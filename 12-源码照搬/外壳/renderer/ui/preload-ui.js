/* preload-ui.js —— UI 版本判定（2026-11-03）
 *
 * 必须在 styles.css / ui.css 之前执行：先决定用哪套界面，再让 CSS 命中，
 * 避免页面先画一帧旧布局再跳成新布局。
 *
 * 优先级：URL ?ui=classic|v2 > localStorage wb.ui.mode > 默认 v2
 * 回退：任意时刻在「⋯ → 切换 2.0 / 经典界面」切回，或加 ?ui=classic。
 */
(function () {
  'use strict';
  var mode = 'v2';
  try {
    var q = new URLSearchParams(location.search);
    var qm = q.get('ui');
    if (qm === 'classic' || qm === 'v2') {
      mode = qm;
    } else {
      var saved = localStorage.getItem('wb.ui.mode');
      if (saved === 'classic' || saved === 'v2') mode = saved;
    }
  } catch (e) { /* 隐私模式 / 老 Chromium，用默认值 */ }
  document.documentElement.setAttribute('data-wb-ui', mode);
  window.__WB_UI_MODE = mode;
  // 场景分离窗口（?solo=1&scene=…）保持旧布局：那里只跑一个场景，左栏/命令面板没有意义
  try { window.__WB_UI_SOLO = new URLSearchParams(location.search).get('solo') ? 1 : 0; }
  catch (e) { window.__WB_UI_SOLO = 0; }
})();
