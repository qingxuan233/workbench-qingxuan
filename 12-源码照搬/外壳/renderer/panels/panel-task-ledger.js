// panels/panel-task-ledger.js —— 命令场景「任务台账」面板（P4-5，2026-11-10）
// 数据：宿主 IPC `tasks:ledger()` → 能力层 `task.list`（**与 REST / MCP 同一口径**，含信封与证据）；
//       服务层"读时顺扫"会把超时未回执的任务转 expired，所以这里看到的状态是新鲜的。
// 依赖：`pcPanel` / `pcEmpty` 在 panel-pc-drives.js（index.html 先加载本文件之后才加载 renderers.js）；
//       `el` 定义在 renderers.js —— 本文件只在**调用时**才用到它，先加载不影响。
// 判据：check-gui 第 4 项按"本渲染器 → 下一个 APP[...]"切片找 cleanup 形状 ⇒ 这里显式 return () => stop()。
var APP = window.APP_RENDERERS || (window.APP_RENDERERS = {});

APP['task-ledger'] = function (body) {
  // 一次性自报（server.log 的 [diag] console 能收到）：排障时用来区分"没挂载 / 没调 IPC"
  try {
    if (!window.__taskLedgerMounted) {
      window.__taskLedgerMounted = true;
      console.warn('[task-ledger] mounted');
    }
  } catch (e) { /* ignore */ }
  var stop = pcPanel(body, 'task-ledger-body', 15000, render);
  return function () { stop(); };   // ★ cleanup（registerCenter 会拿它当 unmount）

  function stateText(t) {
    var m = {
      pending: '待接', dispatched: '已投递', claimed: '已领取', completed: '已完成',
      failed: '失败', expired: '已超时', cancelled: '已取消'
    };
    return m[t] || String(t || 'pending');
  }
  function fmt(iso) { return iso ? String(iso).slice(5, 16).replace('T', ' ') : '—'; }

  function detailText(t) {
    var L = [];
    L.push('任务号   ' + (t.taskId || ''));
    L.push('流向     ' + (t.from || '-') + ' → ' + (t.to || '-'));
    L.push('状态     ' + stateText(t.status) + (t.claimedBy ? '（' + t.claimedBy + ' 领取）' : ''));
    L.push('时间     ' + fmt(t.createdAt) + (t.deadlineAt ? ' · 截止 ' + fmt(t.deadlineAt) : ' · 未设截止'));
    if (t.mandate) {
      L.push('写入边界 ' + (t.mandate.allowWrite === false ? '只读（不许写）' : '允许写')
        + (t.mandate.scope && t.mandate.scope.length ? ' · 范围 ' + t.mandate.scope.join('/') : ''));
    }
    if (t.evidenceExpected && t.evidenceExpected.length) L.push('期望证据 ' + t.evidenceExpected.join('；'));
    if (t.evidence) L.push('证据     ' + String(t.evidence).slice(0, 300));
    if (t.evidenceMeta) {
      if (t.evidenceMeta.exitCode !== undefined) L.push('退出码   ' + t.evidenceMeta.exitCode);
      (t.evidenceMeta.files || []).forEach(function (f) {
        L.push('证据文件 ' + f.path + '（' + (f.bytes || 0) + ' 字节 · sha256 ' + String(f.sha256 || '').slice(0, 12) + '…）');
      });
    }
    if (t.err) L.push('错误     ' + t.err);
    return L.join('\n');
  }

  function rowOf(t) {
    var row = el('div', 'pc-line');
    row.style.cursor = 'pointer';
    row.title = '点击展开：信封 / 证据';
    row.appendChild(el('span', 'pc-line-k', stateText(t.status)));
    row.appendChild(el('span', 'pc-line-m', (t.priority || 'P2') + ' · ' + String(t.title || '（无标题）')));
    row.appendChild(el('span', 'pc-line-v', fmt(t.deadlineAt)));

    var detail = null;
    row.addEventListener('click', function () {
      if (detail) {
        if (detail.parentNode) detail.parentNode.removeChild(detail);
        detail = null;
        return;
      }
      detail = el('div', 'pc-hint');
      detail.style.whiteSpace = 'pre-wrap';
      detail.style.userSelect = 'text';
      detail.textContent = detailText(t);
      if (row.parentNode) row.parentNode.insertBefore(detail, row.nextSibling);
    });
    return row;
  }

  function render(wrap) {
    var api = window.app && window.app.tasks;
    if (!window.__taskLedgerFirstRender) {
      window.__taskLedgerFirstRender = true;
      try { console.warn('[task-ledger] first render, api=' + (!!api) + ', ledger=' + (!!(api && api.ledger))); } catch (e) { /* ignore */ }
    }
    if (!api || typeof api.ledger !== 'function') {
      wrap.innerHTML = '';
      return pcEmpty(wrap, '宿主没有 tasks 接口 —— 面板可热更新，IPC 不行：重启一次工作台，再切回本场景。');
    }
    api.ledger({ limit: 20 }).then(function (r) {
      wrap.innerHTML = '';
      if (!r || r.ok === false) return pcEmpty(wrap, '读取失败：' + String((r && r.err) || '未知错误'));
      var list = Array.isArray(r.tasks) ? r.tasks : [];
      var head = el('div', 'pc-hint',
        '共 ' + (r.count || 0) + ' 条 · 点一行看信封与证据'
        + (r.expiredNow && r.expiredNow.length ? ' · 本次自动转 expired ' + r.expiredNow.length + ' 条' : ''));
      wrap.appendChild(head);
      if (!list.length) return pcEmpty(wrap, '台账为空：还没有任何派单。');
      list.forEach(function (t) { wrap.appendChild(rowOf(t)); });
    }).catch(function (e) {
      wrap.innerHTML = '';
      pcEmpty(wrap, '读取异常：' + String((e && e.message) || e));
    });
  }
};
