/**
 * 代码红线.mjs 的纯函数最小用例（node:test，无第三方依赖）
 * 运行：node --test 工具\代码红线.test.mjs
 *
 * 注意：本文件本身也在 代码红线 的扫描范围内，所以真实会话 id 与盘符样例
 * 一律在运行时拼接，不在源码里写成连续字面量（否则闸会扫到自己）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { countLines, isDummySession, findDriveLiterals, findRealSessions } from './代码红线.mjs'

const REAL_SESSION = ['session', '1a2b3c4d', '5e6f', '7a8b', '9c0d', '1e2f3a4b5c6d'].join('-')
const DUMMY_SESSION = ['session', 'aaaaaaaa', 'bbbb', 'cccc', 'dddd', 'eeeeeeeeeeee'].join('-')
const BS = String.fromCharCode(92)

test('countLines：按 LF 计数（含末尾空行）', () => {
  assert.equal(countLines('a'), 1)
  assert.equal(countLines('a\nb'), 2)
  assert.equal(countLines('a\r\nb\r\n'), 3)
})

test('isDummySession：重复字符的样本算占位，真实 UUID 不算', () => {
  assert.equal(isDummySession(DUMMY_SESSION), true)
  assert.equal(isDummySession(REAL_SESSION), false)
  assert.equal(isDummySession('not-a-session'), false)
})

test('findDriveLiterals：只认引号包住的盘符，并给出行号', () => {
  const d = 'D' + ':' + BS + BS + 'CODE'
  const e = 'E' + ':' + BS + BS + 'tmp'
  const src = `const a = '${d}'\nconst b = 'http://127.0.0.1:3083'\n// const c = "${e}"\n`
  const hits = findDriveLiterals(src)
  assert.equal(hits.length, 2)
  assert.equal(hits[0].line, 1)
  assert.equal(hits[1].line, 3)
})

test('findRealSessions：跳过重复字符样本，命中真实会话 id', () => {
  const hits = findRealSessions(`// ${DUMMY_SESSION}\nconst x = '${REAL_SESSION}'\n`)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].line, 2)
  assert.equal(hits[0].id, REAL_SESSION)
})
