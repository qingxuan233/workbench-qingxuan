#!/usr/bin/env node
/**
 * 上游分层.mjs —— 判断一个改动落在方法论的哪一层，并给出「该不该读、谁拍板」
 *
 * 为什么单独成文件（方法论 O6）：
 *   同步上游 原来的输出是「N 个文件变更」——这等于把判断整个推给人。
 *   但真正决定风险的只有一件事：**改的是规矩、实现，还是本机真值**。
 *   分层逻辑若内嵌在同步脚本里，上游没更新时就永远测不到 ⇒ 必须能单独自检。
 *
 * 用法：
 *   node 工具\上游分层.mjs --self-test        反例验收（每条断言都要能被证伪）
 *   node 工具\上游分层.mjs a.md b.js …        打印分层结果
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 单文件 → 层名 */
export function layerOf(f) {
  const p = String(f).replace(/\\/g, '/');
  const base = p.split('/').pop();
  // 实例层：本机真值（会话 id、绝对路径、实例清单）——最危险，覆盖了就是别人的机器
  if (p.startsWith('12-源码照搬/引擎数据/') || base === '工作台.json' || base === '工作台.example.json') return '实例层';
  // 宪法层：规矩本身
  if (/^(README\.md|总纲\.md|00-核心机制\/|05-协作与规矩\/|模板\/|说明\/|更新清单\.md)/.test(p)) return '宪法层';
  // 机制层：可执行的那一半
  if (p.startsWith('12-源码照搬/')) return '机制层';
  return '其他';
}

export const ADVICE = {
  '宪法层': '⚠ 改的是规矩本身：逐条读，别因 diff 干净就并（可能推翻本机既定做法）',
  '实例层': '⚠ 可能覆盖本机真值/会话：并前必须宿主同意，并先备份',
  '机制层': '✅ 通常可并：并后必须 node 12-源码照搬\\工具\\体检.mjs 转绿',
  '其他': '✅ 按普通改动处理'
};
export const ORDER = ['宪法层', '实例层', '机制层', '其他'];

/** 分组；保持层内原有顺序 */
export function classify(files) {
  const g = {};
  for (const x of files) (g[layerOf(x)] ||= []).push(x);
  return ORDER.filter((k) => g[k] && g[k].length).map((k) => ({ layer: k, files: g[k], advice: ADVICE[k] }));
}

// ── CLI ──────────────────────────────────────────────────
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (IS_MAIN) {
  const argv = process.argv.slice(2);

  if (argv.includes('--self-test')) {
    const cases = [
      // [文件, 期望层]
      ['README.md', '宪法层'],
      ['总纲.md', '宪法层'],
      ['00-核心机制/二-记忆机制.md', '宪法层'],
      ['05-协作与规矩\\一-全局铁律.md', '宪法层'],
      ['模板\\项目信息-模板.md', '宪法层'],
      ['说明\\底层逻辑总纲.md', '宪法层'],
      ['更新清单.md', '宪法层'],
      ['12-源码照搬\\外壳\\main.js', '机制层'],
      ['12-源码照搬\\工具\\体检.mjs', '机制层'],
      ['12-源码照搬\\引擎数据\\.dsh\\场景记忆\\命令\\场景私有记忆.md', '实例层'],
      ['12-源码照搬\\工作台.json', '实例层'],
      ['12-源码照搬\\工作台.example.json', '实例层'],
      ['13-公开情报\\x.md', '其他'],
      ['配图\\拓扑-总纲.svg', '其他'],
    ];
    let pass = 0, fail = 0;
    for (const [f, want] of cases) {
      const got = layerOf(f);
      if (got === want) { pass++; console.log(`  ✓ ${f} → ${got}`) }
      else { fail++; console.log(`  ✗ ${f} → 期望 ${want}，实际 ${got}`) }
    }
    // 反例：分组顺序必须「宪法层在最前」，否则人先看到的是低风险项
    const g = classify(['12-源码照搬\\外壳\\main.js', 'README.md', '12-源码照搬\\工作台.json']);
    if (g[0].layer === '宪法层') { pass++; console.log('  ✓ 分层顺序：宪法层在首') }
    else { fail++; console.log('  ✗ 分层顺序错：首项是 ' + g[0].layer) }
    // 反例：同一文件不能被算进两层
    const g2 = classify(['README.md', 'README.md']);
    if (g2.length === 1 && g2[0].files.length === 2) { pass++; console.log('  ✓ 同层合并正确') }
    else { fail++; console.log('  ✗ 同层合并错') }

    console.log(`\n自检：${pass} 通过 · ${fail} 失败`);
    process.exit(fail ? 2 : 0);
  }

  const files = argv.filter((x) => !x.startsWith('--'));
  if (!files.length) { console.error('用法：node 工具\\上游分层.mjs <文件…> ｜ --self-test'); process.exit(2) }
  for (const g of classify(files)) {
    console.log(`  ${g.layer} · ${g.files.length} 个文件  ${g.advice}`);
    for (const x of g.files) console.log('    · ' + x);
  }
}
