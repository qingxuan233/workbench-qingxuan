#!/usr/bin/env node
/**
 * scenes-store.test.mjs —— 抽出的场景模块 smoke test（2026-11-04）
 *
 *   node scripts/scenes-store.test.mjs
 *
 * 覆盖：listScenarios / getScenario / readManifest / 标签顺序读写与 first 置顶。
 * 只在系统临时目录写 order 文件，不碰实例数据。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_ROOT = path.dirname(ROOT);
const store = require('../main/scenes.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-scenes-'));
const orderFile = path.join(tmp, 'order.json');
store.init({
  root: APP_ROOT,
  scenariosDir: path.join(ROOT, 'scenarios'),
  orderFile,
  log: () => {},
});

let pass = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };

// 1. 场景列表
const list = store.listScenarios();
assert.ok(Array.isArray(list) && list.length >= 4, '场景列表至少 4 条');
assert.ok(list.some((s) => s.id === 'command'), '包含 command');
assert.ok(list.every((s) => s.id && s.name), '每条都有 id/name');
ok('listScenarios：' + list.length + ' 个场景');

// 2. 读单个场景 + 实例叠加不炸
const cmd = store.getScenario('command');
assert.ok(cmd && Array.isArray(cmd.panels), 'command 有 panels');
assert.ok(cmd.panels.length >= 2, 'command 至少 2 个面板');
assert.equal(store.getScenario('__no_such_scene__'), null);
ok('getScenario：command ' + cmd.panels.length + ' 面板 / 不存在返回 null');

// 3. 标签顺序：写 → 读 → 排序（first 固定最前）
const saved = store.saveSceneTabOrder(['pc-cleanup', 'command', 'command', 'bilibili']);
assert.deepEqual(saved, ['pc-cleanup', 'command', 'bilibili'], '去重/去空');
assert.deepEqual(store.readSceneTabOrder(), saved, '读回一致');
const ordered = store.listScenarios().map((s) => s.id);
assert.equal(ordered[0], 'command', 'first 场景固定最前');
assert.ok(ordered.indexOf('pc-cleanup') > 0, '保存的顺序生效');
ok('scene-tab-order：写读一致 + first 置顶');

// 4. 坏文件不抛
fs.writeFileSync(orderFile, '{bad json', 'utf8');
assert.deepEqual(store.readSceneTabOrder(), [], '坏 json 按没存过处理');
ok('坏 order 文件：回退为空、不抛');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n✓ 场景模块 smoke test 全部通过：' + pass + ' 组');
