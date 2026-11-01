#!/usr/bin/env node
// 强制更新.mjs —— 版本策略的会话入口（对应 外壳\scripts\mandatory-update.js）
//
// 用法：
//   node 外壳\scripts\强制更新.mjs                      # = state：策略是什么、本机版本、会不会拦
//   node 外壳\scripts\强制更新.mjs 设 1.2.0             # 要求最低 1.2.0（软提示，可「稍后」）
//   node 外壳\scripts\强制更新.mjs 设 1.2.0 --hard      # 硬拦：窗口关不掉，直到升级
//   node 外壳\scripts\强制更新.mjs 设 1.2.0 --hard --title "..." --detail "..." --deadline 2026-12-01
//   node 外壳\scripts\强制更新.mjs 清                   # 删掉策略（恢复放行）
//
// 说明：本脚本只改 data\version-policy.json，不碰运行中的进程；工作台每 30 分钟（以及启动时）
// 自己判定一次，命中就弹提示窗。想立刻看到效果就重启工作台。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const MU = require(path.join(HERE, 'mandatory-update.js'));

const POLICY = MU.files.POLICY_FILE;
const STATE = MU.files.STATE_FILE;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : ''; };
const words = argv.filter((a) => !a.startsWith('--'));
const cmd = String(words[0] || 'state').toLowerCase();

function currentVersion() {
  try { return String(JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version || '0.0.0'); }
  catch (e) { return '0.0.0'; }
}
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return null; } }

if (cmd === 'state' || cmd === 'status') {
  const cur = currentVersion();
  const pol = MU.loadPolicy();
  const v = MU.verdict(cur);
  const st = readJson(STATE) || {};
  console.log('版本策略（强制更新）');
  console.log('  本机版本：' + cur);
  console.log('  要求下限：' + (pol.minVersion || '（未设 · 放行一切）'));
  console.log('  策略类型：' + (!pol.minVersion ? '无策略' : (pol.mandatory ? (pol.hardBlock ? '硬拦（窗口关不掉）' : '软提示（可稍后）') : '只记录（mandatory=false ⇒ 不拦）')));
  if (pol.detail) console.log('  说明    ：' + pol.detail);
  if (pol.deadline) console.log('  截止    ：' + pol.deadline);
  if (pol.page) console.log('  说明页  ：' + pol.page);
  console.log('  本次判定：' + (v.blocking ? (v.hardBlock ? '拦下（硬）' : '拦下（软）') : '放行'));
  if (st.state) console.log('  上次状态：' + st.state + (st.at ? ' · ' + st.at : '') + (st.verdict ? ' · 当时 ' + st.verdict.current + ' < ' + st.verdict.minVersion : ''));
  console.log('\n策略文件：' + POLICY);
  console.log('改动不写死在这里：设 → `node 外壳\\scripts\\强制更新.mjs 设 <版本> [--hard]`；清 → `… 清`');
  process.exit(0);
}

if (cmd === '设' || cmd === 'set') {
  const minv = words[1] || val('--min');
  if (!minv) { console.error('✗ 要写最低版本号，例如：强制更新.mjs 设 1.2.0 [--hard]'); process.exit(2); }
  if (!/^\d+(\.\d+)*([\-.+][0-9A-Za-z.\-+]*)?$/.test(minv)) { console.error('✗ 版本号看着不对：' + minv); process.exit(2); }
  const cur = currentVersion();
  const prev = readJson(POLICY) || {};
  const next = Object.assign({}, prev, {
    minVersion: minv,
    mandatory: true,
    hardBlock: has('--hard'),
    title: val('--title') || prev.title || '需要更新到新版本',
    detail: val('--detail') || prev.detail || '',
    page: val('--page') || prev.page || '',
    deadline: val('--deadline') || prev.deadline || null,
  });
  fs.mkdirSync(path.dirname(POLICY), { recursive: true });
  fs.writeFileSync(POLICY, JSON.stringify(next, null, 1), 'utf8');
  const hit = MU.compareVersion(cur, minv) < 0;
  console.log('✓ 策略已写：最低 ' + minv + '（' + (next.hardBlock ? '硬拦' : '软提示') + '）');
  console.log('  本机 ' + cur + (hit ? ' < ' + minv + ' ⇒ 下次判定会拦下' : ' ≥ ' + minv + ' ⇒ 本机不受影响（用来约束旧版本）'));
  console.log('  生效时机：重启工作台，或等它自己下一次判定（≤30 分钟）');
  process.exit(0);
}

if (cmd === '清' || cmd === 'clear') {
  let removed = false;
  for (const f of [POLICY, STATE]) {
    try { if (fs.existsSync(f)) { fs.unlinkSync(f); removed = true; console.log('✓ 已删 ' + path.basename(f)); } } catch (e) { console.error('✗ 删不掉 ' + f + '：' + e.message); }
  }
  if (!removed) console.log('（本来就没有策略/状态文件，已经是放行状态）');
  console.log('  重启工作台后不再提示。');
  process.exit(0);
}

console.error('用法：node 外壳\\scripts\\强制更新.mjs [state | 设 <最低版本> [--hard] [--title ...] [--detail ...] [--deadline ...] [--page <url>] | 清]');
process.exit(2);
