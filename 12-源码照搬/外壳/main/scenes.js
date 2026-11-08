'use strict';
/**
 * main/scenes.js —— 场景配置 / 实例清单 / 标签顺序（2026-11-04）
 *
 * 从 main.js 抽出的第一块主进程模块。目标：主进程按“域”拆，单文件可独立读。
 *
 * 依赖由 main.js 通过 init() 注入，模块本身不碰 Electron / 窗口：
 *   root        工作台根（工作台.json 所在目录）
 *   scenariosDir scenarios/*.json
 *   orderFile   data/scene-tab-order.json
 *   log         日志函数（可选）
 *
 * 行为与抽离前一致：
 *   - listScenarios() 按场景 json 文件自然序读，再按 scene-tab-order.json 排；
 *   - getScenario() 叠加 工作台.json 的实例字段（applySceneInstance）；
 *   - 读不到 / 坏 json 一律跳过，不抛。
 */
const fs = require('fs');
const path = require('path');
const { applySceneInstance } = require('../../工具/_场景绑定.js');

let CFG = null;

function init(cfg) {
  CFG = {
    root: cfg && cfg.root ? cfg.root : '',
    scenariosDir: cfg && cfg.scenariosDir ? cfg.scenariosDir : '',
    // P3-1：实例场景目录（不入库）。可由调用方显式给；缺省 = <scenariosDir>/_local
    localScenariosDir: (cfg && cfg.localScenariosDir) || ((cfg && cfg.scenariosDir) ? path.join(cfg.scenariosDir, '_local') : ''),
    orderFile: cfg && cfg.orderFile ? cfg.orderFile : '',
    log: (cfg && typeof cfg.log === 'function') ? cfg.log : function () {},
  };
}

function ready() {
  if (!CFG) throw new Error('scenes.js 未 init()');
  return CFG;
}

function manifestFile() {
  return path.join(ready().root, '工作台.json');
}

function readManifest() {
  try { return JSON.parse(fs.readFileSync(manifestFile(), 'utf8')) || {}; }
  catch (e) { return {}; }
}

function readSceneTabOrder() {
  const cfg = ready();
  if (!cfg.orderFile) return [];
  try {
    const j = JSON.parse(fs.readFileSync(cfg.orderFile, 'utf8'));
    if (j && Array.isArray(j.ids)) return j.ids.filter((x) => typeof x === 'string' && x);
  } catch (e) { /* 没有文件 / 内容坏了，都按"没存过"处理 */ }
  return [];
}

function saveSceneTabOrder(ids) {
  const cfg = ready();
  const clean = [];
  for (const raw of (Array.isArray(ids) ? ids : [])) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id || clean.indexOf(id) >= 0) continue;   // 去空、去重
    clean.push(id);
    if (clean.length >= 200) break;                // 上限：坏数据也写不爆文件
  }
  try {
    if (cfg.orderFile) {
      fs.mkdirSync(path.dirname(cfg.orderFile), { recursive: true });
      fs.writeFileSync(cfg.orderFile, JSON.stringify({
        version: 1, savedAt: new Date().toISOString(), ids: clean
      }, null, 2));
    }
  } catch (e) { cfg.log('[tabs] 保存场景标签顺序失败: ' + ((e && e.message) || e)); }
  return clean;
}

/** 按存下来的顺序排：已删掉的场景自动丢、新场景按 json 自然序追加在后面；标了 first 的场景固定在最前。 */
function applySceneTabOrder(list) {
  const saved = readSceneTabOrder();
  if (!saved.length) return list;
  const byId = {};
  list.forEach((s) => { byId[s.id] = s; });
  const ordered = saved.map((id) => byId[id]).filter(Boolean)
    .concat(list.filter((s) => saved.indexOf(s.id) < 0));
  return ordered.filter((s) => s.first).concat(ordered.filter((s) => !s.first));
}

function listScenarios() {
  const cfg = ready();
  const out = [];
  const push = (s, instance) => { out.push({ id: s.id, name: s.name, description: s.description || '', first: !!s.first, instance: !!instance }); };
  // ① 模板场景（顶层 scenarios/*.json；下划线开头的是说明/模板文件，不参与）
  if (cfg.scenariosDir && fs.existsSync(cfg.scenariosDir)) {
    for (const f of fs.readdirSync(cfg.scenariosDir).sort()) {
      if (f.startsWith('_')) continue;   // 客户版：_模板-*.json 不参与场景列表
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(cfg.scenariosDir, f), 'utf8'));
        if (s && s.id) push(s, false);
      } catch (e) { /* skip bad json */ }
    }
  }
  // ② 实例场景（scenarios/_local/*.json）；同 id 冲突 ⇒ 实例优先（运行时以本机实例为准），并告警
  if (cfg.localScenariosDir && fs.existsSync(cfg.localScenariosDir)) {
    for (const f of fs.readdirSync(cfg.localScenariosDir).sort()) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(cfg.localScenariosDir, f), 'utf8'));
        if (!s || !s.id) continue;
        const hit = out.findIndex((x) => x.id === s.id);
        if (hit >= 0) {
          cfg.log('[scenes] 实例场景与模板同 id 冲突：' + s.id + ' ⇒ 以 scenarios/_local 为准');
          out[hit] = { id: s.id, name: s.name, description: s.description || '', first: !!s.first, instance: true };
        } else {
          push(s, true);
        }
      } catch (e) { /* skip bad json */ }
    }
  }
  // 在这里就排好 ⇒ 任何消费方（主窗口标签栏 / 独立场景窗口 / 以后的新界面）拿到的顺序天然一致
  return applySceneTabOrder(out);
}

function getScenario(id) {
  const cfg = ready();
  if (!cfg.scenariosDir) return null;
  // P3-1：实例优先（同 id 冲突时 local 覆盖模板）
  const f = (cfg.localScenariosDir && fs.existsSync(path.join(cfg.localScenariosDir, id + '.json')))
    ? path.join(cfg.localScenariosDir, id + '.json')
    : path.join(cfg.scenariosDir, id + '.json');
  if (!fs.existsSync(f)) return null;
  try { return applySceneInstance(JSON.parse(fs.readFileSync(f, 'utf8')), readManifest()); }
  catch (e) { return null; }
}

module.exports = {
  init,
  readManifest,
  readSceneTabOrder,
  saveSceneTabOrder,
  listScenarios,
  getScenario,
};
