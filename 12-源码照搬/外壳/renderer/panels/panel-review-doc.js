// panels/panel-review-doc.js —— 「自我复盘 · 预览」面板（P2-D 阶段3c 从 renderers.js 2795-3080 搬出）
// 来源：renderers.js 原 2795-3080（286 行）。外层赋值改 `APP['review-doc'] = ...`；函数体/注释/缩进逐字保留。
// 依赖：`el` / `sr*` helper / `renderers.view`（通用预览，复用 `window.__kunViews`）等——
//       `renderers.view` 是**调用期**访问（review-doc 面板 mount 时才走 showMedia），此时 panel-view 已注册。
// 加载顺序：… → panels/view-media.js → panels/panel-view.js → panels/panel-review-doc.js → chrome.js → …
var APP = window.APP_RENDERERS || (window.APP_RENDERERS = {});

APP['review-doc'] = function (body, meta, head) {
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



// ---------- 左上角：文档预览（渲染 md；单击右上文档即在此打开；文档内相对链接原地跟读）----------
