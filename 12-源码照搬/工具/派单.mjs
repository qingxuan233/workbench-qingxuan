#!/usr/bin/env node
/**
 * 派单.mjs —— 任务派发 CLI（薄壳，业务全在 工具/_派单核心.mjs）
 *
 * 用法：
 *   node 工具\派单.mjs --to 命令 "执行环境检查"
 *   node 工具\派单.mjs --to pc-cleanup --title "磁盘体检" --from claude-code "扫描大文件"
 *   node 工具\派单.mjs --complete task-20261108-xxxx --evidence "16绿0红"
 *   node 工具\派单.mjs --list [--limit 20]
 *   node 工具\派单.mjs --complete <id> --idem-key <key>   # 幂等键只在 dispatch 时用
 *
 * 设计（2026-11-08 P0）：
 *   - 台账 = `_共享记忆\_任务台账.jsonl`（append-only + 锁 + 读侧折叠）⇒ 并发不丢单
 *   - 幂等：`--idem-key` 重复派单返回原 task（replayed）
 *   - 唤醒：`工具/_派单核心.mjs` 内做 DSH `session/prompt`（token 优先读 `外壳/data/harness-endpoint.json`）
 *   - 校验：场景不存在 / 未绑定会话 ⇒ 非 0 退出码（**不再"假成功"**）
 */

import * as core from './_派单核心.mjs';

const argv = process.argv.slice(2);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || '') : (d || ''); };
const has = (k) => argv.includes(k);

const die = (msg, code = 1) => { console.error('✗ ' + msg); process.exit(code); };

// ── 查看 ─────────────────────────────────────────────────
if (has('--list')) {
  const limit = Math.max(1, Math.min(200, Number(val('--limit', '20')) || 20));
  const rows = core.list(limit);
  if (!rows.length) {
    console.log('（任务台账为空）');
    process.exit(0);
  }
  console.log('=== 任务台账（最近 ' + rows.length + ' 条）===');
  for (const t of rows) {
    console.log(
      '[' + String(t.status || 'pending').toUpperCase() + '] ' + t.taskId +
      '  ' + (t.from || '-') + ' → ' + (t.to || '-') + ' ：「' + (t.title || '') + '」' +
      '  ' + String(t.createdAt || '').slice(0, 16).replace('T', ' ') +
      (t.evidence ? '  证据: ' + String(t.evidence).slice(0, 40) : '')
    );
  }
  process.exit(0);
}

// ── 销账 ─────────────────────────────────────────────────
if (has('--complete')) {
  const id = val('--complete');
  if (!id) die('--complete 需要任务编号');
  const evidence = val('--evidence', '执行完成');
  const r = core.complete(id, evidence);
  if (!r.ok) die(r.err || '销账失败');
  console.log('✓ 任务 ' + id + ' 已销账（completed），证据：' + evidence);
  process.exit(0);
}

// ── 派单 ─────────────────────────────────────────────────
const to = val('--to');
const title = val('--title', '系统派单');
const from = val('--from', 'cli');
const idemKey = val('--idem-key', '');
const content = argv
  .filter((a, i) => !a.startsWith('--') &&
    !['--to', '--title', '--from', '--idem-key', '--evidence', '--limit'].includes(argv[i - 1]))
  .join(' ').trim();

if (!to || !content) {
  console.log('用法：node 工具\\派单.mjs --to <场景名|id> [--title "标题"] [--from "调用者"] [--idem-key "键"] "任务正文"');
  console.log('      node 工具\\派单.mjs --list [--limit 20]');
  console.log('      node 工具\\派单.mjs --complete <taskId> --evidence "证据"');
  process.exit(2);
}

const r = await core.dispatch({ to, title, content, from, idemKey: idemKey || null });
if (!r.ok) die(r.err || '派单失败');

if (r.replayed) {
  console.log('✓ 幂等命中：' + r.taskId + '（未重复唤醒，状态 ' + (r.status || 'pending') + '）');
  process.exit(0);
}

console.log('✓ 任务已入账：' + r.taskId + ' → ' + (r.scene || to));

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
