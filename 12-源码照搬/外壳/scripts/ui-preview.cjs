/* ui-preview.cjs —— 不连引擎、只看界面的预览/截图器（2026-11-03）
 *
 *   node_modules\.bin\electron scripts\ui-preview.cjs
 *   node_modules\.bin\electron scripts\ui-preview.cjs --shot=data\ui-preview.png --scene=command
 *
 * 用途：改 ui/*.css / ui/*.js 时不开真引擎也能看效果；也方便截图验收。
 * 数据：scripts/ui-preview-preload.cjs 里的内存桩 + scenarios/*.json 真配置。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const shot = arg('shot', '');
const scene = arg('scene', 'command');
const width = Number(arg('width', '1600')) || 1600;
const height = Number(arg('height', '980')) || 980;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width,
    height,
    show: !shot,
    backgroundColor: '#0b0e15',
    webPreferences: {
      preload: path.join(__dirname, 'ui-preview-preload.cjs'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      webviewTag: true
    }
  });

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: { ui: 'v2' } });
  await new Promise((r) => setTimeout(r, 1400));

  // 切到指定场景（默认命令：2 个面板，最能看出左右结构）
  try {
    await win.webContents.executeJavaScript(
      'document.querySelector(\'.tab[data-sc-id="' + String(scene).replace(/["\\]/g, '') + '"]\')?.click(); true'
    );
  } catch (e) { /* ignore */ }
  await new Promise((r) => setTimeout(r, 900));

  if (shot) {
    const img = await win.webContents.capturePage();
    const out = path.isAbsolute(shot) ? shot : path.join(__dirname, '..', shot);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, img.toPNG());
    console.log('saved ' + out);
    app.quit();
  }
});
