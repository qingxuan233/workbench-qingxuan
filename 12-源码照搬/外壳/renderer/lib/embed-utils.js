// renderer/lib/embed-utils.js —— embed 面板支持区（P2-D 阶段3a 从 renderers.js 1583-2092 逐字搬出）
//
// 内容：resolveEmbedUA / startBiliTrack / startBiliProbe（3 个脚本级全局 helper）
//       + bootAnimRegistry / localModelTopbar（2 个自包含 IIFE；只用 window/DOM，无外部符号引用）。
//
// 约定：
//   · **不包 IIFE**：3 个 helper 保持脚本级 function 全局声明，renderers.js 的 embed/harness 等在**调用期**直接引用；
//   · 加载顺序：engine-adapter/contract.js → **lib/embed-utils.js** → panels/* → chrome.js →
//     renderers.js → renderer.js → topbar-status.js（本文件比 renderers.js 先加载，但只在调用期被用到）；
//   · 本文件不参与「⟳ 热更新」（⟳ 只重跑 renderers.js），因此两个 IIFE 的定时器不会因 ⟳ 反复执行而累积；
//     20 秒状态刷新仍按既有约定挂 window 级守卫（window.__localModelRefreshTimer），防未来被热加载时攒定时器。
// ============ embed：把"本机自带的网页工具"整页内嵌进面板（<webview>） ============
// 首个用户：视频工作流 窗口1 = ComfyUI 控制台（http://127.0.0.1:8189/，bridge.py 起的本地页面）。
// 为什么用 <webview> 而不是 iframe：与 harness / 官网预览一致，guest view 独立进程更稳，
// 且能带自己的 partition（一板一分区），不和引擎面板串味。
//
// 配置（都在场景 json 的面板对象里，全是选填、缺省即"没有这个按钮"）：
//   meta.url          必填，要内嵌的页面
//   meta.failHint     连不上时卡片里的一句话排查提示
//   meta.launchPath   桌面启动器的路径（快捷方式/exe）：点「🖥 桌面启动」就用宿主能力打开它
//   meta.launchLabel  桌面启动按钮文字（默认「🖥 桌面启动」）
//   meta.launchHint   点完桌面启动后卡片里显示的那句话
//   meta.embedToggle  false = 不显示「内置/取消内置」按钮（默认显示）
//   meta.offHint      「取消内置」后卡片里的说明（默认一句通用说明）
// 为什么桌面启动不用新开 IPC：宿主通用能力 app:open-path 走 shell.openPath（= ShellExecute），
// 传桌面 .lnk 就等价于双击快捷方式，所以这条路不用重启 GUI 就能加。
//
// 「内置 / 取消内置」（2026-09-20 加，用户要求"比较灵活"）：取消内置 = 把 <webview> 真的摘掉
// （不是隐藏）——不再有 guest 进程、也不会有第二份轮询；选择记在 localStorage，⟳/切场景都记得住。
// 内嵌页面的 UA：Electron 默认 UA 尾巴上挂着 "Electron/43.4.0"，有的站点一看就把页面盖成
// 「使用环境异常 / 建议使用我们的官方产品」弹窗（DeepSeek 网页版 2026-09-20 实测如此）。
// meta.userAgent 写 "chrome" ⇒ 换成一条**纯 Chrome UA**，Chrome 版本取当前 Electron 真实内核版本
// （process.versions.chrome，不写死、不撒谎）；也可以直接写完整 UA 字符串；不写 = 不动（用默认）。
// 为什么用函数声明而不是顶层 const/let：renderers.js 会被反复 ⟳ 重新求值，顶层 const 会重复声明报错。
function resolveEmbedUA(v) {
  if (!v) return '';
  if (v !== 'chrome' && v !== true) return String(v);
  var ver = '';
  try { ver = (typeof process !== 'undefined' && process.versions && process.versions.chrome) || ''; } catch (e) { ver = ''; }
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/'
    + (ver || '<IP>') + ' Safari/537.36';
}

// ==========================================================================================
// 2026-10-19 22:5x（宿主：「左边点开视频，右边直接说『总结这个』就行」· dg-dsh 派单）
//   当前视频同步：只在 **B站场景的 embed 面板** 上，每 1.5s 看一次 webview 的 URL，
//   抽 BV 号 + document.title，写到 `引擎\场景项目信息\B站\当前视频.json`（AI 侧已约定读它）。
//   ⛔ 不动 src / 不 reload / 不往页面里注入；⛔ 只在内容变化时写盘；⛔ 只认 bilibili 场景。
//   ⛔ 失败一律静默（同步挂了绝不影响看视频）。
// ==========================================================================================
function startBiliTrack(wv, meta) {
  try {
    var scene = String((meta && meta.scenario) || '');
    if (scene !== 'bilibili') return;                        // 别的场景嵌网页一律不装
    if (window.__biliTrack && window.__biliTrack.stop) window.__biliTrack.stop();   // 幂等：只跑一个
    var OUT = ((window.app && window.app.paths && window.app.paths.memRoot) || '') + '\\B站\\当前视频.json';
    var last = '', timer = null, alive = true, seenInDoc = false;
    function iso() {
      var d = new Date();
      var off = -d.getTimezoneOffset(), oh = Math.floor(Math.abs(off) / 60), om = Math.abs(off) % 60;
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' +
        p(d.getMinutes()) + ':' + p(d.getSeconds()) + (off >= 0 ? '+' : '-') + p(oh) + ':' + p(om);
    }
    function write(bv, url, title) {
      if (!url) return;                                       // webview 还没就绪 ⇒ 不写（免得刷一堆空记录）
      // ⚠ 2026-10-19 自查修的 bug：原来拿**整个 JSON**（含 at）比 ⇒ 每轮都不同 ⇒ 一直在刷盘。
      //   现在只比 bv+url+title；at 只记"这次写入的时间"。
      var key = String(bv) + '|' + url + '|' + String(title || '');
      if (key === last) return;
      var txt = JSON.stringify({ bv: bv, url: url, title: String(title || ''), at: iso() });
      // （内容没变已在上面按 key 拦掉；这句保留只为兼容旧注释，不会命中）
      last = key;
      try {
        if (window.app && window.app.file && window.app.file.write) {
          Promise.resolve(window.app.file.write(OUT, txt + '\n')).catch(function () { /* 静默 */ });
        }
      } catch (e) { /* 静默 */ }
    }
    function stop() { alive = false; if (timer) { clearInterval(timer); timer = null; } window.__biliTrack = null; }
    function tick() {
      if (!alive) return;
      var inDoc = document.body.contains(wv);
      if (inDoc) seenInDoc = true;                                  // 挂上过一次才算“活过”
      else if (seenInDoc) { stop(); return; }                       // 曾经挂上 → 现在没了 ⇒ 面板销毁/场景切走
      else return;                                                 // 还没挂上 ⇒ 先等（别把自己判死）
      var url = '';
      try { url = (wv.getURL && wv.getURL()) || ''; } catch (e) { url = ''; }
      if (!url) return;
      var m = /\/video\/(BV[0-9A-Za-z]+)/.exec(url);
      var bv = m ? m[1] : null;
      var done = function (t) { if (alive) write(bv, url, t); };
      // 2026-10-19 自查修：原来首页直接 done('') 不取 title ⇒ 文件里 title 永远是空串。
      //   现在统一走下面的"取 title"路径（bv=null 也照样取，契约里两态都有 title）。
      try {
        Promise.resolve(wv.executeJavaScript('document.title')).then(function (t) { done(t); }).catch(function () { done(''); });
      } catch (e) { done(''); }
    }
    timer = setInterval(tick, 1500);
    window.__biliTrack = { stop: stop, at: Date.now(), out: OUT };
    // 2026-10-19 23:4x（宿主：打字/滚动/选中都行，就是点了不跳转）——**换方式**：不依赖弹窗策略，
    //   直接在页面里接管"新窗口链接"：点 a[target=_blank] ⇒ 当前页面打开（location.href）。幂等、失败静默。
    var LINKFIX = '(function(){try{if(window.__dshLinkFix)return "ok";window.__dshLinkFix=1;'
      + 'document.addEventListener("click",function(e){try{'
      + 'var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;'
      + 'var h=a.getAttribute("href")||"";'
      + 'if(!h||h==="#"||h.indexOf("javascript:")===0||h.indexOf("#")===0)return;'
      + 'if(a.target==="_blank"||!a.target){e.preventDefault();location.href=a.href;}'
      + '}catch(_){}},true);return "ok";}catch(e){return "err";}})()';
    function installLinkFix() {
      try { Promise.resolve(wv.executeJavaScript(LINKFIX)).catch(function () {}); } catch (e) { /* ignore */ }
    }
    try { wv.addEventListener('did-finish-load', function () { installLinkFix(); }); } catch (e) {}
    installLinkFix();
    tick();
    if (window.console) console.log('[biliTrack] 已启动 ⇒ ' + OUT);
  } catch (e) { /* 静默 */ }
}

// ==========================================================================================
// 2026-10-19 23:2x（bv-ai 派单）—— 临时点击探针，用来判断"点击到底进没进 guest"
//   写到 `引擎\场景项目信息\B站\_点击探针.json`（⚠ 临时文件，定位完就删；不污染 AI 认的 当前视频.json）
//   采：① guest 内的 document 级 click 计数与最近一次 target ② a[target=_blank] 数量
//       ③ 屏幕中心点 elementFromPoint（guest 内）④ 同一位置在**宿主页面**里的 elementFromPoint（看有没有东西盖住 webview）
// ==========================================================================================
function startBiliProbe(wv, meta) {
  try {
    if (String((meta && meta.scenario) || '') !== 'bilibili') return;
    if (window.__biliProbe && window.__biliProbe.stop) window.__biliProbe.stop();
    var OUT = ((window.app && window.app.paths && window.app.paths.memRoot) || '') + '\\B站\\_点击探针.json';
    var last = '', timer = null, alive = true, seen = false, injected = false;
    var INJECT = '(function(){try{if(window.__dshProbe)return "exists";window.__dshProbe={n:0,last:""};'
      + 'document.addEventListener("click",function(e){try{window.__dshProbe.n++;var el=e.target||{};'
      + 'var t=(el.tagName||"?")+"#"+(el.id||"")+"."+String(el.className||"");window.__dshProbe.last=t.slice(0,140);}catch(_){}} ,true);'
      + 'return "ok";}catch(e){return "err:"+String(e&&e.message||e);}})()';
    var READ = '(function(){try{var p=window.__dshProbe||{};'
      + 'var a=document.querySelectorAll("a[target=_blank]").length;'
      + 'var el=null;try{el=document.elementFromPoint((innerWidth||800)/2,(innerHeight||600)/2);}catch(_){}'
      + 'var mid=el?((el.tagName||"?")+"#"+(el.id||"")+"."+String(el.className||"")):"";'
      + 'return JSON.stringify({clicks:p.n||0,last:p.last||"",ab:a,mid:mid.slice(0,140)});'
      + '}catch(e){return JSON.stringify({err:String(e&&e.message||e)});}})()';
    function stop() { alive = false; if (timer) { clearInterval(timer); timer = null; } window.__biliProbe = null; }
    function tick() {
      if (!alive) return;
      var inDoc = document.body.contains(wv);
      if (inDoc) seen = true; else if (seen) { stop(); return; } else return;
      if (!injected) { injected = true; try { Promise.resolve(wv.executeJavaScript(INJECT)).catch(function () {}); } catch (e) {} }
      var r = null;
      try { r = wv.getBoundingClientRect(); } catch (e) { r = null; }
      var top = '', rect = '';
      if (r && r.width > 8 && r.height > 8) {
        rect = Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.width) + 'x' + Math.round(r.height);
        try {
          var he = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          top = he ? (String(he.tagName || '?').toLowerCase() + '#' + (he.id || '') + '.' + String(he.className || '')) : '';
        } catch (e) { top = 'err'; }
      }
      try {
        Promise.resolve(wv.executeJavaScript(READ)).then(function (s) {
          var g = {};
          try { g = JSON.parse(String(s || '{}')); } catch (e) { g = { parse: 'fail' }; }
          var obj = { at: Date.now(), clicks: g.clicks || 0, last: g.last || '', ab: g.ab, mid: g.mid || '',
                      hostTop: top, rect: rect, pe: (wv.style.pointerEvents || '(none-set)'), op: (wv.style.opacity || '(none-set)') };
          var txt = JSON.stringify(obj);
          if (txt !== last) {
            last = txt;
            try { if (window.app && window.app.file && window.app.file.write) Promise.resolve(window.app.file.write(OUT, txt + '\n')).catch(function () {}); } catch (e) {}
          }
        }).catch(function () {});
      } catch (e) { /* 静默 */ }
    }
    timer = setInterval(tick, 1500);
    window.__biliProbe = { stop: stop, out: OUT };
    tick();
  } catch (e) { /* 静默 */ }
}

// ==========================================================================================
// 2026-10-19 23:2x（宿主：启动动画要可选）—— 外壳侧"播放层"
//   ① 启动时读 <盘根>:\DSH\外壳\data\boot-animation.json 的 id ⇒ 给 #boot-overlay 加 data-anim
//      （文件不存在/坏了 ⇒ 一律回落 classic，⛔ 绝不让启动失败）
//   ② window.__bootPreview(id)：把 overlay 亮出来按 id 播一遍，1.8 秒后收起（给插件点选用）
//   ⛔ 不碰 boot 逻辑（__bootPaint / __bootFinish / 超时 / 重试全在 renderer.js，一个字没动）
// ==========================================================================================
(function bootAnimRegistry() {
  var CFG = ((window.app && window.app.paths && window.app.paths.bootCfg) || '');
  // 2026-10-20（宿主：把片头视频做成启动动画）—— 视频铺满 overlay（muted 自动播放才允许），
  //   其余（底部光带/百分比/立即进入）由 CSS 叠在上面；只在 id=video 时挂，别的动画会把它摘掉。
  function ensureBootVideo(id) {
    try {
      var ov = document.getElementById('boot-overlay');
      if (!ov) return;
      var v = ov.querySelector('.boot-video');
      // 2026-10-20：支持多个视频动画 —— 按 id 选文件（video=线条睁眼鲸鱼 3D · slogan=为理想奋斗）
      var VID_SRC = {
        video: '../renderer/assets/boot-video.mp4',
        slogan: '../renderer/assets/boot-video-slogan.mp4'
      };
      var want = VID_SRC[id] || '';
      if (!want) { if (v) v.remove(); return; }
      if (v && v.getAttribute('data-anim-src') === want) { try { v.currentTime = 0; v.play(); } catch (e) {} return; }
      if (v) { try { v.remove(); } catch (e) {} v = null; }
      var el2 = document.createElement('video');
      el2.className = 'boot-video';
      el2.setAttribute('data-anim-src', want);
      el2.src = want;
      el2.autoplay = true; el2.muted = true; el2.playsInline = true;
      el2.setAttribute('muted', '');
      el2.setAttribute('playsinline', '');
      ov.insertBefore(el2, ov.firstChild);
      try { el2.play(); } catch (e) { /* 自动播放被拒也没关系，画面会在下次交互开始 */ }
    } catch (e) { /* 静默 */ }
  }
  // 2026-10-21（宿主：ideal 只有一屏太单一）—— 新动画 ideal2「星火 · 钢铁 · 理想」三幕轮播。
  //   画在 overlay 上（不进 .boot-card，免得跟进度条的 flex 布局打架）；id 不是 ideal2 就把这块摘掉。
  var BA_HTML = [
    '<div class="ba-act ba1">',
    '  <div class="ba-emblem"></div>',
    '  <div class="ba-spark s1"></div><div class="ba-spark s2"></div><div class="ba-spark s3"></div>',
    '  <div class="ba-spark s4"></div><div class="ba-spark s5"></div><div class="ba-spark s6"></div>',
    '  <div class="ba-quote">为理想而奋斗</div>',
    '  <div class="ba-sub">星星之火，可以燎原</div>',
    '</div>',
    '<div class="ba-act ba2">',
    '  <div class="ba-cam">',
    '    <div class="ba-flagStage">',
    '      <div class="ba-flag">',
    '        <div class="ba-strips"></div>',
    '        <div class="ba-shade"></div>',
    '        <svg class="ba-sketch" viewBox="0 0 480 320" fill="none" stroke="#ffd9a9" stroke-width="2.6" stroke-linejoin="round" aria-hidden="true">',
    '          <rect class="ba-draw" x="2" y="2" width="476" height="316" stroke-dasharray="1590" stroke-dashoffset="1590"/>',
    '          <polygon class="ba-draw d2" points="80.0,32.0 90.8,65.2 125.7,65.2 97.4,85.7 108.2,118.8 80.0,98.3 51.8,118.8 62.6,85.7 34.3,65.2 69.2,65.2" stroke-dasharray="330" stroke-dashoffset="330"/>',
    '          <polygon class="ba-draw d3" points="146.3,40.2 153.9,31.5 147.9,21.5 158.6,26.0 166.3,17.3 165.2,28.9 175.9,33.4 164.6,36.0 163.6,47.6 157.6,37.6" stroke-dasharray="120" stroke-dashoffset="120"/>',
    '          <polygon class="ba-draw d3" points="176.2,66.3 186.6,61.1 185.0,49.6 193.0,58.0 203.5,52.9 198.1,63.1 206.1,71.5 194.7,69.5 189.3,79.8 187.6,68.3" stroke-dasharray="120" stroke-dashoffset="120"/>',
    '          <polygon class="ba-draw d3" points="176.6,107.6 188.2,107.2 191.4,96.0 195.4,106.9 207.0,106.5 197.9,113.7 201.9,124.6 192.2,118.1 183.1,125.3 186.3,114.1" stroke-dasharray="120" stroke-dashoffset="120"/>',
    '          <polygon class="ba-draw d3" points="147.5,134.0 158.4,138.1 165.6,129.0 165.1,140.6 176.0,144.7 164.8,147.8 164.2,159.4 157.8,149.7 146.6,152.8 153.9,143.7" stroke-dasharray="120" stroke-dashoffset="120"/>',
    '        </svg>',
    '      </div>',
    '    </div>',
    '  </div>',
    '  <div class="ba-call">中华人民共和国万岁</div>',
    '  <div class="ba-sub">一九四九年 · 十月一日</div>',
    '</div>'
  ].join('');
  // ⚠ 动画 DOM 有版本号：改了 BA_HTML 就把 ART_VER 一起改，⟳ 热更新时才能把**旧 DOM** 换掉。
  //   （踩过的坑：只加"有就跳过"的幂等判断 ⇒ 热更新后页面上还是上一版的三幕，新旧文案叠在一起。）
  var ART_VER = '2026-10-21-i';
  // 2026-10-21 宿主：「随风飘要做得像真的」—— 旗帜改成 **40 条竖条**，每条只做上下位移、
  //   相位依次错开、振幅从旗杆那头（1px）到旗尾（13px）递增 ⇒ 看起来像布料在风里行走的波。
  //   这里的 SVG 只用来给每条当背景图（480×320 的旗面），条纹靠 background-position 切。
  var BA_FLAG_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 320">'
    + '<rect width="480" height="320" fill="#e21b1b"/>'
    + '<polygon points="80.0,32.0 90.8,65.2 125.7,65.2 97.4,85.7 108.2,118.8 80.0,98.3 51.8,118.8 62.6,85.7 34.3,65.2 69.2,65.2" fill="#ffde00"/>'
    + '<polygon points="146.3,40.2 153.9,31.5 147.9,21.5 158.6,26.0 166.3,17.3 165.2,28.9 175.9,33.4 164.6,36.0 163.6,47.6 157.6,37.6" fill="#ffde00"/>'
    + '<polygon points="176.2,66.3 186.6,61.1 185.0,49.6 193.0,58.0 203.5,52.9 198.1,63.1 206.1,71.5 194.7,69.5 189.3,79.8 187.6,68.3" fill="#ffde00"/>'
    + '<polygon points="176.6,107.6 188.2,107.2 191.4,96.0 195.4,106.9 207.0,106.5 197.9,113.7 201.9,124.6 192.2,118.1 183.1,125.3 186.3,114.1" fill="#ffde00"/>'
    + '<polygon points="147.5,134.0 158.4,138.1 165.6,129.0 165.1,140.6 176.0,144.7 164.8,147.8 164.2,159.4 157.8,149.7 146.6,152.8 153.9,143.7" fill="#ffde00"/>'
    + '</svg>';
  function buildFlagStrips(root) {
    try {
      var box = root && root.querySelector ? root.querySelector('.ba-strips') : null;
      if (!box || box.getAttribute('data-built') === '1') return;
      var uri = 'data:image/svg+xml;base64,' + btoa(BA_FLAG_SVG);   // 纯 ASCII，btoa 安全
      // 2026-10-21：旗面放大到 640×427 ⇒ 80 条 × 8px、振幅 1~17px（越靠旗尾甩得越大，才有"挥舞"感）
      var N = 80, STEP = 8, parts = [];
      for (var i = 0; i < N; i++) {
        var amp = (1 + 21 * i / (N - 1)).toFixed(1);
        parts.push('<div class="ba-strip" style="left:' + (i * STEP) + 'px;'
          // 竖条是 top:-20 / 高度 +40（上下留出位移余量）⇒ 背景也要往下补 20px，否则旗面整体上移 20px
          + "background-image:url('" + uri + "');background-position:-" + (i * STEP) + 'px 20px;'
          + '--amp:' + amp + ';animation-delay:-' + (i * 0.03).toFixed(2) + 's"></div>');
      }
      box.innerHTML = parts.join('');
      box.setAttribute('data-built', '1');
    } catch (e) { /* ignore */ }
  }
  function ensureBootArt(id) {
    try {
      var ov = document.getElementById('boot-overlay');
      if (!ov) return;
      var old = document.getElementById('boot-art');
      if (id !== 'ideal2') { if (old && old.parentNode) old.parentNode.removeChild(old); return; }
      if (old && old.getAttribute('data-ver') === ART_VER) return;   // 同版本：保留（重建会重启动画）
      if (old && old.parentNode) old.parentNode.removeChild(old);     // 旧版本：拆掉重建
      var d = document.createElement('div');
      d.id = 'boot-art';
      d.className = 'ba-stage';
      d.setAttribute('data-ver', ART_VER);
      d.innerHTML = BA_HTML;
      ov.appendChild(d);
      buildFlagStrips(d);
    } catch (e) { /* 静默 */ }
  }
  // 2026-10-22（宿主：切到别的场景后，启动动画预览就看不见了）——
  //   #boot-overlay 原本挂在 #harness-view 里面，一切场景那个 .view 就 display:none，遮罩跟着消失。
  //   这里把它**提到 body 上**（只提一次）并加 .lifted（position:fixed 盖满整窗）⇒ 任何页签下预览/启动进度都看得见。
  function liftOverlay() {
    var el = document.getElementById('boot-overlay');
    if (!el) return null;
    if (el.parentNode !== document.body) document.body.appendChild(el);
    el.classList.add('lifted');
    return el;
  }
  function apply(id) {
    try {
      var ov = liftOverlay();
      if (!ov) return false;
      ov.setAttribute('data-anim', String(id || 'classic'));
      ensureBootVideo(String(id || "classic"));
      ensureBootArt(String(id || 'classic'));
      return true;
    } catch (e) { return false; }
  }
  try {
    var F = window.app && window.app.file;
    if (F && F.read) {
      if (!window.__bpwTicks) window.__bpwTicks = 0; if (++window.__bpwTicks % 5 === 0) log('tick ' + window.__bpwTicks + ' hidden=' + document.hidden);
      Promise.resolve(F.read(CFG)).then(function (r) {
        var txt = (typeof r === 'string') ? r : ((r && (r.text || r.content)) || '');
        var id = 'classic';
        try { var j = JSON.parse(txt); if (j && j.id) id = String(j.id); } catch (e) { /* 坏文件 ⇒ classic */ }
        apply(id);
      }).catch(function () { apply('classic'); });
    }
  } catch (e) { /* 读配置失败 ⇒ 什么都不做 = classic */ }
  window.__bootPreview = function (id) {
    try {
      var ov = document.getElementById('boot-overlay');
      if (!ov) return false;
      var play = function (real) {
        var rid = String(real || 'classic');
        ov = liftOverlay() || ov;          // 预览也走"提 body"（切到别的场景同样看得见）
        ov.classList.remove('hide', 'err');
        ov.setAttribute('data-anim', rid);
        ensureBootVideo(rid);
        ensureBootArt(rid);
        window.__bootId = rid;
        if (window.__bootPaint) {
          window.__bootPaint({ stage: 'anim', pct: 42, text: '启动动画预览：' + rid, detail: '1.8 秒后自动收起' });
        }
        setTimeout(function () {
          try { if (window.__bootFinish) window.__bootFinish(); else ov.classList.add('hide'); } catch (e) { /* ignore */ }
        // 2026-10-21：视频 7.5s；三幕动画 ideal2 要 11s 才能看完三幕
        }, (rid === 'video') ? 7500 : ((rid === 'ideal2') ? 11000 : 1800));
      };
      if (id) { play(id); return true; }
      // 2026-10-19 23:5x（宿主：设置里改了但预览没变）—— 不传 id 时**现读一遍配置**：
      //   插件里刚点完卡片，菜单里的预览立刻就是新的（不用等下次启动）。
      var F = window.app && window.app.file;
      if (F && F.read) {
        Promise.resolve(F.read(CFG)).then(function (r) {
          var txt = (typeof r === 'string') ? r : ((r && (r.text || r.content)) || '');
          var cur = 'classic';
          try { var j2 = JSON.parse(txt); if (j2 && j2.id) cur = String(j2.id); } catch (e) { /* classic */ }
          play(cur);
        }).catch(function () { play(ov.getAttribute('data-anim') || 'classic'); });
      } else {
        play(ov.getAttribute('data-anim') || 'classic');
      }
      return true;
    } catch (e) { return false; }
  };
})();

// ==========================================================================================
// 2026-10-20（宿主：把常用网站的"智能抠图"做成**本地**工具）—— 场景「抠图」的主面板
//   引擎：本地 venv 里的 rembg（主进程 app.cut.run 起一次进程，算完就退，不常驻；图片不出本机）。
//   图片来源：① 左边「文件管理」里单击图片 ⇒ 走 window.__kunViews[面板id].show({path}) 送进来
//            ② 面板上的「选择图片…」(app.pickFile 系统对话框) ③ 直接把图片拖进来 (app.filePath)
//   输出：同目录 `<原名>_抠图.png`（带透明通道），旁边给 复制路径 / 定位 / 系统打开。
// ==========================================================================================
// 2026-10-20（宿主：「不要做成场景，做成一个小工具放在 CPU 左边，剪刀图标和其它图标风格一致」
//            + 「只有开始抠图吗，有没有橡皮或者扩选」）—— 顶栏「本地抠图」小工具
//   · 按钮：.titlebar-controls 里、负载胶囊（#tbs-load）**左边**；16px 线稿剪刀，与手机/月亮同一套 .tb-btn
//   · 弹层：居中（最宽 980、最高 88vh），左原图右结果 = 一块可精修的画布
//   · 引擎：<盘根>:\DSH\工具\抠图（rembg，离线）→ app.cut.run；读/存 PNG → app.cut.read / app.cut.write
//   · 精修（答宿主的问题：自动抠图只是第一步）：
//       橡皮擦 = 把不要的地方擦成透明；恢复笔 = 把擦掉/误抠的地方补回来（按自动结果的 alpha）
//       扩选 +N / 缩减 -N = 边缘整体外扩 / 内收 N 像素；羽化 N = 边缘过渡变软
//       撤销 / 重置（回到自动结果）/ 保存（覆盖 <原名>_抠图.png）/ 复制路径 / 定位
//   ⚠ 只有点过「✂ 自动抠图」之后才有画布可修；编辑全在本地 canvas，不联网。
// ==========================================================================================
/* 开源版：本地抠图入口已移除 */
// ==========================================================================================
// 2026-10-20（dg-dsh 派单）—— 顶栏「本地模型」开关（**只在主窗口**）
//   状态：app.localmodel.status() → {running,pid,vramFreeMb,modelReady}（亮=开 / 灰=关）
//   点击：app.localmodel.toggle()（脚本最多 90s：启动要等 /health + 真出字；启动中显示 loading）
//   悬停：本地 Qwen3-8B（GPU）· 显存空闲 N MB · 不用时关掉释放
//   失败：把脚本 stderr 最后一行弹出来（常见：显存不足 <5000MB）
//   ⛔ 不动引擎、不动 profile：只调 <盘根>:\DSH\工具\本地模型.mjs
// ==========================================================================================
(function localModelTopbar() {
  var LM = window.app && window.app.localmodel;
  // 只在主窗口（分离窗口是一窗一场景，别让这个开关重复出现）
  try { if (/[?&]solo=1/.test(location.search || '')) return; } catch (e) { return; }

  // ⟳ 重注入：把上一份按钮**全清掉**（可能不止一个：旧闭包的 place() 定时器会把摘下来的按钮再插回去）
  try {
    var olds = document.querySelectorAll('#btn-localmodel');
    for (var oi = 0; oi < olds.length; oi++) { if (olds[oi].parentNode) olds[oi].parentNode.removeChild(olds[oi]); }
  } catch (e) { /* ignore */ }
  window.__lmGen = (window.__lmGen || 0) + 1;
  var MY_GEN = window.__lmGen;

  var ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
    + '<rect x="2.7" y="2.7" width="10.6" height="10.6" rx="2.2" stroke="currentColor" stroke-width="1.25"/>'
    + '<rect x="5.5" y="5.5" width="5" height="5" rx="1.1" stroke="currentColor" stroke-width="1.25"/>'
    + '<path d="M6.4 2.7V1.3M9.6 2.7V1.3M6.4 14.7v-1.4M9.6 14.7v-1.4M2.7 6.4H1.3M2.7 9.6H1.3M14.7 6.4h-1.4M14.7 9.6h-1.4" stroke="currentColor" stroke-width="1.05" stroke-linecap="round"/>'
    + '</svg>';

  var st = { running: false, vram: null, modelReady: null, busy: false, err: '', at: 0 };
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tb-btn tb-tools lm-pill lm-off';
  btn.id = 'btn-localmodel';
  btn.innerHTML = ICON + '<span class="lm-txt">本地模型 关</span>';

  function toast(msg, bad) {
    try {
      var box = document.querySelector('.tbs-toasts');
      if (!box) { box = document.createElement('div'); box.className = 'tbs-toasts'; document.body.appendChild(box); }
      var t = document.createElement('div');
      t.className = 'tbs-toast' + (bad ? ' bad' : '');
      t.textContent = msg;
      box.appendChild(t);
      setTimeout(function () { t.classList.add('out'); setTimeout(function () { t.remove(); }, 320); }, 4600);
    } catch (e) { /* ignore */ }
  }

  function place() {
    if (window.__lmGen !== MY_GEN) return;     // 旧闭包（⟳ 之前那份）不再往 DOM 里插东西
    var controls = document.querySelector('#titlebar .titlebar-controls');
    if (!controls) return;
    if (btn.parentNode !== controls) {
      // 2026-10-20（宿主报"最小化没反应"后）—— 挪到 **⟳ 左边**：离窗口控制区（─ □ ✕）远一点，
      //   以后 pill 再变宽也碰不到最小化/最大化/关闭那三颗。
      var ref = document.getElementById('btn-refresh') || document.getElementById('btn-plugins')
        || document.getElementById('btn-theme') || null;
      if (ref && ref.parentNode === controls) controls.insertBefore(btn, ref);
      else controls.appendChild(btn);
    }
  }

  function paint() {
    var on = !!st.running;
    btn.classList.toggle('lm-on', on && !st.busy);
    btn.classList.toggle('lm-off', !on && !st.busy);
    btn.classList.toggle('lm-busy', !!st.busy);
    btn.disabled = false;
    // 带字：开=绿「本地模型 开」/ 关=灰「本地模型 关」/ 忙=琥珀「启动中…」「停止中…」
    var txt = btn.querySelector('.lm-txt');
    if (txt) {
      txt.textContent = st.busy
        ? ('本地模型 ' + (on ? '停止中…' : '启动中…'))
        : ('本地模型 ' + (on ? '开' : '关'));
    }
    var vr = (typeof st.vram === 'number') ? ('显存空闲 ' + st.vram + ' MB') : '显存空闲 —';
    var tip = '本地 Qwen3-8B（GPU）· ' + vr + ' · 不用时关掉释放';
    tip += on ? '\n（运行中 —— 点一下停掉，释放显存）' : '\n（点一下启动，约 10 秒）';
    if (st.busy) tip = '正在启动/停止本地模型…（最多 90 秒）';
    if (st.modelReady === false) tip += '\n⚠ 模型文件没找到（<模型目录>\\qwen3-8b）';
    if (st.err) tip += '\n⚠ ' + st.err;
    btn.title = tip;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function refresh() {
    if (!LM || !LM.status) { st.err = '这个 GUI 版本还没有本地模型通道（要重启一次工作台）'; paint(); return; }
    Promise.resolve(LM.status()).then(function (r) {
      if (!r) { st.err = '读不到状态'; paint(); return; }
      if (typeof r.vramFreeMb === 'number') st.vram = r.vramFreeMb;
      if (r.modelReady === false) st.modelReady = false; else st.modelReady = true;
      if (r.ok) { st.err = ''; st.running = !!r.running; st.at = Date.now(); }
      else st.err = r.err || '读不到状态';
      paint();
    }).catch(function (e) { st.err = (e && e.message) || String(e); paint(); });
  }

  function toggle() {
    if (st.busy) return;
    if (!LM || !LM.toggle) { st.err = '要重启一次工作台才有开关通道'; paint(); return; }
    st.busy = true; st.err = ''; paint();
    var t0 = Date.now();
    Promise.resolve(LM.toggle()).then(function (r) {
      st.busy = false;
      if (r && typeof r.vramFreeMb === 'number') st.vram = r.vramFreeMb;
      if (r && r.ok) {
        st.running = !!r.running;
        toast('本地模型：' + (st.running ? '已启动' : '已停止') + ' · ' + Math.round((Date.now() - t0) / 1000) + ' 秒', false);
      } else {
        if (r && typeof r.running === 'boolean') st.running = r.running;
        st.err = (r && r.err) || '切换失败';
        toast('本地模型切换失败：' + st.err, true);
      }
      paint();
    }).catch(function (e) {
      st.busy = false;
      st.err = (e && e.message) || String(e);
      toast('本地模型切换失败：' + st.err, true);
      paint();
    });
  }

  btn.addEventListener('click', function (ev) { ev.stopPropagation(); toggle(); });
  place();
  var tries = 0;
  var tm = setInterval(function () {
    place();
    if (++tries > 25) clearInterval(tm);
  }, 400);
  refresh();
  // 只在窗口有焦点时每 20 秒对一次状态（不额外养进程：脚本本身 0.2s 就跑完）
  // ⚠ window 级守卫（既有约定）：即便本文件将来被热加载，也不会攒出多个 20s 刷新循环
  if (!window.__localModelRefreshTimer) window.__localModelRefreshTimer = setInterval(function () {
    if (document.hidden || !document.hasFocus()) return;
    if (st.busy) return;
    refresh();
  }, 20000);
  window.addEventListener('focus', function () { if (!st.busy) refresh(); });
  paint();
})();

