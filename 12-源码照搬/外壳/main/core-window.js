/**
 * core-window.js —— 窗口拓扑、几何记忆与场景分离窗口管理
 * 职责：
 *   1. 窗口几何状态读写与多屏幕校验（windows.json，断联副屏不丢窗口）
 *   2. 窗口注册表、按发起方寻址（windowOfEvent / windowOfWebContents）
 *   3. 场景分离独立窗口的生命周期调度与全窗口广播
 */
const fs = require('fs');
const path = require('path');
const { screen, BrowserWindow } = require('electron');

let mainWindow = null;
let lastFocusedWin = null;
const detachedScenes = new Set();
const sceneWindows = new Map(); // sceneId -> BrowserWindow

/** 读 windows.json */
function loadWindowsState(dataPath) {
  const p = path.join(dataPath, 'windows.json');
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {}
  return { main: null, scenes: {} };
}

/** 存 windows.json */
function saveWindowsState(dataPath, state) {
  const p = path.join(dataPath, 'windows.json');
  try {
    fs.mkdirSync(dataPath, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {}
}

/** 校验并校正窗口几何位置（防副屏拔掉后窗口在屏幕外） */
function fitSavedBounds(saved, defW, defH) {
  if (!saved || typeof saved !== 'object') return { bounds: { width: defW, height: defH }, clamped: false, maximized: false };
  const width = Math.max(800, Number(saved.width) || defW);
  const height = Math.max(500, Number(saved.height) || defH);
  let x = typeof saved.x === 'number' ? saved.x : null;
  let y = typeof saved.y === 'number' ? saved.y : null;
  const isMax = !!saved.maximized;

  if (x === null || y === null) {
    return { bounds: { width, height }, clamped: false, maximized: isMax };
  }

  try {
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    // 检查是否与任一屏幕的工作区有相交
    const visible = displays.some((d) => {
      const b = d.workArea;
      return x + width > b.x + 50 && x < b.x + b.width - 50 &&
             y + height > b.y + 50 && y < b.y + b.height - 50;
    });
    if (!visible && primary) {
      const pb = primary.workArea;
      x = pb.x + Math.max(0, Math.floor((pb.width - width) / 2));
      y = pb.y + Math.max(0, Math.floor((pb.height - height) / 2));
      return { bounds: { x, y, width, height }, clamped: true, maximized: isMax };
    }
  } catch (e) {}

  return { bounds: { x, y, width, height }, clamped: false, maximized: isMax };
}

function setMainWindow(win) {
  mainWindow = win;
  if (win) lastFocusedWin = win;
}

function getMainWindow() {
  return mainWindow;
}

function setLastFocusedWin(win) {
  lastFocusedWin = win;
}

function getLastFocusedWin() {
  return lastFocusedWin || mainWindow;
}

function allWindows() {
  const list = [];
  if (mainWindow && !mainWindow.isDestroyed()) list.push(mainWindow);
  for (const win of sceneWindows.values()) {
    if (win && !win.isDestroyed() && !list.includes(win)) list.push(win);
  }
  return list;
}

function windowOfEvent(event) {
  if (!event || !event.sender) return mainWindow;
  const wc = event.sender;
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id === wc.id) return mainWindow;
  for (const win of sceneWindows.values()) {
    if (win && !win.isDestroyed() && win.webContents.id === wc.id) return win;
  }
  try {
    const fromWc = BrowserWindow.fromWebContents(wc);
    if (fromWc) return fromWc;
  } catch (e) {}
  return mainWindow;
}

function broadcast(channel, ...args) {
  for (const w of allWindows()) {
    try {
      if (w && !w.isDestroyed() && w.webContents) {
        w.webContents.send(channel, ...args);
      }
    } catch (e) {}
  }
}

function registerSceneWindow(sceneId, win) {
  sceneWindows.set(sceneId, win);
  detachedScenes.add(sceneId);
}

function unregisterSceneWindow(sceneId) {
  sceneWindows.delete(sceneId);
  detachedScenes.delete(sceneId);
}

function getSceneWindow(sceneId) {
  return sceneWindows.get(sceneId);
}

function getDetachedScenes() {
  return Array.from(detachedScenes);
}

module.exports = {
  loadWindowsState,
  saveWindowsState,
  fitSavedBounds,
  setMainWindow,
  getMainWindow,
  setLastFocusedWin,
  getLastFocusedWin,
  allWindows,
  windowOfEvent,
  broadcast,
  registerSceneWindow,
  unregisterSceneWindow,
  getSceneWindow,
  getDetachedScenes,
};
