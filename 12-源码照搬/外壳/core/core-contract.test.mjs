#!/usr/bin/env node
/**
 * core-contract.test.mjs —— 能力层/引擎适配层的**纯函数契约**回归测试（不联网、不起 GUI）
 *
 * 为什么要有它（2026-11-10 实测事故）：
 *   `core/adapters/engine.mjs` 曾把整个 method 丢进 encodeURIComponent，
 *   `session/prompt` → `/api/session%2Fprompt`，引擎返回 404 "not found"。
 *   后果是 REST `/v1/dispatch` 与 MCP `workbench__dispatch_task` **静默失效**：
 *   HTTP 202 + taskId 照常返回、台账照样入账，只有目标会话不被唤醒。
 *   而 `工具/派单.mjs` 走的是 `_派单核心` 自己的实现，不经过这条函数 ⇒ 手工测 CLI 永远测不出来。
 *   所以必须由机械判据守住路由拼接，而不是靠"我记得试过"。
 *
 * 用法：node 外壳\core\core-contract.test.mjs      （退出码 0=通过，1=失败）
 * 挂钩：`工具/验收.mjs` 第 2 步（自检）的第二个子检查。
 */

import * as engine from './adapters/engine.mjs';
import * as core from './index.mjs';
import { get as rawGet } from './registry.mjs';   // list() 为了可序列化会去掉 run，run 只能从注册表取

let failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { console.log('✓ ' + name); return true; }
  failed += 1;
  console.log('✗ ' + name + (detail ? ' ← ' + detail : ''));
  return false;
};

// ── 1. RPC 路径：method 里的 `/` 必须保留 ───────────────────────────
const p1 = engine.apiPath('session/prompt');
ok('apiPath(session/prompt) = /api/session/prompt', p1 === '/api/session/prompt', p1);
ok('✅ 回归：路径里不得出现 %2F（否则引擎 404 not found）', !/%2f/i.test(p1), p1);
const p2 = engine.apiPath('session/cancel');
ok('apiPath(session/cancel) = /api/session/cancel', p2 === '/api/session/cancel', p2);
ok('单段方法不受影响（ping）', engine.apiPath('ping') === '/api/ping', engine.apiPath('ping'));
ok('段内特殊字符仍需编码（空格）', engine.apiPath('a b') === '/api/a%20b', engine.apiPath('a b'));
ok('前后空白被裁掉', engine.apiPath('  session/prompt  ') === '/api/session/prompt', engine.apiPath('  session/prompt  '));

// ── 2. 能力注册表：10 个能力，名字固定 ──────────────────────────────
const CAPS = [
  'memory.search', 'pc.inspect', 'review.search', 'scene.status',
  'task.cancel', 'task.claim', 'task.dispatch', 'task.get', 'task.list', 'webai.council',
];
const names = core.names();
ok('能力数量 = 10', names.length === CAPS.length, `实际 ${names.length}`);
const missing = CAPS.filter((n) => !names.includes(n));
const extra = names.filter((n) => !CAPS.includes(n));
ok('能力清单与契约一致', !missing.length && !extra.length, `缺 ${missing.join(',') || '无'} / 多 ${extra.join(',') || '无'}`);

// ── 3. 描述符完整性（schema 即真源：缺字段的能力不许上线）─────────
const bad = [];
for (const d of core.list()) {
  if (!d.name || !d.title) bad.push(d.name + ': 缺 name/title');
  if (!d.inputSchema || d.inputSchema.type !== 'object') bad.push(d.name + ': inputSchema 不是 object');
  if (!d.outputSchema) bad.push(d.name + ': 缺 outputSchema');
  if (!d.authz || (!d.authz.open && !Array.isArray(d.authz.scopes))) bad.push(d.name + ': authz 未声明');
  if (!(Number(d.timeoutMs) > 0)) bad.push(d.name + ': 缺 timeoutMs');
  if (typeof rawGet(d.name).run !== 'function') bad.push(d.name + ': 缺 run()');
}
ok('9 个描述符字段齐全（inputSchema/outputSchema/authz/timeoutMs/run）', !bad.length, bad.join('；'));

// ── 4. 旧 MCP 工具名别名必须仍能解析到已注册能力 ─────────────────
const dangling = Object.entries(core.ALIASES).filter(([, target]) => !names.includes(target));
ok('别名表无悬空（旧 workbench__* 名不会打到空气）', !dangling.length, dangling.map(([k, v]) => `${k}→${v}`).join('；'));
ok('别名解析生效', core.resolveName('workbench__pc_inspect') === 'pc.inspect', core.resolveName('workbench__pc_inspect'));
ok('未知名字不被改写', core.resolveName('no-such-capability') === 'no-such-capability');

// ── 5. P4 任务信封：claim 必须真的注册进来 ─────────────────────────
const claim = core.describe('task.claim');
ok('task.claim 已注册', !!claim);
ok('task.claim 要求 taskId', !!(claim && claim.inputSchema && claim.inputSchema.required && claim.inputSchema.required.includes('taskId')), JSON.stringify(claim && claim.inputSchema && claim.inputSchema.required));
const dispatchCap = core.describe('task.dispatch');
const dispatchProps = (dispatchCap && dispatchCap.inputSchema && dispatchCap.inputSchema.properties) || {};
ok('task.dispatch 带信封字段（priority/deadlineMs/mandate/evidenceExpected）',
  ['priority', 'deadlineMs', 'mandate', 'evidenceExpected'].every((k) => !!dispatchProps[k]),
  Object.keys(dispatchProps).join(','));

if (failed) {
  console.log(`\n✗ 核心契约：${failed} 项失败`);
  process.exit(1);
}
console.log(`\n✓ 核心契约自检全部通过（${CAPS.length} 个能力 · 路由编码正确）`);
process.exit(0);
