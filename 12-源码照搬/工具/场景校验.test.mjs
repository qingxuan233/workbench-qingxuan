/**
 * 场景校验.mjs 的纯函数最小用例（node:test，无第三方依赖）
 * 运行：node --test 工具\场景校验.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  registryFromSource,
  portsFromMain,
  validateScenes,
  sceneFacts,
  factTable,
  extractFactBlock,
  upsertFactBlock,
  factBlockMatches,
} from './场景校验.mjs'

const TYPES = new Set(['harness', 'view'])
// 与 场景校验.mjs 同一口径：逐段拼接，源码里不出现完整 session-<8hex>
const SAMPLE_SID = ['session', '11111111', '2222', '3333', '4444', '555555555555'].join('-')

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-test-'))
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2), 'utf8')
  }
  return dir
}

function goodScene(id = 'good', panelId = 'good-ai', sid = SAMPLE_SID) {
  return { id, name: '好场景', panels: [{ id: panelId, title: 'AI', type: 'harness', sessionTitle: '好场景', sessionId: sid, pinTarget: ['好场景'], col: 1, row: 1, w: 1, h: 1 }] }
}

test('registryFromSource：两种注册写法都能解析', () => {
  const src = "renderers['a-b'] = () => {}\nrenderers.c = function () {}\n// renderers['d'] 注释里不算"
  const types = registryFromSource(src)
  assert.ok(types.has('a-b'))
  assert.ok(types.has('c'))
  assert.equal(types.has('d'), false)
})

test('portsFromMain：解析三个端口与默认值', () => {
  const src = [
    "const DSH_PORT = String(process.env.DSH_PORT || '3083');",
    'const SITE_PORT = 31238;',
    'const WEB_AI_PORT = Number(process.env.WEB_AI_PORT || 31239);',
  ].join('\n')
  assert.deepEqual(portsFromMain(src), { engine: '3083', site: '31238', webai: '31239' })
  assert.deepEqual(portsFromMain(''), { engine: null, site: null, webai: null })
})

test('validateScenes：好样本 0 错误', () => {
  const dir = fixture({
    'good.json': goodScene(),
    'good-context.md': '- 场景 id：`good`\n- 面板：`good.json`\n',
  })
  const r = validateScenes([{ file: 'good.json', json: goodScene() }], { types: TYPES, scenariosDir: dir })
  fs.rmSync(dir, { recursive: true, force: true })
  assert.equal(r.errors.length, 0)
})

test('validateScenes：文件名与 id 不符、type 未注册、面板 id 重复、sessionId 非法都必须报错', () => {
  const dir = fixture({
    'a.json': goodScene('a', 'same', 'session-123'),
    'a-context.md': '- 场景 id：`a`\n- 面板：`same`\n',
    'b.json': { ...goodScene('b', 'same'), panels: [{ ...goodScene('b', 'same').panels[0], type: 'nope' }] },
    'b-context.md': '- 场景 id：`b`\n- 面板：`same`\n',
  })
  const items = [
    { file: 'renamed.json', json: goodScene('a', 'same', 'session-123') },
    { file: 'b.json', json: { ...goodScene('b', 'same'), panels: [{ ...goodScene('b', 'same').panels[0], type: 'nope' }] } },
  ]
  const r = validateScenes(items, { types: TYPES, scenariosDir: dir })
  fs.rmSync(dir, { recursive: true, force: true })
  const text = r.errors.map((e) => e.msg).join('\n')
  assert.match(text, /文件名与 id 不一致/)
  assert.match(text, /type 未注册/)
  assert.match(text, /面板 id 重复/)
  assert.match(text, /sessionId 形态非法/)
})

test('事实表：生成 → 写入 → 抽出 → 比对 一致', () => {
  const items = [
    { file: 'b.json', json: { id: 'b', name: '乙', panels: [{ id: 'b1', type: 'view' }, { id: 'b2', type: 'harness' }] } },
    { file: 'a.json', json: { id: 'a', name: '甲', first: true, panels: [{ id: 'a1', type: 'harness' }] } },
  ]
  const facts = sceneFacts(items, { engine: '3083', site: '31238', webai: '31239' })
  assert.equal(facts.count, 2)
  assert.equal(facts.panels, 3)
  assert.equal(facts.first.id, 'a')
  assert.match(factTable(facts).join('\n'), /`a` → 甲；`b` → 乙/)

  const doc = '# 说明\n\n## §0\n\n| 项 | 值 |\n|---|---|\n| x | y |\n\n---\n\n## §1\n'
  const stamped = upsertFactBlock(doc, facts)
  assert.ok(stamped.includes('<!-- 场景事实表:开始'))
  assert.ok(stamped.includes('## §1'))
  assert.equal(factBlockMatches(stamped, facts).ok, true)
  assert.ok(extractFactBlock(stamped).includes('| 场景数 | 2 |'))

  const drifted = stamped.replace('| 场景数 | 2 |', '| 场景数 | 3 |')
  const cmp = factBlockMatches(drifted, facts)
  assert.equal(cmp.ok, false)
  assert.equal(cmp.reason, 'drift')
})
