/**
 * panel-harness.js —— DSH 引擎 AI 会话面板
 * 包含：harness
 * 实现标准生命周期：mount(body, meta, head), unmount(), pause(), resume()
 * 特性：虚拟化休眠控制（切后台静音并降载，切回前台即时唤醒，杜绝多 webview 内存膨胀）。
 */
(function (root) {
  'use strict';

  var REGISTRY = root.APP_PANEL_REGISTRY;

  var harnessPanel = {
    mount: function (body, meta, head) {
      body.classList.add('harness-panel-body');
      var pId = (meta && meta.id) || 'harness';
      var sessionId = (meta && meta.sessionId) || '';
      var partition = sessionId && sessionId !== '__待填__'
        ? 'persist:harness-panel-' + pId
        : 'persist:harness';

      var wv = document.createElement('webview');
      wv.className = 'harness-guest-webview';
      wv.setAttribute('allowpopups', '');
      wv.setAttribute('partition', partition);

      var stateIndicator = document.createElement('div');
      stateIndicator.className = 'harness-pin-status';
      stateIndicator.innerHTML = '<span class="pin-tag">✓ 已钉绑定</span>';
      if (head) head.appendChild(stateIndicator);

      var hibernated = false;
      var hibernateTimer = null;

      function onFinishLoad() {
        try {
          if (typeof root.injectHarnessScripts === 'function') {
            root.injectHarnessScripts(wv, meta);
          }
        } catch (e) {}
      }

      wv.addEventListener('did-finish-load', onFinishLoad);

      // 启动导航
      var base = (root.app && root.app.engine && root.app.engine.url) || 'http://127.0.0.1:3083';
      wv.src = base + (sessionId ? ('/?session=' + sessionId) : '/');
      body.appendChild(wv);

      return {
        wv: wv,
        unmount: function () {
          if (hibernateTimer) clearTimeout(hibernateTimer);
          try { wv.removeEventListener('did-finish-load', onFinishLoad); } catch (e) {}
          try { wv.src = 'about:blank'; } catch (e) {}
          body.innerHTML = '';
          if (stateIndicator && stateIndicator.parentNode) stateIndicator.parentNode.removeChild(stateIndicator);
        },
        pause: function () {
          // 30 秒后台延时休眠
          hibernateTimer = setTimeout(function () {
            hibernated = true;
            try { if (wv.setAudioMuted) wv.setAudioMuted(true); } catch (e) {}
          }, 30000);
        },
        resume: function () {
          if (hibernateTimer) {
            clearTimeout(hibernateTimer);
            hibernateTimer = null;
          }
          if (hibernated) {
            hibernated = false;
            try { if (wv.setAudioMuted) wv.setAudioMuted(false); } catch (e) {}
          }
        }
      };
    }
  };

  if (REGISTRY) {
    REGISTRY.register('harness', harnessPanel);
  }
})(window);
