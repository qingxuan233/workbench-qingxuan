#!/usr/bin/env node
/**
 * 当前项目.mjs —— 工作项目开发场景：当前开发项目文件夹查询与指定工具
 *
 * 遵循本项目方法论规范：
 *   1. 支持命令行查询、列出、切换当前开发的项目文件夹；
 *   2. 持久化存储至 外壳\data\current-project.json，供 GUI 渲染层与 AI 会话统一读取；
 *   3. 切换后自动派发刷新指令，通知工作台文件面板实时导航定位；
 *   4. 自带 --help、--dry 预演与标准退出码。
 *
 * 用法：
 *   node 工具\当前项目.mjs                     # 查看当前指定的项目
 *   node 工具\当前项目.mjs --list              # 列出「代码根」下的所有项目
 *   node 工具\当前项目.mjs --set WMS           # 指定当前开发项目为 WMS
 *   node 工具\当前项目.mjs --set "Financial Compensation"
 *   node 工具\当前项目.mjs --clear             # 清除指定，返回「代码根」
 *   node 工具\当前项目.mjs --help
 *
 * 「代码根」默认按目录结构推导：<代码根>\<仓库>\12-源码照搬 ⇒ 取仓库的上一级；
 * 也可用环境变量 DSH_CODE_ROOT 显式指定（换盘 / 仓库不在代码根下时用）。
 *
 * 退出码：0 成功 ｜ 1 业务失败 ｜ 2 用法错误
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(APP_ROOT, '外壳', 'data');
const CURRENT_PROJECT_FILE = path.join(DATA_DIR, 'current-project.json');
// 开发项目总根：优先环境变量；否则按「应用根 = <代码根>\<仓库>\12-源码照搬」推导。
// 不写死盘符，换机 / 换盘 / 仓库改名都不用改代码。
const CODE_ROOT = (() => {
  const fromEnv = String(process.env.DSH_CODE_ROOT || '').trim();
  return fromEnv ? path.resolve(fromEnv) : path.dirname(path.dirname(APP_ROOT));
})();

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const getArg = (f) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(`
当前项目.mjs —— 工作项目开发：指定与查询当前项目

用法：
  node 工具\\当前项目.mjs [选项]

选项：
  --list               列出 ${CODE_ROOT} 下所有项目工程
  --set <项目名或路径>  指定当前开发的项目文件夹（如 "WMS" 或 "workbench-qingxuan"）
  --clear              清除当前指定（回到 ${CODE_ROOT} 总根）
  --dry                预演模式，只检查不修改
  --help, -h           显示本帮助

示例：
  node 工具\\当前项目.mjs --list
  node 工具\\当前项目.mjs --set WMS
  node 工具\\当前项目.mjs
`);
  process.exit(0);
}

function readCurrentProject() {
  try {
    if (fs.existsSync(CURRENT_PROJECT_FILE)) {
      const raw = fs.readFileSync(CURRENT_PROJECT_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    // 忽略异常
  }
  return null;
}

function notifyGuiReload() {
  try {
    const cmdPath = path.join(DATA_DIR, 'reload-panels.cmd');
    fs.writeFileSync(cmdPath, 'all', 'utf8');
  } catch (err) {
    // 忽略通知异常
  }
}

function listProjects() {
  if (!fs.existsSync(CODE_ROOT)) {
    console.error(`✗ 找不到开发项目总根目录: ${CODE_ROOT}`);
    process.exit(1);
  }
  const entries = fs.readdirSync(CODE_ROOT, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { sensitivity: 'base' }));
}

const isDry = hasFlag('--dry');

// 1. --list 列出项目
if (hasFlag('--list')) {
  const projects = listProjects();
  const current = readCurrentProject();
  const currentName = current && current.name;

  console.log(`\n📁 [${CODE_ROOT}] 下的开发项目列表（共 ${projects.length} 个）：`);
  console.log('----------------------------------------------------');
  projects.forEach((p, idx) => {
    const isCur = currentName && (currentName.toLowerCase() === p.toLowerCase());
    const marker = isCur ? '★ [当前开发]' : '  ';
    const tag = (p === 'workbench-qingxuan') ? '（工作台）' : '';
    console.log(`${marker} ${(idx + 1).toString().padStart(2, ' ')}. ${p} ${tag}`);
  });
  console.log('----------------------------------------------------');
  if (current && current.name) {
    console.log(`当前激活项目: ${current.name} (${current.path || path.join(CODE_ROOT, current.name)})`);
  } else {
    console.log(`当前激活项目: （未指定特定项目，停在 ${CODE_ROOT} 总根）`);
  }
  process.exit(0);
}

// 2. --clear 清除指定
if (hasFlag('--clear')) {
  if (isDry) {
    console.log('[DRY RUN] 将重置当前开发项目，恢复为 CODE 根目录。');
    process.exit(0);
  }
  const emptyRecord = {
    name: null,
    path: CODE_ROOT,
    baseDir: CODE_ROOT,
    updatedAt: new Date().toISOString()
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CURRENT_PROJECT_FILE, JSON.stringify(emptyRecord, null, 2) + '\n', 'utf8');
  notifyGuiReload();
  console.log(`✓ 已清除当前项目指定，重置为根目录: ${CODE_ROOT}`);
  process.exit(0);
}

// 3. --set 指定当前项目
const targetInput = getArg('--set');
if (targetInput) {
  let targetName = targetInput.trim();
  let targetPath = '';

  if (path.isAbsolute(targetName)) {
    targetPath = targetName;
    targetName = path.basename(targetPath);
  } else {
    targetPath = path.join(CODE_ROOT, targetName);
  }

  if (!fs.existsSync(targetPath)) {
    console.error(`✗ 项目路径不存在: ${targetPath}`);
    console.log(`可用项目请运行: node 工具\\当前项目.mjs --list`);
    process.exit(1);
  }

  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) {
    console.error(`✗ 指定的目标不是文件夹: ${targetPath}`);
    process.exit(1);
  }

  const record = {
    name: targetName,
    path: targetPath,
    baseDir: CODE_ROOT,
    updatedAt: new Date().toISOString()
  };

  if (isDry) {
    console.log(`[DRY RUN] 将指定当前开发项目为: ${targetName}`);
    console.log(`[DRY RUN] 项目绝对路径: ${targetPath}`);
    console.log(`[DRY RUN] 配置文件: ${CURRENT_PROJECT_FILE}`);
    process.exit(0);
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CURRENT_PROJECT_FILE, JSON.stringify(record, null, 2) + '\n', 'utf8');
  notifyGuiReload();

  console.log(`✓ 成功指定当前开发项目: ${targetName}`);
  console.log(`- 路径: ${targetPath}`);
  console.log(`- 配置已写盘: ${CURRENT_PROJECT_FILE}`);
  console.log(`- 已通知工作台文件面板实时定位。`);
  process.exit(0);
}

// 4. 默认：打印当前项目状态
const cur = readCurrentProject();
if (cur && cur.name && cur.path) {
  const exists = fs.existsSync(cur.path);
  console.log(`\n📦 当前开发项目: ${cur.name}`);
  console.log(`- 完整路径: ${cur.path} ${exists ? '✓ (路径有效)' : '✗ (路径不存在)'}`);
  console.log(`- 指定时间: ${cur.updatedAt || '—'}`);
  console.log(`- 切换命令: node 工具\\当前项目.mjs --set <其他项目名>`);
  console.log(`- 清除命令: node 工具\\当前项目.mjs --clear`);
} else {
  console.log(`\n📦 当前开发项目: （未指定，正在浏览总目录 ${CODE_ROOT}）`);
  console.log(`- 指定某个项目开发：node 工具\\当前项目.mjs --set <项目名>`);
  console.log(`- 查看所有项目工程：node 工具\\当前项目.mjs --list\n`);
}
process.exit(0);
