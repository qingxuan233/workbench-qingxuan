// panels/panel-harness.js —— harness 面板渲染器（P2 收尾 3e-1 从 renderers.js 704-1509 搬出；行为判据）
// 依赖：HARNESS_DROP_JS 在 panels/harness-utils.js（先加载）；el/panelPartition/HARNESS_* 全局 helper（调用期）。
// 加载顺序：… → panels/harness-utils.js → panels/panel-harness.js → … → chrome.js → renderers.js
var APP = window.APP_RENDERERS || (window.APP_RENDERERS = {});

APP['harness'] = (body, meta, head) => {
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
      if (info && info.found) {
        simplify = '精简 ✓';
        // 路线A（2026-11-08）：注入后**读回布局**，不达标要响：console.warn + 一次性写 外壳/data/inject-warnings.log
        const sb = info.sidebar || null;
        const drawerVis = (info.drawer || []).filter((d) => d && d.vis && d.disp !== 'none' && Number(d.op || 1) > 0).length;
        const badSide = !!sb && (sb.w > 2 || sb.vis === true) && !(Number(sb.x) < 0);
        const badDrawer = drawerVis > 0;
        const badChat = Number(info.chatW || 0) < Math.max(0, Number(info.chatAvailW || info.winW || 0) - 32);
        if (badSide || badDrawer || badChat) {
          const key = 'sidebar=' + (sb ? (sb.w + 'px/' + (sb.vis ? 'visible' : 'hidden') + ' x=' + sb.x) : 'none')
            + ' · drawerVis=' + drawerVis + '/' + (info.drawer || []).length
            + ' · chat=' + (info.chatW || 0) + '/' + (info.winW || 0) + 'px';
          try { console.warn('[wv:inject] ✗ 精简失败 ' + key); } catch (e) { /* ignore */ }
          if (!window.__kunInjectWarned) {
            window.__kunInjectWarned = 1;   // 只写一次，不刷屏
            try {
              const PP = (window.app && window.app.paths) || {};
              const dir = String(PP.dataDir || '').replace(/\\/g, '/');
              if (dir && window.app && window.app.file && window.app.file.write) {
                window.app.file.write(dir + '/inject-warnings.log',
                  new Date().toISOString() + ' [wv:inject] ✗ 精简失败 ' + key + '\n');
              }
            } catch (e) { /* ignore */ }
          }
        }
      } else if (info) simplify = '等界面…';
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
