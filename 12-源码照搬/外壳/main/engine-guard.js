/**
 * engine-guard.js —— DSH 引擎守护、CLI 探测、健康探活与生命周期管理
 * 职责：
 *   1. 探测本机 DSH 官方 CLI / 可用 Node 环境（无盘符硬编码）
 *   2. 组装安全的引擎运行环境（隔离数据目录、临时文件夹、沙箱提权）
 *   3. 进程输出监听、Token 正则嗅探与 HTTP 探活
 *   4. 进程树安全终结与清理
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

let cachedNodeExe = null;

function resolveNodeExe(logger) {
  if (cachedNodeExe !== null) return cachedNodeExe;
  cachedNodeExe = '';
  if (process.env.DSH_NODE) {
    try {
      if (fs.statSync(process.env.DSH_NODE).isFile()) {
        cachedNodeExe = process.env.DSH_NODE;
        return cachedNodeExe;
      }
    } catch (e) {}
  }
  const dirs = String(process.env.Path || process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const sysDrive = process.env.SystemDrive || 'C:';
  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs'),
    path.join(sysDrive, 'Program Files', 'nodejs'),
  ];
  for (const d of candidates) {
    if (d) dirs.push(d);
  }
  for (const d of dirs) {
    const p = path.join(d, 'node.exe');
    try {
      if (fs.statSync(p).isFile()) {
        cachedNodeExe = p;
        return cachedNodeExe;
      }
    } catch (e) {}
  }
  if (typeof logger === 'function') logger('[boot] 未找到系统 node，将使用 Electron 模式');
  return cachedNodeExe;
}

function findDshCmd(manifest, logger) {
  const fromManifest = manifest && manifest.engine && manifest.engine.cliPath;
  if (fromManifest) {
    try {
      if (fs.statSync(fromManifest).isFile()) return fromManifest;
    } catch (e) {
      if (typeof logger === 'function') logger('[boot] 工作台.json 指定的 cliPath 不存在: ' + fromManifest);
    }
  }

  const fromEnv = process.env.DSH_CMD;
  if (fromEnv) {
    try {
      if (fs.statSync(fromEnv).isFile()) return fromEnv;
    } catch (e) {
      if (typeof logger === 'function') logger('[boot] DSH_CMD 环境变量指定的路径不存在: ' + fromEnv);
    }
  }

  try {
    const out = spawnSync('where.exe', ['dsh'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    if (out.status === 0 && out.stdout) {
      const first = out.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l && l.endsWith('.cmd'));
      if (first && fs.existsSync(first)) return first;
    }
  } catch (e) {}

  const localApp = process.env.LOCALAPPDATA;
  if (localApp) {
    const appDataCmd = path.join(localApp, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
    if (fs.existsSync(appDataCmd)) return appDataCmd;
  }

  const progFiles = process.env.ProgramFiles;
  if (progFiles) {
    const pfCmd = path.join(progFiles, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
    if (fs.existsSync(pfCmd)) return pfCmd;
  }

  return '';
}

function serverSpawnEnv(dshDataDir, rootDir, logger) {
  const env = Object.assign({}, process.env);
  env.DSH_HOME = dshDataDir;
  if (!env.DSH_PERMISSION_MODE) env.DSH_PERMISSION_MODE = 'danger-full-access';
  const tmpDir = path.join(rootDir, 'data', 'temp');
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch (e) {
    if (typeof logger === 'function') logger('[boot] 建临时目录失败: ' + (e && e.message));
  }
  env.TEMP = tmpDir;
  env.TMP = tmpDir;
  return env;
}

function captureToken(text, port, onToken) {
  const m = String(text).match(new RegExp('http:\\/\\/127\\.0\\.0\\.1:' + port + '\\/\\?token=([A-Za-z0-9_\\-]+)'));
  if (m && m[1] && typeof onToken === 'function') {
    onToken(m[1]);
  }
}

function probe(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/`, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function killProcessTree(pid) {
  if (!pid) return;
  try {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  } catch (e) {}
}

module.exports = {
  resolveNodeExe,
  findDshCmd,
  serverSpawnEnv,
  captureToken,
  probe,
  killProcessTree,
};
