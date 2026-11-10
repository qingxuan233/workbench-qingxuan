/**
 * core/services/tasks.mjs —— 任务服务（内部委托 工具/_派单核心.mjs）
 *
 * 分层：
 *   core.call('task.dispatch') → services/tasks.dispatch → adapters/store.mjs → 工具/_派单核心.mjs
 *   task.cancel 的引擎调用注入 core/adapters/engine.mjs 的**带校验 RPC**（修"旧 token 残留"）。
 * 说明：_派单核心.dispatch 内部的唤醒路径沿用 P0 实现（endpoint-first + 日志兜底）；
 *       本服务不重复实现唤醒，避免出现第二套台账/唤醒逻辑。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ledger from '../adapters/store.mjs';
import * as engine from '../adapters/engine.mjs';

const APP = process.env.DSH_WORKBENCH_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const isPlaceholder = (sid) => !sid || String(sid).startsWith('__');

export function sessionHash(sessionId) {
  const sid = String(sessionId || '');
  if (isPlaceholder(sid)) return null;
  return crypto.createHash('sha256').update(sid).digest('hex').slice(0, 12);
}

/**
 * task.dispatch：{ to,title,content,idempotencyKey?,timeoutMs?,awaitWake? } →
 *   { taskId, status, replayed, scene, engineRoute, engineDiag }
 * 立即返回 taskId（唤醒在进程内异步完成）；awaitWake=true 时等唤醒结果再返回。
 *
 * P1 注入（2026-11-08，Lead 批准）：唤醒**不再走 _派单核心 内部的 endpoint-first**，
 * 而是用 core/adapters/engine.mjs 的带校验实现 —— 先校验 pid 存活 + 端口可连再采用 endpoint，
 * 否则回退 工作台.json / server.log。`engineRoute` 标明实际走了哪条（endpoint/log/config/env/none）。
 */
export async function dispatch(args = {}, ctx = {}) {
  const to = String(args.to || '').trim();
  const content = String(args.content || '').trim();
  if (!to || !content) return { ok: false, code: 'E_VALIDATE', err: '缺少 to 或 content' };

  // 先解析一次鉴权材料（端点探测有 5s 缓存；最坏 800ms，只在 pid 活但端口不通时发生）
  const auth = await engine.resolveAuth();
  const engineRoute = engine.routeLabel(auth);

  // 定制唤醒：文案模板复用 _派单核心.wakeText，避免两套提示词漂移
  const wakeImpl = async (w) => {
    const scene = ledger.resolveScene(w.to);
    if (!scene) return { ok: false, err: '场景不存在：' + w.to };
    if (!scene.bound) return { ok: false, err: '场景未绑定会话（sessionId 仍是占位）：' + w.to };
    return engine.sessionPrompt(scene.sessionId, ledger.wakeText(w), { auth });
  };

  const r = await ledger.dispatch({
    to,
    title: String(args.title || '').trim() || '外部派单',
    content,
    from: String(ctx.agent || ctx.face || 'core').slice(0, 80),
    idemKey: args.idempotencyKey ? String(args.idempotencyKey).slice(0, 200) : null,
    wakeImpl,
    // P4 信封（全部可选，未传时由 _派单核心 补缺省）
    priority: args.priority,
    timeoutMs: args.deadlineMs,
    mandate: args.mandate,
    evidenceExpected: args.evidenceExpected,
  });
  if (!r || r.ok === false) return r || { ok: false, code: 'E_INTERNAL', err: '派单核心返回空结果' };
  const out = {
    ok: true,
    taskId: r.taskId,
    status: String(r.status || 'pending'),
    replayed: !!r.replayed,
    scene: r.scene || null,
    priority: r.priority || 'P2',
    deadlineAt: r.deadlineAt || null,
    engineRoute,
    engineDiag: auth.diag,
  };
  if (args.awaitWake === true && r.wake) {
    try {
      const w = await r.wake;
      out.wake = { ok: !!(w && w.ok), err: String((w && w.err) || w.text || '') };
      out.status = out.wake.ok ? 'dispatched' : 'failed';
    } catch (e) {
      out.wake = { ok: false, err: String((e && e.message) || e) };
      out.status = 'failed';
    }
  }
  return out;
}

/** task.get：{ taskId } → { task } */
export async function get(args = {}) {
  const id = String(args.taskId || '').trim();
  if (!id) return { ok: false, code: 'E_VALIDATE', err: '缺少 taskId' };
  const t = ledger.getTask(id);
  if (!t) return { ok: false, code: 'E_NOTFOUND', err: '未找到任务：' + id };
  return { ok: true, task: t };
}

/** task.list：{ limit?, status? } → { tasks:[] } */
export async function list(args = {}) {
  const n = Math.max(1, Math.min(200, Number(args.limit) || 20));
  const status = String(args.status || '').trim();
  const tasks = ledger.list(n, { status });
  return { ok: true, count: tasks.length, limit: n, status: status || 'all', tasks };
}

/**
 * task.cancel：{ taskId } → { ok, taskId, status:'cancelled', engine:{...} }
 * 引擎 RPC 用 core 的带校验适配器（pid 存活/端口可连都过才用 endpoint 的 token），
 * 不满足会自动回退工作台.json/日志兜底（见 adapters/engine.mjs）。不回传真实 sessionId。
 */
export async function cancel(args = {}, ctx = {}) {
  const id = String(args.taskId || '').trim();
  if (!id) return { ok: false, code: 'E_VALIDATE', err: '缺少 taskId' };
  const r = await ledger.cancel(id, {
    rpc: (method, a) => engine.rpc(method, a, { timeoutMs: Math.min(20000, Number(ctx.timeoutMs) || 15000) }),
  });
  if (!r || r.ok === false) return r;
  return {
    ok: true,
    taskId: r.taskId,
    status: r.status,
    replayed: !!r.replayed,
    engine: r.engine || null,
  };
}

/** claim：{ taskId, agent? } → { ok, taskId, status:'claimed', claimedBy } */
export async function claim(args = {}, ctx = {}) {
  const id = String(args.taskId || '').trim();
  if (!id) return { ok: false, code: 'E_VALIDATE', err: '缺少 taskId' };
  const by = String(args.agent || ctx.agent || ctx.face || 'agent');
  return ledger.claim(id, by);
}

// ── 销账证据（P4-4，2026-11-10）：把"口头完成"变成"可核对的完成" ──────────
/**
 * safeArtifactPath(rel) → 规范化后的相对路径 / null（拒绝）
 *
 * 规则：只接受**应用根内**的相对路径；拒绝绝对路径、盘符、`..` 穿越。
 * 为什么不接受绝对路径：这个能力是给外部 Agent 用的，放开就等于给它一个任意读文件的口子。
 */
export function safeArtifactPath(rel) {
  const s = String(rel == null ? '' : rel).trim();
  if (!s) return null;
  if (path.isAbsolute(s)) return null;
  if (/^[A-Za-z]:/.test(s)) return null;
  const norm = s.replace(/\\/g, '/');
  if (norm.split('/').includes('..')) return null;
  return norm;
}

/**
 * task.complete：{ taskId, evidence, exitCode?, artifacts?: [{path, sha256?}] }
 *   → { ok, taskId, status:'completed', late, evidence, evidenceMeta }
 *
 * 证据口径：
 *   - `evidence` 必填（一句话说清"凭什么算完成"，不许空）
 *   - `exitCode` 原样记（整数）
 *   - `artifacts`：每个 `path` 必须落在应用根内且**真实存在**；算出 sha256 后与传入值比对，
 *     传了却对不上 ⇒ E_VALIDATE（这就是"机械证据"和"自由文本"的区别）
 *   - 最多 10 个证据文件（防止把台账撑爆）
 */
export async function complete(args = {}, ctx = {}) {
  const id = String(args.taskId || '').trim();
  if (!id) return { ok: false, code: 'E_VALIDATE', err: '缺少 taskId' };
  const t = ledger.getTask(id);
  if (!t) return { ok: false, code: 'E_VALIDATE', err: '任务不存在：' + id };
  if (t.status === 'completed') {
    // 幂等：已销账的不重复写台账（外部 Agent 重试安全）
    return { ok: true, taskId: id, status: 'completed', replayed: true, late: false, evidence: t.evidence || null, evidenceMeta: t.evidenceMeta || null };
  }
  const evidence = String(args.evidence == null ? '' : args.evidence).trim();
  if (!evidence) return { ok: false, code: 'E_VALIDATE', err: '缺少 evidence：完成必须说明客观依据' };

  const arts = Array.isArray(args.artifacts) ? args.artifacts.slice(0, 10) : [];
  const files = [];
  for (const a of arts) {
    const rel = safeArtifactPath(a && a.path);
    if (!rel) return { ok: false, code: 'E_VALIDATE', err: 'artifacts.path 必须是应用根内的相对路径：' + String((a && a.path) || '') };
    const abs = path.join(APP, rel);
    let buf = null;
    try { buf = fs.readFileSync(abs); } catch (e) { return { ok: false, code: 'E_VALIDATE', err: '证据文件不存在或读不了：' + rel }; }
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (a && a.sha256 && String(a.sha256).toLowerCase() !== sha) {
      return { ok: false, code: 'E_VALIDATE', err: '证据哈希不匹配：' + rel };
    }
    files.push({ path: rel, bytes: buf.length, sha256: sha });
  }

  const meta = {};
  if (Number.isInteger(args.exitCode)) meta.exitCode = args.exitCode;
  if (files.length) meta.files = files;

  const r = ledger.complete(id, evidence, Object.keys(meta).length ? meta : null);
  if (!r || r.ok === false) return r || { ok: false, code: 'E_INTERNAL', err: '销账核心返回空结果' };
  return {
    ok: true, taskId: id, status: 'completed', late: !!r.late,
    evidence, evidenceMeta: Object.keys(meta).length ? meta : null,
  };
}

/** scene.status → { agents:[{id,title,bound,sessionHash}] }（不返回真实 sessionId） */
export async function sceneStatus() {
  const reg = ledger.sceneRegistry();
  const agents = reg.map((s) => ({
    id: s.id,
    title: s.title,
    bound: !!s.bound,
    sessionHash: sessionHash(s.sessionId),
  }));
  return { ok: true, count: agents.length, agents };
}
