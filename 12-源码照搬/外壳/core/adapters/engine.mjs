/**
 * core/adapters/engine.mjs —— DSH 引擎适配器（token / baseline / 端点读取 + RPC 封装）
 *
 * 这是 P1 的"旧 token 残留"修复点。读取顺序（P1 接口契约 §四.3）：
 *   1. `DSH_TOKEN` 环境变量（显式覆盖，最可信）
 *   2. `外壳/data/harness-endpoint.json`（主进程 publishEngineEndpoint 写的私有通道）
 *      ⚠ **先校验**：`pid` 进程存活 + 引擎端口可连；不满足就整份跳过（不再拿旧 token / 旧 baseUrl）
 *   3. `工作台.json` 的 `dshPort`（配置端口 → baseUrl；token 仍需下面的兜底）
 *   4. `外壳/server.log` 正则兜底（ADR-11：降级路径，不是主路径）
 *
 * 为什么校验 pid：壳每次启动会重写 endpoint（pid 是新进程）；上一个壳遗留的文件如果 pid 已死，
 * 里面的 token/baseUrl 多半已失效 —— 直接拿去用就是"旧 token 残留"。
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..', '..', '..');
const DATA_DIR = path.join(APP, '外壳', 'data');
const ENDPOINT_FILE = path.join(DATA_DIR, 'harness-endpoint.json');
const CONFIG_FILE = path.join(APP, '工作台.json');
const SERVER_LOG = path.join(APP, '外壳', 'server.log');

const PROBE_TIMEOUT_MS = 800;
const ENDPOINT_CACHE_MS = 5000;   // pid/端口探测别每个请求都做；5s 足够新鲜
const TOKEN_RE = /http:\/\/127\.0\.0\.1:(?:3080|3083)\/\?token=([A-Za-z0-9_\-]{16,})/g;

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) { return null; }
}

export function config() { return readJsonSafe(CONFIG_FILE) || {}; }

/** 工作台.json 配置的引擎端口（没有就 null） */
export function configPort() {
  const p = Number(config().dshPort);
  return Number.isFinite(p) && p > 0 ? p : null;
}

/** 默认端口（环境变量优先，与 main.js 的 DSH_PORT 口径一致） */
export function defaultPort() {
  const p = Number(process.env.DSH_PORT);
  return Number.isFinite(p) && p > 0 ? p : 3083;
}

export function defaultBase() {
  return 'http://127.0.0.1:' + defaultPort();
}

function configBase() {
  const p = configPort();
  return p ? 'http://127.0.0.1:' + p : '';
}

/** 进程是否还活着（Windows：EPERM 表示存在但无权信号；ESRCH 才是没了） */
export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === 'EPERM');
  }
}

/** 端口可连（TCP connect，短超时） */
export function portReachable(port, timeoutMs = PROBE_TIMEOUT_MS) {
  const p = Number(port);
  if (!Number.isInteger(p) || p <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (e) { }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once('error', () => finish(false));
    sock.once('connect', () => finish(true));
    try { sock.connect(p, '127.0.0.1'); } catch (e) { finish(false); }
  });
}

let endpointCache = { at: 0, key: '', value: null };

/**
 * 读并校验 harness-endpoint.json。
 * 返回 { ok, baseUrl, token, port, pid, why, checkedAt }
 * why: 'no-file' | 'json-bad' | 'pid-dead' | 'port-unreachable' | ''
 */
export async function endpointInfo(opts = {}) {
  const force = !!opts.force;
  const now = Date.now();
  if (!force && endpointCache.value && now - endpointCache.at < ENDPOINT_CACHE_MS) return endpointCache.value;

  const set = (value) => {
    endpointCache = { at: Date.now(), key: ENDPOINT_FILE, value };
    return value;
  };

  if (!fs.existsSync(ENDPOINT_FILE)) {
    return set({ ok: false, why: 'no-file', baseUrl: '', token: '', port: null, pid: null, checkedAt: new Date().toISOString() });
  }
  const j = readJsonSafe(ENDPOINT_FILE);
  if (!j || typeof j !== 'object') {
    return set({ ok: false, why: 'json-bad', baseUrl: '', token: '', port: null, pid: null, checkedAt: new Date().toISOString() });
  }
  const pid = Number(j.pid) || null;
  const port = Number(j.port) || null;
  if (pid && !pidAlive(pid)) {
    return set({ ok: false, why: 'pid-dead', pid, baseUrl: '', token: '', port, checkedAt: new Date().toISOString() });
  }
  if (port && !(await portReachable(port))) {
    return set({ ok: false, why: 'port-unreachable', pid, port, baseUrl: '', token: '', checkedAt: new Date().toISOString() });
  }
  if (!j.baseUrl && !port) {
    return set({ ok: false, why: 'json-bad', pid, port, baseUrl: '', token: '', checkedAt: new Date().toISOString() });
  }
  return set({
    ok: true, why: '',
    baseUrl: String(j.baseUrl || ('http://127.0.0.1:' + port)),
    token: String(j.token || ''),
    port, pid,
    checkedAt: new Date().toISOString(),
  });
}

/** 从 server.log 尾部取最新 token（ADR-11 降级路径；只读最后 256KB，避免整份读） */
export function logToken() {
  try {
    if (!fs.existsSync(SERVER_LOG)) return '';
    const size = fs.statSync(SERVER_LOG).size;
    const from = Math.max(0, size - 256 * 1024);
    const buf = Buffer.alloc(size - from);
    const fd = fs.openSync(SERVER_LOG, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, from); } finally { try { fs.closeSync(fd); } catch (e) { } }
    const txt = buf.toString('utf8');
    const hits = [...txt.matchAll(TOKEN_RE)].map((m) => m[1]);
    return hits.length ? hits[hits.length - 1] : '';
  } catch (e) { return ''; }
}

/**
 * 解析当前可用的 baseUrl + token（契约 §四.3 的顺序，带 diag 便于排障）。
 * 返回 { baseUrl, token, source, diag:[...] }
 */
export async function resolveAuth(opts = {}) {
  const diag = [];
  const ep = await endpointInfo(opts);
  const envBase = String(process.env.DSH_GUI_BASE || '').trim();
  const envToken = String(process.env.DSH_TOKEN || '').trim();

  let baseUrl = envBase || '';
  let token = envToken;
  let source = envToken ? 'env:DSH_TOKEN' : '';

  if (ep.ok) {
    if (!baseUrl) baseUrl = ep.baseUrl;
    if (!token && ep.token) { token = ep.token; source = 'harness-endpoint'; }
    diag.push('harness-endpoint 校验通过（pid=' + (ep.pid || '?') + ' 存活，端口 ' + (ep.port || '?') + ' 可连）');
  } else {
    diag.push('harness-endpoint 跳过：' + ep.why + '（不采用其中的旧 token/baseUrl）');
  }

  if (!baseUrl) {
    baseUrl = configBase();
    if (baseUrl) diag.push('baseUrl←工作台.json dshPort=' + configPort());
  }
  if (!baseUrl) { baseUrl = defaultBase(); diag.push('baseUrl←默认端口 ' + defaultPort()); }

  if (!token) {
    const t = logToken();
    if (t) { token = t; source = (source ? source + '+' : '') + 'server.log 兜底'; diag.push('token←server.log 正则兜底（ADR-11 降级路径）'); }
  }
  if (!token) diag.push('没有可用 token（引擎没启动？或 DSH_TOKEN 未设）');

  return { baseUrl, token, source: source || 'none', diag };
}

/** 给审计/排障用的"token 走了哪条路"标签：endpoint / log / config / env / none */
export function routeLabel(auth) {
  const a = auth || {};
  const src = String(a.source || '');
  if (!a.token) return 'config';            // 没有 token：只能靠 工作台.json 的端口推断地址
  if (src.includes('harness-endpoint')) return 'endpoint';
  if (src.includes('server.log')) return 'log';
  if (src.includes('DSH_TOKEN')) return 'env';
  return 'config';
}

/** 用 token 换签名 cookie（必须 redirect:'manual'，跟随后反而 401 —— 见 建会话.mjs 实测配方） */
export async function engineCookie(auth, timeoutMs = 8000) {
  const a = auth || await resolveAuth();
  if (!a.token) return { ok: false, err: '没有可用 token', cookie: '', auth: a };
  try {
    const r = await fetch(a.baseUrl + '/?token=' + encodeURIComponent(a.token), {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
    if (!sc.length) return { ok: false, err: '换不到 cookie（HTTP ' + r.status + '）', cookie: '', auth: a };
    return { ok: true, err: '', cookie: sc.map((c) => c.split(';')[0]).join('; '), auth: a };
  } catch (e) {
    return { ok: false, err: '连接引擎失败：' + ((e && e.message) || e), cookie: '', auth: a };
  }
}

/**
 * RPC 的 HTTP 路径（**纯函数，唯一实现**，2026-11-10 抽出来防回归）
 *
 * ⚠ 踩过的坑：曾对整个 method 做 encodeURIComponent ⇒ `session/prompt` 变成
 *   `/api/session%2Fprompt`，引擎路由不认，返回 404 "not found"。
 *   表现极具欺骗性：台账入账成功、HTTP 202 返回 taskId，但目标会话永远不被唤醒；
 *   CLI 的 `工具/派单.mjs` 走的是另一套实现（不过这条函数），所以**只有 REST/MCP 通道坏**。
 *
 * 规则：只逐段编码，保留 `/`。`apiPath('session/prompt') === '/api/session/prompt'`
 */
export function apiPath(method) {
  const m = String(method == null ? '' : method).trim();
  return '/api/' + m.split('/').map(encodeURIComponent).join('/');
}

/**
 * 调 DSH JSON-RPC：POST /api/<method>，body = {type:'client-request',rpcId,method,payload:{args}}
 * 返回 { ok, status, text, json, auth }
 */
export async function rpc(method, args, opts = {}) {
  const m = String(method || '').trim();
  if (!m) return { ok: false, code: 'E_VALIDATE', err: 'rpc 缺少 method' };
  const auth = opts.auth || await resolveAuth(opts);
  const c = await engineCookie(auth, opts.cookieTimeoutMs || 8000);
  if (!c.ok) return { ok: false, code: 'E_ENGINE', err: c.err, auth: c.auth };
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 15000;
  try {
    // ⚠ 路径必须走 apiPath()（逐段编码）；直接 encodeURIComponent(m) 会把 `/` 编成 %2F ⇒ 404
    const r = await fetch(auth.baseUrl + apiPath(m), {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', cookie: c.cookie },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: crypto.randomBytes(8).toString('hex'),
        method: m,
        payload: { args: args || {} },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    return { ok: r.status === 200, status: r.status, text: text.slice(0, 500), json, auth };
  } catch (e) {
    return { ok: false, code: 'E_ENGINE', err: 'RPC 失败：' + ((e && e.message) || e), auth };
  }
}

/** 取消一个会话正在跑的回合（task.cancel 用） */
export async function sessionCancel(sessionId, opts = {}) {
  const sid = String(sessionId || '').trim();
  if (!sid) return { ok: false, code: 'E_VALIDATE', err: '缺少 sessionId' };
  return rpc('session/cancel', { request: { sessionId: sid } }, opts);
}

/** 给会话排一条 prompt（mode=queue；派单唤醒用） */
export async function sessionPrompt(sessionId, text, opts = {}) {
  const sid = String(sessionId || '').trim();
  if (!sid) return { ok: false, code: 'E_VALIDATE', err: '缺少 sessionId' };
  return rpc('session/prompt', {
    request: {
      requestId: crypto.randomBytes(8).toString('hex'),
      sessionId: sid,
      mode: String(opts.mode || 'queue'),
      content: [{ type: 'text', text: String(text || '') }],
    },
  }, opts);
}

/** 健康探针（给 /v1/health、排障用）：端点校验 + 端口连通 */
export async function health(opts = {}) {
  const auth = await resolveAuth(opts);
  const port = (() => {
    try { return Number(new URL(auth.baseUrl).port) || defaultPort(); } catch (e) { return defaultPort(); }
  })();
  const reachable = await portReachable(port, 1200);
  return {
    ok: reachable,
    baseUrl: auth.baseUrl,
    port,
    tokenSource: auth.source,
    hasToken: !!auth.token,
    reachable,
    diag: auth.diag,
  };
}
