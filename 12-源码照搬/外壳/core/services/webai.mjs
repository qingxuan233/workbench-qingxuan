/**
 * core/services/webai.mjs —— 出站：网页版 AI 顾问团（调主进程 31239 的 /webai/ask）
 *
 * 链路：core → HTTP POST http://127.0.0.1:31239/webai/ask → main.js 桥 → 渲染层 webai-bridge
 *       → 五个网页版 AI 的 webview DOM → 回包。
 * 约束：
 *   - **不走 spawn**；只做 HTTP 调用。
 *   - INJ-01 已在中间件统一做过（这里不再各写一份机密过滤）。
 *   - 单站失败不影响其他站（Promise.allSettled 语义）。
 */

const DEFAULT_SITES = ['deepseek', 'doubao', 'tongyi', 'chatglm', 'kimi'];
const DEFAULT_ASK_SITES = ['deepseek', 'doubao'];
const ASK_TIMEOUT_DEFAULT = 90000;
const ASK_TIMEOUT_MAX = 180000;

function port() {
  const n = Number(process.env.WEB_AI_PORT);
  return Number.isFinite(n) && n > 0 ? n : 31239;
}
function base() { return 'http://127.0.0.1:' + port(); }

function clampTimeout(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return ASK_TIMEOUT_DEFAULT;
  return Math.max(5000, Math.min(ASK_TIMEOUT_MAX, Math.floor(n)));
}

/** 站点清单：优先问桥（/webai/keys），失败/超时用静态兜底（不阻塞主流程） */
async function siteKeys(opts = {}) {
  const want = Array.isArray(opts.sites) ? opts.sites.map((s) => String(s).trim()).filter(Boolean) : [];
  if (want.length) return want;
  try {
    const r = await fetch(base() + '/webai/keys', { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    const keys = Array.isArray(j && j.keys) ? j.keys.map((k) => String((k && k.key) || '')).filter(Boolean) : [];
    if (keys.length) return keys;
  } catch (e) { /* 桥没起来：走兜底，后面每个站会各自报错 */ }
  return DEFAULT_SITES.slice();
}

/**
 * webai.council：{ question, sites?, timeoutMs? } →
 *   { question, sites, results: { <site>: { ok, text, err, elapsedMs } }, okCount, failedCount }
 */
export async function council(args = {}) {
  const question = String(args.question == null ? '' : args.question).trim();
  if (!question) return { ok: false, code: 'E_VALIDATE', err: '缺少 question（要问顾问团的问题）' };

  const sitesRaw = Array.isArray(args.sites) && args.sites.length ? args.sites : null;
  const sites = sitesRaw ? sitesRaw.map((s) => String(s).trim()).filter(Boolean) : DEFAULT_ASK_SITES.slice();
  const timeoutMs = clampTimeout(args.timeoutMs);

  const results = {};
  const tasks = sites.map(async (site) => {
    const t0 = Date.now();
    try {
      const r = await fetch(base() + '/webai/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ key: site, text: question, timeoutMs }),
        signal: AbortSignal.timeout(timeoutMs + 8000),
      });
      const j = await r.json();
      results[site] = {
        ok: !!(j && j.ok),
        text: String((j && j.text) || '').slice(-8000),
        err: (j && j.ok) ? '' : String((j && j.err) || ('HTTP ' + r.status)),
        elapsedMs: Date.now() - t0,
      };
    } catch (e) {
      results[site] = { ok: false, text: '', err: '调用桥异常：' + String((e && e.message) || e), elapsedMs: Date.now() - t0 };
    }
  });
  await Promise.all(tasks);

  const okCount = Object.values(results).filter((x) => x.ok).length;
  const failedCount = sites.length - okCount;
  const err = okCount ? '' : '一个站都没回话：通常是工作台没开、或五个网页版 AI 窗口没登录';
  return {
    ok: okCount > 0,
    err,
    question,
    sites,
    results,
    okCount,
    failedCount,
    port: port(),
    note: okCount ? '' : err,
  };
}

/** 给 /v1/health、自检用的轻量探针：桥是否在（不触发任何站点） */
export async function bridgeHealth() {
  try {
    const r = await fetch(base() + '/webai/keys', { signal: AbortSignal.timeout(2000) });
    return { ok: r.ok, port: port(), status: r.status };
  } catch (e) {
    return { ok: false, port: port(), err: String((e && e.message) || e) };
  }
}
