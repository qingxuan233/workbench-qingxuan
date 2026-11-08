// panels/panel-review-files.js —— 自我复盘场景「右上角 文档树」面板（P2-D 阶段2a 搬出）
// ⚠ 命名说明：任务原定路径是 `panels/panel-review.js`，但该路径**已存在**（P1 前的并行实现，
//   125 行、只用 REGISTRY.register、loadOnDemand 全仓无调用者）。为不在同一文件里混两套实现，
//   本阶段把搬入内容放 `panel-review-files.js`；`panel-review.js` 原样未动（其 review-doc 部分留待阶段2b 裁决）。
// 来源：renderer/renderers.js 原 4857-5015（逐字搬入；只把外层 `renderers['review-files']` 改为 `APP['review-files']`）。
// 加载：index.html 在 renderers.js 之前加载本文件；依赖 `el`/`sr*` helper（srAbs/srParent/srSize/srCopy/
//      srOpenPath/srFull/srTipIn/srKindOf/srRowIcon 等）仍在 renderers.js —— 调用期才用到，加载顺序不影响。
var APP = window.APP_RENDERERS || (window.APP_RENDERERS = {});

// ---------- 右上角：文档树（目录＝单击进入，文件＝单击交给左窗预览，双击＝系统程序打开）----------
APP['review-files'] = function (body, meta, head) {
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
