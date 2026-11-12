// panels/panel-view.js —— 「预览」面板（P2-D 阶段3b 从 renderers.js 683-1581 搬出）
// 来源：renderers.js 原 683-1581（view 渲染器本体 899 行）。本阶段把 openOpaque / openDir / ensureDirCss
// 顶层化到 panels/view-media.js（B-lite：ctx 只传 K 之外的 bodyBox/A/回调/setInner/isDisposed），
// 其余函数体/注释/缩进**逐字保留**。
// 加载：index.html 顺序 … → lib/embed-utils.js → panels/* → panels/view-media.js → panels/panel-view.js
//       → chrome.js → renderers.js → renderer.js → topbar-status.js（view-media 必须先加载）。
// 依赖：el / flowPathParts 等全局 helper 仍在 renderers.js（调用期才用）。
// ⚠ 本阶段放弃逐字节等价（见证据的行为判据：文本/图片/目录/预设/二进制五路径 smoke）。
var APP = window.APP_RENDERERS || (window.APP_RENDERERS = {});

APP['view'] = (body, meta, head) => {
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
      else if (q.path) open({ path: q.path, title: q.label || q.kind || '', kind: q.kind });
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

  // P2-D 阶段3b（B-lite）：目录/二进制打开逻辑已顶层化到 panels/view-media.js。
  // 这里用**显式 ctx 注入**（只传 bodyBox/A/回调/setInner/isDisposed，不传整个 view 闭包）；
  // 下面的局部名保持原样 ⇒ 闭包内原有 openDir/openOpaque 调用点一字不用改。
  const VM = makeViewMedia({
    bodyBox: bodyBox, A: A,
    say: say, paint: paint, card: card, remember: remember, fileUrl: fileUrl, open: open,
    setInner: function (v) { inner = v; }, isDisposed: function () { return disposed; }
  });
  const openOpaque = VM.openOpaque, openDir = VM.openDir;

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
