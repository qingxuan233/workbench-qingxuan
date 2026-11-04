/* ui-panels.js —— 面板聚焦（伪全屏）+ 面板级操作注入（2026-11-03）
 *
 * 解决的问题：
 *   1) 旧界面只有 AI 面板有「▲ 展开到最高」，普通面板（文件树、预览、磁盘）没有聚焦手段；
 *   2) 面板一多，标题栏里的操作散落，缺少统一入口。
 *
 * 做法（不侵入 renderers.js）：
 *   - 监听面板渲染（scene:rendered 事件 + MutationObserver 兜底）；
 *   - 给每个 .panel-head 追加一个「⛶ 聚焦」按钮；
 *   - 聚焦 = 在网格原位插占位格（其余面板不回流）+ position:fixed 撑满工作区；
 *   - Esc / 点击遮罩 / 切场景退出。
 */
(function () {
  'use strict';
  if (window.WB && window.WB.__panels) return;
  var WB = window.WB = window.WB || {};
  WB.__panels = true;

  var FOCUS_BTN_CLASS = 'wb-panel-focus';
  var focused = null;          // { panel, slot, backdrop, saved, onKey, onResize }

  function panelTitle(panel) {
    var t = panel && panel.querySelector('.panel-title');
    return (t && (t.textContent || '').trim()) || '面板';
  }

  function saveStyle(panel) {
    return {
      position: panel.style.position,
      left: panel.style.left,
      top: panel.style.top,
      right: panel.style.right,
      bottom: panel.style.bottom,
      width: panel.style.width,
      height: panel.style.height,
      zIndex: panel.style.zIndex,
      margin: panel.style.margin,
      boxSizing: panel.style.boxSizing
    };
  }

  function restoreStyle(panel, s) {
    if (!panel || !s) return;
    Object.keys(s).forEach(function (k) { panel.style[k] = s[k]; });
  }

  function geometry() {
    var cb = document.getElementById('scenebar');
    var rail = document.getElementById('wb-rail');
    var top = cb ? cb.getBoundingClientRect().bottom : 90;
    var left = (rail && !document.body.classList.contains('wb-rail-collapsed'))
      ? rail.getBoundingClientRect().right : (rail ? rail.getBoundingClientRect().right : 0);
    // 侧栏收起时 rail 仍然占 64px，所以 right 永远是正确起点
    var gap = 10;
    return {
      left: Math.round(left + gap),
      top: Math.round(top + gap),
      width: Math.max(320, Math.round(window.innerWidth - left - gap * 2)),
      height: Math.max(240, Math.round(window.innerHeight - top - gap * 2))
    };
  }

  function place() {
    if (!focused || !focused.panel || !focused.panel.isConnected) return;
    var g = geometry();
    var p = focused.panel;
    p.style.left = g.left + 'px';
    p.style.top = g.top + 'px';
    p.style.width = g.width + 'px';
    p.style.height = g.height + 'px';
  }

  function exit() {
    if (!focused) return;
    var f = focused;
    focused = null;
    try { document.removeEventListener('keydown', f.onKey, true); } catch (e) { /* ignore */ }
    try { window.removeEventListener('resize', f.onResize); } catch (e) { /* ignore */ }
    if (f.panel) {
      f.panel.classList.remove('wb-panel-focused');
      restoreStyle(f.panel, f.saved);
    }
    if (f.slot && f.slot.parentNode) f.slot.parentNode.removeChild(f.slot);
    if (f.backdrop && f.backdrop.parentNode) f.backdrop.parentNode.removeChild(f.backdrop);
    document.body.classList.remove('wb-focus-mode');
  }

  function focus(panel) {
    if (!panel || !panel.isConnected) return false;
    if (focused && focused.panel === panel) return true;
    exit();

    // 与旧「▲ 展开」互斥：先收起旧的展开态，避免两个 fixed 定位打架
    if (panel.classList.contains('panel-expanded') && typeof window.collapsePanel === 'function') {
      try { window.collapsePanel(panel); } catch (e) { /* ignore */ }
    }

    var grid = document.getElementById('grid');
    if (!grid || !grid.contains(panel)) return false;

    var slot = document.createElement('div');
    slot.className = 'panel-slot wb-focus-slot';
    slot.style.gridColumn = panel.style.gridColumn;
    slot.style.gridRow = panel.style.gridRow;
    panel.parentNode.insertBefore(slot, panel);

    var backdrop = document.createElement('div');
    backdrop.className = 'wb-focus-backdrop';
    backdrop.addEventListener('mousedown', function (ev) {
      if (ev.target === backdrop) exit();
    });
    document.body.appendChild(backdrop);

    var saved = saveStyle(panel);
    panel.classList.add('wb-panel-focused');
    panel.style.position = 'fixed';
    panel.style.zIndex = '9990';
    panel.style.margin = '0';
    panel.style.boxSizing = 'border-box';

    var onKey = function (ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); exit(); }
    };
    var onResize = function () { place(); };

    focused = { panel: panel, slot: slot, backdrop: backdrop, saved: saved, onKey: onKey, onResize: onResize };
    place();
    document.body.classList.add('wb-focus-mode');
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    return true;
  }

  function toggle(panel) {
    if (focused && focused.panel === panel) { exit(); return true; }
    return focus(panel);
  }

  function injectButton(panel) {
    if (!panel || panel.querySelector('.' + FOCUS_BTN_CLASS)) return;
    var head = panel.querySelector('.panel-head');
    if (!head) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = FOCUS_BTN_CLASS;
    btn.title = '聚焦这个面板（Esc 退出）';
    btn.setAttribute('aria-label', '聚焦面板');
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
      + '<path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      toggle(panel);
    });
    head.appendChild(btn);
  }

  function scan() {
    if (window.__WB_UI_MODE === 'classic') return;
    if (window.__WB_UI_SOLO) return;
    WB.dom.qsa('#grid > .panel').forEach(injectButton);
  }

  function current() { return focused ? focused.panel : null; }

  WB.panels = { focus: focus, exit: exit, toggle: toggle, scan: scan, current: current };

  // 面板渲染完成后注入按钮；MutationObserver 兜住所有非标准渲染路径
  WB.ready(function () {
    if (window.__WB_UI_MODE === 'classic') return;   // 经典界面不注入任何按钮/监听
    if (window.__WB_UI_SOLO) return;                 // 分离窗口保持旧布局
    WB.bus.on('scene:changed', function () { exit(); setTimeout(scan, 0); });
    var grid = document.getElementById('grid');
    if (grid && window.MutationObserver) {
      var scanSoon = WB.util.debounce(scan, 40);
      var mo = new MutationObserver(function () {
        // 同场景点 ⟳ 会重建面板：聚焦中的节点被删掉时立刻退出，别留一层黑遮罩
        if (focused && focused.panel && !focused.panel.isConnected) exit();
        scanSoon();
      });
      mo.observe(grid, { childList: true, subtree: false });
    }
  });
})();
