// 内存 / 磁盘防护（2026-11-04 从 main.js 抽出：main.js 是存量超长文件，红线只许变短）
//
// 背景：实测「启动即预热 4 个网页版 AI」会让内存 2 分钟从 1.2GB 涨到 7.2GB 并 OOM；
//       同时 data\electron-profile 涨到 980MB、data\temp 涨到 736MB 且正常启动链里没人清。
//       诊断与数据见 诊断-内存\内存问题诊断报告.md。
//
// 本模块只做四件"低风险"的事：
//   ① Chromium 硬盘缓存封顶（原来无上限）；
//   ② 注入截图默认关（原来每次注入都 capturePage→toPNG→同步写盘）；
//   ③ 启动时清 data\temp 里 1 天前的残留；
//   ④ 按数量收敛 dsh-workspace-changes-*（引擎每个 Session 的 scratch 目录，实测 44 个占 712MB）。
//
// 用法（main.js）：
//   const memGuard = require('./scripts/mem-guard.js');
//   memGuard.installCommandLine(app);                    // app ready 之前
//   const INJECT_SHOT_ON = memGuard.injectShotOn();
//   // whenReady 里、拉起引擎之前：
//   memGuard.purgeOldTemp(log, 1);
//   memGuard.pruneWorkspaceChanges(log, 2);
'use strict';

const fs = require('fs');
const path = require('path');

const TEMP_DIR = path.join(__dirname, '..', 'data', 'temp');
const WS_CHANGES_RE = /^dsh-workspace-changes-/;

// ① 硬盘缓存上限。⚠ 这是**每个 StoragePartition 各一份**（实测 14 个持久分区），
//    所以 128MB × 14 ≈ 1.75GB 上限；比默认"无上限"（已涨到 980MB 且继续涨）好得多。
//    想进一步回收，可在空闲时对 webai-*/embed-* 分区调 session.clearCache()（保留登录态）。
function installCommandLine(app) {
  try { app.commandLine.appendSwitch('disk-cache-size', String(128 * 1024 * 1024)); } catch (e) { /* ignore */ }
}

// ② 注入截图开关：默认关。排查时 set DSH_INJECT_SHOT=1（且每个 webContents 最多 3 张）。
function injectShotOn() {
  return String(process.env.DSH_INJECT_SHOT || '') === '1';
}

function listTemp() {
  try { return fs.readdirSync(TEMP_DIR); } catch (e) { return []; }
}

// ③ 清 data\temp 里 N 天前的残留（同步、量小；当前实现为"1 天"）。
//    引擎子进程的 TEMP/TMP 指向这里（main.js 的 serverSpawnEnv），只有 工具\初始化.mjs 会整目录清。
function purgeOldTemp(log, days) {
  const keepDays = Number(days) || 1;
  const cutoff = Date.now() - keepDays * 86400000;
  let n = 0;
  for (const name of listTemp()) {
    const full = path.join(TEMP_DIR, name);
    try {
      if (fs.statSync(full).mtimeMs >= cutoff) continue;
      fs.rmSync(full, { recursive: true, force: true });
      n++;
    } catch (e) { /* 被占用就跳过，不阻塞启动 */ }
  }
  if (n && typeof log === 'function') log('[boot] 清理过期临时残留 ' + n + ' 项（data\\temp，> ' + keepDays + ' 天）');
  return n;
}

// ④ dsh-workspace-changes-*：引擎在 asar 里用 mkdtemp 给**每个 Session** 建的 scratch 目录，
//    进程退出后无人再引用。启动这一刻还没有新会话 ⇒ 除最新 keep 个（可能是上次会话的）外都是死目录。
//    实测：44 个共 712MB，其中一天内就 20 个 / 598MB ⇒ 只按时间保留会稳态 ~600MB，必须按数量收。
//    异步删除（fs.promises），不阻塞主线程；在拉起引擎之前调用，不会误删引擎新建的目录。
function pruneWorkspaceChanges(log, keep) {
  const keepN = Math.max(0, Number(keep) || 2);
  const items = [];
  for (const name of listTemp()) {
    if (!WS_CHANGES_RE.test(name)) continue;
    const full = path.join(TEMP_DIR, name);
    try { items.push({ full: full, m: fs.statSync(full).mtimeMs }); } catch (e) { /* ignore */ }
  }
  items.sort(function (a, b) { return b.m - a.m; });
  const victims = items.slice(keepN);
  if (!victims.length) return Promise.resolve(0);
  return Promise.all(victims.map(function (v) {
    return fs.promises.rm(v.full, { recursive: true, force: true }).then(function () { return 1; }, function () { return 0; });
  })).then(function (rs) {
    const n = rs.reduce(function (a, b) { return a + b; }, 0);
    if (n && typeof log === 'function') log('[boot] 清理 session 临时目录 ' + n + ' 个（保留最新 ' + keepN + ' 个）');
    return n;
  });
}

// ⑤ 注入计数 + 可选截图（原来内联在 main.js 的 harness:wv:inject 里）。
//    原来每次注入都 capturePage→toPNG→同步写盘，实测日志 75.6% 是 [wv:inject]、
//    历史累计 1,429 次截图；现在截图默认关（DSH_INJECT_SHOT=1 才开），每 webContents 最多 3 张。
const injectSeen = new Map();
function injectCount(wc) {
  const n = (injectSeen.get(wc.id) || 0) + 1;
  injectSeen.set(wc.id, n);
  if (n === 1) { try { wc.once('destroyed', function () { injectSeen.delete(wc.id); }); } catch (e) { /* ignore */ } }
  return n;
}
function maybeShot(wc, n, deps) {
  if (!injectShotOn() || n > 3) return;
  const dir = (deps && deps.dir) || path.join(__dirname, '..', 'captures');
  const log = deps && deps.log;
  try {
    wc.capturePage().then(function (img) {
      if (!img || img.isEmpty()) return;
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'panel-latest.png'), img.toPNG());
        if (typeof log === 'function') log('[wv:inject] 截图已保存 panel-latest.png');
      } catch (e) { /* ignore */ }
    }, function () { /* ignore */ });
  } catch (e) { /* ignore */ }
}

// ⑥ webview 渲染进程「跑飞」看门狗（2026-11-04 实测后新增）：
//    本机兼容模式（--no-sandbox）下，豆包/千问/智谱的渲染进程被打开后 15s 就到 1.7GB、
//    45s 2.6GB（主线程锁死、Runtime.evaluate 超时），再开几个就把整机拖到 OOM；
//    实测：光 `reload()` **降不下来**（主线程锁死，导航排队；同一进程的泄漏也不回收）⇒
//    先用 `forcefullyCrashRenderer()` 把这一支渲染进程干掉（内存立即释放），1s 后再 reload 重建。
//    重载不丢登录态（分区还在），页面回首页；冷却 2 分钟避免死循环。远好于整个应用 OOM。
function installWebviewWatchdog(deps) {
  const d = deps || {};
  if (!d.app || !d.webContents) return null;
  const LIMIT_MB = Number(d.limitMB || process.env.DSH_MEM_WATCH_MB || 800);
  if (!LIMIT_MB || LIMIT_MB < 0) return null;   // 0 / 负数 = 关闭看门狗（排障用）
  const COOLDOWN_MS = Number(d.cooldownMs) || 30000;
  const last = new Map();
  const strikes = new Map();
  const timer = setInterval(function () {
    try {
      const byPid = new Map();
      for (const m of (d.app.getAppMetrics() || [])) { if (m && m.pid) byPid.set(Number(m.pid), m); }
      const now = Date.now();
      for (const wc of d.webContents.getAllWebContents()) {
        try {
          if (!wc || wc.isDestroyed() || wc.getType() !== 'webview') continue;
          const m = byPid.get(Number(wc.getOSProcessId()));
          const mb = m && m.memory ? Math.round(Number(m.memory.workingSetSize) / 1024) : 0;   // KB → MB
          if (!mb || mb <= LIMIT_MB) continue;
          if (now - (last.get(wc.id) || 0) < COOLDOWN_MS) continue;
          last.set(wc.id, now);
          const st = (strikes.get(wc.id) || 0) + 1;
          strikes.set(wc.id, st);
          let url = ''; try { url = String(wc.getURL()).slice(0, 120); } catch (e) { /* ignore */ }
          // 第 3 次还犯 ⇒ 直接停掉这个 guest（加载 about:blank），避免"重载→再跑飞"的死循环
          if (st >= 3) {
            if (typeof d.log === 'function') d.log('[mem-guard] webview 渲染进程 ' + mb + 'MB 反复超限（第 ' + st + ' 次），已停止加载：' + url);
            try { wc.loadURL('about:blank'); } catch (e) { /* ignore */ }
            continue;
          }
          if (typeof d.log === 'function') d.log('[mem-guard] webview 渲染进程 ' + mb + 'MB 超限（>' + LIMIT_MB + 'MB，第 ' + st + ' 次），强制回收并重载：' + url);
          try { wc.forcefullyCrashRenderer(); } catch (e) {
            try { wc.reload(); } catch (e2) { /* ignore */ }
          }
          setTimeout(function () { try { if (wc && !wc.isDestroyed()) wc.reload(); } catch (e) { /* ignore */ } }, 1000);
        } catch (e) { /* 单个失败不影响其它 */ }
      }
    } catch (e) { /* ignore */ }
  }, Number(d.everyMs) || 6000);
  if (timer.unref) timer.unref();
  return timer;
}

// ⑦ webview 挂载前"卫生处理"（2026-11-04 定位到豆包死循环的**真正根因**）：
//    Electron 会把宿主窗口的 webPreferences.preload **继承给 <webview> guest**。
//    宿主 preload（外壳 preload.js）在沙箱化的 guest 里执行失败：
//      sandboxed_renderer.bundle.js script failed to run
//      TypeError: Cannot destructure property 'preloadScripts' of 'binding.startupData' as it is null
//    ⇒ 页面的 Electron 侧初始化坏掉，豆包/千问/智谱 的 JS 会空 body + 死循环吃内存
//      （实测：豆包 15s 1.4GB、75s 3.2GB；手开窗口也一样）。
//    对照实验：宿主窗口**不带 preload** 的空白 Electron 加载同一个豆包 → 稳定 260–350MB。
//    修法（Electron 官方推荐）：will-attach-webview 里把继承来的 preload 摘掉，并强制安全默认值。
//    本应用没有任何 webview 需要 preload（已全仓 grep 确认）。
function installWebviewHygiene(app, log) {
  try {
    app.on('web-contents-created', function (event, contents) {
      try {
        contents.on('will-attach-webview', function (ev, webPreferences) {
          let had = '';
          try { had = webPreferences && webPreferences.preload ? String(webPreferences.preload) : ''; } catch (e) { /* ignore */ }
          try { delete webPreferences.preload; } catch (e) { /* ignore */ }
          webPreferences.nodeIntegration = false;
          webPreferences.contextIsolation = true;
          webPreferences.sandbox = true;
          if (typeof log === 'function') log('[mem-guard] webview preload 已摘除（原：' + (had || '无') + '）');
        });
      } catch (e) { /* ignore */ }
    });
  } catch (e) { /* ignore */ }
}

// ⑧ 31238 静态服务路径防护（2026-11-04 安全项）：
//    原实现把整个应用根（12-源码照搬）当 HTTP 根 ⇒ 本机任意进程都能读
//    引擎数据\.dsh\.credentials.yaml、sessions、外壳\node_modules、工作台.json、server.log 等。
//    这里按"段/模式"黑名单拒绝；只放行官网类静态文件（本模板里实际只有 /chat 与 Blender 帧在用）。
const SITE_DENY_SEG = new Set(['node_modules', '.git', '引擎数据', '外壳', '工具', '说明', '发布', '_临时', '诊断-内存']);
function sitePathForbidden(root, p) {
  try {
    const rel = path.relative(root, p).replace(/\\/g, '/');
    if (!rel || rel === '.' || rel.startsWith('..')) return true;
    for (const s of rel.split('/')) {
      if (SITE_DENY_SEG.has(s)) return true;
      if (s.startsWith('.')) return true;                       // 隐藏文件/目录（.env、.gitignore、.credentials…）
    }
    if (/\.credentials|\.env$|(^|\/)工作台\.json$|(^|\/)server\.log(\.prev)?$/i.test(rel)) return true;
    return false;
  } catch (e) { return true; }
}

// 启动前一次性安装（main.js 只调这一个，保持 main.js 行数不增长）
function install(app, log) {
  installCommandLine(app);
  installWebviewHygiene(app, log);
}

module.exports = {
  install: install,
  installCommandLine: installCommandLine,
  installWebviewHygiene: installWebviewHygiene,
  sitePathForbidden: sitePathForbidden,
  injectShotOn: injectShotOn,
  injectCount: injectCount,
  maybeShot: maybeShot,
  installWebviewWatchdog: installWebviewWatchdog,
  purgeOldTemp: purgeOldTemp,
  pruneWorkspaceChanges: pruneWorkspaceChanges,
};
