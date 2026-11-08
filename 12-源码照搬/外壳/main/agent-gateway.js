/**
 * agent-gateway.js —— 清玄工作台 REST face（挂在外壳主进程 31239 的 `/v1/*`）
 *
 * P1 收口（2026-11-08）：
 *   ① 所有业务改为调 `外壳/core/index.mjs` 的 `call()`（**单内核**：中间件 INJ-01 / CMP-01 / 审计只走一遍）
 *   ② 新增**限流**：按 `X-Workbench-Agent`（缺省按 IP），默认 60 次/60s；超限 `429 E_RATE` + `retryAfterMs`
 *   ③ 新增**场景级 ACL**：`工作台.json.gateway.acl = [{ agent:'cursor', allowScenes:['command'] }]`
 *      未配置 = 全放行；配置后未授权 agent / 越权场景一律 `403 E_ACL`
 *   ④ 鉴权与来源沿用 P0：Bearer token（`外壳/data/gateway-token.json`）+ Origin 白名单
 *
 * 端点：
 *   GET  /v1/health            匿名：网关 + 引擎健康
 *   GET  /v1/agents            场景状态（sessionHash，不泄露真实 sessionId）
 *   GET  /v1/tasks?limit=n     任务列表
 *   GET  /v1/tasks/:id         单任务
 *   POST /v1/dispatch          派单（幂等；立即 202 + taskId）
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const appRoot = path.resolve(__dirname, '..', '..');
const dataDir = path.join(appRoot, '外壳', 'data');
const tokenFile = path.join(dataDir, 'gateway-token.json');
const accessLog = path.join(dataDir, 'gateway-access.log');
const configPath = path.join(appRoot, '工作台.json');
const corePath = path.join(appRoot, '外壳', 'core', 'index.mjs');
const startedAt = Date.now();

// ── 配置 / token / 来源 ───────────────────────────────────────
function readConfig() {
  try {
    if (!fs.existsSync(configPath)) return {};
    return JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) { return {}; }
}

function gatewayToken() {
  const cfg = readConfig();
  const fromCfg = cfg && cfg.gateway && cfg.gateway.token;
  if (fromCfg) return String(fromCfg);
  try {
    if (fs.existsSync(tokenFile)) {
      const j = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
      if (j && j.token) return String(j.token);
    }
  } catch (e) { }
  const t = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(tokenFile, JSON.stringify({ token: t, createdAt: new Date().toISOString() }), { mode: 0o600 });
    try { fs.chmodSync(tokenFile, 0o600); } catch (e) { }
  } catch (e) { }
  return t;
}

function allowedOrigins() {
  const cfg = readConfig();
  const a = cfg && cfg.gateway && Array.isArray(cfg.gateway.allowedOrigins) ? cfg.gateway.allowedOrigins : [];
  const b = process.env.WORKBENCH_ALLOWED_ORIGINS ? String(process.env.WORKBENCH_ALLOWED_ORIGINS).split(',') : [];
  return a.concat(b).map((s) => String(s).trim()).filter(Boolean);
}

function aclRules() {
  const cfg = readConfig();
  const a = cfg && cfg.gateway && Array.isArray(cfg.gateway.acl) ? cfg.gateway.acl : [];
  return a.map((r) => ({ agent: String((r && r.agent) || ''), allowScenes: Array.isArray(r && r.allowScenes) ? r.allowScenes.map(String) : null }));
}

// ── 能力层（动态 import；本文件 CJS，core 是 ESM）───────────────
let corePromise = null;
function core() {
  if (!corePromise) corePromise = import(pathToFileURL(corePath).href);
  return corePromise;
}

// ── 引擎探活（缓存 10s）──────────────────────────────────────
let probeCache = { at: 0, ok: false, port: 0 };
function enginePort() {
  const cfg = readConfig();
  return Number(cfg && cfg.dshPort) || Number(process.env.DSH_PORT) || 3083;
}
function probeEngine() {
  const port = enginePort();
  if (Date.now() - probeCache.at < 10000 && probeCache.port === port) return Promise.resolve(probeCache.ok);
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      probeCache = { at: Date.now(), ok: val, port };
      try { sock.destroy(); } catch (e) { }
      resolve(val);
    };
    sock.setTimeout(800, () => finish(false));
    sock.once('error', () => finish(false));
    sock.once('connect', () => finish(true));
    sock.connect(port, '127.0.0.1');
  });
}

// ── 限流（滑动窗口：按 agent/ip，60 次 / 60s）──────────────────
const RATE_WINDOW_MS = 60000;
const RATE_MAX = Number(process.env.WORKBENCH_GATEWAY_RATE || 60);
const rateHits = new Map();   // key -> { windowStart, count }
function rateKey(req) {
  const agent = String((req.headers && req.headers['x-workbench-agent']) || '').trim();
  if (agent) return 'agent:' + agent;
  let ip = '';
  try { ip = String((req.socket && req.socket.remoteAddress) || ''); } catch (e) { }
  return 'ip:' + (ip || 'unknown');
}
function rateCheck(req) {
  const key = rateKey(req);
  const now = Date.now();
  let rec = rateHits.get(key);
  if (!rec || now - rec.windowStart >= RATE_WINDOW_MS) { rec = { windowStart: now, count: 0 }; rateHits.set(key, rec); }
  rec.count += 1;
  if (rateHits.size > 500) {  // 防内存无界：窗口过期就清
    for (const [k, v] of rateHits) if (now - v.windowStart >= RATE_WINDOW_MS) rateHits.delete(k);
  }
  if (rec.count <= RATE_MAX) return { ok: true };
  return { ok: false, retryAfterMs: Math.max(0, RATE_WINDOW_MS - (now - rec.windowStart)) };
}

// ── 响应助手 ─────────────────────────────────────────────────
function send(res, code, obj, headers) {
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }, headers || {}));
  res.end(JSON.stringify(obj, null, 2));
}
const errBody = (code, msg, extra) => Object.assign({ ok: false, code, err: msg }, extra || {});
function logAccess(traceId, req, pathname, status, ms, extra) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(accessLog, JSON.stringify({
      ts: new Date().toISOString(), traceId, method: req.method, path: pathname,
      status, ms, agent: String((req.headers && req.headers['x-workbench-agent']) || ''), extra: extra || '',
    }) + '\n');
  } catch (e) { }
}

function originAllowed(req) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return true;
  const list = allowedOrigins();
  return list.length > 0 && list.includes(String(origin));
}
function tokenAllowed(req) {
  const want = gatewayToken();
  const auth = String((req.headers && req.headers.authorization) || '');
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const alt = String((req.headers && req.headers['x-workbench-token']) || '').trim();
  const got = bearer || alt;
  if (!got || !want || got.length !== want.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)); } catch (e) { return false; }
}

function readBody(req, limit = 5e5) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > limit) { try { req.destroy(); } catch (e) { } } });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(''));
  });
}

// 错误码 → HTTP 状态
const HTTP_OF = {
  E_AUTH: 401, E_ORIGIN: 403, E_ACL: 403, E_RATE: 429,
  E_VALIDATE: 400, E_NOTFOUND: 404, E_INJ: 400, E_TIMEOUT: 504,
  E_ENGINE: 503, E_CORE_UNAVAILABLE: 503, E_INTERNAL: 500,
};

// ── 主入口 ───────────────────────────────────────────────────
function handle(req, res) {
  const rawUrl = req.url || '/';
  const pathname = rawUrl.split('?')[0];
  if (!pathname.startsWith('/v1/')) return false;

  const t0 = Date.now();
  const traceId = crypto.randomBytes(6).toString('hex');
  const finish = (code, obj, extra) => {
    logAccess(traceId, req, pathname, code, Date.now() - t0, extra);
    send(res, code, obj, { 'X-Workbench-Trace': traceId });
  };

  if (!originAllowed(req)) {
    finish(403, errBody('E_ORIGIN', '此 Origin 不在白名单（跨域请求默认拒绝）'));
    return true;
  }
  if (req.method === 'OPTIONS') {
    const origin = req.headers && req.headers.origin;
    const h = {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key, X-Workbench-Token, X-Workbench-Agent',
      'Access-Control-Max-Age': '600',
      'Vary': 'Origin',
    };
    if (origin) h['Access-Control-Allow-Origin'] = String(origin);
    res.writeHead(204, h);
    res.end();
    return true;
  }

  // 健康：匿名
  if (pathname === '/v1/health' && req.method === 'GET') {
    probeEngine().then((ok) => {
      finish(200, {
        ok: true, service: 'workbench-agent-gateway', version: '1.3.0',
        uptimeMs: Date.now() - startedAt,
        engine: { port: enginePort(), reachable: !!ok },
        auth: { required: true, scheme: 'Bearer' },
        rateLimit: { max: RATE_MAX, windowMs: RATE_WINDOW_MS },
      });
    }).catch(() => finish(500, errBody('E_ENGINE', 'health 探测失败')));
    return true;
  }

  if (!tokenAllowed(req)) { finish(401, errBody('E_AUTH', '缺少或错误的 Bearer token（见 外壳/data/gateway-token.json）')); return true; }

  const rate = rateCheck(req);
  if (!rate.ok) {
    finish(429, errBody('E_RATE', '请求过于频繁（' + RATE_MAX + ' 次/分钟）', { retryAfterMs: rate.retryAfterMs }), 'rate');
    return true;
  }

  const cctx = (c) => c.makeCtx('rest', {
    agent: String((req.headers && req.headers['x-workbench-agent']) || 'rest-agent'),
    traceId,
  });
  const callCap = (name, args) => core().then((c) => c.call(name, args, cctx(c)));
  const replyCap = (name, args) => callCap(name, args).then((r) => {
    if (!r || r.ok !== true) {
      const code = (r && r.code) || 'E_INTERNAL';
      finish(HTTP_OF[code] || 400, errBody(code, (r && r.err) || '能力调用失败'));
      return;
    }
    finish(200, r);
  }).catch((e) => finish(500, errBody('E_INTERNAL', String((e && e.message) || e))));

  if (pathname === '/v1/agents' && req.method === 'GET') {
    replyCap('scene.status', {});
    return true;
  }

  if (pathname === '/v1/tasks' && req.method === 'GET') {
    const q = rawUrl.split('?')[1] || '';
    const limit = Math.max(1, Math.min(200, Number((q.match(/limit=(\d+)/) || [])[1]) || 20));
    replyCap('task.list', { limit });
    return true;
  }

  if (pathname.startsWith('/v1/tasks/') && req.method === 'GET') {
    replyCap('task.get', { taskId: pathname.slice('/v1/tasks/'.length).trim() });
    return true;
  }

  if (pathname === '/v1/dispatch' && req.method === 'POST') {
    readBody(req).then((body) => {
      let p = null;
      try { p = JSON.parse(body || '{}'); } catch (e) {
        finish(400, errBody('E_VALIDATE', '请求体不是合法 JSON'));
        return;
      }
      const to = String(p.to || p.toScenario || '');
      const content = String(p.text || p.content || '');
      const agent = String((req.headers && req.headers['x-workbench-agent']) || p.from || 'agent-api');
      if (!to || !content) { finish(400, errBody('E_VALIDATE', '缺少 to/toScenario 与 text/content')); return; }

      // ACL：配置了规则就按规则；未配置 = 全放行
      const rules = aclRules();
      if (rules.length) {
        const hit = rules.find((r) => r.agent === agent);
        if (!hit) { finish(403, errBody('E_ACL', 'agent 「' + agent + '」未被授权使用派单（见 工作台.json.gateway.acl）')); return; }
        if (hit.allowScenes && hit.allowScenes.length && !hit.allowScenes.includes(to)) {
          // 允许用标题（命令）而不是 id（command）：用 scene.status 的清单做一次归一
          callCap('scene.status', {}).then((st) => {
            const list = (st && st.agents) || [];
            const sc = list.find((s) => s.id === to || s.title === to);
            if (sc && hit.allowScenes.includes(sc.id)) { doDispatch(sc.id); return; }
            finish(403, errBody('E_ACL', 'agent 「' + agent + '」无权派单给场景「' + to + '」'));
          }).catch(() => finish(403, errBody('E_ACL', 'ACL 校验失败')));
          return;
        }
      }
      doDispatch(to);

      function doDispatch(sceneId) {
        const idemKey = String((req.headers && req.headers['idempotency-key']) || p.idempotencyKey || '').trim() || null;
        callCap('task.dispatch', {
          to: to, title: p.title || '外部 API 派单', content,
          idempotencyKey: idemKey, awaitWake: p.awaitWake === true,
        }).then((r) => {
          if (!r || r.ok !== true) {
            const code = (r && r.code) || 'E_INTERNAL';
            finish(HTTP_OF[code] || 400, errBody(code, (r && r.err) || '派单失败'));
            return;
          }
          finish(r.replayed ? 200 : 202, {
            ok: true, taskId: r.taskId, status: r.status,
            replayed: !!r.replayed, scene: r.scene || null, traceId,
          });
        }).catch((e) => finish(500, errBody('E_INTERNAL', String((e && e.message) || e))));
      }
    });
    return true;
  }

  finish(404, errBody('E_NOTFOUND', '没有这个端点', {
    endpoints: ['GET /v1/health', 'GET /v1/agents', 'GET /v1/tasks', 'GET /v1/tasks/:id', 'POST /v1/dispatch'],
  }));
  return true;
}

// 预热 token（首次启动即落盘，脚本可直接读）
try { gatewayToken(); } catch (e) { }

module.exports = { handle, gatewayToken, enginePort };
