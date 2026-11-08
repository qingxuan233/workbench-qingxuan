/**
 * core/lib/text-search.mjs —— 只读文本检索（memory.search / review.search 共用一份）
 *
 * 设计：只读、不写、不缓存；按目录递归扫 .md（可配置扩展名），逐文件做**字面量**匹配
 * （不做正则，避免外部 query 变成 ReDoS；也避免大小写歧义）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..', '..', '..');

const MAX_FILE_BYTES = 2 * 1024 * 1024;   // 单文件上限 2MB（超过跳过，只读场景不追大文件）
const DEFAULT_EXTS = ['.md', '.txt'];
const DEFAULT_LIMIT = 10;
const DEFAULT_MAX_MATCHES = 5;

function relFromApp(abs) {
  try { return path.relative(APP, abs).split(path.sep).join('/'); } catch (e) { return String(abs); }
}

function walk(root, exts, out, depth = 0) {
  if (depth > 8) return;
  let ents = [];
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith('.')) continue;      // .git 之类
      walk(full, exts, out, depth + 1);
    } else if (exts.includes(path.extname(e.name).toLowerCase())) {
      out.push(full);
    }
  }
}

/**
 * 在 root 下检索 query（字面量，大小写不敏感）。
 * 返回 { query, scanned, count, hits:[{file, matches:[行文本]}] }
 */
export function searchText(root, query, opts = {}) {
  const q = String(query == null ? '' : query).trim();
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || DEFAULT_LIMIT));
  const maxMatches = Math.max(1, Math.min(20, Number(opts.maxMatches) || DEFAULT_MAX_MATCHES));
  const exts = Array.isArray(opts.exts) && opts.exts.length ? opts.exts : DEFAULT_EXTS;
  const lower = q.toLowerCase();
  const files = [];
  walk(root, exts, files);
  const hits = [];
  let scanned = 0;

  for (const abs of files) {
    let st = null;
    try { st = fs.statSync(abs); } catch (e) { continue; }
    if (!st.isFile() || st.size > MAX_FILE_BYTES || st.size === 0) continue;
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { continue; }
    scanned += 1;
    if (!text.toLowerCase().includes(lower)) continue;
    const matches = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.toLowerCase().includes(lower)) continue;
      const t = line.trim();
      if (!t) continue;
      matches.push(t.length > 200 ? t.slice(0, 200) + '…' : t);
      if (matches.length >= maxMatches) break;
    }
    hits.push({ file: relFromApp(abs), matches });
    if (hits.length >= limit) break;
  }

  return { query: q, scanned, count: hits.length, hits, limited: hits.length >= limit };
}
