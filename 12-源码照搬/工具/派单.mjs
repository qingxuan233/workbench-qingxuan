#!/usr/bin/env node
/**
 * 派单.mjs —— 任务派发 CLI（薄壳，业务全在 工具/_派单核心.mjs）
 *
 * 用法：
 *   node 工具\派单.mjs --to 命令 "执行环境检查"
 *   node 工具\派单.mjs --to pc-cleanup --title "磁盘体检" --priority P1 --timeout-min 30 --from claude-code "扫描大文件"
 *   node 工具\派单.mjs --to 命令 --no-write --expect "体检绿数" "只做只读检查"
 *   node 工具\派单.mjs --list [--status expired] [--limit 20]
 *   node 工具\派单.mjs --claim task-20261108-xxxx --agent mybot
 *   node 工具\派单.mjs --complete task-20261108-xxxx --evidence "16绿0红" [--exit-code 0] [--evidence-file 路径]
 *   node 工具\派单.mjs --sweep                    # 超时未回执 ⇒ 转 expired
 *
 * 设计：
 *   - 台账 = `_共享记忆\_任务台账.jsonl`（append-only + 锁 + 读侧折叠）⇒ 并发不丢单
 *   - 幂等：`--idem-key` 重复派单返回原 task（replayed）
 *   - 信封（P4，全部可选）：--priority / --timeout-min / --no-write / --expect
 *   - 唤醒：`工具/_派单核心.mjs` 内做 DSH `session/prompt`（token 优先读 `外壳/data/harness-endpoint.json`）
 *   - 校验：场景不存在 / 未绑定会话 ⇒ 非 0 退出码（**不再"假成功"**）
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as core from './_派单核心.mjs';

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || '') : (d || ''); };
const has = (k) => argv.includes(k);

const die = (msg, code = 1) => { console.error('✗ ' + msg); process.exit(code); };

// 这些旗标后面跟的是"值"，不能算进任务正文
const FLAGS = [
  '--to', '--title', '--from', '--idem-key', '--evidence', '--limit', '--status',
  '--priority', '--timeout-min', '--expect', '--agent', '--exit-code', '--evidence-file',
];

// ── 查看 ─────────────────────────────────────────────────
if (has('--list')) {
  const limit = Math.max(1, Math.min(200, Number(val('--limit', '20')) || 20));
  const status = val('--status', '').trim();
  const sw = core.sweep();                    // 读时顺扫：超时未回执的先转 expired（P4-6）
  const rows = core.list(limit, { status });
  if (sw.count) console.log('（读前顺扫：已把 ' + sw.count + ' 条超时任务转为 expired → ' + sw.expired.join(', ') + '）');
  if (!rows.length) {
    console.log('（任务台账为空' + (status ? '：status=' + status : '') + '）');
    process.exit(0);
  }
  console.log('=== 任务台账（最近 ' + rows.length + ' 条）===');
  for (const t of rows) {
    const dl = t.deadlineAt ? '  截止 ' + String(t.deadlineAt).slice(5, 16).replace('T', ' ') : '';
    console.log(
      '[' + String(t.status || 'pending').toUpperCase() + '] ' + t.taskId +
      '  ' + (t.priority || 'P2') + '  ' + (t.from || '-') + ' → ' + (t.to || '-') +
      ' ：「' + (t.title || '') + '」  ' + String(t.createdAt || '').slice(0, 16).replace('T', ' ') + dl +
      (t.evidence ? '  证据: ' + String(t.evidence).slice(0, 40) : '')
    );
  }
  process.exit(0);
}

// ── 超时扫账 ─────────────────────────────────────────────
if (has('--sweep')) {
  const r = core.sweep();
  if (!r.count) console.log('✓ 没有超时任务（检查时间 ' + r.checkedAt + '）');
  else console.log('✓ 已把 ' + r.count + ' 条超时任务转为 expired：' + r.expired.join(', '));
  process.exit(0);
}

// ── 领取 ─────────────────────────────────────────────────
if (has('--claim')) {
  const id = val('--claim');
  if (!id) die('--claim 需要任务编号');
  const r = core.claim(id, val('--agent', 'cli'));
  if (!r.ok) die(r.err || '领取失败');
  console.log('✓ 已领取 ' + id + '（claimed by ' + r.claimedBy + (r.replayed ? '，幂等重放' : '') + '）');
  process.exit(0);
}

// ── 销账 ─────────────────────────────────────────────────
if (has('--complete')) {
  const id = val('--complete');
  if (!id) die('--complete 需要任务编号');
  const evidence = val('--evidence', '执行完成');
  const meta = {};
  const exitRaw = val('--exit-code', '').trim();
  if (exitRaw !== '') {
    const n = Number(exitRaw);
    if (!Number.isInteger(n)) die('--exit-code 必须是整数');
    meta.exitCode = n;
  }
  const file = val('--evidence-file', '').trim();
  if (file) {
    if (!fs.existsSync(file)) die('--evidence-file 不存在：' + file);
    const buf = fs.readFileSync(file);
    meta.files = [{
      path: path.basename(file),
      bytes: buf.length,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    }];
  }
  const r = core.complete(id, evidence, Object.keys(meta).length ? meta : null);
  if (!r.ok) die(r.err || '销账失败');
  console.log('✓ 任务 ' + id + ' 已销账（completed）' + (r.late ? '⚠ 该任务曾超时，已补记' : '') + '，证据：' + evidence);
  process.exit(0);
}

// ── 派单 ─────────────────────────────────────────────────
const to = val('--to');
const title = val('--title', '系统派单');
const from = val('--from', 'cli');
const idemKey = val('--idem-key', '');
const priority = val('--priority', 'P2');
const timeoutMin = Number(val('--timeout-min', '0')) || 0;
const noWrite = has('--no-write');
const expect = val('--expect', '').trim();
const content = argv
  .filter((a, i) => !a.startsWith('--') && !FLAGS.includes(argv[i - 1]))
  .join(' ').trim();

if (!to || !content) {
  console.log('用法：node 工具\\派单.mjs --to <场景名|id> [--title "标题"] [--from "调用者"] [--idem-key "键"]');
  console.log('      [--priority P0|P1|P2|P3] [--timeout-min N] [--no-write] [--expect "期望证据"] "任务正文"');
  console.log('      node 工具\\派单.mjs --list [--status pending|dispatched|claimed|completed|expired] [--limit 20]');
  console.log('      node 工具\\派单.mjs --claim <taskId> [--agent 名字]');
  console.log('      node 工具\\派单.mjs --complete <taskId> --evidence "证据" [--exit-code 0] [--evidence-file 路径]');
  console.log('      node 工具\\派单.mjs --sweep');
  process.exit(2);
}

const r = await core.dispatch({
  to, title, content, from,
  idemKey: idemKey || null,
  priority,
  timeoutMs: timeoutMin > 0 ? timeoutMin * 60000 : 0,
  mandate: noWrite ? { allowWrite: false } : undefined,
  evidenceExpected: expect ? [expect] : [],
});
if (!r.ok) die(r.err || '派单失败');

if (r.replayed) {
  console.log('✓ 幂等命中：' + r.taskId + '（未重复唤醒，状态 ' + (r.status || 'pending') + '）');
  process.exit(0);
}

console.log('✓ 任务已入账：' + r.taskId + ' → ' + (r.scene || to) + '（' + priority + (timeoutMin ? '，超时 ' + timeoutMin + ' 分钟' : '') + '）');

// 唤醒结果：CLI 要确定性答案 —— 引擎没起来/场景未绑定时必须非 0 退出（不再"假成功"）
let wakeRes = null;
if (r.wake) {
  try { wakeRes = await r.wake; } catch (e) { wakeRes = { ok: false, err: String((e && e.message) || e) }; }
}
if (wakeRes && !wakeRes.ok) {
  console.error('✗ 唤醒失败：' + (wakeRes.err || wakeRes.text || '未知原因'));
  console.error('  任务已保留在台账（' + r.taskId + '），引擎就绪后可人工重派。');
  console.error('  台账：' + core.LEDGER);
  process.exit(3);
}

console.log('✓ 已唤醒目标会话（engine session/prompt accepted）');
console.log('  台账：' + core.LEDGER);
console.log('  查询：node 工具\\派单.mjs --list ｜ 销账：node 工具\\派单.mjs --complete ' + r.taskId + ' --evidence "..."');
console.log('  提示：若目标会话正忙，引擎会 queue 到当前回合结束后。');
