#!/usr/bin/env node
/**
 * 场景校验.mjs —— 场景 json 的结构闸 + AGENTS「场景事实表」的生成/比对
 *
 * 背景：
 *   场景 json 是「场景 ↔ 面板 ↔ 会话」的唯一真源（见 身份索引.mjs 的说明）。
 *   但真源本身也会写坏：文件名与 id 漂移、面板类型没注册、面板 id 撞车、
 *   sessionId 是随手复制的残缺串 —— 这些都不是语法错，JSON.parse 照样能过，
 *   直到界面白屏或面板「未切到」才被发现。
 *   本工具把这几类问题变成一条可失败的检查，并把「场景数 / 名称 / 端口」
 *   这类事实写进 AGENTS.md 的固定区块，避免文档与实践各说各话。
 *
 * 用法：
 *   node 工具\场景校验.mjs --check       结构校验 + 事实段比对（有漂移退出码 1）
 *   node 工具\场景校验.mjs --stamp       重写身份索引表 + AGENTS 事实段（不动区块外内容）
 *   node 工具\场景校验.mjs --self-test   坏样本必须报红（4 类反例）
 *
 * 退出码：0 通过 ｜1 有错误/漂移 ｜2 用法错误
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '..')
const SCEN_DIR = path.join(APP, '外壳', 'scenarios')
const REG_FILE = path.join(APP, '外壳', 'renderer', 'renderers.js')
const MAIN_FILE = path.join(APP, '外壳', 'main.js')
const AGENTS_FILE = path.resolve(APP, '..', 'AGENTS.md')

const MARK_START = '<!-- 场景事实表:开始（工具\\场景校验.mjs --stamp 生成；勿手改） -->'
const MARK_END = '<!-- 场景事实表:结束 -->'

/** 合法会话 id：session-<8-4-4-4-12 十六进制>；模板态允许 __待填__ */
const SESSION_RE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PLACEHOLDER = '__待填__'

const readText = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }
const readJson = (p) => { try { return JSON.parse(readText(p) || '') } catch { return null } }

/** 从 renderers.js 源码提取已注册的面板类型（与 check-gui.mjs 第 3 项同一判据） */
export function registryFromSource(src) {
  const types = new Set()
  for (const m of (src || '').matchAll(/renderers\[['"]([^'"]+)['"]\]\s*=/g)) types.add(m[1])
  for (const m of (src || '').matchAll(/\nrenderers\.([A-Za-z_$][\w$]*)\s*=/g)) types.add(m[1])
  return types
}

/** 从 main.js 读取三个端口（环境变量名一并带出，供事实表说明） */
export function portsFromMain(src) {
  const s = src || ''
  const engine = (s.match(/const DSH_PORT = String\(process\.env\.DSH_PORT \|\| '(\d+)'\)/) || [])[1] || null
  const site = (s.match(/const SITE_PORT = (\d+)/) || [])[1] || null
  const webai = (s.match(/const WEB_AI_PORT = Number\(process\.env\.WEB_AI_PORT \|\| (\d+)\)/) || [])[1] || null
  return { engine, site, webai }
}

const isPosInt = (v) => Number.isInteger(v) && v >= 1

/**
 * 校验场景集合。
 * items: [{ file, json }]，file 为展示用的相对路径
 * opts:  { types:Set, scenariosDir:绝对路径 }
 * 返回 { errors:[{file,msg}], warnings:[{file,msg}] }
 */
export function validateScenes(items, opts) {
  const errors = []
  const warnings = []
  const addErr = (file, msg) => errors.push({ file, msg })
  const addWarn = (file, msg) => warnings.push({ file, msg })
  const idOwners = new Map()
  const panelOwners = new Map()

  for (const { file, json } of items) {
    if (!json || typeof json !== 'object') { addErr(file, '不是合法 JSON 对象'); continue }
    const id = json.id
    const base = path.basename(file).replace(/\.json$/i, '')

    if (base !== id) addErr(file, `文件名与 id 不一致：文件名「${base}」，id「${String(id)}」`)
    if (typeof id !== 'string' || !id) addErr(file, 'id 缺失或不是字符串')
    else if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) addErr(file, `id 形态非法：「${id}」（只允许小写字母、数字、连字符）`)
    else if (idOwners.has(id)) addErr(file, `场景 id 重复：与 ${idOwners.get(id)} 撞车`)
    else idOwners.set(id, file)
    if (typeof json.name !== 'string' || !json.name.trim()) addErr(file, 'name 缺失或为空')

    if (json.cols != null && !isPosInt(json.cols)) addErr(file, `cols 不是正整数：${JSON.stringify(json.cols)}`)
    const panels = Array.isArray(json.panels) ? json.panels : null
    if (!panels || !panels.length) { addErr(file, 'panels 缺失或为空数组'); continue }

    for (const p of panels) {
      const pid = p && p.id
      const tag = `面板「${String(pid)}」`
      if (typeof pid !== 'string' || !pid) { addErr(file, '面板 id 缺失或不是字符串'); continue }
      if (panelOwners.has(pid)) addErr(file, `面板 id 重复：${tag} 与 ${panelOwners.get(pid)} 撞车`)
      else panelOwners.set(pid, file)

      if (typeof p.type !== 'string' || !p.type) addErr(file, `${tag} 的 type 缺失`)
      else if (!opts.types.has(p.type)) addErr(file, `${tag} 的 type 未注册：「${p.type}」（renderers.js 里没有对应渲染器）`)

      for (const k of ['col', 'row', 'w', 'h']) {
        if (!isPosInt(p[k])) addErr(file, `${tag} 的 ${k} 不是正整数：${JSON.stringify(p[k])}`)
      }
      if (json.cols != null && isPosInt(json.cols) && isPosInt(p.col) && isPosInt(p.w) && p.col + p.w - 1 > json.cols) {
        addWarn(file, `${tag} 横向越界：col=${p.col} + w=${p.w} 超过 cols=${json.cols}`)
      }

      if (p.type === 'harness') {
        if (typeof p.sessionTitle !== 'string' || !p.sessionTitle.trim()) addErr(file, `${tag} 缺少 sessionTitle（会话名是绑定判据之一）`)
        if (typeof p.sessionId !== 'string' || !p.sessionId.trim()) {
          addErr(file, `${tag} 缺少 sessionId（模板态应写 ${PLACEHOLDER}）`)
        } else if (p.sessionId !== PLACEHOLDER && !SESSION_RE.test(p.sessionId)) {
          addErr(file, `${tag} 的 sessionId 形态非法（应为 session-8-4-4-4-12 十六进制，或模板占位 ${PLACEHOLDER}）`)
        }
        if (p.pinTarget != null) {
          if (!Array.isArray(p.pinTarget) || !p.pinTarget.length || p.pinTarget.some((x) => typeof x !== 'string' || !x.trim())) {
            addErr(file, `${tag} 的 pinTarget 必须是至少一项的非空字符串数组`)
          } else if (typeof p.sessionTitle === 'string' && p.sessionTitle.trim() && p.pinTarget[0] !== p.sessionTitle) {
            addErr(file, `${tag} 的 pinTarget 首项「${p.pinTarget[0]}」与 sessionTitle「${p.sessionTitle}」不一致`)
          }
        }
      }
    }

    // 定位卡：文件必须存在，且写明了本场景 id 与面板文件
    const ctxRel = json.contextFile || `${String(id)}-context.md`
    const ctxAbs = path.join(opts.scenariosDir, ctxRel)
    if (!fs.existsSync(ctxAbs)) {
      addErr(file, `定位卡不存在：scenarios\\${ctxRel}`)
    } else {
      const ctx = readText(ctxAbs) || ''
      if (!ctx.includes(String(id))) addErr(file, `定位卡 scenarios\\${ctxRel} 里没写本场景 id「${String(id)}」`)
      const panelRef = (json.panels || []).some((p) => p && typeof p.id === 'string' && ctx.includes(p.id))
      if (!panelRef && !ctx.includes(`${String(id)}.json`)) {
        addErr(file, `定位卡 scenarios\\${ctxRel} 既没引用面板文件 ${String(id)}.json，也没写面板 id`)
      }
    }
  }
  return { errors, warnings }
}

/** 汇总事实（供 AGENTS 事实表生成） */
export function sceneFacts(items, ports) {
  const scenes = items
    .filter((x) => x.json && typeof x.json.id === 'string')
    .map((x) => ({ id: x.json.id, name: x.json.name || '', panels: (x.json.panels || []).length, harness: (x.json.panels || []).filter((p) => p && p.type === 'harness').length, first: !!x.json.first }))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
  return {
    count: scenes.length,
    scenes,
    panels: scenes.reduce((n, s) => n + s.panels, 0),
    harness: scenes.reduce((n, s) => n + s.harness, 0),
    first: scenes.find((s) => s.first) || null,
    ports: ports || { engine: null, site: null, webai: null },
  }
}

/** 事实表的表格体（不含标记行） */
export function factTable(facts) {
  const p = facts.ports
  const portLine = [
    p.engine ? `引擎 \`${p.engine}\`（\`DSH_PORT\`）` : '引擎端口未解析',
    p.site ? `站点 \`${p.site}\`（写死）` : '站点端口未解析',
    p.webai ? `网页版 AI 桥 \`${p.webai}\`（\`WEB_AI_PORT\`）` : '网页版 AI 桥端口未解析',
  ].join('；')
  const sceneLine = facts.scenes.map((s) => `\`${s.id}\` → ${s.name}`).join('；')
  return [
    '| 项 | 值 |',
    '|---|---|',
    `| 场景数 | ${facts.count} |`,
    `| 场景（id → 标题） | ${sceneLine} |`,
    `| 面板总数 | ${facts.panels} |`,
    `| AI 面板（harness） | ${facts.harness} |`,
    `| 首屏场景 | ${facts.first ? '`' + facts.first.id + '`' : '（未标记）'} |`,
    `| 端口 | ${portLine} |`,
    '| 场景配置目录 | `12-源码照搬\\外壳\\scenarios` |',
  ]
}

/** 取出 AGENTS 里的事实段（含标记之间的原始行）；没有返回 null */
export function extractFactBlock(text) {
  if (!text) return null
  const a = text.indexOf(MARK_START)
  if (a < 0) return null
  const b = text.indexOf(MARK_END, a)
  if (b < 0) return null
  return text.slice(a + MARK_START.length, b).replace(/^\r?\n/, '').replace(/\r?\n$/, '')
}

const norm = (block) => (block || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '')

/** 事实段是否与生成结果一致 */
export function factBlockMatches(text, facts) {
  const cur = extractFactBlock(text)
  if (cur == null) return { ok: false, reason: 'missing', current: [] }
  const want = norm(factTable(facts).join('\n'))
  const got = norm(cur)
  const same = want.length === got.length && want.every((l, i) => got[i] === l)
  return { ok: same, reason: same ? 'same' : 'drift', current: got, expected: want }
}

/** 把事实段写进 AGENTS（只动标记之间；没有标记就插在 §0 表格之后） */
export function upsertFactBlock(text, facts) {
  const body = factTable(facts).join('\n')
  const block = `${MARK_START}\n${body}\n${MARK_END}`
  const a = text.indexOf(MARK_START)
  if (a >= 0) {
    const b = text.indexOf(MARK_END, a)
    if (b >= 0) return text.slice(0, a) + block + text.slice(b + MARK_END.length)
  }
  const lines = text.split(/\r?\n/)
  const sec = lines.findIndex((l) => l.startsWith('## §0'))
  let anchor = -1
  if (sec >= 0) {
    for (let i = sec; i < lines.length; i++) {
      if (/^---\s*$/.test(lines[i])) { anchor = i; break }
    }
  } else {
    anchor = lines.findIndex((l) => /^---\s*$/.test(l))
  }
  const next = [...lines]
  if (anchor < 0) next.push('', block, '')
  else {
    const after = lines[anchor + 1]
    next.splice(anchor + 1, 0, ...(after === '' ? [block, ''] : ['', block, '']))
  }
  return next.join('\n')
}

/** 读取磁盘上的场景集合；跳过非 .json 与下划线开头的说明文件 */
export function loadScenes(dir) {
  const items = []
  for (const f of fs.readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.json') && !x.startsWith('_')).sort()) {
    const abs = path.join(dir, f)
    items.push({ file: `外壳/scenarios/${f}`, abs, json: readJson(abs) })
  }
  return items
}

function collect(opts = {}) {
  const scenDir = opts.scenariosDir || SCEN_DIR
  const regFile = opts.regFile || REG_FILE
  const mainFile = opts.mainFile || MAIN_FILE
  const items = loadScenes(scenDir)
  const types = registryFromSource(readText(regFile) || '')
  const ports = portsFromMain(readText(mainFile) || '')
  return { items, types, ports, result: validateScenes(items, { types, scenariosDir: scenDir }) }
}

function printIssues(result) {
  for (const e of result.errors) console.log(`✗ ${e.file} ← ${e.msg}`)
  for (const w of result.warnings) console.log(`⚠ ${w.file} ← ${w.msg}`)
}

function runCheck() {
  const { items, types, ports, result } = collect()
  console.log(`场景目录：${SCEN_DIR}`)
  console.log(`已注册面板类型 ${types.size} 个；场景 ${items.length} 个；端口：引擎 ${ports.engine || '?'} / 站点 ${ports.site || '?'} / 网页版 AI 桥 ${ports.webai || '?'}`)

  const agents = readText(AGENTS_FILE)
  if (agents == null) {
    result.errors.push({ file: 'AGENTS.md', msg: '读不到 AGENTS.md（事实段无处比对）' })
  } else {
    const facts = sceneFacts(items, ports)
    const cmp = factBlockMatches(agents, facts)
    if (cmp.reason === 'missing') {
      result.errors.push({ file: 'AGENTS.md', msg: '缺少场景事实表区块（先运行 工具\\场景校验.mjs --stamp）' })
    } else if (!cmp.ok) {
      const n = Math.max(cmp.expected.length, cmp.current.length)
      const diffs = []
      for (let i = 0; i < n; i++) {
        if ((cmp.current[i] || '') === (cmp.expected[i] || '')) continue
        diffs.push(`期望：${cmp.expected[i] || '（缺行）'} / 实际：${cmp.current[i] || '（缺行）'}`)
      }
      result.errors.push({ file: 'AGENTS.md', msg: `场景事实表与场景 json 不一致（${diffs.length} 行）；先运行 --stamp\n      ` + diffs.slice(0, 6).join('\n      ') })
    }
  }

  printIssues(result)
  console.log('')
  if (result.errors.length) {
    console.log(`✗ 场景校验失败：${result.errors.length} 个错误 · ${result.warnings.length} 个警告`)
    process.exit(1)
  }
  console.log(`✓ 场景校验通过：${items.length} 个场景 · ${sceneFacts(items, ports).panels} 个面板 · 事实表一致${result.warnings.length ? ` · ${result.warnings.length} 个警告` : ''}`)
  process.exit(0)
}

function runStamp() {
  const { items, ports, result } = collect()
  if (result.errors.length) {
    printIssues(result)
    console.log('\n✗ 结构未通过，拒绝盖章（先修上面的错误）')
    process.exit(1)
  }
  const idx = spawnSync(process.execPath, [path.join(HERE, '身份索引.mjs'), '--stamp'], { cwd: APP, encoding: 'utf8' })
  const idxOut = (String(idx.stdout || '') + String(idx.stderr || '')).trim().split(/\r?\n/).filter(Boolean)
  if (idx.status !== 0) {
    console.log('✗ 身份索引.mjs --stamp 失败：')
    for (const l of idxOut.slice(-6)) console.log('  ' + l)
    process.exit(1)
  }
  console.log('✓ 身份索引：' + (idxOut.filter((l) => l.startsWith('✓')).pop() || '已重写').replace(/^✓\s*/, ''))

  const agents = readText(AGENTS_FILE)
  if (agents == null) { console.log('✗ 读不到 ' + AGENTS_FILE); process.exit(1) }
  const facts = sceneFacts(items, ports)
  const next = upsertFactBlock(agents, facts)
  if (next === agents) console.log('✓ AGENTS 事实段已是最新（未改写）')
  else {
    fs.writeFileSync(AGENTS_FILE, next, 'utf8')
    console.log(`✓ 已重写 AGENTS 事实段：${facts.count} 个场景 · ${facts.panels} 个面板（区块外内容原样保留）`)
  }
  process.exit(0)
}

// ── 自检：4 类坏样本必须被点名，好样本必须放过 ──────────
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'scene-'))
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2), 'utf8')
  }
  return dir
}

const TYPES = new Set(['harness', 'view'])
// 自检样本 id 逐段拼接：源码里不出现完整的 session-<8hex>，避免被发布前红线误判为真实会话 id
const SAMPLE_SID = ['session', '11111111', '2222', '3333', '4444', '555555555555'].join('-')

function goodScene(id = 'good', panelId = 'good-ai', sid = SAMPLE_SID) {
  return { id, name: '好场景', layout: 'grid', panels: [{ id: panelId, title: 'AI', type: 'harness', sessionTitle: '好场景', sessionId: sid, pinTarget: ['好场景'], col: 1, row: 1, w: 1, h: 1 }] }
}

function runSelfTest() {
  const cases = []
  const add = (name, files, expect) => cases.push({ name, files, expect })

  add('好样本 → 必须全绿', {
    'scenarios/good.json': goodScene(),
    'scenarios/good-context.md': '# 好场景 · 定位卡\n\n- 场景 id：`good`\n- 面板：`外壳\\scenarios\\good.json`\n',
  }, null)

  add('文件名与 id 不符 → 必须报红', {
    'scenarios/renamed.json': goodScene('good'),
    'scenarios/good-context.md': '- 场景 id：`good`\n- 面板：`good.json`\n',
  }, '文件名与 id 不一致')

  add('type 未注册 → 必须报红', {
    'scenarios/good.json': { ...goodScene(), panels: [{ id: 'x', title: 'X', type: 'nope', col: 1, row: 1, w: 1, h: 1 }] },
    'scenarios/good-context.md': '- 场景 id：`good`\n- 面板：`good.json`\n',
  }, 'type 未注册')

  add('面板 id 重复 → 必须报红', {
    'scenarios/a.json': goodScene('a', 'same'),
    'scenarios/a-context.md': '- 场景 id：`a`\n- 面板：`a.json`\n',
    'scenarios/b.json': goodScene('b', 'same'),
    'scenarios/b-context.md': '- 场景 id：`b`\n- 面板：`b.json`\n',
  }, '面板 id 重复')

  add('sessionId 形态非法 → 必须报红', {
    'scenarios/good.json': goodScene('good', 'good-ai', 'session-123'),
    'scenarios/good-context.md': '- 场景 id：`good`\n- 面板：`good.json`\n',
  }, 'sessionId 形态非法')

  add('定位卡缺失 → 必须报红', {
    'scenarios/good.json': goodScene(),
  }, '定位卡不存在')

  let pass = 0
  let fail = 0
  for (const c of cases) {
    const dir = fixture(c.files)
    const items = loadScenes(path.join(dir, 'scenarios'))
    const r = validateScenes(items, { types: TYPES, scenariosDir: path.join(dir, 'scenarios') })
    fs.rmSync(dir, { recursive: true, force: true })
    let ok
    if (c.expect == null) ok = r.errors.length === 0
    else ok = r.errors.some((e) => e.msg.includes(c.expect))
    console.log(`${ok ? '  ✓' : '  ✗'} ${c.name}${ok ? '' : `（未命中「${c.expect || '全绿'}」；实际 ${r.errors.length} 个错误）`}`)
    ok ? pass++ : fail++
  }
  console.log(`\n自检：${pass} 通过 · ${fail} 失败`)
  return fail === 0
}

// ── CLI ─────────────────────────────────────────────────
const IS_MAIN = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try { return path.resolve(entry) === fileURLToPath(import.meta.url) } catch { return false }
})()

if (IS_MAIN) {
  const argv = process.argv.slice(2)
  const has = (k) => argv.includes(k)
  if (has('--self-test')) process.exit(runSelfTest() ? 0 : 1)
  if (has('--check')) runCheck()
  if (has('--stamp')) runStamp()
  console.error('用法：node 工具\\场景校验.mjs [--check|--stamp|--self-test]')
  process.exit(2)
}
