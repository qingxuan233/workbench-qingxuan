#!/usr/bin/env node
/**
 * 待确认.mjs —— 「想动宪法层，但没这个权」时的唯一出口
 *
 * 背景（方法论 O5）：
 *   修改权五档（A/B/C/D/E）规定了谁能改什么。可现实里 AI 经常发现「上层文档写错了」，
 *   然后两种坏结局二选一：
 *     ① 偷偷改掉（越权，且机主事后不知道）——这是曾经真实发生过的失败模式；
 *     ② 干脆不提（问题烂在肚子里，下一个人再踩一次）。
 *   本工具给第三条路：**AI 只能「提」，不能「批」**。提案进 append-only 的 jsonl，
 *   由宿主/机主用 `resolve --as 宿主` 转正或驳回。落地结果写回原文件，提案留痕。
 *
 * 用法：
 *   node 工具\待确认.mjs list                  列出全部（默认只看 pending）
 *   node 工具\待确认.mjs list --all            连已结清的一起列
 *   node 工具\待确认.mjs add --file <相对路径> --anchor <小节> --propose "改成什么" --reason "为什么"
 *   node 工具\待确认.mjs resolve <id> --as 宿主 --status 已转正|驳回 [--note "依据"]
 *
 * 铁律：`add` 永远只产生 status=pending；只有 `--as 宿主` 能改状态。
 * 退出码：0 成功 ｜1 有错 ｜2 用法错
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const ROOT = path.resolve(APP, '..');
const F = path.join(APP, '引擎数据', '.dsh', '场景记忆', '_共享记忆', '待确认.jsonl');

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d };
const has = (k) => argv.includes(k);

function readAll() {
  if (!fs.existsSync(F)) return [];
  return fs.readFileSync(F, 'utf8').split(/\r?\n/).filter((x) => x.trim()).map((line, i) => {
    try { return JSON.parse(line) } catch { return { __bad: line, __line: i + 1 } }
  });
}
function append(obj) {
  fs.mkdirSync(path.dirname(F), { recursive: true });
  fs.appendFileSync(F, JSON.stringify(obj) + '\n', 'utf8');
}
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const nextId = (rows) => 'P' + String(rows.filter((r) => r && r.id).length + 1).padStart(3, '0');

// ── list ─────────────────────────────────────────────────
if (argv[0] === 'list' || argv.length === 0) {
  const all = readAll();
  // append-only：同一 id 可能有多行（提案 + 结清），**后写者为准**
  const order = [];
  const latest = new Map();
  for (const r of all) {
    if (r.__bad || !r.id) { order.push(r); continue }
    if (!latest.has(r.id)) order.push(r.id);
    latest.set(r.id, r);
  }
  const rows = order.map((x) => (typeof x === 'string' ? latest.get(x) : x));
  const show = has('--all') ? rows : rows.filter((r) => r.status === 'pending');
  if (!show.length) { console.log('（没有待确认项）'); process.exit(0) }
  for (const r of show) {
    if (r.__bad) { console.log(`  ✗ 第 ${r.__line} 行不是合法 JSON`); continue }
    const mark = r.status === 'pending' ? '·' : (r.status === '已转正' ? '✓' : '✗');
    console.log(`${mark} ${r.id} [${r.scope || '?'}] ${r.file || ''}${r.anchor ? ' ' + r.anchor : ''}`);
    console.log(`    提出：${r.actor || '?'} @ ${r.ts || '?'}`);
    console.log(`    改成：${r.propose || ''}`);
    if (r.reason) console.log(`    理由：${r.reason}`);
    if (r.status !== 'pending') console.log(`    结清：${r.status}${r.note ? ' · ' + r.note : ''} @ ${r.resolvedAt || '?'}`);
  }
  process.exit(0);
}

// ── add ──────────────────────────────────────────────────
if (argv[0] === 'add') {
  const file = val('--file', '');
  const propose = val('--propose', '');
  if (!file || !propose) { console.error('用法：add --file <相对路径> --anchor <小节> --propose "改成什么" [--reason "为什么"]'); process.exit(2) }
  const scope = val('--scope', /^(00-|05-|总纲|README|说明)/.test(file) ? '宪法层' : '机制层');
  const rows = readAll();
  const rec = {
    id: nextId(rows),
    ts: nowIso(),
    actor: val('--actor', 'AI'),
    scope,
    file,
    anchor: val('--anchor', ''),
    propose,
    reason: val('--reason', ''),
    evidence: val('--evidence', ''),
    status: 'pending',
    resolvedAt: null,
    resolvedBy: null,
    note: ''
  };
  if (rec.actor !== 'AI') {
    console.error('✗ add 只接受 --actor AI（提案权）。要转正请用 resolve --as 宿主。');
    process.exit(1);
  }
  append(rec);
  console.log(`✓ 已登记 ${rec.id}（${rec.scope}）→ ${F}`);
  console.log('  这是提案，不是改动。等宿主 resolve。');
  process.exit(0);
}

// ── resolve ──────────────────────────────────────────────
if (argv[0] === 'resolve') {
  const id = argv[1];
  const as = val('--as', '');
  const status = val('--status', '');
  if (!id) { console.error('用法：resolve <id> --as 宿主 --status 已转正|驳回'); process.exit(2) }
  if (as !== '宿主') { console.error('✗ 只有 --as 宿主 能转正/驳回（AI 不得自批）'); process.exit(1) }
  if (!['已转正', '驳回'].includes(status)) { console.error('✗ --status 只能是 已转正 / 驳回'); process.exit(2) }
  const rows = readAll();
  const target = rows.find((r) => r && r.id === id);
  if (!target) { console.error('✗ 没有 ' + id); process.exit(1) }
  if (target.status !== 'pending') { console.error(`✗ ${id} 已是「${target.status}」`); process.exit(1) }
  // append-only：不改旧行，追加一条「结清」记录（同 id，后写者为准）
  const closing = { ...target, status, resolvedAt: nowIso(), resolvedBy: as, note: val('--note', '') };
  append(closing);
  console.log(`✓ ${id} → ${status}`);
  const still = readAll().filter((r) => r && r.id === id).pop();
  console.log(`    现状态：${still.status}${still.note ? ' · ' + still.note : ''}`);
  process.exit(0);
}

console.error('用法：list [--all] | add … | resolve <id> --as 宿主 --status 已转正|驳回');
process.exit(2);
