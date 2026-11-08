#!/usr/bin/env node
/**
 * webai-mcp-merge.mjs —— 把 `cordis.patch.yml` 里 5 个 per-site 的 webai MCP entry 合成 1 个多站 entry。
 *
 * 背景（2026-11-08 P1）：`webai-mcp.mjs` 现在支持 `WEBAI_KEYS=a,b,c` 多站模式（一个进程暴露 5 个工具）。
 * 原来 5 个 `mcp-webai-*` = 5 个 node 常驻进程 + 5 条 stdio + 5 个日志文件；合成 1 个后只剩 1 份。
 *
 * 用法：
 *   node scripts\webai-mcp-merge.mjs --dry      # 只看将怎么改（默认）
 *   node scripts\webai-mcp-merge.mjs --apply    # 真改（自动备份到 data\backups\）
 *   node scripts\webai-mcp-merge.mjs --revert   # 从最近一次备份还原
 *
 * 安全：只动两段（insert 列表 / MCP 开关列表），改前备份，改后做结构校验（条数/缩进/关键字段），
 *      任何一步不符合就还原并 exit 1。本文件属实例配置（已被 .gitignore 挡），换机器由 初始化.mjs 重建。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');           // 12-源码照搬（HERE=外壳/scripts ⇒ 上两级）
const PATCH = path.join(ROOT, '引擎数据', '.dsh', 'profiles', 'web', 'cordis.patch.yml');
const BK_DIR = path.join(ROOT, '外壳', 'data', 'backups');
const KEYS = ['deepseek', 'doubao', 'tongyi', 'chatglm', 'kimi'];

const SAY = (s) => console.log(s);
const die = (s) => { console.error('✗ ' + s); process.exit(1); };

const argv = process.argv.slice(2);
const MODE = argv.includes('--apply') ? 'apply' : (argv.includes('--revert') ? 'revert' : 'dry');

if (!fs.existsSync(PATCH)) die('找不到 ' + PATCH + '（工作台没初始化过？）');

// ── 还原 ────────────────────────────────────────────────────────────────
if (MODE === 'revert') {
  const list = fs.existsSync(BK_DIR) ? fs.readdirSync(BK_DIR).filter((f) => f.startsWith('cordis-patch-') && f.endsWith('.yml.bak')).sort() : [];
  if (!list.length) die('没有可用的备份（' + BK_DIR + ' 下没有 cordis-patch-*.yml.bak）');
  const last = list[list.length - 1];
  fs.copyFileSync(path.join(BK_DIR, last), PATCH);
  SAY('✓ 已从备份还原：' + last);
  SAY('  注意：引擎需要重启工作台才会重新读这份 patch。');
  process.exit(0);
}

const src = fs.readFileSync(PATCH, 'utf8');

// ── 已经合过？幂等 ──────────────────────────────────────────────────────
if (src.includes('mcp-webai-all')) {
  SAY('✓ 已经是合并后的形态（发现 mcp-webai-all），无需再改。');
  process.exit(0);
}

// ── 构造合并后的两段 ────────────────────────────────────────────────────
const mergedInsert = [
  '    - id: mcp-webai-all',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: webai-all',
  '        transport: stdio',
  '        command: node',
  '        args:',
  '          - 外壳/scripts/webai-mcp.mjs',
  '        env:',
  '          WEBAI_KEYS: ' + KEYS.join(','),
].join('\n');

const mergedSwitch = [
  '- id: mcp-webai-all',
  '  disabled: true   # 2026-11-08 合并后保持原状态（原 5 个都是 disabled）；要启用改成 false',
].join('\n');

// ── 第一段：insert 里的 5 个分块 ────────────────────────────────────────
const startMark = '    - id: mcp-webai-deepseek';
const endMark = '          WEBAI_KEY: kimi';
const i1 = src.indexOf(startMark);
if (i1 < 0) die('结构不认识：找不到 insert 段的起点（' + startMark.trim() + '）');
const i2 = src.indexOf(endMark, i1);
if (i2 < 0) die('结构不认识：找不到 insert 段的终点（' + endMark.trim() + '）');
const afterInsert = src.slice(0, i1) + mergedInsert + src.slice(i2 + endMark.length);

// ── 第二段：MCP 开关里的 5 个 disabled ──────────────────────────────────
const switchBlock = KEYS.map((k) => '- id: mcp-webai-' + k + '\n  disabled: true').join('\n');
const j1 = afterInsert.indexOf(switchBlock);
if (j1 < 0) die('结构不认识：找不到「MCP 开关」段的 5 条 disabled 记录（可能已经被工具改过）');
const out = afterInsert.slice(0, j1) + mergedSwitch + afterInsert.slice(j1 + switchBlock.length);

// ── 结构校验（改前/改后都数一遍）────────────────────────────────────────
const countOf = (t, needle) => (t.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
const before = { entries: countOf(src, "name: '@deepseek-ai/dsh-mcp-client'"), keys: countOf(src, 'WEBAI_KEY:'), switches: countOf(src, '  disabled: true') };
const after = { entries: countOf(out, "name: '@deepseek-ai/dsh-mcp-client'"), keys: countOf(out, 'WEBAI_KEYS:'), switches: countOf(out, '  disabled: true') };

SAY('== 合并计划 ==');
SAY('  dsh-mcp-client 条目：' + before.entries + ' → ' + after.entries + '（应 ↓5，因为 5 个 webai 合成 1 个）');
SAY('  webai 环境变量：WEBAI_KEY×' + before.keys + ' → WEBAI_KEYS×' + after.keys);
SAY('  disabled 行：' + before.switches + ' → ' + after.switches);

const problems = [];
if (after.entries !== before.entries - 4) problems.push('mcp-client 条目数不对（期望 ' + (before.entries - 4) + '，实际 ' + after.entries + '）');
if (after.keys !== 1) problems.push('WEBAI_KEYS 应恰好 1 行，实际 ' + after.keys);
if (countOf(out, 'mcp-webai-') !== 2) problems.push('mcp-webai- 应恰好出现 2 次（insert + 开关），实际 ' + countOf(out, 'mcp-webai-'));
if (!out.includes('serverName: webai-all')) problems.push('缺少 serverName: webai-all');
if (problems.length) die('结构校验失败：\n  - ' + problems.join('\n  - '));

if (MODE === 'dry') {
  SAY('\n（--dry：未写盘。确认无误后跑 `node 外壳\\scripts\\webai-mcp-merge.mjs --apply`）');
  process.exit(0);
}

// ── 备份 + 写盘 + 复核 ──────────────────────────────────────────────────
try { fs.mkdirSync(BK_DIR, { recursive: true }); } catch (e) { }
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const bk = path.join(BK_DIR, 'cordis-patch-' + stamp + '.yml.bak');
fs.copyFileSync(PATCH, bk);
fs.writeFileSync(PATCH, out, 'utf8');

const reread = fs.readFileSync(PATCH, 'utf8');
if (!reread.includes('mcp-webai-all') || countOf(reread, 'mcp-webai-') !== 2) {
  fs.copyFileSync(bk, PATCH);   // 写坏了立刻还原
  die('写盘后复核失败，已自动还原；备份：' + bk);
}
SAY('\n✓ 已合并并备份：' + path.relative(ROOT, bk));
SAY('  下一步：重启工作台（引擎重读 cordis.patch.yml）→ 引擎里应只剩 1 个 webai MCP 进程');
SAY('  工具名变化：mcp__webai-<site>__ask → mcp__webai-all__ask_<site>（提示词/脚本里若写死旧名要同步）');
SAY('  回滚：node 外壳\\scripts\\webai-mcp-merge.mjs --revert');
