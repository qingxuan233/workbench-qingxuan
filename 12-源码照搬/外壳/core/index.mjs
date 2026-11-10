/**
 * core/index.mjs —— 能力层唯一入口（四个 face 共用）
 *
 * 用法：
 *   import { call, list, makeCtx, ALIASES, resolveName } from '../../core/index.mjs';
 *   const ctx = makeCtx('rest', { agent: 'cursor', traceId: '...' });
 *   const r = await call('task.dispatch', { to:'命令', content:'跑体检' }, ctx);
 *
 * 约定：
 *   - call(name,args,ctx) 成功 = { ok:true, ...output, traceId }；失败 = { ok:false, code, err }
 *   - list() 返回 9 个能力的描述符（schema 即真源）
 *   - 旧 workbench__* 名字只在本层提供**别名解析**（ALIASES/resolveName），face 自己决定怎么用；
 *     能力注册表里不出现别名（契约 §二）。
 */

import crypto from 'node:crypto';
import { define, get, list as registryList, names as registryNames, describe as registryDescribe } from './registry.mjs';
import { PIPELINE, CODES, runPipeline } from './middleware.mjs';
import * as tasks from './services/tasks.mjs';
import * as memory from './services/memory.mjs';
import * as review from './services/review.mjs';
import * as webai from './services/webai.mjs';
import * as pc from './services/pc.mjs';
import * as bilibili from './services/bilibili.mjs';

export const VERSION = '1.0.0';
export { PIPELINE, CODES };

/** 旧 MCP 工具名 → 能力名（只在 face 层用，core 注册表不出现别名） */
export const ALIASES = {
  workbench__pc_inspect: 'pc.inspect',
  workbench__review_search: 'review.search',
  workbench__webai_council: 'webai.council',
  workbench__dispatch_task: 'task.dispatch',
  workbench__bilibili_extract: 'bilibili.extract',
};

/** 别名解析：不认识的返回原名（让 registry.get 自然报 E_NOTFOUND） */
export function resolveName(name) {
  const n = String(name || '').trim();
  return ALIASES[n] || n;
}

const OBJ = (props, required) => ({
  type: 'object',
  properties: props || {},
  ...(required ? { required } : {}),
});
const STR = (description) => ({ type: 'string', description });
const NUM = (description) => ({ type: 'number', description });
const BOOL = (description) => ({ type: 'boolean', description });

// ── 能力注册（9 个名：契约 §二 8 个 + review.search）─────────────────────
define({
  name: 'scene.status',
  version: '1.0.0',
  title: '场景与绑定状态',
  description: '5 个场景的 id/标题/绑定态 + sessionId 哈希（不泄露真实 id）',
  inputSchema: OBJ({}),
  outputSchema: OBJ({ agents: { type: 'array' } }),
  authz: { open: true },
  effects: 'none',
  timeoutMs: 5000,
  run: () => tasks.sceneStatus(),
});

define({
  name: 'task.dispatch',
  version: '1.0.0',
  title: '派单（异步唤醒场景会话）',
  description: '校验场景与绑定 → 幂等入账 → 异步唤醒目标会话；立即返回 taskId',
  inputSchema: OBJ({
    to: STR('目标场景 id 或标题（如 command / 命令）'),
    title: STR('任务标题'),
    content: STR('任务正文/指令'),
    idempotencyKey: STR('幂等键：同一键只创建一次任务'),
    timeoutMs: NUM('唤醒超时（毫秒，可选）'),
    awaitWake: BOOL('true=等唤醒结果再返回（默认 false，HTTP/MCP 应保持 false）'),
    priority: STR('信封优先级 P0|P1|P2|P3（缺省 P2）'),
    deadlineMs: NUM('信封截止毫秒（0=不设；超时由 --sweep 转 expired）'),
    evidenceExpected: { type: 'array', items: { type: 'string' }, description: '期望证据清单（给接手方看）' },
    mandate: { type: 'object', description: '写入边界声明 { allowWrite:boolean, scope:string[] }' },
  }, ['to', 'content']),
  outputSchema: OBJ({ taskId: STR('任务号'), status: STR('pending|dispatched|failed'), replayed: BOOL('是否幂等重放'), scene: STR('目标场景 id') }),
  authz: { scopes: ['task:write'] },
  effects: 'wake',
  timeoutMs: 25000,
  run: (args, ctx) => tasks.dispatch(args, ctx),
});

define({
  name: 'task.get',
  version: '1.0.0',
  title: '查询单个任务',
  description: '按 taskId 查任务状态与证据链',
  inputSchema: OBJ({ taskId: STR('任务号') }, ['taskId']),
  outputSchema: OBJ({ task: { type: 'object' } }),
  authz: { scopes: ['task:read'] },
  effects: 'none',
  timeoutMs: 5000,
  run: (args) => tasks.get(args),
});

define({
  name: 'task.list',
  version: '1.0.0',
  title: '任务列表',
  description: '最近任务（按创建时间倒序）',
  inputSchema: OBJ({ limit: NUM('最多返回多少条（1-200，默认 20）'), status: STR('只取某个状态：pending|dispatched|claimed|completed|cancelled|expired') }),
  outputSchema: OBJ({ tasks: { type: 'array' }, count: NUM('条数') }),
  authz: { scopes: ['task:read'] },
  effects: 'none',
  timeoutMs: 5000,
  run: (args) => tasks.list(args),
});

define({
  name: 'task.cancel',
  version: '1.0.0',
  title: '取消任务',
  description: '引擎 session/cancel 打断目标会话当前回合，并把任务置 cancelled',
  inputSchema: OBJ({ taskId: STR('任务号') }, ['taskId']),
  outputSchema: OBJ({ ok: BOOL('是否成功'), taskId: STR('任务号'), status: STR('cancelled'), engine: { type: 'object' } }),
  authz: { scopes: ['task:write'] },
  effects: 'engine',
  timeoutMs: 25000,
  run: (args, ctx) => tasks.cancel(args, ctx),
});

define({
  name: 'task.claim',
  version: '1.0.0',
  title: '领取任务（claimed）',
  description: '把任务标记为已被某个 agent 领取；已完成/已取消/已超时的任务不可领',
  inputSchema: OBJ({ taskId: STR('任务号'), agent: STR('领取方标识（缺省取 ctx.agent）') }, ['taskId']),
  outputSchema: OBJ({ ok: BOOL('是否成功'), taskId: STR('任务号'), status: STR('claimed'), claimedBy: STR('领取方') }),
  authz: { scopes: ['task:write'] },
  effects: 'write',
  timeoutMs: 10000,
  run: (args, ctx) => tasks.claim(args, ctx),
});

define({
  name: 'bilibili.extract',
  version: '1.0.0',
  title: 'B站当前视频（读产物）',
  description: '读 B站面板同步的「当前视频」产物（bv/url/title）；没有就如实返回 never-synced，不造假、不联网抓取',
  inputSchema: OBJ({
    quick: BOOL('默认 true 只回视频信息；false 附带该场景记忆的最近更新时间'),
  }),
  outputSchema: OBJ({
    status: STR('ok|not-a-video|unrecognized-bv|never-synced'),
    source: STR('产物相对路径'),
    bv: STR('BV 号（可能为 null）'),
    url: STR('同步到的页面 URL'),
    title: STR('同步到的页面标题'),
    syncedAt: STR('渲染层最后一次写盘时间'),
    isVideo: BOOL('是否确认是一条视频'),
  }),
  authz: { scopes: ['local:read'] },
  effects: 'read',
  timeoutMs: 10000,
  run: (args) => bilibili.extract(args),
});

define({
  name: 'webai.council',
  version: '1.0.0',
  title: '网页版 AI 顾问团',
  description: '并发问 5 个免费网页版 AI（0 Token）；单站失败不影响其他站',
  inputSchema: OBJ({
    question: STR('要问的问题'),
    sites: { type: 'array', items: { type: 'string' }, description: '站点 key 列表（默认 deepseek/doubao）' },
    timeoutMs: NUM('单站等待毫秒（默认 90000，上限 180000）'),
  }, ['question']),
  outputSchema: OBJ({ results: { type: 'object' }, okCount: NUM('成功站点数'), failedCount: NUM('失败站点数') }),
  authz: { scopes: ['net:out'] },
  effects: 'network',
  timeoutMs: 190000,
  run: (args) => webai.council(args),
});

define({
  name: 'pc.inspect',
  version: '1.0.0',
  title: '本地电脑体检（读缓存）',
  description: '读最近一次 pc-scan 产物；从未扫描过就如实返回 never-scanned，不造假数据',
  inputSchema: OBJ({ quick: BOOL('默认 true 只回摘要；false 才带回完整 items') }),
  outputSchema: OBJ({ status: STR('cached|never-scanned'), source: STR('产物相对路径'), scannedAt: STR('扫描时间'), summary: { type: 'object' } }),
  authz: { scopes: ['local:read'] },
  effects: 'read',
  timeoutMs: 15000,
  run: (args) => pc.inspect(args),
});

define({
  name: 'memory.search',
  version: '1.0.0',
  title: '场景记忆检索（只读）',
  description: '在 引擎数据/.dsh/场景记忆 下做只读关键词检索',
  inputSchema: OBJ({ query: STR('关键词（字面量，不区分大小写）'), limit: NUM('最多命中文件数（默认 10）') }, ['query']),
  outputSchema: OBJ({ query: STR('关键词'), count: NUM('命中文件数'), hits: { type: 'array' } }),
  authz: { scopes: ['local:read'] },
  effects: 'read',
  timeoutMs: 15000,
  run: (args) => memory.search(args),
});

define({
  name: 'review.search',
  version: '1.0.0',
  title: '复盘库检索（只读）',
  description: '在 自我复盘/ 下做只读关键词检索（旧 workbench__review_search 的别名目标）',
  inputSchema: OBJ({ query: STR('关键词（字面量，不区分大小写）'), limit: NUM('最多命中文件数（默认 10）') }, ['query']),
  outputSchema: OBJ({ query: STR('关键词'), count: NUM('命中文件数'), hits: { type: 'array' } }),
  authz: { scopes: ['local:read'] },
  effects: 'read',
  timeoutMs: 15000,
  run: (args) => review.search(args),
});

// ── ctx 工厂（face 层调用；本机可信进程默认 local-full）───────────────────
/**
 * makeCtx(face, opts) → { face, agent, traceId, scopes, now, rateLimitMax? }
 * face: 'mcp-stdio' | 'mcp-http' | 'rest' | 'cli' | 'ipc'
 * opts.scopes 默认 ['local-full']（本机可信面；远端 face 应只给细粒度 scope）
 */
export function makeCtx(face, opts = {}) {
  const f = String(face || 'cli');
  return {
    face: f,
    agent: String(opts.agent || f),
    traceId: String(opts.traceId || ('t' + crypto.randomBytes(6).toString('hex'))),
    scopes: Array.isArray(opts.scopes) ? opts.scopes.slice() : ['local-full'],
    now: new Date().toISOString(),
    ...(opts.rateLimit !== undefined ? { rateLimit: !!opts.rateLimit } : {}),
    ...(Number(opts.rateLimitMax) > 0 ? { rateLimitMax: Number(opts.rateLimitMax) } : {}),
    ...(opts.debug ? { debug: true } : {}),
  };
}

function normalizeCtx(ctx) {
  if (ctx && typeof ctx === 'object' && ctx.face) {
    return {
      face: String(ctx.face),
      agent: String(ctx.agent || ctx.face),
      traceId: String(ctx.traceId || ('t' + crypto.randomBytes(6).toString('hex'))),
      scopes: Array.isArray(ctx.scopes) ? ctx.scopes.slice() : ['local-full'],
      now: ctx.now || new Date().toISOString(),
      ...(ctx.rateLimit !== undefined ? { rateLimit: !!ctx.rateLimit } : {}),
      ...(Number(ctx.rateLimitMax) > 0 ? { rateLimitMax: Number(ctx.rateLimitMax) } : {}),
      ...(ctx.debug ? { debug: true } : {}),
    };
  }
  return makeCtx('cli');
}

// ── 对外 API ──────────────────────────────────────────────────────────
/** 调一个能力（支持别名）。 */
export async function call(name, args, ctx) {
  const real = resolveName(name);
  const cap = get(real);
  if (!cap) {
    const err = '未知能力：' + String(name || '') + (real !== String(name || '') ? '（别名→' + real + '）' : '');
    return { ok: false, code: CODES.E_NOTFOUND, err };
  }
  return runPipeline(cap, args || {}, normalizeCtx(ctx));
}

/** 能力清单（9 项；描述符含 inputSchema/outputSchema/authz/effects/middleware/timeoutMs）。 */
export function list() {
  return registryList();
}

/** 单个能力描述符（未注册返回 null）。 */
export function describe(name) {
  return registryDescribe(resolveName(name));
}

/** 能力名数组（含别名不展开；face 层可用 ALIASES 自行映射）。 */
export function names() {
  return registryNames();
}
