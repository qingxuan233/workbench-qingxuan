// DSH 引擎 desktop window (Electron wrapper) — 多场景版
// 场景 0：内嵌 DSH 引擎 Web UI（带 token，默认初始界面）
// 场景 1：<客户> OA 系统运维（本地渲染）
// 场景 2：大A / 美股分析（本地渲染）
// 设计：壳与 Harness 解耦——只通过 HTTP+token 认识它；场景配置在 scenarios/ 下。
const { app, BrowserWindow, dialog, shell, ipcMain, webContents, nativeImage, screen } = require('electron');
const { spawn, spawnSync } = require('child_process');
const http = require('http'); const net = require('net');
const path = require('path'); const { applySceneInstance } = require('../工具/_场景绑定.js');
const sceneStore = require('./main/scenes');
const inventory = require('./main/inventory');
const ipcGuard = require('./main/ipc-guard');
const coreWindow = require('./main/core-window');
const engineGuard = require('./main/engine-guard');
const systemIo = require('./main/system-io');
const legacyServices = require('./main/legacy-services');
// 引擎内部契约单一实现（P2 收口）：选择器/宽度/CSS 都从这里取，别再写字面量
const ENGINE_ADAPTER = require('./engine-adapter/contract.js');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DSH_PORT = String(process.env.DSH_PORT || '3083');
const EFFECTIVE_DSH_PORT = String(process.env.DSH_PORT || (function () {
  try { const m = readManifest(); return m && m.dshPort ? String(m.dshPort) : ''; } catch (e) { return ''; }
})() || DSH_PORT);
const BASE = 'http://127.0.0.1:' + EFFECTIVE_DSH_PORT;
// 客户包：把外壳目录暴露给 preload / renderer（读 data\boot-animation.json 用）
process.env.DSH_SHELL_DIR = __dirname;

// ⭐ 应用身份（AppUserModelID）：必须在 **app ready 之前**调用才对 Windows 任务栏生效。
//   2026-10-13 查明：原来这行写在 app.whenReady() 回调里（文件靠后位置）⇒ Windows 认不出身份，
//   任务栏右键菜单里显示成「Electron」、图标退回 Electron 原子图标 ✗。提到顶部即可。
//   配套：开始菜单/桌面那两条「工作台」快捷方式必须带同一个 AUMID（脚本 %TEMP%\set-lnk-aumid2.ps1 写过）。
app.setAppUserModelId('deepseek.harness.gui.v2');   // 2026-10-13 换新身份：旧的 deepseek.harness.gui 已被 Windows 按身份缓存成原子图标，绕开它

const memGuard = require('./scripts/mem-guard.js'); memGuard.install(app, log);   // 2026-11-04 内存防护 + webview 卫生（见 mem-guard.js）
// 引擎目录：先看「与本工作台同级」的 引擎\，没有就空串。
// ⚠ 2026-11-01：以前推不出来会**退回一个写死的同名路径**，于是 HARNESS_DIR 永远非空，
//   「同级目录在不在」这个判断就永远为真，后面每一项「引擎在哪里」的单点都拿它当根拼出来，
//   拼出的路径必然不存在（真实踩到：内置入口 `引擎\apps\cli\lib\bin.js` 一直在启动计划里空跑）。
//   现在推不出来就是 ''：谁要用，先自己判断，别拿空串去 path.join。
const HARNESS_DIR = (function () {
  const sibling = path.join(path.dirname(__dirname), '引擎');
  try { if (fs.existsSync(path.join(sibling, 'apps', 'cli'))) return sibling; } catch (e) { /* ignore */ }
  return '';
})();
const NPM_BIN = path.join(os.homedir(), 'AppData', 'Roaming', 'npm');
const PNPM_CMD = path.join(NPM_BIN, 'pnpm.cmd');
const LOG_FILE = path.join(__dirname, 'server.log'); const LOG_PREV = path.join(__dirname, 'server.log.prev');
const LOG_MAX_BYTES = 4 * 1024 * 1024;   // 超过 4MB 就轮转，只留上一份（见 rotateLog）

// ---- 日志轮转：日志只增不减会把根目录搞得乱七八糟（曾经涨到 3MB+ 且没有上限）----
// 启动时检查一次：超过上限就把旧日志改名为 server.log.prev（覆盖更早的那份），新日志从空开始。
// 只保留 1 份历史，避免"日志文件越堆越多"这种典型的目录污染。
function rotateLog() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size <= LOG_MAX_BYTES) return;
    try { fs.rmSync(LOG_PREV, { force: true }); } catch (e) { /* ignore */ }
    fs.renameSync(LOG_FILE, LOG_PREV);
  } catch (e) { /* 文件不存在或正被占用：忽略，不影响启动 */ }
}
rotateLog();
const SCENARIOS_DIR = path.join(__dirname, 'scenarios');

const WORKBENCH_ROOT = path.dirname(__dirname);

// ---- 实例清单（工作台.json）：本机真值的唯一落点 ----
//   模板要能公开（里面只能是占位/可推导），实例要能跑（本机真值）。
//   真值只存 工作台.json（不入库，见 .gitignore）；模板见 工作台.example.json。
//   读不到就当没有（老机器 / 纯模板），一切回落到下面的推导逻辑。
//   ＊2026-11-04：场景读取 / 实例叠加 / 标签顺序已抽到 main/scenes.js。
sceneStore.init({
  root: WORKBENCH_ROOT,
  scenariosDir: SCENARIOS_DIR,
  orderFile: path.join(__dirname, 'data', 'scene-tab-order.json'),
  log: function (m) { log(m); },
});
function readManifest() { return sceneStore.readManifest(); }
// ---- 个人站场景：官网静态服务（WORKBENCH_ROOT → http://127.0.0.1:SITE_PORT）----
const SITE_DIR = WORKBENCH_ROOT;
// 2026-10-22：第二个预览源——DSH 社区站（本地目录，静态服务用 /__community/ 前缀直出，
// 不跟官网同根，免得社区站的源码被当成官网页面发布出去）
const COMMUNITY_DIR = WORKBENCH_ROOT;
// 2026-10-22：个人站场景「本地文件」面板的浏览根 = 项目工程总目录（原来写死成官网目录）
const SITE_BROWSE_DIR = WORKBENCH_ROOT;
const SITE_PORT = 31238;
let siteServer = null;

// ---- 数据盘隔离：所有 Electron 运行时数据（userData/session、webview partition、localStorage 等）
// 强制写到 D 盘项目目录，绝不落到 C 盘。必须在任何 app API 之前设置。----
const PROFILE_DIR = path.join(__dirname, 'data', 'electron-profile');
try { fs.mkdirSync(PROFILE_DIR, { recursive: true }); } catch (e) { /* ignore */ }
try { app.setPath('userData', PROFILE_DIR); } catch (e) { /* ignore */ }
try { app.setPath('sessionData', path.join(PROFILE_DIR, 'sessions')); } catch (e) { /* ignore */ }

// 启动计时基准：日志里会打印「窗口可见耗时」与「引擎就绪总耗时」，便于日后评估启动速度
const APP_T0 = Date.now();

let mainWindow = null;
let serverProc = null;
let logTail = '';
let harnessToken = null;

function log(line) {
  try { fs.appendFileSync(LOG_FILE, line + '\r\n'); } catch (e) { /* ignore */ }
  logTail = (logTail + line + '\n').slice(-1200);
}

// ==================== 多窗口（场景分离） ====================
// 主窗口照旧（场景 = 标签页）；任意场景可「弹出」成独立窗口，一屏看一个场景。
// 三条纪律（踩了就出鬼）：
//   ① 窗口控制类 IPC 一律按 e.sender 找窗口 —— 否则分离窗口上的最小化/关闭会去动主窗口；
//   ② 广播类事件（余额 / 启动进度 / 引擎就绪）发给全部窗口 —— 从前只发 mainWindow；
//   ③ Blender「内置」画面只能挂在一个窗口上（它是贴在窗口上的独立顶层窗口）→ 用 blenderEmbedOwner 记账。
const detachWindows = [];                        // 主窗口之外的场景窗口
const WIN_LAYOUT_FILE = path.join(__dirname, 'data', 'windows.json');
// 场景标签顺序（拖拽换位的结果）：**主进程是唯一权威**。
// 为什么不让渲染层自己 localStorage：① 顺序要跨窗口一致（主窗口 / 独立场景窗口 / 将来任何消费方）；
// ② file:// 下的 localStorage 可能被清掉或与分区绑定。渲染层只负责"拖完把新顺序报上来"，读一律读这里。
const SCENE_ORDER_FILE = path.join(__dirname, 'data', 'scene-tab-order.json');
const layoutCache = { main: null, detached: {} }; // sceneId -> 几何（关窗后仍记得，供下次启动恢复）
let quitRequested = false;                       // 主窗口关闭 = 整个应用退出（分离窗口一起关，但布局要留下）

function allWindows() {
  const out = [];
  if (mainWindow && !mainWindow.isDestroyed()) out.push(mainWindow);
  for (const w of detachWindows) { if (w && !w.isDestroyed()) out.push(w); }
  return out;
}
function broadcast(channel, payload) {
  for (const w of allWindows()) {
    try { w.webContents.send(channel, payload); } catch (e) { /* ignore */ }
  }
}
function windowOfEvent(e) {
  try {
    const w = BrowserWindow.fromWebContents(e && e.sender);
    return (w && !w.isDestroyed()) ? w : null;
  } catch (err) { return null; }
}
function sceneNameOf(id) {
  try {
    const hit = listScenarios().filter(function (s) { return s.id === id; })[0];
    return (hit && hit.name) || String(id || '场景');
  } catch (e) { return String(id || '场景'); }
}
function detachedSceneIds() {
  const out = [];
  for (const w of detachWindows) { if (w && !w.isDestroyed() && w.kunScene) out.push(w.kunScene); }
  return out;
}
function findSceneWindow(sceneId) {
  for (const w of detachWindows) {
    if (w && !w.isDestroyed() && w.kunScene === sceneId) return w;
  }
  return null;
}
function notifyWindowsChanged() {
  broadcast('windows:changed', { detached: detachedSceneIds() });
}

// 记录窗口几何（含所在屏幕）；关窗后仍留着，供下次启动恢复
function rectOfWindow(win) {
  try {
    const max = win.isMaximized();
    const b = (max && typeof win.getNormalBounds === 'function') ? win.getNormalBounds() : win.getBounds();
    let displayId = '';
    try { const d = screen.getDisplayMatching(b); if (d) displayId = String(d.id); } catch (e) { /* ignore */ }
    return { x: b.x, y: b.y, w: b.width, h: b.height, maximized: max, display: displayId };
  } catch (e) { return null; }
}
function noteWindowRect(win) {
  if (!win || win.isDestroyed()) return;
  const r = rectOfWindow(win);
  if (!r) return;
  if (win === mainWindow) layoutCache.main = r;
  else if (win.kunScene) layoutCache.detached[win.kunScene] = r;
}
let layoutSaveTimer = null;
function saveWinLayoutSoon() {
  if (layoutSaveTimer) clearTimeout(layoutSaveTimer);
  layoutSaveTimer = setTimeout(function () { saveWinLayout(); }, 600);
}
function saveWinLayout() {
  if (layoutSaveTimer) { clearTimeout(layoutSaveTimer); layoutSaveTimer = null; }
  for (const w of allWindows()) noteWindowRect(w);
  try {
    fs.mkdirSync(path.dirname(WIN_LAYOUT_FILE), { recursive: true });
    fs.writeFileSync(WIN_LAYOUT_FILE, JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      main: layoutCache.main || null,
      detached: Object.keys(layoutCache.detached).map(function (sid) {
        return Object.assign({ scene: sid }, layoutCache.detached[sid]);
      })
    }, null, 2));
  } catch (e) { log('[win] 保存窗口布局失败: ' + ((e && e.message) || e)); }
}
function loadWinLayout() {
  try {
    const raw = JSON.parse(fs.readFileSync(WIN_LAYOUT_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return;
    layoutCache.main = raw.main || null;
    const map = {};
    (Array.isArray(raw.detached) ? raw.detached : []).forEach(function (d) {
      if (d && d.scene) map[String(d.scene)] = d;
    });
    layoutCache.detached = map;
  } catch (e) { /* 首次运行没有该文件，正常 */ }
}
// 恢复前校验：副屏被拔 / 坐标跑到屏幕外 → 夹回工作区，避免"窗口开了但看不见"
function fitSavedBounds(saved, defW, defH) {
  const out = { bounds: null, maximized: false };
  if (!saved || typeof saved.x !== 'number' || typeof saved.y !== 'number') return out;
  const w = Math.max(680, Math.round(saved.w || defW));
  const h = Math.max(460, Math.round(saved.h || defH));
  out.maximized = !!saved.maximized;
  let area = null;
  try {
    const displays = screen.getAllDisplays();
    const same = displays.filter(function (d) { return String(d.id) === String(saved.display); })[0];
    const inter = displays.filter(function (d) {
      const a = d.workArea;
      return saved.x < a.x + a.width && saved.x + w > a.x && saved.y < a.y + a.height && saved.y + h > a.y;
    })[0];
    if (same && inter && same.id === inter.id) area = same.workArea;
    else if (inter) area = inter.workArea;
    if (!area) {
      const wa = screen.getPrimaryDisplay().workArea;
      out.bounds = {
        x: Math.round(wa.x + Math.max(0, (wa.width - Math.min(w, wa.width)) / 2)),
        y: Math.round(wa.y + Math.max(0, (wa.height - Math.min(h, wa.height)) / 2)),
        width: Math.min(w, wa.width),
        height: Math.min(h, wa.height)
      };
      out.clamped = true;
      return out;   // 副屏不在了 → 主屏居中
    }
  } catch (e) { return out; }
  out.bounds = {
    x: Math.round(Math.min(Math.max(saved.x, area.x), Math.max(area.x, area.x + area.width - w))),
    y: Math.round(Math.min(Math.max(saved.y, area.y), Math.max(area.y, area.y + area.height - h))),
    width: w,
    height: h
  };
  return out;
}

// ---- 全局兜底：任何未捕获异常都写日志 + 弹一次可见提示，绝不"静默打不开" ----
// 目的：以前一旦启动流程里抛错，表现就是"点了没反应/窗口不出来"，很难查。
// 现在任何致命错误都会：① 写进 server.log ② 弹一次错误框（含日志路径与回滚提示）。
let fatalShown = false;
function reportFatal(where, err) {
  const detail = (err && (err.stack || err.message)) || String(err);
  try { log('[FATAL] ' + where + ': ' + detail); } catch (e) { /* ignore */ }
  if (fatalShown) return;
  fatalShown = true;
  try {
    dialog.showErrorBox(
      'DSH 引擎 出错（已记录日志）',
      where + '\n\n' + String(detail).slice(0, 1200) +
      '\n\n日志：' + LOG_FILE +
      '\n回滚：把 data\\backups\\gui-<最新> 里的文件覆盖回来即可。'
    );
  } catch (e) { /* 弹框本身失败就只留日志 */ }
}
process.on('uncaughtException', function (err) { reportFatal('主进程未捕获异常', err); });
process.on('unhandledRejection', function (reason) { reportFatal('主进程未处理的 Promise 拒绝', reason); });

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function probe() {
  return new Promise(function (resolve) {
    const req = http.get(BASE + '/', { timeout: 1500 }, function (res) {
      res.resume();
      resolve(true);
    });
    req.on('error', function () { resolve(false); });
    req.on('timeout', function () { req.destroy(); resolve(false); });
  });
}

// 从 dsh web 输出中解析 token 与完整 URL
function captureToken(text) {
  const m = String(text).match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_\-]+)/);
  if (m && m[2]) {
    harnessToken = m[2];
    log('[token] captured: ' + m[2]);
    publishEngineEndpoint();
  }
}

// ---- 私有 token 通道（2026-11-08 ADR-11）----
// 背景：以前 5 个脚本各自用正则扫 server.log 抢 token —— 日志轮转/多实例/端口覆写都会静默断链。
// 现在由壳把「当前引擎地址 + 当前 token」写成一个只给本机进程读的文件，脚本优先读它；
// 扫日志只作为降级兜底（工具/_派单核心.mjs 里保留了该兜底分支）。
// ⚠ 该文件在 外壳/data/ 下，属「机写区」，已被根 .gitignore 挡（`12-源码照搬/外壳/data/*`）。
const ENDPOINT_FILE = path.join(__dirname, 'data', 'harness-endpoint.json');
function publishEngineEndpoint() {
  try {
    if (!harnessToken) return;
    const payload = {
      baseUrl: BASE,
      port: EFFECTIVE_DSH_PORT,
      token: harnessToken,
      ts: new Date().toISOString(),
      pid: process.pid,
    };
    fs.mkdirSync(path.dirname(ENDPOINT_FILE), { recursive: true });
    fs.writeFileSync(ENDPOINT_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 });
    try { fs.chmodSync(ENDPOINT_FILE, 0o600); } catch (e) { }
  } catch (e) { log('[endpoint] 写 harness-endpoint.json 失败（已忽略）：' + ((e && e.message) || e)); }
}
// 退出清理（2026-11-08 P1）：只删"本进程写的"那一份（pid 校验），避免误删另一个实例的 endpoint。
// 为什么必须清：旧 token 残留会让脚本以为引擎还在（读时校验虽能兜底，但文件本身不该留着误导人）。
function clearEngineEndpoint() {
  try {
    if (!fs.existsSync(ENDPOINT_FILE)) return;
    const j = JSON.parse(fs.readFileSync(ENDPOINT_FILE, 'utf8').replace(/^\uFEFF/, ''));
    if (Number(j && j.pid) === process.pid) {
      fs.unlinkSync(ENDPOINT_FILE);
      log('[endpoint] 退出清理：已删除本进程写的 harness-endpoint.json');
    }
  } catch (e) { /* 清理失败不影响退出 */ }
}
// 启动清理（2026-11-08 追加）：上一次如果是**崩溃/被强杀**退出，endpoint 会留下死 pid 残留。
// 用户实跑证据：selfcheck 报 "harness-endpoint.json 是死 pid 残留（pid=26512 不存活）" ⇒ 每次启动先扫一遍，
// 只删 pid 已死的，活着的（并存的另一个实例）不动。
function clearStaleEndpointOnBoot() {
  try {
    if (!fs.existsSync(ENDPOINT_FILE)) return;
    const j = JSON.parse(fs.readFileSync(ENDPOINT_FILE, 'utf8').replace(/^\uFEFF/, ''));
    const pid = Number(j && j.pid);
    if (!pid) return;
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (e) { alive = false; }
    if (!alive) {
      fs.unlinkSync(ENDPOINT_FILE);
      log('[endpoint] 启动清理：删掉死 pid 残留（pid=' + pid + '）');
    }
  } catch (e) { log('[endpoint] 启动清理失败（已忽略）：' + ((e && e.message) || e)); }
}
try { clearStaleEndpointOnBoot(); } catch (e) { /* ignore */ }

// ---- 启动进度（渲染层加载页用）----
let lastBoot = { stage: 'init', pct: 0, text: '准备中…', detail: '', ts: Date.now() };
function sendBoot(patch) {
  lastBoot = Object.assign({}, lastBoot, patch, { ts: Date.now() });
  try { broadcast('boot:progress', lastBoot); } catch (e) { /* ignore */ }
  return lastBoot;
}

// 已构建的 CLI 入口：直接 node 跑它，可跳过 cmd.exe → pnpm → tsx 三层转译，明显加快引擎启动
// ⚠ 2026-11-01：公开版把自带引擎删了，HARNESS_DIR 是 ''。这里以前无条件拼出 `引擎\apps\cli\lib\bin.js`，
//   一个**永远不存在**的路径，却被当成「首选启动方式」写进启动计划（白等一轮超时）。
//   现在：没有引擎目录就没有这个入口（null），由 spawnServerDirect 自己跳过。
const CLI_BUILT = HARNESS_DIR ? path.join(HARNESS_DIR, 'apps', 'cli', 'lib', 'bin.js') : null;

// DSH_HOME：数据根。环境变量优先，其次工作台自己的 引擎数据\.dsh。
// 环境变量指向一个**不存在**的目录时，dsh 会在那里重建一份空数据（会话/记忆全"消失"），
//   所以先确认它存在；不存在就退回工作台自己的数据根，并在日志里说清楚这次改用了谁。
function dshHomeDir() {
  const own = path.join(path.dirname(__dirname), '引擎数据', '.dsh');
  const want = process.env.DSH_CUSTOMER_HOME;
  if (!want) return own;
  try { if (fs.statSync(want).isDirectory()) return want; } catch (e) { /* 不存在 */ }
  log('[boot] DSH_CUSTOMER_HOME 指向的目录不存在，改用工作台自己的数据根：' + own);
  return own;
}

function serverSpawnEnv() {
  const env = Object.assign({}, process.env);
  env.Path = NPM_BIN + ';' + (env.Path || '');
  env.DSH_HOME = dshHomeDir();
  env.DSH_CUSTOMER_HOME = env.DSH_HOME;
  env.DSH_PORT = EFFECTIVE_DSH_PORT;
  if (!env.DSH_PERMISSION_MODE) env.DSH_PERMISSION_MODE = 'danger-full-access';
  env.PYTHONIOENCODING = 'utf-8';
  const tmpDir = path.join(__dirname, 'data', 'temp');
  try { fs.mkdirSync(tmpDir, { recursive: true }) } catch (e) { log('[boot] 建临时目录失败: ' + (e && e.message)) }
  env.TEMP = tmpDir;
  env.TMP = tmpDir;
  return env;
}

// 临时目录清理搬到 scripts\mem-guard.js（main.js 是存量超长文件，红线只许变短）

// 统一挂上 stdout/stderr/exit 处理（解析 token + 写日志）
function wireServerProc(proc) {
  // 没有这一行，spawn 失败（cwd 不存在 / exe 找不到）会走 uncaughtException ⇒ 弹致命框
  proc.on('error', function (e) {
    log('[boot] 子进程启动失败: ' + ((e && e.code) || '') + ' ' + ((e && e.message) || e));
  });
  proc.stdout.on('data', function (d) {
    const s = String(d);
    captureToken(s);
    log('[out] ' + s.trim());
  });
  proc.stderr.on('data', function (d) {
    const s = String(d);
    captureToken(s);
    log('[err] ' + s.trim());
  });
  proc.on('exit', function (code) { log('[server exited] code=' + code); });
  return proc;
}

// 解析可用的 node 可执行文件（优先系统 node，其次 Electron 以纯 Node 模式运行自身）
// harness 要求 node ^22.19 || >=24
let cachedNodeExe = null;
function resolveNodeExe() {
  if (cachedNodeExe !== null) return cachedNodeExe;
  cachedNodeExe = '';
  if (process.env.DSH_NODE) {
    try { if (fs.statSync(process.env.DSH_NODE).isFile()) { cachedNodeExe = process.env.DSH_NODE; return cachedNodeExe; } } catch (e) { /* ignore */ }
  }
  const dirs = String(process.env.Path || process.env.PATH || '').split(path.delimiter).filter(Boolean);
  // 末位兜底：系统常见安装位置（PATH 里没有 node 时仍可直连）
  //   2026-11-01：原来写死某个人的盘符（'<盘根>:\software\node.js'），换机必失效 ⇒ 改成系统位置。
  for (const d of [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs'),
    path.join(process.env.SystemDrive || 'C:', 'Program Files', 'nodejs')
  ]) {
    if (d) dirs.push(d);
  }
  for (const d of dirs) {
    const p = path.join(d, 'node.exe');
    try { if (fs.statSync(p).isFile()) { cachedNodeExe = p; return cachedNodeExe; } } catch (e) { /* next */ }
  }
  log('[boot] 未找到系统 node，将用 Electron 的 Node 模式直跑');
  return cachedNodeExe;
}

// 方式〇（推荐）：本机安装的 DSH 官方 CLI（dsh.cmd）
// ⚠ 不再把本机绝对路径写进代码（模板要能公开）。
//   来源优先级：工作台.json 的 engine.cliPath → 环境变量 DSH_CMD → where dsh → LOCALAPPDATA / ProgramFiles 等常见目录。
function findDshCmd() {
  return engineGuard.findDshCmd(readManifest(), log);
}

function spawnServerDshCmd() {
  const dshCmd = findDshCmd();
  const env = serverSpawnEnv();
  log('[boot] dsh.cmd: ' + dshCmd + ' web --no-open --port ' + EFFECTIVE_DSH_PORT);
  // ⚠ cwd 必须是一个**存在**的目录：之前用 HARNESS_DIR（引擎\，模板里并不存在），
  //   spawn 会异步抛 ENOENT；wireServerProc 没挂 error 监听 ⇒ 走 uncaughtException 弹致命框。
  //   工作台根一定存在，且 dsh CLI 不依赖 cwd，故用它。
  // ⚠ 不要在参数里手写引号：Node 在 Windows 上会把带空格的参数再转义一层，
  //   cmd 收到的是带反斜杠转义的双引号 ⇒ 报「不是内部或外部命令」。
  //   交给 Node 自动加引号即可（真实事故，2026-11-01）。
  const proc = spawn('cmd.exe', ['/c', dshCmd, 'web', '--no-open', '--port', EFFECTIVE_DSH_PORT], {
    cwd: WORKBENCH_ROOT,
    env: env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.on('error', function (e) { log('[boot] dsh.cmd spawn 失败: ' + ((e && e.message) || e)); });
  return wireServerProc(proc);
}

// 方式一（首选）：直跑构建产物（无 cmd / 无 pnpm / 无 tsx）
// 引擎子进程的 cwd 必须是**存在**的目录。
// 原来固定用 HARNESS_DIR（模板里没有 引擎\ 这一层）⇒ spawn 异步抛 ENOENT，界面白屏。
function engineCwd() {
  try { if (HARNESS_DIR && fs.statSync(HARNESS_DIR).isDirectory()) return HARNESS_DIR } catch (e) { /* ignore */ }
  return WORKBENCH_ROOT;
}

function spawnServerDirect() {
  if (!CLI_BUILT) { log('[boot] 没有内置引擎目录（引擎\\apps\\cli 不存在），跳过内置入口'); return null }
  if (!fs.existsSync(CLI_BUILT)) { log('[boot] 内置入口不存在，跳过：' + CLI_BUILT); return null }
  const env = serverSpawnEnv();
  const nodeExe = resolveNodeExe();
  let cmd, args;
  if (nodeExe) {
    cmd = nodeExe;
    args = [CLI_BUILT, 'web', '--no-open', '--port', EFFECTIVE_DSH_PORT];
  } else {
    // Electron 二进制以纯 Node 运行（内置 Node 24.18，满足 engines 要求）
    env.ELECTRON_RUN_AS_NODE = '1';
    cmd = process.execPath;
    args = [CLI_BUILT, 'web', '--no-open', '--port', EFFECTIVE_DSH_PORT];
  }
  log('[boot] direct: ' + cmd + ' ' + args.join(' '));
  return wireServerProc(spawn(cmd, args, {
    cwd: engineCwd(),
    env: env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }));
}

// 方式二（兜底）：原来的 pnpm 脚本（走 tsx 实时转译，慢但兼容性最好）
function spawnServerPnpm() {
  return wireServerProc(spawn('cmd.exe', ['/c', PNPM_CMD + ' dsh web --no-open --port ' + EFFECTIVE_DSH_PORT], {
    cwd: engineCwd(),
    env: serverSpawnEnv(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }));
}

// 引擎是不是**别人**拉起来的（我们只是复用）：
//   true ⇒ 我们看不到它启动时打印的 token，日志历史里的 token 也只对"我们自己拉起的那次"有效；
//   引擎在外部重启后旧 token 立刻失效（实测白屏 `dsh web authentication required`）。
//   所以复用外部引擎时，主界面改走本机保命入口 `http://127.0.0.1:<SITE_PORT>/chat`（实时用当前 token 跳转）。
let engineIsForeign = false
const BOOT_FAIL_FILE = path.join(__dirname, 'data', 'engine-boot-fail.json')

function bumpBootFail() {
  let n = 0
  try { n = Number(JSON.parse(fs.readFileSync(BOOT_FAIL_FILE, 'utf8')).count) || 0 } catch { /* first */ }
  n += 1
  try { fs.writeFileSync(BOOT_FAIL_FILE, JSON.stringify({ count: n, at: new Date().toISOString() }, null, 2) + '\n', 'utf8') } catch { /* ignore */ }
  return n
}
function resetBootFail() {
  try { fs.writeFileSync(BOOT_FAIL_FILE, JSON.stringify({ count: 0, at: new Date().toISOString() }, null, 2) + '\n', 'utf8') } catch { /* ignore */ }
}

/**
 * 引擎成功启动后，把当前配置标成“正常点”（2026-10-21 宿主：升级卡死后要能回到上次能用）。
 * 只备份 17 个启动配置，不碰源码/构建；失败静默，不影响启动。
 */
function markEngineGood() {
  try {
    const tool = path.join(__dirname, '..', '工具', '引擎快照.mjs');
    if (!fs.existsSync(tool)) return;
    topbarRunAsync(tool, ['--save', '--quiet'], 120000).then(function (r) {
      if (r && r.ok) log('[engine] 已更新“正常点”配置快照');
      else log('[engine] 正常点快照失败: ' + String((r && r.out) || '').slice(0, 160));
    });
  } catch (e) { log('[engine] 正常点快照异常: ' + String((e && e.message) || e)); }
}

async function startServer() {
  sendBoot({ stage: 'check', pct: 6, text: '检查引擎状态…', detail: '' });
  if (await probe()) {
    log('reuse: port already listening');
    engineIsForeign = true;
    // 端口已在监听时，token 只能尝试从日志历史里找（仅当"我们自己曾拉起过它"时才对）
    if (!harnessToken) {
      const hist = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
      const m = hist.match(/token=([A-Za-z0-9_\-]+)/);
      if (m) harnessToken = m[1];
    }
    publishEngineEndpoint();
    log('[engine] 复用外部引擎 ⇒ 主界面走保命入口 http://127.0.0.1:' + SITE_PORT + '/chat（token 每次实时转发，永远是最新的）');
    sendBoot({ stage: 'ready', pct: 92, text: '引擎已就绪', detail: '复用正在运行的实例' });
    resetBootFail();
    markEngineGood();
    return true;
  }
  const plans = [];
  const dshCmd = findDshCmd();
  if (dshCmd) {
    plans.push({ label: 'DSH 官方 CLI', detail: 'dsh.cmd web --no-open --port ' + EFFECTIVE_DSH_PORT, spawn: spawnServerDshCmd, budget: 45 });
  }
  if (CLI_BUILT && fs.existsSync(CLI_BUILT)) {
    plans.push({ label: '内置入口', detail: 'apps/cli/lib/bin.js（跳过 pnpm / tsx）', spawn: spawnServerDirect, budget: 45 });
  }
  if (fs.existsSync(PNPM_CMD)) {
    plans.push({ label: 'pnpm 脚本', detail: 'pnpm dsh web（tsx 转译，兜底）', spawn: spawnServerPnpm, budget: 90 });
  } else {
    log('[boot] pnpm 不存在，跳过该兜底：' + PNPM_CMD);
  }

  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    sendBoot({ stage: 'spawn', pct: 12, text: '正在启动 Harness 引擎…', detail: plan.detail });
    serverProc = plan.spawn();
    const proc = serverProc;
    if (!proc) { log(plan.label + ' 无法启动，跳到下一档'); continue }
    const t0 = Date.now();
    while ((Date.now() - t0) < plan.budget * 1000) {
      await sleep(300);   // 300ms 轮询：引擎就绪后最多 0.3s 就能进入下一步（原来 1s）
      if (await probe()) {
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        log('engine ready in ' + secs + 's via ' + plan.label);
        sendBoot({ stage: 'ready', pct: 92, text: '引擎已就绪，正在加载界面…', detail: plan.label + ' · ' + secs + 's' });
        resetBootFail();
        markEngineGood();
        return true;
      }
      if (proc.exitCode !== null) {
        log(plan.label + ' exited early (code=' + proc.exitCode + ')');
        sendBoot({ stage: 'spawn', pct: 14, text: '该启动方式未成功，正在尝试兜底…', detail: plan.label + ' 退出（code ' + proc.exitCode + '）' });
        break;
      }
      const el = (Date.now() - t0) / 1000;
      const pct = Math.min(88, 14 + Math.round((el / plan.budget) * 74));
      sendBoot({ stage: 'wait', pct: pct, text: '引擎启动中…', detail: plan.detail + ' · ' + el.toFixed(0) + 's' });
    }
    killServer();
  }
  sendBoot({ stage: 'error', pct: 100, text: '引擎启动失败', detail: '可点「重试」，或查看 server.log' });
  try {
    const n = bumpBootFail()
    log('[engine] start failed, consecutive=' + n)
    // 连续两次起不来：自动回退到上一次“正常点”配置，再让用户点重试。
    if (n >= 2) {
      const tool = path.join(__dirname, '..', '工具', '引擎快照.mjs')
      if (fs.existsSync(tool)) {
        log('[engine] 连续失败 ⇒ 自动回退引擎配置正常点')
        topbarRunAsync(tool, ['--restore', '--yes'], 120000).then(function (r) {
          log('[engine] 自动回退' + (r && r.ok ? '完成' : '失败: ' + String((r && r.out) || '').slice(0, 160)))
        })
        resetBootFail()
      }
    }
  } catch (e) { log('[engine] boot-fail 计数异常: ' + String((e && e.message) || e)) }
  return false
}

function killServer() {
  if (serverProc) {
    try {
      spawnSync('taskkill', ['/pid', String(serverProc.pid), '/T', '/F'], { windowsHide: true });
    } catch (e) { /* ignore */ }
    serverProc = null;
  }
}

// ---- 场景标签顺序：读 / 写 / 应用（实现已抽到 main/scenes.js，这里只保留兼容入口）----
function readSceneTabOrder() { return sceneStore.readSceneTabOrder(); }
function saveSceneTabOrder(ids) { return sceneStore.saveSceneTabOrder(ids); }

// ---- 读取场景配置（scenarios/*.json；实现已抽到 main/scenes.js）----
function listScenarios() { return sceneStore.listScenarios(); }

function getScenario(id) { return sceneStore.getScenario(id); }

// ---- 多公司模板支持：当前场景的 meta（可覆盖 SSH/服务/映射/日志/网址）----
// meta 缺省 → 全部回落 oa.db 全局配置（原有场景行为不变）
let oaActiveScenario = 'oa-ops';
function scenarioMeta(sid) {
  const s = getScenario(sid || oaActiveScenario);
  return (s && s.meta && typeof s.meta === 'object') ? s.meta : {};
}
function applyOaScenario(sid) {
  const id = String(sid || '').trim();
  if (!id) return { ok: false, err: '缺少场景 id' };
  oaActiveScenario = id;
  const m = scenarioMeta(id);
  try { oaSsh.setMeta(m); } catch (e) { /* ignore */ }
  invalidateOaCache();          // 切场景后所有采集缓存作废（不同公司数据不能混）
  const sc = getScenario(id);
  return {
    ok: true,
    id: id,
    name: (sc && sc.name) || id,
    company: m.company || '',
    hasMeta: !!(m && Object.keys(m).length),
    ssh: { host: (m.ssh && m.ssh.host) || oaStore.getConfig('ssh.host') || '', user: (m.ssh && m.ssh.user) || oaStore.getConfig('ssh.user') || '' }
  };
}

// ---- 个人站场景：官网静态服务（E 盘官网目录 → 127.0.0.1:SITE_PORT，供 webview 预览与图片加载）----
// ---- Blender 场景：实时画面（抓帧 JPEG 也由这个静态服务直出，避免每帧走 IPC）----
// 本机没装就留空（该场景没面板时永远不会被调用）
  const BLENDER_EXE = process.env.DSH_BLENDER_EXE || '';
const BLENDER_DIR = process.env.DSH_BLENDER_DIR || '';                               // Blender 工作区（本地文件面板的根）
const BLENDER_AUTOSTART = path.join(__dirname, 'scripts', 'autostart_mcp.py'); // ASCII 路径：中文路径会被 Blender 当文件加载
const BLENDER_CAPTURE_PS = path.join(__dirname, 'scripts', 'blender-capture.ps1');
const BLENDER_LIVE_JPG = path.join(__dirname, 'data', 'blender-live.jpg');
const BLENDER_LIVE_META = path.join(__dirname, 'data', 'blender-live.json');
const BLENDER_CAPTURE_PID = path.join(__dirname, 'data', 'blender-capture.pid');
const BLENDER_MCP_PORT = 9876;

// ---- Blender 内置：把 Blender 主窗口 SetParent 进 GUI 窗口，直接在面板里操作 ----
// Win32 部分全在 scripts/blender-embed-agent.ps1；主进程只负责起代理、下命令、收结果。
const BLENDER_EMBED_AGENT = path.join(__dirname, 'scripts', 'blender-embed-agent.ps1');
const BLENDER_EMBED_CMD = path.join(__dirname, 'data', 'blender-embed.cmd.json');
const BLENDER_EMBED_RES = path.join(__dirname, 'data', 'blender-embed.res.json');

const SITE_MIME = {
  '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.webp': 'image/webp'
};
function startSiteServer() {
  if (siteServer) return;
  const SITE_ROOT = path.normalize(SITE_DIR);
  const hasSite = fs.existsSync(SITE_DIR);
  if (!hasSite) log('[site] 官网目录不存在（个人站预览不可用）: ' + SITE_DIR);
  siteServer = http.createServer(function (req, res) {
    const u = decodeURIComponent((req.url || '/').split('?')[0]);
    // Blender 场景：实时画面（抓帧进程写盘 → 这里直出，渲染层 img 带时间戳轮询即可）
    if (u === '/__blender/live.jpg') {
      fs.readFile(BLENDER_LIVE_JPG, function (err, data) {
        if (err) { res.writeHead(404); res.end('no-frame'); return; }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store, no-cache, must-revalidate' });
        res.end(data);
      });
      return;
    }
    // 保命入口：http://127.0.0.1:31238/chat → 用**当前** token 跳到引擎对话页。
    // 为什么需要：引擎每次启动都会随机生成新 token（见引擎源码 packages/client/connection/README.md），
    // 所以「带 token 的收藏网址」一重启就 401。这个固定入口只要工作台在跑就总能进对话。
    if (u === '/chat' || u === '/chat/') {
      const t = harnessToken;
      if (t) {
        res.writeHead(302, { Location: BASE + '/?token=' + t, 'Cache-Control': 'no-store' });
        res.end('redirecting to chat...');
      } else {
        // 引擎还没起来 / 还没抓到 token：给一个会自动重试的提示页，而不是 401 白屏
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('<!doctype html><meta charset="utf-8"><title>等待引擎…</title>' +
          '<body style="background:#0b0d12;color:#e6e8ee;font:14px/1.8 system-ui;padding:40px">' +
          '<h2>引擎还没就绪</h2><p>工作台正在启动 Harness 引擎（或还没拿到本次启动令牌）。</p>' +
          '<p>这个页面<b>不再自动刷新</b>；看到引擎起来后，点下面按钮重新检查。</p>' +
          '<p><a href="" style="display:inline-block;padding:9px 18px;border:1px solid #3b82f6;border-radius:8px;color:#93c5fd;text-decoration:none">🔄 重新检查</a></p>' +
          '<p style="color:#64748b;font-size:12px">2026-11-01 起改为手动重试</p></body>');
      }
      return;
    }
    // 2026-10-22：DSH 社区站（第二个预览源）—— 前缀 /__community/ 直出本地目录，
    // 与官网同端口不同根；目录不存在时给明确 404，不影响官网预览。
    if (u === '/__community' || u.startsWith('/__community/')) {
      const cRoot = path.normalize(COMMUNITY_DIR);
      if (!fs.existsSync(cRoot)) { res.writeHead(404); res.end('no-community-dir'); return; }
      let rel = u.replace(/^\/__community\/?/, '');
      if (!rel) rel = 'index.html';
      let cp = path.normalize(path.join(cRoot, rel));
      if (!cp.startsWith(cRoot) || memGuard.sitePathForbidden(cRoot, cp)) { res.writeHead(403); res.end('forbidden'); return; }
      if (fs.existsSync(cp) && fs.statSync(cp).isDirectory()) cp = path.join(cp, 'index.html');
      if (!fs.existsSync(cp)) { res.writeHead(404); res.end('not found'); return; }
      fs.readFile(cp, function (err, data) {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        const ext = path.extname(cp).toLowerCase();
        res.writeHead(200, { 'Content-Type': SITE_MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(data);
      });
      return;
    }
    if (!hasSite) { res.writeHead(404); res.end('no-site'); return; }
    let p = path.normalize(path.join(SITE_ROOT, u === '/' ? 'index.html' : u));
    if (!p.startsWith(SITE_ROOT) || memGuard.sitePathForbidden(SITE_ROOT, p)) { res.writeHead(403); res.end('forbidden'); return; }
    if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(SITE_ROOT, 'index.html');
    fs.readFile(p, function (err, data) {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      const ext = path.extname(p).toLowerCase();
      res.writeHead(200, { 'Content-Type': SITE_MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });
  // ★ 2026-09-26：同一台机上可能同时跑着两个壳（dev 工作台 + 安装版）⇒ 31238 只能被一个占住。
  //   占不到的那个**安静退让**（原来会抛未捕获的 EADDRINUSE 刷日志），保命入口/官网预览由占住的那个提供；
  //   它自己取主界面地址时走 http://127.0.0.1:31238/chat（见下方 harness:url）⇒ 照样能进官方主界面。
  siteServer.on('error', function (e) {
    log('[site] 端口 ' + SITE_PORT + ' 没占上（' + ((e && e.code) || e) + '）⇒ 本实例让给已在跑的那个壳；'
      + '保命入口/官网预览继续由它提供，主界面仍走 http://127.0.0.1:' + SITE_PORT + '/chat');
    siteServer = null;
  });
  siteServer.listen(SITE_PORT, '127.0.0.1', function () {
    log('[site] 静态服务已启动: http://127.0.0.1:' + SITE_PORT + '（个人站官网 + Blender 实时画面 + 保命入口 /chat）');
  });
}

// 个人站上下文：从官网 index.html 提取关键信息（账号/邮箱/标题），失败回退内置
function collectSiteContext() {
  const ctx = {
    title: '我 | 我 · 个人站',
    accounts: [
      { name: '哔哩哔哩', handle: '@我', url: 'https://space.bilibili.com' },
      { name: '抖音', handle: '@<你的抖音账号>', url: 'https://<你的抖音主页>' },
      { name: '小红书', handle: '@我', url: 'https://www.xiaohongshu.com' }
    ],
    email: '<邮箱>',
    siteUrl: 'http://127.0.0.1:' + SITE_PORT + '/index.html'
  };
  try {
    const html = fs.readFileSync(path.join(SITE_DIR, 'index.html'), 'utf8');
    const t = String(html).match(/<title>([^<]+)<\/title>/);
    if (t && t[1]) ctx.title = t[1].trim();
    const mail = String(html).match(/mailto:([^"']+)/);
    if (mail && mail[1]) ctx.email = mail[1];
  } catch (e) { /* 用内置兜底 */ }
  return ctx;
}

function buildSiteSystem(c) {
  const acct = (c.accounts || []).map(function (a) {
    return '- ' + a.name + '（' + a.handle + '）: ' + a.url;
  }).join('\n');
  return [
    '你是「我」个人站的 AI 助手（我的个人站），只回答与这个个人站相关的问题，语气友好简洁。',
    '',
    '【个人站信息】',
    '标题：' + (c.title || '我 | 我 · 个人站'),
    '官网本地预览：' + (c.siteUrl || ''),
    '自媒体账号：',
    acct || '（无）',
    '联系邮箱：' + (c.email || '<邮箱>'),
    '',
    '【官网板块】#tools 我小工具集合（已上架「上班盯盘助手」，其余空位待填）；#media 自媒体账号；#cooperate 联系咨询；#donate 投喂小鱼干；#about 关于我。',
    '【风格】像素风 + 下雨背景，深蓝 #0a1628 主色，青色 #06e7e9 点缀；签名：梦想是优雅地淋一场雨。',
    '无关话题礼貌说明自己只了解我个人站。'
  ].join('\n');
}

let blenderEmbedOwner = null;
function stopBlenderCapture() {}
function releaseBlenderEmbedSync() {}
function scheduleEmbedFollow(win) {}
function scheduleAppwFollow(win) {}
function invalidateOaCache() {}

// 建窗口：opts = { isMain, scene, saved }
//   isMain=true  → 主窗口（场景标签页齐全，行为与以前完全一致）
//   isMain=false → 「场景分离窗口」：只渲染 opts.scene 这一个场景，隐藏场景标签栏（渲染层按 URL 的 solo=1 处理）
function createWindow(opts) {
  opts = opts || {};
  const isMain = !!opts.isMain;
  const scene = String(opts.scene || '');
  const defW = isMain ? 1380 : 1220;
  const defH = isMain ? 900 : 840;
  const fit = fitSavedBounds(opts.saved, defW, defH);
  const bounds = fit.bounds || { width: defW, height: defH };
  const winOpts = {
    width: bounds.width,
    height: bounds.height,
    minWidth: 1000,
    minHeight: 660,
    title: isMain ? 'DSH 引擎' : (sceneNameOf(scene) + ' · 清玄的工作台'),
    autoHideMenuBar: true,
    frame: false,
    backgroundColor: '#0b0d12',
    icon: path.join(__dirname, 'icon.ico'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      // 渲染层要「记忆根 / 技能根」去找文件（顶栏体检卡、神经元面板），preload 里读的是这两个环境变量。
      // ⚠ DSH_HOME 只在**引擎子进程**的 env 里设过，主进程自己的 process.env 里从来没有 ⇒
      //   preload 拿到的 memRoot / skillDir 一直是空串，界面侧所有按记忆根拼的路径都会退化成相对路径。
      //   这里显式把主进程算好的真值传进去（沙箱化 preload 读得到的唯一通道就是 additionalArguments）。
      additionalArguments: [
        '--dsh-home=' + DSH_DATA_DIR,
        '--dsh-skills=' + path.join(DSH_DATA_DIR, 'skills')
      ]
    }
  };
  if (typeof bounds.x === 'number' && typeof bounds.y === 'number') { winOpts.x = bounds.x; winOpts.y = bounds.y; }
  const win = new BrowserWindow(winOpts);
  win.kunRole = isMain ? 'main' : 'scene';
  win.kunScene = isMain ? '' : scene;
  // 网页版 AI 桥的派发目标：记住"最后被聚焦的窗口"——分离窗口也是一整套壳（自带 preload+渲染器+桥），
  // 任务千万不能广播（旧版本桥会抢单，界面里看到的却一直是新代码，极难排查）。
  win.on('focus', function () { lastFocusedWin = win; });
  if (isMain) lastFocusedWin = win;
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', function () {
    win.show();
    if (fit.maximized) { try { win.maximize(); } catch (e) { /* ignore */ } }
    if (isMain) log('[boot] window-visible ms=' + (Date.now() - APP_T0));   // ASCII 判据，供启动脚本 find
    if (isMain) log('[boot] 窗口可见耗时 ' + (Date.now() - APP_T0) + 'ms');
    else log('[win] 场景窗口已打开: ' + scene + (fit.clamped ? '（原屏幕已不在，已夹回主屏）' : ''));
  });
  // ── 启动诊断（2026-11-01）────────────────────────────────
  // 症状：双击后什么也没发生。常见原因是「窗口 create 了但 show 没触发」——
  //   show:false + once('ready-to-show') ⇒ 渲染层没加载完就永远不显示，人看不到任何报错。
  // 这里把三件事写进 server.log，让"没反应"有据可查：
  win.webContents.on('did-fail-load', function (e, code, desc, url, isMainFrame) {
    log('[diag] did-fail-load code=' + code + ' desc=' + desc + ' url=' + url + ' mainFrame=' + isMainFrame);
  });
  win.webContents.on('preload-error', function (e, p, err) {
    log('[diag] preload-error ' + p + ' :: ' + ((err && err.message) || err));
  });
  win.webContents.on('render-process-gone', function (e, d) {
    log('[diag] render-process-gone reason=' + (d && d.reason) + ' exit=' + (d && d.exitCode));
  });
  win.webContents.on('did-finish-load', function () {
    log('[diag] did-finish-load ' + String(win.webContents.getURL()).slice(0, 120));
  });
  // Electron 43 起 console-message 的形参只剩一个事件对象；多声明一个参数就会触发弃用警告
  win.webContents.on('console-message', function (ev) {
    try {
      var d = ev || {};
      if (d.message === undefined) return;                 // 老签名（拿不到文案）就别记噪音
      if (d.level === 'verbose' || d.level === 'info' || d.level === 0 || d.level === 1) return;  // 只留警告和错误
      log('[diag] console L' + d.level + ' ' + String(d.message).slice(0, 400) + '  @' + (d.sourceId || '').slice(-60) + ':' + d.lineNumber);
    } catch (err) { /* ignore */ }
  });
  // 兜底：10 秒还没显示，就强制显示（宁可露出半成品，也别让人对着空气）
  setTimeout(function () {
    try {
      if (!win.isVisible() && !win.isDestroyed()) {
        log('[diag] 10s 仍未 ready-to-show，强制显示窗口');
        win.show();
      }
    } catch (e) { /* ignore */ }
  }, 10000);
  win.webContents.setWindowOpenHandler(function (details) {
    if (/^https?:/i.test(details.url) || /^mailto:/i.test(details.url)) shell.openExternal(details.url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', function (e, url) {
    // 只允许：引擎地址(DSH_PORT) + GUI 自己目录下的 file:// 页面。
    // 其余一律拦截 —— 这样"把文件拖到窗口上"不会把界面导航到那个文件（观感像闪退）。
    // 注意：主进程主动 loadFile 不会触发 will-navigate，所以启动不受影响。
    const u = String(url);
    const ownDir = __dirname.replace(/\\/g, '/').toLowerCase();
    const isOwnFile = u.indexOf('file://') === 0 && decodeURIComponent(u).toLowerCase().indexOf(ownDir) >= 0;
    if (u.indexOf(BASE) !== 0 && !isOwnFile) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  win.on('close', function () {
    // 关之前先把几何记下来：主窗口关闭时还要连带关闭分离窗口，那一刻它们的位置已经取不到了
    noteWindowRect(win);
    if (isMain) { quitRequested = true; saveWinLayout(); }
  });
  win.on('closed', function () {
    if (isMain) {
      mainWindow = null;
      releaseBlenderEmbedSync();
      quitRequested = true;
      // 主窗口关闭 = 整个应用退出（用户选定的行为）：连带关掉分离窗口
      for (const w of detachWindows.slice()) { try { w.close(); } catch (e) { /* ignore */ } }
    } else {
      const i = detachWindows.indexOf(win);
      if (i >= 0) detachWindows.splice(i, 1);
      if (blenderEmbedOwner === win) releaseBlenderEmbedSync();
      // 用户主动关掉某个场景窗口 = 下次启动不再恢复它；整个应用退出时则保留布局
      if (!quitRequested && win.kunScene) delete layoutCache.detached[win.kunScene];
      saveWinLayout();
      notifyWindowsChanged();
    }
  });
  // 窗口移动/缩放时记忆位置
  win.on('move', function () { noteWindowRect(win); saveWinLayoutSoon(); });
  win.on('resize', function () { noteWindowRect(win); saveWinLayoutSoon(); });
  if (isMain) {
    mainWindow = win;
  } else {
    detachWindows.push(win);
    noteWindowRect(win);
    saveWinLayout();
  }
  // 分离窗口：URL 带场景 id + solo 标记 → 渲染层只画这一个场景（并隐藏场景标签栏）
  win.loadFile(
    path.join(__dirname, 'renderer', 'index.html'),
    isMain ? undefined : { query: { scene: scene, solo: '1' } }
  );
  if (!isMain) notifyWindowsChanged();
  return win;
}

// 「在新窗口打开场景」：已在独立窗口里的场景 → 把那个窗口拉到前台，不重复开
function openSceneWindow(sceneId) {
  const id = String(sceneId || '').trim();
  if (!id) return { ok: false, err: 'empty-scene' };
  // 场景 json 可能已被删/改名 → 先校验，避免开出一个空壳窗口（渲染层取不到场景就只剩空白）
  try {
    const known = listScenarios().map(function (s) { return s.id; });
    if (known.indexOf(id) < 0) return { ok: false, err: 'unknown-scene', scene: id };
  } catch (e) { /* 校验本身失败就不拦，交给渲染层 */ }
  const exist = findSceneWindow(id);
  if (exist) {
    try {
      if (exist.isMinimized()) exist.restore();
      exist.show();
      exist.focus();
    } catch (e) { /* ignore */ }
    return { ok: true, focused: true, scene: id };
  }
  createWindow({ scene: id });
  log('[win] 新开场景窗口: ' + id + '（' + sceneNameOf(id) + '）');
  return { ok: true, focused: false, scene: id };
}


// ---- 外链统一交给系统默认浏览器（对话里的网址点一下就跳默认浏览器）----
// 原因：Harness 界面跑在 <webview> 里，那是独立 webContents，
// 主窗口上的 setWindowOpenHandler / will-navigate 管不到它 →
// 对话里的网址（GFM 自动链接，target=_blank）以往在应用内弹窗或毫无反应。
// 这里对 guest(webview) 内容统一接管：外部 http(s)/mailto 交给系统默认浏览器，
// 本地/内部地址（Harness 127.0.0.1:3080、个人站 :31238、file:// 等）保持原行为。
//
// ★例外：「内置网页版 AI」的窗口（渲染器用 partition="persist:webai-<key>" 建，见
//   renderer\renderers.js 的 WEB_AI）必须"像浏览器一样"，否则两头坏（2026-09-20 实测）：
//   ① 它们自己会跳：智谱加载 2.2 秒后自家 iframe 带着 refer__991 参数再跳一次、
//      千问点"登录"要跳 passport.qianwen.com（阿里账号域）。一拦就 e.preventDefault()
//      → 登录框根本出不来（用户报「智谱和千问无法登陆」）；
//   ② 一拦的同时还会 shell.openExternal() → 一开 GUI 预热时豆包/智谱的页面自己一跳，
//      用户的系统浏览器就被弹出来了（用户报「打开 dsh 之后就会自动打开豆包和智谱的网页」）。
//   所以：这些 guest 的导航一律放行；它们的 window.open（登录小窗、文档链接）在应用内开小窗，
//   并沿用原分区（小窗里的登录态要能回到主窗口）。识别方式：会话存储目录里带 Partitions\webai-<key>
//   （contents.session.getStoragePath() 是公开 API，探针已核实取到 "webai-chatglm" 这种名字）。
const INTERNAL_PROTOCOLS = /^(file|about|data|blob|devtools|dsh-app|chrome-extension|ws|wss):/i;
const INTERNAL_HOSTS = { '127.0.0.1': true, 'localhost': true, '::1': true };
const EXTERNAL_PROTOCOLS = /^(https?|mailto):/i;

function guestPartition(contents) {
  try {
    const m = /[\\/]Partitions[\\/](.+)$/.exec(contents.session.getStoragePath() || '');
    return m ? m[1] : '';
  } catch (e) { return ''; }
}

function isInternalUrl(u) {
  if (!u) return true;
  if (INTERNAL_PROTOCOLS.test(u)) return true;
  try {
    return INTERNAL_HOSTS[new URL(u).hostname] === true;
  } catch (e) {
    return true;
  }
}

function openInSystemBrowser(u) {
  try {
    if (EXTERNAL_PROTOCOLS.test(u)) { shell.openExternal(u); return true; }
  } catch (e) { /* ignore */ }
  return false;
}

app.on('web-contents-created', function (event, contents) {
  let type = '';
  try { type = contents.getType(); } catch (e) { return; }
  if (type !== 'webview') return;   // 主窗口已有自己的处理，不重复接管
  const part = guestPartition(contents);
  const webai = /^webai-/.test(part);   // 内置网页版 AI 的窗口
  // 2026-10-19 host: B站 scene opens Edge immediately. Embedded web panels (persist:embed-*)
  //   used to send EVERY external link / popup to openInSystemBrowser() -> system browser.
  //   For these partitions we now BLOCK instead (the panel has its own "open in browser" button).
  const isEmbed = /^embed-/.test(part);
  try {
    contents.setWindowOpenHandler(function (details) {
      if (isInternalUrl(details.url)) return { action: 'allow' };
      // 2026-10-19（bv-ai 反馈 · 宿主：「首页点视频/搜索没反应」）：embed 里 target=_blank / window.open 的链接
      //   以前直接 deny ⇒ 点了没反应。改成**就地打开**（照 scripts/sidebar.js L72-75 的写法）：
      //   不开新窗口、不弹系统浏览器，就在这个面板里继续走。
      if (isEmbed) {
        try { if (/^(https?:\/\/|file:\/\/)/.test(details.url || '')) contents.loadURL(details.url); } catch (e) { /* ignore */ }
        return { action: 'deny' };
      }
      if (webai) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 560, height: 720, autoHideMenuBar: true,
            webPreferences: { partition: 'persist:' + part },   // 登录小窗与主窗口共用登录态
          },
        };
      }
      openInSystemBrowser(details.url);
      return { action: 'deny' };
    });
  } catch (e) { /* ignore */ }
  if (webai) {
    // 网页版 AI 的 guest 是独立进程，渲染层看不到它的失败。这里把它的关键事件写进 server.log，
    // 否则出问题只能看到一片空白（真实踩过：面板显示模板源码/白屏，日志里什么都没有）。
    const tag = '[webai:' + part + '] ';
    contents.on('did-fail-load', function (e, code, desc, url, isMain) {
      if (isMain) log(tag + 'did-fail-load ' + code + ' ' + desc + ' ' + url);
    });
    contents.on('did-finish-load', function () {
      let u = '', ti = '';
      try { u = contents.getURL() } catch (e2) { /* ignore */ }
      try { ti = contents.getTitle() } catch (e2) { /* ignore */ }
      log(tag + 'finish title=' + JSON.stringify(ti) + ' url=' + u);
      // 正文长度 + 开头一小段：白屏和「渲染了但没登录」是两回事，得能分开
      contents.executeJavaScript("(function(){try{var b=document.body;return {len:b?b.innerText.length:0,txt:b?b.innerText.slice(0,120):\"(no body)\",els:document.querySelectorAll(\"*\").length}}catch(e){return {err:String(e&&e.message)}}})()", true)
        .then(function (r) { log(tag + 'bodyLen=' + (r && r.len) + ' els=' + (r && r.els) + ' txt=' + JSON.stringify(r && r.txt)) })
        .catch(function (e) { log(tag + 'probe failed ' + (e && e.message)) });
      // did-finish-load 只是初始 HTML 到位，SPA 还要再水合一轮（首屏常是骨架屏）。
      // 3 秒后再量一次，避免把「还在水合」误判成「白屏」。
      setTimeout(function () {
        try {
          contents.executeJavaScript("(function(){try{var b=document.body;return {len:b?b.innerText.length:0,els:document.querySelectorAll(\"*\").length}}catch(e){return {err:String(e&&e.message)}}})()", true)
            .then(function (r) { log(tag + 'hydrated bodyLen=' + (r && r.len) + ' els=' + (r && r.els)) })
            .catch(function () { /* 面板已关就算了 */ });
        } catch (e3) { /* ignore */ }
      }, 3000);
    });
    contents.on('console-message', function (ev) {
      const lv = String(ev.level);
      if (lv === 'error' || lv === '2') log(tag + 'console ' + String(ev.message).slice(0, 200));
    });
  }
  if (webai) return;   // 内置网页版 AI：导航完全照浏览器来，不接管
  contents.on('will-navigate', function (e, url) {
    if (isInternalUrl(url)) return;
    if (isEmbed) return;                            // 2026-10-19 embed: 就地导航（不弹系统浏览器、也别拦页面自己的跳转）
    if (openInSystemBrowser(url)) e.preventDefault();
  });
  try {
    contents.on('will-frame-navigate', function (e) {
      const url = e && e.url;
      if (!url || isInternalUrl(url)) return;
      if (isEmbed) return;                            // 2026-10-19 embed: iframe 导航也放行（B站的内部 iframe 全靠它）
      if (openInSystemBrowser(url)) e.preventDefault();
    });
  } catch (e) { /* 旧版 Electron 无此事件，忽略 */ }
});

// ---- IPC：渲染层请求 token / 场景配置 ----
ipcMain.handle('harness:url', () => {
  // ★ 2026-09-26：引擎是**外部进程**时，手上的 token 可能是旧的（引擎一重启就失效 ⇒ 主界面白屏
  //   `dsh web authentication required`）。改用保命入口：由真正拉起引擎的那个工作台提供，
  //   每次请求都拿**当前** token 跳转 ⇒ 安装版/第二个壳也能稳定进主界面。
  if (engineIsForeign) return 'http://127.0.0.1:' + SITE_PORT + '/chat';
  const token = harnessToken;
  return token ? (BASE + '/?token=' + token) : (BASE + '/');
});
ipcMain.handle('harness:ready', () => engineIsForeign || !!harnessToken);
// ---- IPC：版本信息（左上角品牌区悬停显示）----
// 放主进程读的原因：版本号来自各处 package.json，渲染层没有文件系统权限；
// 运行时版本（Electron / Chromium / Node）也只有主进程能一次拿全。
ipcMain.handle('app:version', () => inventory.versionInfo(app.getVersion()));

// ---- 内嵌 Harness 面板精简模式：主进程向 webview 注入（只保留聊天流 + 输入框）----
// 隐藏：左侧菜单栏 / 右侧详情列（框架内联 grid-template-columns「Npx minmax(0,1fr) Npx」，
// 用 !important 强制 0/1fr/0，手柄 data-side 隐藏）；对话区顶部会话标题栏（data-phase > header）；
// 对话轨迹 turn rail（[data-chat-flow] 前一兄弟）；宽度拖条（data-width-handle）。
// ★会话列「铺满」★（2026-09-20 第三波；P2 收口后常量与 CSS 的唯一实现在 engine-adapter/contract.js）
const HARNESS_WIDE_COL = ENGINE_ADAPTER.WIDE_COL;
const HARNESS_WIDE_CARD = ENGINE_ADAPTER.WIDE_CARD;
const HARNESS_WIDE_CSS = ENGINE_ADAPTER.wideCss().join('\n');   // 原常量是 join 后的 string（P2 单一实现）
// 自维持：宿主只投几次，页面重渲染后自己纠回来（window 级守卫，防止攒出一堆定时器）。
// 会话列铺满脚本（HARNESS_WIDE_PIN_JS）已并入 ENGINE_ADAPTER.fixJs({profile:'main'})（P2 收口，不再保留副本）
const HARNESS_CHAT_CSS = ENGINE_ADAPTER.chatCss({ centerColFix: true }).join('\n');   // 原 6 段规则（含 centerCol 2 条）由 adapter 单一实现
const HARNESS_FIX_JS = ENGINE_ADAPTER.fixJs({ profile: 'main' });   // 布局修复 + centerCol 内联 + 完整 __fixDiag（P2 单一实现）
// 2026-11-04：注入计数/截图在 scripts\mem-guard.js（截图默认关、diag 只记前 2 轮）。
ipcMain.handle('harness:wv:inject', (e, webContentsId, pinTarget) => {
  const wc = webContents.fromId(Number(webContentsId));
  if (!wc || wc.isDestroyed()) {
    log('[wv:inject] webContents 不存在: ' + webContentsId);
    return { ok: false, err: 'no-webcontents' };
  }
  const n = memGuard.injectCount(wc);
  memGuard.maybeShot(wc, n, { dir: path.join(__dirname, 'captures'), log: log });
  try {
    const p = wc.insertCSS(HARNESS_CHAT_CSS);
    if (p && typeof p.catch === 'function') p.catch(function (err) { log('[wv:inject] insertCSS 拒绝: ' + (err && err.message || err)); });
  } catch (ex) { log('[wv:inject] insertCSS 失败: ' + (ex && ex.message || ex)); }
  try {
    // 钉住目标由调用方决定（OA 'oa系统运维' / 个人站 '个人站' / 分析助手 ['我看盘助手','我']）
    // 支持字符串或字符串数组（多候选）；以 JSON 数组字面量注入，避免引号转义问题
    const targets = (Array.isArray(pinTarget) ? pinTarget : [pinTarget])
      .map(function (t) { return String(t == null ? '' : t).trim(); })
      .filter(Boolean);
    const fixJs = HARNESS_FIX_JS.split('__DSH_PIN_TARGET__').join(JSON.stringify(targets.length ? targets : ['oa系统运维']));
    wc.executeJavaScript(fixJs).then(
      function (r) {
        // 2026-11-04：只记前 2 轮，之后静默（注入本身照常执行；日志不再被它刷满）
        if (n <= 2) {
          log('[wv:inject] js 结果: ' + String(r));
          // 诊断信息挂在 window.__fixDiag（executeJavaScript 只返回最后表达式值，诊断用全局变量取回）
          try {
            wc.executeJavaScript('window.__fixDiag || null').then(
              function (d) { if (d) log('[wv:inject] diag: ' + String(d).slice(0, 900)); },
              function () { /* ignore */ }
            );
          } catch (ex) { /* ignore */ }
        }
      },
      function (err) { log('[wv:inject] js 失败: ' + (err && err.message || err)); }
    );
  } catch (ex) { log('[wv:inject] exec 异常: ' + (ex && ex.message || ex)); }
  return { ok: true };
});
ipcMain.handle('scenarios:list', () => listScenarios());
ipcMain.handle('scenario:get', (e, id) => getScenario(id));
// 场景标签顺序（拖拽换位）：渲染层拖完报上来，下次开机 / 其它窗口都读它
ipcMain.handle('scenes:order:get', () => ({ saved: fs.existsSync(SCENE_ORDER_FILE), ids: readSceneTabOrder() }));
ipcMain.handle('scenes:order:set', (e, ids) => saveSceneTabOrder(ids));

// ---- 宿主通用能力（不属于任何场景）：打开/定位任意路径 ----
// 之前各场景为了"打开文件夹"互相借用通道（例如 OA 文件面板去调 app.site/app.blender），
// 造成场景间耦合。这里提供一个平台级通道，任何场景都可以用，互不依赖。
// 安全：只允许打开「存在且非可执行」的路径，或 http(s)/mailto 链接。
ipcMain.handle('app:open-path', (e, target) => {
  const t = String(target || '');
  if (!t) return { ok: false, err: 'empty' };
  try {
    if (/^(https?:|mailto:)/i.test(t)) { shell.openExternal(t); return { ok: true }; }
    if (!fs.existsSync(t)) return { ok: false, err: '路径不存在：' + t };
    shell.openPath(t);
    return { ok: true };
  } catch (ex) { return { ok: false, err: String((ex && ex.message) || ex) }; }
});
ipcMain.handle('app:reveal-path', (e, target) => {
  const t = String(target || '');
  if (!t) return { ok: false, err: 'empty' };
  try {
    if (!fs.existsSync(t)) return { ok: false, err: '路径不存在：' + t };
    shell.showItemInFolder(t);
    return { ok: true };
  } catch (ex) { return { ok: false, err: String((ex && ex.message) || ex) }; }
});

// ---- 宿主通用能力与系统 I/O 已抽离至 main/system-io.js ----
systemIo.setupSystemIO(ipcMain, { workbenchRoot: WORKBENCH_ROOT, windowOfEvent, getMainWindow: () => mainWindow, logger: log });

// ---- 个人站场景 IPC：官网预览地址 / 官网结构化信息 ----
ipcMain.handle('site:preview', () => ({
  ok: fs.existsSync(SITE_DIR),
  url: 'http://127.0.0.1:' + SITE_PORT + '/index.html',
  base: 'http://127.0.0.1:' + SITE_PORT,
  // 2026-10-22：第二个预览源（DSH 社区站），同一静态服务的 /__community/ 前缀
  communityUrl: 'http://127.0.0.1:' + SITE_PORT + '/__community/index.html',
  communityOk: fs.existsSync(COMMUNITY_DIR)
}));
ipcMain.handle('site:info', () => collectSiteContext());
ipcMain.handle('site:open', (e, url) => {
  const u = String(url || '');
  if (/^(https?:|mailto:)/i.test(u)) { try { shell.openExternal(u); } catch (ex) { /* ignore */ } }
  return true;
});
// 个人站场景：在资源管理器打开本地文件夹（项目管理用）
ipcMain.handle('site:open-folder', (e, dir) => {
  const d = String(dir || '');
  if (!d) return { ok: false, err: 'empty' };
  try {
    shell.openPath(d);
    return { ok: true };
  } catch (ex) { return { ok: false, err: String((ex && ex.message) || ex) }; }
});
// 个人站场景：网站可用性探测（我的网址状态；主进程发请求，绕开渲染器跨域限制）
ipcMain.handle('site:probe', (e, url) => {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return { ok: false, err: 'bad-url' };
  return new Promise((resolve) => {
    let mod = null, req = null;
    try {
      mod = u.toLowerCase().indexOf('https:') === 0 ? require('https') : require('http');
      const done = (ok, status) => { clearTimeout(timer); resolve({ ok: ok, status: status || 0 }); };
      const timer = setTimeout(() => { try { req && req.destroy(); } catch (x) { /* ignore */ } done(false, 0); }, 6000);
      req = mod.get(u, { headers: { 'User-Agent': 'kun-probe/1.0' } }, (res) => {
        // 2xx / 3xx 视为在线
        const code = res.statusCode || 0;
        res.resume();
        done(code >= 200 && code < 400, code);
      });
      req.on('error', () => done(false, 0));
    } catch (ex) { done(false, 0); }
  });
});
// ---- 程序开发场景：把项目里的 H5 用「手机尺寸独立窗口」打开（400×830，独立持久会话 → 登录能记住）----
// 场景 json 的 code-urls 面板里给条目加 "phone": true 就会出现 📱 按钮；换项目只改 json。
ipcMain.handle('code:phone-window', (e, url, title) => {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return { ok: false, err: 'bad-url' };
  try {
    const win = new BrowserWindow({
      width: 400,
      height: 830,
      title: String(title || '手机预览'),
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: 'persist:code-phone-preview'
      }
    });
    win.setMenuBarVisibility(false);
    win.loadURL(u);
    return { ok: true };
  } catch (ex) {
    return { ok: false, err: String((ex && ex.message) || ex) };
  }
});

// ---- 个人站场景：官网本地文件夹浏览（安全限制在 SITE_DIR 内，可进入子目录）----
ipcMain.handle('site:files:local', (e, relPath) => {
  const root = path.resolve(SITE_BROWSE_DIR);
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const full = rel ? path.resolve(root, rel) : root;
  if (full !== root && !full.startsWith(root + path.sep)) {
    return { ok: false, err: '越界路径：仅可浏览 ' + SITE_BROWSE_DIR };
  }
  let ents = [];
  try { ents = fs.readdirSync(full, { withFileTypes: true }); }
  catch (ex) { return { ok: false, err: '无法读取目录：' + full }; }
  const rows = ents.map(en => {
    let isDir = en.isDirectory(), size = 0, mtime = 0;
    try {
      const st = fs.statSync(path.join(full, en.name));
      isDir = st.isDirectory(); size = isDir ? 0 : st.size; mtime = Math.floor(st.mtimeMs / 1000);
    } catch (ex2) { /* ignore */ }
    return { name: en.name, isDir: isDir, size: size, mtime: mtime };
  }).sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'zh'));
  return { ok: true, root: root, rel: rel, base: 'http://127.0.0.1:' + SITE_PORT, rows: rows };
});

// 打开文件（2026-10-22）：浏览根已改成 <工作台>
// 其它项目文件直接交给系统默认程序（shell.openPath），不会 404。
ipcMain.handle('site:open-file', async (e, relPath) => {
  try {
    const root = path.resolve(SITE_BROWSE_DIR);
    const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const full = rel ? path.resolve(root, rel) : root;
    if (full !== root && !full.startsWith(root + path.sep)) return { ok: false, err: '越界' };
    if (!fs.existsSync(full)) return { ok: false, err: '文件不存在' };
    if (fs.statSync(full).isDirectory()) return { ok: false, err: '这是目录' };
    const siteRoot = path.resolve(SITE_DIR);
    if (full.startsWith(siteRoot + path.sep)) {
      const r2 = path.relative(siteRoot, full).split(path.sep).join('/');
      const url = 'http://127.0.0.1:' + SITE_PORT + '/' + r2.split('/').map(encodeURIComponent).join('/');
      try { shell.openExternal(url); return { ok: true, url: url }; } catch (ex) { /* 落到下面 openPath */ }
    }
    const r = await shell.openPath(full);
    return r ? { ok: false, err: r } : { ok: true };
  } catch (ex) {
    return { ok: false, err: String((ex && ex.message) || ex) };
  }
});

// ================= 自我复盘场景（独立命名空间 app.review，根＝<工作台>\自我复盘，只读） =================
// 需求：右上角浏览「自我复盘」镜像目录（主要都是 md），左上角大窗口"单击即预览"该文档。
// 为什么必须走主进程：渲染进程是 file:// 页面，fetch/XHR 读不了本地文件（图/视频能当子资源加载，
// 文本不能），所以目录列表与正文都由这里读盘；路径一律相对 REVIEW_DIR 解析并夹在本目录内。
// 只读：镜像是「我-个人信息 / 我的知识库」的副本（技能 maben-profile 的默认只读约束），不提供任何写接口。
const REVIEW_DIR = path.join(WORKBENCH_ROOT, '自我复盘');
const REVIEW_TEXT_EXT = /\.(md|markdown|txt|json|ya?ml|csv|log|ini|conf)$/i;
const REVIEW_MAX_BYTES = 4 * 1024 * 1024;   // 单篇上限 4 MB：超了只回前 4 MB，够看且不会把面板卡死

function resolveReviewPath(rel) {
  const root = path.resolve(REVIEW_DIR);
  const r = String(rel == null ? '' : rel).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const full = r ? path.resolve(root, r) : root;
  if (full !== root && !full.startsWith(root + path.sep)) return null;   // 越界 → null（不接受 .. 逃出）
  return { root: root, rel: r, full: full };
}

// 根目录是否存在（给面板显示"目录不见了"用）
ipcMain.handle('review:root', () => {
  const root = path.resolve(REVIEW_DIR);
  let exists = false;
  try { exists = fs.statSync(root).isDirectory(); } catch (ex) { exists = false; }
  return { ok: exists, root: root, label: REVIEW_DIR, exists: exists };
});

// ---- 任务台账（P4-5）：面板「任务台账」读的就是能力层 task.list（与 REST / MCP 同一口径）----
// 为什么用动态 import：core 是 ESM、主进程是 CJS —— 与 main/agent-gateway.js 走同一条路。
// 读时顺扫（services/tasks.list 里做）会把超时未回执的任务转 expired，面板看到的状态是新鲜的。
let coreModPromise = null;
function loadCoreModule() {
  if (!coreModPromise) {
    const { pathToFileURL } = require('url');
    coreModPromise = import(pathToFileURL(path.join(__dirname, 'core', 'index.mjs')).href);
  }
  return coreModPromise;
}
ipcMain.handle('tasks:ledger', async (e, opts) => {
  try {
    const core = await loadCoreModule();
    const r = await core.call('task.list', {
      limit: Math.max(1, Math.min(50, Number(opts && opts.limit) || 20)),
      status: (opts && opts.status) || undefined,
    }, core.makeCtx('ipc', { agent: 'renderer', rateLimit: false }));
    // 给排障/验收留证据：面板确实打通了 IPC → 能力层（第一次 + 每次顺扫真转了 expired）
    if (!loadCoreModule.__ledgerLogged) {
      loadCoreModule.__ledgerLogged = true;
      log('[tasks] 任务台账面板首次读取：' + ((r && r.count) || 0) + ' 条');
    }
    if (r && Array.isArray(r.expiredNow) && r.expiredNow.length) {
      log('[tasks] 读时顺扫转 expired：' + r.expiredNow.join(','));
    }
    return r;
  } catch (err) {
    return { ok: false, err: String((err && err.message) || err) };
  }
});

// 列目录：目录在前、中文按拼音排；text 标记可预览的文本类（md/txt/json…）
ipcMain.handle('review:files', (e, rel) => {
  const t = resolveReviewPath(rel);
  if (!t) return { ok: false, err: '越界路径：仅可浏览「自我复盘」目录' };
  let ents = [];
  try { ents = fs.readdirSync(t.full, { withFileTypes: true }); }
  catch (ex) { return { ok: false, err: '无法读取目录：' + t.full }; }
  const rows = ents
    .filter(en => !en.name.startsWith('.') && !en.name.startsWith('~$'))
    .map(en => {
      let isDir = en.isDirectory(), size = 0, mtime = 0;
      try {
        const st = fs.statSync(path.join(t.full, en.name));
        isDir = st.isDirectory(); size = isDir ? 0 : st.size; mtime = Math.floor(st.mtimeMs / 1000);
      } catch (ex2) { /* ignore */ }
      return { name: en.name, isDir: isDir, size: size, mtime: mtime, text: isDir || REVIEW_TEXT_EXT.test(en.name) };
    })
    .sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'zh'));
  return { ok: true, root: t.root, rel: t.rel, label: REVIEW_DIR, rows: rows };
});

// 读正文（utf8）：返回相对路径 / 绝对路径 / 大小 / 修改时间 / 内容 / 是否截断
ipcMain.handle('review:read', (e, rel) => {
  const t = resolveReviewPath(rel);
  if (!t) return { ok: false, err: '越界路径：仅可读取「自我复盘」目录' };
  if (t.full === t.root) return { ok: false, err: '这是根目录，不是文档' };
  try {
    const st = fs.statSync(t.full);
    if (st.isDirectory()) return { ok: false, err: '这是目录，不是文档' };
    if (st.size > 512 * 1024 * 1024) return { ok: false, err: '文件过大（>512MB），不预览' };
    const buf = fs.readFileSync(t.full);
    const cut = buf.length > REVIEW_MAX_BYTES;
    return {
      ok: true, rel: t.rel, path: t.full, size: st.size, mtime: Math.floor(st.mtimeMs / 1000),
      content: buf.slice(0, REVIEW_MAX_BYTES).toString('utf8'), cut: cut, text: REVIEW_TEXT_EXT.test(t.full)
    };
  } catch (ex) { return { ok: false, err: '读取失败：' + String((ex && ex.message) || ex) }; }
});

// ============ 通用：Office / WPS 文档 → PDF（预览面板内嵌显示用，2026-10-13 加）============
// 为什么这么做：Chromium 内核渲染不了 doc/docx/xls/xlsx/ppt/pptx，但**能渲染 PDF**（内核自带阅读器）。
//   本机装了 Microsoft Office ⇒ 借它的 COM 转一次 PDF，交给内核阅读器显示 ⇒ 版式是 Office 自己排的，最接近原样。
// 缓存：结果按「绝对路径 + 大小 + 修改时间」算 sha1，落在 %TEMP%\kun-office-pdf\；同一个文件第二次打开直接命中
//   （几百毫秒），不再起 Office。改过文件（大小或时间变了）⇒ 哈希变了 ⇒ 自动重转，不会看到旧版。
// 失败（.wps/.et/.dps 这类 WPS 私有格式 MS Office 打不开、或本机没装 Office）⇒ 明确回报错误，
//   预览层退回「用系统默认程序打开」的卡片，绝不白屏、绝不静默失败。
const OFFICE_PDF_DIR = path.join(os.tmpdir(), 'kun-office-pdf');
const OFFICE_PS1 = path.join(__dirname, 'scripts', 'office2pdf.ps1');
const OFFICE_KIND = {
  doc: 'word', docx: 'word', rtf: 'word', odt: 'word', wps: 'word',
  xls: 'excel', xlsx: 'excel', ods: 'excel', et: 'excel',
  ppt: 'ppt', pptx: 'ppt', odp: 'ppt', dps: 'ppt'
};
const officeJobs = {};          // key → Promise：同一个文件并发点两次只转一次
let officeSwept = false;

// 顺手清缓存：整个进程生命周期做一次，删掉 14 天没动过的（别让它无声长大）
function officeSweep() {
  if (officeSwept) return;
  officeSwept = true;
  try {
    const cut = Date.now() - 14 * 24 * 3600 * 1000;
    fs.readdirSync(OFFICE_PDF_DIR).forEach(function (f) {
      try {
        const p = path.join(OFFICE_PDF_DIR, f);
        if (fs.statSync(p).mtimeMs < cut) fs.unlinkSync(p);
      } catch (e) { /* ignore */ }
    });
  } catch (e) { /* 目录还不存在，正常 */ }
}

function officeToPdf(src) {
  const ext = (path.extname(src).slice(1) || '').toLowerCase();
  const kind = OFFICE_KIND[ext];
  if (!kind) return Promise.resolve({ ok: false, err: '不是可转换的 Office 格式：.' + ext });
  let st = null;
  try { st = fs.statSync(src); } catch (e) { return Promise.resolve({ ok: false, err: '读不到文件：' + src }); }
  if (!st.isFile()) return Promise.resolve({ ok: false, err: '不是文件：' + src });
  if (st.size > 200 * 1024 * 1024) return Promise.resolve({ ok: false, err: '文件过大（>200MB），不做转换预览' });

  const key = crypto.createHash('sha1')
    .update(src.toLowerCase() + '|' + st.size + '|' + st.mtimeMs).digest('hex');
  const out = path.join(OFFICE_PDF_DIR, key + '.pdf');
  try { if (fs.statSync(out).size > 0) return Promise.resolve({ ok: true, pdf: out, cached: true }); }
  catch (e) { /* 没缓存，往下走 */ }
  if (officeJobs[key]) return officeJobs[key];

  officeSweep();
  const job = new Promise(function (resolve) {
    let settled = false;
    const finish = function (r) { if (!settled) { settled = true; resolve(r); } };
    try { fs.mkdirSync(OFFICE_PDF_DIR, { recursive: true }); }
    catch (e) { return finish({ ok: false, err: '建不了缓存目录：' + e.message }); }
    if (!fs.existsSync(OFFICE_PS1)) return finish({ ok: false, err: '缺少转换脚本 scripts\\office2pdf.ps1' });

    let ch = null;
    try {
      ch = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', OFFICE_PS1, '-In', src, '-Out', out, '-Kind', kind], { windowsHide: true });
    } catch (e) { return finish({ ok: false, err: '起不来 PowerShell：' + e.message }); }

    let so = '', se = '';
    if (ch.stdout) ch.stdout.on('data', function (d) { so += d.toString(); });
    if (ch.stderr) ch.stderr.on('data', function (d) { se += d.toString(); });
    // 90 秒兜底：Office 偶尔会卡在激活/字体对话框上，别让面板一直转圈
    const timer = setTimeout(function () { try { ch.kill(); } catch (e) { /* ignore */ } }, 90000);
    ch.on('error', function (e) { clearTimeout(timer); finish({ ok: false, err: 'PowerShell 起不来：' + e.message }); });
    ch.on('close', function () {
      clearTimeout(timer);
      let size = 0;
      try { size = fs.statSync(out).size; } catch (e) { size = 0; }
      if (size > 0) return finish({ ok: true, pdf: out });
      const detail = String(se || so || '').replace(/\s+/g, ' ').trim().slice(0, 240);
      finish({ ok: false, err: '转成 PDF 失败（' + kind + '）' + (detail ? '：' + detail : '') });
    });
  }).then(function (r) { delete officeJobs[key]; return r; });

  officeJobs[key] = job;
  return job;
}

// p 必须是绝对路径（渲染层给的是文件树里的真实路径）；这里不夹目录 —— 预览面板本来就能浏览任意盘
ipcMain.handle('kun:file:toPdf', function (e, p) {
  const t = String(p == null ? '' : p).trim();
  if (!t) return { ok: false, err: '空路径' };
  if (!path.isAbsolute(t)) return { ok: false, err: '需要绝对路径' };
  return officeToPdf(t);
});





// ---- 插件 / 模型 面板（只读；数据全部来自项目文件夹，核心原则：不落 C 盘） ----
// ⚠ 2026-11-01：HARNESS_DIR 现在可能是 ''（公开版没有 引擎\ 这一层）。空串不能往 path.join 里塞——
//   path.join('', '插件') 会得到**相对路径**，fs 再按进程 cwd 解析，于是"引擎的插件目录"静默变成了
//   "当前工作目录下的 插件\"，读出一份不存在的清单还不报错。删引擎目录这条分支后必须给真值。
//   引擎数据根的真值是 DSH_HOME（与 serverSpawnEnv 同源：引擎真正在用的那份数据就在那儿）。
const PLUGINS_DIR = HARNESS_DIR ? path.join(HARNESS_DIR, '插件') : '';
const DSH_DATA_DIR = dshHomeDir();
const SETTINGS_PATH = path.join(DSH_DATA_DIR, 'settings.yaml');

const SKILLS_DIR = path.join(DSH_DATA_DIR, 'skills');
const CREDENTIALS_PATH = path.join(DSH_DATA_DIR, '.credentials.yaml');

// 清点类接口（插件 / 技能 / 设置 / 工具清单）已抽离至 main/inventory.js
inventory.init({
  harnessDir: HARNESS_DIR,
  // 没有内置 引擎\ 时，版本卡/左栏的"内核版本"从外部 CLI 安装目录只读探测（见 engine-guard.detectEngineVersion）
  engineCliPath: findDshCmd,
  pluginsDir: PLUGINS_DIR,
  dshDataDir: DSH_DATA_DIR,
  toolsCatalogFile: path.join(__dirname, 'data', '工具清单.json'),
  settingsPath: SETTINGS_PATH,
  credentialsPath: CREDENTIALS_PATH,
  skillsDir: SKILLS_DIR,
  projectDir: __dirname,
});

ipcMain.handle('plugins:list', () => inventory.listPlugins());
ipcMain.handle('skills:list', () => inventory.listSkills());
ipcMain.handle('skills:open', (e, target) => {
  const p = target ? String(target) : SKILLS_DIR;
  try { if (fs.existsSync(p)) { shell.openPath(p); return { ok: true, path: p }; } } catch (ex) { /* ignore */ }
  return { ok: false, err: '路径不存在：' + p };
});
ipcMain.handle('settings:list', () => inventory.readSettings());
ipcMain.handle('settings:open', (e, which) => {
  const f = which === 'credentials' ? CREDENTIALS_PATH : SETTINGS_PATH;
  if (fs.existsSync(f)) {
    try { shell.openPath(f); return { ok: true }; } catch (ex) { return { ok: false, err: ex.message }; }
  }
  return { ok: false, err: '文件不存在' };
});

// ---- 余额实时显示：DeepSeek 平台余额（API 密钥只留在主进程，渲染层永远拿不到明文）----
// 数据源优先级：① 「余额显示」插件（引擎侧 GET /plugins/deepseek-balance/balance）
//               ② 插件未加载/不可用时回退主进程直连 https://api.deepseek.com/user/balance
// 点击余额打开 https://platform.deepseek.com/usage
const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const BALANCE_PLUGIN_URL = BASE + '/plugins/deepseek-balance/balance';
const BALANCE_PAGE = 'https://platform.deepseek.com/usage';
const BALANCE_INTERVAL = 10000;   // 每 10 秒刷新一次
let balanceTimer = null;
let lastBalance = null;
let balanceVia = '';              // 最近一次取数来源：plugin / direct

// 首选：走「余额显示」插件；插件未加载时返回 null（由调用方回退直连）
function fetchBalanceViaPlugin() {
  return new Promise(function (resolve) {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.get(BALANCE_PLUGIN_URL, { timeout: 8000 }, function (res) {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', function (d) { data += d; });
      res.on('end', function () {
        try {
          const j = JSON.parse(data || '{}');
          if (j && j.ok) {
            return finish({
              ok: true, ts: j.ts || Date.now(), isAvailable: !!j.isAvailable,
              currency: j.currency || 'CNY', total: j.total,
              granted: j.granted, toppedUp: j.toppedUp
            });
          }
        } catch (e) { /* 非 JSON → 视为插件不可用 */ }
        finish(null);   // 插件返回失败 → 交给直连路径
      });
    });
    req.on('timeout', function () { req.destroy(); finish(null); });
    req.on('error', function () { finish(null); });
  });
}

// 解析 DeepSeek 密钥：优先 .dsh/.credentials.yaml 的 refs.DEEPSEEK_API_KEY，其次环境变量
function readDeepseekKey() {
  try {
    const cred = path.join(DSH_DATA_DIR, '.credentials.yaml');
    if (fs.existsSync(cred)) {
      const m = fs.readFileSync(cred, 'utf8').match(/DEEPSEEK_API_KEY:\s*(\S+)/);
      if (m && m[1]) return m[1].replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* ignore */ }
  return process.env.DEEPSEEK_API_KEY || '';
}

async function fetchDeepseekBalance() {
  // ① 优先「余额显示」插件（引擎侧实现，插件未加载时静默回退）
  try {
    const viaPlugin = await fetchBalanceViaPlugin();
    if (viaPlugin) { balanceVia = 'plugin'; return viaPlugin; }
  } catch (e) { /* 回退直连 */ }
  balanceVia = 'direct';

  const key = readDeepseekKey();
  if (!key) return { ok: false, err: '未配置 DEEPSEEK_API_KEY', ts: Date.now() };
  const ctl = new AbortController();
  const to = setTimeout(() => { try { ctl.abort(); } catch (e) { /* ignore */ } }, 15000);
  try {
    const res = await fetch(BALANCE_URL, {
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
      signal: ctl.signal
    });
    clearTimeout(to);
    if (!res.ok) return { ok: false, err: 'HTTP ' + res.status, ts: Date.now() };
    const j = await res.json();
    const list = Array.isArray(j && j.balance_infos) ? j.balance_infos : [];
    const info = list.find(function (x) { return x && x.currency === 'CNY'; }) || list[0];
    if (!info) return { ok: false, err: '响应无余额信息', ts: Date.now() };
    return {
      ok: true, ts: Date.now(), isAvailable: !!(j && j.is_available),
      currency: info.currency || 'CNY',
      total: info.total_balance, granted: info.granted_balance, toppedUp: info.topped_up_balance
    };
  } catch (ex) {
    clearTimeout(to);
    const msg = (ex && ex.name === 'AbortError') ? '请求超时' : (ex && ex.message || String(ex));
    return { ok: false, err: msg, ts: Date.now() };
  }
}

function pushBalance(v) {
  lastBalance = v;
  try {
    // 余额要发全部窗口：分离出去的场景窗口也显示余额条
    try { broadcast('balance:update', v); } catch (e) { /* ignore */ }
  } catch (e) { /* ignore */ }
  return v;
}

function startBalancePoll() {
  if (balanceTimer) clearInterval(balanceTimer);
  const tick = async function () { pushBalance(await fetchDeepseekBalance()); };
  tick();
  balanceTimer = setInterval(tick, BALANCE_INTERVAL);
}

ipcMain.handle('balance:get', async () => lastBalance || await fetchDeepseekBalance());
ipcMain.handle('balance:refresh', async () => pushBalance(await fetchDeepseekBalance()));

// ============ 手机远程访问（dsh-plugin-remote-access）============
// 数据源：插件路由 /plugins/remote-access/*（插件内部放行 loopback 调用，故主进程可直接取）
const REMOTE_BASE = BASE + '/plugins/remote-access';

/** 向远程访问插件发一个请求；asBuffer=true 时保留原始 Buffer（取 PNG 二维码）。 */
function remoteAccessHttp(method, urlPath, asBuffer) {
  return new Promise(function (resolve) {
    let u;
    try { u = new URL(REMOTE_BASE + urlPath); } catch (e) { return resolve({ status: 0, error: '地址无效' }); }
    let done = false;
    const finish = function (v) { if (!done) { done = true; resolve(v); } };
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: method, timeout: 15000
    }, function (res) {
      const chunks = [];
      res.on('data', function (d) { chunks.push(d); });
      res.on('end', function () {
        const buf = Buffer.concat(chunks);
        finish({ status: res.statusCode, buf: buf, text: asBuffer ? '' : buf.toString('utf8') });
      });
    });
    req.on('timeout', function () { req.destroy(); finish({ status: 0, error: '请求超时' }); });
    req.on('error', function (e) { finish({ status: 0, error: e.message }); });
    req.end();
  });
}

ipcMain.handle('remoteAccess:status', async () => {
  const r = await remoteAccessHttp('GET', '/status');
  try { return JSON.parse(r.text); } catch (e) { return { ok: false, error: r.error || ('HTTP ' + r.status) }; }
});

ipcMain.handle('remoteAccess:qr', async () => {
  const r = await remoteAccessHttp('GET', '/qr.png', true);
  return (r.status === 200 && r.buf && r.buf.length)
    ? ('data:image/png;base64,' + r.buf.toString('base64'))
    : '';
});

// 引导第一步用的静态图：手机 WireGuard 配置二维码
ipcMain.handle('remoteAccess:guideImage', async () => {
  try {
    if (!PLUGINS_DIR) return '';   // 没有 引擎\ 这一层（公开版），插件图本来就不在
    const p = path.join(PLUGINS_DIR, '手机远程访问', 'runtime', '手机导入.png');
    if (fs.existsSync(p)) return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
  } catch (e) { /* 图缺失时前端会降级为文字说明 */ }
  return '';
});

ipcMain.handle('remoteAccess:action', async (e, action) => {
  if (action !== 'refresh' && action !== 'restart') return { ok: false, error: '未知操作' };
  const r = await remoteAccessHttp('POST', '/' + action);
  try { return JSON.parse(r.text); } catch (err) { return { ok: false, error: r.error || ('HTTP ' + r.status) }; }
});
// 外观：窗口底色随主题（浅色 #f5f7fa / 深色 #0b0d12），避免缩放重绘闪黑
ipcMain.handle('theme:set-window-bg', (e, color) => {
  const v = String(color || '');
  if (/^#[0-9a-fA-F]{6}$/.test(v)) {
    try { const w = windowOfEvent(e); if (w) w.setBackgroundColor(v); } catch (ex) { /* ignore */ }
  }
  return true;
});
require('./scripts/theme-source')(ipcMain);   // 外观三档 → nativeTheme.themeSource（网页版 AI 也要跟着变）
ipcMain.handle('balance:open', () => {
  try { shell.openExternal(BALANCE_PAGE); } catch (e) { /* ignore */ }
  return true;
});

// 模型与提供方：解析**引擎真正在用的配置**
//   ★ 2026-10-15 修：旧版死读 .dsh\settings.yaml，而 0.2.1 起该文件根本不存在
//     ⇒ 弹窗必然显示「当前默认模型 —」「未发现自定义提供方」（用户报的"模型提供方不显示"）。
//   现在改为按**结构**解析（不认行号、不认固定缩进）：
//     · profiles\<名字>\cordis.patch.yml 里任意 `providers:` 块 ⇒ 每个子键一个提供方（含 models 列表）
//     · `- id: agent-default-model` / `agent-default-model:` 块 ⇒ 默认模型
//     · 密钥是否已配 = 环境变量 或 .credentials.yaml 的 refs:（引擎把密钥存这，环境变量里通常没有）
const MODEL_PATCH_FILES = () => {
  const out = [];
  try {
    const base = path.join(DSH_DATA_DIR, 'profiles');
    if (fs.existsSync(base)) {
      const dirs = fs.readdirSync(base).sort((a, b) => {
        if (a === 'web') return -1;
        if (b === 'web') return 1;
        return a.localeCompare(b);
      });
      for (const d of dirs) {
        const p = path.join(base, d, 'cordis.patch.yml');
        if (fs.existsSync(p)) out.push(p);
      }
    }
    const top = path.join(DSH_DATA_DIR, 'cordis.patch.yml');
    if (fs.existsSync(top)) out.push(top);
    if (fs.existsSync(SETTINGS_PATH)) out.push(SETTINGS_PATH);   // 旧引擎口径，留着兼容
  } catch (e) { /* ignore */ }
  return out;
};

function parseModelConfig(text) {
  const providers = [];
  const def = {};
  const lines = String(text).split(/\r?\n/);
  let provIndent = -1;                       // providers: 的缩进，-1 = 不在块里
  let cur = null;
  let inModels = false;
  let inDef = false, defIndent = -1;
  let modelsIndent = -1;
  for (const raw of lines) {
    if (/^\s*#/.test(raw)) continue;
    const line = raw.replace(/\s+#.*$/, '').replace(/\s+$/, '');
    if (!line.trim()) continue;
    const indent = (line.match(/^ */) || [''])[0].length;
    const t = line.trim();
    // 默认模型（三种写法都认：`- id: agent-default-model` ← 当前引擎实际写法 / `agent-default-model:` / `id: ...`）
    if (/^(?:-\s*)?(?:id:\s*)?agent-default-model:?\s*$/.test(t)) {
      inDef = true; defIndent = indent; provIndent = -1; cur = null; inModels = false; modelsIndent = -1; continue;
    }
    if (inDef) {
      if (indent <= defIndent) { inDef = false; }
      else {
        const m = t.match(/^(provider|model|reasoningEffort):\s*(.+)$/);
        if (m) def[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
        continue;
      }
    }
    if (/^providers:\s*$/.test(t)) { provIndent = indent; cur = null; inModels = false; modelsIndent = -1; continue; }
    if (provIndent < 0) continue;
    if (indent <= provIndent) { provIndent = -1; cur = null; inModels = false; modelsIndent = -1; continue; }
    if (indent === provIndent + 2 && /^[A-Za-z0-9_.\-]+:\s*$/.test(t)) {
      cur = { id: t.slice(0, -1), models: [] };
      providers.push(cur); inModels = false; modelsIndent = -1; continue;
    }
    if (!cur) continue;
    if (inModels) {
      if (indent < modelsIndent || (indent === modelsIndent && !t.startsWith('-'))) {
        inModels = false;
        modelsIndent = -1;
      }
    }
    if (inModels) {
      const m = t.match(/^-?\s*id:\s*(.+)$/);
      if (m) cur.models.push(m[1].trim().replace(/^['"]|['"]$/g, ''));
      continue;
    }
    if (/^models:\s*$/.test(t)) { inModels = true; modelsIndent = indent; continue; }
    const m2 = t.match(/^(displayName|apiKeyEnv|api|baseURL):\s*(.+)$/);
    if (m2) cur[m2[1]] = m2[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return { def, providers };
}

ipcMain.handle('models:list', () => {
  const files = MODEL_PATCH_FILES();
  const primaryFile = files.find(f => {
    try {
      const txt = fs.readFileSync(f, 'utf8');
      return /providers:\s*$/m.test(txt) || /agent-default-model/m.test(txt);
    } catch (e) { return false; }
  }) || files[0] || SETTINGS_PATH;
  const out = { settingsPath: primaryFile, default: null, providers: [], sourceFiles: files };
  try {
    // 引擎已登记的密钥名（.credentials.yaml 的 refs: 段）
    const refs = new Set();
    try {
      if (fs.existsSync(CREDENTIALS_PATH)) {
        const ct = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
        for (const l of ct.split(/\r?\n/)) {
          const m = l.match(/^\s{2}([A-Za-z0-9_.\-]+):/);
          if (m) refs.add(m[1]);
        }
      }
    } catch (e) { /* ignore */ }
    const def = {};
    const merged = new Map();
    for (const f of files) {
      let r;
      try { r = parseModelConfig(fs.readFileSync(f, 'utf8')); } catch (e) { continue; }
      Object.assign(def, r.def);
      for (const p of r.providers) {
        const old = merged.get(p.id);
        if (!old) { merged.set(p.id, p); continue; }
        for (const k of Object.keys(p)) {
          if (k === 'models') continue;
          if (p[k]) old[k] = p[k];
        }
        for (const m of p.models) if (old.models.indexOf(m) < 0) old.models.push(m);
      }
    }
    out.default = Object.keys(def).length ? def : null;
    out.providers = Array.from(merged.values()).map(p => ({
      id: p.id,
      displayName: p.displayName || p.id,
      apiKeyEnv: p.apiKeyEnv || null,
      apiKeySet: p.apiKeyEnv ? (!!process.env[p.apiKeyEnv] || refs.has(p.apiKeyEnv)) : false,
      baseURL: p.baseURL || null,
      models: p.models || []
    }));
  } catch (e) { /* ignore */ }
  return out;
});

// ===========================================================================
// 顶栏状态区（2026-10-16 新增：① 上下文压力灯 ② 谁在等我 ③ 快照/回滚）
//   **纯增量**：不动任何现有按钮 / IPC；渲染层在 renderer\topbar-status.js，读不到这组桥就不显示。
//   为什么放主进程：只有这里能读文件、能 spawn 脚本（渲染层没有 fs）。
// ===========================================================================
//   顶栏「记忆」「上下文」两个入口原来按 引擎\.dsh\ 拼，删引擎目录后是死路径：
//   现在统一走 DSH_DATA_DIR（= DSH_HOME，引擎真正在用的数据根）。
const TOPBAR_CTX = path.join(DSH_DATA_DIR, 'skills', 'context-overflow', 'ctx.mjs');
const TOPBAR_MEM = HARNESS_DIR ? path.join(HARNESS_DIR, '场景项目信息') : '';
// ⚠ 2026-11-01：原来是 `scenarios\dsh-gui-context.md`（作者机的 GUI 改造定位卡，本仓库没有）
//   ⇒ 那里读文件必抛异常，「谁在等我」永远是空的。现在改为按身份索引逐个场景的定位卡读，见 topbar:pending。
const TOPBAR_BK = path.join(__dirname, 'data', 'backups');
const TOPBAR_ROOT = path.dirname(__dirname);   // <工作台>

// 跑 node 脚本：本体是 Electron，没有独立 node ⇒ 先试 ELECTRON_RUN_AS_NODE，失败再退回 PATH 上的 node
function topbarRun(script, args, timeout) {
  if (!script) return { ok: false, out: '脚本路径为空（这个入口在本机没有对应的引擎文件）' };
  const tries = [
    { exe: process.execPath, env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }) },
    { exe: 'node', env: process.env }
  ];
  let last = '';
  for (const t of tries) {
    try {
      const r = spawnSync(t.exe, [script].concat(args || []), {
        encoding: 'utf8', windowsHide: true, timeout: timeout || 90000,
        env: t.env, maxBuffer: 16 * 1024 * 1024
      });
      const out = String(r.stdout || '') + String(r.stderr || '');
      if (r.status === 0 && String(r.stdout || '').length) return { ok: true, out: String(r.stdout) };
      last = out || ('exit ' + r.status);
    } catch (e) { last = String((e && e.message) || e); }
  }
  return { ok: false, out: last };
}

// 工作台 10 条常驻会话：sessionId → 属于哪个场景/面板（压力灯用它把裸会话名翻译成"我的哪块面板"）
function topbarWorkbenchSessions() {
  const out = [];
  try {
    const dir = path.join(__dirname, 'scenarios');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue;
      let j = null;
      try { j = applySceneInstance(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), readManifest()); } catch (e) { continue; }
      for (const p of (Array.isArray(j.panels) ? j.panels : [])) {
        if (p && p.sessionId && p.sessionId !== '__待填__') out.push({ scene: j.title || j.id || f, panel: p.title || p.id || '', sessionId: p.sessionId });
      }
    }
  } catch (e) { /* ignore */ }
  return out;
}

// 异步版（压力灯每 90s 刷一次，**必须**用它）：⛔ spawnSync 是同步的，会把主进程连整个窗口的
// IPC/拖拽一起卡住 —— 实测 ctx.mjs --all 要 0.3s，那就是每 90 秒卡 0.3 秒。异步则零感知。
function topbarRunAsync(script, args, timeout) {
  return new Promise((resolve) => {
    const tries = [
      { exe: process.execPath, env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }) },
      { exe: 'node', env: process.env }
    ];
    let last = '';
    const attempt = (i) => {
      if (i >= tries.length) return resolve({ ok: false, out: last });
      const t = tries[i];
      let out = '', settled = false, cp = null;
      try {
        cp = spawn(t.exe, [script].concat(args || []), { windowsHide: true, env: t.env });
      } catch (e) { last = String((e && e.message) || e); return attempt(i + 1); }
      const timer = setTimeout(() => { try { cp.kill(); } catch (e) { /* ignore */ } }, timeout || 120000);
      cp.stdout.on('data', (d) => { out += d; });
      cp.stderr.on('data', (d) => { out += d; });
      cp.on('error', (e) => { if (settled) return; settled = true; clearTimeout(timer); last = String((e && e.message) || e); attempt(i + 1); });
      cp.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0 && out) resolve({ ok: true, out });
        else { last = out || ('exit ' + code); attempt(i + 1); }
      });
    };
    attempt(0);
  });
}

// ⑦ 最近打开的文件夹与系统负载已由 main/system-io.js 统一实现并注入 ipcMain
// ==========================================================================================
// 2026-10-20（宿主：把常用网站的"智能抠图"做成**本地**工具）—— 本地 rembg，图片不出本机。
//   引擎在 <工作台>\工具\抠图\venv（Python + rembg + onnxruntime CPU），模型放同目录 models（U2NET_HOME）。
//   ⚠ 这两条在主进程 ⇒ 加完要**重启一次工作台**才会出现（渲染层会先显示"要重启"提示，不会白屏）。
//   资源纪律：跑一张图起一次进程，算完就退（不常驻）；模型只在第一次用时下载。
// ==========================================================================================
/* 开源版：本地抠图（IPC + Python 引擎）已移除 */
;
ipcMain.handle('topbar:pressure', async () => {
  // 2026-10-16 23:3x 按 dg-dsh 派单：取数由 --all 改成 **--panels** ——
  //   --all 有门控（只列 ≥60%），低压力会话被藏起来 ⇒ 面板/帮手匹配不上，只能显示 —；
  //   --panels 固定列 10 个面板 + 5 个帮手（不管压力高低），且带 role/panel/scene/noData/belowGate。
  const r = await topbarRunAsync(TOPBAR_CTX, ['--panels', '--json'], 120000);
  if (!r.ok) return { ok: false, error: String(r.out).slice(0, 300), rows: [], total: 0, at: Date.now() };
  let arr = null;
  try { arr = JSON.parse(r.out); } catch (e) { return { ok: false, error: 'JSON 解析失败: ' + e.message, rows: [], total: 0, at: Date.now() }; }
  if (!Array.isArray(arr)) return { ok: false, error: 'ctx.mjs 返回的不是数组', rows: [], total: 0, at: Date.now() };
  const map = new Map();
  for (const m of topbarWorkbenchSessions()) map.set(m.sessionId, m);
  // 2026-10-16 晚（按 dg-dsh 的嵌套合同）：{version,note,updated,scenes:[{scene,sceneName,panel,bossSessionId,helpers:[{title,sessionId,since,handover,note}]}]}
  //   ⛔ 不是数组、也不是顶层 {helpers:[…]}。容错：缺 scenes 但有顶层 helpers ⇒ 退化成扁平 + 留一行警告。
  const helperIds = new Set();
  const helperMeta = new Map();
  try {
    const hf = path.join(__dirname, 'data', '助手会话.json');
    if (fs.existsSync(hf)) {
      const hj = JSON.parse(fs.readFileSync(hf, 'utf8'));
      const scenes = Array.isArray(hj && hj.scenes) ? hj.scenes : null;
      const addOne = (h, sceneId, sceneName, panel) => {
        if (!h) return;
        const sid = String(h.sessionId || h.id || '');
        if (!sid) return;
        helperIds.add(sid);
        helperMeta.set(sid, { sceneId: sceneId || '', sceneName: sceneName || '', panel: panel || '',
          title: h.title || h.name || '', since: h.since || '', note: h.note || '' });
      };
      if (scenes) {
        for (const s of scenes) {
          if (!s) continue;
          const sName = s.sceneName || s.scene || '';
          for (const h of (Array.isArray(s.helpers) ? s.helpers : [])) addOne(h, s.scene || '', sName, s.panel || '');
        }
      } else if (Array.isArray(hj && hj.helpers)) {
        log('[助手会话] ⚠ 登记表缺 scenes ⇒ 退化成顶层 helpers 扁平读法（建议用 助手会话.mjs 重写一遍）');
        for (const h of hj.helpers) addOne(h, h.scene || '', h.sceneName || h.scene || '', h.panel || '');
      }
    }
  } catch (e) { log('[助手会话] 登记表读不动：' + ((e && e.message) || e)); }
  const rows = [];
  const seen = new Set();
  for (const x of arr) {
    if (!x || !x.fullId) continue;
    const m = map.get(x.fullId);
    if (!m) continue;                       // 只列工作台自己的会话（全机还有几十条别的）
    seen.add(x.fullId);
    rows.push({
      id: x.id, fullId: x.fullId, title: x.title || '',
      pct: (x.pct === null || x.pct === undefined) ? null : (x.pct || 0),   // noData ⇒ null ⇒ 渲染成 —（别假 0%）
      noData: !!x.noData, belowGate: !!x.belowGate, line: x.line || 0, win: x.win || 0,
      projected: x.projected || 0, turns: x.turns || 0, model: x.model || '', scene: m.scene, panel: m.panel
    });
  }
  rows.sort((a, b) => ((b.pct == null ? -1 : b.pct) - (a.pct == null ? -1 : a.pct)));   // 有数据的在前，—的沉底
  // ctx.mjs 只列"有 projcache 数据"的会话 ⇒ 从没用过/刚建的新会话可能不在里面；明确报出来，别让它静默消失
  const missing = [];
  for (const m of map.values()) if (!seen.has(m.sessionId)) missing.push({ scene: m.scene, panel: m.panel });
  // ① 登记表里的**每一行都要出**（哪怕引擎还没给它建用量数据）⇒ pct 取不到就给 null，渲染成 "—"
  const helpers = [];
  const byId = new Map();
  for (const x of arr) if (x && x.fullId) byId.set(String(x.fullId), x);
  for (const [sid, m] of helperMeta) {
    const x = byId.get(sid) || null;
    helpers.push({
      id: x ? x.id : '', fullId: sid, title: m.title || (x && x.title) || '',
      sceneId: m.sceneId || '', sceneName: m.sceneName || '', panel: m.panel || '',
      since: m.since || '', note: m.note || '',
      pct: x ? (x.pct || 0) : null, line: x ? (x.line || 0) : 0,
      projected: x ? (x.projected || 0) : 0, turns: x ? (x.turns || 0) : 0, model: x ? (x.model || '') : ''
    });
  }  return { ok: true, at: Date.now(), rows, total: arr.length, mine: map.size, missing, helpers, helperReg: helperIds.size };
});

// ② 谁在等我：共用定位卡 §六 未办结行 + 各场景记忆 §〇 的「卡点」
ipcMain.handle('topbar:pending', () => {
  const items = [];
  try {
    // ⚠ 2026-11-01：这里原来只读 `scenarios\dsh-gui-context.md`（作者机专属的"DSH·GUI改造"定位卡，
    //   本仓库从来没有）⇒ readFileSync 必抛，整段被 catch 吞掉，"谁在等我"永远是空列表。
    //   改成读**每个场景自己的定位卡**（身份索引的「定位卡」列是权威表）。
    const cards = [];
    try {
      const idxTxt = fs.readFileSync(path.join(__dirname, 'scenarios', '_场景身份索引.md'), 'utf8');
      for (const line of idxTxt.split(/\r?\n/)) {
        if (!/^\|\s*`/.test(line)) continue;
        const c = line.split('|').map((x) => x.trim());
        const card = (c[6] || '').replace(/`/g, '');
        if (!card) continue;
        const abs = path.join(__dirname, card.replace(/\\/g, '/'));
        if (!cards.includes(abs)) cards.push(abs);
      }
    } catch (e) { /* 没有索引就不出卡点条目 */ }
    for (const cardFile of cards) {
      let t = '';
      try { t = fs.readFileSync(cardFile, 'utf8'); } catch (e) { continue }
      const after = t.split(/\n##\s*六、/)[1];
      const seg = after ? after.split(/\n##\s*七、/)[0] : '';
      for (const line of seg.split(/\r?\n/)) {
        const s = line.trim();
        if (s.charAt(0) !== '|') continue;
        const cells = s.split('|').map((x) => x.trim()).filter((x) => x.length);
        if (cells.length < 4) continue;
        if (/^-+$/.test(cells[0]) || cells[0] === '日期') continue;   // 分隔行与表头行都不算待办
        const status = cells[cells.length - 1];
        if (/^✅/.test(status) || /已办结|已关闭|不用做/.test(status)) continue;   // 只留"真的还没办"的
        items.push({
          kind: 'card', date: cells[0], from: cells[1], status,
          text: cells[2].replace(/\*\*/g, '').replace(/\s+/g, ' ').slice(0, 220), file: cardFile
        });
      }
    }
  } catch (e) { /* ignore */ }
  try {
    // TOPBAR_MEM 为空（公开版没有 引擎\ 这一层）⇒ readdirSync('') 直接抛，这里显式跳过
    for (const d of (TOPBAR_MEM ? fs.readdirSync(TOPBAR_MEM) : [])) {
      const f = path.join(TOPBAR_MEM, d, '项目信息.md');
      if (!fs.existsSync(f)) continue;
      let head = '';
      try {
        const fd = fs.openSync(f, 'r');
        const b = Buffer.alloc(12000);
        const n = fs.readSync(fd, b, 0, b.length, 0);
        fs.closeSync(fd);
        head = b.slice(0, n).toString('utf8');
      } catch (e) { continue; }
      const m = head.match(/卡点[：:]\s*([^\n\r]{2,200})/);
      if (m) items.push({ kind: 'scene', date: '', from: d, status: '卡点', text: m[1].replace(/\*\*/g, '').trim(), file: f });
    }
  } catch (e) { /* ignore */ }
  return { ok: true, at: Date.now(), items };
});

// ③ 快照：列最近 12 份 / 立即打一份 / 回滚到指定那份（回滚前弹原生确认框）
ipcMain.handle('topbar:snapshots', () => {
  try {
    const names = fs.readdirSync(TOPBAR_BK)
      .filter((n) => n.indexOf('gui-') === 0 && fs.statSync(path.join(TOPBAR_BK, n)).isDirectory());
    const rows = names.map((n) => ({ name: n, at: fs.statSync(path.join(TOPBAR_BK, n)).mtimeMs, pre: n.indexOf('gui-prerestore-') === 0 }))
      .sort((a, b) => b.at - a.at);
    return { ok: true, dir: TOPBAR_BK, rows: rows.slice(0, 5), total: rows.length };
  } catch (e) { return { ok: false, error: String((e && e.message) || e), rows: [], total: 0, dir: TOPBAR_BK }; }
});
ipcMain.handle('topbar:snapshot', () => {
  const r = topbarRun(path.join(__dirname, 'scripts', 'backup-gui.mjs'), [], 180000);
  const out = String(r.out || '');
  const m = out.match(/快照完成[:：]\s*(.+)/);
  return { ok: r.ok, name: m ? m[1].trim() : null, error: r.ok ? null : out.slice(0, 300) };
});
ipcMain.handle('topbar:restore', (e, name) => {
  const n = String(name || '');
  if (!/^gui-[A-Za-z0-9._-]+$/.test(n)) return { ok: false, error: '快照名不合法' };
  if (!fs.existsSync(path.join(TOPBAR_BK, n))) return { ok: false, error: '找不到这个快照：' + n };
  let go = false;
  try {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const opt = {
      type: 'warning', buttons: ['回到这个界面', '取消'], defaultId: 1, cancelId: 1,
      title: '界面回退',
      message: '回到界面版本 ' + n + ' ？',
      detail: '只覆盖工作台的界面与脚本源码（main.js / preload.js / renderer\\ / scenarios\\ / scripts\\）。'
        + '回退前会先用当前界面记一份 gui-prerestore-*，还能再回来；不动数据和对话。'
    };
    go = (win ? dialog.showMessageBoxSync(win, opt) : dialog.showMessageBoxSync(opt)) === 0;
  } catch (err) { go = false; }
  if (!go) return { ok: false, error: '已取消' };
  const r = topbarRun(path.join(__dirname, 'scripts', 'restore-gui.mjs'), [n], 240000);
  const tail = String(r.out || '').trim().split(/\r?\n/).slice(-5).join(' | ');
  return { ok: r.ok, error: r.ok ? null : tail.slice(0, 400), out: tail.slice(0, 600) };
});
ipcMain.handle('topbar:engine-status', () => {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'engine-good', 'meta.json'), 'utf8'));
    return { ok: true, meta };
  } catch (e) { return { ok: false, error: '还没有“正常点”（先打一份）', meta: null }; }
});
ipcMain.handle('topbar:engine-snapshot', () => {
  const tool = path.join(TOPBAR_ROOT, '工具', '引擎快照.mjs');
  if (!fs.existsSync(tool)) return { ok: false, error: '找不到 工具\\引擎快照.mjs' };
  const r = topbarRun(tool, ['--save'], 120000);
  return { ok: r.ok, out: String(r.out || '').slice(0, 500), error: r.ok ? null : String(r.out || '').slice(0, 300) };
});
ipcMain.handle('topbar:engine-restore', () => {
  const tool = path.join(TOPBAR_ROOT, '工具', '引擎快照.mjs');
  if (!fs.existsSync(tool)) return { ok: false, error: '找不到 工具\\引擎快照.mjs' };
  let go = false;
  try {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const opt = {
      type: 'warning', buttons: ['回到上次正常配置', '取消'], defaultId: 1, cancelId: 1,
      title: '引擎回退', message: '回到上次能正常启动的引擎配置？',
      detail: '只回退 17 个启动配置（cordis.patch.yml / settings / 插件接线），不碰源码与构建产物。\n'
        + '回退前会把当前配置另存到 data\\engine-good\\pre-restore-*。回退后请重启工作台。'
    };
    go = (win ? dialog.showMessageBoxSync(win, opt) : dialog.showMessageBoxSync(opt)) === 0;
  } catch (err) { go = false; }
  if (!go) return { ok: false, error: '已取消' };
  const r = topbarRun(tool, ['--restore', '--yes'], 120000);
  return { ok: r.ok, out: String(r.out || '').slice(0, 600), error: r.ok ? null : String(r.out || '').slice(0, 400) };
});
// ===== 2026-10-24（宿主）：「引擎回退也能记录，上限 5 份」 =====
// 工具（工具\引擎快照.mjs）早就支持多代（--list / --restore-gen），这里只把清单翻译成结构化数据给界面。
ipcMain.handle('topbar:engine-gens', () => {
  const tool = path.join(TOPBAR_ROOT, '工具', '引擎快照.mjs');
  if (!fs.existsSync(tool)) return { ok: false, error: '找不到 工具\\引擎快照.mjs', rows: [] };
  const r = topbarRun(tool, ['--list'], 20000);
  const rows = [];
  String(r.out || '').split(/\r?\n/).forEach((ln) => {
    // 形如：- gen-20261023175458 · 2026-10-23 17:54:58 · 引擎 0.2.1-rc.2 · HEAD 687f282e
    const m = ln.match(/^-\s*(gen-\d+)\s*·\s*([^·]*?)\s*·\s*引擎\s*([^·]*?)\s*·\s*HEAD\s*(\S*)/);
    if (m) rows.push({ gen: m[1].trim(), at: m[2].trim(), ver: m[3].trim(), head: m[4].trim() });
  });
  return { ok: r.ok, rows: rows.slice(0, 5), error: r.ok ? null : String(r.out || '').slice(0, 300) };
});
ipcMain.handle('topbar:engine-restore-gen', (e, gen) => {
  const g = String(gen || '');
  if (!/^gen-\d{8,}$/.test(g)) return { ok: false, error: '这一代的编号不合法：' + g };
  const tool = path.join(TOPBAR_ROOT, '工具', '引擎快照.mjs');
  if (!fs.existsSync(tool)) return { ok: false, error: '找不到 工具\\引擎快照.mjs' };
  let go = false;
  try {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const opt = {
      type: 'warning', buttons: ['回到这一代配置', '取消'], defaultId: 1, cancelId: 1,
      title: '引擎回退（指定代）',
      message: '回到引擎配置 ' + g + ' ？',
      detail: '只回退启动配置（不碰源码与构建产物）。\n回退前会把当前配置另存到 data\\engine-good\\pre-restore-*。\n回退后请重启工作台。'
    };
    go = (win ? dialog.showMessageBoxSync(win, opt) : dialog.showMessageBoxSync(opt)) === 0;
  } catch (err) { go = false; }
  if (!go) return { ok: false, error: '已取消' };
  const r = topbarRun(tool, ['--restore-gen', g, '--yes'], 120000);
  return { ok: r.ok, out: String(r.out || '').slice(0, 600), error: r.ok ? null : String(r.out || '').slice(0, 400) };
});

// ===== 2026-10-24（宿主）：「升级中途不小心关闭 ⇒ 自动回滚到上次正常」 =====
// 每次启动先落一枚"这次开过、还没正常退出"的哨（clean:false）；正常退出时改写成 clean:true。
// 下次启动若发现上次 clean:false（崩溃 / 被强关 / 升级中途关掉），60 秒后探一次引擎：
//   · 引擎起来了  → 什么都不做；
//   · 引擎没起来 且 有"正常点" → 自动 引擎快照.mjs --restore --yes，并给界面推一条 toast。
// ⛔ 只回「启动配置」，不碰源码/构建产物（源码坏了要走 git，这个工具做不到，也不该自动做）。
const GUARD_FILE = path.join(__dirname, 'data', 'start-guard.json');
function readGuard() { try { return JSON.parse(fs.readFileSync(GUARD_FILE, 'utf8')); } catch (e) { return null; } }
function writeGuard(obj) { try { fs.writeFileSync(GUARD_FILE, JSON.stringify(obj, null, 2) + '\n', 'utf8'); } catch (e) { /* ignore */ } }
function engineLastGood() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'engine-good', 'meta.json'), 'utf8'));
    return (m && m.savedAt) ? m : null;
  } catch (e) { return null; }
}
async function guardCheckAfterBoot() {
  const prev = readGuard();
  writeGuard({ clean: false, at: Date.now(), pid: process.pid, appVersion: app.getVersion(), note: '开机登记' });
  if (!prev || prev.clean !== false) return;                 // 上次是正常退出
  const good = engineLastGood();
  log('[guard] 上次没正常退出（' + (prev.at ? new Date(prev.at).toLocaleString() : '?') + '）⇒ 60 秒后查引擎');
  await sleep(60000);
  let up = false;
  try { up = await probe(); } catch (e) { up = false; }
  if (up) { log('[guard] 引擎正常，不做回退'); writeGuard({ clean: false, at: Date.now(), pid: process.pid, note: '引擎正常' }); return; }
  if (!good) { log('[guard] 引擎没起来，但还没有"正常点"，无法自动回退'); return; }
  const tool = path.join(TOPBAR_ROOT, '工具', '引擎快照.mjs');
  let ok = false;
  try {
    const r = topbarRun(tool, ['--restore', '--yes'], 120000);
    ok = !!(r && r.ok);
    log('[guard] 自动回退引擎配置 ' + (ok ? '成功' : '失败') + '：' + String((r && r.out) || '').slice(0, 200));
  } catch (e) { log('[guard] 自动回退异常：' + ((e && e.message) || e)); }
  writeGuard({ clean: false, at: Date.now(), pid: process.pid, autoRolledBack: { at: Date.now(), ok, to: good.savedAt } });
  try {
    broadcast('topbar:toast', {
      text: ok ? ('上次没正常退出、引擎也没起来 ⇒ 已自动回到 ' + good.savedAt + ' 的配置，请重启一次工作台')
               : '上次没正常退出、引擎也没起来，自动回退没成功 —— 看 server.log 或手动「引擎回退」',
      bad: !ok, ms: 20000
    });
  } catch (e2) { /* ignore */ }
}

ipcMain.handle('tools:catalog', () => inventory.readToolCatalog());
ipcMain.handle('topbar:open', (e, p) => {
  const f = path.resolve(String(p || ''));
  if (f.indexOf(TOPBAR_ROOT) !== 0) return { ok: false, error: '只允许打开项目根目录里的文件' };   // 白名单：别让它变成任意路径打开器
  try { shell.openPath(f); return { ok: true }; } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

// 选股器秒开：直接返回本地缓存的最近一次全市场排名（不发网络请求）
ipcMain.handle('stock:market:rankCached', (e, type) => stockStore.latestRank(type));

// ---- 窗口控制（自定义标题栏用）----
// ★按发起方寻址★：分离窗口上的按钮必须动它自己 —— 若仍用 mainWindow，
// 分离窗口点「关闭」会把主窗口关掉（= 整个应用退出），是这套功能里最危险的坑。
// 2026-10-20（宿主报「点最小化没反应」）—— 实测：**Electron 最大化态下 win.minimize() 偶发无效**
//   （点击到、IPC 也 resolve，但窗口不 iconic；Win32 SW_MINIMIZE 却能；unmaximize 后再 minimize 就正常）。
//   这里加一层兜底：先 minimize，300ms 后还是没最小化 ⇒ 先 unmaximize + minimize，并记住"本来是最大化"，
//   恢复（restore）时再 maximize 回去。日志写 server.log，便于以后核对。
ipcMain.handle('window:minimize', (e) => {
  const w = windowOfEvent(e) || mainWindow;
  if (!w) { log('[win] minimize: 没有窗口'); return { ok: false, err: 'no-window' }; }
  let wasMax = false;
  try { wasMax = w.isMaximized(); w.minimize(); } catch (err) {
    log('[win] minimize 抛错: ' + ((err && err.message) || err));
    return { ok: false, err: String((err && err.message) || err) };
  }
  setTimeout(function () {
    try {
      if (w.isMinimized()) {
        log('[win] minimize ok（wasMax=' + wasMax + '）');
        return;
      }
      if (!wasMax) { log('[win] minimize 之后仍未最小化（非最大化态） visible=' + w.isVisible()); return; }
      log('[win] minimize 在最大化态无效 ⇒ 退回 unmaximize + minimize');
      try {
        w.unmaximize();
        w.minimize();
        w.once('restore', function () { try { w.maximize(); } catch (e3) { /* ignore */ } });
      } catch (e2) { log('[win] 兜底也失败: ' + ((e2 && e2.message) || e2)); }
    } catch (e) { /* ignore */ }
  }, 300);
  return { ok: true };
});
ipcMain.handle('window:toggle-maximize', (e) => {
  const w = windowOfEvent(e) || mainWindow;
  if (!w) return false;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
  return w.isMaximized();
});
ipcMain.handle('window:is-maximized', (e) => { const w = windowOfEvent(e) || mainWindow; return !!w && w.isMaximized(); });
ipcMain.handle('window:close', (e) => { const w = windowOfEvent(e) || mainWindow; if (w) w.close(); });

// ---- 多窗口（场景分离）：我是谁 / 开场景窗口 / 关自己 / 哪些场景已分离 ----
ipcMain.handle('window:info', (e) => {
  const w = windowOfEvent(e);
  const isMain = !w || w.kunRole !== 'scene';
  return {
    role: isMain ? 'main' : 'scene',
    isMain: isMain,
    scene: (w && w.kunScene) || '',
    sceneName: (w && w.kunScene) ? sceneNameOf(w.kunScene) : '',
    maximized: !!w && w.isMaximized(),
    detached: detachedSceneIds()
  };
});
ipcMain.handle('window:scenes', () => detachedSceneIds());
ipcMain.handle('window:open-scene', (e, sceneId) => openSceneWindow(sceneId));
ipcMain.handle('window:close-self', (e) => { const w = windowOfEvent(e); if (w) w.close(); return { ok: true }; });

// ---- 启动页 IPC：当前进度快照 / 失败后重试 ----
ipcMain.handle('boot:state', () => lastBoot);
let bootRunning = false;
ipcMain.handle('boot:retry', async () => {
  if (bootRunning) return { ok: false, err: '正在启动中，请稍候' };
  bootRunning = true;
  try {
    const ok = await startServer();
    if (ok) broadcast('harness:ready');   // 所有窗口都要知道引擎就绪（分离窗口也要开始加载 webview）
    return { ok: ok };
  } catch (e) {
    sendBoot({ stage: 'error', pct: 100, text: '重试失败', detail: (e && e.message) || String(e) });
    return { ok: false, err: (e && e.message) || String(e) };
  } finally {
    bootRunning = false;
  }
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', function () {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(async function () {
  // 【已移除】任务栏角标（原来显示"当前窗口数"）：2026-10-15 按用户要求删除。
  //   原因：这台机器上 Windows 的徽章层会压过应用自画的叠加图标（TaskbarBadges=1 时永远显示系统的「1」），
  //   而关掉系统徽章后应用叠加图标也一并不显示 ⇒ 「角标 = 窗口数」在 Windows 这一层做不到 ✗。
  //   想数窗口时：鼠标悬停任务栏那颗按钮，Windows 会弹出各窗口的缩略图 ✓（详见 项目信息.md §47 补3）。
    // 启动流程整体兜底：任何一步抛错都不会变成"静默打不开"——
    // 先尽力保证有一个可见窗口，再弹一次错误提示（含日志路径与回滚方法）。
    loadWinLayout();   // 上次退出时的窗口布局：主窗口位置 + 分离出去的场景窗口
    try {
      createWindow({ isMain: true, saved: layoutCache.main });
    } catch (err) {
      reportFatal('创建主窗口失败', err);
      try { createWindow({ isMain: true }); } catch (e2) { reportFatal('重试创建主窗口仍失败', e2); }
    }
    memGuard.installWebviewWatchdog({ app: app, webContents: webContents, log: log });   // 跑飞的 webview 自动重载
    // 恢复上次分离出去的场景窗口（场景 json 可能已被删 → 校验后只开仍然存在的）
    try {
      const known = listScenarios().map(function (s) { return s.id; });
      Object.keys(layoutCache.detached).forEach(function (sid) {
        if (known.indexOf(sid) < 0) { delete layoutCache.detached[sid]; return; }
        try { createWindow({ scene: sid, saved: layoutCache.detached[sid] }); }
        catch (e) { log('[win] 恢复场景窗口失败 ' + sid + ': ' + ((e && e.message) || e)); }
      });
    } catch (err) { log('[win] 恢复场景窗口异常: ' + ((err && err.message) || err)); }
    try {
      startSiteServer();   // 个人站场景：官网静态服务（独立于 Harness）
    } catch (err) { reportFatal('启动本地静态服务失败', err); }
    try {
      startBalancePoll();  // 余额实时显示：每 10s 拉取 DeepSeek 平台余额
    } catch (err) { reportFatal('启动余额轮询失败', err); }
    // 2026-11-04：清理临时残留（先按数量收敛 session scratch，再按时间清老的）
    try { memGuard.purgeOldTemp(log, 1); memGuard.pruneWorkspaceChanges(log, 2); } catch (err) { /* ignore */ }
    let ok = false;
    try {
      ok = await startServer();
    } catch (err) {
      reportFatal('启动 Harness 引擎失败', err);
      ok = false;
    }
    if (!ok) {
      // 不再弹框退出：保留窗口，由首屏加载页显示失败态与「重试」（进度条不会空白）
      log('startServer failed — 保留窗口，等待用户重试');
      return;
    }
    log('[boot] 引擎就绪总耗时 ' + ((Date.now() - APP_T0) / 1000).toFixed(1) + 's');
    // 通知渲染层：Harness 已就绪（所有窗口的 webview 都可以加载了）
    try {
      broadcast('harness:ready');
    } catch (err) { log('[boot] 通知渲染层失败: ' + ((err && err.message) || err)); }
    // 2026-10-24：升级/崩溃保险 —— 后台跑，引擎 60 秒没起来就自动回退（不阻塞启动）
    guardCheckAfterBoot().catch(function (e) { log('[guard] 检查自身失败：' + ((e && e.message) || e)); });
  }).catch(function (err) {
    reportFatal('whenReady 启动链失败', err);
  });
  app.on('window-all-closed', function () {
    killServer();
    stopBlenderCapture();
    app.quit();
  });
  app.on('before-quit', function () {
    quitRequested = true;      // 保留"下次恢复"的布局：整体退出 ≠ 用户关掉某个场景窗口
    // 2026-10-24：正常退出 ⇒ 给保险哨子盖章（下次启动不会误判成"升级中途被关掉"）
    try { writeGuard({ clean: true, at: Date.now(), pid: process.pid }); } catch (e) { /* ignore */ }
    try { saveWinLayout(); } catch (e) { /* ignore */ }
    // 2026-11-08 P1：私有 token 通道的退出清理（只删本进程写的，pid 校验）
    try { clearEngineEndpoint(); } catch (e) { /* ignore */ }
    releaseBlenderEmbedSync();
    killServer();
    stopBlenderCapture();
  });
}

// ===== 内置网页版 AI 桥：让任何会话/脚本能“免费问顶栏那 5 个网页版”（2026-09-21 第 10 轮）=====
// 需求：会话想省钱 / API 额度用完时，把活儿外包给免费网页版（DeepSeek·豆包·通义·智谱·Kimi）。
// 链路：脚本 → POST http://127.0.0.1:31239/webai/ask → broadcast('webai:task')
//      → 渲染层 renderer\webai-bridge.js 在对应 <webview> 里输入问题、等回答 → IPC webai:done → 回包。
// 为什么这么绕：会话（引擎侧）只会跑命令，进程外只有 HTTP 进得来；而网页版是**渲染层**的 <webview>
//   （partition=persist:webai-<key>，登录态在那儿），主进程碰不到它的 DOM —— 所以必须借渲染层的手。
// 安全：只监听 127.0.0.1，不对外；claim 机制保证多窗口时只有一个窗口干活（不会问两遍）。
const WEB_AI_PORT = Number(process.env.WEB_AI_PORT || 31239);
const WEB_AI_KEYS = [
  { key: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/' },
  { key: 'doubao', name: '豆包', url: 'https://www.doubao.com/chat/' },
  { key: 'tongyi', name: '千问', url: 'https://www.qianwen.com/' },   // 2026-11-01 品牌改名，老地址只剩跳转
  { key: 'chatglm', name: '智谱清言', url: 'https://chatglm.cn/main/alltoolsdetail' },
  { key: 'kimi', name: 'Kimi', url: 'https://www.kimi.com/' }
];   // ⚠ 这份表必须和 renderer\renderers.js 的 WEB_AI 一致（check-gui.mjs 会比对）
const webAiPending = new Map();
let webAiSeq = 0;
let lastFocusedWin = null;      // 由 createWindow 的 focus 事件维护（见上面那段注释：为什么必须定向派发）
// ★多窗口安全（v3.17，2026-09-23）★
// 每个窗口都是**独立一整套壳**（自带 preload + 渲染器 + 一份 webai-bridge.js），而分离窗口那份桥
// 只在它自己那次加载/⟳ 时才更新 —— 用户分屏常驻时它可能很久都是旧代码。旧桥的判正文逻辑是老的，
// 抢到活就把正文切错（实测：菜单墙 / 页脚 / 上一轮内容，现象像"你刚改的判据坏了"，能白查一整轮）。
// 所以派发**必须挑窗口**，三道闸：
//   闸 1：窗口加载完（did-finish-load）问一次它的桥版本；只挑**版本相等**的 ⇒ 旧桥窗口直接出局。
//   闸 2：抢单必须来自派发目标。闸 3：交卷也必须来自派发目标（旧桥不一定申报）。
const WEB_AI_BRIDGE_MIN = '3.17';               // 桥的**最低**可用版本（真正的派活基准见 WEB_AI_WANT）
const webAiWinVer = new Map();                  // webContents.id → { ver, title }
// ★2026-09-26★ 派活基准改成**动态 = 见过的最新桥版本**。
//   原来拿上面那个常量判等 ⇒ 桥一升版（今天 3.17→3.24），所有新窗口都被判成"旧桥、不再派活"，
//   现象却是"`[[peek]]` 偶尔能通、一打字必失败"，查了半天才发现是这儿 ⇒ 桥升级不该再改主进程。
let WEB_AI_WANT = WEB_AI_BRIDGE_MIN;
function webAiVerNum(v) { return String(v || '').split('.').map(function (x) { return parseInt(x, 10) || 0; }); }
function webAiVerGt(a, b) {
  const x = webAiVerNum(a), y = webAiVerNum(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return false;
}
// 派发目标：**主窗口优先**（用户 2026-09-23 定的口径：分屏时以主窗口为基准）→ 聚焦 → 最后聚焦 → 任意
// 为什么不再"聚焦优先"：分屏时焦点常在别的场景窗口上，任务就被派给那份可能很旧的桥了。
function webAiTargetWindow() {
  const E = require('electron').BrowserWindow;
  const alive = function (w) { return w && !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed(); };
  const ready = function (w) {
    if (!alive(w)) return false;
    const rec = webAiWinVer.get(w.webContents.id);
    return !!rec && rec.ver === WEB_AI_WANT;   // 没申报 / 不是最新版 = 不派（基准是动态的最新版）
  };
  const cands = [mainWindow, E.getFocusedWindow(), lastFocusedWin];
  const all = E.getAllWindows().filter(alive);
  for (let i = 0; i < all.length; i++) cands.push(all[i]);
  for (let i = 0; i < cands.length; i++) if (ready(cands[i])) return cands[i];
  // 一个都没申报（比如刚启动还在加载）：退回旧口径，让闸 2/闸 3 去挡 —— 总比"没窗口可用"强
  for (let i = 0; i < cands.length; i++) if (alive(cands[i])) return cands[i];
  return null;
}
function webAiAsk(key, text, opts) {
  return new Promise(function (resolve) {
    const k = String(key || '').trim();
    const known = WEB_AI_KEYS.map(function (s) { return s.key; });
    if (known.indexOf(k) < 0) { resolve({ ok: false, key: k, err: '不认识的 key：' + k + '（可用：' + known.join(' / ') + '）' }); return; }
    const t = String(text || '');
    if (!t.trim()) { resolve({ ok: false, key: k, err: '问题是空的' }); return; }
    const target = webAiTargetWindow();
    if (!target) { resolve({ ok: false, key: k, err: '工作台窗口还没起来（GUI 正在启动？）' }); return; }
    const targetId = target.webContents.id;
    const targetTitle = (function () { try { return target.getTitle(); } catch (e) { return ''; } })();
    const id = 'w' + (++webAiSeq) + '-' + Date.now().toString(36);
    const timeoutMs = Math.max(5000, Math.min(600000, Number((opts && opts.timeoutMs) || 180000)));
    const timer = setTimeout(function () {
      if (!webAiPending.has(id)) return;
      webAiPending.delete(id);
      resolve({ ok: false, id: id, key: k, err: '超时（' + Math.round(timeoutMs / 1000) + 's）：网页版没回完话，或那个窗口没在跑' });
    }, timeoutMs + 8000);
    webAiPending.set(id, { id: id, key: k, text: t, t0: Date.now(), resolve: resolve, timer: timer, claimed: false, winId: targetId, winTitle: targetTitle });
    try { target.webContents.send('webai:task', { id: id, key: k, text: t, timeoutMs: timeoutMs }); }
    catch (e) {
      clearTimeout(timer); webAiPending.delete(id);
      resolve({ ok: false, key: k, err: '派发失败：' + String((e && e.message) || e) });
      return;
    }
    // 日志里带上窗口标题：多窗口时这一行就是"谁在抢单"的铁证
    log('[webai] → ' + k + ' 任务 ' + id + '（' + t.slice(0, 24) + '…）→ 窗口「' + targetTitle + '」');
  });
}
ipcMain.handle('webai:ask', function (e, key, text, opts) { return webAiAsk(key, text, opts); });
ipcMain.handle('webai:claim', function (e, id) {
  const t = webAiPending.get(String(id || ''));
  if (!t || t.claimed) return false;          // 只有一个窗口能抢到
  // 只认派发目标的抢单：旧版桥（别的窗口）就算收到了也不让它接活
  if (t.winId && e.sender.id !== t.winId) {
    log('[webai] ⛔ 忽略抢单：窗口 id ' + e.sender.id + ' ≠ 目标 ' + t.winId +
      '（那是**旧桥**，正文可能被切错；关掉那个窗口再重开、或点它上面的 ⟳）');
    return false;
  }
  t.claimed = true; t.winId = e.sender.id;
  return true;
});
// 窗口加载完就来申报自己的桥版本 ⇒ 派发时只挑"版本相等"的窗口（旧桥窗口直接出局，不用等它抢单才发现）
ipcMain.handle('webai:bridge', function (e, ver) {
  const E = require('electron').BrowserWindow;
  const w = E.fromWebContents(e.sender);
  let title = '';
  try { title = w ? w.getTitle() : ''; } catch (x) { }
  const v = String(ver || '?');
  const prev = webAiWinVer.get(e.sender.id);
  webAiWinVer.set(e.sender.id, { ver: v, title: title });
  if (webAiVerGt(v, WEB_AI_WANT)) WEB_AI_WANT = v;   // ★动态基准：谁报得比基准新，以后就派给这个版本
  const isMain = !!w && w === mainWindow;
  if (!prev || prev.ver !== v) {
    log('[webai] 窗口申报桥版本 v' + v + (isMain ? '（主窗口）' : '（场景窗口）') + '：' + title +
      (v === WEB_AI_WANT ? ' ✓' : ' ⚠ 低于当前基准 v' + WEB_AI_WANT + ' ⇒ 不派活给它（点它的 ⟳ 或关掉重开）'));
  }
  return { ver: v, want: WEB_AI_WANT, ok: v === WEB_AI_WANT, isMain: isMain };
});
// 体检用：谁申报了什么版本、当前会派给谁 —— 排障时一条命令看清，不用靠猜
ipcMain.handle('webai:who', function () {
  const E = require('electron').BrowserWindow;
  const list = [];
  webAiWinVer.forEach(function (rec, id) { list.push({ id: id, ver: rec.ver, title: rec.title, ok: rec.ver === WEB_AI_WANT }); });
  const t = webAiTargetWindow();
  let tTitle = ''; try { tTitle = t ? t.getTitle() : ''; } catch (e) { }
  return { want: WEB_AI_WANT, windows: list, target: tTitle, pending: webAiPending.size };
});
ipcMain.handle('webai:done', function (e, id, r) {
  const t = webAiPending.get(String(id || ''));
  if (!t) return false;
  // 闸 3：交卷也必须来自派发目标 —— 旧桥可能压根不申报、直接干完就交（那就把它的结果扔掉）
  if (t.winId && e.sender.id !== t.winId) {
    log('[webai] ⛔ 忽略交卷：窗口 id ' + e.sender.id + ' ≠ 目标 ' + t.winId + '（旧桥给的结果不可信，已丢弃）');
    return false;
  }
  clearTimeout(t.timer);
  webAiPending.delete(t.id);
  log('[webai] ← ' + t.key + ' 任务 ' + t.id + '：' + (r && r.ok ? '成功 ' + String((r && r.text) || '').length + ' 字' : '失败 ' + ((r && r.err) || '')));
  t.resolve(Object.assign({ id: t.id, key: t.key, elapsedMs: Date.now() - t.t0 }, r || {}));
  return true;
});
ipcMain.handle('webai:state', function () {
  return {
    port: WEB_AI_PORT,
    keys: WEB_AI_KEYS.map(function (s) { return s.key; }),
    pending: Array.from(webAiPending.values()).map(function (t) {
      return { id: t.id, key: t.key, claimed: t.claimed, ageMs: Date.now() - t.t0, winTitle: t.winTitle || '', text: t.text.slice(0, 40) };
    })
  };
});
let agentGateway = null;
try { agentGateway = require('./main/agent-gateway.js'); } catch (e) { }
// MCP Streamable HTTP face（2026-11-08 P1）：单端点 POST /mcp。它是 ESM ⇒ 主进程这侧用动态 import；
// 加载失败只影响 /mcp，不影响 /v1 与 /webai（日志里能看见原因）。
let mcpHttpFace = null;
try {
  const { pathToFileURL } = require('url');
  import(pathToFileURL(path.join(__dirname, 'scripts', 'mcp-http.mjs')).href)
    .then(function (m) { mcpHttpFace = m; log('[mcp] Streamable HTTP face 已就绪（POST /mcp）'); })
    .catch(function (e) { log('[mcp] face 加载失败（已忽略，不影响其它端点）：' + (e && e.message ? e.message : String(e))); });
} catch (e) {
  log('[mcp] face 装载异常（已忽略）：' + (e && e.message ? e.message : String(e)));
}
const webAiServer = http.createServer(function (req, res) {
  if (mcpHttpFace && mcpHttpFace.handle(req, res)) return;
  if (agentGateway && agentGateway.handle(req, res)) return;
  const json = function (code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  const u = (req.url || '/').split('?')[0];
  if (u === '/webai/keys' && req.method === 'GET') { json(200, { keys: WEB_AI_KEYS }); return; }
  if (u === '/webai/state' && req.method === 'GET') {
    json(200, {
      port: WEB_AI_PORT,
      pending: Array.from(webAiPending.values()).map(function (t) { return { id: t.id, key: t.key, claimed: t.claimed, ageMs: Date.now() - t.t0 }; })
    });
    return;
  }
  // 排障：谁申报了哪个版本的桥、现在会派给哪个窗口（= 分屏/多窗口时"到底谁在答"，一条命令看清）
  if (u === '/webai/who' && req.method === 'GET') {
    const E = require('electron').BrowserWindow;
    const list = [];
    webAiWinVer.forEach(function (rec, id) { list.push({ id: id, ver: rec.ver, title: rec.title, ok: rec.ver === WEB_AI_WANT }); });
    const t = webAiTargetWindow();
    let tTitle = ''; try { tTitle = t ? t.getTitle() : ''; } catch (e) { }
    json(200, { want: WEB_AI_WANT, windows: list, target: tTitle, stale: list.filter(function (x) { return !x.ok; }).length });
    return;
  }
  if (u === '/webai/ask') {
    if (req.method !== 'POST') { json(405, { ok: false, err: '这个端点要用 POST' }); return; }
    let body = '';
    req.on('data', function (c) { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async function () {
      let p = null;
      try { p = JSON.parse(body || '{}'); } catch (e) { json(400, { ok: false, err: '请求体不是 JSON' }); return; }
      const r = await webAiAsk(p.key, p.text, p);
      json(r.ok ? 200 : 502, r);
    });
    return;
  }
  // 站点健康探针（2026-11-08 P1「probe 常态化」）：只看不派（桥的 `[[peek]]` 分支不往页面打字），
  //   返回该站 webview 的真实现状（浅 DOM/shadow DOM/iframe 字数、输入框候选、当前地址）。
  //   用途：出站失败时先跑它，5 秒内分清"页面卡死 / 没登录 / 站点改版 / 输入框不在"，不用靠猜。
  if (u === '/webai/probe') {
    if (req.method !== 'POST') { json(405, { ok: false, err: '这个端点要用 POST' }); return; }
    let body = '';
    req.on('data', function (c) { body += c; if (body.length > 2e5) req.destroy(); });
    req.on('end', async function () {
      let p = null;
      try { p = JSON.parse(body || '{}'); } catch (e) { json(400, { ok: false, err: '请求体不是 JSON' }); return; }
      const key = String((p && p.key) || '').trim();
      if (!key) { json(400, { ok: false, err: '缺少 key（' + WEB_AI_KEYS.map(function (s) { return s.key; }).join('/') + '）' }); return; }
      const r = await webAiAsk(key, '[[peek]]', { timeoutMs: 20000, peek: true });
      json(r.ok ? 200 : 502, r);
    });
    return;
  }
  json(404, { ok: false, err: '没有这个端点', endpoints: ['GET /webai/keys', 'GET /webai/state', 'GET /webai/who', 'POST /webai/ask {key,text,timeoutMs}', 'POST /webai/probe {key}'] });
});
webAiServer.on('error', function (e) { log('[webai] 桥服务起不来（端口 ' + WEB_AI_PORT + '）：' + e.message); });
// ===== 自动更新挂载（官方 apps/desktop 能力搬迁 ② · 2026-09-26）=====
// 独立模块 updater.js：未打包（源码直跑）时静默待命、默认不自动安装、全部错误吞掉 ⇒ 不影响现有使用。
// 会话入口：node scripts\检查更新.mjs [state|check|install|config]
let updaterHandle = null;
try {
  updaterHandle = require('./updater.js').install({ log: log });
} catch (e) {
  log('[updater] 挂载失败（已忽略，不影响使用）：' + (e && e.message ? e.message : String(e)));
}
// ===== 版本策略 / 强制更新挂载（官方 apps/desktop 能力搬迁 ④ 的另一半 · 2026-09-26）=====
// 独立模块 scripts/mandatory-update.js：策略来自 data\version-policy.json；命中弹内联 HTML 模态提示窗。
// ★ 刻意做成**软提示**（可"稍后"），只有策略显式 hardBlock 才不可关 —— 不锁工作台、不影响任何场景。
// 会话入口：node scripts\强制更新.mjs [state|设 <最低版本> [--hard]|清]
try {
  require('./scripts/mandatory-update.js').install({
    log: log,
    checkNow: updaterHandle && typeof updaterHandle.checkNow === 'function' ? updaterHandle.checkNow : null,
  });
} catch (e) {
  log('[强制更新] 挂载失败（已忽略，不影响使用）：' + (e && e.message ? e.message : String(e)));
}

// ===== 原生浏览器侧栏挂载（官方 apps/desktop 能力搬迁 ③ · 2026-09-26）=====
// 独立模块 scripts/sidebar.js：WebContentsView 贴到主窗口 contentView（官方 platform-view.ts 同款做法）。
// ★ 未 attach 时对工作台零影响；不碰场景 json / sessionId / 渲染层注入。
// 会话入口：node scripts\浏览器侧栏.mjs [open|close|url|bounds|state]
try {
  require('./scripts/sidebar.js').install({ log: log });
} catch (e) {
  log('[sidebar] 挂载失败（已忽略，不影响使用）：' + (e && e.message ? e.message : String(e)));
}

// ===== 崩溃上报 + 版本策略挂载（官方 apps/desktop 能力搬迁 ④ · 2026-09-26）=====
// 独立模块 crash.js：本地崩溃转储（不上传）+ 主进程异常流水 data\crash-log.jsonl + 版本策略 data\version-policy.json。
// 全部 try/catch 吞掉 ⇒ 记不下来也不影响使用；不弹窗、不拦启动。
try {
  require('./crash.js').install({ log: log, appendLog: function (m) { try { log(m) } catch (e) {} } });
} catch (e) {
  log('[crash] 挂载失败（已忽略，不影响使用）：' + (e && e.message ? e.message : String(e)));
}

// ===== 外部刷新通道（2026-09-26 立；AI 会话自助刷新，不再让用户手点 ⟳）=====
// 背景：工作台是「零构建 + 单文件渲染器 + ⟳ 热更」，而 ⟳ 以前只能人手点 ⇒ 每次改完 renderer 都要用户动手。
// 现在：任何进程写 data/reload-panels.cmd（内容 all 或场景 id）⇒ 本进程 500ms 内重载匹配的 webview 面板。
// 会话用法：node scripts\刷新面板.mjs all
const RELOAD_CMD = path.join(__dirname, 'data', 'reload-panels.cmd');
// 2026-10-16：顶栏状态区文件的"版本哨"——启动时先记一份 mtime，之后只要它变了就把主窗口整页重载一次
// （不这样记，第一条刷新命令只会"记录"、第二条才重载，白等一轮）。
try { global.__dshTopbarMtime = fs.statSync(path.join(__dirname, 'renderer', 'topbar-status.js')).mtimeMs; }
catch (e) { global.__dshTopbarMtime = undefined; }
setInterval(function () {
  try {
    if (!fs.existsSync(RELOAD_CMD)) return;
    var target = String(fs.readFileSync(RELOAD_CMD, 'utf8')).trim() || 'all';
    fs.unlinkSync(RELOAD_CMD);
    var views = webContents.getAllWebContents().filter(function (wc) {
      try { return wc.getType() === 'webview' && !wc.isDestroyed(); } catch (e) { return false; }
    });
    var hit = target === 'all' ? views : views.filter(function (wc) {
      try { var u = String(wc.getURL()); return u.indexOf(target) >= 0 || u.indexOf(encodeURIComponent(target)) >= 0; } catch (e) { return false; }
    });
    hit.forEach(function (wc) { try { wc.reload(); } catch (e) {} });

    // 2026-10-16 补（界面侧）：顶栏状态区 `renderer\topbar-status.js` 是靠 index.html 的 <script> 加载的，
    //   而下面那条"主窗口热更新"只 executeJavaScript(reloadScene()) ⇒ **不会重新执行页面脚本** ⇒ 改了它主窗口永远不变
    //   （当天实测：连改 4 轮、顶栏一动不动，全是这个原因）。
    //   办法：记一份它的 mtime，**只有它变了**才整页重载主窗口；其余情况照旧走 reloadScene（不打扰 Harness 对话）。
    try {
      var tf = path.join(__dirname, 'renderer', 'topbar-status.js');
      var tm = fs.statSync(tf).mtimeMs;
      if (global.__dshTopbarMtime === undefined) {
        global.__dshTopbarMtime = tm;
      } else if (global.__dshTopbarMtime !== tm) {
        global.__dshTopbarMtime = tm;
        log('[reload-panels] topbar-status.js 变了 ⇒ 整页重载主窗口（让它重新执行）');
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reloadIgnoringCache();
      }
    } catch (e) { /* ignore */ }

    // 2026-09-27 补：<客户> OA 这类「同页 div 面板」不是 webview，上面那条重载碰不到它们。
    // 再让窗口跑一次它自己的热更新（重灌带时间戳的 renderers.js，**不重载页面** ⇒ Harness 对话不断）。
    // 2026-09-29 修：以前只热更新 mainWindow ⇒ 跑在**独立场景窗口**里的面板永远刷不到
    //   （主窗口对"已分离"的场景只画一张占位卡然后 return，所以 renderer 改动在那边全都不生效——
    //    当天就撞上：改了 renderers.js，独立窗口里的「我的分析助手」既不换标题也没有新页签）。
    //   现在按 target 选窗口：场景 id ⇒ 该场景的独立窗口 + 主窗口（主窗口自己判断要不要重建，currentTab 是渲染层状态）；
    //   all ⇒ 所有窗口。**不顺手重建无关窗口**——那会把别的窗口里的 AI 面板一起重建。
    try {
      var js = '(function(){try{ if (typeof reloadScene === "function") { reloadScene(); return "ok"; }'
        + ' if (window.__dshReloadScene) { window.__dshReloadScene(); return "ok-hook"; } return "no-fn"; }'
        + 'catch(e){ return "err:" + ((e && e.message) || e); }})()';
      var wins = allWindows();
      var targets = wins.filter(function (w) {
        if (target === 'all') return true;
        if (w === mainWindow) return true;                    // 主窗口的重建交给它自己的 reloadScene
        try { return String(w.kunScene || '') === target; } catch (e) { return false; }
      });
      targets.forEach(function (w) {
        var tag;
        try { tag = (w === mainWindow) ? '主窗口' : ('独立窗口[' + (w.kunScene || '') + ']'); } catch (e) { tag = '窗口'; }
        w.webContents.executeJavaScript(js).then(function (r) {
          log('[reload-panels] ' + tag + ' 热更新结果: ' + r);
          // 2026-09-27：CSP 是 script-src 'self'（无 unsafe-eval）⇒ eval 这条路随时可能被挡，
          // 一旦够不着（no-fn / err:…）就退回整页重载：不依赖 eval、不依赖动态插 script，必然读到新 renderers.js。
          if (r === 'no-fn' || String(r).indexOf('err:') === 0) {
            log('[reload-panels] ' + tag + ' 热更新够不着 ⇒ 整页重载该窗口');
            try { w.webContents.reloadIgnoringCache(); } catch (e2) { /* ignore */ }
          }
        }).catch(function (e) {
          log('[reload-panels] ' + tag + ' executeJavaScript 被拒（多半是 CSP）⇒ 整页重载该窗口: ' + ((e && e.message) || e));
          try { w.webContents.reloadIgnoringCache(); } catch (e2) { /* ignore */ }
        });
      });
      log('[reload-panels] 同页面板热更新窗口: ' + targets.length + '/' + wins.length + ' 个');
    } catch (e) { /* 窗口没了也不致命 */ }
    log('[reload-panels] ' + target + ' ⇒ 重载 ' + hit.length + '/' + views.length + ' 个面板');
  } catch (e) { /* 命令文件忙/损坏都不致命，下一轮再试 */ }
}, 500);

webAiServer.listen(WEB_AI_PORT, '127.0.0.1', function () {
  log('[webai] 网页版 AI 桥已就绪: http://127.0.0.1:' + WEB_AI_PORT + '/webai/keys（会话可用 scripts\\webai.mjs 问免费网页版）');
});