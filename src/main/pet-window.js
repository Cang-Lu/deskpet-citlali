'use strict';

const { BrowserWindow, screen } = require('electron');

const CELL = { width: 192, height: 208 };
/** Vertical room reserved above the sprite for the speech bubble + composer. */
const BUBBLE_ZONE = 172;
/**
 * Work mode gives her a taller bubble.
 *
 * Long, useful answers need somewhere to go; a 172px strip with a scrollbar
 * makes them painful to read.
 */
const WORK_BUBBLE_ZONE = 320;

const WALK_TICK_MS = 16;
/** A walk is a short stroll, never a screen-crossing trek. */
const MAX_WALK_MS = 8000;

class PetWindow {
  /**
   * @param {import('./config').Config} config
   * @param {{preload:string}} paths
   */
  constructor(config, paths) {
    this.config = config;
    this.paths = paths;
    this.win = null;
    this.walkTimer = null;
    this.maxWalkTimer = null;
    this.persistTimer = null;
    this.lastBoundsEmit = 0;
    this.boundsListener = null;
    this.onBoundsChanged = null;
    this.onWalkDone = null;
  }

  get sizePx() {
    const raw = Number(this.config.get().sizePx);
    return Number.isFinite(raw) ? Math.min(900, Math.max(96, raw)) : 416;
  }

  /** Taller when she is expected to give real answers. */
  get bubbleZone() {
    return this.config.get().workMode ? WORK_BUBBLE_ZONE : BUBBLE_ZONE;
  }

  /**
   * Window size for the requested sprite height.
   *
   * The renderer snaps the sprite to whole device pixels and reports the size
   * it actually drew, so this only has to guarantee that a crisp size fits.
   * The extra margin covers the rounding-down at fractional scale factors.
   */
  get size() {
    const target = this.sizePx;
    const spriteWidth = Math.round(CELL.width * (target / CELL.height)) + 36;
    return {
      width: Math.round(Math.max(300, spriteWidth)),
      height: Math.round(target + this.bubbleZone),
    };
  }

  create() {
    const { width, height } = this.size;
    const pos = this.restorePosition(width, height);

    this.win = new BrowserWindow({
      width,
      height,
      x: pos.x,
      y: pos.y,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      title: '茜特菈莉',
      webPreferences: {
        preload: this.paths.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });

    this.win.setAlwaysOnTop(Boolean(this.config.get().alwaysOnTop), 'floating');
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    this.win.setMenuBarVisibility(false);

    this.win.loadURL('deskpet://app/src/renderer/index.html');

    this.win.once('ready-to-show', () => this.win.show());
    // Never let the pet be navigated away from its own UI.
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.on('closed', () => {
      this.stopWalk();
      this.win = null;
    });

    this.boundsListener = () => this.emitBounds();
    this.win.on('move', this.boundsListener);
    this.win.on('moved', () => this.persistPosition());

    return this.win;
  }

  /** Default home: bottom-right of the primary work area, above the taskbar. */
  restorePosition(width, height) {
    const saved = this.config.get().position;
    const displays = screen.getAllDisplays();
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      const visible = displays.some((d) => {
        const a = d.workArea;
        return saved.x < a.x + a.width - 40 && saved.x + width > a.x + 40
          && saved.y < a.y + a.height - 40 && saved.y + height > a.y + 40;
      });
      if (visible) return { x: Math.round(saved.x), y: Math.round(saved.y) };
    }
    const area = screen.getPrimaryDisplay().workArea;
    return {
      x: Math.round(area.x + area.width - width - 24),
      y: Math.round(area.y + area.height - height - 8),
    };
  }

  /**
   * Persist the window position.
   *
   * Debounced: during a walk or a drag this would otherwise rewrite the config
   * file synchronously on every frame.
   */
  persistPosition() {
    if (!this.win || this.win.isDestroyed()) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (!this.win || this.win.isDestroyed()) return;
      const [x, y] = this.win.getPosition();
      this.config.update({ position: { x, y } });
    }, 500);
  }

  /** Throttled: the renderer only needs a coarse idea of where the window is. */
  emitBounds() {
    const now = Date.now();
    if (now - (this.lastBoundsEmit || 0) < 90) return;
    this.lastBoundsEmit = now;
    if (this.onBoundsChanged) this.onBoundsChanged(this.info());
  }

  info() {
    if (!this.win || this.win.isDestroyed()) return null;
    const bounds = this.win.getBounds();
    const display = screen.getDisplayNearestPoint({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
    return {
      ...bounds,
      workArea: display.workArea,
      displayId: display.id,
      sizePx: this.sizePx,
      displayScaleFactor: display.scaleFactor,
      cell: CELL,
      bubbleZone: this.bubbleZone,
    };
  }

  setClickThrough(ignore) {
    if (!this.win || this.win.isDestroyed()) return;
    if (!this.config.get().clickThrough) {
      this.win.setIgnoreMouseEvents(false);
      return;
    }
    // `forward` keeps mousemove flowing to the renderer so it can detect when
    // the pointer re-enters the pet's hit box.
    this.win.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
  }

  setPosition(x, y) {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.setPosition(Math.round(x), Math.round(y));
  }

  moveBy(dx, dy) {
    if (!this.win || this.win.isDestroyed()) return;
    const [x, y] = this.win.getPosition();
    this.win.setPosition(Math.round(x + dx), Math.round(y + dy));
  }

  setAlwaysOnTop(flag) {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.setAlwaysOnTop(Boolean(flag), 'floating');
  }

  /** Re-create the window at a new sprite size, keeping its bottom edge. */
  applySize(sizePx) {
    if (!this.win || this.win.isDestroyed()) return;
    this.config.update({ sizePx });
    const [x, y] = this.win.getPosition();
    const previousHeight = this.win.getBounds().height;
    const { width, height } = this.size;
    this.stopWalk({ notify: true });
    this.win.setBounds({ x, y: Math.round(y + (previousHeight - height)), width, height });
    this.emitBounds();
  }
  /**
   * Glide the pet horizontally.
   *
   * @param {{direction:-1|1, speed?:number, targetX?:number, maxDurationMs?:number}} options
   */
  walk({ direction, speed = 90, targetX, maxDurationMs = MAX_WALK_MS } = {}) {
    if (!this.win || this.win.isDestroyed()) return;
    this.stopWalk();

    const dir = direction < 0 ? -1 : 1;
    const stepPerTick = (speed * WALK_TICK_MS) / 1000;

    const finish = (reason) => {
      const [x] = this.win && !this.win.isDestroyed() ? this.win.getPosition() : [0, 0];
      this.stopWalk();
      if (this.onWalkDone) this.onWalkDone({ x: Math.round(x), reason });
    };

    // Safety net: a walk must always end, however the geometry works out.
    this.maxWalkTimer = setTimeout(() => finish('timeout'), maxDurationMs);

    this.walkTimer = setInterval(() => {
      if (!this.win || this.win.isDestroyed()) return this.stopWalk();

      const [x, y] = this.win.getPosition();
      const { width } = this.win.getBounds();
      const area = screen.getDisplayNearestPoint({ x: x + width / 2, y }).workArea;
      const minX = area.x;
      const maxX = area.x + area.width - width;

      let next = x + dir * stepPerTick;
      let finished = false;

      if (typeof targetX === 'number' && Number.isFinite(targetX)) {
        if ((dir > 0 && next >= targetX) || (dir < 0 && next <= targetX)) {
          next = Math.min(maxX, Math.max(minX, targetX));
          finished = true;
        }
      }
      if (next <= minX) {
        next = minX;
        finished = true;
      }
      if (next >= maxX) {
        next = maxX;
        finished = true;
      }

      this.win.setPosition(Math.round(next), y);
      if (finished) finish('arrived');
    }, WALK_TICK_MS);
  }

  stopWalk({ notify = false } = {}) {
    const wasWalking = Boolean(this.walkTimer);
    if (this.walkTimer) {
      clearInterval(this.walkTimer);
      this.walkTimer = null;
    }
    if (this.maxWalkTimer) {
      clearTimeout(this.maxWalkTimer);
      this.maxWalkTimer = null;
    }
    // Make sure the final position is reported and stored straight away.
    this.lastBoundsEmit = 0;
    this.emitBounds();
    this.persistPosition();

    // A walk that is cancelled rather than completed must still tell the
    // renderer, or she keeps playing the walking animation in place -- which
    // reads as her shaking/rocking forever.
    if (notify && wasWalking && this.onWalkDone) {
      const [x, y] = this.win && !this.win.isDestroyed() ? this.win.getPosition() : [0, 0];
      this.onWalkDone({ x, y, reason: 'cancelled' });
    }
  }

  /** Crop a sprite cell for use as the tray icon. */
  destroy() {
    this.stopWalk();
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { PetWindow, CELL, BUBBLE_ZONE };
