#!/usr/bin/env node
/**
 * 身份索引.mjs —— 让 `_场景身份索引.md` 变成「生成物」，而不是第二份手抄真源
 *
 * 背景（方法论 O3）：
 *   同一件事（场景 ↔ 面板 ↔ 会话）原来存在于三处：场景 json、身份索引表、换会话脚本的映射表。
 *   三处手抄 ⇒ 必然漂移：换过会话忘了改索引，`场景记忆.mjs check` 就报「会话未绑定场景 json」，
 *   而脚本里那张表早就没用上了。**真源只有一个：场景 json**；索引表由它生成，禁止手改。
 *
 * 用法：
 *   node 工具\身份索引.mjs                只报告差异（不写）
 *   node 工具\身份索引.mjs --stamp        重写表格（保留表外的一切内容）
 *   node 工具\身份索引.mjs --check        有漂移就退出码 1（给体检/发布前检查用）
 *
 * 退出码：0 一致/stamp 成功 ｜1 有漂移 ｜2 用法错误
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const SCEN = path.join(APP, '外壳', 'scenarios');
const IDX = path.join(SCEN, '_场景身份索引.md');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } };

/** 从场景 json 推导一行 */
function rows() {
  const out = [];
  for (const f of fs.readdirSync(SCEN).filter((x) => x.endsWith('.json')).sort()) {
    const j = readJson(path.join(SCEN, f));
    if (!j || !j.id) continue;
    const panel = (j.panels || []).find((p) => p && p.type === 'harness') || {};
    const cell = (s) => '`' + String(s == null ? '' : s) + '`';
    out.push([
      cell(j.id),
      cell(panel.id || ''),
      panel.title || '',
      j.sessionTitle || panel.sessionTitle || j.name || '',
      cell(j.sessionId || panel.sessionId || ''),
      cell('scenarios\\' + (j.contextFile || j.id + '-context.md')),
      cell(j.skill || (Array.isArray(j.skills) ? j.skills[0] : '') || j.id)
    ]);
  }
  return out;
}

const HEAD = '| 场景 id | 面板 id | 面板标题 | 会话名（pinTarget 首项） | 会话 id | 定位卡 | 主技能 |';
const SEP = '|---|---|---|---|---|---|---|';

const tableLines = () => [HEAD, SEP, ...rows().map((c) => '| ' + c.join(' | ') + ' |')];

function current() {
  if (!fs.existsSync(IDX)) return '';
  return fs.readFileSync(IDX, 'utf8');
}

/** 把表体换成生成结果，表外（标题/说明/建会话命令）原样保留 */
function stamp(text) {
  const lines = text.split(/\r?\n/);
  const a = lines.findIndex((l) => l.trim().startsWith('| 场景 id'));
  const want = tableLines();
  if (a < 0) return text.trimEnd() + '\n\n' + want.join('\n') + '\n';
  let b = a;
  while (b < lines.length && lines[b].trim().startsWith('|')) b++;
  const next = [...lines.slice(0, a), ...want, ...lines.slice(b)];
  return next.join('\n');
}

const before = current();
if (!before) { console.error('✗ 找不到 ' + IDX); process.exit(1) }

const want = tableLines();
const now = [];
{
  const lines = before.split(/\r?\n/);
  const a = lines.findIndex((l) => l.trim().startsWith('| 场景 id'));
  if (a >= 0) { let b = a; while (b < lines.length && lines[b].trim().startsWith('|')) b++; now.push(...lines.slice(a, b)); }
}

const same = want.length === now.length && want.every((l, i) => now[i].trim() === l.trim());

if (!same) {
  console.log('身份索引与场景 json 不一致：');
  for (let i = 0; i < Math.max(want.length, now.length); i++) {
    if ((now[i] || '').trim() === (want[i] || '').trim()) continue;
    console.log('  json → ' + (want[i] || '（缺行）'));
    console.log('  索引 ← ' + (now[i] || '（缺行）'));
  }
} else {
  console.log('✓ 身份索引与场景 json 一致（' + (rows().length) + ' 个场景）');
}

if (has('--check')) process.exit(same ? 0 : 1);
if (!has('--stamp')) { if (!same) console.log('\n（只报告；加 --stamp 重写表格）'); process.exit(same ? 0 : 1) }
if (same) { console.log('（无需改写）'); process.exit(0) }

fs.writeFileSync(IDX, stamp(before), 'utf8');
console.log('✓ 已重写 ' + path.relative(APP, IDX) + '（表外内容原样保留）');
