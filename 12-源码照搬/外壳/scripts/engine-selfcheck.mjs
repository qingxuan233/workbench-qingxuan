#!/usr/bin/env node
/**
 * engine-selfcheck.mjs —— DSH 引擎运行时契约自检（2026-11-08 · P2-B）
 * 起 Electron 隐藏窗口加载引擎 UI → 注入 chatCss()+fixJs()（adapter 未就绪时用 main.js 字面量）→
 * 断言契约 §五 的选择器命中数。三态：
 *   exit 0 = VERIFIED（可达 + 注入成功 + 命中数达标）
 *   exit 3 = SKIPPED（不可达 / 无有效 token / 无 Electron / 探针异常）⇒ 打印「未验证」，禁止假装通过
 *   exit 1 = FAILED（注入成功但某选择器不足）⇒ 打印「期望 vs 实际」差异集合
 * 用法：node 外壳\scripts\engine-selfcheck.mjs [--json] [--timeout=20] [--port=3084] [--selftest] [--force-fallback]
 * ⚠ 只检测、**不拉起引擎**（自己拉会抢用户的 3083/搞乱在用窗口）：引擎没跑就 exit 3。
 * ⚠ token 顺序：data/harness-endpoint.json（先校验 pid 存活 + 端口可连）→ server.log 正则 → DSH_TOKEN。
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL = path.resolve(HERE, '..');
const APP = path.resolve(SHELL, '..');
const DATA = path.join(SHELL, 'data');
const ENDPOINT = path.join(DATA, 'harness-endpoint.json');
const SERVER_LOG = path.join(DATA, 'server.log');
const WORKBENCH_JSON = path.join(APP, '工作台.json');
const CONTRACT = path.join(SHELL, 'engine-adapter', 'contract.js');
const requireCjs = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TEXT_JSON = process.argv.includes('--json');
const SELFTEST = process.argv.includes('--selftest'), FORCE_FALLBACK = process.argv.includes('--force-fallback');
const TIMEOUT_S = Math.max(8, Number((process.argv.find((a) => a.startsWith('--timeout=')) || '--timeout=20').split('=')[1] || 20));
const PORT_ARG = Number((process.argv.find((a) => a.startsWith('--port=')) || '').split('=')[1] || 0);
const log = (s) => { if (!TEXT_JSON) console.log(s); };
const MIN = (id, label, expect, key) => ({ id, label, kind: 'min', expect, pick: (m) => m[key] });
const EXPECTED = [
  MIN('chatFlow', '[data-chat-flow]', 1, 'chatFlow'), MIN('phase', '[data-phase]', 1, 'phase'),
  MIN('widthHandle', '[data-width-handle]', 1, 'widthHandle'),
  { id: 'composer', label: '[data-composer-card] 或 [data-composer-input]', kind: 'anyMin', expect: 1, pick: (m) => [m.composerCard, m.composerInput] },
  { id: 'centerCol', label: '[class*="centerCol"]', kind: 'eq', expect: 1, pick: (m) => m.centerCol },
  { id: 'dataSide', label: '宽度手柄的 data-side 取值', kind: 'subset', allowed: ['left', 'right'], pick: (m) => m.widthHandleSides || [] }
]; 
const readText = (p) => { try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch (e) { return ''; } };
function tcpAlive(port, ms = 1200) {
  return new Promise((resolve) => {
    if (!port || port <= 0) return resolve(false);
    const sock = net.connect({ host: '127.0.0.1', port }); let done = false;
    const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (e) { /* ignore */ } resolve(v); };
    sock.setTimeout(ms);
    sock.once('connect', () => fin(true)); sock.once('timeout', () => fin(false)); sock.once('error', () => fin(false));
  });
}
function httpProbe(url, ms = 2500) {
  return new Promise((resolve) => {
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    let req = null;
    try { req = http.get(url, (res) => { let body = ''; res.on('data', (d) => { body += d; if (body.length > 4096) body = body.slice(0, 4096); }); res.on('end', () => fin({ status: res.statusCode, ok: [200, 302, 303, 307].includes(res.statusCode), body })); }); } catch (e) { return fin({ ok: false, error: String(e && e.message || e) }); }
    req.on('error', (e) => fin({ ok: false, error: String(e && e.message || e) }));
    req.setTimeout(ms, () => { try { req.destroy(); } catch (e) { /* ignore */ } fin({ ok: false, timeout: true }); });
  });
}
// ---------- token：endpoint（pid 存活 + 端口可连）→ server.log → DSH_TOKEN ----------
async function engineProbe() {
  const notes = [], cands = [];
  const end = { reachable: false, token: '', tokenSource: 'none', base: '', port: 0, authProblem: false };
  let ep = null;
  try { ep = JSON.parse(readText(ENDPOINT) || 'null'); } catch (e) { notes.push('harness-endpoint.json 不是合法 JSON（按缺失处理）'); }
  if (ep && ep.token) {
    const pid = Number(ep.pid || 0), port = Number(ep.port || 0);
    let pidOk = false;
    try { if (pid > 0) { process.kill(pid, 0); pidOk = true; } } catch (e) { pidOk = false; }
    if (!pidOk) notes.push('harness-endpoint.json 是**死 pid 残留**（pid=' + pid + ' 不存活）⇒ 不采用其 token');
    else if (!(await tcpAlive(port))) notes.push('harness-endpoint.json 端口 ' + port + ' 不可连（死残留）⇒ 不采用其 token');
    else cands.push({ token: String(ep.token), source: 'harness-endpoint.json', port, base: String(ep.baseUrl || ('http://127.0.0.1:' + port)) });
  } else if (ep) notes.push('harness-endpoint.json 存在但没有 token 字段');
  const hist = readText(SERVER_LOG);
  if (!cands.length && hist) {
    const m = [...hist.matchAll(/token=([A-Za-z0-9_\-]+)/g)].pop();
    const p = [...hist.matchAll(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=/g)].pop();
    if (m) cands.push({ token: m[1], source: 'server.log', port: Number(p && p[1] || 0), base: '' });
  } else if (!cands.length) notes.push('server.log 不存在或没抓到 token（日志轮转/非本壳拉起都会这样）');
  if (!cands.length && process.env.DSH_TOKEN) cands.push({ token: String(process.env.DSH_TOKEN), source: 'DSH_TOKEN', port: Number(process.env.DSH_PORT || 0), base: '' });
  const ports = [PORT_ARG, Number(process.env.DSH_PORT || 0), ...cands.map((c) => c.port), (() => { try { return Number(JSON.parse(readText(WORKBENCH_JSON)).dshPort || 0); } catch (e) { return 0; } })(), 3083].filter((p) => p > 0);
  for (const p of ports) { if (await tcpAlive(p)) { end.reachable = true; end.port = p; end.base = 'http://127.0.0.1:' + p; break; } }
  if (!end.reachable) { notes.push('端口全部不可达：' + [...new Set(ports)].join('/')); return { ...end, notes }; }
  for (const c of cands) {
    const base = c.base || ('http://127.0.0.1:' + (c.port || end.port));
    const hp = await httpProbe(base + '/?token=' + encodeURIComponent(c.token));
    const auth = hp.ok && !/authentication required|未授权|unauthor/i.test(hp.body || '');
    if (auth) { end.token = c.token; end.tokenSource = c.source; end.base = base; return { ...end, notes }; }
    notes.push(c.source + ' 的 token 探活未通过（状态 ' + (hp.status || hp.error || '?') + '）⇒ 换下一个来源');
  }
  end.authProblem = true;
  notes.push('引擎端口在跑，但三个来源都拿不到有效 token');
  return { ...end, notes };
}
// ---------- 注入内容：adapter（已收口部分优先）→ main.js/renderers.js 字面量降级 ----------
function pickTemplate(src, name) {
  const i = src.search(new RegExp('(?:const|var|let) ' + name + ' = `'));
  if (i < 0) return null;
  let out = '';
  for (let p = src.indexOf('`', i) + 1; p < src.length; p++) {
    const ch = src[p];
    if (ch === '\\') { out += ch + (src[p + 1] || ''); p++; continue; }
    if (ch === '`') return out;
    out += ch;
  }
  return null;
}
function pickArrayJoin(src, name) {
  const i = src.search(new RegExp('(?:const|var|let) ' + name + ' = \\['));
  if (i < 0) return null;
  const keyLen = src.slice(i).indexOf('[') + 1, end = src.indexOf('].join(', i);
  return end < 0 ? null : src.slice(i + keyLen, end);
}
function pickString(src, name) {
  const m = src.match(new RegExp('(?:const|var|let) ' + name + " = '([^']*)'"));
  return m ? m[1] : null;
}
function evalArray(src, name, deps) {
  const body = pickArrayJoin(src, name);
  if (body == null) return null;
  const keys = Object.keys(deps);
  return new Function(...keys, 'return [' + body + '].join("\\n");')(...keys.map((k) => deps[k]));
}
function fallbackInjection(A) {
  const main = readText(path.join(SHELL, 'main.js')), rend = readText(path.join(SHELL, 'renderer', 'renderers.js'));
  const src = /(?:const|var|let) HARNESS_FIX_JS = `/.test(main) ? main : rend;
  const COL = (A && A.WIDE_COL) || pickString(src, 'HARNESS_WIDE_COL'), CARD = (A && A.WIDE_CARD) || pickString(src, 'HARNESS_WIDE_CARD');
  const wideCss = (A && typeof A.wideCss === 'function') ? A.wideCss() : evalArray(src, 'HARNESS_WIDE_CSS', { HARNESS_WIDE_COL: COL, HARNESS_WIDE_CARD: CARD });
  const pinRaw = pickTemplate(src, 'HARNESS_WIDE_PIN_JS'), chatBody = pickArrayJoin(src, 'HARNESS_CHAT_CSS'), fixRaw = pickTemplate(src, 'HARNESS_FIX_JS');
  if (COL == null || CARD == null || !wideCss || pinRaw == null || chatBody == null || fixRaw == null) throw new Error('注入字面量取不全：' + JSON.stringify({ COL: COL != null, CARD: CARD != null, wideCss: !!wideCss, pin: pinRaw != null, chat: chatBody != null, fix: fixRaw != null }) + '（来源 ' + (src === main ? 'main.js' : 'renderers.js') + '）');
  const pinJs = new Function('HARNESS_WIDE_COL', 'HARNESS_WIDE_CARD', 'return `' + pinRaw + '`;')(COL, CARD);
  // ⚠ 忠实复现当前源码语义：main.js 的 HARNESS_WIDE_CSS 可能是 adapter.wideCss() 的**数组**，
  //   数组塞进数组再 join('\n') 会逗号串联（P2 第二批收口前的已知差异，见实施报告"遗留风险"）。
  const chatCss = new Function('HARNESS_WIDE_CSS', 'return [' + chatBody + '].join("\\n");')(wideCss);
  return { adapter: 'fallback', css: chatCss, fix: new Function('HARNESS_WIDE_PIN_JS', 'return `' + fixRaw + '`;')(pinJs), notes: ['降级字面量来源：' + (src === main ? 'main.js' : 'renderers.js') + (A ? '（adapter 仅部分就绪 VERSION=' + (A.VERSION || '?') + '）' : '（adapter 不存在）')] };
}
function loadInjection() {
  let A = null;
  if (fs.existsSync(CONTRACT)) { try { A = requireCjs(CONTRACT); } catch (e) { A = null; } }
  if (!FORCE_FALLBACK && A && typeof A.chatCss === 'function' && typeof A.fixJs === 'function') {
    try {
      const css = (A.chatCss() || []).join('\n'), fix = A.fixJs({});
      if (!css || !fix) throw new Error('chatCss()/fixJs() 返回空');
      new Function(fix);
      return { adapter: 'contract', css, fix, notes: ['adapter 已就绪：' + CONTRACT + '（VERSION=' + (A.VERSION || '?') + '）'] };
    } catch (e) { /* 落到降级 */ }
  }
  const fb = fallbackInjection(A);
  if (FORCE_FALLBACK) fb.notes.push('按 --force-fallback 强制走降级路径（用于验证 adapter 缺失时的行为）');
  return fb;
}
// ---------- Electron 隐藏窗口探针（argv 会混入启动开关 ⇒ 路径走 env） ----------
function runnerSource() {
  return `'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs'); const path = require('path');
const RESULT = process.env.SELFCHECK_RESULT, URL = process.env.SELFCHECK_URL;
const CSSF = process.env.SELFCHECK_CSS, JSF = process.env.SELFCHECK_JS;
const SESSION = process.env.SELFCHECK_SESSION || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { app.setPath('userData', path.join(path.dirname(RESULT), 'profile-' + Date.now())); } catch (e) {}
let done = false;
function finish(code, obj) { if (done) return; done = true; try { fs.writeFileSync(RESULT, JSON.stringify(obj)); } catch (e) {} setTimeout(() => { try { app.exit(code); } catch (e) { process.exit(code); } }, 120); }
setTimeout(() => finish(2, { ok: false, error: 'runner watchdog' }), 24000);
try { app.disableHardwareAcceleration(); } catch (e) {}
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false } });
  const load = {};
  win.webContents.on('did-fail-load', (e, code, desc, url) => { load.fail = code + ' ' + desc + ' ' + url; });
  try { await win.loadURL(URL); } catch (e) { load.err = String(e && e.message || e); }
  const q = "document.querySelectorAll('[data-chat-flow]').length";
  const t0 = Date.now(); let sel = 0, enter = null;
  while (Date.now() - t0 < 6000 && !load.fail) { try { sel = await win.webContents.executeJavaScript(q); } catch (e) {} if (sel > 0) break; await sleep(300); }
  // 引擎首页可能是欢迎页/选择工作区。① 优先模拟真实面板：写 localStorage['dsh.sessions.current'] 再 reload
  if (!sel && SESSION) {
    try { await win.webContents.executeJavaScript("try{localStorage.setItem('dsh.sessions.current', JSON.stringify({sessionId:" + JSON.stringify(SESSION) + "}));'ok'}catch(e){'err'}"); } catch (e) { /* ignore */ }
    try { await win.webContents.reload(); } catch (e) { /* ignore */ }
    const t1 = Date.now();
    while (Date.now() - t1 < 10000) { try { sel = await win.webContents.executeJavaScript(q); } catch (e) {} if (sel > 0) break; await sleep(300); }
    enter = { mode: 'localStorage', session: SESSION, sel };
  }
  // ② 兜底：点一条会话行（协议内操作，只点列表）
  if (!sel) {
    const E = "(()=>{const rows=Array.from(document.querySelectorAll('div[role=\\"treeitem\\"]'));const vis=rows.filter((r)=>r.getBoundingClientRect().height>0);const titles=vis.slice(0,10).map((r)=>(r.textContent||'').replace(/\\\\s+/g,' ').trim().slice(0,40));if(!vis.length)return{rows:rows.length,clicked:0,titles:[]};const pick=vis.find((r)=>{const t=(r.textContent||'').trim();return r.getAttribute('aria-selected')==='true'&&!/新会话|新建|New/.test(t);})||vis.find((r)=>!/新会话|新建|New/.test((r.textContent||'').trim()))||vis[0];pick.click();return{rows:rows.length,titles:titles,clicked:1,title:(pick.textContent||'').replace(/\\\\s+/g,' ').trim().slice(0,40)};})()";
    try { enter = await win.webContents.executeJavaScript(E); } catch (e) { enter = { err: String(e && e.message || e) }; }
    const t2 = Date.now();
    while (Date.now() - t2 < 9000) { try { sel = await win.webContents.executeJavaScript(q); } catch (e) {} if (sel > 0) break; await sleep(300); }
  }
  const i = { cssOk: false, cssErr: '', jsOk: false, jsErr: '', jsResult: '' };
  try { const k = await win.webContents.insertCSS(fs.readFileSync(CSSF, 'utf8')); i.cssOk = !!k; } catch (e) { i.cssErr = String(e && e.message || e); }
  try { const r = await win.webContents.executeJavaScript(fs.readFileSync(JSF, 'utf8')); i.jsOk = true; i.jsResult = String(r == null ? '' : r).slice(0, 200); } catch (e) { i.jsErr = String(e && e.message || e); }
  await sleep(900);
  const M = \`(()=>{const q=(s)=>document.querySelectorAll(s).length;const diag=(()=>{try{return JSON.parse(window.__fixDiag||'null')}catch(e){return null}})();return{chatFlow:q('[data-chat-flow]'),phase:q('[data-phase]'),widthHandle:q('[data-width-handle]'),composerCard:q('[data-composer-card]'),composerInput:q('[data-composer-input]'),centerCol:q('[class*="centerCol"]'),dataSides:Array.from(document.querySelectorAll('[data-side]')).map((e)=>String(e.getAttribute('data-side'))),widthHandleSides:Array.from(document.querySelectorAll('[data-width-handle]')).map((e)=>String(e.getAttribute('data-side')||'')),dataSideInfo:Array.from(document.querySelectorAll('[data-side]')).slice(0,12).map((e)=>({t:e.tagName,c:String(e.className||'').slice(0,40),s:String(e.getAttribute('data-side')),v:e.offsetParent!==null})),fixDiag:diag,title:document.title,bodyText:(document.body&&document.body.textContent||'').slice(0,2000),url:location.href};})()\`;
  let meas = {}; try { meas = await win.webContents.executeJavaScript(M); } catch (e) { meas = { error: String(e && e.message || e) }; }
  finish(0, { ok: true, load, selBeforeInject: sel, enter, waitedMs: Date.now() - t0, injected: i, meas });
}).catch((e) => finish(3, { ok: false, error: String(e && e.message || e) }));
`;
}
function pickSessionId() {
  try { const j = JSON.parse(readText(WORKBENCH_JSON)); for (const k of Object.keys(j.scenes || {})) { const id = String((j.scenes[k] || {}).sessionId || ''); if (/^session-/.test(id)) return id; } } catch (e) { /* ignore */ }
  return '';
}
function findElectron() {
  const cands = [process.env.ELECTRON_PATH, path.join(SHELL, 'node_modules', 'electron', 'dist', 'electron.exe')].filter(Boolean);
  for (const p of cands) { try { if (fs.statSync(p).isFile()) return p; } catch (e) { /* next */ } }
  return '';
}
async function runProbe(probe, inj) {
  const electron = findElectron();
  if (!electron) return { skipped: '找不到 Electron（外壳\\node_modules\\electron\\dist\\electron.exe 不存在）⇒ 无法做运行时实测' };
  const dir = path.join(DATA, '_临时', 'engine-selfcheck-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const runner = path.join(dir, 'runner.cjs'), resultF = path.join(dir, 'result.json');
  fs.writeFileSync(runner, runnerSource());
  fs.writeFileSync(path.join(dir, 'inject.css'), inj.css);
  fs.writeFileSync(path.join(dir, 'inject.js'), inj.fix);
  try { new Function(readText(path.join(dir, 'inject.js'))); } catch (e) { return { skipped: 'FIX_JS 语法不可解析（未验证）：' + String(e && e.message || e) }; }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;   // ⚠ 本机可能有它：留着 Electron 会跑成纯 Node（无 GUI）
  env.SELFCHECK_RESULT = resultF;
  env.SELFCHECK_URL = probe.base + '/?token=' + encodeURIComponent(probe.token);
  env.SELFCHECK_CSS = path.join(dir, 'inject.css');
  env.SELFCHECK_JS = path.join(dir, 'inject.js');
  env.SELFCHECK_SESSION = pickSessionId();
  const child = spawn(electron, ['--no-sandbox', '--disable-gpu', runner], { cwd: SHELL, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 4096) stderr = stderr.slice(-4096); });
  let exitCode = null;
  const killed = await new Promise((resolve) => {
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* ignore */ } resolve(true); }, TIMEOUT_S * 1000);
    child.on('exit', (code) => { clearTimeout(timer); exitCode = code; resolve(false); });
  });
  let res = null;
  try { res = JSON.parse(readText(resultF) || 'null'); } catch (e) { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  if (!res) return { skipped: (killed ? '探针超时（' + TIMEOUT_S + 's，未验证）' : '探针没有产出结果（未验证；electron exit=' + exitCode + '）') + (stderr ? '；stderr=' + stderr.trim().slice(0, 300) : '') };
  if (res.ok !== true) return { skipped: '探针失败（未验证）：' + (res.error || JSON.stringify(res).slice(0, 300)) };
  return { probeResult: res };
}
// ---------- 判定 ----------
function judge(meas, selftest) {
  const rows = [];
  for (const e of EXPECTED) {
    const v = e.pick(meas);
    if (e.kind === 'min') rows.push({ id: e.id, label: e.label, expect: '≥' + e.expect, actual: v, ok: Number(v) >= e.expect });
    else if (e.kind === 'anyMin') rows.push({ id: e.id, label: e.label, expect: '任一 ≥' + e.expect, actual: 'card=' + v[0] + ' input=' + v[1], ok: Math.max(Number(v[0]), Number(v[1])) >= e.expect });
    else if (e.kind === 'eq') rows.push({ id: e.id, label: e.label, expect: '=' + e.expect, actual: v, ok: Number(v) === e.expect });
    else if (e.kind === 'subset') { const bad = (Array.isArray(v) ? v : []).filter((x) => !e.allowed.includes(x)); rows.push({ id: e.id, label: e.label, expect: '只允许 ' + e.allowed.join('/'), actual: '共 ' + v.length + ' 个：' + JSON.stringify(v), ok: bad.length === 0, bad }); }
  }
  if (selftest) {
    rows.push({ id: 'selftest:bogus', label: '[data-wb-selfcheck-bogus]', expect: '≥1', actual: 0, ok: false });
    rows.push({ id: 'selftest:center', label: '[class*="centerCol"]', expect: '=2（故意改大 1）', actual: meas.centerCol, ok: false });
  }
  return { rows, diffs: rows.filter((r) => !r.ok).map((r) => r.label + '：期望 ' + r.expect + '，实际 ' + r.actual + (r.bad && r.bad.length ? '（非法值 ' + r.bad.join('/') + '）' : '')) };
}

// ---------- 输出与主流程 ----------
function emit(res) {
  if (TEXT_JSON) { console.log(JSON.stringify(res, null, 2)); return; }
  log('== engine-selfcheck（DSH 引擎运行时契约自检） ==');
  log('引擎：' + (res.engine.reachable ? res.engine.base + '（token 来源：' + res.engine.tokenSource + '）' : '不可达') + (res.engine.port ? ' · 端口 ' + res.engine.port : ''));
  log('adapter：' + res.adapter);
  for (const n of res.notes) log('  ! ' + n);
  if (res.skipped) { log(''); log('SKIPPED：' + res.skipped); log('结果：**未验证**（exit 3；这不是"通过"）'); return; }
  log('注入：CSS ' + (res.injected.cssOk ? '✓' : '✗ ' + res.injected.cssErr) + ' · FIX_JS ' + (res.injected.jsOk ? '✓' : '✗ ' + res.injected.jsErr));
  if (res.meas.fixDiag) log('修后诊断：hasChatFlow=' + res.meas.fixDiag.hasChatFlow + ' hasPhase=' + res.meas.fixDiag.hasPhase + " wide='" + (res.meas.fixDiag.wide || '') + "'");
  if (res.enter) log('进入会话：' + (res.enter.mode === 'localStorage' ? '写 dsh.sessions.current（' + res.enter.session + '）后重载 → chatFlow=' + res.enter.sel : res.enter.clicked ? '点击会话行「' + res.enter.title + '」（共 ' + res.enter.rows + ' 行）' : '未能进入（没有可点会话行：' + (res.enter.body || res.enter.err || '') + '）'));
  if (res.meas.dataSideInfo) log('data-side 分布：' + res.meas.dataSideInfo.map((x) => x.t + '.' + x.c + '="' + x.s + '"' + (x.v ? '' : '(隐藏)')).join('、'));
  log('断言：'); for (const r of res.assertions.rows) log('  ' + (r.ok ? '✓' : '✗') + ' ' + r.label + ' 期望 ' + r.expect + '，实际 ' + r.actual);  log('');
  if (res.status === 'VERIFIED') log('结果：VERIFIED（exit 0）');
  else { log('FAILED：' + res.assertions.diffs.length + ' 项断言不满足（exit 1）'); log('差异集合：'); for (const d of res.assertions.diffs) log('  ✗ ' + d); }
}
async function main() {
  const t0 = Date.now();
  const base = { script: 'engine-selfcheck.mjs', checkedAt: new Date().toISOString(), timeoutSec: TIMEOUT_S, selftest: SELFTEST };
  const skip = (reason, extra) => { emit({ ...base, status: 'SKIPPED', exitCode: 3, adapter: 'none', ...extra, skipped: reason }); process.exit(3); };
  const probe = await engineProbe();
  if (!probe.reachable) return skip('引擎未运行（' + probe.notes.slice(-1)[0] + '）⇒ 未验证；不自己拉起引擎（会抢用户端口）', { engine: probe, notes: probe.notes });
  if (probe.authProblem) return skip('引擎在跑，但 token 来源全部无效 ⇒ 未验证', { engine: probe, notes: probe.notes });
  let inj;
  try { inj = loadInjection(); } catch (e) { return skip('取不到注入字面量 ⇒ 未验证：' + String(e && e.message || e), { engine: probe, notes: [] }); }
  const run = await runProbe(probe, inj);
  if (run.skipped) return skip(run.skipped, { engine: probe, adapter: inj.adapter, notes: (probe.notes || []).concat(inj.notes, [run.skipped]) });
  const pr = run.probeResult, meas = pr.meas || {};
  const assertions = judge(meas, SELFTEST);
  const notes = (probe.notes || []).concat(inj.notes);
  if (!pr.selBeforeInject && pr.enter) notes.push('注入前仍未进入会话画面（enter=' + JSON.stringify(pr.enter).slice(0, 200) + '）');
  // 契约漂移提示（不判红）：实测 AppFrame 的列手柄（mP3x-q_handle）也带 data-side="sidebar"，
  // 而契约 §五写的是"data-side 只能是 left/right"。判定只约束壳真正操作的 [data-width-handle]
  // （那里实测只有 left/right）；全局其它值单列出来供 Lead 定夺契约措辞（见实施报告）。
  const extraSides = (meas.dataSides || []).filter((x) => x !== 'left' && x !== 'right');
  if (extraSides.length) notes.push('契约漂移提示：全局 data-side 另有值 ' + JSON.stringify(extraSides) + '（位于 AppFrame 列手柄，不是宽度手柄；契约 §五原文只允许 left/right）');
  const fails = assertions.diffs.concat((!pr.injected || !pr.injected.cssOk || !pr.injected.jsOk) ? ['注入未成功：CSS=' + (pr.injected && pr.injected.cssOk) + ' FIX_JS=' + (pr.injected && pr.injected.jsOk)] : []);
  const status = fails.length ? 'FAILED' : 'VERIFIED';
  const out = { ...base, status, exitCode: fails.length ? 1 : 0, engine: probe, adapter: inj.adapter, notes, injected: pr.injected, enter: pr.enter, selBeforeInject: pr.selBeforeInject, meas: { ...meas, bodyText: undefined }, pageTitle: meas.title, assertions, durationMs: Date.now() - t0 };
  emit(out);
  process.exit(out.exitCode);
}
main().catch((e) => { emit({ script: 'engine-selfcheck.mjs', status: 'SKIPPED', exitCode: 3, adapter: 'none', notes: [], skipped: '脚本异常（未验证）：' + String(e && e.stack || e) }); process.exit(3); });
