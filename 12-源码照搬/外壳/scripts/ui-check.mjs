#!/usr/bin/env node
/**
 * ui-check.mjs —— UI 2.0 壳层自检（2026-11-03）
 *
 *   node scripts/ui-check.mjs
 *
 * 挡住“改 UI 改出白屏”的低级错误：
 *   1) ui/*.js 语法（node --check）
 *   2) index.html 的加载顺序（preload-ui → styles.css → ui.css；ui-*.js 在末尾）
 *   3) index.html 的 id 唯一性 + 壳层依赖的挂载点存在
 *   4) ui/*.js 里静态引用的非动态 id 都能在 index.html 找到
 *   5) ui.css 花括号平衡
 *   6) 体量红线：新增文件 ≤ 800 行
 *
 * 退出码：0 = 全绿；1 = 有 FAIL
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let fails = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { fails++; console.log('  ✗ ' + m); };
const head = (m) => console.log('\n== ' + m + ' ==');

const UI_FILES = [
  'renderer/ui/preload-ui.js',
  'renderer/ui/ui-core.js',
  'renderer/ui/ui-panels.js',
  'renderer/ui/ui-command.js',
  'renderer/ui/ui-shell.js',
  // GUI 优化 P0/P1（2026-11-08）：3 个自举模块也必须进语法/体量/静态 id 检查，
  // 否则"新增文件过了闸"只是因为它压根没被看（自欺，不是通过）。
  'renderer/ui/ui-a11y.js',
  'renderer/ui/ui-credential.js',
  'renderer/ui/ui-empty.js'
];

// ---------- 1) 语法 ----------
head('1. UI 模块语法');
for (const f of UI_FILES) {
  if (!exists(f)) { bad(f + ' 不存在'); continue; }
  const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
  if (r.status === 0) { ok(f); continue; }
  // 受限沙箱里 spawn 子进程可能 EPERM；退回进程内解析（只编译不执行，同样能抓语法错误）
  if (r.error && String(r.error.code || r.error.message).includes('EPERM')) {
    try { new Function(read(f)); ok(f + '（进程内解析）'); }
    catch (e) { bad(f + ' 语法错误：' + e.message); }
    continue;
  }
  bad(f + ' 语法错误：' + String(r.stderr || '').split('\n').slice(0, 4).join(' '));
}

// ---------- 2) index.html 加载顺序 ----------
head('2. index.html 加载顺序');
const html = read('renderer/index.html');
const order = ['ui/preload-ui.js', 'styles.css', 'ui/ui.css', 'ui/ui-core.js', 'ui/ui-panels.js', 'ui/ui-command.js', 'ui/ui-shell.js', 'ui/ui-a11y.js', 'ui/ui-credential.js', 'ui/ui-empty.js'];
let last = -1;
let orderOk = true;
for (const token of order) {
  const at = html.indexOf(token);
  if (at < 0) { bad('index.html 没有引用 ' + token); orderOk = false; continue; }
  if (at < last) { bad('index.html 顺序不对：' + token + ' 出现得太早'); orderOk = false; }
  last = at;
}
if (orderOk) ok('preload-ui → 样式 → core/panels/command/shell 顺序正确');
if (html.indexOf('topbar-status.js') > html.indexOf('ui/ui-core.js')) bad('ui 脚本应在 topbar-status.js 之后加载');
else ok('ui 脚本位于 topbar-status.js 之后');

// ---------- 3) id 唯一性 + 挂载点 ----------
head('3. DOM 挂载点');
const ids = [];
for (const m of html.matchAll(/\bid="([^"]+)"/g)) ids.push(m[1]);
const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
if (dup.length) bad('index.html 有重复 id：' + [...new Set(dup)].join(', '));
else ok('index.html id 唯一（' + ids.length + ' 个）');
const mounts = ['titlebar', 'scenebar', 'scenario-tabs', 'grid', 'harness-view', 'scenario-view', 'status-dot', 'status-text', 'balance-chip', 'modal-mask'];
const missMount = mounts.filter((x) => !ids.includes(x));
if (missMount.length) bad('缺少挂载点：' + missMount.join(', '));
else ok('壳层依赖的挂载点齐全');

// ---------- 4) 静态 id 引用 ----------
head('4. 静态 id 引用');
const known = new Set(ids);
const dynamicPrefixes = ['wb-', 'sf-'];
// 这些 id 由 renderers.js / mcp-panel.js 在运行时创建，不在 index.html 里
const runtimeIds = new Set(['tb-group-ext', 'webai-strip', 'btn-mcp', 'mcp-badge']);
let missing = [];
for (const f of UI_FILES) {
  const src = read(f);
  for (const m of src.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) {
    const id = m[1];
    if (dynamicPrefixes.some((p) => id.startsWith(p))) continue; // 壳层自己创建的节点
    if (runtimeIds.has(id)) continue;                             // 运行时注入的节点
    if (!known.has(id)) missing.push(f + ' → #' + id);
  }
}
missing = [...new Set(missing)];
if (missing.length) bad('引用了不存在的 id：' + missing.join('；'));
else ok('静态 id 引用全部存在');

// ---------- 5) CSS 花括号 ----------
head('5. ui.css 结构');
const css = read('renderer/ui/ui.css');
let depth = 0, broken = false;
for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
  if (ch === '{') depth++;
  else if (ch === '}') { depth--; if (depth < 0) { broken = true; break; } }
}
if (broken || depth !== 0) bad('ui.css 花括号不平衡（depth=' + depth + '）');
else ok('ui.css 花括号平衡');
if (!css.includes('body.wb-v2')) bad('ui.css 没有 body.wb-v2 作用域，可能污染经典界面');
else ok('ui.css 已限定 body.wb-v2 作用域');

// ---------- 6) 体量红线 ----------
head('6. 体量红线（新增文件 ≤ 800 行）');
for (const f of UI_FILES.concat(['renderer/ui/ui.css'])) {
  const n = read(f).split(/\r?\n/).length;
  if (n > 800) bad(f + ' 有 ' + n + ' 行，超过 800 行红线');
  else ok(f + '（' + n + ' 行）');
}

console.log('\n' + (fails ? '✗ UI 自检失败：' + fails + ' 项' : '✓ UI 自检全部通过'));
process.exit(fails ? 1 : 0);
