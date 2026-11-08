/**
 * 外壳/engine-adapter/contract.js —— DSH 引擎内部契约的**单一实现**（P2 收口）
 *
 * 为什么是 UMD：主进程是 CJS（main.js `require` 本文件），渲染层是浏览器脚本
 * （index.html 在本文件之后再加载 renderers.js，渲染层直接读 `window.__WB_ENGINE_ADAPTER`）。
 * 没有构建链，所以用最朴素的 UMD 包装；**不要**改成 ESM（main.js 无法 require）。
 *
 * 收口内容（2026-11-08，P2-A）：
 *   SELECTORS / WIDE_COL / WIDE_CARD / wideCss() / chatCss() / widePinJs() / fixJs()
 *
 * 等价性口径（Lead 拍板，见同目录 README「差异登记」）：
 *   - wideCss()/chatCss()/widePinJs()：与两侧历史输出**逐字节等价**（profile 条件片段拼出）
 *   - fixJs()：两侧原实现已漂移，采用 `profile` 双档；验收 = 去注释/空白后**逐 token 等价**
 *     + `new Function` 可解析；main 保留全部诊断字段、renderer 保留 JSON 返回+末尾嵌 pin。
 *
 * 修改纪律：本文件是"对上游 DOM 的劫持"唯一落点；改动前先跑
 *   node 外壳\scripts\engine-selfcheck.mjs（运行时命中数自检；无引擎时 exit 3 = 未验证）。
 */

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;   // 主进程（CJS）
  else root.__WB_ENGINE_ADAPTER = api;                                      // 渲染层（浏览器全局）
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '1.0.0';

  // 注入脚本的行分隔符：原 main.js / renderers.js 是 CRLF，模板字面量里的换行就是 CRLF。
  // 为与历史注入文本逐字节等价，widePinJs() / fixJs() 统一用 CRLF 拼接。
  var NL = '\r\n';

  // ── 引擎内部契约：选择器/属性/键（别再散落到 main.js / renderers.js）──────────
  var SELECTORS = {
    chatFlow: '[data-chat-flow]',
    phase: '[data-phase]',
    widthHandle: '[data-width-handle]',
    composerCard: '[data-composer-card]',
    composerInput: '[data-composer-input]',
    centerCol: '[class*="centerCol"]',
    sidebarCol: '[class*="sidebarCol"]',
    rightbarCol: '[class*="rightbarCol"]',
    chatFlowHas: ':has([data-chat-flow])',
    sessionCurrentKey: 'dsh.sessions.current',
    sessionRow: 'div[role="treeitem"][aria-selected]',
    treeGroup: '[aria-expanded]',
    projCache: 'session_projcache',
    chatFlowSlot: 'conversation.chat.flow'
  };

  // ── 会话列「铺满」的两个宽度（实测值：父层内容盒 − 16px；两边同值 ⇒ 卡比列宽 32px）──
  var WIDE_COL = 'calc(100% - 16px)';
  var WIDE_CARD = 'calc(100% - 16px)';

  /** 原 HARNESS_WIDE_CSS：三条（返回数组；调用方自行 join('\n')，与原常量形态一致） */
  function wideCss() {
    return [
      '[data-chat-flow] { max-width: ' + WIDE_COL + ' !important; }',
      '[data-composer-card] { max-width: ' + WIDE_CARD + ' !important; }',
      '[class*="embeddedBody"], [class*="column"] { --dsh-chat-content-width: ' + WIDE_COL +
      ' !important; --dsh-composer-card-max-width: ' + WIDE_CARD + ' !important; }'
    ];
  }

  // 精简布局公共前缀：内联 grid+minmax 的单轨道压成 1fr
  var PREFIX_1 = '[style*="grid-template-columns"][style*="minmax(0"]';
  var RULE_GRID = PREFIX_1 + ' { grid-template-columns: minmax(0, 1fr) !important; }';
  // 0.2.2 起三列用 grid-area 定位：单轨道后必须把中心列钉回第 1 列（main 侧独有）
  var RULE_CENTER_HAS = PREFIX_1 + ' > :has([data-chat-flow]) { grid-column: 1 / -1 !important; grid-row: 1 !important; }';
  var RULE_CENTER_CLS = PREFIX_1 + ' > [class*="centerCol"] { grid-column: 1 / -1 !important; grid-row: 1 !important; }';
  var RULE_PHASE_HEADER = PREFIX_1 + ' [data-phase] > header { display: none !important; }';
  var RULE_WIDTH_HANDLE = PREFIX_1 + ' [data-width-handle] { display: none !important; }';

  /**
   * 原 HARNESS_CHAT_CSS。
   * opts.centerColFix：main 侧 true（含 2 条 centerCol 规则，AGENTS §5-13 修复）；
   *                    渲染层 false（历史文本只有 3+WIDE 规则）。
   * 返回数组；调用方 join('\n')。
   */
  function chatCss(opts) {
    var o = opts || {};
    var rules = [RULE_GRID];
    if (o.centerColFix) { rules.push(RULE_CENTER_HAS); rules.push(RULE_CENTER_CLS); }
    rules.push(RULE_PHASE_HEADER);
    rules.push(RULE_WIDTH_HANDLE);
    return rules.concat(wideCss());
  }

  /**
   * 原 HARNESS_WIDE_PIN_JS：把宽度变量沿祖先链逐层压 + 覆盖 max-width，并返回诊断串。
   * opts.layers：main 侧 false（历史文本无 layers 计数）；
   *              渲染层 true（历史文本有 layers 计数，返回值多 layers 字段）。
   * 输出与两侧历史文本**逐字节等价**（用 P2 前备份机械核验）。
   */
  function widePinJs(opts) {
    var o = opts || {};
    var layers = !!o.layers;
    var L = [];
    L.push('(() => {');
    L.push('  var COL = ' + JSON.stringify(WIDE_COL) + ', CARD = ' + JSON.stringify(WIDE_CARD) + ';');
    L.push('  var pinOnce = function () {');
    if (layers) L.push('    var layers = 0;');
    L.push('    var pin = function (el) {');
    L.push('      while (el && el.nodeType === 1) {');
    L.push('        try {');
    L.push("          el.style.setProperty('--dsh-chat-content-width', COL, 'important');");
    L.push("          el.style.setProperty('--dsh-composer-card-max-width', CARD, 'important');");
    L.push('        } catch (e) {}');
    L.push(layers ? '        layers++; el = el.parentElement;' : '        el = el.parentElement;');
    L.push('      }');
    L.push('    };');
    L.push("    var cols = document.querySelectorAll('[data-chat-flow]');");
    L.push("    for (var i = 0; i < cols.length; i++) { try { cols[i].style.setProperty('max-width', COL, 'important'); } catch (e) {} pin(cols[i]); }");
    L.push("    var cards = document.querySelectorAll('[data-composer-card]');");
    L.push("    for (var j = 0; j < cards.length; j++) { try { cards[j].style.setProperty('max-width', CARD, 'important'); } catch (e) {} pin(cards[j]); }");
    L.push(layers ? '    var c0 = cols[0], pw = 0, w = 0;' : '    var c0 = cols[0], w = 0, pw = 0;');
    if (layers) {
      L.push('    // ⚠ 分母必须是"可用宽"＝父层**内容盒**（clientWidth 去掉左右内边距），不能用父层 border box：');
      L.push('    //    max-width 里的 % 就是对这个内容盒算的。实测父层 border box 1656 / 内容盒 1592 / 列 1576 ⇒ 只差 16px。');
    }
    L.push('    if (c0) {');
    L.push('      try {');
    L.push('        w = c0.getBoundingClientRect().width;');
    if (!layers) L.push('        // ⚠ 分母用父层**内容盒**（clientWidth 去左右内边距），不能用 border box —— max-width 的 % 就是这么算的');
    L.push('        var p = c0.parentElement || c0, cs = null;');
    L.push('        try { cs = getComputedStyle(p); } catch (e2) {}');
    L.push('        pw = p.clientWidth - ((cs && parseFloat(cs.paddingLeft)) || 0) - ((cs && parseFloat(cs.paddingRight)) || 0);');
    L.push('      } catch (e) {}');
    L.push('    }');
    L.push(layers
      ? '    return { cols: cols.length, cards: cards.length, layers: layers, w: Math.round(w), pw: Math.round(pw) };'
      : '    return { cols: cols.length, cards: cards.length, w: Math.round(w), pw: Math.round(pw) };');
    L.push('  };');
    L.push('  var r = pinOnce();');
    L.push('  try { if (!window.__kunWideTimer) window.__kunWideTimer = setInterval(pinOnce, 2000); } catch (e) {}');
    L.push("  return r.cols + '列 ' + r.w + '/' + r.pw + 'px';");
    L.push('})()');
    return L.join(NL);
  }

  /**
   * 原 HARNESS_FIX_JS（布局修复脚本）。
   * opts.profile：'main'（主进程注入：含 centerCol 内联修复 + 完整 window.__fixDiag 诊断）
   *               'renderer'（面板内注入：极简 JSON 返回 + 末尾嵌 opts.pinJs）
   * opts.pinJs：renderer 档要嵌在末尾的钉会话脚本（renderers.js 的 HARNESS_PIN_JS）。
   * 等价性口径：两档各自与原实现"去注释/空白后逐 token 等价"；main 档诊断字段一个不少。
   */
  function fixJs(opts) {
    var o = opts || {};
    var profile = o.profile === 'renderer' ? 'renderer' : 'main';
    var pinJs = String(o.pinJs == null ? '' : o.pinJs);
    var wide = widePinJs({ layers: profile === 'renderer' });
    var L = [];
    L.push('(() => {');
    L.push('  const pick = () => {');
    L.push("    const all = document.querySelectorAll('[style*=\"grid-template-columns\"]');");
    L.push('    for (let i = 0; i < all.length; i++) {');
    L.push("      const v = all[i].style.gridTemplateColumns || '';");
    L.push("      if (v.indexOf('minmax(') >= 0) return all[i];");
    L.push('    }');
    L.push('    return null;');
    L.push('  };');
    if (profile === 'renderer') L.push("  let WIDE = '';   // 铺满诊断（宿主显示在面板标题行）");
    L.push('  const fix = () => {');
    L.push('    const f = pick();');
    L.push('    if (!f) return false;');
    if (profile === 'renderer') {
      L.push('    try { WIDE = ' + wide + '; } catch (e) { /* ignore */ }');
    } else {
      L.push('    try { window.__wideTxt = ' + wide + '; } catch (e) { /* ignore */ }');
    }
    L.push("    f.style.setProperty('grid-template-columns', 'minmax(0, 1fr)', 'important');");
    L.push('    let center = null;');
    L.push("    const flow = f.querySelector('[data-chat-flow]') || f.querySelector('[data-phase]');");
    L.push('    if (flow) {');
    L.push('      let n = flow;');
    L.push('      while (n && n.parentElement && n.parentElement !== f) n = n.parentElement;');
    L.push('      if (n && n.parentElement === f) center = n;');
    L.push('    }');
    L.push('    if (center) {');
    L.push('      const kids = f.children;');
    L.push('      for (let i = 0; i < kids.length; i++) {');
    L.push('        const c = kids[i];');
    L.push('        if (c === center) continue;');
    L.push("        let pos = 'static';");
    L.push('        try { pos = getComputedStyle(c).position; } catch (e) { /* ignore */ }');
    L.push("        if (pos === 'absolute') continue;");
    L.push("        c.style.setProperty('display', 'none', 'important');");
    L.push('      }');
    if (profile === 'main') {
      L.push('      // 单轨道下把中心列钉回第 1 列（与 chatCss 的 2 条规则同一件事；React 重渲染后自维持）');
      L.push('      try {');
      L.push("        center.style.setProperty('grid-column', '1 / -1', 'important');");
      L.push("        center.style.setProperty('grid-row', '1', 'important');");
      L.push('      } catch (e) { /* ignore */ }');
    }
    L.push('    }');
    L.push("    f.querySelectorAll('[data-width-handle]').forEach(function (h) {");
    L.push("      h.style.setProperty('display', 'none', 'important');");
    L.push('    });');
    L.push("    f.querySelectorAll('[data-phase]').forEach(function (r) {");
    L.push('      const kids = r.children;');
    L.push('      let hasFlow = false;');
    L.push('      for (let j = 0; j < kids.length; j++) {');
    L.push("        if (kids[j].querySelector('[data-chat-flow]')) { hasFlow = true; break; }");
    L.push('      }');
    L.push('      if (!hasFlow) return;');
    L.push('      for (let j = 0; j < kids.length; j++) {');
    L.push('        const c = kids[j];');
    L.push("        if (c.querySelector('[data-chat-flow]')) continue;");
    L.push("        c.style.setProperty('display', 'none', 'important');");
    L.push('      }');
    L.push('    });');
    L.push('    if (flow) {');
    L.push('      const sc = flow.parentElement;');
    L.push('      if (sc && sc.firstElementChild && sc.firstElementChild !== flow) {');
    L.push("        sc.firstElementChild.style.setProperty('display', 'none', 'important');");
    L.push('      }');
    L.push('    }');
    L.push('    return true;');
    L.push('  };');
    L.push('  fix();');
    L.push('  // 幂等守卫：宿主会重复注入，不守卫会攒出多个 MutationObserver + 定时器');
    L.push('  if (!window.__kunFixOn) {');
    L.push('    window.__kunFixOn = 1;');
    L.push("    try { new MutationObserver(fix).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] }); } catch (e) {}");
    L.push('    setInterval(fix, 1000);');
    L.push('  }');
    L.push("  const all = document.querySelectorAll('[style*=\"grid-template-columns\"]');");
    L.push('  const f2 = pick();');
    L.push('  const vals = [];');
    L.push('  for (let i = 0; i < all.length && i < 5; i++) vals.push(all[i].style.gridTemplateColumns);');
    L.push("  const rootEl = document.getElementById('root') || document.body;");
    if (profile === 'main') {
      L.push('  let rect = null;');
      L.push('  if (f2) { const r = f2.getBoundingClientRect(); rect = { x: r.x, y: r.y, w: r.width, h: r.height }; }');
      L.push('  const kidsInfo = [];');
      L.push('  if (f2) {');
      L.push('    const kk = f2.children;');
      L.push('    for (let i = 0; i < kk.length && i < 8; i++) {');
      L.push('      const c = kk[i];');
      L.push("      let pos = 'static', cr = { x: -1, w: -1 };");
      L.push('      try { pos = getComputedStyle(c).position; cr = { x: Math.round(c.getBoundingClientRect().x), w: Math.round(c.getBoundingClientRect().width) }; } catch (e) { /* ignore */ }');
      L.push('      kidsInfo.push({ i: i, cls: (c.className && c.className.toString().slice(0, 30) || c.tagName), pos: pos, x: cr.x, w: cr.w, vis: c.offsetParent !== null });');
      L.push('    }');
      L.push('  }');
      L.push('  window.__fixDiag = JSON.stringify({');
      L.push('    found: !!f2,');
      L.push("    grid: f2 ? f2.style.gridTemplateColumns : '',");
      L.push('    grids: all.length,');
      L.push('    vals: vals,');
      L.push("    iframes: document.querySelectorAll('iframe').length,");
      L.push("    hasPhase: document.querySelectorAll('[data-phase]').length,");
      L.push("    hasChatFlow: document.querySelectorAll('[data-chat-flow]').length,");
      L.push("    wide: window.__wideTxt || '',");
      L.push('    rootKids: rootEl ? rootEl.children.length : -1,');
      L.push("    frameTag: f2 ? f2.tagName : '',");
      L.push("    frameCls: f2 ? (f2.className && f2.className.toString().slice(0, 60) || '') : '',");
      L.push('    frameRect: rect,');
      L.push('    kidsInfo: kidsInfo,');
      L.push('    sidebarEls: f2 ? (f2.children.length - 1) : 0,');
      L.push("    widthHandles: f2 ? f2.querySelectorAll('[data-width-handle]').length : 0,");
      L.push('    winW: window.innerWidth,');
      L.push('    winH: window.innerHeight,');
      L.push('    title: document.title,');
      L.push('    url: location.href,');
      L.push('    pinDiag: (() => {');
      L.push("      const T = 'oa系统运维';");
      L.push('      const hits = [];');
      L.push("      const all = document.querySelectorAll('*');");
      L.push('      for (let i = 0; i < all.length; i++) {');
      L.push('        const e = all[i];');
      L.push("        const t = (e.textContent || '');");
      L.push('        if (t.indexOf(T) < 0) continue;');
      L.push("        hits.push({ tag: e.tagName, cls: String(e.className || '').slice(0, 40), len: t.replace(/\\\\s+/g, ' ').trim().length, vis: e.offsetParent !== null });");
      L.push('        if (hits.length >= 8) break;');
      L.push('      }');
      L.push('      hits.sort(function (a, b) { return a.len - b.len; });');
      L.push("      return { total: hits.length, top3: hits.slice(0, 3), selected: !!document.querySelector('[aria-selected=\"true\"]') };");
      L.push('    })()');
      L.push('  });');
    } else {
      L.push('  return JSON.stringify({');
      L.push('    found: !!f2,');
      L.push("    grid: f2 ? f2.style.gridTemplateColumns : '',");
      L.push('    grids: all.length,');
      L.push('    vals: vals,');
      L.push("    iframes: document.querySelectorAll('iframe').length,");
      L.push("    hasPhase: document.querySelectorAll('[data-phase]').length,");
      L.push("    hasChatFlow: document.querySelectorAll('[data-chat-flow]').length,");
      L.push('    wide: WIDE,   // 铺满实测（宿主把它显示在面板标题行）');
      L.push('    rootKids: rootEl ? rootEl.children.length : -1,');
      L.push('    title: document.title,');
      L.push('    url: location.href');
      L.push('  });');
    }
    L.push('})();');
    if (profile === 'renderer' && pinJs) {
      L.push('');
      L.push('// ---- 钉住会话（renderers.js 的 HARNESS_PIN_JS；仍只在渲染层）----');
      L.push(pinJs);
    }
    return L.join(NL);
  }

  return {
    VERSION: VERSION,
    SELECTORS: SELECTORS,
    WIDE_COL: WIDE_COL,
    WIDE_CARD: WIDE_CARD,
    wideCss: wideCss,
    chatCss: chatCss,
    widePinJs: widePinJs,
    fixJs: fixJs
  };
}));
