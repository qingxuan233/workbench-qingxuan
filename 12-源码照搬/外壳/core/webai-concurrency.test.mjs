#!/usr/bin/env node
/**
 * webai-concurrency.test.mjs —— 网页版 AI「顾问团」并发性的**可重复实测**（不依赖登录态）
 *
 * 为什么用 mock 桥：真实 5 站并发生成需要各站登录态，登录与否不可控、单次 30~150 秒；
 * 但"并发性"本身是**代码属性** —— 只要 mock 桥记录"同时在飞的请求数"，就能确定地测出来：
 *   · 顾问团对**不同站点**是并行派发的（2 站总耗时应 ≈ 单站耗时，而不是相加）
 *   · 单站失败不影响其他站（一个 500 不能让整次调用失败）
 * ⚠ 真实站点的并行（以及"同站串行、不串话"）仍需登录态才能验；报告 §7.6 保留了该前提。
 *
 * 用法：node 外壳\core\webai-concurrency.test.mjs      （0=通过 1=失败）
 * 挂钩：`工具/验收.mjs` 第 2 步（自检）的子检查。
 */

import http from 'node:http';
import * as core from './index.mjs';

const DELAY_MS = 600;          // 单站"生成"耗时（mock）
const answered = [];           // 记录每个请求的 key，用于验证无串话
let inFlight = 0;
let maxInFlight = 0;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/webai/keys') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [{ key: 'alpha' }, { key: 'beta' }, { key: 'gamma' }] }));
    return;
  }
  if (req.method === 'POST' && req.url === '/webai/ask') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let key = '';
      try { key = String(JSON.parse(body).key || ''); } catch (e) { key = ''; }
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      answered.push(key);
      setTimeout(() => {
        inFlight -= 1;
        if (key === 'gamma') {                    // 故意失败的站点：验证"单站失败不拖累别人"
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('boom');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, text: 'answer-' + key }));
      }, DELAY_MS);
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('nf');
});

let failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { console.log('✓ ' + name); return; }
  failed += 1;
  console.log('✗ ' + name + (detail ? ' ← ' + detail : ''));
};

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
process.env.WEB_AI_PORT = String(port);       // 能力层按这个端口找"桥"（读时取，不是加载时）

const ctx = core.makeCtx('cli', { agent: 'concurrency', rateLimit: false });

// ── 1. 两站并行：总耗时应 ≈ 单站耗时 ─────────────────────────────
const t0 = Date.now();
const r = await core.call('webai.council', { question: '并发自检', sites: ['alpha', 'beta'], timeoutMs: 8000 }, ctx);
const ms1 = Date.now() - t0;
ok('顾问团调用成功', r.ok === true, JSON.stringify({ code: r.code, err: r.err }));
ok('两站都成功', r.okCount === 2, JSON.stringify({ okCount: r.okCount, failedCount: r.failedCount }));
ok('两站确实同时在飞（mock 记录并发峰值=2）', maxInFlight === 2, 'maxInFlight=' + maxInFlight);
ok('总耗时 ≈ 单站耗时（并行，不是相加）', ms1 < DELAY_MS * 1.6, ms1 + 'ms vs 单站 ' + DELAY_MS + 'ms（相加会 ≥' + DELAY_MS * 2 + 'ms）');
ok('无串话（每站只拿到自己的答案）',
  String(r.results.alpha.text) === 'answer-alpha' && String(r.results.beta.text) === 'answer-beta',
  JSON.stringify({ alpha: r.results.alpha && r.results.alpha.text, beta: r.results.beta && r.results.beta.text }));

// ── 2. 单站失败不影响其他站 ─────────────────────────────────────
maxInFlight = 0;
const r2 = await core.call('webai.council', { question: '失败隔离', sites: ['alpha', 'gamma'], timeoutMs: 8000 }, ctx);
ok('一好一坏时整体仍成功', r2.ok === true && r2.okCount === 1 && r2.failedCount === 1, JSON.stringify({ ok: r2.ok, okCount: r2.okCount, failedCount: r2.failedCount }));
ok('坏站点带错误信息而不是静默', !!(r2.results.gamma && r2.results.gamma.ok === false && r2.results.gamma.err), JSON.stringify(r2.results.gamma));

await new Promise((r3) => server.close(r3));

if (failed) {
  console.log(`\n✗ WebAI 并发：${failed} 项失败`);
  process.exit(1);
}
console.log('\n✓ WebAI 并发自检通过（两站并行 ' + ms1 + 'ms · 单站失败隔离 · 无串话）');
process.exit(0);
