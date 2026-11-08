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
renderers.harness = (body, meta, head) => {
  body.classList.add('harness-panel');

  // 标题栏（标题行）加「重新加载」按钮 + 精简模式状态
  let wv = null;
  let hostTimer = null;   // 加载后 30s 注入兜底窗口
  let pinTimer = null;    // 常驻钉住重注入（5s）
  let disposed = false;   // 场景切换后停止一切注入
  const reloadBtn = el('button', 'file-refresh', '🔄 重新加载');
  reloadBtn.title = '重新加载对话窗口';
  reloadBtn.addEventListener('click', () => {
    if (wv) wv.setAttribute('src', wv.getAttribute('src') || '');
    else load();
  });
  const diag = el('span', 'harness-diag', '精简模式：注入中…');
  // 状态小字可点击 = 人工兜底（2026-11-07 分成两档）：
  //   ① 普通点击 = **重新加载**，并按场景里的绑定再钉一次 —— 用于「存储已指向 / 画面没跟上（欢迎页）」这种
  //      最常见的情形（以前这里只会清绑定，等于把本来对的绑定也扔了）。
  //   ② Shift + 点击 = 忘掉本面板记住的会话标题，重新按会话名匹配 —— 用于"绑错了会话 / 会话改名"。
  // 不用改代码、不用重启 GUI。（悬停有完整说明，见 injectFix 里的 diag.title）
  diag.style.cursor = 'pointer';
  diag.addEventListener('click', (ev) => {
    try {
      if (!wv || !wv.executeJavaScript) return;
      if (!(ev && ev.shiftKey)) {
        // 清掉软刷新/直达通道的计数，让重载后还能再试几次（否则额度用光就永远不重载了）
        const soft = "try{sessionStorage.removeItem('app_pin_soft_reloads');sessionStorage.removeItem('app_pin_reloads');}catch(e){}; 'ok'";
        wv.executeJavaScript(soft).then(() => { try { wv.reload(); } catch (e) { /* ignore */ } }).catch(() => { try { wv.reload(); } catch (e) { /* ignore */ } });
        return;
      }
      // 只清本面板的绑定（键名带面板 id），别把其它 AI 面板的记忆一起清掉
      const js = "try{localStorage.removeItem('app_pin_bind_v2:" + PANEL_KEY + "')}catch(e){}; 'ok'";
      wv.executeJavaScript(js)
        .then(() => { try { wv.reload(); } catch (e) { /* ignore */ } })
        .catch(() => { /* ignore */ });
    } catch (e) { /* ignore */ }
  });
  if (head) {
    head.classList.add('file-head');
    const acts = el('div', 'file-head-acts ai-head-acts');
    // 顺序：按钮在左、状态小字在右。窄面板（如 Blender 的 1 列宽 AI 面板）下，
    // 长状态文字不再把按钮挤到换行/裁切；小字自身用省略号收尾（CSS .harness-diag）。
    acts.appendChild(reloadBtn);
    acts.appendChild(diag);
    head.appendChild(acts);
  }

  const msg = el('div', 'harness-loading', '正在加载对话窗口…');
  body.appendChild(msg);

  // 内嵌窗口只显示聊天框：隐藏左侧菜单栏、右侧详情列、对话区顶部标题栏、对话轨迹 turn rail、宽度拖条。
  // 主策略 = CSS 优先（不依赖 JS）：应用框架带内联 grid-template-columns 且含 minmax(0,1fr) 中列，
  // 用 !important 强制成 0 / 1fr / 0；标题栏 data-phase>header、拖条 data-width-handle、手柄 data-side 稳定属性。
  // 兜底 = JS 常驻（MutationObserver + 定时器）纠正 React 重渲染。
  const HARNESS_CHAT_CSS = (ENGINE_ADAPTER && ENGINE_ADAPTER.chatCss) ? ENGINE_ADAPTER.chatCss({ centerColFix: false }).join('\n') : '';   // P2：单一实现（main 侧 centerColFix:true）
  // 钉住脚本（幂等：已装则不再重复装定时器；webview 内部重载后 window 重置，可重新注入）
  // pinTarget 支持「会话名」或「会话名数组」：多候选按顺序匹配——① 标题完全相等 ② 包含匹配，
  // **匹配时忽略大小写与空格**（兼容「oa系统运维」↔「<客户>oa系统运维」↔「<客户> OA 系统运维」）。
  // sessionTitle（可选）= 该会话的**完整真实标题**（从引擎会话索引里查到的原文），优先级最高、要求完全相等。
  // 每次注入都会刷新 window.__pinDiag（诊断），宿主面板会把结果写到标题行小字，便于排查。
  // 没写 pinTarget = 「不钉」（下面 clickItem 会直接什么都不做，交给用户自己选会话）。
  // 别再给缺省值塞历史默认「oa系统运维」：那会让主标签的「工作台」对话面板跑去找 OA 会话、
  // 甚至点到别的会话上去（2026-09-19 去掉这个默认值）。
  const rawPin = (meta && meta.pinTarget) || '';
  const pinTargets = (Array.isArray(rawPin) ? rawPin : [rawPin])
    .map(t => String(t == null ? '' : t).trim()).filter(Boolean);
  const PIN_TARGETS_JS = JSON.stringify(pinTargets);
  const PIN_SESSION_JS = JSON.stringify(String((meta && meta.sessionTitle) || '').trim());
  // ★会话 id = 身份校验（不再是"直达通道"）★ 2026-09-19 二次修正：
  //   场景 json 的 sessionId 是引擎真实 id（如 session-XXXXXXXX-…），面板拿它来**核对**
  //   「画面上这条会话是不是我要的那条」——因为会话行 DOM 里没有 id，只有标题，而本机真的
  //   存在过只差一个空格的孪生会话（`DSH 改造` / `DSH改造`），光凭标题会认错人。
  //   ⚠ 早先"写 dsh.sessions.current + reload 直达"的做法一度**删除**过（共用分区下两个面板互抢）；
  //     2026-09-19 三次定稿后**已按新前提重新启用**（一板一分区 ⇒ 各写各的键，见下方 ⓪）。
  //   ⚠ 早先"这些面板里侧栏压根不在 DOM 里、点行不可靠"的说法（2026-09-14）也已作废：
  //     2026-09-19 探针实测：侧栏会话行**加载后 1 秒内就在 DOM 里**（[role="treeitem"] 有 7~8 行），点行有效。
  const PIN_SESSION_ID_JS = JSON.stringify(String((meta && meta.sessionId) || '').trim());
  // 面板身份：分区现在是**一板一分区**（见 panelPartition 与 webview 处的说明），但"记住的会话标题"
  // 仍然按面板分键存 —— 面板重建、场景里换了会话 id 时它还要用，换分区不影响这个键的用途。
  const PANEL_KEY = String((meta && meta.id) || (meta && meta.scenario) || 'ai').replace(/[^A-Za-z0-9_-]/g, '') || 'ai';
  const PIN_PANEL_JS = JSON.stringify(PANEL_KEY);
  // ★拖文件进对话窗口（2026-09-23 用户要求）：webview 内部页面收 drop，把文件路径插进输入框
  //   （只插入、不自动发送，用户手动回车）。幂等：window.__kunDropGen 装过一次就不再装；
  //   webview 内部真重载时 window 重置 ⇒ 按新页面重新装一遍。
  //   路径链：guest 页面的 webUtils（引擎一般没暴露）→ File.path（老 Electron）→ text/uri-list / text/plain 兜底
  //   （系统文件拖拽 / 素材管理窗口 startDrag 拖回，dataTransfer 里都带 uri-list，能稳定拿到完整路径）。
  //   输入框 = 引擎 Composer 的 contenteditable（data-composer-input，Lexical 宿主），用 execCommand 插入
  //   会触发标准 InputEvent，Lexical 正常感知（只插文本、不拼文件名以外的任何东西）。
  const HARNESS_DROP_JS = `(() => {
    const GEN = 'kun-drop-v1';
    if (window.__kunDropGen === GEN) return;
    window.__kunDropGen = GEN;
    document.addEventListener('dragover', (ev) => {
      if (!ev.dataTransfer) return;
      try { ev.preventDefault(); } catch (e) { }
    });
    document.addEventListener('drop', (ev) => {
      if (!ev.dataTransfer) return;
      try { ev.preventDefault(); } catch (e) { }
      try { ev.stopPropagation(); } catch (e) { }
      const paths = [];
      const files = ev.dataTransfer.files || [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        let p = '';
        try { if (window.webUtils && window.webUtils.getPathForFile) p = window.webUtils.getPathForFile(f); } catch (e) { }
        if (!p) p = (f && f.path) || '';
        if (p) paths.push(p);
      }
      if (!paths.length) {
        let raw = '';
        try { raw = ev.dataTransfer.getData('text/uri-list') || ev.dataTransfer.getData('text/plain') || ''; } catch (e) { }
        String(raw).split(/\\r?\\n/).forEach((line) => {
          const s = line.trim();
          if (!s) return;
          let p = s;
          if (/^file:\\/\\//i.test(s)) {
            try { p = decodeURIComponent(s.replace(/^file:\\/\\//i, '').replace(/^\\/([A-Za-z]:)/, '$1').replace(/\\//g, '\\\\')); } catch (e) { }
          }
          if (p) paths.push(p);
        });
      }
      if (!paths.length) return;
      const el = document.querySelector('[data-composer-input]');
      if (!el) return;
      el.focus();
      try { document.execCommand('insertText', false, paths.join('\\n')); } catch (e) { }
    });
  })()`;
  const HARNESS_PIN_JS = `(() => {
    const TARGETS = ${PIN_TARGETS_JS};
    const SESSION_TITLE = ${PIN_SESSION_JS};
    const SESSION_ID = ${PIN_SESSION_ID_JS};
    const PANEL = ${PIN_PANEL_JS};
    // ⚠ 侧栏真实 DOM 结构（依据引擎源码 packages/client/ui-workspace/src/client/rows/Rows.tsx）：
    //   · 会话行  = div[role="treeitem"][aria-selected]  —— 没有 data-session-id 之类的 id 属性，
    //     标题在一个 <span class*="title"> 里，行内还有状态点/相对时间/菜单按钮（所以整行 textContent
    //     带着"3天前"这种尾巴，**不能拿整行文本做完全相等判断**）。
    //   · 分组头  = div[role="treeitem"][aria-expanded]（项目/工作区分组，点了只展开分组、不换会话）。
    //   因此：① 只认会话行，永不点分组头；② 只用"标题节点"的文本比对；③ 分组头只用来展开分组。
    // ⚠ 键里带上本面板"当前的钉会话配置"：改了场景（换会话 / 删掉绑定）就一定换键 ⇒
    //   旧记忆立刻失效。否则会出现"场景 json 里已经删了 id，面板还按记住的标题去点旧会话"的鬼绑定。
    const PIN_SIG = (SESSION_ID || SESSION_TITLE || (TARGETS || []).join('|') || 'none');
    const BIND_KEY = 'app_pin_bind_v2:' + PANEL + ':' + PIN_SIG;
    // ★幂等守卫（2026-09-19 三次定稿补）★：宿主每 5 秒会"轻量重注入"一次本脚本（好让 webview 内部
    //   重载后钉住仍生效），而下面装的是 setInterval ⇒ 每次注入都新装一轮，几分钟就能攒出几十个 4 秒循环，
    //   表现为面板状态小字周期性乱跳、空转扫 DOM（用户实感「每隔一会跳一下」）。
    //   同一份配置（GEN 里含面板名 + 钉会话签名）只装一次；重复注入只做一次轻量 tick（点一次 + 刷诊断）。
    //   webview 内部真重载时 window 重置 ⇒ GEN 自然失效 ⇒ 重新按新页面装一遍，语义不变。
    const GEN = 'pin_v3:' + BIND_KEY;
    if (window.__pinGen === GEN) { try { window.__pinTick && window.__pinTick(); } catch (e) { } return; }
    // 绑定 = 本面板上次钉成功的那条会话行的**精确标题**（DOM 里拿不到会话 id，标题就是最可靠的钥匙）；
    // 键名带面板 id，所以多个 AI 面板共用同一个浏览器分区也不会互相串。
    const readBind = () => { try { const s = localStorage.getItem(BIND_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; } };
    const saveBind = (title) => {
      try { if (title) localStorage.setItem(BIND_KEY, JSON.stringify({ title: String(title) })); } catch (e) { }
    };
    // ── localStorage['dsh.sessions.current'] 的读写（引擎用它记住"上次会话"）──
    // ★2026-09-19 三次定稿：写键 + reload 的"直达通道"**已按新前提重新启用**（见下方 ⓪）。
    //   前提变了：每个带 sessionId 的面板现在有**自己的分区**，本面板写的键只有本面板读得到，
    //   所以不会再出现"共用分区时代"的 8 秒级互抢 ⇒ 这条通道是本面板的首选钉法。
    //   （readSel 也重新可以当"本面板状态"用：它现在就是本面板自己分区里的值。）
    const SEL_KEY = 'dsh.sessions.current';
    const readSel = () => { try { return JSON.parse(localStorage.getItem(SEL_KEY) || 'null'); } catch (e) { return null; } };
    const writeSel = (id) => {
      try {
        const cur = readSel() || {};
        localStorage.setItem(SEL_KEY, JSON.stringify(Object.assign({}, cur, { sessionId: String(id) })));
        return true;
      } catch (e) { return false; }
    };
    // 重载次数记在 sessionStorage（**跨 reload 存活**，localStorage 会被应用改写、不适合计数）
    const RELOAD_KEY = 'app_pin_reloads';
    const readReloads = () => { try { return Number(sessionStorage.getItem(RELOAD_KEY) || 0) || 0; } catch (e) { return 0; } };
    const bumpReloads = () => { try { sessionStorage.setItem(RELOAD_KEY, String(readReloads() + 1)); } catch (e) { } };
    const clearReloads = () => { try { sessionStorage.removeItem(RELOAD_KEY); } catch (e) { } };
    // ★ 节流时间戳也必须跨 reload 存活（2026-09-19 修）：原先记在 window.__pinReloadAt 上，
    //   reload 之后归零 ⇒ "两次之间至少隔 8 秒"实际失效 ⇒ 一个场景挂两个 AI 面板时，两边会
    //   连续互抢同一个当前会话键，抢输的一方重载次数很快用光，最终停在"选择工作区开始"的
    //   新建会话页（症状：切过来偶尔就是新画面）。
    const RELOAD_AT_KEY = 'app_pin_reload_at';
    const readReloadAt = () => { try { return Number(sessionStorage.getItem(RELOAD_AT_KEY) || 0) || 0; } catch (e) { return 0; } };
    const markReloadAt = () => { try { sessionStorage.setItem(RELOAD_AT_KEY, String(Date.now())); } catch (e) { } };
    // ── 跨面板「改键 + 重载」令牌：**一板一分区之后已无必要**，代码保留仅作诊断（refreshDiag 会显示它）。
    //    历史：共用分区（主窗口 persist:harness）里 dsh.sessions.current 只有一个值，同一时刻只允许
    //    一个面板改它，才需要这个令牌；现在各面板写各面板分区里的键 ⇒ 令牌恒为空、claimFree() 恒真。
    const CLAIM_KEY = 'app_pin_claim_v1';
    const CLAIM_TTL = 20000;
    const readClaim = () => { try { return JSON.parse(localStorage.getItem(CLAIM_KEY) || 'null'); } catch (e) { return null; } };
    const claimFree = () => {
      const c = readClaim();
      if (!c || !c.panel) return true;
      if (String(c.panel) === String(PANEL)) return true;
      return (Date.now() - Number(c.at || 0)) > CLAIM_TTL;
    };
    const takeClaim = () => { try { localStorage.setItem(CLAIM_KEY, JSON.stringify({ panel: String(PANEL), at: Date.now() })); } catch (e) { } };
    const dropClaim = () => {
      try { const c = readClaim(); if (c && String(c.panel) === String(PANEL)) localStorage.removeItem(CLAIM_KEY); } catch (e) { }
    };
    // 重载预算（只在本面板**自己分区**的 sessionStorage 里计数，不会被对侧清零）：
    // 前 3 次间隔 ≥8 秒（正常情况下第一次就到位），第 4~5 次转慢车道 ≥25 秒（目标 id 失效时别狂刷），
    // 用完就只走 ① 点侧栏会话行，不会再无休止重载。
    const RELOAD_MAX = 5;
    const reloadGap = () => (readReloads() >= 3 ? 25000 : 8000);
    // 软刷新计数（2026-11-07）：存储已指向目标、画面却没落在目标会话时，允许再重载**最多 2 次**（间隔 ≥8 秒）。
    //   与 reloads 分开计数：reloads 管"写键通道"，这里管"键对了但画面没跟上"（欢迎页 / 应用慢加载）。
    const SOFT_KEY = 'app_pin_soft_reloads';
    const readSoft = () => { try { return Number(sessionStorage.getItem(SOFT_KEY) || 0) || 0; } catch (e) { return 0; } };
    const bumpSoft = () => { try { sessionStorage.setItem(SOFT_KEY, String(readSoft() + 1)); } catch (e) { } };
    const clearSoft = () => { try { sessionStorage.removeItem(SOFT_KEY); } catch (e) { } };
    // ⚠ 归一化**必须保留空格**（只把连续空白压成一个空格）：2026-09-19 实测本机存在"长得一样"的孪生会话
    //   （「DSH 改造」与「DSH改造」、「GUI 页面改造」与「GUI页面改造」），早先这里把空白**全部删掉**（只留字母），
    //   全删了 ⇒ 孪生会话的标题**完全相等** ⇒ 面板把"另一个几乎空白的同名会话"当成目标、还报"✓ 已钉绑定"
    //   ⇒ 用户看到的就是"切过来是空的新画面"（而存储里指向的确实是另一个会话 id）。
    const norm = (x) => String(x == null ? '' : x).toLowerCase().replace(/\\s+/g, ' ').trim();
    // ⚠ 教训（2026-09-14 当天踩过一次，别再犯）：**不要把搜索范围限制在某个"看起来像侧栏"的容器里**。
    //   实测 [data-side="sidebar"] 挂在拖拽手柄上、不是会话列表容器 → 限定范围后候选恒为空 →
    //   一个会话都点不到，面板就停在"新会话/欢迎页"（表现为"每个场景都切不进去"）。
    //   ★2026-11-07 补正★：对本机引擎 0.2.2-rc.1 的 app.asar 再核一次——[data-side] 只出现在
    //   宽度拖拽手柄上（"data-side": props.side），取值只有 left / right；sidebar / details **各 0 命中**。
    //   所以那条选择器不是"能选中但选错"，而是**压根选不中**。本文件里所有同类选择器已一并清掉。
    //   正确做法：全文档找，但 ① 排除聊天内容区（避免点到聊天记录里的同名字样）
    //            ② 绝不点分组头（[aria-expanded]，点了只展开分组）③ 会话行优先。
    const inChat = (e) => {
      try { return !!(e.closest && e.closest('[data-chat-flow],[data-phase]')); } catch (err) { return false; }
    };
    const clickTarget = (e) => (e.closest && e.closest('button,[role="button"],[role="option"],[role="treeitem"],a,li,[aria-selected]')) || e;
    const isRowLike = (e) => !!(e.closest && e.closest('[aria-selected],[data-session-id]'));
    const isGroupHead = (e) => {
      try { return !!(e.hasAttribute && e.hasAttribute('aria-expanded')); } catch (err) { return false; }
    };
    // 元素文本：会话行优先取行内标题节点（整行文本带"3天前"尾巴），其余用自身文本
    const readText = (e) => {
      try {
        if (e.querySelector) {
          const t = e.querySelector('[class*="title"]');
          if (t && t.textContent && t.textContent.trim()) return t.textContent.trim();
        }
      } catch (err) { /* ignore */ }
      return String((e && e.textContent) || '').replace(/\\s+/g, ' ').trim();
    };
    // 一行会话的"标题文本"（给诊断/记忆用）：标题节点 ＞ 按钮 aria-label 里的「标题」＞ 整行文本
    const rowTitle = (row) => {
      try {
        if (!row) return '';
        const t = row.querySelector ? row.querySelector('[class*="title"]') : null;
        if (t && t.textContent && t.textContent.trim()) return t.textContent.trim();
        const b = row.querySelector ? row.querySelector('[aria-label]') : null;
        if (b) {
          const m = String(b.getAttribute('aria-label') || '').match(/[「『"“]([^」』"”]{1,80})[」』"”]/);
          if (m && m[1].trim()) return m[1].trim();
        }
        return String(row.textContent || '').replace(/\\s+/g, ' ').trim();
      } catch (e) { return ''; }
    };
    // 页面标题 =「<会话名> — DSH 本地构建」：去掉后缀就是会话名（应用自己写的，最权威）
    const stripSuffix = (s) => String(s == null ? '' : s).replace(/\s*[—–\-]\s*DSH.*$/, '').trim();
    // ⚠ 2026-11-07 修：欢迎页/起始页的 document.title 就是笼统的「DeepSeek Harness」，
    //   以前被当成"当前会话名"⇒ 状态小字写「未切到 · DeepSeek Harness」，同时让 storeOk 分支误判成已切到。
    //   这些通用标题一律当"读不到会话名"处理。
    const GENERIC_TITLES = ['DSH 本地构建', 'DeepSeek Harness', 'DSH', '探索未至之境', '新会话', '欢迎'];
    const isGenericTitle = (s) => GENERIC_TITLES.indexOf(String(s || '').trim()) >= 0;
    // 欢迎页/选择工作区页：没有对话流，且有引导语。用它把"引擎压根没打开会话"与"开着会话但标题没读到"分开。
    const isWelcome = () => {
      try {
        if (document.querySelector('[data-chat-flow]')) return false;
        const t = String(document.body.innerText || '');
        return /探索未至之境|选择工作区|描述你想要构建的内容|选择一个工作区开始/.test(t);
      } catch (e) { return false; }
    };
    // 纯页签名（聊天区顶栏里第一个文本常常只是页签名"对话"），不能当成会话名
    const isTabLabel = (s) => /^(对话|chat|新视图|new view)$/i.test(String(s || '').trim());
    // 当前**已打开**的会话名。⚠ 顺序很重要（2026-09-14 修）：
    //   ① document.title —— 应用把会话名写在这里，最可靠（日志实证："<客户>oa系统运维 — DSH 本地构建"）
    //   ② 侧栏高亮行标题（侧栏多半没渲染，聊胜于无）
    //   ③ 聊天区顶栏文字 —— **放最后**：顶栏第一个文本往往是页签名「对话」，优先用它就会误报
    //      "未切到 · 对话"（状态小字显示错误，功能其实是好的）。
    // 都读不到时返回 ''（例如停在"新会话/欢迎页"）。
    const titleOf = () => {
      const dt = stripSuffix(document.title);
      if (dt && !isGenericTitle(dt)) return dt;
      try {
        const sel = document.querySelector('[aria-selected="true"]');
        const st = rowTitle(sel);
        if (st && st.length <= 60 && !isTabLabel(st)) return st;
      } catch (e) { /* ignore */ }
      try {
        const h = document.querySelector('[data-phase] > header');
        const ht = h ? String(h.textContent || '').replace(/\\s+/g, ' ').trim() : '';
        if (ht && ht.length <= 60 && !isTabLabel(ht)) return ht;
      } catch (e) { /* ignore */ }
      return '';
    };
    // 这个会话名是从哪儿读来的（只用于诊断显示，便于判断状态小字是否可信）
    const titleSrc = () => {
      const dt = stripSuffix(document.title);
      if (dt && !isGenericTitle(dt)) return '页面标题';
      try {
        const st = rowTitle(document.querySelector('[aria-selected="true"]'));
        if (st && st.length <= 60 && !isTabLabel(st)) return '侧栏高亮行';
      } catch (e) { /* ignore */ }
      try {
        const h = document.querySelector('[data-phase] > header');
        const ht = h ? String(h.textContent || '').replace(/\\s+/g, ' ').trim() : '';
        if (ht && ht.length <= 60 && !isTabLabel(ht)) return '聊天区顶栏';
      } catch (e) { /* ignore */ }
      return '读不到';
    };
    const findBest = (relaxed) => {
      // 全文档候选（排除聊天内容区；含"可点/可读"的常见节点）
      // relaxed=true 时不再排除聊天区：只在"严格找一遍没找到"时才用，保证绝不出现"一个都找不到"
      let all;
      try {
        all = document.querySelectorAll('div,button,span,a,li,p,[role="option"],[role="button"],[role="treeitem"],[aria-selected],[data-session-id]');
      } catch (e) { return null; }
      const cand = [];
      for (let i = 0; i < all.length; i++) {
        const e = all[i];
        try {
          const rowLike = isRowLike(e) || isRowLike(clickTarget(e));
          if (!relaxed && !rowLike && inChat(e)) continue;   // 聊天内容区：默认不点
          const raw = readText(e);
          if (!raw || raw.length > 160) continue;
          const n = norm(raw);
          if (!n) continue;
          const target = clickTarget(e);
          if (isGroupHead(target)) continue;            // 分组头：只用于展开分组，不当作会话
          cand.push({ el: e, t: raw, n: n, rank: rowLike ? 0 : 1 });
        } catch (err) { /* ignore */ }
      }
      if (!cand.length) return null;
      // ① 绑定标题 → ② 场景指定标题 → ③ 候选名；同一目标里"会话行优先、完全相等优先、文本越短越像行"
      const bind = readBind();
      const want = [];
      if (bind && bind.title) want.push({ n: norm(bind.title), by: '绑定标题:' + bind.title, exactOnly: true });
      if (SESSION_TITLE) want.push({ n: norm(SESSION_TITLE), by: '指定标题:' + SESSION_TITLE, exactOnly: true });
      for (let ti = 0; ti < TARGETS.length; ti++) want.push({ n: norm(TARGETS[ti]), by: '候选名:' + TARGETS[ti], exactOnly: false });
      for (let w = 0; w < want.length; w++) {
        const W = want[w];
        if (!W.n) continue;
        let best = null, bestKey = Infinity;
        for (let i = 0; i < cand.length; i++) {
          const c = cand[i];
          const exact = (c.n === W.n);
          if (!exact) {
            if (W.exactOnly) continue;
            if (c.n.indexOf(W.n) < 0 || c.n.length > 240) continue;
          }
          const key = c.rank * 1e6 + (exact ? 0 : 1e5) + c.n.length;
          if (key < bestKey) { bestKey = key; best = c; }
        }
        if (best) return { el: best.el, by: (best.n === W.n ? '完全相等 · ' : '包含 · ') + W.by };
      }
      return null;
    };
    const brief = (e) => String((e && (rowTitle(e) || e.textContent)) || '').replace(/\\s+/g, ' ').trim().slice(0, 36);
    const listCands = () => {
      const seen = {}, out = [];
      try {
        const els = document.querySelectorAll('[aria-selected],[data-session-id],[role="treeitem"],div,li,button');
        for (let i = 0; i < els.length && out.length < 12; i++) {
          const e = els[i];
          if (inChat(e)) continue;
          if (isGroupHead(e)) continue;
          const t = rowTitle(e);
          if (!t || t.length > 40) continue;
          if (seen[t]) continue;
          seen[t] = 1; out.push(t);
        }
      } catch (err) { /* ignore */ }
      return out;
    };
    const refreshDiag = (hit) => {
      const h = hit || findBest(false) || findBest(true);   // 与实际点击同一套判据（严格→放宽）
      window.__pinDiag = {
        targets: TARGETS,
        sessionTitle: SESSION_TITLE,
        sessionId: SESSION_ID,
        stored: (() => { const s = readSel(); return (s && s.sessionId) ? String(s.sessionId) : ''; })(),
        reloads: readReloads(),
        reloadMax: RELOAD_MAX,
        softReloads: readSoft(),
        // 欢迎页 / 选择工作区页：画面压根没打开任何会话（不是"标题没读到"）
        welcome: isWelcome(),
        hasFlow: (() => { try { return document.querySelectorAll('[data-chat-flow]').length; } catch (e) { return 0; } })(),
        claim: (() => {
          const c = readClaim();
          return c ? (String(c.panel) + ' · ' + Math.round((Date.now() - Number(c.at || 0)) / 1000) + ' 秒前') : '';
        })(),
        claimFree: claimFree(),
        title: titleOf(),
        titleSrc: titleSrc(),
        matched: h ? brief(h.el) : '',
        by: h ? h.by : '',
        bound: readBind(),
        rows: (() => { try { return document.querySelectorAll('[aria-selected],[data-session-id],[role="treeitem"]').length; } catch (e) { return -1; } })(),
        clicked: !!window.__pinClickedAt,
        clickedAt: window.__pinClickedAt || 0,
        cands: listCands()
      };
    };
    refreshDiag(null);
    // 用渲染层独立标记（不能复用 __pinSet：主进程注入会先设它，会把这里的新逻辑顶掉）
    if (window.__pinSetR) return;
    window.__pinSetR = true;
    // 双保险：顺手占住 main.js 旧版脚本的标记位，让那份"扫全文档模糊点击"的老逻辑直接 return
    try { window.__pinSet = true; } catch (e) { /* ignore */ }
    let last = 0;
    const reveal = (el) => {
      const hidden = [];
      let n = el.parentElement;
      while (n) {
        if (n.style && n.style.display === 'none') { hidden.push(n); n.style.display = ''; }
        n = n.parentElement;
      }
      return hidden;
    };
    const fire = (el) => {
      const o = { bubbles: true, cancelable: true, view: window };
      try { el.dispatchEvent(new PointerEvent('pointerdown', o)); } catch (_) { }
      try { el.dispatchEvent(new MouseEvent('mousedown', o)); } catch (_) { }
      try { el.dispatchEvent(new PointerEvent('pointerup', o)); } catch (_) { }
      try { el.dispatchEvent(new MouseEvent('mouseup', o)); } catch (_) { }
      try { el.dispatchEvent(new MouseEvent('click', o)); } catch (_) { }
    };
    const doClick = (hit) => {
      const c = hit.el.closest('button,[role="button"],[role="option"],[role="treeitem"],a,li') || hit.el;
      const hidden = reveal(c);
      fire(c);
      last = Date.now();
      window.__pinClickedAt = last;
      window.__pinLastHitTitle = rowTitle(c) || rowTitle(hit.el) || '';
      refreshDiag({ el: c, by: hit.by });
      hidden.forEach(function (h) { h.style.display = 'none'; });
    };
    // 兜底：会话列表若被折叠/隐藏，虚拟列表可能因容器 0 尺寸而不渲染任何列表项（DOM 里找不到）
    // 处理：临时注入样式强制显示侧栏 → 等 React 渲染 → 点击 → 立刻恢复隐藏（用户看不到闪动）。
    // ⚠ 这条规则是实测有效的版本（display:flex + min-width:0）。上一版改成 position:fixed/visibility:hidden
    //   后虚拟列表不再渲染列表项 → 反而"一个会话都切不进去"，已回退，别再改。
    // ★2026-11-07★：原规则写的是 [data-side="sidebar"]，而本机引擎 0.2.2-rc.1 里**没有这个值**
    //   （[data-side] 只有 left/right，且只挂在宽度拖拽手柄上）⇒ 这条注入**从来没命中过任何元素**，
    //   等于这段"兜底"一直是死代码。而且真隐藏是 main.js 结构法写的**内联** display:none，
    //   内联样式优先级高于任何选择器，必须用 !important 才顶得回来。
    //   改为运行时按结构定位：框架是 grid，含 [data-chat-flow] 的那一列是中心列，其余列就是侧栏/详情列。
    let forceTimes = 0, forceTargets = [], forceSaved = null;
    const sideColsOf = () => {
      const out = [];
      try {
        const all = document.querySelectorAll('[style*="grid-template-columns"]');
        let f = null;
        for (let i = 0; i < all.length; i++) {
          const v = all[i].style.gridTemplateColumns || '';
          if (v.indexOf('minmax(') >= 0) { f = all[i]; break; }
        }
        if (!f) return out;
        const kids = f.children;
        for (let i = 0; i < kids.length; i++) {
          const c = kids[i];
          if (c.querySelector && c.querySelector('[data-chat-flow]')) continue;   // 中心列跳过
          out.push(c);
        }
      } catch (e) { /* ignore */ }
      return out;
    };
    const forceShow = () => {
      if (forceSaved) return;
      forceTargets = sideColsOf();
      if (!forceTargets.length) return;
      forceSaved = forceTargets.map(function (el) { return el.style.display; });
      forceTargets.forEach(function (el) {
        try { el.style.setProperty('display', 'flex', 'important'); el.style.setProperty('min-width', '0', 'important'); } catch (e) { /* ignore */ }
      });
    };
    const forceHide = () => {
      try {
        if (forceSaved) {
          forceTargets.forEach(function (el, i) {
            if (forceSaved[i]) el.style.display = forceSaved[i]; else el.style.removeProperty('display');
            el.style.removeProperty('min-width');
          });
        }
      } catch (e) { /* ignore */ }
      forceTargets = []; forceSaved = null;
    };
    // 是否已经钉住：按"侧栏高亮行标题"判断（权威），命中绑定标题/指定标题/候选名都算到位
    // 画面证据：标题对 ≠ 画面已打开。2026-09-19 探针实测（全新分区 + 只写当前会话键）：
    //   document.title 已经是目标会话名、存储里也指向目标，但**画面仍是「探索未至之境 / 选择一个工作区开始」**
    //   （路由停在 / 没进会话）⇒ 旧判据会认为"已钉住"从而**永不修复**。所以必须再要一条画面证据。
    const hasFlow = () => { try { return !!document.querySelector('[data-chat-flow],[data-phase]'); } catch (e) { return false; } };
    const welcomeish = () => {
      try {
        const b = (document.body && document.body.innerText) || '';
        return b.indexOf('探索未至之境') >= 0 || b.indexOf('选择一个工作区开始') >= 0;
      } catch (e) { return false; }
    };
    const titlePinned = () => {
      const t = norm(titleOf());
      if (!t) return false;
      let ok = false;
      const bind = readBind();
      if (bind && bind.title && t === norm(bind.title)) ok = true;
      if (!ok && SESSION_TITLE && t === norm(SESSION_TITLE)) ok = true;
      if (!ok) {
        for (let i = 0; i < TARGETS.length; i++) {
          const T = norm(TARGETS[i]);
          if (T && t.indexOf(T) >= 0) { ok = true; break; }
        }
      }
      if (!ok) return false;
      // 标题对上之后再看一眼画面：没有对话流、且还在欢迎/选工作区页 ⇒ 不算钉住（交给侧栏点击那条路）
      if (!hasFlow() && welcomeish()) return false;
      return true;
    };
    // 侧栏只渲染「当前会话所属工作区分组」的行，其他分组的行不在 DOM 里 →
    // 必须先把折叠的分组展开，目标会话行才会出现（这是「切场景钉不住」的根因）
    let expandedByUs = [];
    const collapsedGroups = () => {
      const out = [];
      const gs = document.querySelectorAll('[role="treeitem"][aria-expanded]');
      for (let i = 0; i < gs.length; i++) {
        if (gs[i].getAttribute('aria-expanded') === 'false' && expandedByUs.indexOf(gs[i]) < 0) out.push(gs[i]);
      }
      return out;
    };
    let tries = 0;
    const clickItem = () => {
      // 解绑状态（场景里没给 id / 标题 / 候选名，也没有记住的绑定）→ 什么都不做：
      // 不点侧栏、不展开分组、不强制显隐，面板就停在当前会话，由用户自己选。
      if (!SESSION_ID && !SESSION_TITLE && !(TARGETS && TARGETS.length)) {
        const bU = readBind();
        if (!bU || !bU.title) { refreshDiag(null); return; }
      }
      // 「已钉住」只看**本面板画面**这一条证据（2026-09-19 三次定稿）。
      //   ⚠ 判"成没成"不能用存储值：一板一分区之后 dsh.sessions.current 确实是本面板自己的了，
      //   但"键写对了"不等于"应用已经切过去"（reload 尚未发生时两者必然不一致）⇒ 画面才是唯一判据。
      //   标题证据本身也有死角（应用停在空会话/欢迎页时 document.title 可能还没改），所以 titlePinned() 里
      //   额外要求「有对话流」或「不在欢迎页」——两条合起来才判到位。
      //   下面这个存储值只用于状态小字；写键之前要跟它比一次（见 ⓪）。
      const storedNow = (() => { try { const s = readSel(); return (s && s.sessionId) ? String(s.sessionId) : ''; } catch (e) { return ''; } })();
      if (titlePinned()) {            // 已在这个会话上 → 不再点击、不再折腾侧栏
        // 到位后把"这次钉住的精确标题"记下来（DOM 里没有会话 id，标题就是钥匙）：
        // 以后先按这条标题找，会话列表顺序/分组折叠变化都不会再找错。
        try {
          const b0 = readBind();
          const exact = (window.__pinLastHitTitle || '').trim();
          const cur = (titleOf() || '').trim();
          const remember = cur || exact;
          if (remember && (!b0 || b0.title !== remember)) saveBind(remember);
        } catch (e) { }
        clearReloads();               // 到位即清零本面板的重载预算（本分区只有本面板，清零不会让对侧无限刷）
        clearSoft();                  // 软刷新额度也一并清零（下次再出现"画面没跟上"还有 2 次可用）
        dropClaim();                  // ★ 到位即让位：让另一个 AI 面板去改当前会话键（两边各一次就都到位）
        last = Date.now();
        refreshDiag(null);
        return;
      }
      if (Date.now() - last < 1500) return;
      // ⓪ 直达通道（写**本面板自己分区**的 dsh.sessions.current + reload 一次）★2026-09-19 三次定稿·重新启用★
      //   早先删掉它，是因为"两个面板共用 persist:harness、键只有一个值"⇒ 互抢 + 8 秒级对刷
      //   （用户实感「每隔一会跳一下刷新、一打字就断」）。
      //   现在每个带 sessionId 的面板有**自己的分区**（webview 的 panelPartition(meta)）⇒
      //   本面板写的键只有本面板读得到 ⇒ 互抢在结构上不可能 ⇒ 这条通道重新成为**首选**钉法。
      //   探针实测（<盘根>:\DSH\工具\probe-seed\，全新分区）：写目标 id + reload ⇒ 1.4 秒落在目标会话。
      //   预算：最多 RELOAD_MAX 次、两次之间隔 reloadGap()（sessionStorage 计数，跨 reload 存活，
      //   而且只在**本分区本面板**里，不会再被对侧清零）。用完就退回 ① 点侧栏会话行，不会无休止重载。
      //   ⚠ 判"到没到位"仍然只看本面板画面（titlePinned）—— 那是唯一可信的本面板状态；
      //     这里读键只用于判断"要不要写"，不用于判断"成没成"。
      // 2026-11-07 回补（宿主反馈「面板一直停在欢迎页」）：写键之后**必须**重载一次页面 ——
      //   dsh.sessions.current 只影响"下一次加载"选谁；旧版为了不再"每 3 秒自动刷"，写完只弹了个提示条
      //   等用户点，结果面板永远停在欢迎页（状态小字却写着已切到）。现在合并成一条统一的 reloadPage()：
      //   次数由 readReloads()+RELOAD_MAX 与 reloadGap() 管住（最多 5 次、≥8 秒），不会退回秒级对刷。
      const reloadPage = () => { try { location.reload(); } catch (e) { } };
      if (SESSION_ID) {
        const curSel = (() => { try { const s = readSel(); return (s && s.sessionId) ? String(s.sessionId) : ''; } catch (e) { return ''; } })();
        if (curSel !== String(SESSION_ID) && readReloads() < RELOAD_MAX && (Date.now() - readReloadAt()) > reloadGap()) {
          bumpReloads();
          markReloadAt();
          if (writeSel(SESSION_ID)) {
            refreshDiag(null);
            // ★2026-11-07★ 写完键必须让页面**重载一次**：dsh.sessions.current 只影响"下一次加载"选哪条会话，
            //   不重载画面就永远停在欢迎页/上一条会话（这就是"存储已指向、状态显示已切到、画面却是 welcome"的真相）。
            //   次数与间隔由上面的预算管住（最多 5 次、每次 ≥8 秒），不会退化成 2026-11-01 那种"每 3 秒自己刷"。
            reloadPage();
            return;
          }
        }
        // 软刷新：存储已经等于目标 id，但画面仍不是目标会话（典型＝停在欢迎页；也可能是应用慢加载）。
        //   只允许 2 次、间隔 ≥8 秒；到位后 clearSoft 清零。无效 id 那种情况由上面的预算兜底，不会无限刷。
        const curSel2 = (() => { try { const s = readSel(); return (s && s.sessionId) ? String(s.sessionId) : ''; } catch (e) { return ''; } })();
        if (String(curSel2) === String(SESSION_ID) && readSoft() < 2 && (Date.now() - readReloadAt()) > 8000) {
          bumpSoft();
          markReloadAt();
          refreshDiag(null);
          reloadPage();
          return;
        }
      }
      // 说明：走到这里只有一种情形 —— 标题还不像目标：可能应用还在加载（下一轮就好）、
      //   会话行还没渲染（下面会展开分组 / 临时显示侧栏）、或该会话 id 已失效（被归档/删除）。
      // ① 兜底：按标题在会话行里精确匹配（找不到时放宽再找一遍）
      let hit = findBest(false) || findBest(true);
      if (hit) { doClick(hit); forceHide(); return; }
      // 找不到会话行：逐个展开折叠的工作区分组（每轮展开一个，等 React 渲染下轮再找）
      const collapsed = collapsedGroups();
      if (collapsed.length) {
        expandedByUs.push(collapsed[0]);
        fire(collapsed[0]);
        refreshDiag(null);
        return;
      }
      // 分组都展开了仍找不到：侧栏被精简模式隐藏时虚拟列表可能整个不渲染 →
      // 临时让侧栏"有尺寸但不可见"，等渲染完再找（随后立刻恢复隐藏）。最多重试 6 轮。
      if (forceTimes < 6) {
        forceTimes++;
        forceShow();
        refreshDiag(null);
        setTimeout(() => {
          const h2 = findBest();
          if (h2) doClick(h2);
          forceHide();
        }, 900);
        return;
      }
      refreshDiag(null);
    };
    setTimeout(clickItem, 1000);
    // 切场景后先用 1.5s 快节奏重试 20 次（尽快到位），之后 4s 常驻守着
    const fastTimer = setInterval(() => {
      clickItem();
      if (++tries >= 20) clearInterval(fastTimer);
    }, 1500);
    setInterval(clickItem, 4000);
    setInterval(() => refreshDiag(null), 4000);
    // 幂等标记 + 轻量 tick：宿主每 5 秒的重注入只会调 __pinTick（点一次 + 刷一次诊断），
    // 不再新装定时器 —— 见脚本开头的守卫。webview 内部重载后 window 重置，这里会重新执行。
    window.__pinGen = GEN;
    window.__pinTick = () => { try { clickItem(); refreshDiag(null); } catch (e) { } };

    // ---- 聊天滚动锚定：面板展开/收起（webview 视口变大变小）时稳住聊天内容 ----
    // 目的：展开瞬间不要"内容乱跳"。规则：原本贴底 → 展开后仍贴底；否则保持原阅读位置。
    (() => {
      if (window.__expandAnchor) return;
      window.__expandAnchor = true;
      const findScroller = () => {
        let n = document.querySelector('[data-chat-flow]') || document.querySelector('[data-phase]');
        while (n && n !== document.body) {
          try {
            const cs = getComputedStyle(n);
            if (n.scrollHeight - n.clientHeight > 40 && /(auto|scroll)/.test(cs.overflowY)) return n;
          } catch (e) { /* ignore */ }
          n = n.parentElement;
        }
        return document.scrollingElement || document.documentElement;
      };
      window.addEventListener('resize', () => {
        const el = findScroller();
        if (!el) return;
        const wasBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 48;
        const prevTop = el.scrollTop;
        requestAnimationFrame(() => {
          try {
            if (wasBottom) el.scrollTop = el.scrollHeight;   // 原来贴底 → 继续贴底
            else el.scrollTop = prevTop;                     // 否则维持原来的阅读位置
          } catch (e) { /* ignore */ }
        });
      }, { passive: true });
    })();
  })();`;
  const HARNESS_FIX_JS = (ENGINE_ADAPTER && ENGINE_ADAPTER.fixJs) ? ENGINE_ADAPTER.fixJs({ profile: 'renderer', pinJs: HARNESS_PIN_JS }) : '';   // P2：布局修复 + 极简 JSON 诊断 + 嵌钉会话（单一实现）

  const injectFix = async () => {
    try { await wv.insertCSS(HARNESS_CHAT_CSS); } catch (e) { /* ignore */ }
    // 拖文件进对话窗口（幂等脚本，装上监听后重复执行只返回）
    try { await wv.executeJavaScript(HARNESS_DROP_JS); } catch (e) { /* ignore */ }
    let simplify = '';
    let wideTxt = '';
    try {
      const r = await wv.executeJavaScript(HARNESS_FIX_JS);
      let info = null;
      try { info = JSON.parse(r); } catch (e) { /* ignore */ }
      if (info && info.found) simplify = '精简 ✓';
      else if (info) simplify = '等界面…';
      // 铺满实测（例 `铺满 1列 1576/1592px`）：两者只差十几像素（我们留的那 16px）就是铺开了；
      // 还差几百像素说明页面里没有 [data-chat-flow]（引擎换版了）——见文件上方「会话列铺满」。
      if (info && info.wide) { simplify += (simplify ? ' · ' : '') + '铺满 ' + info.wide; wideTxt = info.wide; }
    } catch (e) { /* ignore */ }
    // 钉会话诊断：HARNESS_PIN_JS 每次注入都会刷新 window.__pinDiag，这里读回来显示在面板标题行
    let pinTxt = '钉会话: 检测中…';
    try {
      const d = await wv.executeJavaScript('window.__pinDiag || null');
      if (d && d.targets) {
        const want = [String(d.sessionTitle || '')].filter(Boolean).concat(d.targets || []).join(' / ');
        const nz = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();   // ⚠ 保留空格：别把 'DSH 改造' 和 'DSH改造' 混成一个（同名孪生会话）
        // 面板当前显示的会话名（取自侧栏高亮行标题，权威）作为最终判据
        const live = String(d.title || '');
        const liveN = nz(live);
        const okName = (!!d.sessionTitle && liveN === nz(d.sessionTitle)) ||
          (d.targets || []).some(t => { const tn = nz(t); return tn && liveN.indexOf(tn) >= 0; });
        const boundOk = !!(d.bound && d.bound.title && liveN === nz(d.bound.title));
        const ok = boundOk || okName;
        // 侧栏行一条都读不到时（面板窄/分组折叠/应用还没渲染列表），标题证据必然失效 ——
        // 这时如果引擎自己记的当前会话 id 就等于指定 id，**只把状态小字**改说"按存储核对"，
        // 钉会话的动作照旧（下面 clickItem 仍然每轮尝试），不动"画面才是唯一判据"那条铁律。
        const storeOk = !!(d.sessionId && d.stored && String(d.stored) === String(d.sessionId));
        const unbound = !d.sessionId && !d.sessionTitle && !(d.targets || []).length && !(d.bound && d.bound.title);
        // ★2026-11-07★ 状态小字必须如实：存储一致 ≠ 画面已切过去。
        //   旧文案在 storeOk 时直接报「✓ 已切到（存储核对）」，而画面可能还停在欢迎页/上一条会话
        //   （用户实见：状态 ✓、面板是「探索未至之境」）⇒ 现在把三种情形分开写。
        pinTxt = unbound ? '○ 未绑定 · 面板自由选会话'
          : (boundOk ? '✓ 已钉绑定'
            : (ok ? '✓ 已钉'
              : (storeOk
                ? (d.welcome ? '⚠ 存储已指向 · 画面还是欢迎页（点此刷新）' : '⚠ 存储已指向 · 画面未切（点此刷新）')
                : ('未切到 · ' + (live || (d.welcome ? '欢迎页' : '读不到当前会话'))))));
        if (unbound) diag.title = '该面板未绑定任何会话（场景 json 里没写 sessionTitle / sessionId / pinTarget）\n' +
          '面板停在它当前显示的会话上，不会被自动切换，也不再去找侧栏。\n' +
          '要重新绑定：给该面板补 sessionTitle + sessionId，再切一次场景即可（改了就会立刻生效）。';
        else diag.title = '该面板应对应的会话：' + want +
          '\n指定会话 id：' + (d.sessionId || '（未指定 · 靠标题匹配）') +
          '\n应用存储里的当前会话：' + (d.stored || '（空）') + (String(d.stored) === String(d.sessionId) && d.sessionId ? ' ✓ 一致' : '') +
          (d.reloads ? ('\n直达通道重载计数 ' + d.reloads + ' 次（上限 ' + (d.reloadMax || 5) + '）') : '') +
          (d.softReloads ? ('\n"键对了画面没跟上"的软刷新计数 ' + d.softReloads + ' 次（上限 2）') : '') +
          (d.welcome ? '\n画面状态：**欢迎页 / 选择工作区页**（引擎还没打开任何会话）' : '') +
          '\n面板当前显示的会话：' + (live || '（读不到）') + (d.titleSrc ? ('（来源：' + d.titleSrc + '）') : '') +
          (d.bound && d.bound.title ? ('\n已记住的会话标题：' + d.bound.title) : '\n已记住的会话标题：（无 · 首次按名字找）') +
          '\n界面可识别会话行/选中行数：' + (d.rows == null ? '未知' : d.rows) +
          (d.matched ? ('\n已定位到会话行：' + d.matched + '（' + d.by + '）') : '\n未定位到目标会话行（分组折叠或列表未渲染）') +
          (d.cands && d.cands.length ? ('\n界面里能看到的会话/行：' + d.cands.join(' ｜ ')) : '\n界面里能看到的会话/行：（读不到）') +
          (storeOk && !ok ? ('\n↑ 「应用存储」里的当前会话已经等于指定 id，但画面没落在该会话上（' +
            (d.welcome ? '停在欢迎页' : '标题还没变成目标会话') + '）。\n'
            + '  面板会在写入后自动重载一次；仍不行就点这里刷新（点击 = 重新加载并按当前绑定再钉一次）。') : '') +
          (wideTxt ? ('\n会话列铺满：' + wideTxt + '（列宽 / 可用宽；只差十几像素＝已铺满，差几百＝没铺上，多半引擎换版了）') : '') +
          '\n\n点击此处 = 重新加载并按当前绑定再钉一次；Shift + 点击 = 忘掉记住的标题、重新按会话名匹配';
      }
    } catch (e) { /* ignore */ }
    diag.textContent = (simplify ? simplify + ' · ' : '') + pinTxt;
  };
  // 主进程通道注入（更可靠）：轮询 webview 的 webContentsId，让 main 直接注入并写日志
  // ⚠ 注意：main.js 注入脚本里**旧版**还带一套"扫全文档模糊匹配后点击"的钉会话循环
  //   （每 4s 点一次），它会和渲染层的新逻辑打架 —— 渲染层刚钉对，它又把面板点到
  //   聊天记录里含同名字样的随便一个元素上，于是"切场景后会话错乱/切不过去"。
  //   这里固定传一个**绝不可能匹配到任何元素**的哨兵目标（NUL 字符不会出现在任何 textContent 里），
  //   于是 main 侧只保留"注入布局修复 + 截图 + 日志"，点击权完全交给本文件的 HARNESS_PIN_JS。
  const mainInject = () => {
    try {
      if (!wv || !wv.getWebContentsId) return;
      const id = wv.getWebContentsId();
      if (id === -1 || typeof window.app.injectHarnessPanel !== 'function') return;
      window.app.injectHarnessPanel(id, '\u0000no-pin\u0000');
    } catch (e) { /* ignore */ }
  };

  const load = async () => {
    if (disposed) return;
    try {
      const ready = await window.app.isHarnessReady();
      if (!ready) {
        msg.textContent = 'Harness 引擎尚未就绪。请稍候或点击「重试」。';
        const retry = el('button', 'file-refresh', '🔄 重试');
        retry.addEventListener('click', () => { msg.textContent = '正在加载对话窗口…'; load(); });
        msg.appendChild(retry);
        return;
      }
      const url = await window.app.getHarnessUrl();
      body.innerHTML = '';
      wv = document.createElement('webview');
      wv.className = 'harness-wv';
      // ⚠ 分区策略（2026-09-19 三次定稿·探针实测）：**带 sessionId 的面板一板一分区**（panelPartition）。
      //   探针证据（<盘根>:\DSH\工具\probe-seed\，隐藏 Electron + 真引擎 + 全新分区）：
      //   写入 dsh.sessions.current = 目标 id 后 reload ⇒ 1.4 秒即落在目标会话（标题、正文全对）。
      //   旧注释"独立分区会卡在欢迎页"是误判（当时快照取太早）；但旧注释另一半是对的：
      //   共用分区时"写键 + reload"必然互抢 ⇒ 那才是 2026-09-19「每隔一会跳一下刷新」的真因。
      //   ⇒ 现在两者合起来用：分区私有 + 各自写自己的键，既确定又不互抢。
      //   没带 sessionId 的面板仍然退回 soloHarnessPartition()（主窗口 = persist:harness，与主标签同分区）。
      wv.setAttribute('partition', panelPartition(meta));
      wv.setAttribute('allowpopups', '');
      wv.addEventListener('dom-ready', injectFix);
      wv.addEventListener('did-finish-load', injectFix);
      // 主进程通道 + 宿主定时兜底：加载后前 30 秒每 1.5 秒重注入
      hostTimer = setInterval(() => {
        if (disposed) return;
        if (!wv || !wv.getWebContentsId) return;
        if (wv.getWebContentsId() === -1) return;
        mainInject();
        injectFix();
      }, 1500);
      setTimeout(() => { if (hostTimer) clearInterval(hostTimer); }, 30000);
      // 常驻钉住：每 5 秒轻量重注入一次（webview 内部重载后钉住仍生效；脚本自身幂等）
      pinTimer = setInterval(() => {
        if (disposed) return;
        try { if (wv && wv.executeJavaScript) wv.executeJavaScript(HARNESS_PIN_JS + '\n' + HARNESS_DROP_JS).catch(function () { }); } catch (e) { /* ignore */ }
      }, 5000);
      wv.setAttribute('src', url);
      body.appendChild(wv);
    } catch (e) {
      msg.textContent = '加载失败：' + (e && e.message || e);
    }
  };
  load();
  // 场景切换清理：停止注入定时器（webview DOM 由 loadScenario 统一移除）
  return () => {
    disposed = true;
    if (hostTimer) clearInterval(hostTimer);
    if (pinTimer) clearInterval(pinTimer);
  };
};

renderers.neuron = (body, meta, head) => {
  body.classList.add('kneu-wrap');
  body.innerHTML = '';

  const F = (window.app && window.app.file) || null;
  const OPEN = (window.app && window.app.topbar && window.app.topbar.open) || null;
  // 根统一 引擎\\场景记忆（2026-10-27 审计②：旧别名 场景项目信息 是 junction，收掉就全断）
  const P = (window.app && window.app.paths) || {};
  const MEM_ROOT = P.memRoot || '';
  const ROOT = MEM_ROOT + '\\_共享记忆';
  const SKILL_DIR = P.skillDir || (__WB_ROOT + '\\引擎数据\\.dsh\\skills');
  // 技能清单**不硬编码**（2026-10-27 审计①：硬编码 23 漏了 command / douyin）——运行时列技能目录；
  //   2026-11-07 修「⛔ 路径失效 22」：列目录失败时改为解析 skills\_索引.md（真清单），
  //   这份兜底表只给**极老宿主**（既没有列目录、也没有索引文件）用，且只允许写本模板真实存在的技能。
  //   旧表是某个工作区实例的 25 个技能名，本机只有 3 个存在 ⇒ 其余 22 个路径全红（用户截图那 22）。
  const SKILL_FALLBACK = ['bilibili', 'command', 'pc-cleanup', 'self-review', 'webai'];
  // 边的语义标签（2026-10-27 审计⑤：原来只有颜色，看不出这条线是什么关系）
  const EDGE_LABEL = {
    area: '内核 → 区域', skill: '技能归属（→ owner 场景）', memory: '私有记忆归属',
    project: '项目 owner', dep: '区域互相提及（文本启发式）', chain: '提交链',
    source: '数据源', doc: '共享文档'
  };
  // 归口配色：引擎/工具=蓝 · 界面/设计=琥珀 · 内容/业务=绿 · 运维/清理=红
  const GROUP = {
    'dg-dsh': 'engine', 'dg-gui': 'ui', 'code-ai': 'code', 'dz-ai': 'ui', 'site-ai': 'content',
    'wb-ai': 'content', 'oa-ai': 'content', 'vw-ai': 'content', 'bv-ai': 'content', 'bl-ai': 'content',
    'mk-chat': 'content', 'sr-ai': 'content', 'pc-ai': 'ops'
  };
  const COLOR = isLightTheme() ? { core: '#0e7490', engine: '#2563eb', ui: '#b45309', code: '#6d28d9', content: '#15803d', ops: '#b91c1c', skill: '#5b73c4', doc: '#64748b', project: '#0f766e', memory: '#475569', source: '#64748b', chain: '#b45309' } : { core: '#7fe3ff', engine: '#8fb4ff', ui: '#f0a35e', code: '#b79bff', content: '#3ddc84', ops: '#e5484d', skill: '#6f8fd6', doc: '#c9d4e6', project: '#2dd4bf', memory: '#dfe7ff', source: '#8f9bb3', chain: '#ffcf6b' };
  // 项目层（2026-10-26）：不是从记忆里正则猜，而是直接列真实目录（B 盘/项目工程），归属按 area 正文里出现的名字来挂
  const PROJECT_ROOTS = P.projectRoots || [];
  // dg-dsh 审计（2026-10-26）：这 5 个是一级目录但属于「资料/介质夹」，不是项目
  const NON_PROJECTS = ['_项目文件', '产物、素材、内容、方案', '服务器信息', '通用素材', '更新feed'];
  // 私有记忆（2026-10-26，宿主："每个场景的私有记忆连到各自对应的场景"）——
  //   映射照抄 _场景身份索引.md §五「写回点」的权威表，别自己猜文件夹名。
  // 私有记忆兜底表（2026-10-27 审计②）：只补 记忆地图 缺的项；名字统一 场景私有记忆.md、根统一 场景记忆
  const MEM_DIR = MEM_ROOT;
  const CHAIN_DIR = MEM_ROOT + '\\_共享记忆\\提交链';
  const MEMORY_BY_PANEL = {
    'cmd-chat': MEM_DIR + '\\命令\\场景私有记忆.md',
    'bv-ai': MEM_DIR + '\\B站\\场景私有记忆.md',
    'dg-dsh': MEM_DIR + '\\DSH·GUI改造\\场景私有记忆.md',
    'dg-gui': MEM_DIR + '\\DSH·GUI改造\\场景私有记忆.md',
    'bl-ai': MEM_DIR + '\\Blender\\场景私有记忆.md'
  };

  // ---------- 骨架 ----------
  const cv = el('canvas', 'kneu-cv');
  const hud = el('div', 'kneu-hud');
  const stat = el('div', 'kneu-stat', '加载中…');
  const searchWrap = el('div', 'kneu-searchwrap');
  const search = el('input', 'kneu-search');
  search.type = 'search';
  search.placeholder = '搜场景 / 技能 / 文件…';
  searchWrap.appendChild(el('span', 'kneu-searchico', '⌕'));
  searchWrap.appendChild(search);
  hud.appendChild(searchWrap);
  hud.appendChild(stat);
  const btns = el('div', 'kneu-btns');
  const bRot = el('button', 'kneu-btn', '⟳ 自转');
  const bReset = el('button', 'kneu-btn', '⤾ 复位');
  const bMem = el('button', 'kneu-btn', '只看记忆');
  const bFx = el('button', 'kneu-btn', '动效：开');
  bMem.type = 'button';
  bMem.title = '只留：场景 / 私有记忆 / 提交链 / 共享文档（技能·项目·数据源 及它们的连线一起隐藏）';
  const bLabel = el('button', 'kneu-btn', '标签：自动');
  bFx.type = 'button';
  bFx.title = '星点/流光/呼吸的开关（卡就关掉）';
  const bReload = el('button', 'kneu-btn', '↻ 重读');
  bLabel.type = 'button';
  bLabel.title = '节点标签：自动（场景常显、项目近了才显示）→ 全部 → 关';
  bRot.type = bReset.type = bReload.type = 'button';
  btns.appendChild(bRot); btns.appendChild(bReset); btns.appendChild(bMem); btns.appendChild(bFx); btns.appendChild(bLabel); btns.appendChild(bReload);
  hud.appendChild(btns);
  const detail = el('div', 'kneu-detail');
  const legend = el('div', 'kneu-legend');
  [['engine', '引擎/工具'], ['ui', '界面/设计'], ['code', '代码'], ['content', '内容/业务'], ['ops', '运维/清理'], ['project', '项目'], ['memory', '私有记忆'], ['chain', '提交链'], ['source', '数据源'], ['skill', '技能'], ['doc', '共享文档']]
    .forEach(function (p) {
      var it = el('span', 'kneu-lg');
      var dot = el('i', 'kneu-dot');
      dot.style.background = COLOR[p[0]];
      it.appendChild(dot);
      it.appendChild(document.createTextNode(p[1]));
      legend.appendChild(it);
    });
  body.appendChild(cv);
  body.appendChild(hud);
  body.appendChild(detail);
  body.appendChild(legend);
  if (head) {
    head.appendChild(el('span', 'stat-refresh', '共享记忆 · 只读'));
  }

  // ---------- 状态 ----------
  let nodes = [];        // {id,label,kind,group,path,size,x,y,z,r,deg,hover}
  let edges = [];        // {a,b,kind}
  // 2026-11-07：默认俯角 0.18 → 0.42（约 24°）。原来是近乎平视：整张图是又宽又扁的一条，面板下半屏全空，
  //   只能靠"拉近"填满，结果上下裁切。抬高俯角后同样的宽度能换到 2 倍纵向高度，圆环读成"盘"而不是"线"。
  var RY0 = -0.35, RX0 = 0.42;                 // 默认机位（↺ 复位 / 视口适配都以它为准）
  let ry = RY0, rx = RX0, zoom = 1.42;
  let hover = null, sel = null, auto = true, disposed = false, raf = 0, last = 0;
  var ownerSkill = {};   // skill 节点 id → 面板 id（layout 贴 owner 用）
  let labelMode = 1;   // 1=全部（默认，宿主 2026-10-26：所有点都要有文字标签） 0=自动 2=关
  let fx = true;       // 动效（星点/流光/呼吸）；卡就一键关
  let onlyMem = false; // 只看记忆：只留 内核/场景/私有记忆/提交链/共享文档
  let bornAt = 0;      // 载入时刻（入场动画：整图从中心展开）
  let introBoot = false; // 2026-10-27 宿主：点「↻ 重读」无条件重播一次入场动画（即使动效开关是关的）
  var stars = [];
  function makeStars() {
    stars = [];
    var n = 18;
    for (var i = 0; i < n; i++) {
      stars.push({ x: Math.random() * W, y: Math.random() * H, r: 0.4 + Math.random() * 1.1, ph: Math.random() * 6.28, sp: 0.4 + Math.random() * 1.2 });
    }
  }
  let W = 0, H = 0, dpr = 1, q = '';

  function readText(p) {
    if (!F || !F.read) return Promise.resolve('');
    return Promise.resolve(F.read(p)).then(function (r) {
      return (typeof r === 'string') ? r : ((r && (r.text || r.content)) || '');
    }).catch(function () { return ''; });
  }
  function statSize(p) {
    if (!F || !F.stat) return Promise.resolve(0);
    return Promise.resolve(F.stat(p)).then(function (r) {
      return (r && (r.size || (r.stat && r.stat.size))) || 0;
    }).catch(function () { return 0; });
  }
  // 2026-10-27 审计⑤：路径存在校验（kun:file:stat 缺失时返回 {ok:true, exists:false}，不抛错）
  function statOk(p) {
    if (!F || !F.stat || !p) return Promise.resolve(false);
    return Promise.resolve(F.stat(p)).then(function (r) {
      if (!r || r.ok === false) return false;
      if (r.exists === false) return false;
      return !!(r.isDir || r.size != null || r.stat);
    }).catch(function () { return false; });
  }

  // 2026-11-07（宿主：「记忆神经元里节点路径失效」）：宿主通用「列目录」能力的统一入口。
  //   新壳用 app.file.list（kun:file:list），老壳退回 app.oa.filesLocal（oa:files:local，同一个实现，
  //   见 main/system-io.js）。两件事都要防：
  //     · 通道不存在 / 主进程还是旧的 ⇒ invoke reject；
  //     · **preload 新、主进程旧**（换 preload 只消重载页面，换主进程要重启 GUI）⇒ 前一个通道有函数但没 handler。
  //   所以按顺序逐个试，第一个失败就试下一个，全都失败才 resolve(null)（调用方走文本索引兜底），绝不 throw。
  function listDir(p) {
    var A = window.app || {};
    var fns = [];
    if (A.file && A.file.list) fns.push(A.file.list);
    if (A.oa && A.oa.filesLocal) fns.push(A.oa.filesLocal);
    if (!fns.length) return Promise.resolve(null);
    function tryAt(i) {
      if (i >= fns.length) return Promise.resolve(null);
      var pr;
      try { pr = Promise.resolve(fns[i](p)); } catch (e) { return tryAt(i + 1); }
      return pr.then(function (r) {
        return (r && r.ok !== false && r.rows) ? r : tryAt(i + 1);
      }).catch(function () { return tryAt(i + 1); });
    }
    return tryAt(0);
  }

  // ---------- 载入数据 ----------
  function load() {
    stat.textContent = '正在读共享记忆…';
    return Promise.all([readText(ROOT + '\\索引.json'), readText(ROOT + '\\项目.json'), readText(ROOT + '\\记忆地图.json')]).then(function (both) {
      var txt = both && both[0];
      var projTxt = (both && both[1]) || '';
      var mapTxt = (both && both[2]) || '';
      var memMap = null;
      try { memMap = mapTxt ? JSON.parse(mapTxt) : null; } catch (e) { memMap = null; }
      var memByPanel = {};
      if (memMap && Array.isArray(memMap.areas)) {
        memMap.areas.forEach(function (a) {
          if (a && a.panel && Array.isArray(a.privateMemory) && a.privateMemory.length) memByPanel[a.panel] = a.privateMemory;
        });
      }
      var reg = null;
      try { reg = projTxt ? JSON.parse(projTxt) : null; } catch (e) { reg = null; }
      var idx = null;
      try { idx = JSON.parse(txt); } catch (e) { idx = null; }
      // 客户包：记忆地图里的相对路径按记忆根解析（不带盘符）
      function __memAbs(mp) {
        if (!mp) return '';
        if (/^[A-Za-z]:/.test(mp)) return mp;
        return MEM_ROOT + '\\' + String(mp).replace(/^引擎[\\/]场景记忆[\\/]/, '');
      }
      var areas = (idx && idx.areas) || [];
      ownerSkill = {};                 // 2026-11-07：重读时清空，别让上一轮的归属残留
      nodes = []; edges = [];
      var core = { id: 'core', label: 'DSH 记忆', kind: 'core', group: 'core', r: 15, path: ROOT, size: 0 };
      nodes.push(core);

      var docs = [
        // 2026-11-01 修：这两份是**共享**文档，全仓唯一的写点在 场景记忆\_共享记忆\
        //   （工具\发消息.mjs 往 _共享记忆\_跨场景通知.md 追加；topbar-status.js 的「跨场景通知」也指向那里）。
        //   以前这里写成 META_DIR（= 场景记忆 根）⇒ 根上根本没有这两个文件 ⇒ 加载时校验一路判失效，
        //   面板常驻「⛔ 路径失效 2」，点开详情是「文件不存在」，点「定位」也定位不到东西。
        { id: 'doc-todo', label: '待办', path: ROOT + '\\_待办.md', ang: 0 },
        { id: 'doc-msg', label: '通知', path: ROOT + '\\_跨场景通知.md', ang: Math.PI * 0.66 },
        { id: 'doc-conf', label: '冲突', path: ROOT + '\\冲突.md', ang: Math.PI * 1.33 }
      ];
      var jobs = [];

      // 文档节点（放在内核附近）
      docs.forEach(function (d) {
        jobs.push(statSize(d.path).then(function (sz) {
          nodes.push({ id: d.id, label: d.label, kind: 'doc', group: 'doc', path: d.path, size: sz, r: 8 });
          edges.push({ a: 'core', b: d.id, kind: 'doc' });
        }));
      });

      // 场景区域节点（球壳 1）+ 依赖边
      areas.forEach(function (a, i) {
        var id = 'area-' + a.owner;
        var g = GROUP[a.owner] || 'content';
        jobs.push(readText(ROOT + '\\' + String(a.file || '').replace(/\//g, '\\')).then(function (txt) {
          nodes.push({
            id: id, label: a.owner, title: a.title || '', kind: 'area', group: g,
            path: ROOT + '\\' + String(a.file || '').replace(/\//g, '\\'),
            size: txt.length, region: a.region || '', text: txt
          });
          edges.push({ a: 'core', b: id, kind: 'area' });
        }));
      });

      // 项目节点（2026-10-26）：优先读 dg-dsh 建的登记表 _共享记忆\\项目.json；
      //   没有才退回"列两个真实根目录"。登记表里有 owner/status/aliases ⇒ 归属与状态都比猜的准。
      var fromReg = !!(reg && Array.isArray(reg.projects) && reg.projects.length);
      if (fromReg) {
        reg.projects.forEach(function (pr) {
          if (!pr || !pr.name) return;
          var owner = String(pr.owner || '');
          nodes.push({
            id: 'proj-' + String(pr.id || pr.name),
            label: String(pr.name).slice(0, 24),
            kind: 'project', group: 'project',
            path: (Array.isArray(pr.paths) && pr.paths[0]) || '',
            paths: Array.isArray(pr.paths) ? pr.paths : [],
            owner: owner,
            status: String(pr.status || 'active'),
            aliases: Array.isArray(pr.aliases) ? pr.aliases : [],
            size: 0
          });
        });
        console.log('[neuron] 项目登记表：' + reg.projects.length + ' 个项目');
      }
      if (!fromReg && PROJECT_ROOTS.length) {
        PROJECT_ROOTS.forEach(function (root) {
          jobs.push(listDir(root).then(function (r) {
            if (!r || r.ok === false) return;
            (r.rows || []).filter(function (it) {
              return it && it.isDir && NON_PROJECTS.indexOf(String(it.name)) < 0;
            }).slice(0, 40).forEach(function (it) {
              nodes.push({
                id: 'proj-' + root.replace(/[^A-Za-z0-9]/g, '_') + '-' + it.name,
                label: String(it.name).slice(0, 22), kind: 'project', group: 'project',
                path: root + '\\' + it.name, size: it.size || 0, root: root
              });
            });
          }).catch(function () { /* 目录不存在就算了 */ }));
        });
      }

      // 私有记忆节点：优先用 记忆地图.json（一个面板可有多份），没有才退回硬编码表
      areas.forEach(function (a) {
        var list = (memByPanel[a.owner] || (MEMORY_BY_PANEL[a.owner] ? [MEMORY_BY_PANEL[a.owner]] : [])).map(__memAbs);
        list.forEach(function (mp, mi) {
          var isDir = /[\\/]$/.test(mp) || !/\.md$/i.test(mp);
          (isDir ? Promise.resolve(0) : statSize(mp)).then(function (sz) {
            var id = 'mem-' + a.owner + (list.length > 1 ? ('-' + mi) : '');
            nodes.push({
              id: id, label: '§' + a.owner + (list.length > 1 ? ('·' + (mi + 1)) : ''), kind: 'memory', group: 'memory',
              path: mp, size: sz || 0, isDir: isDir, ownerPanel: a.owner
            });
            edges.push({ a: 'area-' + a.owner, b: id, kind: 'memory' });
          });
        });
      });

      // 数据源节点（记忆地图 dataSources）：工具/插件/MCP/会话档案/备份/台账/体检 …
      if (memMap && memMap.dataSources) {
        var SKIP = { scenes: 1, skills: 1, projects: 1, tasks: 1 };   // 这几个已有专门节点
        Object.keys(memMap.dataSources).forEach(function (key) {
          if (SKIP[key]) return;
          var ds = memMap.dataSources[key] || {};
          var nm = ({ tools: '工具', plugins: '插件', mcp: 'MCP', sessions: '会话档案', backups: '备份', docs: '说明台账', health: '体检' })[key] || key;
          var cnt = ds.count;
          nodes.push({
            id: 'src-' + key, label: nm + (cnt ? (' ' + cnt) : ''), kind: 'source', group: 'source',
            path: String(ds.path || ds.board || ''), size: 0, srcKey: key,
            dsInfo: ds
          });
          edges.push({ a: 'core', b: 'src-' + key, kind: 'source' });
        });
      }

      // 提交链（2026-10-26 A 档）：每个面板一条追加式锚点链，只读
      jobs.push(listDir(CHAIN_DIR).then(function (r) {
        if (!r || r.ok === false) return [];
        var rows = (r.rows || []).filter(function (it) { return it && /\.jsonl$/i.test(it.name); });
        return Promise.all(rows.map(function (it) {
          var panel = String(it.name).replace(/\.jsonl$/i, '');
          return readText(CHAIN_DIR + '\\' + it.name).then(function (txt) {
            var list = String(txt || '').split(/\r?\n/).filter(Boolean).map(function (line) {
              try { return JSON.parse(line); } catch (e) { return null; }
            }).filter(Boolean);
            if (!list.length) return;
            var last = list[list.length - 1];
            nodes.push({
              id: 'chain-' + panel, label: '链 ' + list.length, kind: 'chain', group: 'chain',
              path: CHAIN_DIR + '\\' + panel + '.jsonl', size: 0, panel: panel,
              total: list.length, recent: list.slice(-3).reverse()
            });
            edges.push({ a: 'area-' + panel, b: 'chain-' + panel, kind: 'chain' });
          });
        }));
      }).catch(function () { /* 没有链目录就算了 */ }));

      // 技能归属（2026-10-26）：读 skills\_索引.md 的「属于哪个场景」列，把技能挂到它 owner 的 area 上
      // 2026-10-27 修：那一格写的是「场景名（`场景id` · 面板 `面板id`）」，旧正则取第一个形如 xx-xx 的反引号词
      //   ⇒ pc-cleanup / self-profile / code-dev / oa-ops 被解析成「场景 id」（area-pc-cleanup 之类根本不存在）
      //   ⇒ 边悬空、画不出来 ⇒ 这几个技能点看着"没连线"。现在只认**真实存在的 area owner（面板 id）**。
      // 2026-11-07：同一份索引还兼作**技能清单的二级兜底**（列目录失败时用它，别再退回硬编码旧表）；
      //   索引里没写归属时再按「技能名 == 场景 id」同名兜底一次（模板里 5 个技能与场景 id 同名，
      //   新克隆还没有 _索引.md 时也能把技能挂对场景，而不是全挂 core）。
      var AREA_IDS = {};
      areas.forEach(function (a) { if (a && a.owner) AREA_IDS[a.owner] = 1; });
      var SCENE_OWNER = {};
      areas.forEach(function (a) { if (a && a.id && a.owner) SCENE_OWNER[String(a.id)] = a.owner; });
      var skillIndexP = readText(SKILL_DIR + '\\_索引.md').then(function (txt) {
        var ownerMap = {}, names = [];
        String(txt || '').split(/\r?\n/).forEach(function (line) {
          if (line.charAt(0) !== '|') return;
          var cells = line.split('|').map(function (c) { return c.trim(); });
          var name = String(cells[1] || '').replace(/`/g, '');
          if (!name || name === '技能' || /^[-:\s]+$/.test(name)) return;   // 表头 / 分隔行
          names.push(name);
          var own = String(cells[2] || '');
          var toks = own.match(/`[a-z0-9][a-z0-9-]{1,20}`/g) || [];
          var picked = '';
          for (var ti = 0; ti < toks.length; ti++) {
            var tk = toks[ti].replace(/`/g, '');
            if (AREA_IDS[tk]) { picked = tk; break; }       // 只认真实 area owner
          }
          ownerMap[name] = picked;                            // 空串 = 没有归属 ⇒ 挂 core
        });
        return { owner: ownerMap, names: names };
      }).catch(function () { return { owner: {}, names: [] }; });

      // 技能节点（球壳 2）：清单优先级 = 真实目录（2026-10-27 审计①）→ _索引.md 表格 → 兜底表
      jobs.push(Promise.all([listDir(SKILL_DIR), skillIndexP]).then(function (arr) {
        var r = arr[0], sidx = arr[1] || { owner: {}, names: [] };
        var dirs = (r && r.ok !== false) ? (r.rows || []).filter(function (it) {
          return it && it.name && String(it.name).charAt(0) !== '_' && it.isDir !== false;
        }).map(function (it) { return String(it.name); }) : [];
        var list = dirs.length ? dirs.slice().sort() : (sidx.names.length ? sidx.names : SKILL_FALLBACK);
        list.forEach(function (n) {
          var id = 'skill-' + n;
          jobs.push(statSize(SKILL_DIR + '\\' + n + '\\SKILL.md').then(function (sz) {
            nodes.push({ id: id, label: n, kind: 'skill', group: 'skill', path: SKILL_DIR + '\\' + n + '\\SKILL.md', size: sz });
            var ownerPanel = sidx.owner[n] || SCENE_OWNER[n] || '';
            edges.push({ a: ownerPanel ? ('area-' + ownerPanel) : 'core', b: id, kind: 'skill' });
            if (ownerPanel) ownerSkill[id] = ownerPanel;
          }));
        });
      }));

      return Promise.all(jobs).then(function () { return Promise.all(jobs); });
    }).then(function () {
      // 路径校验（2026-10-27 审计⑤）：每个节点加载时验一次，失效的标红、详情里写明
      return Promise.all(nodes.filter(function (n) { return n.path; }).map(function (n) {
        return statOk(n.path).then(function (okk) { n.missing = !okk; });
      }));
    }).then(function () {
      // 依赖边：area 文本里提到别的 owner ⇒ 连一条
      var owners = nodes.filter(function (n) { return n.kind === 'area'; }).map(function (n) { return n.label; });
      nodes.filter(function (n) { return n.kind === 'area' && n.text; }).forEach(function (n) {
        owners.forEach(function (o) {
          if (o === n.label) return;
          if (new RegExp('`?' + o.replace(/[-]/g, '\\-') + '`?').test(n.text)) {
            edges.push({ a: n.id, b: 'area-' + o, kind: 'dep' });
          }
        });
      });
      // 重名项目（两组「我的git hub仓库」）：后面缀盘符区分，别让人看混
      var nameCount = {};
      nodes.filter(function (n) { return n.kind === 'project'; }).forEach(function (n) { nameCount[n.label] = (nameCount[n.label] || 0) + 1; });
      nodes.filter(function (n) { return n.kind === 'project' && nameCount[n.label] > 1; }).forEach(function (n) {
        var m = String(n.root || '').match(/^([A-Za-z]):/);
        n.label = n.label + (m ? '（' + m[1].toUpperCase() + ' 盘）' : '');
      });

      // 项目归属：登记表给了 owner ⇒ 直接连到 owner 的 area；没有才退回"正文里提到名字"的启发式
      var areaById = {};
      nodes.filter(function (n) { return n.kind === 'area'; }).forEach(function (n) { areaById[n.label] = n; });
      var regDone = {};
      nodes.filter(function (n) { return n.kind === 'project' && n.owner; }).forEach(function (n) {
        var target = areaById[n.owner] || null;
        edges.push({ a: target ? target.id : 'core', b: n.id, kind: 'project' });
        regDone[n.id] = 1;
      });

      // 项目归属（兜底）：某 area 正文里出现项目名 ⇒ 连到它；否则挂 core
      var areaNodes = nodes.filter(function (n) { return n.kind === 'area' && n.text; });
      nodes.filter(function (n) { return n.kind === 'project' && !regDone[n.id]; }).forEach(function (p) {
        var owner = null;
        for (var ai = 0; ai < areaNodes.length; ai++) {
          if (String(areaNodes[ai].text).indexOf(p.label) >= 0) { owner = areaNodes[ai]; break; }
        }
        edges.push({ a: owner ? owner.id : 'core', b: p.id, kind: 'project' });
      });
      nodes.forEach(function (n) { delete n.text; n.deg = 0; });
      var byId = {}; nodes.forEach(function (n) { byId[n.id] = n; });
    // 尺寸变了就重设位图（真机上 ResizeObserver 有时晚一拍）
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    }
      // 2026-10-27：边只留两端都真实存在的；悬空的丢掉并在头部报数（不再"悄悄算一条画不出来的线"）
      var nDangling = 0;
      edges = edges.filter(function (e) {
        if (byId[e.a] && byId[e.b]) return true;
        nDangling++;
        return false;
      });
      edges.forEach(function (e) { if (byId[e.b]) byId[e.b].deg++; if (byId[e.a]) byId[e.a].deg++; });
      layout();
      bornAt = performance.now();
      // 2026-10-27 审计③：17 个区域里有「宿主 / 全体场景」两个伪节点，不再叫"场景 17"
      var nArea = nodes.filter(function (n) { return n.kind === 'area'; }).length;
      var nPseudo = nodes.filter(function (n) { return n.kind === 'area' && /^(宿主|全体场景)$/.test(String(n.label)); }).length;
      var nChainN = nodes.filter(function (n) { return n.kind === 'chain'; }).length;
      var nMiss = nodes.filter(function (n) { return n.missing; }).length;
      // 2026-10-27（宿主：这段"看着太丑"）：不再拼一整句纯文本 —— 每项一个小段，整段不拆行；
      //   面板窄时按「·」整段换行（不会把「孤立 0」拆成「孤 / 立 0」），右侧按钮也不会被挤压成两行。
      var nSkillN = nodes.filter(function (n) { return n.kind === 'skill'; }).length;
      var nMemN = nodes.filter(function (n) { return n.kind === 'memory'; }).length;
      var nDocN = nodes.filter(function (n) { return n.kind === 'doc'; }).length;
      var nSrcN = nodes.filter(function (n) { return n.kind === 'source'; }).length;
      var nProjN = nodes.filter(function (n) { return n.kind === 'project'; }).length;
      var nAnchorN = nodes.filter(function (n) { return n.kind === 'chain'; }).reduce(function (a, n) { return a + (n.total || 0); }, 0);
      var nLoneN = nodes.filter(function (n) { return n.kind !== 'core' && !n.deg; }).length;
      var chips = [
        { t: '区域 ' + nArea + '（' + (nArea - nPseudo) + ' 场景 + 宿主 + 全体）' },
        { t: '技能 ' + nSkillN },
        { t: '私有记忆 ' + nMemN },
        { t: '共享 ' + nDocN },
        { t: '数据源 ' + nSrcN },
        { t: '提交链 ' + nChainN + ' 文件 / ' + nAnchorN + ' 锚点' },
        { t: '项目 ' + nProjN },
        { t: '连线 ' + edges.length },
        { t: '孤立 ' + nLoneN, cls: nLoneN ? ' bad' : '' }
      ];
      if (nDangling) chips.push({ t: '⛔ 悬空边 ' + nDangling, cls: ' bad' });
      chips.push(nMiss ? { t: '⛔ 路径失效 ' + nMiss, cls: ' bad' } : { t: '路径全在', cls: ' ok' });
      stat.innerHTML = '';
      chips.forEach(function (c, ci) {
        if (ci) stat.appendChild(el('span', 'kneu-sep', '·'));
        stat.appendChild(el('span', 'kneu-seg' + (c.cls || ''), c.t));
      });
      stat.title = '数据源：引擎\\场景记忆\\_共享记忆（索引/项目/记忆地图/提交链）+ .dsh\\skills 目录'
        + ' · 核对时间 ' + new Date().toLocaleString('zh-CN', { hour12: false });
      // 2026-11-07：统计段建好后 HUD 的真实高度才定下来（窄面板会折成多行）⇒ 再排一次，
      //   fitToViewport 才能按 HUD 实际高度留出顶部空间，节点不会钻到统计字底下。
      layout();
    }).catch(function (e) {
      stat.textContent = '读不到共享记忆：' + ((e && e.message) || e);
    });
  }

  // ---------- 3D 布置 ----------
  // 2026-11-07 重做（宿主：「优化各节点的位置关系」）。旧版是"每个种类各按数组下标绕一圈"，三个硬伤：
  //   ① 技能环的角度跟归属场景无关 ⇒ 「技能→owner 场景」的线横穿整张图，点一多就成一团麻；
  //   ② 半径写死 430 / 700，与面板尺寸无关 ⇒ 面板一窄，外圈节点直接被裁到画布外（880×626 实测裁掉 5 个点）；
  //   ③ 记忆/链/项目的半径 = 各自 owner 半径 × 系数，而 owner 半径又按奇偶错开 0.86
  //      ⇒ 同一个场景的卫星忽近忽远，看不出归属。
  // 新口径：主环 = 场景（顺序与左侧场景列表一致）；每个场景的卫星（记忆 → 技能 → 项目/链）放在
  //   **它自己的扇区**里由内到外逐层外扩；共享文档/数据源贴内核；最后按当前画布做一次投影包围盒适配
  //   （fitToViewport）⇒ 任何面板尺寸下开局都不裁切、不糊在中心。场景顺序保持 index.json 顺序，不重排。
  function layout() {
    var areas = nodes.filter(function (n) { return n.kind === 'area'; });
    var skills = nodes.filter(function (n) { return n.kind === 'skill'; });
    var docs = nodes.filter(function (n) { return n.kind === 'doc'; });
    var projects = nodes.filter(function (n) { return n.kind === 'project'; });
    var mems = nodes.filter(function (n) { return n.kind === 'memory'; });
    var srcs = nodes.filter(function (n) { return n.kind === 'source'; });
    var chains = nodes.filter(function (n) { return n.kind === 'chain'; });
    var R1 = 430;                                  // 主环世界半径（最终会被 fitToViewport 整体缩放）
    // ① 场景主环：均匀铺开 + 轻微上下起伏（看得出是 3D，但不破坏"环"的读法）
    var areaBy = {};
    areas.forEach(function (n, i) {
      var t = -Math.PI / 2 + (i / Math.max(1, areas.length)) * Math.PI * 2;
      n.ax = Math.cos(t); n.az = Math.sin(t); n.at = t;
      n.x = n.ax * R1;
      n.z = n.az * R1;
      n.y = Math.sin(t * 2) * 30;
      n.r = 9 + Math.min(9, Math.sqrt(n.size / 700));
      areaBy[n.label] = n;
    });
    // ② 卫星贴 owner 的通用摆法：同扇区（owner 角度 + 偏角）、指定半径系数、指定高度偏移
    function placeNear(n, own, radK, angOff, yOff, r0) {
      var t = own.at + angOff;
      var rr = R1 * radK;
      n.x = Math.cos(t) * rr;
      n.z = Math.sin(t) * rr;
      n.y = own.y + yOff;
      if (r0) n.r = r0;
    }
    var lone = { memory: [], skill: [], project: [], chain: [] };
    // ③ 私有记忆：owner 扇区里紧贴场景外侧（"随身笔记"）
    mems.forEach(function (n) {
      var own = areaBy[n.ownerPanel];
      if (own) placeNear(n, own, 1.26, 0.10, 26, 4.6);
      else lone.memory.push(n);
    });
    // ④ 技能：**按 owner 分组放进各自扇区** —— "位置关系"最要紧的一条：归属线短、归属一眼看得出来。
    //   同一场景的多个技能沿扇区小角度散开；技能多时角间距自动收窄，不会散到别人的扇区去。
    var bySkillOwner = {};
    skills.forEach(function (n) {
      var op = ownerSkill[n.id];
      if (op && areaBy[op]) (bySkillOwner[op] = bySkillOwner[op] || []).push(n);
      else lone.skill.push(n);
    });
    Object.keys(bySkillOwner).forEach(function (op) {
      var own = areaBy[op], list = bySkillOwner[op];
      list.sort(function (a, b) { return String(a.label).localeCompare(String(b.label), 'zh'); });
      var step = Math.min(0.40, 0.92 / list.length);
      var t0 = own.at + (step * (list.length - 1)) / 2;      // 整组以 owner 角度为中心
      list.forEach(function (n, i) {
        var t = t0 - i * step;
        var rr = R1 * 1.58 * (1 + (i % 2 ? 0.05 : -0.05));   // 奇偶错开一点，标签不叠
        n.x = Math.cos(t) * rr; n.z = Math.sin(t) * rr;
        n.y = own.y + Math.sin(t * 3) * 16 + (i % 2 ? 52 : -52);
        n.r = 5 + Math.min(4, Math.sqrt(n.size / 2200));
      });
    });
    // ⑤ 项目：owner 扇区里靠内（0.68R），多个项目沿扇区散开
    var byProjOwner = {};
    projects.forEach(function (n) {
      var own = n.owner ? areaBy[n.owner] : null;
      if (own) (byProjOwner[n.owner] = byProjOwner[n.owner] || []).push(n);
      else lone.project.push(n);
    });
    Object.keys(byProjOwner).forEach(function (op) {
      var own = areaBy[op], list = byProjOwner[op];
      list.forEach(function (n, i) {
        var t = own.at - 0.17 + (i - (list.length - 1) / 2) * 0.19;
        var rr = R1 * (0.66 + (i % 2 ? 0.05 : 0));
        n.x = Math.cos(t) * rr; n.z = Math.sin(t) * rr;
        n.y = own.y * 0.5 + (i % 2 ? 16 : -16);
        n.r = 5.4;
      });
    });
    // ⑥ 提交链：owner 扇区最外一层（反向偏角），像场景外面挂的年表
    chains.forEach(function (n) {
      var own = areaBy[n.panel];
      if (own) placeNear(n, own, 1.86, -0.14, -34, 4.4);
      else lone.chain.push(n);
    });
    // ⑦ 共享文档：贴内核的一圈小三角（不占场景扇区，避免压住场景标签）
    var R0 = R1 * 0.52;
    docs.forEach(function (n, i) {
      var t = -Math.PI / 2 + Math.PI * 0.34 + (i / Math.max(1, docs.length)) * Math.PI * 2;
      n.x = Math.cos(t) * R0; n.z = Math.sin(t) * R0;
      n.y = Math.sin(t * 2) * 26;
      n.r = 8;
    });
    // ⑧ 数据源：内核外一小圈（"我的家底"）
    var RS = R1 * 0.36;
    srcs.forEach(function (n, i) {
      var t = 0.2 + (i / Math.max(1, srcs.length)) * Math.PI * 2;
      n.x = Math.cos(t) * RS; n.z = Math.sin(t) * RS;
      n.y = (i % 2 ? 14 : -14);
      n.r = 5.2;
    });
    // ⑨ 无归属的卫星：外圈均匀铺开（半径各不相同，互不重叠）
    function placeRing(list, radK, yAmp, yBase) {
      list.sort(function (a, b) { return String(a.label).localeCompare(String(b.label), 'zh'); });
      list.forEach(function (n, i) {
        var t = 0.5 + (i / Math.max(1, list.length)) * Math.PI * 2;
        n.x = Math.cos(t) * R1 * radK; n.z = Math.sin(t) * R1 * radK;
        n.y = yBase + Math.sin(t * 1.7) * yAmp;
      });
    }
    placeRing(lone.skill, 1.62, 150, 0);
    placeRing(lone.memory, 1.30, 40, 10);
    placeRing(lone.project, 0.84, 60, 0);
    placeRing(lone.chain, 1.94, 40, -20);
    lone.skill.forEach(function (n) { n.r = 5 + Math.min(4, Math.sqrt(n.size / 2200)); });
    nodes.filter(function (n) { return n.kind === 'core'; }).forEach(function (n) { n.x = 0; n.y = 0; n.z = 0; });
    // ⑩ 视口适配：按**当前画布**投影一遍，把整张图缩进可视区（上方 HUD / 下方图例留白）。
    //    面板变宽变窄都会重跑（见 ResizeObserver）⇒ 任何尺寸开局都不裁切。
    fitToViewport();
  }

  // 投影包围盒 → 整体缩放。透视是非线性的（越靠前的点被放得越大），所以必须**迭代到收敛**：
  //   只缩不放会在窄面板上留下一大片空白（第一轮按被透视放大的包络缩得过头，后面又不敢放大）。
  // 注意：适配按**默认缩放 REF_ZOOM / 默认机位**算，不按用户当前滚轮与拖动 —— 否则用户放大后
  // 一改面板宽度，布局会被永久缩小（缩完再复位就看不清了）。可用区还要扣掉顶部 HUD 与底部图例的
  // **实际高度**（窄面板时 HUD 会换行变高，写死 108px 会让节点钻到字底下）。
  var REF_ZOOM = 1.42;
  var viewShiftY = 0;              // 可用区中心与画布中心的纵向偏差（HUD 比图例高时把图整体下移）
  function fitToViewport() {
    if (!nodes.length || !W || !H) return;
    var clamp = function (v, lo, hi) { return Math.max(lo, Math.min(hi, v)); };
    var hudH = (hud && hud.offsetHeight) ? hud.offsetHeight : 0;
    var legH = (legend && legend.offsetHeight) ? legend.offsetHeight : 0;
    var padX = clamp(W * 0.10, 34, 92);
    var padTop = Math.max(clamp(H * 0.12, 64, 108), hudH ? (hudH + 26) : 0);
    var padBot = Math.max(clamp(H * 0.10, 56, 86), legH ? (legH + 20) : 0);
    var availW = Math.max(100, (W - padX * 2) / 2);
    var availH = Math.max(80, (H - padTop - padBot) / 2);
    viewShiftY = (padTop - padBot) / 2;
    var sRy = ry, sRx = rx;
    ry = RY0; rx = RX0;
    for (var it = 0; it < 8; it++) {
      var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
      nodes.forEach(function (n) {
        var p = project(n, REF_ZOOM);
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      });
      var halfW = Math.max(1, (maxX - minX) / 2);
      var halfH = Math.max(1, (maxY - minY) / 2);
      var k = Math.min(availW / halfW, availH / halfH);
      if (k > 0.97 && k < 1.04) break;             // 收敛：两个方向都用上了
      k = Math.max(0.25, Math.min(2.5, k));        // 每轮限幅，防透视非线性导致来回震荡
      nodes.forEach(function (n) { n.x *= k; n.y *= k; n.z *= k; });
    }
    ry = sRy; rx = sRx;
  }

  // ---------- 画布 ----------
  function fit() {
    dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    var rect = body.getBoundingClientRect();
    // 2026-10-26 真机排查：面板刚建时 rect 可能是 0 ⇒ 先看 clientWidth/Height，还是 0 就下一帧再量
    var cw = body.clientWidth || 0, ch = body.clientHeight || 0;
    var w0 = Math.round(rect.width) || cw, h0 = Math.round(rect.height) || ch;
    if (!w0 || !h0) {
      if (!fit._tries) fit._tries = 0;
      if (fit._tries++ < 60 && !disposed) requestAnimationFrame(fit);
      w0 = w0 || W || 320; h0 = h0 || H || 240;
    } else fit._tries = 0;
    W = Math.max(320, w0);
    H = Math.max(240, h0);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    makeStars();
  }
  function project(n, zOverride) {
    var cy = Math.cos(ry), sy = Math.sin(ry);
    var x1 = n.x * cy - n.z * sy;
    var z1 = n.x * sy + n.z * cy;
    var cx0 = Math.cos(rx), sx0 = Math.sin(rx);
    var y1 = n.y * cx0 - z1 * sx0;
    var z2 = n.y * sx0 + z1 * cx0;
    var f = 820;
    var zz = (zOverride == null) ? zoom : zOverride;
    var s = (f / (f + z2 + 420)) * zz;
    return { x: W / 2 + x1 * s, y: H / 2 + y1 * s + viewShiftY, s: s, z: z2 };
  }
  function draw() {
    var ctx = cv.getContext('2d');
    try { drawInner(ctx); } catch (e) {
      try {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        ctx.font = '700 15px Consolas, monospace';
        ctx.fillStyle = '#ff4d6d';
        ctx.textAlign = 'left';
        ctx.fillText('neuron 绘制出错：' + ((e && e.message) || e), 16, 60);
      } catch (e2) { /* ignore */ }
    }
  }
  function drawInner(ctx) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // 背景：中心微光
    var bg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.62);
    bg.addColorStop(0, isLightTheme() ? 'rgba(37,99,235,.06)' : 'rgba(30,54,96,.55)');
    bg.addColorStop(1, 'rgba(6,9,16,0)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    var tt = fx ? (performance.now() / 1000) : 0;
    // 星点（有动效时轻微明暗呼吸，静止时一片星空）
    if (stars.length) {
      for (var si = 0; si < stars.length; si++) {
        var st = stars[si];
        var tw = fx ? (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(tt * st.sp + st.ph))) : 0.55;
        ctx.beginPath();
        ctx.arc(st.x, st.y, st.r, 0, 6.2832);
        ctx.fillStyle = isLightTheme() ? ('rgba(15,23,42,' + (0.16 * tw) + ')') : ('rgba(190,215,255,' + (0.07 * tw) + ')');
        ctx.fill();
      }
    }
    // 暗角：把注意力收到中间
    var vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.32, W / 2, H / 2, Math.max(W, H) * 0.78);
    vg.addColorStop(0, 'rgba(15,23,42,0)');
    vg.addColorStop(1, isLightTheme() ? 'rgba(15,23,42,.055)' : 'rgba(2,4,9,.55)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);

    // ══ 入场动画（2026-10-27 科幻版）══
    //   节拍：核心点火(0~0.3s) → 冲击波+扫描线(0.15~1.1s) → 连线逐条生长(0.26~1.9s) → 节点被依次点亮(0.26~1.8s) → 余晖淡出
    //   全程一次（2.4s），只在 fx 开着时跑；跑完所有进度=1，完全退回原来的静态渲染路径。
    var INTRO = 2400;
    var animOn = fx || introBoot;                                          // 动效关也允许"重读"重播一次
    var ei = animOn ? Math.max(0, performance.now() - (bornAt || 0)) : INTRO; // 已进入的毫秒数
    if (introBoot && ei > INTRO + 400) introBoot = false;                   // 只播一次，播完自动熄
    var eo = 1 - Math.pow(1 - Math.min(1, ei / INTRO), 3);                  // easeOutCubic：先快后慢
    var introOn = animOn && ei < INTRO + 400;
    var kk = 0.86 + 0.14 * eo;                                              // 位置只从 86% 展开，主要靠"生长"而不是"炸开"
    var D2C = Math.hypot(W, H) * 0.5 || 1;                                  // 画面中心 → 角的距离
    function waveT(norm) { return 260 + norm * 1150; }                      // 冲击波到达某处的时间
    function nodeNorm(n) {
      var qq = project(n);
      return Math.min(1, Math.hypot(qq.x - W / 2, qq.y - H / 2) / D2C);
    }
    function P(n) {
      var pp = project(n);
      if (kk < 0.999) { pp.x = W / 2 + (pp.x - W / 2) * kk; pp.y = H / 2 + (pp.y - H / 2) * kk; }
      return pp;
    }

    var byId = {}; nodes.forEach(function (n) { byId[n.id] = n; });
    var selN = sel ? byId[sel] : null;
    var hoverN = hover ? byId[hover] : null;
    var neigh = {};
    if (hoverN) {
      neigh[hoverN.id] = true;
      edges.forEach(function (e) {
        if (e.a === hoverN.id) neigh[e.b] = true;
        if (e.b === hoverN.id) neigh[e.a] = true;
      });
    }
    function dimmed(n) {
      if (q) {
        var hay = (n.id + ' ' + (n.label || '') + ' ' + (n.title || '') + ' ' + (n.region || '') + ' ' + (n.path || '')).toLowerCase();
        if (hay.indexOf(q) < 0 && n.kind !== 'core') return true;
      }
      if (hoverN) return !neigh[n.id];
      return false;
    }
    // 只看记忆：留下的种类（内核/场景/私有记忆/提交链/共享文档）
    var MEM_KINDS = { core: 1, area: 1, memory: 1, chain: 1, doc: 1 };
    function keep(n) { return !onlyMem || !!MEM_KINDS[n.kind]; }
    function col(group) { return COLOR[group] || '#94a3b8'; }
    function safeR(n, ps) { var r = n.r * ps; return (isFinite(r) && r > 0) ? Math.max(1.6, r) : 1.6; }

    // 先画线（远的先画）
    var segs = edges.map(function (e) {
      var a = byId[e.a], b = byId[e.b];
      if (!a || !b) return null;
      if (!keep(a) || !keep(b)) return null;
      var pa = P(a), pb = P(b);
      return { e: e, a: a, b: b, pa: pa, pb: pb, z: (pa.z + pb.z) / 2 };
    }).filter(Boolean).sort(function (x, y) { return y.z - x.z; });
    segs.forEach(function (s) {
      var hot = hoverN && (s.e.a === hoverN.id || s.e.b === hoverN.id);
      var active = selN && (s.e.a === selN.id || s.e.b === selN.id);
      // 入场：这条线什么时候开始长（按边中点离中心远近，像冲击波扫过去），长 520ms，从 a 端推向 b 端
      var gp = 1;
      if (introOn) {
        var mx = (s.pa.x + s.pb.x) / 2 - W / 2, my = (s.pa.y + s.pb.y) / 2 - H / 2;
        var mn = Math.min(1, Math.hypot(mx, my) / D2C);
        var gt = (ei - waveT(mn)) / 520;
        gp = gt <= 0 ? 0 : (gt >= 1 ? 1 : 1 - Math.pow(1 - gt, 3));
        if (gp <= 0) return;                       // 还没轮到这个方向
      }
      var alpha = (hot ? 0.55 : (active ? 0.4 : Math.max(0.05, 0.22 - s.z / 2600))) * (fx ? (0.5 + 0.5 * eo) : 1);
      if (introOn) alpha *= 0.35 + 0.65 * gp;
      if (s.e.kind === 'skill') alpha *= 0.55;
      if (dimmed(s.a) && dimmed(s.b)) alpha *= 0.25;
      // 线的颜色按类型分（记忆=近白、项目=青、依赖=青蓝、其余=蓝），一眼能分出关系
      var lc = (s.e.kind === 'memory') ? (isLightTheme() ? '71,85,105' : '223,231,255')
        : (s.e.kind === 'project') ? (isLightTheme() ? '13,148,136' : '45,212,191')
        : (s.e.kind === 'dep') ? (isLightTheme() ? '14,116,144' : '127,227,255') : (isLightTheme() ? '37,99,235' : '143,180,255');
      var core = hot ? 1.7 : (s.e.kind === 'dep' ? 1.15 : 0.85);
      var ex2 = s.pb.x, ey2 = s.pb.y;
      if (gp < 1) { ex2 = s.pa.x + (s.pb.x - s.pa.x) * gp; ey2 = s.pa.y + (s.pb.y - s.pa.y) * gp; }
      ctx.beginPath();
      ctx.moveTo(s.pa.x, s.pa.y);
      ctx.lineTo(ex2, ey2);
      if (fx && (hot || active)) {              // 悬停/选中：跑虚线流光
        ctx.setLineDash([5, 6]);
        ctx.lineDashOffset = -(tt * 26) % 11;
      }
      if (fx) {                                 // 霓虹光晕（宽、淡）
        ctx.strokeStyle = 'rgba(' + lc + ',' + (alpha * 0.17) + ')';
        ctx.lineWidth = core * 2.8;
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(' + lc + ',' + alpha + ')';
      ctx.lineWidth = core;
      ctx.stroke();
      ctx.setLineDash([]);
      if (introOn && gp < 1) {                     // 生长头：亮点把线"推"出来
        ctx.beginPath();
        ctx.arc(ex2, ey2, 2.4 + 1.8 * (1 - gp), 0, 6.2832);
        ctx.fillStyle = isLightTheme() ? ('rgba(37,99,235,' + (0.55 + 0.4 * (1 - gp)) + ')') : ('rgba(214,242,255,' + (0.55 + 0.4 * (1 - gp)) + ')');
        ctx.fill();
        ctx.beginPath();
        ctx.arc(ex2, ey2, 7 + 9 * (1 - gp), 0, 6.2832);
        ctx.fillStyle = isLightTheme() ? ('rgba(37,99,235,' + (0.18 * (1 - gp)) + ')') : ('rgba(120,200,255,' + (0.22 * (1 - gp)) + ')');
        ctx.fill();
      }
    });

    // 扫描光（高级感的关键：一次只有一条边在走，不抢戏）
    if (fx && segs.length && kk > 0.9) {
      var CYC = 2.4;
      var slot = Math.floor(tt / CYC);
      var sg2 = segs[slot % segs.length];
      if (sg2 && !dimmed(sg2.a) && !dimmed(sg2.b)) {
        var run2 = (tt % CYC) / CYC;
        var fade = Math.sin(Math.PI * run2);
        var ddx = sg2.pb.x - sg2.pa.x, ddy = sg2.pb.y - sg2.pa.y;
        var hx2 = sg2.pa.x + ddx * run2, hy2 = sg2.pa.y + ddy * run2;
        for (var t2 = 0; t2 < 6; t2++) {
          var q2 = Math.max(0, run2 - t2 * 0.022);
          var x2 = sg2.pa.x + ddx * q2, y2 = sg2.pa.y + ddy * q2;
          ctx.beginPath();
          ctx.arc(x2, y2, 1.5 - t2 * 0.16, 0, 6.2832);
          ctx.fillStyle = isLightTheme() ? ('rgba(37,99,235,' + (0.5 * fade * (1 - t2 / 6)) + ')') : ('rgba(215,235,255,' + (0.5 * fade * (1 - t2 / 6)) + ')');
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(hx2, hy2, 2.2, 0, 6.2832);
        ctx.fillStyle = isLightTheme() ? ('rgba(30,64,175,' + (0.85 * fade) + ')') : ('rgba(240,248,255,' + (0.85 * fade) + ')');
        ctx.fill();
      }
    }

    // 入场专属特效（只在前 2.8 秒，跑完这段画面回到原来的样子）
    if (introOn) {
      var cx0 = W / 2, cy0 = H / 2;
      var maxR = Math.hypot(W, H) * 0.62;
      // ① 核心点火闪光（前 320ms）
      if (ei < 320) {
        var fl = 1 - ei / 320;
        var fg = ctx.createRadialGradient(cx0, cy0, 0, cx0, cy0, 90 + 130 * fl);
        fg.addColorStop(0, isLightTheme() ? 'rgba(37,99,235,.20)' : 'rgba(224,246,255,' + (0.45 * fl) + ')');
        fg.addColorStop(0.4, isLightTheme() ? 'rgba(37,99,235,.10)' : 'rgba(110,200,255,' + (0.2 * fl) + ')');
        fg.addColorStop(1, isLightTheme() ? 'rgba(37,99,235,0)' : 'rgba(80,170,255,0)');
        ctx.fillStyle = fg;
        ctx.fillRect(0, 0, W, H);
      }
      // ② 两层冲击波（错开 180ms，从核心向外扩散、变淡变细）
      for (var wi = 0; wi < 2; wi++) {
        var wt = (ei - wi * 180) / 1100;
        if (wt > 0 && wt < 1) {
          var wr = maxR * (1 - Math.pow(1 - wt, 2.2));
          ctx.beginPath();
          ctx.arc(cx0, cy0, wr, 0, 6.2832);
          ctx.lineWidth = 2.4 - 1.4 * wt;
          ctx.strokeStyle = isLightTheme() ? ('rgba(37,99,235,' + (0.22 * (1 - wt) * (1 - wt)) + ')') : ('rgba(130,214,255,' + (0.34 * (1 - wt) * (1 - wt)) + ')');
          ctx.stroke();
        }
      }
      // ③ 扫描线：一次从上往下抹过（0.15~1.0s），像雷达扫过整片星图
      var sc = (ei - 150) / 850;
      if (sc > 0 && sc < 1) {
        var sy = H * (sc * sc * (3 - 2 * sc));
        var lg = ctx.createLinearGradient(0, sy - 90, 0, sy);
        lg.addColorStop(0, 'rgba(37,99,235,0)');
        lg.addColorStop(0.85, 'rgba(37,99,235,.06)');
        lg.addColorStop(1, 'rgba(37,99,235,.18)');
        ctx.fillStyle = lg;
        ctx.fillRect(0, sy - 90, W, 90);
        ctx.beginPath();
        ctx.moveTo(0, sy); ctx.lineTo(W, sy);
        ctx.lineWidth = 1;
        ctx.strokeStyle = isLightTheme() ? ('rgba(37,99,235,' + (0.22 * Math.sin(Math.PI * sc)) + ')') : ('rgba(190,236,255,' + (0.22 * Math.sin(Math.PI * sc)) + ')');
        ctx.stroke();
      }
      // ④ 沿线奔跑的粒子：入场时 5 颗，错开时间，跑完就没了
      if (segs.length) {
        for (var pi2 = 0; pi2 < 5; pi2++) {
          var pr2 = ((ei / 900) + pi2 * 0.21) % 1;
          if (pr2 <= 0 || pr2 >= 1) continue;
          var s3 = segs[(pi2 * 7 + Math.floor(ei / 900)) % segs.length];
          if (!s3) continue;
          var hx3 = s3.pa.x + (s3.pb.x - s3.pa.x) * pr2;
          var hy3 = s3.pa.y + (s3.pb.y - s3.pa.y) * pr2;
          ctx.beginPath();
          ctx.arc(hx3, hy3, 1.8, 0, 6.2832);
          ctx.fillStyle = isLightTheme() ? ('rgba(37,99,235,' + (0.55 * Math.sin(Math.PI * pr2)) + ')') : ('rgba(235,250,255,' + (0.55 * Math.sin(Math.PI * pr2)) + ')');
          ctx.fill();
        }
      }
    }

    var labelBoxes = [];
    // 再画节点（按深度排序）
    var list = nodes.filter(keep).map(function (n) { return { n: n, p: project(n) }; }).sort(function (a, b) { return a.p.z - b.p.z; });
    list.forEach(function (it) {
      var n = it.n, p = it.p;
      // 入场：节点等冲击波到达才亮（离中心越远越晚），亮的那一下带一圈扩散光环
      var np2 = 1, nring = 0;
      if (introOn) {
        var nt = (ei - waveT(nodeNorm(n))) / 420;
        np2 = nt <= 0 ? 0 : (nt >= 1 ? 1 : 1 - Math.pow(1 - nt, 3));
        if (np2 <= 0) return;
        nring = np2 < 1 ? (1 - np2) : 0;
      }
      var r = safeR(n, p.s) * (fx ? (0.55 + 0.45 * kk) : 1) * (introOn ? (0.5 + 0.5 * np2) : 1);

      var alpha = dimmed(n) ? 0.18 : Math.max(0.35, 1 - p.z / 1500);
      if (introOn) alpha *= 0.25 + 0.75 * np2;
      var c = col(n.group);
      if (n.kind === 'project') { if (n.status === 'delivery') c = isLightTheme() ? '#b45309' : '#f0a35e'; else if (n.status === 'archived' || n.status === 'parked') c = isLightTheme() ? '#64748b' : '#8b93a7'; }
      // 光晕
      var g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3.4);
      g.addColorStop(0, hexA(c, 0.55 * alpha));
      g.addColorStop(0.45, hexA(c, 0.16 * alpha));
      g.addColorStop(1, hexA(c, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, r * 3.4, 0, Math.PI * 2); ctx.fill();
      // 核：球面渐变（左上亮、右下暗）+ 细内描边
      var ng = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.38, r * 0.15, p.x, p.y, r * 1.15);
      ng.addColorStop(0, hexA('#ffffff', 0.55 * alpha));
      ng.addColorStop(0.35, hexA(c, 0.95 * alpha));
      ng.addColorStop(1, hexA(c, 0.72 * alpha));
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = ng;
      ctx.fill();
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.5, r - 0.6), 0, Math.PI * 2);
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = hexA('#ffffff', 0.22 * alpha);
      ctx.stroke();
      // 高光：左上一点亮，球体感
      ctx.beginPath();
      ctx.arc(p.x - r * 0.32, p.y - r * 0.34, Math.max(0.9, r * 0.34), 0, 6.2832);
      ctx.fillStyle = 'rgba(255,255,255,' + (0.28 * alpha) + ')';
      ctx.fill();
      if (nring > 0) {                             // 点亮瞬间：一圈光环扩散出去
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 4 + 26 * (1 - nring), 0, 6.2832);
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = hexA(isLightTheme() ? '#1d4ed8' : '#bfe8ff', 0.55 * nring);
        ctx.stroke();
      }
      if (n.missing) {                     // 2026-10-27 审计⑤：路径失效的点 → 红虚线圈
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 3.5, 0, 6.2832);
        ctx.setLineDash([2, 3]);
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = 'rgba(229,72,77,.8)';
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (n.kind === 'core') {
        ctx.lineWidth = 2; ctx.strokeStyle = hexA(isLightTheme() ? '#0e7490' : '#7fe3ff', 0.8); ctx.stroke();
      }
      if (n.kind === 'core' && fx) {       // 核心：缓慢旋转的细光环（全图唯一的常驻动效）
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(tt * 0.25);
        ctx.beginPath();
        ctx.setLineDash([3, 8]);
        ctx.arc(0, 0, r + 7, 0, 6.2832);
        ctx.lineWidth = 1.1;
        ctx.strokeStyle = hexA(isLightTheme() ? '#0e7490' : '#8fd7ff', 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
      if (selN && n.id === selN.id) {     // 选中：外圈光环
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 5, 0, 6.2832);
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = hexA(isLightTheme() ? '#1e3a8a' : '#cfe1ff', 0.75);
        ctx.stroke();
      }
      // 标签：内核 / 悬停 / 选中 / 搜索命中 / 大节点
      var show = false;
      if (labelMode === 2) show = n.kind === 'core' || (hoverN && n.id === hoverN.id) || (selN && n.id === selN.id);
      else if (labelMode === 1) show = true;
      else show = n.kind === 'core' || (hoverN && n.id === hoverN.id) || (selN && n.id === selN.id)
        || (q && !dimmed(n)) || (n.kind === 'area' && p.s > 0.55)
        || (n.kind === 'project' && (n.id === sel || n.id === hover || (p.s > 1.05 && n.deg > 0)));
      if (show) {
        var fsz = n.kind === 'core' ? 13 : (n.kind === 'area' ? 11 : (n.kind === 'project' ? 10 : 9));
        ctx.font = (n.kind === 'core' ? '700 13px' : (n.kind === 'area' ? '600 11px' : '500 ' + fsz + 'px')) + ' ui-sans-serif, "Microsoft YaHei", system-ui';
        var lbl = String(n.label || '');
        if (n.kind === 'skill' && lbl.length > 15) lbl = lbl.slice(0, 14) + '…';
        var tw = ctx.measureText(lbl).width;
        var force = (hoverN && n.id === hoverN.id) || (selN && n.id === selN.id) || (q && !dimmed(n));
        // 四向候选：上 → 下 → 右 → 左，挑第一个不撞的；都撞就照画（宿主：所有点都要有标签）
        // 记忆/链/数据源这类"卫星":先试右边（免得压住它贴着的主场景标签）；场景/项目先试上方
        var rightFirst = (n.kind === 'memory' || n.kind === 'chain' || n.kind === 'source');
        var cands = rightFirst
          ? [{ lx: p.x + r + 7, ly: p.y + 4, align: 'left' },
             { lx: p.x, ly: p.y - r - 7, align: 'center' },
             { lx: p.x, ly: p.y + r + 13, align: 'center' },
             { lx: p.x - r - 7, ly: p.y + 4, align: 'right' }]
          : [{ lx: p.x, ly: p.y - r - 7, align: 'center' },
             { lx: p.x, ly: p.y + r + 13, align: 'center' },
             { lx: p.x + r + 7, ly: p.y + 4, align: 'left' },
             { lx: p.x - r - 7, ly: p.y + 4, align: 'right' }];
        var pick = cands[0], clash = false;
        for (var ci = 0; ci < cands.length; ci++) {
          var cd = cands[ci];
          var x1 = cd.align === 'left' ? cd.lx : (cd.align === 'right' ? cd.lx - tw : cd.lx - tw / 2);
          var bx0 = { x1: x1 - 2, x2: x1 + tw + 2, y1: cd.ly - 10, y2: cd.ly + 3 };
          var hit2 = false;
          for (var bi = 0; bi < labelBoxes.length; bi++) {
            var bb = labelBoxes[bi];
            if (bx0.x1 < bb.x2 && bx0.x2 > bb.x1 && bx0.y1 < bb.y2 && bx0.y2 > bb.y1) { hit2 = true; break; }
          }
          if (!hit2) { pick = cd; clash = false; break; }
          pick = cd; clash = true;
        }
        var ly = pick.ly, alignMode = pick.align;
        var box = { x1: (alignMode === 'left' ? pick.lx : (alignMode === 'right' ? pick.lx - tw : pick.lx - tw / 2)) - 2,
                    x2: (alignMode === 'left' ? pick.lx + tw : (alignMode === 'right' ? pick.lx : pick.lx + tw / 2)) + 2,
                    y1: ly - 10, y2: ly + 3 };
        if (!clash || force || labelMode !== 2) {
          labelBoxes.push(box);
          // 底片：深色半透明圆角，压住后面的线和星点（"更清晰"主要靠它）
          var bx = box.x1 - 3, by = box.y1, bw = (box.x2 - box.x1) + 6, bh = (box.y2 - box.y1) + 1;
          ctx.beginPath();
          if (ctx.roundRect) { ctx.roundRect(bx, by, bw, bh, 4); }
          else { ctx.rect(bx, by, bw, bh); }
          ctx.fillStyle = isLightTheme() ? ('rgba(255,255,255,' + (force ? 0.94 : 0.72) + ')') : ('rgba(6,10,18,' + (force ? 0.62 : 0.34) + ')');
          ctx.fill();
          ctx.fillStyle = dimmed(n) ? 'rgba(15,23,42,.35)' : (isLightTheme() ? 'rgba(15,23,42,.92)' : 'rgba(226,236,255,.92)');
          ctx.fillStyle = force ? (isLightTheme() ? '#0f172a' : '#eaf2ff') : ctx.fillStyle;
          ctx.textAlign = alignMode;
          ctx.fillText(lbl, pick.lx, ly);
        }
      }
    });
  }
  function hexA(hex, a) {
    var h = hex.replace('#', '');
    var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  function loop(t) {
    if (disposed) return;
    if (auto && !document.hidden) { ry += 0.0032; }
    draw();
    raf = requestAnimationFrame(loop);
  }

  // ---------- 交互 ----------
  let drag = null;
  function pos(ev) {
    var r = cv.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }
  function pick(mx, my) {
    var best = null, bestD = 1e9;
    nodes.forEach(function (n) {
      var p = project(n);
      var rr = Math.max(6, n.r * p.s) + 6;
      var d = Math.hypot(p.x - mx, p.y - my);
      if (d < rr && d < bestD) { bestD = d; best = n; }
    });
    return best;
  }
  function onDown(ev) {
    drag = { x: ev.clientX, y: ev.clientY, ry: ry, rx: rx, moved: false };
    cv.setPointerCapture && cv.setPointerCapture(ev.pointerId);
  }
  function onMove(ev) {
    var p = pos(ev);
    if (drag) {
      var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      ry = drag.ry + dx * 0.006;
      rx = Math.max(-1.1, Math.min(1.1, drag.rx + dy * 0.005));
      return;
    }
    var n = pick(p.x, p.y);
    hover = n ? n.id : null;
    cv.style.cursor = n ? 'pointer' : 'grab';
  }
  function onUp(ev) {
    var wasDrag = drag && drag.moved;
    drag = null;
    if (wasDrag) return;
    var p = pos(ev);
    var n = pick(p.x, p.y);
    sel = n ? n.id : null;
    showDetail(n);
  }
  function onWheel(ev) {
    ev.preventDefault();
    zoom = Math.max(0.35, Math.min(9, zoom * (ev.deltaY > 0 ? 0.92 : 1.08)));
  }
  // 2026-10-27 审计⑤：点击/定位统一入口 —— 文件→预览面板，目录→资源管理器，失败退回系统打开
  function openNode(n) {
    var p = n && (n.path || (n.paths && n.paths[0]));
    if (!p) { stat.textContent = '这个节点没有路径'; return; }
    var APP = (window.app && window.app.app) || null;
    var isDir = !!n.isDir || /[\\/]$/.test(p) || !/\.[A-Za-z0-9]{1,6}$/.test(p);
    if (n.missing) stat.textContent = '⛔ 这个路径不存在：' + p;
    if (isDir) {
      if (APP && APP.openPath) {
        Promise.resolve(APP.openPath(p)).then(function (r) { if (r && r.ok === false) stat.textContent = '打不开：' + (r.error || ''); });
        return;
      }
    }
    if (OPEN) {
      Promise.resolve(OPEN(p)).then(function (r) {
        if (r && r.ok === false) {
          if (APP && APP.openPath) Promise.resolve(APP.openPath(p)).then(function (r2) { if (r2 && r2.ok === false) stat.textContent = '打不开：' + (r2.error || ''); });
          else stat.textContent = '打不开：' + (r.error || '');
        }
      });
      return;
    }
    if (APP && APP.openPath) { Promise.resolve(APP.openPath(p)); return; }
    stat.textContent = '这个版本没有打开通道';
  }

  function showDetail(n) {
    if (!n) { detail.classList.remove('on'); return; }
    detail.innerHTML = '';
    var t = el('div', 'kneu-dt', n.label + (n.title ? (' · ' + n.title) : ''));
    detail.appendChild(t);
    if (n.region) detail.appendChild(el('div', 'kneu-ds', n.region));
    if (n.owner) detail.appendChild(el('div', 'kneu-ds', '归属：' + n.owner + (n.status && n.status !== 'active' ? (' · 状态：' + n.status) : '')));
    (n.paths && n.paths.length ? n.paths : [n.path]).filter(Boolean).forEach(function (pp) {
      detail.appendChild(el('div', 'kneu-dp', pp));
    });
    if (n.aliases && n.aliases.length) detail.appendChild(el('div', 'kneu-ds', '别名：' + n.aliases.join(' / ')));
    if (n.kind === 'chain' && n.recent && n.recent.length) {
      detail.appendChild(el('div', 'kneu-ds', '共 ' + n.total + ' 段 · 最近：'));
      n.recent.forEach(function (e) {
        detail.appendChild(el('div', 'kneu-dp', e.coord + '  ' + String(e.title || '').slice(0, 26)));
      });
    }
    if (n.dsInfo) {
      if (n.dsInfo.count) detail.appendChild(el('div', 'kneu-ds', '数量：' + n.dsInfo.count));
      if (n.dsInfo.caveat) detail.appendChild(el('div', 'kneu-ds', '说明：' + n.dsInfo.caveat));
      if (n.dsInfo.index) detail.appendChild(el('div', 'kneu-dp', n.dsInfo.index));
    }
    if (n.isDir) detail.appendChild(el('div', 'kneu-ds', '（目录 · 里面按主题分文件）'));
    else if (n.size) detail.appendChild(el('div', 'kneu-ds', '约 ' + (n.size > 1024 ? (n.size / 1024).toFixed(1) + ' KB' : n.size + ' 字节')));
    if (n.missing) detail.appendChild(el('div', 'kneu-ds', '⛔ 文件不存在（路径已失效）：' + (n.path || '')));
    // 关系（2026-10-27 审计⑤：边原来只有颜色，这里写清"这条线是什么意思"）
    var relMap = {};
    var byIdD = {};
    nodes.forEach(function (x) { byIdD[x.id] = x; });
    edges.forEach(function (e2) {
      if (e2.a !== n.id && e2.b !== n.id) return;
      var o = byIdD[(e2.a === n.id) ? e2.b : e2.a];
      if (!o) return;
      var k = EDGE_LABEL[e2.kind] || e2.kind;
      (relMap[k] = relMap[k] || []).push(o.label);
    });
    Object.keys(relMap).forEach(function (k) {
      detail.appendChild(el('div', 'kneu-ds', k + '（' + relMap[k].length + '）：' + relMap[k].slice(0, 6).join('、') + (relMap[k].length > 6 ? ' …' : '')));
    });
    var row = el('div', 'kneu-drow');
    var bOpen = el('button', 'kneu-btn', n.isDir ? '📂 打开目录' : '📂 打开文件');
    bOpen.type = 'button';
    bOpen.addEventListener('click', function (ev) { ev.stopPropagation(); openNode(n); });
    var bReveal = el('button', 'kneu-btn', '🗂 资源管理器定位');
    bReveal.type = 'button';
    bReveal.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var APP = (window.app && window.app.app) || null;
      var p2 = n.path || (n.paths && n.paths[0]);
      if (!p2) { stat.textContent = '这个节点没有路径'; return; }
      if (APP && APP.revealPath) Promise.resolve(APP.revealPath(p2)).then(function (r) { if (r && r.ok === false) stat.textContent = '定位失败：' + (r.error || ''); });
      else stat.textContent = '这个版本没有定位通道';
    });
    var bCopy = el('button', 'kneu-btn', '⧉ 复制路径');
    bCopy.type = 'button';
    bCopy.addEventListener('click', function (ev) {
      ev.stopPropagation();
      try { navigator.clipboard.writeText(n.path || ''); bCopy.textContent = '✓ 已复制'; } catch (e) { /* ignore */ }
    });
    row.appendChild(bOpen); row.appendChild(bReveal); row.appendChild(bCopy);
    detail.appendChild(row);
    detail.classList.add('on');
  }

  bRot.addEventListener('click', function () {
    auto = !auto;
    bRot.classList.toggle('on', auto);
  });
  bReset.addEventListener('click', function () {
    ry = RY0; rx = RX0; zoom = 1.42; sel = null; hover = null; detail.classList.remove('on');
    // 复位 = 回默认机位；顺便按默认机位重排一次（用户可能在别的机位下改过面板宽度，适配是按 REF 机位算的）
    if (nodes.length) layout();
  });
  bReload.addEventListener('click', function () {
    introBoot = true;                 // 2026-10-27：重读 = 重读数据 + 重播一次入场动画
    bornAt = performance.now();
    load();
  });
  var statAll = '';   // 全量统计文案（切回时还原）
  bMem.addEventListener('click', function () {
    onlyMem = !onlyMem;
    bMem.textContent = onlyMem ? '只看记忆 ✓' : '只看记忆';
    bMem.classList.toggle('on', onlyMem);
    if (onlyMem) {
      statAll = stat.textContent;
      var c = { area: 0, memory: 0, chain: 0, doc: 0, chainSeg: 0 };
      nodes.forEach(function (n) {
        if (n.kind === 'area') c.area++;
        else if (n.kind === 'memory') c.memory++;
        else if (n.kind === 'chain') { c.chain++; c.chainSeg += (n.total || 0); }
        else if (n.kind === 'doc') c.doc++;
      });
      stat.textContent = '只看记忆 · 场景 ' + c.area + ' · 私有记忆 ' + c.memory + ' · 提交链 ' + c.chain + ' 条/' + c.chainSeg + ' 段 · 共享 ' + c.doc;
    } else if (statAll) {
      stat.textContent = statAll;
    }
  });
  bFx.addEventListener('click', function () {
    fx = !fx;
    bFx.textContent = '动效：' + (fx ? '开' : '关');
    bFx.classList.toggle('on', fx);
  });
  bFx.classList.toggle('on', fx);
  bLabel.addEventListener('click', function () {
    labelMode = (labelMode + 1) % 3;
    bLabel.textContent = '标签：' + ['自动', '全部', '关'][labelMode];
  });
  search.addEventListener('input', function () { q = String(search.value || '').trim().toLowerCase(); });
  cv.addEventListener('pointerdown', onDown);
  cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp);
  cv.addEventListener('pointerleave', function () { hover = null; });
  cv.addEventListener('wheel', onWheel, { passive: false });
  bRot.classList.toggle('on', auto);

  var ro = null;
  try {
    // 2026-11-07：尺寸变了除了重设位图，还要重排一次 —— 节点半径是按画布尺寸适配的（见 fitToViewport），
    //   只 fit() 不 layout() 会让窄面板里外圈节点一直裁在画布外。
    ro = new ResizeObserver(function () { fit(); if (nodes.length) layout(); });
    ro.observe(body);
  } catch (e) { /* 老内核没有 ResizeObserver */ }
  fit();
  load();
  raf = requestAnimationFrame(loop);

  delete body.dataset.neuronDone;
  return function cleanup() {
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    if (ro) { try { ro.disconnect(); } catch (e) { /* ignore */ } }
    cv.removeEventListener('pointerdown', onDown);
    cv.removeEventListener('pointermove', onMove);
    cv.removeEventListener('pointerup', onUp);
    cv.removeEventListener('wheel', onWheel);
    body.innerHTML = '';
  };
};

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

