/**
 * panel-neuron.js —— 记忆神经元与拓扑图可视化面板
 * 包含：neuron
 * 实现标准生命周期：mount(body, meta, head), unmount(), pause(), resume()
 * 特性：后台休眠停用 requestAnimationFrame，切回前台恢复渲染，降低空闲 GPU/CPU 占用。
 */
(function (root) {
  'use strict';

  var REGISTRY = root.APP_PANEL_REGISTRY;

  var neuronPanel = {
    mount: function (body, meta, head) {
      body.classList.add('neuron-panel-body');
      var canvas = document.createElement('canvas');
      canvas.className = 'neuron-canvas';
      var tip = document.createElement('div');
      tip.className = 'neuron-tip';
      tip.innerHTML = '<span class="neuron-badge">神经元</span> <span class="neuron-stat">5 节点 · 记忆单一真源</span>';
      body.appendChild(canvas);
      body.appendChild(tip);

      var animId = null;
      var paused = false;
      var ctx = canvas.getContext('2d');
      var nodes = [
        { x: 50, y: 50, vx: 0.3, vy: 0.2, r: 6, label: 'L0 宪法' },
        { x: 120, y: 80, vx: -0.2, vy: 0.3, r: 5, label: 'L1 共享层' },
        { x: 90, y: 150, vx: 0.2, vy: -0.2, r: 5, label: 'L2 场景私有' },
        { x: 180, y: 120, vx: -0.3, vy: -0.1, r: 4, label: 'L3 资产隔离' },
        { x: 150, y: 180, vx: 0.1, vy: 0.2, r: 4, label: 'L4 运行时' }
      ];

      function resize() {
        var rect = body.getBoundingClientRect();
        canvas.width = rect.width || 300;
        canvas.height = rect.height || 200;
      }
      resize();

      function step() {
        if (paused) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // 连线
        ctx.strokeStyle = 'rgba(79, 140, 255, 0.25)';
        ctx.lineWidth = 1;
        for (var i = 0; i < nodes.length; i++) {
          for (var j = i + 1; j < nodes.length; j++) {
            ctx.beginPath();
            ctx.moveTo(nodes[i].x, nodes[i].y);
            ctx.lineTo(nodes[j].x, nodes[j].y);
            ctx.stroke();
          }
        }

        // 绘制节点
        for (var k = 0; k < nodes.length; k++) {
          var n = nodes[k];
          n.x += n.vx;
          n.y += n.vy;
          if (n.x < 10 || n.x > canvas.width - 10) n.vx = -n.vx;
          if (n.y < 10 || n.y > canvas.height - 10) n.vy = -n.vy;

          ctx.fillStyle = '#4f8cff';
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = 'rgba(255,255,255,0.75)';
          ctx.font = '10px sans-serif';
          ctx.fillText(n.label, n.x + 8, n.y + 3);
        }

        animId = requestAnimationFrame(step);
      }

      animId = requestAnimationFrame(step);

      return {
        unmount: function () {
          if (animId) cancelAnimationFrame(animId);
          animId = null;
          body.innerHTML = '';
        },
        pause: function () {
          paused = true;
          if (animId) cancelAnimationFrame(animId);
          animId = null;
        },
        resume: function () {
          if (!paused) return;
          paused = false;
          resize();
          if (!animId) animId = requestAnimationFrame(step);
        }
      };
    }
  };

  if (REGISTRY) {
    REGISTRY.register('neuron', neuronPanel);
  }
})(window);
