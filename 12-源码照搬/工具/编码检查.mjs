#!/usr/bin/env node
// 编码检查 —— 防止「乱码」和「静默读不出」这两类事故。
//
// 为什么需要它（都是真实踩过的）：
//   · 工作台.json 带 UTF-8 BOM ⇒ JSON.parse 静默失败，本机真值整份失效（体检 A13 就是为它加的）
//   · 启动.bat 写成 LF + UTF-8 ⇒ cmd 按 CRLF 逐行解析，把中文行切成碎片当命令执行
//   · 启动.vbs 用 UTF-8 存中文 ⇒ WSH 按 ANSI 读，弹窗里全是问号
//   · PowerShell 5.1 的 .ps1 无 BOM ⇒ 按 ANSI 读，中文全乱
//
// 判据不是「我觉得应该」，是按消费者的真实行为定的：
//   谁读这个文件        它怎么解码              所以要求
//   ────────────────────────────────────────────────────────
//   JSON.parse         严格 UTF-8，BOM 即语法错   必须 UTF-8 且无 BOM
//   Node (require/import) 自动去 BOM              有无都行
//   cmd.exe            按活动代码页逐行读         必须 CRLF；有中文就 UTF-8 无 BOM + 首屏 chcp 65001
//   WSH (cscript/wscript) 按 ANSI 读             非 ASCII 必须 UTF-16LE+BOM（或干脆全 ASCII）
//   PowerShell 5.1     按 ANSI 读，BOM 才认 UTF-8 必须带 BOM
//   PowerShell 7        默认 UTF-8                有无都行
//   浏览器             看 meta charset             与文件实际编码一致
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(TOOL_DIR, '..');

// electron-profile 是 Chromium 的缓存/分区，里面全是不透明的二进制式文件：
// 逐字节判定成"不是合法 UTF-8"属误报，而且它本身是跨机无效的运行时状态。
const SKIP_DIR = new Set([
  '.git', 'node_modules', '.npm-cache', '.npm', '.electron-cache', 'dist', 'out', 'release',
  'electron-profile', 'Crashpad', 'Cache', 'Code Cache', 'GPUCache', 'DawnWebGPUCache', 'Service Worker'
]);
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.pdf', '.zip', '.exe', '.dll', '.node', '.woff', '.woff2', '.ttf', '.mp4', '.webm', '.b64', '.asar', '.log']);

const EXT_KIND = {
  '.json': 'json',
  '.js': 'node', '.mjs': 'node', '.cjs': 'node', '.ts': 'node',
  '.bat': 'cmd', '.cmd': 'cmd',
  '.vbs': 'wsh', '.vbe': 'wsh',
  '.ps1': 'pwsh',
  '.md': 'text', '.txt': 'text', '.yml': 'text', '.yaml': 'text',
  '.html': 'html', '.htm': 'html',
  '.css': 'css'
};

function walk(root, out = []) {
  let ents;
  try { ents = fs.readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    if (SKIP_DIR.has(e.name)) continue;
    const p = path.join(root, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (!SKIP_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

function decode(buf) {
  // 返回 { enc, boms, utf8Ok, text }
  let enc = 'utf8', boms = [], offset = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) { boms.push('utf8'); enc = 'utf8'; offset = 3 }
  else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) { boms.push('utf16le'); enc = 'utf16le'; offset = 2 }
  else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) { boms.push('utf16be'); enc = 'utf16be'; offset = 2 }

  let text = '', utf8Ok = true;
  if (enc === 'utf16le' || enc === 'utf16be') {
    const le = Buffer.from(buf.subarray(offset));
    if (enc === 'utf16be') le.swap16();
    text = le.toString('utf16le');
    utf8Ok = true; // 已是 UTF-16，不参与 UTF-8 判定
  } else {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(offset)) }
    catch { utf8Ok = false; text = buf.subarray(offset).toString('utf8') }
  }
  return { enc, boms, utf8Ok, text };
}

function lineEndings(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  return { crlf, lf, mixed: crlf > 0 && lf > 0 };
}

function hasNonAscii(text) {
  return /[^\x00-\x7F]/.test(text);
}

// 判据：返回问题数组（空 = 合格）
export function inspect(relPath, buf) {
  const ext = path.extname(relPath).toLowerCase();
  const kind = EXT_KIND[ext];
  const { enc, boms, utf8Ok, text } = decode(buf);
  const le = lineEndings(text);
  const nonAscii = hasNonAscii(text);
  const out = [];
  const add = (level, msg) => out.push({ level, msg });

  if (!kind) return { kind: null, enc, boms, le, nonAscii, problems: out };
  if (!utf8Ok && enc === 'utf8') add('red', '不是合法 UTF-8（可能是 GBK/ANSI 存的），按 UTF-8 读会乱码');

  switch (kind) {
    case 'json':
      if (boms.includes('utf8')) add('red', 'UTF-8 BOM：JSON.parse 会直接抛错 ⇒ 整份配置静默失效');
      if (enc === 'utf16le' || enc === 'utf16be') add('red', 'UTF-16 存的 JSON：JSON.parse 读不了');
      break;
    case 'cmd':
      if (le.lf > 0 && le.crlf === 0) add('red', '全是 LF 换行：cmd 会粘连相邻行，把中文切成碎片当命令执行');
      else if (le.mixed) add('yellow', 'CRLF 与 LF 混用：cmd 解析行为不可预期，统一成 CRLF');
      if (boms.length) add('red', '带 BOM：cmd 会把 BOM 当命令的一部分（`﻿@echo off` 报错）');
      if (!boms.length && nonAscii) {
        const hasChcp = /chcp\s+65001/i.test(text);
        if (!hasChcp) add('red', '含中文但没 chcp 65001：cmd 会按 GBK 解码 UTF-8 字节 ⇒ 乱码');
      }
      break;
    case 'wsh':
      if (!boms.includes('utf16le') && nonAscii) add('red', 'UTF-8/ANSI 里写中文：WSH 按 ANSI 读 ⇒ 弹窗乱码（改 UTF-16LE+BOM 或全 ASCII）');
      if (le.lf > 0 && le.crlf === 0) add('yellow', '全是 LF：部分 WSH 版本解析异常，建议 CRLF');
      break;
    case 'pwsh':
      // PowerShell 5.1 是 Windows 自带版本，必须按它的行为判
      if (!boms.length && nonAscii) add('red', 'PowerShell 5.1 读无 BOM 的 UTF-8 会按 ANSI 解码 ⇒ 中文全乱（加 BOM 或存 UTF-16LE）');
      break;
    case 'css':
      // CSS 的编码声明是 @charset 指令，不是 meta；不声明时按引用它的文档/猜测解码
      if (nonAscii && !/@charset\s+["']?utf-?8["']?\s*;/i.test(text)) {
        add('yellow', '含中文但没 @charset "UTF-8"; —— 独立打开或被打包时中文注释可能乱码');
      }
      break;
    case 'html':
      {
        const m = text.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i);
        const declared = m ? m[1].toLowerCase() : null;
        if (nonAscii && !declared) add('yellow', '含中文但没声明 charset：浏览器可能按 latin-1 猜');
        else if (declared && declared.replace(/^utf-?8$/, 'utf8') !== 'utf8' && nonAscii) add('red', `声明 charset=${declared} 但文件是 UTF-8 ⇒ 中文必乱`);
      }
      break;
    default:
      break;
  }
  return { kind, enc, boms, le, nonAscii, problems: out };
}

// ── 自检（坏样本必须被抓到，好样本必须放过）──────────────
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'enc-'));
  for (const [rel, buf] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
  }
  return dir;
}

function runSelfTest() {
  const cases = [];
  const t = (name, files, expect) => cases.push({ name, files, expect });

  t('JSON 带 BOM → 必须报红', {
    'a.json': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}', 'utf8')])
  }, 'red');
  t('JSON 无 BOM → 合格', { 'a.json': Buffer.from('{"a":1}', 'utf8') }, 'ok');
  t('BAT 全 LF + 中文 → 必须报红', {
    'a.bat': Buffer.from('@echo off\nchcp 65001 >nul\necho 你好\n', 'utf8')
  }, 'red');
  t('BAT 全 LF 但纯 ASCII → 也要报红（换行本身就是坑）', {
    'a.bat': Buffer.from('@echo off\necho hi\n', 'utf8')
  }, 'red');
  t('BAT CRLF + chcp + 中文 → 合格', {
    'a.bat': Buffer.from('@echo off\r\nchcp 65001 >nul\r\necho 你好\r\n', 'utf8')
  }, 'ok');
  t('BAT CRLF + 中文但没 chcp → 必须报红', {
    'a.bat': Buffer.from('@echo off\r\necho 你好\r\n', 'utf8')
  }, 'red');
  t('BAT 带 BOM → 必须报红', {
    'a.bat': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('@echo off\r\necho hi\r\n', 'utf8')])
  }, 'red');
  t('VBS 含中文且非 UTF-16 → 必须报红', {
    'a.vbs': Buffer.from('MsgBox "你好"', 'utf8')
  }, 'red');
  t('VBS UTF-16LE + BOM → 合格', {
    'a.vbs': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('MsgBox "hi"', 'utf16le')])
  }, 'ok');
  t('PS1 中文无 BOM → 必须报红（PS 5.1）', {
    'a.ps1': Buffer.from('Write-Host "你好"', 'utf8')
  }, 'red');
  t('PS1 中文带 BOM → 合格', {
    'a.ps1': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Write-Host "你好"', 'utf8')])
  }, 'ok');
  t('GBK 存的 JSON → 必须报红（非法 UTF-8）', {
    'a.json': Buffer.from([0x7b, 0x22, 0xc4, 0xe3, 0x22, 0x3a, 0x31, 0x7d]) // {"你":1} 的 GBK
  }, 'red');
  t('纯 ASCII 的 JS → 合格', { 'a.mjs': Buffer.from('export const a = 1;', 'utf8') }, 'ok');
  t('CSS 含中文没 @charset → 报黄（算不合格，但不阻断）', {
    'a.css': Buffer.from('/* 中文注释 */\n:root{--x:1}', 'utf8')
  }, 'yellow');
  t('CSS 含中文且声明了 @charset → 合格', {
    'a.css': Buffer.from('@charset "UTF-8";\n/* 中文注释 */\n:root{--x:1}', 'utf8')
  }, 'ok');

  let pass = 0, fail = 0;
  for (const c of cases) {
    const dir = fixture(c.files);
    let worst = 'ok';
    for (const rel of Object.keys(c.files)) {
      const { problems } = inspect(rel, fs.readFileSync(path.join(dir, rel)));
      if (problems.some((p) => p.level === 'red')) worst = 'red';
      else if (problems.some((p) => p.level === 'yellow') && worst === 'ok') worst = 'yellow';
    }
    fs.rmSync(dir, { recursive: true, force: true });
    const ok = worst === c.expect;
    console.log(`${ok ? '  ✓' : '  ✗'} ${c.name}${ok ? '' : `（期望 ${c.expect}，实际 ${worst}）`}`);
    ok ? pass++ : fail++;
  }
  console.log(`\n自检：${pass} 通过 · ${fail} 失败`);
  return fail === 0;
}

// ── 扫描（给体检复用）───────────────────────────────────
export function scan(root) {
  const files = walk(root);
  const reds = [], yellows = [], stats = { utf8: 0, 'utf8+bom': 0, utf16le: 0, utf16be: 0 };
  for (const abs of files) {
    const rel = path.relative(root, abs);
    let buf;
    try { buf = fs.readFileSync(abs) } catch { continue }
    if (!buf.length) continue;
    const r = inspect(rel, buf);
    if (r.enc === 'utf8') r.boms.includes('utf8') ? stats['utf8+bom']++ : stats.utf8++;
    else if (r.enc === 'utf16le') stats.utf16le++;
    else stats.utf16be++;
    for (const p of r.problems) {
      const row = { path: rel, kind: r.kind, enc: r.boms.length ? r.enc + '+bom' : r.enc, le: r.le, msg: p.msg };
      if (p.level === 'red') reds.push(row); else yellows.push(row);
    }
  }
  return { root, files: files.length, stats, reds, yellows };
}

// ── CLI ──────────────────────────────────────────────────
// ⚠ 只在「本文件被直接运行」时执行。被 体检.mjs import 时绝不能碰 process.argv / process.exit，
//   否则导入即接管别人的命令行（真实踩过：体检 一 import 就被这里 exit 掉了）。
const IS_MAIN = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return path.resolve(entry) === fileURLToPath(import.meta.url) } catch { return false }
})();

if (IS_MAIN) {
const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null };

if (has('--self-test')) process.exit(runSelfTest() ? 0 : 1);

const root = path.resolve(opt('--root') || DEFAULT_ROOT);
const json = has('--json');
const { files, stats, reds, yellows } = scan(root);

if (json) {
  console.log(JSON.stringify({ root, stats, reds, yellows }, null, 2));
  process.exit(reds.length ? 1 : 0);
}

console.log(`编码检查 · ${root}`);
console.log(`扫了 ${files} 个文本文件：UTF-8 ${stats.utf8} · UTF-8+BOM ${stats['utf8+bom']} · UTF-16LE ${stats['utf16le']}`);
if (!reds.length && !yellows.length) {
  console.log('\n✓ 没有会导致乱码或静默失效的编码问题。');
  process.exit(0);
}
const show = (list, mark) => {
  for (const r of list) {
    console.log(`${mark} ${r.path}`);
    console.log(`    · ${r.msg}`);
  }
};
if (reds.length) { console.log(''); show(reds, '✗') }
if (yellows.length) { console.log(''); show(yellows, '⚠') }
console.log(`\n汇总：${reds.length} 红 · ${yellows.length} 黄`);
process.exit(reds.length ? 1 : 0);
}
