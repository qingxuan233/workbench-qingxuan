/* public-clean.js —— 开源版：隐藏只属于「本机私有」的功能入口
 * 用法：index.html 末尾引入即可。
 * 说明：不是删除能力，只是开源模板里不展示（本地抠图、远程控制、本地模型）。
 * ⚠ 2026-11-08 修 F1（GUI 优化 P0-1）：`#btn-models` **不再隐藏**。
 *   它原来是「模型与凭据」的唯一顶栏入口，却被 display:none!important 藏掉；
 *   再叠加"showModels 只读 / showSettings 死函数 / settings:open 渲染层零调用"就是三重断 ——
 *   用户根本找不到填 API Key 的地方，AI 面板不回话，看起来像功能坏了。
 *   现在按钮可见，点击由 ui/ui-credential.js 接管（真正的填写入口）。
 */
(function () {
  var HIDE = ['#btn-remote', '#btn-cut', '#btn-localmodel'];
  var TEXT_HIDE = ['远程控制', '手机远程访问', '本地抠图', '模型提供方', '记忆管理'];
  function css() {
    if (document.getElementById('public-clean-css')) return;
    var s = document.createElement('style');
    s.id = 'public-clean-css';
    s.textContent = HIDE.join(',') + '{display:none!important}';
    document.head.appendChild(s);
  }
  function sweep() {
    css();
    var items = document.querySelectorAll('.menu-item,.pop-item,.dd-item,button,a,li');
    for (var i = 0; i < items.length; i++) {
      var t = (items[i].textContent || '').trim();
      if (!t) continue;
      for (var k = 0; k < TEXT_HIDE.length; k++) {
        if (t === TEXT_HIDE[k] || t.indexOf(TEXT_HIDE[k]) === 0) { items[i].style.display = 'none'; break; }
      }
    }
  }
  function boot() { sweep(); setInterval(sweep, 1500); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
