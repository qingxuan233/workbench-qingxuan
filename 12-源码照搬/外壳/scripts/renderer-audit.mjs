#!/usr/bin/env node
/**
 * renderer-audit.mjs —— 渲染器体量与死代码审计（2026-11-04）
 *
 *   node scripts/renderer-audit.mjs
 *
 * 只读，不改任何文件。输出：
 *   · renderers.js 行数 / 字节
 *   · 已注册面板类型 vs 4 个场景实际用到的类型
 *   · 未被任何场景引用的类型（死代码候选）
 *   · 只出现一次（声明）的顶层函数（孤儿函数候选）
 *   · 体积最大的 10 个渲染器块
 *
 * 用途：每次删死代码前后跑一遍，确认“删的是候选、不是活代码”；
 * 真删之前请先看场景 json 与 runtime 预览（scripts/ui-preview.cjs）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERERS = path.join(ROOT, 'renderer', 'renderers.js');
const SCEN_DIR = path.join(ROOT, 'scenarios');
const src = fs.readFileSync(RENDERERS, 'utf8');
const lines = src.split(/\r?\n/);
const lineAt = (pos) => src.slice(0, pos).split(/\r?\n/).length;

const ok = (m) => console.log('  ✓ ' + m);
const info = (m) => console.log('  · ' + m);
const head = (m) => console.log('\n== ' + m + ' ==');

// 场景实际用到的类型
const used = new Set();
for (const f of fs.readdirSync(SCEN_DIR).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
  try {
    const sc = JSON.parse(fs.readFileSync(path.join(SCEN_DIR, f), 'utf8'));
    (sc.panels || []).forEach((p) => used.add(p.type));
  } catch (e) { /* 坏 json 交给 check-gui */ }
}

// renderers.X = / renderers['x'] =
const defs = [];
const re = /renderers(?:\.([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])\s*=/g;
let m;
while ((m = re.exec(src))) {
  const name = m[1] || m[2];
  const start = lineAt(m.index);
  defs.push({ name, start });
}
const names = [...new Set(defs.map((d) => d.name))].sort();
const all = names.map((n) => {
  const pats = ['renderers.' + n, "renderers['" + n + "']", 'renderers["' + n + '"]'];
  const refs = lines.reduce((k, l) => k + (pats.some((p) => l.includes(p)) ? 1 : 0), 0);
  return { name: n, refs };
});
const dead = all.filter((x) => !used.has(x.name) && x.refs <= 1).map((x) => x.name);
const reused = all.filter((x) => x.refs > 1 && !used.has(x.name)).map((x) => x.name);

// 单引用顶层函数（只声明、无人调用）
const fns = [];
const fre = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
while ((m = fre.exec(src))) {
  const name = m[1];
  const count = (src.match(new RegExp('\\b' + name.replace(/[$]/g, '\\$') + '\\b', 'g')) || []).length;
  if (count === 1) fns.push({ name, line: lineAt(m.index) });
}

// 按渲染器声明行切块，估算每块行数（只用于排序，不精确到语句）
defs.sort((a, b) => a.start - b.start);
const blocks = defs.map((d, i) => {
  const end = i + 1 < defs.length ? defs[i + 1].start - 1 : lines.length;
  return { name: d.name, start: d.start, lines: Math.max(1, end - d.start + 1) };
}).sort((a, b) => b.lines - a.lines);

head('1. 体量');
ok('renderers.js：' + lines.length + ' 行 / ' + Buffer.byteLength(src) + ' 字节');

head('2. 面板类型覆盖');
info('已注册 ' + names.length + ' 种：' + names.join(', '));
info('场景用到 ' + used.size + ' 种：' + [...used].sort().join(', '));
if (dead.length) info('未被场景引用且无交叉引用 ' + dead.length + ' 种（死代码候选）：' + dead.join(', '));
else ok('没有无人引用的类型');
if (reused.length) info('未被场景直接引用、但被其他渲染器复用（不要删）：' + reused.join(', '));

head('3. 单引用顶层函数（孤儿候选）');
if (!fns.length) ok('没有单引用顶层函数');
else fns.forEach((f) => info(f.name + '（L' + f.line + '）'));

head('4. 渲染器声明间隔（粗略，仅用于找大块）');
blocks.slice(0, 10).forEach((b) => info(b.name + '：' + b.lines + ' 行（L' + b.start + '）'));

console.log('\n提示：删除前先跑 node scripts/ui-preview.cjs --shot=data/audit.png --scene=command，');
console.log('      再切 B站 / 自我复盘 / 本地电脑 各看一次（或跑 check-gui + 验收）。');
