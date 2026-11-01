#!/usr/bin/env node
// 浏览器侧栏.mjs —— 原生浏览器侧栏的会话入口（对应 外壳\scripts\sidebar.js）
//
// 用法：
//   node 外壳\scripts\浏览器侧栏.mjs state              # 有没有附着、占哪块、现在什么 URL
//   node 外壳\scripts\浏览器侧栏.mjs open [url]         # 附着到主窗口并打开（不给 url 就用默认页）
//   node 外壳\scripts\浏览器侧栏.mjs close              # 从窗口上摘下来（视图保留，可再 open）
//   node 外壳\scripts\浏览器侧栏.mjs url <url>          # 在这个侧栏里跳转
//   node 外壳\scripts\浏览器侧栏.mjs bounds x,y,w,h     # 贴到哪（屏幕像素）
//   可加 --wait <毫秒>（默认 4000）：等主进程执行完再回话。
//
// 通道：写 data\sidebar-command.cmd，sidebar.js 每秒读一次、执行完把状态写 data\sidebar-state.json。
// ⇒ 不需要 IPC、不需要端口，工作台在跑就会执行。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const DATA = path.join(APP, 'data');
const CMD = path.join(DATA, 'sidebar-command.cmd');
const STATE = path.join(DATA, 'sidebar-state.json');

const argv = process.argv.slice(2);
const flagVal = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const words = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--wait');
const cmd = String(words[0] || 'state').toLowerCase();
const waitMs = Math.max(500, parseInt(flagVal('--wait') || '4000', 10) || 4000);

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return null; }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const USAGE = '用法：node 外壳\\scripts\\浏览器侧栏.mjs [state | open [url] | close | url <url> | bounds x,y,w,h]';

let line = '';
if (cmd === 'state') {
  line = 'state';
} else if (cmd === 'open') {
  line = 'open' + (words[1] ? ' ' + words[1] : '');
} else if (cmd === 'close') {
  line = 'close';
} else if (cmd === 'url') {
  if (!words[1]) { console.error('✗ url 后面要给地址'); process.exit(2); }
  line = 'url ' + words[1];
} else if (cmd === 'bounds') {
  const n = String(words[1] || '').split(',').map((x) => parseInt(x, 10));
  if (n.length !== 4 || n.some((x) => isNaN(x))) { console.error('✗ bounds 要 4 个整数：x,y,w,h'); process.exit(2); }
  line = 'bounds ' + n.join(',');
} else {
  console.error(USAGE);
  process.exit(2);
}

// 工作台没在跑的话命令写进去也没人执行 —— 先看一眼引擎端口/状态文件的新鲜度，给句实话。
const st0 = readState();
let appSeemsUp = false;
try { appSeemsUp = !!(st0 && st0.at && (Date.now() - Date.parse(st0.at)) < 10 * 60 * 1000); } catch (e) { appSeemsUp = false; }

fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(CMD, line, 'utf8');

if (!appSeemsUp) {
  console.log('! 工作台好像没在跑（侧栏状态文件是旧的/没有）');
  console.log('  命令已写进 ' + CMD);
  console.log('  ⇒ 下次启动工作台 1 秒内会执行一次；现在要看结果，先双击「启动工作台」。');
  if (cmd === 'state') process.exit(1);
}

// 等主进程把同一个动作做完：状态文件的 at/event 变了就算执行过
const before = st0 ? String(st0.at || '') + '|' + String(st0.event || '') : '';
const started = Date.now();
let after = null;
while (Date.now() - started < waitMs) {
  await sleep(250);
  after = readState();
  const now = after ? String(after.at || '') + '|' + String(after.event || '') : '';
  if (now && now !== before) break;
}
// open 的"附着"会先回话，真正的 did-navigate 要等页面起来 ⇒ 再等一小会儿把 URL 补上
if (cmd === 'open') { await sleep(1600); after = readState(); }

const s = after || readState() || {};
console.log('侧栏状态' + (s.at ? '（' + s.at + '）' : ''));
console.log('  附着    ：' + (s.attached ? '是（挂在窗口上）' : '否（没挂，工作台照常用）'));
if (s.bounds) console.log('  位置    ：x=' + s.bounds.x + ' y=' + s.bounds.y + ' w=' + s.bounds.width + ' h=' + s.bounds.height);
console.log('  URL     ：' + (s.url || '（还没打开过页面）'));
if (s.event) console.log('  最近事件：' + s.event + (s.code ? ' ' + s.code + ' ' + (s.desc || '') : ''));
if (!s.at) console.log('\n（还没有状态文件 ⇒ 工作台启动后 sidebar.js 才会写第一份）');
console.log('\n命令文件：' + CMD + '\n状态文件：' + STATE);
process.exit(0);
