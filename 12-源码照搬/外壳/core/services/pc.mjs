/**
 * core/services/pc.mjs —— 本地电脑体检（读 pc-scan 产物；必要时提示先扫描）
 *
 * 数据源（按优先级，**不造假数据**）：
 *   1. `外壳/data/pc-scan-latest.json`（P1 契约口径）
 *   2. `外壳/data/pc-cleanup-scan.json`（当前 `外壳/scripts/pc-scan.mjs:33` 实际产物）
 *   3. 都没有 ⇒ `status:"never-scanned"` + 提示跑扫描，**不返回演示/占位数字**
 *
 * 只读，不触发扫描（扫描是 40~60 秒的重操作，不能让一个 status 查询把它带起来）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..', '..', '..');
const DATA = path.join(APP, '外壳', 'data');

export const CANDIDATES = [
  path.join(DATA, 'pc-scan-latest.json'),
  path.join(DATA, 'pc-cleanup-scan.json'),
];

function relFromApp(abs) {
  try { return path.relative(APP, abs).split(path.sep).join('/'); } catch (e) { return String(abs); }
}

function readFirst() {
  for (const p of CANDIDATES) {
    try {
      if (!fs.existsSync(p)) continue;
      const data = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
      return { path: p, data };
    } catch (e) { /* 坏文件跳过，试下一个 */ }
  }
  return null;
}

/** 从扫描产物里抽人类可读的摘要（字段缺失就如实缺） */
export function summarize(data) {
  const d = data && typeof data === 'object' ? data : {};
  const items = Array.isArray(d.items) ? d.items : null;
  const byDrive = d.byDrive && typeof d.byDrive === 'object' ? d.byDrive : null;
  const junk = Array.isArray(d.junk) ? d.junk : null;
  return {
    scannedAt: d.scannedAt || d.ts || null,
    tookSec: d.tookSec == null ? null : d.tookSec,
    partial: !!d.stopped,
    items: items ? items.length : (d.itemsCount == null ? null : d.itemsCount),
    drives: byDrive ? Object.keys(byDrive).length : null,
    junkItems: junk ? junk.length : null,
    junkTotalGb: d.junkTotalGb == null ? null : d.junkTotalGb,
    minGb: d.minGb == null ? null : d.minGb,
  };
}

/**
 * pc.inspect：{ quick? } → { status, source, scannedAt, summary, data? }
 *   quick=true（默认）只回摘要；quick=false 才带回完整 items（可能很大，交给 CMP-01 修剪/落盘）。
 */
export async function inspect(args = {}) {
  const quick = args.quick !== false;
  const hit = readFirst();
  if (!hit) {
    return {
      ok: true,
      status: 'never-scanned',
      source: null,
      scannedAt: null,
      summary: null,
      hint: '还没有 pc 扫描产物。先跑一次：node 外壳\\scripts\\pc-scan.mjs（约 40–60 秒），再查。',
    };
  }
  const summary = summarize(hit.data);
  const out = {
    ok: true,
    status: 'cached',
    source: relFromApp(hit.path),
    scannedAt: summary.scannedAt,
    summary,
    note: '这是最近一次扫描的缓存；要刷新就重跑 外壳\\scripts\\pc-scan.mjs',
  };
  if (!quick) out.data = hit.data;
  return out;
}
