// panels/panel-embed.js —— embed 面板渲染器（P2-D 阶段3c 从 renderers.js 684-921 搬出）
// 来源：renderers.js 原 684-921（238 行）。外层赋值改 `APP['embed'] = ...`；函数体/注释/缩进逐字保留。
// 依赖：`el` / `wireHeadNoDrag` / `resolveEmbedUA` 等在 renderers.js 与 lib/embed-utils.js 的全局 helper
//       （**调用期**才用到，本文件先加载不影响）；`resolveEmbedUA` 已在 lib/embed-utils.js，禁止重复实现。
// 加载顺序：adapter → lib/embed-utils.js → panels/embed-host.js → panels/panel-embed.js → … → chrome.js
//           → renderers.js → renderer.js → topbar-status.js。
var APP = window.APP_RENDERERS || (window.APP_RENDERERS = {});

APP['embed'] = (body, meta, head) => {  body.classList.add('embed-panel');
  const url = String(meta.url || '');
  const A = window.app && window.app.app;   // app = 宿主通用能力（开外链/定位路径），不占任何场景命名空间
  const pid = String(meta.id || 'panel');
  const storeKey = 'app.embed.on.' + pid;
  const launchPaths = (Array.isArray(meta.launchPaths) ? meta.launchPaths : [meta.launchPath])
    .filter((p) => typeof p === 'string' && p);
  let wv = null;
  let disposed = false;
  let retryTimer = null;
  let retryLeft = 0;

  // 记住"内置还是没内置"：默认内置；用户点了取消内置就一直是取消状态，直到自己切回来
  let embedded = true;
  try { if (window.localStorage.getItem(storeKey) === '0') embedded = false; } catch (e) { /* 存储不可用就按默认 */ }
  const remember = (on) => { try { window.localStorage.setItem(storeKey, on ? '1' : '0'); } catch (e) { /* ignore */ } };

  const msg = el('div', 'embed-msg', '');
  body.appendChild(msg);
  const clearCards = () => {
    const c = body.querySelectorAll('.embed-fail, .embed-off');
    for (let i = 0; i < c.length; i++) c[i].remove();
  };
  const showMsg = (t) => { msg.textContent = t; msg.style.display = ''; };
  const hideMsg = () => { msg.style.display = 'none'; };

  // 桌面启动：按候选顺序试，第一个打开成功就停（用桌面快捷方式 = 等价双击）
  const needsRetry = () => (!wv || !!body.querySelector('.embed-fail'));   // 页面好好的就别去折腾它
  const launch = async (statusEl) => {
    if (!launchPaths.length) return false;
    let ok = false;
    for (let i = 0; i < launchPaths.length; i++) {
      const p = launchPaths[i];
      try {
        const r = A && A.openPath ? await A.openPath(p) : (window.open(p, '_blank'), { ok: true });
        if (r && r.ok) { ok = true; break; }
      } catch (e) { /* 试下一个 */ }
    }
    const failText = '桌面启动失败：没找到启动器（' + launchPaths.join(' / ') + '），请手动双击桌面快捷方式。';
    if (statusEl) statusEl.textContent = ok ? (meta.launchHint || '已调用桌面启动器，等它起来（本机约 1~2 秒），好会自动接上…') : failText;
    if (ok) { if (needsRetry()) autoRetry(); }
    else showMsg(failText);   // 标题行没有状态栏，失败就写到面板中间，别静默
    return ok;
  };

  // 点了桌面启动后：每 2 秒自己重试一次，最多 12 次（约 24 秒）；成功或超时就停，不留定时器
  const stopRetry = () => { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } };
  const autoRetry = () => {
    if (disposed || !embedded || retryTimer) return;
    retryLeft = 12;
    const tick = () => {
      retryTimer = null;
      if (disposed || !embedded) return;
      if (retryLeft-- <= 0) { showMsg('等不到 ' + url + ' 起来，点「🔄 刷新」再试，或看桌面那个窗口是不是报错了。'); return; }
      clearCards();
      // 失败时 did-fail-load 会把 webview 摘掉，所以这里可能是"没有 wv"的状态 → 重新挂一个
      if (!wv) mount();
      else { try { wv.reload(); } catch (e) { try { wv.loadURL(url); } catch (e2) { /* ignore */ } } }
      retryTimer = setTimeout(tick, 2000);
    };
    retryTimer = setTimeout(tick, 2000);
  };

  const makeBtn = (label, title, cls) => {
    const b = el('button', cls || 'file-refresh', label);
    if (title) b.title = title;
    return b;
  };

  // 内嵌页面的滚动条：guest 是**另一个文档**，工作台的 ::-webkit-scrollbar 管不到它，
  // 默认那条白条在深色面板里特别扎眼 ⇒ 往 guest 里注一层同款深色细条（meta.scrollbar === false 可关）
  const SCROLL_CSS = '::-webkit-scrollbar{width:10px;height:10px}'
    + '::-webkit-scrollbar-track{background:transparent}'
    + '::-webkit-scrollbar-thumb{background:rgba(148,163,184,.42);border-radius:5px;border:2px solid transparent;background-clip:content-box}'
    + '::-webkit-scrollbar-thumb:hover{background:rgba(148,163,184,.62);background-clip:content-box}'
    + '::-webkit-scrollbar-corner{background:transparent}';
  const applyScrollCss = () => {
    if (meta.scrollbar === false || !wv) return;
    try {
      if (typeof wv.insertCSS === 'function') {
        const p = wv.insertCSS(SCROLL_CSS);
        if (p && p.catch) p.catch(() => { /* guest 已销毁 */ });
        return;
      }
      // 老 Electron 没有 insertCSS：退化成往 guest 里塞一个 <style>（带 id，重复注入只留一份）
      if (typeof wv.executeJavaScript === 'function') {
        const p = wv.executeJavaScript('(function(){if(document.getElementById("kun-scrollbar-css"))return;'
          + 'var s=document.createElement("style");s.id="kun-scrollbar-css";s.textContent=' + JSON.stringify(SCROLL_CSS)
          + ';(document.head||document.documentElement).appendChild(s);})()');
        if (p && p.catch) p.catch(() => { /* ignore */ });
      }
    } catch (e) { /* 注入失败不影响页面 */ }
  };

  // ---- 挂上 webview（内置模式）----
  const mount = () => {
    if (wv || !url) return;
    hideMsg();
    clearCards();
    wv = document.createElement('webview');
    wv.className = 'embed-wv';
    // partition 必须在首次导航前设好；面板 id 决定分区名，避免和 harness 的会话分区混用
    wv.setAttribute('partition', 'persist:embed-' + pid.replace(/[^A-Za-z0-9_-]/g, '_'));
    // UA 也必须在首次导航前设好（加载后再改要重载才生效）
    const ua = resolveEmbedUA(meta.userAgent);
    if (ua) wv.setAttribute('useragent', ua);
    // 2026-10-19（宿主：B站场景一点开就跳两个 Edge 窗口）——根因：embed 的 webview 开了 allowpopups，
    //   B站页面会 window.open 它自己的内部页（leader-election/iframe.html、Cross Origin Local Storage），
    //   而 main.js 的 setWindowOpenHandler 对非内部 URL 一律 openInSystemBrowser() ⇒ 跑到系统浏览器。
    //   现在**默认不给弹窗**（浏览器不会弹，也不会跳 Edge）；确实需要弹窗的面板，在场景 json 里写 "allowPopups": true。
    if (meta.allowPopups === true) wv.setAttribute('allowpopups', '');
    wv.addEventListener('dom-ready', applyScrollCss);
    startBiliTrack(wv, meta);   // 2026-10-19：B站场景「当前视频」同步（非 B站场景内部直接 return）
    startBiliProbe(wv, meta);   // 2026-10-19 临时：点击探针（定位完删掉）
    wv.addEventListener('did-finish-load', () => { hideMsg(); clearCards(); stopRetry(); applyScrollCss(); });
    wv.addEventListener('did-fail-load', (e) => {
      // -3 = ERR_ABORTED：正常重载/跳转时的取消，不算故障
      if (e && e.errorCode === -3) return;
      if (wv) { try { wv.remove(); } catch (ex) { /* ignore */ } wv = null; }
      hideMsg();
      clearCards();
      showFail(e);
    });
    wv.setAttribute('src', url);
    body.appendChild(wv);
  };

  // ---- 摘掉 webview（取消内置模式）----
  const unmount = () => {
    stopRetry();
    if (wv) { try { wv.remove(); } catch (e) { /* ignore */ } wv = null; }
    clearCards();
    showMsg('已取消内置：这个面板不再加载 ' + url + '（省一份 guest 进程和轮询）。');
  };

  const showFail = (e) => {
    const box = el('div', 'embed-fail');
    box.appendChild(el('div', 'embed-fail-icon', '🔌'));
    box.appendChild(el('div', 'embed-fail-title', '连不上 ' + url));
    box.appendChild(el('div', 'embed-fail-sub', meta.failHint || '确认这个服务在本机跑着，再点「重试」。'));
    if (e && (e.errorDescription || e.errorCode)) {
      box.appendChild(el('div', 'embed-fail-err', String(e.errorDescription || e.errorCode)));
    }
    const status = el('div', 'embed-fail-status', '');
    const row = el('div', 'embed-actions');
    if (launchPaths.length) {
      const lb = makeBtn(meta.launchLabel || '🖥 桌面启动', '按场景 json 里配的启动器把桌面程序拉起来', 'file-refresh embed-btn');
      lb.addEventListener('click', () => launch(status));
      row.appendChild(lb);
    }
    const retry = makeBtn('🔄 重试', '再连一次', 'file-refresh embed-btn');
    retry.addEventListener('click', () => {
      hideMsg();
      clearCards();
      mount();
    });
    row.appendChild(retry);
    box.appendChild(row);
    box.appendChild(status);
    body.appendChild(box);
  };

  const showOff = () => {
    clearCards();
    hideMsg();
    const box = el('div', 'embed-off');
    box.appendChild(el('div', 'embed-off-icon', '⏏️'));
    box.appendChild(el('div', 'embed-off-title', '已取消内置'));
    box.appendChild(el('div', 'embed-off-sub', meta.offHint
      || '这个面板不再内嵌页面（省一份 guest 进程和它的轮询）。要在这里看就点「🔗 内置」切回来；桌面那个窗口不受影响。'));
    const status = el('div', 'embed-fail-status', '');
    const row = el('div', 'embed-actions');
    if (launchPaths.length) {
      const lb = makeBtn(meta.launchLabel || '🖥 桌面启动', '按场景 json 里配的启动器把桌面程序拉起来', 'file-refresh embed-btn');
      lb.addEventListener('click', () => launch(status));
      row.appendChild(lb);
    }
    const openBtn = makeBtn('🌐 浏览器打开', '在系统浏览器打开（要放大时用）', 'file-refresh embed-btn');
    openBtn.addEventListener('click', () => { if (A && A.openPath) A.openPath(url); else window.open(url, '_blank'); });
    row.appendChild(openBtn);
    const backBtn = makeBtn('🔗 内置', '把这个页面嵌回面板', 'file-refresh embed-btn');
    backBtn.addEventListener('click', () => setEmbedded(true));
    row.appendChild(backBtn);
    box.appendChild(row);
    box.appendChild(status);
    body.appendChild(box);
  };

  const setEmbedded = (on) => {
    embedded = !!on;
    remember(embedded);
    if (toggleBtn) {
      toggleBtn.textContent = embedded ? '⛔ 取消内置' : '🔗 内置';
      toggleBtn.title = embedded ? '不再把这个页面嵌在面板里（省资源，随时可切回）' : '把这个页面嵌回面板';
      toggleBtn.classList.toggle('embed-toggle-off', !embedded);
    }
    if (reloadBtn) reloadBtn.style.display = embedded ? '' : 'none';
    if (embedded) { hideMsg(); mount(); } else { unmount(); showOff(); }
  };

  // ---- 标题行按钮：桌面启动 · 内置开关 · 刷新 · 浏览器打开 ----
  let toggleBtn = null;
  let reloadBtn = null;
  if (head) {
    const acts = el('div', 'file-head-acts');
    if (launchPaths.length) {
      const launchBtn = makeBtn(meta.launchLabel || '🖥 桌面启动', '把桌面那个程序拉起来（等价双击桌面快捷方式）');
      launchBtn.addEventListener('click', () => launch(null));
      acts.appendChild(launchBtn);
    }
    if (meta.embedToggle !== false) {
      toggleBtn = makeBtn('⛔ 取消内置', '');
      toggleBtn.addEventListener('click', () => setEmbedded(!embedded));
      acts.appendChild(toggleBtn);
    }
    reloadBtn = makeBtn('🔄 刷新', '重新加载这个页面');
    reloadBtn.addEventListener('click', () => {
      if (!wv) { mount(); return; }
      retryLeft = 0;
      stopRetry();
      try { wv.reload(); } catch (e) { /* ignore */ }
    });
    acts.appendChild(reloadBtn);
    const openBtn = makeBtn('🌐 浏览器打开', '在系统浏览器打开（要放大、要登录时用）');
    openBtn.addEventListener('click', () => {
      if (A && A.openPath) A.openPath(url);
      else window.open(url, '_blank');
    });
    acts.appendChild(openBtn);
    head.appendChild(acts);
  }

  if (!url) { showMsg('这个面板没有配置 url。'); return () => { disposed = true; stopRetry(); }; }

  setEmbedded(embedded);   // 按记下来的状态进入：内置 or 取消内置

  return () => { disposed = true; stopRetry(); };
};
