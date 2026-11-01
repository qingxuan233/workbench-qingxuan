// 记忆神经元路径体检：完全照抄 renderers.js renderers.neuron 的取值规则，
// 把每个节点会去 stat 的 path 列出来，逐个验真。用法：
//   node scripts\check-neuron-paths.mjs [--home <场景记忆的父目录，即 .dsh 目录>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const SHELL = path.resolve(__dir, '..');
const WB = path.resolve(SHELL, '..');

// ---- 取 --home / --skills：与 preload.js 一致（--dsh-home= / --dsh-skills=）----
function argVal(prefix) {
  const a = (process.argv || []).find(s => String(s).indexOf(prefix) === 0);
  return a ? String(a).slice(prefix.length) : '';
}
const HOME = argVal('--home=') || process.env.DSH_CUSTOMER_HOME || path.join(WB, '引擎数据', '.dsh');
const SKILL_DIR = argVal('--skills=') || path.join(HOME, 'skills');

const MEM_ROOT = path.join(HOME, '场景记忆');   // preload: memRoot = home + '\场景记忆'
const ROOT = path.join(MEM_ROOT, '_共享记忆');
const META_DIR = MEM_ROOT;
const CHAIN_DIR = path.join(ROOT, '提交链');
const MEM_DIR = MEM_ROOT;

const MEMORY_BY_PANEL = {
  'cmd-chat': path.join(MEM_DIR, '命令', '场景私有记忆.md'),
  'bv-ai': path.join(MEM_DIR, 'B站', '场景私有记忆.md'),
  'dg-dsh': path.join(MEM_DIR, 'DSH·GUI改造', '场景私有记忆.md'),
  'dg-gui': path.join(MEM_DIR, 'DSH·GUI改造', '场景私有记忆.md'),
  'bl-ai': path.join(MEM_DIR, 'Blender', '场景私有记忆.md'),
};
const SKILL_FALLBACK = ['gui-workbench', 'harness-dev', 'context-overflow', 'workbuddy', 'webai-offload',
  'new-tools', 'code-dev', 'design-misc', 'pc-cleanup', 'bilibili', 'blender', 'comfyui',
  'code-video', 'jianying-ai-editor', 'oa-ops', 'your-site', 'self-profile',
  'video-workflow-canvas', 'transparent-flow-video', 'provider-direct', 'host-scan', 'app-packaging',
  'local-pc-control', 'command', 'douyin'];

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function exists(p) { if (!p) return false; try { const st = fs.statSync(p); return !!(st.isDirectory() || st.isFile()); } catch { return false; } }
function __memAbs(mp) {
  if (!mp) return '';
  if (/^[A-Za-z]:/.test(mp)) return mp;
  return path.join(MEM_ROOT, String(mp).replace(/^引擎[\\/]场景记忆[\\/]/, ''));
}
const toWin = p => String(p).split('/').join('\\');

const idx = readJson(path.join(ROOT, '索引.json'));
const reg = readJson(path.join(ROOT, '项目.json'));
const memMap = readJson(path.join(ROOT, '记忆地图.json'));

const memByPanel = {};
if (memMap && Array.isArray(memMap.areas)) {
  memMap.areas.forEach(a => { if (a && a.panel && Array.isArray(a.privateMemory) && a.privateMemory.length) memByPanel[a.panel] = a.privateMemory; });
}
const areas = (idx && idx.areas) || [];
const nodes = [];
const add = (kind, id, label, p, extra) => nodes.push({ kind, id, label, path: p ? toWin(p) : '', ...(extra || {}) });

// core
add('core', 'core', 'DSH 记忆', ROOT);
// docs
// 2026-11-01：共享文档都在 _共享记忆 下（不是 场景记忆 根）
[['doc-todo', '待办', path.join(ROOT, '_待办.md')],
 ['doc-msg', '通知', path.join(ROOT, '_跨场景通知.md')],
 ['doc-conf', '冲突', path.join(ROOT, '冲突.md')]].forEach(([id, lb, p]) => add('doc', id, lb, p));
// areas
areas.forEach(a => add('area', 'area-' + a.owner, a.owner, path.join(ROOT, String(a.file || '').replace(/\//g, '\\')), { owner: a.owner }));
// projects
const fromReg = !!(reg && Array.isArray(reg.projects) && reg.projects.length);
if (fromReg) reg.projects.forEach(pr => { if (pr && pr.name) add('project', 'proj-' + (pr.id || pr.name), String(pr.name), (Array.isArray(pr.paths) && pr.paths[0]) || '', { owner: String(pr.owner || '') }); });
// memories
areas.forEach(a => {
  const list = (memByPanel[a.owner] || (MEMORY_BY_PANEL[a.owner] ? [MEMORY_BY_PANEL[a.owner]] : [])).map(__memAbs);
  list.forEach((mp, mi) => add('memory', 'mem-' + a.owner + (list.length > 1 ? '-' + mi : ''), '§' + a.owner + (list.length > 1 ? '·' + (mi + 1) : ''), mp, { ownerPanel: a.owner, src: memByPanel[a.owner] ? '记忆地图.json' : 'MEMORY_BY_PANEL 兜底' }));
});
// data sources
if (memMap && memMap.dataSources) {
  const SKIP = { scenes: 1, skills: 1, projects: 1, tasks: 1 };
  Object.keys(memMap.dataSources).forEach(key => {
    if (SKIP[key]) return;
    const ds = memMap.dataSources[key] || {};
    const nm = ({ tools: '工具', plugins: '插件', mcp: 'MCP', sessions: '会话档案', backups: '备份', docs: '说明台账', health: '体检' })[key] || key;
    add('source', 'src-' + key, nm + (ds.count ? ' ' + ds.count : ''), String(ds.path || ds.board || ''), { srcKey: key });
  });
}
// chains
let chainRows = [];
try { chainRows = fs.readdirSync(CHAIN_DIR).filter(n => /\.jsonl$/i.test(n)); } catch { /* 没有链目录就算了 */ }
chainRows.forEach(name => {
  const p = path.join(CHAIN_DIR, name);
  let list = [];
  try { list = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { }
  if (list.length) add('chain', 'chain-' + name.replace(/\.jsonl$/i, ''), '链 ' + list.length, p);
});
// skills
let dirs = [];
try { dirs = fs.readdirSync(SKILL_DIR, { withFileTypes: true }).filter(d => d.isDirectory() && d.name.charAt(0) !== '_').map(d => d.name); } catch { }
const skillList = dirs.length ? dirs.slice().sort() : SKILL_FALLBACK;
skillList.forEach(n => add('skill', 'skill-' + n, n, path.join(SKILL_DIR, n, 'SKILL.md')));

// ---- 体检 ----
const miss = nodes.filter(n => n.path && !exists(n.path));
const okN = nodes.length - miss.length;
const pad = (s, w) => String(s) + ' '.repeat(Math.max(0, w - [...String(s)].length));
console.log('记忆根   : ' + MEM_ROOT);
console.log('技能目录 : ' + SKILL_DIR + (dirs.length ? '' : '  (读不到 ⇒ 用了兜底清单，' + SKILL_FALLBACK.length + ' 个，必然大面积失效)'));
console.log('节点 ' + nodes.length + ' ｜ 路径在 ' + okN + ' ｜ 路径失效 ' + miss.length);
if (miss.length) {
  console.log('\n── 失效节点 ──');
  console.log(pad('kind', 9) + pad('id', 34) + pad('来源', 20) + 'path');
  miss.forEach(n => {
    const src = n.owner && n.kind === 'memory' ? n.src : (n.kind === 'skill' && !dirs.length ? '兜底清单' : (n.kind === 'memory' ? n.src : ''));
    console.log(pad(n.kind, 9) + pad(n.id, 34) + pad(src, 20) + n.path);
  });
}
// 悬空边（照抄 renderer 的 byId 过滤）
const byId = {};
nodes.forEach(n => { byId[n.id] = n; });
console.log('\n按 kind 统计失效：');
const byKind = {};
miss.forEach(n => { byKind[n.kind] = (byKind[n.kind] || 0) + 1; });
console.log(byKind);
process.exitCode = miss.length ? 2 : 0;
