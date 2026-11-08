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
 * 2026-11-08「死区清理后重定」：
 *   删掉两个死数据表（sector-data.js 8668 行 / us-sector-data.js 8394 行）与
 *   renderers.js 的三个渲染死区（radar 雷达/机会池 822 行、market/board 残留 88 行、
 *   flow 画布 814 行，保留仍被 view 复用的 flowPathParts），renderers.js 基线由
 *   历史值 18863 按删除后实测值重定；其余项实测未变、保持现值。
 *   死区判定依据见 _本机产物/优化报告/改造执行/P0-B-死区清理.md（本机产物，不入库）。
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
const BASELINE_DATE = '2026-11-08'

/** 存量 >800 行文件的行数基线：只允许变短，不允许变长
 *  2026-11-08 死区清理后重定：仅 renderers.js 按删除后实测值重定，其余项保持现值 */
const BASELINE_LINES = {
  '外壳/renderer/renderers.js': 3609,        // 2026-11-08 P2-D 阶段3c：embed 本体 238 + 主机侧/chrome 装饰区 771 + review-doc 286 搬入 panels/（实测 3608 行 +1 尾部空行；基线只许更小）
  '外壳/main.js': 5130,
  '外壳/renderer/renderer.js': 1355,
  '外壳/renderer/topbar-status.js': 1733,
  '外壳/renderer/webai-bridge.js': 1569,     // 2026-11-04：并入主题同步（外壳深/浅色推给内嵌网页版 AI），基线同步
  '工具/体检.mjs': 887,                      // 2026-11-07：新增 A16「实例工作区有效」+ 3 个反例（死路径轮），基线同步；下次再加断言请先拆模块
}

/** 存量硬编码盘符豁免（已全部清零：源码中禁止任何盘符硬编码） */
const DRIVE_ALLOW = {
  '工具/初始化.mjs': 0,
  '外壳/main.js': 0,
  '外壳/renderer/renderers.js': 0,
  '外壳/scripts/pc-scan.mjs': 0,
  '外壳/scripts/webai.mjs': 0,
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
  // 2026-11-08（P1）：main/ 与 core/ 原来不在扫描范围 —— 主进程模块和能力层同样是"会被提交的源码"，
  //   盘符硬编码/真实会话 id/eval/新增文件 ≤800 行 这些红线必须同样适用（否则新增层天然免检）。
  walk('外壳/main')
  walk('外壳/core')
  // 2026-11-08（P2）：engine-adapter = 引擎契约与注入脚本的唯一实现，同样是"会被提交的源码"
  walk('外壳/engine-adapter')
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
    // 2026-11-08（P1）：UTF-8 → ANSI 乱码哨兵。本环境 PowerShell 读写中文会把 UTF-8 写成乱码，
    //   子代理已踩两次（P0 的 agent-gateway/workbench-mcp、P1 又各一次）。这类文件往往还能过 --check 之外的静态闸，
    //   所以必须在这里拦。判定：同一文件出现 ≥2 个哨兵字符（单个可能是正常字形，误报可忽略）。
    //   ⚠ 哨兵表必须用 \u 转义写：直接写这些字面量会让本文件自己被判红（自检时踩过）。
    const MOJI = ['\u951b', '\u9225', '\u9286', '\u7035', '\u9359', '\u93c2', '\u5a67', '\u5bf0', '\u74ba', '\u935b',
      '\u7eef', '\u7efe', '\u6d93', '\u95ab', '\u9354', '\u93c4', '\u6769', '\u9428', '\u935c', '\u93b4']
    const mojiHits = MOJI.filter((s) => text.includes(s))
    if (mojiHits.length >= 2) reds.push(`${rel} ← 疑似 UTF-8 乱码（命中 ${mojiHits.length} 个哨兵）`)
  }

  // P2-D：面板类型注册源 = renderers.js + renderer/panels/*.js（多文件注册；只扩解析范围，断言不变）
  const regSrc = (() => {
    const regFile = path.join(APP, '外壳/renderer/renderers.js')
    let t = fs.existsSync(regFile) ? fs.readFileSync(regFile, 'utf8') : ''
    try {
      const panelsDir = path.join(APP, '外壳/renderer/panels')
      if (fs.existsSync(panelsDir)) {
        for (const f of fs.readdirSync(panelsDir).filter((x) => x.endsWith('.js')).sort()) {
          t += '\n' + fs.readFileSync(path.join(panelsDir, f), 'utf8')
        }
      }
    } catch (e) { /* ignore */ }
    return t
  })()
  const types = registryFromSource(regSrc)
  const scenDir = path.join(APP, '外壳/scenarios')
  for (const f of fs.readdirSync(scenDir).filter((x) => x.endsWith('.json') && !x.startsWith('_')).sort()) {
    let j = null
    try { j = JSON.parse(fs.readFileSync(path.join(scenDir, f), 'utf8')) } catch { reds.push(`外壳/scenarios/${f} ← 不是合法 JSON`); continue }
    for (const p of (j.panels || [])) {
      if (!p || !p.id || !p.type) { reds.push(`外壳/scenarios/${f} ← 面板缺少 id/type`); continue }
      if (!types.has(p.type)) reds.push(`外壳/scenarios/${f} ← 面板 ${p.id} 的 type「${p.type}」未在注册源（renderers.js / panels*.js）登记`)
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
