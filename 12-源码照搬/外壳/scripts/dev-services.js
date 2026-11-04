#!/usr/bin/env node
/**
 * dev-services.js —— 「工作项目开发」场景的服务与调试地址（单一真源）。识别 package.json / pnpm-workspace / vite / next / nest / Django / Spring Boot / docker-compose / .env，识别不出用 外壳\data\dev-services.json 手动登记兜底。不写死盘符、纯 CommonJS；消费方：主进程 IPC `code:dev-services` / 渲染层缓存 / 命令行 [--write][--all][--json]；退出码 0 成功 / 1 没指定项目 / 2 用法错误。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SHELL_DIR = path.resolve(__dirname, '..');                 // <应用根>\外壳
const APP_ROOT = path.resolve(SHELL_DIR, '..');                  // <应用根>
const DATA_DIR = path.join(SHELL_DIR, 'data');
const CURRENT_PROJECT_FILE = path.join(DATA_DIR, 'current-project.json');
const REGISTRY_FILE = path.join(DATA_DIR, 'dev-services.json');  // 手动登记（人改，代码只读）
const CACHE_FILE = path.join(DATA_DIR, 'dev-services-cache.json'); // 自动识别结果（本模块写）

const MAX_TEXT = 512 * 1024;   // 单个配置文件最多读 512KB（package.json / vite 配置不会更大）
const MAX_PKGS = 16;           // 一个工程最多认 16 个包，防止巨型 monorepo 拖慢面板
const MAX_SCAN_FILES = 300;    // Nest 源码扫描上限（找 Swagger / 全局前缀 / 健康检查）

// 开发项目总根：优先环境变量；否则按「应用根 = <代码根>\<仓库>\12-源码照搬」推导（与 工具\当前项目.mjs 同口径）
const CODE_ROOT = (() => {
  const fromEnv = String(process.env.DSH_CODE_ROOT || '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  try {
    const rec = readJson(CURRENT_PROJECT_FILE);
    if (rec && rec.baseDir) return path.resolve(String(rec.baseDir));
  } catch (e) { /* ignore */ }
  return path.dirname(path.dirname(APP_ROOT));
})();

// ---------------------------------------------------------------------------
// 基础读取（全部吞异常：读不到 = 没这条信息，不是错误）
// ---------------------------------------------------------------------------
function readText(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_TEXT) return '';
    return fs.readFileSync(p, 'utf8');
  } catch (e) { return ''; }
}
function readJson(p) {
  const t = readText(p);
  if (!t) return null;
  try { return JSON.parse(t.replace(/^\uFEFF/, '')); } catch (e) { return null; }
}
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }
function listDir(p) { try { return fs.readdirSync(p, { withFileTypes: true }); } catch (e) { return []; } }
function firstExisting(dir, names) {
  for (const n of names) {
    const p = path.join(dir, n);
    if (isFile(p)) return p;
  }
  return '';
}
function uniq(arr) { return [...new Set(arr)]; }

// ---------------------------------------------------------------------------
// 工作区发现：pnpm-workspace.yaml / package.json workspaces / 常见目录名
// ---------------------------------------------------------------------------
const CONVENTIONAL_DIRS = ['apps', 'services', 'packages', 'server', 'web', 'client',
  'frontend', 'backend', 'admin', 'api', 'site', 'docs'];

function workspaceGlobs(projectPath, rootPkg) {
  const out = [];
  const add = (arr) => {
    if (!Array.isArray(arr)) return;
    arr.forEach((g) => {
      if (typeof g !== 'string') return;
      const v = g.trim();
      if (v && v[0] !== '!' && v[0] !== '#') out.push(v);
    });
  };
  if (rootPkg && rootPkg.workspaces) {
    add(Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : (rootPkg.workspaces.packages || []));
  }
  // pnpm-workspace.yaml 只认 `packages:` 下面的 `- 'apps/*'` 这种浅层列表（不引 yaml 依赖）
  const yml = readText(path.join(projectPath, 'pnpm-workspace.yaml'));
  if (yml) {
    let inPackages = false;
    for (const raw of yml.split(/\r?\n/)) {
      const line = raw.replace(/\t/g, '  ');
      if (/^\s{0,2}packages\s*:/.test(line)) { inPackages = true; continue; }
      if (!inPackages) continue;
      if (/^\s*#/.test(line) || !line.trim()) continue;
      const m = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/);
      if (m && m[1].trim()) {
        const g = m[1].trim();
        if (g[0] !== '!') out.push(g);
        continue;
      }
      if (/^\S/.test(line)) inPackages = false;   // 出了 packages 块
    }
  }
  return uniq(out);
}

// 只支持「一级通配」：apps/*、packages/*、services/* —— 遇到 ** 就放弃（不递归扫全盘）
function expandGlob(projectPath, glob) {
  const g = String(glob || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!g || g.indexOf('**') >= 0) return [];
  const parts = g.split('/').filter(Boolean);
  if (!parts.length) return [];
  if (parts[parts.length - 1] !== '*') {
    const dir = path.join(projectPath, ...parts);
    return isFile(path.join(dir, 'package.json')) ? [dir] : [];
  }
  const base = path.join(projectPath, ...parts.slice(0, -1));
  if (!isDir(base)) return [];
  return listDir(base)
    .filter((d) => d.isDirectory())
    .map((d) => path.join(base, d.name))
    .filter((p) => isFile(path.join(p, 'package.json')));
}

function candidatePackages(projectPath) {
  const rootPkg = readJson(path.join(projectPath, 'package.json'));
  const dirs = [];
  const push = (d) => {
    if (d && dirs.indexOf(d) < 0 && isFile(path.join(d, 'package.json'))) dirs.push(d);
  };
  if (rootPkg) push(projectPath);
  workspaceGlobs(projectPath, rootPkg).forEach((g) => expandGlob(projectPath, g).forEach(push));
  CONVENTIONAL_DIRS.forEach((name) => {
    const d = path.join(projectPath, name);
    if (!isDir(d)) return;
    if (isFile(path.join(d, 'package.json'))) push(d);
    if (name === 'apps' || name === 'services' || name === 'packages') {
      listDir(d).filter((x) => x.isDirectory()).forEach((x) => push(path.join(d, x.name)));
    }
  });
  // 兜底：有些工程把可运行子工程再套一层（medical-equipment-rental-system/…、src/server/…）
  // 只往下探 2 层、跳过依赖/构建目录，且只收带 package.json 的目录（是不是服务交给 servicesOfPackage 判）
  const found = [];
  walkPackages(projectPath, 2, found, 30);
  found.forEach(push);
  return { rootPkg, dirs: dirs.slice(0, MAX_PKGS) };
}

const SKIP_WALK_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',
  '.turbo', '.cache', 'vendor', 'temp', 'tmp', '.venv', 'venv', '__pycache__', 'artifacts', 'captures']);
function walkPackages(root, depth, out, cap) {
  if (depth < 0 || out.length >= cap) return;
  listDir(root).forEach((e) => {
    if (out.length >= cap || !e.isDirectory()) return;
    if (SKIP_WALK_DIRS.has(e.name.toLowerCase()) || e.name[0] === '.') return;
    const dir = path.join(root, e.name);
    if (isFile(path.join(dir, 'package.json'))) out.push(dir);
    if (depth > 0) walkPackages(dir, depth - 1, out, cap);
  });
}

// 通用：找「目录里有某个标志文件」的子目录（含工程根本身）
function walkForFile(root, filename, depth, cap, out) {
  if (depth < 0 || out.length >= cap) return;
  listDir(root).forEach((e) => {
    if (out.length >= cap || !e.isDirectory()) return;
    if (SKIP_WALK_DIRS.has(e.name.toLowerCase()) || e.name[0] === '.') return;
    const dir = path.join(root, e.name);
    if (isFile(path.join(dir, filename))) out.push(dir);
    if (depth > 0) walkForFile(dir, filename, depth - 1, cap, out);
  });
}
function dirsWith(projectPath, filename, depth, cap) {
  const out = [];
  if (isFile(path.join(projectPath, filename))) out.push(projectPath);
  walkForFile(projectPath, filename, depth, cap, out);
  return out;
}

// ---------------------------------------------------------------------------
// 非 npm 后端：Django（manage.py）/ Spring Boot（pom.xml）/ docker-compose 里的 Web 服务
// （2026-11-04 适配 代码根：erp-rebuild 是 Vite + Spring Boot，medical-equipment-rental-system
//   是 CRA + Django，bos 用 docker 起 Apache Hop 8080 —— 都要能认出来）
// ---------------------------------------------------------------------------
function djangoServices(projectPath, dir) {
  if (!isFile(path.join(dir, 'manage.py'))) return [];
  let port = 8000;
  const bat = readText(path.join(dir, 'start.bat')) + readText(path.join(dir, '启动.bat'))
    + readText(path.join(dir, 'README.md'));
  const m = bat.match(/runserver\s+[^\s:]*:(\d{2,5})/) || bat.match(/runserver\s+(\d{2,5})/)
    || bat.match(/(?:port|端口)[^\d]{0,8}(\d{2,5})/i);
  if (m) port = Number(m[1]);
  const base = 'http://127.0.0.1:' + port;
  const venv = isFile(path.join(dir, 'venv', 'Scripts', 'python.exe'));
  const name = path.resolve(dir) === path.resolve(projectPath) ? 'Django 后端' : (path.basename(dir) + ' · Django');
  const out = [{
    name: name, url: base,
    note: 'Django · ' + (venv ? 'venv\\Scripts\\python' : 'python') + ' manage.py runserver',
    kind: 'api', source: 'auto', port: port, framework: 'django'
  }];
  // 后台管理页：只有 urls.py 里真正挂了 admin.site.urls 才加（避免假链接）
  const hasAdmin = dirsWith(dir, 'urls.py', 2, 20).some((d) => readText(path.join(d, 'urls.py')).indexOf('admin.site.urls') >= 0);
  if (hasAdmin) {
    out.push({
      name: 'Django Admin', url: base + '/admin',
      note: 'Django 管理后台', kind: 'docs', source: 'auto', port: port, framework: 'django'
    });
  }
  return out;
}

function springService(projectPath, dir) {
  const pom = readText(path.join(dir, 'pom.xml'));
  if (!/spring-boot/.test(pom)) return null;
  const artifacts = (pom.match(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/g) || [])
    .map((s) => s.replace(/<\/?artifactId>\s*/g, '').trim());
  const artifact = artifacts.find((a) => a && !/^spring-boot/.test(a)) || path.basename(dir);
  let port = 8080;
  const yml = readText(path.join(dir, 'src', 'main', 'resources', 'application.yml'));
  const prop = readText(path.join(dir, 'src', 'main', 'resources', 'application.properties'));
  let m = yml.match(/server\s*:\s*[\s\S]{0,300}?port\s*:\s*(\d{2,5})/) || yml.match(/port\s*:\s*(\d{2,5})/);
  if (!m) m = prop.match(/server\.port\s*=\s*(\d{2,5})/);
  if (m) port = Number(m[1]);
  const mvn = (isFile(path.join(dir, 'mvnw.cmd')) || isFile(path.join(dir, 'mvnw'))) ? '.\\mvnw' : 'mvn';
  return {
    name: artifact + ' · Spring Boot', url: 'http://127.0.0.1:' + port,
    note: 'Spring Boot · ' + mvn + ' spring-boot:run',
    kind: 'api', source: 'auto', port: port, framework: 'spring'
  };
}

const WEB_IMAGE_RE = /(nginx|httpd|apache|traefik|caddy|hop|grafana|kibana|portainer|minio|adminer|phpmyadmin|jenkins|sonar|web|ui|frontend|backend|api|server)/i;
const DB_PORT_RE = /^(5432|3306|6379|27017|1433|1521|9200|9300|5672|11211|2375|2379|2181|9092)$/;
function dockerServices(projectPath) {
  const files = [];
  ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].forEach((n) => {
    ['', 'docker', 'deploy', 'devops'].forEach((sub) => {
      const f = sub ? path.join(projectPath, sub, n) : path.join(projectPath, n);
      if (isFile(f)) files.push(f);
    });
  });
  const seen = {};
  const out = [];
  files.forEach((f) => {
    const lines = readText(f).split(/\r?\n/);
    let inServices = false;
    let cur = '';
    const svcInfo = {};
    lines.forEach((raw) => {
      const line = raw.replace(/\t/g, '  ');
      if (/^services\s*:/.test(line)) { inServices = true; return; }
      if (!inServices) return;
      const top = line.match(/^ {2}([A-Za-z0-9._-]+)\s*:\s*$/);
      if (top) { cur = top[1]; svcInfo[cur] = svcInfo[cur] || { image: '', ports: [] }; return; }
      if (!cur) return;
      const img = line.match(/^\s+image\s*:\s*['"]?([^'"\s#]+)/);
      if (img) { svcInfo[cur].image = img[1]; return; }
      const pm = line.match(/^\s*-\s*['"]?([\d.\-:]+)['"]?\s*(?:#.*)?$/);
      if (pm) {
        const parts = pm[1].split(':').filter(Boolean);
        if (parts.length >= 2) {
          const container = Number(parts[parts.length - 1]);
          const host = Number(parts[parts.length - 2]);
          if (host > 0 && container > 0) svcInfo[cur].ports.push({ host, container });
        }
      }
    });
    Object.keys(svcInfo).forEach((k) => {
      const info = svcInfo[k];
      if (!info.image || !info.ports.length) return;
      if (!WEB_IMAGE_RE.test(info.image)) return;
      info.ports.forEach((p) => {
        if (DB_PORT_RE.test(String(p.host))) return;
        const key = k + '|' + p.host;
        if (seen[key]) return;
        seen[key] = true;
        out.push({
          name: k + ' · Docker', url: 'http://127.0.0.1:' + p.host,
          note: 'docker compose · ' + info.image,
          kind: 'other', source: 'auto', port: p.host, framework: 'docker'
        });
      });
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// 框架识别（文件优先，其次依赖）
// ---------------------------------------------------------------------------
const CONFIG_FILES = {
  vite: ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs'],
  next: ['next.config.js', 'next.config.mjs', 'next.config.ts'],
  nuxt: ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs'],
  svelte: ['svelte.config.js'],
  astro: ['astro.config.mjs', 'astro.config.ts', 'astro.config.js'],
  angular: ['angular.json'],
  webpack: ['webpack.config.js', 'webpack.config.ts', 'webpack.config.mjs'],
  vueCli: ['vue.config.js', 'vue.config.ts']
};

const FRAMEWORK_LABEL = {
  vite: 'Vite', next: 'Next.js', nuxt: 'Nuxt', svelte: 'SvelteKit', astro: 'Astro',
  angular: 'Angular', webpack: 'Webpack', vueCli: 'Vue CLI', cra: 'React (CRA)',
  static: '静态服务器', nest: 'NestJS', node: 'Node 服务',
  django: 'Django', spring: 'Spring Boot', docker: 'Docker 容器'
};
const FRAMEWORK_KIND = {
  vite: 'web', next: 'web', nuxt: 'web', svelte: 'web', astro: 'web',
  angular: 'web', webpack: 'web', vueCli: 'web', cra: 'web', static: 'web',
  nest: 'api', node: 'api', django: 'api', spring: 'api', docker: 'other'
};
const DEFAULT_PORT = {
  vite: 5173, next: 3000, nuxt: 3000, svelte: 5173, astro: 4321,
  angular: 4200, webpack: 8080, vueCli: 8080, cra: 3000, static: 8080,
  nest: 3000, node: 3000, django: 8000, spring: 8080, docker: 0
};

function hasDep(pkg, names) {
  const all = Object.assign({}, (pkg && pkg.dependencies) || {}, (pkg && pkg.devDependencies) || {});
  return names.some((n) => Object.prototype.hasOwnProperty.call(all, n));
}

function detectFramework(dir, pkg) {
  const has = (k) => !!firstExisting(dir, CONFIG_FILES[k]);
  if (has('angular')) return 'angular';
  if (has('vite')) return 'vite';
  if (has('next')) return 'next';
  if (has('nuxt')) return 'nuxt';
  if (has('svelte') || hasDep(pkg, ['@sveltejs/kit'])) return 'svelte';
  if (has('astro') || hasDep(pkg, ['astro'])) return 'astro';
  if (hasDep(pkg, ['react-scripts'])) return 'cra';
  if (hasDep(pkg, ['@nestjs/core'])) return 'nest';
  if (has('webpack')) return 'webpack';
  if (has('vueCli')) return 'vueCli';
  if (hasDep(pkg, ['http-server', 'serve', 'live-server'])) return 'static';
  if (hasDep(pkg, ['express', 'fastify', 'koa', '@hapi/hapi'])) return 'node';
  return '';
}

// 端口识别顺序：启动脚本里的 --port > 框架配置文件 > .env 的 PORT > 框架默认端口
function portFromScript(script) {
  const s = String(script || '');
  let m = s.match(/--port[= ]+(\d{2,5})/);
  if (m) return Number(m[1]);
  m = s.match(/(?:^|\s)-p\s+(\d{2,5})/);
  return m ? Number(m[1]) : 0;
}
function portFromVite(dir) {
  const f = firstExisting(dir, CONFIG_FILES.vite);
  if (!f) return 0;
  const t = readText(f);
  const m = t.match(/(?:server|preview)\s*:\s*\{[\s\S]{0,600}?port\s*:\s*(\d{2,5})/);
  return m ? Number(m[1]) : 0;
}
function envFiles(projectPath) {
  const out = [];
  ['.env', '.env.local', '.env.development', '.env.dev'].forEach((n) => {
    const p = path.join(projectPath, n);
    if (isFile(p)) out.push(p);
  });
  return out;
}
function portFromEnv(projectPath) {
  for (const f of envFiles(projectPath)) {
    const m = readText(f).match(/^\s*(?:export\s+)?PORT\s*=\s*['"]?(\d{2,5})['"]?\s*$/m);
    if (m) return Number(m[1]);
  }
  return 0;
}
function portFromNest(dir) {
  // Nest 的端口写在 src/main.ts 里：DEFAULT_PORT / process.env.PORT || N / app.listen(N)
  const files = [path.join(dir, 'src', 'main.ts'), path.join(dir, 'src', 'main.js'),
    path.join(dir, 'main.ts'), path.join(dir, 'main.js')];
  for (const f of files) {
    const t = readText(f);
    if (!t) continue;
    let m = t.match(/DEFAULT_PORT\s*=\s*(\d{2,5})/);
    if (m) return Number(m[1]);
    m = t.match(/PORT['"]?\]?\s*\|\|\s*(\d{2,5})/);
    if (m) return Number(m[1]);
    m = t.match(/\.listen\(\s*(\d{2,5})/);
    if (m) return Number(m[1]);
  }
  return 0;
}

// Nest 源码里的「接口前缀 / Swagger 文档 / 健康检查」——只做一次浅扫描（深度 ≤3、文件数 ≤300）
function collectSourceFiles(dir, depth, cap, out) {
  out = out || [];
  if (depth < 0 || out.length >= cap) return out;
  listDir(dir).forEach((e) => {
    if (out.length >= cap) return;
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git' || e.name === 'coverage') return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collectSourceFiles(full, depth - 1, cap, out);
    else if (/\.(ts|js|mts|cts)$/.test(e.name)) out.push(full);
  });
  return out;
}
function nestMeta(dir) {
  const meta = { swagger: '', prefix: '', health: '' };
  const files = collectSourceFiles(path.join(dir, 'src'), 3, MAX_SCAN_FILES);
  for (const f of files) {
    const t = readText(f);
    if (!t) continue;
    if (!meta.swagger) {
      const m = t.match(/SwaggerModule\.setup\(\s*['"]([^'"]+)['"]/);
      if (m) meta.swagger = m[1].replace(/^\/+|\/+$/g, '');
    }
    if (!meta.prefix) {
      const m = t.match(/setGlobalPrefix\(\s*['"]([^'"]+)['"]/);
      if (m) meta.prefix = m[1].replace(/^\/+|\/+$/g, '');
      else {
        // 常见写法：setGlobalPrefix(API_PREFIX, …) + 同文件 const API_PREFIX = 'api/v1'
        const id = t.match(/setGlobalPrefix\(\s*([A-Za-z_$][\w$]*)/);
        if (id) {
          const lit = t.match(new RegExp('(?:const|let|var)\\s+' + id[1].replace(/[$]/g, '\\$') + '\\s*(?::[^=]+)?=\\s*[\'"]([^\'"]+)[\'"]'));
          if (lit) meta.prefix = lit[1].replace(/^\/+|\/+$/g, '');
        }
      }
    }
    if (!meta.health) {
      const m = t.match(/HEALTH_PATH\s*=\s*['"]([^'"]+)['"]/);
      if (m) meta.health = m[1].replace(/^\/+|\/+$/g, '');
    }
    if (meta.swagger && meta.prefix && meta.health) break;
  }
  return meta;
}

function shortName(pkg, dir) {
  const name = String((pkg && pkg.name) || '').trim();
  if (name) {
    const cut = name.indexOf('/');
    return cut >= 0 ? name.slice(cut + 1) : name;
  }
  return path.basename(dir);
}
function displayName(pkg, dir, framework, manyPackages) {
  const desc = String((pkg && pkg.description) || '').replace(/\s+/g, ' ').trim();
  if (desc && desc.length <= 24) return desc;
  const short = shortName(pkg, dir);
  const label = FRAMEWORK_LABEL[framework] || '服务';
  return manyPackages ? (short + ' · ' + label) : (short + ' · ' + label);
}

function runCommand(projectPath, dir, pkgName, scriptName) {
  const isPnpm = isFile(path.join(projectPath, 'pnpm-lock.yaml')) || isFile(path.join(projectPath, 'pnpm-workspace.yaml'));
  const root = path.resolve(projectPath);
  const rel = path.relative(root, dir);
  const isRoot = !rel || rel === '.';
  const runner = isPnpm ? 'pnpm' : 'npm';
  if (!isRoot && pkgName && isPnpm) return 'pnpm --filter ' + pkgName + ' ' + scriptName;
  if (!isRoot && isPnpm) return 'pnpm --dir ' + rel.replace(/\\/g, '/') + ' ' + scriptName;
  return runner + (isPnpm ? ' ' : ' run ') + scriptName;
}

// 单个包 → 服务（可能 0 条：库包 / 桌面应用 / 没 dev 脚本）
function servicesOfPackage(projectPath, dir, pkg, warnings) {
  const scripts = (pkg && pkg.scripts) || {};
  const scriptName = ['dev', 'start', 'serve', 'develop', 'dev:web', 'dev:server']
    .find((k) => typeof scripts[k] === 'string' && scripts[k].trim());
  const framework = detectFramework(dir, pkg);
  if (!scriptName && !framework) return [];          // 纯库：没有启动方式
  if (!framework && hasDep(pkg, ['electron']) && !hasDep(pkg, ['express', 'fastify', 'koa'])) return []; // 桌面端没有网址
  const fw = framework || 'node';

  let port = portFromScript(scripts[scriptName]);
  if (!port && fw === 'vite') port = portFromVite(dir);
  if (!port && fw === 'nest') port = portFromNest(dir);
  if (!port) port = portFromEnv(projectPath);
  if (!port) port = DEFAULT_PORT[fw] || 3000;

  const baseUrl = 'http://127.0.0.1:' + port;
  const cmd = runCommand(projectPath, dir, pkg && pkg.name, scriptName || 'dev');
  const out = [];
  const label = FRAMEWORK_LABEL[fw] || '服务';
  const meta = fw === 'nest' ? nestMeta(dir) : { swagger: '', prefix: '', health: '' };
  let note = label + ' · ' + cmd;
  if (meta.prefix) note += ' · 接口前缀 /' + meta.prefix;
  out.push({
    name: displayName(pkg, dir, fw, true),
    url: baseUrl,
    note: note,
    kind: FRAMEWORK_KIND[fw] || 'other',
    source: 'auto',
    port: port,
    framework: fw
  });
  if (meta.swagger) {
    out.push({
      name: 'Swagger 接口文档',
      url: baseUrl + '/' + meta.swagger,
      note: 'NestJS 交互文档（开发环境）',
      kind: 'docs',
      source: 'auto',
      port: port,
      framework: fw
    });
  }
  if (meta.health) {
    out.push({
      name: '健康检查',
      url: baseUrl + '/' + meta.health,
      note: '运维探活用（不在 /api 前缀下）',
      kind: 'docs',
      source: 'auto',
      port: port,
      framework: fw
    });
  }
  if (!out.length) warnings.push('包 ' + shortName(pkg, dir) + ' 没认出端口');
  return out;
}

// ---------------------------------------------------------------------------
// 手动登记（外壳\data\dev-services.json）—— 人改，本模块只读
//   { "version": 1, "projects": { "<项目名>": {
//       "auto": true,                                  // false = 只用下面登记的
//       "services": [ { "name": "...", "url": "...", "note": "...", "phone": false } ],
//       "hide": [ "http://127.0.0.1:5173" ] } } }
// ---------------------------------------------------------------------------
function loadRegistry() {
  const j = readJson(REGISTRY_FILE);
  if (!j || typeof j !== 'object') return { version: 1, projects: {} };
  if (!j.projects || typeof j.projects !== 'object') j.projects = {};
  return j;
}
function applyRegistry(projectName, detected) {
  const reg = loadRegistry();
  const entry = reg.projects[String(projectName || '')] || null;
  let list = detected.slice();
  let autoDisabled = false;
  if (entry && typeof entry === 'object') {
    autoDisabled = entry.auto === false;
    if (autoDisabled) list = [];
    (Array.isArray(entry.services) ? entry.services : []).forEach((s) => {
      if (!s || !s.url || s.enabled === false) return;
      const norm = {
        name: String(s.name || s.url),
        url: String(s.url),
        note: String(s.note || ''),
        kind: String(s.kind || 'other'),
        phone: !!s.phone,
        source: 'manual'
      };
      const i = list.findIndex((x) => x.url === norm.url);
      if (i >= 0) list[i] = Object.assign({}, list[i], norm, { source: 'manual' });
      else list.push(norm);
    });
    const hide = Array.isArray(entry.hide) ? entry.hide.map(String) : [];
    if (hide.length) list = list.filter((x) => hide.indexOf(x.url) < 0);
  }
  return { list, autoDisabled, registered: !!entry };
}

// ---------------------------------------------------------------------------
// 汇总：当前项目 + 服务清单（去重 / 排序 / 附启动命令）
// ---------------------------------------------------------------------------
const SORT_ORDER = { web: 0, api: 1, docs: 2, other: 3 };

function detectProject(projectPath, warnings) {
  const { rootPkg, dirs } = candidatePackages(projectPath);
  const rootAbs = path.resolve(projectPath);
  const kids = dirs.filter((d) => path.resolve(d) !== rootAbs);
  const byDirs = (list) => {
    let out = [];
    list.forEach((dir) => {
      const pkg = readJson(path.join(dir, 'package.json'));
      if (!pkg) return;
      try {
        out = out.concat(servicesOfPackage(projectPath, dir, pkg, warnings));
      } catch (e) {
        warnings.push('识别 ' + dir + ' 失败：' + ((e && e.message) || e));
      }
    });
    return out;
  };
  // 先认各子包；一条都没有才把「根包」当服务 —— monorepo 的根包通常只是 pnpm dev 编排器
  // （Financial Compensation 的根包 devDependencies 里就有 @nestjs/core，直接认会误报成 API）
  let services = kids.length ? byDirs(kids) : [];
  if (!services.length && dirs.indexOf(projectPath) >= 0) services = byDirs([projectPath]);
  // Python / Java / Docker：不是 npm 包的后端与服务，单独认
  dirsWith(projectPath, 'manage.py', 3, 4).forEach((dir) => {
    try { services = services.concat(djangoServices(projectPath, dir)); }
    catch (e) { warnings.push('识别 Django（' + dir + '）失败：' + ((e && e.message) || e)); }
  });
  dirsWith(projectPath, 'pom.xml', 3, 4).forEach((dir) => {
    try { const s = springService(projectPath, dir); if (s) services.push(s); }
    catch (e) { warnings.push('识别 Spring Boot（' + dir + '）失败：' + ((e && e.message) || e)); }
  });
  try { services = services.concat(dockerServices(projectPath)); }
  catch (e) { warnings.push('识别 docker compose 失败：' + ((e && e.message) || e)); }
  // 去重（同一地址只留一条；手动的在 applyRegistry 里覆盖）
  const seen = {};
  services = services.filter((s) => {
    if (!s || !s.url) return false;
    if (seen[s.url]) return false;
    seen[s.url] = true;
    return true;
  });
  services.sort((a, b) => {
    const ra = Object.prototype.hasOwnProperty.call(SORT_ORDER, a.kind) ? SORT_ORDER[a.kind] : 9;
    const rb = Object.prototype.hasOwnProperty.call(SORT_ORDER, b.kind) ? SORT_ORDER[b.kind] : 9;
    return ra - rb || String(a.url).localeCompare(String(b.url));
  });
  // 工程级启动命令（monorepo 常见 pnpm dev 一把起前后端）
  let startCmd = '';
  const rootScripts = (rootPkg && rootPkg.scripts) || {};
  if (typeof rootScripts.dev === 'string') {
    startCmd = (isFile(path.join(projectPath, 'pnpm-lock.yaml')) ? 'pnpm dev' : 'npm run dev');
  }
  return { services, startCmd, rootPkg };
}

function readCurrentProject() {
  const rec = readJson(CURRENT_PROJECT_FILE);
  if (!rec || !rec.name || !rec.path) return null;
  return {
    name: String(rec.name),
    path: String(rec.path),
    updatedAt: rec.updatedAt || '',
    exists: isDir(rec.path)
  };
}

/**
 * 解析当前项目 → 服务清单。永远返回对象，不抛。
 * opts.projectPath：显式指定工程目录（默认读 current-project.json）
 * opts.noCache：不写缓存（CLI --no-cache 用）
 */
function resolve(opts) {
  const o = opts || {};
  const warnings = [];
  let project = null;
  if (o.projectPath) {
    const p = path.resolve(String(o.projectPath));
    project = { name: path.basename(p), path: p, updatedAt: '', exists: isDir(p) };
  } else {
    project = readCurrentProject();
  }
  const base = {
    ok: true,
    project: project,
    services: [],
    startCmd: '',
    counts: { auto: 0, manual: 0 },
    registry: { path: REGISTRY_FILE, exists: isFile(REGISTRY_FILE), autoDisabled: false },
    dataDir: DATA_DIR,
    codeRoot: CODE_ROOT,
    detectedAt: new Date().toISOString(),
    warnings: warnings
  };
  if (!project) {
    warnings.push('没有指定当前开发项目：读不到 ' + CURRENT_PROJECT_FILE);
    return base;
  }
  if (!project.exists) {
    warnings.push('当前项目目录不存在：' + project.path);
    return base;
  }
  try {
    const detected = detectProject(project.path, warnings);
    const merged = applyRegistry(project.name, detected.services);
    base.services = merged.list;
    base.startCmd = detected.startCmd;
    base.registry.autoDisabled = merged.autoDisabled;
    base.registry.registered = merged.registered;
    base.counts.auto = merged.list.filter((s) => s.source !== 'manual').length;
    base.counts.manual = merged.list.filter((s) => s.source === 'manual').length;
  } catch (e) {
    base.ok = false;
    base.err = String((e && e.message) || e);
    warnings.push('识别服务失败：' + base.err);
  }
  return base;
}

// ---------------------------------------------------------------------------
// 缓存（渲染层在「旧主进程」上时的兜底数据；主进程每次 IPC 也会顺手刷新）
// ---------------------------------------------------------------------------
function writeCache(result) {
  if (!result || !result.project || !result.project.name || !result.ok) return;
  const old = readJson(CACHE_FILE) || { version: 1, projects: {} };
  if (!old.projects || typeof old.projects !== 'object') old.projects = {};
  old.version = 1;
  old.updatedAt = new Date().toISOString();
  old.projects[result.project.name] = {
    projectPath: result.project.path,
    services: result.services,
    startCmd: result.startCmd,
    counts: result.counts,
    detectedAt: result.detectedAt
  };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(old, null, 2) + '\n', 'utf8');
  } catch (e) { /* 缓存写不了不影响面板（只是旧主进程上没兜底数据） */ }
}

// ---------------------------------------------------------------------------
// IPC 挂载：main.js 里 require 一次（与 crash.js / sidebar.js 同一种挂法）
// ---------------------------------------------------------------------------
function install(ipcMainOrOptions, maybeDeps) {
  let ipcMain = null;
  let deps = null;
  if (ipcMainOrOptions && typeof ipcMainOrOptions.handle === 'function') {
    ipcMain = ipcMainOrOptions;
    deps = maybeDeps || {};
  } else {
    deps = ipcMainOrOptions || {};
    if (deps.ipcMain && typeof deps.ipcMain.handle === 'function') {
      ipcMain = deps.ipcMain;
    } else {
      try { ipcMain = require('electron').ipcMain; } catch (e) { ipcMain = null; }
    }
  }
  const log = (deps && deps.log) || function () {};
  if (!ipcMain || typeof ipcMain.handle !== 'function') return;
  ipcMain.handle('code:dev-services', function (e, opts) {
    try {
      const r = resolve(opts);
      writeCache(r);
      log('[dev-services] ' + ((r.project && r.project.name) || '(未指定)') + ' ⇒ ' + r.services.length + ' 个服务');
      return r;
    } catch (ex) {
      log('[dev-services] 解析失败：' + ((ex && ex.message) || ex));
      return { ok: false, err: String((ex && ex.message) || ex), services: [], warnings: [] };
    }
  });
}

// ---------------------------------------------------------------------------
// CLI：node 外壳\scripts\dev-services.js [--write] [--all] [--json] [--project <路径>]
// ---------------------------------------------------------------------------
function printHuman(r) {
  if (!r.project) {
    console.log('⚠ 还没有指定当前开发项目（外壳\\data\\current-project.json 不存在或没 name/path）');
    console.log('  先指定：node 工具\\当前项目.mjs --set <项目名>');
    return 1;
  }
  console.log('📦 当前开发项目：' + r.project.name + '（' + r.project.path + '）');
  if (r.startCmd) console.log('▶ 一键启动：' + r.startCmd);
  if (!r.services.length) {
    console.log('（没识别到开发服务：这个工程可能不是 Web/Node 项目；可在 外壳\\data\\dev-services.json 手动登记）');
  } else {
    console.log('服务 ' + r.services.length + ' 个（自动 ' + r.counts.auto + ' · 手动 ' + r.counts.manual + '）：');
    r.services.forEach((s, i) => {
      console.log('  ' + String(i + 1).padStart(2) + '. ' + s.name);
      console.log('      ' + s.url + (s.note ? '   ' + s.note : ''));
    });
  }
  r.warnings.forEach((w) => console.log('  ! ' + w));
  return 0;
}

function listCodeRootProjects() {
  return listDir(CODE_ROOT).filter((e) => e.isDirectory() && e.name[0] !== '.').map((e) => path.join(CODE_ROOT, e.name));
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.indexOf('--help') >= 0 || argv.indexOf('-h') >= 0) {
    console.log('用法：node 外壳\\scripts\\dev-services.js [选项]');
    console.log('  --write            把识别结果写进 外壳\\data\\dev-services-cache.json（旧主进程兜底用）');
    console.log('  --all              遍历「代码根」下所有工程并写缓存');
    console.log('  --json             输出 JSON（给脚本/AI 用）');
    console.log('  --project <路径>   指定工程目录（默认读 current-project.json）');
    process.exit(0);
  }
  const pi = argv.indexOf('--project');
  const opts = { projectPath: pi >= 0 ? argv[pi + 1] : '' };
  if (argv.indexOf('--all') >= 0) {
    if (!isDir(CODE_ROOT)) { console.error('✗ 代码根不存在：' + CODE_ROOT); process.exit(2); }
    let n = 0;
    listCodeRootProjects().forEach((p) => {
      const r = resolve({ projectPath: p });
      if (r.services.length) n++;
      writeCache(r);
    });
    console.log('✓ 已遍历 ' + CODE_ROOT + '：' + listCodeRootProjects().length + ' 个工程，' + n + ' 个识别到服务');
    console.log('  缓存：' + CACHE_FILE);
    process.exit(0);
  }
  const r = resolve(opts);
  writeCache(r);
  if (argv.indexOf('--json') >= 0) console.log(JSON.stringify(r, null, 2));
  else {
    const code = printHuman(r);
    if (argv.indexOf('--write') >= 0) console.log('✓ 缓存已写：' + CACHE_FILE);
    process.exit(code);
  }
  process.exit(r.ok ? 0 : 1);
}

module.exports = {
  install,
  resolve,
  writeCache,
  detectProject,
  DATA_DIR,
  CODE_ROOT,
  REGISTRY_FILE,
  CACHE_FILE
};
