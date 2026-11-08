#!/usr/bin/env node
// webai-mcp.mjs —— 把「网页版 AI」包装成一个标准 MCP 服务（stdio），给 DSH 会话当原生工具用。
//
// 一个进程只伺候一个站：站点由环境变量 WEBAI_KEY 决定（deepseek / doubao / tongyi / chatglm / kimi）。
// 对外只暴露 1 个工具 ask(question, save_image?, timeout_s?)，工具全名 = mcp__webai-<key>__ask。
//
// 链路（和 外壳\scripts\webai.mjs 完全同一条，只是换成 MCP 协议）：
//   本进程 --HTTP--> 127.0.0.1:31239/webai/ask --> 工作台主进程 --> 渲染层 webai-bridge.js
//          --> 顶栏那个已登录的 <webview> 里输入问题、等它答完 --> 回传文字/图片
//
// 为什么"省 token"：回答正文**落盘**，工具只回「路径 + 开头一段」；要看细节再去读文件。
//
// 启动前提：工作台 GUI 开着（桥在主进程里，端口 31239），对应站点已在顶栏登录过一次。
// 用法（手工调试）：node 外壳\scripts\webai-mcp.mjs   然后往 stdin 一行一个 JSON-RPC。
//   ⚠ 正常由 dsh-mcp-client 拉起，不需要手工跑。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '..');          // 12-源码照搬
const DATA = path.join(APP, '外壳', 'data');
// 两种模式（2026-11-08 P1「5 个进程合 1」）：
//   ① 单站模式 WEBAI_KEY=deepseek          → 1 个工具 `ask`（**向后兼容，老配置不用改**）
//   ② 多站模式 WEBAI_KEYS=deepseek,doubao,… → 1 个进程 5 个工具 `ask_<site>`（省掉 4 个 node 常驻进程 + 4 条 stdio）
const KEYS = String(process.env.WEBAI_KEYS || process.env.WEBAI_KEY || '')
  .split(',').map((s) => s.trim()).filter(Boolean).slice(0, 6);
const KEY = KEYS[0] || '';
const MULTI = KEYS.length > 1;
const PORT = Number(process.env.WEBAI_PORT || 31239);
const BASE = 'http://127.0.0.1:' + PORT;
const OUTDIR = path.join(DATA, 'webai-mcp');
const LOGFILE = path.join(OUTDIR, 'server-' + (MULTI ? 'multi' : (KEY || 'unknown')) + '.log');
const VER = '1.1.0';
const SITE_NAMES = {
  deepseek: 'DeepSeek', doubao: '豆包', tongyi: '千问', chatglm: '智谱清言', kimi: 'Kimi',
};
const SITE_USES = {
  deepseek: '复杂推理 / 算法代码 / 深度思考（最难的问题优先问它）',
  doubao: '多模态理解 / AI生图与视频 / 联网日常问答（抖音系链接支持好）',
  tongyi: '中文长文本阅读 / 综合问答 / 创意写作 / 多模态辅助',
  chatglm: '代码编写 / 结构化输出 / 逻辑分析（适合作为第二意见）',
  kimi: '长文档研读 / 深度联网搜索 / 学术资料整理 / 智能体任务',
};
const SITE_NAME = SITE_NAMES[KEY] || KEY || '网页版 AI';
const nameOf = (k) => SITE_NAMES[k] || k || '网页版 AI';

// stdio MCP 只能用 stdio 报错，日志落文件（否则会污染 JSON-RPC 流）
function log(msg) {
  try {
    fs.mkdirSync(OUTDIR, { recursive: true });
    fs.appendFileSync(LOGFILE, new Date().toISOString() + ' ' + msg + '\n');
  } catch (e) { /* 日志失败不影响协议 */ }
}

function send(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch (e) { /* 管道已关 */ }
}
function reply(id, result) { send({ jsonrpc: '2.0', id: id, result: result }); }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id: id, error: { code: code, message: message } }); }

// ── 机密闸：这些内容一律不发往站外服务（判断放在调用之前，不能只写在注释里）──────
// 只拦"像凭据/证件"的形态，别把"怎么省 token"这类正常提问误杀。
const SECRET_PATTERNS = [
  { re: /(password|passwd|密码|口令|secret|密钥|api[_-]?key)\s*[:=：]\s*\S+/i, why: '疑似凭据赋值' },
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/, why: '疑似 API key' },
  { re: /\b\d{17}[\dXx]\b/, why: '疑似身份证号' },
  { re: /\b\d{16,19}\b/, why: '疑似银行卡号' },
  { re: /\b1[3-9]\d{9}\b/, why: '疑似手机号' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: '疑似私钥' },
];
function secretWhy(text) {
  const s = String(text || '');
  for (const p of SECRET_PATTERNS) { if (p.re.test(s)) return p.why; }
  return '';
}

// 把桥回包里夹带的调试标记剔掉（CLI 也是这么做的）
function pickMarker(text) {
  const m = /\[\[webai-img:(\d+)x(\d+):([^:\]]+):([^\]:]+)(?::(shot|toobig))?\]\]/.exec(String(text || ''));
  if (!m) return null;
  return { w: Number(m[1]), h: Number(m[2]), type: m[3], spool: m[4], kind: m[5] || '' };
}
function errMarker(text) {
  const m = /\[\[webai-img-err:([\s\S]*?)\]\]/.exec(String(text || ''));
  return m ? m[1] : '';
}
function cleanText(s) {
  let out = String(s || '');
  out = out.replace(/^\[\[bridge:v[^\]]*\]\]\s*/, '');
  out = out.replace(/\n*\[\[webai-pick:[\s\S]*?\]\]\s*$/m, '');
  out = out.replace(/\n*\[\[webai-img(?:-err)?:[\s\S]*?\]\]\s*$/m, '');
  return out.trim();
}

const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg' };
async function saveImage(marker, wantPath) {
  const ext = EXT[String(marker.type || '').toLowerCase()] || '.png';
  const target = wantPath ? path.resolve(wantPath) : path.join(OUTDIR, KEY + '-' + stamp() + ext);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (marker.kind === 'toobig') {
    // 原图 >3.5MB 塞不进中转文件：桥只落了一份带直链的 meta
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(DATA, 'webai-last-image.json'), 'utf8')); } catch (e) { /* ignore */ }
    if (!meta || !meta.src) throw new Error('原图太大且读不到直链 meta');
    const r = await fetch(meta.src);
    if (!r.ok) throw new Error('直链下载失败 HTTP ' + r.status);
    fs.writeFileSync(target, Buffer.from(await r.arrayBuffer()));
    return { file: target, how: '直链下载' };
  }
  let raw = '';
  try { raw = fs.readFileSync(marker.spool, 'utf8'); } catch (e) { throw new Error('读中转文件失败：' + marker.spool); }
  const comma = raw.indexOf(',');
  const buf = Buffer.from(comma >= 0 ? raw.slice(comma + 1) : raw, 'base64');
  if (!buf.length) throw new Error('中转文件解出来是空的');
  fs.writeFileSync(target, buf);
  return { file: target, how: '中转文件' };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

async function askBridge(key, question, timeoutMs) {
  const r = await fetch(BASE + '/webai/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ key: key, text: question, timeoutMs: timeoutMs }),
  });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch (e) { /* 非 JSON */ }
  if (!j) throw new Error('桥返回的不是 JSON（HTTP ' + r.status + '）：' + t.slice(0, 160));
  return j;
}

// ── 错误分类（2026-11-08 P1「错误码分类」）：把桥/网页回的一串 err 归成可判的码，
//    让调用方（MCP 客户端 / 脚本）能分支处理，而不是只能读中文猜。──────────────────
function errCode(msg) {
  const s = String(msg || '');
  if (/看门狗|超时|timeout|没有收尾/i.test(s)) return 'E_TIMEOUT';
  if (/登录|login|未登录|会话失效|401/i.test(s)) return 'E_LOGIN';
  if (/验证码|滑块|captcha/i.test(s)) return 'E_CAPTCHA';
  if (/卡死|卡住|guest|重建|崩溃|crash/i.test(s)) return 'E_SITE_DEAD';
  if (/熔断|连续 .* 次异常/i.test(s)) return 'E_CIRCUIT_OPEN';
  if (/桥/.test(s) && /(连不上|起不来|refused)/i.test(s)) return 'E_BRIDGE_DOWN';
  return 'E_UNKNOWN';
}

// ── 工具定义（单站 1 个 / 多站 N 个）────────────────────────────────────────
function toolFor(key) {
  const nm = nameOf(key);
  return {
    name: MULTI ? ('ask_' + key) : 'ask',
    description: '免费问「' + nm + '」网页版并取回回答（不花 API token）。用途：' + (SITE_USES[key] || '一次性纯文字任务') +
      '。⚠ 慢（一次几十秒）、同一站点不能并发、只适合一次性任务；回答正文会自动落盘，这里只回路径和开头一段。' +
      '⛔ 不要发密码 / token / 证件号 / 银行卡 / 手机号等机密。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问的问题（纯文本）。可以带上下文，但别太长（站点输入框有上限）。' },
        save_image: { type: 'boolean', description: '要它生成的图片时传 true：回答里若有图，会存到本地并回图片路径。' },
        image_path: { type: 'string', description: '图片保存路径（可选，仅 save_image 为 true 时生效）。未指定时默认存到 外壳\\data\\webai-mcp\\ 目录下。' },
        timeout_s: { type: 'integer', description: '最多等多少秒（默认 180，范围 15~580）。长文/代码建议 240~300。' },
      },
      required: ['question'],
    },
  };
}
const TOOLS = KEYS.map((k) => toolFor(k));
const TOOL = TOOLS[0] || toolFor(KEY);
/** 工具名 → 站点 key（多站模式靠它路由；单站模式兼容老名字） */
function keyOfTool(name) {
  const n = String(name || '');
  if (!MULTI) {
    if (n === 'ask' || n === 'ask_' + KEY || n === 'mcp__webai-' + KEY + '__ask' || n.endsWith('__ask')) return KEY;
    return '';
  }
  if (n.startsWith('ask_')) {
    const k = n.slice(4);
    return KEYS.includes(k) ? k : '';
  }
  // 兼容：客户端可能用 mcp__webai-all__ask_deepseek 这类全名
  const m = n.match(/_+ask_([a-z]+)/);
  if (m && KEYS.includes(m[1])) return m[1];
  if (n.endsWith('__ask') && KEYS.length === 1) return KEYS[0];
  return '';
}

async function toolCall(siteKey, args) {
  const q = String((args && args.question) || '').trim();
  if (!q) return { isError: true, text: '问题为空。' };
  const why = secretWhy(q);
  if (why) {
    log('拒绝发送：' + why);
    return { isError: true, text: '⛔ 已拒绝：问题里含「' + why + '」形态的内容。这些站是站外服务，机密一律不发。' };
  }
  let timeoutS = Number((args && args.timeout_s) || 180);
  if (!isFinite(timeoutS)) timeoutS = 180;
  timeoutS = Math.max(15, Math.min(580, Math.round(timeoutS)));
  const wantImg = !!(args && args.save_image);
  const text = q + (wantImg ? '\n[[save-img]]' : '');
  const t0 = Date.now();
  log('ask ' + siteKey + ' ' + q.slice(0, 40).replace(/\s+/g, ' ') + ' timeout=' + timeoutS + 's img=' + wantImg);

  let j;
  try { j = await askBridge(siteKey, text, timeoutS * 1000); }
  catch (e) {
    return { isError: true, code: 'E_BRIDGE_DOWN', text: '连不上网页版 AI 桥（' + BASE + '）：' + ((e && e.message) || e) + '\n先确认工作台 GUI 开着（桥在主进程里）。' };
  }
  if (!j.ok) {
    log('失败：' + j.err);
    const code = errCode(j.err);
    return { isError: true, code: code, text: '「' + nameOf(siteKey) + '」没答上来（' + code + '）：' + String(j.err || '未知错误') + '（' + Math.round((Date.now() - t0) / 1000) + 's）' };
  }

  const body = cleanText(j.text);
  const seconds = Math.round((j.elapsedMs || (Date.now() - t0)) / 1000);

  // 图片
  let imgNote = '';
  const marker = pickMarker(j.text);
  if (marker) {
    const wantPath = (args && args.image_path) ? String(args.image_path) : '';
    try {
      const saved = await saveImage(marker, wantPath);
      imgNote = '\n[图] ' + saved.file + '（' + marker.w + 'x' + marker.h + '，' + saved.how + '）';
    } catch (e) {
      imgNote = '\n[图] 没取到：' + ((e && e.message) || e);
    }
  } else if (wantImg) {
    const whyImg = errMarker(j.text);
    imgNote = '\n[图] 这次没取到' + (whyImg ? '：' + whyImg : '') + '（页面里可能没有新图）';
  }

  // 正文落盘：只回"路径 + 开头一段"，长回答不进上下文
  const PREVIEW = 1200;
  let head = '';
  let fileInfo = '';
  try {
    fs.mkdirSync(OUTDIR, { recursive: true });
    const f = path.join(OUTDIR, siteKey + '-' + stamp() + '.md');
    fs.writeFileSync(f, '# ' + nameOf(siteKey) + ' · 网页版回答\n\n时间：' + new Date().toLocaleString('zh-CN') +
      '\n问题：\n\n' + q + '\n\n---\n\n' + body + '\n');
    head = body.slice(0, PREVIEW);
    fileInfo = '\n\n[完整回答 ' + body.length + ' 字，已落盘] ' + f;
  } catch (e) {
    // 写盘失败就把能给的都给了，别丢回答
    head = body.slice(0, PREVIEW);
    fileInfo = '\n\n[提示] 回答落盘失败：' + ((e && e.message) || e);
  }

  const more = body.length > PREVIEW ? '\n\n…（后面还有 ' + (body.length - PREVIEW) + ' 字，读上面的文件）' : '';
  log('成功 ' + body.length + ' 字 ' + seconds + 's');
  return {
    isError: false,
    text: head + more + fileInfo + imgNote + '\n\n[' + nameOf(siteKey) + ' 网页版 · ' + seconds + 's · ' + body.length + ' 字]',
  };
}

// ── JSON-RPC over stdio（一行一个 JSON，MCP 标准 stdio 帧）────────────────────
let initialized = false;

function handle(msg) {
  const id = msg.id;
  const method = String(msg.method || '');
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    const want = msg.params && msg.params.protocolVersion;
    // 回客户端要的版本；没有就给一个通用版本（SDK 会自己协商）
    const ver = (typeof want === 'string' && want) ? want : '2025-06-18';
    initialized = true;
    log('initialize ' + ver + ' client=' + JSON.stringify((msg.params && msg.params.clientInfo) || {}) + ' mode=' + (MULTI ? 'multi' : 'single'));
    reply(id, { protocolVersion: ver, capabilities: { tools: {} }, serverInfo: { name: (MULTI ? 'webai-all' : 'webai-' + (KEY || 'unknown')), version: VER } });
    return;
  }
  if (method === 'ping') { reply(id, {}); return; }
  if (method === 'tools/list') { reply(id, { tools: TOOLS }); return; }
  if (method === 'resources/list') { reply(id, { resources: [] }); return; }
  if (method === 'prompts/list') { reply(id, { prompts: [] }); return; }
  if (method === 'tools/call') {
    const p = msg.params || {};
    const name = String(p.name || '');
    const siteKey = keyOfTool(name);
    if (!siteKey) { replyErr(id, -32602, '没有这个工具：' + name + '（可用：' + TOOLS.map((t) => t.name).join(' / ') + '）'); return; }
    toolCall(siteKey, p.arguments || {}).then(function (r) {
      // 错误码放进正文前缀，客户端既能读到码也能读到人话
      const txt = r.isError && r.code ? ('[' + r.code + '] ' + r.text) : r.text;
      reply(id, { content: [{ type: 'text', text: txt }], isError: !!r.isError });
    }).catch(function (e) {
      reply(id, { content: [{ type: 'text', text: '[E_INTERNAL] 服务内部异常：' + ((e && e.message) || e) }], isError: true });
    });
    return;
  }
  // 通知（initialized / cancelled / 其它）：不回应
  if (isNotification) { log('通知 ' + method); return; }
  replyErr(id, -32601, '不支持的方法：' + method);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', function (chunk) {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg = null;
    try { msg = JSON.parse(line); } catch (e) {
      log('收到非 JSON 行：' + line.slice(0, 120));
      continue;
    }
    try { handle(msg); } catch (e) { log('处理异常：' + ((e && e.stack) || e)); }
  }
});
process.stdin.on('end', function () { setTimeout(function () { process.exit(0); }, 200); });
process.on('uncaughtException', function (e) { log('uncaught：' + ((e && e.stack) || e)); });

if (!KEYS.length) { log('❌ 没设 WEBAI_KEY（deepseek/doubao/tongyi/chatglm/kimi）或多站 WEBAI_KEYS=a,b,c'); }
log('启动 mode=' + (MULTI ? 'multi(' + KEYS.join(',') + ')' : 'single(' + KEY + ')') + ' port=' + PORT + ' tools=' + TOOLS.map((t) => t.name).join(','));
