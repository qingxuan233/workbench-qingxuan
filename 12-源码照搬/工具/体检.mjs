#!/usr/bin/env node
/**
 * 体检.mjs —— 把方法论里散落的「判据」变成可执行断言
 *
 * 设计原则（照抄方法论 · 总纲「反例验收」）：
 *   1. 只报告，不修。铁不铁由 `--self-test` 证明：每条断言都配一个「故意坏掉」的样本，
 *      坏样本必须报红、好样本必须过；**有一条在坏样本上没报红 ⇒ 这条断言作废**。
 *   2. 一条断言只答一个问题，finding 带路径与证据，不写"建议"。
 *   3. 与《方法论分析与优化方案》的 A1~A10 一一对应，编号不再漂移。
 *
 * 用法：
 *   node 工具\体检.mjs                      体检当前工作台（默认根 = 本文件上一级）
 *   node 工具\体检.mjs --root <路径>         指定根
 *   node 工具\体检.mjs --json               机器可读
 *   node 工具\体检.mjs --self-test          反例验收（自检断言本身是否有效）
 *
 * 退出码：0 全绿（或仅有跳过）｜1 有红 ｜2 自检失败
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { scan as scanEncoding } from './编码检查.mjs';
import binding from './_场景绑定.js';
import { staleWorkspaceFindings } from './_工作区判据.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 根 = 仓库根（本工具在 <根>\12-源码照搬\工具）。可用 --root / DSH_WORKBENCH_ROOT 覆盖。
const DEFAULT_ROOT = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..', '..');

/**
 * 应用目录：仓库根下若有 12-源码照搬\外壳 就进它；否则根自己就是工作台
 * （自检 fixture 走后者：根下直接是 外壳 / 工具 / 引擎数据）。
 */
function appRoot(root) {
  return exists(path.join(root, '12-源码照搬', '外壳')) ? path.join(root, '12-源码照搬') : root;
}

// ── 路径约定（唯一口径：引擎数据\.dsh）─────────────────────────
const memRoot = (root) => path.join(appRoot(root), '引擎数据', '.dsh', '场景记忆');
const sessRoot = (root) => path.join(appRoot(root), '引擎数据', '.dsh', 'sessions');
const dshRoot = (root) => path.join(appRoot(root), '引擎数据', '.dsh');
const sceneJsonDir = (root) => path.join(appRoot(root), '外壳', 'scenarios');
const scriptsDir = (root) => path.join(appRoot(root), '外壳', 'scripts');
const toolsDir = (root) => path.join(appRoot(root), '工具');

// ── 小工具 ────────────────────────────────────────────────
const exists = (p) => { try { fs.accessSync(p); return true } catch { return false } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } };
const readJson = (p) => { try { return JSON.parse(readText(p)) } catch { return null } };
const listDirs = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { return [] } };
const listFiles = (p, re) => {
  try {
    return fs.readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isFile() && (!re || re.test(e.name))).map((e) => e.name);
  } catch { return [] }
};

/** 递归收集 .md（限深度，跳过重目录） */
function walkMd(dir, out = [], depth = 0) {
  if (depth > 3) return out;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(p, out, depth + 1);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/** 读场景配置（外壳\scenarios\*.json） */
function scenes(root) {
  const dir = sceneJsonDir(root);
  const out = [];
  for (const f of listFiles(dir, /\.json$/)) {
    const j = readJson(path.join(dir, f));
    if (j && j.id) out.push(Object.assign({ __file: f, __path: path.join(dir, f) }, j));
  }
  return out;
}
const harnessPanels = (sc) => (sc.panels || []).filter((p) => p && p.type === 'harness');

/** 运行模式：有实例清单 ⇒ instance，否则 template（清单在工作台目录，不在仓库根） */
function modeOf(root) {
  if (process.env.DSH_MODE === 'instance' || process.env.DSH_MODE === 'template') return process.env.DSH_MODE;
  return exists(path.join(appRoot(root), '工作台.json')) ? 'instance' : 'template';
}

// ── 断言表 ────────────────────────────────────────────────
// 每条：{ id, title, layer, instanceOnly?, run(root, ctx) -> findings[] }
// finding = { path, msg }

const ASSERTIONS = [
  {
    id: 'A1', title: '数据根与代码口径一致', layer: 'L3 抓手',
    run(root, ctx) {
      const f = [];
      if (!exists(memRoot(root))) f.push({ path: memRoot(root), msg: '记忆根不存在' });
      // 会话库由引擎启动时创建。刚初始化、还没启动过 ⇒ 缺它是正常，算待办；
    // 非 fresh 态还缺，说明数据根配歪了，那才是红。
    if (!exists(sessRoot(root))) f.push({ path: sessRoot(root), msg: '会话库不存在（引擎还没启动过？）', todo: !!ctx.fresh });
      // 代码里把会话库拼成「.dsh\.dsh」的写法，见过一次就够（真实事故）
      // ⚠ 跳过本文件：它内含自检用的「坏样本」样本串，扫自己会误报。
      const codeFiles = [
        ...listFiles(toolsDir(root), /\.mjs$/).filter((n) => n !== '体检.mjs').map((n) => path.join(toolsDir(root), n)),
        ...listFiles(scriptsDir(root), /\.mjs$/).map((n) => path.join(scriptsDir(root), n))
      ];
      for (const p of codeFiles) {
        const t = readText(p);
        if (/['"]\.\.['"]\s*,\s*['"]\.dsh['"]/.test(t)) {
          f.push({ path: p, msg: "会话库路径拼成了双重 .dsh（应为 path.join(MEMROOT,'..','sessions')）" });
        }
      }
      return f;
    }
  },
  {
    id: 'A2', title: '端口单一来源', layer: 'L4 实例',
    run(root) {
      const f = [];
      const mainJs = path.join(appRoot(root), '外壳', 'main.js');
      const main = readText(mainJs);
      const m = main.match(/DSH_PORT\s*=\s*String\(\s*process\.env\.DSH_PORT\s*\|\|\s*'(\d+)'/);
      if (!m) { f.push({ path: mainJs, msg: '读不到 DSH_PORT 默认值' }); return f }
      const port = m[1];
      for (const n of listFiles(scriptsDir(root), /\.mjs$/)) {
        const p = path.join(scriptsDir(root), n);
        const t = readText(p);
        for (const mm of t.matchAll(/DSH_GUI_BASE\s*\|\|\s*'http:\/\/127\.0\.0\.1:(\d+)'/g)) {
          if (mm[1] !== port) f.push({ path: p, msg: `默认端口 ${mm[1]} ≠ main.js 的 ${port}` });
        }
      }
      return f;
    }
  },
  {
    id: 'A3', title: '记忆单一真源', layer: 'L2 机制',
    run(root) {
      const f = [];
      for (const s of listDirs(memRoot(root))) {
        if (s.startsWith('_')) continue;
        const dir = path.join(memRoot(root), s);
        const files = listFiles(dir);
        if (!files.includes('场景私有记忆.md')) continue;
        for (const n of files) {
          if (n !== '场景私有记忆.md' && /场景私有记忆\.md$/.test(n)) {
            f.push({ path: path.join(dir, n), msg: `与 场景私有记忆.md 重复（旧命名），应删除并只留真源` });
          }
        }
      }
      return f;
    }
  },
  {
    id: 'A4', title: '已绑定的会话必须在库', layer: 'L2 机制',
    run(root, ctx) {
      const f = [];
      const bound = [];
      for (const sc of ctx.scenes) {
        for (const p of harnessPanels(sc)) {
          const id = binding.effectiveSessionId(ctx.manifest, sc.id, p); if (!id) continue;   // 未绑定交给 A10
          bound.push({ sc, p, id });
        }
      }
      for (const b of bound) {
        let found = false;
        for (const ws of listDirs(sessRoot(root))) {
          if (exists(path.join(sessRoot(root), ws, b.id, 'session.v4.jsonl.zstd')) ||
              exists(path.join(sessRoot(root), ws, b.id, 'session.v3.jsonl.zstd'))) { found = true; break }
        }
        if (!found) f.push({ path: b.sc.__path, msg: `面板 ${b.p.id} 的会话 ${b.id} 不在会话库` });
      }
      return f;
    }
  },
  {
    id: 'A5', title: '会话工作目录（cwd）必须存在', layer: 'L2 机制',
    run(root, ctx) {
      const f = [];
      const cacheDir = path.join(dshRoot(root), 'storages', 'session_projcache', 'sessions');
      for (const sc of ctx.scenes) {
        for (const p of harnessPanels(sc)) {
          const id = binding.effectiveSessionId(ctx.manifest, sc.id, p); if (!id) continue;
          const j = readJson(path.join(cacheDir, id + '.json'));
          const cwd = j && j.record && j.record.identity && j.record.identity.cwd;
          if (!cwd) continue;                              // 没有记录就不判
          if (!exists(cwd)) f.push({ path: path.join(cacheDir, id + '.json'), msg: `cwd 已不存在：${cwd}` });
        }
      }
      return f;
    }
  },
  {
    id: 'A6', title: '面板→场景记忆 可解析', layer: 'L2 机制',
    run(root, ctx) {
      const f = [];
      const sw = path.join(scriptsDir(root), '换会话.mjs');
      if (exists(sw) && /<工作台>/.test(readText(sw))) {
        f.push({ path: sw, msg: '仍含占位路径 <工作台>（换会话会把交接写到不存在的地方）' });
      }
      for (const sc of ctx.scenes) {
        if (!harnessPanels(sc).length) continue;
        const mp = path.join(memRoot(root), String(sc.name || sc.id), '场景私有记忆.md');
        if (!exists(mp)) f.push({ path: sc.__path, msg: `场景「${sc.name || sc.id}」的记忆文件不存在，自动交接无处落` });
      }
      return f;
    }
  },
  {
    id: 'A7', title: '§〇 可开工（体量之外的第二道闸）', layer: 'L2 机制',
    run(root, ctx) {
      const f = [];
      for (const sc of ctx.scenes) {
        const mp = path.join(memRoot(root), String(sc.name || sc.id), '场景私有记忆.md');
        if (!exists(mp)) continue;
        f.push(...checkKaiGong(mp, sc.name || sc.id));
      }
      return f;
    }
  },
  {
    id: 'A8', title: '模板模式不得泄漏实例信息', layer: 'L4 实例',
    run(root, ctx) {
      if (ctx.mode !== 'template') return [];
      const f = [];
      for (const sc of ctx.scenes) {
        for (const p of harnessPanels(sc)) {
          const id = String(p.sessionId || '').trim();
          if (/^session-[0-9a-f]{8}-/.test(id)) {
            f.push({ path: sc.__path, msg: `模板里出现真实会话 id（${id.slice(0, 20)}…）` });
          }
        }
      }
      const codeFiles = [
        ...listFiles(path.join(root, '外壳'), /\.js$/).map((n) => path.join(root, '外壳', n)),
        ...listFiles(scriptsDir(root), /\.mjs$/).map((n) => path.join(scriptsDir(root), n))
      ];
      for (const p of codeFiles) {
        if (/[A-Za-z]:\\\\Programs|[A-Za-z]:\\\\software/i.test(readText(p))) {
          f.push({ path: p, msg: '出现本机绝对路径（模板应改为清单/环境变量）' });
        }
      }
      return f;
    }
  },
  {
    id: 'A9', title: '文档口径唯一（记忆目录）', layer: 'L1 宪法',
    run(root) {
      const SKIP = ['13-公开情报', '09-改造参考', '配图', 'node_modules', '.git', '.npm-cache'];
      // 引述旧口径作证据、或属于历史记录的文档不参与口径判定：
      //   差异审计/方法论分析 = 审计证据原文；更新清单 = 变更史（改动史不该被改写）
      const QUOTE = /^(差异审计|方法论分析|体检|与上游|仓库分工|更新清单)/;
      const f = [];
      for (const p of walkMd(root)) {
        const rel = path.relative(root, p);
        if (SKIP.some((s) => rel.split(path.sep).includes(s))) continue;
        if (QUOTE.test(path.basename(p))) continue;
        const t = readText(p);
        t.split(/\r?\n/).forEach((line, i) => {
          if (/引擎\\场景记忆|引擎\/场景记忆/.test(line) && !/引擎数据/.test(line)) {
            f.push({ path: p, msg: `第 ${i + 1} 行仍是旧口径「引擎\\场景记忆」，应为 引擎数据\\.dsh\\场景记忆` });
          }
        });
      }
      return f;
    }
  },
  {
    id: 'A10', title: '每个 AI 面板都已绑定会话（实例）', layer: 'L2 机制',
    run(root, ctx) {
      if (ctx.mode !== 'instance') return [];
      const f = [];
      for (const sc of ctx.scenes) {
        for (const p of harnessPanels(sc)) {
          const id = binding.effectiveSessionId(ctx.manifest, sc.id, p);
          if (!id) {
            f.push({
              path: sc.__path,
              msg: `面板 ${p.id} 未绑定会话（跑 node 工具\\实例化.mjs）`,
              todo: !!ctx.fresh          // 装好还没绑会话 ⇒ 待办；绑了一半就是错
            });
          }
        }
      }
      return f;
    }
  },
  {
    id: 'A11', title: '身份索引与场景 json 一致（索引是生成物）', layer: 'L2 机制',
    run(root, ctx) {
      const idx = path.join(sceneJsonDir(root), '_场景身份索引.md');
      if (!exists(idx)) return [{ path: idx, msg: '缺身份索引（跑 node 工具\\身份索引.mjs --stamp）' }];
      // 表格列：场景id | 面板id | 面板标题 | 会话名 | 会话id | 定位卡 | 主技能
      const table = new Map();
      for (const line of readText(idx).split(/\r?\n/)) {
        const t = line.trim();
        if (!t.startsWith('|')) continue;
        const c = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim().replace(/`/g, ''));
        if (c.length < 5 || !/^[a-z0-9-]+$/.test(c[0])) continue;
        table.set(c[0], { panel: c[1], sessionId: c[4] });
      }
      const f = [];
      for (const sc of ctx.scenes) {
        const row = table.get(String(sc.id));
        if (!row) { f.push({ path: idx, msg: `索引里缺场景 ${sc.id}（跑 node 工具\\身份索引.mjs --stamp）` }); continue }
        for (const p of harnessPanels(sc)) {
          const id = String(p.sessionId || '').trim();
          if (id && id !== '__待填__' && row.sessionId !== id) {
            f.push({ path: idx, msg: `${sc.id} 的会话 id 与 json 不一致（索引 ${row.sessionId.slice(0, 22)}… / json ${id.slice(0, 22)}…）⇒ 跑 身份索引.mjs --stamp` });
          }
          if (p.id && row.panel && row.panel !== p.id) {
            f.push({ path: idx, msg: `${sc.id} 的面板 id 与 json 不一致（索引 ${row.panel} / json ${p.id}）` });
          }
        }
      }
      return f;
    }
  },
  {
    id: 'A12', title: '待确认项不悬空（超过 14 天必须有人结清）', layer: 'L3 抓手',
    run(root) {
      const F = path.join(memRoot(root), '_共享记忆', '待确认.jsonl');
      if (!exists(F)) return [];
      const f = [];
      const latest = new Map();
      readText(F).split(/\r?\n/).forEach((line, i) => {
        if (!line.trim()) return;
        let j; try { j = JSON.parse(line) } catch (e) { f.push({ path: F, msg: `第 ${i + 1} 行不是合法 JSON` }); return }
        if (j && j.id) latest.set(j.id, j);      // 后写者为准（append-only）
      });
      const DAY = 86400000;
      for (const r of latest.values()) {
        if (r.status !== 'pending') continue;
        const t = Date.parse(r.ts || '');
        if (!Number.isFinite(t)) { f.push({ path: F, msg: `${r.id} 的 ts 读不出时间` }); continue }
        const days = Math.floor((Date.now() - t) / DAY);
        if (days > 14) f.push({ path: F, msg: `${r.id} 已悬空 ${days} 天（${r.file || '?'}）：等宿主 resolve 或删掉` });
      }
      return f;
    }
  },
  {
    id: 'A13', title: '实例清单可解析（BOM/语法错会让真值静默失效）', layer: 'L4 实例',
    run(root) {
      const mf = path.join(appRoot(root), '工作台.json');
      if (!exists(mf)) return [];                     // 模板态没有清单，不算错
      const buf = fs.readFileSync(mf);
      const f = [];
      if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        f.push({ path: mf, msg: '带 UTF-8 BOM ⇒ JSON.parse 必失败（PowerShell Set-Content -Encoding UTF8 会加）' });
      }
      try { JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, '')) }
      catch (e) { f.push({ path: mf, msg: 'JSON 语法错误：' + (e && e.message) }) }
      return f;
    }
  },
    {
      id: 'A14', title: '文本编码不会乱码（BOM / 换行 / 代码页）', layer: 'L3 抓手',
      run(root) {
        // 判据不是"我觉得该用什么编码"，而是按真实消费者：JSON.parse / cmd / WSH / PS 5.1。
        // 三类真实事故：BOM 让 JSON.parse 静默失败、LF 让 cmd 切碎命令、代码页让中文变问号。
        const app = appRoot(root);
        if (!exists(app)) return [];
        return scanEncoding(app).reds.map((r) => ({ path: r.path, msg: `${r.kind}：${r.msg}` }));
      }
    },
  {
    id: 'A15', title: '路径基准有效（不悬空 / 不重复定义）', layer: 'L3 抓手',
    /**
     * 「失效路径」的四条判据。四条都是真实踩过的，不是想象出来的：
     *   ① 写出来的绝对路径必须存在（文档里承诺"必须存在"的「引擎\」在公开版里根本不存在）；
     *   ② 同一个基准路径只能有一个定义（删了引擎目录，另一处还在按旧目录拼）；
     *   ③ 推不出来的路径必须给空/null，不能退回一个"看起来对"的写死值（否则判断永远为真）；
     *   ④ 空值不能喂给 path.join / fs（空串拼出来的相对路径会按进程 cwd 解析，静默落到别处）。
     * 只认"本仓库内的字面量绝对路径"和"本仓库的已知基准"，不做全盘文件系统爬取。
     */
    run(root, ctx) {
      const app = appRoot(root);
      const SHELL = path.join(app, '外壳');
      const f = [];

      // ── ① 基准路径不得重复定义：引擎目录只有一个真源 HARNESS_DIR ──────────
      //   真实事故：删掉照搬来的 引擎\ 之后，main.js 里 HARNESS_DIR 仍然"推得出来"，
      //   于是 `path.join(HARNESS_DIR, 'apps','cli','lib','bin.js')` 拼出一个永远不存在的路径，
      //   还被当成首选启动方式写进启动计划。判据 = 推不出来时必须给空串，且用它的地方必须判空。
      const mainJs = path.join(SHELL, 'main.js');
      const main = readText(mainJs);
      if (main) {
        const defs = (main.match(/^const\s+HARNESS_DIR\s*=/gm) || []).length;
        if (defs > 1) f.push({ path: mainJs, msg: `HARNESS_DIR 定义了 ${defs} 次（基准路径必须单点定义）` });
        const block = (main.match(/const HARNESS_DIR = \(function \(\) \{[\s\S]{0,500}?\}\)\(\);/) || [''])[0];
        if (block && !/return\s+''\s*;/.test(block)) {
          f.push({ path: mainJs, msg: "HARNESS_DIR 推不出来时没有给 ''，而是退回了写死路径 ⇒「引擎在不在」的判断永远为真" });
        }
      }

      // ── ② 每个**本仓库定义**的基准路径：写进代码就必须真的存在 ────────────
      //   只认本仓库口径的基准（不与"本机装在哪"混为一谈：引擎/Node 是外部依赖，归 工作台.json 管，不在此列）。
      const BENCH = [
        { name: '外壳\\scenarios', p: path.join(SHELL, 'scenarios'), must: true },
        { name: '引擎数据\\.dsh\\场景记忆', p: memRoot(root), must: true },
        { name: '外壳\\scripts', p: scriptsDir(root), must: true }
      ];
      for (const b of BENCH) {
        if (b.must && !exists(b.p)) f.push({ path: b.p, msg: `基准路径不存在：${b.name}` });
      }

      // ── ③ 场景 json 里点名的文件必须存在（定位卡 / 记忆文件这一类"名字对不上就静默跳过"） ──
      //   真实事故：sessions.mjs 的自检点着 `scenarios\dsh-gui-context.md` —— 一个作者机上才有、
      //   本仓库从来没有的文件 ⇒ 那项自检永远静默跳过，等于没写。
      if (ctx && Array.isArray(ctx.scenes)) {
        for (const sc of ctx.scenes) {
          for (const pt of [].concat(sc.pinTarget || [])) {
            const abs = path.join(SHELL, String(pt).replace(/\\/g, '/'));
            if (!exists(abs) && /\.(md|json|txt)$/i.test(String(pt))) {
              f.push({ path: sc.__path, msg: `pinTarget 指向的文件不存在：「${pt}」` });
            }
          }
        }
      }

      // ── ④ 代码里点名的"本仓库内"文件必须存在 ─────────────────────────────
      //   只查 外壳\scenarios\ 下**本仓库自产**的文件名；
      //   外部引擎路径（引擎\…、resources\…）一律不当基准 —— 那是装配问题，由 工作台.json 与启动日志判。
      //   ⚠ 两种写法都要认：字符串里带目录（'scenarios\\x.md'）和 path.join 分段（join(r,'scenarios','x.md')）。
      //   这条断言自己踩过坑：只认 'scenarios\' 反斜杠写法时，path.join 形式的坏引用一个都抓不到，
      //   反例验收当场把这条判成"没命中 ⇒ 断言作废"（这正是反例验收存在的意义）。
      const codeFiles = [
        ...listFiles(SHELL, /\.(js|mjs)$/).map((n) => path.join(SHELL, n)),
        ...listFiles(scriptsDir(root), /\.(js|mjs)$/).map((n) => path.join(scriptsDir(root), n)),
        ...listFiles(path.join(SHELL, 'renderer'), /\.js$/).map((n) => path.join(SHELL, 'renderer', n))
      ];
      const REF_INLINE = /['"][^'"]*[\\/]scenarios[\\/]([^'"\\/]+\.(?:md|json))['"]/g;   // 'scenarios\\x.md'
      const REF_JOIN = /['"]scenarios['"]\s*,\s*['"]([^'"]+\.(?:md|json))['"]/g;         // join(r,'scenarios','x.md')
      const seen = new Set();
      // 「可选注入件」白名单：代码里 existsSync 守着的可选文件，缺了是设计如此，不是失效路径。
      //   目前只有 oa-context.md（OA / 内部管理系统模块在公开版被剔除，该文件从没进过仓库）。
      const OPTIONAL = new Set(['oa-context.md']);
      for (const p of codeFiles) {
        const t = readText(p);
        t.split(/\r?\n/).forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line)) return;          // 注释里的历史名字不算
          for (const re of [REF_INLINE, REF_JOIN]) {
            for (const m of line.matchAll(re)) {
              if (OPTIONAL.has(m[1])) continue;
              const abs = path.join(SHELL, 'scenarios', m[1]);
              if (exists(abs)) continue;
              const key = p + '|' + i + '|' + m[1];
              if (seen.has(key)) continue;
              seen.add(key);
              f.push({ path: p, msg: `第 ${i + 1} 行引用了不存在的场景文件：scenarios\\${m[1]}` });
            }
          }
        });
      }

      return f;
    }
  },
  {
    id: 'A16', title: '实例工作区有效（默认工作区 / 所有登记工作区 / 面板会话 cwd 都落在真工作台上）', layer: 'L4 实例',
    /**
     * 「失效路径」的实例态分支：**路径存在 ≠ 路径有效**。
     *   2026-11-07 事故：仓库搬家后引擎 workspace.json 仍指旧路径（旧目录还在、是空的）⇒ 新会话在空目录里干活；
     *   A5「cwd 必须存在」抓不到（空目录也存在）。判据取本仓库自己的锚：落在 $APP 内，或路径下真有 外壳\main.js。
     */
    run(root, ctx) {
      if (!ctx || ctx.mode !== 'instance') return [];       // 模板态没有引擎实例，不判
      const f = [];
      const wsFile = path.join(dshRoot(root), 'storages', 'workspace.json');
      const ws = readJson(wsFile);
      if (!ws) return [];                                   // 引擎从没启动过：交给 A1 报「会话库缺失」
      const app = path.resolve(appRoot(root));
      const tables = (ws.tables && ws.tables.workspaces) || {};
      const inside = (p, base) => { const r = path.resolve(p); return r === base || r.startsWith(base + path.sep) };
      const isWorkbenchRoot = (p) => exists(path.join(p, '外壳', 'main.js')) || exists(path.join(p, '12-源码照搬', '外壳', 'main.js'));
      const valid = (p) => exists(p) && (inside(p, app) || isWorkbenchRoot(p));

      // ① 默认工作区：**登记过**就必须有效（路径存在、且是本工作台）。
      //    未登记（引擎内部悬空 id）不判：那是引擎自己的状态，没有 RPC 可改、运行期落盘还会覆盖文件写入，
      //    本仓库能修、也必须修的是「登记过的路径别指向失效目录」——这条才可操作、可证伪。
      const defId = String((ws.global && ws.global.defaultWorkspaceId) || '');
      const def = defId && tables[defId];
      if (def) {
        if (!exists(def.path)) f.push({ path: wsFile, msg: `默认工作区路径不存在：${def.path}` });
        else if (!valid(def.path)) f.push({ path: wsFile, msg: `默认工作区路径已失效（不在本工作台内、也没有 外壳\\main.js）：${def.path}` });
      }

      // ② 面板会话的 cwd 必须落在**登记过且真的有效**的工作区里。
      //    cwd 存在不算数：旧路径的目录还在、只是空的 —— 这次事故的形态正是「空目录里干活」。
      const wsList = Object.values(tables)
        .map((w) => ({ path: String((w && w.path) || ''), ok: !!w && valid(String((w && w.path) || '')) }))
        .filter((w) => w.path);
      const cacheDir = path.join(dshRoot(root), 'storages', 'session_projcache', 'sessions');
      for (const sc of ctx.scenes) {
        for (const p of harnessPanels(sc)) {
          const id = binding.effectiveSessionId(ctx.manifest, sc.id, p); if (!id) continue;
          const j = readJson(path.join(cacheDir, id + '.json'));
          const cwd = j && j.record && j.record.identity && j.record.identity.cwd; if (!cwd) continue;
          const hit = wsList.find((w) => inside(cwd, w.path));
          if (!hit) f.push({ path: path.join(cacheDir, id + '.json'), msg: `面板 ${p.id} 的会话 cwd 不在任何已登记工作区内：${cwd}` });
          else if (!hit.ok) f.push({ path: path.join(cacheDir, id + '.json'), msg: `面板 ${p.id} 的会话 cwd 落在失效工作区（${hit.path}）⇒ 等于在空目录里干活` });
        }
      }

      // ③ **每一张登记过的工作区**都必须有效（只查默认工作区会漏 —— 旧仓库根曾长期空挂在登记表里）
      f.push(...staleWorkspaceFindings({ tables, wsFile, defId, exists, valid }));
      return f;
    }
  }
];

/** §〇 可开工判据（A7 与 场景记忆.mjs check 共用同一口径） */
export function checkKaiGong(file, sceneName) {
  const f = [];
  const t = readText(file);
  const name = sceneName || path.basename(path.dirname(file));

  const i = t.search(/^##\s*§〇/m);
  if (i < 0) { f.push({ path: file, msg: '缺 §〇 当前交接' }); return f }
  const j = t.slice(i + 1).search(/^##\s/m);
  const sec = j < 0 ? t.slice(i) : t.slice(i, i + 1 + j);

  // 1) 五小节齐全且顺序固定
  const want = ['### 1)', '### 2)', '### 3)', '### 4)', '### 5)'];
  let last = -1;
  for (const w of want) {
    const at = sec.indexOf(w);
    if (at < 0) f.push({ path: file, msg: `§〇 缺小节 ${w}` });
    else if (at < last) f.push({ path: file, msg: `§〇 小节 ${w} 顺序错` });
    else last = at;
  }

  // 2) 下一步：非空、非占位、像「动词 + 对象」
  const nextLine = (sec.match(/下一步[:：]\s*(.*)/) || [])[1] || '';
  if (!nextLine.trim()) f.push({ path: file, msg: '§〇「下一步」为空' });
  else if (/^[（(]?\s*(待补|空|无|—|-|暂无)/.test(nextLine.trim())) {
    f.push({ path: file, msg: `§〇「下一步」仍是占位：${nextLine.trim().slice(0, 20)}` });
  } else if (nextLine.trim().length < 8) {
    f.push({ path: file, msg: `§〇「下一步」太短，读不出动作：${nextLine.trim()}` });
  }

  // 3) 卡点必填
  const blockLine = (sec.match(/卡点[:：]\s*(.*)/) || [])[1] || '';
  if (!blockLine.trim()) f.push({ path: file, msg: '§〇「卡点」为空（无也要写「无」）' });

  // 4) 反周报化
  const weekly = (sec.match(/今天|然后|接着|首先|另外还/g) || []).length;
  if (weekly >= 3) f.push({ path: file, msg: `§〇 像周报（流水词 ${weekly} 次），应只写 我是谁/干到哪/下一步/卡在哪` });

  // 5) 单节行数上限
  for (const w of want.slice(0, 4)) {
    const a = sec.indexOf(w);
    if (a < 0) continue;
    const rest = sec.slice(a + w.length);
    const b = rest.search(/^###\s/m);
    const body = b < 0 ? rest : rest.slice(0, b);
    const lines = body.split(/\r?\n/).filter((x) => x.trim()).length;
    if (lines > 15) f.push({ path: file, msg: `小节 ${w} 有 ${lines} 行（上限 15）` });
  }

  // 6) 核心职责不得是占位
  const k = t.search(/^##\s*核心职责/m);
  if (k < 0) f.push({ path: file, msg: '缺「## 核心职责」' });
  else {
    const rest = t.slice(k);
    const end = rest.slice(1).search(/^##\s/m);
    const body = end < 0 ? rest : rest.slice(0, end + 1);
    if (/（待补）|\(待补\)/.test(body)) f.push({ path: file, msg: '「核心职责」仍是「（待补）」' });
    if (body.split(/\r?\n/).filter((x) => /^\s*[-*]\s*\S/.test(x)).length < 3) {
      f.push({ path: file, msg: '「核心职责」不足 3 条' });
    }
  }
  return f;
}

// ── 运行 ─────────────────────────────────────────────────
function runAll(root) {
  // fresh = 「刚初始化、还没绑会话」的合法中间态：未绑定算待办，不算失败。
  // 一旦 实例化.mjs --apply 绑完并清掉 fresh，A10 立刻恢复硬判。
  // 没有 工作台.json（刚 clone 下来、还没跑初始化）同样算 fresh ——
  //   否则新克隆的仓库第一条体检就报红，把"还没开始"说成"坏了"（真实踩到）。
  let fresh = true, manifest = {};
  try {
    const mf = path.join(appRoot(root), '工作台.json');
    if (exists(mf)) { manifest = JSON.parse(readText(mf).replace(/^\uFEFF/, '')) || {}; fresh = manifest.fresh === true }
  } catch { fresh = true; /* 清单坏了由 A13 报，这里按未初始化处理 */ }
  const ctx = { scenes: scenes(root), mode: modeOf(root), fresh, manifest };
  const results = ASSERTIONS.map((a) => {
    let findings = [];
    try { findings = a.run(root, ctx) } catch (e) { findings = [{ path: root, msg: '断言自身抛错: ' + (e && e.message) }] }
    return { id: a.id, title: a.title, layer: a.layer, ok: findings.every((f) => f && f.todo), findings };
  });
  return { root, mode: ctx.mode, fresh, results };
}

// ── 反例验收 ──────────────────────────────────────────────
const GOOD_MD = `# 命令 · 场景私有记忆

## §〇 当前交接

### 1) 上次交接
- 2026-11-01 建好骨架，四场景会话已绑定

### 2) 当前项目
| 项目 | 记忆文件 | 状态 | 下一步 |
|---|---|---|---|
| 无 | — | — | — |

### 3) 私有记忆变更
- 2026-11-01：初建

### 4) 下一步 / 卡点
- 下一步：把「命令」场景的职责边界写进核心职责
- 卡点：无

### 5) 全貌
- 项目记忆 0 个 · 归档 0 份

## 核心职责

- 负责：总览与路由（谁该干什么）
- 不碰：具体业务执行（交派给对应场景）
- 一句话：进来先问「这活归谁」，不自己动手。
`;

const BAD_MD = `# 命令 · 场景私有记忆

## §〇 当前交接

### 1) 上次交接
- 今天做了 5 件事，然后改了配置，接着又跑了测试，首先修了 bug，另外还写了文档，然后又复盘，接着再改。

### 2) 当前项目
- 无

### 3) 私有记忆变更
- （空）

### 4) 下一步 / 卡点
- 下一步：（待补）
- 卡点：

### 5) 全貌
- 无

## 核心职责

- 负责：（待补）
- 不碰：（待补）
- 一句话：能用一句话说清才算立住。
`;

function makeFixture(root, o = {}) {
  fs.rmSync(root, { recursive: true, force: true });
  const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) };
  const sid = o.placeholder ? '__待填__' : 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  // 记忆
  const sd = path.join(memRoot(root), '命令');
  w(path.join(sd, '场景私有记忆.md'), o.badScene ? BAD_MD : GOOD_MD);
  w(path.join(sd, '身份卡.md'), '# 身份卡\n');
  w(path.join(sd, '场景画像.md'), '# 画像\n');
  w(path.join(sd, '_文件索引.md'), '# 索引\n');
  fs.mkdirSync(path.join(sd, '项目记忆'), { recursive: true });
  fs.mkdirSync(path.join(sd, '归档'), { recursive: true });
  if (o.dupMemory) w(path.join(sd, '命令场景私有记忆.md'), GOOD_MD);

  // 待确认队列（A12）
  if (o.stalePending) {
    const old = new Date(Date.now() - 30 * 86400000).toISOString();
    w(path.join(memRoot(root), '_共享记忆', '待确认.jsonl'),
      JSON.stringify({ id: 'P001', ts: old, actor: 'AI', scope: '宪法层', file: 'x.md', propose: 'y', status: 'pending' }) + '\n');
  }

  // 会话库
  if (!o.dropSession) {
    const d = path.join(sessRoot(root), 'ws1', sid);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'session.v4.jsonl.zstd'), 'x');
  }

  // 会话缓存（cwd）
  const cwd = o.deadCwd ? path.join(root, 'gone-workspace')
    : o.cwdOutside ? path.join(root, 'outside-cwd')
    : o.badPanelWsOutside ? path.join(path.dirname(root), 'stale-panel-' + path.basename(root))
    : path.join(root, '工作区');
  if (!o.deadCwd) fs.mkdirSync(cwd, { recursive: true });
  w(path.join(dshRoot(root), 'storages', 'session_projcache', 'sessions', sid + '.json'),
    JSON.stringify({ record: { identity: { cwd } } }));

  // 引擎工作区登记（A16）：默认工作区 = <fixture>\工作区（落在工作台内）
  //   反例各造一种「失效路径」：路径不存在 / 路径在但已经不是工作台 / 面板 cwd 落在失效工作区。
  {
    const wsId = 'ws-11111111-2222-3333-4444-555555555555';
    const wsPath = o.badDefaultOutside ? path.join(path.dirname(root), 'stale-' + path.basename(root))
      : o.badPanelWsOutside ? path.join(path.dirname(root), 'stale-panel-' + path.basename(root))
      : o.badDefaultPath ? path.join(root, 'gone-workspace')
      : path.join(root, '工作区');
    if (o.badDefaultOutside) fs.mkdirSync(wsPath, { recursive: true });   // 目录存在但里面没有 外壳\main.js
    const table = {};
    table[wsId] = { path: wsPath, title: '工作区', sessionIds: [] };
    // badRegisteredOutside：默认工作区是好的，但另有一张登记项指着失效旧路径（2026-11-07 真实形态）
    if (o.badRegisteredOutside) { const p2 = path.join(path.dirname(root), 'stale-registered-' + path.basename(root)); fs.mkdirSync(p2, { recursive: true }); table['ws-66666666-7777-8888-9999-000000000000'] = { path: p2, title: '旧工作区', sessionIds: [] }; }
    w(path.join(dshRoot(root), 'storages', 'workspace.json'), JSON.stringify({
      global: { defaultWorkspaceId: wsId, workspaceIds: o.badRegisteredOutside ? [wsId, 'ws-66666666-7777-8888-9999-000000000000'] : [wsId], archivedSessionIds: [] },
      tables: { workspaces: table }
    }, null, 1));
  }

  // 场景配置
  w(path.join(root, '外壳', 'scenarios', 'command.json'), JSON.stringify({
    id: 'command', name: '命令',
    panels: [{ id: 'cmd-chat', type: 'harness', sessionId: sid }]
  }, null, 1));

  // 身份索引（生成物：正常应与 json 一致）
  const idxSid = o.badIndex ? 'session-ffffffff-ffff-ffff-ffff-ffffffffffff' : sid;
  w(path.join(root, '外壳', 'scenarios', '_场景身份索引.md'),
    '# 场景身份索引\n\n'
    + '| 场景 id | 面板 id | 面板标题 | 会话名（pinTarget 首项） | 会话 id | 定位卡 | 主技能 |\n'
    + '|---|---|---|---|---|---|---|\n'
    + `| \`command\` | \`cmd-chat\` | AI·命令 | 命令 | \`${idxSid}\` | \`scenarios\\command-context.md\` | \`command\` |\n`);

  // 代码
  w(path.join(root, '外壳', 'main.js'), "const DSH_PORT = String(process.env.DSH_PORT || '3083');\n");
  w(path.join(root, '外壳', 'scripts', '换会话.mjs'),
    o.badHandoff ? "const P = '<工作台>\\\\引擎\\\\场景记忆\\\\命令\\\\场景私有记忆.md';\n" : "// 面板→记忆 由场景名派生\n");
  w(path.join(root, '外壳', 'scripts', 'sessions.mjs'),
    "const BASE = process.env.DSH_GUI_BASE || 'http://127.0.0.1:" + (o.badPort ? '3080' : '3083') + "';\n");
  w(path.join(root, '工具', '场景记忆.mjs'),
    o.badSess ? "const SESS = path.join(MEMROOT, '..', '.dsh', 'sessions')\n"
              : "const SESS = path.join(MEMROOT, '..', 'sessions')\n");
  w(path.join(root, 'README.md'), o.badDoc ? '记忆放 引擎\\场景记忆\\命令\\\n' : '记忆放 引擎数据\\.dsh\\场景记忆\\命令\\\n');

  // 实例清单决定模式
  if (!o.template) {
    const mf = path.join(root, '工作台.json');
    fs.mkdirSync(path.dirname(mf), { recursive: true });
    // badManifest：带上 UTF-8 BOM（PowerShell 5 的 Set-Content -Encoding UTF8 就会这么写）
    fs.writeFileSync(mf, (o.badManifest ? '\uFEFF' : '') + JSON.stringify({ version: 1, dshPort: 3083, fresh: !!o.fresh }, null, 1));
  }
  // badBat：批处理写成 LF + 中文（真实事故：cmd 会把中文行切成碎片当命令执行）
  if (o.badBat) fs.writeFileSync(path.join(root, '外壳', 'start-bad.bat'), '@echo off\necho 你好\n', 'utf8');

  // A15 的四类坏样本（「失效路径」）：
  //   ① 基准推不出来却退回写死值 ⇒ "引擎在不在"永远为真
  //   ② 同一个基准定义两次
  //   ③ 场景 json 的 pinTarget 点着一个本仓库没有的文件
  //   ④ 代码里引用了不存在的 scenarios\*.md
  if (o.badBase) {
    w(path.join(root, '外壳', 'main.js'),
      "const DSH_PORT = String(process.env.DSH_PORT || '3083');\n"
      + 'const HARNESS_DIR = (function () {\n'
      + "  const sibling = path.join(path.dirname(__dirname), '引擎');\n"
      + "  try { if (fs.existsSync(path.join(sibling, 'apps', 'cli'))) return sibling; } catch (e) { /* ignore */ }\n"
      + "  return path.join(path.dirname(__dirname), '引擎');\n"
      + '})();\n'
      + (o.dupBase ? "const HARNESS_DIR = '';\n" : ''));
  }
  if (o.badPin) {
    const scf = path.join(root, '外壳', 'scenarios', 'command.json');
    const j = JSON.parse(fs.readFileSync(scf, 'utf8'));
    j.pinTarget = ['scenarios\\dsh-gui-context.md'];
    fs.writeFileSync(scf, JSON.stringify(j, null, 1));
  }
  if (o.badRef) {
    w(path.join(root, '外壳', 'scripts', 'sessions.mjs'),
      "const BASE = process.env.DSH_GUI_BASE || 'http://127.0.0.1:3083';\n"
      + "const CARD = path.join(root, 'scenarios', 'dsh-gui-context.md');\n");
  }
  return root;
}

function selfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vitals-'));
  const cases = [
    { id: 'A1', opts: { badSess: true }, desc: '会话库拼成双重 .dsh' },
    { id: 'A2', opts: { badPort: true }, desc: '脚本端口 3080 ≠ 3083' },
    { id: 'A3', opts: { dupMemory: true }, desc: '同一场景两份记忆文件' },
    { id: 'A4', opts: { dropSession: true }, desc: '会话不在库' },
    { id: 'A5', opts: { deadCwd: true }, desc: '会话 cwd 已不存在' },
    { id: 'A6', opts: { badHandoff: true }, desc: '换会话仍用占位路径' },
    { id: 'A7', opts: { badScene: true }, desc: '§〇 是周报 / 职责待补' },
    { id: 'A8', opts: { template: true }, desc: '模板里含真实会话 id' },
    { id: 'A9', opts: { badDoc: true }, desc: '文档用旧口径 引擎\\场景记忆' },
    { id: 'A10', opts: { placeholder: true }, desc: '实例模式下面板未绑定会话' },
    { id: 'A11', opts: { badIndex: true }, desc: '身份索引与场景 json 漂移' },
    { id: 'A12', opts: { stalePending: true }, desc: '待确认项悬空 30 天没人结清' },
    { id: 'A13', opts: { badManifest: true }, desc: '工作台.json 带 BOM ⇒ JSON.parse 失败' },
    { id: 'A14', opts: { badBat: true }, desc: '批处理写成 LF + 中文（cmd 会切碎）' },
    { id: 'A15', opts: { badBase: true }, desc: '基准推不出来却退回写死路径（判断永远为真）' },
    { id: 'A15', opts: { badBase: true, dupBase: true }, desc: '同一个基准路径定义了两次' },
    { id: 'A15', opts: { badPin: true }, desc: '场景 json 的 pinTarget 点着不存在的文件' },
    { id: 'A15', opts: { badRef: true }, desc: '代码引用了不存在的 scenarios\\*.md' },
    // A16 的四类坏样本（实例态「失效路径」：路径存在 ≠ 有效）
    { id: 'A16', opts: { badDefaultPath: true }, desc: '默认工作区路径不存在' },
    { id: 'A16', opts: { badDefaultOutside: true }, desc: '默认工作区路径存在但已不是工作台（旧路径空挂）' },
    { id: 'A16', opts: { badPanelWsOutside: true }, desc: '面板会话 cwd 落在失效工作区（空目录里干活）' },
    { id: 'A16', opts: { badRegisteredOutside: true }, desc: '登记表里还挂着一张失效工作区（默认工作区是好的 ⇒ 只看默认会漏）' },
  ];

  let pass = 0, fail = 0;
  const log = [];

  // ① 好样本：除 A8 外必须全绿（A8 只在模板模式生效，好样本是实例）
  const goodRoot = makeFixture(path.join(tmp, 'good'), {});
  const good = runAll(goodRoot);
  for (const r of good.results) {
    if (r.id === 'A8') continue;
    if (r.ok) { pass++; log.push(`  ✓ 好样本 ${r.id} ${r.title}`) }
    else { fail++; log.push(`  ✗ 好样本 ${r.id} 误报：${r.findings.map((x) => x.msg).join(' / ')}`) }
  }

  // ② 坏样本：对应断言必须报红
  for (const c of cases) {
    const root = makeFixture(path.join(tmp, 'bad_' + c.id), c.opts);
    const res = runAll(root);
    const hit = res.results.find((r) => r.id === c.id);
    if (hit && !hit.ok) { pass++; log.push(`  ✓ 坏样本 ${c.id} 命中（${c.desc}）`) }
    else { fail++; log.push(`  ✗ 坏样本 ${c.id} 未命中（${c.desc}）⇒ 该断言作废`) }
  }

  // ③ fresh 态（装好但还没绑会话）：A10 必须降级为待办，而不是红
  const freshRes = runAll(makeFixture(path.join(tmp, 'fresh'), { placeholder: true, fresh: true }));
  const a10 = freshRes.results.find((r) => r.id === 'A10');
  if (a10 && a10.ok && a10.findings.length > 0) { pass++; log.push('  ✓ fresh 态：未绑会话降级为待办（不误报红）') }
  else { fail++; log.push('  ✗ fresh 态处理错：应为「绿 + 待办」，实际 ' + (a10 ? (a10.ok ? '无待办' : '红') : '缺 A10')) }
  // ② 已覆盖反向情形：同一坏样本去掉 fresh ⇒ 必须红
  const noFresh = runAll(makeFixture(path.join(tmp, 'nofresh'), { placeholder: true }));
  const a10b = noFresh.results.find((r) => r.id === 'A10');
  if (a10b && !a10b.ok) { pass++; log.push('  ✓ 非 fresh 态：未绑会话仍然报红（闸没松）') }
  else { fail++; log.push('  ✗ 非 fresh 态未报红 ⇒ A10 闸被放水') }
  // ③ 刚 clone 下来（仓库里没有 工作台.json，引擎也没启动过）：
  //    A1 的「会话库不存在」必须是待办。否则新克隆的仓库第一条体检就是红的。
  const cloneRes = runAll(makeFixture(path.join(tmp, 'clone'), { template: true }));
  const a1c = cloneRes.results.find((r) => r.id === 'A1');
  if (a1c && a1c.ok) { pass++; log.push('  ✓ 无清单（刚 clone）⇒ 会话库缺失降级为待办') }
  else { fail++; log.push('  ✗ 无清单（刚 clone）A1 仍报红 ⇒ 新克隆第一条体检就是红的') }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(log.join('\n'));
  console.log(`\n自检：${pass} 通过 · ${fail} 失败`);
  return fail === 0;
}

// ── CLI ─────────────────────────────────────────────────
// ⚠ 只有「直接运行」时才走 CLI：本文件同时被 场景记忆.mjs 当库 import（共用 §〇 判据），
//   被 import 时不能解析 argv / 不能 process.exit。
const __SELF = fileURLToPath(import.meta.url);
const __MAIN = process.argv[1] ? path.resolve(process.argv[1]) : '';
const IS_MAIN = __MAIN && (__MAIN === path.resolve(__SELF));

if (IS_MAIN) {
  const argv = process.argv.slice(2);
  const getArg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d };

  if (argv.includes('--self-test')) {
    const ok = selfTest();
    process.exit(ok ? 0 : 2);
  }

  const root = path.resolve(getArg('--root', DEFAULT_ROOT));
  const { mode, fresh, results } = runAll(root);
  const red = results.filter((r) => !r.ok);
  const todo = results.filter((r) => r.ok && r.findings.length);

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ root, mode, fresh, results, red: red.length, todo: todo.length }, null, 2));
    process.exit(red.length ? 1 : 0);
  }

  console.log(`体检 · ${root}`);
  console.log(`模式：${mode}（${mode === 'instance' ? '有 工作台.json，按实例判' : '无 工作台.json，按模板判'}）${fresh ? ' · 初始化态（未绑会话算待办）' : ''}\n`);
  for (const r of results) {
    const isTodo = r.ok && r.findings.length > 0;
    console.log(`${isTodo ? '⚠' : (r.ok ? '✓' : '✗')} ${r.id} [${r.layer}] ${r.title}`);
    for (const f of r.findings) console.log(`    · ${path.relative(root, f.path) || f.path}：${f.msg}`);
  }
  console.log(`\n汇总：${results.length} 条断言 · ${results.length - red.length} 绿 · ${red.length} 红${todo.length ? ` · ${todo.length} 待办` : ''}`);
  if (todo.length) console.log('待办不是错误：装好之后按提示建会话，然后 node 工具\\实例化.mjs --apply。');
  if (red.length) console.log('提示：体检只报告不修；修完再跑，直到转绿。');
  process.exit(red.length ? 1 : 0);
}
