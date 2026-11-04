/**
 * legacy-services.js —— 历史与扩展场景（股票、OA、Blender、个人站、工业宿主）兼容服务
 * 职责：
 *   1. 承接历史 IPC 通道（保持与 preload.js 的契约对齐，杜绝悬空或崩溃）
 *   2. 保留通用宿主文件/目录读取与图片加载能力（view 面板与 neuron 面板依赖的通用能力）
 *   3. 异常安全切面，任何历史业务调用均安全兜底返回
 */
const fs = require('fs');
const path = require('path');
const { shell, nativeImage } = require('electron');

function stubModule() {
  return new Proxy(function () {}, {
    get: () => () => undefined,
    apply: () => undefined,
  });
}

const stockStore = stubModule();
const oaStore = stubModule();
const oaSsh = stubModule();

function setupLegacyServices(ipcMain, { workbenchRoot, siteDir, sitePort, logger }) {
  // ---- 站点与通用外链 ----
  ipcMain.handle('site:preview', () => `http://127.0.0.1:${sitePort}/index.html`);
  ipcMain.handle('site:info', () => ({
    title: '工作台',
    accounts: [],
    email: '',
    siteUrl: `http://127.0.0.1:${sitePort}/index.html`,
  }));
  ipcMain.handle('site:open', (e, url) => {
    const u = String(url || '');
    if (/^(https?:|mailto:)/i.test(u)) { try { shell.openExternal(u); } catch (ex) {} }
    return true;
  });
  ipcMain.handle('site:open-folder', (e, dir) => {
    const d = String(dir || '');
    if (!d) return { ok: false, err: 'empty' };
    try { shell.openPath(d); return { ok: true }; } catch (ex) { return { ok: false, err: String(ex.message || ex) }; }
  });
  ipcMain.handle('site:probe', (e, url) => {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) return Promise.resolve({ ok: false, err: 'bad-url' });
    return new Promise((resolve) => {
      try {
        const mod = u.toLowerCase().startsWith('https:') ? require('https') : require('http');
        const req = mod.get(u, { headers: { 'User-Agent': 'workbench-probe/1.0' } }, (res) => {
          const code = res.statusCode || 0;
          res.resume();
          resolve({ ok: code >= 200 && code < 400, status: code });
        });
        req.on('error', () => resolve({ ok: false, status: 0 }));
        req.setTimeout(5000, () => { try { req.destroy(); } catch (x) {} resolve({ ok: false, status: 0 }); });
      } catch (ex) { resolve({ ok: false, status: 0 }); }
    });
  });
  ipcMain.handle('site:files:local', async () => ({ ok: true, rows: [] }));
  ipcMain.handle('site:open-file', async (e, relPath) => {
    try {
      const full = path.join(siteDir || '', String(relPath || ''));
      if (fs.existsSync(full)) { await shell.openPath(full); return { ok: true }; }
      return { ok: false, err: 'not-found' };
    } catch (e) { return { ok: false, err: String(e.message || e) }; }
  });
  ipcMain.handle('code:phone-window', (e, url) => {
    if (url) { try { shell.openExternal(url); } catch (ex) {} }
    return { ok: true };
  });

  // ---- Blender 与宿主 Hook ----
  ipcMain.handle('blender:state', () => ({ ok: true, running: false }));
  ipcMain.handle('blender:launch', () => ({ ok: false, err: 'not-configured' }));
  ipcMain.handle('blender:close', () => ({ ok: true }));
  ipcMain.handle('blender:capture', () => ({ ok: false }));
  ipcMain.handle('blender:embed', () => ({ ok: false }));
  ipcMain.handle('blender:embedMove', () => ({ ok: true }));
  ipcMain.handle('blender:embedStatus', () => ({ ok: true, embedded: false }));
  ipcMain.handle('blender:files', () => ({ ok: true, rows: [] }));
  ipcMain.handle('blender:open', () => ({ ok: true }));
  ipcMain.handle('blender:reveal', () => ({ ok: true }));
  ipcMain.handle('appwin:status', () => ({ ok: true, running: false }));
  ipcMain.handle('appwin:launch', () => ({ ok: false }));
  ipcMain.handle('appwin:embed', () => ({ ok: false }));
  ipcMain.handle('appwin:move', () => ({ ok: true }));
  ipcMain.handle('appwin:release', () => ({ ok: true }));

  // ---- 股票通用 / 记忆 / 对话 ----
  ipcMain.handle('stock:mem:add', (e, m) => stockStore.addMemory(m));
  ipcMain.handle('stock:mem:list', (e, kind, scenario) => stockStore.listMemories(kind, scenario));
  ipcMain.handle('stock:mem:update', (e, id, patch) => stockStore.updateMemory(id, patch));
  ipcMain.handle('stock:mem:delete', (e, id) => stockStore.deleteMemory(id));
  ipcMain.handle('stock:chat:create', (e, scenario, title) => stockStore.createSession(scenario, title));
  ipcMain.handle('stock:chat:list', (e, scenario) => stockStore.listSessions(scenario));
  ipcMain.handle('stock:chat:messages', (e, sid) => stockStore.getMessages(sid));
  ipcMain.handle('stock:chat:send', (e, sid, role, content) => stockStore.addMessage(sid, role, content));
  ipcMain.handle('stock:chat:delete', (e, sid) => stockStore.deleteSession(sid));
  ipcMain.handle('stock:chat:rename', (e, sid, title) => stockStore.renameSession(sid, title));
  ipcMain.handle('stock:watch:set', (e, code, name) => stockStore.setWatch(code, name));
  ipcMain.handle('stock:watch:list', () => stockStore.listWatch());
  ipcMain.handle('stock:watch:remove', (e, code) => stockStore.removeWatch(code));
  ipcMain.handle('stock:pos:set', (e, code, name, shares, cost) => stockStore.setPosition(code, name, shares, cost));
  ipcMain.handle('stock:pos:list', () => stockStore.listPositions());
  ipcMain.handle('stock:pos:update', (e, code, patch) => stockStore.updatePosition(code, patch));
  ipcMain.handle('stock:pos:remove', (e, code) => stockStore.removePosition(code));
  ipcMain.handle('stock:trade:buy', (e, code, name, shares, price) => stockStore.buyStock(code, name, shares, price));
  ipcMain.handle('stock:trade:sell', (e, code, name, shares, price) => stockStore.sellStock(code, name, shares, price));
  ipcMain.handle('stock:trade:close', (e, code, price) => stockStore.closePosition(code, price));
  ipcMain.handle('stock:trade:list', (e, limit) => stockStore.listTrades(limit));
  ipcMain.handle('stock:trade:stats', () => stockStore.tradeStats());
  ipcMain.handle('stock:fee:get', () => stockStore.getFeeConfig());
  ipcMain.handle('stock:fee:set', (e, patch) => stockStore.setFeeConfig(patch));
  ipcMain.handle('stock:quote:cache', (e, code, payload) => stockStore.cacheQuote(code, payload));
  ipcMain.handle('stock:quote:latest', (e, code) => stockStore.latestQuote(code));
  ipcMain.handle('stock:kline:cache', (e, code, period, payload) => stockStore.cacheKline(code, period, payload));
  ipcMain.handle('stock:kline:latest', (e, code, period) => stockStore.latestKline(code, period));
  ipcMain.handle('stock:sector:daily:set', () => ({ ok: true }));
  ipcMain.handle('stock:sector:daily:get', (e, market, date) => stockStore.getSectorDaily(market, date));
  ipcMain.handle('stock:sector:daily:history', (e, market, sectorId, limit) => stockStore.listSectorDaily(market, sectorId, limit));
  ipcMain.handle('stock:acct:init', (e, amount) => stockStore.initCash(amount));
  ipcMain.handle('stock:acct:cash', () => stockStore.getCash());
  ipcMain.handle('stock:acct:account', () => stockStore.getAccount());
  ipcMain.handle('stock:acct:set-total', (e, amount) => stockStore.setTotalAsset(amount));
  ipcMain.handle('stock:acct:set-cash', (e, amount) => stockStore.setCash(amount));
  ipcMain.handle('stock:acct:adjust', (e, delta) => stockStore.adjustCash(delta));
  ipcMain.handle('stock:acct:snapshot', (e, snap) => stockStore.addAssetSnapshot(snap));
  ipcMain.handle('stock:acct:snapshots', (e, limit) => stockStore.listAssetSnapshots(limit));
  ipcMain.handle('stock:script:run', () => Promise.resolve({ ok: false, out: '', err: '未配置 Python 环境' }));
  ipcMain.handle('stock:quote:realtime', () => Promise.resolve({ ok: true, quotes: {} }));
  ipcMain.handle('stock:kline:history', () => Promise.resolve({ ok: true, data: [] }));
  ipcMain.handle('stock:kline:batch', () => Promise.resolve({ ok: true, data: {} }));
  ipcMain.handle('stock:market:rank', () => Promise.resolve({ ok: true, list: [] }));
  ipcMain.handle('stock:market:rankCached', (e, type) => stockStore.latestRank(type));

  // ---- OA 运维与宿主文件扩展 ----
  ipcMain.handle('oa:status', () => Promise.resolve({ ok: true, status: 'idle' }));
  ipcMain.handle('oa:logs', () => Promise.resolve({ ok: true, logs: [] }));
  ipcMain.handle('oa:logs:real', () => Promise.resolve({ ok: true, logs: [] }));
  ipcMain.handle('oa:files', () => Promise.resolve({ ok: true, files: [] }));
  ipcMain.handle('oa:files:local', async (e, localPath) => {
    const base = localPath || path.join(workbenchRoot, '工作区');
    try {
      const ents = await fs.promises.readdir(base, { withFileTypes: true });
      const rows = await Promise.all(ents.map(async (en) => {
        let isDir = en.isDirectory();
        let size = 0;
        let mtime = 0;
        try {
          const st = await fs.promises.stat(path.join(base, en.name));
          isDir = st.isDirectory();
          size = isDir ? 0 : st.size;
          mtime = Math.floor(st.mtimeMs / 1000);
        } catch (err) {}
        return { name: en.name, isDir, size, mtime };
      }));
      rows.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'zh'));
      return { ok: true, base, rows };
    } catch (ex) {
      return { ok: false, err: '无法读取目录: ' + base, base, rows: [] };
    }
  });
  ipcMain.handle('oa:paths', () => ({
    localRoot: path.join(workbenchRoot, '工作区'),
    code: '/opt/oa',
    www: '/var/www',
    backups: '/opt/backups',
    mappings: [],
  }));
  ipcMain.handle('oa:set-scenario', () => ({ ok: true }));
  ipcMain.handle('oa:image', async (e, p) => {
    try {
      const fp = String(p || '');
      if (!fp || !fs.existsSync(fp)) return { ok: false, err: '文件不存在' };
      const st = fs.statSync(fp);
      if (st.size > 12 * 1024 * 1024) return { ok: false, err: '图片过大（>12MB）' };
      const ext = path.extname(fp).slice(1).toLowerCase();
      const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif'
        : ext === 'webp' ? 'image/webp' : ext === 'bmp' ? 'image/bmp' : 'image/jpeg';
      const b64 = fs.readFileSync(fp).toString('base64');
      return { ok: true, dataUrl: 'data:' + mime + ';base64,' + b64, name: path.basename(fp) };
    } catch (ex) {
      return { ok: false, err: String(ex.message || ex) };
    }
  });
  ipcMain.handle('oa:openFolder', async (e, dir) => {
    try {
      const d = String(dir || '');
      if (!d || !fs.existsSync(d)) return { ok: false, err: '目录不存在: ' + d };
      const r = await shell.openPath(d);
      return r ? { ok: false, err: r } : { ok: true };
    } catch (ex) {
      return { ok: false, err: String(ex.message || ex) };
    }
  });
  ipcMain.handle('oa:openPath', async (e, p) => {
    try {
      const target = String(p || '');
      if (!target || !fs.existsSync(target)) return { ok: false, err: '文件不存在' };
      shell.showItemInFolder(target);
      return { ok: true };
    } catch (ex) {
      return { ok: false, err: String(ex.message || ex) };
    }
  });
  ipcMain.handle('oa:upload', () => Promise.resolve({ ok: false, err: 'not-configured' }));
  ipcMain.handle('oa:download', () => Promise.resolve({ ok: false, err: 'not-configured' }));
  ipcMain.handle('oa:sync:status', () => Promise.resolve({ ok: true, synced: true }));
  ipcMain.handle('oa:sync:push', () => Promise.resolve({ ok: true }));
  ipcMain.handle('oa:sync:pull', () => Promise.resolve({ ok: true }));
  ipcMain.handle('oa:web:list', () => Promise.resolve({ ok: true, list: [] }));
  ipcMain.handle('oa:urls', () => Promise.resolve({ ok: true, urls: [] }));
  ipcMain.handle('oa:web:check', () => Promise.resolve({ ok: true, alive: true }));
  ipcMain.handle('oa:open', (e, url) => {
    if (url) shell.openExternal(url);
    return Promise.resolve({ ok: true });
  });
  ipcMain.handle('oa:appWindow', () => Promise.resolve({ ok: true }));
  ipcMain.handle('oa:appWindow:pin', () => Promise.resolve({ ok: true }));
  ipcMain.handle('oa:appWindow:pinState', () => Promise.resolve({ ok: true, pinned: false }));
  ipcMain.handle('oa:ai:perms', () => Promise.resolve({ read: true, write: false, sync: false }));
  ipcMain.handle('oa:ai:perms:set', () => Promise.resolve({ ok: true }));
  ipcMain.handle('oa:code:read', () => Promise.resolve({ ok: false, err: 'not-supported' }));
  ipcMain.handle('oa:code:write', () => Promise.resolve({ ok: false, err: 'not-supported' }));
  ipcMain.handle('oa:backups', () => Promise.resolve({ ok: true, rows: [] }));
  ipcMain.handle('oa:action:list', () => Promise.resolve({ ok: true, actions: [] }));
  ipcMain.handle('oa:action:run', () => Promise.resolve({ ok: true }));
  ipcMain.handle('oa:shell:exec', () => Promise.resolve({ ok: true, out: '' }));
  ipcMain.handle('oa:shell:history', () => Promise.resolve({ ok: true, list: [] }));
  ipcMain.handle('oa:agent:dequeue', () => Promise.resolve({ ok: true, item: null }));
  ipcMain.handle('oa:agent:ack', () => Promise.resolve({ ok: true }));
  ipcMain.handle('oa:config:get', () => Promise.resolve({ ok: true, config: {} }));
  ipcMain.handle('oa:config:set', () => Promise.resolve({ ok: true }));
  ipcMain.handle('oa:ssh:status', () => Promise.resolve({ connected: false }));

  ipcMain.on('oa:dragstart', (event, filePath) => {
    try {
      const fp = String(filePath || '');
      if (!fp || !fs.existsSync(fp)) return;
      let icon = null;
      try {
        const img = nativeImage.createFromPath(path.join(__dirname, '..', 'icon.png'));
        if (img && !img.isEmpty()) icon = img.resize({ width: 64 });
      } catch (e) {}
      const payload = { file: fp };
      if (icon && !icon.isEmpty()) payload.icon = icon;
      event.sender.startDrag(payload);
    } catch (ex) {}
  });
}

module.exports = {
  setupLegacyServices,
};
