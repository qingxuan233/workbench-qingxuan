/* theme-sync.js —— 外壳深/浅色 → 内嵌页面
 *
 * 为什么要单独一份：DSH 的浅色主题就是 body[data-ds-dark-theme] 有没有这一个属性
 *   （浅色 = 去掉它）。但 DSH 自己的 ui-theme 偏好存在引擎配置里（cordis.patch.yml，
 *   默认 dark），不会跟着工作台外壳走 —— 外壳切浅色时内嵌的 DSH 仍是深色。
 *
 * 做法（两档一起管）：
 *   ① 引擎页（src 带 :3083）：外壳主题一解析（html[data-theme] 变化）就把当前主题推给它；
 *   ② 网页版 AI 五站：主进程 theme-source.js 已把外壳三档落到 nativeTheme.themeSource，
 *      Chromium 的 prefers-color-scheme 本来就会实时变（DSH 引擎、DeepSeek、Kimi、智谱
 *      这些"跟系统"的页面直接跟着走）。但豆包 / 千问 把用户偏好**写死在 localStorage**
 *      （默认 light），只改 prefers-color-scheme 它们不动 ⇒ 这里再按站点把它们自己的
 *      主题参数（data-theme / localStorage / body.dark）改成当前明暗，并挂一个观察器
 *      兜住站点 React 重渲染把属性改回去的时序。
 *
 * 只碰 src 里带 :3083 的 webview 和这五个网页版站点，其它内嵌网页（B 站、官网预览等）不动。
 * 无新依赖、不改主进程。
 */
(function () {
  var SITES = [
    { re: /(^|\.)chat\.deepseek\.com$/, key: 'deepseek' },
    { re: /(^|\.)doubao\.com$/, key: 'doubao' },
    { re: /(^|\.)qianwen\.com$/, key: 'qianwen' },
    { re: /(^|\.)chatglm\.cn$/, key: 'chatglm' },
    { re: /(^|\.)kimi\.com$/, key: 'kimi' }
  ];
  function themeNow() { try { return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'; } catch (e) { return 'dark'; } }
  function isEngineWv(wv) { try { return String(wv.getAttribute('src') || '').indexOf(':3083') >= 0; } catch (e) { return false; } }
  function siteOf(wv) {
    var src = '', host = '';
    try { src = String(wv.getAttribute('src') || ''); } catch (e) { return ''; }
    try { host = new URL(src).host; } catch (e) { return ''; }
    for (var i = 0; i < SITES.length; i++) if (SITES[i].re.test(host)) return SITES[i].key;
    return '';
  }

  // ---- ① DSH 引擎：body[data-ds-dark-theme]（DSH 的浅色 = 没有这个属性）----
  function syncEngine(wv) {
    var light = themeNow() === 'light';
    var js = '(function(l){try{window.__wbDark=!l;function ap(){var b=document.body;if(!b)return;' +
      'var h=b.hasAttribute("data-ds-dark-theme");' +
      'if(window.__wbDark&&!h)b.setAttribute("data-ds-dark-theme","");' +
      'else if(!window.__wbDark&&h)b.removeAttribute("data-ds-dark-theme");}' +
      'window.__wbApplyTheme=ap;ap();' +
      'if(!window.__wbThemeObs&&window.MutationObserver){' +
      'window.__wbThemeObs=new MutationObserver(ap);' +
      'window.__wbThemeObs.observe(document.body,{attributes:true,attributeFilter:["data-ds-dark-theme"]});}' +
      'setTimeout(ap,400);setTimeout(ap,1500);}catch(e){}})(' + light + ');';
    try {
      var p = wv.executeJavaScript(js);
      if (p && p.catch) p.catch(function () { /* 页面还没就绪时忽略 */ });
    } catch (e) { /* ignore */ }
  }

  // ---- ② 网页版 AI：改站点自己的主题参数（并用观察器钉住）----
  // ⚠ 2026-11-04 修复「豆包/千问/智谱 空白页 + 内存/CPU 失控」：
  //   原实现 `h.setAttribute('data-theme', t)` + MutationObserver(html:{data-theme,class}, body:{class,...})
  //   回调里**又无条件写同一个属性** ⇒ 站点 React 每次把属性改回去都会再触发我们、我们再改回去……
  //   → MutationObserver 自激死循环（主线程锁死、Runtime.evaluate 超时、renderer 15s 涨到 1.4GB/75s 3.2GB）。
  //   对照实验：不带本脚本的空白 Electron 加载同一个豆包 → 稳定 260–350MB。
  //   现在三条约束：
  //     ① 只在**值真的不同**时才写（写相同值本身不会触发 MutationObserver，是幂等的）；
  //     ② 写之前先 disconnect、写完再 observe（绝不让自己触发自己）；
  //     ③ 每个窗口最多观察 20 次，且两次回调之间至少 300ms（真遇到站点反复横跳也只会收敛，不会失控）。
  function syncSite(wv, site) {
    var t = themeNow();
    var js = '(function(site,tt){try{' +
      'var h=document.documentElement,b=document.body;' +
      'window.__wbWebAiTheme=tt;' +
      'function set(k,v){try{localStorage.setItem(k,v)}catch(e){}}' +
      'var n=0,last=0;' +
      'function ap(){try{var t=window.__wbWebAiTheme||"dark";' +
        'window.__wbWebAiObs&&window.__wbWebAiObs.takeRecords&&window.__wbWebAiObs.takeRecords();' +
        'var ob=window.__wbWebAiObs;if(ob){try{ob.disconnect()}catch(e){}}' +
        'if(site==="deepseek"){' +
          'if(b){if(b.classList.contains("dark")!==(t==="dark"))b.classList.toggle("dark",t==="dark");if(b.classList.contains("light")!==(t==="light"))b.classList.toggle("light",t==="light");}' +
          // 用 getAttribute 而不是 hasAttribute：老版本/测试桩里 hasAttribute 不一定存在（踩过）
          'if(t==="dark"){if(b&&b.getAttribute("data-ds-dark-theme")===null)b.setAttribute("data-ds-dark-theme","dark");}else if(b&&b.getAttribute("data-ds-dark-theme")!==null){b.removeAttribute("data-ds-dark-theme");}' +
        '}else if(site==="doubao"){if(h.getAttribute("data-theme")!==t)h.setAttribute("data-theme",t);set("dbx-web-theme",t);}' +
        'else if(site==="qianwen"){if(h.getAttribute("data-theme")!==t)h.setAttribute("data-theme",t);set("tongyi-theme-preference",t);}' +
        'else if(site==="chatglm"){if(h.getAttribute("data-theme")!==t)h.setAttribute("data-theme",t);}' +
        'else if(site==="kimi"){if(h.classList.contains("dark")!==(t==="dark"))h.classList.toggle("dark",t==="dark");if(h.classList.contains("light")!==(t==="light"))h.classList.toggle("light",t==="light");}' +
        'if(ob&&n++<20){try{ob.observe(h,{attributes:true,attributeFilter:["data-theme","class"]});if(document.body)ob.observe(document.body,{attributes:true,attributeFilter:["class","data-ds-dark-theme"]});}catch(e){}}' +
      '}catch(e){}}' +
      'ap();' +
      'if(!window.__wbWebAiObs&&window.MutationObserver){' +
        'window.__wbWebAiObs=new MutationObserver(function(){var now=Date.now();if(now-last<300)return;last=now;ap();});' +
        'try{window.__wbWebAiObs.observe(h,{attributes:true,attributeFilter:["data-theme","class"]});' +
        'if(document.body)window.__wbWebAiObs.observe(document.body,{attributes:true,attributeFilter:["class","data-ds-dark-theme"]});}catch(e){}' +
        'setTimeout(ap,400);setTimeout(ap,1500);}' +
      '}catch(e){}})(' + JSON.stringify(site) + ',' + JSON.stringify(t) + ');';
    try {
      var p = wv.executeJavaScript(js);
      if (p && p.catch) p.catch(function () { /* 页面还没就绪时忽略 */ });
    } catch (e) { /* ignore */ }
  }

  function sync(wv) {
    if (!wv || typeof wv.executeJavaScript !== 'function') return;
    if (isEngineWv(wv)) { syncEngine(wv); return; }
    var site = siteOf(wv);
    if (site) syncSite(wv, site);
  }
  function syncAll() {
    var list = document.querySelectorAll('webview');
    for (var i = 0; i < list.length; i++) sync(list[i]);
  }
  // 每个 webview 装载完成后补推一次（含 DSH 客户端 / 站点 React 后挂载的情形）
  document.addEventListener('dom-ready', function (e) {
    var t = e.target;
    if (t && t.tagName === 'WEBVIEW') { sync(t); setTimeout(function () { sync(t); }, 800); }
  }, true);
  // 外壳主题变化 → 立刻同步
  try {
    new MutationObserver(syncAll).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  } catch (e) { /* ignore */ }
  // 首次装载：webview 可能在主题解析之后才建出来
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(syncAll, 400); });
  else setTimeout(syncAll, 400);
  setTimeout(syncAll, 2500);
})();
