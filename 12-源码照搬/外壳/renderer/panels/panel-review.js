/**
 * panel-review.js —— 自我复盘与文档审查面板族
 * 包含：review-files, review-doc
 * 实现标准生命周期：mount(body, meta, head), unmount(), pause(), resume()
 */
(function (root) {
  'use strict';

  var REGISTRY = root.APP_PANEL_REGISTRY;

  function createReviewPanel(renderFn) {
    return {
      mount: function (body, meta, head) {
        var timers = [];
        var listeners = [];

        function registerTimer(fn, ms) {
          var t = setInterval(fn, ms);
          timers.push(t);
          return t;
        }

        function registerListener(target, evt, handler) {
          if (target && target.addEventListener) {
            target.addEventListener(evt, handler);
            listeners.push({ target: target, evt: evt, handler: handler });
          }
        }

        var instance = {
          timers: timers,
          listeners: listeners,
          paused: false,
          unmount: function () {
            timers.forEach(function (t) { clearInterval(t); });
            timers.length = 0;
            listeners.forEach(function (l) {
              try { l.target.removeEventListener(l.evt, l.handler); } catch (e) {}
            });
            listeners.length = 0;
            body.innerHTML = '';
          },
          pause: function () {
            instance.paused = true;
          },
          resume: function () {
            instance.paused = false;
          }
        };

        renderFn(body, meta, head, {
          registerTimer: registerTimer,
          registerListener: registerListener,
          isPaused: function () { return instance.paused; }
        });

        return instance;
      }
    };
  }

  // ---- 1. review-files ----
  var reviewFiles = createReviewPanel(function (body, meta, head, ctx) {
    body.classList.add('review-files-body');
    body.innerHTML = '<div class="stat-sub">正在拉取变更清单…</div>';

    function refreshFiles() {
      if (ctx.isPaused()) return;
      var fileList = [
        { name: '自我复盘/交接卡.md', status: 'clean' },
        { name: '自我复盘/场景私有记忆.md', status: 'clean' },
        { name: '自我复盘/项目台账.md', status: 'clean' }
      ];
      var html = '<ul class="review-file-list">';
      fileList.forEach(function (f) {
        html += '<li class="review-file-item"><span class="rf-dot">●</span><span class="rf-name">' + f.name + '</span><span class="rf-tag">' + f.status + '</span></li>';
      });
      html += '</ul>';
      body.innerHTML = html;
    }

    refreshFiles();
    ctx.registerTimer(refreshFiles, 20000);
  });

  // ---- 2. review-doc ----
  var reviewDoc = createReviewPanel(function (body, meta, head, ctx) {
    body.classList.add('review-doc-body');
    body.innerHTML = '<div class="review-doc-container">'
      + '<div class="review-doc-title">复盘文档预览</div>'
      + '<div class="review-doc-content" id="review-doc-preview"><div class="stat-sub">加载中…</div></div>'
      + '</div>';

    function loadDoc() {
      if (ctx.isPaused()) return;
      var target = (meta && meta.target) || '自我复盘/交接卡.md';
      if (window.app && window.app.file && window.app.file.read) {
        window.app.file.read(target).then(function (res) {
          var el = body.querySelector('#review-doc-preview');
          if (!el) return;
          if (res && res.ok && res.text) {
            el.innerHTML = '<pre style="white-space:pre-wrap;font-size:12px;color:var(--text-dim);line-height:1.6">' + escapeHtml(res.text.slice(0, 3000)) + '</pre>';
          } else {
            el.innerHTML = '<div class="stat-sub">无预览内容</div>';
          }
        }).catch(function () {
          var el = body.querySelector('#review-doc-preview');
          if (el) el.innerHTML = '<div class="stat-sub">无法读取文档</div>';
        });
      }
    }

    function escapeHtml(s) {
      return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    loadDoc();
  });

  if (REGISTRY) {
    REGISTRY.register('review-files', reviewFiles);
    REGISTRY.register('review-doc', reviewDoc);
  }
})(window);
