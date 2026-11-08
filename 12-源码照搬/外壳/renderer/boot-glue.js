// renderer/boot-glue.js —— 启动引导 IIFE 区（P2-D 阶段3d 从 renderers.js 1786-2325 搬出；540 行）
//
// 内容（全部是加载期执行的 IIFE，不注册渲染器）：
//   MCP 面板动态加载、webai-bridge 加载、CSS 热重载、场景 webview 停车、harness 刷新钩子、
//   extGroupTopbar、brandTipOnDot、bootPreviewWatch。
//
// ⚠ **加载期时序（必须是本阶段最关键的约束）**：
//   · 这些 IIFE 在**加载时立刻执行**，它们会用 renderers.js / panels/* / chrome.js 定义的函数与全局
//     钩子（例如 renderers 的渲染器表、`window.__kunViews` 等），所以 index.html 把它排在
//     **renderers.js 之后、renderer.js 之前**（`… → chrome.js → renderers.js → boot-glue.js →
//     renderer.js → topbar-status.js`）。
//   · 若把它排到 renderers.js 之前（例如按"panels 之前加载"的直觉），加载期就会引用未定义符号；
//     本阶段已用探针回归（真实 index.html，无 Uncaught）验证当前顺序正确。
//   · 放在 renderers.js **之后**也意味着它**不参与 ⟳ 热更新**（⟳ 只重跑 renderers.js）；原来这些 IIFE
//     随 renderers.js 一起重跑，现在改为"页面级一次"——各 IIFE 本来就靠 window 旗标/幂等设计防重复，
//     探针实测安装钩子仍生效（见证据 §加载期依赖结论）。

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
