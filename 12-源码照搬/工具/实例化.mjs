#!/usr/bin/env node
/**
 * 实例化.mjs —— 「模板」与「实例」之间唯一的一道工序
 *
 * 背景（方法论 O2）：
 *   模板要能公开 ⇒ 里面必须是占位符；实例要能跑 ⇒ 里面必须是本机真值。
 *   过去这两种身份共用一棵工作树、共用 .git，于是「落地」必然等于「把脱敏位填成真值」，
 *   而「填真值」必然触发 发布前检查 的红线 —— 落地动作与出包闸门天然对立。
 *   现在把真值收进 **工作台.json（实例清单，不入库）**，源文件回到占位/可推导。
 *
 * 用法：
 *   node 工具\实例化.mjs --discover        列出会话库里所有会话（id / 标题 / cwd 是否还有效）
 *   node 工具\实例化.mjs --dry             只报告：要写哪些 sessionId 到 工作台.json
 *   node 工具\实例化.mjs --apply           真写（工作台.json 存真值；场景 json 统一回 __待填__）
 *   node 工具\实例化.mjs --check           校验 工作台.json 完整、场景 json 仍是模板
 *
 * 退出码：0 成功/一致 ｜1 不一致或有错 ｜2 用法错误
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');                       // 12-源码照搬
const DSH = path.join(APP, '引擎数据', '.dsh');
const SCEN = path.join(APP, '外壳', 'scenarios');
const LOCAL = path.join(SCEN, '_local');   // P3-1：实例场景（不入库；同 id 覆盖模板）
const MANIFEST = path.join(APP, '工作台.json');
const EXAMPLE = path.join(APP, '工作台.example.json');
const CACHE = path.join(DSH, 'storages', 'session_projcache', 'sessions');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const say = (...a) => console.log(...a);

const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } };
const exists = (p) => { try { fs.accessSync(p); return true } catch { return false } };
const listFiles = (p, re) => {
  try { return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isFile() && (!re || re.test(e.name))).map((e) => e.name) } catch { return [] }
};
const listDirs = (p) => {
  try { return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { return [] }
};

/** 会话库：sessions/<workspace>/<session-id>/session.v4.jsonl.zstd */
function discover() {
  const out = [];
  for (const ws of listDirs(path.join(DSH, 'sessions'))) {
    for (const id of listDirs(path.join(DSH, 'sessions', ws))) {
      if (!/^session-/.test(id)) continue;
      const cache = readJson(path.join(CACHE, id + '.json'), {});
      const rec = (cache && cache.record) || {};
      const cwd = rec.identity && rec.identity.cwd;
      const title = (rec.rows && rec.rows.title && rec.rows.title.val) || '';
      out.push({ id, ws, title, cwd, cwdOk: cwd ? exists(cwd) : null, createdAt: rec.identity && rec.identity.createdAt });
    }
  }
  return out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

/** 场景配置：id / name / 该场景首个 harness 面板（模板 + 实例；同 id 实例优先） */
function scenarios() {
  const out = [];
  const addDir = (dir, isInstance) => {
    for (const f of listFiles(dir, /\.json$/)) {
      const j = readJson(path.join(dir, f));
      if (!j || !j.id) continue;
      const panel = (j.panels || []).find((p) => p && p.type === 'harness');
      const row = { file: f, path: path.join(dir, f), id: j.id, name: j.name, sessionTitle: j.sessionTitle, panel, raw: j, instance: !!isInstance };
      const hit = out.findIndex((x) => x.id === j.id);
      if (hit >= 0) {
        if (isInstance) out[hit] = row;       // 实例覆盖模板
      } else out.push(row);
    }
  };
  addDir(SCEN, false);
  addDir(LOCAL, true);
  return out;
}

// ── discover ─────────────────────────────────────────────
if (has('--discover')) {
  const rows = discover();
  if (!rows.length) { say('（会话库为空：' + path.join(DSH, 'sessions') + '）'); process.exit(0) }
  say('id'.padEnd(42) + ' title'.padEnd(12) + ' cwd');
  say('-'.repeat(100));
  for (const r of rows) {
    const flag = r.cwdOk === false ? '✗ ' : (r.cwdOk ? '✓ ' : '? ');
    say(r.id.padEnd(42) + (' ' + (r.title || '（无标题）')).padEnd(12) + ' ' + flag + (r.cwd || '（无记录）'));
  }
  process.exit(0);
}

// ── 组装「应该是什么」 ───────────────────────────────────
const scens = scenarios();
const rows = discover();
const manifest = readJson(MANIFEST);
const base = manifest || readJson(EXAMPLE, {}) || {};

// 每个场景该绑哪条会话：按场景 json 的 sessionTitle（会话名）匹配会话库标题；
// 匹配不到就退回「已绑定的那条」（现状），再退回空。
const want = {};
const notes = [];
for (const sc of scens) {
  const title = String(sc.sessionTitle || sc.name || '');
  // P3-1：实例场景允许没有 AI 面板（例如只有 view 面板的实例场景）⇒ 不需要会话绑定
  if (!sc.panel) {
    notes.push(`${sc.id}：没有 harness(AI) 面板，无需会话绑定（${sc.instance ? '实例场景' : '模板场景'}）`);
    continue;
  }
  const mine = rows.filter((r) => (r.title || '') === title && r.cwdOk !== false);
  const current = sc.panel ? String(sc.panel.sessionId || '') : '';
  const pick = mine.length ? mine[mine.length - 1] : null;
  if (pick) {
    want[sc.id] = pick.id;
    if (current && current !== pick.id) notes.push(`${sc.id}：${current.slice(0, 22)}… ⇒ ${pick.id.slice(0, 22)}…（按标题「${title}」重新匹配，cwd 有效）`);
  } else if (current && current !== '__待填__') {
    want[sc.id] = current;
    notes.push(`${sc.id}：保持现状 ${current.slice(0, 22)}…（会话库里找不到标题为「${title}」且 cwd 有效的会话）`);
  } else {
    want[sc.id] = '__待填__';
    notes.push(`${sc.id}：未绑定（跑 node 外壳\\scripts\\建会话.mjs "${title}" 后重跑本工具）`);
  }
}

const nextManifest = {
  version: 1,
  name: base.name || '清玄的工作台',
  root: base.root || null,
  dshPort: base.dshPort || 3083,
  sitePort: base.sitePort || 31238,
  engine: base.engine || { source: 'local-dir', dir: '引擎', cliPath: null },
  scenes: Object.fromEntries(Object.entries(want).map(([k, v]) => [k, { sessionId: v }]))
};
nextManifest.$comment = '本机实例清单（不入库）。真值只存这里，源文件保持占位/可推导。';

// ── check ────────────────────────────────────────────────
if (has('--check')) {
  let bad = 0;
  if (!manifest) {
    if (exists(MANIFEST)) say('✗ 工作台.json 存在但解析失败（多半是 BOM 或尾逗号）⇒ JSON.parse 拿不到真值');
    else say('✗ 缺 工作台.json（先 --apply 或复制 工作台.example.json）');
    bad++;
  }
  else {
    for (const sc of scens) {
      if (!sc.panel) continue;   // 非 AI 面板的实例场景不需要绑定
      const m = (manifest.scenes || {})[sc.id];
      const wantId = m && String(m.sessionId || '').trim();
      const cur = sc.panel ? String(sc.panel.sessionId || '').trim() : '';
      if (!wantId || wantId === '__待填__') {
        say(`✗ ${sc.id}：工作台.json 里没有有效会话 id（先建会话，再 --apply）`);
        bad++;
      } else if (cur && cur !== '__待填__' && cur !== wantId) {
        say(`✗ ${sc.id}：场景 json 里仍是实例真值（模板应写 __待填__，由 --apply 清回占位；运行时由 main.js 叠加清单值）`);
        bad++;
      } else if (cur && cur === wantId) {
        say(`✗ ${sc.id}：场景 json 里写了真实会话 id（模板应写 __待填__）`);
        bad++;
      }
    }
    if (!bad) say('✓ 工作台.json 绑定完整 · 场景 json 保持模板占位');
  }
  process.exit(bad ? 1 : 0);
}

// ── dry / apply ──────────────────────────────────────────
say('实例化 · ' + APP);
say('模式：' + (manifest ? '已有 工作台.json' : '尚未实例化（将新建）') + '\n');
say('将写入 工作台.json：');
for (const [k, v] of Object.entries(nextManifest.scenes)) say('  ' + k.padEnd(14) + (v && v.sessionId));
if (notes.length) { say('\n说明：'); notes.forEach((n) => say('  · ' + n)) }
if (rows.some((r) => r.cwdOk === false)) {
  say('\n⚠ 仍有会话的 cwd 不可用（体检 A5 会红）：');
  for (const r of rows.filter((x) => x.cwdOk === false)) say('  · ' + r.id.slice(0, 22) + '… → ' + r.cwd);
  say('  处理：在为该场景建一条新会话后重跑 --apply（SESSIONS 里旧的会自然被替换）。');
}

if (!has('--apply')) {
  say('\n（--dry：什么都没写。确认无误后加 --apply）');
  process.exit(0);
}

// 写 工作台.json
// fresh 只在「还有面板没绑上」时为 true（装好未绑 ⇒ 体检把未绑定算待办）。
// 一旦全部绑上就置 false，A10 立刻恢复硬判：以后再有面板掉绑定就是错，不是待办。
const allBound = scens.filter((sc) => sc.panel).every((sc) => {
  const id = (nextManifest.scenes[sc.id] || {}).sessionId;
  return id && id !== '__待填__';
});
if (allBound) delete nextManifest.fresh;
fs.writeFileSync(MANIFEST, JSON.stringify(nextManifest, null, 2) + '\n', 'utf8');
say('\n✓ 已写 工作台.json' + (allBound ? '（全部面板已绑定 ⇒ fresh 已清除）' : '（仍有面板未绑定 ⇒ 保持 fresh）'));

// 场景 json 是模板：真值只写 工作台.json（运行时由 外壳\main.js 叠加）。
// 因此这里把场景 json 的 sessionId 统一清回 __待填__，保证「提交模板」与「实例能跑」不再互斥。
let changed = 0;
for (const sc of scens) {
  const cur = sc.panel ? String(sc.panel.sessionId || '') : '';
  if (cur === '__待填__') continue;
  let t = fs.readFileSync(sc.path, 'utf8');
  if (!/"sessionId"\s*:\s*"[^"]*"/.test(t)) {
    // 没有 sessionId 字段：在 "sessionTitle" 之后插入
    t = t.replace(/("sessionTitle"\s*:\s*"[^"]*"\s*,?)/, (m) => m + '\n   "sessionId": "__待填__",');
  } else {
    t = t.replace(/("sessionId"\s*:\s*)"[^"]*"/, '$1"__待填__"');
  }
  fs.writeFileSync(sc.path, t, 'utf8');
  changed++;
  say('  ✓ ' + sc.file + ' → __待填__');
}
say(`\n完成：工作台.json 1 份 · 场景 json ${changed} 份回到模板占位`);
say('下一步：node 工具\\体检.mjs（A8/A10 应按「实例」口径判）');
