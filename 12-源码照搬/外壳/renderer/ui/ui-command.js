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

  var overlay = null, input = null, listEl = null, emptyEl = null, countEl = null;
  var items = [], active = -1, isOpen = false, lastFocus = null;
  var TOOL_ITEMS = [];                  // 工具清单里的每一条（分组「工具」，按需从宿主拉取）
  var RECENT_KEY = 'cmd.recent';       // WB.store 前缀后 = localStorage wb.ui.cmd.recent
  var RECENT_MAX = 8;                  // 规范：最近使用上限 8 条（置顶分区）

  function flash(msg) {
    var box = document.getElementById('wb-cmd-flash');
    if (!box) {
      box = document.createElement('div');
      box.id = 'wb-cmd-flash';
      box.className = 'wb-cmd-flash';
      document.body.appendChild(box);
    }
    box.textContent = String(msg || '');
    box.classList.add('on');
    clearTimeout(flash._t);
    flash._t = setTimeout(function () { box.classList.remove('on'); }, 2200);
  }

  function copyText(text) {
    var ok = function () { flash('已复制：' + text + '　→ 到应用根粘贴运行'); };
    var bad = function () { flash('复制失败，命令：' + text); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(ok, bad);
        return;
      }
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      var yes = document.execCommand && document.execCommand('copy');
      document.body.removeChild(ta);
      if (yes) ok(); else bad();
    } catch (e) { bad(); }
  }

  function getRecent() {
    var raw = WB.store.get(RECENT_KEY, '');
    if (!raw) return [];
    try {
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.filter(function (x) { return typeof x === 'string'; }).slice(0, RECENT_MAX);
    } catch (e) { return []; }
  }

  function pushRecent(id) {
    if (!id) return;
    var arr = getRecent().filter(function (x) { return x !== id; });
    arr.unshift(id);
    WB.store.set(RECENT_KEY, JSON.stringify(arr.slice(0, RECENT_MAX)));
  }

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

  // ⚠ 宿主能力在 window.app.app.openPath（见 ui-core.js 的 WB.host 说明）；老写法恒 undefined ⇒ 点了没反应。
  function openPath(p) {
    WB.host.openPath(p, function (m) { try { console.warn('[WB 命令] ' + m); } catch (e) { /* ignore */ } });
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
      var scId = (tab.dataset && tab.dataset.scId) || name;
      return {
        group: '场景',
        id: 'scene:' + scId,
        title: name,
        desc: tab.classList.contains('active') ? '当前场景' : '切换到这个场景',
        icon: iconOf(tab),
        keywords: 'scene 场景 切换 ' + name + ' ' + scId,
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
      var pid = (panel.dataset && panel.dataset.panelId) || title;
      return {
        group: '当前场景面板',
        id: 'panel:' + pid,
        title: title,
        desc: (s && s.textContent || '').trim() || '聚焦这个面板',
        icon: WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '▦' }),
        keywords: 'panel 面板 聚焦 ' + title + ' ' + pid,
        run: function () { WB.panels.focus(panel); }
      };
    });
  }

  // 工具分组：从宿主的工具清单（preload.js toolsCatalog → data\工具清单.json）现拉，不写死数量。
  //   原来这里硬编码 '47 个工具'，而清单实际是 48 个，以后再加工具又会漂 ⇒ 一律以清单为准。
  //   清单里的每一条也进命令面板「工具」分组：回车 = 复制该工具的命令（到应用根粘贴运行）。
  var TOOL_COUNT = 0;          // 0 = 还没拿到
  function collectToolItems(cat) {
    var out = [];
    try {
      (cat && cat.groups || []).forEach(function (g) {
        (g && g.sections || []).forEach(function (s) {
          (s && Array.isArray(s.items) ? s.items : []).forEach(function (it) {
            var name = String((it && it.name) || '').trim();
            if (!name) return;
            var how = String((it && it.how) || '').trim();
            var plain = String((it && it.plain) || '').trim();
            out.push({
              group: '工具',
              id: 'tool:' + String((s && s.title) || '') + ':' + name,
              title: name,
              desc: how || (plain.length > 64 ? plain.slice(0, 64) + '…' : plain) || '工具清单里的工具',
              icon: WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '🛠' }),
              keywords: 'tool 工具 ' + String((it && it.tag) || '') + ' ' + String((it && it.where) || '') + ' ' +
                String((g && g.title) || '') + ' ' + String((s && s.title) || '') + ' ' + name,
              run: function () { if (how) copyText(how); else click('btn-tools'); }
            });
          });
        });
      });
    } catch (e) { return []; }
    return out;
  }
  function refreshToolCatalog() {
    // preload.js 用 contextBridge.exposeInMainWorld('app', …) 暴露，toolsCatalog 挂在这个对象上
    var T = (typeof window !== 'undefined' && window.app) ? window.app : null;
    if (!T || typeof T.toolsCatalog !== 'function') return;
    Promise.resolve().then(function () { return T.toolsCatalog(); }).then(function (cat) {
      var list = collectToolItems(cat);
      if (list.length) { TOOL_ITEMS = list; TOOL_COUNT = list.length; }
      if (isOpen) render();     // 面板正开着：拿到清单后立刻补进「工具」分组
    }).catch(function () { /* 取不到就保持中性文案 */ });
  }

  function actionItems() {
    var out = [
      {
        group: '操作', title: '刷新当前场景', desc: '热更新渲染器并重建面板，不影响 AI 对话',
        id: 'act:refresh',
        icon: WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '⟳' }),
        keywords: 'refresh 刷新 重载',
        run: function () { click('btn-refresh'); }
      },
      {
        group: '操作', title: '切换外观（深色 / 浅色 / 跟随系统）', desc: '立即生效',
        id: 'act:theme',
        icon: WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '◐' }),
        keywords: 'theme dark light 主题 外观 深色 浅色',
        run: function () { if (WB.shell) WB.shell.cycleTheme(); else click('btn-theme'); }
      },
      {
        group: '操作', title: '收起 / 展开左侧栏', desc: '快捷键 Ctrl B',
        id: 'act:rail',
        icon: WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '▤' }),
        keywords: 'sidebar rail 侧栏 收起 展开',
        run: function () { if (WB.shell) WB.shell.toggleRail(); }
      },
      {
        group: '工具', title: '插件', desc: '查看已安装插件与数据目录', id: 'act:plugins',
        icon: WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '🧩' }),
        keywords: 'plugin 插件',
        run: function () { click('btn-plugins'); }
      },
      {
        group: '工具', title: '技能（Skills）', desc: '查看技能目录与格式', id: 'act:skills',
        icon: WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '✦' }),
        keywords: 'skill 技能',
        run: function () { click('btn-skills'); }
      },
      {
        group: '工具', title: '工具清单（Tools）',
        desc: TOOL_COUNT ? (TOOL_COUNT + ' 个工具 · 每条回车=复制命令') : '工具清单与用法',
        id: 'act:tools',
        icon: WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '🛠' }),
        keywords: 'tool 工具',
        run: function () { click('btn-tools'); }
      },
      {
        group: '操作', title: '模型与凭据（填 API Key）', desc: '凭据入口 · 打开 .credentials.yaml / DSH 原生设置',
        id: 'act:credential',
        icon: WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '◈' }),
        keywords: 'model 模型 提供方 凭据 credential key api settings 密钥 设置',
        run: function () { if (WB.credential) WB.credential.open(); else click('btn-models'); }
      },
      {
        group: '操作', title: '键盘快捷键', desc: '查看全部快捷键', id: 'act:shortcuts',
        icon: WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '⌨' }),
        keywords: 'keyboard shortcut 快捷键',
        run: function () { if (WB.shell) WB.shell.showShortcuts(); }
      }
    ];

    // 顶栏状态区的胶囊（界面回退 / 谁在等我 / 压力 / 更多 …）也进入命令面板
    WB.dom.qsa('#titlebar .tbs-pill').forEach(function (pill, pi) {
      var txt = (pill.querySelector('.tbs-txt') || pill).textContent || '';
      txt = txt.replace(/\s+/g, ' ').trim();
      if (!txt) return;
      out.push({
        group: '操作',
        id: 'pill:' + (pill.id || ('p' + pi)) + ':' + txt,
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
        group: '操作', id: 'open:root', title: '工作台目录', desc: root,
        icon: WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '📁' }),
        keywords: 'folder 目录 路径 工作台',
        run: function () { openPath(root); }
      });
      out.push({
        group: '操作', id: 'open:memory', title: '场景记忆', desc: '引擎数据\\.dsh\\场景记忆',
        icon: WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '🧠' }),
        keywords: 'memory 记忆 场景',
        run: function () { openPath(root + '\\引擎数据\\.dsh\\场景记忆'); }
      });
      out.push({
        group: '操作', id: 'open:scenarios', title: '场景配置目录', desc: '外壳\\scenarios',
        icon: WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '⚙' }),
        keywords: 'scenario config 场景 配置',
        run: function () { openPath(root + '\\外壳\\scenarios'); }
      });
    }
    return out;
  }

  function allItems() {
    return sceneItems().concat(panelItems()).concat(actionItems()).concat(TOOL_ITEMS);
  }

  // 分段高亮：只对「我们自己提供的文本」做 textContent 分段 + <mark>，**绝不拼 innerHTML**
  function markSegments(text, query) {
    var s = String(text == null ? '' : text);
    var q = String(query || '').toLowerCase().replace(/\s+/g, '');
    var frag = document.createDocumentFragment();
    if (!q) { frag.appendChild(document.createTextNode(s)); return frag; }
    var qi = 0, buf = '';
    for (var i = 0; i < s.length; i++) {
      if (qi < q.length && s.charAt(i).toLowerCase() === q.charAt(qi)) {
        if (buf) { frag.appendChild(document.createTextNode(buf)); buf = ''; }
        var run = s.charAt(i);
        qi++;
        while (qi < q.length && i + 1 < s.length && s.charAt(i + 1).toLowerCase() === q.charAt(qi)) {
          run += s.charAt(++i);
          qi++;
        }
        var mk = document.createElement('mark');
        mk.className = 'wb-cmd-mark';
        mk.textContent = run;
        frag.appendChild(mk);
      } else {
        buf += s.charAt(i);
      }
    }
    if (buf) frag.appendChild(document.createTextNode(buf));
    return frag;
  }

  function recentPinned(all) {
    var byId = {};
    all.forEach(function (it) { if (it.id) byId[it.id] = it; });
    var out = [];
    getRecent().forEach(function (id) {
      var it = byId[id];
      if (!it) return;                       // 项已经不在了（场景/面板变化）⇒ 跳过，不留僵尸
      out.push({
        group: '最近使用', id: it.id, title: it.title, desc: it.desc,
        icon: it.icon, keywords: it.keywords, run: it.run, recent: true
      });
    });
    return out;
  }

  function buildItems() {
    var all = allItems();
    var q = (input.value || '').trim();
    if (!q) return recentPinned(all).concat(all);
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

  var EMPTY_SUGS = [
    { label: '刷新当前场景', id: 'act:refresh' },
    { label: '模型与凭据（填 API Key）', id: 'act:credential' },
    { label: '去「命令」场景', id: 'scene:command' }
  ];

  function showEmpty(q) {
    WB.dom.clear(emptyEl);
    emptyEl.hidden = false;
    emptyEl.appendChild(WB.dom.h('div', { class: 'wb-command-empty-t',
      text: q ? ('没有匹配「' + q + '」的命令') : '暂时没有可列出的命令' }));
    emptyEl.appendChild(WB.dom.h('div', { class: 'wb-command-empty-d',
      text: '试试下面这几个，或换关键词；Esc 关闭。' }));
    var all = allItems();
    var sugBox = WB.dom.h('div', { class: 'wb-command-empty-sugs' });
    EMPTY_SUGS.forEach(function (sug) {
      var target = null;
      all.forEach(function (it) { if (!target && it.id === sug.id) target = it; });
      if (!target) return;
      var b = WB.dom.h('button', { class: 'wb-cmd-empty-sug', type: 'button' }, [
        WB.dom.h('span', { class: 'wb-cmd-empty-sug-t', text: sug.label }),
        WB.dom.h('span', { class: 'wb-cmd-empty-sug-k', text: '↵' })
      ]);
      b.addEventListener('click', function () { runItem(target); });
      sugBox.appendChild(b);
    });
    if (sugBox.children.length) emptyEl.appendChild(sugBox);
  }

  function render() {
    items = buildItems();
    WB.dom.clear(listEl);
    active = items.length ? 0 : -1;
    var q = (input.value || '').trim();
    if (countEl) countEl.textContent = q ? (items.length + ' 项匹配') : (items.length + ' 项');
    if (input) input.setAttribute('aria-expanded', items.length ? 'true' : 'false');
    if (!items.length) {
      showEmpty(q);
      setActive(-1);
      return;
    }
    emptyEl.hidden = true;
    var lastGroup = '';
    items.forEach(function (it, i) {
      if (it.group !== lastGroup) {
        lastGroup = it.group;
        listEl.appendChild(WB.dom.h('div', { class: 'wb-cmd-group', text: it.group }));
      }
      var titleEl = WB.dom.h('span', { class: 'wb-cmd-title' });
      if (q) titleEl.appendChild(markSegments(it.title, q));
      else titleEl.textContent = it.title;
      var btn = WB.dom.h('button', {
        class: 'wb-cmd-item' + (i === active ? ' active' : ''),
        type: 'button',
        id: 'wb-cmd-item-' + i,
        role: 'option',
        'aria-selected': i === active ? 'true' : 'false',
        dataset: { index: String(i) }
      }, [
        it.icon || WB.dom.h('span', { class: 'wb-cmd-ico-t', text: '·' }),
        WB.dom.h('span', { class: 'wb-cmd-main' }, [
          titleEl,
          it.desc ? WB.dom.h('span', { class: 'wb-cmd-desc', text: it.desc }) : null
        ]),
        WB.dom.h('span', { class: 'wb-cmd-enter', text: '↵' })
      ]);
      btn.addEventListener('mousemove', function () { setActive(i); });
      btn.addEventListener('click', function () { run(i); });
      listEl.appendChild(btn);
    });
    setActive(0);
  }

  function setActive(i) {
    if (i === active) { syncAria(); return; }
    active = i;
    WB.dom.qsa('.wb-cmd-item', listEl).forEach(function (el, idx) {
      el.classList.toggle('active', idx === i);
      if (el.setAttribute) el.setAttribute('aria-selected', idx === i ? 'true' : 'false');
    });
    syncAria();
    var el = listEl.querySelector('.wb-cmd-item.active');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  function syncAria() {
    if (!input) return;
    if (active >= 0 && items.length) input.setAttribute('aria-activedescendant', 'wb-cmd-item-' + active);
    else input.removeAttribute('aria-activedescendant');
  }

  function runItem(it) {
    if (!it) return;
    pushRecent(it.id);               // 最近使用：执行过才记（最多 RECENT_MAX 条，置顶分区用）
    close();
    setTimeout(function () {
      try { it.run(); } catch (e) { try { console.error('[WB.command]', e); } catch (_) {} }
    }, 0);
  }

  function run(i) {
    runItem(items[i]);
  }

  function onKey(e) {
    if (!isOpen) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); if (items.length) setActive((active + 1) % items.length); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); if (items.length) setActive((active - 1 + items.length) % items.length); return; }
    if (e.key === 'Home') { e.preventDefault(); if (items.length) setActive(0); return; }
    if (e.key === 'End') { e.preventDefault(); if (items.length) setActive(items.length - 1); return; }
    if (e.key === 'Enter') {
      if (e.isComposing) return;
      e.preventDefault();
      run(active);
    }
  }

  function open() {
    if (!overlay) return;
    lastFocus = (document.activeElement && document.activeElement !== document.body) ? document.activeElement : null;
    isOpen = true;
    overlay.hidden = false;
    overlay.classList.add('open');
    input.value = '';
    if (input) input.setAttribute('aria-expanded', 'true');
    refreshToolCatalog();   // 每次打开顺手对一次工具清单（异步；拿到了下一帧 render 就会补进来）
    if (!TOOL_ITEMS.length && window.app && typeof window.app.toolsCatalog === 'function' && WB.skeleton) {
      // 2026-11-08 P3-2：工具清单还在路上（首次打开常见）⇒ 先给骨架占位。
      // refreshToolCatalog 成功后会自己 render；700ms 兜底防止清单接口异常时永远停在骨架。
      WB.skeleton(listEl, 4);
      emptyEl.hidden = true;
      if (countEl) countEl.textContent = '加载中…';
      setTimeout(function () { if (isOpen) render(); }, 700);
    } else {
      render();
    }
    setTimeout(function () { try { input.focus(); } catch (e) { /* ignore */ } }, 10);
  }

  function close() {
    if (!overlay) return;
    isOpen = false;
    overlay.classList.remove('open');
    overlay.hidden = true;
    if (input) input.setAttribute('aria-expanded', 'false');
    // 关闭后焦点回到打开前的那个元素（Raycast/VS Code 同款；否则焦点掉到 body、键盘续操作断掉）
    var el = lastFocus;
    lastFocus = null;
    if (el && el.isConnected) {
      setTimeout(function () {
        try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (_) { /* ignore */ } }
      }, 0);
    }
  }

  function toggle() { if (isOpen) close(); else open(); }

  function build() {
    overlay = WB.dom.h('div', { id: 'wb-command', class: 'wb-command', hidden: true, role: 'dialog', 'aria-label': '命令面板' }, [
      WB.dom.h('div', { class: 'wb-command-card' }, [
        WB.dom.h('div', { class: 'wb-command-inputrow' }, [
          WB.dom.h('span', { class: 'wb-command-searchicon', html: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.4" stroke="currentColor" stroke-width="1.4"/><path d="m10.4 10.4 3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>' }),
          input = WB.dom.h('input', {
            class: 'wb-command-input', type: 'text', placeholder: '搜索场景、面板、命令或工具…',
            spellcheck: 'false', autocomplete: 'off',
            role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'true',
            'aria-controls': 'wb-cmd-list', 'aria-label': '搜索场景、面板、命令或工具'
          }),
          WB.dom.h('kbd', { class: 'wb-command-kbd', text: 'Esc' })
        ]),
        listEl = WB.dom.h('div', { id: 'wb-cmd-list', class: 'wb-command-list', role: 'listbox', 'aria-label': '命令列表' }),
        emptyEl = WB.dom.h('div', { class: 'wb-command-empty', hidden: true }),
        WB.dom.h('div', { class: 'wb-command-foot' }, [
          WB.dom.h('span', { text: '↑↓ 选择' }),
          WB.dom.h('span', { text: '↵ 执行' }),
          WB.dom.h('span', { text: 'Esc 关闭' }),
          countEl = WB.dom.h('span', { class: 'wb-command-count', text: '' })
        ])
      ])
    ]);
    document.body.appendChild(overlay);

    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    input.addEventListener('input', render);
    input.addEventListener('keydown', onKey);
    // Esc 兜底：焦点万一不在输入框（Tab 走到列表/用户点了别处），键盘也还能关面板
    document.addEventListener('keydown', function (e) {
      if (!isOpen || e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    }, true);
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
    if (window.__WB_UI_SOLO) return;                 // 分离窗口保持旧布局
    build();
    refreshToolCatalog();   // 首屏就把工具清单取回来，别等第一次打开
  });
})();
