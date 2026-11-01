#!/usr/bin/env node
// 引擎快照.mjs —— 引擎"启动配置"的存档与回退（顶栏「引擎快照 / 引擎回退」按钮的背后工具）
//
//   node 工具\引擎快照.mjs --save                 # 存一代（最多留 5 代）
//   node 工具\引擎快照.mjs --list                 # 列出各代（顶栏卡片按这个格式解析）
//   node 工具\引擎快照.mjs --restore [--yes]      # 回到最近一代（先备份当前）
//   node 工具\引擎快照.mjs --restore-gen gen-20261101... [--yes]
//
// ⛔ 只碰**启动配置**（profile 的 cordis.yml / cordis.patch.yml / package.json / 插件接线 JSON /
//    settings.json），绝不碰源码、构建产物、会话数据。源码坏了要走 git，这个工具做不到，也不该自动做。
//
// 存放：外壳\data\engine-good\gen-<时间>\（文件按相对路径平铺保存）+ manifest.json
//       回退前把当前配置另存成 外壳\data\engine-good\pre-restore-<时间>\
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');                 // …\12-源码照搬
const APP = path.join(ROOT, '外壳');
const STORE = path.join(APP, 'data', 'engine-good');
const KEEP = 5;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : ''; };
const yes = has('--yes') || has('-y');

// ---------- 要存哪些文件：引擎启动就靠这些，缺了会起不来或插件全掉 ----------
function configCandidates() {
  const list = [];
  const webProfile = path.join(ROOT, '引擎数据', '.dsh', 'profiles', 'web');
  for (const f of ['cordis.yml', 'cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml']) {
    list.push(path.join(webProfile, f));
  }
  // 插件接线：profiles\web 下除上面四个以外的 json（plugins.json 之类）
  try {
    for (const e of fs.readdirSync(webProfile)) {
      if (!/\.json$/i.test(e)) continue;
      const p = path.join(webProfile, e);
      if (!list.includes(p)) list.push(p);
    }
  } catch (e) { /* 目录不存在就算了 */ }
  list.push(path.join(ROOT, '引擎数据', '.dsh', 'settings.json'));
  list.push(path.join(ROOT, '引擎数据', '.dsh', 'settings.local.json'));
  // 壳侧影响"启动长什么样"的两份配置（切场景顺序、启动动画预览值）
  list.push(path.join(APP, 'data', 'scene-tab-order.json'));
  list.push(path.join(APP, 'data', 'boot-animation.json'));
  return [...new Set(list)];
}

function engineInfo() {
  const dirs = [path.join(ROOT, '引擎'), path.join(ROOT, '..', '引擎')];
  const ENG = dirs.find((d) => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } }) || '';
  let ver = '（外部引擎）', head = '';
  if (ENG) {
    try { ver = String(JSON.parse(fs.readFileSync(path.join(ENG, 'package.json'), 'utf8')).version || ver); } catch (e) { /* ignore */ }
    try { head = String(execFileSync('git', ['-C', ENG, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }) || '').trim(); } catch (e) { head = ''; }
  }
  return { dir: ENG, ver, head };
}

const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}
function fmtAt(iso) {
  const d = new Date(iso);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function gens() {
  try {
    return fs.readdirSync(STORE).filter((d) => /^gen-\d{8,}$/.test(d)).sort().reverse();
  } catch (e) { return []; }
}
function readManifest(gen) {
  try { return JSON.parse(fs.readFileSync(path.join(STORE, gen, 'manifest.json'), 'utf8')); } catch (e) { return null; }
}

// ---------- 存一代 ----------
function save() {
  const files = configCandidates().filter((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
  if (!files.length) {
    console.error('✗ 一个启动配置文件都没找到（先启动一次工作台，让它生成 引擎数据\\.dsh\\profiles\\web\\…）');
    return 1;
  }
  const gen = 'gen-' + stamp();
  const dir = path.join(STORE, gen);
  const info = engineInfo();
  const rows = [];
  for (const src of files) {
    const rel = path.relative(ROOT, src);
    const dst = path.join(dir, rel);
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      rows.push({ rel, size: fs.statSync(src).size });
    } catch (e) { console.error('  ! 跳过 ' + rel + '（' + e.message + '）'); }
  }
  const man = { gen, at: new Date().toISOString(), engine: { dir: info.dir ? path.relative(ROOT, info.dir) : null, ver: info.ver, head: info.head }, files: rows };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(man, null, 1), 'utf8');
  // 只留最近 KEEP 代
  const all = gens();
  for (const old of all.slice(KEEP)) {
    try { fs.rmSync(path.join(STORE, old), { recursive: true, force: true }); console.log('  · 清掉旧的一代 ' + old); } catch (e) { /* ignore */ }
  }
  console.log('✓ 已存一代：' + gen + '（' + rows.length + ' 个启动配置 · 引擎 ' + info.ver + (info.head ? ' · HEAD ' + info.head : '') + '）');
  console.log('  位置：' + path.relative(ROOT, dir));
  console.log('  现有 ' + gens().length + ' 代（上限 ' + KEEP + '）：--list 看全部');
  return 0;
}

function list() {
  const all = gens();
  if (!all.length) { console.log('还没有任何一代快照。先跑：node 工具\\引擎快照.mjs --save'); return 0; }
  console.log('引擎启动配置快照（共 ' + all.length + ' 代 · 新→旧 · 上限 ' + KEEP + '）');
  for (const g of all) {
    const m = readManifest(g) || {};
    const files = (m.files || []).length;
    // ⚠ 这一行的格式被 main.js 的 topbar:engine-gens 正则解析，别随便改
    console.log('- ' + g + ' · ' + fmtAt(m.at || '') + ' · 引擎 ' + ((m.engine && m.engine.ver) || '?') + ' · HEAD ' + ((m.engine && m.engine.head) || '—') + '  (' + files + ' 个文件)');
  }
  return 0;
}

// ---------- 回退 ----------
function restore(gen, assumeYes) {
  const all = gens();
  const target = gen || all[0];
  if (!target) { console.error('✗ 没有可回退的快照（先 --save 存一代）'); return 1; }
  if (!all.includes(target)) { console.error('✗ 没有这一代：' + target + '（--list 看有哪些）'); return 1; }
  const man = readManifest(target);
  if (!man || !Array.isArray(man.files) || !man.files.length) { console.error('✗ ' + target + ' 的 manifest 缺失或为空，不能用'); return 1; }

  if (!assumeYes) {
    console.log('要回退到 ' + target + '（' + fmtAt(man.at || '') + '，' + man.files.length + ' 个启动配置）。');
    console.log('只覆盖启动配置，不碰源码/构建产物/会话。');
    console.log('确认请加 --yes 重跑。');
    return 2;
  }

  // 先把当前配置另存（回退也能反悔）
  const pre = path.join(STORE, 'pre-restore-' + stamp());
  let backed = 0;
  for (const row of man.files) {
    const cur = path.join(ROOT, row.rel);
    try { if (fs.statSync(cur).isFile()) { fs.mkdirSync(path.dirname(path.join(pre, row.rel)), { recursive: true }); fs.copyFileSync(cur, path.join(pre, row.rel)); backed++; } } catch (e) { /* 当前没有这个文件 */ }
  }
  console.log('· 回退前已备份当前配置 ' + backed + ' 个 → ' + path.relative(ROOT, pre));

  let done = 0;
  for (const row of man.files) {
    const src = path.join(STORE, target, row.rel);
    const dst = path.join(ROOT, row.rel);
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      done++;
    } catch (e) { console.error('  ✗ 写不回去：' + row.rel + '（' + e.message + '）'); }
  }
  console.log('✓ 已回退 ' + done + '/' + man.files.length + ' 个启动配置（' + target + '）');
  console.log('  重启工作台后生效。');
  return done === man.files.length ? 0 : 1;
}

// ---------- 入口 ----------
if (has('--list') || has('--gens')) process.exit(list());
if (has('--save')) process.exit(save());
if (has('--restore-gen')) process.exit(restore(val('--restore-gen'), yes));
if (has('--restore')) process.exit(restore('', yes));
console.log('用法：');
console.log('  node 工具\\引擎快照.mjs --save                 # 存一代（最多 5 代）');
console.log('  node 工具\\引擎快照.mjs --list                 # 列出各代');
console.log('  node 工具\\引擎快照.mjs --restore [--yes]      # 回到最近一代');
console.log('  node 工具\\引擎快照.mjs --restore-gen <gen> [--yes]');
process.exit(2);
