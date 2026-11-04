/**
 * panel-embed.js —— 通用内嵌与视图预览面板族
 * 包含：embed, view
 * 实现标准生命周期：mount(body, meta, head), unmount(), pause(), resume()
 */
(function (root) {
  'use strict';

  var REGISTRY = root.APP_PANEL_REGISTRY;

  // ---- 1. embed ----
  var embedPanel = {
    mount: function (body, meta, head) {
      body.classList.add('embed-panel');
      var url = (meta && (meta.url || meta.src)) || 'about:blank';
      var wv = document.createElement('webview');
      wv.className = 'embed-webview';
      wv.setAttribute('allowpopups', '');
      wv.setAttribute('partition', (meta && meta.partition) || 'persist:embed');
      wv.src = url;
      body.appendChild(wv);

      return {
        mountTime: Date.now(),
        unmount: function () {
          try { wv.src = 'about:blank'; } catch (e) {}
          body.innerHTML = '';
        },
        pause: function () {
          try {
            if (wv.setAudioMuted) wv.setAudioMuted(true);
          } catch (e) {}
        },
        resume: function () {
          try {
            if (wv.setAudioMuted) wv.setAudioMuted(false);
          } catch (e) {}
        }
      };
    }
  };

  // ---- 2. view ----
  var viewPanel = {
    mount: function (body, meta, head) {
      body.classList.add('view-panel-body');
      var pathTarget = (meta && (meta.file || meta.path)) || '';
      var container = document.createElement('div');
      container.className = 'view-content-area';
      container.innerHTML = '<div class="stat-sub">正在加载视图内容…</div>';
      body.appendChild(container);

      function loadView() {
        if (!pathTarget) {
          container.innerHTML = '<div class="stat-sub">无指定视图文件</div>';
          return;
        }
        if (window.app && window.app.file && window.app.file.read) {
          window.app.file.read(pathTarget).then(function (res) {
            if (res && res.ok && res.text) {
              container.innerHTML = '<pre style="white-space:pre-wrap;font-size:12px;color:var(--text);line-height:1.6">' + escapeHtml(res.text.slice(0, 5000)) + '</pre>';
            } else {
              container.innerHTML = '<div class="stat-sub">视图内容为空或不存在</div>';
            }
          }).catch(function () {
            container.innerHTML = '<div class="stat-sub">无法读取视图文件</div>';
          });
        }
      }

      function escapeHtml(s) {
        return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }

      loadView();

      return {
        unmount: function () {
          body.innerHTML = '';
        },
        pause: function () {},
        resume: function () {}
      };
    }
  };

  if (REGISTRY) {
    REGISTRY.register('embed', embedPanel);
    REGISTRY.register('view', viewPanel);
  }
})(window);
