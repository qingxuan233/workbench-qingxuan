#!/usr/bin/env node
/**
 * gateway-smoke.mjs —— 网关 / 能力层的**运行时**冒烟（唯一实现）
 *
 * 为什么需要它：`core-contract.test.mjs` 只能守纯函数（路由拼接、能力清单），
 * 守不住"进程真的在跑、鉴权真的生效、INJ-01 真的拦得住"。2026-11-10 那个
 * RPC 编码 bug 就是"静态看起来全对、跑起来静默失效"——这条冒烟是它的运行时补位。
 *
 * 三态（照 @AGENTS.md §8-1 的 engine-after 契约，别把 3 当 0）：
 *   exit 0 = VERIFIED  —— 网关在线，下面全部断言命中
 *   exit 3 = SKIPPED   —— 工作台没在跑 / 端口不可达 ⇒ **未验证**
 *   exit 1 = FAILED    —— 在线但有断言不满足（打印期望 vs 实际）
 *
 * 用法：
 *   node 外壳\scripts\gateway-smoke.mjs            # 正常跑
 *   node 外壳\scripts\gateway-smoke.mjs --quiet    # 只打结论（验收/CI 用）
 *   set WORKBENCH_GATEWAY_PORT=31999 && node ...   # 故意指向不存在的端口 ⇒ 验 SKIPPED 分支
 *
 * 只读：不发任何会写台账的请求。INJ-01 那条是**故意被拦**的（拦在派单之前，不产生任务）。
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as mcp from './mcp-rpc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '..');
const DATA = path.join(APP, '外壳', 'data');
const TOKEN_FILE = path.join(DATA, 'gateway-token.json');
const CONFIG_FILE = path.join(APP, '工作台.json');
const QUIET = process.argv.includes('--quiet');

let failed = 0;
function ok(name, cond, detail) {
  if (cond) { if (!QUIET) console.log('✓ ' + name); return true; }
  failed += 1;
  console.log('✗ ' + name + (detail ? ' ← ' + detail : ''));
  return false;
}
function log(s) { if (!QUIET) console.log(s); }
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return null; }
}
function cfg() { return readJson(CONFIG_FILE) || {}; }
function dshPort() { return Number(cfg().dshPort) || Number(process.env.DSH_PORT) || 3083; }
function gwPort() {
  return Number(process.env.WORKBENCH_GATEWAY_PORT) || Number(process.env.WEB_AI_PORT) || 31239;
}
function reachable(port, ms = 900) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch (e) { } resolve(v); };
    s.setTimeout(ms, () => fin(false));
    s.once('error', () => fin(false));
    s.once('connect', () => fin(true));
    try { s.connect(port, '127.0.0.1'); } catch (e) { fin(false); }
  });
}
async function http(method, p, headers, body, ms = 8000) {
  try {
    const r = await fetch('http://127.0.0.1:' + gwPort() + p, {
      method, headers: headers || {}, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    return { status: r.status, json, text };
  } catch (e) { return { status: -1, json: null, text: String((e && e.message) || e) }; }
}

function finish(code, msg) {
  log('');
  if (code === 0) console.log('结果：VERIFIED（exit 0）');
  else if (code === 3) { log('SKIPPED：' + msg); console.log('结果：**未验证**（exit 3；这不是"通过"）'); }
  else console.log('结果：FAILED（exit 1）—— ' + msg);
  setTimeout(() => process.exit(code), 30);
}

(async () => {
  const port = gwPort();
  if (!(await reachable(port))) {
    finish(3, '工作台没在跑（127.0.0.1:' + port + ' 不可达）⇒ 网关属于未验证状态。先 `启动.bat` 再跑。');
    return;
  }

  log('网关运行时冒烟 · 端口 ' + port + ' · 引擎 ' + dshPort());

  // ── 1. 凭证面 ──────────────────────────────────────────
  const tok = readJson(TOKEN_FILE);
  const token = String((tok && tok.token) || '');
  ok('gateway-token.json 存在且 token 长度 ≥32', fs.existsSync(TOKEN_FILE) && token.length >= 32, 'len=' + token.length);
  ok('token 不是占位/弱值', /^[0-9a-f]{32,}$/i.test(token), token.slice(0, 6) + '…');

  // ── 2. 健康面（匿名）───────────────────────────────────
  const h = await http('GET', '/v1/health');
  ok('/v1/health 匿名 200', h.status === 200, 'HTTP ' + h.status);
  ok('health 自报 service/version', !!(h.json && h.json.service === 'workbench-agent-gateway' && h.json.version), JSON.stringify(h.json && h.json.version));
  const engReach = !!(h.json && h.json.engine && h.json.engine.reachable);
  ok('引擎可达（否则派单必失败）', engReach, 'engine=' + JSON.stringify(h.json && h.json.engine) + '（引擎没起就重开工作台）');
  ok('health 声明鉴权与限流口径', !!(h.json && h.json.auth && h.json.auth.required && h.json.rateLimit && h.json.rateLimit.max > 0));

  // ── 3. 鉴权面 ──────────────────────────────────────────
  const noTok = await http('GET', '/v1/agents');
  ok('无 token 访问 /v1/agents ⇒ 401 E_AUTH', noTok.status === 401 && noTok.json && noTok.json.code === 'E_AUTH', 'HTTP ' + noTok.status + ' ' + (noTok.json && noTok.json.code));
  const badTok = await http('GET', '/v1/agents', { Authorization: 'Bearer ' + 'x'.repeat(48) });
  ok('错误 token ⇒ 401', badTok.status === 401, 'HTTP ' + badTok.status);

  const H = { Authorization: 'Bearer ' + token };
  const a = await http('GET', '/v1/agents', H);
  const bodyText = String(a.text || '');
  ok('带 token ⇒ 200', a.status === 200, 'HTTP ' + a.status);
  ok('/v1/agents 不泄漏真实 sessionId', !/session-|"sessionId"/.test(bodyText), '响应里出现了 session- 字样');

  // ── 4. 场景面（与磁盘上的场景清单对齐）────────────────
  const core = await import(pathToFileURL(path.join(APP, '外壳', 'core', 'index.mjs')).href);
  const st = await core.call('scene.status', {}, core.makeCtx('cli', { agent: 'smoke', rateLimit: false }));
  const scenes = (st && st.agents) || [];
  const apiAgents = (a.json && a.json.agents) || [];
  ok('场景数与能力层一致', apiAgents.length === scenes.length && scenes.length > 0, `REST=${apiAgents.length} core=${scenes.length}`);
  ok('所有场景已绑定会话', apiAgents.length > 0 && apiAgents.every((x) => x.bound === true), '未绑定：' + apiAgents.filter((x) => !x.bound).map((x) => x.id).join(','));
  ok('sessionHash 形态正确（12 位 hex）', apiAgents.every((x) => /^[0-9a-f]{12}$/.test(String(x.sessionHash || ''))), '异常：' + apiAgents.map((x) => x.sessionHash).join(','));

  // ── 5. 任务面 ──────────────────────────────────────────
  const t = await http('GET', '/v1/tasks?limit=3', H);
  ok('/v1/tasks ⇒ 200 且 tasks 是数组', t.status === 200 && t.json && Array.isArray(t.json.tasks), 'HTTP ' + t.status);
  ok('任务对象带 taskId/status', !(t.json && t.json.tasks || []).some((x) => !x.taskId || !x.status));

  // ── 6. MCP 协议面（进程内，不起子进程）──────────────────
  const info = mcp.info();
  const tools = mcp.toolsList();
  ok('MCP tools 数与能力注册表一致', tools.length === core.names().length, `tools=${tools.length} caps=${core.names().length}`);
  ok('MCP 暴露 scene_status 工具', tools.some((x) => x.name === 'workbench__scene_status'));
  const call = await mcp.dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workbench__scene_status', arguments: {} } }, { face: 'mcp-stdio', agent: 'smoke' });
  ok('MCP tools/call 实调成功', !!(call && call.result && !call.result.isError), JSON.stringify(call && call.error));

  // ── 7. 安全围栏（INJ-01 必须真的拦得住）────────────────
  const inj = await http('POST', '/v1/dispatch', Object.assign({ 'Content-Type': 'application/json', 'X-Workbench-Agent': 'smoke' }, H),
    { to: 'command', title: 'INJ 冒烟', text: 'api_key: sk-abcdefghijklmnop1234' });
  ok('INJ-01 拦截含密钥派单 ⇒ 400 E_INJ', inj.status === 400 && inj.json && inj.json.code === 'E_INJ', 'HTTP ' + inj.status + ' ' + (inj.json && inj.json.code));

  // ── 8. 结论 ───────────────────────────────────────────
  if (failed) { finish(1, failed + ' 项断言不满足'); return; }
  log('');
  log('证据：agents=' + apiAgents.length + ' · tools=' + tools.length + ' · tasks=' + ((t.json && t.json.tasks) || []).length + ' · INJ 已拦 · 引擎可达=' + engReach);
  finish(0, '');
})();
