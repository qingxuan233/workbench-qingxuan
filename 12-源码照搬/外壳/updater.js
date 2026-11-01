// updater.js —— 自动更新（官方 apps/desktop 能力搬迁 ② · 2026-09-26 立）
//
// main.js 在启动时 require 本文件并 install() —— 失败只写一行日志、绝不影响使用：
//   updaterHandle = require('./updater.js').install({ log })   // 返回 { checkNow, getState, config, setConfig }
//
// 设计（刻意保守，和「强制更新」互补）：
//   · **不打补丁、不静默安装**：本模块只做"检查 + 告诉你有什么"，装不装由人决定；
//   · **源码直跑（未打包）时静默待命**：没有 app.isPackaged 就没有"更新"这回事，直接返回原因，
//     不发网络请求、不弹窗 —— 开发时不该被更新提示打断；
//   · 发布源只认 `data/updater.json` 里显式写的 `feed`（一个返回 JSON 的 URL），默认空 ⇒ 不检查；
//   · feed 的 JSON 约定：{ "version": "1.2.3", "url": "下载地址", "notes": "更新说明" }。
//
// 会话入口：node scripts\检查更新.mjs [state|check|config|--feed <url>|--auto on|off]

'use strict';
const fs = require('fs');
const path = require('path');

const APP = __dirname;
const DATA = path.join(APP, 'data');
const CFG = path.join(DATA, 'updater.json');

const DEFAULTS = { feed: '', autoCheck: true, autoInstall: false };   // autoInstall 目前只记录，不执行

function readCfg() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CFG, 'utf8')) || {}; } catch (e) { c = {}; }
  return Object.assign({}, DEFAULTS, c);
}
function writeCfg(patch) {
  const next = Object.assign(readCfg(), patch || {});
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(CFG, JSON.stringify(next, null, 1), 'utf8');
  } catch (e) { /* 写不进去就算了，不影响运行 */ }
  return next;
}
function appVersion() {
  try { return String(JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version || '0.0.0'); }
  catch (e) { return '0.0.0'; }
}
function isPackaged() {
  try { const { app } = require('electron'); return !!(app && app.isPackaged); } catch (e) { return false; }
}
function cmpVer(a, b) {
  const x = String(a).split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
  const y = String(b).split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  }
  return 0;
}

function getState() {
  const c = readCfg();
  const packaged = isPackaged();
  return {
    packaged,
    version: appVersion(),
    config: c,
    enabled: packaged && !!c.feed,
    reason: !packaged ? '源码直跑（未打包）：自动更新静默待命'
      : (!c.feed ? '没配发布源：data\\updater.json 的 feed 为空' : ''),
  };
}

/** 检查更新。**只查不装**：返回 { ok, current, latest, newer, url, notes } 或 { ok:false, reason }。 */
async function checkNow(ctx) {
  const log = (ctx && ctx.log) || function () { };
  const st = getState();
  if (!st.packaged) return { ok: false, reason: st.reason };
  if (!st.config.feed) return { ok: false, reason: st.reason };
  try {
    const r = await fetch(st.config.feed, { headers: { accept: 'application/json' } });
    if (!r.ok) return { ok: false, reason: '发布源返回 HTTP ' + r.status };
    const j = await r.json();
    const latest = String((j && j.version) || '');
    const newer = !!latest && cmpVer(latest, st.version) > 0;
    log('[updater] 检查完成：当前 ' + st.version + ' · 最新 ' + (latest || '?') + (newer ? '（有新版）' : '（已是最新）'));
    return { ok: true, current: st.version, latest, newer, url: String((j && j.url) || ''), notes: String((j && j.notes) || '') };
  } catch (e) {
    return { ok: false, reason: '检查失败：' + ((e && e.message) || e) };
  }
}

function install(ctx) {
  const log = (ctx && ctx.log) || function () { };
  const st = getState();
  log('[updater] 已挂载：' + (st.packaged ? '打包版' : '源码直跑（静默待命）') +
    ' · 自动检查 ' + (st.config.autoCheck ? '开' : '关') +
    (st.enabled ? ' · 发布源 ' + st.config.feed : ' · 未配发布源'));
  return {
    checkNow: function () { return checkNow(ctx); },
    getState: getState,
    config: readCfg,
    setConfig: writeCfg,
  };
}

module.exports = { install, checkNow, getState, readCfg, writeCfg, appVersion, isPackaged };
