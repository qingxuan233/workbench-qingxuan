/**
 * core/middleware.mjs —— 固定中间件管线（唯一实现，face 层不许各写一份）
 *
 * 顺序（P1 接口契约 §三，固定）：
 *   authz → INJ-01(机密出境) → rateLimit → executor → CMP-01(修剪/溢出) → audit
 *
 * 约定：
 *   - ctx = { face, agent, traceId, scopes, now }（face 层用 makeCtx 生成，见 index.mjs）
 *   - 任一步失败统一返回 { ok:false, code, err }
 *   - CMP-01 的 6KB 阈值与溢出目录（外壳/data/mcp-spool/）与旧 MCP 实现一致，
 *     协议面删掉自己那份后行为不变。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));          // 外壳/core
const APP = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..', '..');   // → 12-源码照搬（应用根）
const DATA_DIR = path.join(APP, '外壳', 'data');
const SPOOL_DIR = path.join(DATA_DIR, 'mcp-spool');
const AUDIT_LOG = path.join(DATA_DIR, 'core-audit.log');

/** 管线顺序（唯一定义；registry 的描述符 middleware 字段引用这里） */
export const PIPELINE = ['authz', 'inj01', 'rateLimit', 'executor', 'cmp01', 'audit'];

/** 错误码（face 层按各自协议翻译） */
export const CODES = {
  E_AUTH: 'E_AUTH',
  E_INJ: 'E_INJ',
  E_RATE: 'E_RATE',
  E_TIMEOUT: 'E_TIMEOUT',
  E_VALIDATE: 'E_VALIDATE',
  E_ENGINE: 'E_ENGINE',
  E_NOTFOUND: 'E_NOTFOUND',
  E_INTERNAL: 'E_INTERNAL',
};

const fail = (code, err, extra) => Object.assign({ ok: false, code, err: String(err || '') }, extra || {});

// ── INJ-01 机密过滤闸（从 scripts/workbench-mcp.mjs:68-80 抽出，唯一一份）──────
const SECRET_PATTERNS = [
  { re: /(password|passwd|密码|口令|secret|密钥|api[_-]?key)\s*[:=：]\s*\S+/i, why: '疑似凭据赋值' },
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/, why: '疑似 API key' },
  { re: /\b\d{17}[\dXx]\b/, why: '疑似身份证号' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: '疑似私钥' },
];

/** 检查一段文本里是否有机密（返回命中的类别说明，没有返回 ''） */
export function checkSecret(text) {
  const s = String(text == null ? '' : text);
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(s)) return p.why;
  }
  return '';
}

/** 深度扫描入参里的所有字符串值（避免"藏在嵌套对象里就漏过"） */
export function scanSecretsDeep(value, depth = 0) {
  if (depth > 6 || value == null) return '';
  if (typeof value === 'string') return checkSecret(value);
  if (typeof value === 'number' || typeof value === 'boolean') return '';
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = scanSecretsDeep(v, depth + 1);
      if (hit) return hit;
    }
    return '';
  }
  if (typeof value === 'object') {
    for (const k of Object.keys(value)) {
      // key 本身（如 password）不算泄漏；只看值
      const hit = scanSecretsDeep(value[k], depth + 1);
      if (hit) return hit;
    }
  }
  return '';
}

// ── rateLimit（本地限流：默认 60 次/分，按 agent 或 face）───────────────
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 60;
const buckets = new Map(); // key -> { count, windowStart }

/** 测试/长驻进程用：清空限流桶 */
export function resetRateLimit() {
  buckets.clear();
}

function rateLimit(ctx, cap) {
  if (ctx && ctx.rateLimit === false) return null;
  const limit = Number(ctx && ctx.rateLimitMax) > 0 ? Number(ctx.rateLimitMax) : (cap.rateLimitMax || RATE_MAX);
  const key = 'k:' + String((ctx && (ctx.agent || ctx.face)) || 'local');
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.windowStart >= RATE_WINDOW_MS) {
    b = { count: 0, windowStart: now };
    buckets.set(key, b);
  }
  b.count += 1;
  if (b.count > limit) {
    return fail(CODES.E_RATE, '限流：' + limit + ' 次/' + Math.round(RATE_WINDOW_MS / 1000) + 's 已用完（key=' + key + '）', {
      retryAfterMs: Math.max(0, RATE_WINDOW_MS - (now - b.windowStart)),
    });
  }
  return null;
}

// ── CMP-01 结果修剪 / 溢出落盘（与旧 MCP 的 6KB 阈值、目录一致）────────
export const MAX_RESULT_CHARS = 6000;
const PREVIEW_CHARS = 500;
const LONG_STRING = 1200;
const MAX_ARRAY = 20;

function relFromApp(abs) {
  try { return path.relative(APP, abs).split(path.sep).join('/'); } catch (e) { return String(abs); }
}

/** 对超大结果做"可读的修剪"：长字符串截断、长数组保留前 N 条，并附 _cmp 元信息 */
function trimValue(value, depth = 0) {
  if (depth > 6) return value;
  if (typeof value === 'string') {
    return value.length > LONG_STRING ? value.slice(0, LONG_STRING) + '…（已截断）' : value;
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((v) => trimValue(v, depth + 1));
    if (value.length > MAX_ARRAY) head.push('…（另 ' + (value.length - MAX_ARRAY) + ' 条已省略，完整结果见落盘文件）');
    return head;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = trimValue(value[k], depth + 1);
    return out;
  }
  return value;
}

/**
 * CMP-01：超过阈值就把完整 JSON 落盘，返回修剪后的结果 + _cmp 说明。
 * 任何落盘失败都降级为"直接截断"，不阻断主流程。
 */
export function pruneResult(name, result) {
  let json = '';
  try { json = JSON.stringify(result); } catch (e) { return result; }
  if (!json || json.length <= MAX_RESULT_CHARS) return result;

  let spool = '';
  try {
    fs.mkdirSync(SPOOL_DIR, { recursive: true });
    const safeName = String(name || 'result').replace(/[^A-Za-z0-9._-]/g, '_');
    const target = path.join(SPOOL_DIR, safeName + '-' + Date.now() + '.json');
    fs.writeFileSync(target, JSON.stringify(result, null, 2), 'utf8');
    spool = relFromApp(target);
  } catch (e) { spool = ''; }

  const trimmed = trimValue(result);
  const out = Object.assign({}, trimmed, {
    ok: (result && typeof result.ok === 'boolean') ? result.ok : true,
    _cmp: {
      truncated: true,
      bytes: Buffer.byteLength(json),
      limit: MAX_RESULT_CHARS,
      preview: json.slice(0, PREVIEW_CHARS),
      spool: spool,
      note: spool ? '完整结果已落盘（相对路径见 spool）' : '落盘失败，已就地截断',
    },
  });
  return out;
}

// ── true 空函数占位 ─────────────────────────────────────────────────
function nowISO() { return new Date().toISOString(); }

// ── authz ───────────────────────────────────────────────────────────
function authz(cap, ctx) {
  const a = (cap && cap.authz) || {};
  if (a.open) return null;
  const faces = Array.isArray(a.faces) ? a.faces : [];
  if (faces.length && !faces.includes(ctx.face)) {
    return fail(CODES.E_AUTH, 'face「' + ctx.face + '」无权调用 ' + cap.name + '（允许：' + faces.join('/') + '）');
  }
  const need = Array.isArray(a.scopes) ? a.scopes : [];
  const have = Array.isArray(ctx.scopes) ? ctx.scopes : [];
  const trustedLocal = have.includes('local-full');
  const missing = need.filter((s) => !have.includes(s));
  if (missing.length && !trustedLocal) {
    return fail(CODES.E_AUTH, '缺少 scope：' + missing.join(',') + '（当前：' + (have.join(',') || '无') + '）');
  }
  return null;
}

// ── 入参校验（递归 JSON Schema：required / 类型 / enum / 数组项 / 嵌套对象）────
/**
 * validateValue(value, spec, path, depth) → '' 通过 / '人话原因' 失败
 *
 * P4-深校验（2026-11-10）：原来只查顶层类型，`artifacts` 里少个 `path`、`sites` 里塞个数字都能混进去。
 * 现在递归到 **depth ≤ 3**（防止恶意深嵌套把校验变成 DoS），覆盖：
 *   ① required 字段必须给值 ② type / enum ③ 数组每一"项" ④ 嵌套对象的声明字段
 *   ⑤ 声明了 `additionalProperties:false` 的对象不接受多余字段（默认不设，向后兼容）
 * 约定：`undefined` / `null` 的可选字段一律跳过（调用方 JS 里写死的 undefined 不算错）。
 */
const VALIDATE_MAX_DEPTH = 3;

export function validateValue(value, spec, pathStr, depth) {
  const spec2 = (spec && typeof spec === 'object') ? spec : {};
  const at = pathStr || '入参';
  if (Array.isArray(spec2.enum) && spec2.enum.length && !spec2.enum.includes(value)) {
    return at + ' 只能是 ' + spec2.enum.join('/');
  }
  switch (spec2.type) {
    case 'string': if (typeof value !== 'string') return at + ' 必须是字符串'; break;
    case 'number': if (!(typeof value === 'number' && Number.isFinite(value))) return at + ' 必须是有限数字'; break;
    case 'boolean': if (typeof value !== 'boolean') return at + ' 必须是布尔'; break;
    case 'array': {
      if (!Array.isArray(value)) return at + ' 必须是数组';
      if (depth < VALIDATE_MAX_DEPTH && spec2.items) {
        for (let i = 0; i < value.length; i++) {
          const e = validateValue(value[i], spec2.items, at + '[' + i + ']', depth + 1);
          if (e) return e;
        }
      }
      break;
    }
    case 'object': {
      if (!(typeof value === 'object' && value !== null && !Array.isArray(value))) return at + ' 必须是对象';
      if (depth < VALIDATE_MAX_DEPTH) {
        const props = (spec2.properties && typeof spec2.properties === 'object') ? spec2.properties : {};
        const req = Array.isArray(spec2.required) ? spec2.required : [];
        for (const k of req) {
          if (value[k] === undefined || value[k] === null) return at + ' 缺少必填字段 ' + k;
        }
        for (const k of Object.keys(props)) {
          const v = value[k];
          if (v === undefined || v === null) continue;
          const e = validateValue(v, props[k], at + '.' + k, depth + 1);
          if (e) return e;
        }
        if (spec2.additionalProperties === false) {
          const extra = Object.keys(value).filter((k) => !props[k]);
          if (extra.length) return at + ' 不接受多余字段：' + extra.join(',');
        }
      }
      break;
    }
    default: break;
  }
  return '';
}

/**
 * validateArgs(cap, args) → '' 通过 / '人话原因' 失败
 *
 * 校验点放在 executor 入口（不新增管线步骤，PIPELINE 顺序保持 authz→INJ-01→rateLimit→executor→CMP-01→audit）。
 */
export function validateArgs(cap, args) {
  const schema = (cap && cap.inputSchema) || {};
  if (!(args && typeof args === 'object' && !Array.isArray(args))) return '入参必须是对象';
  const root = Object.assign({}, schema, { type: schema.type || 'object' });
  return validateValue(args, root, '', 0);
}

// ── executor（带超时）────────────────────────────────────────────────
async function execute(cap, args, ctx) {
  const bad = validateArgs(cap, args);
  if (bad) return fail(CODES.E_VALIDATE, '入参校验失败：' + bad + '（' + cap.name + '）');
  const ms = Number(cap.timeoutMs) > 0 ? Number(cap.timeoutMs) : 30000;
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fail(CODES.E_TIMEOUT, '能力执行超时（' + ms + 'ms）：' + cap.name)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    const out = await Promise.race([Promise.resolve().then(() => cap.run(args || {}, ctx)), timeout]);
    if (out && out.ok === false) {
      return fail(out.code || 'E_DOMAIN', out.err || '能力返回失败', out);
    }
    return Object.assign({ ok: true }, out || {});
  } catch (e) {
    return fail(CODES.E_INTERNAL, String((e && e.message) || e));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── audit（JSONL；也不许因为写日志把主流程打挂）────────────────────────
function audit(entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_LOG, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) { /* 忽略 */ }
}

// ── 主入口：跑完整管线 ────────────────────────────────────────────────
export async function runPipeline(cap, args, ctx) {
  const t0 = Date.now();
  const traceId = String(ctx.traceId || ('t' + crypto.randomBytes(6).toString('hex')));
  const base = { entry: 'core', cap: cap.name };

  const step1 = authz(cap, ctx);
  if (step1) { audit(Object.assign({ ts: nowISO(), traceId, face: ctx.face, agent: ctx.agent, code: step1.code, ok: false, ms: Date.now() - t0 }, base)); return Object.assign(step1, { traceId }); }

  const sec = scanSecretsDeep(args);
  if (sec) {
    const r = fail(CODES.E_INJ, '[INJ-01 拦截] 入参包含敏感信息（' + sec + '），拒绝执行');
    audit(Object.assign({ ts: nowISO(), traceId, face: ctx.face, agent: ctx.agent, code: r.code, ok: false, ms: Date.now() - t0 }, base));
    return Object.assign(r, { traceId });
  }

  const step2 = rateLimit(ctx, cap);
  if (step2) { audit(Object.assign({ ts: nowISO(), traceId, face: ctx.face, agent: ctx.agent, code: step2.code, ok: false, ms: Date.now() - t0 }, base)); return Object.assign(step2, { traceId }); }

  const out = await execute(cap, args, ctx);
  const route = (out && typeof out.engineRoute === 'string' && out.engineRoute) ? out.engineRoute : '';
  if (out.ok === false) {
    audit(Object.assign({ ts: nowISO(), traceId, face: ctx.face, agent: ctx.agent, code: out.code, ok: false, ms: Date.now() - t0 }, base, route ? { engineRoute: route } : {}));
    return Object.assign(out, { traceId });
  }

  const pruned = pruneResult(cap.name, out);
  const ms = Date.now() - t0;
  audit(Object.assign({ ts: nowISO(), traceId, face: ctx.face, agent: ctx.agent, ok: true, ms }, base, route ? { engineRoute: route } : {}));
  const ret = Object.assign({ ok: true }, pruned, { traceId, ms });
  delete ret._trace;
  return ret;
}
