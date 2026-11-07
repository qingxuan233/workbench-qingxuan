'use strict';
/**
 * main/inventory.js —— 只读清点：版本 / 插件 / 技能 / 工具清单 / 设置（2026-11-04）
 *
 * 从 main.js 抽出的第二块主进程模块。只读文件，不碰窗口、不写盘。
 *
 * init() 注入路径（由 main.js 决定，模块自己不猜盘符）：
 *   harnessDir      引擎目录（没有就空串）
 *   pluginsDir      插件目录
 *   dataDir         工作台 data/（工具清单.json 在这）
 *   settingsPath    settings.yaml
 *   credentialsPath .credentials.yaml（返回时脱敏）
 *   skillsDir       .dsh/skills
 *   projectDir      外壳目录（项目级 .dsh/skills、.agents/skills）
 */
const fs = require('fs');
const path = require('path');
const engineGuard = require('./engine-guard');

let CFG = null;

function init(cfg) {
  cfg = cfg || {};
  CFG = {
    harnessDir: cfg.harnessDir || '',
    // 外部 CLI 路径（字符串或返回字符串的函数）。没有内置 引擎\ 时靠它只读探测内核版本。
    engineCliPath: cfg.engineCliPath || '',
    pluginsDir: cfg.pluginsDir || '',
    dshDataDir: cfg.dshDataDir || cfg.dataDir || '',
    toolsCatalogFile: cfg.toolsCatalogFile || (cfg.shellDataDir ? path.join(cfg.shellDataDir, '工具清单.json') : (cfg.dataDir ? path.join(cfg.dataDir, '工具清单.json') : '')),
    settingsPath: cfg.settingsPath || '',
    credentialsPath: cfg.credentialsPath || '',
    skillsDir: cfg.skillsDir || '',
    projectDir: cfg.projectDir || '',
  };
}

function ready() {
  if (!CFG) throw new Error('inventory.js 未 init()');
  return CFG;
}

function readVer(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')).version || null; }
  catch (e) { return null; }
}

function versionInfo(appVersion) {
  const cfg = ready();
  // 内核版本：有内置 引擎\ 就读它自己的 package.json；
  // 没有（公开副本是源码直跑 + 外部 CLI）就只读探测 CLI 安装目录里的内核包。
  // 2026-11-07：以前这一支恒为 null，左栏只剩外壳版本号，容易被读成"DSH 内核版本"。
  let engine = cfg.harnessDir ? readVer(path.join(cfg.harnessDir, 'package.json')) : null;
  let engineSource = engine ? 'harness' : '';
  let engineCli = '';
  if (!engine && cfg.engineCliPath) {
    try {
      engineCli = typeof cfg.engineCliPath === 'function' ? String(cfg.engineCliPath() || '') : String(cfg.engineCliPath);
      const hit = engineGuard.detectEngineVersion(engineCli);
      if (hit && hit.version) { engine = hit.version; engineSource = hit.source; }
    } catch (e) { /* 探测失败 = 未知，不抛 */ }
  }
  return {
    gui: readVer(path.join(cfg.projectDir, 'package.json')),
    // HARNESS_DIR 为空时，path.join('', 'package.json') 会读到外壳自己的版本 ⇒ 空串一律 null
    engine,
    engineSource,
    // 新主进程的标志：渲染层据此区分「探测过但未知」与「老主进程根本没有这个字段」
    engineProbe: true,
    cli: cfg.harnessDir ? readVer(path.join(cfg.harnessDir, 'apps', 'cli', 'package.json')) : null,
    engineDir: cfg.harnessDir,
    electron: process.versions.electron || '',
    chrome: process.versions.chrome || '',
    node: process.versions.node || '',
    app: String(appVersion || ''),
  };
}

function listPlugins() {
  const cfg = ready();
  const out = {
    pluginsDir: cfg.pluginsDir,
    dataDir: cfg.dshDataDir,
    plugins: [],
    builtinDir: cfg.harnessDir ? path.join(cfg.harnessDir, 'packages') : '',
    builtinCount: 0,
  };
  try {
    if (cfg.pluginsDir && fs.existsSync(cfg.pluginsDir)) {
      for (const d of fs.readdirSync(cfg.pluginsDir)) {
        const dir = path.join(cfg.pluginsDir, d);
        let st = null;
        try { st = fs.statSync(dir); } catch (e) { continue; }
        if (!st.isDirectory()) continue;   // 跳过 开发约定.md 等文件
        let name = d, version = null, description = '';
        const pkgPath = path.join(dir, 'package.json');
        if (fs.existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            name = pkg.name || d;
            version = pkg.version || null;
            description = pkg.description || '';
          } catch (e) { /* 忽略坏 JSON */ }
        }
        const plugin = { name, displayName: d, version, description, path: dir };
        for (const sub of ['缓存', 'data', 'cache']) {
          const sp = path.join(dir, sub);
          try { if (fs.statSync(sp).isDirectory()) { plugin.cacheDir = sp; break; } } catch (e) { /* ignore */ }
        }
        for (const sub of ['配置', 'config']) {
          const sp = path.join(dir, sub);
          try { if (fs.statSync(sp).isDirectory()) { plugin.configDir = sp; break; } } catch (e) { /* ignore */ }
        }
        out.plugins.push(plugin);
      }
    }
    // 内置插件包数量（packages/client + packages/host 下的包）
    let n = 0;
    const pkgRoot = cfg.harnessDir ? path.join(cfg.harnessDir, 'packages') : '';
    for (const base of pkgRoot ? [path.join(pkgRoot, 'client'), path.join(pkgRoot, 'host')] : []) {
      try {
        n += fs.readdirSync(base).filter((x) => {
          try { return fs.statSync(path.join(base, x)).isDirectory(); } catch (e) { return false; }
        }).length;
      } catch (e) { /* ignore */ }
    }
    out.builtinCount = n;
  } catch (e) { /* ignore */ }
  return out;
}

// 极简 frontmatter 解析：只取 --- 块里的 name / description / whenToUse（其余字段忽略）
function parseSkillFrontmatter(text) {
  const meta = {};
  const m = String(text || '').match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return meta;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    val = val.replace(/^["']|["']$/g, '').replace(/\s+#.*$/, '').trim();
    if (key === 'name' || key === 'description' || key === 'whenToUse') meta[key] = val;
  }
  return meta;
}

// 读取一个技能（目录包或单文件），返回目录条目
function readSkill(file, dirPath, format) {
  const entry = {
    name: '', description: '', whenToUse: '',
    file, dir: dirPath, format, valid: false, error: '',
  };
  try {
    const text = fs.readFileSync(file, 'utf8');
    const meta = parseSkillFrontmatter(text);
    entry.name = meta.name || '';
    entry.description = meta.description || '';
    entry.whenToUse = meta.whenToUse || '';
    const st = fs.statSync(file);
    entry.mtime = st.mtimeMs;
    entry.size = st.size;
    if (!entry.name || !entry.description) {
      entry.error = 'frontmatter 缺少 name 或 description（引擎会丢弃该技能）';
    } else {
      entry.valid = true;
    }
  } catch (e) {
    entry.error = '读取失败：' + ((e && e.message) || e);
  }
  return entry;
}

function listSkills() {
  const cfg = ready();
  const out = { skillsDir: cfg.skillsDir, roots: [], skills: [] };
  const roots = [
    { source: 'user-dsh', rank: 400, dir: cfg.skillsDir },
    { source: 'project-dsh', rank: 100, dir: path.join(cfg.projectDir, '.dsh', 'skills') },
    { source: 'project-agents', rank: 200, dir: path.join(cfg.projectDir, '.agents', 'skills') },
  ];
  for (const r of roots) {
    if (!r.dir) continue;
    let exists = false;
    try { exists = fs.statSync(r.dir).isDirectory(); } catch (e) { exists = false; }
    out.roots.push({ source: r.source, rank: r.rank, dir: r.dir, exists });
    if (!exists) continue;
    let names = [];
    try { names = fs.readdirSync(r.dir); } catch (e) { continue; }
    for (const n of names) {
      if (n === '.system' || n === '.git' || n.startsWith('_') || n.startsWith('.')) continue;
      const full = path.join(r.dir, n);
      let st = null;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (st.isDirectory()) {
        const entryFile = path.join(full, 'SKILL.md');
        if (!fs.existsSync(entryFile)) continue;   // 目录包必须有 SKILL.md
        const entry = readSkill(entryFile, full, 'bundle');
        if (!entry.name) entry.name = n;
        entry.source = r.source;
        out.skills.push(entry);
      } else if (st.isFile() && /\.md$/i.test(n)) {
        const entry = readSkill(full, r.dir, 'flat');
        if (!entry.name) entry.name = n.replace(/\.md$/i, '');
        entry.source = r.source;
        out.skills.push(entry);
      }
    }
  }
  out.skills.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const seen = {};
  out.skills = out.skills.filter((s) => {
    const key = String(s.name || '').toLowerCase();
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
  return out;
}

function readToolCatalog() {
  const cfg = ready();
  try {
    const target = cfg.toolsCatalogFile || path.join(cfg.projectDir, 'data', '工具清单.json');
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (e) {
    // 文件不在 = 还没登记工具（不是故障）⇒ 给 missing，让面板出"怎么建"提示而不是红字 ENOENT
    if (e && e.code === 'ENOENT') return { updated: null, groups: [], missing: true };
    return { updated: null, groups: [], error: String((e && e.message) || e) };
  }
}

function readSettings() {
  const cfg = ready();
  const out = { settingsPath: cfg.settingsPath, credentialsPath: cfg.credentialsPath, files: {} };
  try {
    if (cfg.settingsPath && fs.existsSync(cfg.settingsPath)) out.files.settings = fs.readFileSync(cfg.settingsPath, 'utf8');
  } catch (e) { /* ignore */ }
  try {
    if (cfg.credentialsPath && fs.existsSync(cfg.credentialsPath)) {
      let t = fs.readFileSync(cfg.credentialsPath, 'utf8');
      // 脱敏：把行尾 12+ 位长的值（密钥/token）打码，保留短配置项
      t = t.replace(/(:\s*)(["']?)([A-Za-z0-9_\-.]{12,})(["']?)(\s*(#.*)?)$/gm, '$1$2••••••（已隐藏）$4$5');
      out.files.credentials = t;
    }
  } catch (e) { /* ignore */ }
  return out;
}

module.exports = {
  init,
  versionInfo,
  listPlugins,
  listSkills,
  readToolCatalog,
  readSettings,
  // 供测试 / 其他模块复用
  parseSkillFrontmatter,
};
