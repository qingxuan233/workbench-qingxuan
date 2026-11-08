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
var renderers = {};

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
renderers.view = (body, meta, head) => {
  body.classList.add('view-panel');
  const pid = String(meta.id || 'panel');
  const A = window.app && window.app.app;      // 宿主通用能力：开外链 / 定位路径
  const F = window.app && window.app.file;     // 文件读写（没有 = 需要重启一次 GUI）
  const HOME = '预览';
  const storeKey = 'app.view.' + pid;          // 记住上次看的是哪个文件（⟳ / 切场景回来还在）
  const quickLinks = (Array.isArray(meta.quickLinks) ? meta.quickLinks : [])
    .filter(q => q && typeof q === 'object' && (q.url || q.path || q.launchPath));
  let cur = { kind: 'empty', path: '', url: '', title: '', dirty: false, size: 0, mtime: 0 };
  let inner = null;        // 当前主体元素（textarea / img / video / webview / 卡片）
  let disposed = false;
  let readSeq = 0;         // 异步读盘令牌：切得快时，晚回来的那次结果直接丢掉
  let officeStone = 0;     // Office→PDF 转换令牌：转换是异步的（几秒），切走之后晚回来的结果不许抢屏
  let flash = { text: '', cls: '', until: 0 };
  let flashTimer = null;

  const EXT = {
    text: ['md', 'markdown', 'txt', 'json', 'jsonc', 'js', 'mjs', 'cjs', 'ts', 'css', 'py', 'bat', 'cmd', 'ps1', 'vbs',
      'ini', 'cfg', 'conf', 'log', 'csv', 'srt', 'ass', 'vtt', 'yaml', 'yml', 'xml', 'sql', 'toml', 'sh', 'env', 'gitignore'],
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'],
    video: ['mp4', 'webm', 'mov', 'mkv', 'm4v', 'avi'],
    audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'],
    // 2026-09-26 加：PDF / Office（「设计杂活」场景要"什么都能预览"）
    pdf: ['pdf'],
    office: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf', 'odt', 'ods', 'odp', 'wps', 'et', 'dps']
  };
  const extOf = (p) => {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(p || '').trim());
    return m ? m[1].toLowerCase() : '';
  };
  const isHtml = (p) => /^(html?|htm)$/.test(extOf(p));
  // ★2026-10-13★ 用户要求「预览能预览更多类型、别双击就拉系统程序」：把"内核怎么都看不了"的封装 / 二进制类
  //   单列一类（清单跟自我复盘的 SR_EXT_OPAQUE 一致）⇒ 给一张说清楚的卡片 + 卡片里就能系统打开，
  //   而不是把它们当文本读出一屏乱码。认不出扩展名的，靠 openText 里的二进制嗅探兜底。
  const EXT_OPAQUE = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'psd', 'ai', 'exe', 'dll', 'msi',
    'db', 'sqlite', 'bin', 'iso', 'apk', 'ttf', 'otf', 'woff', 'woff2'];
  function pickKind(p) {
    const e = extOf(p);
    if (isHtml(p)) return 'web';                          // html：先看渲染效果，按钮能切去改源码
    if (EXT.image.indexOf(e) >= 0) return 'image';
    if (EXT.video.indexOf(e) >= 0) return 'video';
    if (EXT.audio.indexOf(e) >= 0) return 'audio';
    if (EXT.pdf.indexOf(e) >= 0) return 'pdf';                 // PDF：交给内核自带的阅读器（webview）
    if (EXT.office.indexOf(e) >= 0) return 'office';           // Office/WPS：内核渲染不了 ⇒ 给一张"怎么打开"的卡片
    if (EXT_OPAQUE.indexOf(e) >= 0) return 'opaque';           // 压缩包/安装包/二进制 ⇒ 提示卡 + 系统打开（★2026-10-13）
    return 'text';                                        // 其余都按文本读；真二进制由 openText 的嗅探退回提示卡
  }
  function fileUrl(p) { return 'file:///' + encodeURI(String(p).replace(/\\/g, '/')).replace(/^\/+/, ''); }
  const fmtSize = (n) => (!n ? '0 B' : (n < 1024 ? n + ' B' : (n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB')));
  const fmtClock = (sec) => {
    if (!sec) return '';
    try {
      const d = new Date(sec * 1000);
      const p2 = (x) => (x < 10 ? '0' + x : '' + x);
      return (d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
    } catch (e) { return ''; }
  };
  function remember(p) { try { if (p) localStorage.setItem(storeKey, p); else localStorage.removeItem(storeKey); } catch (e) { /* ignore */ } }

  // ---- DOM：一条工具行 + 主体 + 一条状态行 ----
  const HEADMODE = !!head;                 // 有标题行 ⇒ 按键并进标题行（见本渲染器顶部说明）
  const bar = el('div', 'view-bar');
  const what = el('div', 'view-what');
  const iconEl = el('span', 'view-icon', '👁');
  const nameEl = el('span', 'view-name', HOME);
  what.appendChild(iconEl); what.appendChild(nameEl);
  const acts = el('div', 'view-acts');
  bar.appendChild(what); bar.appendChild(acts);
  const bodyBox = el('div', 'view-body');
  const statusEl = el('div', 'view-status', '');
  // 2026-10-18（vw-ai 派单 · 可选）：状态行里那串路径也做成「单击即复制」，照自我复盘 fpath 的先例。
  statusEl.style.cursor = 'copy';
  statusEl.title = '点一下复制当前文件路径';
  statusEl.addEventListener('click', () => {
    const txt = String(cur.path || '').trim();
    if (!txt) return;
    const ok = () => say('✓ 已复制：' + txt);
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(txt).then(ok, () => { if (viewCopyText(txt)) ok(); }); return; } } catch (e) { /* 落下面 */ }
    if (viewCopyText(txt)) ok();
  });
  if (HEADMODE) {
    head.classList.add('view-head');
    body.classList.add('view-head-mode');            // 空状态行由 CSS :empty 收掉（不白占一行）
    acts.classList.add('view-head-acts');
    nameEl.classList.add('view-head-name');
    // ⚠ 必须插在**标题之后、副标题之前**：.panel-sub 是 flex:1 1 100% 独占一排，
    //   排在它后面的东西会被顶到第三排（自我复盘的窗口二踩过，见工作台项目信息 §23.5）。
    const titleEl = head.querySelector('.panel-title');
    if (titleEl) { head.insertBefore(nameEl, titleEl.nextSibling); head.insertBefore(acts, nameEl.nextSibling); }
    else { head.appendChild(nameEl); head.appendChild(acts); }
    // 标题行同时是拖拽把手 ⇒ 塞进去的东西必须阻断指针事件，否则点了没反应（公共工具，素材管理面板同一条）
    if (window.APP_RENDER_UTILS && window.APP_RENDER_UTILS.wireHeadNoDrag) {
      window.APP_RENDER_UTILS.wireHeadNoDrag(acts);
      window.APP_RENDER_UTILS.wireHeadNoDrag(nameEl);
    }
    // 2026-10-18（宿主实测反馈）：▲ 原来被 makePanel 插在 title 之后、又被这里的 nameEl/acts 挤到**✕ 关闭右边** ⇒
    //   容易误点关闭。现在把 ▲ 挪到**整排按钮最左边**（=「⟳ 重读」左边），并补一次 wireHeadNoDrag。
    const expBtn = head.querySelector('.panel-expand');
    if (expBtn) {
      head.insertBefore(expBtn, acts);
      if (window.APP_RENDER_UTILS && window.APP_RENDER_UTILS.wireHeadNoDrag) window.APP_RENDER_UTILS.wireHeadNoDrag(expBtn);
    }
    body.appendChild(bodyBox); body.appendChild(statusEl);
  } else {
    body.appendChild(bar); body.appendChild(bodyBox); body.appendChild(statusEl);
  }

  const B = {};
  function mkBtn(key, label, title, cls) {
    const b = el('button', 'file-refresh' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    if (title) b.title = title;
    B[key] = b;
    acts.appendChild(b);
    return b;
  }
  mkBtn('save', '💾 保存', '存盘（Ctrl+S）—— 只写 D: / E: 盘', 'primary');
  mkBtn('src', '✎ 编辑源码', '把 HTML 切回源码模式改');
  mkBtn('preview', '👁 看效果', '切回渲染效果（有改动会先存盘）');
  mkBtn('reread', '⟳ 重读', '从磁盘重新读一遍（丢掉没保存的手改）');
  mkBtn('sysopen', '🖥 系统打开', '用系统的默认程序打开这个文件');
  mkBtn('reveal', '📂 定位', '在资源管理器里选中它');
  // 2026-10-18（vw-ai 派单 · 宿主点名）：「宿主要能复制文件的具体路径」⇒ 专门一颗按钮。
  mkBtn('copypath', '⧉ 复制路径', '把这个文件的完整路径复制到剪贴板');
  mkBtn('close', '✕ 关闭', '回到空预览（文件不动）');
  // 常驻快捷入口（场景 json 配的）：视频工作流用它留住 ComfyUI 控制台
  quickLinks.forEach((q, i) => {
    const b = mkBtn('ql' + i, String(q.label || q.url || q.path), '切到这个页面：' + (q.url || q.path || q.launchPath));
    b.classList.add('view-quick');
    b.addEventListener('click', () => {
      if (q.url) open({ url: q.url, title: q.label || '' });
      else if (q.path) open({ path: q.path, title: q.label || q.kind || '' });
    });
    if (q.launchPath) {
      const d = mkBtn('qll' + i, '🖥', '桌面启动：' + q.launchPath);
      d.classList.add('view-quick');
      d.addEventListener('click', () => {
        if (A && A.openPath) A.openPath(q.launchPath);
        else say('没有宿主能力，打不开启动器', 'warn');
      });
    }
  });

  // 挂在 bodyBox 上的临时监听（换文件/⟳ 时统一摘掉，别攒着）——图片的滚轮缩放/拖动就挂这儿
  let bodyHooks = [];
  function clearBody() {
    officeStone++;                 // 任何一次"换内容"都让在飞的 Office 转换作废（否则它回来会抢屏）
    bodyHooks.forEach(h => { try { h(); } catch (e) { /* ignore */ } });
    bodyHooks = [];
    if (inner && inner.parentNode) inner.parentNode.removeChild(inner);
    inner = null;
  }
  function say(text, cls, ms) {
    flash = { text: text, cls: cls || '', until: Date.now() + (ms || 3500) };
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { if (!disposed) paintStatus(); }, (ms || 3500) + 30);
    paintStatus();
  }
  function paintStatus() {
    if (flash.until > Date.now() && flash.text) { statusEl.textContent = flash.text; statusEl.className = 'view-status ' + flash.cls; return; }
    statusEl.className = 'view-status';
    if (cur.kind === 'empty') { statusEl.textContent = F ? '' : '当前是旧主进程：文本读写要重启一次 GUI 才有（图片/视频/网页不受影响）'; return; }
    // 只读文档（画布双击「固定流程预设」摊出来的东西）：没有磁盘路径，状态行就印那句"这是什么、为什么不能改"
    if (cur.doc) { statusEl.textContent = cur.note || '只读预览'; return; }
    if (cur.url && !cur.path) { statusEl.textContent = cur.url; return; }
    if (cur.kind === 'dir') { statusEl.textContent = '文件夹 · ' + cur.path; return; }
    if (cur.kind === 'opaque') { statusEl.textContent = cur.path; return; }   // 二进制/封装类：只印路径，别写"已保存"（★2026-10-13）
    const bits = [cur.path];
    if (cur.size) bits.push(fmtSize(cur.size));
    if (cur.mtime) bits.push('改于 ' + fmtClock(cur.mtime));
    bits.push(cur.dirty ? '● 有改动没保存' : '已保存');
    statusEl.textContent = bits.join('  ·  ');
  }
  function paint() {
    const label = cur.title || (cur.path ? flowPathParts(cur.path).file : (cur.url || HOME));
    // 并进标题行时，空状态的「预览」跟面板标题重复 ⇒ 留空（标题行写的就是「预览」）
    nameEl.textContent = (HEADMODE && label === HOME) ? '' : label;
    nameEl.title = cur.path || cur.url || cur.note || '';
    if (cur.kind === 'dir') iconEl.textContent = '📁'; else iconEl.textContent = cur.kind === 'image' ? '🖼' : (cur.kind === 'video' ? '🎞' : (cur.kind === 'audio' ? '🔊'
      : (cur.kind === 'web' ? '🌐' : (cur.kind === 'preset' ? '📋' : (cur.kind === 'text' ? '✎' : (cur.kind === 'office' ? '📘' : (cur.kind === 'opaque' ? '📦' : '👁')))))));
    const isText = cur.kind === 'text' && !!cur.path;
    const webish = cur.kind === 'web';
    const isDir = cur.kind === 'dir';
    const htmlFile = isHtml(cur.path || '');
    // ★2026-09-26★ 按钮要**贴合场景**（用户点名）：目录视图自带「⟳ 刷新 / 📂 用资源管理器打开」，
    //   顶上那排通用的「重读 / 系统打开 / 定位」就是重复且语义不对 ⇒ 目录视图只留「✕ 关闭」。
    const on = {
      save: isText,
      src: webish && htmlFile,
      preview: isText && htmlFile,
      reread: !!(cur.path && cur.kind !== 'empty') && !isDir,
      sysopen: !!(cur.path || cur.url) && !isDir,
      reveal: !!cur.path && !isDir,
      copypath: !!(cur.path || cur.url) && !isDir,   // 2026-10-18：漏登记会导致永远 display:none（宿主实测「按钮没出现」）
      close: cur.kind !== 'empty'
    };
    Object.keys(B).forEach(k => { if (k.indexOf('ql') !== 0) B[k].style.display = on[k] ? '' : 'none'; });
    B.save.classList.toggle('dirty', !!cur.dirty);
    bodyBox.dataset.mode = cur.kind;
    paintStatus();
  }
  function shell(cls) { clearBody(); const d = el('div', cls || 'view-empty'); bodyBox.appendChild(d); inner = d; return d; }
  function card(icon, title, sub, pathText) {
    const d = shell();
    d.appendChild(el('div', 'view-empty-icon', icon));
    d.appendChild(el('div', 'view-empty-title', title));
    if (sub) d.appendChild(el('div', 'view-empty-sub', sub));
    if (pathText) d.appendChild(el('div', 'view-empty-path', pathText));
    return d;
  }
  // 2026-10-20（宿主：「本场景的文件预览默认显示最近打开的文件夹以及常用的文件夹」）
  //   配了 meta.home / meta.homeFolders 才出现；点一下 ⇒ 让 meta.filesPanel 指定的「文件管理」跳过去
  //   （file 面板对外挂了 window.__kunFiles[面板id].open(路径)，同文档直调，不用新 IPC）。
  function buildHome(host) {
    host.classList.add('has-home');     // 让空状态容器放宽（.view-empty 默认按内容收缩，网格会被挤成一列）
    const wrap = el('div', 'view-home');
    host.appendChild(wrap);
    const mkSection = (title) => {
      const box = el('div', 'view-home-sec');
      box.appendChild(el('div', 'view-home-h', title));
      const grid = el('div', 'view-home-grid');
      box.appendChild(grid); wrap.appendChild(box);
      return grid;
    };
    const nameOf = (p) => {
      const t = String(p || '').replace(/[\\/]+$/, '');
      const seg = t.split(/[\\/]/).filter(Boolean).pop();
      return seg || t || String(p || '');
    };
    const chip = (label, p) => {
      const b = el('button', 'view-home-chip');
      b.type = 'button';
      b.appendChild(el('span', 'ico', '📁'));
      const mid = el('span', 'mid');
      mid.appendChild(el('span', 'n', String(label || nameOf(p))));
      mid.appendChild(el('span', 'p', String(p)));
      b.appendChild(mid);
      b.title = p + '\n点击 ⇒ 让「文件管理」跳到这个文件夹';
      b.addEventListener('click', () => {
        const api = (window.__kunFiles || {})[String(meta.filesPanel || '')];
        if (api && api.open) { api.open(p); say('文件管理 → ' + p, 'ok'); }
        else if (A && A.openPath) A.openPath(p);
        else say('这个场景没有可跳转的文件管理面板', 'warn');
      });
      return b;
    };
    const favs = (Array.isArray(meta.homeFolders) ? meta.homeFolders : [])
      .map((x) => (x && typeof x === 'object')
        ? { label: x.label || '', path: String(x.path || x.launchPath || '') }
        : { label: '', path: String(x || '') })
      .filter((x) => !!x.path);
    if (favs.length) {
      const g1 = mkSection('常用文件夹');
      favs.forEach((x) => g1.appendChild(chip(x.label, x.path)));
    }
    const TB2 = window.app && window.app.topbar;
    if (TB2 && TB2.recentFolders) {
      Promise.resolve().then(() => TB2.recentFolders()).then((r) => {
        if (disposed) return;
        const rows = ((r && r.rows) || []).filter((x) => x && x.path);
        if (!rows.length) return;
        const g2 = mkSection('最近打开的文件夹');
        rows.slice(0, 6).forEach((x) => g2.appendChild(chip('', x.path)));
      }).catch(() => { /* 读不到最近记录就不显示这一节 */ });
    }
  }
  // 空状态：说明 + 手填路径打开（没有"选择文件"对话框这回事，直接让用户粘真实路径 —— 他就喜欢写路径）
  function showEmpty(msg) {
    cur = { kind: 'empty', path: '', url: '', title: '', dirty: false, size: 0, mtime: 0 };
    remember('');
    const d = card('👁', meta.hint ? String(meta.hint) : '这里是预览位',
      msg || (meta.emptyMsg != null ? String(meta.emptyMsg)
        : '流程画布上双击一个节点，它对应的文件就摊在这里（文本能直接改、能存盘）。也可以自己填个路径：'));
    if (meta.home || meta.homeFolders) buildHome(d);
    const row = el('div', 'view-open');
    const inp = el('input', 'view-open-input');
    inp.type = 'text';
    inp.placeholder = '<视频工作流>';
    inp.spellcheck = false;
    const go = el('button', 'file-refresh', '打开');
    go.type = 'button';
    const run = () => { const p = inp.value.trim().replace(/^"|"$/g, ''); if (p) open({ path: p }); };
    go.addEventListener('click', run);
    inp.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); run(); }
    });
    row.appendChild(inp); row.appendChild(go);
    d.appendChild(row);
    if (quickLinks.length) d.appendChild(el('div', 'view-empty-sub', '右上角的按钮是本场景的常驻入口，点一下就在这儿打开。'));
    paint();
  }
  function needRestart(p) {
    const d = card('🔒', '这个要重启一次 GUI 才能用', F ? '' : '宿主这次启动时还没有文件读写接口（app.file）。重启 GUI 后：文本能直接在这里改、Ctrl+S 存盘。图片/视频/网页不受影响。', p);
    const row = el('div', 'view-open');
    const mk = (label, fn) => { const b = el('button', 'file-refresh', label); b.type = 'button'; b.addEventListener('click', fn); row.appendChild(b); };
    mk('🖥 用系统程序打开', () => { if (A && A.openPath) A.openPath(p); });
    mk('📂 定位', () => { if (A && A.revealPath) A.revealPath(p); });
    d.appendChild(row);
  }

  // ★2026-10-13★ 「预览更多类型」：内核渲染不了、也转不出 PDF 的封装/二进制类（zip/rar/7z/psd/exe/msi/db/iso/apk…）
  //   单独归一类 ⇒ 给一张**说清楚**的卡片 + 卡片里就能「🖥 系统打开 / 📂 定位」，绝不白屏、不静默失败（照自我复盘那份做法）。
  //   ⚠ 它同时是"素材管理双击不再拉系统程序"的兜底：用户双击一个 zip，看到的是这张卡，不是一屏乱码。
  function openOpaque(p, why) {
    const d = card('📦', '这类文件内核看不了：' + flowPathParts(p).file,
      (why ? why + '。' : '') + '它属于压缩包 / 安装包 / 二进制这类格式（内核渲染不了，也转不出 PDF）。'
      + '看内容请用系统程序打开；要在这里看，请选文本、图片、视频、音频、PDF、Office 或 HTML。', p);
    const row = el('div', 'view-open');
    const mk = (label, fn) => { const b = el('button', 'file-refresh', label); b.type = 'button'; b.addEventListener('click', fn); row.appendChild(b); };
    mk('🖥 用系统程序打开', () => { if (A && A.openPath) A.openPath(p); else say('没有宿主能力，打不开', 'warn'); });
    mk('📂 定位', () => { if (A && A.revealPath) A.revealPath(p); });
    d.appendChild(row);
    remember(p);
  }

  async function flushDirty() {
    if (!(cur.dirty && cur.kind === 'text' && cur.path && inner && inner.tagName === 'TEXTAREA')) return;
    if (!F || !F.write) { cur.dirty = false; return; }
    const p = cur.path, text = inner.value;
    let r = null;
    try { r = await F.write(p, text); } catch (e) { r = { ok: false, err: String((e && e.message) || e) }; }
    cur.dirty = false;
    if (r && r.ok) { cur.size = r.size || cur.size; cur.mtime = r.mtime || cur.mtime; say('✓ 切走之前先自动存了：' + flowPathParts(p).file, 'ok'); }
    else say('⚠ 自动保存失败：' + ((r && r.err) || '未知'), 'bad');
  }
  async function saveText() {
    if (!(cur.kind === 'text' && cur.path && inner && inner.tagName === 'TEXTAREA')) return false;
    if (!F || !F.write) { say('宿主还没重启过：重启一次 GUI 才能写文件', 'warn'); return false; }
    const r = await F.write(cur.path, inner.value);
    if (r && r.ok) {
      cur.dirty = false; cur.size = r.size || 0; cur.mtime = r.mtime || 0;
      say('✓ 已保存 ' + fmtClock(r.mtime) + '  ·  ' + cur.path, 'ok');
    } else say('⚠ ' + ((r && r.err) || '保存失败'), 'bad');
    paint();
    return !!(r && r.ok);
  }

  async function openText(p) {
    const stone = ++readSeq;
    card('⏳', '正在读：' + flowPathParts(p).file, '', p);
    if (!F || !F.read) { needRestart(p); return; }
    let r = null;
    try { r = await F.read(p); } catch (e) { r = { ok: false, err: String((e && e.message) || e) }; }
    if (disposed || stone !== readSeq) return;
    if (!r || !r.ok) {
      const d = card('⚠', '打不开这个文件', (r && r.err) || '未知错误', p);
      const row = el('div', 'view-open');
      const mk = el('button', 'file-refresh', '📄 新建空文件');
      mk.type = 'button';
      mk.addEventListener('click', async () => {
        const w = await F.write(p, '');
        if (w && w.ok) openText(p); else say('新建失败：' + ((w && w.err) || ''), 'bad');
      });
      const mk2 = el('button', 'file-refresh', '🖥 系统打开');
      mk2.type = 'button';
      mk2.addEventListener('click', () => { if (A && A.openPath) A.openPath(p); });
      row.appendChild(mk); row.appendChild(mk2);
      d.appendChild(row);
      remember('');
      return;
    }
    cur.size = r.size || 0; cur.mtime = r.mtime || 0; cur.dirty = false;
    // ★2026-10-13★ 认不出扩展名、其实是二进制的文件（无后缀 / .sample 这类）：读回来出现 NUL 或大量坏字符
    //   （U+FFFD = utf8 解不开的字节）⇒ 退回"看不了"卡片，绝不把乱码糊在面板里（照自我复盘那份做法）。
    const rawTxt = r.text == null ? '' : String(r.text);
    if (rawTxt && (rawTxt.indexOf('\u0000') >= 0 || (rawTxt.match(/\uFFFD/g) || []).length > 8)) {
      cur.kind = 'opaque'; paint();
      return openOpaque(p, '这个文件其实是二进制');
    }
    clearBody();
    const ta = el('textarea', 'view-ta');
    ta.value = r.text == null ? '' : String(r.text);
    ta.spellcheck = false;
    ta.addEventListener('input', () => { if (!cur.dirty) { cur.dirty = true; paint(); } });
    ta.addEventListener('keydown', (ev) => {
      ev.stopPropagation();                                  // 别让快捷键跑到宿主/画布那边去
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === 's' || ev.key === 'S')) { ev.preventDefault(); saveText(); }
      else if (ev.key === 'Tab') {                           // 改 HTML / 脚本时 Tab 缩进比切焦点有用
        ev.preventDefault();
        const s = ta.selectionStart, e2 = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(e2);
        ta.selectionStart = ta.selectionEnd = s + 2;
        if (!cur.dirty) { cur.dirty = true; paint(); }
      }
    });
    bodyBox.appendChild(ta);
    inner = ta;
    remember(p);
    paint();
    try { ta.focus(); } catch (e) { /* ignore */ }
  }
  function openImage(p) {
    clearBody();
    const img = el('img', 'view-img');
    img.alt = flowPathParts(p).file;
    // ★ 本地图片**优先走宿主 IPC 读成 data: URL**（app.oa.image，上限 12MB）——跟文件面板的大图同一条路。
    //   为什么不让 file:// 先试：2026-09-26 用户实测"预览里本地图打不开"，而 data: 这条路一直是通的
    //   （data: 是 CSP 一直放行的源；file:// 在不同内核/CSP 组合下不一定通）。IPC 读不了（比如 >12MB）再退回 file://。
    const K = window.app && window.app.oa;
    let imgTriedFile = false;
    const useFile = () => {
      if (imgTriedFile || disposed) return;
      imgTriedFile = true;
      img.src = fileUrl(p);
      img.addEventListener('error', () => {
        if (disposed) return;
        say('图片没显示出来：文件不在、或者它其实不是图片'
          + '（名字以 ._ 开头的是 macOS 元数据文件，4KB 左右，不是图）', 'bad');
      }, { once: true });
    };
    if (K && K.image && p) {
      Promise.resolve(K.image(p)).then(r => {
        if (disposed) return;
        if (r && r.ok && r.dataUrl) img.src = r.dataUrl;
        else useFile();                                  // 读不到（例如超过 12MB）⇒ 退回 file://
      }).catch(useFile);
    } else {
      useFile();
    }
    bodyBox.appendChild(img); inner = img;
    // ★ 滚轮放大 / 拖动平移 / 双击复原（2026-09-26 用户要求："显示图片时可以滚轮放大缩小看细节"）
    //   做法：只动图片自己的 transform —— translate(tx,ty) scale(z)，原点固定 0 0（不动面板布局）。
    //   滚轮以**光标所在的那个点**为锚（缩放时它在屏幕上原地不动，否则一放大就跑偏，细节没法看）：
    //   锚点坐标要的是"没缩放时的矩形"，所以量之前先把 transform 摘掉再量，同一帧内改回去（不闪屏）。
    //   监听挂在 bodyBox 上（图片小的时候，边上的黑边也能滚），换文件时由 clearBody 统一摘掉。
    img.style.transformOrigin = '0 0';
    img.style.cursor = 'zoom-in';
    let z = 1, tx = 0, ty = 0, lastPct = 100, dragging = false, lx = 0, ly = 0;
    const applyT = () => { img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + z + ')'; };
    const baseRect = () => {
      const keep = img.style.transform;
      img.style.transform = 'none';
      const r = img.getBoundingClientRect();
      img.style.transform = keep;
      return r;
    };
    const onWheel = (e) => {
      if (!img.clientWidth) return;
      e.preventDefault();                                   // 别让面板/页面跟着滚
      const r = baseRect();
      const cx = e.clientX - r.left, cy = e.clientY - r.top;
      const nz = Math.min(20, Math.max(0.2, z * Math.exp(-e.deltaY * 0.0016)));
      if (nz === z) return;
      tx += cx * (z - nz);                                  // 光标那个点原地不动（推导见上）
      ty += cy * (z - nz);
      z = nz; applyT();
      img.style.cursor = z > 1.01 ? 'grab' : 'zoom-in';
      const pct = Math.round(z * 100);
      if (pct !== lastPct) {                                // 别每个滚轮事件都刷状态行
        lastPct = pct;
        say('缩放 ' + pct + '%' + (z > 1.01 ? ' · 按住拖动平移 · 双击复原' : ''), '', 1400);
      }
    };
    const onDown = (e) => {
      if (z <= 1.01 || e.button !== 0) return;              // 没放大 = 不拖动（保持原来的选中/拖拽行为）
      dragging = true; lx = e.clientX; ly = e.clientY;
      img.style.cursor = 'grabbing';
      try { bodyBox.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!dragging) return;
      tx += e.clientX - lx; ty += e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      applyT();
    };
    const onUp = () => { if (!dragging) return; dragging = false; img.style.cursor = z > 1.01 ? 'grab' : 'zoom-in'; };
    const onDbl = () => {
      z = 1; tx = 0; ty = 0; applyT(); lastPct = 100;
      img.style.cursor = 'zoom-in';
      say('已复原成适应窗口（滚轮放大，放大后按住拖动看细节）', '', 1600);
    };
    bodyBox.addEventListener('wheel', onWheel, { passive: false });
    bodyBox.addEventListener('pointerdown', onDown);
    bodyBox.addEventListener('pointermove', onMove);
    bodyBox.addEventListener('pointerup', onUp);
    bodyBox.addEventListener('pointercancel', onUp);
    bodyBox.addEventListener('dblclick', onDbl);
    bodyHooks.push(() => {
      bodyBox.removeEventListener('wheel', onWheel);
      bodyBox.removeEventListener('pointerdown', onDown);
      bodyBox.removeEventListener('pointermove', onMove);
      bodyBox.removeEventListener('pointerup', onUp);
      bodyBox.removeEventListener('pointercancel', onUp);
      bodyBox.removeEventListener('dblclick', onDbl);
    });
    remember(p);
    paint();
  }
  function openMedia(p, kind) {
    clearBody();
    const v = el(kind === 'audio' ? 'audio' : 'video', 'view-media-el');
    v.controls = true;
    v.src = fileUrl(p);
    bodyBox.appendChild(v); inner = v;
    remember(p);
    paint();
  }
  function openWeb(src) {
    clearBody();
    const wv = document.createElement('webview');
    wv.setAttribute('partition', 'persist:view-' + pid.replace(/[^A-Za-z0-9_-]/g, '_'));
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('src', src);
    wv.className = 'view-web';
    bodyBox.appendChild(wv); inner = wv;
    if (cur.path) remember(cur.path);
    paint();
  }
  // ---- PDF：用内核自带的 PDF 阅读器（<webview> 载 file://）----
  // 为什么不自己解析：Electron 自带 Chromium 的 PDF 查看器，翻页 / 缩放 / 搜索 / 打印都是现成的。
  // 万一这台机器上没出图（少数情况），工具栏的「🖥 系统打开」是兜底。
  function openPdf(p) {
    clearBody();
    const wv = document.createElement('webview');
    wv.setAttribute('partition', 'persist:view-' + pid.replace(/[^A-Za-z0-9_-]/g, '_'));
    wv.setAttribute('src', fileUrl(p));
    wv.className = 'view-web';
    bodyBox.appendChild(wv); inner = wv;
    remember(p);
    paint();
    say('PDF：用页面自带的工具条翻页/缩放；没显示出来就点「🖥 系统打开」', '', 6000);
  }
  // ---- Office / WPS 文档（★2026-10-13 升级：从"只能说怎么打开"变成"真能看"）----
  // 旧版只摊一张说明卡。现在先让主进程借本机装的 Office 把它转成 PDF（按文件缓存），
  //   转成功就直接喂给内核自带 PDF 阅读器 ⇒ Word / Excel / PPT 在这里就能看，版式是 Office 自己排的。
  // 转不动（.wps/.et/.dps 这类 WPS 私有格式、本机没装 Office、或主进程还是旧的）才退回那张说明卡，
  //   并把**具体原因**印在卡上 —— 用户明确要求"不要白屏、不要静默失败"。
  function openOffice(p) {
    const api = (window.app && window.app.file) || null;
    if (!api || typeof api.toPdf !== 'function') {
      openOfficeCard(p, '当前主进程还是旧的（没有 doc→PDF 接口）—— 重启一次 GUI 就能在这里内嵌预览');
      return;
    }
    clearBody();
    const stone = ++officeStone;        // clearBody 之后再取号：此后任何一次换内容都会让它作废
    const wrap = el('div', 'view-doc');
    wrap.appendChild(el('pre', 'view-doc-pre',
      '正在把这份 .' + extOf(p) + ' 转成 PDF 预览…\n\n'
      + '· 借本机装的 Office 转一次；第一次大约几秒，转完按文件缓存，再打开就是秒开\n'
      + '· 版式由 Office 自己排，跟原文件一致（翻页/缩放/搜索都用 PDF 阅读器那套）\n'
      + '· 不想等：直接点工具栏「🖥 系统打开」'));
    bodyBox.appendChild(wrap); inner = wrap;
    if (cur.path) remember(cur.path);
    paint();
    say('转换中…', '', 0);
    Promise.resolve(api.toPdf(p)).then(function (r) {
      if (disposed || stone !== officeStone) return;        // 期间切到别的文件了 ⇒ 丢掉这次结果
      if (r && r.ok && r.pdf) {
        openPdf(r.pdf);
        // openPdf 会把"上次看的文件"记成 %TEMP% 里那份转换产物 —— 这里改回**原始文档**：
        // 否则下次开面板会去恢复一个临时 PDF（临时目录一清就找不到，还会让人以为在预览 PDF）。
        remember(p);
        say(r.cached ? 'PDF（缓存命中）· 翻页/缩放用页面自带工具条' : '已转成 PDF 预览 · 下次打开秒开', '', 5000);
        return;
      }
      openOfficeCard(p, String((r && r.err) || '转换成 PDF 失败'));
    }).catch(function (e) {
      if (disposed || stone !== officeStone) return;
      openOfficeCard(p, '转换异常：' + String((e && e.message) || e));
    });
  }
  // 兜底卡片（转不动时才用）：说清是什么格式、为什么看不了、下一步点哪儿
  function openOfficeCard(p, why) {
    clearBody();
    const wrap = el('div', 'view-doc');
    const e = extOf(p);
    wrap.appendChild(el('pre', 'view-doc-pre',
      '这种格式（.' + e + '）没法内嵌预览。\n\n'
      + (why ? '原因：' + why + '\n\n' : '')
      + '三种做法：\n'
      + '  · 点工具栏「🖥 系统打开」—— 用 Word / WPS / Office 打开它（最常用）\n'
      + '  · 先在 Office 里「另存为 PDF」，PDF 能在预览面板里直接看\n'
      + '  · 只是要看/改文字：把内容贴给我，我在 AI 面板里处理'));
    wrap.appendChild(el('div', 'view-preset-cap', '文件'));
    wrap.appendChild(el('pre', 'view-preset-prompt', String(p)));
    bodyBox.appendChild(wrap); inner = wrap;
    remember(p);
    paint();
  }
  // ---- 两类"没有文件"的只读预览（画布上双击「固定流程预设」摊到这儿的东西）----
  // 共同点：都不读盘、不能改、**不写 last（remember）** —— 它们不是"上次看的文件"，
  //   写了的话下次开面板会试图按路径打开一个空路径。要改内容 = 回画布右键那个节点。
  // ① 只读文档（预览形式 = 文字说明）：把步骤 + 指令模板整段摊出来。
  //    为什么不用 readonly 的 textarea：那看着像"能改但点不动"，反而让人反复试；pre 一眼就是"看的"。
  function openDoc(o) {
    cur = {
      kind: 'text', path: '', url: '', title: String(o.title || ''), dirty: false, size: 0, mtime: 0,
      doc: true, note: String(o.note || '只读预览（要改就回画布右键那个节点 → ✎ 编辑节点）')
    };
    clearBody();
    const wrap = el('div', 'view-doc');
    // 用 pre 而不是普通 div：步骤/指令里的换行、缩进都是内容的一部分，不能被 HTML 折叠掉
    wrap.appendChild(el('pre', 'view-doc-pre', String(o.text == null ? '' : o.text)));
    bodyBox.appendChild(wrap); inner = wrap;
    paint();
  }
  // ② 流程图小图（预览形式 = 流程图小图）：小方块 + 箭头，**纯 HTML/CSS 的静态示意图**。
  //    ⚠ 这里是预览，不是可编辑画布 ⚠ —— 不拖、不连、不存盘。为什么不复用画布那套 DOM/SVG 内核：
  //    那套是编辑器（几十个事件 + 缩放 + 平移 + localStorage），为了画几个方块引进来，
  //    既拖慢预览面板，又会让人以为"这儿能连线"（不能，改法只有一个：右键画布上那个节点）。
  function openPresetMini(o) {
    const steps = (Array.isArray(o.steps) ? o.steps : []).map(s => String(s == null ? '' : s).trim()).filter(s => !!s);
    cur = {
      kind: 'preset', path: '', url: '', title: String(o.title || ''), dirty: false, size: 0, mtime: 0,
      doc: true, note: '固定流程预设 · ' + steps.length + ' 步（只读的示意图 —— 要改步骤就右键画布上那个节点）'
    };
    clearBody();
    const wrap = el('div', 'view-preset');
    if (!steps.length) wrap.appendChild(el('div', 'view-preset-empty', '这个预设还没写步骤（右键画布上那个节点 → ✎ 编辑节点，或在内置模板里挑一个）'));
    steps.forEach((s, i) => {
      const bx = el('div', 'view-preset-step');
      bx.appendChild(el('span', 'view-preset-no', String(i + 1)));
      bx.appendChild(el('span', 'view-preset-txt', s));
      wrap.appendChild(bx);
      if (i < steps.length - 1) {
        const ar = el('div', 'view-preset-arrow', '↓');
        ar.title = '下一步';
        wrap.appendChild(ar);
      }
    });
    const prompt = String(o.prompt || '').trim();
    if (prompt) {
      wrap.appendChild(el('div', 'view-preset-cap', '指令模板'));
      wrap.appendChild(el('pre', 'view-preset-prompt', prompt));
    }
    wrap.appendChild(el('div', 'view-preset-tip', '⚠ 这里是预览、不是可编辑画布 —— 要改步骤或指令，右键画布上那个节点 → ✎ 编辑节点'));
    bodyBox.appendChild(wrap); inner = wrap;
    paint();
  }

  // ★2026-09-26★ 项目文件夹（画布上双击「项目文件夹」节点）= 在预览面板里**摊开这个文件夹**：
  //   图片、视频直接给缩略图（视频用 <video preload="metadata"> 出首帧），双击任意一项 = 在**这个面板里**
  //   看/播（图片大图、视频/音频带播放条、文本可改可存）；顶部两个按钮：⟳ 刷新、📂 用资源管理器打开。
  //   列目录借宿主现成的 `app.oa.filesLocal`（= `oa:files:local`，本来是给 OA 用的，其实是通用的本地列目录，
  //   **不用新 IPC、不用重启 GUI**）。找不到预览面板时画布那边会退回"直接用资源管理器打开"。
  // ★2026-09-26★ 目录视图的小样式：**就地注入一段 <style>**（不去动 styles.css —— 那份不一定跟着热重载，
  //   而这里注入的只作用于 .kun-dir-* 这几个类名；幂等：已经插过就不重复插）。
  function ensureDirCss() {
    // ★2026-09-27 用户反馈：「文件夹预览里面的 md 文件显示太差了，可以显示文件名和图标」★
    //   原来是"缩略图区里放一个 📄 emoji + 下面一行窄窄的文件名"，实际看着就是**一张几乎全黑的空卡片**。
    //   现在：非图片/视频的文件（md/txt/json/srt…）走 `.plain` 卡片 —— **扩展名徽标当图标 + 文件名占两行**。
    //   ⚠ 必须带版本判据：老写法只有 `if (已存在) return`，改了 CSS 也不生效（同 ensureRunCss 那条经验）。
    // ★2026-09-27 v3 ★ 「卡片被压成 21~50px 横条」那条 bug 的修复就在下面这几条规则里（根因与量到的数字
    //   写在 .kun-dir-grid 那段注释里）。**版本号必须跟着改**（v2-filecards → v3-rows-fixed），
    //   否则老的 <style> 已经在文档里、`data-ver` 一样就直接 return，改了的 CSS 一条都不生效 —— 这条经验踩过两次。
    const VER = 'v4-grid-scroll';
    const old = document.getElementById('kun-view-dir-css');
    if (old && old.getAttribute('data-ver') === VER) return;
    if (old && old.parentNode) old.parentNode.removeChild(old);
    const st = document.createElement('style');
    st.id = 'kun-view-dir-css';
    st.setAttribute('data-ver', VER);
    st.textContent = [
      '.kun-dir-bar{display:flex;align-items:center;gap:8px;padding:7px 9px;border-bottom:1px solid var(--border);}',
      '.kun-dir-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);font-size:11px;color:var(--text-dim);}',
      '.kun-dir-btn{display:inline-flex;align-items:center;gap:5px;padding:4px 11px;border-radius:7px;cursor:pointer;font:inherit;font-size:11.5px;line-height:1.5;color:var(--text);background:rgba(255,255,255,.05);border:1px solid var(--border);transition:background .14s ease,border-color .14s ease,transform .1s ease;}',
      '.kun-dir-btn:hover{background:rgba(255,255,255,.11);border-color:var(--accent);}',
      '.kun-dir-btn:active{transform:translateY(1px);}',
      // ★2026-09-27 修「卡片被压成横条」★（用户截图：预览面板摊开项目文件夹，26 张卡每张只剩 ~21~50px 高的
      //   一条压扁/裁切的图片，文件名和大小全看不见）。
      //   根因：`.kun-dir-grid` 是 `flex:1` + `min-height:0` 的 flex item，而预览面板只占 2×2 格
      //   （scenarios\video-workflow.json 的 vw-view = col1,row4,w2,h2；主窗口 1558×913 ⇒ 面板体 ≈770×314
      //   ⇒ 网格只剩 ≈218px 高），grid 内容却要 ≈1008px ⇒ flex 把网格**压到内容高度以下**，
      //   grid-auto-rows 默认 auto 的行一起被压成 20.5px（真浏览器量到：卡 21px、行 20.5312px、
      //   而 .kun-dir-thumb 的 computed height 仍是 118px ⇒ 缩略图整个溢出卡片，
      //   被 `.kun-dir-card{overflow:hidden}` 裁掉下半 ⇒ 只剩一条图片横条，名字/大小全被吃掉）。
      //   修法（打不烂的写法）：① 网格**不再参与收缩**（flex:none）+ 行高不压缩（grid-auto-rows:max-content）
      //     ⇒ 网格永远按内容排满，装不下就自己滚动（wrap 有 min-height:0，滚动条落在网格内部）；
      //   ② 卡片一律 flex 列布局 + min-height:0，缩略图 flex:none 不被压；
      //   ③ JS 里再给 thumb/img/video/name/meta 写**内联兜底尺寸**（见 openDir），样式被别处覆盖也塌不了。
      // ★2026-09-27 再修（用户反馈"预览不全"）★：上一版写成 `flex:none`（不参与收缩）⇒ 网格按**内容高度**撑到 1000+px，
      //   超出面板的部分被裁掉、**下面那些项够不到**。正解 = **允许收缩到面板高度 + 内部滚动**（`flex:1 1 auto` + `min-height:0` + `overflow:auto`），
      //   同时保留 `grid-auto-rows:max-content` —— 那才是最初"卡片被压成横条"的真根因（行高被压扁）。
      '.kun-dir-grid{flex:1 1 auto;min-height:0;overflow:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));grid-auto-rows:max-content;gap:9px;padding:10px;align-content:start;}',
      '.kun-dir-card{display:flex;flex-direction:column;min-height:0;border:1px solid var(--border);border-radius:9px;overflow:hidden;cursor:pointer;background:var(--bg-panel);transition:border-color .14s ease,box-shadow .14s ease,transform .1s ease;}',
      '.kun-dir-card:hover{border-color:var(--accent);box-shadow:0 4px 14px rgba(0,0,0,.35);transform:translateY(-1px);}',
      '.kun-dir-thumb{height:118px;flex:none;display:flex;align-items:center;justify-content:center;background:#0d1424;font-size:34px;overflow:hidden;}',
      // ★媒体缩略图按**原始比例**铺满（object-fit:contain）——不加这条 <video> 会被拉变形/裁掉★（2026-09-27 用户："合适比例显示不要压缩"）
      '.kun-dir-thumb>img,.kun-dir-thumb>video{display:block;width:100%;height:100%;object-fit:contain;background:#0a1120;}',
      // 文件名/尺寸行：flex:none + 最多两行（媒体卡与徽标卡**同一条规则**，不再分叉；长文件名换行不裁字）
      '.kun-dir-name{flex:none;padding:6px 8px 2px;font-size:11px;line-height:1.35;color:var(--text);'
        + 'white-space:normal;word-break:break-all;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}',
      '.kun-dir-meta{flex:none;padding:0 8px 7px;font-size:10px;color:var(--text-dim);font-family:var(--mono);white-space:nowrap;}',
      '.kun-dir-empty{grid-column:1/-1;padding:22px 10px;text-align:center;color:var(--text-dim);font-size:12px;}',
      // ---- 非媒体文件（md/txt/json/srt/csv…）：不用 emoji 兜底，直接"扩展名徽标 + 两行文件名" ----
      '.kun-dir-card.plain .kun-dir-thumb{height:auto;min-height:66px;background:transparent;padding:13px 8px 4px;font-size:0;}',
      '.kun-dir-ext{display:inline-flex;align-items:center;justify-content:center;min-width:46px;padding:7px 12px;border-radius:9px;'
        + 'font-family:var(--mono);font-size:14px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;'
        + 'color:#7fe3ff;background:rgba(77,226,255,.13);border:1px solid rgba(77,226,255,.34);}',
      // 文件夹也用徽标（emoji 在不同机器上不一定有）
      '.kun-dir-card.dir .kun-dir-thumb{height:auto;min-height:66px;background:transparent;font-size:0;padding:13px 8px 4px;}',
      '.kun-dir-badge{display:inline-flex;align-items:center;justify-content:center;min-width:46px;padding:7px 12px;border-radius:9px;'
        + 'font-size:17px;color:#ffd479;background:rgba(224,179,65,.14);border:1px solid rgba(224,179,65,.36);}',
    ].join('\n');
    (document.head || document.body).appendChild(st);
  }
  async function openDir(p) {
    // ⚠ 先把整个 body 清干净：`clearBody()` 只删 `inner` 那**一个**节点，而这个视图有"工具条 + 网格"两块 ⇒
    //   只清 inner 会留下旧工具条（实测：双击两次 ⇒ 两根工具条叠着、卡片还被后来的空状态顶掉 ✗）。
    while (bodyBox.firstChild) bodyBox.removeChild(bodyBox.firstChild);
    inner = null;
    ensureDirCss();
    const K = (window.app && window.app.oa) || null;
    // 工具条 + 网格**包在一个 wrap 里**，wrap 就是 inner ⇒ 以后任何 clearBody() 都能一次清掉整块
    const wrap = el('div', 'view-dirwrap');
    wrap.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;';
    bodyBox.appendChild(wrap); inner = wrap;
    const bar = el('div', 'kun-dir-bar');
    const t = el('div', 'kun-dir-path', p);
    t.title = p;
    const bRef = el('button', 'kun-dir-btn', '⟳ 刷新');
    const bOpen = el('button', 'kun-dir-btn', '📂 用资源管理器打开');
    bar.appendChild(t); bar.appendChild(bRef); bar.appendChild(bOpen);
    wrap.appendChild(bar);
    const grid = el('div', 'kun-dir-grid');
    wrap.appendChild(grid);
    // ★2026-09-27 用户要求：「合适比例显示不要压缩，加个滚轮」★
    //   Ctrl/⌘ + 滚轮 = 调缩略图大小（72~320px，同时改卡片宽度）；**普通滚轮照旧滚动列表**（不抢滚动）。
    //   只作用在媒体卡（图片/视频）上；.plain/.dir 那种徽标卡高度自适应，别被内联高度压住。
    let thumbH = 118;
    const applyThumbSize = () => {
      const h = Math.round(thumbH);
      grid.style.gridTemplateColumns = 'repeat(auto-fill,minmax(' + Math.round(thumbH * 1.27) + 'px,1fr))';
      grid.querySelectorAll('.kun-dir-card:not(.plain):not(.dir) .kun-dir-thumb').forEach((x) => {
        // ⚠ 三个一起写：只写 height 的话，别的规则里的 flex-shrink / max-height 还是能把它压扁
        //   （2026-09-27 那条"卡片压成横条"的 bug 就是被 flex 压的）⇒ height + min/max 全部钉死。
        x.style.height = h + 'px';
        x.style.minHeight = h + 'px';
        x.style.maxHeight = h + 'px';
        x.style.flex = '0 0 auto';
      });
    };
    grid.addEventListener('wheel', (ev) => {
      if (!ev.ctrlKey && !ev.metaKey) return;                 // 普通滚轮 = 正常滚动
      ev.preventDefault();
      thumbH = Math.max(72, Math.min(320, thumbH * (ev.deltaY < 0 ? 1.12 : 0.9)));
      applyThumbSize();
      say('缩略图 ' + Math.round(thumbH) + 'px（Ctrl+滚轮 继续调；普通滚轮 = 滚动列表）', '', 1600);
    }, { passive: false });
    bRef.addEventListener('click', () => openDir(p));
    bOpen.addEventListener('click', () => { const A2 = window.app && window.app.app; if (A2 && A2.openPath) A2.openPath(p); else say('没有宿主打开能力', 'warn'); });
    if (!K || !K.filesLocal) {
      grid.appendChild(el('div', 'view-empty-s', '宿主没有列目录的能力（app.oa.filesLocal）—— 这台 GUI 版本旧了'));
      paint(); return;
    }
    const r = await K.filesLocal(p);
    if (disposed) return;
    if (!r || !r.ok) { grid.appendChild(el('div', 'view-empty-s', '读不了这个文件夹：' + ((r && r.err) || p))); paint(); return; }
    const rows = (r.rows || []).filter(x => !/^\./.test(x.name));
    if (!rows.length) { grid.appendChild(el('div', 'view-empty-s', '这个文件夹还是空的 —— 产物生成后会出现在这儿')); paint(); return; }
    const IMG = /\.(png|jpe?g|webp|gif|bmp)$/i, VID = /\.(mp4|mov|mkv|webm|avi|m4v)$/i, AUD = /\.(mp3|wav|m4a|flac|aac)$/i;
    const fmtSize = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');
    let nMedia = 0;
    // ★内联兜底尺寸（2026-09-27 修"卡片压成横条"那条 bug 的第二道防线）★
    //   为什么非要写内联：这次的根因是**容器被 flex 压缩**导致卡片只剩 21px，将来任何一条别的规则
    //   （新加的 .flow-node* 段、全局 img/div 规则、主题覆盖…）都可能再把它压一次。
    //   把每张卡的**骨架尺寸直接钉在元素 style 上**，样式表被谁盖了都塌不了：
    //     thumb 高（媒体卡）/ min-height（徽标卡）、img/video 充满且 contain、name 两行、meta 一行。
    const THUMB_FALLBACK = 'flex:0 0 auto;height:' + Math.round(thumbH) + 'px;min-height:' + Math.round(thumbH) + 'px;'
      + 'display:flex;align-items:center;justify-content:center;overflow:hidden;';
    const MEDIA_FALLBACK = 'display:block;width:100%;height:100%;max-width:100%;max-height:100%;object-fit:contain;flex:0 0 auto;';
    const BADGE_FALLBACK = 'flex:0 0 auto;height:auto;min-height:66px;display:flex;align-items:center;justify-content:center;overflow:hidden;';
    const NAME_FALLBACK = 'flex:0 0 auto;min-height:15px;padding:6px 8px 2px;font-size:11px;line-height:1.35;overflow:hidden;'
      + 'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-all;';
    const META_FALLBACK = 'flex:0 0 auto;padding:0 8px 7px;font-size:10px;line-height:1.3;white-space:nowrap;overflow:hidden;';
    rows.forEach(it => {
      const full = p.replace(/[\\/]+$/, '') + '\\' + it.name;
      const card = el('div', 'kun-dir-card');
      card.title = it.name + (it.isDir ? '\n双击进入这个子文件夹' : (IMG.test(it.name) ? '\n双击看大图' : ((VID.test(it.name) || AUD.test(it.name)) ? '\n双击播放' : '\n双击打开')));
      const thumb = el('div', 'kun-dir-thumb');
      // ★非图片/视频：给"扩展名徽标 + 两行文件名"的卡片（不再靠 emoji 兜底 —— 用户反馈那些 md 看着就是一张空卡）★
      const extOf = (n) => { const m = /\.([A-Za-z0-9]{1,5})$/.exec(n || ''); return m ? m[1].toLowerCase() : '文件'; };
      const isBadge = it.isDir || (!IMG.test(it.name) && !VID.test(it.name));
      thumb.style.cssText = isBadge
        ? (BADGE_FALLBACK + 'background:transparent;font-size:0;padding:13px 8px 4px;')
        : THUMB_FALLBACK;
      if (it.isDir) { card.classList.add('dir'); const b = el('span', 'kun-dir-badge', '📁'); b.textContent = '📁'; thumb.appendChild(b); }
      else if (IMG.test(it.name)) { const im = el('img', ''); im.src = fileUrl(full); im.loading = 'lazy'; im.style.cssText = MEDIA_FALLBACK; thumb.appendChild(im); nMedia++; }
      else if (VID.test(it.name)) { const vd = document.createElement('video'); vd.src = fileUrl(full); vd.preload = 'metadata'; vd.muted = true; vd.style.cssText = MEDIA_FALLBACK; thumb.appendChild(vd); nMedia++; }
      else if (AUD.test(it.name)) { card.classList.add('plain'); const b = el('span', 'kun-dir-ext', '♪ ' + extOf(it.name)); thumb.appendChild(b); }
      else { card.classList.add('plain'); const b = el('span', 'kun-dir-ext', extOf(it.name)); thumb.appendChild(b); }
      card.appendChild(thumb);
      const nm = el('div', 'kun-dir-name', it.name);
      nm.title = it.name; nm.style.cssText = NAME_FALLBACK;
      const mt = el('div', 'kun-dir-meta', it.isDir ? '文件夹' : fmtSize(it.size || 0));
      mt.style.cssText = META_FALLBACK;
      card.appendChild(nm); card.appendChild(mt);
      card.addEventListener('dblclick', () => { if (it.isDir) open({ kind: 'dir', path: full, title: it.name }); else open({ path: full, title: it.name }); });
      grid.appendChild(card);
    });
    applyThumbSize();          // 卡片都建好了，先按当前缩略图尺寸排一次（Ctrl+滚轮 就在这个基础上调）
    remember(p);
    say(rows.length + ' 项' + (nMedia ? '（' + nMedia + ' 个图片/视频）' : '') + ' · 双击就在这个面板里看/播');
    paint();
  }
  async function open(opt) {
    const o = opt || {};
    const p = String(o.path || '').trim();
    const url = String(o.url || '').trim();
    await flushDirty();                                   // 切走之前先把没存的手改存了（防丢）
    if (disposed) return;
    const kind = o.kind || (p ? pickKind(p) : 'web');
    // 画布上两类"没有文件"的东西走这两条支线（**必须排在 !p && !url 那道判空前面**，
    // 否则它们没有路径，会直接被当成"空预览"清屏 —— 用户点了个预设却什么都没发生）
    if (kind === 'preset') return openPresetMini(o);
    if (kind === 'text' && !p && !url) return openDoc(o);
    if (!p && !url) { showEmpty(); return; }
    cur = { kind: kind, path: p, url: url, title: String(o.title || ''), dirty: false, size: 0, mtime: 0 };
    paint();
    if (kind === 'text') return openText(p);
    if (kind === 'image') return openImage(p);
    if (kind === 'video' || kind === 'audio') return openMedia(p, kind);
    if (kind === 'dir') return openDir(p);                       // ★项目文件夹：摊开列出里面的东西（图片/视频带缩略图）
    if (kind === 'web') return openWeb(url || fileUrl(p));
    if (kind === 'pdf') return openPdf(p);                       // PDF：内核自带阅读器
    if (kind === 'office') return openOffice(p);                 // Office/WPS：先转 PDF 再内嵌显示（★2026-10-13）
    if (kind === 'opaque') return openOpaque(p);                 // 压缩包/安装包/二进制：提示卡 + 系统打开（★2026-10-13）
    showEmpty();
  }

  B.save.addEventListener('click', () => saveText());
  B.reread.addEventListener('click', () => {
    if (cur.kind === 'dir') { open({ kind: 'dir', path: cur.path, title: cur.title }); return; }   // 目录要按 dir 重开，否则会被当成文本
    if (cur.path) open({ path: cur.path, title: cur.title });
  });
  B.sysopen.addEventListener('click', () => {
    const t = cur.path || cur.url;
    if (!t) return;
    if (A && A.openPath) A.openPath(t); else say('没有宿主能力，打不开', 'warn');
  });
  B.reveal.addEventListener('click', () => { if (cur.path && A && A.revealPath) A.revealPath(cur.path); })
  // 2026-10-18（vw-ai 派单）：复制当前文件完整路径。web/url 态没有磁盘路径 ⇒ 退回复制 URL。
  //   两条兜底照本文件既有写法：navigator.clipboard 优先（真 GUI 聚焦时最稳），失败退 textarea+execCommand。
  const viewCopyText = (txt) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = txt;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) { return false; }
  };
  B.copypath.addEventListener('click', () => {
    const txt = String(cur.path || cur.url || '').trim();
    if (!txt) { say('还没打开文件，没路径可复制', 'warn'); return; }
    const ok = () => say('✓ 已复制：' + txt);
    const fb = () => { if (viewCopyText(txt)) ok(); else say('复制失败（窗口可能没聚焦）· 路径：' + txt, 'warn'); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(txt).then(ok, fb); return; }
    } catch (e) { /* 落到 fb */ }
    fb();
  });;
  B.close.addEventListener('click', () => showEmpty());
  B.src.addEventListener('click', () => { cur.kind = 'text'; paint(); openText(cur.path); });
  B.preview.addEventListener('click', async () => {
    const p = cur.path;
    await flushDirty();
    if (disposed) return;
    cur.kind = 'web'; cur.dirty = false; paint();
    openWeb(fileUrl(p));
  });

  const api = {
    pid: pid,
    current: () => ({ kind: cur.kind, path: cur.path, url: cur.url, title: cur.title, dirty: !!cur.dirty }),
    show: (o) => open(o || {}),
    clear: () => showEmpty()
  };
  window.__kunViews = window.__kunViews || {};
  window.__kunViews[pid] = api;

  // 开场：先按上次看的文件恢复（有才开），否则空状态
  let last = '';
  try { last = localStorage.getItem(storeKey) || ''; } catch (e) { last = ''; }
  if (last) open({ path: last });
  else showEmpty();

  return () => {
    disposed = true;
    readSeq++;
    // 面板被销毁（切场景 / ⟳）前抢存一次手改 —— 不能让用户的心血随面板一起没
    if (cur.dirty && cur.kind === 'text' && cur.path && inner && inner.tagName === 'TEXTAREA' && F && F.write) {
      try { F.write(cur.path, inner.value); } catch (e) { /* ignore */ }
    }
    if (flashTimer) clearTimeout(flashTimer);
    if (window.__kunViews && window.__kunViews[pid] === api) delete window.__kunViews[pid];
    clearBody();
  };
};

// ============ embed：把"本机自带的网页工具"整页内嵌进面板（<webview>） ============
// 首个用户：视频工作流 窗口1 = ComfyUI 控制台（http://127.0.0.1:8189/，bridge.py 起的本地页面）。
// 为什么用 <webview> 而不是 iframe：与 harness / 官网预览一致，guest view 独立进程更稳，
// 且能带自己的 partition（一板一分区），不和引擎面板串味。
//
// 配置（都在场景 json 的面板对象里，全是选填、缺省即"没有这个按钮"）：
//   meta.url          必填，要内嵌的页面
//   meta.failHint     连不上时卡片里的一句话排查提示
//   meta.launchPath   桌面启动器的路径（快捷方式/exe）：点「🖥 桌面启动」就用宿主能力打开它
//   meta.launchLabel  桌面启动按钮文字（默认「🖥 桌面启动」）
//   meta.launchHint   点完桌面启动后卡片里显示的那句话
//   meta.embedToggle  false = 不显示「内置/取消内置」按钮（默认显示）
//   meta.offHint      「取消内置」后卡片里的说明（默认一句通用说明）
// 为什么桌面启动不用新开 IPC：宿主通用能力 app:open-path 走 shell.openPath（= ShellExecute），
// 传桌面 .lnk 就等价于双击快捷方式，所以这条路不用重启 GUI 就能加。
//
// 「内置 / 取消内置」（2026-09-20 加，用户要求"比较灵活"）：取消内置 = 把 <webview> 真的摘掉
// （不是隐藏）——不再有 guest 进程、也不会有第二份轮询；选择记在 localStorage，⟳/切场景都记得住。
// 内嵌页面的 UA：Electron 默认 UA 尾巴上挂着 "Electron/43.4.0"，有的站点一看就把页面盖成
// 「使用环境异常 / 建议使用我们的官方产品」弹窗（DeepSeek 网页版 2026-09-20 实测如此）。
// meta.userAgent 写 "chrome" ⇒ 换成一条**纯 Chrome UA**，Chrome 版本取当前 Electron 真实内核版本
// （process.versions.chrome，不写死、不撒谎）；也可以直接写完整 UA 字符串；不写 = 不动（用默认）。
// 为什么用函数声明而不是顶层 const/let：renderers.js 会被反复 ⟳ 重新求值，顶层 const 会重复声明报错。
function resolveEmbedUA(v) {
  if (!v) return '';
  if (v !== 'chrome' && v !== true) return String(v);
  var ver = '';
  try { ver = (typeof process !== 'undefined' && process.versions && process.versions.chrome) || ''; } catch (e) { ver = ''; }
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/'
    + (ver || '<IP>') + ' Safari/537.36';
}

// ==========================================================================================
// 2026-10-19 22:5x（宿主：「左边点开视频，右边直接说『总结这个』就行」· dg-dsh 派单）
//   当前视频同步：只在 **B站场景的 embed 面板** 上，每 1.5s 看一次 webview 的 URL，
//   抽 BV 号 + document.title，写到 `引擎\场景项目信息\B站\当前视频.json`（AI 侧已约定读它）。
//   ⛔ 不动 src / 不 reload / 不往页面里注入；⛔ 只在内容变化时写盘；⛔ 只认 bilibili 场景。
//   ⛔ 失败一律静默（同步挂了绝不影响看视频）。
// ==========================================================================================
function startBiliTrack(wv, meta) {
  try {
    var scene = String((meta && meta.scenario) || '');
    if (scene !== 'bilibili') return;                        // 别的场景嵌网页一律不装
    if (window.__biliTrack && window.__biliTrack.stop) window.__biliTrack.stop();   // 幂等：只跑一个
    var OUT = ((window.app && window.app.paths && window.app.paths.memRoot) || '') + '\\B站\\当前视频.json';
    var last = '', timer = null, alive = true, seenInDoc = false;
    function iso() {
      var d = new Date();
      var off = -d.getTimezoneOffset(), oh = Math.floor(Math.abs(off) / 60), om = Math.abs(off) % 60;
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' +
        p(d.getMinutes()) + ':' + p(d.getSeconds()) + (off >= 0 ? '+' : '-') + p(oh) + ':' + p(om);
    }
    function write(bv, url, title) {
      if (!url) return;                                       // webview 还没就绪 ⇒ 不写（免得刷一堆空记录）
      // ⚠ 2026-10-19 自查修的 bug：原来拿**整个 JSON**（含 at）比 ⇒ 每轮都不同 ⇒ 一直在刷盘。
      //   现在只比 bv+url+title；at 只记"这次写入的时间"。
      var key = String(bv) + '|' + url + '|' + String(title || '');
      if (key === last) return;
      var txt = JSON.stringify({ bv: bv, url: url, title: String(title || ''), at: iso() });
      // （内容没变已在上面按 key 拦掉；这句保留只为兼容旧注释，不会命中）
      last = key;
      try {
        if (window.app && window.app.file && window.app.file.write) {
          Promise.resolve(window.app.file.write(OUT, txt + '\n')).catch(function () { /* 静默 */ });
        }
      } catch (e) { /* 静默 */ }
    }
    function stop() { alive = false; if (timer) { clearInterval(timer); timer = null; } window.__biliTrack = null; }
    function tick() {
      if (!alive) return;
      var inDoc = document.body.contains(wv);
      if (inDoc) seenInDoc = true;                                  // 挂上过一次才算“活过”
      else if (seenInDoc) { stop(); return; }                       // 曾经挂上 → 现在没了 ⇒ 面板销毁/场景切走
      else return;                                                 // 还没挂上 ⇒ 先等（别把自己判死）
      var url = '';
      try { url = (wv.getURL && wv.getURL()) || ''; } catch (e) { url = ''; }
      if (!url) return;
      var m = /\/video\/(BV[0-9A-Za-z]+)/.exec(url);
      var bv = m ? m[1] : null;
      var done = function (t) { if (alive) write(bv, url, t); };
      // 2026-10-19 自查修：原来首页直接 done('') 不取 title ⇒ 文件里 title 永远是空串。
      //   现在统一走下面的"取 title"路径（bv=null 也照样取，契约里两态都有 title）。
      try {
        Promise.resolve(wv.executeJavaScript('document.title')).then(function (t) { done(t); }).catch(function () { done(''); });
      } catch (e) { done(''); }
    }
    timer = setInterval(tick, 1500);
    window.__biliTrack = { stop: stop, at: Date.now(), out: OUT };
    // 2026-10-19 23:4x（宿主：打字/滚动/选中都行，就是点了不跳转）——**换方式**：不依赖弹窗策略，
    //   直接在页面里接管"新窗口链接"：点 a[target=_blank] ⇒ 当前页面打开（location.href）。幂等、失败静默。
    var LINKFIX = '(function(){try{if(window.__dshLinkFix)return "ok";window.__dshLinkFix=1;'
      + 'document.addEventListener("click",function(e){try{'
      + 'var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;'
      + 'var h=a.getAttribute("href")||"";'
      + 'if(!h||h==="#"||h.indexOf("javascript:")===0||h.indexOf("#")===0)return;'
      + 'if(a.target==="_blank"||!a.target){e.preventDefault();location.href=a.href;}'
      + '}catch(_){}},true);return "ok";}catch(e){return "err";}})()';
    function installLinkFix() {
      try { Promise.resolve(wv.executeJavaScript(LINKFIX)).catch(function () {}); } catch (e) { /* ignore */ }
    }
    try { wv.addEventListener('did-finish-load', function () { installLinkFix(); }); } catch (e) {}
    installLinkFix();
    tick();
    if (window.console) console.log('[biliTrack] 已启动 ⇒ ' + OUT);
  } catch (e) { /* 静默 */ }
}

// ==========================================================================================
// 2026-10-19 23:2x（bv-ai 派单）—— 临时点击探针，用来判断"点击到底进没进 guest"
//   写到 `引擎\场景项目信息\B站\_点击探针.json`（⚠ 临时文件，定位完就删；不污染 AI 认的 当前视频.json）
//   采：① guest 内的 document 级 click 计数与最近一次 target ② a[target=_blank] 数量
//       ③ 屏幕中心点 elementFromPoint（guest 内）④ 同一位置在**宿主页面**里的 elementFromPoint（看有没有东西盖住 webview）
// ==========================================================================================
function startBiliProbe(wv, meta) {
  try {
    if (String((meta && meta.scenario) || '') !== 'bilibili') return;
    if (window.__biliProbe && window.__biliProbe.stop) window.__biliProbe.stop();
    var OUT = ((window.app && window.app.paths && window.app.paths.memRoot) || '') + '\\B站\\_点击探针.json';
    var last = '', timer = null, alive = true, seen = false, injected = false;
    var INJECT = '(function(){try{if(window.__dshProbe)return "exists";window.__dshProbe={n:0,last:""};'
      + 'document.addEventListener("click",function(e){try{window.__dshProbe.n++;var el=e.target||{};'
      + 'var t=(el.tagName||"?")+"#"+(el.id||"")+"."+String(el.className||"");window.__dshProbe.last=t.slice(0,140);}catch(_){}} ,true);'
      + 'return "ok";}catch(e){return "err:"+String(e&&e.message||e);}})()';
    var READ = '(function(){try{var p=window.__dshProbe||{};'
      + 'var a=document.querySelectorAll("a[target=_blank]").length;'
      + 'var el=null;try{el=document.elementFromPoint((innerWidth||800)/2,(innerHeight||600)/2);}catch(_){}'
      + 'var mid=el?((el.tagName||"?")+"#"+(el.id||"")+"."+String(el.className||"")):"";'
      + 'return JSON.stringify({clicks:p.n||0,last:p.last||"",ab:a,mid:mid.slice(0,140)});'
      + '}catch(e){return JSON.stringify({err:String(e&&e.message||e)});}})()';
    function stop() { alive = false; if (timer) { clearInterval(timer); timer = null; } window.__biliProbe = null; }
    function tick() {
      if (!alive) return;
      var inDoc = document.body.contains(wv);
      if (inDoc) seen = true; else if (seen) { stop(); return; } else return;
      if (!injected) { injected = true; try { Promise.resolve(wv.executeJavaScript(INJECT)).catch(function () {}); } catch (e) {} }
      var r = null;
      try { r = wv.getBoundingClientRect(); } catch (e) { r = null; }
      var top = '', rect = '';
      if (r && r.width > 8 && r.height > 8) {
        rect = Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.width) + 'x' + Math.round(r.height);
        try {
          var he = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          top = he ? (String(he.tagName || '?').toLowerCase() + '#' + (he.id || '') + '.' + String(he.className || '')) : '';
        } catch (e) { top = 'err'; }
      }
      try {
        Promise.resolve(wv.executeJavaScript(READ)).then(function (s) {
          var g = {};
          try { g = JSON.parse(String(s || '{}')); } catch (e) { g = { parse: 'fail' }; }
          var obj = { at: Date.now(), clicks: g.clicks || 0, last: g.last || '', ab: g.ab, mid: g.mid || '',
                      hostTop: top, rect: rect, pe: (wv.style.pointerEvents || '(none-set)'), op: (wv.style.opacity || '(none-set)') };
          var txt = JSON.stringify(obj);
          if (txt !== last) {
            last = txt;
            try { if (window.app && window.app.file && window.app.file.write) Promise.resolve(window.app.file.write(OUT, txt + '\n')).catch(function () {}); } catch (e) {}
          }
        }).catch(function () {});
      } catch (e) { /* 静默 */ }
    }
    timer = setInterval(tick, 1500);
    window.__biliProbe = { stop: stop, out: OUT };
    tick();
  } catch (e) { /* 静默 */ }
}

// ==========================================================================================
// 2026-10-19 23:2x（宿主：启动动画要可选）—— 外壳侧"播放层"
//   ① 启动时读 <盘根>:\DSH\外壳\data\boot-animation.json 的 id ⇒ 给 #boot-overlay 加 data-anim
//      （文件不存在/坏了 ⇒ 一律回落 classic，⛔ 绝不让启动失败）
//   ② window.__bootPreview(id)：把 overlay 亮出来按 id 播一遍，1.8 秒后收起（给插件点选用）
//   ⛔ 不碰 boot 逻辑（__bootPaint / __bootFinish / 超时 / 重试全在 renderer.js，一个字没动）
// ==========================================================================================
(function bootAnimRegistry() {
  var CFG = ((window.app && window.app.paths && window.app.paths.bootCfg) || '');
  // 2026-10-20（宿主：把片头视频做成启动动画）—— 视频铺满 overlay（muted 自动播放才允许），
  //   其余（底部光带/百分比/立即进入）由 CSS 叠在上面；只在 id=video 时挂，别的动画会把它摘掉。
  function ensureBootVideo(id) {
    try {
      var ov = document.getElementById('boot-overlay');
      if (!ov) return;
      var v = ov.querySelector('.boot-video');
      // 2026-10-20：支持多个视频动画 —— 按 id 选文件（video=线条睁眼鲸鱼 3D · slogan=为理想奋斗）
      var VID_SRC = {
        video: '../renderer/assets/boot-video.mp4',
        slogan: '../renderer/assets/boot-video-slogan.mp4'
      };
      var want = VID_SRC[id] || '';
      if (!want) { if (v) v.remove(); return; }
      if (v && v.getAttribute('data-anim-src') === want) { try { v.currentTime = 0; v.play(); } catch (e) {} return; }
      if (v) { try { v.remove(); } catch (e) {} v = null; }
      var el2 = document.createElement('video');
      el2.className = 'boot-video';
      el2.setAttribute('data-anim-src', want);
      el2.src = want;
      el2.autoplay = true; el2.muted = true; el2.playsInline = true;
      el2.setAttribute('muted', '');
      el2.setAttribute('playsinline', '');
      ov.insertBefore(el2, ov.firstChild);
      try { el2.play(); } catch (e) { /* 自动播放被拒也没关系，画面会在下次交互开始 */ }
    } catch (e) { /* 静默 */ }
  }
  // 2026-10-21（宿主：ideal 只有一屏太单一）—— 新动画 ideal2「星火 · 钢铁 · 理想」三幕轮播。
  //   画在 overlay 上（不进 .boot-card，免得跟进度条的 flex 布局打架）；id 不是 ideal2 就把这块摘掉。
  var BA_HTML = [
    '<div class="ba-act ba1">',
    '  <div class="ba-emblem"></div>',
    '  <div class="ba-spark s1"></div><div class="ba-spark s2"></div><div class="ba-spark s3"></div>',
    '  <div class="ba-spark s4"></div><div class="ba-spark s5"></div><div class="ba-spark s6"></div>',
    '  <div class="ba-quote">为理想而奋斗</div>',
    '  <div class="ba-sub">星星之火，可以燎原</div>',
    '</div>',
    '<div class="ba-act ba2">',
    '  <div class="ba-cam">',
    '    <div class="ba-flagStage">',
    '      <div class="ba-flag">',
    '        <div class="ba-strips"></div>',
    '        <div class="ba-shade"></div>',
    '        <svg class="ba-sketch" viewBox="0 0 480 320" fill="none" stroke="#ffd9a9" stroke-width="2.6" stroke-linejoin="round" aria-hidden="true">',
    '          <rect class="ba-draw" x="2" y="2" width="476" height="316" stroke-dasharray="1590" stroke-dashoffset="1590"/>',
    '          <polygon class="ba-draw d2" points="80.0,32.0 90.8,65.2 125.7,65.2 97.4,85.7 108.2,118.8 80.0,98.3 51.8,118.8 62.6,85.7 34.3,65.2 69.2,65.2" stroke-dasharray="330" stroke-dashoffset="330"/>',
    '          <polygon class="ba-draw d3" points="146.3,40.2 153.9,31.5 147.9,21.5 158.6,26.0 166.3,17.3 165.2,28.9 175.9,33.4 164.6,36.0 163.6,47.6 157.6,37.6" stroke-dasharray="120" stroke-dashoffset="120"/>',
    '          <polygon class="ba-draw d3" points="176.2,66.3 186.6,61.1 185.0,49.6 193.0,58.0 203.5,52.9 198.1,63.1 206.1,71.5 194.7,69.5 189.3,79.8 187.6,68.3" stroke-dasharray="120" stroke-dashoffset="120"/>',
    '          <polygon class="ba-draw d3" points="176.6,107.6 188.2,107.2 191.4,96.0 195.4,106.9 207.0,106.5 197.9,113.7 201.9,124.6 192.2,118.1 183.1,125.3 186.3,114.1" stroke-dasharray="120" stroke-dashoffset="120"/>',
    '          <polygon class="ba-draw d3" points="147.5,134.0 158.4,138.1 165.6,129.0 165.1,140.6 176.0,144.7 164.8,147.8 164.2,159.4 157.8,149.7 146.6,152.8 153.9,143.7" stroke-dasharray="120" stroke-dashoffset="120"/>',
    '        </svg>',
    '      </div>',
    '    </div>',
    '  </div>',
    '  <div class="ba-call">中华人民共和国万岁</div>',
    '  <div class="ba-sub">一九四九年 · 十月一日</div>',
    '</div>'
  ].join('');
  // ⚠ 动画 DOM 有版本号：改了 BA_HTML 就把 ART_VER 一起改，⟳ 热更新时才能把**旧 DOM** 换掉。
  //   （踩过的坑：只加"有就跳过"的幂等判断 ⇒ 热更新后页面上还是上一版的三幕，新旧文案叠在一起。）
  var ART_VER = '2026-10-21-i';
  // 2026-10-21 宿主：「随风飘要做得像真的」—— 旗帜改成 **40 条竖条**，每条只做上下位移、
  //   相位依次错开、振幅从旗杆那头（1px）到旗尾（13px）递增 ⇒ 看起来像布料在风里行走的波。
  //   这里的 SVG 只用来给每条当背景图（480×320 的旗面），条纹靠 background-position 切。
  var BA_FLAG_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 320">'
    + '<rect width="480" height="320" fill="#e21b1b"/>'
    + '<polygon points="80.0,32.0 90.8,65.2 125.7,65.2 97.4,85.7 108.2,118.8 80.0,98.3 51.8,118.8 62.6,85.7 34.3,65.2 69.2,65.2" fill="#ffde00"/>'
    + '<polygon points="146.3,40.2 153.9,31.5 147.9,21.5 158.6,26.0 166.3,17.3 165.2,28.9 175.9,33.4 164.6,36.0 163.6,47.6 157.6,37.6" fill="#ffde00"/>'
    + '<polygon points="176.2,66.3 186.6,61.1 185.0,49.6 193.0,58.0 203.5,52.9 198.1,63.1 206.1,71.5 194.7,69.5 189.3,79.8 187.6,68.3" fill="#ffde00"/>'
    + '<polygon points="176.6,107.6 188.2,107.2 191.4,96.0 195.4,106.9 207.0,106.5 197.9,113.7 201.9,124.6 192.2,118.1 183.1,125.3 186.3,114.1" fill="#ffde00"/>'
    + '<polygon points="147.5,134.0 158.4,138.1 165.6,129.0 165.1,140.6 176.0,144.7 164.8,147.8 164.2,159.4 157.8,149.7 146.6,152.8 153.9,143.7" fill="#ffde00"/>'
    + '</svg>';
  function buildFlagStrips(root) {
    try {
      var box = root && root.querySelector ? root.querySelector('.ba-strips') : null;
      if (!box || box.getAttribute('data-built') === '1') return;
      var uri = 'data:image/svg+xml;base64,' + btoa(BA_FLAG_SVG);   // 纯 ASCII，btoa 安全
      // 2026-10-21：旗面放大到 640×427 ⇒ 80 条 × 8px、振幅 1~17px（越靠旗尾甩得越大，才有"挥舞"感）
      var N = 80, STEP = 8, parts = [];
      for (var i = 0; i < N; i++) {
        var amp = (1 + 21 * i / (N - 1)).toFixed(1);
        parts.push('<div class="ba-strip" style="left:' + (i * STEP) + 'px;'
          // 竖条是 top:-20 / 高度 +40（上下留出位移余量）⇒ 背景也要往下补 20px，否则旗面整体上移 20px
          + "background-image:url('" + uri + "');background-position:-" + (i * STEP) + 'px 20px;'
          + '--amp:' + amp + ';animation-delay:-' + (i * 0.03).toFixed(2) + 's"></div>');
      }
      box.innerHTML = parts.join('');
      box.setAttribute('data-built', '1');
    } catch (e) { /* ignore */ }
  }
  function ensureBootArt(id) {
    try {
      var ov = document.getElementById('boot-overlay');
      if (!ov) return;
      var old = document.getElementById('boot-art');
      if (id !== 'ideal2') { if (old && old.parentNode) old.parentNode.removeChild(old); return; }
      if (old && old.getAttribute('data-ver') === ART_VER) return;   // 同版本：保留（重建会重启动画）
      if (old && old.parentNode) old.parentNode.removeChild(old);     // 旧版本：拆掉重建
      var d = document.createElement('div');
      d.id = 'boot-art';
      d.className = 'ba-stage';
      d.setAttribute('data-ver', ART_VER);
      d.innerHTML = BA_HTML;
      ov.appendChild(d);
      buildFlagStrips(d);
    } catch (e) { /* 静默 */ }
  }
  // 2026-10-22（宿主：切到别的场景后，启动动画预览就看不见了）——
  //   #boot-overlay 原本挂在 #harness-view 里面，一切场景那个 .view 就 display:none，遮罩跟着消失。
  //   这里把它**提到 body 上**（只提一次）并加 .lifted（position:fixed 盖满整窗）⇒ 任何页签下预览/启动进度都看得见。
  function liftOverlay() {
    var el = document.getElementById('boot-overlay');
    if (!el) return null;
    if (el.parentNode !== document.body) document.body.appendChild(el);
    el.classList.add('lifted');
    return el;
  }
  function apply(id) {
    try {
      var ov = liftOverlay();
      if (!ov) return false;
      ov.setAttribute('data-anim', String(id || 'classic'));
      ensureBootVideo(String(id || "classic"));
      ensureBootArt(String(id || 'classic'));
      return true;
    } catch (e) { return false; }
  }
  try {
    var F = window.app && window.app.file;
    if (F && F.read) {
      if (!window.__bpwTicks) window.__bpwTicks = 0; if (++window.__bpwTicks % 5 === 0) log('tick ' + window.__bpwTicks + ' hidden=' + document.hidden);
      Promise.resolve(F.read(CFG)).then(function (r) {
        var txt = (typeof r === 'string') ? r : ((r && (r.text || r.content)) || '');
        var id = 'classic';
        try { var j = JSON.parse(txt); if (j && j.id) id = String(j.id); } catch (e) { /* 坏文件 ⇒ classic */ }
        apply(id);
      }).catch(function () { apply('classic'); });
    }
  } catch (e) { /* 读配置失败 ⇒ 什么都不做 = classic */ }
  window.__bootPreview = function (id) {
    try {
      var ov = document.getElementById('boot-overlay');
      if (!ov) return false;
      var play = function (real) {
        var rid = String(real || 'classic');
        ov = liftOverlay() || ov;          // 预览也走"提 body"（切到别的场景同样看得见）
        ov.classList.remove('hide', 'err');
        ov.setAttribute('data-anim', rid);
        ensureBootVideo(rid);
        ensureBootArt(rid);
        window.__bootId = rid;
        if (window.__bootPaint) {
          window.__bootPaint({ stage: 'anim', pct: 42, text: '启动动画预览：' + rid, detail: '1.8 秒后自动收起' });
        }
        setTimeout(function () {
          try { if (window.__bootFinish) window.__bootFinish(); else ov.classList.add('hide'); } catch (e) { /* ignore */ }
        // 2026-10-21：视频 7.5s；三幕动画 ideal2 要 11s 才能看完三幕
        }, (rid === 'video') ? 7500 : ((rid === 'ideal2') ? 11000 : 1800));
      };
      if (id) { play(id); return true; }
      // 2026-10-19 23:5x（宿主：设置里改了但预览没变）—— 不传 id 时**现读一遍配置**：
      //   插件里刚点完卡片，菜单里的预览立刻就是新的（不用等下次启动）。
      var F = window.app && window.app.file;
      if (F && F.read) {
        Promise.resolve(F.read(CFG)).then(function (r) {
          var txt = (typeof r === 'string') ? r : ((r && (r.text || r.content)) || '');
          var cur = 'classic';
          try { var j2 = JSON.parse(txt); if (j2 && j2.id) cur = String(j2.id); } catch (e) { /* classic */ }
          play(cur);
        }).catch(function () { play(ov.getAttribute('data-anim') || 'classic'); });
      } else {
        play(ov.getAttribute('data-anim') || 'classic');
      }
      return true;
    } catch (e) { return false; }
  };
})();

// ==========================================================================================
// 2026-10-20（宿主：把常用网站的"智能抠图"做成**本地**工具）—— 场景「抠图」的主面板
//   引擎：本地 venv 里的 rembg（主进程 app.cut.run 起一次进程，算完就退，不常驻；图片不出本机）。
//   图片来源：① 左边「文件管理」里单击图片 ⇒ 走 window.__kunViews[面板id].show({path}) 送进来
//            ② 面板上的「选择图片…」(app.pickFile 系统对话框) ③ 直接把图片拖进来 (app.filePath)
//   输出：同目录 `<原名>_抠图.png`（带透明通道），旁边给 复制路径 / 定位 / 系统打开。
// ==========================================================================================
// 2026-10-20（宿主：「不要做成场景，做成一个小工具放在 CPU 左边，剪刀图标和其它图标风格一致」
//            + 「只有开始抠图吗，有没有橡皮或者扩选」）—— 顶栏「本地抠图」小工具
//   · 按钮：.titlebar-controls 里、负载胶囊（#tbs-load）**左边**；16px 线稿剪刀，与手机/月亮同一套 .tb-btn
//   · 弹层：居中（最宽 980、最高 88vh），左原图右结果 = 一块可精修的画布
//   · 引擎：<盘根>:\DSH\工具\抠图（rembg，离线）→ app.cut.run；读/存 PNG → app.cut.read / app.cut.write
//   · 精修（答宿主的问题：自动抠图只是第一步）：
//       橡皮擦 = 把不要的地方擦成透明；恢复笔 = 把擦掉/误抠的地方补回来（按自动结果的 alpha）
//       扩选 +N / 缩减 -N = 边缘整体外扩 / 内收 N 像素；羽化 N = 边缘过渡变软
//       撤销 / 重置（回到自动结果）/ 保存（覆盖 <原名>_抠图.png）/ 复制路径 / 定位
//   ⚠ 只有点过「✂ 自动抠图」之后才有画布可修；编辑全在本地 canvas，不联网。
// ==========================================================================================
/* 开源版：本地抠图入口已移除 */
// ==========================================================================================
// 2026-10-20（dg-dsh 派单）—— 顶栏「本地模型」开关（**只在主窗口**）
//   状态：app.localmodel.status() → {running,pid,vramFreeMb,modelReady}（亮=开 / 灰=关）
//   点击：app.localmodel.toggle()（脚本最多 90s：启动要等 /health + 真出字；启动中显示 loading）
//   悬停：本地 Qwen3-8B（GPU）· 显存空闲 N MB · 不用时关掉释放
//   失败：把脚本 stderr 最后一行弹出来（常见：显存不足 <5000MB）
//   ⛔ 不动引擎、不动 profile：只调 <盘根>:\DSH\工具\本地模型.mjs
// ==========================================================================================
(function localModelTopbar() {
  var LM = window.app && window.app.localmodel;
  // 只在主窗口（分离窗口是一窗一场景，别让这个开关重复出现）
  try { if (/[?&]solo=1/.test(location.search || '')) return; } catch (e) { return; }

  // ⟳ 重注入：把上一份按钮**全清掉**（可能不止一个：旧闭包的 place() 定时器会把摘下来的按钮再插回去）
  try {
    var olds = document.querySelectorAll('#btn-localmodel');
    for (var oi = 0; oi < olds.length; oi++) { if (olds[oi].parentNode) olds[oi].parentNode.removeChild(olds[oi]); }
  } catch (e) { /* ignore */ }
  window.__lmGen = (window.__lmGen || 0) + 1;
  var MY_GEN = window.__lmGen;

  var ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
    + '<rect x="2.7" y="2.7" width="10.6" height="10.6" rx="2.2" stroke="currentColor" stroke-width="1.25"/>'
    + '<rect x="5.5" y="5.5" width="5" height="5" rx="1.1" stroke="currentColor" stroke-width="1.25"/>'
    + '<path d="M6.4 2.7V1.3M9.6 2.7V1.3M6.4 14.7v-1.4M9.6 14.7v-1.4M2.7 6.4H1.3M2.7 9.6H1.3M14.7 6.4h-1.4M14.7 9.6h-1.4" stroke="currentColor" stroke-width="1.05" stroke-linecap="round"/>'
    + '</svg>';

  var st = { running: false, vram: null, modelReady: null, busy: false, err: '', at: 0 };
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tb-btn tb-tools lm-pill lm-off';
  btn.id = 'btn-localmodel';
  btn.innerHTML = ICON + '<span class="lm-txt">本地模型 关</span>';

  function toast(msg, bad) {
    try {
      var box = document.querySelector('.tbs-toasts');
      if (!box) { box = document.createElement('div'); box.className = 'tbs-toasts'; document.body.appendChild(box); }
      var t = document.createElement('div');
      t.className = 'tbs-toast' + (bad ? ' bad' : '');
      t.textContent = msg;
      box.appendChild(t);
      setTimeout(function () { t.classList.add('out'); setTimeout(function () { t.remove(); }, 320); }, 4600);
    } catch (e) { /* ignore */ }
  }

  function place() {
    if (window.__lmGen !== MY_GEN) return;     // 旧闭包（⟳ 之前那份）不再往 DOM 里插东西
    var controls = document.querySelector('#titlebar .titlebar-controls');
    if (!controls) return;
    if (btn.parentNode !== controls) {
      // 2026-10-20（宿主报"最小化没反应"后）—— 挪到 **⟳ 左边**：离窗口控制区（─ □ ✕）远一点，
      //   以后 pill 再变宽也碰不到最小化/最大化/关闭那三颗。
      var ref = document.getElementById('btn-refresh') || document.getElementById('btn-plugins')
        || document.getElementById('btn-theme') || null;
      if (ref && ref.parentNode === controls) controls.insertBefore(btn, ref);
      else controls.appendChild(btn);
    }
  }

  function paint() {
    var on = !!st.running;
    btn.classList.toggle('lm-on', on && !st.busy);
    btn.classList.toggle('lm-off', !on && !st.busy);
    btn.classList.toggle('lm-busy', !!st.busy);
    btn.disabled = false;
    // 带字：开=绿「本地模型 开」/ 关=灰「本地模型 关」/ 忙=琥珀「启动中…」「停止中…」
    var txt = btn.querySelector('.lm-txt');
    if (txt) {
      txt.textContent = st.busy
        ? ('本地模型 ' + (on ? '停止中…' : '启动中…'))
        : ('本地模型 ' + (on ? '开' : '关'));
    }
    var vr = (typeof st.vram === 'number') ? ('显存空闲 ' + st.vram + ' MB') : '显存空闲 —';
    var tip = '本地 Qwen3-8B（GPU）· ' + vr + ' · 不用时关掉释放';
    tip += on ? '\n（运行中 —— 点一下停掉，释放显存）' : '\n（点一下启动，约 10 秒）';
    if (st.busy) tip = '正在启动/停止本地模型…（最多 90 秒）';
    if (st.modelReady === false) tip += '\n⚠ 模型文件没找到（<模型目录>\\qwen3-8b）';
    if (st.err) tip += '\n⚠ ' + st.err;
    btn.title = tip;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function refresh() {
    if (!LM || !LM.status) { st.err = '这个 GUI 版本还没有本地模型通道（要重启一次工作台）'; paint(); return; }
    Promise.resolve(LM.status()).then(function (r) {
      if (!r) { st.err = '读不到状态'; paint(); return; }
      if (typeof r.vramFreeMb === 'number') st.vram = r.vramFreeMb;
      if (r.modelReady === false) st.modelReady = false; else st.modelReady = true;
      if (r.ok) { st.err = ''; st.running = !!r.running; st.at = Date.now(); }
      else st.err = r.err || '读不到状态';
      paint();
    }).catch(function (e) { st.err = (e && e.message) || String(e); paint(); });
  }

  function toggle() {
    if (st.busy) return;
    if (!LM || !LM.toggle) { st.err = '要重启一次工作台才有开关通道'; paint(); return; }
    st.busy = true; st.err = ''; paint();
    var t0 = Date.now();
    Promise.resolve(LM.toggle()).then(function (r) {
      st.busy = false;
      if (r && typeof r.vramFreeMb === 'number') st.vram = r.vramFreeMb;
      if (r && r.ok) {
        st.running = !!r.running;
        toast('本地模型：' + (st.running ? '已启动' : '已停止') + ' · ' + Math.round((Date.now() - t0) / 1000) + ' 秒', false);
      } else {
        if (r && typeof r.running === 'boolean') st.running = r.running;
        st.err = (r && r.err) || '切换失败';
        toast('本地模型切换失败：' + st.err, true);
      }
      paint();
    }).catch(function (e) {
      st.busy = false;
      st.err = (e && e.message) || String(e);
      toast('本地模型切换失败：' + st.err, true);
      paint();
    });
  }

  btn.addEventListener('click', function (ev) { ev.stopPropagation(); toggle(); });
  place();
  var tries = 0;
  var tm = setInterval(function () {
    place();
    if (++tries > 25) clearInterval(tm);
  }, 400);
  refresh();
  // 只在窗口有焦点时每 20 秒对一次状态（不额外养进程：脚本本身 0.2s 就跑完）
  setInterval(function () {
    if (document.hidden || !document.hasFocus()) return;
    if (st.busy) return;
    refresh();
  }, 20000);
  window.addEventListener('focus', function () { if (!st.busy) refresh(); });
  paint();
})();

renderers.embed = (body, meta, head) => {  body.classList.add('embed-panel');
  const url = String(meta.url || '');
  const A = window.app && window.app.app;   // app = 宿主通用能力（开外链/定位路径），不占任何场景命名空间
  const pid = String(meta.id || 'panel');
  const storeKey = 'app.embed.on.' + pid;
  const launchPaths = (Array.isArray(meta.launchPaths) ? meta.launchPaths : [meta.launchPath])
    .filter((p) => typeof p === 'string' && p);
  let wv = null;
  let disposed = false;
  let retryTimer = null;
  let retryLeft = 0;

  // 记住"内置还是没内置"：默认内置；用户点了取消内置就一直是取消状态，直到自己切回来
  let embedded = true;
  try { if (window.localStorage.getItem(storeKey) === '0') embedded = false; } catch (e) { /* 存储不可用就按默认 */ }
  const remember = (on) => { try { window.localStorage.setItem(storeKey, on ? '1' : '0'); } catch (e) { /* ignore */ } };

  const msg = el('div', 'embed-msg', '');
  body.appendChild(msg);
  const clearCards = () => {
    const c = body.querySelectorAll('.embed-fail, .embed-off');
    for (let i = 0; i < c.length; i++) c[i].remove();
  };
  const showMsg = (t) => { msg.textContent = t; msg.style.display = ''; };
  const hideMsg = () => { msg.style.display = 'none'; };

  // 桌面启动：按候选顺序试，第一个打开成功就停（用桌面快捷方式 = 等价双击）
  const needsRetry = () => (!wv || !!body.querySelector('.embed-fail'));   // 页面好好的就别去折腾它
  const launch = async (statusEl) => {
    if (!launchPaths.length) return false;
    let ok = false;
    for (let i = 0; i < launchPaths.length; i++) {
      const p = launchPaths[i];
      try {
        const r = A && A.openPath ? await A.openPath(p) : (window.open(p, '_blank'), { ok: true });
        if (r && r.ok) { ok = true; break; }
      } catch (e) { /* 试下一个 */ }
    }
    const failText = '桌面启动失败：没找到启动器（' + launchPaths.join(' / ') + '），请手动双击桌面快捷方式。';
    if (statusEl) statusEl.textContent = ok ? (meta.launchHint || '已调用桌面启动器，等它起来（本机约 1~2 秒），好会自动接上…') : failText;
    if (ok) { if (needsRetry()) autoRetry(); }
    else showMsg(failText);   // 标题行没有状态栏，失败就写到面板中间，别静默
    return ok;
  };

  // 点了桌面启动后：每 2 秒自己重试一次，最多 12 次（约 24 秒）；成功或超时就停，不留定时器
  const stopRetry = () => { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } };
  const autoRetry = () => {
    if (disposed || !embedded || retryTimer) return;
    retryLeft = 12;
    const tick = () => {
      retryTimer = null;
      if (disposed || !embedded) return;
      if (retryLeft-- <= 0) { showMsg('等不到 ' + url + ' 起来，点「🔄 刷新」再试，或看桌面那个窗口是不是报错了。'); return; }
      clearCards();
      // 失败时 did-fail-load 会把 webview 摘掉，所以这里可能是"没有 wv"的状态 → 重新挂一个
      if (!wv) mount();
      else { try { wv.reload(); } catch (e) { try { wv.loadURL(url); } catch (e2) { /* ignore */ } } }
      retryTimer = setTimeout(tick, 2000);
    };
    retryTimer = setTimeout(tick, 2000);
  };

  const makeBtn = (label, title, cls) => {
    const b = el('button', cls || 'file-refresh', label);
    if (title) b.title = title;
    return b;
  };

  // 内嵌页面的滚动条：guest 是**另一个文档**，工作台的 ::-webkit-scrollbar 管不到它，
  // 默认那条白条在深色面板里特别扎眼 ⇒ 往 guest 里注一层同款深色细条（meta.scrollbar === false 可关）
  const SCROLL_CSS = '::-webkit-scrollbar{width:10px;height:10px}'
    + '::-webkit-scrollbar-track{background:transparent}'
    + '::-webkit-scrollbar-thumb{background:rgba(148,163,184,.42);border-radius:5px;border:2px solid transparent;background-clip:content-box}'
    + '::-webkit-scrollbar-thumb:hover{background:rgba(148,163,184,.62);background-clip:content-box}'
    + '::-webkit-scrollbar-corner{background:transparent}';
  const applyScrollCss = () => {
    if (meta.scrollbar === false || !wv) return;
    try {
      if (typeof wv.insertCSS === 'function') {
        const p = wv.insertCSS(SCROLL_CSS);
        if (p && p.catch) p.catch(() => { /* guest 已销毁 */ });
        return;
      }
      // 老 Electron 没有 insertCSS：退化成往 guest 里塞一个 <style>（带 id，重复注入只留一份）
      if (typeof wv.executeJavaScript === 'function') {
        const p = wv.executeJavaScript('(function(){if(document.getElementById("kun-scrollbar-css"))return;'
          + 'var s=document.createElement("style");s.id="kun-scrollbar-css";s.textContent=' + JSON.stringify(SCROLL_CSS)
          + ';(document.head||document.documentElement).appendChild(s);})()');
        if (p && p.catch) p.catch(() => { /* ignore */ });
      }
    } catch (e) { /* 注入失败不影响页面 */ }
  };

  // ---- 挂上 webview（内置模式）----
  const mount = () => {
    if (wv || !url) return;
    hideMsg();
    clearCards();
    wv = document.createElement('webview');
    wv.className = 'embed-wv';
    // partition 必须在首次导航前设好；面板 id 决定分区名，避免和 harness 的会话分区混用
    wv.setAttribute('partition', 'persist:embed-' + pid.replace(/[^A-Za-z0-9_-]/g, '_'));
    // UA 也必须在首次导航前设好（加载后再改要重载才生效）
    const ua = resolveEmbedUA(meta.userAgent);
    if (ua) wv.setAttribute('useragent', ua);
    // 2026-10-19（宿主：B站场景一点开就跳两个 Edge 窗口）——根因：embed 的 webview 开了 allowpopups，
    //   B站页面会 window.open 它自己的内部页（leader-election/iframe.html、Cross Origin Local Storage），
    //   而 main.js 的 setWindowOpenHandler 对非内部 URL 一律 openInSystemBrowser() ⇒ 跑到系统浏览器。
    //   现在**默认不给弹窗**（浏览器不会弹，也不会跳 Edge）；确实需要弹窗的面板，在场景 json 里写 "allowPopups": true。
    if (meta.allowPopups === true) wv.setAttribute('allowpopups', '');
    wv.addEventListener('dom-ready', applyScrollCss);
    startBiliTrack(wv, meta);   // 2026-10-19：B站场景「当前视频」同步（非 B站场景内部直接 return）
    startBiliProbe(wv, meta);   // 2026-10-19 临时：点击探针（定位完删掉）
    wv.addEventListener('did-finish-load', () => { hideMsg(); clearCards(); stopRetry(); applyScrollCss(); });
    wv.addEventListener('did-fail-load', (e) => {
      // -3 = ERR_ABORTED：正常重载/跳转时的取消，不算故障
      if (e && e.errorCode === -3) return;
      if (wv) { try { wv.remove(); } catch (ex) { /* ignore */ } wv = null; }
      hideMsg();
      clearCards();
      showFail(e);
    });
    wv.setAttribute('src', url);
    body.appendChild(wv);
  };

  // ---- 摘掉 webview（取消内置模式）----
  const unmount = () => {
    stopRetry();
    if (wv) { try { wv.remove(); } catch (e) { /* ignore */ } wv = null; }
    clearCards();
    showMsg('已取消内置：这个面板不再加载 ' + url + '（省一份 guest 进程和轮询）。');
  };

  const showFail = (e) => {
    const box = el('div', 'embed-fail');
    box.appendChild(el('div', 'embed-fail-icon', '🔌'));
    box.appendChild(el('div', 'embed-fail-title', '连不上 ' + url));
    box.appendChild(el('div', 'embed-fail-sub', meta.failHint || '确认这个服务在本机跑着，再点「重试」。'));
    if (e && (e.errorDescription || e.errorCode)) {
      box.appendChild(el('div', 'embed-fail-err', String(e.errorDescription || e.errorCode)));
    }
    const status = el('div', 'embed-fail-status', '');
    const row = el('div', 'embed-actions');
    if (launchPaths.length) {
      const lb = makeBtn(meta.launchLabel || '🖥 桌面启动', '按场景 json 里配的启动器把桌面程序拉起来', 'file-refresh embed-btn');
      lb.addEventListener('click', () => launch(status));
      row.appendChild(lb);
    }
    const retry = makeBtn('🔄 重试', '再连一次', 'file-refresh embed-btn');
    retry.addEventListener('click', () => {
      hideMsg();
      clearCards();
      mount();
    });
    row.appendChild(retry);
    box.appendChild(row);
    box.appendChild(status);
    body.appendChild(box);
  };

  const showOff = () => {
    clearCards();
    hideMsg();
    const box = el('div', 'embed-off');
    box.appendChild(el('div', 'embed-off-icon', '⏏️'));
    box.appendChild(el('div', 'embed-off-title', '已取消内置'));
    box.appendChild(el('div', 'embed-off-sub', meta.offHint
      || '这个面板不再内嵌页面（省一份 guest 进程和它的轮询）。要在这里看就点「🔗 内置」切回来；桌面那个窗口不受影响。'));
    const status = el('div', 'embed-fail-status', '');
    const row = el('div', 'embed-actions');
    if (launchPaths.length) {
      const lb = makeBtn(meta.launchLabel || '🖥 桌面启动', '按场景 json 里配的启动器把桌面程序拉起来', 'file-refresh embed-btn');
      lb.addEventListener('click', () => launch(status));
      row.appendChild(lb);
    }
    const openBtn = makeBtn('🌐 浏览器打开', '在系统浏览器打开（要放大时用）', 'file-refresh embed-btn');
    openBtn.addEventListener('click', () => { if (A && A.openPath) A.openPath(url); else window.open(url, '_blank'); });
    row.appendChild(openBtn);
    const backBtn = makeBtn('🔗 内置', '把这个页面嵌回面板', 'file-refresh embed-btn');
    backBtn.addEventListener('click', () => setEmbedded(true));
    row.appendChild(backBtn);
    box.appendChild(row);
    box.appendChild(status);
    body.appendChild(box);
  };

  const setEmbedded = (on) => {
    embedded = !!on;
    remember(embedded);
    if (toggleBtn) {
      toggleBtn.textContent = embedded ? '⛔ 取消内置' : '🔗 内置';
      toggleBtn.title = embedded ? '不再把这个页面嵌在面板里（省资源，随时可切回）' : '把这个页面嵌回面板';
      toggleBtn.classList.toggle('embed-toggle-off', !embedded);
    }
    if (reloadBtn) reloadBtn.style.display = embedded ? '' : 'none';
    if (embedded) { hideMsg(); mount(); } else { unmount(); showOff(); }
  };

  // ---- 标题行按钮：桌面启动 · 内置开关 · 刷新 · 浏览器打开 ----
  let toggleBtn = null;
  let reloadBtn = null;
  if (head) {
    const acts = el('div', 'file-head-acts');
    if (launchPaths.length) {
      const launchBtn = makeBtn(meta.launchLabel || '🖥 桌面启动', '把桌面那个程序拉起来（等价双击桌面快捷方式）');
      launchBtn.addEventListener('click', () => launch(null));
      acts.appendChild(launchBtn);
    }
    if (meta.embedToggle !== false) {
      toggleBtn = makeBtn('⛔ 取消内置', '');
      toggleBtn.addEventListener('click', () => setEmbedded(!embedded));
      acts.appendChild(toggleBtn);
    }
    reloadBtn = makeBtn('🔄 刷新', '重新加载这个页面');
    reloadBtn.addEventListener('click', () => {
      if (!wv) { mount(); return; }
      retryLeft = 0;
      stopRetry();
      try { wv.reload(); } catch (e) { /* ignore */ }
    });
    acts.appendChild(reloadBtn);
    const openBtn = makeBtn('🌐 浏览器打开', '在系统浏览器打开（要放大、要登录时用）');
    openBtn.addEventListener('click', () => {
      if (A && A.openPath) A.openPath(url);
      else window.open(url, '_blank');
    });
    acts.appendChild(openBtn);
    head.appendChild(acts);
  }

  if (!url) { showMsg('这个面板没有配置 url。'); return () => { disposed = true; stopRetry(); }; }

  setEmbedded(embedded);   // 按记下来的状态进入：内置 or 取消内置

  return () => { disposed = true; stopRetry(); };
};

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

// ============ 左上角品牌区：悬停显示版本信息卡 ============
// ★版本契约★：本壳是围绕引擎的"内部实现"做的（DOM 属性 / localStorage 键 / 会话行结构…见项目信息 §18），
// 上游一改这些，壳不会崩但会**静默降级**（面板藏不住侧栏、钉会话失效、状态小字乱报）。
// 所以这里记一份"已验证过的引擎版本"：引擎版号与它不一致 → 品牌区小点变琥珀色 + 悬停卡里明确写出，
// 并在 console 留一行提示。**只提示、不阻塞启动**（升级后功能多数仍然可用，不该把人挡在门外）。
// ★2026-11-07 如实修订★：上一版注释写「8 核心锚点契约验证全绿通过」——**这句没有证据**。
//   本仓库是「源码直跑 + 外部引擎」，没有内置 引擎\ 目录 ⇒ engine-after.mjs 的 8 锚点**源码扫描根本跑不了**，
//   它只会在无内置引擎时跳过（现在显式报 SKIPPED / exit 3，不再自报"不适用(0 失败)"）。
//   8 个锚点对着 0.2.2-rc.1 真实产物的逐条核查见 _本机产物/优化报告/DSH内核兼容.md（只读 asar，附命中次数）。
//   所以下面这个版本号的含义严格限定为：**壳"声称"适配 0.2.2-rc.1**（本机 dsh --version 实测值）。
//   ⚠ 锚点契约仍待在有内置 引擎\ 的克隆里跑一次 engine-after.mjs（exit 0 = 真的逐条核对过）。
var ADAPTED_ENGINE = '0.2.2-rc.1';   // 2026-11-05 升到 0.2.2-rc.1（本机 dsh --version 实测）；锚点契约未在本仓库复核
var engineMismatch = '';
// 为什么放在这个文件（而不是 renderer.js）：renderers.js 是**可热更新**的（标题栏 ⟳ 会重新执行它），
// 把"品牌区装饰 + 版本卡"放这里，改完点 ⟳ 就生效，不用重启 GUI。
// 幂等：index.html 里已有 .brand-tip 就用现成的；没有就建一个（这样旧 index.html 也能有版本卡）。
// 数据：优先走主进程 app:version（preload 的 app.getVersion，含 引擎/GUI/Electron/Chromium/Node 版本）；
// 若主进程还没重启（没有这个接口）→ 先用 navigator.userAgent 能拿到的信息，并提示重启后显示引擎版本，
// 之后 30 秒内每 3 秒重试一次（用户中途重启了也能自动补全，不用再点 ⟳）。
var brandTipRetry = null;
function decorateBrand() {
  try {
    const brand = document.querySelector('.brand');
    if (!brand) return;
    let tip = document.getElementById('brand-tip');
    if (!tip) {
      tip = document.createElement('span');
      tip.id = 'brand-tip';
      tip.className = 'brand-tip';
      tip.setAttribute('role', 'tooltip');
      tip.innerHTML =
        '<span class="brand-tip-line brand-tip-title">DSH 引擎 <b id="ver-engine">—</b></span>' +
        '<span class="brand-tip-line">工作台 GUI <b id="ver-gui">—</b></span>' +
        '<span class="brand-tip-line" id="ver-runtime">运行时 —</span>' +
        '<span class="brand-tip-line brand-tip-dim" id="ver-dir">引擎目录 —</span>';
      brand.appendChild(tip);
    }
    const set = (id, text) => { const el = document.getElementById(id); if (el && text) el.textContent = text; };
    const ua = String(navigator.userAgent || '');
    const electron = (ua.match(/Electron\/([\d.]+)/) || [])[1];
    const chrome = (ua.match(/Chrome\/([\d.]+)/) || [])[1];
    const fill = (v) => {
      if (!v || !(v.engine || v.cli || v.gui || v.electron)) return false;
      const vv = (x) => (x ? 'v' + x : '（未知）');
      set('ver-engine', vv(v.engine || v.cli));
      set('ver-gui', vv(v.gui || v.app));
      const rt = [];
      if (v.electron) rt.push('Electron ' + v.electron);
      if (v.chrome) rt.push('Chromium ' + v.chrome);
      if (v.node) rt.push('Node ' + v.node);
      set('ver-runtime', rt.join(' · ') || '运行时（未知）');
      let dir = '引擎目录 ' + (v.engineDir || '（未知）');
      // 引擎与 CLI 版本不一致 = "看起来正常其实错配"，直接标出来
      if (v.engine && v.cli && v.engine !== v.cli) dir += ' ⚠ CLI ' + v.cli;
      set('ver-dir', dir);
      // ★版本契约核对★：引擎换了版本 → 明确写出来（不阻塞，只提示 + 变琥珀色）
      if (v.engine && ADAPTED_ENGINE && v.engine !== ADAPTED_ENGINE) {
        engineMismatch = v.engine;
        set('ver-runtime', (rt.join(' · ') || '运行时') + '\n⚠ 本壳适配的是 v' + ADAPTED_ENGINE + '，引擎已是 v' + v.engine +
          '：若面板藏不住侧栏 / 切不到会话，先跑 node scripts\\engine-after.mjs 核对上游实现');
        try { highlightEngineMismatch(true); } catch (e) { /* ignore */ }
        try { console.warn('[工作台] 引擎版本 ' + v.engine + ' ≠ 本壳适配版本 ' + ADAPTED_ENGINE + '，请跑 node scripts/engine-after.mjs 核对'); } catch (e) { /* ignore */ }
      } else {
        engineMismatch = '';
        try { highlightEngineMismatch(false); } catch (e) { /* ignore */ }
      }
      return true;
    };
    const tryFetch = () => {
      try {
        if (!window.app || typeof window.app.getVersion !== 'function') return false;
        window.app.getVersion().then(fill).catch(function () { });
        return true;
      } catch (e) { return false; }
    };
    if (!tryFetch()) {
      const rt = [];
      if (electron) rt.push('Electron ' + electron);
      if (chrome) rt.push('Chromium ' + chrome);
      set('ver-runtime', rt.join(' · ') || '运行时（未知）');
      set('ver-engine', '重启 GUI 后显示');
      set('ver-dir', '版本接口需重启一次 GUI（app:version）');
      // 有界重试（最多 10 次，每次 3 秒）：用户中途重启了 GUI 也能自动补上，不用再点 ⟳。
      // 用 setTimeout 递归而不是 setInterval：这是"启动期一次性补偿"，不是常驻定时器，
      // 也不会被 check-gui 的"渲染器定时器必须有 cleanup"规则误判（它不是面板定时器）。
      if (!brandTipRetry) {
        let n = 0;
        const retry = () => {
          if (tryFetch() || ++n > 10) { brandTipRetry = null; return; }
          brandTipRetry = setTimeout(retry, 3000);
        };
        brandTipRetry = setTimeout(retry, 3000);
      }
    }
  } catch (e) { /* 品牌区装饰失败绝不能影响工作台启动 */ }
}

// ===== 顶栏「网页版 AI」：五个官方小图标 + 点开的浮动窗口（2026-09-20 第四波 / 第五波补 DeepSeek）=====
// 用户原话：「把这四个网页版内置到 gui 窗口最顶上，清玄的工作台字段后面，用一个个官方小图标
// 显示，点击就可以出来一个窗口，保证快速响应」。
//
// ★为什么整段都在这里、一行 index.html 都不改★
//   1) index.html 是外壳，改它要**重启 GUI**；本文件点「⟳」就重新执行 ⇒ 加顶栏元素必须放这儿；
//   2) 图标必须是**官方**的：`scripts\fetch-webai-icons.mjs` 从各家官网抓 favicon 落到
//      `renderer\assets\webai\`（不是手画 SVG），抓不到时按钮退回"名字首字"，不会出现破图；
//   3) ★快★ = **预热**：启动后错峰把网页各建一个 <webview> 先加载好（不显示），
//      点图标只是"把已经加载好的窗口挪出来" ⇒ 打开是瞬时的，不是每次重新联网。
//      代价是每个预热过的页面各占一份常驻内存；不想要就在各自窗口的工具栏里点「⏏ 释放」
//      （下次点开重新加载）。站点表里标了 `noWarm` 的站不进预热队列 —— 点开时才加载。
//
// 宿主侧没有任何配套改动（不开新 BrowserWindow、不加新 IPC）：webview 的 partition 不需要主进程
// 白名单，登录态默认落在各自的 `persist:webai-<key>` 分区里，互不串味、也不会污染对话那条链路。
// ★唯一的例外是 deepseek★：它在站点表里显式写了 `partition`，**和自我复盘场景左下角那个 DeepSeek
//   面板共用同一个分区**（`persist:embed-sr-site-bl`；embed 面板的分区规则 = `persist:embed-<面板id>`，
//   见本文件 renderers.embed）⇒ 两边同一份 cookie、同一个登录态，「联通」不是两套各登一次。
// ⚠ 已知限制（主进程的既有策略，不是本功能的 bug）：这几个站点里 `window.open` 弹出来的
//   第三方登录小窗会被统一丢给系统默认浏览器（main.js 的 setWindowOpenHandler）⇒ 扫码/授权类
//   登录建议直接在系统浏览器里登完，本窗口用账号密码登录没问题。
// 站点表字段：key/name/icon/fallback/url 必填；另有两个可选开关 ——
//   partition：覆盖默认的 `persist:webai-<key>`（**只在"要跟别的面板共用登录态"时才写**）；
//   noWarm   ：不参加启动预热（点开时才建 webview，省一份常驻 guest 内存）；
//              ★2026-11-04★ 默认**全部 noWarm**：实测"启动即预热 4 站"会让内存 2 分钟从 1.2GB
//              涨到 7.2GB（3 个隐藏 guest 主线程锁死），随后 OOM。见 诊断-内存\内存问题诊断报告.md。
//              想恢复"秒开"：设 window.__DSH_WEB_AI_WARM = true 或 localStorage['webai.warm']='1'
//              （见 decorateWebAi 里的 warmWanted），且**分离窗口永不预热**。
//   userAgent：'chrome' = 换成纯 Chrome UA（站点认 Electron 就会盖一层「使用环境异常」弹窗）。
// ⚠ deepseek 这一项**故意**用 `persist:embed-sr-site-bl`：它和自我复盘场景（scenarios\self-review.json）
//   左下角那个 DeepSeek 面板（面板 id `sr-site-bl`，同一个 chat.deepseek.com）**是同一个 webview 分区**
//   ⇒ 登录态/会话完全**联通**：在场景面板里登录过，顶栏点开就是登录好的，反过来也一样。
//   不是"两套各登一次"；也别把这个分区名改掉 —— 改了两边同时掉登录。
var WEB_AI = [
  { key: 'deepseek', name: 'DeepSeek', icon: 'assets/webai/deepseek.png', fallback: 'D',
    url: 'https://chat.deepseek.com/', partition: 'persist:embed-sr-site-bl',
    userAgent: 'chrome', noWarm: true,
    tip: '与自我复盘场景的 DeepSeek 面板共用登录态（同一个 webview 分区）' },
  { key: 'doubao', name: '豆包', icon: 'assets/webai/doubao.png', fallback: '豆',
    url: 'https://www.doubao.com/chat/', noWarm: true },
  { key: 'tongyi', name: '千问', icon: 'assets/webai/tongyi.png', fallback: '通',
    // 2026-11-01：tongyi.aliyun.com/qianwen/ 已并入 qianwen.com（品牌改叫「千问」）。
    // 老地址还能跳，但会落到根路径，且可能拿到未渲染的 Velocity 模板源码（页面显示成 #set(...)）。
    // key 仍叫 tongyi：分区 persist:webai-tongyi 里的登录态要能继续用。
    // userAgent:'chrome'：Electron 默认 UA 里带 Electron/xx，阿里侧的 WAF 会回一个空壳页面
    //   （实测 bodyLen=0、只有 3 个元素、标题是域名本身、控制台无报错）。换成真实 Chrome UA 再试。
    url: 'https://www.qianwen.com/', userAgent: 'chrome', noWarm: true },
  { key: 'chatglm', name: '智谱清言', icon: 'assets/webai/chatglm.png', fallback: '智',
    url: 'https://chatglm.cn/main/alltoolsdetail', noWarm: true },
  { key: 'kimi', name: 'Kimi', icon: 'assets/webai/kimi.png', fallback: 'K',
    url: 'https://www.kimi.com/', noWarm: true, warmOptIn: true },
];

// ★状态为什么挂在 window 上★ ⟳ 会**重新求值本文件**却**不重建 DOM**（同一个页面上下文）：
// 状态若只放在 `var webAiWins = {}` 里，点一次「⟳」就会被清空，而旧的窗口 div 与那只正在跑的
// webview 还留在页面上 ⇒ 再预热一遍就多出一整套窗口（两只会互相盖住，肉眼很难发现）。
// 所以状态存 window.__kunWebAi（和 __kunFixOn / __kunWideTimer 是同一个套路）。
var WEB_AI_ST = window.__kunWebAi || (window.__kunWebAi = { wins: {}, layer: null, z: 2400, warmed: false });
var webAiWins = WEB_AI_ST.wins;   // 别名：下面所有代码照旧用这个名字

// ⟳ 之后把页面上**已经存在**的窗口认领回来（不重建、不重复挂 webview）
function webAiAdopt() {
  try {
    const layer = document.querySelector('.webai-layer');
    if (layer) WEB_AI_ST.layer = layer;
    Array.prototype.forEach.call(document.querySelectorAll('.webai-win'), function (el) {
      const key = el.dataset.key;
      if (!key || WEB_AI_ST.wins[key]) return;
      const site = WEB_AI.filter(function (s) { return s.key === key; })[0];
      if (!site) return;
      WEB_AI_ST.wins[key] = {
        el: el, wv: el.querySelector('webview'), mask: el.querySelector('.webai-mask'),
        host: el.querySelector('.webai-host'), key: key, site: site,
      };
    });
  } catch (e) { /* ignore */ }
}

// 每个站点的窗口几何记在 localStorage：拖过/拉过大小，下次点开还在原地
function webAiGeom(key, idx) {
  try {
    const raw = localStorage.getItem('app.webai.geom.' + key);
    if (raw) {
      const g = JSON.parse(raw);
      if (g && g.w > 200 && g.h > 150) return g;
    }
  } catch (e) { /* ignore */ }
  const w = Math.min(980, Math.max(420, Math.round((window.innerWidth || 1400) * 0.56)));
  const h = Math.min(760, Math.max(360, Math.round((window.innerHeight || 900) * 0.78)));
  const x = Math.max(12, Math.round(((window.innerWidth || 1400) - w) / 2) + idx * 26);
  const y = Math.max(46, Math.round(((window.innerHeight || 900) - h) / 2) + idx * 22);
  return { x: x, y: y, w: w, h: h };
}
function webAiRecordGeometry(key) {
  const o = webAiWins[key];
  if (!o || !o.el) return;
  try {
    const r = o.el.getBoundingClientRect();
    if (r.width > 200) {
      localStorage.setItem('app.webai.geom.' + key, JSON.stringify({
        x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      }));
    }
  } catch (e) { /* ignore */ }
}
function webAiSetStatus(key, st) {
  const o = webAiWins[key];
  if (o && o.btn) o.btn.dataset.st = st;
}

// 建（或复用）一个站点的窗口 + 它的 <webview>；mode: 'warm' 只加载不显示，'show' 顺带摊出来
function webAiEnsure(key, mode) {
  const site = WEB_AI.filter(function (s) { return s.key === key; })[0];
  if (!site) return null;
  let o = webAiWins[key];
  if (!o) webAiAdopt();
  o = webAiWins[key];
  if (!o) {
    if (!WEB_AI_ST.layer) {
      WEB_AI_ST.layer = document.createElement('div');
      WEB_AI_ST.layer.className = 'webai-layer';
      document.body.appendChild(WEB_AI_ST.layer);
    }
    const idx = WEB_AI.map(function (s) { return s.key; }).indexOf(key);
    const g = webAiGeom(key, idx);
    const el = document.createElement('div');
    el.className = 'webai-win warm';
    el.dataset.key = key;
    el.style.left = g.x + 'px';
    el.style.top = g.y + 'px';
    el.style.width = g.w + 'px';
    el.style.height = g.h + 'px';
    el.style.zIndex = String(++WEB_AI_ST.z);

    // 标题栏顺序 = 图标 · 名字 · 当前网址 · 空白 · 工具按钮（一次append到位，不做插入挪动）
    const head = document.createElement('div');
    head.className = 'webai-head';
    const ico = document.createElement('img');
    ico.src = site.icon; ico.alt = '';
    ico.onerror = function () { try { this.style.display = 'none'; } catch (e) {} };
    const title = document.createElement('span');
    title.className = 'webai-title'; title.textContent = site.name;
    const host = document.createElement('span');
    host.className = 'webai-host'; host.textContent = new URL(site.url).host;
    const spacer = document.createElement('span');
    spacer.className = 'webai-spacer';
    const mkTb = function (act, label, tip, cls) {
      const b = document.createElement('button');
      b.className = 'webai-tb' + (cls ? ' ' + cls : '');
      b.dataset.act = act;
      b.textContent = label;
      b.title = tip;
      b.setAttribute('aria-label', tip);
      return b;
    };
    const bBack = mkTb('back', '‹', '后退');
    const bFwd = mkTb('fwd', '›', '前进');
    const bRel = mkTb('reload', '⟳', '重新加载这个页面');
    // 「只留标题栏（▁）」按钮已按用户要求去掉（2026-09-23：留着没用还占位）。功能本体还在：
    // 7802 行 act==='mini' 的分支与 7864 行的 classList.remove('mini') 都保留 —— 万一有窗口停在 mini 态，
    // 重开该窗口会自动恢复成正常高度，不会卡死。
    const bFree = mkTb('free', '⏏', '释放内存：关掉网页本身，下次点开重新加载');
    const bOpen = mkTb('open', '↗', '用系统默认浏览器打开（登录/扫码建议走这里）');
    const bClose = mkTb('close', '✕', '关掉这个窗口（网页留着，下次点开秒开）', 'close');
    [ico, title, host, spacer, bBack, bFwd, bRel, bFree, bOpen, bClose].forEach(function (n) { head.appendChild(n); });

    const body = document.createElement('div');
    body.className = 'webai-body';
    const wv = document.createElement('webview');
    // 站点表给了 partition 就用它（deepseek 与自我复盘面板共用 ⇒ 登录态联通）；没给才按 key 各建一个
    wv.setAttribute('partition', site.partition || ('persist:webai-' + key));
    // UA 也必须在首次导航前设好（加载后再改要重载才生效）；没写 userAgent 的站点一个字都不动
    const ua = resolveEmbedUA(site.userAgent);
    if (ua) wv.setAttribute('useragent', ua);
    wv.setAttribute('allowpopups', '');
    // 2026-10-17 按 dg-dsh 派单：**不再关掉后台节流**（实测闲置 14 个隐藏面板全速跑 ≈1.12 核 / 5.2 GB）。
  //   删掉 backgroundThrottling=no ⇒ 交给 Electron 默认：前台那个不节流、隐藏的自动节流（定时器 1 Hz、不重绘）。
    wv.setAttribute('src', site.url);
    body.appendChild(wv);

    const mask = document.createElement('div');
    mask.className = 'webai-mask';
    mask.innerHTML = '<div class="webai-spin"></div><div class="webai-mask-t">正在加载 ' + site.name + ' …</div>';
    body.appendChild(mask);

    el.appendChild(head);
    el.appendChild(body);
    WEB_AI_ST.layer.appendChild(el);

    o = webAiWins[key] = { el: el, wv: wv, mask: mask, host: host, key: key, site: site };
    o.btn = document.querySelector('.webai-btn[data-key="' + key + '"]');
    webAiSetStatus(key, 'loading');
    webAiBindWindow(o);
    webAiBindWebview(o);      // ★必须绑★：状态点变绿、遮罩撤掉、加载失败出"重试"全靠这几个事件
  } else if (!o.wv) {
    // 释放过：重新挂一只 webview（同一分区 ⇒ 登录态还在）
    webAiRebuildGuest(o);
  }
  if (mode === 'show') webAiShow(key);
  return o;
}

// 绕过缓存重载。站点的坏响应（比如未渲染的模板）会被 disk cache 钉住，
// 普通 reload 拿回来的还是那一份，所以用户点 ⟳ 时优先走这个。
function webAiHardReload(o) {
  if (!o || !o.wv) { if (o) webAiRebuildGuest(o); return }
  try { if (o.wv.reloadIgnoringCache) o.wv.reloadIgnoringCache(); else o.wv.reload() } catch (e) { try { o.wv.reload() } catch (e2) { /* ignore */ } }
}

// 释放后重建 guest（保留窗口外壳与几何）
function webAiRebuildGuest(o) {
  const wv = document.createElement('webview');
  // ★必须和首次创建用同一个表达式★：否则"⏏ 释放 → 再点开"会重建到另一个分区，deepseek 的登录态就丢了
  wv.setAttribute('partition', (o.site && o.site.partition) || ('persist:webai-' + o.key));
  const ua = resolveEmbedUA(o.site && o.site.userAgent);
  if (ua) wv.setAttribute('useragent', ua);
  wv.setAttribute('allowpopups', '');
  // 2026-10-17 按 dg-dsh 派单：**不再关掉后台节流**（实测闲置 14 个隐藏面板全速跑 ≈1.12 核 / 5.2 GB）。
  //   删掉 backgroundThrottling=no ⇒ 交给 Electron 默认：前台那个不节流、隐藏的自动节流（定时器 1 Hz、不重绘）。
  wv.setAttribute('src', o.site.url);
  o.wv = wv;
  o.el.querySelector('.webai-body').insertBefore(wv, o.mask);
  webAiBindWebview(o);
  webAiSetStatus(o.key, 'loading');
  o.mask.style.display = '';
  o.mask.innerHTML = '<div class="webai-spin"></div><div class="webai-mask-t">正在加载 ' + o.site.name + ' …</div>';
}

function webAiBindWebview(o) {
  const wv = o.wv;
  if (!wv || !wv.addEventListener) return;
  const done = function () {
    // 偶发：站点把未渲染的服务端模板直接发下来（标题/正文里能看到 #set( 或 $!xxx），
    //   而且这份坏响应会被 disk cache 钉住 —— 表现就是面板一片模板源码。
    //   这里识别到就硬刷一次；每个窗口只自动做一次，避免和站点互相打架变成死循环。
    try {
      const ttl = String((o.wv && o.wv.getTitle && o.wv.getTitle()) || '');
      if (!o._tplReloaded && /\$!|#set\(|#if\(/.test(ttl)) {
        o._tplReloaded = true;
        webAiHardReload(o);
      }
    } catch (e) { /* ignore */ }
    webAiSetStatus(o.key, 'ready');
    if (o.mask) o.mask.style.display = 'none';
    webAiSyncNav(o);
  };
  wv.addEventListener('did-stop-loading', done);
  wv.addEventListener('did-fail-load', function (e) {
    if (e && e.errorCode === -3) return;                 // -3 = ERR_ABORTED（同页跳转/被取消），不是失败
    webAiSetStatus(o.key, 'fail');
    if (o.mask) {
      o.mask.style.display = '';
      o.mask.innerHTML = '<div class="webai-err">打不开：' + String((e && (e.errorDescription || e.errorCode)) || '未知错误') +
        '</div><div class="webai-act" data-act="retry">点这里重试</div>' +
        '<div class="webai-act" data-act="open">改用系统浏览器打开</div>';
    }
  });
  wv.addEventListener('did-navigate', function (e) { if (e && e.url) webAiSetHost(o, e.url); });
  wv.addEventListener('did-navigate-in-page', function (e) { if (e && e.url) webAiSetHost(o, e.url); });
  wv.addEventListener('page-title-updated', function (e) {
    try { o.el.querySelector('.webai-title').textContent = o.site.name + (e && e.title ? ' · ' + String(e.title).slice(0, 28) : ''); } catch (err) {}
  });
  wv.addEventListener('did-start-loading', function () { webAiSetStatus(o.key, 'loading'); });
}
function webAiSetHost(o, url) {
  try { o.host.textContent = new URL(url).host; } catch (e) { /* ignore */ }
}
function webAiSyncNav(o) {
  try {
    const q = function (a) { return o.el.querySelector('.webai-tb[data-act="' + a + '"]'); };
    const bb = q('back'), bf = q('fwd');
    if (bb) bb.disabled = !(o.wv && o.wv.canGoBack && o.wv.canGoBack());
    if (bf) bf.disabled = !(o.wv && o.wv.canGoForward && o.wv.canGoForward());
  } catch (e) { /* ignore */ }
}

function webAiBindWindow(o) {
  const el = o.el;
  // ① 拖标题栏挪窗口（不能用 app-region: drag —— 那是拖**整个应用窗口**，不是拖这个 div）
  const head = el.querySelector('.webai-head');
  let drag = null;
  head.addEventListener('mousedown', function (e) {
    if (e.target.closest && e.target.closest('.webai-tb')) return;      // 点按钮不算拖
    const r = el.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height };
    webAiRaise(o);
    e.preventDefault();
  });
  window.addEventListener('mousemove', function (e) {
    if (!drag) return;
    const x = Math.min(Math.max(-drag.w + 120, e.clientX - drag.dx), window.innerWidth - 90);
    const y = Math.min(Math.max(0, e.clientY - drag.dy), window.innerHeight - 34);
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
  });
  window.addEventListener('mouseup', function () {
    if (!drag) return;
    drag = null;
    webAiRecordGeometry(o.key);
  });
  // ② 工具栏
  head.addEventListener('click', function (e) {
    const b = e.target.closest && e.target.closest('.webai-tb');
    if (!b) { webAiRaise(o); return; }
    const act = b.dataset.act;
    try {
      if (act === 'back') o.wv.goBack();
      else if (act === 'fwd') o.wv.goForward();
      else if (act === 'reload') { o.mask.style.display = ''; webAiHardReload(o); webAiSetStatus(o.key, 'loading'); }
      else if (act === 'mini') { el.classList.toggle('mini'); b.textContent = el.classList.contains('mini') ? '▔' : '▁'; webAiRecordGeometry(o.key); }
      else if (act === 'free') webAiFree(o);
      else if (act === 'open') webAiOpenExternal(o.key);
      else if (act === 'close') webAiHide(o.key);
    } catch (err) { /* ignore */ }
  });
  // ③ 遮罩里的"重试 / 用浏览器打开"
  el.querySelector('.webai-body').addEventListener('click', function (e) {
    const a = e.target.closest && e.target.closest('.webai-act');
    if (!a) return;
    if (a.dataset.act === 'retry') {
      o.mask.style.display = '';
      o.mask.innerHTML = '<div class="webai-spin"></div><div class="webai-mask-t">正在加载 ' + o.site.name + ' …</div>';
      webAiSetStatus(o.key, 'loading');
      // o.wv 可能为 null（释放过内存）：原代码 try/catch 都假设 wv 存在，
      //   null 时 catch 里再调 setAttribute 会抛 TypeError，重试按钮彻底失效（真实踩过）。
      if (!o.wv) { webAiRebuildGuest(o); return }
      try { if (o.wv.loadURL) o.wv.loadURL(o.site.url); else o.wv.setAttribute('src', o.site.url) } catch (err) { try { o.wv.setAttribute('src', o.site.url) } catch (e2) { /* ignore */ } }
    } else if (a.dataset.act === 'open') webAiOpenExternal(o.key);
  });
  // ④ 鼠标按在窗口任何地方都把它抬到最前（多窗口叠着时符合直觉）
  el.addEventListener('mousedown', function () { webAiRaise(o); }, true);
  // ⑤ 拉过右下角大小 → 记下来（resize 是 CSS 的，没有事件，用 ResizeObserver）
  try {
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(function () { webAiRecordGeometry(o.key); });
      ro.observe(el);
      o.ro = ro;
    }
  } catch (e) { /* ignore */ }
}

function webAiRaise(o) {
  try {
    o.el.style.zIndex = String(++WEB_AI_ST.z);
    webAiMarkOn();
  } catch (e) { /* ignore */ }
}
function webAiOpenExternal(key) {
  const site = WEB_AI.filter(function (s) { return s.key === key; })[0];
  let url = site ? site.url : '';
  try { const o = webAiWins[key]; if (o && o.wv && o.wv.getURL) url = o.wv.getURL() || url; } catch (e) { /* ignore */ }
  try {
    if (window.app && typeof window.app.openExternal === 'function') { window.app.openExternal(url); return; }
  } catch (e) { /* ignore */ }
  try { window.open(url, '_blank'); } catch (e) { /* ignore */ }
}
function webAiFree(o) {
  try {
    if (o.ro) { o.ro.disconnect(); o.ro = null; }
    if (o.wv) {
      try { o.wv.stop(); } catch (e) {}
      try { o.wv.remove(); } catch (e) { const p = o.wv.parentNode; if (p) p.removeChild(o.wv); }
      o.wv = null;
    }
    webAiSetStatus(o.key, 'none');
    o.mask.style.display = '';
    o.mask.innerHTML = '<div class="webai-mask-t">已释放内存</div>' +
      '<div class="webai-act" data-act="retry">点这里重新加载</div>' +
      '<div class="webai-act" data-act="open">改用系统浏览器打开</div>';
  } catch (e) { /* ignore */ }
}
function webAiShow(key) {
  const o = webAiEnsure(key, '');
  if (!o) return;
  if (o.hibernateTimer) { clearTimeout(o.hibernateTimer); o.hibernateTimer = null; }
  try { if (o.wv && o.wv.setAudioMuted) o.wv.setAudioMuted(false); } catch (e) {}
  o.el.classList.remove('warm', 'mini');
  const mb = o.el.querySelector('.webai-tb[data-act="mini"]');
  if (mb) mb.textContent = '▁';
  webAiRaise(o);
  webAiMarkOn();
  try {
    if (o.wv && o.wv.focus) setTimeout(function () { try { o.wv.focus(); } catch (e) {} }, 0);
  } catch (e) { /* ignore */ }
}
function webAiHide(key) {
  const o = webAiWins[key];
  if (!o) return;
  o.el.classList.add('warm');
  webAiRecordGeometry(key);
  webAiMarkOn();
  if (o.hibernateTimer) clearTimeout(o.hibernateTimer);
  o.hibernateTimer = setTimeout(function () {
    try {
      if (o.el.classList.contains('warm') && o.wv && (!window.__webaiBridgeBusy || !window.__webaiBridgeBusy[key])) {
        if (o.wv.setAudioMuted) o.wv.setAudioMuted(true);
      }
    } catch (e) {}
  }, 60000);
}
// 打开 / 收起一个站点的窗口 —— **顶栏图标和画布上的「网页版 AI 节点」共用这一个函数**
// （一个功能只留一处实现：另写一份就会出现两套窗口、两份登录态、两份 guest 内存）。
// forceShow=true 表示"只开不收"：画布上双击节点的语义是**打开**（用户原话"点击选中双击打开"），
//   窗口本来就开着的时候再双击，应该只是把它提到最前面，而不是把它收起来。
// 返回 true = 答应打开了；false = 顶栏站点表里没有这个 key（画布靠它决定要不要提示，不许静默失败）。
function webAiToggle(key, forceShow) {
  if (!WEB_AI.filter(function (s) { return s.key === key; })[0]) return false;
  const o = webAiWins[key];
  if (!forceShow && o && !o.el.classList.contains('warm')) { webAiHide(key); return true; }
  webAiShow(key);
  return true;
}
// ★导出一份给画布节点复用★（用它的地方：本文件上面 renderers.flow 里的 openWebAi）。
// 为什么多这一行：画布那节要的是"打开某个站点的窗口"，而站点表 / webview 分区 / 登录态 /
//   ⏏ 释放内存全在这一节里管着 —— 画布只认这个入口，不碰里面的细节。
// 为什么挂 window 而不是让画布直接调 webAiToggle：⟳ 会**重新求值整个文件**（页面上下文不变），
//   挂 window 上每次重跑都会被新函数覆盖、不会留旧闭包；画布那边取不到时**当场出提示**，不会静默失败。
window.__kunWebAiOpen = webAiToggle;
// ★给网页版 AI 桥的"确保挂载"入口（v3.17，2026-09-23）★
// 为什么需要：桥要往某个站的 <webview> 里打脚本，而**没挂到 DOM 上的 webview 拒绝执行**
//   （electron：`The WebView must be attached to the DOM`）⇒ 一问就 0 字失败，报错还看不懂。
//   挂载只有这一节能做（分区/遮罩/状态点都在这儿），所以给桥一个窄入口：只"显示"，不 toggle（绝不把开着的窗口关掉）。
//   桥那边只在检测到 wv.isConnected === false 时才调它。
window.__kunWebAiEnsure = function (key) {
  try {
    var o = webAiEnsure(String(key), '');
    if (!o) return false;
    if (!o.wv || o.wv.isConnected === false) webAiRebuildGuest(o);   // ⏏ 释放过 / 被卸掉 ⇒ 用同一分区重建
    webAiShow(key);
    return true;
  } catch (e) { return false; }
};
// ★2026-09-30★ 静默挂载（`__kunWebAiSilentMount`）：把窗口和 guest **建好但保持收起**（warm = opacity:0，
//   屏幕上不出现、不抢焦点、不 raise）。和上面 `__kunWebAiEnsure` 的唯一区别就是**不调 webAiShow**。
//   为什么需要它：用户当天明确要求「调用免费 AI 时不要打开新窗口」（他正在录屏，窗口自己蹦出来很恼人）；
//   但 `noWarm` 的站（deepseek）压根没建 webview ⇒ 完全不给入口就等于"必须用户手动点开"。
//   桥在"窗口没开 / guest 被释放 / 刚重载还没挂载"三种情形下改走这条 ⇒ 活照跑、屏幕上一个窗口都不多。
window.__kunWebAiSilentMount = function (key) {
  try {
    var o = webAiEnsure(String(key), 'warm');
    if (!o) return false;
    if (!o.wv || o.wv.isConnected === false) webAiRebuildGuest(o);
    return true;
  } catch (e) { return false; }
};
// 说明：没有 webAiHideOthers —— 五个窗口是互相独立的（见 webAiShow 里的注释），
// 唯一"会收起来"的动作是用户自己点：点图标切换、点 ✕、点 ⏏（释放内存）。
function webAiMarkOn() {
  try {
    Object.keys(webAiWins).forEach(function (k) {
      const btn = document.querySelector('.webai-btn[data-key="' + k + '"]');
      if (btn) btn.classList.toggle('on', !webAiWins[k].el.classList.contains('warm'));
    });
  } catch (e) { /* ignore */ }
}

// 顶栏那五个图标（插在「清玄的工作台」字段后面；✕ 幂等：⟳ 重跑不会插第二排）
function decorateWebAi() {
  try {
    const drag = document.querySelector('#titlebar .titlebar-drag');
    const brand = document.querySelector('#titlebar .brand');
    if (!drag || !brand) return;
    webAiAdopt();                                    // ⟳ 之后先把旧窗口认领回来
    let strip = document.getElementById('webai-strip');
    if (!strip) {
      strip = document.createElement('span');
      strip.id = 'webai-strip';
      strip.className = 'webai-strip';
      strip.setAttribute('role', 'group');
      strip.setAttribute('aria-label', '网页版 AI');
      brand.parentNode.insertBefore(strip, brand.nextSibling);   // ★紧跟品牌字段之后
    }
    WEB_AI.forEach(function (site, i) {
      let btn = strip.querySelector('.webai-btn[data-key="' + site.key + '"]');
      if (!btn) {
        btn = document.createElement('button');
        btn.className = 'webai-btn';
        btn.dataset.key = site.key;
        btn.dataset.st = 'none';
        btn.dataset.fb = site.fallback;
        btn.title = site.name + '（点一下开一个窗口，再点收起）' + (site.tip ? '　·　' + site.tip : '');
        const img = document.createElement('img');
        img.src = site.icon;
        img.alt = site.name;
        img.draggable = false;
        img.onerror = function () { try { btn.classList.add('noimg'); this.remove(); } catch (e) {} };
        btn.appendChild(img);
        btn.addEventListener('click', function () {
          // 已开着 → 再点收起；否则打开。判定/动作都在 webAiToggle 里（画布节点走的是同一个函数）
          webAiToggle(site.key);
        });
        strip.appendChild(btn);
      }
    });
    // ★2026-11-04 内存修复（实测 7.2GB / OOM，见 诊断-内存\内存问题诊断报告.md）★
    //   ① 默认**不预热**（站点表已全部 noWarm）：点开时才建 webview，启动只留 1 个 harness guest；
    //   ② 想恢复"秒开"：显式设 window.__DSH_WEB_AI_WARM = true 或 localStorage['webai.warm']='1'；
    //   ③ **分离窗口永不预热**（以前每个分离窗口都会再建一整套 4 站，+0.4~0.8GB）；
    //   ④ 即使开启预热，也只在窗口**可见且用户已交互过**之后再做，且一次只预 1 个 —— 不排队占满。
    const warmWanted = (function () {
      try {
        if (document.body.classList.contains('solo')) return false;      // 分离窗口：不预热
        if (window.__DSH_WEB_AI_WARM === true) return true;             // 显式开关（调试/回归用）
        return localStorage.getItem('webai.warm') === '1';              // 用户自选"秒开"
      } catch (e) { return false; }
    })();
    const warmOk = !!(window.app && window.app.caps && window.app.caps.webaiGuestFreeNav);
    if (!WEB_AI_ST.warmed && warmWanted && warmOk) {
      // 只取"允许预热"的那 1 个站（warmOptIn）。实测证明：同时预热多个隐藏站点会失控
      // （豆包/千问/智谱三个都跑飞）⇒ 即使开启秒开，也只预 1 个，且选实测最稳的（kimi）。
      const warmList = WEB_AI.filter(function (s) { return s.warmOptIn; }).slice(0, 1);
      const kick = function () {
        warmList.forEach(function (s, k) {
          setTimeout(function () { try { webAiEnsure(s.key, 'warm'); } catch (e) { /* 单个站点失败不影响别的 */ } }, 1200 + k * 700);
        });
      };
      // 只有真的有可预热站点才置位（否则以后加正站也不会再触发）
      if (warmList.length) WEB_AI_ST.warmed = true;
      // 交互信号：指针 + 键盘都算（纯键盘用户不点鼠标）
      const arm = function () {
        if (WEB_AI_ST.interacted) return;
        WEB_AI_ST.interacted = true;
        try { document.removeEventListener('pointerdown', arm); } catch (e) { /* ignore */ }
        try { document.removeEventListener('keydown', arm); } catch (e) { /* ignore */ }
        kick();
      };
      try {
        if (WEB_AI_ST.interacted) kick();
        else {
          document.addEventListener('pointerdown', arm, { once: true, passive: true });
          document.addEventListener('keydown', arm, { once: true });
        }
      } catch (e) { /* ignore */ }
    } else if (!WEB_AI_ST.warmed && warmWanted && !warmOk && !WEB_AI_ST.warmOff) {
      WEB_AI_ST.warmOff = true;
      if (window.console && console.info) {
        console.info('[webai] 壳还是旧策略（main.js/preload.js 需重启 GUI）→ 暂不预热，避免自动弹出系统浏览器');
      }
      const tip = '　·　重启一次 GUI 后自动开启"秒开预热"';
      WEB_AI.forEach(function (site) {
        const b = strip.querySelector('.webai-btn[data-key="' + site.key + '"]');
        if (b && b.title.indexOf('重启一次 GUI') < 0) b.title += tip;
      });
    }
    webAiMarkOn();
  } catch (e) { /* 装饰失败不影响工作台 */ }
}

// ============ 标题栏右上角：把 emoji 按钮换成"线性浅灰图标" ============
// 为什么也放这里：改 index.html 要重启 GUI，而这个文件点 ⟳ 就重新执行 → 换图标立刻生效。
// 风格对齐"技能"按钮（16×16 内联 SVG、currentColor 继承 .tb-btn 的浅灰、悬停变亮）。
// 图标取"精简有代表性"：外观=月牙（深/浅色）、插件=插头、模型与提供方=芯片。
var TOOLBAR_ICONS = {
  'btn-theme':
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  'btn-plugins':
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M6 2.6v2.2M10 2.6v2.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
    '<path d="M3.9 4.8h8.2v2.6a4.1 4.1 0 0 1-8.2 0V4.8Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
    '<path d="M8 11.5v1.9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  'btn-models':
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<rect x="4.6" y="4.6" width="6.8" height="6.8" rx="1.4" stroke="currentColor" stroke-width="1.3"/>' +
    '<rect x="6.9" y="6.9" width="2.2" height="2.2" rx="0.6" stroke="currentColor" stroke-width="1.2"/>' +
    '<path d="M6.6 2.6v2M9.4 2.6v2M6.6 11.4v2M9.4 11.4v2M2.6 6.6h2M2.6 9.4h2M11.4 6.6h2M11.4 9.4h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
};
function decorateToolbarIcons() {
  try {
    Object.keys(TOOLBAR_ICONS).forEach(function (id) {
      const btn = document.getElementById(id);
      if (!btn) return;
      if (btn.getAttribute('data-icon') === 'svg') return;   // 幂等：换过就不再动
      btn.innerHTML = TOOLBAR_ICONS[id];
      btn.setAttribute('data-icon', 'svg');
    });
  } catch (e) { /* 换图标失败不影响功能 */ }
}

// 引擎版本与"本壳适配版本"不一致时：小点转琥珀色（呼吸光效保留），一眼能看出"该核对一下了"
function highlightEngineMismatch(on) {
  try {
    const dot = document.getElementById('brand-dot');
    if (dot) dot.classList.toggle('brand-dot-warn', !!on);
    const brand = document.querySelector('.brand');
    if (brand) brand.title = on ? ('引擎版本与适配版本不一致：引擎 v' + engineMismatch + '，本壳适配 v' + ADAPTED_ENGINE) : '';
  } catch (e) { /* ignore */ }
}

// ── 场景标签图标（外壳 renderer.js 里 ICONS 的"热更新版"）────────────────────
// 为什么放这里：`renderer.js` 是外壳，改它要重启应用；本文件随标题栏「⟳ 刷新」重载并重建。
// 这里按场景 id 覆写标签图标 ⇒ 换图标立刻生效，不必重启，两边写法保持一致即可。
// oa-ops：服务器机柜（两片机架 + 绿色指示灯 + 插槽），比原来的云朵更贴合"OA 运维"。
var SCENARIO_ICONS = {
  // 命令（command，2026-10-26）：与 renderer.js 的 NEURON_SVG 同一份
  'command':
    '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.7 4.5 8 2.9l4.4 1.7M3 8.4l.7-3.9M8 2.9l.4 5.2M12.4 4.6 8.4 8.1M8.4 8.1l3.8 3.4M8.4 8.1l-3.8 4.1M3 8.4l5.4-.3" stroke="#8fb4ff" stroke-width=".85" stroke-linecap="round" opacity=".6"/><circle cx="3.7" cy="4.5" r="1.45" fill="#8fb4ff"/><circle cx="8" cy="2.9" r="1.15" fill="#8fb4ff" opacity=".85"/><circle cx="12.4" cy="4.6" r="1.25" fill="#8fb4ff"/><circle cx="3" cy="8.4" r="1.05" fill="#8fb4ff" opacity=".8"/><circle cx="8.4" cy="8.1" r="1.85" fill="#f0a35e"/><circle cx="12.2" cy="11.5" r="1.15" fill="#8fb4ff" opacity=".85"/><circle cx="4.6" cy="12.2" r="1.05" fill="#8fb4ff" opacity=".8"/></svg>',
  // 工作台定制（workbench-custom，2026-10-26）：与 renderer.js 的 WORKBENCH_SVG 同一份
  'workbench-custom':
    '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="2.4" width="12" height="11.2" rx="1.9" fill="#8fb4ff"/><circle cx="4.05" cy="3.5" r=".48" fill="#0b1220" opacity=".45"/><circle cx="5.6" cy="3.5" r=".48" fill="#0b1220" opacity=".45"/><rect x="3.5" y="4.9" width="4" height="3.2" rx=".7" fill="#0b1220" opacity=".55"/><rect x="8.5" y="4.9" width="4" height="3.2" rx=".7" fill="#0b1220" opacity=".55"/><rect x="3.5" y="8.6" width="4" height="3.2" rx=".7" fill="#0b1220" opacity=".55"/><rect x="8.72" y="8.28" width="4" height="3.2" rx=".7" fill="#f0a35e"/></svg>',
  // 2026-10-19「B站」：这里的内容是 innerHTML 插入 ⇒ 要写 <img> 标签（不是路径）
  'bilibili': '<img src="assets/bilibili-icon.png" width="17" height="17" alt="" style="display:block">',
  // 2026-10-26「刷抖音」：抖音官方 favicon 转 PNG（32×32，去背白）
  'douyin': '<img src="assets/douyin-icon.png" width="17" height="17" alt="" style="display:block">',
  'oa-ops':
    '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<rect x="2" y="2.6" width="12" height="4.7" rx="1.2" fill="currentColor"/>' +
    '<rect x="2" y="8.7" width="12" height="4.7" rx="1.2" fill="currentColor" opacity=".8"/>' +
    '<circle cx="4.4" cy="4.95" r="1" fill="#3ddc84"/>' +
    '<circle cx="4.4" cy="11.05" r="1" fill="#3ddc84"/>' +
    '<rect x="6.6" y="4.45" width="5.4" height="1" rx=".5" fill="#0b1220" opacity=".45"/>' +
    '<rect x="6.6" y="10.55" width="5.4" height="1" rx=".5" fill="#0b1220" opacity=".45"/></svg>',
  // video-workflow：胶片 + 播放三角（与 renderer.js 的 FILM_SVG 同一份，两边保持一致）
  'video-workflow':
    '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<rect x="2" y="2.4" width="12" height="11.2" rx="1.8" fill="#8fb4ff"/>' +
    '<circle cx="4.7" cy="4.9" r=".8" fill="#0b1220" opacity=".55"/>' +
    '<circle cx="8" cy="4.9" r=".8" fill="#0b1220" opacity=".55"/>' +
    '<circle cx="11.3" cy="4.9" r=".8" fill="#0b1220" opacity=".55"/>' +
    '<circle cx="4.7" cy="11.1" r=".8" fill="#0b1220" opacity=".55"/>' +
    '<circle cx="8" cy="11.1" r=".8" fill="#0b1220" opacity=".55"/>' +
    '<circle cx="11.3" cy="11.1" r=".8" fill="#0b1220" opacity=".55"/>' +
    '<path d="M6.6 6.7l3.8 2.3-3.8 2.3z" fill="#0b1220" opacity=".8"/></svg>',
  // self-review：环形箭头（复盘/回顾）+ 文档页（与 renderer.js 的 REVIEW_SVG 同一份，两边保持一致）
  'self-review':
    '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M13.1 8A5.1 5.1 0 1 1 11.4 4.1" stroke="#8fb4ff" stroke-width="1.5" stroke-linecap="round"/>' +
    '<path d="M13.5 2.2v3h-3" stroke="#8fb4ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<rect x="5.6" y="5.9" width="4.8" height="6.2" rx="1" fill="#8fb4ff" opacity=".85"/>' +
    '<rect x="6.9" y="7.6" width="2.2" height=".9" rx=".45" fill="#0b1220" opacity=".5"/>' +
    '<rect x="6.9" y="9.4" width="2.2" height=".9" rx=".45" fill="#0b1220" opacity=".5"/></svg>',
  // stock-analysis：「我的分析助手」→ 同花顺官方图标（用户 2026-09-26 指定；
  // 由 scripts\fetch-hithink-icon.mjs 从 10jqka 官网抓到 renderer\assets\hithink-icon.png（32×32 PNG；
  // 那个网址后缀是 .ico、content-type 也写 image/x-icon，但真实字节是 PNG —— 脚本按魔数认格式），
  // 换版式了重跑那个脚本即可）。这里用 <img>：renderer.js 只认 .png，热更新版不受那个限制。
  'stock-analysis':
    '<img class="tab-ico-img" src="assets/hithink-icon.png" alt="">',
  // dsh-gui：窗口 + 三块面板（右下那块琥珀色高亮 = 正在改造的那块）。
  // 原为"窗口 + 两条滑杆"，像"设置"而不像"改造界面"（2026-09-26 用户要求换）；与 renderer.js 的 PANELS_SVG 同一份。
  'dsh-gui':
    '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<rect x="2" y="2.7" width="12" height="10.6" rx="1.6" fill="#4f8cff" opacity=".26"/>' +
    '<rect x="2" y="2.7" width="12" height="10.6" rx="1.6" stroke="#8fb4ff" stroke-width="1.1"/>' +
    '<rect x="2.6" y="4.5" width="10.8" height="1" fill="#8fb4ff" opacity=".45"/>' +
    '<circle cx="4.15" cy="3.6" r=".5" fill="#8fb4ff" opacity=".85"/>' +
    '<circle cx="5.85" cy="3.6" r=".5" fill="#8fb4ff" opacity=".85"/>' +
    '<rect x="3.4" y="6.5" width="4.3" height="5.3" rx=".8" fill="#8fb4ff" opacity=".38"/>' +
    '<rect x="8.7" y="6.5" width="4.1" height="2.2" rx=".8" fill="#8fb4ff" opacity=".38"/>' +
    '<rect x="8.7" y="9.6" width="4.1" height="2.2" rx=".8" fill="#f0a35e"/></svg>',
  // design-misc（设计杂活，2026-09-26 新增）：钢笔笔尖 + 落笔曲线 —— "画/做设计"的意象（用户要"有设计感"，不要 emoji）。
  // 三个候选（贝塞尔控制点 / 三层图层 / 钢笔）出过 17px 对比图，钢笔这版在真标签尺寸下最好认。
  // 与 renderer.js 的 DESIGN_SVG 同一份，两边保持一致。
  'design-misc':
    '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M1.8 13.6c0-5 2.8-8.4 6.8-8.4 2.3 0 3.5 1.2 3.5 2.8 0 2-1.7 3.1-3.9 3.1-1.9 0-3.2.7-4.1 1.9" stroke="#8fb4ff" stroke-width="1.4" stroke-linecap="round"/>' +
    '<path d="M11.1 2.1 14 5l-3.3.9z" fill="#f0a35e"/>' +
    '<circle cx="1.9" cy="13.4" r="1.15" fill="#f0a35e"/></svg>',
  // code-dev（程序开发，2026-10-22 新增）：代码尖括号 + 斜杠；与 renderer.js 的 CODE_SVG 是同一份。
  'code-dev':
    '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M5.2 4.1 2 8l3.2 3.9" stroke="#8fb4ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M10.8 4.1 14 8l-3.2 3.9" stroke="#8fb4ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M9.2 2.8 6.8 13.2" stroke="#f0a35e" stroke-width="1.5" stroke-linecap="round"/></svg>',
    // pc-cleanup（电脑清理，2026-10-06 新增）：用量环 —— "分区占用"的意象；与 renderer.js 的 CLEAN_SVG 是同一份。
    'pc-cleanup':
      '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
      '<circle cx="8" cy="8" r="5.4" stroke="#8fb4ff" stroke-width="1.7" opacity=".35"/>' +
      '<path d="M8 2.6a5.4 5.4 0 0 1 5.2 4" stroke="#f0a35e" stroke-width="1.7" stroke-linecap="round"/>' +
      '<circle cx="8" cy="8" r="1.7" fill="#8fb4ff"/></svg>',
};
// ============ 电脑清理场景：磁盘分区面板（C / D / E / F 四个分区的大小）============
// 数据：宿主 IPC app.sys.disks()（main.js 用 fs.statfsSync 只读算总量/剩余）。
// ⚠ 缺这个命名空间 = 主进程还是旧的（本次动的就是 main.js/preload.js）⇒ 要**重启一次 GUI** 才有实时读数；
//   没重启前面板显示提示而不是空白（面板代码本身是 ⟳ 热更新的）。
// 危险度配色：<70% 绿 · 70~89% 黄 · ≥90% 红 —— 一眼看出哪个盘该清。
// 2026-10-10 美化 + 占满：顶部总览条（总量/已用/剩余/最紧张）+ 四张"占比环"卡 + 底部图例，
//   网格改成 `auto 1fr 1fr auto` 撑满整格 —— 老版是 `align-content:start`，内容堆在顶上、下半格全空。
renderers['pc-drives'] = (body) => {
  body.classList.add('pc-drives-body');
  const K = window.app && window.app.sys;
  const wrap = el('div', 'pc-drives');
  body.appendChild(wrap);
  let disposed = false;
  const GB = 1073741824;
  const fmt = (b) => (b == null ? '--' : ((b / GB) >= 100 ? (b / GB).toFixed(0) : (b / GB).toFixed(1)) + ' GB');
  const fmtBig = (b) => { if (b == null) return '--'; const g = b / GB; return g >= 1024 ? (g / 1024).toFixed(2) + ' TB' : g.toFixed(0) + ' GB'; };
  const level = (p) => (p >= 90 ? 'bad' : (p >= 70 ? 'warn' : 'ok'));
  // 分区角色：用户 2026-10-10 明确的定位 —— D 主要存软件 / E 主要存文件 / F 是游戏盘
  const ROLE = { 'C:': '系统盘', 'D:': '软件盘', 'E:': '文件盘', 'F:': '游戏盘' };
  const RING_R = 33, RING_C = 2 * Math.PI * RING_R;

  // 占比环：SVG 描边 + 虚线偏移（矢量，缩放不糊；比进度条更像仪表盘）
  function ringOf(pct, lv) {
    const NS = 'http://www.w3.org/2000/svg';
    const mk = (t) => document.createElementNS(NS, t);
    const svg = mk('svg');
    svg.setAttribute('viewBox', '0 0 80 80');
    svg.setAttribute('class', 'pc-ring');
    const bg = mk('circle');
    bg.setAttribute('cx', '40'); bg.setAttribute('cy', '40'); bg.setAttribute('r', String(RING_R));
    bg.setAttribute('class', 'pc-ring-bg');
    const fg = mk('circle');
    fg.setAttribute('cx', '40'); fg.setAttribute('cy', '40'); fg.setAttribute('r', String(RING_R));
    fg.setAttribute('class', 'pc-ring-fg ' + lv);
    fg.setAttribute('stroke-dasharray', RING_C.toFixed(2));
    const p = Math.max(0, Math.min(100, pct));
    fg.setAttribute('stroke-dashoffset', (RING_C * (1 - p / 100)).toFixed(2));
    fg.setAttribute('transform', 'rotate(-90 40 40)');   // 从 12 点方向起画
    svg.appendChild(bg); svg.appendChild(fg);
    const box = el('div', 'pc-ring-wrap');
    box.appendChild(svg);
    box.appendChild(el('span', 'pc-ring-txt ' + lv, Math.round(pct) + '%'));
    return box;
  }
  function kv(k, v) {
    const row = el('div', 'pc-drive-line');
    row.appendChild(el('span', 'pc-k', k));
    row.appendChild(el('span', 'pc-v', v));
    return row;
  }
  function paint(rows, note) {
    if (disposed) return;
    wrap.innerHTML = '';
    if (note) { wrap.appendChild(el('div', 'pc-drives-note', note)); return; }
    const list = (rows || []).filter(Boolean);
    const live = list.filter((d) => d.ok);
    // ① 顶部总览条
    const tot = live.reduce((a, d) => a + (d.total || 0), 0);
    const used = live.reduce((a, d) => a + (d.used || 0), 0);
    const free = live.reduce((a, d) => a + (d.free || 0), 0);
    const worst = live.slice().sort((a, b) => b.percent - a.percent)[0];
    const sum = el('div', 'pc-drives-sum');
    const item = (k, v, cls) => {
      const it = el('div', 'pc-sum-item');
      it.appendChild(el('span', 'pc-sum-k', k));
      it.appendChild(el('span', 'pc-sum-v' + (cls ? ' ' + cls : ''), v));
      return it;
    };
    sum.appendChild(item('总容量', fmtBig(tot)));
    sum.appendChild(item('已用', fmtBig(used)));
    sum.appendChild(item('剩余', fmtBig(free)));
    if (worst) sum.appendChild(item('最紧张', String(worst.drive) + ' ' + worst.percent.toFixed(1) + '%', level(worst.percent)));
    const hhmmss = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    sum.appendChild(el('span', 'pc-sum-hint', PC_SEL.drive ? ('已选 ' + PC_SEL.drive + ' → 右侧只看它') : '点分区卡 → 右侧看该盘大户'));
    sum.appendChild(el('span', 'pc-sum-time', hhmmss + ' 读数 · 每 10 秒自动刷新'));
    wrap.appendChild(sum);
    // ② 四张分区卡（可点：选中 ⇒ 右侧「磁盘大户排行」切成这个盘；再点一次取消）
    list.forEach((d) => {
      const lv = d.ok ? level(d.percent) : 'off';
      const sel = d.drive && PC_SEL.drive === d.drive;
      const card = el('div', 'pc-drive-card ' + lv + (sel ? ' sel' : ''));
      if (d.ok) {
        card.title = '点一下：右侧「磁盘大户排行」只看 ' + d.drive + (sel ? '（再点一次取消）' : '');
        card.addEventListener('click', () => pcSelectDrive(d.drive));
      }
      if (d.ok) card.appendChild(ringOf(d.percent, lv));
      const info = el('div', 'pc-drive-info');
      const top = el('div', 'pc-drive-top');
      top.appendChild(el('span', 'pc-drive-name', String(d.drive || '?')));
      if (ROLE[d.drive]) top.appendChild(el('span', 'pc-drive-role', ROLE[d.drive]));
      if (sel) top.appendChild(el('span', 'pc-drive-badge', '已选'));
      info.appendChild(top);
      if (d.ok) {
        info.appendChild(kv('已用', fmt(d.used)));
        info.appendChild(kv('剩余', fmt(d.free)));
        info.appendChild(kv('总量', fmt(d.total)));
      } else {
        info.appendChild(kv('状态', d.err === 'ENOENT' ? '无此分区' : '未就绪'));
      }
      card.appendChild(info);
      wrap.appendChild(card);
    });
    // ③ 底部图例（颜色含义 + 清理纪律一句）
    const lg = el('div', 'pc-drives-legend');
    [['ok', '＜70% 宽裕'], ['warn', '70~89% 该留意'], ['bad', '≥90% 该清']].forEach((p) => {
      const s = el('span', 'pc-lg ' + p[0]);
      s.appendChild(el('i', 'pc-lg-dot'));
      s.appendChild(el('span', null, p[1]));
      lg.appendChild(s);
    });
    lg.appendChild(el('span', 'pc-lg-note', '清理纪律：先列清单等你点头 → 直接删（无暂存，技能 pc-cleanup）'));
    wrap.appendChild(lg);
  }
  async function load() {
    if (disposed) return;
    if (!K || !K.disks) { paint([], '宿主还没重启：磁盘容量要重启一次 GUI 才会实时读数（面板已就位）。'); return; }
    try {
      const r = await K.disks();
      if (disposed) return;
      if (!r || !r.ok || !Array.isArray(r.drives)) { paint([], '读磁盘失败：' + ((r && r.err) || '未知')); return; }
      paint(r.drives, '');
    } catch (e) { paint([], '读磁盘异常：' + ((e && e.message) || e)); }
  }
  load();
  pcOnSelect(() => { if (!disposed) load(); });   // 点某个盘 ⇒ 立刻重画，把选中态亮出来
  const t = setInterval(load, 10000);
  return () => { disposed = true; clearInterval(t); };   // ★ cleanup：切场景/热更新时停掉，不泄漏
};

// ============ 电脑清理场景：三块数据面板（2026-10-10 立）============
//   ① pc-toplarge 磁盘大户排行   ② pc-stage 清理暂存   ③ pc-ledger 清理台账
// 数据来源：① ② 读 `data\pc-cleanup-scan.json`（由 scripts\pc-scan.mjs 产出）；
//          ③ 读 `data\pc-cleanup-log.json`（每清一次由 AI 追加一条）。
// ⛔ 面板**自己不能扫盘**：渲染层只有 app.file.read/write/stat，没有列目录 IPC ⇒ 数据必须由脚本产出。
//    也正因为纯读 JSON，这三块全是 ⟳ 热更新，不用重启 GUI。
var PC_DATA = {
  scan: ((window.app && window.app.paths && window.app.paths.dataDir) || '.') + '\\pc-cleanup-scan.json',
  log: ((window.app && window.app.paths && window.app.paths.dataDir) || '.') + '\\pc-cleanup-log.json',
};

// 跨面板联动：点磁盘分区面板里的某个盘 ⇒ 大户排行面板单独显示这个盘（再点一次取消，回到全盘）。
// 两块面板在同一个文档里，所以一个模块级变量 + 订阅就够，不用 IPC（也不惊动 main.js ⇒ 保持 ⟳ 热更新）。
var PC_SEL = { drive: '' };
var PC_SEL_SUBS = [];
function pcSelectDrive(d) {
  const next = String(d || '');
  PC_SEL.drive = (PC_SEL.drive === next) ? '' : next;   // 再点同一个 = 取消
  PC_SEL_SUBS.forEach((f) => { try { f(); } catch (e) { /* 单个订阅出错不影响别人 */ } });
}
function pcOnSelect(fn) { PC_SEL_SUBS.push(fn); }

// 读 JSON：文件不存在 = "还没扫过"（正常空态，不是错误）
function pcReadJson(file) {
  const F = window.app && window.app.file;
  if (!F || !F.read) return Promise.resolve({ err: '宿主还没重启：读文件要重启一次 GUI 才有 app.file。' });
  return F.read(file).then((res) => {
    if (!res || !res.ok) return { missing: true };
    try { return { data: JSON.parse(res.text), mtime: res.mtime }; }
    catch (e) { return { err: 'JSON 解析失败：' + ((e && e.message) || e) }; }
  }).catch((e) => ({ err: '读取异常：' + ((e && e.message) || e) }));
}
var pcGb = (n) => (n == null ? '--' : (n >= 1024 ? (n / 1024).toFixed(2) + ' TB' : (n >= 100 ? Number(n).toFixed(0) : Number(n).toFixed(1)) + ' GB'));
var pcBase = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;
var pcOpen = (fn, target) => {
  const A = window.app && window.app.app;
  if (!A || !A[fn]) return;
  try { A[fn](target); } catch (e) { /* 打不开就算了，不弹错 */ }
};
/** 面板骨架：定时重读 JSON —— 我重扫完你不用点 ⟳，十几秒内面板自己就变了。
 *  onReady(wrap, tick)：注册跨面板联动用（比如"点了某个盘就重画"）。 */
function pcPanel(body, cls, everyMs, render, onReady) {
  body.classList.add(cls);
  const wrap = el('div', 'pc-panel');
  body.appendChild(wrap);
  let disposed = false;
  const tick = () => { if (!disposed) render(wrap); };
  tick();
  if (onReady) { try { onReady(wrap, tick); } catch (e) { /* ignore */ } }
  const t = setInterval(tick, everyMs || 15000);
  return () => { disposed = true; clearInterval(t); };   // ★ cleanup
}
function pcEmpty(wrap, msg) { wrap.appendChild(el('div', 'pc-hint', msg)); }

// ① 磁盘大户排行：谁最占地方，点一行在资源管理器里定位。
// **联动**：点了磁盘分区面板里的某个盘 ⇒ 这里只显示那个盘（标题变成「C: 单盘排行」+ 显示全部按钮）；
// 默认（没选盘）= 全盘 Top N。数据分别是 byDrive[盘] / items。
function pcRenderTopLarge(wrap) {
  pcReadJson(PC_DATA.scan).then((r) => {
    wrap.innerHTML = '';
    if (r.missing) return pcEmpty(wrap, '还没扫过。让 AI 跑一次扫描（scripts\\pc-scan.mjs），这里就会列出最占地方的目录。');
    if (r.err) return pcEmpty(wrap, r.err);
    const d = r.data || {};
    const sel = PC_SEL.drive;
    const items = sel ? ((d.byDrive || {})[sel] || []) : (d.items || []);
    const when = d.scannedAt ? new Date(d.scannedAt).toLocaleString('zh-CN', { hour12: false }).slice(5) : '?';
    const head = el('div', 'pc-panel-head');
    if (sel) {
      head.appendChild(el('span', 'pc-sel-tag', sel + ' 单盘排行'));
      const back = el('button', 'pc-mini-btn', '显示全部');
      back.title = '回到全盘排行（也可以再点一次那个分区卡）';
      back.addEventListener('click', () => pcSelectDrive(''));
      head.appendChild(back);
    } else {
      head.appendChild(el('span', null, '全盘排行'));
    }
    head.appendChild(el('span', 'pc-panel-head-sub', '上次扫描 ' + when + ' · 用时 ' + (d.tookSec || '?') + 's'));
    wrap.appendChild(head);
    if (!items.length) {
      return pcEmpty(wrap, sel ? (sel + ' 上没有超过 ' + (d.minGb || 0.5) + ' GB 的目录。') : '扫描结果里没有超过 ' + (d.minGb || 0.5) + ' GB 的目录。');
    }
    const max = items[0].gb || 1;
    const list = el('div', 'pc-rank');
    items.forEach((it, i) => {
      const row = el('div', 'pc-rank-row');
      row.title = it.path + '\n（点击在资源管理器里定位）';
      const bar = el('i', 'pc-rank-bar');
      bar.style.width = Math.max(2, Math.round((it.gb / max) * 100)) + '%';
      row.appendChild(bar);
      row.appendChild(el('span', 'pc-rank-no', String(i + 1)));
      const nm = el('span', 'pc-rank-name');
      nm.appendChild(el('b', null, pcBase(it.path)));
      nm.appendChild(el('i', null, String(it.path).slice(0, String(it.path).length - pcBase(it.path).length - 1)));
      row.appendChild(nm);
      row.appendChild(el('span', 'pc-rank-gb', pcGb(it.gb)));
      row.addEventListener('click', () => pcOpen('revealPath', it.path));
      list.appendChild(row);
    });
    wrap.appendChild(list);
    if (!sel) wrap.appendChild(el('div', 'pc-foot', '点左边任意分区卡 → 这里只看那个盘'));
  });
}
renderers['pc-toplarge'] = (body) => {
  // ⚠ 显式 cleanup：check-gui 第 4 项按"本渲染器 → 下一个 renderers[...]"切片认这个形状
  const stop = pcPanel(body, 'pc-toplarge-body', 15000, pcRenderTopLarge, (wrap, tick) => pcOnSelect(tick));
  return () => stop();
};

// ② 可清理体检：常扫的缓存/临时位置逐项体积，一眼看出哪里又长回来了。
// ⚠ 2026-10-10 用户定：**清理直接删除，不要"清理暂存"这一步**（原来那块面板已废）。
renderers['pc-junk'] = (body) => {
  const stop = pcPanel(body, 'pc-junk-body', 20000, (wrap) => {
    pcReadJson(PC_DATA.scan).then((r) => {
      wrap.innerHTML = '';
      if (r.missing) return pcEmpty(wrap, '还没扫过。让 AI 跑一次扫描（scripts\\pc-scan.mjs），这里列出各处的缓存体积。');
      if (r.err) return pcEmpty(wrap, r.err);
      const d = r.data || {};
      const junk = d.junk || [];
      // ⚠ 必须显示扫描时刻：面板数据是快照，清理完不重扫的话这些数字是旧的（曾把已删的 7.36 GB 还列在上面）
      const when = d.scannedAt ? new Date(d.scannedAt).toLocaleString('zh-CN', { hour12: false }).slice(5) : '?';
      wrap.appendChild(el('div', 'pc-panel-head', '上次扫描 ' + when + ' · 点一行打开位置'));
      const big = el('div', 'pc-big');
      big.appendChild(el('b', 'pc-big-num', pcGb(d.junkTotalGb != null ? d.junkTotalGb : junk.reduce((a, j) => a + (j.gb || 0), 0))));
      big.appendChild(el('span', 'pc-big-k', '体检合计 · ' + junk.length + ' 项'));
      wrap.appendChild(big);
      if (!junk.length) return pcEmpty(wrap, '这次扫描没量到可清理项。');
      junk.slice(0, 6).forEach((j) => {
        const row = el('div', 'pc-line clickable');
        row.title = j.k + '\n' + (j.path || '') + (j.note ? '\n' + j.note : '') + '\n（点击打开所在位置）';
        row.appendChild(el('span', 'pc-line-m', j.k));
        row.appendChild(el('span', 'pc-line-v', pcGb(j.gb)));
        row.addEventListener('click', () => pcOpen('openPath', j.path));
        wrap.appendChild(row);
      });
      wrap.appendChild(el('div', 'pc-foot', '要我清就说一声 —— 按新规矩直接删，不留暂存'));
    });
  });
  return () => stop();
};

// ③ 清理台账：历次清了什么、释放多少、累计多少
// ⚠ 这里必须写成显式 `return () => stop()`：check-gui 第 4 项是按"本渲染器 → 下一个 renderers[...]"
//   切片去找 cleanup 形状的，而 pc-ledger 后面隔着几千行无关代码（里面有 setInterval），
//   简写形式会被误判成"用了定时器却不返回 cleanup"。
renderers['pc-ledger'] = (body) => {
  const stop = pcPanel(body, 'pc-ledger-body', 20000, (wrap) => {
    pcReadJson(PC_DATA.log).then((r) => {
      wrap.innerHTML = '';
      if (r.err) return pcEmpty(wrap, r.err);
      const es = (r.data && r.data.entries) || [];
      const total = es.reduce((a, e) => a + (Number(e.freed) || 0), 0);
      const big = el('div', 'pc-big');
      big.appendChild(el('b', 'pc-big-num', pcGb(total)));
      big.appendChild(el('span', 'pc-big-k', '累计释放 · ' + es.length + ' 次'));
      wrap.appendChild(big);
      if (!es.length) return pcEmpty(wrap, '还没有清理记录。清完一次我会往台账里追加一条。');
      es.slice().reverse().slice(0, 6).forEach((e) => {
        const row = el('div', 'pc-line');
        row.title = (e.what || '') + (e.note ? '\n' + e.note : '');
        row.appendChild(el('span', 'pc-line-k', String(e.date || '').slice(5)));
        row.appendChild(el('span', 'pc-line-m', e.what || ''));
        row.appendChild(el('span', 'pc-line-v accent', '+' + (Number(e.freed) || 0).toFixed(2)));
        wrap.appendChild(row);
      });
    });
  });
  return () => stop();
};

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

// ============ 个人站场景（personal-site）：官网预览 / 关于 / 自媒体 / 联系 / 投喂 ============
var SITE_BASE = null;

// 二维码大图弹层（点击外部关闭）
var siteQrLayer = null;

// 官网/项目本地文件夹（2026-10-22：浏览根由主进程 SITE_BROWSE_DIR 决定，默认 <工作台>

// 官网预览：webview 内嵌 <工作台>

// 关于我：头像 + 简介 + 标签 + 时间线

// 自媒体账号：B站 / 抖音 / 小红书 卡片（打开主页 + 二维码弹层）

// 项目管理：项目卡片列表（图标 + 名字 + 状态 + 描述 + 本地路径 + 操作）

// 我的网址：一条一条的列表（图标 + 名字 + 网址标签 + 在线状态，点击在浏览器打开）
// 个人站为置顶网站（下方横栏分隔）；其余为个人站内容的相关链接；每 1 分钟自动探测一次在线状态

// ============ code-urls（程序开发场景「网址」）：项目相关网址的实时状态（点击用系统浏览器打开）============
// 数据来自场景 json：meta.urls = [{ name, url, note? }] —— 换项目只改 json，不动渲染器。
// 只用宿主通用能力：app.site.probe（主进程发 HTTP，绕开渲染器跨域限制）/ app.site.open（系统浏览器打开）。
// 首个用户：code-dev 场景「网址」窗口（取代原来那个空的「项目管理」预留位）。

// ============ Blender 场景（blender）：实时画面 / 本地文件 ============
// 场景独立性：只走 window.app.blender 这一套 IPC，不读股票 / OA / 个人站的任何数据。
// 画面来自主进程的抓帧进程（PrintWindow 抓 Blender 窗口 → JPEG），由本地静态服务直出，
// 渲染层只负责带时间戳轮询同一张图，所以帧数据不经过 IPC。

// Blender 实时画面（大窗口）

// Blender 本地文件（工作区浏览：<盘根>:\blender\blender控制）

/* ══════════════════════════════════════════════════════════════════
   OA 运维场景 · 文件面板（type = "file"）
   meta.mode = 'local' → 只显本地；'cloud' → 只显云端；缺省 → 左右双栏
   每个面板自带【工具条 + 列表】，互不串线
   ══════════════════════════════════════════════════════════════════ */

// =====================================================================================
// 场景「自我复盘」（self-review）：右上角浏览 <盘根>:\DSH\自我复盘（md 镜像，只读）
//                                 左上角大窗「单击即预览」（渲染 md + 跟读目录内相对链接）
// -------------------------------------------------------------------------------------
// 为什么另写一对面板，不复用现成的 file / site-folder：
//   1) file 面板单击 = 交给系统程序打开，且只认图/视频；md 是纯文本，这里要的是"单击 = 在左窗渲染"；
//   2) site-folder 的路径夹死在 SITE_DIR，预览走静态服务器（md 会被当纯文本吐出来）→ 不满足"渲染 md"；
//   3) 本场景就这两个面板互相配合：桥接用一个挂在 window 上的小对象 __SR + 两个自定义事件即可，
//      不碰别的场景，也不改 HARNESS_PIN_JS / styles 里任何既有规则。
// 数据来源：主进程 app.review（根＝REVIEW_DIR，路径夹在该目录内，只读，无写接口）。
// =====================================================================================
var SR_LABEL = ((window.app && window.app.paths && window.app.paths.reviewDir) || '自我复盘');
var SR_LAST_KEY = 'sr:self-review:last';   // 记住上次看的文档（按场景分区；切场景/重启后自动恢复）

// ---------- 小工具（都带 sr 前缀，避免和工作台里的同名函数打架）----------
function srEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// 行内元素：`code` / **粗** / *斜* / ~~删~~ / [文字](链接)
function srInline(s) {
  var t = srEsc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  t = t.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  return t;
}
// 迷你 Markdown → HTML：标题 / 粗斜删 / 行内码 / 围栏码 / 有序无序表 / 复选框 / 表格 / 引用 / 分割线 / 链接
// （够用即止：档案与知识库这几篇就是标题 + 列表 + 表格 + 引用，不为它引入第三方库）
function srMd(src) {
  var lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  var html = [], i = 0, listOpen = false, para = [];
  function flushPara() {
    if (para.length) { html.push('<p>' + srInline(para.join(' ')) + '</p>'); para = []; }
  }
  function closeList() { if (listOpen) { html.push('</ul>'); listOpen = false; } }
  function cells(s) {
    return s.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); });
  }
  while (i < lines.length) {
    var ln = lines[i];
    // 围栏代码块
    if (/^\s*(```|~~~)/.test(ln)) {
      flushPara(); closeList();
      var body = [], j = i + 1;
      while (j < lines.length && !/^\s*(```|~~~)\s*$/.test(lines[j])) { body.push(lines[j]); j++; }
      html.push('<pre class="sr-code"><code>' + srEsc(body.join('\n')) + '</code></pre>');
      i = j + 1; continue;
    }
    // 表格：本行含 | 且下一行是 |---| 分隔行
    if (ln.indexOf('|') >= 0 && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|/.test(lines[i + 1])) {
      flushPara(); closeList();
      var head2 = cells(ln), trs = [], k = i + 2;
      while (k < lines.length && lines[k].trim() && lines[k].indexOf('|') >= 0) { trs.push(cells(lines[k])); k++; }
      html.push('<table class="sr-tb"><thead><tr>' + head2.map(function (c) { return '<th>' + srInline(c) + '</th>'; }).join('') +
        '</tr></thead><tbody>' + trs.map(function (r) {
          return '<tr>' + r.map(function (c) { return '<td>' + srInline(c) + '</td>'; }).join('') + '</tr>';
        }).join('') + '</tbody></table>');
      i = k; continue;
    }
    var h = ln.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); closeList(); html.push('<' + 'h' + h[1].length + '>' + srInline(h[2]) + '</h' + h[1].length + '>'); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(ln)) { flushPara(); closeList(); html.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(ln)) {
      flushPara(); closeList();
      var qb = [], m = i;
      while (m < lines.length && /^\s*>/.test(lines[m])) { qb.push(lines[m].replace(/^\s*>\s?/, '')); m++; }
      html.push('<blockquote>' + srMd(qb.join('\n')) + '</blockquote>');
      i = m; continue;
    }
    var li = ln.match(/^\s*[-*+]\s+(.*)$/);
    if (li) {
      flushPara();
      if (!listOpen) { html.push('<ul>'); listOpen = true; }
      var t = li[1], box = '', cb = t.match(/^\[( |x|X)\]\s+(.*)$/);
      if (cb) { box = '<span class="sr-cb">' + (cb[1].toLowerCase() === 'x' ? '☑' : '☐') + '</span> '; t = cb[2]; }
      html.push('<li>' + box + srInline(t) + '</li>');
      i++; continue;
    }
    var oli = ln.match(/^\s*\d+[.)]\s+(.*)$/);
    if (oli) {
      flushPara();
      if (!listOpen) { html.push('<ul class="sr-ol">'); listOpen = true; }
      html.push('<li>' + srInline(oli[1]) + '</li>');
      i++; continue;
    }
    if (!ln.trim()) { flushPara(); closeList(); i++; continue; }
    para.push(ln.trim()); i++;
  }
  flushPara(); closeList();
  return html.join('\n');
}
// 相对路径解析：支持 ./ 与 ../（文档里的相对链接、目录名都用它）
function srJoin(dir, p) {
  var s = String(p == null ? '' : p).replace(/\\/g, '/');
  try { s = decodeURIComponent(s); } catch (e) { /* 没转义就算了 */ }
  if (/^[a-zA-Z]:/.test(s)) return s.replace(/^[a-zA-Z]:[\\/]*/, '').replace(/\\/g, '/');   // 绝对路径 → 归一到"相对根"
  s = s.replace(/^\.\//, '');
  var parts = String(dir || '').split('/').filter(Boolean);
  s.split('/').forEach(function (seg) {
    if (!seg || seg === '.') return;
    if (seg === '..') parts.pop(); else parts.push(seg);
  });
  return parts.join('/');
}
function srParent(rel) {
  var p = String(rel || '').split('/').filter(Boolean);
  p.pop();
  return p.join('/');
}
function srSize(n) {
  var v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1048576) return (v / 1024).toFixed(v < 10240 ? 1 : 0) + ' KB';
  return (v / 1048576).toFixed(1) + ' MB';
}
function srTime(t) {
  var n = Number(t) || 0;
  if (!n) return '';
  var d = new Date(n * 1000), p = function (x) { return (x < 10 ? '0' : '') + x; };
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
// 主进程里"用系统程序打开 / 在资源管理器里显示"的接口名按存在性探测，避免写错名字静默失效
function srOpenPath(p) {
  var k = window.app || {}, a = k.app || {}, o = k.oa || {};
  var fn = a.openPath || o.openPath;
  if (typeof fn !== 'function') return false;
  try { fn(p); return true; } catch (e) { return false; }
}
function srRevealPath(p) {
  var k = window.app || {}, a = k.app || {}, o = k.oa || {};
  var fn = a.revealPath || o.openFolder;
  if (typeof fn !== 'function') return false;
  try { fn(p); return true; } catch (e) { return false; }
}
function srCopy(text) {
  try {
    var ta = document.createElement('textarea');
    ta.value = String(text == null ? '' : text);
    ta.style.position = 'fixed'; ta.style.left = '-9999px'; ta.style.top = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    var ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}
function srFull(rel) { return SR_LABEL + '\\' + String(rel || '').replace(/\//g, '\\'); }
// 复盘镜像的**绝对路径**：根目录就是 SR_LABEL 本身（不带结尾反斜杠），窗口二标题行 / ⧉ 都用它
function srAbs(rel) { return rel ? srFull(rel) : SR_LABEL; }
// 操作提示（「✓ 已复制…」）并进**标题行**（用户要求）：原来挂在内容区底部，空着时也占一排（21px），
// 看着就像一条很粗的下边框、正文永远碰不到下沿。拿不到标题行时才退回内容区。
function srTipIn(head, body, before) {
  var t = el('span', 'sr-tip sr-head-tip');
  if (head) { if (before && before.parentNode === head) head.insertBefore(t, before); else head.appendChild(t); }
  else body.appendChild(t);
  var timer = 0;
  return function (msg, ms) {
    t.textContent = msg || '';
    t.title = msg || '';
    if (timer) clearTimeout(timer);
    if (msg && ms) timer = setTimeout(function () { t.textContent = ''; t.title = ''; }, ms);
  };
}

// ---------- 左上「文档预览」的文件分流（★2026-10-11★ 用户要求：预览能力从"只能看 md"扩到"能预览的全部文件"）----------
// 判据只看**扩展名**，并且判在渲染层（不在主进程）：
//   ① 主进程的 review:read 对**任何**文件都会回 utf8 正文（它只是额外标了个 text 标志），
//      "该不该按文本读"必须在这儿先判断 —— 否则 PDF / 图片会被当文本读成一屏乱码；
//   ② 判在渲染层 = 不用动 main.js = 改完 ⟳ 就生效，不用重启 GUI。
// 四类去处：
//   md / text        → 左窗自己渲染（md 走 srMd；txt/json/js/csv/log… 按原文 <pre> 显示）
//   image/video/audio/pdf/html → **整块交给通用预览渲染器**（renderers.view）：
//                      滚轮缩放、播放条、内核 PDF 阅读器、HTML 内嵌渲染都在它那儿，本场景一行都不重复写
//   opaque（docx/xlsx/pptx/zip/psd…）→ 内核渲染不了 ⇒ 明确提示卡 + 「用系统默认程序打开」按钮（不白屏、不静默失败）
//   认不出扩展名的    → 先按文本读，正文里出现 NUL/大量坏字符再退回"打不开"卡片（无后缀、.sample 这类）
var SR_EXT_TEXT = ['md', 'markdown', 'mdx', 'txt', 'text', 'json', 'jsonl', 'jsonc', 'ndjson', 'csv', 'tsv', 'log',
  'ini', 'cfg', 'conf', 'env', 'yaml', 'yml', 'toml', 'xml', 'srt', 'ass', 'vtt',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'css', 'scss', 'less', 'sql', 'py', 'ps1', 'psm1', 'bat', 'cmd',
  'sh', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'lua', 'typ', 'sample'];
var SR_EXT_HTML = ['html', 'htm', 'xhtml'];
var SR_EXT_IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'];
var SR_EXT_VIDEO = ['mp4', 'webm', 'mov', 'mkv', 'm4v', 'avi'];
var SR_EXT_AUDIO = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'];
// ★2026-10-13★ Office / WPS 文档单独成一类（以前算 opaque、只给提示卡）：
//   现在交给通用预览渲染器 → 主进程借本机 Office 转成 PDF → 内核 PDF 阅读器内嵌显示。
//   留在 SR_EXT_OPAQUE 里的只剩"真的没法在面板里看"的：压缩包、PSD、可执行文件、数据库、镜像、APK。
var SR_EXT_OFFICE = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf', 'odt', 'ods', 'odp', 'wps', 'et', 'dps'];
var SR_EXT_OPAQUE = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'psd', 'ai', 'exe', 'dll', 'msi', 'db', 'sqlite', 'bin', 'iso', 'apk'];
function srExtOf(p) {
  var m = /\.([A-Za-z0-9]+)$/.exec(String(p || '').trim());
  return m ? m[1].toLowerCase() : '';
}
function srKindOf(p) {
  var e = srExtOf(p);
  if (!e) return 'maybe-text';                       // 无后缀：先按文本试
  if (e === 'md' || e === 'markdown' || e === 'mdx') return 'md';
  if (SR_EXT_HTML.indexOf(e) >= 0) return 'html';    // HTML：看渲染效果（不是当源码看）
  if (SR_EXT_IMAGE.indexOf(e) >= 0) return 'image';
  if (SR_EXT_VIDEO.indexOf(e) >= 0) return 'video';
  if (SR_EXT_AUDIO.indexOf(e) >= 0) return 'audio';
  if (e === 'pdf') return 'pdf';
  if (SR_EXT_OFFICE.indexOf(e) >= 0) return 'office';   // Word/Excel/PPT：转 PDF 后内嵌显示
  if (SR_EXT_TEXT.indexOf(e) >= 0) return 'text';
  if (SR_EXT_OPAQUE.indexOf(e) >= 0) return 'opaque';
  return 'maybe-text';
}
// 二进制嗅探（只给"认不出扩展名"的文件用）：NUL 字节 = 一定是二进制；坏字符（U+FFFD，utf8 解不开的字节）
// 占比超过 5% 也算。真文本（哪怕是 GBK 的老笔记变成坏字符）不会满屏 NUL。
function srLooksBinary(text) {
  var s = String(text == null ? '' : text);
  if (!s) return false;
  if (s.indexOf('\u0000') >= 0) return true;
  var bad = (s.match(/\uFFFD/g) || []).length;
  return bad > 0 && bad / s.length > 0.05;
}
// 文件树里的小图标：一眼分清"点了会出图 / 会播 / 会渲染 / 打不开"
function srRowIcon(name) {
  var k = srKindOf(name);
  if (k === 'md') return '📄';
  if (k === 'image') return '🖼';
  if (k === 'video') return '🎞';
  if (k === 'audio') return '🔊';
  if (k === 'pdf') return '📕';
  if (k === 'office') return '📘';                   // Word/Excel/PPT：点开会在预览里转成 PDF
  if (k === 'html') return '🌐';
  if (k === 'text' || k === 'maybe-text') return '📃';
  return '🧩';                                       // opaque：要交给系统程序打开
}

// ---------- 右上角：文档树（目录＝单击进入，文件＝单击交给左窗预览，双击＝系统程序打开）----------
renderers['review-files'] = function (body, meta, head) {
  var K = (window.app && window.app.review) || null;
  body.classList.add('sr-wrap');

  var curRel = '', rowsCache = [], picked = '', disposed = false, seq = 0;

  // 功能按键（⌂ ↑ ⟳ ⧉）+ 面包屑全部并进**标题行**，排在标题「自我复盘 · 文档」后面 —— 三排压成一排：
  // 第二排的根路径与标题重复、面包屑根段「自我复盘」也重复（用户要求「重复的不显示」），
  // 「只读」徽标同样去掉了。拿不到标题行时退回内容区顶部（.sr-bar），保证单独渲染也能用。
  var bRoot = el('button', 'sr-btn', '⌂'); bRoot.type = 'button'; bRoot.title = '回到根目录';
  var bUp = el('button', 'sr-btn', '↑'); bUp.type = 'button'; bUp.title = '上一级';
  var bRe = el('button', 'sr-btn', '⟳'); bRe.type = 'button'; bRe.title = '重新读取目录';
  var bCp = el('button', 'sr-btn', '⧉'); bCp.type = 'button'; bCp.title = '复制当前文件夹的完整路径';
  var RO_NOTE = '这里是「个人档案 / 我的知识库」的复盘镜像：只读。要改档案去你自己的档案目录，再同步过来。';
  // 当前文件夹的**完整路径**：并进标题行显示，可拖选、也可单击复制（用户要求）。
  var fpath = el('span', 'sr-fpath');
  fpath.title = '当前文件夹的完整路径（单击复制）';
  if (head) {
    head.classList.add('sr-head', 'sr-head-files');
    var acts = el('div', 'file-head-acts sr-head-acts');
    acts.appendChild(bRoot); acts.appendChild(bUp); acts.appendChild(bRe); acts.appendChild(bCp);
    // 副标题（镜像根路径）与标题行上的完整路径重复 —— 整条收掉，否则它 flex:1 1 100% 会硬占第二排
    var headSub = head.querySelector('.panel-sub');
    if (headSub) { headSub.textContent = ''; headSub.style.display = 'none'; }
    // 插到**标题之后**（同 makePanel 里 AI 面板「展开」箭头的写法）：徽标 → 标题 → 路径 → 提示 → 按键
    var titleEl = head.querySelector('.panel-title');
    if (titleEl) { head.insertBefore(fpath, titleEl.nextSibling); head.insertBefore(acts, fpath.nextSibling); }
    else { head.appendChild(fpath); head.appendChild(acts); }
  } else {
    var bar = el('div', 'sr-bar');
    bar.appendChild(bRoot); bar.appendChild(bUp); bar.appendChild(bRe); bar.appendChild(bCp);
    body.appendChild(bar);
    body.appendChild(fpath);
  }

  var list = el('div', 'sr-list');
  list.title = RO_NOTE;
  body.appendChild(list);

  var tip = srTipIn(head, body, acts);

  // 路径文字 = 当前文件夹的绝对路径（根目录不带结尾反斜杠）。不再印面包屑：路径本身就是"具体位置"，
  // 窄面板里两套并排也放不下；回根 / 上一级仍有 ⌂ ↑。
  function paintPath() {
    var abs = srAbs(curRel);
    fpath.textContent = abs;
    fpath.title = abs + '　（单击复制）';
  }

  function rowOf(r) {
    var rel = curRel ? curRel + '/' + r.name : r.name;
    var ic = r.isDir ? '📁' : srRowIcon(r.name);
    var row = el('div', 'sr-row' + (rel === picked ? ' on' : ''));
    row.appendChild(el('span', 'sr-ic', ic));
    row.appendChild(el('span', 'sr-name', r.name));
    row.appendChild(el('span', 'sr-meta', r.isDir ? '' : srSize(r.size)));
    row.title = r.isDir ? (rel + '　单击进入') : (rel + '　单击＝在左边预览');
    // ★2026-10-11★ 单击 = **一律**送到左边预览（用户要求"右边库点击直接预览"）。
    //   以前这里有个 `r.text` 条件：图片/视频/PDF 这些非文本会被判成"预览不了"直接丢给系统程序打开，
    //   于是"单击"在不同类型上行为不一致。现在一律预览，能不能内嵌由左边那块的分类来决定
    //   （打不开的格式它会给出提示 + 「用系统默认程序打开」按钮，不会白屏）。
    // ★2026-10-13★ 用户又要求：**单击、双击、怎么点都只在左边预览**，别再拿系统程序打开。
    //   原来双击那条 `dblclick` 会直接 shell.openPath 拉起 Word/图片查看器 —— 单击已经预览了，
    //   双击再弹一个外部窗口纯属碍事。⇒ 删掉 dblclick，只留 click 一条路：
    //   双击本来就会先触发两次 click，效果一样是"在左边预览"，行为彻底统一。
    //   「用系统默认程序打开」现在只有**左边预览面板工具栏上那一个入口**（🖥），不会误触。
    function pick() {
      if (r.isDir) { load(rel); return; }
      picked = rel;
      paintRows();
      var br = window.__SR;
      if (br && typeof br.open === 'function') { br.open(rel, r.name, r.size, r.mtime); return; }
      // 预览面板不在（理论上不会发生）：退回"用系统程序打开"，不静默什么都不做
      tip('预览面板不在，已交给系统程序打开：' + r.name, 3500);
      if (!srOpenPath(srFull(rel))) tip('打不开：主进程没有 openPath', 4000);
    }
    row.addEventListener('click', pick);
    return row;
  }

  function paintRows() {
    list.innerHTML = '';
    var rows = rowsCache;
    if (curRel) {
      var up = el('div', 'sr-row sr-up');
      up.appendChild(el('span', 'sr-ic', '↰'));
      up.appendChild(el('span', 'sr-name', '..'));
      up.title = '上一级';
      up.addEventListener('click', function () { load(srParent(curRel)); });
      list.appendChild(up);
    }
    if (!rows.length) { list.appendChild(el('div', 'sr-empty', '（空目录）')); return; }
    rows.forEach(function (r) { list.appendChild(rowOf(r)); });
  }

  function load(rel) {
    if (!K) {
      list.innerHTML = '';
      list.appendChild(el('div', 'sr-empty', '主进程接口 app.review 未就绪（需要重启 GUI）'));
      return;
    }
    curRel = String(rel || '');
    paintPath();
    var my = ++seq;
    list.innerHTML = '';
    list.appendChild(el('div', 'sr-empty', '读取中…'));
    Promise.resolve(K.files(curRel)).then(function (res) {
      if (disposed || my !== seq) return;
      if (!res || !res.ok) { list.innerHTML = ''; list.appendChild(el('div', 'sr-empty', (res && res.err) || '读取失败')); return; }
      rowsCache = res.rows || [];
      picked = (window.__SR && window.__SR.cur) || picked;
      paintRows();
    }).catch(function (e) {
      if (disposed || my !== seq) return;
      list.innerHTML = '';
      list.appendChild(el('div', 'sr-empty', '读取异常：' + e.message));
    });
  }

  // 预览面板切换文档 → 高亮（必要时跟着跳目录）；它在空状态点目录 → 这里跳过去
  function onPick(ev) {
    var rel = ev && ev.detail && ev.detail.rel;
    if (!rel) return;
    picked = rel;
    var dir = rel.indexOf('/') >= 0 ? rel.replace(/[^/]*$/, '').replace(/\/$/, '') : '';
    if (dir !== curRel) load(dir); else paintRows();
  }
  function onGoto(ev) {
    var rel = ev && ev.detail && typeof ev.detail.rel === 'string' ? ev.detail.rel : '';
    load(rel);
  }
  window.addEventListener('sr-pick', onPick);
  window.addEventListener('sr-goto', onGoto);
  // ★2026-10-13★ 预览面板点了「✕ 关闭」⇒ 这里只**取消高亮**，不跟着跳目录
  //   （不能用 sr-goto：那会把文件库整个导航回根目录，用户正翻到深目录时会很烦）
  function onClearPick() { picked = ''; paintRows(); }
  window.addEventListener('sr-clear-pick', onClearPick);

  bRoot.addEventListener('click', function () { load(''); });
  bUp.addEventListener('click', function () { load(srParent(curRel)); });
  bRe.addEventListener('click', function () { load(curRel); });
  // ⧉ 与标题行上的路径文字是同一件事：复制**当前文件夹**的绝对路径（跟左上角预览面板的 ⧉ 同一套
  // srCopy：textarea + execCommand，因为这里是 file:// 页面，navigator.clipboard 不一定可用）。
  function copyAbs() {
    var abs = srAbs(curRel);
    tip(srCopy(abs) ? '✓ 已复制路径：' + abs : '复制失败，可手动选中复制：' + abs, 3200);
  }
  bCp.addEventListener('click', copyAbs);
  fpath.addEventListener('click', copyAbs);

  load('');
  return function () {
    disposed = true;
    window.removeEventListener('sr-pick', onPick);
    window.removeEventListener('sr-goto', onGoto);
    window.removeEventListener('sr-clear-pick', onClearPick);
  };
};

// ---------- 左上角：文档预览（渲染 md；单击右上文档即在此打开；文档内相对链接原地跟读）----------
renderers['review-doc'] = function (body, meta, head) {
  var K = (window.app && window.app.review) || null;
  body.classList.add('sr-wrap', 'sr-doc');

  var curRel = '', disposed = false, seq = 0;

  // 场景内桥：右上角面板单击 → 这里打开（面板渲染顺序里本面板在前，桥一定先就位）
  var br = window.__SR || (window.__SR = {});
  // ★2026-10-11★ 桥多收两个参数（size / mtime）：右栏单击时顺手把大小、时间带过来 —— 图片/视频/PDF
  //   这类媒体就不用为了"显示大小"先把整个文件读一遍（PDF 动辄几十 MB，读进内存纯属浪费）。
  var mine = function (rel, name, size, mtime) { openDoc(rel, name, size, mtime); };
  br.open = mine;
  br.cur = '';

  var fname = el('div', 'sr-doc-name', '（未选择文档）');
  var fmeta = el('div', 'sr-doc-meta', '');
  var acts = el('div', 'sr-doc-acts');
  var bRe = el('button', 'sr-btn', '⟳'); bRe.type = 'button'; bRe.title = '重新读取这个文件';
  var bOut = el('button', 'sr-btn', '🖥'); bOut.type = 'button'; bOut.title = '用系统默认程序打开';
  var bRev = el('button', 'sr-btn', '📂'); bRev.type = 'button'; bRev.title = '在资源管理器里显示';
  var bCp = el('button', 'sr-btn', '⧉'); bCp.type = 'button'; bCp.title = '复制完整路径';
  // ★2026-10-13★ 「✕ 关闭当前预览」（用户要求：加在「复制」右边）——此前只有"换一个文件"、没有"合上"，
  //   看完想收工只能去点别的文件，面板一直占着一份正文。
  //   行为＝回到「未选择文档」空状态 ＋ **顺手忘掉"上次看的文件"**（否则下次开面板它又自己回来了）。
  var bClose = el('button', 'sr-btn sr-btn-close', '✕'); bClose.type = 'button';
  bClose.title = '关闭当前预览（回到「未选择文档」；下次开面板不会自动恢复这个文件）';
  acts.appendChild(bRe); acts.appendChild(bOut); acts.appendChild(bRev); acts.appendChild(bCp); acts.appendChild(bClose);

  // 功能按键并进面板标题行（跟窗口二 .sr-head-acts 同一套做法）：标题「文档预览」→ 文件名 → 靠右的按键，
  // 全在一排；「完整路径 · 大小 · 时间」走标题行下面那行副标题（原来面板的那句提示语只在没打开文档时显示）。
  // 这样内容区只剩 md 正文，不再被横条吃掉一行。拿不到 head 时退回旧横条（.sr-doc-bar），单独渲染也不会瞎。
  var headSub = head ? head.querySelector('.panel-sub') : null;
  var SUB_HINT = '单击右上的文件即可在此预览（要改就用这排的 🖥 打开系统程序）';
  function subText(t) { if (headSub) headSub.textContent = t; else if (fmeta) fmeta.textContent = (t === SUB_HINT ? '' : t); }
  if (head) {
    // sr-head-doc：窗口一专用类 —— 文件名 + 路径·大小·时间 + 按键全部挤进标题这一排（见 styles.css）
    head.classList.add('sr-head', 'sr-head-doc');
    acts.classList.add('sr-head-acts');
    if (!headSub) { headSub = el('span', 'panel-sub', ''); head.appendChild(headSub); }
    // 必须插在**标题之后、副标题之前**：副标题是 flex:1 1 100% 独占一排，
    // 排到它后面的东西会被顶到第三排（窗口二已经踩过一次，见项目信息 §23.5）。
    var titleEl = head.querySelector('.panel-title');
    if (titleEl) { head.insertBefore(fname, titleEl.nextSibling); head.insertBefore(acts, fname.nextSibling); }
    else { head.appendChild(fname); head.appendChild(acts); }
  } else {
    var bar = el('div', 'sr-doc-bar');
    bar.appendChild(fname); bar.appendChild(fmeta); bar.appendChild(acts);
    body.appendChild(bar);
  }

  var md = el('div', 'sr-md');
  body.appendChild(md);

  var tip = srTipIn(head, body, acts);

  // ---------- 非文本类：整块交给通用预览渲染器（复用，不重写）----------
  // ★2026-10-11★ 用户要求「预览能预览的全部文件」。图片（滚轮缩放）、视频/音频（播放条）、
  //   PDF（内核自带阅读器）、HTML（内嵌渲染）这四类**一行渲染代码都不在这儿写** ——
  //   直接把通用预览渲染器 renderers.view 挂进内容区，用它的 window.__kunViews[面板id] 把文件递过去
  //   （跟「设计杂活」预览面板、流程画布双击节点同一条路）。以后 view 那边的图片缩放 / PDF 兜底 /
  //   播放器修好了，这里跟着一起好。
  //   ⚠ 它是往 md 里塞 .view-bar / .view-body / .view-status 的**列式**布局 ⇒ 需要 styles.css 的
  //     `.sr-md.sr-media` 那条规则（收掉正文内边距/滚动，并收掉与面板标题行重复的那条 view 工具行）。
  var MEDIA_ID = 'sr-doc-media';
  var mediaCleanup = null, mediaApi = null;
  function dropMedia() {
    if (mediaCleanup) { try { mediaCleanup(); } catch (e) { /* ignore */ } }
    mediaCleanup = null;
    mediaApi = null;
    md.classList.remove('sr-media');
    if (md.firstChild) md.innerHTML = '';
  }
  function showMedia(kind, rel, name) {
    if (!mediaApi) {
      // ★ 第一次挂通用预览渲染器之前必须先把内容区清干净：上一个文件若是**文本**，
      //   它的 <pre> 是直接写在 md 里的（不属于 view 的 bodyBox，view 的 clearBody 清不掉它），
      //   留着就会把 .view-body 挤成 0 高 —— 表现为"标题栏换成了图片名，正文还是上一篇的文字，
      //   图/PDF 其实已经加载了却看不见"（2026-10-11 探针实测抓到的真 bug）。
      if (md.firstChild) md.innerHTML = '';
      md.classList.add('sr-media');
      mediaCleanup = renderers.view(md, { id: MEDIA_ID });     // ← 复用：它自己往 md 里建「工具行/主体/状态行」
      mediaApi = (window.__kunViews || {})[MEDIA_ID] || null;
    } else {
      md.classList.add('sr-media');
    }
    if (!mediaApi) { showOpaque(rel, name); return; }          // 极端情况（注册表没拿到）⇒ 退回提示卡，绝不白屏
    mediaApi.show({ path: srFull(rel), title: name || '', kind: kind });
  }
  // 「内核渲染不了」的格式（docx/xlsx/pptx/zip/psd…）：说清是什么格式、为什么看不了，并给一个
  // **写在卡片里**的「用系统默认程序打开」按钮 —— 用户明确要求"不要白屏、不要静默失败"。
  function showOpaque(rel, name) {
    dropMedia();
    var box = el('div', 'sr-raw');
    var e = srExtOf(rel);
    box.appendChild(el('div', 'sr-raw-ic', '🧩'));
    box.appendChild(el('div', 'sr-raw-t', (name || rel.split('/').pop() || rel) + (e ? '（.' + e + '）' : '')));
    box.appendChild(el('div', 'sr-raw-s', '这种格式没法在面板里内嵌预览（Word / Excel / PPT / WPS 文档、压缩包、PSD 这类"打包格式"都算）。'
      + '用系统里默认的程序打开它就能看 —— 预览面板不会白屏，也不会默默什么都不做。'));
    var row = el('div', 'sr-raw-acts');
    var b1 = el('button', 'sr-qbtn sr-qopen', '🖥 用系统默认程序打开');
    b1.type = 'button';
    b1.addEventListener('click', function () { if (!srOpenPath(srFull(rel))) tip('打不开：主进程没有 openPath', 4000); });
    var b2 = el('button', 'sr-qbtn', '📂 在资源管理器里显示');
    b2.type = 'button';
    b2.addEventListener('click', function () { if (!srRevealPath(srFull(rel))) tip('打不开：主进程没有 revealPath', 4000); });
    row.appendChild(b1); row.appendChild(b2);
    box.appendChild(row);
    box.appendChild(el('div', 'sr-raw-path', srFull(rel)));
    md.appendChild(box);
  }
  // 打开过一次就记一次（下次 ⟳ / 切场景回来恢复），并让右栏跟着高亮 —— 两条都是原来散在成功分支里的
  function markPicked(rel) {
    try { localStorage.setItem(SR_LAST_KEY, rel); } catch (e) { /* ignore */ }
    try { window.dispatchEvent(new CustomEvent('sr-pick', { detail: { rel: rel } })); } catch (e) { /* ignore */ }
  }
  // 非 md 的文本（txt / json / 代码 / csv / log…）：**按原文显示**，不丢换行。
  //   （以前所有文本都被丢进 Markdown 渲染器 ⇒ json / 代码会被并成一整段，看着就像坏了）
  function showPlainText(text) {
    dropMedia();
    md.appendChild(el('pre', 'sr-pre', String(text == null ? '' : text)));
    md.scrollTop = 0;
  }
  function showMarkdown(text) {
    dropMedia();
    md.innerHTML = srMd(text);
    md.scrollTop = 0;
  }

  async function openDoc(rel, name, size, mtime) {
    rel = String(rel || '');
    if (!rel) return;
    if (!K) {
      dropMedia();
      md.appendChild(el('div', 'sr-empty', '主进程接口 app.review 未就绪（需要重启 GUI）'));
      return;
    }
    curRel = rel;
    br.cur = rel;
    syncClose();                                  // 有文件了 ⇒ ✕ 可用（2026-10-13）
    fname.textContent = name || rel.split('/').pop() || rel;
    fname.title = srFull(rel);
    var kind = srKindOf(rel);
    var title = srFull(rel) + (size ? '　·　' + srSize(size) : '') + (mtime ? '　·　' + srTime(mtime) : '');
    var my = ++seq;
    // ① 媒体类（图片/视频/音频/PDF/HTML/Office）：**不读盘**，直接交给通用预览渲染器
    //    ★2026-10-13★ office 也走这条：通用预览渲染器那边会先让主进程转成 PDF，再用内核 PDF 阅读器显示
    if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf' || kind === 'html' || kind === 'office') {
      subText(title);
      showMedia(kind === 'html' ? 'web' : kind, rel, name);
      markPicked(rel);
      return;
    }
    // ② 打包类（zip/rar/7z/psd/exe/db/iso/apk…）：内核渲染不了、也转不出 PDF ⇒ 提示卡 + 系统打开按钮
    if (kind === 'opaque') {
      subText(title);
      showOpaque(rel, name);
      markPicked(rel);
      return;
    }
    // ③ 文本类（md / 源码 / 数据 / 配置 / 认不出扩展名的）：读 utf8 正文
    subText('读取中…');
    dropMedia();
    md.innerHTML = '<div class="sr-empty">读取中…</div>';
    let res = null;
    try { res = await K.read(rel); } catch (e) { res = { ok: false, err: '读取异常：' + ((e && e.message) || e) }; }
    if (disposed || my !== seq) return;
    if (!res || !res.ok) {
      // ★2026-10-11★ 文件不在了（ENOENT：stat/readFile 失败，多见于档案里删过/改过名）⇒ 说人话 + 忘掉这个路径 + 回根，
      //   绝不把内核的 "ENOENT: no such file or directory, stat '…'" 原文糊在面板上。其它错误（越界/目录/权限/编码）照旧原样显示。
      if (/ENOENT|no such file or directory/i.test(String((res && res.err) || ''))) {
        emptyState('上次看的文件不在了（可能已改名或移动）　·　原路径：' + srFull(rel) + '　·　已回到档案根目录');
        try { localStorage.removeItem(SR_LAST_KEY); } catch (e) { /* ignore */ }
        try { window.dispatchEvent(new CustomEvent('sr-goto', { detail: { rel: '' } })); } catch (e) { /* ignore */ }
        return;
      }
      dropMedia();
      md.appendChild(el('div', 'sr-empty', (res && res.err) || '读取失败'));
      subText('');
      return;
    }
    var txt = String(res.content == null ? '' : res.content);
    // 认不出扩展名的文件（无后缀 / .sample 这类）：正文里出现 NUL（或大量坏字符）= 其实是二进制
    //   ⇒ 退回"打不开"卡片，绝不把乱码糊在面板里（不静默失败）
    if (kind === 'maybe-text' && srLooksBinary(txt)) {
      subText(srFull(rel) + '　·　' + srSize(res.size) + '　·　' + srTime(res.mtime));
      showOpaque(rel, name);
      markPicked(rel);
      return;
    }
    subText(srFull(rel) + '　·　' + srSize(res.size) + '　·　' + srTime(res.mtime));
    if (kind === 'md') showMarkdown(txt); else showPlainText(txt);
    if (res.cut) md.insertBefore(el('div', 'sr-cut', '⚠ 文件超过 4 MB，这里只渲染了前 4 MB'), md.firstChild);
    markPicked(rel);
  }

  // 文档里的链接：站内相对链接 → 原地跟读（_索引.md 里那一堆链接直接点就行）；外链 → 交给系统浏览器
  md.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    ev.preventDefault();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) { srOpenPath(href); return; }
    if (href.charAt(0) === '#') return;
    // ★2026-10-13★ Markdown 里的目标路径必须允许**百分号编码**：文件名带半角空格或半角括号时
    //   （例：`中国鸟类图鉴(1).pdf`、`中国毒蛇及蛇伤救治 (蓝海，陈远聪).pdf`），
    //   裸写会被 Markdown 语法截断（`)` 提前结束目标），所以档案索引里统一写成 `%28`/`%20`
    //   —— 浏览器会自动解码，但这里是自己的渲染器，不解码就点不开（表现为"链接是死的"）。
    //   实测：自我复盘 `关系复盘\_索引.md`、`我的知识库\...\_索引.md` 里共 14 条这类链接。
    if (href.indexOf('%') >= 0) { try { href = decodeURI(href); } catch (e) { /* 不是合法编码就按原样用 */ } }
    var dir = curRel.indexOf('/') >= 0 ? curRel.replace(/[^/]*$/, '') : '';
    openDoc(srJoin(dir, href), null);
  });

  // 空状态：一段说明 + 根目录里的文档/目录快捷入口
  function emptyState(notice) {
    dropMedia();
    fname.textContent = '（未选择文档）';
    subText(SUB_HINT);
    var box = el('div', 'sr-empty sr-empty-big');
    box.appendChild(el('div', 'sr-empty-t', '自我复盘 · 文件预览'));
    if (notice) box.appendChild(el('div', 'sr-empty-s', notice));   // ★2026-10-11★ 回根原因（上次看的文件不在了），说人话
    box.appendChild(el('div', 'sr-empty-s', '在右上角「库」里单击一个文件，这里就会预览它（目录单击＝进入）。'
      + '单击、双击、怎么点都只在这里预览，只有这排的 🖥 才会拉起外部程序。'
      + '能预览的：md / txt / 代码 / json / csv 这些文本、图片（可滚轮缩放）、视频、音频、PDF、HTML、'
      + 'Word / Excel / PPT（自动转成 PDF 内嵌）；压缩包这类真的看不了的，会给一张提示卡 + 一键「用系统默认程序打开」。'
      + '看完点 ✕ 就能合上。'));
    md.appendChild(box);
    syncClose();                                  // 空状态 ⇒ ✕ 置灰（2026-10-13）
    if (!K) return;
    Promise.resolve(K.files('')).then(function (res) {
      if (disposed || !res || !res.ok) return;
      var quick = el('div', 'sr-quick');
      (res.rows || []).filter(function (r) { return r.isDir; }).forEach(function (r) {
        var b = el('button', 'sr-qbtn sr-qdir', '📁 ' + r.name);
        b.type = 'button';
        b.title = '在右上面板里进入这个目录';
        b.addEventListener('click', function () {
          try { window.dispatchEvent(new CustomEvent('sr-goto', { detail: { rel: r.name } })); } catch (e) { /* ignore */ }
        });
        quick.appendChild(b);
      });
      (res.rows || []).filter(function (r) { return !r.isDir; }).slice(0, 6).forEach(function (r) {
        var b = el('button', 'sr-qbtn', r.name);
        b.type = 'button';
        b.addEventListener('click', function () { openDoc(r.name, r.name); });
        quick.appendChild(b);
      });
      if (quick.childNodes.length) md.appendChild(quick);
    }).catch(function () { /* ignore */ });
  }

  bRe.addEventListener('click', function () { if (curRel) openDoc(curRel, null); });
  bOut.addEventListener('click', function () { if (curRel && !srOpenPath(srFull(curRel))) tip('打不开：主进程没有 openPath', 4000); });
  bRev.addEventListener('click', function () { if (curRel && !srRevealPath(srFull(curRel))) tip('打不开：主进程没有 revealPath / openFolder', 4000); });
  bCp.addEventListener('click', function () { if (curRel) tip(srCopy(srFull(curRel)) ? '✓ 已复制完整路径' : '复制失败', 2200); });

  // ---- ✕ 关闭当前预览（2026-10-13 加）----
  // 没打开任何文件时置灰（不然点了没反应，像坏了）。
  function syncClose() { bClose.disabled = !curRel; }
  function closeDoc() {
    if (!curRel) return;
    dropMedia();                                  // 图片/视频/PDF/HTML 这类挂在预览区的要一起销毁
    seq++;                                        // 还在路上的读取结果作废
    curRel = ''; br.cur = '';
    // 忘掉"上次看的文件"：不清的话下次开面板（或点 ⟳）它又自己恢复了，跟"我关掉了"矛盾
    try { localStorage.removeItem(SR_LAST_KEY); } catch (e) { /* ignore */ }
    emptyState('已关闭预览　·　再点右上角「库」里的文件名就能重新打开');
    syncClose();
    // 右上角文件库把高亮也去掉（只清高亮，不跳目录 —— 他可能正翻在很深的目录里）
    try { window.dispatchEvent(new CustomEvent('sr-clear-pick')); } catch (e) { /* ignore */ }
    tip('已关闭预览', 1600);
  }
  bClose.addEventListener('click', closeDoc);

  var last = '';
  try { last = localStorage.getItem(SR_LAST_KEY) || ''; } catch (e) { last = ''; }
  if (last) openDoc(last, null); else emptyState();

  return function () {
    disposed = true;
    seq++;                     // 还在路上的读取结果一律作废
    dropMedia();               // 挂在这儿的通用预览渲染器（图/视频/PDF/HTML）要一起销毁，别留下监听与 webview
    if (window.__SR && window.__SR.open === mine) window.__SR.open = null;
    if (window.__SR && window.__SR.cur === curRel) window.__SR.cur = '';
  };
};

// ============ 右上角「MCP」开关面板（2026-09-21）============
// 面板本体在同目录 mcp-panel.js：本文件每次点 ⟳ 都会重新执行，所以这里用带版本号的
// 动态 <script> 把面板也一起重载（删旧的再加新的）—— 改面板只需点 ⟳，不必重启 GUI。
(function () {
  try {
    var old = document.getElementById('mcp-panel-script');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var s = document.createElement('script');
    s.id = 'mcp-panel-script';
    s.src = 'mcp-panel.js?v=' + Date.now();
    (document.body || document.documentElement).appendChild(s);
  } catch (e) { if (window.console) console.warn('[mcp] 面板加载失败', e); }
})();

// ---- 网页版 AI 桥（renderer\webai-bridge.js）----
// 让任何会话/脚本能问顶栏那 5 个免费网页版（入口：scripts\webai.mjs）。
// 靠 window.__kunWebAiBridge 幂等：⟳ 重跑只是换一次回调，监听不叠（preload 侧只有一个分发器）。
(function () {
  var old = document.getElementById('webai-bridge-script');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  var s = document.createElement('script');
  s.id = 'webai-bridge-script';
  s.src = 'webai-bridge.js?v=' + Date.now();
  (document.body || document.documentElement).appendChild(s);
})();

// ============ 面板对话框「焦点自愈」（2026-09-21）============
// 症状（用户实测原话）：对准面板窗口打字，字不进对话输入框、聊天框不显示，切到别的软件再切回来才好。
// 病因：宿主（<webview> 的 embedder）与 guest 的焦点不同步 —— guest 里的 composer 本来记得焦点，
//       但系统焦点没交给 guest，键盘事件就落在宿主那层（字跑到左上角那块），对话输入框自然不动。
// 修法：只在「guest 内部没有任何可编辑元素持有焦点」时，把焦点交回 guest **最靠下**的可编辑元素
//       （DSH 的 composer 就在页面底部）。用户正在打字时它已经持有焦点 ⇒ 这条分支不会走 ⇒ 绝不打断输入。
// 三道护栏（都是实测会踩到的场景）：
//   ① 宿主自己在输入（重命名节点、画布输入框等）⇒ 不抢；
//   ② 用户正待在别的 <webview> 里（顶栏网页版 AI 窗口、另一个面板）⇒ 不抢；
//   ③ 同一个位置 300ms 内只做一次（focus / transition 会连成一串）。
// 触发点＝用户手动的那个动作：窗口重新拿到系统焦点（alt-tab 回来）／页面重新可见／面板动画结束。
// 生效：改本文件 → 点顶栏 **⟳**（renderer 热更新），**不用重启**。排查用：控制台 `__kunFocusHealNow()`。
(function () {
  if (window.__kunFocusHeal) return;          // ⟳ 重跑只是重新执行本文件 ⇒ 装一次就够
  window.__kunFocusHeal = true;
  var HEAL = '(function(){try{' +
    'function ok(el){return !!el&&(el.tagName==="TEXTAREA"||el.tagName==="INPUT"||el.isContentEditable===true);}' +
    'var a=document.activeElement;' +
    'if(ok(a)){var ra=a.getBoundingClientRect();if(ra.width>40&&ra.height>8)return "keep:"+a.tagName;}' +
    'var n=document.querySelectorAll("textarea,[contenteditable=true]"),best=null,bestTop=-1e9;' +
    'for(var i=0;i<n.length;i++){var e=n[i],r=e.getBoundingClientRect(),s=getComputedStyle(e);' +
    'if(r.width<40||r.height<8||s.display==="none"||s.visibility==="hidden"||s.pointerEvents==="none")continue;' +
    'if(r.top>bestTop){bestTop=r.top;best=e;}}' +
    'if(best){try{best.focus();}catch(e2){}return "fix:"+best.tagName;}' +
    'return "none";}catch(e){return "err";}})()';
  function panelWv() {                        // 正在显示的那个对话面板 webview（有面积 = 在显示）
    var list = document.querySelectorAll('#harness-webview, webview.harness-wv'), best = null, area = 0;
    for (var i = 0; i < list.length; i++) {
      var wv = list[i], r;
      try { r = wv.getBoundingClientRect(); } catch (e) { continue; }
      if (r.width < 120 || r.height < 120) continue;
      var s = getComputedStyle(wv);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      if (r.width * r.height > area) { area = r.width * r.height; best = wv; }
    }
    return best;
  }
  var last = 0;
  // 留痕：每次自愈都往 data\focus-heal.log 追一行（只留最后 300 行）——
  // 这样"到底有没有再犯"不用靠用户开控制台，看文件就知道（走 app.file 通道，只允许 <盘根>:/E: 盘）。
  var LOG = __WB_ROOT + '\\外壳\\data\\focus-heal.log';
  function logHeal(why, r) {
    try {
      if (!window.app || !window.app.file || !window.app.file.write) return;
      window.app.file.read(LOG).then(function (res) {
        var old = (res && res.ok && res.text) ? res.text.split('\n') : [];
        var d = new Date();
        var stamp = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) +
          ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
        old.push(stamp + '  ' + why + ' → ' + r);
        var keep = old.filter(function (x) { return x !== ''; }).slice(-300);
        return window.app.file.write(LOG, keep.join('\n') + '\n');
      }).catch(function () { });
    } catch (e) { /* ignore */ }
  }
  function heal(why) {
    var wv = panelWv();
    if (!wv || !wv.focus) return;
    var ae = document.activeElement;                                   // ①② 两道护栏
    if (ae && ae !== document.body) {
      if (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable) return;
      if (ae.tagName === 'WEBVIEW' && ae !== wv) return;
    }
    try { wv.focus(); } catch (e) { }
    try {
      wv.executeJavaScript(HEAL).then(function (r) {
        logHeal(why, r);
        if (window.console && r && r.indexOf('fix') === 0) console.log('[focus-heal] ' + why + ' → ' + r);
      }).catch(function () { });
    } catch (e) { }
  }
  function healSoon(why) {
    var t = Date.now(); if (t - last < 300) return; last = t;           // ③ 防抖
    setTimeout(function () { heal(why); }, 60);
  }
  window.addEventListener('focus', function () { healSoon('win-focus'); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) healSoon('visible'); });
  document.addEventListener('transitionend', function (e) {
    var c = e.target && e.target.classList;
    if (c && (c.contains('panel-body') || c.contains('view-body') || c.contains('webai-body'))) healSoon('anim');
  }, true);
  window.__kunFocusHealNow = function () { heal('manual'); return 'ok'; };   // 手动触发（排查用）
})();

// ================= 独立窗口「置顶」（2026-09-23 第十一轮；第十二轮修"刷新多一个" + 换线性图钉）=================
// 场景分离窗口（?solo=1，主进程 createWindow({scene}) 打开的独立窗口）顶部菜单栏加一个置顶按钮：
// 点它 = 主进程 win.setAlwaysOnTop 开关 ⇒ 置顶后窗口浮在最上层，缩小独立窗口也能
// 「一边看独立窗口、一边看主窗口」，点主窗口/其它页面不会被遮挡。再点取消。
// 放 renderers.js（⟳ 即见）；切置顶走 app.setAlwaysOnTop（preload/main 暴露，重启 GUI 后可用；
// 老宿主没有它 ⇒ 按钮不显示，不崩）。
// ⚠ **必须幂等**：⟳ 是**热更新**（renderer.js 的 hotReloadRenderers() 重新加载本文件、DOM 不重载）
//   ⇒ 这段 IIFE 每点一次 ⟳ 就重跑一遍。原来无条件 insertBefore，点几次就插几个按钮（用户实测报的 bug）。
//   现在：先摘掉旧的 #btn-flow-pin 再重建 —— 旧的 click 监听随节点一起丢掉，**不会**出现"两个监听
//   各切一次 = 点了没反应"；置顶状态记在 data-on 上（DOM 不重载 ⇒ 刷新后状态不丢，接着显示"已置顶"）。
// 图标：与顶栏其它线性图标（手机/技能）同款 —— 16×16、currentColor、stroke-width 1.3 的**图钉**，
//   不再是 📌 emoji（emoji 大小/配色跟着系统字体走，跟顶栏不搭）。
(function () {
  if (!/[?&]solo=1/.test(window.location.search || '')) return;   // 只在独立窗口显示
  var bar = document.querySelector('.titlebar-controls');
  var minBtn = document.getElementById('btn-min');
  if (!bar || !minBtn) return;
  if (!(window.app && window.app.setAlwaysOnTop)) return;         // 老宿主没有这个 IPC ⇒ 干脆不显示按钮

  var PIN_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M6.15 1.85h3.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
    + '<path d="M7.05 1.85v3.3L4.85 7.6v1.25h6.3V7.6L8.95 5.15v-3.3" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>'
    + '<path d="M8 8.85v5.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
    + '</svg>';

  var prevs = document.querySelectorAll('#btn-flow-pin');        // ⚠ 老版本可能已经插了**好几个**（同 id 重复），getElementById 只拿得到第一个 ⇒ 用 querySelectorAll 全摘
  var on = prevs.length ? prevs[prevs.length - 1].getAttribute('data-on') === '1' : false;
  prevs.forEach(function (b) { b.remove(); });                   // 连旧的 click 监听一起丢掉（避免双触发）
  var btn = el('button', 'tb-btn tb-tools');
  btn.type = 'button';
  btn.id = 'btn-flow-pin';
  btn.innerHTML = PIN_SVG;
  function paint() {
    btn.classList.toggle('on', on);
    btn.setAttribute('data-on', on ? '1' : '0');
    btn.title = on
      ? '已置顶（点我取消：窗口回到普通层，会被其它窗口挡住）'
      : '置顶显示：窗口浮在最上层，缩小后一边看独立窗口一边看主窗口';
  }
  btn.addEventListener('click', async function () {
    var want = !on;
    on = want; paint();                     // 先乐观切换（IPC 回来前界面不卡）
    try {
      var r = await window.app.setAlwaysOnTop(want);
      if (!r || !r.ok) { on = !want; paint(); }
    } catch (e) { on = !want; paint(); }
  });
  paint();
  bar.insertBefore(btn, minBtn);            // 排在 ─ □ ✕ 那组前面，紧挨窗口控制按钮
})();

// ==========================================================================================
// 2026-10-19（宿主：「看着没变化」）—— styles.css 热重载
//   根因：刷新面板只重载 webview + 重跑页面脚本，**不会重新拉 styles.css** ⇒ 改 CSS 以前必须整页刷新。
//   做法：每 2 秒 stat 一次 styles.css 的 mtime，变了就给 <link> 换个查询串 ⇒ 浏览器重新拉文件。
//   纯渲染层（不碰 main/preload）；幂等：计时器挂在 window.__dshCssHot 上，⟳ 多次也只跑一个。
// ==========================================================================================
(function cssHotReload() {
  try {
    if (window.__dshCssHot) return;
    var F = window.app && window.app.file;
    if (!F || !F.stat) return;                       // 老宿主没有 stat ⇒ 静默跳过
    var link = document.querySelector('link[rel="stylesheet"][href*="styles.css"]');
    if (!link) return;
    var winPath = decodeURIComponent(location.pathname).replace(/^\//, '').replace(/\//g, '\\');
    var cssPath = winPath.replace(/[^\\]+$/, 'styles.css');
    window.__dshCssHot = { at: 0, path: cssPath, link: link, n: 0 };
    var last = 0;
    function tick() {
      Promise.resolve().then(function () { return F.stat(cssPath); }).then(function (st) {
        if (!st || !st.exists) return;
        var t = Number(st.mtime) || 0;
        if (!t) return;
        if (last && t !== last) {
          link.href = 'styles.css?v=' + t;
          window.__dshCssHot.n++;
          window.__dshCssHot.at = Date.now();
          if (window.console) console.log('[cssHot] styles.css 变了 ⇒ 重新加载（第 ' + window.__dshCssHot.n + ' 次）');
        }
        last = t;
      }).catch(function () { /* 读不到就算了 */ });
      window.__dshCssHot.at = window.__dshCssHot.at || Date.now();
      window.__dshCssHot.at = window.__dshCssHot.at || Date.now();
    }
    tick();
    setInterval(tick, 2000);
  } catch (e) { /* 装饰失败不影响主流程 */ }
})();

// ==========================================================================================
// 2026-10-19 22:4x（宿主：「打开工作台时 B站场景的网页也露出来」· dg-dsh 定位）
//   机制：切视图只切 .active 类 ⇒ #scenario-view 变 display:none，但 Electron 的 <webview> 是独立 guest view，
//         **不跟着 display:none 隐藏** ⇒ 残影露出来（harness 视图里也能看到 B站网页）。
//   做法：用本仓既有先例（renderers.js L1412：隐藏层用 opacity:0 + pointer-events:none，**不用 display:none**，
//         否则终端/webview 的尺寸测量会失真）——
//     · #scenario-view 失去 .active ⇒ 把里面所有 webview 设 opacity:0 / pointer-events:none（保留尺寸与运行状态）
//     · 重新拿到 .active ⇒ 还原
//     · ⛔ 绝不动 src / 不 reload（B站登录态与页面进度都要保住）
//     · ⚠ 只管 #scenario-view 里的 webview，**不碰 harness 自己的 #harness-webview**
//   场景 A⇄B 互切：grid 会被重建、旧 guest 可能残留一帧 ⇒ 点场景标签时先 park，400ms 后按 .active 状态复位。
// ==========================================================================================
(function parkScenarioWebviews() {
  try {
    if (window.__dshParkWv) return;                       // 幂等：⟳ 多次只装一次
    var host = document.getElementById('scenario-view');
    if (!host) return;
    window.__dshParkWv = true;

    function each(fn) {
      var list = host.querySelectorAll('webview');
      for (var i = 0; i < list.length; i++) fn(list[i]);
    }
    function park(hide) {
      each(function (w) {
        if (hide) {
          if (!w.__dshParked) {
            w.__dshParked = { opacity: w.style.opacity, pe: w.style.pointerEvents };
          }
          w.style.opacity = '0';
          // 2026-10-19 宿主「B站内容操作不了」：这里原来越权设了 pointer-events:none，
          //   一旦某次 sync 没跑（页面重建时序）就会把可见的 webview 钉成不可点。
          //   其实隐藏时父级是 display:none，本来就点不到 ⇒ 这行不需要。
        } else if (w.__dshParked) {
          w.style.opacity = w.__dshParked.opacity || '';
          w.style.pointerEvents = '';   // 无条件清掉：宁可多点穿透，也不能让页面点不动
          delete w.__dshParked;
        }
      });
      // 2026-11-04：离开场景视图（切到 DSH 引擎页）超过 3 秒 ⇒ **真正释放**面板：
      //   display:none 不会销毁独立 guest，实测连切 5 个场景后常驻 +150~960MB。
      //   场景标签再点回来时 loadScenario 会整页重建 ⇒ 这里清理不会多丢状态。
      if (hide) {
        if (releaseTimer) return;
        releaseTimer = setTimeout(function () {
          releaseTimer = null;
          try {
            if (host.classList.contains('active')) return;      // 又切回去了
            if (window.__dshUnloadScenario) window.__dshUnloadScenario();
            each(function (w) { try { w.remove(); } catch (e) { /* ignore */ } });
            if (window.console && console.info) console.info('[park] 场景视图已释放（离开 >3s）：webview 与面板定时器已清理');
          } catch (e) { /* ignore */ }
        }, 3000);
      } else if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
    }
    var releaseTimer = null;
    function sync() { park(!host.classList.contains('active')); }

    // ① 视图切换：盯 #scenario-view 的 class
    new MutationObserver(sync).observe(host, { attributes: true, attributeFilter: ['class'] });
    sync();

    // ② 场景 A⇄B：点标签时先压住，等重建完（400ms）再按当前可见性复位
    // 2026-10-19 宿主「B站内容操作不了」：原来点场景标签会先 park(true) 再 400ms 复位 ⇒ 时序一乱就把页面钉成不可点。
    //   这里整段撤掉：A⇄B 的残帧最多闪一下，但绝不会让人点不动（可点优先于好看）。
    // ③ 兜底：grid 内容变化时（场景重建）也让新加入的 webview 跟随当前可见性
    var grid = document.getElementById('grid');
    if (grid) {
      new MutationObserver(function () { if (!host.classList.contains('active')) park(true); })
        .observe(grid, { childList: true });
    }
    // 2026-10-19 兜底看门狗：每 2s 检查一次 —— 场景视图激活时，任何被 park 过的 webview 立即还原。
    //   （宁可多跑一个很轻的定时器，也不允许"页面看得见却点不动"）
    setInterval(function () { if (host.classList.contains('active')) park(false); }, 2000);
    // 2026-10-19 23:2x（bv-ai：也许输入没路由到 guest）—— 场景激活时给 webview 补一次 focus（无损）。
    //   ⚠ `重新 append` 那条我先**不启用**：移动 <webview> 可能让 guest 重载（B站会丢页面进度），
    //   等探针 `_点击探针.json` 里的 clicks / hostTop 出来再决定（clicks=0 且 hostTop=webview 才用）。
    new MutationObserver(function () {
      try {
        if (!host.classList.contains('active')) return;
        var ws = host.querySelectorAll('webview');
        for (var i = 0; i < ws.length; i++) {
          var w = ws[i];
          // 2026-10-19 23:3x：探针实测 clicks=0 且 hostTop=webview（没有遮挡、自身也没 pointer-events）
          //   ⇒ 就是 guest 的输入没路由。按 bv-ai 建议：**可见后重新挂一次**（同父容器内 append 回去），
          //   强制 guest 重新计算输入区域。每个 webview 只做一次（避免每次切场景都重挂）。
          if (w && !w.__dshRemounted) {
            w.__dshRemounted = 1;
            try { var pp = w.parentNode; if (pp) pp.appendChild(w); } catch (e) { /* ignore */ }
          }
          try { if (w && w.focus) w.focus(); } catch (e) {}
        }
      } catch (e) { /* ignore */ }
    }).observe(host, { attributes: true, attributeFilter: ['class'] });
    if (window.console) console.log('[park] 场景 webview 停车机制已装（opacity 方案，不动 src）');
  } catch (e) { /* 装饰失败不影响功能 */ }
})();

// ==========================================================================================
// 2026-10-21（宿主：顶栏 ⟳ 刷不到「原始对话面板」，而且它有时会空白）
//   ⟳ 原来只做两件事：热更新渲染器 + 重建**本地场景**；Harness（场景 0，内嵌 webview）根本不碰
//   ⇒ 所以刷不到。这里补一层（放 renderers.js，可热重载、不用重启工作台）：
//     ① Harness 页签下点 ⟳ ⇒ 真 reload 那个 webview（会话/布局都在引擎侧，刷新不丢）
//     ② 刷完 2.5s 自检：还空白 ⇒ 重新取一次带 token 的地址强刷
//     ③ 自愈：guest 进程崩了 / did-fail-load ⇒ 自动重载（最多 3 次，间隔递增，60s 冷却）
//     ④ 窗口获得焦点时，若当前就在 Harness 页且是空白 ⇒ 自动恢复（同样带冷却）
// ==========================================================================================
(function harnessRefreshHook() {
  var wv = document.getElementById('harness-webview');
  var btn = document.getElementById('btn-refresh');
  var view = document.getElementById('harness-view');
  if (!wv || !btn || !view) return;

  // 2026-10-21（宿主改口径）：**把"刷新"拆开** —— 顶栏 ⟳ 只刷场景，不再碰对话；
  //   对话面板单独一颗按钮，放在场景栏右侧「余额」旁边（宿主原话："到余额旁边专门刷新对话的"）。
  //   ⚠ 这一段必须放在"是否已挂监听"的判断**之前**：hotReload 重跑本文件时它每次都要重新插一次按钮。
  window.__mountChatReload = function () {
    try {
      var right = document.querySelector('.scenebar-right');
      if (!right) return;
      var olds = document.querySelectorAll('#btn-chat-reload');
      for (var i = 0; i < olds.length; i++) { if (olds[i].parentNode) olds[i].parentNode.removeChild(olds[i]); }
      var b = document.createElement('button');
      b.type = 'button';
      b.id = 'btn-chat-reload';
      b.className = 'sb-reload';
      b.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
        + '<path d="M13.25 8a5.25 5.25 0 1 1-1.62-3.79" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>'
        + '<path d="M13.45 2.35v3.5H9.95" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>'
        + '</svg><span>刷新对话</span>';
      b.title = '只重载 DSH 引擎 的对话面板（场景不变、会话不丢；面板空白时点它就能救回来）';
      b.addEventListener('click', function (ev) { ev.stopPropagation(); reloadHarness(); });
      var chip = document.getElementById('balance-chip');
      if (chip && chip.parentNode === right) right.insertBefore(b, chip);   // 紧挨「余额」左边
      else right.insertBefore(b, right.firstChild);
    } catch (e) { /* ignore */ }
  };
  window.__mountChatReload();

  if (window.__harnessRefreshHooked) {        // ⟳ 重注入：别挂第二份监听
    window.__harnessWv = wv;
    return;
  }
  window.__harnessRefreshHooked = true;
  window.__harnessWv = wv;

  var BLANK_PROBE = '(() => { try {'
    + ' var r = document.getElementById("root"); if (!r || r.children.length === 0) return false;'
    // 2026-11-07：原来这里还有 ultimate 兜底 'document.querySelector(\'[data-side="sidebar"]\')'，但引擎里没有 sidebar
    // 这个 data-side 值（只有 left/right，且只挂宽度手柄）⇒ 那一项**永假**。同一 || 链上的 [data-chat-flow] /
    // [data-phase] 都是真实存在的锚点，删掉死条件不改变判定结果。
    + ' if (document.querySelector("[data-chat-flow]") || document.querySelector("[data-phase]")) return true;'
    + ' return (r.innerText || "").trim().length > 20;'
    + ' } catch (e) { return false; } })()';

  function toast(msg, bad) {
    try {
      var box = document.querySelector('.tbs-toasts');
      if (!box) { box = document.createElement('div'); box.className = 'tbs-toasts'; document.body.appendChild(box); }
      var t = document.createElement('div');
      t.className = 'tbs-toast' + (bad ? ' bad' : '');
      t.textContent = msg;
      box.appendChild(t);
      setTimeout(function () { t.classList.add('out'); setTimeout(function () { t.remove(); }, 320); }, 3600);
    } catch (e) { /* ignore */ }
  }
  function isActive() { try { return view.classList.contains('active'); } catch (e) { return false; } }
  var lastAuto = 0;
  function canAuto() { var now = Date.now(); if (now - lastAuto < 60000) return false; lastAuto = now; return true; }

  function reloadHarness(why, quiet) {
    try {
      var src = wv.getAttribute('src') || '';
      if (!src) {
        // 还没拿到地址（引擎刚起）⇒ 交给 renderer.js 的 loadHarness
        if (typeof window.loadHarness === 'function') window.loadHarness();
        if (!quiet) toast('对话面板还没加载，已让它重新加载');
        return;
      }
      try { wv.reload(); } catch (e) { /* ignore */ }
      if (!quiet) toast('已刷新对话界面' + (why ? '（' + why + '）' : ''));
      setTimeout(verify, 2500);
    } catch (e) { if (!quiet) toast('刷新失败：' + ((e && e.message) || e), true); }
  }

  // 刷完自检：还是空白 ⇒ 重新取一次带 token 的地址，强刷一遍
  function verify() {
    var p;
    try { p = wv.executeJavaScript(BLANK_PROBE); } catch (e) { return; }
    if (!p || !p.then) return;
    p.then(function (ok) {
      if (ok) return;
      try {
        if (!(window.app && window.app.getHarnessUrl)) return;
        window.app.getHarnessUrl().then(function (url) {
          if (!url) return;
          try { wv.setAttribute('src', 'about:blank'); } catch (e) { /* ignore */ }
          setTimeout(function () { try { wv.setAttribute('src', url); } catch (e) { /* ignore */ } }, 80);
          toast('界面仍是空白 ⇒ 已重新取地址强刷（多半是引擎 token 换过了）', true);
        }).catch(function () { /* ignore */ });
      } catch (e) { /* ignore */ }
    }).catch(function () { /* 执行不了 = 还在加载 */ });
  }

  // 自愈 ①：guest 进程崩了
  var autoTries = 0;
  try {
    wv.addEventListener('render-process-gone', function () {
      if (autoTries >= 3) return;
      autoTries++;
      setTimeout(function () { reloadHarness('渲染进程崩了，自动恢复', true); }, 800 * autoTries);
    });
    wv.addEventListener('crashed', function () {
      if (autoTries >= 3) return;
      autoTries++;
      setTimeout(function () { reloadHarness('渲染进程崩了，自动恢复', true); }, 800 * autoTries);
    });
    // 自愈 ②：加载失败（-3 = 主动取消，不算）
    wv.addEventListener('did-fail-load', function (e) {
      if (e && e.errorCode === -3) return;
      if (autoTries >= 3) return;
      autoTries++;
      setTimeout(function () { reloadHarness('加载失败，自动恢复', true); }, 1200 * autoTries);
    });
    wv.addEventListener('did-finish-load', function () { autoTries = 0; });
  } catch (e) { /* ignore */ }

  // 自愈 ③：窗口回到前台、且当前就在 Harness 页 → 探一次空白（60s 冷却）
  window.addEventListener('focus', function () {
    if (!isActive()) return;
    if (!canAuto()) return;
    var p;
    try { p = wv.executeJavaScript(BLANK_PROBE); } catch (e) { return; }
    if (!p || !p.then) return;
    p.then(function (ok) {
      try { if (!ok && !wv.isLoading()) reloadHarness('检测到空白，自动恢复', true); } catch (e) { /* ignore */ }
    }).catch(function () { /* ignore */ });
  });
})();

// ==========================================================================================
// 2026-10-21（宿主：「把这四个用一个大胶囊扩住，他们是一类」）
//   这四个 = 插件 🧩 / 技能 ✨ / MCP 🔌 / 工具 🛠 —— 都是"扩展类"入口，
//   原来散在顶栏里跟 ⟳、序号、模型、窗口按钮混在一起。这里给它们套一个圆角大胶囊（.tb-group）。
//   ⚠ btn-mcp 是 mcp-panel.js **后来才插**的 ⇒ 用 MutationObserver + 前 12 秒补几次，
//      保证它一出现就被收进同一个胶囊；⟳ 重注入也幂等（有 #tb-group-ext 就只校正顺序）。
// ==========================================================================================
(function extGroupTopbar() {
  var IDS = ['btn-plugins', 'btn-skills', 'btn-mcp', 'btn-tools'];
  function ensure() {
    try {
      var controls = document.querySelector('#titlebar .titlebar-controls');
      var first = document.getElementById('btn-plugins');
      if (!controls || !first) return;
      var group = document.getElementById('tb-group-ext');
      if (!group) {
        group = document.createElement('div');
        group.className = 'tb-group';
        group.id = 'tb-group-ext';
        group.title = '扩展：插件 / 技能 / MCP / 工具';
        controls.insertBefore(group, first);
      }
      var want = [];
      for (var i = 0; i < IDS.length; i++) {
        var b = document.getElementById(IDS[i]);
        if (b) want.push(b);
      }
      var now = Array.prototype.slice.call(group.children);
      var same = want.length === now.length && want.every(function (b, k) { return now[k] === b; });
      if (!same) { for (var j = 0; j < want.length; j++) group.appendChild(want[j]); }
    } catch (e) { /* ignore */ }
  }
  ensure();
  var tries = 0;
  var t = setInterval(function () { ensure(); if (++tries > 20) clearInterval(t); }, 600);
  try {
    var c = document.querySelector('#titlebar .titlebar-controls');
    if (c && window.MutationObserver) {
      var mo = new MutationObserver(function () { ensure(); });
      mo.observe(c, { childList: true });
    }
  } catch (e) { /* ignore */ }
  window.addEventListener('focus', ensure);
})();

// 2026-10-22（宿主：分离窗口拖不动、要"左上角标题能拖"）——
//   .brand 从 no-drag 改成 drag（整块标题都能拖窗口），代价是 :hover 不投递事件 ⇒ 版本卡出不来。
//   补法：只有那颗小圆点还留 no-drag（能收鼠标事件），悬停它时给 .brand 挂 .is-tip，CSS 负责显示版本卡。
//   放 renderers.js ⇒ ⟳ 即生效，不用重启。
(function brandTipOnDot() {
  try {
    var brand = document.querySelector('#titlebar .brand');
    var dot = document.getElementById('brand-dot');
    if (!brand || !dot || dot.__tipBound) return;
    dot.__tipBound = true;
    dot.addEventListener('mouseenter', function () { brand.classList.add('is-tip'); });
    dot.addEventListener('mouseleave', function () { brand.classList.remove('is-tip'); });
  } catch (e) { /* ignore */ }
})();

// 2026-10-22（宿主：预览统一收到「设置 → 启动动画」插件页）——
//   外壳只负责"被叫醒"：插件写 外壳\data\boot-preview.json  {"id":"<动画id>","at":<毫秒>}
//   这里每 1.2 秒看一眼；at 比上次处理过的更大就 __bootPreview(id) 播一遍。
//   · at 记在 localStorage（app.bpw.at）⇒ 页面重载/重启不会把同一条指令再播一次
//   · 每次热注入重挂 interval（先 clear），避免旧实例被页面重载带走后变哑巴
//   · 只读文件，不写不删
(function bootPreviewWatch() {
  try {
    var F = window.app && window.app.file;
    if (!F || !F.read) return;
    if (window.__bpwTimer) { clearInterval(window.__bpwTimer); window.__bpwTimer = null; }
    var CFG = ((window.app && window.app.paths && window.app.paths.dataDir) || '.') + '\\boot-preview.json';
    var KEY = 'app.bpw.at';
    var lastAt = 0;
    try { lastAt = Number(localStorage.getItem(KEY)) || 0; } catch (e) { /* ignore */ }
    window.__bpwTimer = setInterval(function () {
      if (document.hidden) return;
      Promise.resolve(F.read(CFG)).then(function (r) {
        var txt = (typeof r === 'string') ? r : ((r && (r.text || r.content)) || '');
        if (!txt) return;
        var j = null;
        try { j = JSON.parse(txt); } catch (e) { return; }
        var at = Number(j && j.at) || 0;
        if (!at || at <= lastAt) return;
        lastAt = at;
        try { localStorage.setItem(KEY, String(at)); } catch (e) { /* ignore */ }
        var id = j && j.id ? String(j.id) : '';
        if (window.__bootPreview) window.__bootPreview(id || undefined);
      }).catch(function () { /* 读不到安静跳过 */ });
    }, 1200);
  } catch (e) { /* ignore */ }
})();

// ==========================================================================================
// 2026-10-26（宿主）：新场景「命令」——左边大窗口把记忆系统做成 3D 神经元网络（节点=场景/技能/记忆文档，
//   连线=所有权与依赖），右边窄条 = AI 会话。本渲染器只读共享记忆与技能目录，不改任何文件。
//   · 3D 用 canvas 2D 自己投影（不引三方库，CSP script-src 'self' 也引不进来）
//   · 数据源：_共享记忆\索引.json + areas\*.md + 冲突.md + _待办.md + _跨场景通知.md + 技能 SKILL.md
//   · 交互：拖拽旋转 / 滚轮缩放 / 悬停高亮邻居 / 点击看详情（可定位文件）/ 搜索过滤 / 自转开关
// ==========================================================================================
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

