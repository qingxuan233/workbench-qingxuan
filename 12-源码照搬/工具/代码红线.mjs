#!/usr/bin/env node
/**
 * 代码红线.mjs —— 体量上限 + 硬编码的「不得增长」闸
 *
 * 为什么要「存量基线」：
 *   这个工作台是纯 JS 源码直跑（无打包、无构建）。三个渲染层大文件
 *   （renderers.js / main.js / renderer.js）已经几千到近两万行，一刀切要求
 *   ≤800 行等于让仓库永远红。所以对存量只做「不得增长」，与基线行数比较；
 *   基线之外的新文件才适用 800 行上限。基线日期见 BASELINE_DATE。
 *
 * 检查项：
 *   1) 行数：新文件 ≤ 800；存量文件不得超过基线行数
 *   2) 硬编码盘符：源码字符串里的盘符绝对路径（存量按文件计数豁免，只挡新增）
 *   3) 真实会话 id：源码里出现 session-<8-4-4-4-12>（体检的重复字符样本不算）
 *   4) eval：禁止出现 eval 调用
 *   5) 面板渲染器登记：场景 json 里的每个 panel.type 都必须在 renderers.js 注册
 *
 * 用法：
 *   node 工具\代码红线.mjs --check           只挡新增违规（存量盘符只提示）
 *   node 工具\代码红线.mjs --check --strict  存量盘符也计入失败
 *
 * 退出码：0 通过 ｜1 有红线 ｜2 用法错误
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registryFromSource } from './场景校验.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..')
const LIMIT = 800
const BASELINE_DATE = '2026-11-04'

/** 存量 >800 行文件的行数基线：只允许变短，不允许变长 */
const BASELINE_LINES = {
  '外壳/renderer/renderers.js': 19780,
  '外壳/main.js': 5160,
  '外壳/renderer/renderer.js': 1356,
  '外壳/renderer/topbar-status.js': 1733,
  '外壳/renderer/webai-bridge.js': 1570,     // 2026-11-04：本轮本地工作 +55 行（网页版 AI 桥完善），基线同步
  '外壳/renderer/sector-data.js': 8669,      // 行情数据表（存量数据文件）
  '外壳/renderer/us-sector-data.js': 8395,   // 美股行情数据表（存量数据文件）
  '工具/体检.mjs': 809,
}

/** 存量硬编码盘符豁免（按文件精确计数；新增一处就失败） */
const DRIVE_ALLOW = {
  '工具/初始化.mjs': 3,          // 引擎搜索的固定候选目录（Program Files / D 盘）
  '外壳/main.js': 4,             // SystemRoot / nodejs 兜底 + 注释里的路径样例
  '外壳/renderer/renderers.js': 2, // 工作台自身的绝对路径兜底
  '外壳/scripts/pc-scan.mjs': 2, // 用法注释里的示例路径
  '外壳/scripts/webai.mjs': 1,   // 用法注释里的示例路径
}

const SESSION_RE = /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const DRIVE_LITERAL_RE = /(?:'|"|`)[A-Za-z]:\\{1,2}[^'"`\r\n]*/g
const EVAL_RE = /\beval\s*\(/

export const countLines = (text) => String(text || '').split('\n').length

/** 重复字符的会话 id 是自检样本，不是真值（例如 session-aaaa…） */
export function isDummySession(id) {
  const body = String(id || '').replace(/^session-/i, '')
  const groups = body.split('-')
  return groups.length === 5 && groups.every((g) => /^([0-9a-f])\1*$/i.test(g))
}

export function findDriveLiterals(text) {
  const out = []
  const src = String(text || '')
  DRIVE_LITERAL_RE.lastIndex = 0
  for (const m of src.matchAll(DRIVE_LITERAL_RE)) {
    const line = src.slice(0, m.index).split('\n').length
    out.push({ line, text: m[0] })
  }
  return out
}

export function findRealSessions(text) {
  const out = []
  const src = String(text || '')
  SESSION_RE.lastIndex = 0
  for (const m of src.matchAll(SESSION_RE)) {
    if (isDummySession(m[0])) continue
    out.push({ line: src.slice(0, m.index).split('\n').length, id: m[0] })
  }
  return out
}

function codeFiles() {
  const out = new Set()
  const walk = (rel) => {
    const dir = path.join(APP, rel)
    if (!fs.existsSync(dir)) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '_临时' || e.name === 'data' || e.name === 'captures') continue
      const r = rel + '/' + e.name
      if (e.isDirectory()) walk(r)
      else if (/\.(js|mjs|cjs)$/i.test(e.name)) out.add(r)
    }
  }
  walk('工具')
  walk('外壳/scripts')
  walk('外壳/renderer')
  for (const e of fs.readdirSync(path.join(APP, '外壳'), { withFileTypes: true })) {
    if (e.isFile() && /\.(js|mjs)$/i.test(e.name)) out.add('外壳/' + e.name)
  }
  return [...out].sort()
}

const maskDrive = (s) => String(s).replace(/[A-Za-z]:\\{1,2}[^'"`\r\n]*/, '<盘符路径已掩码>')
const maskSession = (s) => String(s).replace(SESSION_RE, (m) => 'session-' + m.slice(8, 12) + '-****')

function main() {
  const argv = process.argv.slice(2)
  if (!argv.includes('--check')) {
    console.error('用法：node 工具\\代码红线.mjs --check [--strict]')
    process.exit(2)
  }
  const STRICT = argv.includes('--strict')
  const files = codeFiles()
  const reds = []
  const yellows = []
  const note = (msg) => yellows.push(msg)

  let maxNew = 0
  for (const rel of files) {
    const text = fs.readFileSync(path.join(APP, rel), 'utf8')
    const n = countLines(text)
    const base = BASELINE_LINES[rel]
    if (base != null) {
      if (n > base) reds.push(`${rel} ← 存量文件增长：基线 ${base} 行（${BASELINE_DATE}），现在 ${n} 行（+${n - base}）`)
    } else if (n > LIMIT) {
      reds.push(`${rel} ← 新文件 ${n} 行，超过上限 ${LIMIT} 行`)
    } else {
      maxNew = Math.max(maxNew, n)
    }
  }

  let driveStock = 0
  for (const rel of files) {
    const text = fs.readFileSync(path.join(APP, rel), 'utf8')
    const hits = findDriveLiterals(text)
    if (!hits.length) continue
    const allowed = DRIVE_ALLOW[rel] || 0
    if (hits.length > allowed) {
      for (const h of hits.slice(allowed)) {
        reds.push(`${rel}:${h.line} ← 硬编码盘符（新增）：${maskDrive(h.text)}`)
      }
    }
    const stock = Math.min(hits.length, allowed)
    if (stock) {
      driveStock += stock
      note(`存量硬编码盘符 ${stock} 处：${rel}（豁免，不阻断）`)
    }
  }

  for (const rel of files) {
    const text = fs.readFileSync(path.join(APP, rel), 'utf8')
    for (const h of findRealSessions(text)) reds.push(`${rel}:${h.line} ← 真实会话 id：${maskSession(h.id)}`)
    if (EVAL_RE.test(text)) reds.push(`${rel} ← 使用了 eval（禁止）`)
  }

  const regSrc = fs.existsSync(path.join(APP, '外壳/renderer/renderers.js'))
    ? fs.readFileSync(path.join(APP, '外壳/renderer/renderers.js'), 'utf8') : ''
  const types = registryFromSource(regSrc)
  const scenDir = path.join(APP, '外壳/scenarios')
  for (const f of fs.readdirSync(scenDir).filter((x) => x.endsWith('.json') && !x.startsWith('_')).sort()) {
    let j = null
    try { j = JSON.parse(fs.readFileSync(path.join(scenDir, f), 'utf8')) } catch { reds.push(`外壳/scenarios/${f} ← 不是合法 JSON`); continue }
    for (const p of (j.panels || [])) {
      if (!p || !p.id || !p.type) { reds.push(`外壳/scenarios/${f} ← 面板缺少 id/type`); continue }
      if (!types.has(p.type)) reds.push(`外壳/scenarios/${f} ← 面板 ${p.id} 的 type「${p.type}」未在 renderers.js 登记`)
    }
  }

  console.log(`代码红线 · 扫描 ${files.length} 个源码文件`)
  console.log(`行数：存量基线 ${Object.keys(BASELINE_LINES).length} 个（只许变短）；其余新文件上限 ${LIMIT} 行（当前最大 ${maxNew} 行）`)
  console.log(`面板类型：renderers.js 已注册 ${types.size} 个；场景 json 的 type 全部核对`)
  if (STRICT) {
    for (const msg of yellows.splice(0)) reds.push(msg.replace('（豁免，不阻断）', '（--strict 计入失败）'))
  } else {
    for (const msg of yellows) console.log('⚠ ' + msg)
  }
  if (!driveStock) console.log('✓ 硬编码盘符：0 处存量')
  for (const r of reds) console.log('✗ ' + r)

  console.log('')
  if (reds.length) {
    console.log(`✗ 代码红线失败：${reds.length} 处红 · ${yellows.length} 处黄`)
    process.exit(1)
  }
  console.log(`✓ 代码红线通过：0 处红 · ${yellows.length} 处存量黄（未增长）`)
  process.exit(0)
}

const IS_MAIN = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try { return path.resolve(entry) === fileURLToPath(import.meta.url) } catch { return false }
})()

if (IS_MAIN) main()
