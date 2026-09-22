'use strict';

const path = require('node:path');
const fs = require('node:fs');
const {
  app, ipcMain, BrowserWindow, shell, protocol, Menu, screen,
} = require('electron');

const { Config, resolveDataDir } = require('./config');
const { PetWindow } = require('./pet-window');
const { PetTray, createMenuTemplate } = require('./tray');
const secrets = require('./secrets');
const ai = require('./ai');
const selftest = require('./selftest');

const ROOT = path.join(__dirname, '..', '..');
const ATLAS_PATH = path.join(ROOT, 'assets', 'citlali', 'spritesheet.webp');
const TRAY_ICON_PATH = path.join(ROOT, 'assets', 'citlali', 'tray.png');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');

/** How often the global cursor position is sampled while gaze-follow is on. */
const CURSOR_POLL_MS = 100;

/**
 * The renderer is served from a custom `deskpet://` origin rather than
 * `file://`. Two reasons this is not optional:
 *   1. Chromium refuses to load ES modules over file:// (opaque origin / CORS),
 *      and the renderer is written as modules.
 *   2. A real origin keeps the atlas same-origin, so canvas operations such as
 *      the tray-icon snapshot are not blocked by tainting.
 */
const APP_SCHEME = 'deskpet';
const APP_ORIGIN = `${APP_SCHEME}://app`;
const ENTRY_URL = `${APP_ORIGIN}/src/renderer/index.html`;

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

// Keep every write inside a directory we control (and inside the sandbox when
// DESKPET_DATA_DIR points at the workspace).
app.setPath('userData', resolveDataDir(app.getPath('userData')));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  bootstrap();
}

function bootstrap() {
  /** @type {Config} */
  let config;
  /** @type {PetWindow} */
  let pet;
  /** @type {PetTray} */
  let tray;
  /** @type {BrowserWindow|null} */
  let settingsWindow = null;
  /** @type {BrowserWindow|null} */
  let historyWindow = null;

  let currentAbort = null;
  let chatterTimer = null;
  let balanceTimer = null;
  let cursorTimer = null;
  let lastUserActivity = Date.now();
  /** Stamped by every real reply, so chatter never lands mid-conversation. */
  let lastChatAt = 0;
  let quitting = false;
  /** Renderer console warnings/errors, surfaced for diagnostics. */
  const rendererIssues = [];

  /* ------------------------------------------------------------------ */
  /* Settings plumbing                                                   */
  /* ------------------------------------------------------------------ */

  /** Everything the renderer is allowed to know — never the raw key. */
  function publicSettings() {
    const { apiKey, apiKeyCipher, ...rest } = config.get();
    void apiKey;
    void apiKeyCipher;
    return {
      ...rest,
      hasApiKey: secrets.hasApiKey(config.get()),
      keyEncrypted: secrets.canEncrypt(),
      // Owned by the window, but the renderer needs it to size the bubble.
      bubbleZone: pet ? pet.bubbleZone : 172,
    };
  }

  function broadcastSettings() {
    const payload = publicSettings();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('settings:changed', payload);
    }
  }

  /** Single funnel for settings changes, whoever triggered them. */
  function applyPatch(incoming) {
    config.update(incoming);
    applySideEffects(incoming);
    broadcastSettings();
    return publicSettings();
  }

  /** Push a settings change into the live app. */
  function applySideEffects(patch) {
    if ('alwaysOnTop' in patch) pet.setAlwaysOnTop(config.get().alwaysOnTop);
    if ('clickThrough' in patch) pet.setClickThrough(false);
    if ('autoLaunch' in patch) applyAutoLaunch(config.get().autoLaunch);
    if ('sizePx' in patch || 'workMode' in patch) pet.applySize(config.get().sizePx);
    scheduleChatter();
    scheduleBalanceCheck();
    startCursorTracking();
    if (tray) tray.rebuild();
  }

  function applyAutoLaunch(enabled) {
    try {
      app.setLoginItemSettings({
        openAtLogin: Boolean(enabled),
        path: process.execPath,
        args: app.isPackaged ? [] : [ROOT],
      });
    } catch (err) {
      console.error('[autolaunch] failed:', err.message);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Chat pipeline                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Slash commands typed into the chat, so the mode can be switched without
   * leaving the conversation. Returns the new workMode, or null if this is not
   * a command.
   */
  function handleModeCommand(text) {
    const command = text.trim().toLowerCase();
    const on = ['/work', '/work on', '/工作', '/认真'];
    const off = ['/pet', '/work off', '/pet on', '/闲聊', '/放松'];
    if (on.includes(command)) return true;
    if (off.includes(command)) return false;
    return null;
  }

  const MODE_LINES = {
    on: '行，进入工作模式。有正经事就说吧，奶奶我认真听着。',
    off: '好，那就随便聊聊。……别指望我讲得太正经。',
  };

  function send(channel, payload) {
    if (pet && pet.win && !pet.win.isDestroyed()) {
      pet.win.webContents.send(channel, payload);
    }
  }

  async function runChat({ text, chatter = false } = {}) {
    if (currentAbort) currentAbort.abort();
    const controller = new AbortController();
    currentAbort = controller;

    const settings = { ...config.get(), apiKey: secrets.readApiKey(config.get()) };
    const history = config.getHistory();
    const messages = chatter
      ? ai.buildChatterMessages({ settings, history, context: chatterContext() })
      : ai.buildMessages({ settings, history, userText: text });

    send('chat:start', { chatter });

    let streamedVisible = '';
    try {
      const result = await ai.streamChat({
        messages,
        settings,
        signal: controller.signal,
        onDelta: (delta) => {
          streamedVisible += delta;
          send('chat:delta', { text: delta, full: streamedVisible });
        },
      });

      if (!chatter) lastChatAt = Date.now();
      const mood = result.mood || (chatter ? 'neutral' : null);
      if (!chatter) {
        config.setHistory([...history, { role: 'user', content: text }, { role: 'assistant', content: result.text }]);
      } else if (result.text) {
        config.setHistory([...history, { role: 'assistant', content: result.text }]);
      }

      send('chat:done', { ok: true, text: result.text, mood, chatter, usage: result.usage });
      return { ok: true, text: result.text, mood };
    } catch (err) {
      if (err.name === 'AbortError') {
        send('chat:done', { ok: false, aborted: true, text: streamedVisible, error: null });
        return { ok: false, aborted: true };
      }
      const message = err instanceof ai.AiError ? err.message : `出了点问题：${err.message}`;
      send('chat:done', { ok: false, text: '', error: message, chatter });
      return { ok: false, error: message };
    } finally {
      if (currentAbort === controller) currentAbort = null;
    }
  }

  function chatterContext() {
    const minutes = Math.round((Date.now() - lastUserActivity) / 60000);
    const hour = new Date().getHours();
    const part = hour < 5 ? '凌晨' : hour < 11 ? '早上' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 23 ? '晚上' : '深夜';
    return `现在是${part}（${hour}点）。用户已经 ${minutes} 分钟没有和你互动了。`;
  }

  /** Schedule the next unprompted line, if the user wants those at all. */
  /**
   * Schedule her next unprompted line.
   *
   * Two things matter beyond the interval itself:
   *
   * - **Jitter.** A fixed timer makes her speak at metronome intervals, which
   *   reads as a machine. The real gap is drawn from a range around the setting.
   * - **Never during a conversation.** `lastChatAt` is stamped by every reply,
   *   and the renderer additionally refuses a chatter that arrives while an
   *   answer is on screen. Together those mean she cannot talk over the thing
   *   you are still reading.
   */
  function scheduleChatter() {
    if (chatterTimer) {
      clearTimeout(chatterTimer);
      chatterTimer = null;
    }
    const proactive = config.get().proactive || {};
    if (!proactive.enabled || !proactive.idleChatter) return;
    const minutes = Math.max(3, Number(proactive.chatterMinutes) || 25);
    const jitter = 0.7 + Math.random() * 0.6;
    const waitMs = Math.max(60_000, Math.round(minutes * jitter * 60_000));

    chatterTimer = setTimeout(async () => {
      const current = config.get().proactive || {};
      const idleFor = (Date.now() - lastUserActivity) / 60000;
      const sinceChat = Date.now() - lastChatAt;
      const quiet = idleFor >= minutes - 0.5 && sinceChat > minutes * 60_000 * 0.5;
      if (!currentAbort && current.enabled && current.idleChatter && quiet) {
        await runChat({ chatter: true });
      }
      scheduleChatter();
    }, waitMs);
  }

  /* ------------------------------------------------------------------ */
  /* Account balance                                                     */
  /* ------------------------------------------------------------------ */

  /** The balance snapshot the renderer and the settings window render. */
  function balancePayload() {
    const balance = config.get().balance || {};
    return {
      enabled: balance.enabled !== false,
      intervalMinutes: Number(balance.intervalMinutes) || 30,
      lowThreshold: Number(balance.lowThreshold) || 0,
      isAvailable: balance.lastAvailable,
      total: balance.lastTotal,
      currency: balance.lastCurrency || 'CNY',
      granted: balance.lastGranted,
      toppedUp: balance.lastToppedUp,
      checkedAt: balance.lastCheckedAt || 0,
      error: balance.lastError || null,
      hasKey: secrets.hasApiKey(config.get()),
    };
  }

  /** Broadcast the snapshot to every open window. */
  function broadcastBalance() {
    const payload = balancePayload();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('balance:update', payload);
    }
    return payload;
  }

  /**
   * Query the balance and store the result.
   *
   * Never throws: callers get `{ok:false, error}` so the settings window can
   * show the reason and the pet can stay quiet about it.
   */
  async function refreshBalance() {
    if (!secrets.hasApiKey(config.get())) {
      return { ok: false, error: '还没有配置 API Key。' };
    }
    const settings = { ...config.get(), apiKey: secrets.readApiKey(config.get()) };
    try {
      const result = await ai.fetchBalance({ settings });
      config.update({
        balance: {
          lastAvailable: result.isAvailable,
          lastTotal: result.total,
          lastCurrency: result.currency,
          lastGranted: result.granted,
          lastToppedUp: result.toppedUp,
          lastCheckedAt: Date.now(),
          lastError: null,
        },
      });
      broadcastBalance();
      maybeWarnLowBalance(result);
      return { ok: true, ...balancePayload() };
    } catch (err) {
      const message = (err && err.message) || '查询余额失败';
      // Remember the failure so the settings window can explain it, but do not
      // nag the user about it from the pet.
      config.update({ balance: { lastCheckedAt: Date.now(), lastError: message } });
      broadcastBalance();
      return { ok: false, error: message };
    }
  }

  /**
   * Tell the pet when the account is running dry.
   *
   * Deliberately a local, canned line rather than a model call: the whole point
   * is that there is almost no credit left to spend.
   */
  function maybeWarnLowBalance(result) {
    const balance = config.get().balance || {};
    const threshold = Number(balance.lowThreshold) || 0;
    if (result.total > threshold) return;

    const now = Date.now();
    const sameAmount = balance.warnedForAmount === result.total;
    const recentlyWarned = now - (Number(balance.warnedAt) || 0) < 12 * 60 * 60 * 1000;
    if (sameAmount && recentlyWarned) return;

    config.update({ balance: { warnedAt: now, warnedForAmount: result.total } });
    send('balance:low', {
      total: result.total,
      currency: result.currency,
      threshold,
      isAvailable: result.isAvailable,
    });
  }

  function scheduleBalanceCheck({ initialDelayMs = 0 } = {}) {
    if (balanceTimer) {
      clearTimeout(balanceTimer);
      balanceTimer = null;
    }
    const balance = config.get().balance || {};
    if (balance.enabled === false || !secrets.hasApiKey(config.get())) return;

    const minutes = Math.max(5, Number(balance.intervalMinutes) || 30);
    balanceTimer = setTimeout(async () => {
      await refreshBalance();
      scheduleBalanceCheck();
    }, initialDelayMs || minutes * 60 * 1000);
  }

  /* ------------------------------------------------------------------ */
  /* Cursor tracking                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Poll the true global cursor position and forward it to the pet.
   *
   * The renderer used to derive her gaze from `mousemove`, which is wrong: once
   * the pointer leaves the window no further move events arrive, so the last
   * known position sticks. If the cursor happened to exit through a side or top
   * edge, that stale position was still inside the "look at me" radius and she
   * would stare that way forever instead of going back to her book.
   *
   * `screen.getCursorScreenPoint()` is a cheap OS call and is independent of
   * which window is under the pointer, so "the mouse moved away" becomes a fact
   * rather than an inference.
   */
  function startCursorTracking() {
    stopCursorTracking();
    const proactive = config.get().proactive || {};
    if (proactive.enabled === false || proactive.gazeFollow === false) return;

    let last = null;
    cursorTimer = setInterval(() => {
      if (!pet || !pet.win || pet.win.isDestroyed() || !pet.win.isVisible()) return;
      let point;
      try {
        point = screen.getCursorScreenPoint();
      } catch {
        return; // no cursor information on this platform; the renderer falls back
      }
      if (last && last.x === point.x && last.y === point.y) return;
      last = point;
      pet.win.webContents.send('cursor:position', point);
    }, CURSOR_POLL_MS);
  }

  function stopCursorTracking() {
    if (cursorTimer) {
      clearInterval(cursorTimer);
      cursorTimer = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Windows                                                             */
  /* ------------------------------------------------------------------ */

  /** Resolve deskpet://app/<relative path> to a file inside the project root. */
  /**
   * Serve `deskpet://app/<relative path>` from the project directory.
   *
   * Reads through `fs` rather than handing a `file:` URL to `net.fetch`.
   * Inside a packaged build the app lives in `app.asar`, and while Electron's
   * `fs` understands asar archives, the file loader behind `net.fetch` does
   * not -- the request would 404, the atlas would never load, and the window
   * would come up blank.
   */
  async function handleAppProtocol(request) {
    try {
      const url = new URL(request.url);
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const target = path.resolve(ROOT, relative);
      // Never serve anything outside the project directory.
      if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
        return new Response('forbidden', { status: 403 });
      }
      const body = await fs.promises.readFile(target);
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': contentTypeFor(target),
          'Cache-Control': 'no-cache',
        },
      });
    } catch (err) {
      if (err && err.code === 'ENOENT') return new Response('not found', { status: 404 });
      return new Response(`bad request: ${err.message}`, { status: 400 });
    }
  }

  /**
   * The MIME type matters: the renderer is loaded as ES modules, and a wrong
   * Content-Type makes Chromium refuse to execute them.
   */
  function contentTypeFor(file) {
    switch (path.extname(file).toLowerCase()) {
      case '.html': return 'text/html; charset=utf-8';
      case '.js':
      case '.mjs': return 'text/javascript; charset=utf-8';
      case '.css': return 'text/css; charset=utf-8';
      case '.json': return 'application/json; charset=utf-8';
      case '.webp': return 'image/webp';
      case '.png': return 'image/png';
      case '.svg': return 'image/svg+xml';
      case '.ico': return 'image/x-icon';
      default: return 'application/octet-stream';
    }
  }

  /**
   * The tray icon is a small PNG cropped out of the atlas by `npm run slice`.
   * It cannot be produced with `nativeImage` directly, because Electron's
   * native image decoder does not understand WebP.
   */
  function loadTrayIcon() {
    try {
      if (!fs.existsSync(TRAY_ICON_PATH)) {
        console.warn('[tray] icon missing — run `npm run slice` to generate it');
        return null;
      }
      const image = require('electron').nativeImage.createFromPath(TRAY_ICON_PATH);
      return image.isEmpty() ? null : image;
    } catch (err) {
      console.error('[tray] could not load the icon:', err.message);
      return null;
    }
  }

  /**
   * Everything the tray menu and the pet's right-click menu need. Shared so the
   * two menus stay identical.
   */
  function petMenuDeps() {
    return {
      config,
      update: (patch) => applyPatch(patch),
      icon: loadTrayIcon(),
      isVisible: () => Boolean(pet.win && !pet.win.isDestroyed() && pet.win.isVisible()),
      onToggleVisible: () => {
        if (!pet.win || pet.win.isDestroyed()) return;
        if (pet.win.isVisible()) pet.win.hide();
        else pet.win.show();
      },
      onOpenChat: () => {
        if (!pet.win || pet.win.isDestroyed()) return;
        pet.win.show();
        pet.setClickThrough(false);
        pet.win.webContents.send('app:command', { type: 'open-chat' });
      },
      onOpenSettings: () => openSettings(),
      onOpenHistory: () => openHistory(),
      onClearHistory: () => config.clearHistory(),
      onCheckBalance: async () => {
        const result = await refreshBalance();
        if (!pet.win || pet.win.isDestroyed()) return;
        pet.win.show();
        pet.win.webContents.send('app:command', {
          type: 'show-balance',
          payload: result.ok ? result : { ...balancePayload(), error: result.error },
        });
      },
      onQuit: () => {
        quitting = true;
        app.quit();
      },
    };
  }

  function createPet() {
    pet = new PetWindow(config, { preload: PRELOAD });
    pet.onBoundsChanged = (info) => send('win:info-changed', info);
    pet.onWalkDone = (info) => {
      send('win:walk-done', info);
      pet.persistPosition();
    };
    pet.create();
    // Surface renderer-side errors in the terminal instead of burying them in
    // a devtools console nobody has open.
    if (pet.win) selftest.attachConsoleCapture(pet.win.webContents, rendererIssues);
  }

  function openSettings() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.show();
      settingsWindow.focus();
      return;
    }
    settingsWindow = createChildWindow({
      width: 470,
      height: 640,
      minWidth: 420,
      minHeight: 520,
      title: '茜特菈莉 · 设置',
      page: 'settings.html',
    });
    settingsWindow.on('closed', () => {
      settingsWindow = null;
    });
  }

  /**
   * Conversation log.
   *
   * A reply used to be unrecoverable once her ambient muttering replaced it,
   * so there has to be somewhere to go and read what she actually said.
   */
  function openHistory() {
    if (historyWindow && !historyWindow.isDestroyed()) {
      historyWindow.show();
      historyWindow.focus();
      return;
    }
    historyWindow = createChildWindow({
      width: 560,
      height: 680,
      minWidth: 420,
      minHeight: 420,
      title: '茜特菈莉 · 对话记录',
      page: 'history.html',
    });
    historyWindow.on('closed', () => {
      historyWindow = null;
    });
  }

  /** Shared setup for the auxiliary windows. */
  function createChildWindow({ width, height, minWidth, minHeight, title, page }) {
    const win = new BrowserWindow({
      width,
      height,
      minWidth,
      minHeight,
      title,
      backgroundColor: '#161a22',
      autoHideMenuBar: true,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    win.setMenuBarVisibility(false);
    win.loadURL(`${APP_ORIGIN}/src/renderer/${page}`);
    selftest.attachConsoleCapture(win.webContents, rendererIssues);
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    return win;
  }

  /* ------------------------------------------------------------------ */
  /* IPC                                                                 */
  /* ------------------------------------------------------------------ */

  function registerIpc() {
    ipcMain.handle('settings:get', () => publicSettings());

    ipcMain.handle('settings:save', (_e, patch) => {
      const incoming = { ...(patch || {}) };
      if (incoming.clearApiKey) {
        delete incoming.clearApiKey;
        Object.assign(incoming, secrets.writeApiKey(''));
      }
      if ('apiKey' in incoming) {
        const key = incoming.apiKey;
        delete incoming.apiKey;
        if (typeof key === 'string' && key.length > 0) {
          Object.assign(incoming, secrets.writeApiKey(key));
          lastUserActivity = Date.now();
        }
      }
      return applyPatch(incoming);
    });

    ipcMain.handle('chat:send', async (_e, text) => {
      const trimmed = String(text || '').trim();
      if (!trimmed) return { ok: false, error: '空的' };
      lastUserActivity = Date.now();

      // `/work` and friends switch modes without spending a request.
      const wanted = handleModeCommand(trimmed);
      if (wanted !== null) {
        if (wanted !== Boolean(config.get().workMode)) {
          applyPatch({ workMode: wanted });
        }
        const line = wanted ? MODE_LINES.on : MODE_LINES.off;
        const history = config.getHistory();
        config.setHistory([
          ...history,
          { role: 'user', content: trimmed },
          { role: 'assistant', content: line },
        ]);
        send('chat:start', { chatter: false });
        send('chat:delta', { text: line, full: line });
        send('chat:done', { ok: true, text: line, mood: wanted ? 'happy' : 'shy', command: true });
        return { ok: true, text: line, mood: wanted ? 'happy' : 'shy', command: true };
      }

      return runChat({ text: trimmed });
    });

    ipcMain.handle('chat:cancel', () => {
      if (currentAbort) currentAbort.abort();
      return true;
    });

    ipcMain.handle('chat:clear', () => {
      config.clearHistory();
      return true;
    });

    ipcMain.handle('chat:history', () => config.getHistory());

    ipcMain.handle('balance:get', () => balancePayload());
    ipcMain.handle('balance:refresh', () => refreshBalance());

    // Test-only hook: exercises the low-balance notification path without
    // needing a genuinely depleted account. Only wired while self-testing.
    if (process.env.DESKPET_SELFTEST || process.argv.includes('--selftest')) {
      ipcMain.handle('balance:simulate-low', (_e, total) => {
        maybeWarnLowBalance({ total: Number(total), currency: 'CNY', isAvailable: true });
        return balancePayload();
      });
    }

    /**
     * Round-trip check used by the settings window. Accepts an unsaved key so
     * the user can verify credentials before committing them.
     */
    ipcMain.handle('settings:test', async (_e, override) => {
      const stored = config.get();
      const apiKey = (override && override.apiKey) || secrets.readApiKey(stored);
      const settings = {
        ...stored,
        apiKey,
        baseUrl: (override && override.baseUrl) || stored.baseUrl,
        model: (override && override.model) || stored.model,
        maxTokens: 16,
        temperature: 0,
      };
      try {
        const result = await ai.streamChat({
          messages: [
            { role: 'system', content: '只回复两个字：收到' },
            { role: 'user', content: 'ping' },
          ],
          settings,
        });
        return {
          ok: true,
          message: `连接成功 · 模型 ${settings.model}`,
          sample: (result.text || '').trim().slice(0, 40),
        };
      } catch (err) {
        return { ok: false, message: (err && err.message) || '连接失败' };
      }
    });

    ipcMain.handle('win:info', () => pet.info());

    ipcMain.on('win:click-through', (_e, ignore) => pet.setClickThrough(Boolean(ignore)));
    ipcMain.on('win:set-position', (_e, { x, y }) => pet.setPosition(x, y));
    ipcMain.on('win:move-by', (_e, { dx, dy }) => pet.moveBy(dx, dy));
    ipcMain.on('win:walk', (_e, options) => pet.walk(options || {}));
    // `notify` matters: a cancelled walk has to tell the renderer, otherwise she
    // keeps playing the walking animation on the spot forever.
    ipcMain.on('win:stop-walk', () => pet.stopWalk({ notify: true }));

    ipcMain.on('app:open-settings', () => openSettings());
    ipcMain.on('app:open-history', () => openHistory());
    // Routed through applyPatch so the renderer's copy of the settings (and the
    // tray checkboxes) stay in step with the new size.
    ipcMain.on('app:resize', (_e, sizePx) => {
      const value = Number(sizePx);
      if (Number.isFinite(value)) applyPatch({ sizePx: Math.min(900, Math.max(96, Math.round(value))) });
    });
    ipcMain.on('app:quit', () => {
      quitting = true;
      app.quit();
    });

    // Right-clicking the pet opens the same menu as the tray icon, so the app
    // is usable even when the tray icon is buried in the overflow area.
    ipcMain.on('app:context-menu', () => {
      if (!pet.win || pet.win.isDestroyed()) return;
      Menu.buildFromTemplate(createMenuTemplate(petMenuDeps())).popup({ window: pet.win });
    });

    // Any user interaction resets the "she has been ignored" clock.
    ipcMain.on('app:activity', () => {
      lastUserActivity = Date.now();
    });
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  app.on('second-instance', () => {
    if (pet && pet.win && !pet.win.isDestroyed()) {
      pet.win.show();
      pet.win.focus();
    }
  });

  app.on('window-all-closed', () => {
    // A tray app keeps running with no visible windows.
    if (quitting) app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    if (chatterTimer) clearTimeout(chatterTimer);
    if (balanceTimer) clearTimeout(balanceTimer);
    stopCursorTracking();
    if (pet) pet.persistPosition();
    if (tray) tray.destroy();
  });

  app.whenReady().then(() => {
    protocol.handle(APP_SCHEME, handleAppProtocol);

    config = new Config(app.getPath('userData'));
    config.load();

    registerIpc();
    createPet();

    tray = new PetTray(petMenuDeps());
    tray.create();

    applyAutoLaunch(config.get().autoLaunch);
    scheduleChatter();
    // Give the app a moment to settle before the first balance call.
    scheduleBalanceCheck({ initialDelayMs: 6000 });
    startCursorTracking();

    // Say hello once the renderer has painted.
    if (pet.win) {
      pet.win.webContents.once('did-finish-load', () => {
        setTimeout(() => send('app:command', { type: 'greet' }), 900);
      });
    }

    if (process.env.DESKPET_SELFTEST || process.argv.includes('--selftest')) {
      selftest.run({
        app, pet, tray, config, rendererIssues, openSettings, openHistory,
      });
    }
  });
}
