#!/usr/bin/env node
/**
 * workbench-mcp.mjs —— MCP stdio face（薄传输层）
 *
 * 协议语义与工具表都在 `mcp-rpc.mjs`（stdio 与 Streamable HTTP 共用一份）；
 * 业务在 `外壳/core/index.mjs`（能力层）。本文件只做：按行读 JSON-RPC → 写响应。
 *
 * 用法（外部客户端配置）：
 *   { "mcpServers": { "workbench": { "command": "node", "args": ["<APP>/外壳/scripts/workbench-mcp.mjs"] } } }
 *
 * 启动前提：工作台 GUI 开着（网页 AI 顾问团与派单唤醒需要引擎/桥在线）；只读能力（记忆/复盘/体检缓存）不需要。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatch, info } from './mcp-rpc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '..');
const DATA = path.join(APP, '外壳', 'data');
const LOGFILE = path.join(DATA, 'workbench-mcp.log');

function log(msg) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.appendFileSync(LOGFILE, new Date().toISOString() + ' ' + msg + '\n');
  } catch (e) { /* 日志失败不影响协议 */ }
}

function write(obj) {
  if (!obj) return;   // 通知：不写任何东西
  try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch (e) { /* 管道已关 */ }
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;
    let msg = null;
    try { msg = JSON.parse(raw); } catch (e) {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    dispatch(msg, { face: 'mcp-stdio', agent: 'mcp-client' })
      .then((resp) => write(resp))
      .catch((e) => {
        log('dispatch 异常 ' + String((e && e.message) || e));
        write({ jsonrpc: '2.0', id: (msg && msg.id) || null, error: { code: -32603, message: 'Internal error' } });
      });
  }
});

process.stdin.on('end', () => { try { process.exit(0); } catch (e) { } });

log('stdio face 启动：' + JSON.stringify(info()));
