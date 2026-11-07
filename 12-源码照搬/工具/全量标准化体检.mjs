#!/usr/bin/env node
// 全量标准化体检.mjs —— 把工作台现有的几套检查收成一张「体检卡」数据（4 场景标准版）
//
// 产物（覆盖写）：
//   引擎数据\.dsh\场景记忆\_体检-latest.json    顶栏「更多 → 体检」的唯一数据源
//   引擎数据\.dsh\场景记忆\说明\体检报告.md      人读的明细全文
//
// 用法：
//   node 工具\全量标准化体检.mjs            跑一遍并写产物
//   node 工具\全量标准化体检.mjs --quiet    只写文件，不打印明细
//
// 口径（别在这里另发明判据）：每一项都来自现有的检查脚本，以它们的退出码 / JSON 输出为准。
// 这样「检查本身被改坏」不会被这张卡掩盖 —— 卡里显示的就是那几条命令的真实结果：
//   体检.mjs（A1–A16）· check-gui · ui-check · 编码检查 · sessions --check · 场景校验 · 代码红线 · 验收 · 单测，
//   再加一条运行时探测（端口 / 上次启动结果）。

import { spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(APP, '引擎数据', '.dsh', '场景记忆');
const OUT_JSON = path.join(MEM, '_体检-latest.json');
const OUT_DIR = path.join(MEM, '说明');
const OUT_MD = path.join(OUT_DIR, '体检报告.md');
const QUIET = process.argv.includes('--quiet');

const mark = (s) => (s === 'bad' ? '⛔' : (s === 'warn' ? '⚠' : '✓'));
const cut = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const pad = (n) => String(n).padStart(2, '0');

function nowStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function lines(out) { return String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean); }
function lastLine(out) { const a = lines(out); return a.length ? a[a.length - 1] : ''; }

function run(parts, args = []) {
  const file = path.join(APP, ...parts);
  if (!fs.existsSync(file)) return { code: 1, out: '', missing: '脚本不存在：' + parts.join(path.sep) };
  const r = spawnSync(process.execPath, [file, ...args], {
    cwd: APP, encoding: 'utf8', timeout: 180000, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const code = (typeof r.status === 'number') ? r.status : (r.error ? 1 : 0);
  return { code, out };
}

function countsOf(items) {
  const c = { ok: 0, warn: 0, bad: 0 };
  for (const it of items) c[it.status] = (c[it.status] || 0) + 1;
  return c;
}
function makeGroup(icon, name, note, items) {
  const counts = countsOf(items);
  const status = counts.bad ? 'bad' : (counts.warn ? 'warn' : 'ok');
  return { icon, name, note, status, counts, items };
}

// ── 各子检查的收口 ────────────────────────────────────────

// 体检.mjs --json：逐条断言（A1–A16），有 findings 且 ok 的是「待办」
function parseAssertions(res) {
  if (res.missing) return [{ name: '体检.mjs', status: 'bad', detail: res.missing }];
  let data = null;
  try { data = JSON.parse(res.out); } catch (e) { data = null; }
  if (!data || !Array.isArray(data.results)) {
    return [{ name: '体检.mjs', status: res.code === 0 ? 'ok' : 'bad', detail: '读不出 --json 输出：' + cut(lastLine(res.out), 160) }];
  }
  return data.results.map((r) => {
    const isTodo = r.ok && (r.findings || []).length;
    return {
      name: r.id + ' ' + r.title,
      status: !r.ok ? 'bad' : (isTodo ? 'warn' : 'ok'),
      detail: (r.findings || []).length ? r.findings.map((f) => f.msg).join(' / ') : '通过',
    };
  });
}

// check-gui.mjs：退出码定通过；"!" 行是 warning（缺内置引擎这类，属正常）
function parseGui(res) {
  if (res.missing) return [{ name: 'check-gui.mjs', status: 'bad', detail: res.missing }];
  const warns = lines(res.out).filter((l) => /^!\s/.test(l)).map((l) => l.replace(/^!\s*/, ''));
  const items = [{ name: '界面结构 / 目录契约 / 注入脚本', status: res.code === 0 ? (warns.length ? 'warn' : 'ok') : 'bad', detail: cut(lastLine(res.out), 160) }];
  for (const w of warns) items.push({ name: '界面告警：' + cut(w, 40), status: 'warn', detail: w });
  return items;
}

// ui-check.mjs：UI 2.0 模块 / DOM 挂载点 / 语法 / 体量
function parseUiCheck(res) {
  if (res.missing) return [{ name: 'ui-check.mjs', status: 'bad', detail: res.missing }];
  const out = lines(res.out);
  if (res.code === 0) return [{ name: 'UI 2.0 模块 / 挂载点 / 体量红线', status: 'ok', detail: out.find((l) => l.includes('通过')) || lastLine(res.out) }];
  const bad = out.filter((l) => l.startsWith('✗'));
  return (bad.length ? bad : [lastLine(res.out) || '退出码 ' + res.code]).slice(0, 10)
    .map((l) => ({ name: 'UI 壳层自检', status: 'bad', detail: l }));
}

function parseEncoding(res) {
  if (res.missing) return [{ name: '编码检查.mjs', status: 'bad', detail: res.missing }];
  const out = lines(res.out);
  if (res.code === 0) return [{ name: '文本编码（BOM / 换行 / 代码页）', status: 'ok', detail: out.find((l) => l.startsWith('✓')) || lastLine(res.out) }];
  const bad = out.filter((l) => l.startsWith('✗'));
  return (bad.length ? bad : [lastLine(res.out) || '退出码 ' + res.code]).slice(0, 20)
    .map((l) => ({ name: '编码问题', status: 'bad', detail: l }));
}

// sessions.mjs --check：每个 AI 面板一行结论（4 个基础场景）
function parseSessions(res) {
  if (res.missing) return [{ name: 'sessions.mjs', status: 'bad', detail: res.missing }];
  const out = res.out.split(/\r?\n/);
  const items = [];
  let cur = null;
  for (const raw of out) {
    const head = raw.match(/^(\S+)\s+·\s+(\S+)\s+面板「(.+?)」\s*$/);
    if (head) {
      cur = { name: head[1] + ' · ' + head[2] + '「' + head[3] + '」', status: 'ok', detail: '' };
      items.push(cur);
      continue;
    }
    const v = raw.match(/^\s+([✓○✗])\s*(.+)$/);
    if (v && cur) {
      cur.status = v[1] === '✓' ? 'ok' : (v[1] === '✗' ? 'bad' : 'warn');
      cur.detail = v[2].trim();
      cur = null;
    }
  }
  if (!items.length) items.push({ name: '场景↔会话对照', status: res.code === 0 ? 'ok' : 'bad', detail: cut(lastLine(res.out), 160) });
  return items;
}

function parseScenes(res) {
  if (res.missing) return [{ name: '场景校验.mjs', status: 'bad', detail: res.missing }];
  if (res.code === 0) return [{ name: '场景 json / 面板类型 / 事实表', status: 'ok', detail: lastLine(res.out) }];
  const bad = lines(res.out).filter((l) => l.startsWith('✗'));
  return (bad.length ? bad : [lastLine(res.out) || '退出码 ' + res.code]).slice(0, 20)
    .map((l) => ({ name: '场景配置', status: 'bad', detail: l }));
}

function parseRedline(res) {
  if (res.missing) return [{ name: '代码红线.mjs', status: 'bad', detail: res.missing }];
  const out = lines(res.out);
  const items = [];
  if (res.code === 0) items.push({ name: '体量 / 盘符 / 会话 id / eval', status: 'ok', detail: lastLine(res.out) });
  else {
    const bad = out.filter((l) => l.startsWith('✗'));
    for (const l of (bad.length ? bad : [lastLine(res.out) || '退出码 ' + res.code])) {
      items.push({ name: '代码红线', status: 'bad', detail: l });
    }
  }
  // 存量黄是「已知且已豁免、未增长」，记成 ok 明细，便于回看
  for (const y of out.filter((l) => l.startsWith('⚠'))) items.push({ name: '存量豁免', status: 'ok', detail: y });
  return items;
}

// 验收.mjs：支持 [x/5] 或 [x/6] 串行闸门
function parseAcceptance(res) {
  if (res.missing) return [{ name: '验收.mjs', status: 'bad', detail: res.missing }];
  const items = [];
  for (const raw of lines(res.out)) {
    const m = raw.match(/^([✓✗])\s+\[(\d)\/(\d)\]\s+(.+)$/);
    if (!m) continue;
    const body = m[4].trim();
    items.push({
      name: '[' + m[2] + '/' + m[3] + '] ' + cut(body.split(' 通过 · ')[0] || body, 60),
      status: m[1] === '✓' ? 'ok' : 'bad',
      detail: cut(body, 200),
    });
  }
  if (!items.length) items.push({ name: '验收.mjs', status: res.code === 0 ? 'ok' : 'bad', detail: cut(lastLine(res.out), 160) });
  return items;
}

// 主进程模块单元测试
function parseUnitTests() {
  const items = [];
  const r1 = run(['外壳', 'scripts', 'scenes-store.test.mjs']);
  items.push({
    name: 'scenes-store 场景模块单测',
    status: r1.code === 0 ? 'ok' : 'bad',
    detail: r1.code === 0 ? (lines(r1.out).find((l) => l.includes('通过')) || '4 组全过') : cut(lastLine(r1.out), 120),
  });
  const r2 = run(['外壳', 'scripts', 'inventory.test.mjs']);
  items.push({
    name: 'inventory 清点模块单测',
    status: r2.code === 0 ? 'ok' : 'bad',
    detail: r2.code === 0 ? (lines(r2.out).find((l) => l.includes('通过')) || '6 组全过') : cut(lastLine(r2.out), 120),
  });
  return items;
}

function probe(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch (e) { /* ignore */ } resolve(v); };
    s.setTimeout(1000);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
  });
}

function bootItem() {
  const f = path.join(APP, '外壳', 'data', 'startup.log');
  if (!fs.existsSync(f)) return { name: '启动日志', status: 'warn', detail: '没有 startup.log（可能还没从启动器启动过）' };
  const rows = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean);
  let startAt = -1;
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].includes('[start]')) { startAt = i; break; }
  if (startAt < 0) return { name: '启动日志', status: 'warn', detail: 'startup.log 里没有 [start] 记录' };
  const tail = rows.slice(startAt);
  const exit = [...tail].reverse().find((l) => l.includes('[exit]'));
  if (!exit) return { name: '启动日志', status: 'ok', detail: '本次启动运行中：' + cut(tail[0], 120) };
  const rc = /rc=(-?\d+)/.exec(exit);
  const ok = rc && Number(rc[1]) === 0 && /window-visible/.test(exit) && /engine ready/.test(exit);
  return { name: '启动日志', status: ok ? 'ok' : 'bad', detail: cut(exit, 160) };
}

async function runtimeItems() {
  const items = [];
  const ports = [['引擎 3083', 3083], ['外壳 31238', 31238], ['网页版 AI 桥 31239', 31239]];
  for (const [label, port] of ports) {
    const on = await probe(port);
    items.push({
      name: label,
      status: on ? 'ok' : 'warn',
      detail: on ? ('127.0.0.1:' + port + ' 在监听') : ('127.0.0.1:' + port + ' 未监听（工作台没开？）'),
    });
  }
  items.push(bootItem());
  return items;
}

// ── 跑 ────────────────────────────────────────────────────
const sources = [];
function note(name) { sources.push(name); }

note('体检.mjs --json');
const gAssert = makeGroup('🧭', '机制体检（A1–A16）', '路径 / 端口 / 记忆 / 会话 / 身份 / 编码 / 工作区 等 16 条断言', parseAssertions(run(['工具', '体检.mjs'], ['--json'])));

note('check-gui.mjs');
const gGui = makeGroup('🖥', '界面与结构', 'check-gui：目录契约 / 面板 / 注入脚本 / 引擎接线', parseGui(run(['外壳', 'scripts', 'check-gui.mjs'])));

note('ui-check.mjs');
const gUiCheck = makeGroup('🎨', 'UI 2.0 自检', 'ui-check：模块语法 / 加载顺序 / 挂载点 / CSS / 体量', parseUiCheck(run(['外壳', 'scripts', 'ui-check.mjs'])));

note('编码检查.mjs');
const gEnc = makeGroup('🔤', '文本编码', 'BOM / 换行 / 代码页（按真实消费者判）', parseEncoding(run(['工具', '编码检查.mjs'])));

note('sessions.mjs --check');
const gSessions = makeGroup('🔗', '场景↔会话', '每个 AI 面板的 sessionId 是否命中且标题一致', parseSessions(run(['外壳', 'scripts', 'sessions.mjs'], ['--check'])));

note('场景校验.mjs --check');
const gScenes = makeGroup('🧩', '场景配置', '场景 json / 面板类型注册表 / 事实表', parseScenes(run(['工具', '场景校验.mjs'], ['--check'])));

note('代码红线.mjs --check');
const gRedline = makeGroup('📏', '代码红线', '文件体量 / 盘符硬编码 / 真实会话 id / eval', parseRedline(run(['工具', '代码红线.mjs'], ['--check'])));

note('验收.mjs');
const gAccept = makeGroup('🚀', '提交前验收', '验收.mjs 六步闸（可提交与否）', parseAcceptance(run(['工具', '验收.mjs'])));

note('单测（scenes / inventory）');
const gUnit = makeGroup('🧪', '主进程模块单测', 'scenes-store 与 inventory 独立 smoke test', parseUnitTests());

note('运行时探测');
const gRuntime = makeGroup('🩺', '运行时', '端口 3083 / 31238 / 31239 与上次启动结果', await runtimeItems());

const groups = [gAssert, gGui, gUiCheck, gEnc, gSessions, gScenes, gRedline, gAccept, gUnit, gRuntime];
const all = groups.flatMap((g) => g.items);
const totals = { items: all.length, ...countsOf(all) };
const gc = countsOf(groups);
const verdict = gc.bad ? '有阻断' : (gc.warn ? '有告警' : '全绿');

// ── 写产物 ────────────────────────────────────────────────
const data = {
  time: nowStr(),
  verdict,
  ok: gc.ok,
  warn: gc.warn,
  bad: gc.bad,
  totals,
  report: OUT_MD,
  sources: sources.slice(),
  groups,
};

fs.mkdirSync(MEM, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
const tmp = OUT_JSON + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
fs.renameSync(tmp, OUT_JSON);

const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '｜').replace(/\r?\n/g, ' ');
const md = [];
md.push('# 体检报告', '');
md.push('> 由 `工具\\全量标准化体检.mjs` 生成（覆盖写）。顶栏「更多 → 体检」读的是同名 JSON：`引擎数据\\.dsh\\场景记忆\\_体检-latest.json`。', '');
md.push('- 生成时间：' + data.time);
md.push('- 结论：' + verdict + '（分类 ' + mark('ok') + gc.ok + ' ' + mark('warn') + gc.warn + ' ' + mark('bad') + gc.bad
  + ' · 逐项 ' + totals.items + '：' + mark('ok') + totals.ok + ' ' + mark('warn') + totals.warn + ' ' + mark('bad') + totals.bad + '）');
md.push('- 来源：' + sources.join(' · '));
md.push('');
groups.forEach((g, i) => {
  md.push('## ' + (i + 1) + '. ' + g.icon + ' ' + g.name + ' · ' + mark(g.status)
    + '（' + mark('ok') + g.counts.ok + ' ' + mark('warn') + g.counts.warn + ' ' + mark('bad') + g.counts.bad + '）', '');
  md.push('| 项 | 结果 | 明细 |', '|---|---|---|');
  for (const it of g.items) md.push('| ' + esc(it.name) + ' | ' + mark(it.status) + ' | ' + esc(it.detail) + ' |');
  md.push('');
});
fs.writeFileSync(OUT_MD, md.join('\n'), 'utf8');

// ── 终端摘要 ──────────────────────────────────────────────
if (!QUIET) {
  console.log('体检 · ' + data.time + ' · ' + verdict);
  console.log('模式：全量（' + groups.length + ' 类 · ' + totals.items + ' 项）\n');
  for (const g of groups) {
    console.log('  ' + g.icon + ' ' + g.name + '  ' + mark(g.status) + '  ' + mark('ok') + g.counts.ok + ' ' + mark('warn') + g.counts.warn + ' ' + mark('bad') + g.counts.bad);
    for (const it of g.items.filter((x) => x.status !== 'ok')) console.log('      ' + mark(it.status) + ' ' + it.name + '：' + cut(it.detail, 140));
  }
  console.log('\n汇总：分类 ' + groups.length + ' · 逐项 ' + totals.items + '（' + mark('ok') + totals.ok + ' ' + mark('warn') + totals.warn + ' ' + mark('bad') + totals.bad + '）');
  console.log('已写：' + path.relative(APP, OUT_JSON));
  console.log('报告：' + path.relative(APP, OUT_MD));
}

process.exit(totals.bad ? 1 : 0);
