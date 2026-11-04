#!/usr/bin/env node
/**
 * dev-urls-panel.test.mjs —— 「开发服务与网址」数据层自检（识别结果 + 缓存 + 手动登记）
 *
 * 为什么有它：面板的元素（项目名/路径/服务名/URL/端口/分组）全部来自 dev-services.js，
 * 这个文件一旦认错工程（比如把 vite.config.ts 当视频、把 monorepo 根包当后端），
 * 面板不会报错、只会安静地显示错数据。这里把「代码根下各工程的应有结果」写成断言。
 *
 * 用法：node 外壳\scripts\dev-urls-panel.test.mjs
 * 退出码：0 全过 ｜ 1 有失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ds = require(path.join(HERE, 'dev-services.js'));

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('✓ ' + m); };
const bad = (m) => { fail++; console.log('✗ ' + m); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 代码根下「有可访问服务」的工程 → 应有 URL（顺序即面板顺序：web → api → docs → other）
const EXPECT = {
  'Financial Compensation': [
    'http://127.0.0.1:5173',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3000/docs',
    'http://127.0.0.1:3000/health'
  ],
  'bos': ['http://127.0.0.1:8080'],
  'erp-rebuild': ['http://127.0.0.1:5173', 'http://127.0.0.1:8080'],
  'medical-equipment-rental-system': [
    'http://127.0.0.1:3000',
    'http://127.0.0.1:8000',
    'http://127.0.0.1:8000/admin'
  ]
};
// 这些工程确实没有可访问的 Web/Node/Java 服务（数据脚本 / 插件 / IDE / 纯 SQL）
const EXPECT_EMPTY = ['WMS', 'ERP_SYSTEM', 'Fund_ledger', 'db-analyses', '开发分析',
  'acl-recovery', 'antigravity-ide', 'gemini-adapter', 'wifi', '原华华润接口', 'workbench-qingxuan'];

const URL_RE = /^http:\/\/127\.0\.0\.1:(\d{2,5})(\/[^\s]*)?$/;
const KINDS = new Set(['web', 'api', 'docs', 'other']);

const projects = fs.readdirSync(ds.CODE_ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name[0] !== '.')
  .map((e) => e.name)
  .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { sensitivity: 'base' }));

console.log('开发服务与网址 · 数据层自检');
console.log('代码根：' + ds.CODE_ROOT + '（' + projects.length + ' 个工程）');
console.log('-'.repeat(56));

const results = {};
projects.forEach((name) => {
  const dir = path.join(ds.CODE_ROOT, name);
  const r = ds.resolve({ projectPath: dir });
  results[name] = r;
  if (!r || r.ok !== true) { bad(name + '：resolve ok=false（' + (r && r.err) + '）'); return; }
  if (!r.project || path.resolve(r.project.path) !== path.resolve(dir)) bad(name + '：项目路径回填不对');
  const urls = r.services.map((s) => s.url);
  // 通用不变量：每条服务都是本机 http + 合法端口 + 非空名字 + 合法 kind + 去重
  r.services.forEach((s) => {
    const m = URL_RE.exec(String(s.url || ''));
    if (!m) bad(name + '：非法 URL ' + JSON.stringify(s.url));
    else if (Number(m[1]) < 1 || Number(m[1]) > 65535) bad(name + '：端口越界 ' + s.url);
    if (!s.name || !String(s.name).trim()) bad(name + '：服务缺名字 ' + s.url);
    if (!KINDS.has(s.kind)) bad(name + '：kind 非法 ' + JSON.stringify(s.kind));
    if (s.kind === 'docs' && !/\//.test(String(s.url).replace(/^https?:\/\/[^/]+/, ''))) {
      bad(name + '：docs 服务没有路径 ' + s.url);
    }
  });
  if (new Set(urls).size !== urls.length) bad(name + '：URL 有重复');
  if (r.warnings && r.warnings.length) bad(name + '：有识别警告 ' + r.warnings.join('；'));
});

// 1) 有服务的工程：URL 集合必须与期望一致（多一条、少一条都算错）
Object.keys(EXPECT).forEach((name) => {
  const got = ((results[name] && results[name].services) || []).map((s) => s.url);
  if (eq(got, EXPECT[name])) ok(name + '：' + got.length + ' 条服务与期望一致');
  else bad(name + '：期望 [' + EXPECT[name].join(', ') + ']，实际 [' + got.join(', ') + ']');
});

// 2) 无服务的工程：必须为空（宁缺毋滥，别硬编一个假地址）
EXPECT_EMPTY.forEach((name) => {
  const got = ((results[name] && results[name].services) || []).map((s) => s.url);
  if (!got.length) ok(name + '：无服务（正确）');
  else bad(name + '：本应无服务，却识别出 [' + got.join(', ') + ']');
});

// 3) 关键字段抽查：名字/端口/启动命令/框架线索
const fc = results['Financial Compensation'];
if (fc && fc.startCmd === 'pnpm dev') ok('Financial Compensation：一键启动命令 = pnpm dev');
else bad('Financial Compensation：startCmd 应为 pnpm dev，实际 ' + JSON.stringify(fc && fc.startCmd));
const fcApi = fc && fc.services.find((s) => s.kind === 'api');
if (fcApi && /\/api\/v1/.test(fcApi.note)) ok('Financial Compensation：API 备注带接口前缀 /api/v1');
else bad('Financial Compensation：API 备注缺接口前缀');
const med = results['medical-equipment-rental-system'];
if (med && med.services.some((s) => /Django/.test(s.name) && /:8000$/.test(s.url))) ok('medical-equipment：Django 后端 8000');
else bad('medical-equipment：没认出 Django 8000');
const erp = results['erp-rebuild'];
if (erp && erp.services.some((s) => /Spring Boot/.test(s.name) && /:8080$/.test(s.url))) ok('erp-rebuild：Spring Boot 8080');
else bad('erp-rebuild：没认出 Spring Boot 8080');
const bos = results['bos'];
if (bos && bos.services.some((s) => /Docker/.test(s.name) && /:8080$/.test(s.url))) ok('bos：docker-compose Hop 8080');
else bad('bos：没认出 docker-compose 8080');
// .ts 不是视频（这条曾经把 vitest.config.ts 渲成视频占位卡）
const anyTs = fs.readdirSync(path.join(ds.CODE_ROOT, 'Financial Compensation'), { withFileTypes: true })
  .some((e) => e.isFile() && /^vitest\.config\.ts$/i.test(e.name));
if (anyTs) ok('Financial Compensation：根目录有 vitest.config.ts（面板文件列表应显示为文本，不是视频）');
else ok('Financial Compensation：根目录没有 vitest.config.ts（跳过文件列表检查）');

// 4) 手动登记 + 隐藏：写一份临时登记，验证覆盖/隐藏/来源标记，然后原样恢复
const REG = ds.REGISTRY_FILE;
const backup = fs.existsSync(REG) ? fs.readFileSync(REG, 'utf8') : null;
try {
  fs.mkdirSync(path.dirname(REG), { recursive: true });
  fs.writeFileSync(REG, JSON.stringify({
    version: 1,
    projects: {
      'Financial Compensation': {
        services: [{ name: '手动测试服务', url: 'http://127.0.0.1:4321', note: '自检用' }],
        hide: ['http://127.0.0.1:3000/health']
      }
    }
  }, null, 2) + '\n', 'utf8');
  const r = ds.resolve({ projectPath: path.join(ds.CODE_ROOT, 'Financial Compensation') });
  const urls = r.services.map((s) => s.url);
  if (urls.indexOf('http://127.0.0.1:4321') >= 0 && urls.indexOf('http://127.0.0.1:3000/health') < 0) {
    ok('手动登记：新增 4321 生效、hide 掉 /health 生效');
  } else bad('手动登记合并不对：' + urls.join(', '));
  const manual = r.services.find((s) => s.url === 'http://127.0.0.1:4321');
  if (manual && manual.source === 'manual') ok('手动登记：来源标记 manual');
  else bad('手动登记：来源标记不是 manual');
} catch (e) {
  bad('手动登记用例异常：' + ((e && e.message) || e));
} finally {
  try {
    if (backup == null) { if (fs.existsSync(REG)) fs.unlinkSync(REG); }
    else fs.writeFileSync(REG, backup, 'utf8');
  } catch (e) { /* 恢复失败不掩盖上面的结果 */ }
}

// 5) 缓存与实时结果一致（面板在旧主进程上读的就是这份）
try {
  projects.forEach((name) => {
    const r = ds.resolve({ projectPath: path.join(ds.CODE_ROOT, name) });
    ds.writeCache(r);
  });
  const cache = JSON.parse(fs.readFileSync(ds.CACHE_FILE, 'utf8'));
  let cacheBad = 0;
  projects.forEach((name) => {
    const hit = cache.projects && cache.projects[name];
    const live = (results[name] || {}).services || [];
    if (!hit) { cacheBad++; bad('缓存缺工程：' + name); return; }
    const a = hit.services.map((s) => s.url).join(',');
    const b = live.map((s) => s.url).join(',');
    if (a !== b) { cacheBad++; bad('缓存与实时不一致：' + name + '（缓存 ' + a + ' / 实时 ' + b + '）'); }
  });
  if (!cacheBad) ok('缓存：' + projects.length + ' 个工程与实时识别一致');
} catch (e) {
  bad('缓存校验异常：' + ((e && e.message) || e));
}

console.log('-'.repeat(56));
console.log((fail ? '✗ ' : '✓ ') + '自检结果：' + pass + ' 通过 · ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
