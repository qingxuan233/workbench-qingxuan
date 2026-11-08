/**
 * mcp-http.mjs —— MCP Streamable HTTP face（单端点 `POST /mcp`）
 *
 * 规范要点（MCP 2026 无状态语义）：
 *   - **单端点** `POST /mcp`，服务端不保存 session（没有 Mcp-Session-Id、没有 initialize 握手依赖）
 *   - 协议版本由每请求 `_meta` / `protocolVersion` 提供；缺省回 `2025-11-25`
 *   - `Accept: text/event-stream` ⇒ 请求级 SSE（本 face 只发一条 message 事件即收尾；不做断线重投）
 *   - 其它 ⇒ `application/json`
 *   - 鉴权与 `/v1` 同一枚 token：`外壳/data/gateway-token.json`（`工作台.json.gateway.token` 可覆写）
 *   - 来源：默认拒绝任何带 Origin 的跨域（浏览器网页不能直连本机网关）；CLI/原生客户端无 Origin，凭 token 放行
 *
 * 谁挂它：`外壳/main.js` 的 31239 server（在 `/v1` 与 `/webai` 之后、404 兜底之前）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatch, info } from './mcp-rpc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '..');
const DATA = path.join(APP, '外壳', 'data');
const TOKEN_FILE = path.join(DATA, 'gateway-token.json');
const CONFIG = path.join(APP, '工作台.json');
const ACCESS_LOG = path.join(DATA, 'mcp-http-access.log');
const MAX_BODY = 1e6;   // 1MB 上限：工具参数不该更大

function readConfig() {
  try {
    if (!fs.existsSync(CONFIG)) return {};
    return JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) { return {}; }
}

function token() {
  const cfg = readConfig();
  const fromCfg = cfg && cfg.gateway && cfg.gateway.token;
  if (fromCfg) return String(fromCfg);
  try {
    const j = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (j && j.token) return String(j.token);
  } catch (e) { }
  return '';
}

function allowedOrigins() {
  const cfg = readConfig();
  const a = cfg && cfg.gateway && Array.isArray(cfg.gateway.allowedOrigins) ? cfg.gateway.allowedOrigins : [];
  const b = process.env.WORKBENCH_ALLOWED_ORIGINS ? String(process.env.WORKBENCH_ALLOWED_ORIGINS).split(',') : [];
  return a.concat(b).map((s) => String(s).trim()).filter(Boolean);
}

function authOk(req) {
  const want = token();
  const auth = String((req.headers && req.headers.authorization) || '');
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const alt = String((req.headers && req.headers['x-workbench-token']) || '').trim();
  const got = bearer || alt;
  if (!want || !got || got.length !== want.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)); } catch (e) { return false; }
}

function originOk(req) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return true;                       // CLI / 原生客户端
  return allowedOrigins().includes(String(origin));
}

function accessLog(traceId, req, status, ms, extra) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.appendFileSync(ACCESS_LOG, JSON.stringify({
      ts: new Date().toISOString(), traceId, method: req.method, path: req.url,
      status, ms, agent: String((req.headers && req.headers['x-workbench-agent']) || ''), extra: extra || '',
    }) + '\n');
  } catch (e) { }
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > MAX_BODY) { try { req.destroy(); } catch (e) { } } });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(''));
  });
}

function sendJson(res, code, obj, traceId) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Workbench-Trace': traceId || '',
  });
  res.end(JSON.stringify(obj));
}

function sendSse(res, obj, traceId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Workbench-Trace': traceId || '',
  });
  res.write('event: message\ndata: ' + JSON.stringify(obj) + '\n\n');
  res.end();
}

/**
 * 处理一条 HTTP 请求。**只认领 `/mcp`**，其它路径返回 false 交给后面的路由。
 * @returns {boolean} true = 已认领（无论成功失败都已回包）
 */
export function handle(req, res) {
  const rawUrl = req.url || '/';
  const pathname = rawUrl.split('?')[0];
  if (pathname !== '/mcp') return false;

  const t0 = Date.now();
  const traceId = crypto.randomBytes(6).toString('hex');
  const done = (code, obj, sse) => {
    accessLog(traceId, req, code, Date.now() - t0, sse ? 'sse' : '');
    if (sse) sendSse(res, obj, traceId); else sendJson(res, code, obj, traceId);
  };

  if (!originOk(req)) { done(403, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'E_ORIGIN: 此 Origin 不在白名单' } }); return true; }
  if (req.method === 'OPTIONS') {
    const origin = req.headers && req.headers.origin;
    const h = {
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Workbench-Token, X-Workbench-Agent, MCP-Protocol-Version',
      'Access-Control-Max-Age': '600',
      'Vary': 'Origin',
    };
    if (origin) h['Access-Control-Allow-Origin'] = String(origin);
    res.writeHead(204, h);
    res.end();
    accessLog(traceId, req, 204, Date.now() - t0, 'preflight');
    return true;
  }
  if (req.method !== 'POST') { done(405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'E_METHOD: /mcp 只接受 POST' } }); return true; }
  if (!authOk(req)) { done(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'E_AUTH: 缺少或错误的 Bearer token（见 外壳/data/gateway-token.json）' } }); return true; }

  const wantsSse = String((req.headers && req.headers.accept) || '').includes('text/event-stream');

  readBody(req).then(async (body) => {
    let msg = null;
    try { msg = JSON.parse(body || '{}'); } catch (e) {
      done(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const meta = {
      face: 'mcp-http',
      agent: String((req.headers && req.headers['x-workbench-agent']) || 'http-agent'),
      traceId,
      protocolVersion: String((req.headers && req.headers['mcp-protocol-version']) || (msg && msg.params && msg.params.protocolVersion) || ''),
    };
    try {
      const resp = await dispatch(msg, meta);
      // 通知：无响应体（HTTP 规范里回 202 空体）
      if (!resp) {
        res.writeHead(202, { 'X-Workbench-Trace': traceId });
        res.end();
        accessLog(traceId, req, 202, Date.now() - t0, 'notification');
        return;
      }
      done(200, resp, wantsSse);
    } catch (e) {
      done(500, { jsonrpc: '2.0', id: (msg && msg.id) || null, error: { code: -32603, message: 'Internal error: ' + String((e && e.message) || e) } });
    }
  });

  return true;
}

export function info2() { return info(); }
