// panels/harness-utils.js —— harness 面板的纯常量/纯脚本片段（P2 收尾 3e-1，从 renderers.js harness 体抽出）
//
// 内容：`HARNESS_DROP_JS`（拖文件进会话窗口的注入脚本；只用 window/document，不读 harness 闭包变量）。
// 约定：**不包 IIFE**，脚本级 `var` 全局声明；index.html 在 panel-harness.js 之前加载（两者都在 chrome.js 之前）。
// 依赖：无（纯字符串常量）。
var HARNESS_DROP_JS = `(() => {
    const GEN = 'kun-drop-v1';
    if (window.__kunDropGen === GEN) return;
    window.__kunDropGen = GEN;
    document.addEventListener('dragover', (ev) => {
      if (!ev.dataTransfer) return;
      try { ev.preventDefault(); } catch (e) { }
    });
    document.addEventListener('drop', (ev) => {
      if (!ev.dataTransfer) return;
      try { ev.preventDefault(); } catch (e) { }
      try { ev.stopPropagation(); } catch (e) { }
      const paths = [];
      const files = ev.dataTransfer.files || [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        let p = '';
        try { if (window.webUtils && window.webUtils.getPathForFile) p = window.webUtils.getPathForFile(f); } catch (e) { }
        if (!p) p = (f && f.path) || '';
        if (p) paths.push(p);
      }
      if (!paths.length) {
        let raw = '';
        try { raw = ev.dataTransfer.getData('text/uri-list') || ev.dataTransfer.getData('text/plain') || ''; } catch (e) { }
        String(raw).split(/\\r?\\n/).forEach((line) => {
          const s = line.trim();
          if (!s) return;
          let p = s;
          if (/^file:\\/\\//i.test(s)) {
            try { p = decodeURIComponent(s.replace(/^file:\\/\\//i, '').replace(/^\\/([A-Za-z]:)/, '$1').replace(/\\//g, '\\\\')); } catch (e) { }
          }
          if (p) paths.push(p);
        });
      }
      if (!paths.length) return;
      const el = document.querySelector('[data-composer-input]');
      if (!el) return;
      el.focus();
      try { document.execCommand('insertText', false, paths.join('\\n')); } catch (e) { }
    });
  })()`;
