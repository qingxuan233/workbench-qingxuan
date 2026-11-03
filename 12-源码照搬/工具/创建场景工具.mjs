#!/usr/bin/env node
/**
 * 创建场景工具.mjs —— 工作项目开发场景工具脚手架
 *
 * 遵循本项目方法论：
 *   1. 为工作项目开发快速生成符合规范的场景工具模板（带 --help、--dry、标准退出码）；
 *   2. 自动在 外壳\data\工具清单.json 登记，保证工作台顶栏工具面板实时可见；
 *   3. 赋能业务项目持续沉淀场景工具，持续迭代与优化工作台。
 *
 * 用法：
 *   node 工具\创建场景工具.mjs --name "接口测试" --desc "批量测试本地开发接口" --tag "测试"
 *   node 工具\创建场景工具.mjs --name "代码体检" --desc "检查项目代码规范与坏味道" --dry
 *   node 工具\创建场景工具.mjs --help
 *
 * 退出码：0 成功 ｜ 1 执行失败 ｜ 2 用法错误
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.resolve(__dirname, '..');
const TOOLS_DIR = __dirname;
const MANIFEST_PATH = path.join(APP_ROOT, '外壳', 'data', '工具清单.json');

const args = process.argv.slice(2);
const getArg = (flag) => {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
};
const hasFlag = (flag) => args.includes(flag);

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(`
创建场景工具.mjs —— 场景工具脚手架与自动化纳管

用法：
  node 工具\\创建场景工具.mjs --name <工具名> [选项]

选项：
  --name <名称>     工具显示名称（必填，如 "接口测试"）
  --desc <说明>     工具功能一句话描述
  --tag <标签>      工具标签（默认 "开发"，如 "验收" / "测试" / "发布"）
  --file <文件名>   脚本文件名（默认 <工具名>.mjs）
  --section <小节>  工具清单所属小节（默认 "开发与场景扩展"）
  --dry             只演练预览，不写入文件
  --help, -h        显示本帮助
`);
  process.exit(0);
}

const name = getArg('--name');
if (!name) {
  console.error('✗ 缺少必填参数 --name <工具名>。请使用 --help 查看用法。');
  process.exit(2);
}

const desc = getArg('--desc') || `${name} 场景工具`;
const tag = getArg('--tag') || '开发';
let fileName = getArg('--file') || `${name}.mjs`;
if (!fileName.endsWith('.mjs') && !fileName.endsWith('.js')) {
  fileName += '.mjs';
}
const sectionTitle = getArg('--section') || '开发与场景扩展';
const dryRun = hasFlag('--dry');

const targetScriptPath = path.join(TOOLS_DIR, fileName);
const relativeScriptWhere = `工具\\${fileName}`;

console.log(`[脚手架] 准备创建场景工具: ${name}`);
console.log(`- 目标脚本: ${targetScriptPath}`);
console.log(`- 功能描述: ${desc}`);
console.log(`- 分类标签: ${tag}`);
console.log(`- 所属小节: ${sectionTitle}`);

// 1. 生成工具代码模板
const scriptTemplate = `#!/usr/bin/env node
/**
 * ${fileName} —— ${desc}
 *
 * 遵循本项目方法论规范：
 *   1. 带有 --help 命令行说明与参数校验；
 *   2. 带有 --dry 预演模式，无破坏性副作用；
 *   3. 明确返回码：0 成功，1 业务失败，2 用法错误。
 *
 * 用法：
 *   node 工具\\${fileName} [选项]
 *
 * 退出码：0 成功 ｜ 1 失败 ｜ 2 用法错误
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const getArg = (f) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(\`
${fileName} —— ${desc}

用法：
  node 工具\\\\${fileName} [选项]

选项：
  --dry         预演模式，只检查不修改
  --help, -h    显示帮助信息
\`);
  process.exit(0);
}

const dry = hasFlag('--dry');
if (dry) {
  console.log('【预演模式】未执行实际修改。');
}

console.log('✓ [${name}] 执行完成。');
process.exit(0);
`;

if (dryRun) {
  console.log('\\n[DRY RUN] 将生成脚本内容预览：');
  console.log('----------------------------------------');
  console.log(scriptTemplate.trim());
  console.log('----------------------------------------');
} else {
  if (fs.existsSync(targetScriptPath)) {
    console.log(`ℹ 脚本文件已存在，跳过覆盖: ${targetScriptPath}`);
  } else {
    fs.writeFileSync(targetScriptPath, scriptTemplate, 'utf8');
    console.log(`✓ 脚本文件已写入: ${targetScriptPath}`);
  }
}

// 2. 登记到 外壳\data\工具清单.json
if (!fs.existsSync(MANIFEST_PATH)) {
  console.error(`✗ 找不到工具清单文件: ${MANIFEST_PATH}`);
  process.exit(1);
}

try {
  const rawManifest = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const manifest = JSON.parse(rawManifest);

  let targetGroup = (manifest.groups || []).find((g) => g.title && g.title.includes('工具\\'));
  if (!targetGroup) {
    targetGroup = manifest.groups[0];
  }

  let targetSection = (targetGroup.sections || []).find((s) => s.title === sectionTitle);
  if (!targetSection) {
    targetSection = {
      title: sectionTitle,
      items: []
    };
    targetGroup.sections.push(targetSection);
    console.log(`+ 新建清单小节: ${sectionTitle}`);
  }

  const existingItemIndex = targetSection.items.findIndex((it) => it.name === name || it.where === relativeScriptWhere);
  const newItem = {
    name: name,
    tag: tag,
    plain: desc,
    how: `node ${relativeScriptWhere}`,
    where: relativeScriptWhere
  };

  if (existingItemIndex >= 0) {
    targetSection.items[existingItemIndex] = newItem;
    console.log(`✓ 更新已有清单项: ${name}`);
  } else {
    targetSection.items.push(newItem);
    console.log(`✓ 追加清单项: ${name}`);
  }

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  manifest.updated = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  if (dryRun) {
    console.log('[DRY RUN] 工具清单更新预演完成。');
  } else {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 1) + '\n', 'utf8');
    console.log(`✓ 工具清单已更新并保存: ${MANIFEST_PATH}`);
  }
} catch (err) {
  console.error(`✗ 更新工具清单失败: ${err.message}`);
  process.exit(1);
}

console.log(`\n✓ 场景工具 [${name}] 初始化与纳管完成！`);
process.exit(0);
