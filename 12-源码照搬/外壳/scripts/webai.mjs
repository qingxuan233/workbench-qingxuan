#!/usr/bin/env node
// webai.mjs —— 会话/脚本问「网页版 AI」的入口（不花 API token）
//
// 链路（主进程那半在 外壳\main.js 的「内置网页版 AI 桥」，监听 127.0.0.1:31239）：
//   本脚本 → POST /webai/ask → 主进程 → 渲染层 外壳\renderer\webai-bridge.js（复用顶栏那 5 个 <webview>，
//   登录态在 partition=persist:webai-<key> 里）→ 往页面输入问题、等它答完 → 回传文字/图片。
//
// 用法：
//   node 外壳\scripts\webai.mjs keys                      # 列出可问的 key（deepseek/doubao/tongyi/chatglm/kimi）
//   node 外壳\scripts\webai.mjs state                      # 桥在不在、有没有任务在跑（排障）
//   node 外壳\scripts\webai.mjs who                        # 多窗口时"到底会派给哪个窗口"（桥版本）
//   node 外壳\scripts\webai.mjs ask doubao "帮我写一句 slogan"
//   node 外壳\scripts\webai.mjs ask kimi "解释一下这段代码" --timeout 300
//   node 外壳\scripts\webai.mjs ask doubao "画一只鲸鱼" --save-image "./鲸鱼.png"
//
// 说明：
//   · 网页版是**可见的窗口**：问的时候那个窗口会自己打字，遇到验证码你可以直接接手；
//   · 要图时加 --save-image（不指定路径就落到 外壳\data\webai-last-image.<ext>）；
//   · 回答里夹带的 [[bridge:v..]] / [[webai-pick:..]] / [[webai-img:..]] 是本机调试标记，默认从输出里剔掉，
//     要看原文加 --raw。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const DATA = path.join(APP, 'data');
const PORT = Number(process.env.WEB_AI_PORT || 31239);
const BASE = 'http://127.0.0.1:' + PORT;

const argv = process.argv.slice(2);
const cmd = String(argv[0] || '').toLowerCase();
const rest = argv.slice(1);
const has = (k) => argv.includes(k);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

function die(msg, code = 1) { console.error('✗ ' + msg); process.exit(code); }
function usage() {
  console.error([
    '用法：',
    '  node scripts\\webai.mjs keys',
    '  node scripts\\webai.mjs state | who',
    '  node scripts\\webai.mjs ask <key> "<问题>" [--timeout 秒] [--save-image [路径]] [--raw] [--json]',
    '',
    'key 见 keys（deepseek / doubao / tongyi / chatglm / kimi）。桥要先开工作台 GUI（端口 ' + PORT + '）。',
  ].join('\n'));
  process.exit(2);
}

async function getJson(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch (e) { /* 非 JSON */ }
  return { status: r.status, json: j, text: t };
}

// 把回答里的调试标记剔掉（默认输出干净可读的正文）
function cleanText(s, keepRaw) {
  let out = String(s || '');
  if (keepRaw) return out;
  out = out.replace(/^\[\[bridge:v[^\]]*\]\]\s*/, '');
  out = out.replace(/\n*\[\[webai-pick:[\s\S]*?\]\]\s*$/m, '');
  return out.trim();
}

function pickMarker(text) {
  const m = /\[\[webai-img:(\d+)x(\d+):([^:\]]+):([^\]:]+)(?::(shot|toobig))?\]\]/.exec(String(text || ''));
  if (!m) return null;
  return { w: Number(m[1]), h: Number(m[2]), type: m[3], spool: m[4], kind: m[5] || '' };
}

function errMarker(text) {
  const m = /\[\[webai-img-err:([\s\S]*?)\]\]/.exec(String(text || ''));
  return m ? m[1] : '';
}

const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg' };

async function saveImage(marker) {
  const want = has('--save-image') ? String(val('--save-image', '') || '') : '';
  const ext = EXT[String(marker.type || '').toLowerCase()] || '.png';
  const target = want ? path.resolve(want) : path.join(DATA, ('webai-last-image' + ext));
  if (want && fs.existsSync(want) && fs.statSync(want).isDirectory()) die('--save-image 给的是目录：' + want);

  if (marker.kind === 'toobig') {
    // 原图 >3.5MB、塞不进中转文件：桥只留了 meta，里面有 CDN 直链，会话侧没有 CORS ⇒ 直接下
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(DATA, 'webai-last-image.json'), 'utf8')); } catch (e) { /* ignore */ }
    if (!meta || !meta.src) die('原图太大且读不到直链 meta（' + path.join(DATA, 'webai-last-image.json') + '）');
    const r = await fetch(meta.src);
    if (!r.ok) die('直链下载失败 HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buf);
    return { file: target, bytes: buf.length, how: '直链下载' };
  }

  let raw = '';
  try { raw = fs.readFileSync(marker.spool, 'utf8'); } catch (e) { die('读中转文件失败：' + marker.spool + '（' + ((e && e.message) || e) + '）'); }
  const comma = raw.indexOf(',');
  const b64 = comma >= 0 ? raw.slice(comma + 1) : raw;
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) die('中转文件解出来是空的：' + marker.spool);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buf);
  return { file: target, bytes: buf.length, how: '中转文件' };
}

// ── 命令分发 ────────────────────────────────────────────────────────────────────────────
try {
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') usage();

  if (cmd === 'keys') {
    const r = await getJson(BASE + '/webai/keys');
    if (!r.json || !Array.isArray(r.json.keys)) die('桥没起来（HTTP ' + r.status + '）—— 先开工作台 GUI（端口 ' + PORT + '）\n' + r.text.slice(0, 200));
    if (has('--json')) { console.log(JSON.stringify(r.json, null, 1)); process.exit(0); }
    console.log('可问的网页版 AI（不花 API token）：');
    for (const k of r.json.keys) console.log('  ' + k.key.padEnd(10) + String(k.name).padEnd(10) + k.url);
    process.exit(0);
  }

  if (cmd === 'state' || cmd === 'who') {
    const r = await getJson(BASE + '/webai/' + cmd);
    if (!r.json) die('桥没起来（HTTP ' + r.status + '）—— 先开工作台 GUI（端口 ' + PORT + '）');
    console.log(JSON.stringify(r.json, null, 1));
    process.exit(0);
  }

  if (cmd === 'ask') {
    const key = String(rest[0] || '').trim();
    let text = String(rest[1] || '').trim();
    if (!key || !text) usage();
    // 文本里可能带 --xxx：只有 take 到两个位置参数后才把剩下的当选项
    if (!text && has('--file')) {
      try { text = fs.readFileSync(String(val('--file', '')), 'utf8').trim(); } catch (e) { die('读 --file 失败：' + ((e && e.message) || e)); }
    }
    const timeoutMs = Math.max(5, Number(val('--timeout', 180))) * 1000;
    if (has('--save-image')) text += '\n[[save-img]]';   // 桥认得这个开关：答完把图抓进中转文件

    const t0 = Date.now();
    const r = await getJson(BASE + '/webai/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ key, text, timeoutMs }),
    });
    const j = r.json || {};
    if (has('--json')) { console.log(JSON.stringify(j, null, 1)); process.exit(j.ok ? 0 : 1); }
    if (!j.ok) die(String(j.err || ('HTTP ' + r.status)) + '（' + Math.round((Date.now() - t0) / 1000) + 's）');

    const body = cleanText(j.text, has('--raw'));
    console.log(body);
    const marker = pickMarker(j.text);
    if (marker) {
      const saved = await saveImage(marker);
      console.error('\n[图] ' + saved.file + '（' + marker.w + 'x' + marker.h + '，' + Math.round(saved.bytes / 1024) + ' KB，' + saved.how + '）');
    } else {
      const why = errMarker(j.text);
      if (why) console.error('\n[图] 没取到：' + why);
    }
    console.error('\n[' + key + ' v' + (j.ver || '?') + ' · ' + Math.round((j.elapsedMs || (Date.now() - t0)) / 1000) + 's · ' + String(j.text || '').length + ' 字]');
    process.exit(0);
  }

  usage();
} catch (e) {
  die('连不上桥（' + BASE + '）：' + ((e && e.message) || e) + '\n先开工作台 GUI；端口不对就设 WEB_AI_PORT。');
}
