#!/usr/bin/env node
/**
 * 验收.mjs —— 提交前红线闸（.githooks/pre-commit 调它）
 *
 * 为什么需要单独一层：
 *   `发布前检查.mjs` 默认扫整棵工作树。本机是实例态（有 工作台.json），
 *   它的自动判定会切到 instance 模式，把真实会话 id / 本机路径全部「放行」——
 *   于是提交时什么都挡不住。本工具改用 `git ls-files`（外加暂存新增）得到的
 *   **已跟踪清单**做模板态扫描：清单外的本机实例文件不参与，清单内的真值一律挡。
 *
 * 串行六步（全部执行，任一步失败即整体失败）：
 *   1 编码检查.mjs
 *   2 体检.mjs --self-test
 *   3 身份索引.mjs --check
 *   4 发布前检查.mjs --mode template（仅已跟踪清单）+ 本机绝对路径补充扫描
 *   5 场景校验.mjs --check
 *   6 代码红线.mjs --check
 *
 * 用法：
 *   node 工具\验收.mjs            直接跑
 *   node 工具\验收.mjs --verbose  连每步的完整输出一起打印
 *
 * 退出码：0 全绿 ｜1 有步骤失败 ｜2 环境问题（git 不可用 / 清单为空）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..')
const VERBOSE = process.argv.includes('--verbose')

function safeSpawnSync(cmd, args, opts = {}) {
  const tmp = path.join(os.tmpdir(), `wb-spawn-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'w+');
    const childOpts = { ...opts, stdio: ['ignore', fd, fd] };
    const r = spawnSync(cmd, args, childOpts);
    fs.closeSync(fd);
    fd = null;
    const out = fs.readFileSync(tmp, 'utf8');
    return { status: r.status, error: r.error, stdout: out, stderr: out };
  } catch (err) {
    return { status: 1, error: err, stdout: '', stderr: String(err) };
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
  }
}

const git = (args) => {
  const r = safeSpawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: APP });
  if (r.status !== 0) throw new Error(r.stderr || (r.error && r.error.message) || 'git error');
  return r.stdout;
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }

/** 已跟踪文件 + 暂存新增（相对 APP；越出 APP 的条目丢弃） */
function trackedFiles() {
  const tracked = git(['ls-files']).split(/\r?\n/).filter(Boolean)
  let staged = []
  try { staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']).split(/\r?\n/).filter(Boolean) } catch { staged = [] }
  const out = new Set()
  for (const rel of [...tracked, ...staged]) {
    const norm = path.normalize(rel)
    if (!norm || norm.startsWith('..') || path.isAbsolute(norm)) continue
    out.add(norm)
  }
  return [...out].sort()
}

/** 会话 id、盘符路径一律掩码后再进日志 */
function mask(text) {
  return String(text || '')
    .replace(/session-[0-9a-f]{4}[0-9a-f-]{4,}/gi, (m) => 'session-' + m.slice(8, 12) + '-****')
    .replace(/[A-Za-z]:\\{1,2}[^\s"'<>|]*/g, '<本机路径已掩码>')
}

/** 把 发布前检查 的「文件 ← 规则：值」压成不含真值的形态 */
function sanitizeRuleLine(line) {
  const m = line.match(/^✗\s+(.*?)\s+←\s+(.*?)：.*$/)
  return m ? `✗ ${m[1]} ← ${m[2]}：<已掩码>` : mask(line)
}

/** 补充扫描：数据/文档类已跟踪文件里的本机绝对路径 */
const DATA_EXT = /\.(json|md|txt|yml|yaml)$/i
const DRIVE_RE = /(?<![A-Za-z0-9])[A-Za-z]:\\{1,2}[^\s"'<>|]*/g
function scanLocalPaths(files) {
  const hits = []
  for (const rel of files) {
    if (!DATA_EXT.test(rel)) continue
    const abs = path.join(APP, rel)
    const text = read(abs)
    if (text == null) continue
    const lines = text.split(/\r?\n/)
    lines.forEach((line, i) => {
      DRIVE_RE.lastIndex = 0
      if (DRIVE_RE.test(line)) hits.push(`${rel}:${i + 1} ← 本机绝对路径（已掩码）`)
    })
  }
  return hits
}

const STEP_NAMES = [
  '编码检查',
  '体检自检（--self-test）',
  '身份索引（--check）',
  '发布前检查（template·已跟踪清单）',
  '场景校验（--check）',
  '代码红线（--check）',
]

function runStep(index, cmd, args, extra, label, allowSkip) {
  const target = path.isAbsolute(cmd) ? cmd : path.join(HERE, cmd)
  const r = safeSpawnSync(process.execPath, [target, ...args], { cwd: APP, encoding: 'utf8' })
  const raw = String(r.stdout || '') + String(r.stderr || '')
  const lines = raw.split(/\r?\n/).filter((l) => l.trim())
  const tag = `[${index + 1}/6] ${label || STEP_NAMES[index]}`
  const problems = lines.filter((l) => l.trim().startsWith('✗') || /^\s*✗/.test(l))
  if (VERBOSE) {
    console.log(`\n${tag} · node ${cmd} ${args.join(' ')}`)
    for (const l of lines) console.log('    ' + mask(l))
  }
  if (r.status === 0) {
    console.log(`✓ ${tag} 通过${lines.length ? ' · ' + mask(lines[lines.length - 1]).trim() : ''}`)
    return { ok: true, problems: [] }
  }
  // 三态工具（exit 3 = SKIPPED 未验证）：只在显式声明 allowSkip 的步骤里放行，且**不打印成"通过"**
  if (allowSkip && r.status === 3) {
    const why = (lines.find((l) => l.trim().startsWith('SKIPPED')) || lines[lines.length - 1] || '').trim()
    console.log(`· ${tag} 跳过（未验证）· ${mask(why)}`)
    return { ok: true, problems: [], skipped: true }
  }
  console.log(`✗ ${tag} 失败（退出码 ${r.status}）`)
  const shown = (problems.length ? problems : lines.slice(-4))
  for (const l of shown.slice(0, 12)) console.log('    ' + sanitizeRuleLine(mask(l).trim()))
  if (shown.length > 12) console.log(`    ……另有 ${shown.length - 12} 处未列出，加 --verbose 看全量`)
  return { ok: false, problems }
}

function main() {
  console.log('验收 · 提交前红线闸')
  console.log(`应用根：${APP}`)

  let files
  try { files = trackedFiles() } catch (e) {
    console.error('✗ 无法读取 git 已跟踪清单：' + e.message)
    console.error('  提交前闸必须基于 git ls-files；请在仓库内运行，或先确认 git 可用。')
    process.exit(2)
  }
  if (!files.length) { console.error('✗ 已跟踪清单为空，拒绝空跑通过'); process.exit(2) }
  console.log(`已跟踪/暂存文件：${files.length} 个（本机实例文件不在清单内，不参与）`)

  const results = []
  results.push(runStep(0, '编码检查.mjs', []))
  // 第 2 步由两个子检查组成（对外仍报「6 步」）：体检自检 + 能力层纯函数契约
  // 后者守的是 2026-11-10 那个坑：RPC 路径把 `/` 编成 %2F ⇒ REST/MCP 派单静默失效
  const selfTest = runStep(1, '体检.mjs', ['--self-test'])
  const coreCheck = runStep(1, path.join(APP, '外壳', 'core', 'core-contract.test.mjs'), [], null, '核心契约自检（能力层/路由编码）')
  const envCheck = runStep(1, path.join(APP, '工具', '_派单核心.test.mjs'), [], null, '派单信封/超时判定（纯函数）')
  const webaiCheck = runStep(1, path.join(APP, '外壳', 'core', 'webai-concurrency.test.mjs'), [], null, 'WebAI 并发（mock 桥）')
  // 运行时冒烟：工作台没在跑 ⇒ SKIPPED（exit 3，明确标"未验证"，不当通过）；在跑就必须全绿
  const gwSmoke = runStep(1, path.join(APP, '外壳', 'scripts', 'gateway-smoke.mjs'), [], null, '网关运行时冒烟（工作台没跑=未验证）', true)
  selfTest.ok = selfTest.ok && coreCheck.ok && envCheck.ok && webaiCheck.ok && gwSmoke.ok
  selfTest.problems = selfTest.problems.concat(coreCheck.problems, envCheck.problems, webaiCheck.problems, gwSmoke.problems)
  results.push(selfTest)
  results.push(runStep(2, '身份索引.mjs', ['--check']))

  // 第 4 步：发布前检查按清单跑模板态，再补一层本机绝对路径
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-accept-'))
  const listFile = path.join(tmp, 'tracked.txt')
  fs.writeFileSync(listFile, files.join('\n') + '\n', 'utf8')
  const pre = runStep(3, '发布前检查.mjs', ['--mode', 'template', '--files-from', listFile])
  fs.rmSync(tmp, { recursive: true, force: true })

  const pathHits = scanLocalPaths(files)
  if (pathHits.length) {
    console.log(`✗ [4/6] 发布前检查（template·已跟踪清单）失败 · 补充扫描命中 ${pathHits.length} 处本机绝对路径`)
    for (const h of pathHits.slice(0, 20)) console.log('    ' + h)
    if (pathHits.length > 20) console.log(`    ……另有 ${pathHits.length - 20} 处`)
  } else if (pre.ok) {
    console.log('✓ [4/6] 本机绝对路径补充扫描 通过 · 数据/文档类已跟踪文件 0 命中')
  }
  results.push({ ok: pre.ok && !pathHits.length, problems: pre.problems.concat(pathHits) })

  results.push(runStep(4, '场景校验.mjs', ['--check']))
  results.push(runStep(5, '代码红线.mjs', ['--check']))

  console.log('\n' + '-'.repeat(56))
  const bad = results.map((r, i) => (r.ok ? null : i)).filter((i) => i !== null)
  if (bad.length) {
    console.log(`✗ 验收失败：第 ${bad.map((i) => i + 1).join('、')} 步未通过（共 ${bad.length} 步）`)
    console.log('  修好后再提交；不要绕过本闸（会记进评论/评审记录）。')
    process.exit(1)
  }
  console.log('✓ 验收通过：6 步全绿，可以提交')
  process.exit(0)
}

main()
