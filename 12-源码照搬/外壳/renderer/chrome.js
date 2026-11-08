// renderer/chrome.js —— 外壳 chrome / HARNESS 接线（P2-D 阶段2b 从 renderers.js 3120-3748 逐字搬出）
//
// 约定：
//   · **不包 IIFE**：33 个顶层声明原本靠脚本级 var/function 暴露成全局，renderer.js / index.html /
//     topbar-status.js 都直接调它们；包起来就会断（7 个块外引用）。
//   · 加载顺序（index.html 已按此排）：engine-adapter/contract.js → panels/*.js → chrome.js →
//     renderers.js → renderer.js → topbar-status.js。
//   · chrome.js 比 renderers.js 先加载；而 HARNESS_WIDE_* 别名在**加载期**就要读 ENGINE_ADAPTER，
//     所以下面这行是必要的桥（值同 renderers.js:19 随后赋的值；重复 var 声明无害）。
//   · 定时器（场景发光 / 标签栏重试）都在函数体内且挂 window 级守卫，⟳ 重载不会攒定时器
//     （check-gui 已加对应断言）。
var ENGINE_ADAPTER = window.__WB_ENGINE_ADAPTER || null;
// chrome.js 先于 renderers.js 加载，而搬入的 GLOW_HOME_FALLBACK 在**加载期**就要用 __WB_ROOT
// ⇒ 这里先算一次（与 renderers.js:8 的 IIFE 完全相同；renderers.js 随后会再算一次，同值、无害）。
var __WB_ROOT = (function () {
  try {
    var q = decodeURIComponent(String(location.pathname || '')).replace(/^\//, '').replace(/\//g, '\\');
    var m = q.match(/^(.*)\\外壳\\renderer\\/i);
    if (m && m[1]) return m[1];
  } catch (e) { /* ignore */ }
  if (window.console) console.warn('[工作台] 推不出本机根，依赖根的兜底路径将不可用');
  return '';
})();


function decorateScenarioIcons() {
  try {
    Object.keys(SCENARIO_ICONS).forEach(function (id) {
      const ico = document.querySelector('#scenario-tabs .tab[data-sc-id="' + id + '"] .tab-ico');
      if (!ico) return;
      // 幂等靠"比对内容"：原来只记一个 'svg' 标记 ⇒ 同一个 id 换了新图标（新 SVG / 换成图片）后，
      // ⟳ 会被这个标记挡住、永远不更新（用户换了图标却看不见变化）。现在把上次写进去的内容存在
      // data-icon 里，内容变了才重写 —— 既幂等（重复调用不闪），又能跟着改。
      const html = SCENARIO_ICONS[id];
      if (ico.getAttribute('data-icon') === html) return;
      ico.innerHTML = html;
      ico.setAttribute('data-icon', html);
      ico.style.opacity = '1';   // emoji 那套 14px / opacity .85 的样式对 SVG/图片不适用
    });
  } catch (e) { /* 换图标失败不影响功能 */ }
}

// ── 场景标签栏：拖拽换位（浏览器标签页那种丝滑）+ 未激活标签收成图标 ─────────────────────
// 分工：标签 DOM 由外壳 renderer.js 建（改外壳要重启 GUI），**交互在这一层** ⇒ 随 ⟳ 重载，调手感不必重启。
// 外壳建完标签调一次 initScenarioTabBar({ nav, persist, pinnedIds }) 即可。
// 稳定性要点（几条都是"会真出事"的）：
//   ① 用**指针事件 + setPointerCapture**，不用 HTML5 DnD：幽灵图丑、落点时机不可控、和 click 抢事件；
//   ② 拖动超过阈值 ⇒ 这一次的 click 在 capture 阶段就被吞掉 ⇒ **拖标签绝不会误切场景**（老实现就有这毛病）；
//   ③ 落位用"占位格 + 其它标签 FLIP 位移"，被拖的标签脱流跟着指针走 ⇒ 视觉上就是浏览器标签在让位；
//   ④ 幂等：容器上记 data-tabbar 版本，⟳ 重复调用只重排状态、不叠加监听；
//   ⑤ 顺序**只报给外壳**（外壳交主进程存），这一层自己不存 —— 单一权威在 main.js，避免两份顺序打架。
var TABBAR_VERSION = 'tabs-2026-09-26.1';
var TAB_COLLAPSED_W = 33;   // 收起后只留图标：17px 图标 + 7px×2 内边距 + 2px 边框

function tabListOf(nav) {
  return Array.prototype.filter.call(nav.children, function (n) {
    return n && n.classList && n.classList.contains('tab');
  });
}

/** 落点 → 目标下标（**纯函数**，只吃 rect 数字 ⇒ 好单测）。
 *  规则与浏览器一致：从左往右，第一个"中心点在指针右侧"的标签就是插入点；都不满足则插到末尾。 */
function tabDropIndex(rects, dropX) {
  for (var i = 0; i < rects.length; i++) {
    if (dropX < (rects[i].left + rects[i].right) / 2) return i;
  }
  return rects.length;
}

/** 固定组规则（场景 json 里 "first": true，如 Blender）：它们永远排在最前 ——
 *  拖固定标签 ⇒ 只能在自己那一组内换位；拖别的标签 ⇒ 插不到固定组前面。
 *  纯函数，好单测；这条就是"顺序不会乱"的关键。 */
function tabClampTarget(target, dragIsPinned, fixedCount) {
  if (dragIsPinned) return Math.min(target, fixedCount);
  return Math.max(target, fixedCount);
}

/** 其它标签要平移时用 FLIP 补动画：先记位置 → 改 → 用 transform 抵消跳变 → 下一帧放开。 */
function flipNav(nav, mutate) {
  var tabs = tabListOf(nav);
  // 先把在飞的 FLIP transform 清干净（拖得快时上一个动画还没结束，叠加起来会抖）
  tabs.forEach(function (t) { t.style.transition = 'none'; t.style.transform = ''; });
  void nav.offsetWidth;   // 强制回流：让上面的清理落定，下面的 before 才是干净的位置
  var before = tabs.map(function (t) { return t.getBoundingClientRect().left; });
  mutate();
  var after = tabs.map(function (t) { return t.getBoundingClientRect().left; });
  tabs.forEach(function (t, i) {
    var d = before[i] - after[i];
    if (!d || Math.abs(d) < 0.5) return;
    t.style.transition = 'none';
    t.style.transform = 'translateX(' + d + 'px)';
    requestAnimationFrame(function () {
      t.style.transition = '';
      t.style.transform = '';
    });
  });
}

/** 收起 / 展开：激活的、鼠标悬停的、正在拖的**始终展开**，其余只留图标。 */
function applyTabCollapse(nav, keepOpen) {
  tabListOf(nav).forEach(function (t) {
    var open = t === keepOpen || t.classList.contains('active') || t.classList.contains('tab-dragging');
    t.classList.toggle('tab-collapsed', !open);
  });
}

/** 量"展开时的自然宽度"与"文字宽度"，存成 CSS 变量 —— 两端都是 px，width / max-width 才可过渡
 *（悬停展开之所以丝滑，靠的就是这个：上游标签宽度在动画，后面的标签每帧跟着重排，不需要 JS 逐帧）。 */
function measureTabWidths(nav) {
  var tabs = tabListOf(nav);
  tabs.forEach(function (t) {
    t.classList.remove('tab-collapsed');
    t.style.removeProperty('--tab-w');
    t.style.removeProperty('--label-w');
  });
  tabs.forEach(function (t) {
    var w = Math.ceil(t.getBoundingClientRect().width);
    if (w > 0) t.style.setProperty('--tab-w', (w + 1) + 'px');
    var lab = t.querySelector('.tab-label');
    if (lab) {
      var lw = Math.ceil(lab.scrollWidth);
      if (lw > 0) t.style.setProperty('--label-w', lw + 'px');
    }
    t.style.setProperty('--tab-cw', TAB_COLLAPSED_W + 'px');
  });
}

function initScenarioTabBar(opts) {
  opts = opts || {};
  var nav = opts.nav || document.getElementById('scenario-tabs');
  if (!nav) return null;
  if (nav.getAttribute('data-tabbar') === TABBAR_VERSION) {   // 幂等：⟳ 只重排状态，不叠加监听
    measureTabWidths(nav);
    applyTabCollapse(nav);
    return null;
  }
  nav.setAttribute('data-tabbar', TABBAR_VERSION);
  measureTabWidths(nav);

  var pinnedIds = opts.pinnedIds || [];
  var isPinned = function (t) { return pinnedIds.indexOf(t.dataset.scId) >= 0; };
  var pinnedCountExcept = function (t) {
    return tabListOf(nav).filter(function (x) { return x !== t && isPinned(x); }).length;
  };
  var drag = null, suppressClick = false, suppressTimer = null;

  // ---- 悬停丝滑展开（事件委托：标签重建也不用重绑）----
  nav.addEventListener('mouseover', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('.tab') : null;
    if (t && t.parentNode === nav) applyTabCollapse(nav, t);
  });
  nav.addEventListener('mouseout', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('.tab') : null;
    if (!t || t.parentNode !== nav) return;
    var to = e.relatedTarget;
    if (to && t.contains(to)) return;      // 在标签内部挪动不算移出
    applyTabCollapse(nav);
  });

  // ---- 拖动换位 ----
  var beginDrag = function () {
    var t = drag.tab;
    // 尺寸/起点一律用 offset*（相对 nav，且**不含 transform**）—— 用 getBoundingClientRect 的话，
    // 上一次 FLIP 还在飞时会把 transform 偏移算进来，拖动中就会跳。
    drag.width = t.offsetWidth; drag.height = t.offsetHeight;
    drag.startLeft = t.offsetLeft;
    drag.startTop = t.offsetTop;
    var ph = el('div', 'tab-placeholder');
    ph.style.width = drag.width + 'px';
    ph.style.height = drag.height + 'px';
    nav.insertBefore(ph, t);          // 占位格替它占住原位置
    drag.ph = ph;
    t.classList.add('tab-dragging');  // 脱流，跟着指针走
    t.style.position = 'absolute';
    t.style.width = drag.width + 'px';
    t.style.height = drag.height + 'px';
    t.style.left = drag.startLeft + 'px';
    t.style.top = drag.startTop + 'px';
    nav.classList.add('tabs-dragging');
    drag.started = true;
    drag.curTarget = -1;
    applyTabCollapse(nav, t);
  };

  var placeTarget = function (target) {
    var others = tabListOf(nav).filter(function (x) { return x !== drag.tab; });
    flipNav(nav, function () {
      if (target >= others.length) nav.appendChild(drag.ph);
      else nav.insertBefore(drag.ph, others[target]);
    });
  };

  var edgeScroll = function (clientX) {
    var nr = nav.getBoundingClientRect();
    var max = nav.scrollWidth - nav.clientWidth;
    if (max <= 0) return;
    if (clientX < nr.left + 30) nav.scrollLeft = Math.max(0, nav.scrollLeft - 8);
    else if (clientX > nr.right - 30) nav.scrollLeft = Math.min(max, nav.scrollLeft + 8);
  };

  var onDown = function (e) {
    if (e.button !== 0) return;
    var t = e.target && e.target.closest ? e.target.closest('.tab') : null;
    if (!t || t.parentNode !== nav) return;
    if (e.target.closest('.tab-detach')) return;         // ⧉ 有自己的逻辑
    if (tabListOf(nav).some(function (x) { return x.classList.contains('tab-dragging'); })) return;  // 上一次还没落位
    drag = { tab: t, id: e.pointerId, startX: e.clientX, startY: e.clientY, started: false, scrollAt: nav.scrollLeft };
    try { t.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  };

  var onMove = function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.started) {
      if (Math.abs(e.clientX - drag.startX) < 5 && Math.abs(e.clientY - drag.startY) < 5) return;  // 5px 内算点击
      beginDrag();
    }
    if (e.cancelable) e.preventDefault();
    var scrollDelta = nav.scrollLeft - drag.scrollAt;
    drag.tab.style.left = (drag.startLeft + (e.clientX - drag.startX) + scrollDelta) + 'px';
    // 落点判定：用 offsetLeft/offsetWidth（**不含 transform**，且是内容坐标）——
    // 用 rect 的话，FLIP 动画在飞时会把 transform 偏移算进去 ⇒ 占位格在拖动中乱跳。
    var nr = nav.getBoundingClientRect();
    var dropX = e.clientX - (nr.left + nav.clientLeft) + nav.scrollLeft;
    var others = tabListOf(nav).filter(function (x) { return x !== drag.tab; });
    var rects = others.map(function (x) {
      return { left: x.offsetLeft, right: x.offsetLeft + x.offsetWidth };
    });
    var target = tabClampTarget(tabDropIndex(rects, dropX), isPinned(drag.tab), pinnedCountExcept(drag.tab));
    if (target !== drag.curTarget) { drag.curTarget = target; placeTarget(target); }
    edgeScroll(e.clientX);
  };

  var onUp = function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.started) { drag = null; return; }   // 没拖动 ⇒ 放行 click（正常切场景）
    var t = drag.tab, ph = drag.ph;
    // 立刻标记"这次 click 不算数"：click 紧跟在 pointerup 之后就来，不能等动画结束
    suppressClick = true;
    if (suppressTimer) clearTimeout(suppressTimer);
    suppressTimer = setTimeout(function () { suppressClick = false; }, 500);
    drag = null;
    // 落位动画：从当前位置滑到占位格（offsetLeft 同样是内容坐标，不受滚动/transform 影响）
    t.style.transition = 'left .16s cubic-bezier(.2,.8,.2,1), transform .16s ease';
    t.style.left = ph.offsetLeft + 'px';
    setTimeout(function () {
      nav.insertBefore(t, ph);                     // 按占位格的位置插回 DOM（= 新顺序）
      t.classList.remove('tab-dragging');
      ['position', 'width', 'height', 'left', 'top', 'transition', 'zIndex'].forEach(function (k) { t.style.removeProperty(k); });
      if (ph.parentNode) ph.parentNode.removeChild(ph);
      nav.classList.remove('tabs-dragging');
      measureTabWidths(nav);
      applyTabCollapse(nav);
      if (typeof opts.persist === 'function') {
        try {
          opts.persist(tabListOf(nav).map(function (x) { return x.dataset.scId; }).filter(Boolean));
        } catch (err) { /* 存档失败不影响已经换好的位置 */ }
      }
    }, 170);
  };

  // 拖动过的那一次点击要吞掉（capture 阶段抢在外壳的 click 处理之前），否则"拖标签 = 顺带切场景"
  nav.addEventListener('click', function (e) {
    if (!suppressClick) return;
    e.stopPropagation();
    e.preventDefault();
  }, true);

  nav.addEventListener('pointerdown', onDown);
  nav.addEventListener('pointermove', onMove);
  nav.addEventListener('pointerup', onUp);
  nav.addEventListener('pointercancel', onUp);
  applyTabCollapse(nav);
  return { version: TABBAR_VERSION, refresh: function () { measureTabWidths(nav); applyTabCollapse(nav); } };
}

// ---------- 会话列「铺满窗口」（场景 0 与各场景面板共用，2026-09-20 第三波）----------
// 需求原文：「现在会话又变窄了，修改一下自适应窗口的宽度，包括每个场景窗口里的 ai 会话」。
//
// ★真因（隐藏探针 `_排查脚本存档\probe-chat-width` 实测，别再靠猜）★
//   引擎 0.1.6 这条链是：会话列 = `[data-chat-flow]`（class 形如 `Rpcr1W_column`，
//   `max-width: var(--dsh-chat-content-width)`）；输入卡 = `[data-composer-card]`
//   （`max-width: var(--dsh-composer-card-max-width)`）。
//   两个变量都是**就地算**的 calc：clamp(680px, **声明它的那个元素自己的宽度** × 64%, 920px)。
//   实测 1666 宽窗口：框架内联 grid = `280px minmax(0px, 1fr) 0px` ⇒ 中列 1386 ⇒ 会话列 1386×0.64 = 887px、
//   输入卡 919px——两边各空 250px，正是用户截图里那条"又变窄了"。
//   ⚠ 老办法「把 --dsh-chat-content-width 写在 [data-phase] 上」在本版**必然失效**，两个原因：
//     ① 变量是就地算的：写在别的元素上，算出来的百分比不是会话列自己的宽度；
//     ② 本版 `[data-phase]` **不是**会话相位容器（实测全页只有 2 个，是连接状态小圆点按钮）；
//        会话列真正的锚点是 `[data-chat-flow]`。老代码拿 [data-phase] 兼作"中心列探测器"，
//        靠 `||` 兜底才没一起崩，但宽度那条早就空转了。
//     ③ 变量在**声明它的元素**上求值一次就定死 ⇒ 只改框架层，列自己那层（.embeddedBody）声明会盖掉它。
//
// 做法：三重，任何一条单独生效都能铺满，互不冲突（都是幂等的）：
//   ① 直接盖 `max-width`（不依赖任何变量，最稳）：列与输入卡都写成「父层内容盒 − 16px」——
//     父层内边距不同（会话列 32px / 输入卡 16px），于是自动得到"输入卡比列宽 32px"这个引擎原设计比例，
//     两侧留白也从实测的 250px 收到 20~40px（见下面两个常量的注释：数字是量出来的，别凭感觉改）。
//   ② 从列/输入卡一路往上（含 html/body）**逐层**内联 !important 写这两个变量 ⇒ 消息气泡、
//      markdown、审批面板等"读变量"的地方一起铺开，并压过更上层（:root/.body/.embeddedBody）的声明；
//   ③ CSS 里再写一份同样的规则，作为 JS 没跑起来时的兜底。
// 想更宽/更窄只改下面两个字符串；想彻底还原就把 HARNESS_WIDE_CSS / HARNESS_WIDE_PIN_JS 从两处链路里摘掉。
// ⚠ 这两个数是**实测调出来的**（probe-chat-width 的 before/after）：
//   会话列 `.column` 的父层自己带 32px 内边距，输入卡的父层（composer root）只带 16px ——
//   所以两边同写 `calc(100% - 16px)` 时，恰好得到「输入卡比会话列宽 32px」＝引擎原设计的关系
//   （原设计 887 / 919 就是差 32），同时各自还留 ≥8px 兜底留白（父层没内边距时也不会贴边）。
//   一开始给列写 32px 时是这个结果：列 1560 / 卡 1608，两侧留白 48 vs 24 不对称 —— 别改回去。
// 单一实现：外壳/engine-adapter/contract.js（P2 收口；值/数组与两侧历史输出逐字节一致）
var HARNESS_WIDE_COL = (ENGINE_ADAPTER && ENGINE_ADAPTER.WIDE_COL) || '';
var HARNESS_WIDE_CARD = (ENGINE_ADAPTER && ENGINE_ADAPTER.WIDE_CARD) || '';
var HARNESS_WIDE_CSS = (ENGINE_ADAPTER && ENGINE_ADAPTER.wideCss) ? ENGINE_ADAPTER.wideCss().join('\n') : '';   // 原常量是 join 后的 string（P2 单一实现）
// ②的 JS 版：列/输入卡自身 + 祖先链逐层写变量，并**自维持**（宿主只投几次，页面重渲染后自己纠回来）。
// 返回给宿主看的实测小字：「1列 1576/1592px」= 铺满了几列 · 列宽 / 可用宽。
// 判读：两者只差十几像素（正是我们留的那 16px）= 已铺满；还差几百像素 = 没铺上（多半引擎换版、锚点没了）。
// ⚠ 自维持定时器带 window 级守卫：宿主每 1.5 秒重注入一次（连续 30 秒），不守卫就会攒出几十个循环。
var HARNESS_WIDE_PIN_JS = (ENGINE_ADAPTER && ENGINE_ADAPTER.widePinJs) ? ENGINE_ADAPTER.widePinJs({ layers: true }) : '';   // P2：单一实现（main 侧 layers:false）
// 场景 0 = index.html 里的 #harness-webview：**引擎原生界面，设计上不做任何精简注入**（不隐藏侧栏/顶栏），
// 所以这里只投"铺满"这一件事（CSS 兜底 + JS 逐层压变量），别的布局一律不动。
// ⚠ 只作用于 #harness-webview；各场景面板（bl-ai / oa-ai / site-ai / mk-chat）走的是本文件里的
//   HARNESS_CHAT_CSS + HARNESS_FIX_JS 那条独立链路，两条链路共用上面这组常量，但互不干扰。
var HARNESS_MAIN_WIDE_CSS = HARNESS_WIDE_CSS;
function widenMainHarnessView() {
  try {
    var wv = document.getElementById('harness-webview');
    if (!wv) return;
    var apply = function () {
      try {
        var p = wv.insertCSS(HARNESS_MAIN_WIDE_CSS);
      
        if (p && p.catch) p.catch(function () { /* 页面还没就绪，后面还有补投 */ });
      } catch (e) { /* 同上 */ }
      // JS 那一半：既压变量又量宽度；页面没就绪时 executeJavaScript 会 reject，忽略即可。
      try {
        var q = wv.executeJavaScript(HARNESS_WIDE_PIN_JS);
        if (q && q.catch) q.catch(function () { /* 同上 */ });
      } catch (e) { /* 同上 */ }
    };
    apply();
    if (wv.getAttribute('data-wide-hook') !== '1') {
      wv.setAttribute('data-wide-hook', '1');
      // 冷启动时引擎要十几秒才渲染完，靠这两个事件在页面真正加载时补投
      try { wv.addEventListener('dom-ready', apply); } catch (e) { /* ignore */ }
      try { wv.addEventListener('did-finish-load', apply); } catch (e) { /* ignore */ }
    }
    // SPA 渲染晚于 did-finish-load：再补两次（重复插入同一条 CSS 无害）
    setTimeout(apply, 1500);
    setTimeout(apply, 4000);
  } catch (e) { /* 加宽失败不影响功能 */ }
}

// ── 底部菜单栏收进顶栏（2026-09-20，用户要求）──────────────────────────────
// 需求原文：「把场景下面的菜单 有个序号开关移到最顶的菜单栏，下面的菜单栏不要了以便于节省空间，
//            最下面的窗口下边框向下扩展占满原来的下部菜单」。
// 底部那条 `#scenario-footer`（「菜单」+「序号：开/关」）里只有一个开关，却占了一整条 40px 的横条；
// 把开关搬到顶栏、底栏整个删掉，`#grid` 是 `flex: 1; min-height: 0`，底栏一走它自动向下撑满
// （`#scenario-view` 的 10px 内边距保留，和左右上一致）→ 最下排面板的下边框就落到原底栏的位置。
//
// 为什么放 renderers.js（而不是改 index.html / renderer.js）：本文件随标题栏「⟳」重载 ⇒ **点 ⟳ 就生效，
// 不必重启 GUI**；改 `index.html` / `renderer.js` 是外壳，必须重启。与上面 decorateBrand /
// decorateScenarioIcons 同一个理由（renderer.js 里的注释也写着这条）。
// ⚠ 只**搬节点**、不新建按钮：renderer.js 里 `#sf-badges` 的 click 监听绑在按钮本体上，
//   `applyBadges()` 也是按 id 找它写文字（『序号：开/关』）——同一个节点搬过去，监听与文字更新都跟着走，
//   renderer.js 一行都不用改（改它就等于要重启）。幂等：重复执行只是再确认一次位置。
function moveSceneToggleToTopbar() {
  try {
    const btn = document.getElementById('sf-badges');
    if (btn) {
      const controls = document.querySelector('#titlebar .titlebar-controls');
      if (controls && !controls.contains(btn)) {
        btn.classList.remove('sf-btn');                       // 底栏的样式换成顶栏按钮的样式
        btn.classList.add('tb-btn', 'tb-tools', 'tb-badges');
        btn.title = '显示/隐藏窗口序号徽标（原底部菜单，已收进顶栏）';
        const ref = document.getElementById('btn-refresh');   // 排在「⟳ 刷新当前场景」右边（同为场景级操作）
        if (ref && ref.parentNode === controls) controls.insertBefore(btn, ref.nextSibling);
        else controls.insertBefore(btn, controls.firstChild);
        // 亮不亮跟着文字走（renderer.js 的 applyBadges 只改文字，不给状态）：开=高亮，关=普通
        const sync = function () {
          try { btn.dataset.on = /开/.test(btn.textContent) ? '1' : '0'; } catch (e) { /* ignore */ }
        };
        sync();
        btn.addEventListener('click', function () { setTimeout(sync, 0); });
      }
    }
    const footer = document.getElementById('scenario-footer');   // 底栏整个不要了
    if (footer && footer.parentNode) footer.parentNode.removeChild(footer);
  } catch (e) { /* 收纳失败不影响功能（最坏情况 = 还是原来那条底栏） */ }
}

/**
 * 2026-10-24（宿主：「把序号外观远程控制 放在⋯里」）——
 * 把这三个顶栏按钮藏起来（**只加 class，不删节点**）：
 *   ① renderer.js 的点击监听、`applyBadges()` 的文字同步都绑在节点本身上 ⇒ 节点必须留着；
 *   ② ⋯ 菜单里那三行就是替宿主 .click() 这个隐藏按钮 ⇒ 点一次走的是原来同一套逻辑，零改动；
 *   ③ 幂等：反复调用只是再确认一次 class。id 找不到（老外壳）就安静跳过。
 */
function hideMovedTopbarButtons() {
  try {
    ['btn-remote', 'btn-theme', 'sf-badges'].forEach(function (id) {
      var b = document.getElementById(id);
      if (!b) return;
      b.classList.add('tb-moved');
      b.setAttribute('data-moved-to', 'more-menu');
    });
  } catch (e) { /* 藏不掉就还是留在顶栏，不影响功能 */ }
}

/**
 * 自动装标签栏交互（不需要外壳配合）。
 * 为什么要这一段：外壳 renderer.js 里那次调用要**重启 GUI** 才生效，而热更新只重跑本文件。
 * 于是这里自己兜底：
 *   ① 把老外壳给标签设的 HTML5 `draggable` 摘掉 —— 它的 dragstart/drop 监听还在，但 draggable=false
 *      之后 dragstart 永远不会触发 ⇒ 老 DnD 自动失效，不会和新指针拖拽抢事件；
 *   ② 顺序照样能存：新外壳走主进程（setSceneOrder），老外壳退回 localStorage 的老 key
 *      （老外壳开机就读这个 key，所以**重启也不会复位**）。
 * 开机时标签可能还没建出来（外壳 init 是异步的）⇒ 由下面的轻量轮询补上，装好即停。
 */
// ===== 场景标签「正在工作」光效（2026-09-29 立；用户要求：场景的 AI 在跑要发光，它派子代理时也要亮）=====
// 数据源（不用动 main.js / preload.js，纯读文件）：
//   <DSH_HOME>\storages\session_projcache\sessions\<会话id>.json —— 引擎**按会话**实时写的状态缓存（明文 JSON）。
//   判定字段：record.rows.sessionStats.val.openStep（有值 = 有一步正开着 = 真在跑）+ pendingCalls（有在飞的工具调用）。
//   为什么不用"日志文件时间"：一次 LLM 步可能好几分钟不落盘，时间法会闪；openStep 全程为真。
//   （2026-09-29 实测：全机唯一在跑的会话 openStep={"turn":24,"step":13,…}，其余 171 条全是 null。）
//   子代理：父会话在等子代理时 openStep 一直开着 ⇒ **父场景标签照样亮** —— 正是用户要的"派出去也要有光效"。
//   子代理（2026-09-29 补齐）：父会话自己的记录里 `subagentCatalog.val.head.values[].childId` 就是它派出去的子会话 id
//     （引擎侧真身是会话 header 的 `parentSession`，但会话文件是 zstd 压缩的读不了；这个投影是明文，可直接读）
//     ⇒ 顺着它递归查子孙会话的在跑状态（最多两层）⇒ **父回合已结束、子代理还在跑时，父场景标签也亮** ✓
// 标签定位：#scenario-tabs .tab[data-sc-id="<场景id>"]；场景→面板 sessionId 用 app.listScenarios/getScenario 取，
//   60 秒刷一次映射（面板换了会话也能自动跟上）。
// ⚠ 幂等：⟳ 是热更新（本文件会被重新加载、DOM 不重载）⇒ 状态与计时器挂在 window.__dshSceneGlow 上，
//   每次重载只把 S.tick 指到新函数，**永远只有一个计时器**。
var GLOW_TICK_MS = 2500;
// 引擎用户数据目录（DSH_HOME）：**空 = 运行时从 app.getVersion().engineDir 推**（换电脑/换盘符都不用改这行），
// 老宿主没有 app:version 或它没带 engineDir 时退回下面这个兜底值。2026-10-12 为"拷给别人/换机开箱即用"改。
var GLOW_HOME = window.__dshGlowHome || '';
var GLOW_HOME_FALLBACK = __WB_ROOT + '\\引擎数据\\.dsh';
async function glowHome() {
  if (GLOW_HOME) return GLOW_HOME;
  try {
    var v = (window.app && window.app.getVersion) ? await window.app.getVersion() : null;
    if (v && v.engineDir) { GLOW_HOME = v.engineDir + '\\.dsh'; return GLOW_HOME; }
  } catch (e) { /* ignore */ }
  return GLOW_HOME_FALLBACK;
}
var GLOW_READ_WINDOW_S = 900;   // 状态文件 15 分钟没动过的会话连读都不读（一步不可能开 15 分钟）

function glowTabEl(sceneId) {
  var bar = document.getElementById('scenario-tabs');
  if (!bar) return null;
  return bar.querySelector('.tab[data-sc-id="' + sceneId + '"]');
}
async function glowMapRefresh(S) {
  if (Date.now() - (S.mapAt || 0) < 60000 && Object.keys(S.sidByScene || {}).length) return;
  if (!(window.app && window.app.listScenarios && window.app.getScenario)) return;
  var list = [];
  try { list = (await window.app.listScenarios()) || []; } catch (e) { return; }
  var map = {};
  for (var i = 0; i < list.length; i++) {
    var id = list[i] && list[i].id;
    if (!id) continue;
    try {
      var sc = await window.app.getScenario(id);
      map[id] = ((sc && sc.panels) || []).filter(function (p) { return p && p.sessionId; })
        .map(function (p) { return p.sessionId; });
    } catch (e) { /* ignore */ }
  }
  if (Object.keys(map).length) { S.sidByScene = map; S.mapAt = Date.now(); }
}
// 读一条会话的状态文件 ⇒ {busy, kids}
//   busy：openStep 非空（有一步开着）/ pendingCalls 非空（工具在飞）；**只有文件够新时才认**
//   子代理兜底：它自己是子代理（rows.subagent.identity 有值）且状态文件 ≤20 秒前刚写过 ⇒ 也算在跑
//     （子代理两步之间的缝隙可能既没 openStep 也没 pendingCalls，纯靠上面两条会闪）
//   kids：父会话记录里 subagentCatalog.val.head.values[].childId = 它派出去的子会话 id
//     ⚠ 即使父会话文件已经"不新"也要采 catalog —— 子代理长时间在跑时父会话自己是不写盘的
async function glowReadState(sid, wantCatalog) {
  var out = { busy: false, kids: [] };
  if (!(window.app && window.app.file && window.app.file.stat)) return out;
  var p = (await glowHome()) + '\\storages\\session_projcache\\sessions\\' + sid + '.json';
  var ageS = Infinity;
  try {
    var st = await window.app.file.stat(p);
    if (!st || !st.exists) return out;
    ageS = Date.now() / 1000 - (Number(st.mtime) || 0);
  } catch (e) { return out; }
  if (ageS > GLOW_READ_WINDOW_S && !wantCatalog) return out;
  try {
    var res = await window.app.file.read(p);
    var txt = (typeof res === 'string') ? res : (res && (res.text || res.data || res.content || res.body));
    if (!txt) return out;
    var rows = JSON.parse(txt).record.rows;
    var ss = rows && rows.sessionStats && rows.sessionStats.val;
    var isChild = !!(rows && rows.subagent && rows.subagent.val && rows.subagent.val.identity);
    if (ageS <= GLOW_READ_WINDOW_S && ss) {
      out.busy = !!(ss.openStep || (ss.pendingCalls && Object.keys(ss.pendingCalls).length));
      if (!out.busy && isChild && ageS <= 20) out.busy = true;
    }
    var cat = wantCatalog && rows && rows.subagentCatalog && rows.subagentCatalog.val;
    var vals = cat && cat.head && cat.head.values;
    if (Array.isArray(vals)) out.kids = vals.map(function (v) { return v && v.childId; }).filter(Boolean);
  } catch (e) { /* ignore */ }
  return out;
}
// 场景在跑 = 它自己的会话在跑 **或** 它派出去的子孙会话在跑（子代理干活时父场景标签也亮）
async function glowTick() {
  var S = window.__dshSceneGlow;
  if (!S) return;
  await glowMapRefresh(S);
  if (!S.kids) S.kids = {};
  // 每 60 秒重采一次"父会话 → 子会话"清单（顺带把子会话的子会话也收进来，最多两层）
  if (!S.watch || Date.now() - (S.watchAt || 0) > 60000) {
    var watch = [];
    Object.keys(S.sidByScene || {}).forEach(function (sc) { watch = watch.concat(S.sidByScene[sc] || []); });
    for (var pass = 0; pass < 2; pass++) {
      for (var w = 0; w < watch.length; w++) {
        var st = await glowReadState(watch[w], true);
        if (st.kids.length) {
          S.kids[watch[w]] = st.kids;
          st.kids.forEach(function (k) { if (watch.indexOf(k) < 0) watch.push(k); });
        }
      }
    }
    S.watch = watch; S.watchAt = Date.now();
  }
  var cache = {};
  async function busyOf(sid, seen) {
    if (sid in cache) return cache[sid];
    if (seen[sid]) return false;
    seen[sid] = 1;
    var st = await glowReadState(sid, false), busy = st.busy;
    var kids = S.kids[sid] || [];
    for (var i = 0; i < kids.length && !busy; i++) busy = await busyOf(kids[i], seen);
    cache[sid] = busy;
    return busy;
  }
  var ids = Object.keys(S.sidByScene || {});
  for (var n = 0; n < ids.length; n++) {
    var sids = S.sidByScene[ids[n]] || [], busy = false;
    for (var k = 0; k < sids.length && !busy; k++) busy = await busyOf(sids[k], {});
    var tab = glowTabEl(ids[n]);
    if (!tab) continue;                                    // 标签还没建出来 / 独立窗口里没有它
    if (busy === tab.classList.contains('tab-working')) continue;
    tab.classList.toggle('tab-working', busy);             // 只有状态变了才写 DOM，平时零开销
  }
}
// 幂等启动：状态与计时器挂 window.__dshSceneGlow ⇒ ⟳ 热更新后旧计时器跑的是新代码，永远只有一个计时器
function ensureSceneGlow() {
  var S = window.__dshSceneGlow = window.__dshSceneGlow || { sidByScene: {}, mapAt: 0 };
  S.tick = glowTick;
  if (!S.timer) {
    S.timer = setInterval(function () {
      try { (window.__dshSceneGlow && window.__dshSceneGlow.tick ? window.__dshSceneGlow.tick : function () {})(); }
      catch (e) { /* ignore */ }
    }, GLOW_TICK_MS);
  }
  try { S.tick(); } catch (e) { /* ignore */ }
}

function autoInitScenarioTabBar() {
  var nav = document.getElementById('scenario-tabs');
  if (!nav || !nav.querySelector('.tab')) return false;
  if (nav.getAttribute('data-tabbar') === TABBAR_VERSION) return true;   // 已装过（外壳那次也会命中这里）
  tabListOf(nav).forEach(function (t) { t.draggable = false; t.removeAttribute('draggable'); });
  var persist = function (ids) {
    try {
      if (window.app && window.app.setSceneOrder) window.app.setSceneOrder(ids);     // 新外壳：主进程是权威
      else localStorage.setItem('scenarioTabOrder', JSON.stringify(ids));            // 老外壳：老 key，重启能被读走
    } catch (e) { /* 存档失败不影响已经换好的位置 */ }
  };
  Promise.resolve(window.app && window.app.listScenarios ? window.app.listScenarios() : [])
    .then(function (list) {
      // 固定组（"first": true）从场景表里现取，跟外壳那次用同一份数据 ⇒ 规则一致
      var pinned = (list || []).filter(function (s) { return s && s.first; })
        .map(function (s) { return s.id; });
      initScenarioTabBar({ nav: nav, persist: persist, pinnedIds: pinned });
    })
    .catch(function () { initScenarioTabBar({ nav: nav, persist: persist, pinnedIds: [] }); });
  return true;
}
// 轮询只在"还没装上"时活着，装上就停；用 window 旗标防止 ⟳ 反复重载攒出多个定时器
function ensureScenarioTabBar() {
  if (autoInitScenarioTabBar()) return;
  if (window.__kunTabBarRetry) return;
  var tries = 0;
  window.__kunTabBarRetry = setInterval(function () {
    if (autoInitScenarioTabBar() || ++tries > 40) {   // 最多 ~12 秒，够外壳把标签建出来
      clearInterval(window.__kunTabBarRetry);
      window.__kunTabBarRetry = null;
    }
  }, 300);
}
function decorateShell() {
  // 标签栏放**最前**：上面这些装饰函数任何一个抛错都会截断本函数，而标签栏交互不能因此装不上。
  try { ensureScenarioTabBar(); } catch (e) { /* 装不上就是"老样子"，不影响别的功能 */ }
  try { ensureSceneGlow(); } catch (e) { /* 光效装不上就只是没有光效，不影响别的功能 */ }
  decorateBrand();
  decorateToolbarIcons();
  decorateScenarioIcons();
  decorateWebAi();          // 顶栏五个网页版 AI 图标 + 预热（⟳ 重跑幂等）
  moveSceneToggleToTopbar();
  hideMovedTopbarButtons(); // 2026-10-24：序号 / 外观 / 远程控制 已收进 ⋯ ⇒ 顶栏这三个按钮藏起来
  widenMainHarnessView();
}
// 脚本在 </body> 前加载 → DOM 已就绪；万一以后挪进 head，这里也能补上
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', decorateShell, { once: true });
} else {
  decorateShell();
}


// 场景分离窗口（主进程 loadFile 时带 ?solo=1&scene=<id>）里的引擎界面分区。
// ⚠ 2026-09-19 三次定稿：AI 面板**不再**共用这个分区了，一律走 panelPartition（见下）。
// 这个函数现在只服务"没带 sessionId 的面板"：主窗口退回 persist:harness，
// 分离窗口必须"一窗一分区"（否则两个窗口互相改写 localStorage['dsh.sessions.current']，
// 引擎用它记住"上次会话"，会把对方带到别的会话去）。
function soloHarnessPartition() {
  try {
    var q = new URLSearchParams(location.search);
    if (!q.get('solo')) return 'persist:harness';
    var sid = String(q.get('scene') || 'x').replace(/[^a-zA-Z0-9_-]/g, '');
    return 'persist:harness-solo-' + (sid || 'x');
  } catch (e) { return 'persist:harness'; }
}

// ★每个 AI 面板用哪个分区★ 2026-09-19 三次定稿（这一次是探针实测定的，别再往回合）：
// 引擎事实：面板显示哪个会话，取决于应用启动时从 localStorage['dsh.sessions.current'] 恢复的那一个
// （packages/api/session-controller/src/client/sessions/service.ts 的 persist 名），
// 而**一个分区里只有这一个键**——它不区分标签、不区分面板。
//   结论一：两个面板**共用**一个分区 ⇒ 那个键只能表示"最后动过的那个面板" ⇒ 谁也没法被稳定钉住
//     （用户实感：「切过来是别的会话」「左右两个窗口都变成同一个会话」）。
//   结论二（2026-09-19 探针实测，**推翻**旧结论）：全新分区里"写好这个键 + reload"是**能直接进会话的**——
//     隐藏 Electron + 真引擎实测（<盘根>:\DSH\工具\probe-seed\）：写入目标 sessionId 后 reload，
//     1.4 秒后 document.title 就变成目标会话、正文 231 → 23031 字符、不再停欢迎页。
//     旧注释里"新分区只能停在欢迎页"是**看太早**造成的误判（那次快照在 reload 后 1 秒内就下了结论）。
//   ✓ 所以最终方案：**一板一分区**（panelPartition）＋ 每个面板往**自己的**键里写目标 id、reload 一次。
//     分区私有 ⇒ 两边写的是两个不同的 localStorage ⇒ 互抢/互刷在结构上不可能（"每隔一会跳一下刷新"不会再有）。
//   ✓ 代价：每个面板**第一次**打开会先闪一下欢迎页（约 1–2 秒）再 reload 到位；之后键里已经是目标 ⇒ 直接进、不再 reload。
function panelPartition(meta) {
  try {
    var solo = false, sid = '';
    try {
      var q = new URLSearchParams(location.search);
      solo = !!q.get('solo');
      sid = String(q.get('scene') || '').replace(/[^a-zA-Z0-9_-]/g, '');
    } catch (e) { solo = false; sid = ''; }
    var key = String((meta && meta.id) || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (meta && meta.sessionId && key) {
      // ① 带 sessionId（scenarios/*.json 里所有 AI 面板都必须带，见 scripts\sessions.mjs --check）：
      //    一板一分区；分离窗口再带上场景名，避免"同场景开两个窗口"时两个窗口共用一个分区。
      return solo ? ('persist:harness-panel-' + (sid || 'x') + '-' + key) : ('persist:harness-panel-' + key);
    }
    // ② 没带 sessionId：主窗口共用 persist:harness；分离窗口退回一窗一分区。
    return soloHarnessPartition();
  } catch (e) { return 'persist:harness'; }
}
