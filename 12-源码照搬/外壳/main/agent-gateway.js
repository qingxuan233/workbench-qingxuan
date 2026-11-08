/**
 * agent-gateway.js —— 清玄工作台统一外部 Agent API 网关（挂在外壳主进程的 31239 上）
 *
 * 端点：
 *   GET  /v1/health              网关 + 引擎健康（可匿名）
 *   GET  /v1/agents              场景清单（**不返回真实 sessionId**，只给哈希与绑定态）
 *   GET  /v1/tasks?limit=n       最近任务列表
 *   GET  /v1/tasks/:taskId       单任务状态 + 证据链
 *   POST /v1/dispatch            派单（立即 202 + taskId，异步唤醒）
 *
 * P0 硬化（2026-11-08）：
 *   ① Bearer token 鉴权（`外壳/data/gateway-token.json`，首次自动生成；`工作台.json.gateway.token` 可覆写）
 *   ② 删除 CORS `*`：改为 Origin 白名单（默认拒绝一切带 Origin 的跨域请求；CLI/无 Origin 凭 token 放行）
 *   ③ 场景校验：只认 `工具/_派单核心.mjs` 派生的场景注册表，未绑定会话直接 4xx 且不写台账
 *   ④ 幂等：`Idempotency-Key` 头 / body.idempotencyKey，重复请求返回原 task（replayed:true）
 *   ⑤ 异步：HTTP 立即返回，唤醒在进程内异步完成（不再同步等子进程）
 *   ⑥ 访问日志 JSONL：`外壳/data/gateway-access.log`
 */

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const appRoot = path.resolve(__dirname, '..', '..');
const dataDir = path.join(appRoot, '外壳', 'data');
const tokenFile = path.join(dataDir, 'gateway-token.json');
const accessLog = path.join(dataDir, 'gateway-access.log');
const configPath = path.join(appRoot, '工作台.json');
const corePath = path.join(appRoot, '工具', '_派单核心.mjs');
const startedAt = Date.now();

// ── 配置 / token ──────────────────────────────────────────────
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
  const fromCfg = cfg && cfg.gateway && Array.isArray(cfg.gateway.allowedOrigins) ? cfg.gateway.allowedOrigins : [];
  const fromEnv = process.env.WORKBENCH_ALLOWED_ORIGINS ? String(process.env.WORKBENCH_ALLOWED_ORIGINS).split(',') : [];
  return fromCfg.concat(fromEnv).map((s) => String(s).trim()).filter(Boolean);
}

// ── 核心库（动态 import；本文件是 CJS，核心是 ESM）───────────────
let corePromise = null;
function core() {
  if (!corePromise) corePromise = import(pathToFileURL(corePath).href);
  return corePromise;
}

// ── 引擎健康探活（缓存 10s，避免每次请求都连）──────────────────
let probeCache = { at: 0, ok: false, port: 0 };
function enginePort() {
  const cfg = readConfig();
  const p = Number(cfg && cfg.dshPort) || Number(process.env.DSH_PORT) || 3083;
  return p;
}
function probeEngine() {
  const port = enginePort();
  if (Date.now() - probeCache.at < 10000 && probeCache.port === port) return Promise.resolve(probeCache.ok);
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      probeCache = { at: Date.now(), ok, port };
      try { sock.destroy(); } catch (e) { }
      resolve(ok);
    };
    sock.setTimeout(800, () => finish(false));
    sock.once('error', () => finish(false));
    sock.once('connect', () => finish(true));
    sock.connect(port, '127.0.0.1');
  });
}

// ── 响应助手（统一错误码 + 访问日志）────────────────────────────
function logAccess(traceId, req, pathname, status, ms, extra) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(accessLog, JSON.stringify({
      ts: new Date().toISOString(), traceId, method: req.method, path: pathname,
      status, ms, from: (req.headers && req.headers['x-workbench-agent']) || '', extra: extra || '',
    }) + '\n');
  } catch (e) { }
}

function send(res, code, obj, headers) {
  const h = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }, headers || {});
  res.writeHead(code, h);
  res.end(JSON.stringify(obj, null, 2));
}
const errBody = (code, msg, extra) => Object.assign({ ok: false, code, err: msg }, extra || {});

// ── 鉴权与来源判定 ────────────────────────────────────────────
function originAllowed(req) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return true;                     // 无 Origin：CLI / 原生脚本
  const list = allowedOrigins();
  return list.length > 0 && list.includes(String(origin));
}
function tokenAllowed(req) {
  const want = gatewayToken();
  const auth = String((req.headers && req.headers.authorization) || '');
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const alt = String((req.headers && req.headers['x-workbench-token']) || '').trim();
  const give = bearer || alt;
  if (!give || give.length !== want.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(give), Buffer.from(want)); } catch (e) { return false; }
}

function readBody(req, limit = 5e5) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > limit) { try { req.destroy(); } catch (e) { } } });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(''));
  });
}

// ── 主入口 ────────────────────────────────────────────────────
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

  // 来源白名单（含预检）
  if (!originAllowed(req)) {
    finish(403, errBody('E_ORIGIN', '此 Origin 不在白名单（跨域请求默认拒绝）'),
      'origin=' + String(req.headers.origin).slice(0, 80));
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

  // 健康检查：可匿名（但只暴露最少信息）
  if (pathname === '/v1/health' && req.method === 'GET') {
    probeEngine().then((ok) => {
      finish(200, {
        ok: true, service: 'workbench-agent-gateway', version: '1.2.0',
        uptimeMs: Date.now() - startedAt,
        engine: { port: enginePort(), reachable: !!ok },
        auth: { required: true, scheme: 'Bearer' },
      });
    }).catch(() => finish(500, errBody('E_ENGINE', 'health 探测失败')));
    return true;
  }

  // 其余一律要 token
  if (!tokenAllowed(req)) {
    finish(401, errBody('E_AUTH', '缺少或错误的 Bearer token（见 外壳/data/gateway-token.json）'));
    return true;
  }

  const withCore = (fn) => core().then(fn).catch((e) => finish(500, errBody('E_INTERNAL', String((e && e.message) || e))));

  // 场景清单：不给真实 sessionId
  if (pathname === '/v1/agents' && req.method === 'GET') {
    withCore((c) => {
      const reg = c.sceneRegistry();
      const agents = reg.map((s) => ({
        id: s.id, title: s.title, bound: !!s.bound,
        sessionHash: s.sessionId ? crypto.createHash('sha256').update(String(s.sessionId)).digest('hex').slice(0, 12) : null,
      }));
      finish(200, { ok: true, count: agents.length, agents });
    });
    return true;
  }

  // 任务列表
  if (pathname === '/v1/tasks' && req.method === 'GET') {
    const q = rawUrl.split('?')[1] || '';
    const limit = Math.max(1, Math.min(200, Number((q.match(/limit=(\d+)/) || [])[1]) || 20));
    withCore((c) => { finish(200, { ok: true, tasks: c.list(limit) }); });
    return true;
  }

  // 单任务
  if (pathname.startsWith('/v1/tasks/') && req.method === 'GET') {
    const taskId = pathname.slice('/v1/tasks/'.length).trim();
    withCore((c) => {
      const t = c.getTask(taskId);
      if (!t) finish(404, errBody('E_VALIDATE', '未找到任务：' + taskId));
      else finish(200, { ok: true, task: t });
    });
    return true;
  }

  // 派单
  if (pathname === '/v1/dispatch' && req.method === 'POST') {
    readBody(req).then((body) => {
      let p = null;
      try { p = JSON.parse(body || '{}'); } catch (e) {
        finish(400, errBody('E_VALIDATE', '请求体不是合法 JSON'));
        return;
      }
      const idemKey = String((req.headers && req.headers['idempotency-key']) || p.idempotencyKey || '').trim() || null;
      withCore((c) => c.dispatch({
        to: p.to || p.toScenario,
        title: p.title,
        content: p.text || p.content,
        from: (req.headers && req.headers['x-workbench-agent']) || p.from || 'agent-api',
        idemKey,
      }).then((r) => {
        if (!r.ok) {
          const map = { E_VALIDATE: 400 };
          finish(map[r.code] || 400, errBody(r.code || 'E_VALIDATE', r.err || '派单失败'));
          return;
        }
        finish(r.replayed ? 200 : 202, {
          ok: true, taskId: r.taskId, status: r.status,
          replayed: !!r.replayed, scene: r.scene || null,
        });
      }));
    });
    return true;
  }

  finish(404, errBody('E_NOTFOUND', '没有这个端点', {
    endpoints: ['GET /v1/health', 'GET /v1/agents', 'GET /v1/tasks', 'GET /v1/tasks/:id', 'POST /v1/dispatch'],
  }));
  return true;
}

// 预热 token（首次启动即落盘，用户/脚本可直接读）
try { gatewayToken(); } catch (e) { }

module.exports = { handle, gatewayToken, enginePort };
