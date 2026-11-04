// theme-source.js —— 外观三档（深色 / 浅色 / 跟随系统）→ nativeTheme.themeSource
//
// 为什么必须放主进程：Electron 里「prefers-color-scheme」是 Chromium 的**全局参数**，
// 只有 nativeTheme.themeSource 能改；渲染层（外壳页面）只能改自己的 html[data-theme]，
// 改不了内嵌网页（网页版 AI 的 <webview>、站点面板、DSH 引擎）。
// 表现就是：外壳切深色后，DeepSeek / 豆包 / Kimi 这些网页版还是白底。
//
// 做法：外壳的 chrome 三档原样传进来 ——
//   dark / light：钉死，所有 webContents 的 prefers-color-scheme 跟着变（实时，不用刷新）；
//   system     ：交给 Electron 自己监听操作系统，系统深浅色一变 Chromium 就广播。
// 返回解析后的实际明暗（resolved），供渲染层在「跟随系统」时立刻拿到正确值，
// 不用等 matchMedia 的 change 事件（改 themeSource 的那一刻 matchMedia 还没转过来）。
//
// 站点自身仍可覆盖：这个参数只影响 prefers-color-scheme；像豆包 / 千问会把用户偏好
// 写进 localStorage（见 renderer\theme-sync.js 的站点适配），两者互不冲突。

module.exports = function registerThemeSource(ipcMain) {
  const { nativeTheme } = require('electron');
  ipcMain.handle('theme:set-source', (e, mode) => {
    const m = (mode === 'light' || mode === 'dark' || mode === 'system') ? mode : 'system';
    try { nativeTheme.themeSource = m; } catch (ex) { /* ignore */ }
    let resolved = 'dark';
    try { resolved = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'; } catch (ex) { /* ignore */ }
    return { mode: m, resolved: resolved };
  });
};
