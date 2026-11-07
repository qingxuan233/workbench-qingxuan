/**
 * system-io.js —— 宿主系统能力、硬件状态与受保护文件 I/O
 * 职责：
 *   1. 文本文件安全读写与元数据读取（4MB 限制、原子临时文件写入）
 *   2. 系统对话框（选择文件夹、选择文件、独立窗口置顶）
 *   3. 本机端口探测、地址栏历史目录提取、CPU/GPU/内存负载监测
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { dialog } = require('electron');

const FILE_TEXT_MAX = 4 * 1024 * 1024;
let topbarRecentCache = { at: 0, rows: [] };
let __loadCpuPrev = null;

function loadCpuPercent() {
  const cpus = os.cpus() || [];
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    const t = c.times || {};
    idle += t.idle || 0;
    total += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0);
  }
  const prev = __loadCpuPrev;
  __loadCpuPrev = { idle, total };
  if (!prev) return null;
  const di = idle - prev.idle;
  const dt = total - prev.total;
  return dt > 0 ? Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100))) : null;
}

function nvidiaSmiOnce() {
  return new Promise((resolve) => {
    const sysRoot = process.env.SystemRoot || (process.env.SystemDrive ? path.join(process.env.SystemDrive, 'Windows') : 'Windows');
    const exe = path.join(sysRoot, 'System32', 'nvidia-smi.exe');
    let out = '';
    let done = false;
    let cp = null;
    try {
      cp = spawn(exe, ['--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { windowsHide: true });
    } catch (e) {
      return resolve(null);
    }
    const t = setTimeout(() => {
      try { cp.kill(); } catch (e) {}
      if (!done) { done = true; resolve(null); }
    }, 3000);
    cp.stdout.on('data', (d) => { out += d; });
    cp.stderr.on('data', () => {});
    cp.on('error', () => { if (!done) { done = true; clearTimeout(t); resolve(null); } });
    cp.on('close', () => { if (done) return; done = true; clearTimeout(t); resolve(out); });
  });
}

function setupSystemIO(ipcMain, { workbenchRoot, windowOfEvent, getMainWindow, logger }) {
  function toSafePath(p) {
    const s = String(p || '').trim();
    if (!s) return '';
    if (path.isAbsolute(s)) return s;
    return path.resolve(workbenchRoot || process.cwd(), s);
  }

  ipcMain.handle('kun:sys:disks', () => {
    const letters = ['C', 'D', 'E', 'F'];
    const drives = letters.map((letter) => {
      const root = letter + ':\\';
      const row = { drive: letter + ':', ok: false, total: 0, free: 0, used: 0, percent: 0, err: '' };
      try {
        if (typeof fs.statfsSync === 'function') {
          const st = fs.statfsSync(root);
          const bsize = Number(st.bsize) || 0;
          const total = Number(st.blocks) * bsize;
          const free = Number(st.bavail) * bsize;
          if (total > 0) {
            row.ok = true;
            row.total = total;
            row.free = free;
            row.used = Math.max(0, total - free);
            row.percent = Math.round((row.used / total) * 1000) / 10;
          }
        }
      } catch (e) {
        row.err = (e && (e.code || e.message)) || 'unavailable';
      }
      return row;
    });
    return { ok: true, at: Date.now(), drives };
  });

  ipcMain.handle('kun:file:stat', async (e, p) => {
    const t = toSafePath(p);
    if (!t) return { ok: false, err: 'empty' };
    try {
      const st = await fs.promises.stat(t);
      return { ok: true, exists: true, isDir: st.isDirectory(), size: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
    } catch (ex) {
      return { ok: true, exists: false, isDir: false, size: 0, mtime: 0 };
    }
  });

  // ---- 通用「本地列目录」能力（2026-11-07 补）----
  // 为什么补：这个能力原来只写在 main/legacy-services.js 的 setupLegacyServices() 里（通道 oa:files:local），
  //   但那个 setup 函数**没有任何地方调用**（main.js 只 require、没 setup）⇒ 通道根本不存在
  //   ⇒ 渲染层每次调 app.oa.filesLocal 都 reject。实测后果：
  //     · 记忆神经元（renderers.neuron）列技能目录失败 → 退回硬编码技能兜底表（25 个旧工作区技能名，
  //       本机只有 3 个存在）→ 面板常驻「⛔ 路径失效 22」；
  //     · 通用预览（view）的缩略图网格、客户卡片墙（wb-cards）列目录也整块不可用。
  // 现在：新通道 kun:file:list（preload 的 app.file.list），并保留 oa:files:local 作为旧通道别名
  //   （preload 的 app.oa.filesLocal 还在被老渲染器使用，直接删通道会让它们整块失灵）。
  // 只读、不写、不做路径白名单：这是宿主通用能力，跟任何场景数据无关。
  const listLocalDir = async (p) => {
    const base = toSafePath(p) || path.join(workbenchRoot || process.cwd(), '工作区');
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
        } catch (err) { /* 单项读不到不影响整目录 */ }
        return { name: en.name, isDir, size, mtime };
      }));
      rows.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'zh'));
      return { ok: true, base, rows };
    } catch (ex) {
      return { ok: false, err: '无法读取目录: ' + base, base, rows: [] };
    }
  };
  ipcMain.handle('kun:file:list', (e, p) => listLocalDir(p));
  ipcMain.handle('oa:files:local', (e, p) => listLocalDir(p));

  ipcMain.handle('kun:file:read', async (e, p) => {
    const t = toSafePath(p);
    if (!t) return { ok: false, err: 'empty' };
    try {
      const st = await fs.promises.stat(t);
      if (st.isDirectory()) return { ok: false, err: '这是文件夹，不是文件' };
      if (st.size > FILE_TEXT_MAX) return { ok: false, err: '文件太大（' + (st.size / 1048576).toFixed(1) + ' MB），编辑器只开到 4 MB' };
      const text = await fs.promises.readFile(t, 'utf8');
      return { ok: true, path: t, text, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
    } catch (ex) {
      return { ok: false, err: '读不到：' + String((ex && ex.message) || ex) };
    }
  });

  ipcMain.handle('kun:file:write', async (e, p, text) => {
    const t = toSafePath(p);
    if (!t) return { ok: false, err: 'empty' };
    try {
      await fs.promises.mkdir(path.dirname(t), { recursive: true });
      const tmp = t + '.kun-tmp';
      await fs.promises.writeFile(tmp, String(text == null ? '' : text), 'utf8');
      await fs.promises.rename(tmp, t);
      const st = await fs.promises.stat(t);
      return { ok: true, path: t, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
    } catch (ex) {
      return { ok: false, err: '写不了：' + String((ex && ex.message) || ex) };
    }
  });

  ipcMain.handle('kun:pick-folder', async (e) => {
    const win = (typeof windowOfEvent === 'function' ? windowOfEvent(e) : null) || (typeof getMainWindow === 'function' ? getMainWindow() : null);
    if (!win) return null;
    try {
      const r = await dialog.showOpenDialog(win, {
        title: '选择生成路径（文件夹）',
        buttonLabel: '选这个文件夹',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
      return r.filePaths[0];
    } catch (ex) {
      return null;
    }
  });

  ipcMain.handle('kun:pick-file', async (e, filters) => {
    const win = (typeof windowOfEvent === 'function' ? windowOfEvent(e) : null) || (typeof getMainWindow === 'function' ? getMainWindow() : null);
    if (!win) return null;
    try {
      const opts = { title: '选择文件', buttonLabel: '选这个文件', properties: ['openFile'] };
      if (Array.isArray(filters) && filters.length) opts.filters = filters;
      const r = await dialog.showOpenDialog(win, opts);
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
      return r.filePaths[0];
    } catch (ex) {
      return null;
    }
  });

  ipcMain.handle('kun:set-always-on-top', (e, flag) => {
    const win = (typeof windowOfEvent === 'function' ? windowOfEvent(e) : null) || (typeof getMainWindow === 'function' ? getMainWindow() : null);
    if (!win) return false;
    try {
      const cur = win.isAlwaysOnTop();
      const next = typeof flag === 'boolean' ? flag : !cur;
      win.setAlwaysOnTop(next);
      return win.isAlwaysOnTop();
    } catch (ex) {
      return false;
    }
  });

  ipcMain.handle('kun:net:probe', (e, host, port, timeoutMs) => {
    const p = Number(port);
    const h = String(host || '127.0.0.1');
    if (!p || p < 1 || p > 65535) return Promise.resolve({ ok: false, open: false });
    return new Promise((resolve) => {
      const s = net.createConnection({ host: h, port: p, timeout: timeoutMs || 1000 });
      let done = false;
      function fin(open) {
        if (done) return;
        done = true;
        try { s.destroy(); } catch (ex) {}
        resolve({ ok: true, open });
      }
      s.once('connect', () => fin(true));
      s.once('timeout', () => fin(false));
      s.once('error', () => fin(false));
    });
  });

  ipcMain.handle('topbar:recent-folders', () => {
    const now = Date.now();
    if (now - topbarRecentCache.at < 30000 && topbarRecentCache.rows.length) {
      return { ok: true, at: topbarRecentCache.at, rows: topbarRecentCache.rows };
    }
    const cands = new Map();
    function add(p, reason) {
      if (!p) return;
      try {
        const norm = path.normalize(p).replace(/[\\/]+$/, '');
        if (cands.has(norm)) return;
        const st = fs.statSync(norm);
        if (st.isDirectory()) cands.set(norm, { path: norm, name: path.basename(norm) || norm, at: st.mtimeMs, reason });
      } catch (e) {}
    }
    try {
      const r = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\TypedPaths'],
        { encoding: 'utf8', windowsHide: true, timeout: 8000 });
      for (const line of String((r && r.stdout) || '').split(/\r?\n/)) {
        const m = line.match(/REG_SZ\s+(.+)$/);
        if (m) add(m[1], '地址栏敲过');
      }
    } catch (e) {}
    const rows = Array.from(cands.values()).sort((a, b) => b.at - a.at).slice(0, 6);
    topbarRecentCache = { at: now, rows };
    return { ok: true, at: now, rows };
  });

  ipcMain.handle('kun:sys:load', async () => {
    const out = { ok: true, at: Date.now(), cpu: null, gpu: null };
    try { out.cpu = loadCpuPercent(); } catch (e) {}
    try {
      const tot = os.totalmem();
      const free = os.freemem();
      out.mem = {
        usedPct: Math.round((1 - free / tot) * 100),
        usedGB: Math.round((tot - free) / 1073741824 * 10) / 10,
        totalGB: Math.round(tot / 1073741824 * 10) / 10,
      };
    } catch (e) {}
    try {
      const raw = await nvidiaSmiOnce();
      if (raw) {
        const p = String(raw).trim().split(/\r?\n/)[0].split(',').map((s) => s.trim());
        if (p.length >= 5 && p[1] !== '' && !isNaN(Number(p[1]))) {
          out.gpu = { name: p[0], util: Number(p[1]), temp: Number(p[2]), memUsed: Number(p[3]), memTotal: Number(p[4]) };
        }
      }
    } catch (e) {}
    return out;
  });
}

module.exports = {
  setupSystemIO,
};
