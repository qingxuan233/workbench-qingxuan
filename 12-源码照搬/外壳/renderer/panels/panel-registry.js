/**
 * panel-registry.js —— 面板生命周期注册中心与动态装载器
 * 核心契约：
 *   每个面板实现：mount(body, meta, head), unmount(), pause(), resume()
 *   场景切换与热更新时自动调用 unmount()，清理事件监听与轮询定时器，杜绝内存泄漏与 Ghost 监听器。
 */
(function (root) {
  'use strict';

  var APP_RENDERERS = {};
  var ACTIVE_INSTANCES = new Map(); // bodyEl -> panelInstance
  var SCENE_INSTANCES = new Map();  // sceneId -> Set of instances
  var activeSceneId = null;

  var REGISTRY = {
    register: function (type, definition) {
      if (!type || !definition) return;
      APP_RENDERERS[type] = definition;
    },

    get: function (type) {
      return APP_RENDERERS[type] || null;
    },

    has: function (type) {
      return !!APP_RENDERERS[type];
    },

    mount: function (type, body, meta, head) {
      var renderer = APP_RENDERERS[type];
      var sceneId = (meta && meta.scenario) || activeSceneId || 'default';
      var instance = null;

      if (renderer && typeof renderer.mount === 'function') {
        try {
          instance = renderer.mount(body, meta, head) || {};
        } catch (e) {
          console.error('[panel-registry] mount failed for ' + type, e);
          body.innerHTML = '<div class="stat-sub">面板装载失败: ' + (e && e.message) + '</div>';
        }
      }

      if (!instance) instance = {};
      instance.__type = type;
      instance.__body = body;
      instance.__meta = meta;
      instance.__sceneId = sceneId;

      ACTIVE_INSTANCES.set(body, instance);
      if (!SCENE_INSTANCES.has(sceneId)) SCENE_INSTANCES.set(sceneId, new Set());
      SCENE_INSTANCES.get(sceneId).add(instance);

      // 返回统一的 cleanup 函数
      return function () {
        REGISTRY.unmount(body);
      };
    },

    unmount: function (body) {
      var instance = ACTIVE_INSTANCES.get(body);
      if (!instance) return;
      try {
        if (typeof instance.unmount === 'function') instance.unmount();
      } catch (e) {
        console.error('[panel-registry] unmount error', e);
      }
      ACTIVE_INSTANCES.delete(body);
      if (instance.__sceneId && SCENE_INSTANCES.has(instance.__sceneId)) {
        SCENE_INSTANCES.get(instance.__sceneId).delete(instance);
      }
    },

    pauseScene: function (sceneId) {
      var set = SCENE_INSTANCES.get(sceneId);
      if (!set) return;
      set.forEach(function (inst) {
        try {
          if (typeof inst.pause === 'function') inst.pause();
        } catch (e) {
          console.error('[panel-registry] pause error', e);
        }
      });
    },

    resumeScene: function (sceneId) {
      activeSceneId = sceneId;
      var set = SCENE_INSTANCES.get(sceneId);
      if (!set) return;
      set.forEach(function (inst) {
        try {
          if (typeof inst.resume === 'function') inst.resume();
        } catch (e) {
          console.error('[panel-registry] resume error', e);
        }
      });
    },

    unmountAll: function () {
      ACTIVE_INSTANCES.forEach(function (inst, body) {
        try {
          if (typeof inst.unmount === 'function') inst.unmount();
        } catch (e) {}
      });
      ACTIVE_INSTANCES.clear();
      SCENE_INSTANCES.clear();
    }
  };

  root.APP_PANEL_REGISTRY = REGISTRY;
})(window);
