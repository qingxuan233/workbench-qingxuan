/* preload-ui.js —— UI 2.0 判定（2026-11-03；2026-11-08 起仅保留 UI 2.0，经典界面已删除）
 *
 * 必须在 styles.css / ui.css 之前执行：先给根元素打上 v2 标记，再让 CSS 命中，
 * 避免页面先画一帧无样式布局再跳成新布局。
 *
 * 现在**无条件** v2：html[data-wb-ui="v2"]（ui.css / ui-theme.css 的作用域）+
 * body.wb-v2（由 ui-shell.js mount 时加）。没有 URL 参数 / localStorage 分支，也不需要切换入口。
 */
(function () {
  'use strict';
  document.documentElement.setAttribute('data-wb-ui', 'v2');
  // 场景分离窗口（?solo=1&scene=…）保持旧布局：那里只跑一个场景，左栏/命令面板没有意义
  try { window.__WB_UI_SOLO = new URLSearchParams(location.search).get('solo') ? 1 : 0; }
  catch (e) { window.__WB_UI_SOLO = 0; }
})();
