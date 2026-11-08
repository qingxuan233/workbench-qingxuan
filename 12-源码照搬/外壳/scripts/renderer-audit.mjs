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
const PANELS_DIR = path.join(ROOT, 'renderer', 'panels');
const SCEN_DIR = path.join(ROOT, 'scenarios');
// P2-D 拆域：注册源从"单文件"扩展为 **renderers.js + renderer/panels/*.js**（多文件注册）。
// 只读；panel-registry.js / panel-harness.js 等用 REGISTRY.register 的不在本审计范围（正则不会命中）。
const SOURCE_FILES = [RENDERERS].concat(
  fs.existsSync(PANELS_DIR)
    ? fs.readdirSync(PANELS_DIR).filter((f) => f.endsWith('.js')).sort().map((f) => path.join(PANELS_DIR, f))
    : []
);
const sources = SOURCE_FILES.map((file) => {
  const src = fs.readFileSync(file, 'utf8');
  return { rel: path.relative(ROOT, file).split(path.sep).join('/'), src, lines: src.split(/\r?\n/) };
});
const srcAll = sources.map((s) => s.src).join('\n');

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

// 注册形态（三种都认）：
//   renderers.X = …… / renderers['x'] = …… / APP['x'] = …… / APP_RENDERERS['x'] = ……
const DEF_RE = /(?:renderers(?:\.([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])|APP_RENDERERS?\[\s*['"]([^'"]+)['"]\s*\]|APP\[\s*['"]([^'"]+)['"]\s*\])\s*=/g;
const defs = [];
for (const s of sources) {
  DEF_RE.lastIndex = 0;
  let m;
  while ((m = DEF_RE.exec(s.src))) {
    const name = m[1] || m[2] || m[3] || m[4];
    defs.push({ name, file: s.rel, start: s.src.slice(0, m.index).split(/\r?\n/).length });
  }
}
const names = [...new Set(defs.map((d) => d.name))].sort();
const all = names.map((n) => {
  const pats = ['renderers.' + n, "renderers['" + n + "']", 'renderers["' + n + '"]',
    "APP['" + n + "']", 'APP["' + n + '"]', "APP_RENDERERS['" + n + "']", 'APP_RENDERERS["' + n + '"]'];
  const refs = srcAll.split(/\r?\n/).reduce((k, l) => k + (pats.some((p) => l.includes(p)) ? 1 : 0), 0);
  return { name: n, refs };
});
const dead = all.filter((x) => !used.has(x.name) && x.refs <= 1).map((x) => x.name);
const reused = all.filter((x) => x.refs > 1 && !used.has(x.name)).map((x) => x.name);

// 单引用顶层函数（只声明、无人调用）——按"全仓渲染源"合计引用数，避免跨文件引用被误判成孤儿
const fns = [];
for (const s of sources) {
  const fre = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = fre.exec(s.src))) {
    const name = m[1];
    const count = (srcAll.match(new RegExp('\\b' + name.replace(/[$]/g, '\\$') + '\\b', 'g')) || []).length;
    if (count === 1) fns.push({ name, file: s.rel, line: s.src.slice(0, m.index).split(/\r?\n/).length });
  }
}

// 按渲染器声明行切块（**同文件内**到下一个声明为止），估算每块行数（只用于排序）
const blocks = [];
for (const s of sources) {
  const own = defs.filter((d) => d.file === s.rel).sort((a, b) => a.start - b.start);
  own.forEach((d, i) => {
    const end = i + 1 < own.length ? own[i + 1].start - 1 : s.lines.length;
    blocks.push({ name: d.name, file: s.rel, start: d.start, lines: Math.max(1, end - d.start + 1) });
  });
}
blocks.sort((a, b) => b.lines - a.lines);

head('1. 体量');
for (const s of sources) ok(s.rel + '：' + s.lines.length + ' 行 / ' + Buffer.byteLength(s.src) + ' 字节');

head('2. 面板类型覆盖');
info('已注册 ' + names.length + ' 种：' + names.join(', '));
info('场景用到 ' + used.size + ' 种：' + [...used].sort().join(', '));
if (dead.length) info('未被场景引用且无交叉引用 ' + dead.length + ' 种（死代码候选）：' + dead.join(', '));
else ok('没有无人引用的类型');
if (reused.length) info('未被场景直接引用、但被其他渲染器复用（不要删）：' + reused.join(', '));

head('3. 单引用顶层函数（孤儿候选）');
if (!fns.length) ok('没有单引用顶层函数');
else fns.forEach((f) => info(f.name + '（' + f.file + ' L' + f.line + '）'));

head('4. 渲染器声明间隔（粗略，仅用于找大块）');
blocks.slice(0, 10).forEach((b) => info(b.name + '：' + b.lines + ' 行（' + b.file + ' L' + b.start + '）'));

console.log('\n提示：删除前先跑 node scripts/ui-preview.cjs --shot=data/audit.png --scene=command，');
console.log('      再切 B站 / 自我复盘 / 本地电脑 各看一次（或跑 check-gui + 验收）。');
