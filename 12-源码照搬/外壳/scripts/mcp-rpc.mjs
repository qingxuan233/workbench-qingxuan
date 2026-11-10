/**
 * mcp-rpc.mjs —— MCP JSON-RPC 分发内核（stdio 与 Streamable HTTP 两个 face 共用）
 *
 * 为什么单独抽：stdio 与 HTTP 只是传输不同，**协议语义必须只有一份**（P1 目标之一）。
 * 业务一律走 外壳/core/index.mjs（能力层），本文件只做：
 *   ① 方法路由（initialize / server/discover / tools/list / tools/call / ping）
 *   ② 工具名 → 能力名 + 入参适配（旧 workbench__* 名字保持不变，外部客户端零改动）
 *   ③ 协议语义：通知不响应、未知方法带 id 的 -32601、工具失败 isError:true
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '..');
const CORE_PATH = path.join(APP, '外壳', 'core', 'index.mjs');

export const SERVER_VERSION = '1.1.0';
const SERVER_INFO = { name: 'workbench-mcp', version: SERVER_VERSION };
const DEFAULT_PROTOCOL = '2025-11-25';

let corePromise = null;
/** 懒加载能力层；失败抛出（由调用方翻译成 E_CORE_UNAVAILABLE）。 */
export function loadCore() {
  if (!corePromise) corePromise = import(pathToFileURL(CORE_PATH).href);
  return corePromise;
}

// ── 工具表：MCP 工具名 → 能力名 + 入参适配 ───────────────────────────────────
// 4 个旧名字保持原样（外部客户端配置不用改）；其余能力用 workbench__<能力名> 形式暴露。
const TOOLS = [
  {
    name: 'workbench__pc_inspect',
    capability: 'pc.inspect',
    description: '巡检本地电脑（读最近一次 pc-scan 产物；CMP-01 超 6KB 自动落盘）',
    inputSchema: { type: 'object', properties: { quick: { type: 'boolean', description: 'true=只回摘要' } } },
    mapArgs: (a) => ({ quick: a && a.quick !== false }),
  },
  {
    name: 'workbench__review_search',
    capability: 'review.search',
    description: '检索自我复盘库（只读，字面量匹配）',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: '关键词' }, limit: { type: 'number', description: '最多文件数' } },
      required: ['query'],
    },
    mapArgs: (a) => ({ query: String((a && a.query) || ''), limit: (a && a.limit) || 10 }),
  },
  {
    name: 'workbench__webai_council',
    capability: 'webai.council',
    description: '并发问网页免费 AI 顾问团（0 Token；默认 deepseek + doubao）',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问的问题' },
        models: { type: 'array', items: { type: 'string', enum: ['deepseek', 'doubao', 'tongyi', 'chatglm', 'kimi'] }, description: '站点列表' },
        timeoutMs: { type: 'number', description: '单站等待毫秒' },
      },
      required: ['question'],
    },
    mapArgs: (a) => ({ question: String((a && a.question) || ''), sites: (a && a.models) || undefined, timeoutMs: (a && a.timeoutMs) || undefined }),
  },
  {
    name: 'workbench__dispatch_task',
    capability: 'task.dispatch',
    description: '向工作台场景派单：校验场景与绑定 → 幂等入账 → 异步唤醒会话',
    inputSchema: {
      type: 'object',
      properties: {
        toScenario: { type: 'string', description: '场景 id 或标题（command / 命令）' },
        title: { type: 'string', description: '任务标题' },
        content: { type: 'string', description: '任务正文 / 指令' },
        idempotencyKey: { type: 'string', description: '幂等键' },
        priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'], description: '信封优先级（缺省 P2）' },
        deadlineMs: { type: 'number', description: '信封截止毫秒（0=不设；超时由 sweep 转 expired）' },
        evidenceExpected: { type: 'array', items: { type: 'string' }, description: '期望证据清单' },
        mandate: { type: 'object', description: '写入边界声明 { allowWrite, scope[] }' },
      },
      required: ['toScenario', 'content'],
    },
    mapArgs: (a) => ({
      to: String((a && a.toScenario) || ''),
      title: (a && a.title) || '外部 MCP 派单',
      content: String((a && a.content) || ''),
      idempotencyKey: (a && a.idempotencyKey) || undefined,
      priority: (a && a.priority) || undefined,
      deadlineMs: (a && a.deadlineMs) || undefined,
      evidenceExpected: Array.isArray(a && a.evidenceExpected) ? a.evidenceExpected : undefined,
      mandate: (a && a.mandate && typeof a.mandate === 'object') ? a.mandate : undefined,
    }),
  },
  { name: 'workbench__bilibili_extract', capability: 'bilibili.extract', description: 'B站当前视频（读 B站面板同步的产物；没有就如实返回 never-synced）', inputSchema: { type: 'object', properties: { quick: { type: 'boolean' } } }, mapArgs: (a) => ({ quick: (a && a.quick) !== false }) },
  { name: 'workbench__scene_status', capability: 'scene.status', description: '5 个场景的绑定状态（只给 sessionHash，不泄露真实 id）', inputSchema: { type: 'object', properties: {} }, mapArgs: () => ({}) },
  { name: 'workbench__task_get', capability: 'task.get', description: '按 taskId 查任务状态与证据', inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] }, mapArgs: (a) => ({ taskId: String((a && a.taskId) || '') }) },
  { name: 'workbench__task_list', capability: 'task.list', description: '最近任务列表（可按 status 过滤）', inputSchema: { type: 'object', properties: { limit: { type: 'number' }, status: { type: 'string' } } }, mapArgs: (a) => ({ limit: (a && a.limit) || 20, status: (a && a.status) || undefined }) },
  { name: 'workbench__task_cancel', capability: 'task.cancel', description: '取消任务（引擎 session/cancel + 状态置 cancelled）', inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] }, mapArgs: (a) => ({ taskId: String((a && a.taskId) || '') }) },
  { name: 'workbench__task_claim', capability: 'task.claim', description: '领取任务（claimed；已完成/已取消/已超时不可领）', inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, agent: { type: 'string' } }, required: ['taskId'] }, mapArgs: (a) => ({ taskId: String((a && a.taskId) || ''), agent: (a && a.agent) || 'mcp-client' }) },
  { name: 'workbench__memory_search', capability: 'memory.search', description: '场景记忆检索（只读）', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] }, mapArgs: (a) => ({ query: String((a && a.query) || ''), limit: (a && a.limit) || 10 }) },
];

export function toolsList() {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

function findTool(name) {
  return TOOLS.find((t) => t.name === String(name || '')) || null;
}

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/** 单条工具调用：核心能力 → MCP 结果块。失败必须 isError:true（否则客户端误判成功）。 */
async function callTool(id, params, meta) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  const tool = findTool(name);
  if (!tool) {
    return ok(id, { content: [{ type: 'text', text: '未知工具：' + String(name || '') }], isError: true });
  }
  let core = null;
  try {
    core = await loadCore();
  } catch (e) {
    return ok(id, { content: [{ type: 'text', text: '[E_CORE_UNAVAILABLE] 能力层未就绪：' + String((e && e.message) || e) }], isError: true });
  }
  const ctx = core.makeCtx((meta && meta.face) || 'mcp-stdio', {
    agent: (meta && meta.agent) || 'mcp-client',
    traceId: (meta && meta.traceId) || undefined,
  });
  let r = null;
  try {
    r = await core.call(tool.capability, tool.mapArgs(args), ctx);
  } catch (e) {
    return ok(id, { content: [{ type: 'text', text: '[E_INTERNAL] ' + String((e && e.message) || e) }], isError: true });
  }
  if (!r || r.ok !== true) {
    const code = (r && r.code) || 'E_INTERNAL';
    const msg = (r && r.err) || '能力调用失败';
    return ok(id, { content: [{ type: 'text', text: '[' + code + '] ' + msg }], isError: true });
  }
  let text = '';
  try { text = JSON.stringify(r, null, 2); } catch (e) { text = String(r); }
  return ok(id, { content: [{ type: 'text', text }], isError: false });
}

/**
 * 分发一条 JSON-RPC 消息。
 * @returns {object|null} 需要回一条响应时返回响应对象；**通知类返回 null（不许回任何东西）**
 */
export async function dispatch(msg, meta = {}) {
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
    return fail((msg && msg.id) || null, -32600, '无效的 JSON-RPC 请求');
  }
  const { id, method, params } = msg;

  // 通知：一律不响应（回一个无 id 的错误响应是协议违规）
  if (method.startsWith('notifications/') || id === undefined || id === null && !method.endsWith('/list')) {
    if (method.startsWith('notifications/')) return null;
  }

  const proto = (params && params.protocolVersion) || (meta && meta.protocolVersion) || DEFAULT_PROTOCOL;

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: proto,
        capabilities: { tools: {}, resources: {} },
        serverInfo: SERVER_INFO,
        instructions: '清玄工作台能力层：场景状态 / 派单 / 任务查询 / 网页 AI 顾问团 / 本地体检 / 记忆与复盘检索。',
      });
    case 'server/discover':
      return ok(id, {
        protocolVersion: proto,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {}, resources: {} },
        tools: toolsList(),
      });
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: toolsList() });
    case 'tools/call':
      return callTool(id, params, Object.assign({}, meta, { protocolVersion: proto }));
    // Tasks 扩展（2026 规范把长任务显式化成 task handle）：直接映射到能力
    case 'tasks/get':
      return callTool(id, { name: 'workbench__task_get', arguments: { taskId: (params && (params.taskId || (params.task && params.task.taskId))) } }, meta);
    case 'tasks/cancel':
      return callTool(id, { name: 'workbench__task_cancel', arguments: { taskId: (params && (params.taskId || (params.task && params.task.taskId))) } }, meta);
    default:
      return fail(id, -32601, 'Method not found: ' + method);
  }
}

/** 供 face 层做健康/自检用 */
export function info() {
  return { serverInfo: SERVER_INFO, tools: TOOLS.length, corePath: CORE_PATH };
}
