/**
 * ipc-guard.js —— IPC 调用统一保护切面与错误熔断
 * 为所有 ipcMain.handle / on 增加统一的异常保护与日志记录，
 * 防止单一模块或脚本报错导致 Electron 事件循环受损。
 */
const { ipcMain } = require('electron');

function safeHandle(channel, handler, logger) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (err) {
      const msg = `[ipc:error] ${channel}: ` + (err && err.stack ? err.stack : (err && err.message) || err);
      if (typeof logger === 'function') logger(msg);
      else console.error(msg);
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });
}

function safeOn(channel, handler, logger) {
  ipcMain.on(channel, (event, ...args) => {
    try {
      handler(event, ...args);
    } catch (err) {
      const msg = `[ipc:error:on] ${channel}: ` + (err && err.stack ? err.stack : (err && err.message) || err);
      if (typeof logger === 'function') logger(msg);
      else console.error(msg);
    }
  });
}

module.exports = {
  safeHandle,
  safeOn,
};
