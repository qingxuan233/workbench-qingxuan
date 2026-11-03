/**
 * _场景绑定.js —— 「场景 json 是模板，实例真值只在 工作台.json」的唯一实现
 *
 * 为什么单独一个文件：
 *   运行时（外壳\main.js）与校验（工具\体检.mjs）必须用**同一套口径**解析
 *   「这个 AI 面板到底绑了哪条会话」；两处各写一套，迟早漂移成两份判据。
 *   放在公共模块里，main.js 用 require、体检.mjs 用 import（CJS 默认导出）。
 *
 * 目录约定：<代码根>\<仓库>\12-源码照搬\工具\ ← 本文件
 *   场景 json 里跟踪的路径用 {{APP_ROOT}} / {{REPO_ROOT}} / {{CODE_ROOT}} 记号，
 *   运行时替换成本机绝对路径；sessionId 写 __待填__，真实 id 从 工作台.json 叠加。
 */
const path = require('node:path')

const APP_ROOT = path.resolve(__dirname, '..')          // 12-源码照搬
const REPO_ROOT = path.dirname(APP_ROOT)                // 仓库根
const CODE_ROOT = path.dirname(REPO_ROOT)               // 代码根（各开发项目所在目录）

const TOKENS = {
  '{{APP_ROOT}}': APP_ROOT,
  '{{REPO_ROOT}}': REPO_ROOT,
  '{{CODE_ROOT}}': CODE_ROOT,
}

/**
 * 面板的有效会话 id。
 * 场景 json 自己的值优先（兼容老实例）；占位/缺失时取 工作台.json 的 scenes.<场景id>.sessionId。
 * @param {object} manifest 工作台.json 内容
 * @param {string} sceneId 场景 id
 * @param {object} panel 场景 json 里的面板
 * @returns {string} 有效会话 id；没有则空串
 */
function effectiveSessionId(manifest, sceneId, panel) {
  const own = String((panel && panel.sessionId) || '').trim()
  if (own && own !== '__待填__') return own
  const m = ((manifest && manifest.scenes) || {})[sceneId]
  const id = String((m && m.sessionId) || '').trim()
  return id && id !== '__待填__' ? id : ''
}

/** 递归替换模板记号（只处理字符串值） */
function expandTokens(value) {
  if (typeof value === 'string') return value.replace(/\{\{(APP_ROOT|REPO_ROOT|CODE_ROOT)\}\}/g, (m) => TOKENS[m] || m)
  if (Array.isArray(value)) return value.map(expandTokens)
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) value[k] = expandTokens(value[k])
    return value
  }
  return value
}

/**
 * 把场景模板变成当前实例可用的配置：先展开路径记号，再叠加清单里的会话绑定。
 * @param {object} scenario 场景 json
 * @param {object} manifest 工作台.json 内容
 */
function applySceneInstance(scenario, manifest) {
  if (!scenario || typeof scenario !== 'object') return scenario
  expandTokens(scenario)
  const sid = effectiveSessionId(manifest, scenario.id, null)
  if (sid) {
    for (const p of (Array.isArray(scenario.panels) ? scenario.panels : [])) {
      if (!p || p.type !== 'harness') continue
      const cur = String(p.sessionId || '').trim()
      if (!cur || cur === '__待填__') p.sessionId = sid
    }
  }
  return scenario
}

module.exports = { effectiveSessionId, applySceneInstance, CODE_ROOT }
