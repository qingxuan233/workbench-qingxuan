#!/usr/bin/env node
// fetch-webai-icons.mjs —— 从各家官网抓「网页版 AI」的官方图标（零依赖）
//
//   node 外壳\scripts\fetch-webai-icons.mjs            # 抓全部 5 个，覆盖 renderer\assets\webai\*.png
//   node 外壳\scripts\fetch-webai-icons.mjs --dry      # 只看能不能抓到（不写文件）
//   node 外壳\scripts\fetch-webai-icons.mjs --only doubao
//
// 为什么要有这个脚本：图标必须是**官网的**（用户 2026-09-21 定的），手抄截图会花。
// 做法：读站点首页 → 找 <link rel="icon|shortcut icon|apple-touch-icon"> → 下载 → 统一成 PNG。
//   · 拿到的就是 PNG ⇒ 原样写；
//   · 拿到 .ico ⇒ 从 ICO 里挑最大的一帧（Vista 之后的 ICO 里常常直接内嵌 PNG，纯 JS 就能拆）；
//   · 都不行 ⇒ 报清楚原因，**不动**已有图标（宁可旧图，也不要破图）。
//
// ⚠ 不改 renderer\assets\webai\ 里的文件名：renderers.js 的 WEB_AI 表按 `<key>.png` 引用。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUI = path.resolve(HERE, '..');
const OUT_DIR = path.join(GUI, 'renderer', 'assets', 'webai');

const SITES = [
  { key: 'deepseek', name: 'DeepSeek', home: 'https://chat.deepseek.com/' },
  { key: 'doubao', name: '豆包', home: 'https://www.doubao.com/chat/' },
  { key: 'tongyi', name: '千问', home: 'https://www.qianwen.com/' },
  { key: 'chatglm', name: '智谱清言', home: 'https://chatglm.cn/main/alltoolsdetail' },
  { key: 'kimi', name: 'Kimi', home: 'https://www.kimi.com/' },
];

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');
const only = (() => { const i = args.indexOf('--only'); return i >= 0 ? String(args[i + 1] || '') : ''; })();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, asText) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: asText ? 'text/html,*/*' : 'image/*,*/*' }, redirect: 'follow', signal: ctl.signal });
    if (!r.ok) return { ok: false, err: 'HTTP ' + r.status };
    const ct = String(r.headers.get('content-type') || '');
    const buf = Buffer.from(await r.arrayBuffer());
    return { ok: true, buf, ct, finalUrl: r.url };
  } catch (e) {
    return { ok: false, err: (e && e.message) || String(e) };
  } finally { clearTimeout(t); }
}

// 从首页 HTML 里挑图标链接（apple-touch-icon 通常最大最规整，优先）
function iconLinks(html, baseUrl) {
  const out = [];
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    if (!/rel\s*=\s*['"][^'"]*icon[^'"]*['"]/i.test(tag)) continue;
    const href = (tag.match(/href\s*=\s*['"]([^'"]+)['"]/i) || [])[1];
    if (!href) continue;
    const rel = ((tag.match(/rel\s*=\s*['"]([^'"]+)['"]/i) || [])[1] || '').toLowerCase();
    const sizes = (tag.match(/sizes\s*=\s*['"]([^'"]+)['"]/i) || [])[1] || '';
    let abs;
    try { abs = new URL(href, baseUrl).toString(); } catch (e) { continue; }
    const rank = (/apple-touch-icon/.test(rel) ? 0 : (/shortcut/.test(rel) ? 1 : 2)) + (/svg/.test(abs) ? 0.5 : 0) - (/(\d+)x\1/.test(sizes) ? 0 : 0.1);
    out.push({ url: abs, rank, sizes });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

const isPng = (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isIco = (b) => b.length > 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0;

/** 从 ICO 里挑最大的一帧；若那帧本身是 PNG（内嵌），直接返回它 */
function pngFromIco(b) {
  const count = b.readUInt16LE(4);
  if (!count || b.length < 6 + count * 16) return null;
  const entries = [];
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    const w = b[off] || 256;
    const h = b[off + 1] || 256;
    const bytes = b.readUInt32LE(off + 8);
    const pos = b.readUInt32LE(off + 12);
    if (pos + bytes > b.length) continue;
    entries.push({ w, h, pos, bytes });
  }
  entries.sort((a, b2) => b2.w * b2.h - a.w * a.h);
  for (const e of entries) {
    const slice = b.subarray(e.pos, e.pos + e.bytes);
    if (isPng(slice)) return slice;
  }
  return null;   // 是 BMP 帧：不引第三方库，交给调用方报"需要手工转"
}

async function resolveIcon(site) {
  const home = await get(site.home, true);
  const cands = [];
  if (home.ok) {
    const html = home.buf.toString('utf8');
    cands.push(...iconLinks(html, home.finalUrl || site.home).map((x) => x.url));
  } else {
    cands.push(new URL('/favicon.ico', site.home).toString());
  }
  const origin = new URL(site.home).origin;
  cands.push(origin + '/favicon.ico', origin + '/apple-touch-icon.png', origin + '/favicon.png');

  const seen = new Set();
  for (const u of cands) {
    if (seen.has(u)) continue;
    seen.add(u);
    const r = await get(u, false);
    if (!r.ok) continue;
    const b = r.buf;
    if (b.length < 200) continue;                       // 空壳/占位
    if (isPng(b)) return { png: b, from: u, how: 'PNG 直取' };
    if (isIco(b)) {
      const png = pngFromIco(b);
      if (png) return { png, from: u, how: 'ICO 内嵌 PNG 拆出' };
      return { err: '拿到的是 ICO（BMP 帧），本脚本不引第三方库转换：' + u };
    }
    // 有些站点对 /favicon.ico 回 SVG/HTML
    const ct = (r.ct || '').toLowerCase();
    if (/svg/.test(ct) || b.toString('utf8', 0, 64).includes('<svg')) {
      return { err: '拿到的是 SVG（不是 PNG）：' + u + ' —— 需要转 PNG 再放进 renderer\\assets\\webai\\' };
    }
  }
  return { err: '没找到可用图标（试过 ' + seen.size + ' 个地址）' };
}

fs.mkdirSync(OUT_DIR, { recursive: true });
console.log('抓官网图标 → ' + path.relative(GUI, OUT_DIR) + (DRY ? '（--dry：不写文件）' : ''));
let okN = 0, failN = 0;

for (const site of SITES) {
  if (only && site.key !== only) continue;
  process.stdout.write('  ' + site.name.padEnd(10) + ' ');
  const r = await resolveIcon(site);
  if (r.err) { console.log('✗ ' + r.err); failN++; continue; }
  const dst = path.join(OUT_DIR, site.key + '.png');
  const old = fs.existsSync(dst) ? fs.statSync(dst).size : 0;
  if (DRY) { console.log('✓ ' + r.how + ' · ' + r.png.length + ' B（现在 ' + (old || '无') + ' B）'); okN++; continue; }
  // 内容没变就别动文件（也别留一堆一模一样的 .prev）
  if (old) {
    let same = false;
    try { const cur = fs.readFileSync(dst); same = cur.length === r.png.length && cur.equals(r.png); } catch (e) { same = false; }
    if (same) { console.log('✓ 已经是最新的（' + r.png.length + ' B，和官网一致），没动文件'); okN++; continue; }
  }
  if (old && !FORCE) {
    try { fs.copyFileSync(dst, dst + '.prev'); } catch (e) { /* ignore */ }
  }
  try {
    fs.writeFileSync(dst, r.png);
    console.log('✓ ' + r.how + ' → ' + site.key + '.png（' + r.png.length + ' B' + (old ? '，旧的存成 .prev' : '') + '）');
    okN++;
  } catch (e) {
    console.log('✗ 写不进去：' + e.message); failN++;
  }
  await sleep(300);   // 别把人家站点打疼
}

console.log('\n完成：' + okN + ' 个 OK' + (failN ? ' · ' + failN + ' 个没抓到' : ''));
if (failN) console.log('没抓到的保持原样（不会写坏图）；要手补：把 PNG 放到 renderer\\assets\\webai\\<key>.png 即可。');
process.exit(failN ? 1 : 0);
