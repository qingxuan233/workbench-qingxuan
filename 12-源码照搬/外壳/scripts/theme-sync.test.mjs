// theme-sync.test.mjs —— 外观同步的**坏样本**测试（不进 GUI，纯 Node）
//
// 在 Node 里用两个假 DOM 跑一遍 renderer\theme-sync.js：
//   ① 外壳页：收集它往 webview 里 executeJavaScript 的脚本；
//   ② guest 页：把脚本跑在假页面上，检查 deepseek / 豆包 / 千问 / Kimi / 智谱 的
//      主题属性确实被翻成当前明暗，并且站内 React 把它改回去时观察器能钉回来。
//
// 用法：node 外壳\scripts\theme-sync.test.mjs   （0=通过，1=失败）
// 为什么要有它：这一段只在真 GUI 里"肉眼可见"，坏了不会报错；这里把关键断言变成可回归的。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC_PATH = fileURLToPath(new URL('../renderer/theme-sync.js', import.meta.url));
const src = fs.readFileSync(SRC_PATH, 'utf8');

const injected = [];
const listeners = {};
let currentWvs = [];
global.document = {
  documentElement: { dataset: { theme: 'dark' } },
  readyState: 'complete',
  body: null,
  querySelectorAll: () => currentWvs,
  addEventListener: (t, f) => { listeners[t] = f; },
};
global.MutationObserver = class { observe() {} };
global.window = {};

function fakeWv(srcUrl) {
  return {
    getAttribute: () => srcUrl,
    executeJavaScript: (js) => { injected.push(js); return Promise.resolve(); },
  };
}

// 加载 theme-sync.js：把 setTimeout 换成同步执行，让 syncAll 立刻跑（真实环境里是 400ms/2500ms）
function loadSync(wvs) {
  currentWvs = wvs;
  // 不用 eval（代码红线禁止）：把 theme-sync.js 当函数体跑，document / setTimeout 用参数注入
  const stubSetTimeout = (f) => { try { f(); } catch (e) { /* ignore */ } };
  const fn = new Function('document', 'window', 'MutationObserver', 'setTimeout', 'URL', src);
  fn(global.document, global.window, global.MutationObserver, stubSetTimeout, URL);
}

function makeGuest() {
  const g = {};
  g.html = {
    attrs: {}, set: new Set(),
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
    setAttribute(k, v) { this.attrs[k] = v; },
    classList: {
      toggle(c, on) { if (on) g.html.set.add(c); else g.html.set.delete(c); },
      contains(c) { return g.html.set.has(c); },
    },
  };
  g.body = {
    attrs: {}, set: new Set(['zh_CN']),
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    classList: {
      toggle(c, on) { if (on) g.body.set.add(c); else g.body.set.delete(c); },
      contains(c) { return g.body.set.has(c); },
    },
  };
  g.store = {};
  return g;
}

// 同一 guest = 同一页面上下文 ⇒ 复用同一个 window（真实 executeJavaScript 也是同一 window）
function run(jsStr, guest, w) {
  w = w || {};
  const MO = class { constructor(cb) { this.cb = cb; } observe() {} };
  if (!w.MutationObserver) w.MutationObserver = MO;
  const doc = { documentElement: guest.html, body: guest.body };
  const ls = { setItem: (k, v) => { guest.store[k] = v; }, getItem: (k) => guest.store[k] };
  const fn = new Function('window', 'document', 'localStorage', 'MutationObserver', 'setTimeout', jsStr);
  fn(w, doc, ls, MO, (f) => {});
  return w;
}

let fail = 0;
function check(name, cond) { console.log((cond ? 'ok   ' : 'FAIL ') + name); if (!cond) fail++; }

// ---- 1) DeepSeek：深色 → 浅色 → 观察器钉回 ----
injected.length = 0;
loadSync([fakeWv('https://chat.deepseek.com/')]);
check('deepseek: 收到底层脚本', injected.length >= 1);
const darkJs = injected[0];
const g = makeGuest();
const w = run(darkJs, g);
check('deepseek dark: body.dark', g.body.classList.contains('dark'));
check('deepseek dark: body.light absent', !g.body.classList.contains('light'));
check('deepseek dark: data-ds-dark-theme=dark', g.body.attrs['data-ds-dark-theme'] === 'dark');
check('deepseek: 观察器已装', !!(w.__wbWebAiObs && typeof w.__wbWebAiObs.cb === 'function'));

global.document.documentElement.dataset.theme = 'light';
injected.length = 0;
loadSync([fakeWv('https://chat.deepseek.com/')]);
run(injected[0], g, w);
check('deepseek light: body.light', g.body.classList.contains('light'));
check('deepseek light: body.dark removed', !g.body.classList.contains('dark'));
check('deepseek light: dark attr removed', !('data-ds-dark-theme' in g.body.attrs));

g.body.set.add('dark'); g.body.set.delete('light');   // 站内 React 改回深色
w.__wbWebAiObs.cb();                                   // 观察器应该把它钉回浅色
check('pin: 站内改回深色后重新变浅', g.body.classList.contains('light') && !g.body.classList.contains('dark'));

// ---- 2) 豆包 / 千问 / Kimi / 智谱：各自的主题落点 ----
global.document.documentElement.dataset.theme = 'dark';
injected.length = 0;
loadSync([
  fakeWv('https://www.doubao.com/chat/'),
  fakeWv('https://www.qianwen.com/'),
  fakeWv('https://www.kimi.com/'),
  fakeWv('https://chatglm.cn/main/alltoolsdetail'),
]);
check('四个站点各收到底层脚本', injected.length >= 4);
const names = ['doubao', 'qianwen', 'kimi', 'chatglm'];
injected.slice(0, 4).forEach((jsX, i) => {
  const gx = makeGuest();
  run(jsX, gx);
  const attr = gx.html.getAttribute('data-theme');
  const darkOk = gx.body.classList.contains('dark') || gx.html.classList.contains('dark') || attr === 'dark';
  check(names[i] + ' 被强制成深色（attr=' + attr + '）', darkOk);
});

console.log(fail ? 'FAILED ' + fail : 'ALL PASS');
process.exit(fail ? 1 : 0);
