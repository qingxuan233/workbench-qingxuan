#!/usr/bin/env node
/**
 * 结构校验.mjs —— 《文件归档制度》的机器判据（2026-11-07 文件整理时立）
 *
 * 制度出处：<仓库>/文档/文件归档制度.md
 * 用法：
 *   node 工具\结构校验.mjs --check        只检查（exit 0 通过 / 1 有红）
 *   node 工具\结构校验.mjs --self-test    反例验收（每条判据都要能被证伪）
 *
 * 检查项：
 *   A 根目录白名单：根级只允许 入口/运行必需/编号板块/资源与产物区（制度 §2）
 *   B 文档索引完整性：文档/*.md 与 文档/归档/*.md 都必须在 文档/README.md 登记；
 *     归档文档顶部 20 行内必须有 `> ⚠ **已归档` 横幅（制度 §7）
 *   C 全仓已跟踪 .md 的相对链接可解析（跳过外链；_本机产物/ 允许本机不存在）
 *   D 已跟踪清单不含运行产物（日志/截图/会话/凭据/实例清单/_本机产物）
 *
 * 退出码：0 通过 ｜ 1 有红 ｜ 2 用法错误
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');      // = 仓库根
const DOCS = path.join(ROOT, '文档');
const ARCHIVE = path.join(DOCS, '归档');
const INDEX = path.join(DOCS, 'README.md');

// ── 制度 §2：根目录白名单 ─────────────────────────────────
const ROOT_FILES = new Set([
  'README.md', 'AGENTS.md', 'LICENSE', '.gitattributes', '.gitignore',
  '启动工作台.bat', '启动工作台.vbs', '同步上游.mjs', 'cordis.patch.optimized.yml',
]);
const ROOT_FILE_PATTERNS = [/^preset-.*\.optimized\.patch\.yml$/];
const ROOT_DIRS = new Set([
  '.git', '.githooks', '.acl-recovery', '.dsh-switchman',
  '文档', '模板', '配图', '12-源码照搬', '_本机产物',
]);
const ROOT_DIR_PATTERNS = [/^\d{2}-.+/];          // 编号知识板块
const ARCHIVE_BANNER = /^>\s*⚠\s*\*\*已归档/m;

// ── 制度 §6：已跟踪清单里绝不能出现的东西 ─────────────────
const DATA_WHITELIST = new Set([
  '12-源码照搬/外壳/data/工具清单.json',
  '12-源码照搬/外壳/data/boot-animation.json',
  '12-源码照搬/外壳/data/scene-tab-order.json',
]);
const TRACKED_DENY = [
  { test: (p) => /\.log(\.prev)?$/i.test(p), why: '日志（*.log / *.log.prev）' },
  { test: (p) => p.startsWith('12-源码照搬/外壳/captures/'), why: '截图目录 captures/' },
  { test: (p) => p.startsWith('12-源码照搬/外壳/data/') && !DATA_WHITELIST.has(p), why: '外壳 data/ 运行态文件（仅白名单除外）' },
  { test: (p) => p.startsWith('12-源码照搬/引擎数据/.dsh/sessions/'), why: '引擎会话库 sessions/' },
  { test: (p) => p.startsWith('12-源码照搬/引擎数据/.dsh/storages/'), why: '引擎 storages/' },
  { test: (p) => /\.credentials(\.[a-z]+)?$/i.test(p), why: '凭据文件' },
  { test: (p) => p === '12-源码照搬/工作台.json', why: '本机实例清单 工作台.json' },
  { test: (p) => p.startsWith('_本机产物/'), why: '本机产物（整目录不入库）' },
  { test: (p) => p.includes('node_modules/'), why: 'node_modules/' },
];

// ── 小工具 ────────────────────────────────────────────────
const posix = path.posix;
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const git = (args) => execSync('git -c core.quotepath=false ' + args, { cwd: ROOT, encoding: 'utf8' });

export function isAllowedRootEntry(name, isDir) {
  if (isDir) {
    if (ROOT_DIRS.has(name)) return true;
    if (ROOT_DIR_PATTERNS.some((re) => re.test(name))) return true;
    return false;
  }
  if (ROOT_FILES.has(name)) return true;
  return ROOT_FILE_PATTERNS.some((re) => re.test(name));
}
export function hasArchiveBanner(text) {
  return ARCHIVE_BANNER.test(String(text || '').slice(0, 4000));
}
export function isForbiddenTracked(p) {
  return TRACKED_DENY.find((r) => r.test(p)) || null;
}
/** 相对链接 → 仓库内相对路径（null = 外链/锚点/出仓） */
export function resolveLink(linkerRel, target) {
  const isExternal = (u) => !u || u.startsWith('#') || u.startsWith('/') || u.startsWith('\\') ||
    /^[a-z][a-z0-9+.-]*:/i.test(u) || /^[A-Za-z]:/.test(u);
  let t = String(target || '').trim();
  const hi = t.search(/[#?]/);
  if (hi >= 0) t = t.slice(0, hi);
  if (!t || isExternal(t)) return null;
  try { if (t.includes('%')) t = decodeURIComponent(t); } catch { /* 保留原文 */ }
  const abs = posix.normalize(posix.join(posix.dirname(linkerRel), t.replace(/\\/g, '/')));
  if (abs === '..' || abs.startsWith('../')) return null;
  return abs;
}

const MD_LINK = /(!?\[[^\]]*\]\()(<[^>]+>|[^)\s]+)/g;
const HTML_LINK = /(?:src|href)=["']([^"']+)["']/g;

/** 去掉 fenced 代码块（示例里的链接不是真链接；保留换行，行号不乱） */
export function stripFences(text) {
  return String(text || '').replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\r\n]/g, ' '));
}

export function collectLinks(text) {
  const out = [];
  text.replace(MD_LINK, (m, pre, target) => {
    out.push(target.startsWith('<') ? target.slice(1, -1) : target);
    return m;
  });
  text.replace(HTML_LINK, (m, target) => { out.push(target); return m; });
  return out;
}

/** 要校验的 .md：已跟踪/staged 的 + 文档/ 磁盘上的（新文档还没 git add 时也要查） */
function listMdFiles() {
  const set = new Set();
  const add = (p) => {
    const r = path.relative(ROOT, p).split(path.sep).join('/');
    if (!r.startsWith('../') && r.endsWith('.md')) set.add(r);
  };
  try {
    for (const x of git('ls-files "*.md"').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) set.add(x);
  } catch (e) { /* 交给调用方报红 */ }
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) add(p);
    }
  };
  if (exists(DOCS)) walk(DOCS);
  return [...set].filter((r) => exists(path.join(ROOT, r.split('/').join(path.sep))));
}

// ── 各项检查：返回 findings[] = { path, msg } ───────────────
function checkRoot(f) {
  let ents = [];
  try { ents = fs.readdirSync(ROOT, { withFileTypes: true }); } catch (e) { f.push({ path: ROOT, msg: '读不到仓库根' }); return; }
  for (const e of ents) {
    if (e.name === '.git') continue;
    if (isAllowedRootEntry(e.name, e.isDirectory())) continue;
    // 隐藏的编辑器/系统文件若被 .gitignore 挡住，属本机垃圾而非结构问题（不报红）
    if (e.name.startsWith('.')) {
      try { git('check-ignore -q "' + e.name + '"'); continue; } catch { /* 未被忽略 → 报红 */ }
    }
    f.push({ path: e.name, msg: (e.isDirectory() ? '目录' : '文件') + '不在根目录白名单（制度 §2）' });
  }
}

function checkDocIndex(f) {
  if (!exists(INDEX)) { f.push({ path: '文档/README.md', msg: '文档索引不存在' }); return; }
  const idx = read(INDEX);
  const list = [];
  try {
    for (const e of fs.readdirSync(DOCS, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md') list.push({ name: e.name, file: path.join(DOCS, e.name), archive: false });
    }
    if (exists(ARCHIVE)) {
      for (const e of fs.readdirSync(ARCHIVE, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith('.md')) list.push({ name: e.name, file: path.join(ARCHIVE, e.name), archive: true });
      }
    }
  } catch (e) { f.push({ path: '文档/', msg: '读不到文档目录' }); return; }
  for (const d of list) {
    if (!idx.includes(d.name)) f.push({ path: d.name, msg: '未在 文档/README.md 登记（制度 §1/§7）' });
    if (d.archive && !hasArchiveBanner(read(d.file))) f.push({ path: '文档/归档/' + d.name, msg: '归档文档缺少 `> ⚠ **已归档` 横幅（制度 §7）' });
  }
  return list.length;
}

function checkLinks(f) {
  const files = listMdFiles();
  if (!files.length) { f.push({ path: 'git', msg: '一个 .md 都没找到（git ls-files 失败？）' }); return 0; }
  let n = 0;
  for (const rel of files) {
    const abs = path.join(ROOT, rel.split('/').join(path.sep));
    if (!exists(abs)) continue;
    const text = stripFences(read(abs));
    for (const target of collectLinks(text)) {
      const r = resolveLink(rel, target);
      if (!r) continue;
      n++;
      if (r.startsWith('_本机产物/')) continue;               // 本机产物：别的机器上不存在属正常
      if (!exists(path.join(ROOT, r.split('/').join(path.sep)))) {
        const line = text.slice(0, text.indexOf(target)).split(/\r?\n/).length;
        f.push({ path: rel + ':' + line, msg: '链接解析不到：' + target + ' → ' + r });
      }
    }
  }
  return n;
}

function checkTracked(f) {
  let files = [];
  try { files = git('ls-files').split(/\r?\n/).map((s) => s.trim()).filter(Boolean); } catch (e) { f.push({ path: 'git', msg: 'git ls-files 失败' }); return 0; }
  for (const p of files) {
    const hit = isForbiddenTracked(p);
    if (hit) f.push({ path: p, msg: '已跟踪但属运行产物/本机数据：' + hit.why });
  }
  return files.length;
}

function selfTest() {
  let pass = 0, fail = 0;
  const ok = (name, got, want) => { if (got === want) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + '：期望 ' + want + '，实际 ' + got); } };
  // A 根白名单：正例不报、反例必报
  ok('根文件 README.md 允许', isAllowedRootEntry('README.md', false), true);
  ok('根文件 散落笔记.md 不允许', isAllowedRootEntry('散落笔记.md', false), false);
  ok('根目录 14-新板块 允许', isAllowedRootEntry('14-新板块', true), true);
  ok('根目录 随手建/ 不允许', isAllowedRootEntry('随手建', true), false);
  ok('本机补丁 preset-x.optimized.patch.yml 允许', isAllowedRootEntry('preset-x.optimized.patch.yml', false), true);
  // B 归档横幅
  ok('归档横幅识别', hasArchiveBanner('> ⚠ **已归档（2026-11-07）**：本文只作历史。'), true);
  ok('普通文档不误判', hasArchiveBanner('# 标题\n\n正文'), false);
  // C 链接解析
  ok('文档/README 指向 ../AGENTS.md', resolveLink('文档/README.md', '../AGENTS.md'), 'AGENTS.md');
  ok('归档指向 ../../_本机产物/x.md', resolveLink('文档/归档/a.md', '../../_本机产物/x.md'), '_本机产物/x.md');
  ok('外链不解析', resolveLink('README.md', 'https://github.com/x'), null);
  ok('锚点不解析', resolveLink('README.md', '#section'), null);
  // D 已跟踪清单红线
  ok('日志被拦', !!isForbiddenTracked('12-源码照搬/外壳/server.log'), true);
  ok('工具清单放行', !!isForbiddenTracked('12-源码照搬/外壳/data/工具清单.json'), false);
  ok('配图 png 放行', !!isForbiddenTracked('配图/拓扑-总纲.svg'), false);
  ok('_本机产物被拦', !!isForbiddenTracked('_本机产物/优化报告/x.md'), true);
  ok('实例清单被拦', !!isForbiddenTracked('12-源码照搬/工作台.json'), true);
  ok('代码块里的示例链接不算链接', collectLinks(stripFences('```md\n[示例](./不存在.md)\n```')).length, 0);
  ok('代码块外的链接仍要校验', collectLinks(stripFences('[示例](./不存在.md)')).length, 1);
  console.log('\n自检：' + pass + ' 通过 · ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}

// ── 主流程 ────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();
  if (!argv.includes('--check')) {
    console.error('用法：node 工具\\结构校验.mjs --check ｜ --self-test');
    process.exit(2);
  }
  console.log('结构校验 · 仓库根：' + ROOT);
  const A = [], B = [], C = [], D = [];
  checkRoot(A);
  const docN = checkDocIndex(B);
  const linkN = checkLinks(C);
  const trackedN = checkTracked(D);
  const line = (tag, name, arr) => {
    if (!arr.length) { console.log('✓ [' + tag + '] ' + name); return 0; }
    for (const it of arr) console.log('✗ [' + tag + '] ' + it.path + ' ← ' + it.msg);
    return arr.length;
  };
  line('A', '根目录白名单', A);
  line('B', '文档索引与归档横幅（' + docN + ' 份）', B);
  line('C', '文档相对链接（' + linkN + ' 条，已跟踪 .md）', C);
  line('D', '入库清单（' + trackedN + ' 个文件，无运行产物）', D);
  const red = A.length + B.length + C.length + D.length;
  console.log('');
  if (red) { console.log('✗ 结构校验失败：' + red + ' 处红'); process.exit(1); }
  console.log('✓ 结构与链接全部通过');
  process.exit(0);
}

const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return path.resolve(entry) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isMain) main();
