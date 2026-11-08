/**
 * core/registry.mjs —— 能力注册表（唯一实现）
 *
 * 描述符（schema 即真源）：
 *   { name, version, title, inputSchema, outputSchema, authz, effects, middleware, timeoutMs, run }
 *
 * 说明：
 *   - 能力名固定见 P1 接口契约 §二；旧 workbench__* 名字**不在这里**（只在 face 层做别名，
 *     face 可用 index.mjs 导出的 ALIASES / resolveName）。
 *   - middleware 字段引用 middleware.mjs 的 PIPELINE（顺序固定，能力不允许自己重排）。
 */

import { PIPELINE } from './middleware.mjs';

const REQUIRED = ['name', 'title', 'inputSchema', 'outputSchema', 'run'];

const MAP = new Map();

/** 注册一个能力；重复注册同名直接抛错（防止两个模块偷偷覆盖同一能力） */
export function define(desc) {
  if (!desc || typeof desc !== 'object') throw new Error('能力描述符必须是对象');
  for (const k of REQUIRED) {
    if (desc[k] == null) throw new Error('能力缺少字段 ' + k + '：' + (desc.name || '?'));
  }
  const name = String(desc.name);
  if (!/^[a-z][a-z0-9._-]*$/.test(name)) throw new Error('能力名形态非法（小写字母/数字/._-）：' + name);
  if (MAP.has(name)) throw new Error('能力重复注册：' + name);
  const cap = {
    name,
    version: String(desc.version || '1.0.0'),
    title: String(desc.title),
    description: String(desc.description || desc.title || ''),
    inputSchema: desc.inputSchema || { type: 'object' },
    outputSchema: desc.outputSchema || { type: 'object' },
    authz: desc.authz || { open: false, scopes: [] },
    effects: String(desc.effects || 'none'),
    middleware: Array.isArray(desc.middleware) ? desc.middleware.slice() : PIPELINE.slice(),
    timeoutMs: Number(desc.timeoutMs) > 0 ? Number(desc.timeoutMs) : 30000,
    rateLimitMax: Number(desc.rateLimitMax) > 0 ? Number(desc.rateLimitMax) : null,
    run: desc.run,
  };
  MAP.set(name, Object.freeze(cap));
  return cap;
}

/** 取一个能力（未注册返回 null） */
export function get(name) {
  return MAP.get(String(name || '')) || null;
}

export function has(name) {
  return MAP.has(String(name || ''));
}

/** 能力清单（供 list()/tools/list 用；去掉不可序列化的 run） */
export function list() {
  const out = [];
  for (const cap of MAP.values()) {
    out.push({
      name: cap.name,
      version: cap.version,
      title: cap.title,
      description: cap.description,
      inputSchema: cap.inputSchema,
      outputSchema: cap.outputSchema,
      authz: cap.authz,
      effects: cap.effects,
      middleware: cap.middleware,
      timeoutMs: cap.timeoutMs,
    });
  }
  return out;
}

/** 能力名数组（排好序，便于日志/文档） */
export function names() {
  return [...MAP.keys()].sort();
}

/** 单个能力的公开描述符（未注册返回 null；不含 run） */
export function describe(name) {
  const cap = MAP.get(String(name || ''));
  if (!cap) return null;
  const out = {};
  for (const k of Object.keys(cap)) if (k !== 'run') out[k] = cap[k];
  return out;
}

/** 仅供测试/卸载：清空注册表（正常进程不用） */
export function resetRegistry() {
  MAP.clear();
}
