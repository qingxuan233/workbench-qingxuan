// 工作台 — 渲染层主逻辑（多场景版）
// 场景 0：DSH 引擎（默认初始界面，webview 内嵌，带 token）
// 场景 1..N：本地场景（scenarios/*.json 配置 + renderers 分发）
// 顶层声明一律用 var：刷新按钮会带时间戳重复加载本文件，const/let 重复声明会直接报错导致热更新失效

// 本机工作台根（2026-11-01）：由页面自身路径推导，替代原来写死的「<工作台>」。
// 页面固定在 <根>\外壳\renderer\index.html ⇒ location 里就带着真根，换机不需要改任何代码。
var __WB_ROOT = (function () {
  try {
    var q = decodeURIComponent(String(location.pathname || '')).replace(/^\//, '').replace(/\//g, '\\');
    var m = q.match(/^(.*)\\外壳\\renderer\\/i);
    if (m && m[1]) return m[1];
  } catch (e) { /* ignore */ }
  if (window.console) console.warn('[工作台] 推不出本机根，依赖根的兜底路径将不可用');
  return '';
})();
'use strict';

var ENGINE_ADAPTER = (typeof window !== 'undefined' && window.__WB_ENGINE_ADAPTER) || null;   // P2：契约单一实现；index.html 须先加载 外壳/engine-adapter/contract.js

var el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// ---------- 主题感知：画布本身透明（clearRect），底色来自 CSS ----------
// 浅色主题下"白色前景"（十字线等）必须反转成深色，否则在浅底上看不见
function isLightTheme() {
  try { return document.documentElement.dataset.theme === 'light'; } catch (e) { return false; }
}
// 画布前景色：深色主题 → 白系；浅色主题 → 深灰蓝系

// ---------- 多公司模板：把"当前场景 id"告知主进程（幂等，仅在变化时发 IPC）----------
// 场景 json 的 meta 可覆盖：ssh / svc / paths / mappings / logs / urls / pinTarget
// meta 缺省时主进程全部回落 oa.db 全局配置 → 原有场景行为不变
var oaScenarioSynced = null;
var oaSyncScenario = (meta) => {
  const sid = (meta && meta.scenario) || 'oa-ops';
  if (sid === oaScenarioSynced) return sid;
  oaScenarioSynced = sid;
  try {
    const K = window.app && window.app.oa;
    if (K && K.setScenario) K.setScenario(sid);
  } catch (e) { /* ignore */ }
  return sid;
};

// ---------- 面板轮询助手（省流量：不可见即暂停，恢复可见立刻刷新一次）----------
// 背景：每个面板的采集都要新起 Python + SSH 连接（约 0.3s CPU + 一次握手）。
// 原间隔（dash 15s / logs 6s / files 20s / web 15s）合计约 1200 次 SSH/小时，属明显浪费。
// 现规则：间隔放大到 30~60s + 主进程 TTL 缓存 + 窗口不可见（最小化/切走）时完全停轮询。
var oaPoll = (intervalMs, fn) => {
  let timer = null, stopped = false;
  const start = () => { if (timer === null && !stopped) timer = setInterval(fn, intervalMs); };
  const stop = () => { if (timer !== null) { clearInterval(timer); timer = null; } };
  const onVis = () => {
    if (document.hidden) { stop(); return; }
    try { fn(); } catch (e) { /* ignore */ }   // 回到可见 → 立即补一次
    start();
  };
  document.addEventListener('visibilitychange', onVis);
  if (!document.hidden) start();
  return () => { stopped = true; stop(); document.removeEventListener('visibilitychange', onVis); };
};

// ---------- 工具 ----------
function mktColor(v) {
  if (v == null) return '';
  // 兼容 "+0.52%" / "-0.30%" / "-4.23" / 数值等格式
  const n = Number(String(v).replace(/[+%]/g, ''));
  if (n > 0) return '#e5484d';   // A股红涨
  if (n < 0) return '#2ebd85';   // A股绿跌
  return '';
}

// ---------- 面板渲染器（本地场景用） ----------
// P2-D：注册对象改为**共享**（index.html 先加载的 panels/panel-pc-drives.js 已建好 window.APP_RENDERERS）
var renderers = window.APP_RENDERERS || (window.APP_RENDERERS = {});

// ---------- 面板「展开到最高 / 收起」（AI 助手面板用）----------
// 需求：点标题栏中间的箭头 → 该面板高度直接占满整个场景（盖住其它面板），
//       其它面板位置**完全不动**；箭头翻转，再点收回原状。
// 关键点：面板本来是 grid item，直接改成 absolute 会让其余面板**回流跑位**，
//        所以展开前先在原位置插一个「占位格」（同 grid-column/grid-row），把版面钉住。
// 动效：以「原格子几何 → 满高几何」在 top/height 上做 CSS 过渡（320ms），配青色描边高亮、
//        自上而下的扫描光带、以及压暗其它面板的聚焦层。
//        ⚠ 刻意不用 transform 缩放：面板里是 <webview>，guest view 对祖先 transform 跟随不稳，
//          而展开时只有高度/纵向位置在变（宽度不变），top/height 过渡的重排成本很低。
// 展开中的面板（**可以同时展开多个**：2026-09-20 用户要求"两个 AI 窗口能同时展开"）。
// 顺序 = 展开先后，用来定 z-index（后展开的压住先展开的）和 ESC 的退栈顺序。
// 元素形如 { wrap, slot, btn, onResize, onKey, backdrop }
var panelExpandStates = [];
var panelExpandZ = 60;         // 展开面板的 z-index 基数，每展开一个 +1
var PANEL_ANIM_MS = 320;

function panelMotionOff() {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
}

// 把面板从「当前几何」过渡到 toRect（fixed 定位下改 top/left/width/height），结束后回调 done
function animatePanelBox(wrap, toRect, done) {
  wrap.classList.add('panel-anim');
  void wrap.offsetWidth;   // 强制回流：保证起始帧先落地，过渡才会跑
  wrap.style.left = Math.round(toRect.left) + 'px';
  wrap.style.top = Math.round(toRect.top) + 'px';
  wrap.style.width = Math.round(toRect.width) + 'px';
  wrap.style.height = Math.round(toRect.height) + 'px';
  var finished = false;
  var finish = function () {
    if (finished) return;
    finished = true;
    try { wrap.classList.remove('panel-anim'); } catch (e) { /* ignore */ }
    wrap.removeEventListener('transitionend', onEnd);
    if (done) done();
  };
  var onEnd = function (e) { if (e.target === wrap && e.propertyName === 'height') finish(); };
  wrap.addEventListener('transitionend', onEnd);
  setTimeout(finish, PANEL_ANIM_MS + 140);   // 兜底：transitionend 偶发不触发
}

// 找到某个面板的展开状态（没展开 = null）
function expandedStateOf(wrap) {
  for (var i = 0; i < panelExpandStates.length; i++) {
    if (panelExpandStates[i].wrap === wrap) return panelExpandStates[i];
  }
  return null;
}

// 收起：`collapsePanel(wrap)` 只收这一个；`collapsePanel()` 不带参数 = 全收（切场景时 renderer.js 用的就是这种）。
function collapsePanel(wrap) {
  if (!panelExpandStates.length) return;
  var targets = wrap ? panelExpandStates.filter(function (s) { return s.wrap === wrap; })
                     : panelExpandStates.slice();
  if (!targets.length) return;
  // 逆序收（后展开的先收），动画重叠时视觉更像"退栈"
  for (var i = targets.length - 1; i >= 0; i--) collapseOne(targets[i]);
}

function collapseOne(st) {
  if (!st) return;
  var at = panelExpandStates.indexOf(st);
  if (at >= 0) panelExpandStates.splice(at, 1);
  try {
    const wrap = st.wrap;
    // 目标几何 = 占位格（原格子）；占位格在展开期间一直钉着，所以这里能直接量到
    let toRect = null;
    try { if (st.slot && st.slot.parentNode) toRect = st.slot.getBoundingClientRect(); } catch (e) { toRect = null; }
    if (st.btn) { st.btn.textContent = '▲'; st.btn.title = '展开到最高（再点一次收起）'; }
    window.removeEventListener('resize', st.onResize);
    document.removeEventListener('keydown', st.onKey, true);
    if (st.backdrop) {
      const b = st.backdrop;
      try { b.classList.remove('on'); } catch (e) { /* ignore */ }
      setTimeout(function () { try { if (b.parentNode) b.parentNode.removeChild(b); } catch (e) { /* ignore */ } }, PANEL_ANIM_MS + 60);
    }
    const reset = function () {
      try {
        wrap.classList.remove('panel-expanded');
        wrap.classList.remove('panel-anim');
        wrap.style.position = '';
        wrap.style.zIndex = '';
        wrap.style.left = '';
        wrap.style.top = '';
        wrap.style.width = '';
        wrap.style.height = '';
        if (st.slot && st.slot.parentNode) st.slot.parentNode.removeChild(st.slot);
      } catch (e) { /* ignore */ }
    };
    // 收起同理：贴底冻结 → 缩短动画 → 解冻（内容不会来回跳）
    if (toRect && wrap.isConnected && !panelMotionOff()) {
      const unfreeze = freezePanelWebviews(wrap);
      animatePanelBox(wrap, toRect, function () { try { unfreeze(); } catch (e) { /* ignore */ } reset(); });
    } else {
      reset();
    }
  } catch (e) { /* ignore */ }
}

// 展开/收起时把面板里的 <webview> **贴底冻结**（尺寸不变 + 底边钉住容器底边）。
//
// 为什么这么做：面板展开是「下边缘不动、上边缘往上长」。若让 webview 跟着逐帧长高，
// guest（DSH 对话页，独立进程）会每帧重排 → 内容抖。冻结后 guest 全程只重排 1 次。
//
// ⚠⚠ 必须用 absolute + bottom:0 钉底，**不能**用 flex 的 margin-top:auto：
//    收起时容器会变得比冻结高度更矮，flex 在「负剩余空间」下会把 auto 边距当 0，
//    元素被顶到上方、底部被裁 → 贴底的输入框整块消失，解冻后才跳回来（踩过的坑）。
//    绝对定位 + bottom:0 则始终以底边对齐容器底边，超出部分从**上方**被裁 →
//    输入框全程可见，展开/收起都不跳。
function freezePanelWebviews(wrap) {
  const list = [];
  try {
    wrap.querySelectorAll('webview').forEach(function (wv) {
      const h = Math.round(wv.getBoundingClientRect().height);
      if (!h) return;
      const body = wv.parentElement;
      let changedBodyPos = false;
      if (body) {
        try {
          if (getComputedStyle(body).position === 'static') { body.style.position = 'relative'; changedBodyPos = true; }
        } catch (e) { /* ignore */ }
      }
      list.push({ wv: wv, body: body, changedBodyPos: changedBodyPos });
      wv.style.position = 'absolute';
      wv.style.left = '0';
      wv.style.right = '0';
      wv.style.bottom = '0';
      wv.style.height = h + 'px';
      wv.style.flex = 'none';
    });
  } catch (e) { /* ignore */ }
  if (!list.length) return function () { };
  return function unfreeze() {
    list.forEach(function (it) {
      try {
        const wv = it.wv;
        wv.style.position = '';
        wv.style.left = '';
        wv.style.right = '';
        wv.style.bottom = '';
        wv.style.height = '';
        wv.style.flex = '';
        if (it.changedBodyPos && it.body) it.body.style.position = '';
      } catch (e) { /* ignore */ }
    });
  };
}

function expandPanel(wrap, btn) {
  const gridEl = wrap.parentElement;
  if (!gridEl) return;
  if (expandedStateOf(wrap)) return;   // 已经展开了，别重复插占位格
  // ★ 2026-09-20：**不再"同时只允许展开一个"**（原来这里有一句 collapsePanel()）。
  //   现在可以多个面板并排同时展开（用户要求：自我复盘的两个 AI 窗口都要能展开）。
  //   同一列/同一片区域的两个面板同时展开会互相盖住 —— 靠 z-index 定序：后展开的压在上面；
  //   ⚠ 被完全盖住的那个面板，标题行的 ▲ 会点不到，得先收掉上面那个（横向并排的场景没这个问题）。
  try {
    const from = wrap.getBoundingClientRect();   // ① 原格子几何
    // ② 占位：同坐标同跨度的空格子，保证其它面板不动
    const slot = el('div', 'panel-slot');
    slot.style.gridColumn = wrap.style.gridColumn;
    slot.style.gridRow = wrap.style.gridRow;
    gridEl.insertBefore(slot, wrap);
    // ③ 目标几何：横向保持原位置与原宽度（以占位格为准），高度占满整格。
    //    ⚠ 必须用 position:fixed + 视口坐标：
    //    带 grid-column/grid-row 的网格项改成 absolute 后，**包含块是它自己那一格网格区**
    //    而不是整个网格 —— 用"相对网格的偏移"会再叠加一次格子起点，导致面板右移/下移一格
    //    （现象：面板"脱离场景"、跑到别的列还超出底边）。
    const g = gridEl.getBoundingClientRect();
    const s = slot.getBoundingClientRect();
    const to = { left: s.left, top: g.top, width: s.width, height: g.height };
    // ④ 先落到「起点」：fixed + 原格子几何（此刻不动画）
    wrap.style.position = 'fixed';
    wrap.style.zIndex = String(++panelExpandZ);   // 后展开的压住先展开的
    wrap.style.left = Math.round(from.left) + 'px';
    wrap.style.top = Math.round(from.top) + 'px';
    wrap.style.width = Math.round(from.width) + 'px';
    wrap.style.height = Math.round(from.height) + 'px';
    wrap.classList.add('panel-expanded');
    // ⑤ 聚焦层（全屏压暗 + 青色渐变）**已按用户要求关闭**：
    //    "光效要围绕着窗口，不是全屏都有" → 现在只保留环绕面板的常驻光环（见 styles.css 的 .panel-expanded）。
    //    想恢复全屏压暗：把下面三行取消注释即可（.grid-backdrop 的 CSS 仍在）。
    // const backdrop = el('div', 'grid-backdrop');
    // gridEl.appendChild(backdrop);
    // requestAnimationFrame(function () { try { backdrop.classList.add('on'); } catch (e) { /* ignore */ } });
    const backdrop = null;
    // ⑥ 过渡到满高：动画期间**贴底冻结** webview（内容原地不动、只重排 1 次），
    //    动画结束解冻 → 新增高度全部出现在输入框上方，看起来就是"展开显示上面的信息"。
    if (panelMotionOff()) {
      wrap.style.left = Math.round(to.left) + 'px';
      wrap.style.top = Math.round(to.top) + 'px';
      wrap.style.width = Math.round(to.width) + 'px';
      wrap.style.height = Math.round(to.height) + 'px';
    } else {
      const unfreeze = freezePanelWebviews(wrap);
      animatePanelBox(wrap, to, unfreeze);
    }
    btn.textContent = '▼';
    btn.title = '收起（恢复原来的高度）';
    // ⑦ 窗口尺寸变化时重新贴合（不带动画）；ESC 收起**最上层那个**（连按 = 逐个退栈）；
    //    面板若已被移出文档则自动清理（只清自己，别把别的面板一起收了）
    const onResize = () => {
      if (!wrap.isConnected) { collapsePanel(wrap); return; }
      try {
        wrap.classList.remove('panel-anim');
        const g2 = gridEl.getBoundingClientRect();
        const s2 = slot.getBoundingClientRect();
        wrap.style.left = Math.round(s2.left) + 'px';
        wrap.style.top = Math.round(g2.top) + 'px';
        wrap.style.width = Math.round(s2.width) + 'px';
        wrap.style.height = Math.round(g2.height) + 'px';
      } catch (e) { /* ignore */ }
    };
    const onKey = (e) => {
      if (!wrap.isConnected) { collapsePanel(wrap); return; }
      // 多个面板同时展开时，ESC 只收最上层那个（= 最后展开的），再按一次收下一个
      if (e.key === 'Escape' && panelExpandStates[panelExpandStates.length - 1] === st) collapsePanel(wrap);
    };
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onKey, true);
    const st = { wrap, slot, btn, onResize, onKey, backdrop };
    panelExpandStates.push(st);
  } catch (e) { /* 展开失败就保持原状 */ }
}

function panelHead(title, sub) {
  const head = el('div', 'panel-head');
  head.appendChild(el('span', 'panel-title', title));
  if (sub) head.appendChild(el('span', 'panel-sub', sub));
  return head;
}

function makePanel(meta, idx) {
  const wrap = el('section', 'panel');
  // 面板元素上挂一份 meta：拖拽结束后的「排格 + 补洞」（packAutoGrid）要按它算坐标与跨度
  wrap.__meta = meta;
  // 显式坐标（meta.col/meta.row）+ 尺寸：合并成完整简写（如 "2 / span 3"）。
  // 注意：不能先设 gridRow="span N" 再覆盖 gridRowStart —— start 覆盖后 end 变 auto，高度会塌成 1 行。
  wrap.style.gridColumn = (meta.col ? meta.col + ' / span ' : 'span ') + (meta.w || 2);
  wrap.style.gridRow = (meta.row ? meta.row + ' / span ' : 'span ') + (meta.h || 2);
  wrap.dataset.panelId = meta.id;
  const head = panelHead(meta.title, meta.sub || '');
  // 面板序号徽标（方便用户指定要修改哪个窗口）——两位补零，配合 .panel-badge 科技感样式
  const badge = el('span', 'panel-badge', String(idx + 1).padStart(2, '0'));
  badge.title = '面板序号';
  head.insertBefore(badge, head.firstChild);
  // 「展开到最高」箭头：AI 面板（harness）默认就有；别的类型想有就在场景 json 里写 "expand": true
  // （放标题**右边**、不居中——居中会撞上右侧的重新加载按钮/引擎状态字，Blender 面板尤其明显）。
  // 展开逻辑与本按钮无关（expandPanel 是通用的：占位格 + position:fixed 撑满整个网格高度），
  // 所以 embed 这类面板一样能"向上展开"：动画期间 webview 贴底冻结，新增高度出现在内容上方。
  if (meta.type === 'harness' || meta.expand) {
    const exp = el('button', 'panel-expand', '▲');
    exp.type = 'button';
    exp.title = '展开到最高（再点一次收起）';
    exp.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (expandedStateOf(wrap)) collapsePanel(wrap);
      else expandPanel(wrap, exp);
    });
    const titleEl = head.querySelector('.panel-title');
    if (titleEl && titleEl.nextSibling) head.insertBefore(exp, titleEl.nextSibling);
    else head.appendChild(exp);
  }
  wrap.appendChild(head);
  const body = el('div', 'panel-body');
  body.dataset.kind = meta.type;
  wrap.appendChild(body);
  // 自由拖拽缩放已取消（用户要求固定布局）；attachResize 定义保留备用
  // if (!meta.fixed) attachResize(wrap, meta);
  return { wrap, body, head };
}

// ---------- 面板自由拖拽调大小（四边/四角，相邻上下左右可调） ----------
// 调节上限 = 整个工作区（#grid）大小：宽不超过总列数，高不超过网格总行数
var GRID_COLS = 4;   // 与 #grid 的 grid-template-columns 一致（总窗口列数；场景 json 可用 cols 覆写）

// 当前场景实际的网格列数：renderer.js 会按场景 json 的 cols 覆写 #grid 的内联 grid-template-columns。
function gridColsOf(gridEl) {
  try {
    const t = ((gridEl || document.getElementById('grid')).style.gridTemplateColumns || '');
    const m = /repeat\(\s*(\d+)/.exec(t);
    if (m) return Math.max(1, parseInt(m[1], 10));
  } catch (e) { /* ignore */ }
  return GRID_COLS;
}

// 网格总行数（所有面板 meta.row + meta.h 的最大值）。
function gridRowCount(gridEl) {
  const grid = gridEl || document.getElementById('grid');
  if (!grid) return 1;
  let rows = 1;
  Array.prototype.forEach.call(grid.children, function (p) {
    const m = p && p.__meta;
    if (!m || !m.row) return;
    rows = Math.max(rows, (Number(m.row) || 1) + (Number(m.h) || 2) - 1);
  });
  return Math.max(1, rows);
}

// 一格的实际像素宽度 / 高度：把鼠标位移换算成"格"。
// 优先按面板自身尺寸推算（最准）；面板还没排好时（clientWidth/Height 为 0）退回按网格实测算 ——
// 分母是 0 会让一次轻拖直接跨好几格（2026-09-26：独立窗口里 AI 面板被拖成整行宽就是这个坑）。
function gridCellW(panel) {
  try {
    const m = panel && panel.__meta;
    if (m && m.w && panel.clientWidth > 24) return panel.clientWidth / m.w;
  } catch (e) { /* ignore */ }
  const grid = document.getElementById('grid');
  if (!grid) return 200;
  const gap = parseFloat(getComputedStyle(grid).columnGap) || 10;
  const cols = gridColsOf(grid);
  return Math.max(30, (grid.getBoundingClientRect().width - gap * (cols - 1)) / cols);
}

function gridCellH(panel) {
  try {
    const m = panel && panel.__meta;
    if (m && m.h && panel.clientHeight > 24) return panel.clientHeight / m.h;
  } catch (e) { /* ignore */ }
  const grid = document.getElementById('grid');
  if (!grid) return 100;
  const gap = parseFloat(getComputedStyle(grid).rowGap) || 10;
  const rows = gridRowCount(grid);
  return Math.max(24, (grid.getBoundingClientRect().height - gap * (rows - 1)) / rows);
}

// ---------- 纯自动流场景的排格器：紧凑首适配 + 拉伸补洞 ----------
// 背景（2026-09-26 用户截图）：json 里一个 col/row 都没写的场景（当前只有 oa-ops）原本交给 CSS 自动流排，
//   而 CSS 的规则是"这一排放不下就往下挪" —— 把 AI 面板拖成整行宽（4 列）后，第 3-4 行（列 1 被
//   「网址」这个 1 列 2 行的面板占着）放不下它 ⇒ AI 面板被挪到第 5-6 行，第 3-4 行列 2-4 空成一个大洞，
//   网格也从 4 行变 6 行 ⇒ 每行只剩 1/6 高，**所有面板一起被压扁、内容被裁**（服务器状态/操作日志/本地文件全截断）。
// 做法：自己按 DOM 顺序做紧凑首适配（等价 CSS 稀疏自动流），排完再把"每条行带右侧空出来的格子"
//   拉伸给该带上的面板 ⇒ 拖大拖小都不留空洞；拖拽期间面板按 meta.col 原地改大小，不再整场洗牌。
// 幂等：只处理"没有 col/row，或由本函数排过（__autoPacked）"的面板，每次从 meta.w/meta.h 重算；
//   拉伸出来的宽度**不写回 meta.w**（只影响本次显示），所以把面板拖回原样时布局能自己复原。
function packAutoGrid(grid) {
  grid = grid || document.getElementById('grid');
  if (!grid) return;
  // 顺手清掉残留的"展开占位格"：正常收起时就删了，热更新/异常时可能留下一个透明空格子（看不见但占着格子）
  Array.prototype.forEach.call(grid.querySelectorAll('.panel-slot'), function (s) {
    let owned = false;
    for (let i = 0; i < panelExpandStates.length; i++) if (panelExpandStates[i].slot === s) { owned = true; break; }
    if (!owned) { try { s.parentNode.removeChild(s); } catch (e) { /* ignore */ } }
  });
  const cols = gridColsOf(grid);
  const kids = Array.prototype.filter.call(grid.children, function (n) {
    return n && n.classList && n.classList.contains('panel') && n.__meta;
  });
  if (!kids.length) return;
  for (let i = 0; i < kids.length; i++) {
    const m = kids[i].__meta;
    if ((Number(m.col) || 0) > 0 && !m.__autoPacked) return;   // 有手写坐标 = 设计好的布局，一个字都别动
  }
  const occ = Object.create(null);
  const mark = function (r, c, w, h, v) {
    for (let i2 = r; i2 < r + h; i2++) for (let j = c; j < c + w; j++) occ[i2 + ',' + j] = v;
  };
  const free = function (r, c, w, h) {
    for (let i2 = r; i2 < r + h; i2++) for (let j = c; j < c + w; j++) if (occ[i2 + ',' + j]) return false;
    return true;
  };
  const placed = [];
  let cursor = 0;   // 线性游标（行主序）——等价 CSS 稀疏自动流：每块从"上一块的位置"接着找
  for (let i = 0; i < kids.length; i++) {
    const meta = kids[i].__meta;
    const w = Math.max(1, Math.min(cols, Number(meta.w) || 2));
    const h = Math.max(1, Number(meta.h) || 2);
    for (let idx = cursor, guard = 0; guard < 10000; idx++, guard++) {
      const r = Math.floor(idx / cols), c = idx % cols;
      if (c + w > cols) { cursor = (r + 1) * cols; idx = cursor - 1; continue; }
      if (free(r, c, w, h)) {
        mark(r, c, w, h, 1);
        placed.push({ el: kids[i], meta: meta, r: r, c: c, w: w, h: h });
        cursor = idx;
        break;
      }
    }
  }
  // 补洞：某面板右侧、在它自己跨的每一行里都空着 ⇒ 拉到最后一列（宽度只影响显示，不写回 meta.w）
  for (let q = 0; q < placed.length; q++) {
    const it = placed[q];
    let ok = true;
    for (let rr = it.r; rr < it.r + it.h && ok; rr++) {
      for (let cc = it.c + it.w; cc < cols; cc++) if (occ[rr + ',' + cc]) { ok = false; break; }
    }
    if (!ok) continue;
    const grow = cols - it.c;
    if (grow > it.w) { mark(it.r, it.c, it.w, it.h, 0); it.w = grow; mark(it.r, it.c, it.w, it.h, 1); }
  }
  for (let z = 0; z < placed.length; z++) {
    const it = placed[z];
    it.meta.col = it.c + 1; it.meta.row = it.r + 1; it.meta.__autoPacked = 1;
    it.el.style.gridColumn = (it.c + 1) + ' / span ' + it.w;
    it.el.style.gridRow = (it.r + 1) + ' / span ' + it.h;
  }
}
function attachResize(wrap, meta) {
  // 8 个方向手柄：n/s/e/w/ne/nw/se/sw（透明热区，无可见角标）
  const HANDLES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
  const handles = {};
  HANDLES.forEach(dir => {
    const h = el('div', 'panel-handle p-h-' + dir);
    h.title = '拖拽调整大小';
    wrap.appendChild(h);
    handles[dir] = h;
  });

  let drag = null;   // { dir, startX, startY, curW, curH, maxRows }

  // 当前网格总行数：所有面板占据的最大行范围（拖拽起点快照，作为高度上限）
  const gridRows = () => {
    const grid = document.getElementById('grid');
    if (!grid) return 1;
    const panels = grid.querySelectorAll('.panel');
    if (!panels.length) return 1;
    const rowH = panels[0].offsetHeight || 100;
    let maxBottom = 0;
    panels.forEach(p => { maxBottom = Math.max(maxBottom, p.offsetTop + p.offsetHeight); });
    return Math.max(1, Math.round(maxBottom / rowH));
  };

  const apply = (w, h) => {
    // ⚠ 必须保留显式锚点（meta.col/meta.row）：原来这里写死 `span N`，一拖就把面板变成"自动流"，
    //   整个场景重新洗牌（面板乱跳、留空洞、行数变多把所有面板压扁）——与 makePanel 里的写法保持一致。
    const col = Number(meta.col) || 0, row = Number(meta.row) || 0;
    // 宽度不能越过最后一列：越过会生出隐式列（按内容宽排）⇒ 整场比例全乱（renderer.js 里有同样的兜底告警）。
    const cols = gridColsOf(document.getElementById('grid'));
    const maxW = col ? Math.max(1, cols - col + 1) : cols;
    w = Math.max(1, Math.min(maxW, Math.round(w) || 1));
    h = Math.max(1, Math.round(h) || 1);
    wrap.style.gridColumn = (col ? col + ' / span ' : 'span ') + w;
    wrap.style.gridRow = (row ? row + ' / span ' : 'span ') + h;
    meta.w = w; meta.h = h;   // 记住，切换场景回来保持
  };

  const startDrag = (dir, e) => {
    e.preventDefault();
    e.stopPropagation();
    drag = {
      dir,
      startX: e.clientX,
      startY: e.clientY,
      curW: Math.min(meta.w || 2, GRID_COLS),
      curH: meta.h || 2,
      maxRows: gridRows()   // 快照总窗口行数，拖拽过程高度不超它
    };
    wrap.classList.add('resizing');
    // 对应方向的光标
    const cursors = {
      n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
      ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize'
    };
    document.body.style.cursor = cursors[dir] || 'default';
  };

  HANDLES.forEach(dir => {
    handles[dir].addEventListener('mousedown', (e) => startDrag(dir, e));
  });

  // rAF 节流：保证拖拽丝滑（60fps 跟随鼠标，不卡顿）
  let raf = null;
  window.addEventListener('mousemove', (e) => {
    if (!drag || raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      // 每列/每行像素：走 gridCellW/H（面板自身尺寸为 0 时自动退回按网格实测），
      // 避免"分母是 0 ⇒ 一次轻拖跨好几格"（独立窗口里 AI 面板被拖成整行宽的真凶）
      const cellW = gridCellW(wrap);
      const cellH = gridCellH(wrap);
      let nextW = drag.curW, nextH = drag.curH;
      const d = drag.dir;
      // 整数格步进（CSS grid span 只支持整数）+ rAF 节流保证跟手不卡顿
      if (d.includes('e')) nextW = Math.round(drag.curW + dx / Math.max(cellW, 1));
      if (d.includes('w')) nextW = Math.round(drag.curW - dx / Math.max(cellW, 1));
      if (d.includes('s')) nextH = Math.round(drag.curH + dy / Math.max(cellH, 1));
      if (d.includes('n')) nextH = Math.round(drag.curH - dy / Math.max(cellH, 1));
      // 上限 = 总窗口大小（宽 ≤ 总列数，高 ≤ 总行数）；下限 = 1 格
      nextW = Math.max(1, Math.min(GRID_COLS, nextW));
      nextH = Math.max(1, Math.min(drag.maxRows, nextH));
      if (nextW !== drag.curW || nextH !== drag.curH) {
        drag.curW = nextW; drag.curH = nextH;
        apply(nextW, nextH);
      }
    });
  });

  window.addEventListener('mouseup', () => {
    if (!drag) return;
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    drag = null;
    wrap.classList.remove('resizing');
    document.body.style.cursor = '';
    // 拖完立刻"整理"：这次改大小留下的空格子会被拉伸补掉（纯自动流场景，见 packAutoGrid）
    try { packAutoGrid(document.getElementById('grid')); } catch (e) { /* ignore */ }
  });
}

// ══ 演示脱敏（2026-09-27 用户要求）：录屏时实例名/公网地址不该露全，点「眼睛」一键遮住中间 ══
// ⚠ 这里**必须是一个函数，不能是顶层 `const OA_MASK_KEY = '…'`**（2026-09-27 多画布那批改的）：
//   本文件是热更新的 —— 点 ⟳ 会在**同一个全局上下文**里把整份脚本重新求值一次，
//   顶层 const/let（以及**同名** var）会和上一次那份留下的词法绑定撞车 ⇒
//   "Identifier 'OA_MASK_KEY' has already been declared" ⇒ 整份脚本不执行、⟳ **静默失效**
//   （Chromium 对"脚本解析失败"不发 script.onerror，壳那边连"渲染器热更新失败"都不会报，最坑的一种坏法）。
//   函数声明可以重复求值（var 语义），所以 key 走函数取；**改这一处前先看 check-gui 第 4 项与多画布探针 ⑩**。
/** 把 example.com → 47.108.•••.••• */
/** 把 iZ2vcc7tgt0vdwyopm11mtZ (example.com) → iZ2vcc••••1mtZ (47.108.•••.•••) */
/** 极简线性眼睛：睁开=当前完整，带斜杠=当前已遮住 */
/** 点眼睛：切换遮/显，立即应用，并写进 localStorage（另一个面板下次重绘会跟上） */

// ============ dash：服务器状态（SSH 已连接 → 真实数据轮询；未连接 → oa-store 演示快照） ============

// ============ shell：终端 / Python 数据脚本 ============

// ---- Python 数据脚本运行器（真实执行 akshare / baostock）----

// ============ file：本地 / 云端文件 · 实时同步（左右分栏 + mtime/size 同步状态） ============

// ============ log：真实日志（pm2 后端 / nginx / mysql，SSH 已连接则实时抓取；否则操作日志） ============

// ============ combo：组合窗（多个子面板合成一个窗口 + 顶栏切预览，交叉淡入淡出）============
// 谁要它：<客户> OA 运维场景（用户 2026-09-27 提的）——「SSH 终端 / 云端文件 / 操作日志」原本是**三个独立面板**，
//   三块之间横着 #grid 的 10px 行列缝（用户抱怨的"连接处留黑"就是它，缝里露的是 --bg 近黑底色）。
//   合成一个面板 ⇒ 一个窗口、一条黑缝都没有；顶栏正中一个按钮在「工位区」和「预览区」之间"丝滑切换"。
// 场景 json 面板字段（都在 meta 上）：
//   meta.subPanels          [{id,title,type,...}] 子面板数组；id/title/type 必给，其余字段**原样**透传给子渲染器
//   meta.previewPanelId     预览子面板 id（默认 meta.id + '-view'）；也是别的面板递给它的地址（场景 json 的 viewPanel）
//   meta.previewQuickLinks  选填，原样透传给 view 的 quickLinks
// 状态记忆：localStorage['app.combo.' + meta.id] = 'stage' | 'view'（默认 stage = 工位区）
//
// 六条硬约束（每条都对应一个踩过的坑）：
//   ① 子面板 id **原样透传**：embed / harness 的 localStorage 分区都认面板 id（persist:embed-<id> 等），
//      改了 = 丢登录态 / 丢绑定；所以这里只 Object.assign({}, sub, {scenario}) 补一个场景标记，不碰 id。
//   ② 每个 slot **自己造一个细条 header** 交给子渲染器：三个都塞面板自己的 head 的话，三家的
//      「连接状态 / 刷新 / 眼睛」按钮会全挤进同一个标题栏里。
//      ⚠ renderers.view 只收 (body, meta) 两个参数 —— 别给它第三个。
//   ③ 子渲染器返回的 cleanup **全部收集**，组合窗销毁时依次调用（不收集 = SSH 助手轮询、日志 10s 轮询泄漏）。
//   ④ 切换**只动 opacity / transform**（交叉淡入淡出），全程不碰 width/height/display/flex：
//      动画期间改尺寸会让 shell/view 里的内容逐帧重排而"抖"（技能 gui-workbench reference/布局与展开.md §二），
//      而且组合窗的格子一动，用户要的"场景稳定"（其它面板一格不动）就没了。
//      隐藏层用 opacity:0 + pointer-events:none（**不是 display:none**）：① 终端/webview 的尺寸测量不失真
//      ② 层还留在流里 ⇒ SSH 会话、滚动位置、日志后台照跑。
//   ⑤ 预览区**懒挂载**：第一次要它才渲染 view；挂上 → 等一帧 → 再淡入（第一帧不闪）。
//   ⑥ 预览层全程 transform:none（见 styles.css 同段注释）：view 里可能出现 <webview>（PDF / HTML），
//      而 guest view 对**祖先 transform** 跟随不稳（同一份 reference 里踩过），所以位移只给工位层。
// combo 工位区的**迷你网格排格**：语义与工作台 #grid 完全一致 ——
//   col/row = **起始格**（1 起算；不写就自动排）、w/h = **跨格**（缺省各算 1）。
// 返回 { cols, rows, at:[{col,row,w,h}] }，at 与传入的 subs 一一对应，直接喂给 grid-column / grid-row。
// 通用：1×2 / 2×2 / N 列都行，本场景（SSH 1×1 + 云端文件 1×1 + 日志 2×1）算出来就是 2 列 2 行。
// 三条规矩：
//   ① 列数 = max(最宽的格子, 显式 col 撑出来的列, ceil(sqrt(总格数)))：
//      最宽的格子永远放得下（这条是硬底线）；ceil(sqrt()) 只兜"全是 1×1"的情况 ——
//      两个 1×1 该并排两列，而不是叠成一竖列（不然 form 上永远排不出 1×2 的并排布局）。
//   ② 排格 = 行主序（左→右、上→下）找**第一个放得下**的空位（等价 #grid 的稀疏首适配自动流）；
//      有显式 col/row 的按坐标原样放，只给一半（只写 col 或只写 row）的就在那一列/那一行里找空位。
//   ③ 排完把右侧、底部**整列整行空着**的部分裁掉（单个 w:1 的格子不会白占半幅宽）。
// 为什么不是把 w/h 当装饰：用户原来的排法就是这三个数字说的（第一行两块并排、第二行日志通栏），
// 之前"flex 等高均分"把三格排成了三等分竖条 —— 用户截图里判定为「排列错了」。


// ============ ctl：一键操作 ============

// ============ reserved：预留占位面板 ============

// ============ wb-cards：卡片墙（通用 · 2026-10-27）============
// 用法一（默认，工作台定制场景）：不给 groups ⇒ 「模板 / 客户」两段（读 03-客户\ 与 \_模板\）。
// 用法二（通用项目卡）：给 meta.groups = [{ label, root, list?, tone?, icon?, note? }]
//   · list:false（默认）→ root 本身一张卡（快捷打开某个项目目录）
//   · list:true          → 列 root 下的子目录，每个子目录一张卡
// 卡片副标题：优先 root\05-状态.md 的「阶段：」行，其次 root\说明.md 的第一条正文，最后 note。
// 点卡片 = app.app.openPath 打开该文件夹；⛔ 只读，不写不删任何文件。

// ============ app-window：把外部工业软件窗口内置成面板（2026-10-28 · 客户「<客户>」）============
// meta.app = { label, exe, match:{process,titleHas}, launchArgs, mode:'overlay'|'capture', chrome:'strip'|'keep', keepRatio, closeWithPanel }
// 机制：主进程 owner-overlay（scripts\app-embed-agent.ps1）——软件保持一级窗口，GUI 当它的 owner，再按屏幕坐标贴到面板上。
// 失败/未启动时只显示提示与按钮，不报错；切场景/销毁时按 closeWithPanel 释放 owner。

function flowPathParts(p) {
  var s = String(p || '').trim();
  var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return { file: i >= 0 ? s.slice(i + 1) : s, dir: i >= 0 ? s.slice(0, i) : '' };
}
// ============ view：通用预览 / 编辑面板（视频工作流 窗口1 用）============
// 干什么：把"当前这一步要看的东西"摊在一个面板里 —— 文本(md/txt，**能直接改、能存盘**) / 图片 / 视频 / 音频 / 网页。
// 谁驱动它：别的面板把文件递过来（流程画布双击「文案」节点 ⇒ V.show({path})）。
//   面板都在**同一个文档**里 ⇒ 靠 window.__kunViews[面板id] 这个小注册表互相调函数，
//   **不需要新 IPC**（跨进程的 AI 面板才必须走文件）。
// 为什么把窗口1 从"内嵌 ComfyUI"改成它（用户 2026-09-20 定的）：窗口1 当**通用预览位** ——
//   以后每个节点（文案 / 动画 / 成片）双击都往这里摊，不用为每种东西各开一个面板。
//   ComfyUI 控制台没丢：配在 quickLinks 里，右上角一个按钮就能切过去看。
//
// 场景 json 可配（全选填）：
//   meta.quickLinks  [{ label, url, launchPath }]  右上角常驻入口；带 launchPath 的多一个「🖥 桌面启动」
//   meta.hint        空状态里的自定义说明
// 读文件靠宿主能力 app.file（2026-09-20 新加的 IPC）：没有它 = 主进程还是旧的（没重启过 GUI），
//   这时**图片/视频/网页照样能看**（让内核自己按 file:// 读），只有"文本内容"和"保存"要等重启一次。
// ★2026-10-13★ 收第三个参数 head（面板标题行）：用户要求「功能按键压到标题栏、跟标题共用一排，省内容空间」——
//   拿得到 head ⇒ 文件名 + 那排按键并进标题行，内容区第一行就是正文；
//   拿不到（内部复用调用，例如自我复盘 review-doc 把 view 挂进自己内容区）⇒ 退回原来的体内工具行，单独渲染也不会瞎。


// ---- 标题行里的按键：必须阻断指针事件 ----
// ★2026-10-13★ 面板标题行同时是**拖拽把手** ⇒ 塞进标题行的按钮不阻断 mousedown/pointerdown 的话，
//   事件会被把手吃掉，表现为"点了没反应"。原来只有素材管理面板里那份局部实现（wireHeadBtn），
//   现在提到公共工具（一处实现）：预览面板把功能按键并进标题行时也用它。
function wireHeadNoDrag(node) {
  if (!node) return node;
  ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click', 'dblclick'].forEach(function (ev) {
    node.addEventListener(ev, function (e) { e.stopPropagation(); });
  });
  return node;
}

// ---- 暴露给外壳（renderer.js）的热更新接口 ----
// 面板渲染器与工具函数挂到 window 上；刷新场景时 renderer.js 会带时间戳重新加载本文件，
// 从而让 renderer 逻辑改动即时生效（不重载页面、不影响 harness webview 对话）。
window.APP_RENDER_UTILS = { el, mktColor, GRID_COLS, panelHead, makePanel, attachResize, packAutoGrid, gridColsOf, initScenarioTabBar, decorateScenarioIcons, wireHeadNoDrag };
window.APP_RENDERERS = renderers;

// ============ harness：直接内嵌 DSH 引擎 对话窗口（带 sessionId 的面板一板一分区，见 panelPartition） ============


// ==================== P2-C：面板生命周期接线（只登记，不搬实现）====================
// 把已有的 renderers[type] 包进 APP_PANEL_REGISTRY（index.html 已先加载 panels/panel-registry.js）：
// renderer.js 切场景时会真正调用 pauseScene / resumeScene（此前它们作用在空 Set）；unmount = 原 cleanup。
// 不改变 `renderers[type] = ...` 的注册形态（renderer-audit / check-gui 按该形态切片解析）。
(function () {
  var REG = window.APP_PANEL_REGISTRY;
  if (!REG || typeof REG.register !== 'function') return;   // 老宿主没有注册中心：静默跳过
  Object.keys(renderers).forEach(function (type) {
    if (typeof renderers[type] !== 'function') return;
    REG.register(type, {
      mount: function (body, meta, head) {
        var cleanup = renderers[type](body, meta, head);
        return {
          unmount: function () { try { if (typeof cleanup === 'function') cleanup(); } catch (e) { /* ignore */ } },
          pause: function () { try { body.dataset.panelPaused = '1'; } catch (e) { /* ignore */ } },
          resume: function () { try { delete body.dataset.panelPaused; } catch (e) { /* ignore */ } }
        };
      }
    });
  });
})();

