// panels/panel-pc-drives.js —— 电脑清理场景 3 个面板渲染器（P2-D 拆域阶段1 首批搬出）
// 来源：renderer/renderers.js 原 3116-3383 行（逐字搬入；只把外层 `renderers[...]` 改为 `APP[...]`）。
// 加载：index.html 在 renderers.js **之前**加载本文件 ⇒ 先建共享注册对象 window.APP_RENDERERS；
//      renderers.js 用 `var renderers = window.APP_RENDERERS || (window.APP_RENDERERS = {});` 复用同一对象。
// 依赖：`el` 等公共小工具仍定义在 renderers.js（本文件在**调用时**才用到它们；panels 先加载不影响）。
var APP = window.APP_RENDERERS || (window.APP_RENDERERS = {});

// ============ 电脑清理场景：磁盘分区面板（C / D / E / F 四个分区的大小）============
// 数据：宿主 IPC app.sys.disks()（main.js 用 fs.statfsSync 只读算总量/剩余）。
// ⚠ 缺这个命名空间 = 主进程还是旧的（本次动的就是 main.js/preload.js）⇒ 要**重启一次 GUI** 才有实时读数；
//   没重启前面板显示提示而不是空白（面板代码本身是 ⟳ 热更新的）。
// 危险度配色：<70% 绿 · 70~89% 黄 · ≥90% 红 —— 一眼看出哪个盘该清。
// 2026-10-10 美化 + 占满：顶部总览条（总量/已用/剩余/最紧张）+ 四张"占比环"卡 + 底部图例，
//   网格改成 `auto 1fr 1fr auto` 撑满整格 —— 老版是 `align-content:start`，内容堆在顶上、下半格全空。
APP['pc-drives'] = (body) => {
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
APP['pc-toplarge'] = (body) => {
  // ⚠ 显式 cleanup：check-gui 第 4 项按"本渲染器 → 下一个 renderers[...]"切片认这个形状
  const stop = pcPanel(body, 'pc-toplarge-body', 15000, pcRenderTopLarge, (wrap, tick) => pcOnSelect(tick));
  return () => stop();
};

// ② 可清理体检：常扫的缓存/临时位置逐项体积，一眼看出哪里又长回来了。
// ⚠ 2026-10-10 用户定：**清理直接删除，不要"清理暂存"这一步**（原来那块面板已废）。
APP['pc-junk'] = (body) => {
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
