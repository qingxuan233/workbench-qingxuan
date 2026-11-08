// panels/neuron-core.js —— neuron 面板的"数据/布局/绘制数学"核心（P2 收尾 3e-2，B-lite 显式状态）
// 来源：renderers.js 的 neuron 单闭包内 11 个嵌套 function（layout/fitToViewport/project/draw/drawInner/
// hexA/loop/pos/pick/onWheel/openNode，共约 600 行），逐字搬入（函数声明改为 `NAME = function (...) {...};`）。
//
// 设计：**显式状态对象 S** + `with (S)`。
//   · panel-neuron.js 用 Object.defineProperty 把闭包局部/剩余 helper 绑到 S（get/set 直连闭包变量）；
//   · core 内函数体仍按原样写裸名字 ⇒ 经过 with 作用域时读写都落到 S ⇒ 可变量（W/ry/viewShiftY/
//     introBoot/labelMode/hover/drag 等）的**写回自动回到 panel 闭包**，无需逐处改引用；
//   · `with` 只在**非严格模式**可用 ⇒ 本文件不写 'use strict'（原 renderers.js 虽严格，但函数体本身
//     不含 strict 专属语法）。
//
// 加载顺序：… → panels/neuron-core.js → panels/panel-neuron.js → … → chrome.js → renderers.js。
// 等价判据：**放弃逐字节**（闭包状态显式化必然改作用域结构）；用探针行为判据（canvas 出现 / mount-cleanup /
// pause-resume / 加载 smoke），见证据。
function makeNeuronCore(S) {
  var layout, fitToViewport, project, draw, drawInner, hexA, loop, pos, pick, onWheel, openNode;
  with (S) {
  layout = function () {
    var areas = nodes.filter(function (n) { return n.kind === 'area'; });
    var skills = nodes.filter(function (n) { return n.kind === 'skill'; });
    var docs = nodes.filter(function (n) { return n.kind === 'doc'; });
    var projects = nodes.filter(function (n) { return n.kind === 'project'; });
    var mems = nodes.filter(function (n) { return n.kind === 'memory'; });
    var srcs = nodes.filter(function (n) { return n.kind === 'source'; });
    var chains = nodes.filter(function (n) { return n.kind === 'chain'; });
    var R1 = 430;                                  // 主环世界半径（最终会被 fitToViewport 整体缩放）
    // ① 场景主环：均匀铺开 + 轻微上下起伏（看得出是 3D，但不破坏"环"的读法）
    var areaBy = {};
    areas.forEach(function (n, i) {
      var t = -Math.PI / 2 + (i / Math.max(1, areas.length)) * Math.PI * 2;
      n.ax = Math.cos(t); n.az = Math.sin(t); n.at = t;
      n.x = n.ax * R1;
      n.z = n.az * R1;
      n.y = Math.sin(t * 2) * 30;
      n.r = 9 + Math.min(9, Math.sqrt(n.size / 700));
      areaBy[n.label] = n;
    });
    // ② 卫星贴 owner 的通用摆法：同扇区（owner 角度 + 偏角）、指定半径系数、指定高度偏移
    function placeNear(n, own, radK, angOff, yOff, r0) {
      var t = own.at + angOff;
      var rr = R1 * radK;
      n.x = Math.cos(t) * rr;
      n.z = Math.sin(t) * rr;
      n.y = own.y + yOff;
      if (r0) n.r = r0;
    }
    var lone = { memory: [], skill: [], project: [], chain: [] };
    // ③ 私有记忆：owner 扇区里紧贴场景外侧（"随身笔记"）
    mems.forEach(function (n) {
      var own = areaBy[n.ownerPanel];
      if (own) placeNear(n, own, 1.26, 0.10, 26, 4.6);
      else lone.memory.push(n);
    });
    // ④ 技能：**按 owner 分组放进各自扇区** —— "位置关系"最要紧的一条：归属线短、归属一眼看得出来。
    //   同一场景的多个技能沿扇区小角度散开；技能多时角间距自动收窄，不会散到别人的扇区去。
    var bySkillOwner = {};
    skills.forEach(function (n) {
      var op = ownerSkill[n.id];
      if (op && areaBy[op]) (bySkillOwner[op] = bySkillOwner[op] || []).push(n);
      else lone.skill.push(n);
    });
    Object.keys(bySkillOwner).forEach(function (op) {
      var own = areaBy[op], list = bySkillOwner[op];
      list.sort(function (a, b) { return String(a.label).localeCompare(String(b.label), 'zh'); });
      var step = Math.min(0.40, 0.92 / list.length);
      var t0 = own.at + (step * (list.length - 1)) / 2;      // 整组以 owner 角度为中心
      list.forEach(function (n, i) {
        var t = t0 - i * step;
        var rr = R1 * 1.58 * (1 + (i % 2 ? 0.05 : -0.05));   // 奇偶错开一点，标签不叠
        n.x = Math.cos(t) * rr; n.z = Math.sin(t) * rr;
        n.y = own.y + Math.sin(t * 3) * 16 + (i % 2 ? 52 : -52);
        n.r = 5 + Math.min(4, Math.sqrt(n.size / 2200));
      });
    });
    // ⑤ 项目：owner 扇区里靠内（0.68R），多个项目沿扇区散开
    var byProjOwner = {};
    projects.forEach(function (n) {
      var own = n.owner ? areaBy[n.owner] : null;
      if (own) (byProjOwner[n.owner] = byProjOwner[n.owner] || []).push(n);
      else lone.project.push(n);
    });
    Object.keys(byProjOwner).forEach(function (op) {
      var own = areaBy[op], list = byProjOwner[op];
      list.forEach(function (n, i) {
        var t = own.at - 0.17 + (i - (list.length - 1) / 2) * 0.19;
        var rr = R1 * (0.66 + (i % 2 ? 0.05 : 0));
        n.x = Math.cos(t) * rr; n.z = Math.sin(t) * rr;
        n.y = own.y * 0.5 + (i % 2 ? 16 : -16);
        n.r = 5.4;
      });
    });
    // ⑥ 提交链：owner 扇区最外一层（反向偏角），像场景外面挂的年表
    chains.forEach(function (n) {
      var own = areaBy[n.panel];
      if (own) placeNear(n, own, 1.86, -0.14, -34, 4.4);
      else lone.chain.push(n);
    });
    // ⑦ 共享文档：贴内核的一圈小三角（不占场景扇区，避免压住场景标签）
    var R0 = R1 * 0.52;
    docs.forEach(function (n, i) {
      var t = -Math.PI / 2 + Math.PI * 0.34 + (i / Math.max(1, docs.length)) * Math.PI * 2;
      n.x = Math.cos(t) * R0; n.z = Math.sin(t) * R0;
      n.y = Math.sin(t * 2) * 26;
      n.r = 8;
    });
    // ⑧ 数据源：内核外一小圈（"我的家底"）
    var RS = R1 * 0.36;
    srcs.forEach(function (n, i) {
      var t = 0.2 + (i / Math.max(1, srcs.length)) * Math.PI * 2;
      n.x = Math.cos(t) * RS; n.z = Math.sin(t) * RS;
      n.y = (i % 2 ? 14 : -14);
      n.r = 5.2;
    });
    // ⑨ 无归属的卫星：外圈均匀铺开（半径各不相同，互不重叠）
    function placeRing(list, radK, yAmp, yBase) {
      list.sort(function (a, b) { return String(a.label).localeCompare(String(b.label), 'zh'); });
      list.forEach(function (n, i) {
        var t = 0.5 + (i / Math.max(1, list.length)) * Math.PI * 2;
        n.x = Math.cos(t) * R1 * radK; n.z = Math.sin(t) * R1 * radK;
        n.y = yBase + Math.sin(t * 1.7) * yAmp;
      });
    }
    placeRing(lone.skill, 1.62, 150, 0);
    placeRing(lone.memory, 1.30, 40, 10);
    placeRing(lone.project, 0.84, 60, 0);
    placeRing(lone.chain, 1.94, 40, -20);
    lone.skill.forEach(function (n) { n.r = 5 + Math.min(4, Math.sqrt(n.size / 2200)); });
    nodes.filter(function (n) { return n.kind === 'core'; }).forEach(function (n) { n.x = 0; n.y = 0; n.z = 0; });
    // ⑩ 视口适配：按**当前画布**投影一遍，把整张图缩进可视区（上方 HUD / 下方图例留白）。
    //    面板变宽变窄都会重跑（见 ResizeObserver）⇒ 任何尺寸开局都不裁切。
    fitToViewport();
  }

  // 投影包围盒 → 整体缩放。透视是非线性的（越靠前的点被放得越大），所以必须**迭代到收敛**：
  //   只缩不放会在窄面板上留下一大片空白（第一轮按被透视放大的包络缩得过头，后面又不敢放大）。
  // 注意：适配按**默认缩放 REF_ZOOM / 默认机位**算，不按用户当前滚轮与拖动 —— 否则用户放大后
  // 一改面板宽度，布局会被永久缩小（缩完再复位就看不清了）。可用区还要扣掉顶部 HUD 与底部图例的
  // **实际高度**（窄面板时 HUD 会换行变高，写死 108px 会让节点钻到字底下）。
  var REF_ZOOM = 1.42;
  var viewShiftY = 0;              // 可用区中心与画布中心的纵向偏差（HUD 比图例高时把图整体下移）

  fitToViewport = function () {
    if (!nodes.length || !W || !H) return;
    var clamp = function (v, lo, hi) { return Math.max(lo, Math.min(hi, v)); };
    var hudH = (hud && hud.offsetHeight) ? hud.offsetHeight : 0;
    var legH = (legend && legend.offsetHeight) ? legend.offsetHeight : 0;
    var padX = clamp(W * 0.10, 34, 92);
    var padTop = Math.max(clamp(H * 0.12, 64, 108), hudH ? (hudH + 26) : 0);
    var padBot = Math.max(clamp(H * 0.10, 56, 86), legH ? (legH + 20) : 0);
    var availW = Math.max(100, (W - padX * 2) / 2);
    var availH = Math.max(80, (H - padTop - padBot) / 2);
    viewShiftY = (padTop - padBot) / 2;
    var sRy = ry, sRx = rx;
    ry = RY0; rx = RX0;
    for (var it = 0; it < 8; it++) {
      var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
      nodes.forEach(function (n) {
        var p = project(n, REF_ZOOM);
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      });
      var halfW = Math.max(1, (maxX - minX) / 2);
      var halfH = Math.max(1, (maxY - minY) / 2);
      var k = Math.min(availW / halfW, availH / halfH);
      if (k > 0.97 && k < 1.04) break;             // 收敛：两个方向都用上了
      k = Math.max(0.25, Math.min(2.5, k));        // 每轮限幅，防透视非线性导致来回震荡
      nodes.forEach(function (n) { n.x *= k; n.y *= k; n.z *= k; });
    }
    ry = sRy; rx = sRx;
  }

  // ---------- 画布 ----------

  project = function (n, zOverride) {
    var cy = Math.cos(ry), sy = Math.sin(ry);
    var x1 = n.x * cy - n.z * sy;
    var z1 = n.x * sy + n.z * cy;
    var cx0 = Math.cos(rx), sx0 = Math.sin(rx);
    var y1 = n.y * cx0 - z1 * sx0;
    var z2 = n.y * sx0 + z1 * cx0;
    var f = 820;
    var zz = (zOverride == null) ? zoom : zOverride;
    var s = (f / (f + z2 + 420)) * zz;
    return { x: W / 2 + x1 * s, y: H / 2 + y1 * s + viewShiftY, s: s, z: z2 };
  }

  draw = function () {
    var ctx = cv.getContext('2d');
    try { drawInner(ctx); } catch (e) {
      try {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        ctx.font = '700 15px Consolas, monospace';
        ctx.fillStyle = '#ff4d6d';
        ctx.textAlign = 'left';
        ctx.fillText('neuron 绘制出错：' + ((e && e.message) || e), 16, 60);
      } catch (e2) { /* ignore */ }
    }
  }

  drawInner = function (ctx) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // 背景：中心微光
    var bg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.62);
    bg.addColorStop(0, isLightTheme() ? 'rgba(37,99,235,.06)' : 'rgba(30,54,96,.55)');
    bg.addColorStop(1, 'rgba(6,9,16,0)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    var tt = fx ? (performance.now() / 1000) : 0;
    // 星点（有动效时轻微明暗呼吸，静止时一片星空）
    if (stars.length) {
      for (var si = 0; si < stars.length; si++) {
        var st = stars[si];
        var tw = fx ? (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(tt * st.sp + st.ph))) : 0.55;
        ctx.beginPath();
        ctx.arc(st.x, st.y, st.r, 0, 6.2832);
        ctx.fillStyle = isLightTheme() ? ('rgba(15,23,42,' + (0.16 * tw) + ')') : ('rgba(190,215,255,' + (0.07 * tw) + ')');
        ctx.fill();
      }
    }
    // 暗角：把注意力收到中间
    var vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.32, W / 2, H / 2, Math.max(W, H) * 0.78);
    vg.addColorStop(0, 'rgba(15,23,42,0)');
    vg.addColorStop(1, isLightTheme() ? 'rgba(15,23,42,.055)' : 'rgba(2,4,9,.55)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);

    // ══ 入场动画（2026-10-27 科幻版）══
    //   节拍：核心点火(0~0.3s) → 冲击波+扫描线(0.15~1.1s) → 连线逐条生长(0.26~1.9s) → 节点被依次点亮(0.26~1.8s) → 余晖淡出
    //   全程一次（2.4s），只在 fx 开着时跑；跑完所有进度=1，完全退回原来的静态渲染路径。
    var INTRO = 2400;
    var animOn = fx || introBoot;                                          // 动效关也允许"重读"重播一次
    var ei = animOn ? Math.max(0, performance.now() - (bornAt || 0)) : INTRO; // 已进入的毫秒数
    if (introBoot && ei > INTRO + 400) introBoot = false;                   // 只播一次，播完自动熄
    var eo = 1 - Math.pow(1 - Math.min(1, ei / INTRO), 3);                  // easeOutCubic：先快后慢
    var introOn = animOn && ei < INTRO + 400;
    var kk = 0.86 + 0.14 * eo;                                              // 位置只从 86% 展开，主要靠"生长"而不是"炸开"
    var D2C = Math.hypot(W, H) * 0.5 || 1;                                  // 画面中心 → 角的距离
    function waveT(norm) { return 260 + norm * 1150; }                      // 冲击波到达某处的时间
    function nodeNorm(n) {
      var qq = project(n);
      return Math.min(1, Math.hypot(qq.x - W / 2, qq.y - H / 2) / D2C);
    }
    function P(n) {
      var pp = project(n);
      if (kk < 0.999) { pp.x = W / 2 + (pp.x - W / 2) * kk; pp.y = H / 2 + (pp.y - H / 2) * kk; }
      return pp;
    }

    var byId = {}; nodes.forEach(function (n) { byId[n.id] = n; });
    var selN = sel ? byId[sel] : null;
    var hoverN = hover ? byId[hover] : null;
    var neigh = {};
    if (hoverN) {
      neigh[hoverN.id] = true;
      edges.forEach(function (e) {
        if (e.a === hoverN.id) neigh[e.b] = true;
        if (e.b === hoverN.id) neigh[e.a] = true;
      });
    }
    function dimmed(n) {
      if (q) {
        var hay = (n.id + ' ' + (n.label || '') + ' ' + (n.title || '') + ' ' + (n.region || '') + ' ' + (n.path || '')).toLowerCase();
        if (hay.indexOf(q) < 0 && n.kind !== 'core') return true;
      }
      if (hoverN) return !neigh[n.id];
      return false;
    }
    // 只看记忆：留下的种类（内核/场景/私有记忆/提交链/共享文档）
    var MEM_KINDS = { core: 1, area: 1, memory: 1, chain: 1, doc: 1 };
    function keep(n) { return !onlyMem || !!MEM_KINDS[n.kind]; }
    function col(group) { return COLOR[group] || '#94a3b8'; }
    function safeR(n, ps) { var r = n.r * ps; return (isFinite(r) && r > 0) ? Math.max(1.6, r) : 1.6; }

    // 先画线（远的先画）
    var segs = edges.map(function (e) {
      var a = byId[e.a], b = byId[e.b];
      if (!a || !b) return null;
      if (!keep(a) || !keep(b)) return null;
      var pa = P(a), pb = P(b);
      return { e: e, a: a, b: b, pa: pa, pb: pb, z: (pa.z + pb.z) / 2 };
    }).filter(Boolean).sort(function (x, y) { return y.z - x.z; });
    segs.forEach(function (s) {
      var hot = hoverN && (s.e.a === hoverN.id || s.e.b === hoverN.id);
      var active = selN && (s.e.a === selN.id || s.e.b === selN.id);
      // 入场：这条线什么时候开始长（按边中点离中心远近，像冲击波扫过去），长 520ms，从 a 端推向 b 端
      var gp = 1;
      if (introOn) {
        var mx = (s.pa.x + s.pb.x) / 2 - W / 2, my = (s.pa.y + s.pb.y) / 2 - H / 2;
        var mn = Math.min(1, Math.hypot(mx, my) / D2C);
        var gt = (ei - waveT(mn)) / 520;
        gp = gt <= 0 ? 0 : (gt >= 1 ? 1 : 1 - Math.pow(1 - gt, 3));
        if (gp <= 0) return;                       // 还没轮到这个方向
      }
      var alpha = (hot ? 0.55 : (active ? 0.4 : Math.max(0.05, 0.22 - s.z / 2600))) * (fx ? (0.5 + 0.5 * eo) : 1);
      if (introOn) alpha *= 0.35 + 0.65 * gp;
      if (s.e.kind === 'skill') alpha *= 0.55;
      if (dimmed(s.a) && dimmed(s.b)) alpha *= 0.25;
      // 线的颜色按类型分（记忆=近白、项目=青、依赖=青蓝、其余=蓝），一眼能分出关系
      var lc = (s.e.kind === 'memory') ? (isLightTheme() ? '71,85,105' : '223,231,255')
        : (s.e.kind === 'project') ? (isLightTheme() ? '13,148,136' : '45,212,191')
        : (s.e.kind === 'dep') ? (isLightTheme() ? '14,116,144' : '127,227,255') : (isLightTheme() ? '37,99,235' : '143,180,255');
      var core = hot ? 1.7 : (s.e.kind === 'dep' ? 1.15 : 0.85);
      var ex2 = s.pb.x, ey2 = s.pb.y;
      if (gp < 1) { ex2 = s.pa.x + (s.pb.x - s.pa.x) * gp; ey2 = s.pa.y + (s.pb.y - s.pa.y) * gp; }
      ctx.beginPath();
      ctx.moveTo(s.pa.x, s.pa.y);
      ctx.lineTo(ex2, ey2);
      if (fx && (hot || active)) {              // 悬停/选中：跑虚线流光
        ctx.setLineDash([5, 6]);
        ctx.lineDashOffset = -(tt * 26) % 11;
      }
      if (fx) {                                 // 霓虹光晕（宽、淡）
        ctx.strokeStyle = 'rgba(' + lc + ',' + (alpha * 0.17) + ')';
        ctx.lineWidth = core * 2.8;
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(' + lc + ',' + alpha + ')';
      ctx.lineWidth = core;
      ctx.stroke();
      ctx.setLineDash([]);
      if (introOn && gp < 1) {                     // 生长头：亮点把线"推"出来
        ctx.beginPath();
        ctx.arc(ex2, ey2, 2.4 + 1.8 * (1 - gp), 0, 6.2832);
        ctx.fillStyle = isLightTheme() ? ('rgba(37,99,235,' + (0.55 + 0.4 * (1 - gp)) + ')') : ('rgba(214,242,255,' + (0.55 + 0.4 * (1 - gp)) + ')');
        ctx.fill();
        ctx.beginPath();
        ctx.arc(ex2, ey2, 7 + 9 * (1 - gp), 0, 6.2832);
        ctx.fillStyle = isLightTheme() ? ('rgba(37,99,235,' + (0.18 * (1 - gp)) + ')') : ('rgba(120,200,255,' + (0.22 * (1 - gp)) + ')');
        ctx.fill();
      }
    });

    // 扫描光（高级感的关键：一次只有一条边在走，不抢戏）
    if (fx && segs.length && kk > 0.9) {
      var CYC = 2.4;
      var slot = Math.floor(tt / CYC);
      var sg2 = segs[slot % segs.length];
      if (sg2 && !dimmed(sg2.a) && !dimmed(sg2.b)) {
        var run2 = (tt % CYC) / CYC;
        var fade = Math.sin(Math.PI * run2);
        var ddx = sg2.pb.x - sg2.pa.x, ddy = sg2.pb.y - sg2.pa.y;
        var hx2 = sg2.pa.x + ddx * run2, hy2 = sg2.pa.y + ddy * run2;
        for (var t2 = 0; t2 < 6; t2++) {
          var q2 = Math.max(0, run2 - t2 * 0.022);
          var x2 = sg2.pa.x + ddx * q2, y2 = sg2.pa.y + ddy * q2;
          ctx.beginPath();
          ctx.arc(x2, y2, 1.5 - t2 * 0.16, 0, 6.2832);
          ctx.fillStyle = isLightTheme() ? ('rgba(37,99,235,' + (0.5 * fade * (1 - t2 / 6)) + ')') : ('rgba(215,235,255,' + (0.5 * fade * (1 - t2 / 6)) + ')');
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(hx2, hy2, 2.2, 0, 6.2832);
        ctx.fillStyle = isLightTheme() ? ('rgba(30,64,175,' + (0.85 * fade) + ')') : ('rgba(240,248,255,' + (0.85 * fade) + ')');
        ctx.fill();
      }
    }

    // 入场专属特效（只在前 2.8 秒，跑完这段画面回到原来的样子）
    if (introOn) {
      var cx0 = W / 2, cy0 = H / 2;
      var maxR = Math.hypot(W, H) * 0.62;
      // ① 核心点火闪光（前 320ms）
      if (ei < 320) {
        var fl = 1 - ei / 320;
        var fg = ctx.createRadialGradient(cx0, cy0, 0, cx0, cy0, 90 + 130 * fl);
        fg.addColorStop(0, isLightTheme() ? 'rgba(37,99,235,.20)' : 'rgba(224,246,255,' + (0.45 * fl) + ')');
        fg.addColorStop(0.4, isLightTheme() ? 'rgba(37,99,235,.10)' : 'rgba(110,200,255,' + (0.2 * fl) + ')');
        fg.addColorStop(1, isLightTheme() ? 'rgba(37,99,235,0)' : 'rgba(80,170,255,0)');
        ctx.fillStyle = fg;
        ctx.fillRect(0, 0, W, H);
      }
      // ② 两层冲击波（错开 180ms，从核心向外扩散、变淡变细）
      for (var wi = 0; wi < 2; wi++) {
        var wt = (ei - wi * 180) / 1100;
        if (wt > 0 && wt < 1) {
          var wr = maxR * (1 - Math.pow(1 - wt, 2.2));
          ctx.beginPath();
          ctx.arc(cx0, cy0, wr, 0, 6.2832);
          ctx.lineWidth = 2.4 - 1.4 * wt;
          ctx.strokeStyle = isLightTheme() ? ('rgba(37,99,235,' + (0.22 * (1 - wt) * (1 - wt)) + ')') : ('rgba(130,214,255,' + (0.34 * (1 - wt) * (1 - wt)) + ')');
          ctx.stroke();
        }
      }
      // ③ 扫描线：一次从上往下抹过（0.15~1.0s），像雷达扫过整片星图
      var sc = (ei - 150) / 850;
      if (sc > 0 && sc < 1) {
        var sy = H * (sc * sc * (3 - 2 * sc));
        var lg = ctx.createLinearGradient(0, sy - 90, 0, sy);
        lg.addColorStop(0, 'rgba(37,99,235,0)');
        lg.addColorStop(0.85, 'rgba(37,99,235,.06)');
        lg.addColorStop(1, 'rgba(37,99,235,.18)');
        ctx.fillStyle = lg;
        ctx.fillRect(0, sy - 90, W, 90);
        ctx.beginPath();
        ctx.moveTo(0, sy); ctx.lineTo(W, sy);
        ctx.lineWidth = 1;
        ctx.strokeStyle = isLightTheme() ? ('rgba(37,99,235,' + (0.22 * Math.sin(Math.PI * sc)) + ')') : ('rgba(190,236,255,' + (0.22 * Math.sin(Math.PI * sc)) + ')');
        ctx.stroke();
      }
      // ④ 沿线奔跑的粒子：入场时 5 颗，错开时间，跑完就没了
      if (segs.length) {
        for (var pi2 = 0; pi2 < 5; pi2++) {
          var pr2 = ((ei / 900) + pi2 * 0.21) % 1;
          if (pr2 <= 0 || pr2 >= 1) continue;
          var s3 = segs[(pi2 * 7 + Math.floor(ei / 900)) % segs.length];
          if (!s3) continue;
          var hx3 = s3.pa.x + (s3.pb.x - s3.pa.x) * pr2;
          var hy3 = s3.pa.y + (s3.pb.y - s3.pa.y) * pr2;
          ctx.beginPath();
          ctx.arc(hx3, hy3, 1.8, 0, 6.2832);
          ctx.fillStyle = isLightTheme() ? ('rgba(37,99,235,' + (0.55 * Math.sin(Math.PI * pr2)) + ')') : ('rgba(235,250,255,' + (0.55 * Math.sin(Math.PI * pr2)) + ')');
          ctx.fill();
        }
      }
    }

    var labelBoxes = [];
    // 再画节点（按深度排序）
    var list = nodes.filter(keep).map(function (n) { return { n: n, p: project(n) }; }).sort(function (a, b) { return a.p.z - b.p.z; });
    list.forEach(function (it) {
      var n = it.n, p = it.p;
      // 入场：节点等冲击波到达才亮（离中心越远越晚），亮的那一下带一圈扩散光环
      var np2 = 1, nring = 0;
      if (introOn) {
        var nt = (ei - waveT(nodeNorm(n))) / 420;
        np2 = nt <= 0 ? 0 : (nt >= 1 ? 1 : 1 - Math.pow(1 - nt, 3));
        if (np2 <= 0) return;
        nring = np2 < 1 ? (1 - np2) : 0;
      }
      var r = safeR(n, p.s) * (fx ? (0.55 + 0.45 * kk) : 1) * (introOn ? (0.5 + 0.5 * np2) : 1);

      var alpha = dimmed(n) ? 0.18 : Math.max(0.35, 1 - p.z / 1500);
      if (introOn) alpha *= 0.25 + 0.75 * np2;
      var c = col(n.group);
      if (n.kind === 'project') { if (n.status === 'delivery') c = isLightTheme() ? '#b45309' : '#f0a35e'; else if (n.status === 'archived' || n.status === 'parked') c = isLightTheme() ? '#64748b' : '#8b93a7'; }
      // 光晕
      var g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3.4);
      g.addColorStop(0, hexA(c, 0.55 * alpha));
      g.addColorStop(0.45, hexA(c, 0.16 * alpha));
      g.addColorStop(1, hexA(c, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, r * 3.4, 0, Math.PI * 2); ctx.fill();
      // 核：球面渐变（左上亮、右下暗）+ 细内描边
      var ng = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.38, r * 0.15, p.x, p.y, r * 1.15);
      ng.addColorStop(0, hexA('#ffffff', 0.55 * alpha));
      ng.addColorStop(0.35, hexA(c, 0.95 * alpha));
      ng.addColorStop(1, hexA(c, 0.72 * alpha));
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = ng;
      ctx.fill();
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.5, r - 0.6), 0, Math.PI * 2);
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = hexA('#ffffff', 0.22 * alpha);
      ctx.stroke();
      // 高光：左上一点亮，球体感
      ctx.beginPath();
      ctx.arc(p.x - r * 0.32, p.y - r * 0.34, Math.max(0.9, r * 0.34), 0, 6.2832);
      ctx.fillStyle = 'rgba(255,255,255,' + (0.28 * alpha) + ')';
      ctx.fill();
      if (nring > 0) {                             // 点亮瞬间：一圈光环扩散出去
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 4 + 26 * (1 - nring), 0, 6.2832);
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = hexA(isLightTheme() ? '#1d4ed8' : '#bfe8ff', 0.55 * nring);
        ctx.stroke();
      }
      if (n.missing) {                     // 2026-10-27 审计⑤：路径失效的点 → 红虚线圈
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 3.5, 0, 6.2832);
        ctx.setLineDash([2, 3]);
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = 'rgba(229,72,77,.8)';
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (n.kind === 'core') {
        ctx.lineWidth = 2; ctx.strokeStyle = hexA(isLightTheme() ? '#0e7490' : '#7fe3ff', 0.8); ctx.stroke();
      }
      if (n.kind === 'core' && fx) {       // 核心：缓慢旋转的细光环（全图唯一的常驻动效）
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(tt * 0.25);
        ctx.beginPath();
        ctx.setLineDash([3, 8]);
        ctx.arc(0, 0, r + 7, 0, 6.2832);
        ctx.lineWidth = 1.1;
        ctx.strokeStyle = hexA(isLightTheme() ? '#0e7490' : '#8fd7ff', 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
      if (selN && n.id === selN.id) {     // 选中：外圈光环
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 5, 0, 6.2832);
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = hexA(isLightTheme() ? '#1e3a8a' : '#cfe1ff', 0.75);
        ctx.stroke();
      }
      // 标签：内核 / 悬停 / 选中 / 搜索命中 / 大节点
      var show = false;
      if (labelMode === 2) show = n.kind === 'core' || (hoverN && n.id === hoverN.id) || (selN && n.id === selN.id);
      else if (labelMode === 1) show = true;
      else show = n.kind === 'core' || (hoverN && n.id === hoverN.id) || (selN && n.id === selN.id)
        || (q && !dimmed(n)) || (n.kind === 'area' && p.s > 0.55)
        || (n.kind === 'project' && (n.id === sel || n.id === hover || (p.s > 1.05 && n.deg > 0)));
      if (show) {
        var fsz = n.kind === 'core' ? 13 : (n.kind === 'area' ? 11 : (n.kind === 'project' ? 10 : 9));
        ctx.font = (n.kind === 'core' ? '700 13px' : (n.kind === 'area' ? '600 11px' : '500 ' + fsz + 'px')) + ' ui-sans-serif, "Microsoft YaHei", system-ui';
        var lbl = String(n.label || '');
        if (n.kind === 'skill' && lbl.length > 15) lbl = lbl.slice(0, 14) + '…';
        var tw = ctx.measureText(lbl).width;
        var force = (hoverN && n.id === hoverN.id) || (selN && n.id === selN.id) || (q && !dimmed(n));
        // 四向候选：上 → 下 → 右 → 左，挑第一个不撞的；都撞就照画（宿主：所有点都要有标签）
        // 记忆/链/数据源这类"卫星":先试右边（免得压住它贴着的主场景标签）；场景/项目先试上方
        var rightFirst = (n.kind === 'memory' || n.kind === 'chain' || n.kind === 'source');
        var cands = rightFirst
          ? [{ lx: p.x + r + 7, ly: p.y + 4, align: 'left' },
             { lx: p.x, ly: p.y - r - 7, align: 'center' },
             { lx: p.x, ly: p.y + r + 13, align: 'center' },
             { lx: p.x - r - 7, ly: p.y + 4, align: 'right' }]
          : [{ lx: p.x, ly: p.y - r - 7, align: 'center' },
             { lx: p.x, ly: p.y + r + 13, align: 'center' },
             { lx: p.x + r + 7, ly: p.y + 4, align: 'left' },
             { lx: p.x - r - 7, ly: p.y + 4, align: 'right' }];
        var pick = cands[0], clash = false;
        for (var ci = 0; ci < cands.length; ci++) {
          var cd = cands[ci];
          var x1 = cd.align === 'left' ? cd.lx : (cd.align === 'right' ? cd.lx - tw : cd.lx - tw / 2);
          var bx0 = { x1: x1 - 2, x2: x1 + tw + 2, y1: cd.ly - 10, y2: cd.ly + 3 };
          var hit2 = false;
          for (var bi = 0; bi < labelBoxes.length; bi++) {
            var bb = labelBoxes[bi];
            if (bx0.x1 < bb.x2 && bx0.x2 > bb.x1 && bx0.y1 < bb.y2 && bx0.y2 > bb.y1) { hit2 = true; break; }
          }
          if (!hit2) { pick = cd; clash = false; break; }
          pick = cd; clash = true;
        }
        var ly = pick.ly, alignMode = pick.align;
        var box = { x1: (alignMode === 'left' ? pick.lx : (alignMode === 'right' ? pick.lx - tw : pick.lx - tw / 2)) - 2,
                    x2: (alignMode === 'left' ? pick.lx + tw : (alignMode === 'right' ? pick.lx : pick.lx + tw / 2)) + 2,
                    y1: ly - 10, y2: ly + 3 };
        if (!clash || force || labelMode !== 2) {
          labelBoxes.push(box);
          // 底片：深色半透明圆角，压住后面的线和星点（"更清晰"主要靠它）
          var bx = box.x1 - 3, by = box.y1, bw = (box.x2 - box.x1) + 6, bh = (box.y2 - box.y1) + 1;
          ctx.beginPath();
          if (ctx.roundRect) { ctx.roundRect(bx, by, bw, bh, 4); }
          else { ctx.rect(bx, by, bw, bh); }
          ctx.fillStyle = isLightTheme() ? ('rgba(255,255,255,' + (force ? 0.94 : 0.72) + ')') : ('rgba(6,10,18,' + (force ? 0.62 : 0.34) + ')');
          ctx.fill();
          ctx.fillStyle = dimmed(n) ? 'rgba(15,23,42,.35)' : (isLightTheme() ? 'rgba(15,23,42,.92)' : 'rgba(226,236,255,.92)');
          ctx.fillStyle = force ? (isLightTheme() ? '#0f172a' : '#eaf2ff') : ctx.fillStyle;
          ctx.textAlign = alignMode;
          ctx.fillText(lbl, pick.lx, ly);
        }
      }
    });
  }

  hexA = function (hex, a) {
    var h = hex.replace('#', '');
    var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }


  loop = function (t) {
    if (disposed) return;
    if (auto && !document.hidden) { ry += 0.0032; }
    draw();
    raf = requestAnimationFrame(loop);
  }

  // ---------- 交互 ----------
  let drag = null;

  pos = function (ev) {
    var r = cv.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  pick = function (mx, my) {
    var best = null, bestD = 1e9;
    nodes.forEach(function (n) {
      var p = project(n);
      var rr = Math.max(6, n.r * p.s) + 6;
      var d = Math.hypot(p.x - mx, p.y - my);
      if (d < rr && d < bestD) { bestD = d; best = n; }
    });
    return best;
  }

  onWheel = function (ev) {
    ev.preventDefault();
    zoom = Math.max(0.35, Math.min(9, zoom * (ev.deltaY > 0 ? 0.92 : 1.08)));
  }
  // 2026-10-27 审计⑤：点击/定位统一入口 —— 文件→预览面板，目录→资源管理器，失败退回系统打开

  openNode = function (n) {
    var p = n && (n.path || (n.paths && n.paths[0]));
    if (!p) { stat.textContent = '这个节点没有路径'; return; }
    var APP = (window.app && window.app.app) || null;
    var isDir = !!n.isDir || /[\\/]$/.test(p) || !/\.[A-Za-z0-9]{1,6}$/.test(p);
    if (n.missing) stat.textContent = '⛔ 这个路径不存在：' + p;
    if (isDir) {
      if (APP && APP.openPath) {
        Promise.resolve(APP.openPath(p)).then(function (r) { if (r && r.ok === false) stat.textContent = '打不开：' + (r.error || ''); });
        return;
      }
    }
    if (OPEN) {
      Promise.resolve(OPEN(p)).then(function (r) {
        if (r && r.ok === false) {
          if (APP && APP.openPath) Promise.resolve(APP.openPath(p)).then(function (r2) { if (r2 && r2.ok === false) stat.textContent = '打不开：' + (r2.error || ''); });
          else stat.textContent = '打不开：' + (r.error || '');
        }
      });
      return;
    }
    if (APP && APP.openPath) { Promise.resolve(APP.openPath(p)); return; }
    stat.textContent = '这个版本没有打开通道';
  }

  }
  return { layout, fitToViewport, project, draw, drawInner, hexA, loop, pos, pick, onWheel, openNode };
}
