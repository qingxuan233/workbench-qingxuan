/**
 * core/services/bilibili.mjs —— B站场景能力（读「当前视频」产物；不联网、不点网页）
 *
 * 为什么要它：5 大场景里只有 B站 没有工具面（报告 §2.1 点名 `workbench__bilibili_extract`）。
 * 但 B站的抓取（音频/字幕/转录）是**网页里的人工动作**，不是本层能凭空做的 ——
 * 硬做联网抓取会把"0 Token 免费"变成"另写一套爬虫"，风险与收益不成比例。
 *
 * 所以这里做**只读的产物出口**（与 `pc.inspect` 同构）：
 *   数据源 = `引擎数据/.dsh/场景记忆/B站/当前视频.json`
 *   —— 由渲染层 `renderer/panels/embed-utils.js` 的 startBiliTrack() 在 B站 embed 面板里
 *      每 1.5 秒比对 URL 后写入（字段：bv / url / title / at）。
 *
 * 口径（不造假）：
 *   - 文件没有 ⇒ `status:"never-synced"` + 提示"先去 B站面板打开一个视频"
 *   - 文件有但 `bv=null`（主页/搜索页）⇒ `status:"not-a-video"`，照样把 url/title/at 如实返回
 *   - 文件有且 `bv` 有值 ⇒ `status:"ok"`
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.DSH_WORKBENCH_ROOT || path.resolve(HERE, '..', '..', '..');
const MEM = process.env.DSH_SCENE_MEMORY || path.join(APP, '引擎数据', '.dsh', '场景记忆');

export const SOURCE = path.join(MEM, 'B站', '当前视频.json');

function relFromApp(abs) {
  try { return path.relative(APP, abs).split(path.sep).join('/'); } catch (e) { return String(abs); }
}

/** 纯函数：把产物 JSON 归一成对外形状（缺字段如实 null，不补假值） */
export function normalize(raw) {
  const d = (raw && typeof raw === 'object') ? raw : {};
  const bv = d.bv == null ? null : String(d.bv).trim() || null;
  const url = d.url == null ? null : String(d.url);
  const title = d.title == null ? null : String(d.title);
  const syncedAt = d.at == null ? null : String(d.at);
  const isVideo = !!(bv && (/^BV[0-9A-Za-z]{8,}$/.test(bv) || /[?&]bvid=/.test(String(url || ''))));
  return { bv, url, title, syncedAt, isVideo };
}

/**
 * bilibili.extract：{ quick? } → { status, source, bv, url, title, syncedAt, isVideo, hint? }
 *   quick=true（默认）不读场景记忆；false 时额外带一句该场景记忆的最近更新时间（只读、不解析内容）。
 */
export async function extract(args = {}) {
  let raw = null;
  try {
    if (fs.existsSync(SOURCE)) raw = JSON.parse(fs.readFileSync(SOURCE, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) { raw = null; }

  if (!raw) {
    return {
      ok: true,
      status: 'never-synced',
      source: relFromApp(SOURCE),
      bv: null, url: null, title: null, syncedAt: null, isVideo: false,
      hint: '还没有 B站「当前视频」产物。先在工作台的 B站场景打开一个视频（网页面板会每 1.5 秒把 bv/url/title 写回这个文件），再调用。',
    };
  }

  const n = normalize(raw);
  const status = n.bv ? (n.isVideo ? 'ok' : 'unrecognized-bv') : 'not-a-video';
  const out = {
    ok: true,
    status,
    source: relFromApp(SOURCE),
    ...n,
    note: n.bv
      ? '这是 B站面板最后一次同步到的视频；要最新就回面板翻一下页面再调用。'
      : '当前同步到的是 B站首页/搜索页（bv 为空），不是某条视频。去打开一个视频再来。',
  };
  if (args.quick === false) {
    const mem = path.join(MEM, 'B站', '场景私有记忆.md');
    try {
      out.memoryMtime = fs.existsSync(mem) ? fs.statSync(mem).mtime.toISOString() : null;
    } catch (e) { out.memoryMtime = null; }
  }
  return out;
}
