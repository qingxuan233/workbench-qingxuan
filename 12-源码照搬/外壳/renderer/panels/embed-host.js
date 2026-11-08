// panels/embed-host.js —— 网页AI/嵌入式 webview 的主机侧支撑 + 品牌/工具栏/场景图标装饰
// （P2-D 阶段3c 从 renderers.js 941-1711 搬出；771 行，≤800）
//
// 说明：这些顶层声明原本挂在"embed 块"后面（audit 按"到下一个注册 def"切块把它算进了 embed 1,029 行），
// 实际是 **webview 主机侧 + chrome 装饰**，不是 embed 面板本体（embed 本体只有 238 行，已在 panel-embed.js）。
// 本文件保持**脚本级全局声明**（不包 IIFE、不挂 window 前缀），chrome.js / renderer.js 等仍按原名字直接调用。
// 加载顺序：adapter → lib/embed-utils.js → **panels/embed-host.js** → panels/*（含 panel-embed）→ chrome.js
//           → renderers.js → renderer.js → topbar-status.js。
// ⚠ 本文件在 renderers.js 之前执行：其中 `window.__kunWebAiOpen/Ensure/SilentMount` 等加载期赋值只依赖
//   本文件内已声明的函数（预扫风险=0），不依赖 renderers.js 的顶层符号。
var APP = window.APP_RENDERERS || (window.APP_RENDERERS = {});

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
// （P2-D 拆域阶段1：电脑清理场景 3 个面板渲染器已搬到 panels/panel-pc-drives.js，本文件不再保留副本）
// （pc-toplarge / pc-junk 与其公共 helper 也已搬到 panels/panel-pc-drives.js）


