// ============ code-urls（工作项目开发「开发服务与网址」）：跟随「当前开发工程」 ============
// 2026-11-04 用户反馈：右上「开发项目工程」选的是 Financial Compensation，左下「开发服务与网址」
//   却永远只有工作台自己那 4 条（31238 / 3083 / 31239 / 3000 预留）⇒ 面板跟当前工程对不上。
// 现在的口径：
//   ① 主组 =「当前开发工程」的服务（主进程 code:dev-services 自动识别工程自身的
//      package.json / pnpm-workspace / vite / next / nest / .env，或 外壳\data\dev-services.json 手动登记）；
//   ② 次组 =「工作台自身服务」（场景 json 的 urls，折叠成紧凑行，不再占满整块）。
// 为什么单独一个文件：renderers.js 是存量大文件（代码红线按基线只许变短），实现搬到这里，
//   renderers.js 里只留 3 行注册转发（见那边的 renderers['code-urls']）。
// 旧主进程兜底：没有 app.code.devServices 时读 外壳\data\dev-services-cache.json
//   （node 外壳\scripts\dev-services.js --write 生成），重启一次工作台即切换成实时识别。
(function () {
  'use strict';

  var ICON = { web: '🌐', api: '🔌', docs: '📘', other: '🔗', base: '🧩' };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }

  function dataDirPath() {
    try {
      var p = window.app && window.app.paths && window.app.paths.dataDir;
      // 只认绝对路径：沙箱化 preload 里 DSH_SHELL_DIR 可能取不到，preload 会拼出 "\data" 这种相对路径
      if (p && /^[A-Za-z]:[\\/]/.test(String(p))) return String(p).replace(/[\\/]+$/, '');
    } catch (e) { /* ignore */ }
    var root = '';
    try { root = String(window.__WB_ROOT || ''); } catch (e) { /* ignore */ }
    if (!root) {
      try {
        var q = decodeURIComponent(String(location.pathname || '')).replace(/^\//, '').replace(/\//g, '\\');
        var m = q.match(/^(.*)\\外壳\\renderer\\/i);
        if (m && m[1]) root = m[1];
      } catch (e) { /* ignore */ }
    }
    return root ? (root + '\\外壳\\data') : '';
  }

  function readJsonFile(p) {
    return new Promise(function (resolve) {
      var F = window.app && window.app.file;
      if (!p || !F || typeof F.read !== 'function') return resolve(null);
      Promise.resolve(F.read(p)).then(function (r) {
        if (!r || !r.ok || !r.text) return resolve(null);
        try { resolve(JSON.parse(String(r.text).replace(/^\uFEFF/, ''))); } catch (e) { resolve(null); }
      }).catch(function () { resolve(null); });
    });
  }

  // 缓存兜底：旧主进程 / 新 preload + 还没重启的主进程（IPC 报 No handler）都走这里
  // reason 非空 = 是「IPC 走不通」降级来的，要在提示行里说清楚（不然用户以为识别失败）
  function fetchFromCache(reason) {
    var dir = dataDirPath();
    return Promise.all([
      readJsonFile(dir + '\\current-project.json'),
      readJsonFile(dir + '\\dev-services-cache.json')
    ]).then(function (arr) {
      var cur = arr[0], cache = arr[1];
      var name = (cur && cur.name) ? String(cur.name) : '';
      // 兜底再退一层：current-project.json 读不到（路径推不出来）时，用文件面板记在 localStorage 的项目名
      if (!name) {
        try { name = localStorage.getItem('work-dev:current-project') || ''; } catch (e) { /* ignore */ }
      }
      if (!name) {
        return {
          ok: true, from: 'none', project: null, services: [],
          hint: reason || ''
        };
      }
      var hit = cache && cache.projects && cache.projects[name];
      var project = {
        name: name,
        path: (cur && cur.path) ? String(cur.path) : ((hit && hit.projectPath) ? String(hit.projectPath) : ''),
        exists: true
      };
      if (!hit) {
        return {
          ok: true, from: 'none', project: project, services: [],
          hint: (reason ? reason + '；' : '')
            + '缓存里没有这个工程的服务：重启一次工作台即自动识别；'
            + '也可以先跑 node 外壳\\scripts\\dev-services.js --all 生成兜底缓存。'
        };
      }
      return {
        ok: true, from: 'cache', project: project,
        services: Array.isArray(hit.services) ? hit.services : [],
        startCmd: hit.startCmd || '',
        detectedAt: hit.detectedAt || '',
        counts: hit.counts || null,
        hint: reason ? (reason + '（当前显示上次识别结果；重启工作台后自动切实时识别）') : ''
      };
    });
  }

  // 统一数据入口：新主进程走 IPC（实时识别）；IPC 不可用 / 报错 一律退回缓存文件
  function fetchProject() {
    var api = window.app && window.app.code;
    if (api && typeof api.devServices === 'function') {
      return Promise.resolve(api.devServices({})).then(function (r) {
        if (r && r.ok !== false) return Object.assign({ from: 'live' }, r);
        return fetchFromCache('主进程还没重启（' + ((r && (r.err || r.hint)) || 'code:dev-services 不可用') + '）');
      }).catch(function (e) {
        return fetchFromCache('主进程还没重启（' + ((e && e.message) || e) + '）');
      });
    }
    return fetchFromCache('');
  }

  function iconOf(kind) { return ICON[kind] || ICON.other; }
  function shortUrl(u) { return String(u || '').replace(/^https?:\/\//, ''); }

  function normPath(p) {
    return String(p || '').replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
  }
  // 当前项目是不是「工作台本体」（<代码根>\<仓库>）：
  // 它不是普通 Web 工程、没有自己的 dev server —— 服务就是工作台自己的三个端口。
  function isWorkbenchProject(project) {
    if (!project || !project.path) return false;
    var root = '';
    // 统一成反斜杠再拆（__WB_ROOT 在页面里是反斜杠，但测试/其它入口可能给正斜杠）
    try { root = String(window.__WB_ROOT || '').replace(/\//g, '\\').replace(/[\\/]+$/, ''); } catch (e) { /* ignore */ }
    if (!root) return false;
    var parent = root.split('\\').slice(0, -1).join('\\');
    return !!parent && normPath(project.path) === normPath(parent);
  }

  // 从 URL 拆 host / port（TCP 探活用；没写端口就按协议补默认端口）
  function hostPortOf(u) {
    try {
      var x = new URL(String(u));
      var port = Number(x.port) || (x.protocol === 'https:' ? 443 : 80);
      return { host: x.hostname, port: port };
    } catch (e) { return null; }
  }

  // 状态文案：端口在监听 = 在线；HTTP 只用来补细节
  // （2026-11-04 用户反馈：127.0.0.1:3000 明明能连，面板却显示离线 —— NestJS 根路径是 404，
  //   site:probe 只认 2xx/3xx。开发服务器根路径 404/401 太常见，不能拿 HTTP 状态当在线判据。）
  function statusText(s) {
    var t = (s.ms != null ? ' · ' + s.ms + 'ms' : '');
    var where = '根路径';
    try {
      var p = new URL(String(s.url)).pathname || '/';
      if (p && p !== '/') where = '路径';
    } catch (e) { /* ignore */ }
    if (s.ok === true) {
      if (s.httpOk) return 'HTTP ' + (s.code || '--') + t;
      if (s.open === true) return '端口开放' + t + (s.code ? ' · ' + where + ' ' + s.code : '');
      return '在线' + t;
    }
    if (s.ok === false) return (s.open === false ? '端口未监听' : '无法连接') + t;
    return '探测中…';
  }
  function dotText(s) { return s.ok === true ? '● 在线' : (s.ok === false ? '● 离线' : '● 待探测'); }
  function dotCls(s) { return 'web-dot ' + (s.ok === true ? 'ok' : (s.ok === false ? 'down' : '')); }

  function renderPanel(body, meta, head) {
    body.classList.add('web-panel');
    body.classList.add('dev-urls-panel');
    var K = window.app && window.app.site;
    var projectMode = String(meta.scope || '') === 'project';
    var base = (Array.isArray(meta.urls) ? meta.urls : []).filter(function (u) { return u && u.url; })
      .map(function (u) {
        return {
          name: String(u.name || u.url), url: String(u.url), note: String(u.note || ''),
          kind: 'base', phone: !!u.phone, ok: null, code: 0, ms: null
        };
      });
    var state = {
      project: null,
      services: [],
      startCmd: '',
      source: projectMode ? 'loading' : 'none',
      hint: '',
      detectedAt: '',
      workbench: false,     // 当前项目 = 工作台本体
      baseOpen: null        // null = 按场景自动（工程有服务时收起，工作台本体/无服务时展开）
    };
    var disposed = false;
    var timer = null;
    var tick = 0;

    // ---- 标题栏：30秒 / 汇总 / 打开工程目录 / 刷新 ----
    var summary = el('span', 'stat-refresh web-summary', projectMode ? '识别中…' : '');
    var openBtn = el('button', 'file-refresh', '⧉');
    openBtn.type = 'button';
    openBtn.title = '用资源管理器打开当前开发工程目录';
    openBtn.disabled = true;
    var refreshBtn = el('button', 'file-refresh', '🔄');
    refreshBtn.type = 'button';
    refreshBtn.title = '重新识别当前工程的服务，并探测在线状态';
    if (head) {
      head.classList.add('kun-web-head');
      head.appendChild(summary);
      var acts = el('div', 'file-head-acts');
      acts.appendChild(openBtn);
      acts.appendChild(refreshBtn);
      head.appendChild(acts);
    } else {
      body.appendChild(refreshBtn);
    }
    var subEl = head ? head.querySelector('.panel-sub') : null;

    // ---- 主体：工程条 / 提示 / 列表 ----
    var bar = el('div', 'dev-bar');
    var hintBox = el('div', 'dev-hint');
    var grid = el('div', 'web-grid');
    body.appendChild(bar);
    body.appendChild(hintBox);
    body.appendChild(grid);
    var open = function (url) {
      try {
        if (K && K.open) K.open(url);
        else if (window.app && window.app.openExternal) window.app.openExternal(url);
        else window.open(url);
      } catch (e) { /* ignore */ }
    };
    var copy = function (url, btn) {
      var done = function (ok) {
        btn.textContent = ok ? '✓' : '✕';
        setTimeout(function () { btn.textContent = '⧉'; }, 1100);
      };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(false); });
          return;
        }
      } catch (e) { /* ignore */ }
      done(false);
    };

    function copyBtn(u) {
      var b = el('button', 'web-copy', '⧉');
      b.type = 'button';
      b.title = '复制地址';
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        ev.preventDefault();
        copy(u.url, b);
      });
      return b;
    }

    // 服务卡片（web / api：给足信息，可点开）
    function cardOf(s) {
      var c = el('div', 'web-card ' + (s.ok === false ? 'is-off' : 'is-ok'));
      var top = el('div', 'web-card-top');
      var name = el('span', 'web-name');
      name.appendChild(el('span', 'dev-ico', iconOf(s.kind)));
      name.appendChild(el('span', 'dev-name-t', s.name));
      top.appendChild(name);
      top.appendChild(el('span', dotCls(s), dotText(s)));
      c.appendChild(top);
      var row = el('div', 'web-url-row');
      row.appendChild(el('span', 'web-url', shortUrl(s.url)));
      row.appendChild(copyBtn(s));
      c.appendChild(row);
      if (s.note) c.appendChild(el('div', 'web-meta', s.note));
      c.appendChild(el('div', 'web-meta', statusText(s)));
      if (s.source === 'manual') c.appendChild(el('span', 'dev-src', '手动登记'));
      c.title = s.name + '\n' + s.url + '\n点击在浏览器中打开 ↗';
      c.addEventListener('click', function () { open(s.url); });
      return c;
    }

    // 紧凑行（文档 / 健康检查 / 工作台自身服务）：一行一个，省高度
    function rowOf(s) {
      var r = el('div', 'dev-row');
      r.title = s.name + '  ' + s.url + '  （' + statusText(s) + '）';
      r.appendChild(el('span', dotCls(s), s.ok === true ? '●' : (s.ok === false ? '●' : '○')));
      r.appendChild(el('span', 'dev-row-name', s.name));
      r.appendChild(el('span', 'dev-row-url', shortUrl(s.url)));
      r.appendChild(copyBtn(s));
      r.addEventListener('click', function () { open(s.url); });
      return r;
    }

    function section(title, right) {
      var sec = el('div', 'dev-sec');
      var t = el('span', 'dev-sec-t');
      t.appendChild(el('span', '', title));
      sec.appendChild(t);
      if (right) sec.appendChild(el('span', 'dev-sec-note', right));
      return sec;
    }

    function sourceTag() {
      if (state.source === 'cache') return { text: '缓存', cls: 'warn', title: '旧主进程兜底数据；重启一次工作台后自动实时识别' };
      if (state.source === 'live') return { text: '自动识别', cls: 'ok', title: '来自主进程实时扫描工程文件' };
      if (state.source === 'none') return { text: '未就绪', cls: 'warn', title: '' };
      return { text: '识别中', cls: '', title: '' };
    }

    function paintBar() {
      bar.innerHTML = '';
      var tag = sourceTag();
      if (state.project) {
        var chip = el('span', 'dev-proj');
        chip.appendChild(el('span', 'dev-proj-ico', '📦'));
        chip.appendChild(el('span', 'dev-proj-name', state.project.name));
        var tg = el('span', 'dev-tag ' + tag.cls, tag.text);
        if (tag.title) tg.title = tag.title;
        chip.appendChild(tg);
        bar.appendChild(chip);
        if (state.project.path) {
          var p = el('span', 'dev-path', state.project.path);
          p.title = state.project.path;
          bar.appendChild(p);
        }
      } else if (projectMode) {
        bar.appendChild(el('span', 'dev-path', '未指定当前开发项目'));
      }
    }

    function paint() {
      paintBar();
      // 提示行：有内容才占高度
      hintBox.textContent = state.hint || '';
      hintBox.style.display = state.hint ? '' : 'none';
      grid.innerHTML = '';

      var secs = state.services.filter(function (s) { return s.kind === 'web' || s.kind === 'api' || s.kind === 'other'; });
      var subs = state.services.filter(function (s) { return s.kind === 'docs'; });

      if (projectMode) {
        var right = state.services.length ? (state.services.length + ' 个') : '';
        grid.appendChild(section('当前开发工程服务', right));
        if (!state.services.length) {
          var empty = el('div', 'dev-empty');
          if (state.source === 'loading') empty.textContent = '正在识别当前工程的服务…';
          else if (!state.project) empty.textContent = '右上「开发项目工程」面板里选一个工程（或点「★ 设为当前」），这里就会列出它的服务与调试地址。';
          else if (state.workbench) {
            empty.appendChild(el('span', '', '当前项目 = 工作台本体（Electron 壳 + 渲染层），不是普通 Web 工程、没有自己的 dev server。'));
            empty.appendChild(el('div', 'dev-empty-sub',
              '它的服务就是下面的「工作台自身服务」：31238 主界面/保命入口、3083 引擎、31239 网页版 AI 桥；'
              + '开发时用仓库根的 启动工作台.bat 起壳。'));
          } else {
            empty.appendChild(el('span', '', '没识别到可访问的服务：这个工程可能不是 Web / Node 项目。'));
            empty.appendChild(el('div', 'dev-empty-sub',
              '要手动补：在 外壳\\data\\dev-services.json 里给「' + state.project.name + '」加 services（name + url），再点 🔄。'));
          }
          grid.appendChild(empty);
        }
        secs.forEach(function (s) { grid.appendChild(cardOf(s)); });
        if (subs.length) {
          var subWrap = el('div', 'dev-rows');
          subs.forEach(function (s) { subWrap.appendChild(rowOf(s)); });
          grid.appendChild(subWrap);
        }
        if (state.startCmd) {
          var st = el('div', 'dev-start');
          st.appendChild(el('span', 'dev-start-k', '一键启动'));
          st.appendChild(el('code', 'dev-start-v', state.startCmd));
          grid.appendChild(st);
        }
      }

      if (base.length) {
        // 工作台自身服务：做成可折叠 —— 工程自己有服务时默认收起（它是次要信息），
        // 工作台本体 / 工程没有服务时默认展开（这时它才是主体）。
        var autoOpen = !!(state.workbench || !state.services.length);
        var baseOpen = (state.baseOpen == null) ? autoOpen : !!state.baseOpen;
        var baseTitle = state.workbench ? '工作台自身服务（当前项目）' : (meta.baseTitle || '工作台自身服务');
        var baseSec = section(baseTitle, base.length + ' 条');
        baseSec.classList.add('dev-sec-toggle');
        baseSec.title = baseOpen ? '点击收起' : '点击展开';
        var baseArrow = el('span', 'dev-sec-arrow', baseOpen ? '▾' : '▸');
        baseSec.querySelector('.dev-sec-t').appendChild(baseArrow);
        baseSec.addEventListener('click', function () {
          state.baseOpen = !((state.baseOpen == null) ? autoOpen : !!state.baseOpen);
          paint();
        });
        grid.appendChild(baseSec);
        if (baseOpen) {
          var bw = el('div', 'dev-rows');
          base.forEach(function (s) { bw.appendChild(rowOf(s)); });
          grid.appendChild(bw);
        }
      }

      // 汇总：工程有服务就统计工程；没有就统计工作台自身（这时它是可见主体）
      if (!summary) return;
      var list = (projectMode && state.services.length) ? state.services : base;
      var up = list.filter(function (s) { return s.ok === true; }).length;
      var down = list.filter(function (s) { return s.ok === false; }).length;
      var pending = list.filter(function (s) { return s.ok == null; }).length;
      summary.style.color = '';
      summary.title = '';
      if (!list.length) {
        summary.textContent = projectMode ? (state.source === 'loading' ? '识别中…' : '—') : '';
        return;
      }
      if (down > 0) {
        summary.textContent = up + '/' + list.length + ' · ' + down + ' 离线';
        summary.style.color = 'var(--err)';
        summary.title = '离线：' + list.filter(function (s) { return s.ok === false; }).map(function (s) { return s.name; }).join('、');
      } else if (pending === list.length) {
        summary.textContent = '探测中…';
      } else {
        summary.textContent = up + '/' + list.length;
        summary.title = '全部在线';
      }
    }

    // 单个服务：TCP 端口 + HTTP 双探
    //   在线判据 = 端口在监听（开发服务器根路径 404/401 是常态）；HTTP 状态只进文案，不参与判红。
    function probeOne(s) {
      var t0 = Date.now();
      var K2 = window.app && window.app.site;
      var N = window.app && window.app.net;
      var hp = hostPortOf(s.url);
      var tcp = (N && typeof N.probe === 'function' && hp)
        ? Promise.resolve(N.probe(hp.host, hp.port, 1200)).then(function (r) { return !!(r && r.open); })
          .catch(function () { return false; })
        : Promise.resolve(null);
      var http = (K2 && typeof K2.probe === 'function')
        ? Promise.resolve(K2.probe(s.url)).then(function (r) { return { ok: !!(r && r.ok), code: (r && r.status) || 0 }; })
          .catch(function () { return { ok: false, code: 0 }; })
        : Promise.resolve(null);
      return Promise.all([tcp, http]).then(function (res) {
        var open = res[0];
        var h = res[1];
        s.open = open;
        s.httpOk = h ? h.ok : null;
        s.code = h ? h.code : 0;
        s.ms = Date.now() - t0;
        s.ok = (open === true) || (open === null && !!(h && h.ok));
      });
    }

    function probeAll() {
      var all = (projectMode ? state.services : []).concat(base);
      if (!all.length) { paint(); return; }
      refreshBtn.disabled = true;
      Promise.all(all.map(function (s) { return probeOne(s); })).then(function () {
        refreshBtn.disabled = false;
        if (!disposed) paint();
        // 一次性自检（只打第一轮，给主进程日志留个可核对的凭据）
        if (!window.__wbCodeUrlsSeen) {
          window.__wbCodeUrlsSeen = true;
          try {
            var ups = state.services.filter(function (s) { return s.ok === true; }).length;
            console.warn('[code-urls] 就绪 · ' + (state.project ? state.project.name : '(未指定项目)')
              + ' · 服务 ' + state.services.length + ' 个 · 在线 ' + ups + '/' + state.services.length
              + ' · 来源 ' + state.source);
          } catch (e) { /* ignore */ }
        }
      });
    }

    function load(showTip) {
      if (!projectMode) { paint(); probeAll(); return; }
      state.source = 'loading';
      paint();
      fetchProject().then(function (r) {
        if (disposed) return;
        state.project = r.project || null;
        state.services = (Array.isArray(r.services) ? r.services : []).map(function (s) {
          return {
            name: String(s.name || s.url), url: String(s.url), note: String(s.note || ''),
            kind: String(s.kind || 'other'), source: String(s.source || 'auto'),
            phone: !!s.phone, ok: null, code: 0, ms: null
          };
        });
        state.startCmd = String(r.startCmd || '');
        state.detectedAt = String(r.detectedAt || '');
        state.hint = String(r.hint || '');
        state.source = String(r.from || 'live');
        state.workbench = isWorkbenchProject(state.project);
        // 切项目重置折叠状态（每个工程按自己的场景自动决定展开/收起）
        state.baseOpen = null;
        openBtn.disabled = !(state.project && state.project.path);
        if (subEl) {
          subEl.textContent = state.project
            ? ('当前项目：' + state.project.name)
            : (projectMode ? '未指定当前项目' : String(meta.sub || ''));
        }
        paint();
        probeAll();
        if (showTip && summary) {
          summary.textContent = state.project
            ? ('已刷新 · ' + state.services.length + ' 个服务')
            : '未指定当前项目';
        }
      });
    }

    // ---- 事件 ----
    refreshBtn.addEventListener('click', function () {
      if (projectMode) load(true);
      else probeAll();
    });
    openBtn.addEventListener('click', function () {
      try {
        var A = window.app && window.app.app;
        if (A && typeof A.openPath === 'function' && state.project && state.project.path) A.openPath(state.project.path);
        else if (state.project && state.project.path && window.app && window.app.topbar && window.app.topbar.open) {
          window.app.topbar.open(state.project.path);
        }
      } catch (e) { /* ignore */ }
    });
    var onProjectChanged = function () { if (projectMode) load(false); };
    window.addEventListener('wb:project-changed', onProjectChanged);
    var onStorage = function (e) {
      if (projectMode && e && e.key === 'work-dev:current-project') load(false);
    };
    window.addEventListener('storage', onStorage);

    paint();
    load(false);
    // 30 秒探活一次；每 4 次（约 2 分钟）顺带重新识别一次（工程里新加了服务也能自己长出来）
    timer = setInterval(function () {
      if (disposed) return;
      tick++;
      if (projectMode && tick % 4 === 0) load(false);
      else probeAll();
    }, 30000);

    return function cleanup() {
      disposed = true;
      if (timer) clearInterval(timer);
      window.removeEventListener('wb:project-changed', onProjectChanged);
      window.removeEventListener('storage', onStorage);
    };
  }

  // 注册入口：renderers.js 里的 shim 转给这里
  window.__wbCodeUrls = renderPanel;
  window.__wbCodeUrlsStale = false;
  window.__wbCodeUrlsSeen = false;   // 每个实现版本只在首轮探测后打一条诊断（⟳ 换实现就会重新打）

  // renderers.js 的 shim 在「本文件还没加载」时会先画占位提示，并把重画回调挂在这里
  try {
    var pending = window.__wbCodeUrlsPending;
    if (typeof pending === 'function') {
      window.__wbCodeUrlsPending = null;
      pending();
    }
  } catch (e) { /* ignore */ }
})();
