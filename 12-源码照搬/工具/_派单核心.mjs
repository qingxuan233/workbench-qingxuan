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
      }));
    } else if (ev.type === 'status' && ev.taskId && out.has(ev.taskId)) {
      const t = out.get(ev.taskId);
      t.status = ev.status || t.status;
      t.updatedAt = ev.at;
      if (ev.evidence) t.evidence = ev.evidence;
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
  let files = [];
  try { files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : []; } catch (e) { }
  for (const f of files) {
    let s = null;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\uFEFF/, '')); } catch (e) { continue; }
    if (!s || !s.id) continue;
    const inst = scenes[s.id] || {};
    const sid = String(inst.sessionId || '');
    reg.push({
      id: s.id, title: s.name || s.id,
      sessionId: sid, bound: !!sid && !sid.startsWith('__'),
    });
  }
  return reg;
}
export function resolveScene(to) {
  const t = String(to || '').trim();
  if (!t) return null;
  const reg = sceneRegistry();
  return reg.find((s) => s.id === t) || reg.find((s) => s.title === t) || null;
}

// ── 引擎端点与鉴权材料 ────────────────────────────────────────────────
function engineBase() {
  if (process.env.DSH_GUI_BASE) return String(process.env.DSH_GUI_BASE);
  try {
    if (fs.existsSync(ENDPOINT)) {
      const j = JSON.parse(fs.readFileSync(ENDPOINT, 'utf8'));
      if (j && j.baseUrl) return String(j.baseUrl);
    }
  } catch (e) { }
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
  try {
    if (fs.existsSync(ENDPOINT)) {
      const j = JSON.parse(fs.readFileSync(ENDPOINT, 'utf8'));
      if (j && j.token) return String(j.token);
    }
  } catch (e) { }
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
export async function wake({ taskId, to, title, content, from }) {
  const scene = resolveScene(to);
  if (!scene) return { ok: false, err: '场景不存在：' + to };
  if (!scene.bound) return { ok: false, err: '场景未绑定会话（sessionId 仍是占位）：' + to };
  const text = '【系统派单 · 任务编号 ' + taskId + '】\n来源：' + (from || 'external') +
    '\n标题：' + (title || '系统派单') + '\n指令：' + content +
    '\n\n请执行此任务。完成后运行：\nnode 工具\\派单.mjs --complete ' + taskId +
    ' --evidence "<客观证据与结论>"\n并在本会话简要回复确认。';
  return engineRpc('session/prompt', {
    request: {
      requestId: crypto.randomUUID(),
      sessionId: scene.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
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
  withLock((release) => appendEvent({
    type: 'task', taskId, from, to: scene.id, title, content, idemKey,
  }, release));

  // 写跨场景看板（**只写机写区**；不碰目标场景的 场景私有记忆.md）
  try { writeNotice({ taskId, to: scene.id, title, content, from, scene }); } catch (e) { }

  // 异步唤醒：HTTP 层先拿到 taskId，不阻塞；CLI 层可以 await r.wake 拿到确定性结果
  const wakePromise = wake({ taskId, to: scene.id, title, content, from })
    .then((r) => {
      withLock((release) => appendEvent({
        type: 'status', taskId,
        status: r.ok ? 'dispatched' : 'failed',
        err: r.ok ? undefined : (r.err || r.text || '唤醒失败'),
        evidence: r.ok ? 'engine session/prompt accepted' : undefined,
      }, release));
      return r;
    })
    .catch((e) => {
      const msg = String((e && e.message) || e);
      try {
        withLock((release) => appendEvent({ type: 'status', taskId, status: 'failed', err: msg }, release));
      } catch (e2) { }
      return { ok: false, err: msg };
    });

  return { ok: true, taskId, replayed: false, status: 'pending', scene: scene.id, wake: wakePromise };
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

export function complete(taskId, evidence) {
  const t = getTask(taskId);
  if (!t) return { ok: false, code: 'E_VALIDATE', err: '任务不存在：' + taskId };
  withLock((release) => appendEvent({
    type: 'status', taskId, status: 'completed', evidence: String(evidence || '执行完成'),
  }, release));
  return { ok: true, taskId, status: 'completed' };
}
export function list(limit = 20) {
  const all = readTasks().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return all.slice(0, limit);
}
