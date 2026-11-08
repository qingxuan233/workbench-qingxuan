/* ui-empty.js —— 空状态与引导（2026-11-08 · GUI 优化 P0-3）
 *
 * 三类用户最容易"卡住以为坏了"的空状态，统一加一条**可操作**的引导：
 *   ① AI 面板会话状态：`○ 未绑定 · 面板自由选会话` / `未切到 · …` / `⚠ 存储已指向 · 画面未切`
 *      —— 标题行状态小字旁边补一枚「说明 / 修复」chip，点开是分步做法（不覆盖状态小字本身）；
 *   ② 本地电脑场景：pc 面板"还没扫过"——补一行**可直接复制**的 `node 外壳\scripts\pc-scan.mjs` 和刷新提示；
 *   ③ 网页AI 场景：左侧 `view` 预览面板默认是空的（原来显示的是流程画布的通用文案，对 webai 场景是误导）
 *      —— 补"产物怎么来、路径往哪粘"的引导 + 打开场景记忆的按钮。
 *
 * 约束：只往**外壳自己渲染的 DOM**里追加节点（.view-empty / .pc-hint 外层 / 面板标题行），
 *   不碰 DSH 内嵌面板内部；所有节点带 `.wb-guide` / `.wb-hint-chip` 标记，重复扫描幂等。
 * 依赖：ui-core.js（WB.ready / WB.host / WB.dom）、ui-a11y.js（WB.dialog）。
 */
(function () {
  'use strict';
  var WB = window.WB = window.WB || {};
  if (WB.__empty) return;
  WB.__empty = true;

  var GUIDE_CLASS = 'wb-guide';
  var CHIP_CLASS = 'wb-hint-chip';
  var PC_CMD = 'node 外壳\\scripts\\pc-scan.mjs';
  var scanning = false;

  function rootDir() {
    try {
      var p = decodeURIComponent(String(location.pathname || '')).replace(/^\//, '').replace(/\//g, '\\');
      var m = p.match(/^(.*)\\外壳\\renderer\\/i);
      return m && m[1] ? m[1] : '';
    } catch (e) { return ''; }
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function openPath(p) {
    if (WB.host && WB.host.openPath) WB.host.openPath(p, function (m) { flash(m); });
    else flash('这个工作台版本还没有打开目录的接口，重启一次后可用');
  }

  function flash(msg) {
    var box = document.getElementById('wb-empty-flash');
    if (!box) {
      box = el('div', 'wb-empty-flash');
      box.id = 'wb-empty-flash';
      document.body.appendChild(box);
    }
    box.textContent = String(msg || '');
    box.classList.add('on');
    clearTimeout(flash._t);
    flash._t = setTimeout(function () { box.classList.remove('on'); }, 2400);
  }

  function copyText(text) {
    var ok = function () { flash('已复制：' + text); };
    var bad = function () { flash('复制失败，请手动选中：' + text); };
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

  // ---------------- 通用：一个引导块 ----------------
  function guideBlock(opts) {
    var box = el('div', 'wb-guide');
    box.setAttribute('role', 'note');
    if (opts.title) box.appendChild(el('div', 'wb-guide-title', opts.title));
    (opts.lines || []).forEach(function (t) {
      var d = el('div', 'wb-guide-line', t);
      box.appendChild(d);
    });
    if (opts.cmd) {
      var row = el('div', 'wb-guide-cmdrow');
      var code = el('code', 'wb-guide-code', opts.cmd);
      row.appendChild(code);
      var cp = el('button', 'file-refresh wb-guide-btn', '复制命令');
      cp.type = 'button';
      cp.addEventListener('click', function () { copyText(opts.cmd); });
      row.appendChild(cp);
      box.appendChild(row);
    }
    if (opts.actions && opts.actions.length) {
      var acts = el('div', 'wb-guide-acts');
      opts.actions.forEach(function (a) {
        var b = el('button', 'file-refresh wb-guide-btn', a.label);
        b.type = 'button';
        b.addEventListener('click', a.run);
        acts.appendChild(b);
      });
      box.appendChild(acts);
    }
    return box;
  }

  // 打开"分步做法"弹窗（复用共用弹窗；没有 WB.dialog 时退化成宿主 openModal）
  function showHelp(title, lines, extraActions) {
    function build(body) {
      var box = el('div', 'wb-help');
      var ol = el('ol', 'wb-help-steps');
      (lines || []).forEach(function (t) { ol.appendChild(el('li', 'wb-help-step', t)); });
      box.appendChild(ol);
      if (extraActions && extraActions.length) {
        var acts = el('div', 'wb-help-acts');
        extraActions.forEach(function (a) {
          var b = el('button', 'file-refresh wb-guide-btn', a.label);
          b.type = 'button';
          b.addEventListener('click', a.run);
          acts.appendChild(b);
        });
        box.appendChild(acts);
      }
      body.appendChild(box);
    }
    if (WB.dialog && typeof WB.dialog.open === 'function') { WB.dialog.open(title, build); return; }
    if (typeof window.openModal === 'function') { window.openModal(title, build); return; }
    flash(title + '：' + (lines || []).join(' / '));
  }

  // ---------------- ① AI 面板会话状态 ----------------
  function stateOfHarness(panel) {
    var diag = panel.querySelector('.harness-diag');
    var text = (diag && diag.textContent || '').trim();
    if (!text) return { kind: '', text: '' };
    if (/未绑定/.test(text)) return { kind: 'unbound', text: text };
    if (/未切到|存储已指向|欢迎页/.test(text) && !/已钉/.test(text)) return { kind: 'notswitched', text: text };
    return { kind: 'ok', text: text };
  }

  var HELP = {
    unbound: {
      title: '○ 未绑定：面板自由选会话',
      chip: '未绑定 · 说明',
      lines: [
        '这是"正常态"，不是坏了：面板没有指定要钉哪条会话，你在里面点哪条会话，它就跟哪条走。',
        '想让某个场景固定成一条会话，才需要绑定：编辑 外壳\\scenarios\\<场景>.json，给该面板补 sessionTitle（会话标题，要与侧栏一字不差）和 sessionId（真实 id，在 工作台.json 里）。',
        '保存后切一次场景（或点顶栏 ⟳）即生效；不需要重启工作台。'
      ]
    },
    notswitched: {
      title: '⚠ 存储已指向 / 画面未切：这样修',
      chip: '未切到 · 修复',
      lines: [
        '先点标题行右侧那圈状态小字：普通点击 = 重新加载并按当前绑定再钉一次；Shift + 点击 = 忘掉记住的标题、重新按会话名匹配。',
        '还不行就核对目标会话是否存在：标题一字不差、cwd 是本机工作台根。按部署手册重建：node 外壳\\scripts\\建会话.mjs --title "<场景名>" --cwd "<应用根>"，再 node 工具\\实例化.mjs --apply。',
        '「存储已指向 · 还是欢迎页」多半是引擎刚启动、会话还没落地：等 3–5 秒再点一次状态小字。最后手段才是重启工作台。'
      ]
    }
  };

  function ensureHarnessChip(panel) {
    var head = panel.querySelector('.panel-head');
    if (!head) return;
    var acts = head.querySelector('.ai-head-acts') || head;
    var st = stateOfHarness(panel);
    var chip = acts.querySelector('.' + CHIP_CLASS);
    if (st.kind !== 'unbound' && st.kind !== 'notswitched') {
      if (chip && chip.parentNode) chip.parentNode.removeChild(chip);
      return;
    }
    var help = HELP[st.kind];
    if (!chip) {
      chip = el('button', 'file-refresh ' + CHIP_CLASS, help.chip);
      chip.type = 'button';
      chip.setAttribute('aria-label', '会话状态说明');
      chip.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var kind = chip.dataset.kind || 'notswitched';
        showHelp(HELP[kind] ? HELP[kind].title : '会话状态说明', (HELP[kind] || HELP.notswitched).lines);
      });
      // 放在「重新加载」按钮与状态小字之间：不挡状态小字的点击
      acts.insertBefore(chip, acts.querySelector('.harness-diag') || null);
    }
    chip.dataset.kind = st.kind;
    chip.classList.toggle('warn', st.kind === 'notswitched');
    chip.classList.toggle('info', st.kind === 'unbound');
    // ⚠ 幂等守卫：只是重复扫描时**不要改 DOM**（改 textContent 会触发我们自己的 MutationObserver ⇒ 260ms 一轮的死循环）
    if (chip.textContent !== help.chip) chip.textContent = help.chip;
    var tip = help.title + '\n' + st.text;
    if (chip.title !== tip) chip.title = tip;
  }

  // ---------------- ② 本地电脑：pc 无快照 ----------------
  function pcNeedsGuide(panel) {
    var id = (panel.dataset.panelId || '').toLowerCase();
    if (id.indexOf('pc') === 0) { /* pc 场景面板 */ } else { return false; }
    if (panel.querySelector('.harness-wv') || panel.querySelector('.harness-panel')) return false;
    // 只在"还没扫过"这类空提示上引导；有数据了就不打扰
    var hints = WB.dom.qsa('.pc-hint,.pc-panel-head-sub,.sr-empty', panel);
    for (var i = 0; i < hints.length; i++) {
      var t = (hints[i].textContent || '').trim();
      if (t && /还没扫过|pc-scan/.test(t)) return true;
    }
    return false;
  }

  function ensurePcGuide(panel) {
    var body = panel.querySelector('.panel-body');
    if (!body) return;
    if (!pcNeedsGuide(panel)) {
      var old = body.querySelector('.' + GUIDE_CLASS);
      if (old && old.parentNode) old.parentNode.removeChild(old);
      return;
    }
    if (body.querySelector('.' + GUIDE_CLASS)) return;
    var root = rootDir();
    body.appendChild(guideBlock({
      title: '这个面板还没数据：先跑一次扫描',
      lines: [
        '扫描只读、不会删东西，约 40–60 秒；跑完点本面板右上角 ⟳（或顶栏 ⟳）刷新，排行 / 体检 / 台账就有数了。'
      ],
      cmd: PC_CMD,
      actions: root ? [{
        label: '打开 scripts 目录', run: function () { openPath(root + '\\外壳\\scripts'); }
      }, {
        label: '打开 data 目录（扫描结果落这）', run: function () { openPath(root + '\\外壳\\data'); }
      }] : []
    }));
  }

  // ---------------- ③ 网页AI：左侧 view 面板空态 ----------------
  function sceneId() {
    var tab = document.querySelector('#scenario-tabs .tab.active');
    if (!tab) return '';
    if (tab.dataset && tab.dataset.scId) return tab.dataset.scId;
    var label = tab.querySelector('.tab-label');
    var name = (label && label.textContent || tab.textContent || '').trim();
    return /网页AI/.test(name) ? 'webai' : name;
  }

  function ensureWebaiGuide(panel) {
    if (sceneId() !== 'webai') return;
    var body = panel.querySelector('.panel-body');
    if (!body) return;
    var empty = body.querySelector('.view-empty');
    if (!empty) {
      var dead = body.querySelector('.' + GUIDE_CLASS);
      if (dead && dead.parentNode) dead.parentNode.removeChild(dead);
      return;
    }
    if (empty.querySelector('.' + GUIDE_CLASS)) return;
    var root = rootDir();
    empty.appendChild(guideBlock({
      title: '左侧预览是空的 —— 这样把东西放进来',
      lines: [
        '右侧「AI·网页AI」产出的汇总 / 回复 / 图片，会让文件落到 _webai产物\\ 或场景记忆里；把文件路径粘到下面的输入框，就能在这里预览（Markdown / 图片 / 代码 / PDF 都行）。',
        '也可以先点右上角的站点按钮直接开网页；AI 面板里说"把结果写到文件"，产出的路径就会在这里可用。'
      ],
      actions: root ? [{
        label: '打开 网页AI 场景记忆', run: function () { openPath(root + '\\引擎数据\\.dsh\\场景记忆\\网页AI'); }
      }, {
        label: '打开工作台根目录', run: function () { openPath(root); }
      }] : []
    }));
  }

  // ---------------- ④ 面板加载态：骨架屏（2026-11-08 P3-2 · WB.skeleton） ----------------
  // 只替换"加载中的面板 body"里的占位：renderers.js 加载完会整个清空 body，骨架自然消失。
  function ensureHarnessSkeleton(panel) {
    var loading = panel.querySelector('.harness-loading');
    if (!loading || panel.querySelector('.harness-wv')) return;
    if (loading.querySelector('.wb-harness-skel')) return;
    var box = document.createElement('div');
    box.className = 'wb-harness-skel';
    if (WB.skeleton) WB.skeleton(box, 3); else box.textContent = '加载中…';
    loading.appendChild(box);
  }

  // ---------------- 扫描调度 ----------------
  function scan() {
    if (window.__WB_UI_SOLO) return;
    var view = document.getElementById('scenario-view');
    // AI 面板的主标签（场景 0）不走这里的 chip（没有会话绑定语义）
    if (view && view.classList.contains('active')) {
      WB.dom.qsa('#grid > .panel').forEach(function (panel) {
        var id = (panel.dataset.panelId || '').toLowerCase();
        if (panel.querySelector('.harness-diag')) ensureHarnessChip(panel);
        if (panel.querySelector('.harness-loading')) ensureHarnessSkeleton(panel);
        if (id.indexOf('pc') === 0) ensurePcGuide(panel);
        if (id.indexOf('webai') === 0) ensureWebaiGuide(panel);
      });
    }
  }

  function scanSoon() {
    if (scanning) return;
    scanning = true;
    setTimeout(function () { scanning = false; try { scan(); } catch (e) { /* ignore */ } }, 260);
  }

  WB.ready(function () {
    if (window.__WB_UI_SOLO) return;
    scan();
    // 场景渲染完成后重扫（ui-shell 会 emit scene:changed；面板渲染用 MutationObserver 兜住）
    WB.bus.on('scene:changed', function () { scanSoon(); });
    var grid = document.getElementById('grid');
    if (grid && window.MutationObserver) {
      new MutationObserver(scanSoon).observe(grid, { childList: true, subtree: true, characterData: true });
    }
    var view = document.getElementById('scenario-view');
    if (view && window.MutationObserver) {
      new MutationObserver(scanSoon).observe(view, { attributes: true, attributeFilter: ['class'] });
    }
    // 首屏面板是异步渲染的（harness 要等引擎、pc 要等 IPC）⇒ 再补两次轻量扫描
    setTimeout(scan, 1200);
    setTimeout(scan, 4000);
  });

  WB.empty = { scan: scan, scanSoon: scanSoon };
})();
