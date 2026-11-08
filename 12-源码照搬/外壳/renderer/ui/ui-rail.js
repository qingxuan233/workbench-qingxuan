/* ui-rail.js —— 工作台 UI 2.0 的左栏（2026-11-08 P3-2 拆预算 · 从 ui-shell.js 拆出）
 *
 * 为什么拆：ui-shell.js 原 797/800 行，再加功能就得先动预算。
 * 本文件只负责「自包含的左栏块」：场景导航 / 当前场景面板导航 / 工具箱 / 网页版 AI 挂载 / 收起展开 / 待办角标。
 * 壳层编排（顶栏、语境栏、更多菜单、快捷键、全局键、观察器、挂载顺序）仍留在 ui-shell.js。
 *
 * 共享一律走 window.WB（ui-core 提供）：
 *   WB.dom / WB.util / WB.store / WB.bus / WB.panels / WB.host / WB.shell（toast 运行时回调）
 * 对外：WB.rail = { build, buildToolbox, moveWebai, toggleRail, renderScenes, renderPanels,
 *                   setSceneMeta, refreshBadge, paintBadge, pendingCount }
 */
(function () {
  'use strict';
  if (window.WB && window.WB.__rail) return;
  var WB = window.WB = window.WB || {};
  WB.__rail = true;

  var rail = null, sceneList = null, panelList = null, panelEmpty = null;
  var sceneMeta = {};
  var lastSceneId = '';

  // 轻提示：toast 本体在 ui-shell（模块间零耦合，只在运行时借一下；没有就退化成 console）
  function toast(msg) {
    try { if (WB.shell && typeof WB.shell.toast === 'function') WB.shell.toast(msg); else console.log('[WB] ' + msg); } catch (e) { /* ignore */ }
  }
  function rootDir() {
    if (WB.host && typeof WB.host.rootDir === 'function') return WB.host.rootDir();
    try {
      var p = decodeURIComponent(String(location.pathname || '')).replace(/^\//, '').replace(/\//g, '\\');
      var m = p.match(/^(.*)\\外壳\\renderer\\/i);
      return m && m[1] ? m[1] : '';
    } catch (e) { return ''; }
  }
  function openPath(p) { WB.host.openPath(p, toast); }
  function ctx(id) { return document.getElementById(id); }

  function activeTab() { return document.querySelector('#scenario-tabs .tab.active'); }
  function tabName(tab) {
    var l = tab && tab.querySelector('.tab-label');
    return (l && l.textContent || '').trim();
  }
  function sceneId() {
    var t = activeTab();
    return t ? (t.dataset.scId || 'harness') : 'harness';
  }

  function iconOf(tab, cls) {
    var scId = tab && tab.dataset && tab.dataset.scId;
    var ico = tab && tab.querySelector('.tab-ico');
    var box = document.createElement('span');
    box.className = cls || 'wb-scene-ico';
    if (!ico) {
      if (scId && window.SCENARIO_ICONS && window.SCENARIO_ICONS[scId]) {
        box.innerHTML = window.SCENARIO_ICONS[scId];
        return box;
      }
      box.textContent = '·';
      return box;
    }
    var img = ico.querySelector('img');
    if (img) {
      var im = document.createElement('img');
      im.src = img.src; im.alt = '';
      box.appendChild(im);
      return box;
    }
    var svg = ico.querySelector('svg');
    if (svg) {
      box.appendChild(svg.cloneNode(true));
      return box;
    }
    if (scId && window.SCENARIO_ICONS && window.SCENARIO_ICONS[scId]) {
      box.innerHTML = window.SCENARIO_ICONS[scId];
      return box;
    }
    var txt = (ico.textContent || '').trim();
    box.textContent = txt || '·';
    return box;
  }

  // ---------------------------------------------------------------- 左栏骨架
  function buildRail() {
    if (rail && rail.parentNode) return;          // 幂等：重复挂载不再插第二份
    rail = document.createElement('aside');
    rail.id = 'wb-rail';
    rail.setAttribute('aria-label', '工作台导航');
    rail.innerHTML = ''
      + '<div class="wb-rail-top">'
      + '  <div class="wb-workspace"><span class="wb-workspace-dot"></span><span class="wb-workspace-name">工作台</span></div>'
      + '  <button id="wb-rail-collapse" class="wb-icon-btn" type="button" title="收起侧栏（Ctrl B）" aria-label="收起侧栏">'
      + '    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3 5 8l5 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      + '  </button>'
      + '</div>'
      + '<div class="wb-rail-scroll">'
      + '  <section class="wb-sec" data-sec="scenes">'
      + '    <div class="wb-sec-head"><span class="wb-sec-title">场景</span><span class="wb-sec-count" id="wb-scene-count"></span></div>'
      + '    <div id="wb-scene-list" class="wb-list" role="list" aria-label="场景列表"></div>'
      + '  </section>'
      + '  <section class="wb-sec" data-sec="panels">'
      + '    <div class="wb-sec-head"><span class="wb-sec-title">当前场景</span><span class="wb-sec-count" id="wb-panel-count"></span></div>'
      + '    <div id="wb-panel-list" class="wb-list" role="list" aria-label="当前场景面板"></div>'
      + '    <div id="wb-panel-empty" class="wb-empty" hidden></div>'
      + '  </section>'
      + '  <section class="wb-sec" data-sec="tools">'
      + '    <div class="wb-sec-head"><span class="wb-sec-title">工具箱</span></div>'
      + '    <div id="wb-tool-list" class="wb-tools"></div>'
      + '  </section>'
      + '  <section class="wb-sec" data-sec="webai">'
      + '    <div class="wb-sec-head"><span class="wb-sec-title">网页版 AI</span></div>'
      + '    <div id="wb-webai-host" class="wb-webai" title="网页版 AI：点一下开 / 收（登录状态各自保存）"></div>'
      + '  </section>'
      + '</div>'
      + '<div class="wb-rail-foot">'
      + '  <button id="wb-open-root" class="wb-foot-btn" type="button" title="打开工作台目录">'
      + '    <span class="wb-foot-ico">📁</span><span class="wb-foot-label">工作台目录</span>'
      + '  </button>'
      + '  <div class="wb-rail-version" id="wb-rail-version">UI 2.0</div>'
      + '</div>';
    document.body.insertBefore(rail, document.getElementById('harness-view'));

    sceneList = document.getElementById('wb-scene-list');
    panelList = document.getElementById('wb-panel-list');
    panelEmpty = document.getElementById('wb-panel-empty');

    document.getElementById('wb-rail-collapse').addEventListener('click', toggleRail);
    document.getElementById('wb-open-root').addEventListener('click', function () { openPath(rootDir()); });

    buildToolbox();
    moveWebai();
  }

  var TOOL_ICONS = {
    'btn-plugins': '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 2.6v2.2M10 2.6v2.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M3.9 4.8h8.2v2.6a4.1 4.1 0 0 1-8.2 0V4.8Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 11.5v1.9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    'btn-skills': '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="3" y="2.5" width="10" height="11" rx="1.6" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    'btn-mcp': '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="6.1" y="6.1" width="3.8" height="3.8" rx="1.1" stroke="currentColor" stroke-width="1.3"/><path d="M8 2.2v3.2M8 10.6v3.2M2.2 8h3.2M10.6 8h3.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="2.1" r="1.15" fill="currentColor"/><circle cx="8" cy="13.9" r="1.15" fill="currentColor"/><circle cx="2.1" cy="8" r="1.15" fill="currentColor"/><circle cx="13.9" cy="8" r="1.15" fill="currentColor"/></svg>',
    'btn-tools': '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M14.7 3.3a3.5 3.5 0 0 0-4.6-.4L7.8 5.2 10.8 8.2l2.3-2.3a3.5 3.5 0 0 0 .4-4.6l-1.8 1.8-1.4-1.4 1.8-1.8z" fill="currentColor"/><path d="M6.8 6.2 1.5 11.5a1.4 1.4 0 0 0 0 2l1 1a1.4 1.4 0 0 0 2 0l5.3-5.3-3-3z" fill="currentColor"/></svg>',
    'btn-models': '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="4.6" y="4.6" width="6.8" height="6.8" rx="1.4" stroke="currentColor" stroke-width="1.3"/><rect x="6.9" y="6.9" width="2.2" height="2.2" rx="0.6" stroke="currentColor" stroke-width="1.2"/><path d="M6.6 2.6v2M9.4 2.6v2M6.6 11.4v2M9.4 11.4v2M2.6 6.6h2M2.6 9.4h2M11.4 6.6h2M11.4 9.4h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'
  };

  function buildToolbox() {
    var host = document.getElementById('wb-tool-list');
    if (!host) return;

    var group = document.getElementById('tb-group-ext');
    if (group) {
      var holder = document.getElementById('wb-ext-holder');
      if (!holder) {
        holder = document.createElement('div');
        holder.id = 'wb-ext-holder';
        holder.className = 'wb-ext-holder';
        rail.appendChild(holder);
      }
      if (group.parentNode !== holder) holder.appendChild(group);
      if (!holder.__extObs && window.MutationObserver) {
        holder.__extObs = new MutationObserver(function () { setTimeout(buildToolbox, 0); });
        holder.__extObs.observe(group, { childList: true, subtree: true });
      }
    }

    var wanted = [
      ['btn-plugins', '插件'],
      ['btn-skills', '技能'],
      ['btn-mcp', 'MCP'],
      ['btn-tools', '工具'],
      ['btn-models', '模型与提供方']
    ];

    var sig = wanted.map(function (w) { return document.getElementById(w[0]) ? '1' : '0'; }).join('');
    if (host.dataset.toolSig === sig) return;
    host.dataset.toolSig = sig;

    WB.dom.clear(host);
    wanted.forEach(function (w) {
      var btn = document.getElementById(w[0]);
      if (!btn) return;
      var row = document.createElement('div');
      row.className = 'wb-tool-row';
      row.title = btn.title || w[1];
      var slot = document.createElement('span');
      slot.className = 'wb-tool-slot';
      var svg = btn.querySelector && btn.querySelector('svg');
      if (svg) {
        slot.appendChild(svg.cloneNode(true));
      } else if (TOOL_ICONS[w[0]]) {
        slot.innerHTML = TOOL_ICONS[w[0]];
      } else {
        slot.textContent = (btn.textContent || '').trim() || '•';
      }
      var label = document.createElement('span');
      label.className = 'wb-tool-label';
      label.textContent = w[1];
      row.appendChild(slot);
      row.appendChild(label);
      row.addEventListener('click', function (ev) {
        if (ev.target.closest && ev.target.closest('button') && ev.target.closest('button') === btn) return;
        try { btn.click(); } catch (e) { /* ignore */ }
      });
      host.appendChild(row);
    });
  }

  function moveWebai() {
    var strip = document.getElementById('webai-strip');
    var host = document.getElementById('wb-webai-host');
    if (!strip || !host) return;
    if (strip.parentNode !== host) host.appendChild(strip);
  }

  // 2026-11-08：UI 1.0（经典界面）已删除 ⇒ 原「回到 2.0」回切按钮 addClassicSwitch() 一并移除。

  function toggleRail() {
    var collapsed = !document.body.classList.contains('wb-rail-collapsed');
    document.body.classList.toggle('wb-rail-collapsed', collapsed);
    WB.store.set('rail.collapsed', collapsed ? '1' : '0');
    // 聚焦中的面板需要跟着侧栏宽度重算
    try { if (WB.panels && WB.panels.current) { var p = WB.panels.current(); if (p) { WB.panels.exit(); WB.panels.focus(p); } } } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- 场景导航
  function setSceneMeta(list) {
    (list || []).forEach(function (s) { if (s && s.id) sceneMeta[s.id] = s; });
  }

  function renderScenes() {
    if (!sceneList) return;
    var tabs = WB.dom.qsa('#scenario-tabs .tab');
    WB.dom.clear(sceneList);
    tabs.forEach(function (tab) {
      var id = tab.dataset.scId || '';
      var name = tabName(tab) || id || '场景';
      var active = tab.classList.contains('active');
      var working = tab.classList.contains('tab-working');
      var row = document.createElement('div');
      row.className = 'wb-scene' + (active ? ' active' : '') + (working ? ' working' : '');
      row.dataset.scId = id;
      row.setAttribute('role', 'listitem');
      row.tabIndex = 0;
      row.title = name + (working ? ' · AI 正在工作' : '');
      row.appendChild(iconOf(tab));
      var label = document.createElement('span');
      label.className = 'wb-scene-label';
      label.textContent = name;
      row.appendChild(label);
      if (working) {
        var w = document.createElement('span');
        w.className = 'wb-working-dot';
        w.title = 'AI 正在工作';
        row.appendChild(w);
      }
      if (id && id !== 'harness' && window.app && window.app.win && window.app.win.openScene) {
        var det = document.createElement('button');
        det.type = 'button';
        det.className = 'wb-scene-detach';
        det.title = '在新窗口打开这个场景';
        det.textContent = '⧉';
        det.addEventListener('click', function (ev) {
          ev.stopPropagation();
          try { window.app.win.openScene(id); } catch (e) { /* ignore */ }
        });
        row.appendChild(det);
      }
      row.addEventListener('click', function () { tab.click(); });
      row.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); tab.click(); }
      });
      row.addEventListener('contextmenu', function (ev) {
        ev.preventDefault();
        if (id && id !== 'harness') { try { window.app.win.openScene(id); } catch (e) { /* ignore */ } }
      });
      sceneList.appendChild(row);
    });
    var count = document.getElementById('wb-scene-count');
    if (count) count.textContent = String(tabs.length);

    var id = sceneId();
    var idChanged = id !== lastSceneId;
    if (idChanged) lastSceneId = id;
    var activeTabEl = document.querySelector('#scenario-tabs .tab[data-sc-id="' + id.replace(/["\\]/g, '') + '"]');
    var activeName = id === 'harness' ? 'DSH 引擎' : (tabName(activeTabEl) || id);
    var contextName = ctx('wb-context-name');
    var contextDesc = ctx('wb-context-desc');
    if (contextName) contextName.textContent = activeName;
    if (contextDesc) {
      var meta = sceneMeta[id] || {};
      contextDesc.textContent = id === 'harness'
        ? '内嵌 DeepSeek Harness 主界面 · 会话 / 工作区 / 工具'
        : (meta.description || '');
    }
    if (idChanged) WB.bus.emit('scene:changed', { id: id });
  }

  // ---------------------------------------------------------------- 面板导航
  function renderPanels() {
    if (!panelList) return;
    var panels = WB.dom.qsa('#grid > .panel');
    var id = sceneId();
    WB.dom.clear(panelList);
    var visible = id !== 'harness' && panels.length > 0;
    panelList.hidden = !visible;
    panelEmpty.hidden = visible;
    var count = document.getElementById('wb-panel-count');
    var contextMeta = ctx('wb-context-meta');
    if (count) count.textContent = visible ? String(panels.length) : '';
    if (!visible) {
      WB.dom.clear(panelEmpty);
      panelEmpty.appendChild(WB.dom.h('div', { class: 'wb-empty-t', text: id === 'harness' ? 'DSH 引擎主界面' : '这个场景还没有面板' }));
      panelEmpty.appendChild(WB.dom.h('div', { class: 'wb-empty-d', text: id === 'harness' ? '切到左侧的场景后，这里会列出可跳转的面板。' : '检查 scenarios 配置或点 ⟳ 刷新。' }));
      if (contextMeta) contextMeta.textContent = id === 'harness' ? '主界面' : '';
      return;
    }
    if (contextMeta) contextMeta.textContent = panels.length + ' 个面板';

    panels.forEach(function (panel, i) {
      var t = panel.querySelector('.panel-title');
      var s = panel.querySelector('.panel-sub');
      var title = (t && t.textContent || '面板').trim();
      var row = document.createElement('div');
      row.className = 'wb-panel-row';
      row.setAttribute('role', 'listitem');
      row.title = title;
      row.appendChild(WB.dom.h('span', { class: 'wb-panel-index', text: String(i + 1).padStart(2, '0') }));
      var mid = WB.dom.h('span', { class: 'wb-panel-mid' }, [
        WB.dom.h('span', { class: 'wb-panel-name', text: title }),
        s && (s.textContent || '').trim() ? WB.dom.h('span', { class: 'wb-panel-sub', text: (s.textContent || '').trim() }) : null
      ]);
      row.appendChild(mid);
      var focus = document.createElement('button');
      focus.type = 'button';
      focus.className = 'wb-panel-row-focus';
      focus.title = '聚焦面板';
      focus.textContent = '⛶';
      focus.addEventListener('click', function (ev) {
        ev.stopPropagation();
        WB.panels.focus(panel);
      });
      row.appendChild(focus);
      row.addEventListener('click', function () {
        try { panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* ignore */ }
        panel.classList.add('wb-panel-flash');
        setTimeout(function () { panel.classList.remove('wb-panel-flash'); }, 700);
      });
      row.addEventListener('dblclick', function () { WB.panels.focus(panel); });
      panelList.appendChild(row);
    });
    WB.panels.scan();
    WB.bus.emit('nav:panels', { count: panels.length });
  }

  // ---------------------------------------------------------------- 待办角标（⋯ 按钮上的红点）
  // 不再克隆 topbar-status 的节点，直接问宿主 window.topbar.pending()（preload.js 的 topbar 段）。
  var PENDING = { mine: 0, busy: false };
  function paintBadge() {
    var moreBtn = document.getElementById('wb-more-btn');
    if (!moreBtn) return;
    var mb = moreBtn.querySelector('.tbs-badge');   // 沿用 ui.css 已有的样式，不新增样式依赖
    if (PENDING.mine > 0) {
      if (!mb) { mb = document.createElement('span'); mb.className = 'tbs-badge'; moreBtn.appendChild(mb); }
      mb.textContent = String(PENDING.mine);
      mb.style.display = '';
    } else if (mb) { mb.style.display = 'none'; }
  }
  // 只数「要你拍板」的：与 topbar-status 的 needYou() 同口径；故意各自实现，两个模块互不依赖。
  function needYou(x) {
    var s = String((x && x.status) || '');
    return /拍板/.test(s) || /^s*(卡点|阻塞)/.test(String((x && x.text) || ''));
  }
  function refreshBadge(done) {
    var TB = window.topbar;
    if (!TB || typeof TB.pending !== 'function' || PENDING.busy) { if (done) done(); return; }   // 老宿主无此通道：跳过
    PENDING.busy = true;
    Promise.resolve().then(function () { return TB.pending(); }).then(function (r) {
      PENDING.busy = false;
      PENDING.mine = (((r && r.items) || []).filter(needYou)).length;
      paintBadge();
      if (done) done();
    }).catch(function () { PENDING.busy = false; if (done) done(); });
  }
  function pendingCount() { return PENDING.mine; }

  WB.rail = {
    build: buildRail,
    buildToolbox: buildToolbox,
    moveWebai: moveWebai,
    toggleRail: toggleRail,
    renderScenes: renderScenes,
    renderPanels: renderPanels,
    setSceneMeta: setSceneMeta,
    refreshBadge: refreshBadge,
    paintBadge: paintBadge,
    pendingCount: pendingCount
  };
})();
