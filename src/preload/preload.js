'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Wrap an ipcRenderer.on subscription so callers get an unsubscribe handle. */
function subscribe(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('deskpet', {
  /* ---------------- settings ---------------- */
  getSettings: () => ipcRenderer.invoke('settings:get'),
  // The API key is write-only from the renderer's point of view.
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  testConnection: (override) => ipcRenderer.invoke('settings:test', override),
  onSettingsChanged: (cb) => subscribe('settings:changed', cb),

  /* ---------------- conversation ---------------- */
  sendMessage: (text) => ipcRenderer.invoke('chat:send', text),
  cancelMessage: () => ipcRenderer.invoke('chat:cancel'),
  clearHistory: () => ipcRenderer.invoke('chat:clear'),
  getHistory: () => ipcRenderer.invoke('chat:history'),
  onChatStart: (cb) => subscribe('chat:start', cb),
  onChatDelta: (cb) => subscribe('chat:delta', cb),
  onChatDone: (cb) => subscribe('chat:done', cb),
  onChatter: (cb) => subscribe('chat:chatter', cb),

  /* ---------------- account balance ---------------- */
  getBalance: () => ipcRenderer.invoke('balance:get'),
  refreshBalance: () => ipcRenderer.invoke('balance:refresh'),
  onBalanceUpdate: (cb) => subscribe('balance:update', cb),
  onBalanceLow: (cb) => subscribe('balance:low', cb),
  /* ---------------- window control ---------------- */
  setClickThrough: (ignore) => ipcRenderer.send('win:click-through', ignore),
  setWindowPosition: (x, y) => ipcRenderer.send('win:set-position', { x, y }),
  moveWindowBy: (dx, dy) => ipcRenderer.send('win:move-by', { dx, dy }),
  walk: (options) => ipcRenderer.send('win:walk', options),
  stopWalk: () => ipcRenderer.send('win:stop-walk'),
  getWindowInfo: () => ipcRenderer.invoke('win:info'),
  onWindowInfo: (cb) => subscribe('win:info-changed', cb),
  onWalkDone: (cb) => subscribe('win:walk-done', cb),
  // Global cursor position, polled by the main process. Unlike `mousemove`
  // this keeps arriving after the pointer leaves the window, which is what
  // lets her stop looking away once the cursor is gone.
  onCursorPosition: (cb) => subscribe('cursor:position', cb),
  onCommand: (cb) => subscribe('app:command', cb),

  /* ---------------- app ---------------- */
  openSettings: () => ipcRenderer.send('app:open-settings'),
  openHistory: () => ipcRenderer.send('app:open-history'),
  showContextMenu: () => ipcRenderer.send('app:context-menu'),
  resizePet: (sizePx) => ipcRenderer.send('app:resize', sizePx),
  // Tells the main process the user is around, which resets the idle clock
  // that drives proactive chatter.
  reportActivity: () => ipcRenderer.send('app:activity'),
  quit: () => ipcRenderer.send('app:quit'),

  /* ---------------- static ---------------- */
  // Served over the custom deskpet:// origin so it stays same-origin with the
  // page (file:// would break ES modules and taint the canvas).
  atlasUrl: 'deskpet://app/assets/citlali/spritesheet.webp',
  platform: process.platform,
  // Debug hook used by `--selftest`. The main process only registers the
  // handler while self-testing, so this rejects harmlessly in normal runs.
  simulateLowBalance: (total) => ipcRenderer.invoke('balance:simulate-low', total),
});
