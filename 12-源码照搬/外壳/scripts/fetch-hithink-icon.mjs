#!/usr/bin/env node
// fetch-hithink-icon.mjs —— 抓同花顺官网图标（零依赖）
//
//   node 外壳\scripts\fetch-hithink-icon.mjs          # → renderer\assets\hithink-icon.png
//   node 外壳\scripts\fetch-hithink-icon.mjs --dry    # 只报能不能抓到
//
// 为什么单拎一个：同花顺的图标是**官网**的（renderers.js 里 stock-analysis 那条引用它），
// 而它不在「网页版 AI」那 5 个里，顺手单独做一个入口。
// 抓不到就保持原图不动 —— 旧图好过破图。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUI = path.resolve(HERE, '..');
const DST = path.join(GUI, 'renderer', 'assets', 'hithink-icon.png');

const DRY = process.argv.includes('--dry');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HOME = 'https://www.10jqka.com.cn/';

const isPng = (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isIco = (b) => b.length > 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0;

async function get(url, asText) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: asText ? 'text/html,*/*' : 'image/*,*/*' }, redirect: 'follow', signal: ctl.signal });
    if (!r.ok) return { ok: false, err: 'HTTP ' + r.status };
    return { ok: true, buf: Buffer.from(await r.arrayBuffer()), ct: String(r.headers.get('content-type') || ''), finalUrl: r.url };
  } catch (e) {
    return { ok: false, err: (e && e.message) || String(e) };
  } finally { clearTimeout(t); }
}

function pngFromIco(b) {
  const count = b.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    if (off + 16 > b.length) break;
    const w = b[off] || 256, h = b[off + 1] || 256;
    const bytes = b.readUInt32LE(off + 8), pos = b.readUInt32LE(off + 12);
    if (pos + bytes > b.length) continue;
    entries.push({ w, h, pos, bytes });
  }
  entries.sort((a, c) => c.w * c.h - a.w * a.h);
  for (const e of entries) {
    const slice = b.subarray(e.pos, e.pos + e.bytes);
    if (isPng(slice)) return slice;
  }
  return null;
}

const home = await get(HOME, true);
const cands = [];
if (home.ok) {
  const html = home.buf.toString('utf8');
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    if (!/rel\s*=\s*['"][^'"]*icon[^'"]*['"]/i.test(tag)) continue;
    const href = (tag.match(/href\s*=\s*['"]([^'"]+)['"]/i) || [])[1];
    if (!href) continue;
    try { cands.push(new URL(href, home.finalUrl || HOME).toString()); } catch (e) { /* ignore */ }
  }
} else {
  console.log('  ! 首页打不开（' + home.err + '），直接试 favicon');
}
cands.push('https://www.10jqka.com.cn/favicon.ico', 'https://www.10jqka.com.cn/apple-touch-icon.png');

let got = null;
for (const u of [...new Set(cands)]) {
  const r = await get(u, false);
  if (!r.ok || r.buf.length < 200) continue;
  if (isPng(r.buf)) { got = { png: r.buf, from: u, how: 'PNG 直取' }; break; }
  if (isIco(r.buf)) {
    const png = pngFromIco(r.buf);
    if (png) { got = { png, from: u, how: 'ICO 内嵌 PNG 拆出' }; break; }
  }
}

if (!got) {
  console.log('✗ 没抓到可用的 PNG 图标（' + cands.length + ' 个地址都试过了）');
  console.log('  原图保持不动：' + path.relative(GUI, DST) + (fs.existsSync(DST) ? '（' + fs.statSync(DST).size + ' B）' : '（本来就没有）'));
  process.exit(1);
}
if (DRY) {
  console.log('✓ 能抓到：' + got.how + ' · ' + got.png.length + ' B ← ' + got.from);
  process.exit(0);
}
try {
  // 内容没变就别动文件（也别留一堆一模一样的 .prev）
  if (fs.existsSync(DST)) {
    const cur = fs.readFileSync(DST);
    if (cur.length === got.png.length && cur.equals(got.png)) {
      console.log('✓ 已经是最新的（' + got.png.length + ' B，和官网一致），没动文件');
      process.exit(0);
    }
    fs.copyFileSync(DST, DST + '.prev');
  }
  fs.writeFileSync(DST, got.png);
  console.log('✓ ' + got.how + ' → ' + path.relative(GUI, DST) + '（' + got.png.length + ' B' + (fs.existsSync(DST + '.prev') ? '，旧的存成 .prev' : '') + '）');
  process.exit(0);
} catch (e) {
  console.error('✗ 写不进去：' + e.message);
  process.exit(1);
}
