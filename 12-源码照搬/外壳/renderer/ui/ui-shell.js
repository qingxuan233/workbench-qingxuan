/* ui-shell.js —— 工作台 UI 2.0 的壳层（2026-11-03）
 *
 * 结构（解构后的四层）：
 *   ① 顶栏     品牌 / 全局搜索 / 引擎状态 / 窗口动作
 *   ② 左栏     场景导航 + 当前场景面板 + 工具箱（可收起）
 *   ③ 语境栏   当前场景名称 / 说明 / 面板数 / 刷新
 *   ④ 工作区   #grid（原样保留）
 *
 * 关键原则：只“投影”旧 DOM，不改业务。场景切换仍点 #scenario-tabs 里的原始标签，
 * 工具仍点原来的 #btn-*，AI 面板仍由 renderers.js 渲染 ⇒ 单场景窗口仍可单独开。
 */
(function () {
  'use strict';
  if (window.WB && window.WB.__shell) return;
  var WB = window.WB = window.WB || {};
  WB.__shell = true;

  // 2026-11-08 P3-2：左栏（场景/面板导航、工具箱、网页版 AI、收起展开、待办角标）已拆到 ui-rail.js，
  //   本文件只留壳层编排。下面这些薄封装是壳层内部调用点，统一转给 WB.rail（缺失时安全降级）。
  var morePop = null, shortcutPop = null;
  function rootDir() { return (WB.host && typeof WB.host.rootDir === 'function') ? WB.host.rootDir() : ''; }
  function openPath(p) { WB.host.openPath(p, toast); }
  function toggleRail() { if (WB.rail) WB.rail.toggleRail(); }
  function paintBadge() { if (WB.rail) WB.rail.paintBadge(); }
  function refreshBadge(done) { if (WB.rail) WB.rail.refreshBadge(done); else if (done) done(); }
  function renderScenes() { if (WB.rail) WB.rail.renderScenes(); }
  function renderPanels() { if (WB.rail) WB.rail.renderPanels(); }

  // ---------------------------------------------------------------- 左栏 → ui-rail.js

  // （工具箱 / 网页版 AI 挂载 / 收起展开 均已随左栏拆到 ui-rail.js）

  // ---------------------------------------------------------------- 场景导航 / 面板导航 → ui-rail.js

  // ---------------------------------------------------------------- 顶栏 / 语境栏
  function buildTopbar() {
    var titlebar = document.getElementById('titlebar');
    var controls = titlebar && titlebar.querySelector('.titlebar-controls');
    if (!titlebar || !controls) return;

    // 全局搜索入口（放在品牌与窗口动作之间）
    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.id = 'wb-cmd-trigger';
    trigger.title = '搜索场景、面板或命令（' + WB.util.shortcut('K') + '）';
    trigger.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.4" stroke="currentColor" stroke-width="1.4"/><path d="m10.4 10.4 3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'
      + '<span class="wb-cmd-trigger-text">搜索场景、面板或命令</span>'
      + '<kbd>' + WB.util.shortcut('K') + '</kbd>';
    trigger.addEventListener('click', function () { if (WB.command) WB.command.open(); });
    titlebar.insertBefore(trigger, controls);

    // 引擎状态 + 余额：从场景栏搬到顶栏
    var cluster = document.createElement('div');
    cluster.className = 'wb-status-cluster';
    ['status-dot', 'status-text', 'balance-chip'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) cluster.appendChild(el);
    });
    controls.insertBefore(cluster, controls.firstChild);

    // 刷新按钮升级为统一 15x15 矢量 SVG 旋转箭头
    var refBtn = document.getElementById('btn-refresh');
    if (refBtn && !refBtn.dataset.svgBound) {
      refBtn.dataset.svgBound = '1';
      refBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13.5 8A5.5 5.5 0 1 1 11.89 4.11L13.5 2.5v4h-4l1.64-1.64A4.1 4.1 0 1 0 12.1 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }

    // 低频动作已经搬去左栏；顶栏只留「更多」
    var more = document.createElement('button');
    more.type = 'button';
    more.className = 'tb-btn';
    more.id = 'wb-more-btn';
    more.title = '更多（界面 / 目录 / 诊断 / 快捷键）';
    more.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="3.2" cy="8" r="1.15" fill="currentColor"/><circle cx="8" cy="8" r="1.15" fill="currentColor"/><circle cx="12.8" cy="8" r="1.15" fill="currentColor"/></svg>';
    more.addEventListener('click', function (ev) { ev.stopPropagation(); toggleMore(); });
    controls.insertBefore(more, document.getElementById('btn-min'));

    paintBadge();
    refreshBadge();
  }

  function buildContextBar() {
    var bar = document.getElementById('scenebar');
    var inner = bar && bar.querySelector('.scenebar-inner');
    if (!inner) return;
    var nav = document.getElementById('scenario-tabs');
    if (nav) nav.classList.add('wb-tabs-hidden');

    var ctx = document.createElement('div');
    ctx.className = 'wb-context';
    // 2026-11-08：这三个节点加上 id，ui-rail.js 用 getElementById 更新（跨文件共享同一份 DOM，不再传模块变量）
    var contextName = document.createElement('span');
    contextName.id = 'wb-context-name';
    contextName.className = 'wb-context-name';
    var contextDesc = document.createElement('span');
    contextDesc.id = 'wb-context-desc';
    contextDesc.className = 'wb-context-desc';
    var contextMeta = document.createElement('span');
    contextMeta.id = 'wb-context-meta';
    contextMeta.className = 'wb-context-meta';
    ctx.appendChild(contextName);
    ctx.appendChild(contextDesc);
    ctx.appendChild(contextMeta);
    inner.appendChild(ctx);

    var acts = document.createElement('div');
    acts.className = 'wb-context-actions';
    var palette = document.createElement('button');
    palette.type = 'button';
    palette.className = 'wb-ctx-btn';
    palette.title = '命令面板（' + WB.util.shortcut('K') + '）';
    palette.innerHTML = '<span>⌘</span> 命令';
    palette.addEventListener('click', function () { if (WB.command) WB.command.open(); });
    var refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'wb-ctx-btn';
    refresh.title = '刷新当前场景（热更新渲染器）';
    refresh.innerHTML = '<span>⟳</span> 刷新';
    refresh.addEventListener('click', function () {
      var b = document.getElementById('btn-refresh');
      if (b) b.click();
    });
    acts.appendChild(palette);
    acts.appendChild(refresh);
    inner.appendChild(acts);
  }

  // ------ 更多菜单里的"系统与诊断"三件事：原来靠"替用户点 topbar-status 的隐藏胶囊"实现（跨模块借按钮，
  //   而那张胶囊在 V2 下被 ui.css 设成 display:none）。现在统一走 preload 的 topbar.* 通道 + 存在性判断。
  function hostTopbar() {
    return (typeof window !== 'undefined' && window.topbar) ? window.topbar : null;
  }
  function needHost(method, what) {
    var TB = hostTopbar();
    if (TB && typeof TB[method] === 'function') return TB;
    toast(what + '：这个工作台版本还没有对应接口，重启一次工作台后可用');
    return null;
  }

  // 界面与引擎回退 = 记一份当前界面快照（与 topbar-status 的「＋ 记版本」同一通道）
  function openRollback() {
    var TB = needHost('snapshot', '界面回退');
    if (!TB) return;
    Promise.resolve()
      .then(function () { return TB.snapshot(); })
      .then(function (r) {
        if (r && r.ok) toast('界面版本记好了 ✓ 回退入口在 工作台目录 → 外壳 的版本备份里');
        else toast('快照没打成：' + ((r && r.error) || '未知原因'));
      })
      .catch(function (e) { toast('快照没打成：' + ((e && e.message) || e)); });
  }

  // 系统体检：preload 的 topbar 段没有体检通道（只有 pressure/pending/snapshots/snapshot/restore/
  //   engine*/open/recentFolders），所以不猜不存在的 API，如实告诉用户怎么跑（原来点 #tbs-more 在 V2 下点不动）。
  function openHealth() {
    toast('系统体检：在「命令」场景执行 node 工具\\体检.mjs；结果会写进场景记忆，回来再点这里');
  }

  // 待办事项 = 先刷新角标，再把「要你拍板」的条数如实报出来（真实详情仍在场景记忆里）
  function openPending() {
    refreshBadge(function () {
      var n = (WB.rail && WB.rail.pendingCount) ? WB.rail.pendingCount() : 0;
      toast(n > 0 ? ('有 ' + n + ' 件等你拍板（详情见各场景记忆 §〇 卡点）') : '没有要你拍板的待办 ✓');
    });
  }

  // 统一的轻提示：壳层**自绘**一条，不依赖宿主。preload 的 topbar 段没有 toast 方法
  //   （只有主进程主动推的 topbar:toast 事件），所以这里各自画各自的，模块之间零耦合。
  var toastBox = null;
  function toast(msg) {
    try {
      if (!toastBox || !toastBox.parentNode) {
        toastBox = document.createElement('div');
        toastBox.className = 'wb-toasts';
        toastBox.setAttribute('role', 'status');
        document.body.appendChild(toastBox);
      }
      var t = document.createElement('div');
      t.className = 'wb-toast';
      t.textContent = String(msg);
      toastBox.appendChild(t);
      setTimeout(function () {
        t.style.opacity = '0';
        setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
      }, 4200);
    } catch (e) {
      try { console.log('[WB] ' + msg); } catch (_) { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------- 更多菜单
  function buildMorePop() {
    morePop = document.createElement('div');
    morePop.id = 'wb-more-pop';
    morePop.className = 'wb-pop';
    morePop.hidden = true;
    var root = rootDir();
    var items = [
      ['界面', null],
      ['◐', '切换外观（深色 / 浅色 / 跟随系统）', cycleTheme],
      ['▤', '收起 / 展开左侧栏', toggleRail],
      ['⌨', '键盘快捷键', showShortcuts],
      ['打开', null],
      ['📁', '工作台目录', function () { openPath(root); }],
      ['🧠', '场景记忆', function () { openPath(root + '\\引擎数据\\.dsh\\场景记忆'); }],
      ['⚙', '场景配置', function () { openPath(root + '\\外壳\\scenarios'); }],
      ['动作', null],
      ['⟳', '刷新当前场景', function () { var b = document.getElementById('btn-refresh'); if (b) b.click(); }],
      ['⛶', '聚焦当前面板（Ctrl Shift F）', function () {
        var view = document.getElementById('scenario-view');
        if (!view || !view.classList.contains('active')) return;
        var p = WB.dom.qs('#grid > .panel');
        if (p) WB.panels.focus(p);
      }],
      ['☰', '显示 / 隐藏面板序号徽标', function () { var b = document.getElementById('sf-badges'); if (b) b.click(); }],
      ['系统与诊断', null],
      // 2026-11-07：这 3 项原来都是「拿 topbar-status 那颗 ⋯ 胶囊的 id 去 .click()」—— 借别人的按钮开别人的弹层。
      //   可是 ui.css 在 V2 下把那颗胶囊设成 display:none，于是点下去等于点一个看不见的按钮（可见交互 bug）。
      //   现在改成直接调宿主通道（preload.js 的 topbar:*），并且每一项都做「宿主有没有这个能力」的判断，
      //   没有就如实提示，而不是静默失败。（注释里也不写那串 getElementById 调用：ui-check 扫的是原始源码，）
      //   （写得像真代码就会把检查带红，那才是真的把检查当摆设。）
      ['↩', '界面与引擎回退', openRollback],
      ['🩺', '工作台系统体检', openHealth],
      ['🔔', '待办事项（谁在等我）', openPending]
    ];
    items.forEach(function (it) {
      if (it[1] === null) {
        morePop.appendChild(WB.dom.h('div', { class: 'wb-pop-sec', text: it[0] }));
        return;
      }
      var b = WB.dom.h('button', { class: 'wb-pop-item', type: 'button' }, [
        WB.dom.h('span', { class: 'wb-pop-ico', text: it[0] }),
        WB.dom.h('span', { text: it[1] })
      ]);
      b.addEventListener('click', function () { hideMore(); it[2](); });
      morePop.appendChild(b);
    });
    var ver = WB.dom.h('div', { class: 'wb-pop-ver', text: '工作台 GUI · 正在读取版本…' });
    morePop.appendChild(ver);
    document.body.appendChild(morePop);
    if (window.app && window.app.getVersion) {
      Promise.resolve(window.app.getVersion()).then(function (v) {
        var parts = [];
        if (v && v.gui) parts.push('GUI ' + v.gui);
        if (v && v.engine) parts.push('引擎 ' + v.engine);
        if (v && v.electron) parts.push('Electron ' + v.electron);
        ver.textContent = parts.join(' · ') || '工作台 GUI';
        var rv = document.getElementById('wb-rail-version');
        if (!rv) return;
        // 2026-11-07：版本行分两行写清「DSH 内核 / 工作台 GUI」。原来只有「GUI 0.2.1-rc.3 · UI 2.0」，
        //   内核明明是 0.2.2-rc.1（dsh --version 实测）却看不到，容易被当成内核版本与展示不一致。
        //   engineProbe = 新主进程（会探测外部 CLI 内核）；老主进程没这个字段 ⇒ 保持旧的一行，避免热更新误报"未知"。
        var engine = (v && v.engine) || '';
        var gui = (v && (v.gui || v.app)) || '';
        if (v && v.engineProbe) {
          WB.dom.clear(rv);
          ['内核 ' + (engine || '未知'), 'GUI ' + (gui || '未知') + ' · UI 2.0'].forEach(function (t) {
            var d = document.createElement('div'); d.textContent = t; rv.appendChild(d);
          });
          rv.title = 'DSH 内核 ' + (engine || '未知') + ' · 工作台 GUI ' + (gui || '未知') + ' · UI 2.0';
        } else if (gui) {
          rv.textContent = 'GUI ' + gui + ' · UI 2.0';
        }
      }).catch(function () { /* ignore */ });
    }
    document.addEventListener('mousedown', function (ev) {
      if (!morePop || morePop.hidden) return;
      if (morePop.contains(ev.target)) return;
      if (ev.target.closest && ev.target.closest('#wb-more-btn')) return;
      hideMore();
    }, true);
  }

  function toggleMore() {
    if (!morePop) return;
    if (!morePop.hidden) { hideMore(); return; }
    var btn = document.getElementById('wb-more-btn');
    if (btn) {
      var r = btn.getBoundingClientRect();
      morePop.style.top = Math.round(r.bottom + 8) + 'px';
      morePop.style.right = Math.round(window.innerWidth - r.right) + 'px';
    }
    morePop.hidden = false;
  }
  function hideMore() { if (morePop) morePop.hidden = true; }

  // ---------------------------------------------------------------- 快捷键说明
  function buildShortcuts() {
    shortcutPop = WB.dom.h('div', { id: 'wb-shortcuts', class: 'wb-shortcuts', hidden: true, role: 'dialog', 'aria-label': '键盘快捷键' }, [
      WB.dom.h('div', { class: 'wb-shortcuts-card' }, [
        WB.dom.h('div', { class: 'wb-shortcuts-head' }, [
          WB.dom.h('span', { text: '键盘快捷键' }),
          WB.dom.h('button', { class: 'wb-icon-btn', type: 'button', text: '✕', onclick: closeShortcuts })
        ]),
        WB.dom.h('div', { class: 'wb-shortcuts-list' }, [
          row('命令面板', WB.util.shortcut('K')),
          row('收起 / 展开左栏', WB.util.shortcut('B')),
          row('聚焦当前面板', 'Ctrl Shift F'),
          row('切换场景', 'Alt 1 … 9'),
          row('退出聚焦 / 关闭浮层', 'Esc'),
          row('刷新场景', '点击语境栏 ⟳')
        ])
      ])
    ]);
    document.body.appendChild(shortcutPop);
    shortcutPop.addEventListener('mousedown', function (ev) { if (ev.target === shortcutPop) closeShortcuts(); });
    function row(k, v) {
      return WB.dom.h('div', { class: 'wb-shortcut-row' }, [
        WB.dom.h('span', { text: k }),
        WB.dom.h('kbd', { text: v })
      ]);
    }
  }
  function showShortcuts() { if (shortcutPop) { shortcutPop.hidden = false; } else { buildShortcuts(); shortcutPop.hidden = false; } }
  function closeShortcuts() { if (shortcutPop) shortcutPop.hidden = true; }

  // ---------------------------------------------------------------- 全局键
  // 2026-11-08：UI 1.0（经典界面）已删除 ⇒ 模式切换入口一并移除（仅保留 UI 2.0）。

  // 主题：renderer.js 的 applyTheme() 是普通脚本里的顶层函数（挂在 window 上）
  function cycleTheme() {
    var cur = 'dark';
    try { cur = localStorage.getItem('guiTheme') || 'dark'; } catch (e) { /* ignore */ }
    var next = cur === 'dark' ? 'light' : (cur === 'light' ? 'system' : 'dark');
    try { localStorage.setItem('guiTheme', next); } catch (e) { /* ignore */ }
    try { if (typeof window.applyTheme === 'function') window.applyTheme(next); } catch (e) { /* ignore */ }
    var b = document.getElementById('btn-theme');
    if (b) { try { b.textContent = next === 'light' ? '☀' : (next === 'system' ? '🖥' : '🌙'); } catch (e) { /* ignore */ } }
  }

  function bindKeys() {
    document.addEventListener('keydown', function (e) {
      if (WB.dom.isEditable(e.target)) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        toggleRail();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        var view = document.getElementById('scenario-view');
        if (!view || !view.classList.contains('active')) return;
        var hovered = WB.dom.qsa('#grid > .panel').filter(function (p) { try { return p.matches(':hover'); } catch (_) { return false; } })[0];
        var panel = hovered || WB.dom.qs('#grid > .panel');
        if (panel) WB.panels.toggle(panel);
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
        var idx = parseInt(e.key, 10) - 1;
        var tabs = WB.dom.qsa('#scenario-tabs .tab');
        if (tabs[idx]) { e.preventDefault(); tabs[idx].click(); }
      }
      if (e.key === 'Escape') {
        hideMore();
        closeShortcuts();
      }
    });
  }

  // ---------------------------------------------------------------- 观察器
  function observe() {
    var tabs = document.getElementById('scenario-tabs');
    if (tabs && window.MutationObserver) {
      var tabObs = new MutationObserver(WB.util.debounce(function () {
        renderScenes();
        renderPanels();
      }, 60));
      tabObs.observe(tabs, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-sc-id'] });
    }
    var grid = document.getElementById('grid');
    if (grid && window.MutationObserver) {
      var gridObs = new MutationObserver(WB.util.debounce(renderPanels, 60));
      gridObs.observe(grid, { childList: true, subtree: false });
    }
    // 视图切换（harness / scenario）由 renderer.js 改 .active 类，不侵入它，观察类名即可
    var refresh = WB.util.debounce(function () { renderScenes(); renderPanels(); }, 60);
    ['scenario-view', 'harness-view'].forEach(function (id) {
      var v = document.getElementById(id);
      if (v && window.MutationObserver) {
        new MutationObserver(refresh).observe(v, { attributes: true, attributeFilter: ['class'] });
      }
    });
  }

  // ---------------------------------------------------------------- 挂载
  function mount() {
    if (window.__WB_UI_SOLO) return;   // 场景分离窗口保持旧布局（单场景，不需要左栏）
    var titlebar = document.getElementById('titlebar');
    if (!titlebar) return;
    if (WB.rail) WB.rail.build();
    buildTopbar();
    buildContextBar();
    buildMorePop();
    buildShortcuts();
    bindKeys();
    observe();

    var collapsed = WB.store.getBool('rail.collapsed', false);
    document.body.classList.toggle('wb-rail-collapsed', collapsed);
    document.body.classList.add('wb-v2');
    requestAnimationFrame(function () { document.body.classList.add('wb-ui-ready'); });

    // 后插控件兜底：webai-strip 由 renderers.js 建、btn-mcp 由 mcp-panel.js 建
    var tries = 0;
    var late = setInterval(function () {
      if (WB.rail) WB.rail.moveWebai();
      if (++tries > 20) clearInterval(late);
    }, 600);
    // ⟳ 热更新 renderers.js 时可能重建 webai-strip ⇒ 只要它回到标题栏就再搬回左栏
    try {
      var drag = document.querySelector('#titlebar .titlebar-drag');
      if (drag && window.MutationObserver) {
        new MutationObserver(function () { if (WB.rail) WB.rail.moveWebai(); }).observe(drag, { childList: true });
      }
    } catch (e) { /* ignore */ }

    var preset = window.__WB_SCENARIOS;
    if (Array.isArray(preset) && preset.length) {
      if (WB.rail) WB.rail.setSceneMeta(preset);
      renderScenes();
    } else if (window.app && window.app.listScenarios) {
      Promise.resolve(window.app.listScenarios()).then(function (list) {
        if (WB.rail) WB.rail.setSceneMeta(list);
        renderScenes();
      }).catch(function () { /* ignore */ });
    }
    renderScenes();
    renderPanels();
    setTimeout(function () { renderScenes(); renderPanels(); }, 400);
    setTimeout(function () { renderScenes(); renderPanels(); }, 1500);
  }

  WB.shell = {
    toggleRail: toggleRail,
    cycleTheme: cycleTheme,
    showShortcuts: showShortcuts,
    closeShortcuts: closeShortcuts,
    toast: toast,
    refreshNav: function () { renderScenes(); renderPanels(); }
  };

  WB.ready(mount);
})();
