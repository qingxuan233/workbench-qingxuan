#!/usr/bin/env node
/**
 * _派单核心.test.mjs —— 派单核心的纯函数回归（不写台账、不连引擎）
 *
 * 守的是 P4 信封与超时扫账的口径：
 *   ① normalizeEnvelope：优先级白名单 / 超时上限 / mandate 缺省 / 证据清单截断
 *   ② isOverdue：只有"未结束 + 有截止 + 已过点"才算超时
 *
 * 为什么是纯函数：派单真要落盘时走 `dispatch()`，它会调引擎唤醒；测试里不能连引擎，
 * 所以只把"判定逻辑"抽出来测，落盘路径由 `--sweep`/`--list` 的实跑覆盖。
 *
 * 用法：node 工具\_派单核心.test.mjs        （0=通过 1=失败）
 * 挂钩：`工具/验收.mjs` 第 2 步（自检）的子检查。
 */

import * as core from './_派单核心.mjs';

let failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { console.log('✓ ' + name); return; }
  failed += 1;
  console.log('✗ ' + name + (detail ? ' ← ' + detail : ''));
};

// ── 1. normalizeEnvelope：缺省值 ─────────────────────────────
const d = core.normalizeEnvelope({});
ok('缺省优先级 = P2', d.priority === 'P2', d.priority);
ok('缺省不设截止（timeoutMs=0）', d.timeoutMs === 0, String(d.timeoutMs));
ok('缺省允许写（与旧行为一致）', d.mandate.allowWrite === true);
ok('缺省 scope 为空数组', Array.isArray(d.mandate.scope) && d.mandate.scope.length === 0);
ok('缺省证据清单为空', Array.isArray(d.evidenceExpected) && d.evidenceExpected.length === 0);

// ── 2. 优先级白名单（大小写归一，非法值回落 P2）─────────────
ok('priority=p1 → P1', core.normalizeEnvelope({ priority: 'p1' }).priority === 'P1');
ok('priority=Z9 → 回落 P2', core.normalizeEnvelope({ priority: 'Z9' }).priority === 'P2');
ok('priority 非字符串 → 回落 P2', core.normalizeEnvelope({ priority: 42 }).priority === 'P2');

// ── 3. 超时上限与非法值 ────────────────────────────────────
const cap = core.normalizeEnvelope({ timeoutMs: 99 * 24 * 3600 * 1000 });
ok('超时上限 7 天', cap.timeoutMs === 7 * 24 * 3600 * 1000, String(cap.timeoutMs));
ok('负超时 → 0', core.normalizeEnvelope({ timeoutMs: -5 }).timeoutMs === 0);
ok('非数字超时 → 0', core.normalizeEnvelope({ timeoutMs: 'abc' }).timeoutMs === 0);
ok('小数超时取整', core.normalizeEnvelope({ timeoutMs: 1500.9 }).timeoutMs === 1500, String(core.normalizeEnvelope({ timeoutMs: 1500.9 }).timeoutMs));

// ── 4. mandate / 证据清单 ──────────────────────────────────
const m = core.normalizeEnvelope({ mandate: { allowWrite: false, scope: ['文档/', '工具/'] } });
ok('mandate.allowWrite=false 保留', m.mandate.allowWrite === false);
ok('mandate.scope 保留', m.mandate.scope.join('|') === '文档/|工具/', m.mandate.scope.join('|'));
const many = core.normalizeEnvelope({ evidenceExpected: Array.from({ length: 15 }, (_, i) => 'e' + i) });
ok('证据清单截断到 10 条', many.evidenceExpected.length === 10, String(many.evidenceExpected.length));

// ── 5. isOverdue ───────────────────────────────────────────
const now = Date.parse('2026-11-10T12:00:00Z');
const base = { createdAt: '2026-11-10T11:55:00Z', timeoutMs: 600000, status: 'dispatched' };   // 10 分钟截止
ok('到期前不算超时', core.isOverdue(base, Date.parse('2026-11-10T11:59:00Z')) === false);
ok('到期后算超时', core.isOverdue(base, Date.parse('2026-11-10T12:06:00Z')) === true);
ok('completed 永不超时', core.isOverdue(Object.assign({}, base, { status: 'completed' }), now) === false);
ok('cancelled 永不超时', core.isOverdue(Object.assign({}, base, { status: 'cancelled' }), now) === false);
ok('expired 不重复超时', core.isOverdue(Object.assign({}, base, { status: 'expired' }), now) === false);
ok('没设截止不算超时', core.isOverdue(Object.assign({}, base, { timeoutMs: 0 }), now) === false);
ok('createdAt 非法不判超时', core.isOverdue(Object.assign({}, base, { createdAt: 'x' }), now) === false);
ok('空任务不判超时', core.isOverdue(null, now) === false);

if (failed) {
  console.log(`\n✗ 派单核心：${failed} 项失败`);
  process.exit(1);
}
console.log('\n✓ 派单核心纯函数全部通过（信封缺省/白名单/超时上限/逾期判定）');
process.exit(0);
