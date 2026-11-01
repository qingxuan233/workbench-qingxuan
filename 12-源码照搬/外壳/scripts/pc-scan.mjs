#!/usr/bin/env node
// pc-scan.mjs —— 「本地电脑」场景的扫描器：给三块面板产出数据
//
//   ① 磁盘大户排行（pc-toplarge）  ② 可清理体检（pc-junk）  ③ 清理台账（pc-ledger 只读，由 --log 追加）
//
// 面板是**纯读 JSON** 的（渲染层没有列目录 IPC），所以数据必须由本脚本落盘：
//   data\pc-cleanup-scan.json   ← 本脚本扫描产出（scannedAt / tookSec / minGb / items / byDrive / junk / junkTotalGb）
//   data\pc-cleanup-log.json    ← 每清一次追加一条（--log <释放GB> "<清了个啥>"）
// 面板每 15~20 秒重读这两个文件 ⇒ 扫完/记完**不用点 ⟳**，十几秒内自己就变。
//
// 用法（在 12-源码照搬 目录下跑）：
//   node 外壳\scripts\pc-scan.mjs                      # 全盘扫，默认 150 秒预算、≥0.5 GB 才上榜
//   node 外壳\scripts\pc-scan.mjs --budget 300         # 给更多时间（更全，扫描更久）
//   node 外壳\scripts\pc-scan.mjs --roots "E:\git_code" --min 0.05   # 只扫某个目录（自测/局部扫）
//   node 外壳\scripts\pc-scan.mjs --json               # 只打印结果 JSON，不写摘要
//   node 外壳\scripts\pc-scan.mjs --log 3.2 "清 C:\Windows\Temp 与用户 Temp"
//
// 设计取舍：
//   · 只读、不删任何东西 —— 删除由 AI 按「先列清单等点头」的纪律另做，本脚本连 --clean 都不提供；
//   · 有硬预算（--budget 秒）：超预算就停，已量到的照常上榜，并标 partial:true（不假装扫全了）；
//   · 符号链接/junction 一律不跟进（Windows 上 C:\Documents and Settings 这类会成环、也会重复计体积）；
//   · 体积按 **逻辑大小**（stat.size 累加）算，不是占用簇大小；和大厂工具的"占用"会有几 % 差别，排名不受影响。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');                 // 外壳\
const DATA = path.join(APP, 'data');
const OUT_SCAN = path.join(DATA, 'pc-cleanup-scan.json');
const OUT_LOG = path.join(DATA, 'pc-cleanup-log.json');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const num = (k, d) => { const n = Number(val(k, d)); return Number.isFinite(n) ? n : d; };

const GB = 1024 * 1024 * 1024;
const gb = (n) => Math.round((n / GB) * 100) / 100;
const say = (s) => process.stderr.write(s + '\n');

// ── 台账模式：node pc-scan.mjs --log <释放GB> "<清了个啥>" [--note 备注] ────────────────────
if (has('--log')) {
  const i = argv.indexOf('--log');
  const freed = Number(argv[i + 1]);
  const what = String(argv[i + 2] || '').trim();
  if (!Number.isFinite(freed) || freed < 0 || !what) {
    console.error('用法：node scripts\\pc-scan.mjs --log <释放GB> "<清了个啥>" [--note 备注]');
    process.exit(2);
  }
  let db = { entries: [] };
  try { db = JSON.parse(fs.readFileSync(OUT_LOG, 'utf8')); } catch (e) { /* 没有就新建 */ }
  if (!Array.isArray(db.entries)) db.entries = [];
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  db.entries.push({
    date: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`,
    what,
    freed: Math.round(freed * 100) / 100,
    note: String(val('--note', '') || ''),
  });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(OUT_LOG, JSON.stringify(db, null, 1), 'utf8');
  const total = db.entries.reduce((a, e) => a + (Number(e.freed) || 0), 0);
  console.log('✓ 台账已追加：+' + freed.toFixed(2) + ' GB · ' + what + '（累计 ' + total.toFixed(2) + ' GB / ' + db.entries.length + ' 次）');
  process.exit(0);
}

// ── 扫描参数 ────────────────────────────────────────────────────────────────────────────
const MIN_GB = Math.max(0, num('--min', 0.5));          // 上榜门槛
const TOP = Math.max(1, Math.min(200, num('--top', 40))); // 总榜条数
const PER_DRIVE = Math.max(1, Math.min(60, num('--per-drive', 12)));
const BUDGET_S = Math.max(5, num('--budget', 150));
const MAX_DEPTH = Math.max(2, Math.min(12, num('--depth', 7)));
const RECORD_DEPTH = Math.max(1, Math.min(MAX_DEPTH, num('--record-depth', 3)));
const CONC = Math.max(2, Math.min(64, num('--conc', 12)));
const deadline = Date.now() + BUDGET_S * 1000;
const asJson = has('--json');

let visited = 0, bytesSeen = 0, stopped = false;
const dirs = [];   // { path, bytes, depth }

// 并发闸：同时最多 CONC 个 stat/readdir，避免几十万 promise 把内存吃光
let active = 0;
const waiters = [];
async function slot(fn) {
  if (active >= CONC) await new Promise((r) => waiters.push(r));
  active++;
  try { return await fn(); } finally {
    active--;
    const w = waiters.shift();
    if (w) w();
  }
}

function driveOf(p) {
  const m = /^([A-Za-z]):/.exec(String(p || ''));
  return m ? m[1].toUpperCase() + ':' : '';
}

/** 递归量一个目录的体积。返回 { bytes, denied }；超预算就提前收手（stopped=true）。
 *  rec=false 时只算体积、不往 dirs 里记（体检量缓存用，免得把回收站子目录塞进大户排行）。 */
async function walk(dir, depth, rec) {
  if (stopped || Date.now() > deadline) { stopped = true; return { bytes: 0, denied: false }; }
  let entries;
  try {
    entries = await slot(() => fsp.readdir(dir, { withFileTypes: true }));
  } catch (e) {
    return { bytes: 0, denied: true };   // 没权限/被占用：跳过，不中断整轮
  }
  visited++;
  let bytes = 0;
  const subs = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;              // 不跟进链接/junction（会成环、会重复计）
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH) subs.push(p);         // 超过深度：不计（partial 会体现）
      continue;
    }
    if (!e.isFile()) continue;
    try {
      const st = await slot(() => fsp.stat(p));
      bytes += st.size;
      bytesSeen += st.size;
    } catch (e2) { /* 单个文件读不到就跳过 */ }
  }
  if (subs.length) {
    const rs = await Promise.all(subs.map((p) => walk(p, depth + 1, rec)));
    for (const r of rs) bytes += r.bytes;
  }
  // 深度 0 = 交给它的那个根（如 C:\）本身：不上榜，否则"第一名"永远是整个盘、把真正的大户挤掉
  if (rec !== false && depth >= 1 && depth <= RECORD_DEPTH) dirs.push({ path: dir, bytes, depth, partial: stopped });
  return { bytes, denied: false };
}

/** 只量体积、不记录中间目录（体检/收尾用）。深度必须从 0 起：
 *  原来传 MAX_DEPTH（=7）⇒ `depth < MAX_DEPTH` 立刻为假 ⇒ 只统计目录里**第一层**文件，
 *  回收站这种"全部内容都在子目录里"的地方量出来是 0 ⇒ 被 <5MB 规则滤掉（68 GB 凭空消失）。 */
async function sizeOnly(dir) {
  const r = await walk(dir, 0, false);
  return r.bytes;
}

function listDrives() {
  const roots = String(val('--roots', '') || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (roots.length) return roots;
  const out = [];
  for (const L of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const r = L + ':\\';
    try { if (fs.statSync(r).isDirectory()) out.push(r); } catch (e) { /* 没有这个盘 */ }
  }
  return out;
}

// ── 可清理体检的位置（存在才量；量不到就跳过，不编数字）────────────────────────────────
function junkTargets(drives) {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const win = process.env.SystemRoot || 'C:\\Windows';
  const t = [
    { k: '用户临时目录 Temp', path: os.tmpdir(), note: '装东西/解压的残留，可整目录删（占用的删不掉就跳过）' },
    { k: 'Windows Temp', path: path.join(win, 'Temp'), note: '系统级临时文件，可删' },
    { k: 'Windows 更新缓存', path: path.join(win, 'SoftwareDistribution', 'Download'), note: '更新装完就没用了，可删' },
    { k: 'Windows 预读 Prefetch', path: path.join(win, 'Prefetch'), note: '删了会自动重建，收益一般' },
    { k: 'npm 缓存', path: path.join(local, 'npm-cache'), note: '可删，下次装包会重新下' },
    { k: 'pnpm 缓存', path: path.join(local, 'pnpm-store'), note: '可删，下次装包会重新下' },
    { k: 'pip 缓存', path: path.join(local, 'pip', 'Cache'), note: '可删' },
    { k: '崩溃转储 CrashDumps', path: path.join(local, 'CrashDumps'), note: '崩溃内存转储，除排障平时没用' },
    { k: 'Edge 缓存', path: path.join(local, 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache'), note: '浏览器缓存，可删（会重新下载）' },
    { k: 'Edge 代码缓存', path: path.join(local, 'Microsoft', 'Edge', 'User Data', 'Default', 'Code Cache'), note: '浏览器 JIT 缓存，可删' },
    { k: 'Chrome 缓存', path: path.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'Cache'), note: '浏览器缓存，可删' },
    { k: '临时安装包', path: path.join(roaming, '..', 'Local', 'Temp', 'chocolatey'), note: '包管理器残留（没有就跳过）' },
    { k: '工作台引擎临时目录', path: path.join(APP, 'data', 'temp'), note: '工作台自己用 TEMP 重定向到这里，可清' },
  ];
  // 回收站：**每个盘各一个**（$RECYCLE.BIN），只扫 C: 会漏掉大头的 60+ GB（实测 F: 就有 68 GB）
  for (const d of drives) {
    const L = /^([A-Za-z]):/.exec(d);
    if (!L) continue;
    t.push({ k: '回收站 ' + L[1].toUpperCase() + ':', path: L[1].toUpperCase() + ':\\$RECYCLE.BIN', note: '就是"已删除"的东西，清空即释放' });
  }
  const seen = new Set();
  return t.filter((x) => {
    if (!x.path || seen.has(x.path.toLowerCase())) return false;
    seen.add(x.path.toLowerCase());
    try { return fs.statSync(x.path).isDirectory(); } catch (e) { return false; }
  });
}

// ── 主流程 ──────────────────────────────────────────────────────────────────────────────
const t0 = Date.now();
const roots = listDrives();
if (!roots.length) { console.error('✗ 没有可用磁盘（用 --roots 指定目录）'); process.exit(1); }
say('扫描根：' + roots.join('  ') + '　预算 ' + BUDGET_S + 's · 深度 ' + MAX_DEPTH + ' · 门槛 ' + MIN_GB + ' GB');

let tick = setInterval(() => {
  say('  … ' + Math.round((Date.now() - t0) / 1000) + 's · 目录 ' + visited + ' · 已量 ' + gb(bytesSeen).toFixed(1) + ' GB');
}, 3000);
tick.unref && tick.unref();

for (const r of roots) {
  if (stopped) break;
  say('· ' + r);
  await walk(r, 0).catch((e) => say('  ✗ ' + r + '：' + ((e && e.message) || e)));
}

say('扫描结束：' + Math.round((Date.now() - t0) / 1000) + 's · 目录 ' + visited + (stopped ? ' · ⚠ 到预算提前收手（partial）' : ''));

// 体检：用剩余预算量缓存（预算已尽就全标 0 不编数）
const junk = [];
for (const j of junkTargets(roots)) {
  if (Date.now() > deadline) { say('  （预算用完，' + j.k + ' 这次没量）'); continue; }
  const b = await sizeOnly(j.path);
  if (b < 5 * 1024 * 1024) continue;   // <5 MB 的算"本来就干净"，别拿 0GB 条目占面板的位置
  junk.push({ k: j.k, path: j.path, gb: gb(b), note: j.note, partial: stopped });
}
junk.sort((a, b) => b.gb - a.gb);
const junkTotalGb = Math.round(junk.reduce((a, j) => a + j.gb, 0) * 100) / 100;

// 榜单：≥门槛、按体积倒序；byDrive 每个盘单独一份
const all = dirs
  .filter((d) => d.bytes / GB >= MIN_GB)
  .map((d) => ({ path: d.path, gb: gb(d.bytes), partial: !!d.partial }))
  .sort((a, b) => b.gb - a.gb);
const items = all.slice(0, TOP);
const byDrive = {};
for (const it of all) {
  const k = driveOf(it.path);
  if (!k) continue;
  (byDrive[k] = byDrive[k] || []).length < PER_DRIVE && byDrive[k].push(it);
}

const out = {
  scannedAt: new Date().toISOString(),
  tookSec: Math.round((Date.now() - t0) / 10) / 100,
  minGb: MIN_GB,
  partial: stopped,
  roots,
  dirsVisited: visited,
  items,
  byDrive,
  junk,
  junkTotalGb,
  note: '由 外壳\\scripts\\pc-scan.mjs 产出 · 逻辑大小（非簇占用）· partial=true 表示到时间预算提前收手',
};

fs.mkdirSync(DATA, { recursive: true });
const tmp = OUT_SCAN + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(out, null, 1), 'utf8');
fs.renameSync(tmp, OUT_SCAN);   // 原子替换：面板不会读到写了一半的文件

if (asJson) { console.log(JSON.stringify(out, null, 1)); process.exit(0); }

console.log('✓ 扫描完成 ' + out.tookSec + 's' + (stopped ? '（未扫全，partial）' : '') + ' → ' + OUT_SCAN);
console.log('  大户排行 Top ' + items.length + '（≥' + MIN_GB + ' GB）：');
for (const it of items.slice(0, 10)) console.log('   ' + String(it.gb).padStart(8) + ' GB  ' + it.path);
console.log('  可清理体检合计 ' + junkTotalGb.toFixed(2) + ' GB：');
for (const j of junk.slice(0, 6)) console.log('   ' + String(j.gb).padStart(8) + ' GB  ' + j.k + '  ' + j.path);
console.log('  面板 15~20 秒内会自动刷新；要看即时结果：点那一格的 ⟳。');
