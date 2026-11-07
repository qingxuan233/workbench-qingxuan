#!/usr/bin/env node
// engine-before.mjs —— 升引擎之前的"存档"（会话入口）
//
//   node 外壳\scripts\engine-before.mjs
//
// 升级顺序（见 05-协作与规矩\一-全局铁律.md）：
//   engine-before → git pull → pnpm install → pnpm run build → engine-after
//
// 它做三件事：
//   ① 把"现在的引擎是什么样"记下来 ⇒ data\engine-before-<时间>.json（版本 / HEAD / 插件 / 技能数 / 关键产物）
//   ② 提醒先备份外壳（backup-gui.mjs）并 git stash（本地补丁）
//   ③ 记一份启动配置快照（有 工具\引擎快照.mjs 就顺手存一代，方便升坏了回退）
//
// ★ 没有 引擎\ 目录（源码直跑 + 外部引擎）时，只做 ② 的提醒和一份"外部引擎"记录，不硬报错。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUI = path.resolve(HERE, '..');
const ROOT = path.resolve(GUI, '..');
const DATA = path.join(GUI, 'data');

function engineDir() {
  for (const c of [path.join(ROOT, '引擎'), path.join(ROOT, '..', '引擎')]) {
    try { if (fs.statSync(c).isDirectory()) return c; } catch (e) { /* ignore */ }
  }
  return '';
}
function sh(cmd, args) { try { return String(execFileSync(cmd, args, { encoding: 'utf8', timeout: 20000 }) || '').trim(); } catch (e) { return ''; } }
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

const ENG = engineDir();
const rec = {
  at: new Date().toISOString(),
  host: { app: 'workbench', gui: path.basename(ROOT), appVersion: (() => { try { return JSON.parse(fs.readFileSync(path.join(GUI, 'package.json'), 'utf8')).version; } catch (e) { return ''; } })() },
  engine: { dir: ENG ? path.relative(ROOT, ENG) : null, mode: ENG ? '内置引擎' : '源码直跑（外部 CLI）' },
};

if (ENG) {
  try { rec.engine.version = JSON.parse(fs.readFileSync(path.join(ENG, 'package.json'), 'utf8')).version || ''; } catch (e) { rec.engine.version = ''; }
  rec.engine.head = sh('git', ['-C', ENG, 'rev-parse', '--short', 'HEAD']);
  rec.engine.branch = sh('git', ['-C', ENG, 'rev-parse', '--abbrev-ref', 'HEAD']);
  rec.engine.dirty = sh('git', ['-C', ENG, 'status', '--porcelain']).split(/\r?\n/).filter(Boolean).length;
  rec.engine.behind = sh('git', ['-C', ENG, 'rev-list', '--count', 'HEAD..@{u}']) || '';
  const cli = path.join(ENG, 'apps', 'cli', 'lib', 'bin.js');
  rec.engine.cliBuilt = fs.existsSync(cli);
  const plugins = [path.join(ROOT, '插件'), path.join(ENG, '插件')].filter((d) => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } });
  rec.engine.plugins = plugins.map((d) => ({ dir: path.relative(ROOT, d), items: (() => { try { return fs.readdirSync(d).filter((x) => !x.startsWith('.')).length; } catch (e) { return -1; } })() }));
} else {
  // 外部引擎：能记的只有"壳这侧认为适配哪个版本"
  try {
    const s = fs.readFileSync(path.join(GUI, 'renderer', 'renderers.js'), 'utf8');
    rec.engine.adapted = (s.match(/var ADAPTED_ENGINE\s*=\s*'([^']+)'/) || [])[1] || '';
  } catch (e) { rec.engine.adapted = ''; }
  const cliPath = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, '工作台.json'), 'utf8').replace(/^\uFEFF/, '')).engine.cliPath || ''; } catch (e) { return ''; } })();
  rec.engine.externalCli = cliPath;
  if (cliPath) rec.engine.externalCliExists = fs.existsSync(cliPath);
}
const skills = path.join(ROOT, '引擎数据', '.dsh', 'skills');
rec.skills = { dir: '引擎数据\\.dsh\\skills', exists: fs.existsSync(skills), items: (() => { try { return fs.readdirSync(skills).filter((x) => !x.startsWith('.') && !x.startsWith('_')).length; } catch (e) { return 0; } })() };
rec.sessions = (() => {
  const p = path.join(ROOT, '引擎数据', '.dsh', 'session_projcache.json');
  try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return Array.isArray(j) ? j.length : (Object.keys(j).length || 0); } catch (e) { return 0; }
})();

// 存档落盘必须"失败也说得清"：以前这里裸 writeFileSync，目录不可写时直接抛 EPERM 栈，
// 前面算好的版本/技能/会话信息一行都没打出来（2026-11-07 实测踩到）。现在：先打报告，再试落盘，
// 落不下就把整份记录打在 stdout 里并给非 0 退出码（--no-save 时明确说"只报告"）。
const NO_SAVE = process.argv.includes('--no-save');
fs.mkdirSync(DATA, { recursive: true });
const out = path.join(DATA, 'engine-before-' + stamp() + '.json');

console.log('引擎升级前存档');
console.log('  引擎形态：' + rec.engine.mode + (rec.engine.dir ? '（' + rec.engine.dir + '）' : ''));
if (rec.engine.version) console.log('  引擎版本：' + rec.engine.version);
if (rec.engine.head) console.log('  HEAD    ：' + rec.engine.head + '（' + rec.engine.branch + '）' + (rec.engine.dirty ? ' · 本地改动 ' + rec.engine.dirty + ' 个文件' : ''));
if (rec.engine.adapted) console.log('  壳适配  ：' + rec.engine.adapted);
console.log('  技能/会话：' + rec.skills.items + ' 个技能 · ' + rec.sessions + ' 条会话');

let saved = false;
if (!NO_SAVE) {
  try { fs.writeFileSync(out, JSON.stringify(rec, null, 1), 'utf8'); saved = true; }
  catch (e) {
    console.log('  ✗ 存档没写下去：' + path.relative(ROOT, out) + '（' + (e && e.code ? e.code : e.message) + '）');
    console.log('    ⇒ data\\ 目录不可写（沙箱/权限），这是环境问题不是脚本问题。两种处理：');
    console.log('      ① 换到可写目录跑：node 外壳\\scripts\\engine-before.mjs --no-save 并把下面这段 JSON 自己存起来；');
    console.log('      ② 给 data\\ 写权限（或在能写的终端里跑）。');
    console.log('    ---- engine-before JSON（可直接另存为 ' + path.basename(out) + '）----');
    console.log(JSON.stringify(rec, null, 1));
    console.log('    ---- end ----');
  }
}
if (saved) console.log('  ✔ 已写 ' + path.relative(ROOT, out));
else if (NO_SAVE) console.log('  · --no-save：只报告，不落盘');

console.log('\n升级前请自己确认（脚本不替你做）：');
console.log('  1) 备份外壳：node 外壳\\scripts\\backup-gui.mjs');
console.log('  2) 引擎有本地补丁就先 git stash');
if (rec.engine.dirty) console.log('     ⚠ 引擎目录现在就有 ' + rec.engine.dirty + ' 个未提交改动 —— 先 stash 再 pull');
console.log('  3) 升级：git pull → pnpm install → pnpm run build');
console.log('  4) 升完跑：node 外壳\\scripts\\engine-after.mjs（它会明确区分 通过 / 跳过 / 失败）');

// 顺手存一代启动配置（有工具就存，没有就只提醒）
const snapTool = path.join(ROOT, '工具', '引擎快照.mjs');
if (fs.existsSync(ENG) && fs.existsSync(snapTool)) {
  const r = sh(process.execPath, [snapTool, '--save']);
  console.log('\n启动配置快照：' + (r || '（引擎快照.mjs 没有输出）').split(/\r?\n/).slice(-1)[0]);
} else if (fs.existsSync(snapTool)) {
  console.log('\n提示：启动配置快照（工具\\引擎快照.mjs --save）只在有内置引擎时有意义，这次跳过。');
}
// 退出码：0 = 报告完整 + 存档已落；1 = 存档没落下去（环境问题，上面已给出补救办法）
process.exit(saved || NO_SAVE ? 0 : 1);
