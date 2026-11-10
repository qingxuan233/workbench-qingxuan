#!/usr/bin/env node
/**
 * _派单核心.mjs —— 任务信封与派单的**唯一实现**（库，不是 CLI）
 *
 * 谁调它：工具/派单.mjs（CLI） · 外壳/main/agent-gateway.js（HTTP 网关，CJS 里用动态 import）
 * 设计要点（P0）：
 *   ① 台账 = append-only JSONL + 锁文件，读侧折叠最新状态（并发不丢单）
 *   ② 幂等：同一 idemKey 只创建一次任务，重复请求返回原 task（replayed=true）
 *   ③ 唤醒走 DSH 引擎 RPC（session/prompt），token 优先读 harness-endpoint.json，
 *      日志正则只作兜底（ADR-11：禁止新增"扫 server.log 取 token"为主路径）
 *   ④ 人写区/机写区分离（ADR-10）：只写机写区（_跨场景通知 + 场景私有记忆的 §〇-通知 除外，
 *      后者是人写区…见 writeNotice() 里的显式说明）
 *
 * 用法（库）：
 *   import * as core from './_派单核心.mjs';
 *   const r = await core.dispatch({ to:'命令', title:'体检', content:'跑体检', from:'cli' });
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..');
const MEM = process.env.DSH_SCENE_MEMORY || path.join(APP, '引擎数据', '.dsh', '场景记忆');
const SHARED = path.join(MEM, '_共享记忆');
export const LEDGER = path.join(SHARED, '_任务台账.jsonl');
const LEGACY_LEDGER = path.join(SHARED, '_任务台账.json');
const BOARD = path.join(SHARED, '_跨场景通知.md');
const CONFIG = path.join(APP, '工作台.json');
const ENDPOINT = path.join(APP, '外壳', 'data', 'harness-endpoint.json');
const LOCK = LEDGER + '.lock';

const nowISO = () => new Date().toISOString();
const safeDir = (p) => { try { fs.mkdirSync(p, { recursive: true }); } catch (e) { } };

// ── 任务信封（P4-1，2026-11-10）：字段全部**可选**，向后兼容老台账 ──────────
// 只做"记录与展示"，不做强制：mandate 是给接手方看的边界声明，闸门仍在各场景自己手里。
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const MAX_TIMEOUT_MS = 7 * 24 * 3600 * 1000;   // 上限 7 天，防止手滑写个天文数字

export function normalizeEnvelope(opts = {}) {
  const wanted = String((opts && opts.priority) || '').toUpperCase();
  const priority = PRIORITIES.includes(wanted) ? wanted : 'P2';
  const raw = Number(opts && opts.timeoutMs);
  const timeoutMs = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_TIMEOUT_MS) : 0;
  const m = (opts && opts.mandate && typeof opts.mandate === 'object') ? opts.mandate : {};
  const mandate = {
    allowWrite: m.allowWrite === false ? false : true,          // 缺省允许写（与旧行为一致）
    scope: Array.isArray(m.scope) ? m.scope.map(String).slice(0, 20) : [],
  };
  const evidenceExpected = Array.isArray(opts && opts.evidenceExpected)
    ? opts.evidenceExpected.map(String).slice(0, 10) : [];
  return { priority, timeoutMs, mandate, evidenceExpected };
}

/** 纯函数：任务是否已超时（completed/cancelled/expired 一律不算） */
export function isOverdue(task, nowMs = Date.now()) {
  const t = task || {};
  if (!t.timeoutMs || !t.createdAt) return false;
  if (['completed', 'cancelled', 'expired'].includes(String(t.status || ''))) return false;
  const created = new Date(t.createdAt).getTime();
  if (!Number.isFinite(created)) return false;
  return Number(nowMs) > created + Number(t.timeoutMs);
}

// ── 锁：原子创建 .lock（wx），带超时与陈旧锁回收 ──────────────────────────
function acquire(ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      fs.writeFileSync(LOCK, String(Date.now()), { flag: 'wx' });
      return () => { try { fs.unlinkSync(LOCK); } catch (e) { } };
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        try {
          const age = Date.now() - Number(fs.readFileSync(LOCK, 'utf8'));
          if (!Number.isFinite(age) || age > 5000) fs.unlinkSync(LOCK);   // 陈旧锁回收
        } catch (e2) { }
        const wait = 20 + Math.floor(Math.random() * 40);
        const t = Date.now() + wait;
        while (Date.now() < t) { /* 短自旋 */ }
      } else { throw e; }
    }
  }
  throw new Error('台账锁超时（3s）—— 可能有并发派单卡住');
}

// ── 事件追加（唯一写入口）────────────────────────────────────────────
function appendEvent(ev, release) {
  safeDir(SHARED);
  const line = JSON.stringify(Object.assign({ at: nowISO() }, ev)) + '\n';
  fs.appendFileSync(LEDGER, line, 'utf8');
  if (release) release();
}
function withLock(fn) {
  const release = acquire();
  try { return fn(release); } catch (e) { try { release(); } catch (e2) { } throw e; }
}

// ── 读侧折叠：事件流 → 任务对象 ─────────────────────────────────────
export function readTasks() {
  const out = new Map();
  // 旧 JSON 台账兼容（首次迁移：读一次，不改写）
  try {
    if (fs.existsSync(LEGACY_LEDGER)) {
      const arr = JSON.parse(fs.readFileSync(LEGACY_LEDGER, 'utf8'));
      if (Array.isArray(arr)) for (const t of arr) {
        if (t && t.taskId) out.set(t.taskId, Object.assign({}, t, { status: t.status || 'pending' }));
      }
    }
  } catch (e) { }
  if (!fs.existsSync(LEDGER)) return [...out.values()];
  let txt = '';
  try { txt = fs.readFileSync(LEDGER, 'utf8'); } catch (e) { return [...out.values()]; }
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    let ev = null;
    try { ev = JSON.parse(line); } catch (e) { continue; }
    if (ev.type === 'task' && ev.taskId) {
      const prev = out.get(ev.taskId) || {};
      out.set(ev.taskId, Object.assign({}, prev, {
        taskId: ev.taskId, from: ev.from, to: ev.to, title: ev.title, content: ev.content,
        idemKey: ev.idemKey || prev.idemKey || null,
        status: prev.status || 'pending', createdAt: ev.at, updatedAt: ev.at,
        evidence: prev.evidence || null,
        // 信封（老台账没有这些字段 ⇒ 用缺省值补齐，读侧永远拿到同一形状）
        priority: ev.priority || prev.priority || 'P2',
        timeoutMs: Number(ev.timeoutMs) || Number(prev.timeoutMs) || 0,
        mandate: ev.mandate || prev.mandate || null,
        evidenceExpected: ev.evidenceExpected || prev.evidenceExpected || [],
        deadlineAt: ev.deadlineAt || prev.deadlineAt || null,
      }));
    } else if (ev.type === 'status' && ev.taskId && out.has(ev.taskId)) {
      const t = out.get(ev.taskId);
      t.status = ev.status || t.status;
      t.updatedAt = ev.at;
      if (ev.claimedBy) t.claimedBy = ev.claimedBy;
      if (ev.evidence) t.evidence = ev.evidence;
      if (ev.evidenceMeta) t.evidenceMeta = ev.evidenceMeta;
      if (ev.err) t.err = ev.err;
    }
  }
  return [...out.values()];
}
export function getTask(taskId) { return readTasks().find((t) => t.taskId === taskId) || null; }
export function findByIdem(idemKey) {
  if (!idemKey) return null;
  return readTasks().find((t) => t.idemKey === idemKey) || null;
}

// ── 场景注册表（唯一派生出口；不再手写副本）──────────────────────────
export function sceneRegistry() {
  const reg = [];
  let cfg = {};
  try { if (fs.existsSync(CONFIG)) cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { }
  const scenes = (cfg && cfg.scenes) || {};
  const dir = path.join(APP, '外壳', 'scenarios');
  const localDir = path.join(dir, '_local');   // P3-1：实例场景（不入库；同 id 覆盖模板）
  const one = (f, base) => {
    let s = null;
    try { s = JSON.parse(fs.readFileSync(path.join(base, f), 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return; }
    if (!s || !s.id) return;
    const inst = scenes[s.id] || {};
    const sid = String(inst.sessionId || '');
    const row = {
      id: s.id, title: s.name || s.id,
      sessionId: sid, bound: !!sid && !sid.startsWith('__'),
      instance: base === localDir,
    };
    const hit = reg.findIndex((r) => r.id === s.id);
    if (hit >= 0) { if (row.instance) reg[hit] = row; }   // 实例覆盖模板
    else reg.push(row);
  };
  let files = [];
  try { files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_')) : []; } catch (e) { }
  for (const f of files.sort()) one(f, dir);
  let localFiles = [];
  try { localFiles = fs.existsSync(localDir) ? fs.readdirSync(localDir).filter((f) => f.endsWith('.json')) : []; } catch (e) { }
  for (const f of localFiles.sort()) one(f, localDir);
  return reg;
}
export function resolveScene(to) {
  const t = String(to || '').trim();
  if (!t) return null;
  const reg = sceneRegistry();
  return reg.find((s) => s.id === t) || reg.find((s) => s.title === t) || null;
}

// ── 引擎端点与鉴权材料 ────────────────────────────────────────────────
// 2026-11-08：endpoint 必须**先校验 pid 存活**再采用（否则崩遗的死 pid 会让 CLI 派单用旧 token，
//   表现为"任务入账了但唤醒失败"）。core 侧走带校验的 rpc 注入；这里给 CLI 直连路径补同一道闸。
function endpointUsable() {
  try {
    if (!fs.existsSync(ENDPOINT)) return null;
    const j = JSON.parse(fs.readFileSync(ENDPOINT, 'utf8').replace(/^\uFEFF/, ''));
    const pid = Number(j && j.pid);
    if (pid > 0) { try { process.kill(pid, 0); } catch (e) { return null; } }   // 死 pid ⇒ 不采用
    return j && j.baseUrl ? j : null;
  } catch (e) { return null; }
}
function engineBase() {
  if (process.env.DSH_GUI_BASE) return String(process.env.DSH_GUI_BASE);
  const ep = endpointUsable();
  if (ep && ep.baseUrl) return String(ep.baseUrl);
  try {
    if (fs.existsSync(CONFIG)) {
      const j = JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, ''));
      if (j && j.dshPort) return 'http://127.0.0.1:' + Number(j.dshPort);
    }
  } catch (e) { }
  return 'http://127.0.0.1:3083';
}
function engineToken() {
  if (process.env.DSH_TOKEN) return String(process.env.DSH_TOKEN);
  const ep = endpointUsable();
  if (ep && ep.token) return String(ep.token);
  // 兜底：扫 server.log（ADR-11：这是降级路径，不是主路径）
  try {
    const log = path.join(APP, '外壳', 'server.log');
    if (fs.existsSync(log)) {
      const txt = fs.readFileSync(log, 'utf8');
      const hits = [...txt.matchAll(/http:\/\/127\.0\.0\.1:(?:3080|3083)\/\?token=([A-Za-z0-9_\-]{16,})/g)].map((m) => m[1]);
      if (hits.length) return hits[hits.length - 1];
    }
  } catch (e) { }
  return '';
}
async function engineCookie() {
  const token = engineToken();
  if (!token) return { cookie: '', err: '没有可用的引擎 token（先启动工作台，或设置 DSH_TOKEN）' };
  try {
    const r = await fetch(engineBase() + '/?token=' + token, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
    if (!sc.length) return { cookie: '', err: '换不到 cookie（HTTP ' + r.status + '）' };
    return { cookie: sc.map((c) => c.split(';')[0]).join('; '), err: '' };
  } catch (e) { return { cookie: '', err: '连接引擎失败：' + (e && e.message) }; }
}
async function engineRpc(method, args) {
  const { cookie, err } = await engineCookie();
  if (!cookie) return { ok: false, err };
  try {
    const r = await fetch(engineBase() + '/api/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }),
      signal: AbortSignal.timeout(15000),
    });
    const txt = await r.text();
    return { ok: r.status === 200, status: r.status, text: txt.slice(0, 300) };
  } catch (e) { return { ok: false, err: 'RPC 失败：' + (e && e.message) }; }
}

// ── 唤醒：session/prompt（mode=queue）────────────────────────────────
/** 唤醒提示词模板（导出供 core 的定制 wakeImpl 复用，避免两套文案漂移） */
export function wakeText({ taskId, title, content, from }) {
  return '【系统派单 · 任务编号 ' + taskId + '】\n来源：' + (from || 'external') +
    '\n标题：' + (title || '系统派单') + '\n指令：' + content +
    '\n\n请执行此任务。完成后运行：\nnode 工具\\派单.mjs --complete ' + taskId +
    ' --evidence "<客观证据与结论>"\n并在本会话简要回复确认。';
}

/**
 * wake —— 唤醒目标场景会话。
 * 第二参 rpcFn 可选（P1 扩展，纯追加）：默认用本文件内部的 engineRpc（P0 行为完全不变）；
 * core 可注入带 pid/端口校验的 RPC（core/adapters/engine.mjs 的 rpc）。
 */
export async function wake({ taskId, to, title, content, from }, rpcFn = engineRpc) {
  const scene = resolveScene(to);
  if (!scene) return { ok: false, err: '场景不存在：' + to };
  if (!scene.bound) return { ok: false, err: '场景未绑定会话（sessionId 仍是占位）：' + to };
  const fn = typeof rpcFn === 'function' ? rpcFn : engineRpc;
  return fn('session/prompt', {
    request: {
      requestId: crypto.randomUUID(),
      sessionId: scene.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: wakeText({ taskId, title, content, from }) }],
    },
  });
}

// ── 派单：校验 → 幂等 → 记账 → 异步唤醒 ──────────────────────────────
export function newTaskId() {
  const d = new Date();
  const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  return 'task-' + ymd + '-' + crypto.randomBytes(3).toString('hex');
}

export async function dispatch(opts = {}) {
  const to = String(opts.to || '').trim();
  const content = String(opts.content || '').trim();
  const title = String(opts.title || '系统派单').trim();
  const from = String(opts.from || 'external').trim();
  const idemKey = opts.idemKey ? String(opts.idemKey).slice(0, 200) : null;

  if (!to || !content) return { ok: false, code: 'E_VALIDATE', err: '缺少 to 或 content' };
  const scene = resolveScene(to);
  if (!scene) return { ok: false, code: 'E_VALIDATE', err: '场景不存在：' + to };
  if (!scene.bound) return { ok: false, code: 'E_VALIDATE', err: '场景未绑定会话（仍为 __待填__）：' + to };

  if (idemKey) {
    const hit = findByIdem(idemKey);
    if (hit) return { ok: true, taskId: hit.taskId, replayed: true, status: hit.status };
  }

  const taskId = newTaskId();
  const env = normalizeEnvelope(opts);
  withLock((release) => appendEvent({
    type: 'task', taskId, from, to: scene.id, title, content, idemKey,
    priority: env.priority,
    timeoutMs: env.timeoutMs,
    mandate: env.mandate,
    evidenceExpected: env.evidenceExpected,
    deadlineAt: env.timeoutMs ? new Date(Date.now() + env.timeoutMs).toISOString() : null,
  }, release));

  // 写跨场景看板（**只写机写区**；不碰目标场景的 场景私有记忆.md）
  try { writeNotice({ taskId, to: scene.id, title, content, from, scene }); } catch (e) { }

  // 异步唤醒：HTTP 层先拿到 taskId，不阻塞；CLI 层可以 await r.wake 拿到确定性结果
  // P1 扩展（纯追加，默认路径与 P0 完全一致）：
  //   opts.wakeImpl —— 替换唤醒实现（core 传带校验的 sessionPrompt，参数同 wake({taskId,to,title,content,from})）
  //   opts.rpc      —— 注入引擎 RPC（不传 wakeImpl 时，用 wake(args, rpcFn) 复用同一份文案模板）
  const wakeArgs = { taskId, to: scene.id, title, content, from };
  const useDefaultWake = (typeof opts.wakeImpl !== 'function') && (typeof opts.rpc !== 'function');
  const rpcFn = (typeof opts.rpc === 'function') ? opts.rpc : engineRpc;
  const wakePromise = (useDefaultWake
    ? wake(wakeArgs)
    : Promise.resolve().then(() => (typeof opts.wakeImpl === 'function')
      ? opts.wakeImpl(wakeArgs)
      : wake(wakeArgs, rpcFn))
  ).then((r) => {
    withLock((release) => appendEvent({
      type: 'status', taskId,
      status: r.ok ? 'dispatched' : 'failed',
      err: r.ok ? undefined : (r.err || r.text || '唤醒失败'),
      evidence: r.ok ? 'engine session/prompt accepted' : undefined,
    }, release));
    return r;
  }).catch((e) => {
    const msg = String((e && e.message) || e);
    try {
      withLock((release) => appendEvent({ type: 'status', taskId, status: 'failed', err: msg }, release));
    } catch (e2) { }
    return { ok: false, err: msg };
  });

  const deadlineAt = env.timeoutMs ? new Date(Date.now() + env.timeoutMs).toISOString() : null;
  return { ok: true, taskId, replayed: false, status: 'pending', scene: scene.id, priority: env.priority, deadlineAt, wake: wakePromise };
}

function writeNotice({ taskId, to, title, content, from, scene }) {
  // 人写区 / 机写区（ADR-10）：本函数**只写机写区**（`_共享记忆/_跨场景通知.md`，已 gitignore）。
  // 目标场景的 `场景私有记忆.md` 是人写区 —— 自动化运行时代码**不 append** 它；
  // 场景自己要不要把这条通知并入 §〇，由该场景的 AI/人显式决定（`发消息.mjs` 属显式命令，另论）。
  const line = '- [' + nowISO().slice(0, 16).replace('T', ' ') + '] [' + taskId + '] ' + from + ' → ' + scene.title +
    '：【' + title + '】' + String(content).slice(0, 200);
  safeDir(SHARED);
  try {
    if (!fs.existsSync(BOARD)) fs.writeFileSync(BOARD, '# 跨场景通知\n\n', 'utf8');
    fs.appendFileSync(BOARD, line + '\n', 'utf8');
  } catch (e) { }
}

export function complete(taskId, evidence, meta) {
  const t = getTask(taskId);
  if (!t) return { ok: false, code: 'E_VALIDATE', err: '任务不存在：' + taskId };
  const m = (meta && typeof meta === 'object') ? meta : null;
  withLock((release) => appendEvent({
    type: 'status', taskId, status: 'completed', evidence: String(evidence || '执行完成'),
    evidenceMeta: m,
  }, release));
  return { ok: true, taskId, status: 'completed', late: t.status === 'expired' };
}
export function list(limit = 20, opts = {}) {
  const wantStatus = String((opts && opts.status) || '').trim();
  let all = readTasks().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  if (wantStatus) all = all.filter((t) => String(t.status || '') === wantStatus);
  return all.slice(0, limit);
}

/**
 * sweep(opts) —— 超时未回执的任务转 expired（P4-3）。
 * 幂等：已 expired/completed/cancelled 的不再重复写；返回本次新转的 id 清单。
 */
export function sweep(opts = {}) {
  const now = Number(opts.nowMs) > 0 ? Number(opts.nowMs) : Date.now();
  const expired = [];
  for (const t of readTasks()) {
    if (!isOverdue(t, now)) continue;
    withLock((release) => appendEvent({
      type: 'status', taskId: t.taskId, status: 'expired',
      err: '超时未回执（deadline ' + (t.deadlineAt || '') + '）',
    }, release));
    expired.push(t.taskId);
  }
  return { ok: true, expired, count: expired.length, checkedAt: new Date(now).toISOString() };
}

// ── P1 扩展（仅新增导出；上面所有现有导出与行为保持不变）──────────────────
/**
 * claim(taskId, agent) —— 任务被某个 agent 领取（状态 claimed）。
 * 约定：已完成/已取消的任务不能再领；重复领取幂等返回同一状态。
 */
export function claim(taskId, agent) {
  const id = String(taskId || '').trim();
  const t = getTask(id);
  if (!t) return { ok: false, code: 'E_VALIDATE', err: '任务不存在：' + id };
  if (t.status === 'completed' || t.status === 'cancelled' || t.status === 'expired') {
    return { ok: false, code: 'E_VALIDATE', err: '任务已结束（' + t.status + '），不能再领取：' + id };
  }
  const by = String(agent || 'agent').slice(0, 80);
  if (t.status === 'claimed' && t.claimedBy === by) {
    return { ok: true, taskId: id, status: 'claimed', claimedBy: by, replayed: true };
  }
  // 一单一主：已被别人领走的任务不许抢（2026-11-10 补）
  if (t.status === 'claimed' && t.claimedBy && t.claimedBy !== by) {
    return { ok: false, code: 'E_VALIDATE', err: '任务已被「' + t.claimedBy + '」领取，不能再领：' + id, claimedBy: t.claimedBy };
  }
  withLock((release) => appendEvent({
    type: 'status', taskId: id, status: 'claimed', claimedBy: by, evidence: 'claimed by ' + by,
  }, release));
  return { ok: true, taskId: id, status: 'claimed', claimedBy: by };
}

/**
 * cancel(taskId, opts?) —— 取消任务：引擎 `session/cancel` + 台账置 cancelled。
 * opts.rpc 可注入带校验的引擎 RPC（core/adapters/engine.mjs 提供）；不传则用本文件内部的降级实现。
 * 幂等：已 cancelled 直接返回成功；已完成不能取消。
 */
export async function cancel(taskId, opts = {}) {
  const id = String(taskId || '').trim();
  const t = getTask(id);
  if (!t) return { ok: false, code: 'E_VALIDATE', err: '任务不存在：' + id };
  if (t.status === 'completed') return { ok: false, code: 'E_VALIDATE', err: '任务已完成，不能取消：' + id };
  if (t.status === 'cancelled') {
    return { ok: true, taskId: id, status: 'cancelled', engine: { ok: true, skipped: true, err: '' }, replayed: true };
  }

  const scene = t.to ? resolveScene(t.to) : null;
  let engine = { ok: false, skipped: true, status: 0, err: '场景未绑定会话，无法向引擎发 session/cancel' };
  if (scene && scene.bound) {
    const rpcFn = (typeof opts.rpc === 'function') ? opts.rpc : engineRpc;
    let r = null;
    try { r = await rpcFn('session/cancel', { request: { sessionId: scene.sessionId } }); }
    catch (e) { r = { ok: false, err: String((e && e.message) || e) }; }
    engine = {
      ok: !!(r && r.ok),
      skipped: false,
      status: Number((r && r.status) || 0) || 0,
      err: String((r && (r.err || r.text)) || ''),
    };
  }

  withLock((release) => appendEvent({
    type: 'status', taskId: id, status: 'cancelled',
    evidence: engine.ok ? '引擎 session/cancel 已接受' : '已记录取消；引擎侧：' + (engine.err || '未执行'),
    err: engine.ok ? undefined : (engine.err || undefined),
  }, release));

  return { ok: true, taskId: id, status: 'cancelled', engine };
}
