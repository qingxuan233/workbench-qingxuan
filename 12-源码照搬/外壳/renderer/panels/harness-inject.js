// panels/harness-inject.js —— harness 面板的「精简注入」套件（P2 预算拆分：从 panel-harness.js 抽出）
//
// 职责：注入 CSS + HARNESS_FIX_JS/DROP_JS、注入后读回布局并告警（[wv:inject] ✗ 精简失败 + inject-warnings.log
// 一次性写）、__fixDiag/__pinDiag 解析、标题行状态小字、30s 主进程兜底 + 5s 钉住重注入、cleanup。
//
// 对外：脚本级全局 `makeHarnessInject(ctx)` 工厂（**不包 IIFE**，与其它 panels 同款全局作用域）。
// ctx = {
//   getWv():        () => <当前 webview|null>（load() 会重建 webview，必须每次现取，不能传死引用）
//   panelKey:       PANEL_KEY（Shift+点击清绑定的键名后缀）
//   isDisposed():   () => disposed（场景切换后定时器/注入立即停）
//   onReload():     标题行 🔄 点击 → 重新加载（有 wv 就重设 src，否则调 panel 的 load()）
//   pinJs:          HARNESS_PIN_JS（钉会话脚本；嵌进 fixJs + 5s 重注入）
//   dropJs:         HARNESS_DROP_JS（拖文件脚本）
// }
// 返回 { reloadBtn, diag, injectFix, mainInject, startTimers, stop }；panel-harness 只把按钮/小字挂到标题行。

var APP = window.APP_RENDERERS || (window.APP_RENDERERS = {});

function makeHarnessInject(ctx) {
  const getWv = () => ctx.getWv();
  const reloadBtn = el('button', 'file-refresh', '🔄 重新加载');
  reloadBtn.title = '重新加载对话窗口';
  reloadBtn.addEventListener('click', () => ctx.onReload());
  const diag = el('span', 'harness-diag', '精简模式：注入中…');
  diag.style.cursor = 'pointer';
  diag.addEventListener('click', (ev) => {
    try {
      const wv = getWv();
      if (!wv || !wv.executeJavaScript) return;
      if (!(ev && ev.shiftKey)) {
        // 清掉软刷新/直达通道的计数，让重载后还能再试几次（否则额度用光就永远不重载了）
        const soft = "try{sessionStorage.removeItem('app_pin_soft_reloads');sessionStorage.removeItem('app_pin_reloads');}catch(e){}; 'ok'";
        wv.executeJavaScript(soft).then(() => { try { wv.reload(); } catch (e) { /* ignore */ } }).catch(() => { try { wv.reload(); } catch (e) { /* ignore */ } });
        return;
      }
      // 只清本面板的绑定（键名带面板 id），别把其它 AI 面板的记忆一起清掉
      const js = "try{localStorage.removeItem('app_pin_bind_v2:" + ctx.panelKey + "')}catch(e){}; 'ok'";
      wv.executeJavaScript(js)
        .then(() => { try { wv.reload(); } catch (e) { /* ignore */ } })
        .catch(() => { /* ignore */ });
    } catch (e) { /* ignore */ }
  });
  const chatCss = (ENGINE_ADAPTER && ENGINE_ADAPTER.chatCss) ? ENGINE_ADAPTER.chatCss({ centerColFix: false }).join('\n') : '';
  const fixJs = (ENGINE_ADAPTER && ENGINE_ADAPTER.fixJs) ? ENGINE_ADAPTER.fixJs({ profile: 'renderer', pinJs: ctx.pinJs }) : '';
  const injectFix = async () => {
    try { await getWv().insertCSS(chatCss); } catch (e) { /* ignore */ }
    // 拖文件进对话窗口（幂等脚本，装上监听后重复执行只返回）
    try { await getWv().executeJavaScript(ctx.dropJs); } catch (e) { /* ignore */ }
    let simplify = '';
    let wideTxt = '';
    try {
      const r = await getWv().executeJavaScript(fixJs);
      let info = null;
      try { info = JSON.parse(r); } catch (e) { /* ignore */ }
      if (info && info.found) {
        simplify = '精简 ✓';
        // 路线A（2026-11-08）：注入后**读回布局**，不达标要响：console.warn + 一次性写 外壳/data/inject-warnings.log
        const sb = info.sidebar || null;
        const drawerVis = (info.drawer || []).filter((d) => d && d.vis && d.disp !== 'none' && Number(d.op || 1) > 0).length;
        const badSide = !!sb && (sb.w > 2 || sb.vis === true) && !(Number(sb.x) < 0);
        const badDrawer = drawerVis > 0;
        const badChat = Number(info.chatW || 0) < Math.max(0, Number(info.chatAvailW || info.winW || 0) - 32);
        if (badSide || badDrawer || badChat) {
          const key = 'sidebar=' + (sb ? (sb.w + 'px/' + (sb.vis ? 'visible' : 'hidden') + ' x=' + sb.x) : 'none')
            + ' · drawerVis=' + drawerVis + '/' + (info.drawer || []).length
            + ' · chat=' + (info.chatW || 0) + '/' + (info.winW || 0) + 'px';
          try { console.warn('[wv:inject] ✗ 精简失败 ' + key); } catch (e) { /* ignore */ }
          if (!window.__kunInjectWarned) {
            window.__kunInjectWarned = 1;   // 只写一次，不刷屏
            try {
              const PP = (window.app && window.app.paths) || {};
              const dir = String(PP.dataDir || '').replace(/\\/g, '/');
              if (dir && window.app && window.app.file && window.app.file.write) {
                window.app.file.write(dir + '/inject-warnings.log',
                  new Date().toISOString() + ' [wv:inject] ✗ 精简失败 ' + key + '\n');
              }
            } catch (e) { /* ignore */ }
          }
        }
      } else if (info) simplify = '等界面…';
      // 铺满实测（例 `铺满 1列 1576/1592px`）：两者只差十几像素（我们留的那 16px）就是铺开了；
      // 还差几百像素说明页面里没有 [data-chat-flow]（引擎换版了）——见文件上方「会话列铺满」。
      if (info && info.wide) { simplify += (simplify ? ' · ' : '') + '铺满 ' + info.wide; wideTxt = info.wide; }
    } catch (e) { /* ignore */ }
    // 钉会话诊断：HARNESS_PIN_JS 每次注入都会刷新 window.__pinDiag，这里读回来显示在面板标题行
    let pinTxt = '钉会话: 检测中…';
    try {
      const d = await getWv().executeJavaScript('window.__pinDiag || null');
      if (d && d.targets) {
        const want = [String(d.sessionTitle || '')].filter(Boolean).concat(d.targets || []).join(' / ');
        const nz = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();   // ⚠ 保留空格：别把 'DSH 改造' 和 'DSH改造' 混成一个（同名孪生会话）
        // 面板当前显示的会话名（取自侧栏高亮行标题，权威）作为最终判据
        const live = String(d.title || '');
        const liveN = nz(live);
        const okName = (!!d.sessionTitle && liveN === nz(d.sessionTitle)) ||
          (d.targets || []).some(t => { const tn = nz(t); return tn && liveN.indexOf(tn) >= 0; });
        const boundOk = !!(d.bound && d.bound.title && liveN === nz(d.bound.title));
        const ok = boundOk || okName;
        // 侧栏行一条都读不到时（面板窄/分组折叠/应用还没渲染列表），标题证据必然失效 ——
        // 这时如果引擎自己记的当前会话 id 就等于指定 id，**只把状态小字**改说"按存储核对"，
        // 钉会话的动作照旧（下面 clickItem 仍然每轮尝试），不动"画面才是唯一判据"那条铁律。
        const storeOk = !!(d.sessionId && d.stored && String(d.stored) === String(d.sessionId));
        const unbound = !d.sessionId && !d.sessionTitle && !(d.targets || []).length && !(d.bound && d.bound.title);
        // ★2026-11-07★ 状态小字必须如实：存储一致 ≠ 画面已切过去。
        //   旧文案在 storeOk 时直接报「✓ 已切到（存储核对）」，而画面可能还停在欢迎页/上一条会话
        //   （用户实见：状态 ✓、面板是「探索未至之境」）⇒ 现在把三种情形分开写。
        pinTxt = unbound ? '○ 未绑定 · 面板自由选会话'
          : (boundOk ? '✓ 已钉绑定'
            : (ok ? '✓ 已钉'
              : (storeOk
                ? (d.welcome ? '⚠ 存储已指向 · 画面还是欢迎页（点此刷新）' : '⚠ 存储已指向 · 画面未切（点此刷新）')
                : ('未切到 · ' + (live || (d.welcome ? '欢迎页' : '读不到当前会话'))))));
        if (unbound) diag.title = '该面板未绑定任何会话（场景 json 里没写 sessionTitle / sessionId / pinTarget）\n' +
          '面板停在它当前显示的会话上，不会被自动切换，也不再去找侧栏。\n' +
          '要重新绑定：给该面板补 sessionTitle + sessionId，再切一次场景即可（改了就会立刻生效）。';
        else diag.title = '该面板应对应的会话：' + want +
          '\n指定会话 id：' + (d.sessionId || '（未指定 · 靠标题匹配）') +
          '\n应用存储里的当前会话：' + (d.stored || '（空）') + (String(d.stored) === String(d.sessionId) && d.sessionId ? ' ✓ 一致' : '') +
          (d.reloads ? ('\n直达通道重载计数 ' + d.reloads + ' 次（上限 ' + (d.reloadMax || 5) + '）') : '') +
          (d.softReloads ? ('\n"键对了画面没跟上"的软刷新计数 ' + d.softReloads + ' 次（上限 2）') : '') +
          (d.welcome ? '\n画面状态：**欢迎页 / 选择工作区页**（引擎还没打开任何会话）' : '') +
          '\n面板当前显示的会话：' + (live || '（读不到）') + (d.titleSrc ? ('（来源：' + d.titleSrc + '）') : '') +
          (d.bound && d.bound.title ? ('\n已记住的会话标题：' + d.bound.title) : '\n已记住的会话标题：（无 · 首次按名字找）') +
          '\n界面可识别会话行/选中行数：' + (d.rows == null ? '未知' : d.rows) +
          (d.matched ? ('\n已定位到会话行：' + d.matched + '（' + d.by + '）') : '\n未定位到目标会话行（分组折叠或列表未渲染）') +
          (d.cands && d.cands.length ? ('\n界面里能看到的会话/行：' + d.cands.join(' ｜ ')) : '\n界面里能看到的会话/行：（读不到）') +
          (storeOk && !ok ? ('\n↑ 「应用存储」里的当前会话已经等于指定 id，但画面没落在该会话上（' +
            (d.welcome ? '停在欢迎页' : '标题还没变成目标会话') + '）。\n'
            + '  面板会在写入后自动重载一次；仍不行就点这里刷新（点击 = 重新加载并按当前绑定再钉一次）。') : '') +
          (wideTxt ? ('\n会话列铺满：' + wideTxt + '（列宽 / 可用宽；只差十几像素＝已铺满，差几百＝没铺上，多半引擎换版了）') : '') +
          '\n\n点击此处 = 重新加载并按当前绑定再钉一次；Shift + 点击 = 忘掉记住的标题、重新按会话名匹配';
      }
    } catch (e) { /* ignore */ }
    diag.textContent = (simplify ? simplify + ' · ' : '') + pinTxt;
  };
  // 主进程通道注入（更可靠）：轮询 webview 的 webContentsId，让 main 直接注入并写日志
  // ⚠ 注意：main.js 注入脚本里**旧版**还带一套"扫全文档模糊匹配后点击"的钉会话循环
  //   （每 4s 点一次），它会和渲染层的新逻辑打架 —— 渲染层刚钉对，它又把面板点到
  //   聊天记录里含同名字样的随便一个元素上，于是"切场景后会话错乱/切不过去"。
  //   这里固定传一个**绝不可能匹配到任何元素**的哨兵目标（NUL 字符不会出现在任何 textContent 里），
  //   于是 main 侧只保留"注入布局修复 + 截图 + 日志"，点击权完全交给本文件的 HARNESS_PIN_JS。
  const mainInject = () => {
    try {
      const wv = getWv();
      if (!wv || !wv.getWebContentsId) return;
      const id = wv.getWebContentsId();
      if (id === -1 || typeof window.app.injectHarnessPanel !== 'function') return;
      window.app.injectHarnessPanel(id, '\u0000no-pin\u0000');
    } catch (e) { /* ignore */ }
  };
  let hostTimer = null, pinTimer = null;
  function startTimers() {
    hostTimer = setInterval(() => {
      if (ctx.isDisposed()) return;
      const wv = getWv();
      if (!wv || !wv.getWebContentsId) return;
      if (wv.getWebContentsId() === -1) return;
      mainInject();
      injectFix();
    }, 1500);
    setTimeout(() => { if (hostTimer) clearInterval(hostTimer); }, 30000);
    pinTimer = setInterval(() => {
      if (ctx.isDisposed()) return;
      const wv = getWv();
      try { if (wv && wv.executeJavaScript) wv.executeJavaScript(ctx.pinJs + '\n' + ctx.dropJs).catch(function () { }); } catch (e) { /* ignore */ }
    }, 5000);
  }
  function stop() { if (hostTimer) clearInterval(hostTimer); if (pinTimer) clearInterval(pinTimer); }
  return { reloadBtn, diag, injectFix, mainInject, startTimers, stop };
}
