// panels/view-media.js —— view 面板的「目录 / 二进制」打开 helper（P2-D 阶段3b · B-lite 顶层化）
//
// 为什么不与 panel-view.js 同文件：view 渲染器本体 899 行 > 800（代码红线新文件上限）。
// 本阶段只把**耦合最轻**的一组（openOpaque + openDir + 它们依赖的 ensureDirCss）顶层化，
// panel-view 剩余行数一降到 ≤800 就停手（不追求"拆干净"）。
//
// ctx 签名（只传这几个，不传整个 view 闭包）：
//   ctx = {
//     bodyBox,                  // view 主体容器（DOM）
//     A,                        // 宿主通用能力（app.app；openPath / revealPath）
//     say(text, cls, ms), paint(), card(icon,title,sub,pathText), remember(p), fileUrl(p), open(opt),
//     setInner(v),              // 写回 view 闭包的 inner（当前主体元素）
//     isDisposed()              // 读 view 闭包的 disposed（异步返回时据此丢弃）
//   }
// 返回值：{ openOpaque(p, why), openDir(p) }；panel-view 里解构后，闭包内原同名调用点**不用改**。
// 依赖：el / flowPathParts 仍是 renderers.js 的全局函数（调用期才用）；ensureDirCss 在本文件内定义（全局）。
// ⚠ 本阶段**放弃逐字节等价**（嵌套 helper 顶层化必然改签名/少量闭包引用），等价判据改用行为 smoke（见证据）。

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

// 工厂由 panel-view.js 在 view mount 时调用一次；下面两个 helper 体是从 renderers.js **逐字搬入**的
// （只改 3 处闭包引用：inner 写回 → ctx.setInner、disposed 读取 → ctx.isDisposed()）。
function makeViewMedia(ctx) {
  const bodyBox = ctx.bodyBox;
  const A = ctx.A;
  const say = ctx.say, paint = ctx.paint, card = ctx.card, remember = ctx.remember, fileUrl = ctx.fileUrl, open = ctx.open;

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

  async function openDir(p) {
    // ⚠ 先把整个 body 清干净：`clearBody()` 只删 `inner` 那**一个**节点，而这个视图有"工具条 + 网格"两块 ⇒
    //   只清 inner 会留下旧工具条（实测：双击两次 ⇒ 两根工具条叠着、卡片还被后来的空状态顶掉 ✗）。
    while (bodyBox.firstChild) bodyBox.removeChild(bodyBox.firstChild);
    ctx.setInner(null);
    ensureDirCss();
    const K = (window.app && window.app.oa) || null;
    // 工具条 + 网格**包在一个 wrap 里**，wrap 就是 inner ⇒ 以后任何 clearBody() 都能一次清掉整块
    const wrap = el('div', 'view-dirwrap');
    wrap.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;';
    bodyBox.appendChild(wrap); ctx.setInner(wrap);
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
    if (ctx.isDisposed()) return;
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

  return { openOpaque: openOpaque, openDir: openDir };
}
