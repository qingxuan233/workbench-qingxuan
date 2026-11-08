/**
 * core/services/review.mjs —— 复盘库检索（只读）
 *
 * 数据根：`自我复盘/`（汇报/复盘模板与历史档案；只读，不写）。
 * 这是第 9 个能力 `review.search` 的实现，也是旧 MCP 工具 `workbench__review_search`
 * 的别名目标（别名只在 face 层做，core 不注册别名）。
 */

import path from 'node:path';
import { APP, searchText } from '../lib/text-search.mjs';

export function reviewRoot() {
  return path.join(APP, '自我复盘');
}

/**
 * review.search：{ query, limit? } → { query, count, hits:[{file,matches}], root }
 */
export async function search(args = {}) {
  const query = String(args.query == null ? '' : args.query).trim();
  if (!query) return { ok: false, code: 'E_VALIDATE', err: '缺少 query（要检索的关键词）' };
  const limit = Number(args.limit) || 10;
  const r = searchText(reviewRoot(), query, { limit });
  return {
    ok: true,
    query: r.query,
    count: r.count,
    scanned: r.scanned,
    limited: r.limited,
    hits: r.hits,
    root: '自我复盘',
  };
}
