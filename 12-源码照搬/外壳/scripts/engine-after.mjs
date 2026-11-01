#!/usr/bin/env node
// engine-after.mjs —— 升完引擎之后的核对（会话入口；check-gui 第 11 节也会跑它）
//
//   node 外壳\scripts\engine-after.mjs
//
// 换代后工作台最容易坏的四件事，这里一次查完：
//   ① 产物配套：CLI 构建产物在不在（引擎有没有 build 过）
//   ② 上游锚点：壳依赖的那 8 个 DOM/接口标记还在不在（引擎换版第一杀手）
//   ③ 插件接线：插件目录/清单还在不在（工作台默认 0 个插件，但结构得对）
//   ④ 数据目录 + 适配版本：会话库在哪、壳声明的适配版本与引擎实际版本是否一致
//
// ★ 本公开副本是「源码直跑 + 外部引擎」，没有 引擎\ 目录 ⇒ 这些项不适用，
//   脚本会说清楚"不适用"并以 0 退出（check-gui 不该因为'没有引擎'而变红）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUI = path.resolve(HERE, '..');            // …\外壳
const ROOT = path.resolve(GUI, '..');            // …\12-源码照搬
const DATA = path.join(GUI, 'data');

let fails = 0, warns = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { fails++; console.log('  ✗ ' + m); };
const warn = (m) => { warns++; console.log('  ! ' + m); };
const head = (m) => console.log('\n== ' + m + ' ==');

// ---------- 找引擎目录：与 main.js 同一套推导 ----------
function engineDir() {
  const cands = [
    path.join(ROOT, '引擎'),
    path.join(ROOT, '..', '引擎'),
  ];
  for (const c of cands) { try { if (fs.statSync(c).isDirectory()) return c; } catch (e) { /* ignore */ } }
  return '';
}
const ENG = engineDir();
console.log('引擎核对 · ' + GUI);
console.log('引擎目录：' + (ENG || '（没有内置引擎 ⇒ 源码直跑，用外部 CLI）'));

// ---------- 壳自己声明的适配版本 ----------
function adaptedVersion() {
  try {
    const s = fs.readFileSync(path.join(GUI, 'renderer', 'renderers.js'), 'utf8');
    const m = s.match(/var ADAPTED_ENGINE\s*=\s*'([^']+)'/);
    return m ? m[1] : '';
  } catch (e) { return ''; }
}
const ADAPTED = adaptedVersion();

if (!ENG) {
  head('不适用（没有内置引擎目录）');
  console.log('  这套是「源码直跑 + 外部引擎」：引擎由 dsh CLI 提供，不在本仓库里。');
  console.log('  ⇒ 产物配套 / 上游锚点 / 插件接线 这三类核对无从下手，跳过（不是失败）。');
  console.log('  壳侧结构由 scripts\\check-gui.mjs 负责；会话与面板由 sessions.mjs --check 负责。');
  head('仍然核对的项');
  if (ADAPTED) ok('壳声明的适配引擎版本：' + ADAPTED + '（引擎换版后请同步这一行）');
  else warn('renderers.js 里没找到 ADAPTED_ENGINE');
  const dsh = path.join(ROOT, '引擎数据', '.dsh');
  if (fs.existsSync(dsh)) ok('引擎数据目录在：' + path.relative(ROOT, dsh));
  else warn('没有 引擎数据\\.dsh（跑一次「启动工作台」或 工具\\初始化.mjs 会建）');
  console.log('\n结论：不适用（0 失败' + (warns ? ' · ' + warns + ' 提醒' : '') + '）');
  process.exit(0);
}

// ---------- ① 产物配套 ----------
head('① 产物配套（引擎 build 过没有）');
const cliCands = [
  path.join(ENG, 'apps', 'cli', 'lib', 'bin.js'),
  path.join(ENG, 'apps', 'cli', 'dist', 'bin.js'),
  path.join(ENG, 'packages', 'cli', 'lib', 'bin.js'),
];
const cli = cliCands.find((p) => fs.existsSync(p));
if (cli) ok('CLI 入口：' + path.relative(ENG, cli));
else bad('找不到 CLI 构建产物（apps\\cli\\lib\\bin.js）⇒ 先 pnpm run build');

const engPkg = path.join(ENG, 'package.json');
let engVer = '';
try { engVer = String(JSON.parse(fs.readFileSync(engPkg, 'utf8')).version || ''); } catch (e) { warn('读不到引擎 package.json'); }
if (engVer) ok('引擎版本：' + engVer);

// ---------- ② 8 个上游锚点 ----------
head('② 上游锚点（壳依赖的 DOM/接口标记 · 8 个）');
const ANCHORS = [
  { name: '侧栏列 data-side="sidebar"', needles: ['data-side="sidebar"', "data-side='sidebar'", 'data-side'] },
  { name: '对话流 data-chat-flow', needles: ['data-chat-flow'] },
  { name: '启动阶段 data-phase', needles: ['data-phase'] },
  { name: '布局网格 grid-template-columns', needles: ['grid-template-columns'] },
  { name: '会话创建 session/create', needles: ['session/create'] },
  { name: '会话改名 session/rename', needles: ['session/rename'] },
  { name: '工作区存储 workspace.json', needles: ['workspace.json'] },
  { name: '会话缓存 session_projcache', needles: ['session_projcache'] },
];

// 扫引擎源码/产物（跳过 node_modules 与大文件，限时限量）
function collectTextFiles(dirs, cap = 4000) {
  const out = [];
  const skip = new Set(['node_modules', '.git', 'dist-cache', 'coverage', '.turbo']);
  const walk = (d, depth) => {
    if (out.length >= cap || depth > 8) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (out.length >= cap) return;
      if (skip.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!/\.(js|mjs|cjs|ts|tsx|jsx|css|html|json|yml|yaml)$/i.test(e.name)) continue;
      try { if (fs.statSync(p).size > 2 * 1024 * 1024) continue; } catch (err) { continue; }
      out.push(p);
    }
  };
  for (const d of dirs) { try { if (fs.statSync(d).isDirectory()) walk(d, 0); } catch (e) { /* ignore */ } }
  return out;
}
const scanDirs = [path.join(ENG, 'apps'), path.join(ENG, 'packages'), path.join(ENG, 'web'), path.join(ROOT, '引擎数据', '.dsh', 'profiles')];
const files = collectTextFiles(scanDirs);
console.log('  （扫了 ' + files.length + ' 个文本文件）');
for (const a of ANCHORS) {
  let hit = '';
  for (const f of files) {
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    if (a.needles.some((n) => txt.includes(n))) { hit = f; break; }
  }
  if (hit) ok(a.name + '  → ' + path.relative(ENG, hit));
  else bad(a.name + ' 找不到 ⇒ 引擎换版了：先看 renderer\\renderers.js 里对应的选择器再改壳');
}

// ---------- ③ 插件接线 ----------
head('③ 插件接线');
const pluginDirs = [path.join(ROOT, '插件'), path.join(ENG, '插件'), path.join(ROOT, '引擎数据', '.dsh', 'plugins')];
const found = pluginDirs.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } });
if (!found.length) warn('没有插件目录（公开副本默认 0 个插件，正常；装了插件才需要有）');
else for (const d of found) {
  let n = 0;
  try { n = fs.readdirSync(d).filter((x) => !x.startsWith('.')).length; } catch (e) { n = -1; }
  ok('插件目录 ' + path.relative(ROOT, d) + '：' + n + ' 项');
}

// ---------- ④ 数据目录 + 适配版本 ----------
head('④ 数据目录与适配版本');
const dshHome = path.join(ROOT, '引擎数据', '.dsh');
if (fs.existsSync(dshHome)) ok('引擎数据：' + path.relative(ROOT, dshHome));
else bad('引擎数据\\.dsh 不存在 ⇒ 会话/工作区都会重建为空（先跑 工具\\初始化.mjs）');
if (ADAPTED && engVer) {
  if (ADAPTED === engVer) ok('适配版本一致：' + ADAPTED);
  else warn('壳声明的适配版本 ' + ADAPTED + ' ≠ 引擎实际 ' + engVer + ' ⇒ 上面 8 个锚点过了就没大事，但建议同步 renderers.js 的 ADAPTED_ENGINE');
}
// git HEAD（有 git 才有意义）
try {
  const head = execFileSync('git', ['-C', ENG, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head) ok('引擎 HEAD：' + head);
} catch (e) { warn('引擎目录不是 git 仓库（或没有 git），跳过 HEAD'); }

console.log('\n----------------------------------------------------');
console.log(fails ? ('发现 ' + fails + ' 个 FAIL、' + warns + ' 个 warning ✗') : ('全部通过 ✓' + (warns ? '（' + warns + ' 个提醒）' : '')));
process.exit(fails ? 1 : 0);
