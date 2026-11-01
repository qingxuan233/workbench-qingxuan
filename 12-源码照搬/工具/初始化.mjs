#!/usr/bin/env node
/**
 * 初始化.mjs —— 把「照搬过来的模板」变成「这台机器上干净可用的实例」
 *
 * 为什么需要它：
 *   直接拷贝过来的工作台带着上一台机器的**状态**——会话、工作区、projcache、
 *   server.log（里面有引擎 token）、上一台机器的 .credentials.yaml，以及
 *   指向作者机绝对路径的配置。这些东西不会让程序崩，只会让新机器"看起来能用、
 *   实际在用别人的残留"。本脚本把它们清干净，并把真值重新生成为本机的。
 *
 * 做什么（默认全部执行，`--dry` 只打印）：
 *   1. 清运行期状态：sessions / storages / server*.log / 安装缓存
 *   2. 重置场景会话绑定：所有面板 sessionId → __待填__
 *   3. 重新检测本机 DSH 引擎 CLI，写 工作台.json（fresh:true）
 *   4. 修正 profiles\web\cordis.patch.yml（不挂未安装的插件）
 *   5. 重新生成派生物：身份卡 / 场景画像 / 身份索引
 *   6. 跑体检，把结果直接摆出来
 *
 * 用法：
 *   node 工具\初始化.mjs --dry      # 先看会动什么
 *   node 工具\初始化.mjs            # 真做
 *   node 工具\初始化.mjs --hard     # 连登录凭据也清（== 全新机器，需重新登录）
 *   node 工具\初始化.mjs --keep-sessions   # 保留会话，只修配置
 *
 * 退出码：0 成功｜1 有步骤失败｜2 用法错
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const ROOT = path.resolve(APP, '..');
const DSH = path.join(APP, '引擎数据', '.dsh');
const SHELL = path.join(APP, '外壳');
const JSONDIR = path.join(SHELL, 'scenarios');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const HARD = argv.includes('--hard');
const KEEP_SESSIONS = argv.includes('--keep-sessions');

let step = 0, failed = 0;
const say = (s) => console.log(s);
function head(t) { say(`\n[${++step}] ${t}`) }
function act(msg) { say(`  ${DRY ? '·（预演）' : '✓'} ${msg}`) }
function skip(msg) { say(`  – ${msg}`) }
function bad(msg) { failed++; say(`  ✗ ${msg}`) }
const exists = (p) => { try { fs.statSync(p); return true } catch { return false } }

/** 删除并报到；dry 时只报不删 */
function purge(p, why) {
  if (!exists(p)) return skip(`不存在，跳过：${path.relative(APP, p)}`);
  if (DRY) return act(`将删除 ${path.relative(APP, p)}（${why}）`);
  fs.rmSync(p, { recursive: true, force: true });
  act(`删除 ${path.relative(APP, p)}（${why}）`);
}

// ── 0. 前置 ────────────────────────────────────────────────
say(`初始化 · ${APP}`);
say(`根目录：${ROOT}`);
say(DRY ? '模式：预演（不改任何文件）' : '模式：执行');
if (!exists(SHELL)) { bad('找不到 外壳 目录 ⇒ 这个脚本必须放在 <工作台>\\工具\\ 下'); process.exit(1) }

// ── 1. 清运行期状态 ────────────────────────────────────────
head('清运行期状态（会话 / 工作区 / 日志 / 缓存）');
if (KEEP_SESSIONS) skip('--keep-sessions：会话保留')
else purge(path.join(DSH, 'sessions'), '上一台机器的会话')
purge(path.join(DSH, 'storages'), '工作区与 projcache（记录的是上机路径）')
for (const f of ['server.log', 'server.err.log']) purge(path.join(SHELL, f), '运行时日志（含引擎 token）')
for (const d of ['.npm-cache', '.npm', '.electron-cache', 'node_modules']) purge(path.join(APP, d), '安装缓存/依赖（用时再装）')
if (HARD) {
  purge(path.join(DSH, '.credentials.yaml'), '--hard：登录凭据也清（之后需重新登录）')
  purge(path.join(DSH, '.anonymous-user-id'), '--hard：匿名身份重置')
} else skip('登录凭据保留（要连凭据一起清：--hard）')

// ── 2. 引擎 CLI 探测 ───────────────────────────────────────
head('探测本机 DSH 引擎 CLI');
function findDshCmd() {
  const cands = [];
  if (process.env.DSH_CMD) cands.push(process.env.DSH_CMD);
  try {
    const mf = JSON.parse(fs.readFileSync(path.join(APP, '工作台.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (mf && mf.engine && mf.engine.cliPath) cands.push(mf.engine.cliPath);
  } catch { /* 没有旧清单 */ }
  try {
    const out = execFileSync('where.exe', ['dsh'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of out.split(/\r?\n/)) if (line.trim()) cands.push(line.trim());
  } catch { /* PATH 里没有 */ }
  const rel = path.join('resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
  const bases = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'),
    'C:\\Program Files\\DeepSeek Harness',
    'D:\\Programs\\DeepSeek Harness',
    'D:\\DeepSeek Harness'
  ].filter(Boolean);
  for (const b of bases) cands.push(path.join(b, rel));
  for (const c of cands) if (exists(c)) return c;
  return null;
}
const CLI = findDshCmd();
if (CLI) act(`引擎 CLI：${CLI}`);
else {
  say('  ⚠ 没找到 DSH 引擎 CLI。工作台仍能启动，但 AI 面板不可用。');
  say('    修法：设环境变量 DSH_CMD=<dsh.cmd 的路径>，或在 工作台.json 里填 engine.cliPath');
}

// ── 3. 重置会话绑定 + 写实例清单 ───────────────────────────
head('重置场景会话绑定（所有面板 → __待填__）');
let example = {};
try { example = JSON.parse(fs.readFileSync(path.join(APP, '工作台.example.json'), 'utf8').replace(/^\uFEFF/, '')) } catch { /* 用默认 */ }
const scenes = {};
for (const f of (exists(JSONDIR) ? fs.readdirSync(JSONDIR) : [])) {
  if (!f.endsWith('.json')) continue;
  const p = path.join(JSONDIR, f);
  let j;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch (e) { bad(`${f} 解析失败：${e.message}`); continue }
  const key = f.replace(/\.json$/, '');
  scenes[key] = { sessionId: '__待填__' };
  let changed = 0;
  for (const panel of (j.panels || [])) {
    if (panel && Object.prototype.hasOwnProperty.call(panel, 'sessionId') && panel.sessionId !== '__待填__') {
      if (!DRY) panel.sessionId = '__待填__';
      changed++;
    }
  }
  if (changed) {
    if (!DRY) fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n', 'utf8');
    act(`${f}：${changed} 个面板解绑`);
  } else skip(`${f}：本来就是未绑定`);
}

const manifest = {
  version: 1,
  name: example.name || '我的工作台',
  root: null,                       // null = 跟随 工作台.json 所在目录（换机不用改）
  dshPort: example.dshPort || 3083,
  sitePort: example.sitePort || 31238,
  engine: { source: 'local-dir', dir: '引擎', cliPath: CLI },
  scenes,
  fresh: true                       // 装好还没绑会话：体检把「未绑定」算待办，不算失败
};
const MF = path.join(APP, '工作台.json');
if (DRY) act(`将写 ${path.relative(APP, MF)}（fresh:true，引擎=${CLI || '未找到'}）`);
else {
  fs.writeFileSync(MF, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  act(`写 ${path.relative(APP, MF)}（fresh:true，引擎=${CLI || '未找到'}）`);
}

// ── 4. 修 profile patch ────────────────────────────────────
head('修正 profiles\\web\\cordis.patch.yml（不挂未安装的插件）');
const PATCH = path.join(DSH, 'profiles', 'web', 'cordis.patch.yml');
if (!exists(path.dirname(PATCH))) skip('没有 profiles\\web（引擎首次启动会自己建）');
else {
  const want = '# 公开模板 patch：当前不挂任何本地插件（留空 ⇒ 引擎按 package.json 的 bundles 起）\n[]\n';
  let cur = '';
  try { cur = fs.readFileSync(PATCH, 'utf8') } catch { /* 缺就建 */ }
  if (cur.trim() === want.trim()) skip('已是空的 patch');
  else if (DRY) act('将把 patch 重置为 []');
  else { fs.writeFileSync(PATCH, want, 'utf8'); act('patch 重置为 []（原来挂着未安装的插件 ⇒ 启动报错）') }
}

// ── 5. 重生成派生物 ────────────────────────────────────────
head('重新生成派生物（身份卡 / 场景画像 / 身份索引）');
// 派生物 = 由场景 json 推导出来的东西。手抄必漂移，所以每次初始化都整体重生成。
if (DRY) act('将运行 场景记忆.mjs stamp --场景 <每个场景>，再跑 身份索引.mjs --stamp');
else {
  const run = (args, why) => {
    try { execFileSync(process.execPath, args, { cwd: APP, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); act(why) }
    catch (e) { bad(`${why} 失败：` + String((e.stderr || e.message || '')).split('\n')[0]) }
  };
  const names = (exists(JSONDIR) ? fs.readdirSync(JSONDIR) : [])
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => f.replace(/\.json$/, ''));
  for (const n of names) run([path.join(HERE, '场景记忆.mjs'), 'stamp', '--场景', n], `场景「${n}」身份卡/画像已重生成`);
  run([path.join(HERE, '身份索引.mjs'), '--stamp'], '身份索引已重生成');
}

// ── 6. 体检 ────────────────────────────────────────────────
head('体检（用结果说话，不靠说明）');
if (DRY) act('将运行 node 工具\\体检.mjs');
else {
  try {
    const out = execFileSync(process.execPath, [path.join(HERE, '体检.mjs'), '--root', APP], { encoding: 'utf8', windowsHide: true });
    say(out.trimEnd());
  } catch (e) {
    failed++;
    say(String(e.stdout || '').trimEnd());
    say('  ✗ 体检有红（见上）');
  }
}

// ── 收尾 ──────────────────────────────────────────────────
say('\n' + '─'.repeat(52));
if (failed) say(`✗ 初始化未完成：${failed} 步失败（见上）`);
else if (DRY) say('✓ 预演结束，没有改动任何文件。去掉 --dry 执行。');
else {
  say('✓ 初始化完成。接下来这样开始用：');
  say('  1) 启动工作台：双击 12-源码照搬\\启动.vbs（或 外壳\\start.vbs）');
  say('  2) 打开「命令」场景 → 在 AI 面板点一下，会按当前工作区新建会话');
  say(`  3) 四个场景各开一次面板后，回来跑：node 工具\\实例化.mjs --apply`);
  say('     （它把真实 sessionId 回填进场景 json，并把清单的 fresh 置为 false）');
  say('  4) 再跑一次 node 工具\\体检.mjs —— 这时应该 13 绿、0 待办');
}
process.exit(failed ? 1 : 0);
