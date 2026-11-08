// panels/panel-pc-ledger.js —— 电脑清理场景「③ 清理台账」面板（P2-D 阶段2a 搬出）
// 来源：renderer/renderers.js 原 3120-3147（逐字搬入；只把外层 `renderers['pc-ledger']` 改为 `APP['pc-ledger']`）。
// 加载：index.html 在 renderers.js 之前加载本文件（与 panel-pc-drives.js 相邻；后者提供 pc* helper）。
// 依赖：pcPanel/PC_DATA/pcReadJson/pcGb/pcEmpty 在 panels/panel-pc-drives.js（**先**加载）；`el` 在 renderers.js（调用时已加载）。
var APP = window.APP_RENDERERS || (window.APP_RENDERERS = {});

// ③ 清理台账：历次清了什么、释放多少、累计多少
// ⚠ 这里必须写成显式 `return () => stop()`：check-gui 第 4 项是按"本渲染器 → 下一个 renderers[...]"
//   切片去找 cleanup 形状的，而 pc-ledger 后面隔着几千行无关代码（里面有 setInterval），
//   简写形式会被误判成"用了定时器却不返回 cleanup"。
APP['pc-ledger'] = (body) => {
  const stop = pcPanel(body, 'pc-ledger-body', 20000, (wrap) => {
    pcReadJson(PC_DATA.log).then((r) => {
      wrap.innerHTML = '';
      if (r.err) return pcEmpty(wrap, r.err);
      const es = (r.data && r.data.entries) || [];
      const total = es.reduce((a, e) => a + (Number(e.freed) || 0), 0);
      const big = el('div', 'pc-big');
      big.appendChild(el('b', 'pc-big-num', pcGb(total)));
      big.appendChild(el('span', 'pc-big-k', '累计释放 · ' + es.length + ' 次'));
      wrap.appendChild(big);
      if (!es.length) return pcEmpty(wrap, '还没有清理记录。清完一次我会往台账里追加一条。');
      es.slice().reverse().slice(0, 6).forEach((e) => {
        const row = el('div', 'pc-line');
        row.title = (e.what || '') + (e.note ? '\n' + e.note : '');
        row.appendChild(el('span', 'pc-line-k', String(e.date || '').slice(5)));
        row.appendChild(el('span', 'pc-line-m', e.what || ''));
        row.appendChild(el('span', 'pc-line-v accent', '+' + (Number(e.freed) || 0).toFixed(2)));
        wrap.appendChild(row);
      });
    });
  });
  return () => stop();
};
