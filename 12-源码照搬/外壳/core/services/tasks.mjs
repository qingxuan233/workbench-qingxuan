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
import * as ledger from '../adapters/store.mjs';
import * as engine from '../adapters/engine.mjs';

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
  });
  if (!r || r.ok === false) return r || { ok: false, code: 'E_INTERNAL', err: '派单核心返回空结果' };
  const out = {
    ok: true,
    taskId: r.taskId,
    status: String(r.status || 'pending'),
    replayed: !!r.replayed,
    scene: r.scene || null,
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

/** task.list：{ limit? } → { tasks:[] } */
export async function list(args = {}) {
  const n = Math.max(1, Math.min(200, Number(args.limit) || 20));
  const tasks = ledger.list(n);
  return { ok: true, count: tasks.length, limit: n, tasks };
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
