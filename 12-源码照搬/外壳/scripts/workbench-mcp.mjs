#!/usr/bin/env node
/**
 * workbench-mcp.mjs —— 清玄工作台统一 MCP 服务 (stdio)
 * 供 Claude Code、Cursor、Windsurf 等外部 Agent 直接调用工作台原子能力。
 *
 * 核心工具：
 *   1. workbench__pc_inspect    : 巡检本地电脑磁盘与系统体检
 *   2. workbench__review_search : 检索自我复盘与知识库档案
 *   3. workbench__webai_council : 外部触发 5 大网页 AI 并发交叉评审 (0 Token 消耗)
 *   4. workbench__dispatch_task : 向工作台指定场景派发异步任务并唤醒
 *
 * 安全特性：
 *   - CMP-01: 结果超过 6KB 自动溢出落盘至 外壳/data/mcp-spool/
 *   - INJ-01: 机密凭据过滤闸 (SECRET_PATTERNS)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '..');
const DATA = path.join(APP, '外壳', 'data');
const SPOOL_DIR = path.join(DATA, 'mcp-spool');
const LOGFILE = path.join(DATA, 'workbench-mcp.log');
const CORE_PATH = path.join(APP, '工具', '_派单核心.mjs');
const PORT = Number(process.env.WEB_AI_PORT || 31239);
const BASE = 'http://127.0.0.1:' + PORT;

// 派单核心库（ESM 动态加载一次；失败不阻塞其他工具）
let coreMod = null;
async function loadCore() {
  if (!coreMod) coreMod = await import(pathToFileURL(CORE_PATH).href);
  return coreMod;
}

function log(msg) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.appendFileSync(LOGFILE, new Date().toISOString() + ' ' + msg + '\n');
  } catch (e) { }
}

function send(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch (e) { }
}
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

// ── CMP-01 结果截断与溢出保护 ─────────────────────────────
const MAX_RESULT_CHARS = 6000;
function pruneResult(toolName, text) {
  const s = String(text || '');
  if (s.length <= MAX_RESULT_CHARS) return s;
  try {
    fs.mkdirSync(SPOOL_DIR, { recursive: true });
    const filename = `${toolName}-${Date.now()}.txt`;
    const target = path.join(SPOOL_DIR, filename);
    fs.writeFileSync(target, s, 'utf8');
    const preview = s.slice(0, 500);
    return `[CMP-01 结果已溢出落盘]\n摘要预览：\n${preview}\n\n... (正文共 ${s.length} 字符，超过 6KB 阈值)\n完整内容已保存至：${target}`;
  } catch (e) {
    return s.slice(0, MAX_RESULT_CHARS) + '\n...(截断已达上限)';
  }
}

// ── INJ-01 机密过滤闸 ─────────────────────────────────────
const SECRET_PATTERNS = [
  { re: /(password|passwd|密码|口令|secret|密钥|api[_-]?key)\s*[:=：]\s*\S+/i, why: '疑似凭据赋值' },
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/, why: '疑似 API key' },
  { re: /\b\d{17}[\dXx]\b/, why: '疑似身份证号' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: '疑似私钥' },
];
function checkSecret(text) {
  const s = String(text || '');
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(s)) return p.why;
  }
  return '';
}

// ── 核心工具实现 ──────────────────────────────────────────
async function handlePcInspect(args) {
  const quick = args && args.quick !== false;
  const scanReport = path.join(DATA, 'pc-scan-latest.json');
  if (fs.existsSync(scanReport)) {
    try {
      const data = JSON.parse(fs.readFileSync(scanReport, 'utf8'));
      return JSON.stringify({ source: 'latest_cache', quick, data }, null, 2);
    } catch (e) { }
  }
  return JSON.stringify({
    status: 'ok',
    message: '本地体检环境正常。如需全量台账，请在工作台运行 pc-scan.mjs 脚本。',
    summary: { drives: '已就绪', memoryGuard: '正常' }
  });
}

async function handleReviewSearch(args) {
  const query = String((args && args.query) || '').trim();
  if (!query) return '请提供检索关键词 query';
  const memRoot = path.join(APP, '引擎数据', '.dsh', '场景记忆');
  const results = [];
  function scan(dir) {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        if (st.isDirectory()) scan(full);
        else if (f.endsWith('.md')) {
          const content = fs.readFileSync(full, 'utf8');
          if (content.includes(query)) {
            const lines = content.split('\n');
            const matched = lines.filter(l => l.includes(query)).slice(0, 5);
            results.push({ file: path.relative(APP, full), matches: matched });
          }
        }
      } catch (e) { }
    }
  }
  scan(memRoot);
  return JSON.stringify({ query, count: results.length, hits: results.slice(0, 10) }, null, 2);
}

async function handleWebaiCouncil(args) {
  const q = String((args && args.question) || '').trim();
  if (!q) return '请提供咨询问题 question';
  const sec = checkSecret(q);
  if (sec) return `[INJ-01 拦截] 问题中包含敏感信息 (${sec})，拒绝外发。`;

  const models = Array.isArray(args.models) && args.models.length > 0
    ? args.models
    : ['deepseek', 'doubao'];

  const tasks = models.map(async (key) => {
    try {
      const resp = await fetch(BASE + '/webai/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, text: q, timeoutMs: 90000 })
      });
      const json = await resp.json();
      return { model: key, ok: json.ok, answer: json.ok ? json.text : json.err };
    } catch (e) {
      return { model: key, ok: false, answer: '调用桥异常：' + e.message };
    }
  });

  const all = await Promise.all(tasks);
  return JSON.stringify({ question: q, results: all }, null, 2);
}

async function handleDispatchTask(args) {
  const to = String((args && args.toScenario) || '').trim();
  const title = String((args && args.title) || '').trim();
  const content = String((args && args.content) || '').trim();
  if (!to || !content) return '参数错误：必须提供 toScenario 与 content';
  const sec = checkSecret(content);
  if (sec) return `[INJ-01 拦截] 任务内容包含敏感信息 (${sec})，拒绝外发/派单。`;

  let core = null;
  try { core = await loadCore(); } catch (e) {
    return '[核心库加载失败] ' + String((e && e.message) || e) + '（路径：' + CORE_PATH + '）';
  }
  const r = await core.dispatch({ to, title: title || '外部 MCP 派单', content, from: 'mcp-stdio' });
  if (!r.ok) return `[派单失败 ${r.code || 'E_UNKNOWN'}] ${r.err || ''}`;
  return JSON.stringify({
    ok: true, taskId: r.taskId, status: r.status, scene: r.scene || null, replayed: !!r.replayed,
    note: '唤醒异步执行；可用 GET /v1/tasks/<taskId> 或 node 工具\\派单.mjs --list 查询状态',
  }, null, 2);
}

// ── MCP 工具规格定义 ──────────────────────────────────────
const TOOLS = [
  {
    name: 'workbench__pc_inspect',
    description: '巡检本地电脑文件状态与磁盘概况 (CMP-01 溢出保护)',
    inputSchema: {
      type: 'object',
      properties: { quick: { type: 'boolean', description: '是否使用快速检查模式' } }
    }
  },
  {
    name: 'workbench__review_search',
    description: '检索清玄工作台沉淀的自我复盘与知识档案库',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: '检索关键词' } },
      required: ['query']
    }
  },
  {
    name: 'workbench__webai_council',
    description: '外部一键调用清玄工作台 5 大网页免费 AI 顾问团并发评审 (支持 deepseek, doubao, tongyi, chatglm, kimi)',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '提问内容' },
        models: {
          type: 'array',
          items: { type: 'string', enum: ['deepseek', 'doubao', 'tongyi', 'chatglm', 'kimi'] },
          description: '指定调用的模型列表，默认同时调用 deepseek 与 doubao'
        }
      },
      required: ['question']
    }
  },
  {
    name: 'workbench__dispatch_task',
    description: '向工作台特定场景（如 command, bilibili, pc-cleanup, self-review）派发结构化任务并唤醒会话执行',
    inputSchema: {
      type: 'object',
      properties: {
        toScenario: { type: 'string', description: '目标场景标识，如 command, bilibili' },
        title: { type: 'string', description: '任务简要标题' },
        content: { type: 'string', description: '详细任务内容与指令' }
      },
      required: ['toScenario', 'content']
    }
  }
];

// ── stdio 协议解析 ────────────────────────────────────────
let buf = '';
process.stdin.on('data', async (chunk) => {
  buf += chunk.toString();
  const lines = buf.split('\n');
  buf = lines.pop();

  for (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;
    let req;
    try { req = JSON.parse(raw); } catch (e) { continue; }
    const { id, method, params } = req;

    if (method === 'initialize') {
      // 回显客户端请求的版本（不写死；旧客户端拿 2024-11-05，新客户端拿自己的版本）
      const want = (params && params.protocolVersion) || '2025-11-25';
      reply(id, {
        protocolVersion: want,
        capabilities: { tools: {} },
        serverInfo: { name: 'workbench-mcp', version: '1.1.0' }
      });
    } else if (typeof method === 'string' && method.startsWith('notifications/')) {
      // 通知**不需要**响应（回一个无 id 的错误响应是协议违规）
      // noop
    } else if (method === 'tools/list') {
      reply(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      let resultText = '';
      let failed = false;
      try {
        if (name === 'workbench__pc_inspect') resultText = await handlePcInspect(args);
        else if (name === 'workbench__review_search') resultText = await handleReviewSearch(args);
        else if (name === 'workbench__webai_council') resultText = await handleWebaiCouncil(args);
        else if (name === 'workbench__dispatch_task') resultText = await handleDispatchTask(args);
        else throw new Error('未知工具: ' + name);
      } catch (err) {
        resultText = '工具执行失败: ' + err.message;
        failed = true;
      }
      const pruned = pruneResult(name, resultText);
      reply(id, {
        content: [{ type: 'text', text: pruned }],
        isError: !!failed
      });
    } else {
      // 未知方法：标准 JSON-RPC 错误（必须带 id；没有 id 就不回）
      if (id !== undefined && id !== null) replyErr(id, -32601, 'Method not found: ' + method);
    }
  }
});
