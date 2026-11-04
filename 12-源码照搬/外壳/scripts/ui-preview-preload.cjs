/* ui-preview-preload.cjs —— UI 预览用的假宿主（2026-11-03）
 *
 * 只给 `scripts/ui-preview.cjs` 使用：把 renderer.js 需要的 window.app 通道
 * 做成内存桩，场景配置直接读 scenarios/*.json。不连接 DSH 引擎、不写任何数据。
 */
const { contextBridge } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCEN_DIR = path.join(ROOT, 'scenarios');
const fail = async () => ({ ok: false, error: 'preview-mock' });

function listScenarios() {
  try {
    return fs.readdirSync(SCEN_DIR)
      .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
      .sort()
      .map((f) => {
        const s = JSON.parse(fs.readFileSync(path.join(SCEN_DIR, f), 'utf8'));
        return { id: s.id, name: s.name, description: s.description || '', first: !!s.first };
      });
  } catch (e) { return []; }
}

function getScenario(id) {
  try { return JSON.parse(fs.readFileSync(path.join(SCEN_DIR, id + '.json'), 'utf8')); }
  catch (e) { return null; }
}

contextBridge.exposeInMainWorld('app', {
  paths: { dataDir: path.join(ROOT, 'data'), reviewDir: path.join(ROOT, '..', '自我复盘'), memRoot: '', skillDir: '' },
  listScenarios: async () => listScenarios(),
  getScenario: async (id) => getScenario(id),
  isHarnessReady: async () => false,
  getHarnessUrl: async () => '',
  getVersion: async () => ({ gui: '2.0.0-preview', engine: 'preview', electron: process.versions.electron }),
  bootState: async () => ({ stage: 'ready', pct: 100 }),
  onBootProgress: () => {},
  onHarnessReady: () => {},
  bootRetry: () => {},
  balance: {
    get: async () => ({ ok: true, total: '128.00', toppedUp: '100', granted: '28', currency: 'CNY', isAvailable: true }),
    refresh: async () => ({ ok: true, total: '128.00', currency: 'CNY' }),
    open: () => {},
    onUpdate: () => {}
  },
  theme: { setWindowBg: () => {} },
  settings: { open: () => {}, get: fail },
  plugins: { list: async () => ({ plugins: [], pluginsDir: 'preview', dataDir: 'preview', builtinCount: 0, builtinDir: '' }) },
  skills: { list: async () => ({ skills: [], skillsDir: 'preview' }), open: () => {} },
  toolsCatalog: async () => ({ groups: [], total: 0, updated: '' }),
  models: { list: async () => ({ groups: [] }) },
  win: { openScene: () => {}, onChanged: () => {}, scenes: async () => [] },
  getSceneOrder: async () => ({ saved: true, order: [] }),
  setSceneOrder: async () => ({ ok: true }),
  openPath: () => {},
  file: { read: fail, write: fail, open: () => {} },
  topbar: { open: () => {}, snapshots: async () => ({ rows: [], total: 0 }), pressure: async () => ({}), todos: async () => ({}), onToast: () => {} },
  review: { list: fail, read: fail, open: () => {} },
  pc: { scan: fail, disks: fail },
  remoteAccess: { status: fail, qr: fail }
});
