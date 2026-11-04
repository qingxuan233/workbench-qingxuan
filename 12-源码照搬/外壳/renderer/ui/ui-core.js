/* ui-core.js —— 工作台 UI 2.0 的公共底座（2026-11-03）
 *
 * 目标：给“界面层”一个明确的模块边界，避免再往 renderer.js / renderers.js 里堆全局函数。
 * 约束：不引入构建步骤（CSP script-src 'self'），所有模块用 IIFE + window.WB 命名空间。
 *
 * 提供：
 *   WB.bus    事件总线（跨模块解耦；renderer.js 只负责 emit）
 *   WB.store  带前缀的安全 localStorage（读写失败一律回退默认值）
 *   WB.dom    轻量 DOM 构造与查询
 *   WB.util   防抖 / 转义 / 快捷键文案
 *   WB.flags  运行期开关（UI 版本等）
 *   WB.ready  DOM 就绪回调
 */
(function () {
  'use strict';
  if (window.WB && window.WB.__core) return;

  var WB = window.WB = window.WB || {};
  WB.__core = true;
  WB.version = '2.0.0';

  // ---------- 事件总线 ----------
  var handlers = Object.create(null);
  WB.bus = {
    on: function (name, fn) {
      if (typeof fn !== 'function') return function () {};
      (handlers[name] || (handlers[name] = [])).push(fn);
      return function off() { WB.bus.off(name, fn); };
    },
    off: function (name, fn) {
      var list = handlers[name];
      if (!list) return;
      var i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    emit: function (name, data) {
      var list = handlers[name];
      if (!list || !list.length) return;
      list.slice().forEach(function (fn) {
        try { fn(data); } catch (e) { try { console.error('[WB.bus] ' + name, e); } catch (_) {} }
      });
    }
  };

  // ---------- 本地偏好 ----------
  var PREFIX = 'wb.ui.';
  WB.store = {
    get: function (key, fallback) {
      try {
        var v = localStorage.getItem(PREFIX + key);
        return v === null ? fallback : v;
      } catch (e) { return fallback; }
    },
    set: function (key, value) {
      try { localStorage.setItem(PREFIX + key, String(value)); } catch (e) { /* 隐私模式/配额满，忽略 */ }
    },
    remove: function (key) {
      try { localStorage.removeItem(PREFIX + key); } catch (e) { /* ignore */ }
    },
    getBool: function (key, fallback) {
      var v = WB.store.get(key, null);
      if (v === null) return !!fallback;
      return v === '1' || v === 'true';
    }
  };

  // ---------- DOM ----------
  function h(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'dataset') {
          Object.keys(v).forEach(function (dk) { node.dataset[dk] = v[dk]; });
        } else if (k.slice(0, 2) === 'on' && typeof v === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (k === 'style' && typeof v === 'object') {
          Object.keys(v).forEach(function (sk) { node.style[sk] = v[sk]; });
        } else {
          node.setAttribute(k, v);
        }
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  WB.dom = {
    h: h,
    qs: function (sel, root) { try { return (root || document).querySelector(sel); } catch (e) { return null; } },
    qsa: function (sel, root) { try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); } catch (e) { return []; } },
    on: function (el, type, fn, opts) { if (el) el.addEventListener(type, fn, opts || false); return el; },
    clear: function (el) { if (el) while (el.firstChild) el.removeChild(el.firstChild); },
    isEditable: function (el) {
      if (!el) return false;
      var tag = (el.tagName || '').toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
    }
  };

  // ---------- 工具 ----------
  WB.util = {
    debounce: function (fn, ms) {
      var t = null;
      return function () {
        var args = arguments, self = this;
        clearTimeout(t);
        t = setTimeout(function () { fn.apply(self, args); }, ms || 80);
      };
    },
    escapeHtml: function (s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    },
    shortcut: function (key) {
      var mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
      return (mac ? '⌘' : 'Ctrl') + ' ' + key;
    },
    // 简单子序列打分：连续命中、词首命中加分；不命中返回 -1
    fuzzy: function (query, text) {
      var q = String(query || '').toLowerCase().replace(/\s+/g, '');
      var t = String(text || '').toLowerCase();
      if (!q) return 0;
      var qi = 0, score = 0, last = -2;
      for (var i = 0; i < t.length && qi < q.length; i++) {
        if (t[i] !== q[qi]) continue;
        score += (i === last + 1 ? 4 : 1);
        if (i === 0 || /[\s·/\\._-]/.test(t[i - 1])) score += 3;
        last = i;
        qi++;
      }
      return qi === q.length ? score : -1;
    }
  };

  WB.flags = {
    uiV2: function () { return document.documentElement.getAttribute('data-wb-ui') !== 'classic'; }
  };

  WB.ready = function (fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  };
})();
