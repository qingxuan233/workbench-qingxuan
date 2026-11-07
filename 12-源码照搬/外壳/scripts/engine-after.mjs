#!/usr/bin/env node
// engine-after.mjs —— 升完引擎之后的核对（会话入口；check-gui 第 11 节也会跑它）
//
//   node 外壳\scripts\engine-after.mjs              # 只报告，不写文件（check-gui 用它，必须无副作用）
//   node 外壳\scripts\engine-after.mjs --save       # 同上一份，另把结论落成 data\engine-after-<时间>.json
//   node 外壳\scripts\engine-after.mjs --dry-gui    # 演练「源码直跑」分支（强制当作没有内置引擎），不必真去删 引擎\ 目录
//
// 换代后工作台最容易坏的四件事，这里一次查完：
//   ① 产物配套：CLI 构建产物在不在（引擎有没有 build 过）
//   ② 上游锚点：壳依赖的那批 DOM/接口标记还在不在（引擎换版第一杀手；清单见 ANCHORS，现 10 条）
//   ③ 插件接线：插件目录/清单还在不在（工作台默认 0 个插件，但结构得对）
//   ④ 数据目录 + 适配版本：会话库在哪、壳声明的适配版本与引擎实际版本是否一致
//
// ★★★ 三态契约（2026-11-07 定稿，改这个脚本请先读这段）★★★
//   一个"核对脚本"只要跑得出「通过」，就有人在看它的时候以为**适配验证过了**。所以这里把结论显式分成三态：
//
//   exit 0 = 通过（VERIFIED）
//       有内置 引擎\ 目录，ANCHORS 里每一条的判据**全部**满足，且版本一致 ⇒ 适配确实被核对过。
//   exit 3 = 跳过（SKIPPED · 未验证）
//       没有内置 引擎\ 目录（本公开副本就是这种形态）。①③ 两类核对无从下手，② 的**源码扫描**
//       也做不了 ⇒ **本机 GUI 适配未经验证**。要拿证据只有两条路：
//         a) 在带内置 引擎\ 的克隆里再跑本脚本（exit 0 才算数）；
//         b) 人工照 _本机产物/优化报告/DSH内核兼容.md 的「锚点有效性核查表」对着引擎安装目录复核（只读）。
//       （GUI 内运行时 DOM 探针评估过，本轮**没做**——理由与成本写在报告「运行时替代验证」一节。）
//   exit 1 = 失败（FAILED）
//       锚点缺失 / 产物缺失 / 适配版本与锚点结论不符 / 引擎版本低于已声明的适配版本。
//
//   为什么跳过要单独一个非 0 码：以前跳过也是 0，于是「跑过了、退出码 0」被当成「通过了」，
//   而 GUI 的品牌区又照着 ADAPTED_ENGINE 亮绿灯 —— 两头一凑就是这个仓库里的"假验证闭环"。
//   现在 0 只有一种含义：**锚点真的被逐条核对过并且都在**。
//
// ★ 关于「外部引擎」：源码直跑形态下引擎由 dsh CLI 提供（工作台.json 的 engine.cliPath / DSH_CMD /
//   PATH 里的 dsh），**不在本仓库里**。以前这里对"外面那个引擎"一句不问，连版本都不读。
//   现在会：探测到外部 CLI ⇒ 读它的版本 ⇒ 与 ADAPTED_ENGINE 比对（早就该做的一步，成本 0）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUI = path.resolve(HERE, '..');            // …\外壳
const ROOT = path.resolve(GUI, '..');            // …\12-源码照搬
const DATA = path.join(GUI, 'data');
const ARGV = process.argv.slice(2);
const SAVE = ARGV.includes('--save');
const JSON_MODE = ARGV.includes('--json');        // 最后一行输出机器可读 JSON（给 check-gui.mjs 这类消费方）
const DRY_GUI = ARGV.includes('--dry-gui');      // 演练源码直跑分支（GITHUB 上 clone 的人没有 引擎\，也能自查这段逻辑）

const EXIT_VERIFIED = 0;
const EXIT_FAILED = 1;
const EXIT_SKIPPED = 3;

let fails = 0, warns = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { fails++; console.log('  ✗ ' + m); };
const warn = (m) => { warns++; console.log('  ! ' + m); };
const head = (m) => console.log('\n== ' + m + ' ==');

// ---------- 找内置引擎目录：与 main.js 同一套推导 ----------
function engineDir() {
  if (DRY_GUI) return '';
  const cands = [
    path.join(ROOT, '引擎'),
    path.join(ROOT, '..', '引擎'),
  ];
  for (const c of cands) { try { if (fs.statSync(c).isDirectory()) return c; } catch (e) { /* ignore */ } }
  return '';
}
const ENG = engineDir();
console.log('引擎核对 · ' + GUI);
console.log('引擎目录：' + (ENG || '（没有内置引擎 ⇒ 源码直跑，用外部 CLI）' + (DRY_GUI ? '（--dry-gui 演练）' : '')));

// ---------- 壳自己声明的适配版本 ----------
function adaptedVersion() {
  try {
    const s = fs.readFileSync(path.join(GUI, 'renderer', 'renderers.js'), 'utf8');
    const m = s.match(/var ADAPTED_ENGINE\s*=\s*'([^']+)'/);
    return m ? m[1] : '';
  } catch (e) { return ''; }
}
const ADAPTED = adaptedVersion();

// ---------- 上游锚点表（壳真正依赖的东西 · 现 10 条） ----------
// ★2026-11-07 逐个对过 0.2.2-rc.1 的真实产物（只读 app.asar 全文扫描）★，改了两处，**证据都写在这里**：
//
//  ① data-side：引擎里确实有，但**取值只有 left / right**，没有 "sidebar"/"details"。
//     直接证据（app.asar 里的 JSX 原文）：
//       return ["left", "right"].map((side) => jsx(WidthHandle, { side, onStart, onDrag, onCommit, onEnd }, side));
//     以及 `"data-side": props.side, "data-width-handle": props.side`（挂在 ConversationRoot…widthHandle 上）。
//     所以锚点判据从"出现 data-side 这几个字"收紧成"**left 与 right 两个取值都出现**"——
//     以前只要引擎里还有 `data-sidebar-*` 这种无关属性就会误判为命中。
//     ⚠ 壳侧对应选择器是 main.js:1122 / renderers.js:5846 的 `[data-side="sidebar"]`，它在这版引擎上**选不中任何元素**
//     （选择器合法、不报错 ⇒ 静默失效）。壳自己的 renderers.js:6009 也记过同一件事。那两处归架构任务改，这里只负责"能查出来"。
//
//  ② 工作区存储：旧锚点是文件名 `workspace.json`，在 0.2.2-rc.1 里 **0 处命中**（它是壳自己 `sessions.mjs:352` 的读法，
//     不是引擎的产物名）⇒ 属于**过时锚点**，删掉。换成引擎这边真实存在、且壳也真依赖的两条：
//       · `dsh.sessions.current`：壳的"钉会话直达通道"读写的 localStorage 键（引擎 `createSnapshotStore(…, { persist: { name: "dsh.sessions.current" } })`）
//       · `conversation.chat.flow`：引擎给对话流插的 display:contents DOM 锚点（`[data-slot="conversation.chat.flow"]`）
//     另把 `data-width-handle` 单列成锚点：壳的藏列逻辑直接依赖它（`f.querySelectorAll('[data-side="sidebar"], …, [data-width-handle]')`）。
const ANCHORS = [
  // 判据 = 下面每个 needle 都**全部**出现（needles 之间是 AND；一个 anchor 的 needles 就是它的完整判据）
  { name: '对话列手柄 data-side = left/right', needles: ['"left", "right"', 'data-width-handle'],
    note: '取值只有 left/right；[data-side="sidebar"]/[data-side="details"] 这版引擎不存在' },
  { name: '手柄属性 data-width-handle', needles: ['data-width-handle'],
    note: '藏列逻辑直接按它选元素' },
  { name: '对话流 data-chat-flow', needles: ['data-chat-flow'] },
  { name: '对话流插槽 conversation.chat.flow', needles: ['conversation.chat.flow'],
    note: '引擎给对话流插的 display:contents DOM 锚点（[data-slot="conversation.chat.flow"]）' },
  { name: '会话选中态 dsh.sessions.current', needles: ['dsh.sessions.current'],
    note: 'localStorage 键；壳的钉会话直达通道靠它' },
  { name: '状态标记 data-phase', needles: ['data-phase'],
    note: '是连接状态小圆点，不是会话相位容器（壳已按此改，别再拿它当相位锚点）' },
  { name: '布局网格 grid-template-columns', needles: ['grid-template-columns'] },
  { name: '会话创建 session/create', needles: ['session/create'] },
  { name: '会话改名 session/rename', needles: ['session/rename'] },
  { name: '会话缓存 session_projcache', needles: ['session_projcache'] },
];

// ---------- 外部引擎探测（源码直跑形态用）：与 engine-guard.js 同一套顺序，但**只读**版本 ----------
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return null; }
}
function findExternalCli() {
  const cands = [];
  const mf = readJson(path.join(ROOT, '工作台.json'));
  if (mf && mf.engine && mf.engine.cliPath) cands.push({ from: '工作台.json engine.cliPath', p: mf.engine.cliPath });
  if (process.env.DSH_CMD) cands.push({ from: 'DSH_CMD', p: process.env.DSH_CMD });
  try {
    const out = execFileSync('where.exe', ['dsh'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 });
    for (const line of String(out).split(/\r?\n/)) {
      const t = line.trim();
      if (t) cands.push({ from: 'where dsh', p: t });
    }
  } catch (e) { /* PATH 里没有 */ }
  const localApp = process.env.LOCALAPPDATA;
  if (localApp) cands.push({ from: 'LOCALAPPDATA 常见目录', p: path.join(localApp, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd') });
  const progFiles = process.env.ProgramFiles;
  if (progFiles) cands.push({ from: 'ProgramFiles 常见目录', p: path.join(progFiles, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd') });
  for (const c of cands) { try { if (fs.statSync(c.p).isFile()) return c; } catch (e) { /* ignore */ } }
  return null;
}
// 唯一的数据来源是 dsh CLI 自己：`dsh --version`。
// 调用姿势（都只是"取一个数"，不涉及写盘）：
//   ① cmd.exe /c <cli> --version —— 常规做法
//   ② 无 shell 直接跑 .cmd —— 某些环境 shell:true 会被拒
//   ③ 从 dsh.cmd 里解析出 Electron 可执行文件与入口 js、设 ELECTRON_RUN_AS_NODE 直跑 —— 完全不经过 cmd.exe
// 退出码不看：即便 CLI 以非 0 退出，只要 stdout 里有版本号就采信。
// 全跑不动（常见于沙箱策略禁止 spawn 子进程：EPERM）⇒ 返回 ''，由调用方说清"版本未知"，绝不猜。
//
// ⚠ 2026-11-07 实测：Electron 的策略**不是**"json 输出里带版本"。下面是真实拿到的几组输出，别想当然：
//   dsh --version                          → 0.2.2-rc.1                      ← 只有一个版本号
//   dsh config get toolbox --json          → {"value":[{"id":"deepseek"…}]}  ← 工具清单，不含版本
//   dsh extensions list --json             → {"schemaVersion":1,"models":{…},"providers":{…}}
//   dsh --help                             → Usage: dsh <command> …
//   dsh status --json                      → {"profile":{…},"home":{…}}    ← 也不含版本
// 唯一稳定带版本的机器可读位置是 `<安装目录>\resources\runtime\primary-runtime\runtime.json` 的
// desktopVersion；符号链接指向的是 CLI 导出前缀，不是版本。
function cliVersion(cliPath) {
  const VER_RE = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/;
  const attempts = [];
  attempts.push({ cmd: 'cmd.exe', args: ['/c', cliPath, '--version'] });
  attempts.push({ cmd: cliPath, args: ['--version'] });
  // ③ 从 dsh.cmd 里解析出 Electron 可执行文件与入口脚本（路径是相对 %~dp0 的，直接 path.resolve 即可）
  try {
    const text = fs.readFileSync(cliPath, 'utf8');
    const exeM = text.match(/"([^"]*\.exe)"/i);
    const jsM = text.match(/"([^"]*%[~]*dp0[^"]*?\.(?:js|cjs|mjs))"/i) || text.match(/"([^"]*?\.(?:js|cjs|mjs))"/i);
    if (exeM && jsM) {
      const dir = path.dirname(cliPath);
      const strip = (s) => s.replace(/%~dp0[\\/]?/gi, '').replace(/%dp0%[\\/]?/gi, '');
      const entry = path.resolve(dir, strip(jsM[1]));
      const exe = path.resolve(dir, strip(exeM[1]));
      if (fs.existsSync(exe) && fs.existsSync(entry)) attempts.push({ cmd: exe, args: ['--expose-internals', entry, '--version'], env: { ELECTRON_RUN_AS_NODE: '1' } });
    }
  } catch (e) { /* 不是能解析的 .cmd，跳过这条 */ }
  for (const a of attempts) {
    let out = '';
    try {
      const opt = Object.assign({ encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }, a.env ? { env: Object.assign({}, process.env, a.env) } : {});
      out = String(execFileSync(a.cmd, a.args, opt) || '');
    } catch (e) {
      // 非 0 退出 / EPERM 时 error.stdout 里可能仍有内容
      out = String((e && (e.stdout || (e.output && e.output[1]))) || '');
    }
    const m = out.match(VER_RE);
    if (m) return m[1];
  }
  return '';
}
// 语义化版本比较：只比 "x.y.z" 主体，预发布后缀按字符串比（够用：rc.N / beta.N / 无后缀）
function cmpVersion(a, b) {
  const pa = String(a).split('-');
  const pb = String(b).split('-');
  const na = pa[0].split('.').map((x) => parseInt(x, 10) || 0);
  const nb = pb[0].split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((na[i] || 0) !== (nb[i] || 0)) return (na[i] || 0) < (nb[i] || 0) ? -1 : 1;
  }
  const sa = pa[1] || '';
  const sb = pb[1] || '';
  if (sa === sb) return 0;
  if (!sa) return 1;          // 无后缀 = 正式版，比任何预发布大
  if (!sb) return -1;
  return sa < sb ? -1 : 1;
}

// ---------- 运行时 DOM 探针的落盘结果（可选外部工具写，这里只读） ----------
// ⚠ 2026-11-07：本仓库**没有**随附探针（评估结论：GUI 内探针要开 CDP/引依赖，且 2 条锚点在页面 DOM 里不存在，
//   见 _本机产物/优化报告/DSH内核兼容.md「运行时替代验证」）。这里只做**兼容读取**：若有人自己在 GUI 里做了探针、
//   把结果按 `data\anchor-probe-*.json` + `{anchors:[{hit:true}…]}` 的格式落盘，本脚本会认。
//   没人产出就如实说"没有记录"，不影响 SKIPPED 的结论。
function latestProbe() {
  let names = [];
  try { names = fs.readdirSync(DATA).filter((f) => /^anchor-probe-.*\.json$/.test(f)); } catch (e) { return null; }
  if (!names.length) return null;
  names.sort();
  const f = names[names.length - 1];
  const rec = readJson(path.join(DATA, f));
  return rec ? { file: f, rec } : null;
}

// ---------- 源码直跑分支：诚实的三态 ----------
if (!ENG) {
  head('①③ 产物配套 / 插件接线：跳过（没有内置引擎目录）');
  console.log('  这套是「源码直跑 + 外部引擎」：引擎由 dsh CLI 提供，不在本仓库里 ⇒ 这两类核对无从下手。');
  console.log('  壳侧结构由 scripts\\check-gui.mjs 负责；会话与面板由 sessions.mjs --check 负责。');

  // ② 锚点：源码扫描做不了
  const probe = latestProbe();
  head('② 上游锚点（' + ANCHORS.length + ' 条）：源码扫描跳过' + (probe ? ' · 有外部探针记录' : ''));
  let probeState = 'none';
  if (probe) {
    const r = probe.rec;
    const total = Array.isArray(r.anchors) ? r.anchors.length : 0;
    const hit = Array.isArray(r.anchors) ? r.anchors.filter((a) => a && a.hit).length : 0;
    console.log('  · 外部探针记录：data\\' + probe.file + '（' + (r.at || '?') + ' · 引擎 ' + (r.engineVersion || '未知') + '）');
    if (total && hit === total) { probeState = 'all'; ok('探针：' + hit + '/' + total + ' 个标记在 GUI 里实测存在'); }
    else if (total) { probeState = 'partial'; warn('探针：只有 ' + hit + '/' + total + ' 个标记实测存在 ⇒ 缺的那几个在 0.2.2-rc.1 上失效'); }
    else { probeState = 'none'; console.log('  · 探针文件里没有 anchors 数组（旧格式），当没有'); }
  }
  if (probeState === 'all') {
    console.log('  · 但这**不等于**锚点契约通过：探针只证明"DOM 标记在"，不证明"壳对这些标记的用法还对"。');
  } else {
    for (const a of ANCHORS) console.log('    · ' + a.name + ' —— 未验证' + (a.note ? '（' + a.note + '）' : ''));
  }

  head('仍然核对的项');
  if (ADAPTED) ok('壳声明的适配引擎版本：' + ADAPTED + '（引擎换版后请同步这一行）');
  else warn('renderers.js 里没找到 ADAPTED_ENGINE');

  // ★ 外部引擎版本：以前完全没查过（源码直跑形态就只打印一句"不适用"）
  let extVer = '';
  const ext = findExternalCli();
  if (ext) {
    extVer = cliVersion(ext.p);
    ok('外部引擎 CLI：' + ext.p + '（来源：' + ext.from + '）');
    if (extVer) ok('外部引擎版本：' + extVer);
    // 版本取不到就直说"未知"，不猜、不默认与 ADAPTED 一致
    else warn('外部引擎版本：**未知**（' + ext.p + ' 的 --version 跑不动 ⇒ 无法比对 ADAPTED_ENGINE，这一项按未验证处理）');
  } else {
    warn('没探测到外部引擎 CLI（DSH_CMD / where dsh / 常见目录都没有）⇒ AI 面板不可用（见 AGENTS §5-3）');
  }
  if (ADAPTED && extVer) {
    const c = cmpVersion(extVer, ADAPTED);
    if (c === 0) ok('适配版本声明 = 实际引擎版本：' + ADAPTED + '（**只证明版号对得上，不证明锚点验证过**）');
    else if (c > 0) bad('引擎 ' + extVer + ' **高于**壳声明的适配版本 ' + ADAPTED +
      ' ⇒ 壳依赖的 DOM/接口很可能已经变了：按 _本机产物/优化报告/DSH内核兼容.md 的核查表复核锚点，再决定要不要改 ADAPTED_ENGINE');
    else warn('引擎 ' + extVer + ' 低于壳声明的适配版本 ' + ADAPTED + ' ⇒ 壳声明的是"更新的引擎"，本机却在跑旧版，请核对安装');
  }

  const dsh = path.join(ROOT, '引擎数据', '.dsh');
  if (fs.existsSync(dsh)) ok('引擎数据目录在：' + path.relative(ROOT, dsh));
  else warn('没有 引擎数据\\.dsh（跑一次「启动工作台」或 工具\\初始化.mjs 会建）');

  console.log('\n----------------------------------------------------');
  if (JSON_MODE) {
    // 给 check-gui.mjs 这类"消费方"用的机器可读结论：它们必须能区分"跳过"和"通过"，
    // 否则又会退回到"引擎一项都没核，整份检查却全绿"的老毛病。
    console.log(JSON.stringify({
      verdict: 'skipped', exit: fails ? EXIT_FAILED : EXIT_SKIPPED,
      adapted: ADAPTED, externalCli: ext ? ext.p : '', externalVersion: extVer,
      probe: probe ? { file: probe.file, state: probeState } : null, fails, warns,
    }));
    process.exit(fails ? EXIT_FAILED : EXIT_SKIPPED);
  }
  // 「跳过」必须**自己说出来**：不再用「不适用（0 失败）」这种读起来像通过的话
  console.log('结论：SKIPPED · 未验证（exit ' + EXIT_SKIPPED + '）' + (fails ? ' · 但发现 ' + fails + ' 个 FAIL' : '') + (warns ? ' · ' + warns + ' 个提醒' : ''));
  console.log('  ⇒ 跳过（无内置引擎）：本机 GUI 适配**未经验证**。产物配套 / 锚点源码扫描 / 插件接线三类核对一项都没跑。');
  console.log('  ⇒ 这不是失败，也**不是通过**。要拿到证据，二选一：');
  console.log('     1) 带内置 引擎\\ 的克隆里跑本脚本（会逐条扫 ' + ANCHORS.length + ' 条锚点，全在才 exit 0）；');
  console.log('     2) 人工按 _本机产物/优化报告/DSH内核兼容.md 的「锚点有效性核查表」对着引擎安装目录复核（只读）。');
  if (SAVE) {
    const at = new Date().toISOString();
    const out = path.join(DATA, 'engine-after-' + at.replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-') + '.json');
    try {
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(out, JSON.stringify({
        at, verdict: 'skipped', mode: '源码直跑（外部引擎）', engineDir: null,
        adapted: ADAPTED, externalCli: ext ? ext.p : '', externalVersion: extVer,
        probe: probe ? { file: probe.file, state: probeState } : null,
        anchors: ANCHORS.map((a) => ({ name: a.name, checked: false })),
        fails, warns,
      }, null, 1), 'utf8');
      console.log('  ✔ 已写 data\\' + path.basename(out) + '（结论 skipped，别把它当"验证通过"的存档）');
    } catch (e) { console.log('  ! 写存档失败：' + (e && e.message)); }
  }
  process.exit(fails ? EXIT_FAILED : EXIT_SKIPPED);
}

// ---------- ① 产物配套 ----------
head('① 产物配套（引擎 build 过没有）');
const cliCands = [
  path.join(ENG, 'apps', 'cli', 'lib', 'bin.js'),
  path.join(ENG, 'apps', 'cli', 'dist', 'bin.js'),
  path.join(ENG, 'packages', 'cli', 'lib', 'bin.js'),
];
const cli = cliCands.find((p) => fs.existsSync(p));
if (cli) ok('CLI 入口：' + path.relative(ENG, cli));
else bad('找不到 CLI 构建产物（apps\\cli\\lib\\bin.js）⇒ 先 pnpm run build');

const engPkg = path.join(ENG, 'package.json');
let engVer = '';
try { engVer = String(JSON.parse(fs.readFileSync(engPkg, 'utf8')).version || ''); } catch (e) { warn('读不到引擎 package.json'); }
if (engVer) ok('引擎版本：' + engVer);

// ---------- ② 上游锚点 ----------
head('② 上游锚点（壳依赖的 DOM/接口标记 · ' + ANCHORS.length + ' 条）');

// 扫引擎源码/产物（跳过 node_modules 与大文件，限时限量）
function collectTextFiles(dirs, cap = 4000) {
  const out = [];
  const skip = new Set(['node_modules', '.git', 'dist-cache', 'coverage', '.turbo']);
  const walk = (d, depth) => {
    if (out.length >= cap || depth > 8) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (out.length >= cap) return;
      if (skip.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!/\.(js|mjs|cjs|ts|tsx|jsx|css|html|json|yml|yaml)$/i.test(e.name)) continue;
      try { if (fs.statSync(p).size > 2 * 1024 * 1024) continue; } catch (err) { continue; }
      out.push(p);
    }
  };
  for (const d of dirs) { try { if (fs.statSync(d).isDirectory()) walk(d, 0); } catch (e) { /* ignore */ } }
  return out;
}
const scanDirs = [path.join(ENG, 'apps'), path.join(ENG, 'packages'), path.join(ENG, 'web'), path.join(ROOT, '引擎数据', '.dsh', 'profiles')];
const files = collectTextFiles(scanDirs);
console.log('  （扫了 ' + files.length + ' 个文本文件）');
const anchorResults = [];
for (const a of ANCHORS) {
  // 判据是 AND：一个锚点的 needles **全部**出现才算命中（以前是 OR，导致 `data-sidebar-*` 这种无关属性也能"命中 data-side"）
  const left = new Set(a.needles);
  const firstFile = new Map();
  for (const f of files) {
    if (!left.size) break;
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    for (const n of [...left]) {
      if (txt.includes(n)) { left.delete(n); if (!firstFile.has(n)) firstFile.set(n, f); }
    }
  }
  const miss = [...left];
  const hit = miss.length === 0;
  const where = hit ? path.relative(ENG, firstFile.get(a.needles[0])) : '';
  anchorResults.push({ name: a.name, checked: true, hit, file: where, needles: a.needles, missing: miss });
  if (hit) ok(a.name + '  → ' + where);
  else bad(a.name + ' 找不到（缺：' + miss.join(' / ') + '）⇒ 引擎换版了：先看 renderer\\renderers.js 里对应的选择器再改壳');
}
const anchorsOk = anchorResults.every((r) => r.hit);

// ---------- ③ 插件接线 ----------
head('③ 插件接线');
const pluginDirs = [path.join(ROOT, '插件'), path.join(ENG, '插件'), path.join(ROOT, '引擎数据', '.dsh', 'plugins')];
const found = pluginDirs.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } });
if (!found.length) warn('没有插件目录（公开副本默认 0 个插件，正常；装了插件才需要有）');
else for (const d of found) {
  let n = 0;
  try { n = fs.readdirSync(d).filter((x) => !x.startsWith('.')).length; } catch (e) { n = -1; }
  ok('插件目录 ' + path.relative(ROOT, d) + '：' + n + ' 项');
}

// ---------- ④ 数据目录 + 适配版本 ----------
head('④ 数据目录与适配版本');
const dshHome = path.join(ROOT, '引擎数据', '.dsh');
if (fs.existsSync(dshHome)) ok('引擎数据：' + path.relative(ROOT, dshHome));
else bad('引擎数据\\.dsh 不存在 ⇒ 会话/工作区都会重建为空（先跑 工具\\初始化.mjs）');
if (ADAPTED && engVer) {
  const c = cmpVersion(engVer, ADAPTED);
  if (c === 0) ok('适配版本一致：' + ADAPTED);
  else if (c > 0) {
    // 锚点全过也不能自动宣布"适配"：锚点是必要条件，不是充分条件
    if (anchorsOk) warn('引擎 ' + engVer + ' 高于壳声明的适配版本 ' + ADAPTED + '，但锚点全部满足 ⇒ 可以升级 ADAPTED_ENGINE，升级后请再走一遍面板/钉会话/藏列实测');
    else bad('引擎 ' + engVer + ' 高于壳声明的适配版本 ' + ADAPTED + '，且上面有锚点缺失 ⇒ 壳已与引擎脱节，先补壳再改版本号');
  } else warn('引擎 ' + engVer + ' 低于壳声明的适配版本 ' + ADAPTED + ' ⇒ 壳声明的是"更新的引擎"，本机却在跑旧版，请核对安装');
}
// git HEAD（有 git 才有意义）
try {
  const gitHead = execFileSync('git', ['-C', ENG, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', timeout: 20000 }).trim();
  if (gitHead) ok('引擎 HEAD：' + gitHead);
} catch (e) { warn('引擎目录不是 git 仓库（或没有 git），跳过 HEAD'); }

// ---------- 结论 ----------
const verified = fails === 0 && anchorsOk && !!cli;
console.log('\n----------------------------------------------------');
if (JSON_MODE) {
  console.log(JSON.stringify({
    verdict: verified ? 'verified' : 'failed', exit: verified ? EXIT_VERIFIED : EXIT_FAILED,
    mode: '内置引擎', engineDir: ENG, adapted: ADAPTED, engineVersion: engVer,
    anchors: anchorResults, fails, warns,
  }));
  process.exit(verified ? EXIT_VERIFIED : EXIT_FAILED);
}
if (verified) {
  console.log('结论：VERIFIED · 通过（exit ' + EXIT_VERIFIED + '）· ' + anchorResults.length + ' 条锚点全部在引擎里找到' + (warns ? ' · ' + warns + ' 个提醒' : ''));
  console.log('  这句 output 才能被引用成"锚点验证过"。');
} else {
  console.log('结论：FAILED · 失败（exit ' + EXIT_FAILED + '）· ' + fails + ' 个 FAIL、' + warns + ' 个 warning');
}
if (SAVE) {
  const at = new Date().toISOString();
  const out = path.join(DATA, 'engine-after-' + at.replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-') + '.json');
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(out, JSON.stringify({
      at, verdict: verified ? 'verified' : 'failed', mode: '内置引擎', engineDir: ENG,
      adapted: ADAPTED, engineVersion: engVer, cli: cli ? path.relative(ENG, cli) : '',
      anchors: anchorResults, fails, warns,
    }, null, 1), 'utf8');
    console.log('  ✔ 已写 data\\' + path.basename(out));
  } catch (e) { console.log('  ! 写存档失败：' + (e && e.message)); }
}
process.exit(verified ? EXIT_VERIFIED : EXIT_FAILED);
