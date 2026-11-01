#!/usr/bin/env node
/**
 * 同步上游.mjs —— 上游（跟踪仓库）变更的**确认闸门**
 *
 * 背景（2026-11-01 宿主定）：
 *   本仓库要长期客制化 + 个人开发，**跟踪仓库**是
 *     qingxuan233/workbench-luanyujia（只跟踪，禁止推送）
 *   **推送仓库**是
 *     qingxuan233/workbench-qingxuan
 *   跟踪仓库有更新时，**必须经人工确认后才允许并入**——不许自动 merge、不许后台自动更新。
 *
 * 用法：
 *   node 同步上游.mjs                 只体检：fetch 上游 → 列差异 → 不动工作树
 *   node 同步上游.mjs --apply --i-confirm   确认后执行快进合并（ff-only，不产生 merge 提交）
 *
 * 退出码：0 已最新 ｜ 2 有更新待确认 ｜ 3 拒绝执行（工作树脏 / 非快进 / 缺确认）｜ 1 出错
 *
 * 三条不许（写死在这里，别绕过）：
 *   ① 不许 `git pull`（会隐式合并）；② 不许强推上游；③ 不许在脏工作树上并。
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UPSTREAM = 'upstream';
const BRANCH = 'main';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const CONFIRMED = argv.includes('--i-confirm');

const say = (...a) => console.log(...a);
const die = (code, msg) => { console.error('\n✗ ' + msg); process.exit(code); };

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts
  });
}
function gitSafe(args) {
  try { return { ok: true, out: git(args) }; }
  catch (e) { return { ok: false, out: String((e.stdout || '') + (e.stderr || '') || e.message) }; }
}
function count(range) {
  const s = git(['rev-list', '--left-right', '--count', range]).trim().split(/\s+/);
  return { ahead: Number(s[0] || 0), behind: Number(s[1] || 0) };
}

// ── 0. 前置检查：确认远端配置就是宿主指定的那两个 ──────────────
const remotes = git(['remote', '-v']);
if (!remotes.includes('qingxuan233/workbench-luanyujia')) {
  die(1, '检不到跟踪仓库 upstream（应为 qingxuan233/workbench-luanyujia）。先修：git remote set-url upstream <url>');
}
if (!remotes.includes('qingxuan233/workbench-qingxuan')) {
  die(1, '检不到推送仓库 origin（应为 qingxuan233/workbench-qingxuan）。先修：git remote set-url origin <url>');
}

// ── 1. 只取不并：fetch 上游 ────────────────────────────────
say('→ 取上游 ' + UPSTREAM + '/' + BRANCH + ' …');
const f = gitSafe(['fetch', UPSTREAM, BRANCH]);
if (!f.ok) die(1, 'fetch 失败（网络或凭证）：\n' + f.out.trim());

// ── 2. 对账 ───────────────────────────────────────────────
const { ahead, behind } = count(`HEAD...${UPSTREAM}/${BRANCH}`);
say('  本地领先 ' + ahead + ' 个提交 · 落后（上游新增）' + behind + ' 个提交');

if (behind === 0) {
  say('\n✓ 上游没有新提交，无需任何变更。');
  process.exit(0);
}

// ── 3. 列出上游新增（先给人看，再谈并） ─────────────────────
say('\n── 上游新增提交（本地没有）──');
say(git(['log', '--oneline', '--no-decorate', `HEAD..${UPSTREAM}/${BRANCH}`]).trimEnd());

say('\n── 改动规模（已剥离空白/BOM 噪声）──');
say(git(['diff', '-w', '--stat', `HEAD...${UPSTREAM}/${BRANCH}`]).trimEnd());

const dirty = git(['status', '--porcelain']).trim();
const localFiles = new Set(git(['diff', '--name-only', 'HEAD']).split('\n').filter(Boolean));
const upFiles = git(['diff', '--name-only', `HEAD...${UPSTREAM}/${BRANCH}`]).split('\n').filter(Boolean);
const overlap = upFiles.filter((x) => localFiles.has(x));
if (dirty) {
  say('\n── 本地有未提交改动；与上游改动重叠的文件 ──');
  say(overlap.length ? overlap.map((x) => '  ⚠ ' + x).join('\n') : '  （无重叠 ⇒ 可以安全快进）');
}

// ── 4. 确认闸门：没确认就到此为止 ──────────────────────────
if (!APPLY || !CONFIRMED) {
  say('\n════════════════════════════════════════════');
  say('⛔ 已停在「确认」之前：工作树**没有任何改动**。');
  say('   要并入请先评审上面的差异，然后执行：');
  say('   node 同步上游.mjs --apply --i-confirm');
  say('════════════════════════════════════════════');
  process.exit(2);
}

if (dirty && overlap.length) {
  die(3,
    '工作树有未提交改动，且与上游改动落在同一批文件上，拒绝合并（会覆盖你的改动）。\n' +
    '  重叠文件：\n' + overlap.map((x) => '    ' + x).join('\n') +
    '\n\n  先 commit 或 stash 再重跑：git stash push -u');
}
if (dirty) {
  say('\n⚠ 工作树有未提交改动，但与上游改动无重叠，快进不会碰到它们，继续。');
}

// ── 5. 只允许快进：不产生 merge 提交 ───────────────────────
say('\n→ 快进合并 ' + UPSTREAM + '/' + BRANCH + ' …');
// ⚠ 必须带上确认标记：.git/hooks/reference-transaction 会拦「引入上游提交」的引用更新，
//   这里的合并正是被允许的那一种，所以显式放行（仅此一处）。
const m = gitSafe(['merge', '--ff-only', `${UPSTREAM}/${BRANCH}`], {
  env: { ...process.env, DSH_UPSTREAM_CONFIRMED: '1' }
});
if (!m.ok) {
  die(3, '不是快进关系，已中止（本地有自己的提交在上游之外）。\n' + m.out.trim() +
    '\n\n这种情形请人工 rebase 或开分支评审，不要用 --no-ff / --allow-unrelated-histories 硬并。');
}
say(m.out.trim());
say('\n✓ 已并入。建议立刻：node --check 关键文件 + 起一次工作台自检。');
say('  推送（只到 origin/workbench-qingxuan）：git push origin ' + BRANCH);
process.exit(0);
