// panels/panel-neuron.js —— 「命令」场景 3D 神经元面板渲染器（P2 收尾 3e-2 从 renderers.js neuron 体搬出）
// 来源：renderers.js 的 `renderers.neuron` 体（1,260 行）；本阶段把 11 个"数据/布局/绘制数学"函数
// 顶层化到 panels/neuron-core.js（显式状态 S），本文件留 canvas/事件/生命周期与剩余 helper。
// 加载顺序：… → panels/neuron-core.js → panels/panel-neuron.js → … → chrome.js → renderers.js。
// ⚠ 本阶段**放弃逐字节等价**（闭包状态显式化必然改作用域结构）；等价判据 = 探针行为判据（见证据）。
var APP = window.APP_RENDERERS || (window.APP_RENDERERS = {});

APP['neuron'] = (body, meta, head) => {
  body.classList.add('kneu-wrap');
  body.innerHTML = '';

  const F = (window.app && window.app.file) || null;
  const OPEN = (window.app && window.app.topbar && window.app.topbar.open) || null;
  // 根统一 引擎\\场景记忆（2026-10-27 审计②：旧别名 场景项目信息 是 junction，收掉就全断）
  const P = (window.app && window.app.paths) || {};
  const MEM_ROOT = P.memRoot || '';
  const ROOT = MEM_ROOT + '\\_共享记忆';
  const SKILL_DIR = P.skillDir || (__WB_ROOT + '\\引擎数据\\.dsh\\skills');
  // 技能清单**不硬编码**（2026-10-27 审计①：硬编码 23 漏了 command / douyin）——运行时列技能目录；
  //   2026-11-07 修「⛔ 路径失效 22」：列目录失败时改为解析 skills\_索引.md（真清单），
  //   这份兜底表只给**极老宿主**（既没有列目录、也没有索引文件）用，且只允许写本模板真实存在的技能。
  //   旧表是某个工作区实例的 25 个技能名，本机只有 3 个存在 ⇒ 其余 22 个路径全红（用户截图那 22）。
  const SKILL_FALLBACK = ['bilibili', 'command', 'pc-cleanup', 'self-review', 'webai'];
  // 边的语义标签（2026-10-27 审计⑤：原来只有颜色，看不出这条线是什么关系）
  const EDGE_LABEL = {
    area: '内核 → 区域', skill: '技能归属（→ owner 场景）', memory: '私有记忆归属',
    project: '项目 owner', dep: '区域互相提及（文本启发式）', chain: '提交链',
    source: '数据源', doc: '共享文档'
  };
  // 归口配色：引擎/工具=蓝 · 界面/设计=琥珀 · 内容/业务=绿 · 运维/清理=红
  const GROUP = {
    'dg-dsh': 'engine', 'dg-gui': 'ui', 'code-ai': 'code', 'dz-ai': 'ui', 'site-ai': 'content',
    'wb-ai': 'content', 'oa-ai': 'content', 'vw-ai': 'content', 'bv-ai': 'content', 'bl-ai': 'content',
    'mk-chat': 'content', 'sr-ai': 'content', 'pc-ai': 'ops'
  };
  const COLOR = isLightTheme() ? { core: '#0e7490', engine: '#2563eb', ui: '#b45309', code: '#6d28d9', content: '#15803d', ops: '#b91c1c', skill: '#5b73c4', doc: '#64748b', project: '#0f766e', memory: '#475569', source: '#64748b', chain: '#b45309' } : { core: '#7fe3ff', engine: '#8fb4ff', ui: '#f0a35e', code: '#b79bff', content: '#3ddc84', ops: '#e5484d', skill: '#6f8fd6', doc: '#c9d4e6', project: '#2dd4bf', memory: '#dfe7ff', source: '#8f9bb3', chain: '#ffcf6b' };
  // 项目层（2026-10-26）：不是从记忆里正则猜，而是直接列真实目录（B 盘/项目工程），归属按 area 正文里出现的名字来挂
  const PROJECT_ROOTS = P.projectRoots || [];
  // dg-dsh 审计（2026-10-26）：这 5 个是一级目录但属于「资料/介质夹」，不是项目
  const NON_PROJECTS = ['_项目文件', '产物、素材、内容、方案', '服务器信息', '通用素材', '更新feed'];
  // 私有记忆（2026-10-26，宿主："每个场景的私有记忆连到各自对应的场景"）——
  //   映射照抄 _场景身份索引.md §五「写回点」的权威表，别自己猜文件夹名。
  // 私有记忆兜底表（2026-10-27 审计②）：只补 记忆地图 缺的项；名字统一 场景私有记忆.md、根统一 场景记忆
  const MEM_DIR = MEM_ROOT;
  const CHAIN_DIR = MEM_ROOT + '\\_共享记忆\\提交链';
  const MEMORY_BY_PANEL = {
    'cmd-chat': MEM_DIR + '\\命令\\场景私有记忆.md',
    'bv-ai': MEM_DIR + '\\B站\\场景私有记忆.md',
    'dg-dsh': MEM_DIR + '\\DSH·GUI改造\\场景私有记忆.md',
    'dg-gui': MEM_DIR + '\\DSH·GUI改造\\场景私有记忆.md',
    'bl-ai': MEM_DIR + '\\Blender\\场景私有记忆.md'
  };

  // ---------- 骨架 ----------
  const cv = el('canvas', 'kneu-cv');
  const hud = el('div', 'kneu-hud');
  const stat = el('div', 'kneu-stat', '加载中…');
  const searchWrap = el('div', 'kneu-searchwrap');
  const search = el('input', 'kneu-search');
  search.type = 'search';
  search.placeholder = '搜场景 / 技能 / 文件…';
  searchWrap.appendChild(el('span', 'kneu-searchico', '⌕'));
  searchWrap.appendChild(search);
  hud.appendChild(searchWrap);
  hud.appendChild(stat);
  const btns = el('div', 'kneu-btns');
  const bRot = el('button', 'kneu-btn', '⟳ 自转');
  const bReset = el('button', 'kneu-btn', '⤾ 复位');
  const bMem = el('button', 'kneu-btn', '只看记忆');
  const bFx = el('button', 'kneu-btn', '动效：开');
  bMem.type = 'button';
  bMem.title = '只留：场景 / 私有记忆 / 提交链 / 共享文档（技能·项目·数据源 及它们的连线一起隐藏）';
  const bLabel = el('button', 'kneu-btn', '标签：自动');
  bFx.type = 'button';
  bFx.title = '星点/流光/呼吸的开关（卡就关掉）';
  const bReload = el('button', 'kneu-btn', '↻ 重读');
  bLabel.type = 'button';
  bLabel.title = '节点标签：自动（场景常显、项目近了才显示）→ 全部 → 关';
  bRot.type = bReset.type = bReload.type = 'button';
  btns.appendChild(bRot); btns.appendChild(bReset); btns.appendChild(bMem); btns.appendChild(bFx); btns.appendChild(bLabel); btns.appendChild(bReload);
  hud.appendChild(btns);
  const detail = el('div', 'kneu-detail');
  const legend = el('div', 'kneu-legend');
  [['engine', '引擎/工具'], ['ui', '界面/设计'], ['code', '代码'], ['content', '内容/业务'], ['ops', '运维/清理'], ['project', '项目'], ['memory', '私有记忆'], ['chain', '提交链'], ['source', '数据源'], ['skill', '技能'], ['doc', '共享文档']]
    .forEach(function (p) {
      var it = el('span', 'kneu-lg');
      var dot = el('i', 'kneu-dot');
      dot.style.background = COLOR[p[0]];
      it.appendChild(dot);
      it.appendChild(document.createTextNode(p[1]));
      legend.appendChild(it);
    });
  body.appendChild(cv);
  body.appendChild(hud);
  body.appendChild(detail);
  body.appendChild(legend);
  if (head) {
    head.appendChild(el('span', 'stat-refresh', '共享记忆 · 只读'));
  }

  // ---------- 状态 ----------
  let nodes = [];        // {id,label,kind,group,path,size,x,y,z,r,deg,hover}
  let edges = [];        // {a,b,kind}
  // 2026-11-07：默认俯角 0.18 → 0.42（约 24°）。原来是近乎平视：整张图是又宽又扁的一条，面板下半屏全空，
  //   只能靠"拉近"填满，结果上下裁切。抬高俯角后同样的宽度能换到 2 倍纵向高度，圆环读成"盘"而不是"线"。
  var RY0 = -0.35, RX0 = 0.42;                 // 默认机位（↺ 复位 / 视口适配都以它为准）
  let ry = RY0, rx = RX0, zoom = 1.42;
  let hover = null, sel = null, auto = true, disposed = false, raf = 0, last = 0;
  var ownerSkill = {};   // skill 节点 id → 面板 id（layout 贴 owner 用）
  let labelMode = 1;   // 1=全部（默认，宿主 2026-10-26：所有点都要有文字标签） 0=自动 2=关
  let fx = true;       // 动效（星点/流光/呼吸）；卡就一键关
  let onlyMem = false; // 只看记忆：只留 内核/场景/私有记忆/提交链/共享文档
  let bornAt = 0;      // 载入时刻（入场动画：整图从中心展开）
  let introBoot = false; // 2026-10-27 宿主：点「↻ 重读」无条件重播一次入场动画（即使动效开关是关的）
  var stars = [];
  function makeStars() {
    stars = [];
    var n = 18;
    for (var i = 0; i < n; i++) {
      stars.push({ x: Math.random() * W, y: Math.random() * H, r: 0.4 + Math.random() * 1.1, ph: Math.random() * 6.28, sp: 0.4 + Math.random() * 1.2 });
    }
  }
  let W = 0, H = 0, dpr = 1, q = '';

  function readText(p) {
    if (!F || !F.read) return Promise.resolve('');
    return Promise.resolve(F.read(p)).then(function (r) {
      return (typeof r === 'string') ? r : ((r && (r.text || r.content)) || '');
    }).catch(function () { return ''; });
  }
  function statSize(p) {
    if (!F || !F.stat) return Promise.resolve(0);
    return Promise.resolve(F.stat(p)).then(function (r) {
      return (r && (r.size || (r.stat && r.stat.size))) || 0;
    }).catch(function () { return 0; });
  }
  // 2026-10-27 审计⑤：路径存在校验（kun:file:stat 缺失时返回 {ok:true, exists:false}，不抛错）
  function statOk(p) {
    if (!F || !F.stat || !p) return Promise.resolve(false);
    return Promise.resolve(F.stat(p)).then(function (r) {
      if (!r || r.ok === false) return false;
      if (r.exists === false) return false;
      return !!(r.isDir || r.size != null || r.stat);
    }).catch(function () { return false; });
  }

  // 2026-11-07（宿主：「记忆神经元里节点路径失效」）：宿主通用「列目录」能力的统一入口。
  //   新壳用 app.file.list（kun:file:list），老壳退回 app.oa.filesLocal（oa:files:local，同一个实现，
  //   见 main/system-io.js）。两件事都要防：
  //     · 通道不存在 / 主进程还是旧的 ⇒ invoke reject；
  //     · **preload 新、主进程旧**（换 preload 只消重载页面，换主进程要重启 GUI）⇒ 前一个通道有函数但没 handler。
  //   所以按顺序逐个试，第一个失败就试下一个，全都失败才 resolve(null)（调用方走文本索引兜底），绝不 throw。
  function listDir(p) {
    var A = window.app || {};
    var fns = [];
    if (A.file && A.file.list) fns.push(A.file.list);
    if (A.oa && A.oa.filesLocal) fns.push(A.oa.filesLocal);
    if (!fns.length) return Promise.resolve(null);
    function tryAt(i) {
      if (i >= fns.length) return Promise.resolve(null);
      var pr;
      try { pr = Promise.resolve(fns[i](p)); } catch (e) { return tryAt(i + 1); }
      return pr.then(function (r) {
        return (r && r.ok !== false && r.rows) ? r : tryAt(i + 1);
      }).catch(function () { return tryAt(i + 1); });
    }
    return tryAt(0);
  }

  // ---------- 载入数据 ----------
  function load() {
    stat.textContent = '正在读共享记忆…';
    return Promise.all([readText(ROOT + '\\索引.json'), readText(ROOT + '\\项目.json'), readText(ROOT + '\\记忆地图.json')]).then(function (both) {
      var txt = both && both[0];
      var projTxt = (both && both[1]) || '';
      var mapTxt = (both && both[2]) || '';
      var memMap = null;
      try { memMap = mapTxt ? JSON.parse(mapTxt) : null; } catch (e) { memMap = null; }
      var memByPanel = {};
      if (memMap && Array.isArray(memMap.areas)) {
        memMap.areas.forEach(function (a) {
          if (a && a.panel && Array.isArray(a.privateMemory) && a.privateMemory.length) memByPanel[a.panel] = a.privateMemory;
        });
      }
      var reg = null;
      try { reg = projTxt ? JSON.parse(projTxt) : null; } catch (e) { reg = null; }
      var idx = null;
      try { idx = JSON.parse(txt); } catch (e) { idx = null; }
      // 客户包：记忆地图里的相对路径按记忆根解析（不带盘符）
      function __memAbs(mp) {
        if (!mp) return '';
        if (/^[A-Za-z]:/.test(mp)) return mp;
        return MEM_ROOT + '\\' + String(mp).replace(/^引擎[\\/]场景记忆[\\/]/, '');
      }
      var areas = (idx && idx.areas) || [];
      ownerSkill = {};                 // 2026-11-07：重读时清空，别让上一轮的归属残留
      nodes = []; edges = [];
      var core = { id: 'core', label: 'DSH 记忆', kind: 'core', group: 'core', r: 15, path: ROOT, size: 0 };
      nodes.push(core);

      var docs = [
        // 2026-11-01 修：这两份是**共享**文档，全仓唯一的写点在 场景记忆\_共享记忆\
        //   （工具\发消息.mjs 往 _共享记忆\_跨场景通知.md 追加；topbar-status.js 的「跨场景通知」也指向那里）。
        //   以前这里写成 META_DIR（= 场景记忆 根）⇒ 根上根本没有这两个文件 ⇒ 加载时校验一路判失效，
        //   面板常驻「⛔ 路径失效 2」，点开详情是「文件不存在」，点「定位」也定位不到东西。
        { id: 'doc-todo', label: '待办', path: ROOT + '\\_待办.md', ang: 0 },
        { id: 'doc-msg', label: '通知', path: ROOT + '\\_跨场景通知.md', ang: Math.PI * 0.66 },
        { id: 'doc-conf', label: '冲突', path: ROOT + '\\冲突.md', ang: Math.PI * 1.33 }
      ];
      var jobs = [];

      // 文档节点（放在内核附近）
      docs.forEach(function (d) {
        jobs.push(statSize(d.path).then(function (sz) {
          nodes.push({ id: d.id, label: d.label, kind: 'doc', group: 'doc', path: d.path, size: sz, r: 8 });
          edges.push({ a: 'core', b: d.id, kind: 'doc' });
        }));
      });

      // 场景区域节点（球壳 1）+ 依赖边
      areas.forEach(function (a, i) {
        var id = 'area-' + a.owner;
        var g = GROUP[a.owner] || 'content';
        jobs.push(readText(ROOT + '\\' + String(a.file || '').replace(/\//g, '\\')).then(function (txt) {
          nodes.push({
            id: id, label: a.owner, title: a.title || '', kind: 'area', group: g,
            path: ROOT + '\\' + String(a.file || '').replace(/\//g, '\\'),
            size: txt.length, region: a.region || '', text: txt
          });
          edges.push({ a: 'core', b: id, kind: 'area' });
        }));
      });

      // 项目节点（2026-10-26）：优先读 dg-dsh 建的登记表 _共享记忆\\项目.json；
      //   没有才退回"列两个真实根目录"。登记表里有 owner/status/aliases ⇒ 归属与状态都比猜的准。
      var fromReg = !!(reg && Array.isArray(reg.projects) && reg.projects.length);
      if (fromReg) {
        reg.projects.forEach(function (pr) {
          if (!pr || !pr.name) return;
          var owner = String(pr.owner || '');
          nodes.push({
            id: 'proj-' + String(pr.id || pr.name),
            label: String(pr.name).slice(0, 24),
            kind: 'project', group: 'project',
            path: (Array.isArray(pr.paths) && pr.paths[0]) || '',
            paths: Array.isArray(pr.paths) ? pr.paths : [],
            owner: owner,
            status: String(pr.status || 'active'),
            aliases: Array.isArray(pr.aliases) ? pr.aliases : [],
            size: 0
          });
        });
        console.log('[neuron] 项目登记表：' + reg.projects.length + ' 个项目');
      }
      if (!fromReg && PROJECT_ROOTS.length) {
        PROJECT_ROOTS.forEach(function (root) {
          jobs.push(listDir(root).then(function (r) {
            if (!r || r.ok === false) return;
            (r.rows || []).filter(function (it) {
              return it && it.isDir && NON_PROJECTS.indexOf(String(it.name)) < 0;
            }).slice(0, 40).forEach(function (it) {
              nodes.push({
                id: 'proj-' + root.replace(/[^A-Za-z0-9]/g, '_') + '-' + it.name,
                label: String(it.name).slice(0, 22), kind: 'project', group: 'project',
                path: root + '\\' + it.name, size: it.size || 0, root: root
              });
            });
          }).catch(function () { /* 目录不存在就算了 */ }));
        });
      }

      // 私有记忆节点：优先用 记忆地图.json（一个面板可有多份），没有才退回硬编码表
      areas.forEach(function (a) {
        var list = (memByPanel[a.owner] || (MEMORY_BY_PANEL[a.owner] ? [MEMORY_BY_PANEL[a.owner]] : [])).map(__memAbs);
        list.forEach(function (mp, mi) {
          var isDir = /[\\/]$/.test(mp) || !/\.md$/i.test(mp);
          (isDir ? Promise.resolve(0) : statSize(mp)).then(function (sz) {
            var id = 'mem-' + a.owner + (list.length > 1 ? ('-' + mi) : '');
            nodes.push({
              id: id, label: '§' + a.owner + (list.length > 1 ? ('·' + (mi + 1)) : ''), kind: 'memory', group: 'memory',
              path: mp, size: sz || 0, isDir: isDir, ownerPanel: a.owner
            });
            edges.push({ a: 'area-' + a.owner, b: id, kind: 'memory' });
          });
        });
      });

      // 数据源节点（记忆地图 dataSources）：工具/插件/MCP/会话档案/备份/台账/体检 …
      if (memMap && memMap.dataSources) {
        var SKIP = { scenes: 1, skills: 1, projects: 1, tasks: 1 };   // 这几个已有专门节点
        Object.keys(memMap.dataSources).forEach(function (key) {
          if (SKIP[key]) return;
          var ds = memMap.dataSources[key] || {};
          var nm = ({ tools: '工具', plugins: '插件', mcp: 'MCP', sessions: '会话档案', backups: '备份', docs: '说明台账', health: '体检' })[key] || key;
          var cnt = ds.count;
          nodes.push({
            id: 'src-' + key, label: nm + (cnt ? (' ' + cnt) : ''), kind: 'source', group: 'source',
            path: String(ds.path || ds.board || ''), size: 0, srcKey: key,
            dsInfo: ds
          });
          edges.push({ a: 'core', b: 'src-' + key, kind: 'source' });
        });
      }

      // 提交链（2026-10-26 A 档）：每个面板一条追加式锚点链，只读
      jobs.push(listDir(CHAIN_DIR).then(function (r) {
        if (!r || r.ok === false) return [];
        var rows = (r.rows || []).filter(function (it) { return it && /\.jsonl$/i.test(it.name); });
        return Promise.all(rows.map(function (it) {
          var panel = String(it.name).replace(/\.jsonl$/i, '');
          return readText(CHAIN_DIR + '\\' + it.name).then(function (txt) {
            var list = String(txt || '').split(/\r?\n/).filter(Boolean).map(function (line) {
              try { return JSON.parse(line); } catch (e) { return null; }
            }).filter(Boolean);
            if (!list.length) return;
            var last = list[list.length - 1];
            nodes.push({
              id: 'chain-' + panel, label: '链 ' + list.length, kind: 'chain', group: 'chain',
              path: CHAIN_DIR + '\\' + panel + '.jsonl', size: 0, panel: panel,
              total: list.length, recent: list.slice(-3).reverse()
            });
            edges.push({ a: 'area-' + panel, b: 'chain-' + panel, kind: 'chain' });
          });
        }));
      }).catch(function () { /* 没有链目录就算了 */ }));

      // 技能归属（2026-10-26）：读 skills\_索引.md 的「属于哪个场景」列，把技能挂到它 owner 的 area 上
      // 2026-10-27 修：那一格写的是「场景名（`场景id` · 面板 `面板id`）」，旧正则取第一个形如 xx-xx 的反引号词
      //   ⇒ pc-cleanup / self-profile / code-dev / oa-ops 被解析成「场景 id」（area-pc-cleanup 之类根本不存在）
      //   ⇒ 边悬空、画不出来 ⇒ 这几个技能点看着"没连线"。现在只认**真实存在的 area owner（面板 id）**。
      // 2026-11-07：同一份索引还兼作**技能清单的二级兜底**（列目录失败时用它，别再退回硬编码旧表）；
      //   索引里没写归属时再按「技能名 == 场景 id」同名兜底一次（模板里 5 个技能与场景 id 同名，
      //   新克隆还没有 _索引.md 时也能把技能挂对场景，而不是全挂 core）。
      var AREA_IDS = {};
      areas.forEach(function (a) { if (a && a.owner) AREA_IDS[a.owner] = 1; });
      var SCENE_OWNER = {};
      areas.forEach(function (a) { if (a && a.id && a.owner) SCENE_OWNER[String(a.id)] = a.owner; });
      var skillIndexP = readText(SKILL_DIR + '\\_索引.md').then(function (txt) {
        var ownerMap = {}, names = [];
        String(txt || '').split(/\r?\n/).forEach(function (line) {
          if (line.charAt(0) !== '|') return;
          var cells = line.split('|').map(function (c) { return c.trim(); });
          var name = String(cells[1] || '').replace(/`/g, '');
          if (!name || name === '技能' || /^[-:\s]+$/.test(name)) return;   // 表头 / 分隔行
          names.push(name);
          var own = String(cells[2] || '');
          var toks = own.match(/`[a-z0-9][a-z0-9-]{1,20}`/g) || [];
          var picked = '';
          for (var ti = 0; ti < toks.length; ti++) {
            var tk = toks[ti].replace(/`/g, '');
            if (AREA_IDS[tk]) { picked = tk; break; }       // 只认真实 area owner
          }
          ownerMap[name] = picked;                            // 空串 = 没有归属 ⇒ 挂 core
        });
        return { owner: ownerMap, names: names };
      }).catch(function () { return { owner: {}, names: [] }; });

      // 技能节点（球壳 2）：清单优先级 = 真实目录（2026-10-27 审计①）→ _索引.md 表格 → 兜底表
      jobs.push(Promise.all([listDir(SKILL_DIR), skillIndexP]).then(function (arr) {
        var r = arr[0], sidx = arr[1] || { owner: {}, names: [] };
        var dirs = (r && r.ok !== false) ? (r.rows || []).filter(function (it) {
          return it && it.name && String(it.name).charAt(0) !== '_' && it.isDir !== false;
        }).map(function (it) { return String(it.name); }) : [];
        var list = dirs.length ? dirs.slice().sort() : (sidx.names.length ? sidx.names : SKILL_FALLBACK);
        list.forEach(function (n) {
          var id = 'skill-' + n;
          jobs.push(statSize(SKILL_DIR + '\\' + n + '\\SKILL.md').then(function (sz) {
            nodes.push({ id: id, label: n, kind: 'skill', group: 'skill', path: SKILL_DIR + '\\' + n + '\\SKILL.md', size: sz });
            var ownerPanel = sidx.owner[n] || SCENE_OWNER[n] || '';
            edges.push({ a: ownerPanel ? ('area-' + ownerPanel) : 'core', b: id, kind: 'skill' });
            if (ownerPanel) ownerSkill[id] = ownerPanel;
          }));
        });
      }));

      return Promise.all(jobs).then(function () { return Promise.all(jobs); });
    }).then(function () {
      // 路径校验（2026-10-27 审计⑤）：每个节点加载时验一次，失效的标红、详情里写明
      return Promise.all(nodes.filter(function (n) { return n.path; }).map(function (n) {
        return statOk(n.path).then(function (okk) { n.missing = !okk; });
      }));
    }).then(function () {
      // 依赖边：area 文本里提到别的 owner ⇒ 连一条
      var owners = nodes.filter(function (n) { return n.kind === 'area'; }).map(function (n) { return n.label; });
      nodes.filter(function (n) { return n.kind === 'area' && n.text; }).forEach(function (n) {
        owners.forEach(function (o) {
          if (o === n.label) return;
          if (new RegExp('`?' + o.replace(/[-]/g, '\\-') + '`?').test(n.text)) {
            edges.push({ a: n.id, b: 'area-' + o, kind: 'dep' });
          }
        });
      });
      // 重名项目（两组「我的git hub仓库」）：后面缀盘符区分，别让人看混
      var nameCount = {};
      nodes.filter(function (n) { return n.kind === 'project'; }).forEach(function (n) { nameCount[n.label] = (nameCount[n.label] || 0) + 1; });
      nodes.filter(function (n) { return n.kind === 'project' && nameCount[n.label] > 1; }).forEach(function (n) {
        var m = String(n.root || '').match(/^([A-Za-z]):/);
        n.label = n.label + (m ? '（' + m[1].toUpperCase() + ' 盘）' : '');
      });

      // 项目归属：登记表给了 owner ⇒ 直接连到 owner 的 area；没有才退回"正文里提到名字"的启发式
      var areaById = {};
      nodes.filter(function (n) { return n.kind === 'area'; }).forEach(function (n) { areaById[n.label] = n; });
      var regDone = {};
      nodes.filter(function (n) { return n.kind === 'project' && n.owner; }).forEach(function (n) {
        var target = areaById[n.owner] || null;
        edges.push({ a: target ? target.id : 'core', b: n.id, kind: 'project' });
        regDone[n.id] = 1;
      });

      // 项目归属（兜底）：某 area 正文里出现项目名 ⇒ 连到它；否则挂 core
      var areaNodes = nodes.filter(function (n) { return n.kind === 'area' && n.text; });
      nodes.filter(function (n) { return n.kind === 'project' && !regDone[n.id]; }).forEach(function (p) {
        var owner = null;
        for (var ai = 0; ai < areaNodes.length; ai++) {
          if (String(areaNodes[ai].text).indexOf(p.label) >= 0) { owner = areaNodes[ai]; break; }
        }
        edges.push({ a: owner ? owner.id : 'core', b: p.id, kind: 'project' });
      });
      nodes.forEach(function (n) { delete n.text; n.deg = 0; });
      var byId = {}; nodes.forEach(function (n) { byId[n.id] = n; });
    // 尺寸变了就重设位图（真机上 ResizeObserver 有时晚一拍）
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    }
      // 2026-10-27：边只留两端都真实存在的；悬空的丢掉并在头部报数（不再"悄悄算一条画不出来的线"）
      var nDangling = 0;
      edges = edges.filter(function (e) {
        if (byId[e.a] && byId[e.b]) return true;
        nDangling++;
        return false;
      });
      edges.forEach(function (e) { if (byId[e.b]) byId[e.b].deg++; if (byId[e.a]) byId[e.a].deg++; });
      layout();
      bornAt = performance.now();
      // 2026-10-27 审计③：17 个区域里有「宿主 / 全体场景」两个伪节点，不再叫"场景 17"
      var nArea = nodes.filter(function (n) { return n.kind === 'area'; }).length;
      var nPseudo = nodes.filter(function (n) { return n.kind === 'area' && /^(宿主|全体场景)$/.test(String(n.label)); }).length;
      var nChainN = nodes.filter(function (n) { return n.kind === 'chain'; }).length;
      var nMiss = nodes.filter(function (n) { return n.missing; }).length;
      // 2026-10-27（宿主：这段"看着太丑"）：不再拼一整句纯文本 —— 每项一个小段，整段不拆行；
      //   面板窄时按「·」整段换行（不会把「孤立 0」拆成「孤 / 立 0」），右侧按钮也不会被挤压成两行。
      var nSkillN = nodes.filter(function (n) { return n.kind === 'skill'; }).length;
      var nMemN = nodes.filter(function (n) { return n.kind === 'memory'; }).length;
      var nDocN = nodes.filter(function (n) { return n.kind === 'doc'; }).length;
      var nSrcN = nodes.filter(function (n) { return n.kind === 'source'; }).length;
      var nProjN = nodes.filter(function (n) { return n.kind === 'project'; }).length;
      var nAnchorN = nodes.filter(function (n) { return n.kind === 'chain'; }).reduce(function (a, n) { return a + (n.total || 0); }, 0);
      var nLoneN = nodes.filter(function (n) { return n.kind !== 'core' && !n.deg; }).length;
      var chips = [
        { t: '区域 ' + nArea + '（' + (nArea - nPseudo) + ' 场景 + 宿主 + 全体）' },
        { t: '技能 ' + nSkillN },
        { t: '私有记忆 ' + nMemN },
        { t: '共享 ' + nDocN },
        { t: '数据源 ' + nSrcN },
        { t: '提交链 ' + nChainN + ' 文件 / ' + nAnchorN + ' 锚点' },
        { t: '项目 ' + nProjN },
        { t: '连线 ' + edges.length },
        { t: '孤立 ' + nLoneN, cls: nLoneN ? ' bad' : '' }
      ];
      if (nDangling) chips.push({ t: '⛔ 悬空边 ' + nDangling, cls: ' bad' });
      chips.push(nMiss ? { t: '⛔ 路径失效 ' + nMiss, cls: ' bad' } : { t: '路径全在', cls: ' ok' });
      stat.innerHTML = '';
      chips.forEach(function (c, ci) {
        if (ci) stat.appendChild(el('span', 'kneu-sep', '·'));
        stat.appendChild(el('span', 'kneu-seg' + (c.cls || ''), c.t));
      });
      stat.title = '数据源：引擎\\场景记忆\\_共享记忆（索引/项目/记忆地图/提交链）+ .dsh\\skills 目录'
        + ' · 核对时间 ' + new Date().toLocaleString('zh-CN', { hour12: false });
      // 2026-11-07：统计段建好后 HUD 的真实高度才定下来（窄面板会折成多行）⇒ 再排一次，
      //   fitToViewport 才能按 HUD 实际高度留出顶部空间，节点不会钻到统计字底下。
      layout();
    }).catch(function (e) {
      stat.textContent = '读不到共享记忆：' + ((e && e.message) || e);
    });
  }

  // ---------- 3D 布置 ----------
  // 2026-11-07 重做（宿主：「优化各节点的位置关系」）。旧版是"每个种类各按数组下标绕一圈"，三个硬伤：
  //   ① 技能环的角度跟归属场景无关 ⇒ 「技能→owner 场景」的线横穿整张图，点一多就成一团麻；
  //   ② 半径写死 430 / 700，与面板尺寸无关 ⇒ 面板一窄，外圈节点直接被裁到画布外（880×626 实测裁掉 5 个点）；
  //   ③ 记忆/链/项目的半径 = 各自 owner 半径 × 系数，而 owner 半径又按奇偶错开 0.86
  //      ⇒ 同一个场景的卫星忽近忽远，看不出归属。
  // 新口径：主环 = 场景（顺序与左侧场景列表一致）；每个场景的卫星（记忆 → 技能 → 项目/链）放在
  //   **它自己的扇区**里由内到外逐层外扩；共享文档/数据源贴内核；最后按当前画布做一次投影包围盒适配
  //   （fitToViewport）⇒ 任何面板尺寸下开局都不裁切、不糊在中心。场景顺序保持 index.json 顺序，不重排。
  // P2 收尾 3e-2（B-lite）：显式状态 S —— get/set 直连下面闭包变量；core 经 with(S) 读写同一份状态。
  var S = {
    get F() { return F; }, set F(v) { F = v; }, get OPEN() { return OPEN; }, set OPEN(v) { OPEN = v; },
    get P() { return P; }, set P(v) { P = v; }, get MEM_ROOT() { return MEM_ROOT; }, set MEM_ROOT(v) { MEM_ROOT = v; },
    get ROOT() { return ROOT; }, set ROOT(v) { ROOT = v; }, get SKILL_DIR() { return SKILL_DIR; }, set SKILL_DIR(v) { SKILL_DIR = v; },
    get SKILL_FALLBACK() { return SKILL_FALLBACK; }, set SKILL_FALLBACK(v) { SKILL_FALLBACK = v; }, get EDGE_LABEL() { return EDGE_LABEL; }, set EDGE_LABEL(v) { EDGE_LABEL = v; },
    get GROUP() { return GROUP; }, set GROUP(v) { GROUP = v; }, get COLOR() { return COLOR; }, set COLOR(v) { COLOR = v; },
    get PROJECT_ROOTS() { return PROJECT_ROOTS; }, set PROJECT_ROOTS(v) { PROJECT_ROOTS = v; }, get NON_PROJECTS() { return NON_PROJECTS; }, set NON_PROJECTS(v) { NON_PROJECTS = v; },
    get MEM_DIR() { return MEM_DIR; }, set MEM_DIR(v) { MEM_DIR = v; }, get CHAIN_DIR() { return CHAIN_DIR; }, set CHAIN_DIR(v) { CHAIN_DIR = v; },
    get MEMORY_BY_PANEL() { return MEMORY_BY_PANEL; }, set MEMORY_BY_PANEL(v) { MEMORY_BY_PANEL = v; }, get cv() { return cv; }, set cv(v) { cv = v; },
    get hud() { return hud; }, set hud(v) { hud = v; }, get stat() { return stat; }, set stat(v) { stat = v; },
    get searchWrap() { return searchWrap; }, set searchWrap(v) { searchWrap = v; }, get search() { return search; }, set search(v) { search = v; },
    get btns() { return btns; }, set btns(v) { btns = v; }, get bRot() { return bRot; }, set bRot(v) { bRot = v; },
    get bReset() { return bReset; }, set bReset(v) { bReset = v; }, get bMem() { return bMem; }, set bMem(v) { bMem = v; },
    get bFx() { return bFx; }, set bFx(v) { bFx = v; }, get bLabel() { return bLabel; }, set bLabel(v) { bLabel = v; },
    get bReload() { return bReload; }, set bReload(v) { bReload = v; }, get detail() { return detail; }, set detail(v) { detail = v; },
    get legend() { return legend; }, set legend(v) { legend = v; }, get nodes() { return nodes; }, set nodes(v) { nodes = v; },
    get edges() { return edges; }, set edges(v) { edges = v; }, get RY0() { return RY0; }, set RY0(v) { RY0 = v; },
    get ry() { return ry; }, set ry(v) { ry = v; }, get hover() { return hover; }, set hover(v) { hover = v; },
    get ownerSkill() { return ownerSkill; }, set ownerSkill(v) { ownerSkill = v; }, get labelMode() { return labelMode; }, set labelMode(v) { labelMode = v; },
    get fx() { return fx; }, set fx(v) { fx = v; }, get onlyMem() { return onlyMem; }, set onlyMem(v) { onlyMem = v; },
    get bornAt() { return bornAt; }, set bornAt(v) { bornAt = v; }, get introBoot() { return introBoot; }, set introBoot(v) { introBoot = v; },
    get stars() { return stars; }, set stars(v) { stars = v; }, get W() { return W; }, set W(v) { W = v; },
    get REF_ZOOM() { return REF_ZOOM; }, set REF_ZOOM(v) { REF_ZOOM = v; }, get viewShiftY() { return viewShiftY; }, set viewShiftY(v) { viewShiftY = v; },
    get drag() { return drag; }, set drag(v) { drag = v; }, get statAll() { return statAll; }, set statAll(v) { statAll = v; },
    get ro() { return ro; }, set ro(v) { ro = v; }, get makeStars() { return makeStars; },
    get readText() { return readText; }, get statSize() { return statSize; },
    get statOk() { return statOk; }, get listDir() { return listDir; },
    get load() { return load; }, get fit() { return fit; },
    get onDown() { return onDown; }, get onMove() { return onMove; },
    get onUp() { return onUp; }, get showDetail() { return showDetail; },
    get RX0() { return RX0; }, set RX0(v) { RX0 = v; },
    get rx() { return rx; }, set rx(v) { rx = v; },
    get zoom() { return zoom; }, set zoom(v) { zoom = v; },
    get sel() { return sel; }, set sel(v) { sel = v; },
    get auto() { return auto; }, set auto(v) { auto = v; },
    get disposed() { return disposed; }, set disposed(v) { disposed = v; },
    get raf() { return raf; }, set raf(v) { raf = v; },
    get last() { return last; }, set last(v) { last = v; },
    get H() { return H; }, set H(v) { H = v; },
    get dpr() { return dpr; }, set dpr(v) { dpr = v; },
    get q() { return q; }, set q(v) { q = v; },
  };
  var CORE = makeNeuronCore(S);
  var layout = CORE.layout, fitToViewport = CORE.fitToViewport, project = CORE.project, draw = CORE.draw,
      drawInner = CORE.drawInner, hexA = CORE.hexA, loop = CORE.loop, pos = CORE.pos, pick = CORE.pick,
      onWheel = CORE.onWheel, openNode = CORE.openNode;
  function fit() {
    dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    var rect = body.getBoundingClientRect();
    // 2026-10-26 真机排查：面板刚建时 rect 可能是 0 ⇒ 先看 clientWidth/Height，还是 0 就下一帧再量
    var cw = body.clientWidth || 0, ch = body.clientHeight || 0;
    var w0 = Math.round(rect.width) || cw, h0 = Math.round(rect.height) || ch;
    if (!w0 || !h0) {
      if (!fit._tries) fit._tries = 0;
      if (fit._tries++ < 60 && !disposed) requestAnimationFrame(fit);
      w0 = w0 || W || 320; h0 = h0 || H || 240;
    } else fit._tries = 0;
    W = Math.max(320, w0);
    H = Math.max(240, h0);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    makeStars();
  }
  function onDown(ev) {
    drag = { x: ev.clientX, y: ev.clientY, ry: ry, rx: rx, moved: false };
    cv.setPointerCapture && cv.setPointerCapture(ev.pointerId);
  }
  function onMove(ev) {
    var p = pos(ev);
    if (drag) {
      var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      ry = drag.ry + dx * 0.006;
      rx = Math.max(-1.1, Math.min(1.1, drag.rx + dy * 0.005));
      return;
    }
    var n = pick(p.x, p.y);
    hover = n ? n.id : null;
    cv.style.cursor = n ? 'pointer' : 'grab';
  }
  function onUp(ev) {
    var wasDrag = drag && drag.moved;
    drag = null;
    if (wasDrag) return;
    var p = pos(ev);
    var n = pick(p.x, p.y);
    sel = n ? n.id : null;
    showDetail(n);
  }
  function showDetail(n) {
    if (!n) { detail.classList.remove('on'); return; }
    detail.innerHTML = '';
    var t = el('div', 'kneu-dt', n.label + (n.title ? (' · ' + n.title) : ''));
    detail.appendChild(t);
    if (n.region) detail.appendChild(el('div', 'kneu-ds', n.region));
    if (n.owner) detail.appendChild(el('div', 'kneu-ds', '归属：' + n.owner + (n.status && n.status !== 'active' ? (' · 状态：' + n.status) : '')));
    (n.paths && n.paths.length ? n.paths : [n.path]).filter(Boolean).forEach(function (pp) {
      detail.appendChild(el('div', 'kneu-dp', pp));
    });
    if (n.aliases && n.aliases.length) detail.appendChild(el('div', 'kneu-ds', '别名：' + n.aliases.join(' / ')));
    if (n.kind === 'chain' && n.recent && n.recent.length) {
      detail.appendChild(el('div', 'kneu-ds', '共 ' + n.total + ' 段 · 最近：'));
      n.recent.forEach(function (e) {
        detail.appendChild(el('div', 'kneu-dp', e.coord + '  ' + String(e.title || '').slice(0, 26)));
      });
    }
    if (n.dsInfo) {
      if (n.dsInfo.count) detail.appendChild(el('div', 'kneu-ds', '数量：' + n.dsInfo.count));
      if (n.dsInfo.caveat) detail.appendChild(el('div', 'kneu-ds', '说明：' + n.dsInfo.caveat));
      if (n.dsInfo.index) detail.appendChild(el('div', 'kneu-dp', n.dsInfo.index));
    }
    if (n.isDir) detail.appendChild(el('div', 'kneu-ds', '（目录 · 里面按主题分文件）'));
    else if (n.size) detail.appendChild(el('div', 'kneu-ds', '约 ' + (n.size > 1024 ? (n.size / 1024).toFixed(1) + ' KB' : n.size + ' 字节')));
    if (n.missing) detail.appendChild(el('div', 'kneu-ds', '⛔ 文件不存在（路径已失效）：' + (n.path || '')));
    // 关系（2026-10-27 审计⑤：边原来只有颜色，这里写清"这条线是什么意思"）
    var relMap = {};
    var byIdD = {};
    nodes.forEach(function (x) { byIdD[x.id] = x; });
    edges.forEach(function (e2) {
      if (e2.a !== n.id && e2.b !== n.id) return;
      var o = byIdD[(e2.a === n.id) ? e2.b : e2.a];
      if (!o) return;
      var k = EDGE_LABEL[e2.kind] || e2.kind;
      (relMap[k] = relMap[k] || []).push(o.label);
    });
    Object.keys(relMap).forEach(function (k) {
      detail.appendChild(el('div', 'kneu-ds', k + '（' + relMap[k].length + '）：' + relMap[k].slice(0, 6).join('、') + (relMap[k].length > 6 ? ' …' : '')));
    });
    var row = el('div', 'kneu-drow');
    var bOpen = el('button', 'kneu-btn', n.isDir ? '📂 打开目录' : '📂 打开文件');
    bOpen.type = 'button';
    bOpen.addEventListener('click', function (ev) { ev.stopPropagation(); openNode(n); });
    var bReveal = el('button', 'kneu-btn', '🗂 资源管理器定位');
    bReveal.type = 'button';
    bReveal.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var APP = (window.app && window.app.app) || null;
      var p2 = n.path || (n.paths && n.paths[0]);
      if (!p2) { stat.textContent = '这个节点没有路径'; return; }
      if (APP && APP.revealPath) Promise.resolve(APP.revealPath(p2)).then(function (r) { if (r && r.ok === false) stat.textContent = '定位失败：' + (r.error || ''); });
      else stat.textContent = '这个版本没有定位通道';
    });
    var bCopy = el('button', 'kneu-btn', '⧉ 复制路径');
    bCopy.type = 'button';
    bCopy.addEventListener('click', function (ev) {
      ev.stopPropagation();
      try { navigator.clipboard.writeText(n.path || ''); bCopy.textContent = '✓ 已复制'; } catch (e) { /* ignore */ }
    });
    row.appendChild(bOpen); row.appendChild(bReveal); row.appendChild(bCopy);
    detail.appendChild(row);
    detail.classList.add('on');
  }

  bRot.addEventListener('click', function () {
    auto = !auto;
    bRot.classList.toggle('on', auto);
  });
  bReset.addEventListener('click', function () {
    ry = RY0; rx = RX0; zoom = 1.42; sel = null; hover = null; detail.classList.remove('on');
    // 复位 = 回默认机位；顺便按默认机位重排一次（用户可能在别的机位下改过面板宽度，适配是按 REF 机位算的）
    if (nodes.length) layout();
  });
  bReload.addEventListener('click', function () {
    introBoot = true;                 // 2026-10-27：重读 = 重读数据 + 重播一次入场动画
    bornAt = performance.now();
    load();
  });
  var statAll = '';   // 全量统计文案（切回时还原）
  bMem.addEventListener('click', function () {
    onlyMem = !onlyMem;
    bMem.textContent = onlyMem ? '只看记忆 ✓' : '只看记忆';
    bMem.classList.toggle('on', onlyMem);
    if (onlyMem) {
      statAll = stat.textContent;
      var c = { area: 0, memory: 0, chain: 0, doc: 0, chainSeg: 0 };
      nodes.forEach(function (n) {
        if (n.kind === 'area') c.area++;
        else if (n.kind === 'memory') c.memory++;
        else if (n.kind === 'chain') { c.chain++; c.chainSeg += (n.total || 0); }
        else if (n.kind === 'doc') c.doc++;
      });
      stat.textContent = '只看记忆 · 场景 ' + c.area + ' · 私有记忆 ' + c.memory + ' · 提交链 ' + c.chain + ' 条/' + c.chainSeg + ' 段 · 共享 ' + c.doc;
    } else if (statAll) {
      stat.textContent = statAll;
    }
  });
  bFx.addEventListener('click', function () {
    fx = !fx;
    bFx.textContent = '动效：' + (fx ? '开' : '关');
    bFx.classList.toggle('on', fx);
  });
  bFx.classList.toggle('on', fx);
  bLabel.addEventListener('click', function () {
    labelMode = (labelMode + 1) % 3;
    bLabel.textContent = '标签：' + ['自动', '全部', '关'][labelMode];
  });
  search.addEventListener('input', function () { q = String(search.value || '').trim().toLowerCase(); });
  cv.addEventListener('pointerdown', onDown);
  cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp);
  cv.addEventListener('pointerleave', function () { hover = null; });
  cv.addEventListener('wheel', onWheel, { passive: false });
  bRot.classList.toggle('on', auto);

  var ro = null;
  try {
    // 2026-11-07：尺寸变了除了重设位图，还要重排一次 —— 节点半径是按画布尺寸适配的（见 fitToViewport），
    //   只 fit() 不 layout() 会让窄面板里外圈节点一直裁在画布外。
    ro = new ResizeObserver(function () { fit(); if (nodes.length) layout(); });
    ro.observe(body);
  } catch (e) { /* 老内核没有 ResizeObserver */ }
  fit();
  load();
  raf = requestAnimationFrame(loop);

  delete body.dataset.neuronDone;
  return function cleanup() {
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    if (ro) { try { ro.disconnect(); } catch (e) { /* ignore */ } }
    cv.removeEventListener('pointerdown', onDown);
    cv.removeEventListener('pointermove', onMove);
    cv.removeEventListener('pointerup', onUp);
    cv.removeEventListener('wheel', onWheel);
    body.innerHTML = '';
  };
};
