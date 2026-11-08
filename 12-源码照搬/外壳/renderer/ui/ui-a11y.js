/* ui-a11y.js —— 共用弹窗（#modal-mask）的键盘可达性 + 焦点回归（2026-11-08 · GUI 优化 P0-4）
 *
 * 现状问题（静态走查 + 实跑）：
 *   · renderer.js 的 openModal()/closeModal() 只负责 display:flex/none：**没有 Esc 关闭**、
 *     没有"关闭后焦点回到原来那个按钮"，也没有 role/aria-modal；所有弹窗（插件 / 技能 / 工具 /
 *     模型 / 设置 / 本模块的凭据面板）共用同一个 #modal-mask ⇒ 一次修全；
 *   · showSettings() 给 .modal 加 .set-modal（宽 1120）却从不移除 ⇒ 开过一次「设置」后，
 *     之后任何普通弹窗都会保持加宽态。这里在"弹窗变可见"时按 body 的 set-modal-body 判定并复位；
 *   · 焦点环由 styles.css 的全局 :focus-visible + ui.css 的 body.wb-v2 规则负责，本模块不重复造样式。
 *
 * 对外（给 ui-credential.js / ui-empty.js / 以后任何模块用）：
 *   WB.dialog.open(title, builder, opts)   打开共用弹窗（builder(body)，同步执行）
 *   WB.dialog.close()                      关闭并归还焦点
 *   WB.dialog.isOpen()
 *
 * 约束：不改 renderer.js（行数预算只剩 5 行）；不引入依赖；只在 #modal-mask 上做增量。
 */
(function () {
  'use strict';
  var WB = window.WB = window.WB || {};
  if (WB.__a11y) return;
  WB.__a11y = true;

  var mask = null, modal = null, titleEl = null, bodyEl = null;
  var lastFocus = null;        // 打开前焦点落在哪个元素上（关闭后要还回去）
  var wasOpen = false;         // 上一次观察到的可见状态（hidden → visible 边沿）

  function refs() {
    if (mask && mask.isConnected) return true;
    mask = document.getElementById('modal-mask');
    modal = mask ? mask.querySelector('.modal') : null;
    titleEl = document.getElementById('modal-title');
    bodyEl = document.getElementById('modal-body');
    return !!(mask && modal && titleEl && bodyEl);
  }

  function visible() {
    // renderer.js 的显示/隐藏判据就是 .style.display（flex / none）；初始 HTML 里也是 none
    return !!(mask && mask.style.display && mask.style.display !== 'none');
  }

  function focusables() {
    if (!modal) return [];
    var nodes = modal.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]),' +
      ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    return Array.prototype.slice.call(nodes).filter(function (el) {
      if (!el || el.getClientRects().length === 0) return false;
      var tag = (el.tagName || '').toLowerCase();
      return tag !== 'webview' && !el.hasAttribute('hidden');
    });
  }

  function focusModal() {
    if (!refs()) return;
    if (document.activeElement && modal.contains(document.activeElement)) return;
    var closeBtn = modal.querySelector('.modal-close');
    var el = closeBtn && closeBtn.getClientRects().length ? closeBtn : (focusables()[0] || null);
    if (!el) { try { modal.focus(); } catch (e) { /* ignore */ } return; }
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (_) { /* ignore */ } }
  }

  function restoreFocus() {
    var el = lastFocus;
    lastFocus = null;
    if (!el || !el.isConnected) return;
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (_) { /* ignore */ } }
  }

  function open(title, builder, opts) {
    if (!refs()) return false;
    var o = opts || {};
    lastFocus = (document.activeElement && document.activeElement !== document.body) ? document.activeElement : null;

    // 复位：renderer.js 的 openModal 只重置 #modal-body 的 class，不重置 .modal 上的 set-modal
    bodyEl.className = 'modal-body';
    bodyEl.scrollTop = 0;
    bodyEl.innerHTML = '';
    modal.className = 'modal';
    titleEl.textContent = String(title == null ? '' : title);

    // 通用无障碍属性（有了才设，避免每次重写）
    if (!modal.hasAttribute('role')) modal.setAttribute('role', 'dialog');
    if (!modal.hasAttribute('aria-modal')) modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', String(title == null ? '' : title));
    if (!o.noFocusRing) modal.setAttribute('data-wb-dialog', '1');

    try { builder(bodyEl); } catch (e) {
      bodyEl.appendChild(textLine('内容加载失败：' + ((e && e.message) || e)));
    }
    mask.style.display = 'flex';
    wasOpen = true;
    focusModal();
    return true;
  }

  function close() {
    if (!refs()) return;
    if (typeof window.closeModal === 'function') {
      try { window.closeModal(); } catch (e) { mask.style.display = 'none'; }
    } else {
      mask.style.display = 'none';
    }
    wasOpen = false;
    // 焦点回归放到下一帧：closeModal 后有些调用方还会重建 DOM
    setTimeout(restoreFocus, 0);
  }

  function isOpen() { return refs() && visible(); }

  function textLine(t) {
    var d = document.createElement('div');
    d.className = 'stat-sub';
    d.textContent = t;
    return d;
  }

  // ---------- 监听：可见性边沿（focus 回归 / set-modal 残留复位） ----------
  function onMaskChange() {
    if (!refs()) return;
    var now = visible();
    if (now && !wasOpen) {
      wasOpen = true;
      if (!lastFocus) lastFocus = (document.activeElement && document.activeElement !== document.body) ? document.activeElement : null;
      // 「设置」弹窗自己会同时给 body 加 set-modal-body；没加 = 普通弹窗 ⇒ 把加宽类撤掉
      if (modal.classList.contains('set-modal') && !bodyEl.classList.contains('set-modal-body')) {
        modal.classList.remove('set-modal');
      }
      focusModal();
    } else if (!now && wasOpen) {
      wasOpen = false;
      setTimeout(restoreFocus, 0);
    }
  }

  function onKey(e) {
    if (!isOpen()) return;
    if (e.key === 'Escape') {
      // 命令面板自己也监听 Esc；弹窗开着时 Esc 只该关弹窗
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'Tab') {
      // 焦点圈在弹窗内：Tab 到最后一个后回到第一个，Shift+Tab 反向
      var list = focusables();
      if (!list.length) return;
      var first = list[0], last = list[list.length - 1];
      var cur = document.activeElement;
      if (e.shiftKey) {
        if (cur === first || !modal.contains(cur)) { e.preventDefault(); last.focus(); }
      } else if (cur === last || !modal.contains(cur)) {
        e.preventDefault(); first.focus();
      }
    }
  }

  WB.ready(function () {
    if (!refs()) return;
    // 初始隐藏也补一次无障碍属性
    if (!modal.hasAttribute('role')) modal.setAttribute('role', 'dialog');
    if (!modal.hasAttribute('aria-modal')) modal.setAttribute('aria-modal', 'true');
    var closeBtn = modal.querySelector('.modal-close');
    if (closeBtn && !closeBtn.getAttribute('aria-label')) closeBtn.setAttribute('aria-label', '关闭弹窗');
    if (window.MutationObserver) {
      new MutationObserver(onMaskChange).observe(mask, { attributes: true, attributeFilter: ['style', 'class'] });
    } else {
      setInterval(onMaskChange, 1000);   // 老 Chromium：退化成轮询（只在弹窗开合时改变状态）
    }
    document.addEventListener('keydown', onKey, true);
  });

  // ---------- roving tabindex：左栏「场景 / 当前场景面板」列表（2026-11-08 P3-2） ----------
  // 目标：Tab 进列表一次；↑↓ / Home / End 移动焦点；Enter / Space 打开当前行（复用行的 click）；
  //   重渲染（ui-rail 清空列表）后把 tabindex 与"最后聚焦项"恢复回去。
  // 只在 UI 2.0 生效（左栏由 ui-rail.js 渲染；经典界面不注入任何行为）。
  var ROVING_SEL = '#wb-scene-list, #wb-panel-list';
  var ROV = { list: null, index: 0 };
  function rovingItems(list) {
    return Array.prototype.slice.call(list.querySelectorAll('[role="listitem"]'));
  }
  function applyRoving() {
    if (window.__WB_UI_MODE === 'classic' || window.__WB_UI_SOLO) return 0;
    var n = 0;
    WB.dom.qsa(ROVING_SEL).forEach(function (list) {
      var items = rovingItems(list);
      if (!items.length) return;
      n++;
      list.setAttribute('data-wb-roving', '1');
      items.forEach(function (it, i) {
        var want = (ROV.list === list && ROV.index === i) ? 0 : (i === 0 ? 0 : -1);
        it.tabIndex = want;
      });
    });
    return n;
  }
  function onRovingKey(e) {
    var list = e.target && e.target.closest ? e.target.closest('[data-wb-roving]') : null;
    if (!list) return;
    var items = rovingItems(list);
    var cur = -1;
    for (var i = 0; i < items.length; i++) if (items[i] === document.activeElement) { cur = i; break; }
    if (cur < 0) cur = 0;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();          // 行自己也有 Enter 监听 ⇒ 只走这一条，避免双触发
      if (items[cur]) items[cur].click();
      return;
    }
    var next = -1;
    if (e.key === 'ArrowDown') next = Math.min(items.length - 1, cur + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, cur - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else return;
    if (next < 0 || !items[next]) return;
    e.preventDefault();
    ROV = { list: list, index: next };
    items.forEach(function (it, idx) { it.tabIndex = idx === next ? 0 : -1; });
    try { items[next].focus({ preventScroll: true }); } catch (err) { try { items[next].focus(); } catch (_) { /* ignore */ } }
  }
  function watchRoving() {
    if (window.__WB_UI_MODE === 'classic' || window.__WB_UI_SOLO) return;
    applyRoving();
    if (window.__wbRovingBound) return;        // 监听器只装一次；之后靠观察器/applyRoving 跟上重渲染
    window.__wbRovingBound = 1;
    document.addEventListener('keydown', onRovingKey, true);
    document.addEventListener('focusin', function (e) {
      var list = e.target && e.target.closest ? e.target.closest('[data-wb-roving]') : null;
      if (!list) return;
      var items = rovingItems(list);
      for (var i = 0; i < items.length; i++) if (items[i] === e.target) { ROV = { list: list, index: i }; break; }
    });
    var rail = document.getElementById('wb-rail');
    if (rail && window.MutationObserver) {
      var late = 0;
      new MutationObserver(function () {
        clearTimeout(late);
        late = setTimeout(function () {
          var hadFocusInRail = document.activeElement === document.body && ROV.list && ROV.list.isConnected;
          applyRoving();
          // 列表被 ui-rail 重绘后焦点会掉到 body：还给同索引项（best-effort）
          if (hadFocusInRail && ROV.list) {
            var items = rovingItems(ROV.list);
            var it = items[Math.min(ROV.index, items.length - 1)];
            if (it) { try { it.focus({ preventScroll: true }); } catch (err) { /* ignore */ } }
          }
        }, 60);
      }).observe(rail, { childList: true, subtree: true });
    }
    try { if (WB.bus) { WB.bus.on('scene:changed', function () { setTimeout(applyRoving, 0); }); WB.bus.on('nav:panels', function () { setTimeout(applyRoving, 0); }); } } catch (e) { /* ignore */ }
  }

  WB.ready(function () {
    if (window.__WB_UI_MODE === 'classic' || window.__WB_UI_SOLO) return;
    setTimeout(watchRoving, 0);
    setTimeout(watchRoving, 800);   // 左栏是异步渲染（webai-strip / 面板列表晚到）：再补一次
  });

  WB.a11y = { roving: applyRoving, rovingCount: function () { return WB.dom.qsa(ROVING_SEL).length; } };

  WB.dialog = { open: open, close: close, isOpen: isOpen };
})();
