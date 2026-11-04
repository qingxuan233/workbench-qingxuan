/* ui-command.js —— 全局命令面板（Ctrl/⌘ + K，2026-11-03）
 *
 * 设计目标：把「切场景 / 找面板 / 开工具 / 改界面」收进一个入口，
 * 顶栏只保留高频动作，低频动作不再各占一个图标。
 *
 * 依赖：ui-core.js（WB.bus / WB.dom / WB.util）
 * 兼容：所有动作都复用现有按钮的 click()，不复制业务逻辑。
 */
(function () {
  'use strict';
  if (window.WB && window.WB.__command) return;
  var WB = window.WB = window.WB || {};
  WB.__command = true;

  var overlay = null, input = null, listEl = null, emptyEl = null;
  var items = [], active = -1, isOpen = false;

  function click(id) {
    var el = document.getElementById(id);
    if (el) { el.click(); return true; }
    return false;
  }

  function rootDir() {
    try {
      var p = decodeURIComponent(String(location.pathname || '')).replace(/^\//, '').replace(/\//g, '\\');
      var m = p.match(/^(.*)\\外壳\\renderer\\/i);
      return m && m[1] ? m[1] : '';
    } catch (e) { return ''; }
  }

  function openPath(p) {
    try {
      if (window.app && window.app.openPath) window.app.openPath(p);
    } catch (e) { /* ignore */ }
  }

  function activeTab() {
    return document.querySelector('#scenario-tabs .tab.active');
  }

  function tabName(tab) {
    var l = tab && tab.querySelector('.tab-label');
    return (l && l.textContent || '').trim();
  }

  function iconOf(tab) {
    var scId = tab && tab.dataset && tab.dataset.scId;
    var ico = tab && tab.querySelector('.tab-ico');
    if (!ico) {
      if (scId && window.SCENARIO_ICONS && window.SCENARIO_ICONS[scId]) {
        return WB.dom.h('span', { class: 'wb-cmd-ico-svg', html: window.SCENARIO_ICONS[scId] });
      }
      return null;
    }
    var img = ico.querySelector('img');
    if (img) {
      var im = document.createElement('img');
      im.className = 'wb-cmd-ico-img';
      im.src = img.src;
      im.alt = '';
      return im;
    }
    var svg = ico.querySelector('svg');
    if (svg) {
      var box = document.createElement('span');
      box.className = 'wb-cmd-ico-svg';
      box.appendChild(svg.cloneNode(true));
      return box;
    }
    if (scId && window.SCENARIO_ICONS && window.SCENARIO_ICONS[scId]) {
      return WB.dom.h('span', { class: 'wb-cmd-ico-svg', html: window.SCENARIO_ICONS[scId] });
    }
    return WB.dom.h('span', { class: 'wb-cmd-ico-t', text: (ico.textContent || '·').trim() || '·' });
  }

  function sceneItems() {
    return WB.dom.qsa('#scenario-tabs .tab').map(function (tab) {
      var name = tabName(tab) || '场景';
      return {
        group: '场景',
        title: name,
        desc: tab.classList.contains('active') ? '当前场景' : '切换到这个场景',
        icon: iconOf(tab),
        keywords: 'scene 场景 切换 ' + name,
        run: function () { tab.click(); }
      };
    });
  }

  function panelItems() {
    // 切到 DSH 引擎页时 #grid 里还留着上一个场景的面板（只是隐藏），不能列进命令面板
    var view = document.getElementById('scenario-view');
    if (!view || !view.classList.contains('active')) return [];
    return WB.dom.qsa('#grid > .panel').map(function (panel) {
      var t = panel.querySelector('.panel-title');
      var s = panel.querySelector('.panel-sub');
      var title = (t && t.textContent || '面板').trim();
      return {
        group: '当前场景面板',
        title: title,
        desc: (s && s.textContent || '').trim() || '聚焦这个面板',
        icon: WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '▦' }),
        keywords: 'panel 面板 聚焦 ' + title,
        run: function () { WB.panels.focus(panel); }
      };
    });
  }

  function actionItems() {
    var out = [
      {
        group: '操作', title: '刷新当前场景', desc: '热更新渲染器并重建面板，不影响 AI 对话',
        icon: WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '⟳' }),
        keywords: 'refresh 刷新 重载',
        run: function () { click('btn-refresh'); }
      },
      {
        group: '操作', title: '切换外观（深色 / 浅色 / 跟随系统）', desc: '立即生效',
        icon: WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '◐' }),
        keywords: 'theme dark light 主题 外观 深色 浅色',
        run: function () { if (WB.shell) WB.shell.cycleTheme(); else click('btn-theme'); }
      },
      {
        group: '操作', title: '收起 / 展开左侧栏', desc: '快捷键 Ctrl B',
        icon: WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '▤' }),
        keywords: 'sidebar rail 侧栏 收起 展开',
        run: function () { if (WB.shell) WB.shell.toggleRail(); }
      },
      {
        group: '操作', title: '插件', desc: '查看已安装插件与数据目录',
        icon: WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '🧩' }),
        keywords: 'plugin 插件',
        run: function () { click('btn-plugins'); }
      },
      {
        group: '操作', title: '技能（Skills）', desc: '查看技能目录与格式',
        icon: WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '✦' }),
        keywords: 'skill 技能',
        run: function () { click('btn-skills'); }
      },
      {
        group: '操作', title: '工具（Tools）', desc: '47 个工具的清单与用法',
        icon: WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '🛠' }),
        keywords: 'tool 工具',
        run: function () { click('btn-tools'); }
      },
      {
        group: '操作', title: '模型与提供方', desc: 'API Key、模型选择、设置',
        icon: WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '◈' }),
        keywords: 'model 模型 提供方 key api settings',
        run: function () { click('btn-models'); }
      },
      {
        group: '操作', title: '键盘快捷键', desc: '查看全部快捷键',
        icon: WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '⌨' }),
        keywords: 'keyboard shortcut 快捷键',
        run: function () { if (WB.shell) WB.shell.showShortcuts(); }
      },
      {
        group: '操作', title: '切换到经典界面', desc: '保留旧版布局；可随时切回 2.0',
        icon: WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '↺' }),
        keywords: 'classic ui 经典 界面 回退',
        run: function () { if (WB.shell) WB.shell.switchMode('classic'); }
      }
    ];

    // 顶栏状态区的胶囊（界面回退 / 谁在等我 / 压力 / 更多 …）也进入命令面板
    WB.dom.qsa('#titlebar .tbs-pill').forEach(function (pill) {
      var txt = (pill.querySelector('.tbs-txt') || pill).textContent || '';
      txt = txt.replace(/\s+/g, ' ').trim();
      if (!txt) return;
      out.push({
        group: '操作',
        title: txt,
        desc: pill.title || '打开状态面板',
        icon: WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '◉' }),
        keywords: 'status 状态 ' + txt,
        run: function () { pill.click(); }
      });
    });

    var root = rootDir();
    if (root) {
      out.push({
        group: '打开', title: '工作台目录', desc: root,
        icon: WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '📁' }),
        keywords: 'folder 目录 路径 工作台',
        run: function () { openPath(root); }
      });
      out.push({
        group: '打开', title: '场景记忆', desc: '引擎数据\\.dsh\\场景记忆',
        icon: WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '🧠' }),
        keywords: 'memory 记忆 场景',
        run: function () { openPath(root + '\\引擎数据\\.dsh\\场景记忆'); }
      });
      out.push({
        group: '打开', title: '场景配置目录', desc: '外壳\\scenarios',
        icon: WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '⚙' }),
        keywords: 'scenario config 场景 配置',
        run: function () { openPath(root + '\\外壳\\scenarios'); }
      });
    }
    return out;
  }

  function buildItems() {
    var all = sceneItems().concat(panelItems()).concat(actionItems());
    var q = (input.value || '').trim();
    if (!q) return all;
    var scored = [];
    all.forEach(function (it) {
      var score = Math.max(
        WB.util.fuzzy(q, it.title),
        WB.util.fuzzy(q, (it.keywords || '') + ' ' + (it.desc || '')) - 2
      );
      if (score >= 0) scored.push({ it: it, score: score });
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.map(function (x) { return x.it; });
  }

  function render() {
    items = buildItems();
    WB.dom.clear(listEl);
    active = items.length ? 0 : -1;
    if (!items.length) {
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;
    var lastGroup = '';
    items.forEach(function (it, i) {
      if (it.group !== lastGroup) {
        lastGroup = it.group;
        listEl.appendChild(WB.dom.h('div', { class: 'wb-cmd-group', text: it.group }));
      }
      var btn = WB.dom.h('button', {
        class: 'wb-cmd-item' + (i === active ? ' active' : ''),
        type: 'button',
        dataset: { index: String(i) }
      }, [
        it.icon || WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '·' }),
        WB.dom.h('span', { class: 'wb-cmd-main' }, [
          WB.dom.h('span', { class: 'wb-cmd-title', text: it.title }),
          it.desc ? WB.dom.h('span', { class: 'wb-cmd-desc', text: it.desc }) : null
        ]),
        WB.dom.h('span', { class: 'wb-cmd-enter', text: '↵' })
      ]);
      btn.addEventListener('mousemove', function () { setActive(i); });
      btn.addEventListener('click', function () { run(i); });
      listEl.appendChild(btn);
    });
  }

  function setActive(i) {
    if (i === active) return;
    active = i;
    WB.dom.qsa('.wb-cmd-item', listEl).forEach(function (el, idx) {
      el.classList.toggle('active', idx === i);
    });
    var el = listEl.querySelector('.wb-cmd-item.active');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  function run(i) {
    var it = items[i];
    if (!it) return;
    close();
    setTimeout(function () {
      try { it.run(); } catch (e) { try { console.error('[WB.command]', e); } catch (_) {} }
    }, 0);
  }

  function onKey(e) {
    if (!isOpen) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); if (items.length) setActive((active + 1) % items.length); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); if (items.length) setActive((active - 1 + items.length) % items.length); return; }
    if (e.key === 'Enter') {
      if (e.isComposing) return;
      e.preventDefault();
      run(active);
    }
  }

  function open() {
    if (!overlay) return;
    isOpen = true;
    overlay.hidden = false;
    overlay.classList.add('open');
    input.value = '';
    render();
    setTimeout(function () { try { input.focus(); } catch (e) {} }, 10);
  }

  function close() {
    if (!overlay) return;
    isOpen = false;
    overlay.classList.remove('open');
    overlay.hidden = true;
  }

  function toggle() { if (isOpen) close(); else open(); }

  function build() {
    overlay = WB.dom.h('div', { id: 'wb-command', class: 'wb-command', hidden: true, role: 'dialog', 'aria-label': '命令面板' }, [
      WB.dom.h('div', { class: 'wb-command-card' }, [
        WB.dom.h('div', { class: 'wb-command-inputrow' }, [
          WB.dom.h('span', { class: 'wb-command-searchicon', html: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.4" stroke="currentColor" stroke-width="1.4"/><path d="m10.4 10.4 3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>' }),
          input = WB.dom.h('input', { class: 'wb-command-input', type: 'text', placeholder: '搜索场景、面板或命令…', spellcheck: 'false', autocomplete: 'off' }),
          WB.dom.h('kbd', { class: 'wb-command-kbd', text: 'Esc' })
        ]),
        listEl = WB.dom.h('div', { class: 'wb-command-list', role: 'listbox' }),
        emptyEl = WB.dom.h('div', { class: 'wb-command-empty', text: '没有匹配项。试试“刷新”“B站”“模型”。', hidden: true }),
        WB.dom.h('div', { class: 'wb-command-foot' }, [
          WB.dom.h('span', { text: '↑↓ 选择' }),
          WB.dom.h('span', { text: '↵ 执行' }),
          WB.dom.h('span', { text: 'Esc 关闭' })
        ])
      ])
    ]);
    document.body.appendChild(overlay);

    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    input.addEventListener('input', render);
    input.addEventListener('keydown', onKey);
    document.addEventListener('keydown', function (e) {
      var mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        toggle();
      }
    }, true);
  }

  WB.command = { open: open, close: close, toggle: toggle };

  WB.ready(function () {
    if (window.__WB_UI_MODE === 'classic') return;   // 经典界面不创建命令面板
    if (window.__WB_UI_SOLO) return;                 // 分离窗口保持旧布局
    build();
  });
})();
