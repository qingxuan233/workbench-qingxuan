#!/usr/bin/env node
/**
 * 发布前检查.mjs —— 出包/推仓库前扫一遍红线
 *
 * ⚠ 2026-11-01 起分两种模式（方法论 O2）：
 *   template（模板，要出包）  ：本机绝对路径 / 真实会话 id 都算红线——必须挡。
 *   instance（实例，只在本机）：这两类**本来就是本机真值**，挡它等于让「落地」和「出包」互斥。
 *                              ⇒ 只报告、不计入失败；密钥/服务器 IP 这类**真红线仍然挡**。
 *   自动判定：有 工作台.json ⇒ instance，否则 template。也可 --mode 强制。
 *
 * 用法：node 工具\发布前检查.mjs [--mode template|instance]
 *      node 工具\发布前检查.mjs --mode template --files-from <清单文件>
 *      （--files-from 只扫清单里列出的文件，供 验收.mjs 按 git ls-files 的已跟踪清单执行；
 *        清单里每行一个相对 ROOT 的路径或绝对路径，不存在/越界的条目跳过）
 * 退出码：0 通过 ｜1 有红线
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..')
const argv = process.argv.slice(2)
const modeArg = (() => { const i = argv.indexOf('--mode'); return i >= 0 ? argv[i + 1] : '' })()
const MODE = modeArg === 'template' || modeArg === 'instance'
  ? modeArg
  : (fs.existsSync(path.join(ROOT, '工作台.json')) ? 'instance' : 'template')
const filesFrom = (() => { const i = argv.indexOf('--files-from'); return i >= 0 ? argv[i + 1] : '' })()

// tier：both = 两种模式都挡；template = 只在模板模式挡（实例里是本机真值）
const RULES = [
  ['本机绝对路径 <盘根>', /[A-Za-z]:\\\\DSH/i, 'template'],
  ['本机用户目录 <盘根>', /[A-Za-z]:\\\\Users/i, 'template'],
  ['会话 id', /session-[0-9a-f]{8}/i, 'template'],
  ['密钥', /sk-[A-Za-z0-9]{16,}/, 'both'],
  ['服务器 IP', /47\.108\.201\.6/, 'both'],
]
const SKIP_DIR = new Set(['node_modules', '.git', '发布', 'dist', '.npm-cache', '.npm', '.electron-cache'])
// 实例清单本身含真值且已 .gitignore，不该被当成「泄漏」
// ⚠ 注释里别写具体的 session-<八位十六进制> 样例：本文件的规则会扫到自己（真实踩过一次）
const SKIP_FILE = new Set(['工作台.json', '体检.mjs'])
const SKIP_EXT = /(\.png|\.jpg|\.jpeg|\.gif|\.webp|\.ico|\.woff2?|\.ttf|\.mp4|\.zip|\.7z|\.exe|\.dll|\.zstd)$/i

let hits = 0
let allowed = 0
/** 命中值脱敏后再进日志：密钥/IP 不落明文，会话 id 与路径只留可辨识前缀 */
function maskValue(name, s) {
  if (name === '密钥') return 'sk-****'
  if (name === '服务器 IP') return '<IP 已掩码>'
  if (name === '会话 id') return String(s).slice(0, 12) + '****'
  return String(s).slice(0, 6) + '****'
}
function inspectFile(p, where) {
  if (SKIP_FILE.has(path.basename(p)) || SKIP_EXT.test(p)) return
  let t
  try { t = fs.readFileSync(p, 'utf8') } catch { return }
  for (const [name, re, tier] of RULES) {
    const m = t.match(re)
    if (!m) continue
    if (tier === 'template' && MODE === 'instance') {
      console.log('· ' + where + ' ← ' + name + '：' + maskValue(name, m[0]) + '（实例真值，允许；出包前请切回 template）')
      allowed++
    } else {
      console.log('✗ ' + where + ' ← ' + name + '：' + maskValue(name, m[0]))
      hits++
    }
  }
}
function walk(dir) {
  let ents
  // 运行时目录（Chromium 临时目录等）可能被正在运行的进程锁住；
  // 读不到就跳过并说明，不让一次 EPERM 把整道闸掀翻。
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) {
    console.log('· 跳过不可读目录：' + path.relative(ROOT, dir) + '（' + (e.code || e.message) + '）')
    return
  }
  for (const e of ents) {
    if (SKIP_DIR.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { walk(p); continue }
    inspectFile(p, path.relative(ROOT, p))
  }
}
if (filesFrom) {
  const list = fs.readFileSync(path.resolve(filesFrom), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  let n = 0
  for (const raw of list) {
    const abs = path.resolve(ROOT, raw)
    const rel = path.relative(ROOT, abs)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(abs)) continue
    inspectFile(abs, rel)
    n++
  }
  console.log(`清单模式：只扫 ${n} 个已列出文件（不遍历目录）`)
} else {
  walk(ROOT)
}
console.log('')
console.log(`模式：${MODE}（${MODE === 'instance' ? '本机实例，只看真红线' : '对外模板，本机痕迹也挡'}）`)
if (allowed) console.log(`  另有 ${allowed} 处「实例真值」被放行（不计失败）。`)
if (hits) { console.log(`命中 ${hits} 处红线 ⇒ 不出包`); process.exit(1) }
console.log('✓ 红线检查通过（0 命中）')
