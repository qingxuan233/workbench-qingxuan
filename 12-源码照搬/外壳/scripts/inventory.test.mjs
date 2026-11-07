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

// 7. 外部 CLI 内核版本探测（2026-11-07：源码直跑形态下 engine 不再恒为 null）
//    本机真实布局（官方桌面版）：<安装>\resources\runtime\cli\bin\dsh.cmd + primary-runtime\runtime.json
const fakeInstall = path.join(tmp, 'fake-install');
fs.mkdirSync(path.join(fakeInstall, 'runtime', 'cli', 'bin'), { recursive: true });
fs.mkdirSync(path.join(fakeInstall, 'runtime', 'primary-runtime'), { recursive: true });
const fakeCli = path.join(fakeInstall, 'runtime', 'cli', 'bin', 'dsh.cmd');
fs.writeFileSync(fakeCli, '@echo off\r\n', 'utf8');
fs.writeFileSync(path.join(fakeInstall, 'runtime', 'primary-runtime', 'runtime.json'),
  JSON.stringify({ desktopVersion: '9.9.9-test' }), 'utf8');
inventory.init({
  harnessDir: '',
  engineCliPath: fakeCli,
  pluginsDir: '',
  dshDataDir: tmp,
  toolsCatalogFile: testCatalog,
  settingsPath: '',
  credentialsPath: '',
  skillsDir: '',
  projectDir: ROOT,
});
const vExt = inventory.versionInfo('0.2.1-test');
assert.equal(vExt.engine, '9.9.9-test', '官方桌面版布局应探测到内核版本');
assert.equal(vExt.engineSource, 'runtime.json');
assert.equal(vExt.engineProbe, true, '新主进程标志必须为 true（渲染层据此显示两行版本）');
assert.equal(vExt.gui, v.gui, 'GUI 版本仍来自外壳 package.json，不能被内核版本顶替');
ok('versionInfo：外部 CLI 形态探测到内核版本 ' + vExt.engine + '（来源 ' + vExt.engineSource + '）');

// 7b. npm 全局安装布局：<root>\node_modules\@deepseek-ai\dsh\package.json
const fakeNpm = path.join(tmp, 'fake-npm');
fs.mkdirSync(path.join(fakeNpm, 'bin'), { recursive: true });
fs.mkdirSync(path.join(fakeNpm, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
const npmCli = path.join(fakeNpm, 'bin', 'dsh.cmd');
fs.writeFileSync(npmCli, '@echo off\r\n', 'utf8');
fs.writeFileSync(path.join(fakeNpm, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  JSON.stringify({ name: '@deepseek-ai/dsh', version: '8.8.8-test' }), 'utf8');
inventory.init({
  harnessDir: '',
  engineCliPath: npmCli,
  pluginsDir: '',
  dshDataDir: tmp,
  toolsCatalogFile: testCatalog,
  settingsPath: '',
  credentialsPath: '',
  skillsDir: '',
  projectDir: ROOT,
});
const vNpm = inventory.versionInfo('0.2.1-test');
assert.equal(vNpm.engine, '8.8.8-test');
assert.equal(vNpm.engineSource, 'npm');
ok('versionInfo：npm 全局布局探测到内核版本 ' + vNpm.engine);

// 7c. 探测不到 = 未知（null），不瞎猜
inventory.init({
  harnessDir: '',
  engineCliPath: path.join(tmp, 'no-such-dir', 'dsh.cmd'),
  pluginsDir: '',
  dshDataDir: tmp,
  toolsCatalogFile: testCatalog,
  settingsPath: '',
  credentialsPath: '',
  skillsDir: '',
  projectDir: ROOT,
});
const vNone = inventory.versionInfo('0.2.1-test');
assert.equal(vNone.engine, null);
assert.equal(vNone.engineSource, '');
ok('versionInfo：探测不到内核版本时如实为 null（不猜）');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n✓ 清点模块 smoke test 全部通过：' + pass + ' 组');
