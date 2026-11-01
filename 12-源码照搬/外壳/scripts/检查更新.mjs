#!/usr/bin/env node
// 检查更新.mjs —— 会话里的更新入口（对应 main.js 挂载的 外壳\updater.js）
//
// 为什么是"检查"而不是"安装"：updater.js 刻意不做静默安装（见那边的设计注释）。
// 本脚本只回答"我在什么版本、配了没有、有没有新版"，装不装由人决定。
//
// 用法：
//   node 外壳\scripts\检查更新.mjs            # = state：打包没、当前版本、发布源配了没
//   node 外壳\scripts\检查更新.mjs check      # 真去问发布源（需要 data\updater.json 里有 feed）
//   node 外壳\scripts\检查更新.mjs config     # 看配置
//   node 外壳\scripts\检查更新.mjs --feed https://example.com/latest.json
//   node 外壳\scripts\检查更新.mjs --auto off # 关自动检查（只是记录，源码直跑本来也不查）
//   node 外壳\scripts\检查更新.mjs install    # 只解释为什么这里不装

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const U = require(path.join(APP, 'updater.js'));

const argv = process.argv.slice(2);
const flag = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : ''; };
const onoff = (v) => /^(on|1|true|yes|开)$/i.test(String(v || '').trim());

if (argv.includes('--feed')) {
  const feed = flag('--feed').trim();
  if (!/^https?:\/\//i.test(feed)) { console.error('✗ --feed 要给一个 http(s) 地址（发布源的 JSON）'); process.exit(2); }
  U.writeCfg({ feed });
  console.log('✓ 发布源已设为 ' + feed);
  process.exit(0);
}
if (argv.includes('--auto')) {
  U.writeCfg({ autoCheck: onoff(flag('--auto')) });
  console.log('✓ 自动检查更新：' + (U.readCfg().autoCheck ? '开' : '关'));
  process.exit(0);
}

const cmd = String(argv[0] || 'state').toLowerCase();

if (cmd === 'state' || cmd === 'status') {
  const s = U.getState();
  console.log('工作台更新状态');
  console.log('  运行形态：' + (s.packaged ? '打包版（可检查更新）' : '源码直跑（未打包）'));
  console.log('  当前版本：' + s.version);
  console.log('  发布源  ：' + (s.config.feed || '（未配置）'));
  console.log('  自动检查：' + (s.config.autoCheck ? '开' : '关'));
  console.log('  能不能查：' + (s.enabled ? '能' : '不能 —— ' + s.reason));
  if (!s.config.feed) console.log('\n配一个发布源：node 外壳\\scripts\\检查更新.mjs --feed https://你的地址/latest.json');
  console.log('  ⚠ 只检查不安装：有新版会给你下载地址，装不装自己决定。');
  process.exit(0);
}

if (cmd === 'config') {
  console.log(JSON.stringify(U.readCfg(), null, 1));
  console.log('\n配置文件：外壳\\data\\updater.json');
  console.log('改：--feed <url> / --auto on|off');
  process.exit(0);
}

if (cmd === 'check') {
  const r = await U.checkNow({ log: () => { } });
  if (!r.ok) { console.error('✗ ' + r.reason); process.exit(1); }
  console.log('当前版本：' + r.current);
  console.log('最新版本：' + (r.latest || '（发布源没给 version）'));
  console.log(r.newer ? '有新版 → ' + (r.url || '（发布源没给下载地址）') : '已是最新 ✓');
  if (r.notes) console.log('\n更新说明：\n' + r.notes);
  process.exit(r.newer ? 0 : 0);
}

if (cmd === 'install') {
  console.log('这里不安装更新，是有意的：');
  console.log('  · 工作台是"你自己的那份"，升级要你自己确认，不能半夜自己换掉；');
  console.log('  · 真要升级：按 check 给的地址下载，解压覆盖，再跑一次 工具\\体检.mjs。');
  console.log('  · 想强制所有人升级，用「强制更新」（scripts\\mandatory-update.js），那是另一套、走弹窗提示。');
  process.exit(0);
}

console.error('用法：node 外壳\\scripts\\检查更新.mjs [state|check|config|install|--feed <url>|--auto on|off]');
process.exit(2);
