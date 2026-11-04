#!/usr/bin/env node
/**
 * inventory.test.mjs —— 主进程清点模块 smoke test（2026-11-04）
 *
 *   node scripts/inventory.test.mjs
 *
 * 覆盖：versionInfo / listPlugins / listSkills / readToolCatalog / readSettings / frontmatter 解析。
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
const inventory = require('../main/inventory.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-inv-'));
const testDataDir = path.join(tmp, 'data');
fs.mkdirSync(testDataDir, { recursive: true });

const testCatalog = path.join(testDataDir, '工具清单.json');
fs.writeFileSync(testCatalog, JSON.stringify({
  updated: '2026-11-04',
  groups: [{ title: '测试组', items: [{ name: 'test-tool' }] }]
}), 'utf8');

const testSettings = path.join(tmp, 'settings.yaml');
fs.writeFileSync(testSettings, 'theme: dark\n', 'utf8');

const testCreds = path.join(tmp, '.credentials.yaml');
fs.writeFileSync(testCreds, 'api_key: "token_1234567890abcdef"\nshort: "ok"\n', 'utf8');

inventory.init({
  harnessDir: '',
  pluginsDir: path.join(tmp, 'plugins'),
  dshDataDir: tmp,
  toolsCatalogFile: testCatalog,
  settingsPath: testSettings,
  credentialsPath: testCreds,
  skillsDir: path.join(tmp, 'skills'),
  projectDir: ROOT,
});

let pass = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };

// 1. 版本读取
const v = inventory.versionInfo('0.2.1-test');
assert.ok(v && v.gui, '获取到 GUI 版本');
assert.equal(v.engine, null, '无引擎目录时 engine 为 null');
assert.equal(v.app, '0.2.1-test');
ok('versionInfo：读取 GUI 版本 ' + v.gui);

// 2. 工具清单读取
const cat = inventory.readToolCatalog();
assert.equal(cat.updated, '2026-11-04');
assert.equal(cat.groups.length, 1);
assert.equal(cat.groups[0].items[0].name, 'test-tool');
ok('readToolCatalog：正确读取并解析 JSON');

// 3. 设置与密钥脱敏
const s = inventory.readSettings();
assert.ok(s.files.settings.includes('theme: dark'));
assert.ok(s.files.credentials.includes('••••••（已隐藏）'), '长密钥必须脱敏');
assert.ok(s.files.credentials.includes('short: "ok"'), '短配置不误伤');
ok('readSettings：配置读取 + 凭据脱敏');

// 4. frontmatter 解析
const meta = inventory.parseSkillFrontmatter('---\nname: my-skill\ndescription: test desc\nwhenToUse: always\n---');
assert.equal(meta.name, 'my-skill');
assert.equal(meta.description, 'test desc');
assert.equal(meta.whenToUse, 'always');
ok('parseSkillFrontmatter：YAML frontmatter 解析');

// 5. 插件与技能空列表安全
const p = inventory.listPlugins();
assert.ok(Array.isArray(p.plugins) && p.plugins.length === 0);
const sk = inventory.listSkills();
assert.ok(Array.isArray(sk.skills));
ok('listPlugins / listSkills：目录空/不存在时安全降级');

// 6. 真实目录读取：外壳真实工具清单
inventory.init({
  harnessDir: '',
  pluginsDir: '',
  dshDataDir: path.join(APP_ROOT, '引擎数据', '.dsh'),
  toolsCatalogFile: path.join(ROOT, 'data', '工具清单.json'),
  settingsPath: '',
  credentialsPath: '',
  skillsDir: path.join(APP_ROOT, '引擎数据', '.dsh', 'skills'),
  projectDir: ROOT,
});
const realCat = inventory.readToolCatalog();
assert.ok(realCat && Array.isArray(realCat.groups) && realCat.groups.length > 0, '外壳真实工具清单可读取');
ok('真实工具清单：读取成功，包含 ' + realCat.groups.length + ' 个分组');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n✓ 清点模块 smoke test 全部通过：' + pass + ' 组');
