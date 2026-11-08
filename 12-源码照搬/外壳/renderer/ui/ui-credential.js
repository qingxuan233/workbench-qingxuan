/* ui-credential.js —— 「模型与凭据」面板（2026-11-08 · GUI 优化 P0-1：修 F1 三重断）
 *
 * F1 的事实（已核实）：
 *   ① public-clean.js 用 display:none!important 把 #btn-models（🤖）藏了 —— 现在已放开；
 *   ② 即使点开，renderer.js 的 showModels() 只读展示模型配置，**没有任何"去哪填"的入口**；
 *   ③ 唯一能打开内嵌 Harness 原生设置的 showSettings() 只绑了已删除的 #btn-settings ⇒ 死函数；
 *   ④ main.js 的 settings:open（which='credentials' 打开 .credentials.yaml，其余打开 settings.yaml）
 *      渲染层从未调用过。
 *
 * 本模块（自举，不改 renderer.js 任何一行）：
 *   · 拦截 #btn-models 的点击（document 捕获阶段，先于 renderer.js 的 showModels 监听），
 *     换成真正的「模型与凭据」面板；
 *   · 三个动作：打开 .credentials.yaml / 打开 settings.yaml / 在应用内打开 DSH 原生设置；
 *   · 明明白白告诉用户：填完要重启引擎/工作台才生效；
 *   · **绝不读取、绝不显示任何密钥内容**（只显示"文件在不在 / 提供方密钥配没配"两个布尔状态）。
 *
 * 依赖：ui-core.js（WB.ready）、ui-a11y.js（WB.dialog）。复用宿主已有的 #modal-mask/#modal-body。
 */
(function () {
  'use strict';
  var WB = window.WB = window.WB || {};
  if (WB.__credential) return;
  WB.__credential = true;

  var APP = null;          // window.app（preload 暴露的桥对象）
  var panelSeq = 0;

  function app() {
    if (APP) return APP;
    APP = (typeof window !== 'undefined' && window.app) ? window.app : null;
    return APP;
  }

  function settingsApi() {
    var A = app();
    return (A && A.settings && typeof A.settings.open === 'function') ? A.settings : null;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function section(title) {
    var box = el('div', 'wb-cred-sec');
    box.appendChild(el('div', 'wb-cred-sec-title', title));
    return box;
  }

  function actionRow(label, desc, onClick) {
    var row = el('div', 'wb-cred-row');
    var btn = el('button', 'file-refresh wb-cred-btn', label);
    btn.type = 'button';
    btn.addEventListener('click', onClick);
    row.appendChild(btn);
    if (desc) row.appendChild(el('span', 'wb-cred-desc', desc));
    return row;
  }

  // 设置界面打开结果统一回写（成功绿 / 失败黄），不用弹 toast，避免和顶栏状态抢注意力
  function resultBox(body) {
    var r = el('div', 'wb-cred-res');
    r.setAttribute('role', 'status');
    body.appendChild(r);
    return r;
  }

  function report(resEl, msg, kind) {
    if (!resEl) return;
    resEl.textContent = msg;
    resEl.className = 'wb-cred-res' + (kind ? ' ' + kind : '');
  }

  // 调 settings.open(which) —— 包一层，把主进程的 {ok:false,err} 与异常都翻译成中文
  function openViaIpc(resEl, which, label, missingHint) {
    var S = settingsApi();
    if (!S) {
      report(resEl, '这个工作台版本还没有打开配置文件的能力（老宿主 / 未重启）', 'warn');
      return;
    }
    report(resEl, '正在用系统默认程序打开「' + label + '」…', '');
    var p;
    try { p = S.open(which); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(function (r) {
      if (r && r.ok === false) {
        report(resEl, '打不开：' + (r.err || r.error || '未知原因') + (missingHint ? '　' + missingHint : ''), 'warn');
      } else if (r && r.ok === true) {
        report(resEl, '已用系统默认程序打开「' + label + '」。改完保存后回到这里，按下面的重启说明做。', 'ok');
      } else {
        report(resEl, '已请求打开「' + label + '」（宿主没有回执，若 3 秒后没反应就点上面的按钮重试）。', '');
      }
    }).catch(function (e) {
      report(resEl, '打开失败：' + ((e && e.message) || e), 'warn');
    });
  }

  function ensureNativeSettings(resEl) {
    if (typeof window.showSettings === 'function') {
      try {
        window.showSettings();
        report(resEl, '已在应用内打开 DSH 原生设置（改完保存后仍需重启工作台才生效）。', 'ok');
        return;
      } catch (e) { /* 落到文件方式 */ }
    }
    // 老宿主没有内嵌设置函数：退化成打开 settings.yaml 文件
    openViaIpc(resEl, 'settings', 'settings.yaml', '（引擎数据\\.dsh\\settings.yaml 不存在：先让引擎启动一次）');
  }

  function ensureReadonlyModels(resEl) {
    if (typeof window.showModels === 'function') {
      try { window.showModels(); return; } catch (e) { /* ignore */ }
    }
    report(resEl, '只读视图打不开（宿主没暴露 showModels，重启一次工作台再试）', 'warn');
  }

  // 状态区：只显示"在不在 / 配没配"，不显示任何密钥内容
  function mountStatus(box) {
    var A = app();
    var status = el('div', 'wb-cred-status');
    box.appendChild(status);

    var S = (A && A.settings && typeof A.settings.list === 'function') ? A.settings : null;
    if (S) {
      Promise.resolve().then(function () { return S.list(); }).then(function (r) {
        var files = (r && r.files) || {};
        var rows = [];
        rows.push({ k: 'credentials.yaml', ok: !!files.credentials, path: (r && r.credentialsPath) || '' });
        rows.push({ k: 'settings.yaml', ok: !!files.settings, path: (r && r.settingsPath) || '' });
        status.innerHTML = '';
        rows.forEach(function (x) {
          var row = el('div', 'wb-cred-st-row');
          row.appendChild(el('span', 'wb-cred-st-dot' + (x.ok ? ' ok' : ''), x.ok ? '●' : '○'));
          row.appendChild(el('span', 'wb-cred-st-k', x.k));
          row.appendChild(el('span', 'wb-cred-st-v', x.ok ? '已存在' : '还没生成'));
          if (x.path) {
            var p = el('span', 'wb-cred-st-path', x.path);
            p.title = x.path;
            row.appendChild(p);
          }
          status.appendChild(row);
        });
      }).catch(function () { /* 老宿主没有 settings:list：状态区留空，不影响按钮 */ });
    }

    var M = (A && A.models && typeof A.models.list === 'function') ? A.models : null;
    if (!M) return;
    Promise.resolve().then(function () { return M.list(); }).then(function (r) {
      var list = (r && Array.isArray(r.providers)) ? r.providers : [];
      var box2 = el('div', 'wb-cred-prov');
      box2.appendChild(el('div', 'wb-cred-prov-h',
        '当前默认模型：' + ((r && r.default && r.default.model) || '—') +
        ((r && r.default && r.default.provider) ? '　@ ' + r.default.provider : '')));
      if (!list.length) {
        box2.appendChild(el('div', 'wb-cred-prov-note', '没发现自定义提供方（内置 deepseek-official 始终可用）。'));
      } else {
        var chips = el('div', 'wb-cred-chips');
        list.forEach(function (p) {
          var chip = el('span', 'wb-cred-chip' + (p.apiKeySet ? ' ok' : ' warn'),
            (p.displayName || p.id || '提供方') + (p.apiKeySet ? ' · 密钥已配置' : ' · 密钥未配置'));
          chips.appendChild(chip);
        });
        box2.appendChild(chips);
      }
      status.appendChild(box2);
    }).catch(function () { /* 读不到就只显示文件状态 */ });
  }

  function build(body) {
    panelSeq++;
    var seq = panelSeq;
    body.className = 'modal-body wb-cred-body';
    var wrap = el('div', 'wb-cred');
    body.appendChild(wrap);

    // ① 边界声明：界面绝不显示密钥
    var note = el('div', 'modal-note wb-cred-note');
    note.appendChild(el('div', 'modal-note-line',
      '🔐 这里只负责"打开去哪填"：本面板不读取、不显示任何密钥内容；密钥只存在本机文件里。'));
    note.appendChild(el('div', 'modal-note-line',
      '⚠ 填完 / 改完必须重启才生效：关掉工作台再运行 启动.bat。顶栏 ⟳ 只热更新界面，不会重载引擎的模型配置。'));
    wrap.appendChild(note);

    // ② 填密钥
    var s1 = section('① 填写 API 密钥（.credentials.yaml）');
    s1.appendChild(actionRow('打开 .credentials.yaml', '系统默认程序打开 · 引擎数据\\.dsh\\.credentials.yaml',
      function () {
        openViaIpc(resEl, 'credentials', '.credentials.yaml',
          '（文件还没生成：先在下面②里用内嵌设置填一次密钥，或重启工作台后再回来试）');
      }));
    s1.appendChild(el('div', 'wb-cred-tip',
      '文件不存在是正常的：第一次要先在「DSH 原生设置 → 模型与提供方」里填一次，保存后引擎会自动生成。'));
    wrap.appendChild(s1);

    // ③ 模型/提供方设置（文件 + 应用内两种入口）
    var s2 = section('② 模型与提供方设置');
    s2.appendChild(actionRow('打开 settings.yaml', '模型 / 提供方配置文件（系统默认程序）',
      function () {
        openViaIpc(resEl, 'settings', 'settings.yaml',
          '（引擎数据\\.dsh\\settings.yaml 不存在：先启动一次引擎）');
      }));
    s2.appendChild(actionRow('在应用内打开 DSH 原生设置', '推荐 · 内嵌 Harness 设置界面（模型 / 通用 / 插件）',
      function () { ensureNativeSettings(resEl); }));
    s2.appendChild(actionRow('查看模型与提供方（只读）', '沿用原有只读视图，只列名称与"密钥已配置/未配置"',
      function () { ensureReadonlyModels(resEl); }));
    wrap.appendChild(s2);

    // ④ 生效说明
    var s3 = section('③ 生效方式');
    var steps = el('ol', 'wb-cred-steps');
    [
      '在①或②里把该填的填好，保存文件（内嵌设置点保存即可自动落盘）。',
      '重启工作台：关闭窗口 → 运行 启动.bat（重启会重新加载引擎的模型配置）。',
      '回到对话面板问一句试试；仍不回话就打开下面的"只读视图"确认密钥状态。'
    ].forEach(function (t) { steps.appendChild(el('li', 'wb-cred-step', t)); });
    s3.appendChild(steps);
    wrap.appendChild(s3);

    resEl = resultBox(wrap);
    mountStatus(wrap);
  }

  var resEl = null;   // build() 里赋值；按钮闭包晚于赋值执行，拿到的是最终节点

  function openPanel() {
    var dlg = WB.dialog;
    if (dlg && typeof dlg.open === 'function') {
      resEl = null;
      dlg.open('模型与凭据', build);
      return true;
    }
    // 兜底（理论上不会走到：ui-a11y 先于本模块加载）
    var mask = document.getElementById('modal-mask');
    if (!mask) return false;
    var body = document.getElementById('modal-body');
    var titleEl = document.getElementById('modal-title');
    if (titleEl) titleEl.textContent = '模型与凭据';
    if (body) { body.className = 'modal-body'; body.innerHTML = ''; build(body); }
    mask.style.display = 'flex';
    return true;
  }

  // 关键：document 捕获阶段先于 renderer.js 绑在 #btn-models 上的 showModels 气泡监听
  //   ⇒ preventDefault + stopPropagation 后，原"只读弹窗"不会再抢着打开。
  function intercept(ev) {
    var t = ev.target;
    var btn = (t && t.closest) ? t.closest('#btn-models') : null;
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
    openPanel();
  }

  WB.credential = { open: openPanel };

  // 脚本一加载就装捕获监听（document 一定已存在）；不依赖 DOMContentLoaded 的先后顺序。
  document.addEventListener('click', intercept, true);
})();
