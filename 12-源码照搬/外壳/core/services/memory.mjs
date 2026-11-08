/**
 * core/services/memory.mjs —— 场景记忆检索（只读人写区）
 *
 * 数据根：`引擎数据/.dsh/场景记忆/`（与体检 A1/A9、派单核心同一口径）。
 * 硬约束（ADR-10）：本服务**只读不写**，绝不 append/覆盖人写区文件。
 */

import path from 'node:path';
import { APP, searchText } from '../lib/text-search.mjs';

export function memoryRoot() {
  return process.env.DSH_SCENE_MEMORY || path.join(APP, '引擎数据', '.dsh', '场景记忆');
}

/**
 * memory.search：{ query, limit? } → { query, count, hits:[{file,matches}], root }
 * 检索范围 = 整个场景记忆根（含 _共享记忆 / 各场景 §〇 / 身份卡 / 场景画像）。
 */
export async function search(args = {}) {
  const query = String(args.query == null ? '' : args.query).trim();
  if (!query) return { ok: false, code: 'E_VALIDATE', err: '缺少 query（要检索的关键词）' };
  const limit = Number(args.limit) || 10;
  const r = searchText(memoryRoot(), query, { limit });
  return {
    ok: true,
    query: r.query,
    count: r.count,
    scanned: r.scanned,
    limited: r.limited,
    hits: r.hits,
    root: '引擎数据/.dsh/场景记忆',
  };
}
