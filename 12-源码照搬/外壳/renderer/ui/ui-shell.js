/* ui-shell.js —— 工作台 UI 2.0 的壳层（2026-11-03）
 *
 * 结构（解构后的四层）：
 *   ① 顶栏     品牌 / 全局搜索 / 引擎状态 / 窗口动作
 *   ② 左栏     场景导航 + 当前场景面板 + 工具箱（可收起）
 *   ③ 语境栏   当前场景名称 / 说明 / 面板数 / 刷新
 *   ④ 工作区   #grid（原样保留）
 *
 * 关键原则：只“投影”旧 DOM，不改业务。场景切换仍点 #scenario-tabs 里的原始标签，
 * 工具仍点原来的 #btn-*，AI 面板仍由 renderers.js 渲染 ⇒ 出问题可一键回经典界面。
 */
(function () {
  'use strict';
  if (window.WB && window.WB.__shell) return;
  var WB = window.WB = window.WB || {};
  WB.__shell = true;

  var sceneList = null, panelList = null, panelEmpty = null;
  var contextName = null, contextDesc = null, contextMeta = null;
  var rail = null, morePop = null, shortcutPop = null;
  var sceneMeta = {};
  var lastSceneId = '';

  function rootDir() {
    try {
      var p = decodeURIComponent(String(location.pathname || '')).replace(/^\//, '').replace(/\//g, '\\');
      var m = p.match(/^(.*)\\外壳\\renderer\\/i);
      return m && m[1] ? m[1] : '';
    } catch (e) { return ''; }
  }

  // ⚠ 宿主能力在 window.app.app.openPath（见 ui-core.js 的 WB.host 说明）；老写法 window.app.openPath 恒 undefined。
  function openPath(p) { WB.host.openPath(p, toast); }

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

  // ---------------------------------------------------------------- 左栏
  function buildRail() {
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
      + '    <div id="wb-scene-list" class="wb-list" role="list"></div>'
      + '  </section>'
      + '  <section class="wb-sec" data-sec="panels">'
      + '    <div class="wb-sec-head"><span class="wb-sec-title">当前场景</span><span class="wb-sec-count" id="wb-panel-count"></span></div>'
      + '    <div id="wb-panel-list" class="wb-list" role="list"></div>'
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
    contextName = null;

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

  // 经典界面里留一个“回到 2.0”的入口，避免切过去之后只能手改 URL 回来
  function addClassicSwitch() {
    try {
      var controls = document.querySelector('#titlebar .titlebar-controls');
      if (!controls || document.getElementById('wb-v2-switch')) return;
      var b = document.createElement('button');
      b.type = 'button';
      b.id = 'wb-v2-switch';
      b.className = 'tb-btn';
      b.title = '切换到界面 2.0（左栏 + 命令面板）';
      b.textContent = '2.0';
      b.style.fontSize = '11px';
      b.addEventListener('click', function () { switchMode('v2'); });
      controls.insertBefore(b, document.getElementById('btn-min'));
    } catch (e) { /* ignore */ }
  }

  function toggleRail() {
    var collapsed = !document.body.classList.contains('wb-rail-collapsed');
    document.body.classList.toggle('wb-rail-collapsed', collapsed);
    WB.store.set('rail.collapsed', collapsed ? '1' : '0');
    // 聚焦中的面板需要跟着侧栏宽度重算
    try { if (WB.panels && WB.panels.current) { var p = WB.panels.current(); if (p) { WB.panels.exit(); WB.panels.focus(p); } } } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- 场景导航
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
    if (count) count.textContent = visible ? String(panels.length) : '';
    if (!visible) {
      panelEmpty.innerHTML = '';
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
  }

  // 待办角标：不再克隆 topbar-status 的节点，直接问宿主 window.topbar.pending()（preload.js:344）。
  // ⚠ 2026-11-07 修：PENDING / paintBadge / refreshBadge 必须在 **IIFE 模块作用域**——上一版塞在 buildTopbar 里，
  //   而「更多 → 待办事项」的 openPending() 在函数外调用它们 ⇒ 点击抛 ReferenceError（= 点了没反应）。
  var PENDING = { mine: 0, busy: false };
  function paintBadge() {
    var moreBtn = document.getElementById('wb-more-btn');
    if (!moreBtn) return;
    var mb = moreBtn.querySelector('.tbs-badge');   // 沿用 ui.css:185 已有的样式，不新增样式依赖
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
    contextName = document.createElement('span');
    contextName.className = 'wb-context-name';
    contextDesc = document.createElement('span');
    contextDesc.className = 'wb-context-desc';
    contextMeta = document.createElement('span');
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
      toast(PENDING.mine > 0 ? ('有 ' + PENDING.mine + ' 件等你拍板（详情见各场景记忆 §〇 卡点）') : '没有要你拍板的待办 ✓');
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
      ['2.0', '切换 2.0 / 经典界面', function () { switchMode(document.documentElement.getAttribute('data-wb-ui') === 'classic' ? 'v2' : 'classic'); }],
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

  // ---------------------------------------------------------------- 模式 / 全局键
  function switchMode(mode) {
    WB.store.set('mode', mode);
    try {
      var u = new URL(location.href);
      u.searchParams.set('ui', mode);
      location.href = u.toString();
    } catch (e) { location.reload(); }
  }

  // 主题：renderer.js 的 applyTheme() 是经典脚本里的顶层函数（挂在 window 上）
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
    if (window.__WB_UI_MODE === 'classic') { addClassicSwitch(); return; }
    var titlebar = document.getElementById('titlebar');
    if (!titlebar) return;
    buildRail();
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
      moveWebai();
      if (++tries > 20) clearInterval(late);
    }, 600);
    // ⟳ 热更新 renderers.js 时可能重建 webai-strip ⇒ 只要它回到标题栏就再搬回左栏
    try {
      var drag = document.querySelector('#titlebar .titlebar-drag');
      if (drag && window.MutationObserver) {
        new MutationObserver(function () { moveWebai(); }).observe(drag, { childList: true });
      }
    } catch (e) { /* ignore */ }

    var preset = window.__WB_SCENARIOS;
    if (Array.isArray(preset) && preset.length) {
      preset.forEach(function (s) { if (s && s.id) sceneMeta[s.id] = s; });
      renderScenes();
    } else if (window.app && window.app.listScenarios) {
      Promise.resolve(window.app.listScenarios()).then(function (list) {
        (list || []).forEach(function (s) { if (s && s.id) sceneMeta[s.id] = s; });
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
    switchMode: switchMode,
    cycleTheme: cycleTheme,
    showShortcuts: showShortcuts,
    closeShortcuts: closeShortcuts,
    refreshNav: function () { renderScenes(); renderPanels(); }
  };

  WB.ready(mount);
})();
