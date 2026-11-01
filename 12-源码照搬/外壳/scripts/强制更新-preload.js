// 强制更新-preload.js —— 版本策略提示窗的微型 preload（2026-09-26 立 · 官方能力搬迁 ④）
//
// 提示窗本身是 mandatory-update.js 里拼出来的一段内联 HTML（data: 页面，零构建），
// 页面里的按钮调 `dshPolicy.act("now" | "later" | "page")`；这里只负责把这三个动作送回主进程：
//   now   → 触发 updater.checkNow()（「立即检查更新」）
//   later → 记成 deferred，关窗（软提示才有这个按钮，hardBlock 时页面里不渲染）
//   page  → shell.openExternal(策略里的说明页)
//
// ⚠ contextIsolation=true ⇒ 必须走 contextBridge，别直接给 window 挂全局函数。
const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED = ['now', 'later', 'page'];

contextBridge.exposeInMainWorld('dshPolicy', {
  act: function (action) {
    const a = String(action || '').trim();
    if (ALLOWED.indexOf(a) < 0) return false;      // 只放行白名单动作，别让页面随便发通道
    try { ipcRenderer.send('mandatory-update:action', a); return true; } catch (e) { return false; }
  },
  // 页面自检用：能拿到就说明 preload 挂上了（按钮点了没反应时先看这个）
  version: '1',
});
