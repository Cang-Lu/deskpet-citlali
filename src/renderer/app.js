import {
  CELL,
  DEFAULT_SPRITE_HEIGHT,
  MAX_SPRITE_HEIGHT,
  MIN_SPRITE_HEIGHT,
  directionFromVector,
  fitSpriteSize,
  supersampleFactor,
} from '../shared/pet-spec.js';
import { Atlas, Animator, SpriteRenderer } from './sprite.js';
import { Effects } from './effects.js';
import {
  PetState, findAgitatedAmbientStates, maxHoldFor, validateStates,
} from './state.js';
import { Behavior, MUTTERS, POSES, PACING } from './behavior.js';
import { Ui } from './ui.js';

const api = window.deskpet;

const BUBBLE_ZONE = 172;
const GAZE_INTERVAL_MS = 110;
/**
 * She sits up and follows the cursor once it comes near her.
 *
 * The two radii are deliberate hysteresis: engaging at exactly the same
 * distance she releases at makes her flicker in and out of the gaze pose when
 * the cursor hovers on the boundary.
 */
const GAZE_ENGAGE_PX = 300;
const GAZE_RELEASE_PX = 380;
/**
 * If the platform never delivers polled cursor events, fall back to the
 * window's own pointer position after this long. On those platforms the old
 * "cursor left the window" staleness returns, so it is a last resort.
 */
const CURSOR_FALLBACK_MS = 3000;
const DRAG_THRESHOLD_PX = 4;
const CLICK_MAX_MS = 400;

const GREETINGS = [
  '嗯？又是你啊。……别误会，我只是刚好醒着。',
  '回来了？桌上这么乱，也不知道收拾收拾。',
  '奶奶我今天心情不错，就陪你待一会儿吧。',
  '……别盯着我看，我在看小说呢。',
];

/** Shown when the DeepSeek account is nearly out of credit. */
const LOW_BALANCE_LINES = [
  '喂，账上的钱快见底了。奶奶我可不打算饿着肚子陪你聊天。',
  '……余额不多了。趁我还能说话，去充点吧。',
  '再这样下去我就要断粮了。你忍心？',
];

/**
 * Regions inside the sprite, as fractions of the pet box, used to measure how
 * faithfully she renders.
 *
 * Means over a whole block rather than single pixels, and each region carries
 * its own tolerance: flat areas like the cushion survive a sub-pixel sampling
 * offset unchanged, while a high-detail area like the hair legitimately drifts
 * a few levels when the block lands half a pixel differently against the atlas.
 */
const SPRITE_REGIONS = [
  { name: 'cushion-left', x0: 0.22, y0: 0.82, x1: 0.36, y1: 0.88, tolerance: 3 },
  { name: 'cushion-centre', x0: 0.40, y0: 0.80, x1: 0.60, y1: 0.88, tolerance: 3 },
  { name: 'cushion-right', x0: 0.64, y0: 0.82, x1: 0.78, y1: 0.88, tolerance: 3 },
  { name: 'hair-left', x0: 0.28, y0: 0.42, x1: 0.40, y1: 0.50, tolerance: 8 },
];

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

let settings = null;
let atlas = null;
let animator = null;
let spriteRenderer = null;
let effects = null;
let state = null;
let behavior = null;
let ui = null;

const canvas = document.getElementById('pet');
const ctx = canvas.getContext('2d');

/** Offscreen helper used only by the debug readback, kept off the GPU path. */
const probeCanvas = document.createElement('canvas');
const probeCtx = probeCanvas.getContext('2d', { willReadFrequently: true });

/** Same idea, but reading the atlas itself rather than the rendered frame. */
const atlasProbe = document.createElement('canvas');
const atlasProbeCtx = atlasProbe.getContext('2d', { willReadFrequently: true });

/** Sprite rectangle in CSS pixels, recomputed on resize. */
let petBox = { x: 0, y: 0, width: 0, height: 0 };
let viewport = { width: 0, height: 0, dpr: 1 };

let lastFrame = performance.now();
let bootedAt = performance.now();
let lastGazeAt = 0;
let gazeIndex = null;
let gazeEngaged = false;
/** Global cursor position polled by the main process; authoritative for gaze. */
let cursorScreen = null;
let cursorOverride = null;
let cursorEventCount = 0;
/** Last pointer position the window itself saw. Only a fallback. */
let mouseScreen = { x: -9999, y: -9999 };
let windowInfo = null;
/** The last line she was *asked* for; ambient muttering never overwrites it. */
let lastReplyText = '';
let lastBubbleText = '';

let dragging = null;
let captureState = null;

async function boot() {
  settings = await api.getSettings();

  ui = new Ui({ onSend: handleSend });
  ui.onHidden = () => behavior && behavior.setAttentionHold(0);
  installUiEvents();
  applyModeChrome();

  try {
    atlas = await Atlas.load(api.atlasUrl, { defringe: settings.defringe !== false });
    if (atlas.defringed && atlas.stats) {
      console.info(`[atlas] de-fringed ${atlas.stats.bledPixels} edge pixels`);
    }
  } catch (err) {
    ui.showToast(`精灵图加载失败：${err.message}`, 20000);
    return;
  }

  animator = new Animator(atlas);
  spriteRenderer = new SpriteRenderer(atlas);
  effects = new Effects();
  effects.tintEnabled = settings.moodTint !== false;
  state = new PetState(animator, effects);
  behavior = new Behavior({
    api,
    state,
    getSettings: () => settings,
    onMutter: (text) => sayLine(text, { mood: 'neutral', status: '' }),
    // Twitchy poses must not be held; the state table owns the limit.
    maxHoldFor,
  });

  // A state pointing at a missing clip kills the very first frame, so fail
  // loudly here rather than letting the window stay blank.
  const stateProblems = validateStates();
  if (stateProblems.length) {
    console.error('[state] invalid definitions:', stateProblems);
    ui.showToast(`状态配置有误：${stateProblems.join('；')}`, 30000);
  }

  // A resting state bound to an agitated animation is the bug behind "she keeps
  // shaking her head", so surface it loudly rather than letting it ship again.
  const agitated = findAgitatedAmbientStates();
  if (agitated.length) {
    console.warn('[state] ambient states using high-motion rows:', agitated);
  }

  windowInfo = await api.getWindowInfo();
  resize();

  installIpc();
  installPointer();
  window.addEventListener('resize', resize);

  if (!settings.hasApiKey) {
    ui.showToast('还没有配置 DeepSeek API Key：右键托盘图标 → 设置。', 12000);
  }

  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ */
/* Canvas / layout                                                     */
/* ------------------------------------------------------------------ */

function resize() {
  const dpr = window.devicePixelRatio || 1;
  viewport = { width: window.innerWidth, height: window.innerHeight, dpr };

  canvas.width = Math.max(1, Math.round(viewport.width * dpr));
  canvas.height = Math.max(1, Math.round(viewport.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const target = Number(settings.sizePx) || DEFAULT_SPRITE_HEIGHT;
  const { width, height } = fitSpriteSize({
    targetHeight: target,
    maxWidth: viewport.width - 4,
    maxHeight: viewport.height - 4,
  });

  // Any size is allowed; `SpriteRenderer` decides how to rasterise it.
  petBox = {
    x: (viewport.width - width) / 2,
    y: viewport.height - height,
    width,
    height,
    supersample: settings.renderMode === 'nearest'
      ? null
      : supersampleFactor({ targetHeight: height, dpr }),
  };

  const root = document.documentElement.style;
  root.setProperty('--pet-w', `${petBox.width}px`);
  root.setProperty('--pet-h', `${petBox.height}px`);
  // Work mode gives her a taller bubble; the main process owns the number.
  root.setProperty('--bubble-zone', `${Number(settings.bubbleZone) || BUBBLE_ZONE}px`);
}

/**
 * Paint one cell.
 *
 * `nearest` deliberately bypasses the supersample buffer for a hard-edged,
 * unapologetically pixel-art look; every other mode goes through
 * SpriteRenderer so any size stays clean.
 */
function paintCell(context, cell, alpha = 1) {
  if (settings.renderMode === 'nearest') {
    context.save();
    context.globalAlpha = alpha;
    context.imageSmoothingEnabled = false;
    atlas.draw(context, cell.row, cell.col, petBox.x, petBox.y, petBox.width, petBox.height);
    context.restore();
    return;
  }
  spriteRenderer.drawCell(context, cell, petBox, viewport.dpr, alpha);
}

/* ------------------------------------------------------------------ */
/* Render loop                                                         */
/* ------------------------------------------------------------------ */

function frame(now) {
  const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;

  behavior.tick(now);
  state.update(dt, now);
  animator.update(dt);
  updateGaze(now);

  effects.update(dt, petBox);

  ctx.clearRect(0, 0, viewport.width, viewport.height);

  // Cross-fade the outgoing cell: the atlas mixes two body postures
  // (lying down reading vs. sitting upright), so clips must not hard-cut.
  const alpha = animator.fadeAlpha;
  if (alpha > 0 && animator.fade) {
    paintCell(ctx, { row: animator.fade.row, col: animator.fade.col }, alpha);
  }

  paintCell(ctx, animator.cell);

  // Effects come last: the mood aura is clipped to the sprite silhouette via
  // `source-atop`, so it has to be composited on top of her.
  effects.draw(ctx, petBox);

  requestAnimationFrame(frame);
}

/**
 * Rows 9-10 hold 16 gaze directions.
 *
 * Uses the globally polled cursor rather than `mousemove`. Deriving the gaze
 * from pointer events meant the last position froze the moment the cursor left
 * the window, so exiting through a side or top edge -- still inside the engage
 * radius -- left her staring that way indefinitely.
 */
function updateGaze(now) {
  const follow = settings && settings.proactive && settings.proactive.gazeFollow;
  const eligible = follow
    && state.isFree
    && (state.base === 'idle' || state.base === 'sleepy' || state.base === 'reading');

  const release = () => {
    if (gazeIndex === null && !gazeEngaged) return;
    gazeIndex = null;
    gazeEngaged = false;
    animator.setLook(null);
  };

  if (!eligible) {
    release();
    return;
  }

  if (now - lastGazeAt < GAZE_INTERVAL_MS) return;
  lastGazeAt = now;

  const cursor = cursorOverride
    || cursorScreen
    || (now - bootedAt > CURSOR_FALLBACK_MS ? mouseScreen : null) || null;
  if (!windowInfo || !cursor) {
    release();
    return;
  }

  const headX = windowInfo.x + petBox.x + petBox.width / 2;
  const headY = windowInfo.y + petBox.y + petBox.height * 0.38;

  const dx = cursor.x - headX;
  const dy = cursor.y - headY;
  const distance = Math.hypot(dx, dy);

  const limit = gazeEngaged ? GAZE_RELEASE_PX : GAZE_ENGAGE_PX;
  let next = null;
  if (distance <= limit && distance > 6) {
    next = directionFromVector(dx, dy);
    gazeEngaged = true;
  } else {
    gazeEngaged = false;
  }

  if (next !== gazeIndex) {
    gazeIndex = next;
    animator.setLook(next);
  }
}

/* ------------------------------------------------------------------ */
/* Pointer: hit testing, click-through, dragging                       */
/* ------------------------------------------------------------------ */

/** Slightly inset so the transparent padding around her stays click-through. */
function petHitRect() {
  const insetX = petBox.width * 0.14;
  const insetY = petBox.height * 0.07;
  return {
    left: petBox.x + insetX,
    top: petBox.y + insetY,
    right: petBox.x + petBox.width - insetX,
    bottom: petBox.y + petBox.height,
  };
}

function pointIn(rect, x, y) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function shouldCapture(clientX, clientY) {
  if (pointIn(petHitRect(), clientX, clientY)) return true;
  for (const rect of ui.hitRects()) {
    if (pointIn(rect, clientX, clientY)) return true;
  }
  // Keep capturing for the whole drag so the pet never slips out from under
  // the cursor mid-gesture.
  if (dragging) return true;
  return false;
}

function setCapture(next) {
  if (captureState === next) return;
  captureState = next;
  api.setClickThrough(!next);
}

function installPointer() {
  window.addEventListener('mousemove', (event) => {
    mouseScreen = { x: event.screenX, y: event.screenY };
    setCapture(shouldCapture(event.clientX, event.clientY));

    if (dragging) {
      const dx = event.screenX - dragging.startScreenX;
      const dy = event.screenY - dragging.startScreenY;
      dragging.moved = Math.max(dragging.moved, Math.hypot(dx, dy));
      api.setWindowPosition(dragging.startWindowX + dx, dragging.startWindowY + dy);
    }
  }, { passive: true });

  window.addEventListener('mousedown', async (event) => {
    if (event.button !== 0) return;
    if (!pointIn(petHitRect(), event.clientX, event.clientY)) return;
    if (!windowInfo) windowInfo = await api.getWindowInfo();
    behavior.notifyActivity();
    api.reportActivity();
    dragging = {
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      startWindowX: windowInfo ? windowInfo.x : 0,
      startWindowY: windowInfo ? windowInfo.y : 0,
      startedAt: performance.now(),
      moved: 0,
      pending: true,
    };
    setCapture(true);
    event.preventDefault();
  });

  window.addEventListener('mouseup', (event) => {
    if (event.button !== 0 || !dragging) return;
    const elapsed = performance.now() - dragging.startedAt;
    const wasClick = dragging.moved < DRAG_THRESHOLD_PX && elapsed < CLICK_MAX_MS;
    dragging = null;

    if (wasClick) {
      handlePetClick();
    } else {
      state.setOverlay('surprised', { duration: 1400, force: true });
    }
    setCapture(shouldCapture(event.clientX, event.clientY));
  });

  window.addEventListener('mouseleave', () => {
    mouseScreen = { x: -9999, y: -9999 };
    setCapture(false);
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (ui.composerOpen) ui.closeComposer();
      else ui.hideBubble();
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !ui.composerOpen) {
      ui.openComposer();
    }
  });

  window.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    api.showContextMenu();
  });

  // Ctrl + wheel resizes her in place, one pixel at a time so the size is
  // genuinely free rather than a handful of presets.
  window.addEventListener('wheel', (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const step = event.deltaY < 0 ? 16 : -16;
    const current = Number(settings.sizePx) || DEFAULT_SPRITE_HEIGHT;
    const next = Math.min(MAX_SPRITE_HEIGHT, Math.max(MIN_SPRITE_HEIGHT, current + step));
    if (next !== current) api.resizePet(next);
  }, { passive: false });
}

/** Reflect the active mode in the UI, so it is never a mystery. */
function applyModeChrome() {
  const work = Boolean(settings && settings.workMode);
  document.body.dataset.mode = work ? 'work' : 'pet';
  const input = document.getElementById('input');
  if (input) {
    input.placeholder = work ? '工作模式：说正事吧…（/pet 退出）' : '和茜特菈莉说点什么…（/work 进工作模式）';
  }
}

/**
 * Show one of her own ambient lines.
 *
 * Refuses to run over an answer the user asked for: a random "……腿都坐麻了。"
 * used to replace a long reply before it could be read, and because it also
 * overwrote the remembered text there was no way to get the answer back.
 *
 * @returns {boolean} whether the line was actually shown
 */
function sayLine(text, { mood = 'neutral', status = '', pin = false } = {}) {
  if (ui.showingReply) return false;
  lastBubbleText = text;
  ui.showBubble(text, { mood, status, pin, kind: 'ambient' });
  ui.scheduleHide();
  return true;
}

/** Show an answer she was asked for, and hold her still while it is read. */
function sayReply(text, { mood = 'neutral', status = '', pin = false } = {}) {
  lastReplyText = text;
  lastBubbleText = text;
  ui.showBubble(text, { mood, status, pin, kind: 'reply' });
}

/**
 * Let the behaviour engine know how long to stay put.
 *
 * Capped well below the bubble's own timeout: an answer may stay up for a
 * minute, but she should not be frozen that long.
 */
const MAX_ATTENTION_HOLD_MS = 25_000;

function holdAttentionFor(text, overrideMs = 0) {
  const delay = overrideMs || Ui.replyHideDelay(text);
  behavior.setAttentionHold(Math.min(delay, MAX_ATTENTION_HOLD_MS));
}

function handlePetClick() {
  behavior.notifyActivity();
  api.reportActivity();
  state.setOverlay('greet', { duration: 1800, force: true });

  // Without a key there is nothing to talk to yet, so send the user straight
  // to the place that fixes it rather than into a composer that will fail.
  if (settings && !settings.hasApiKey) {
    ui.showToast('先填一个 DeepSeek API Key，然后我们就能聊天了。', 7000);
    api.openSettings();
    return;
  }

  if (ui.composerOpen) {
    ui.closeComposer();
    restoreLastLine();
    return;
  }
  // Clicking her brings back whatever she last said, reply first.
  restoreLastLine();
  ui.openComposer();
}

/** Bring the last thing she said back into view. */
function restoreLastLine() {
  const text = lastReplyText || lastBubbleText;
  if (!text || ui.bubbleVisible) return;
  if (lastReplyText) sayReply(lastReplyText);
  else sayLine(text);
  ui.scheduleHide();
}

/* ------------------------------------------------------------------ */
/* Chat                                                                */
/* ------------------------------------------------------------------ */

function handleSend(text) {
  if (ui.busy) {
    api.cancelMessage();
    return;
  }
  behavior.notifyActivity();
  api.reportActivity();
  state.setOverlay('thinking', { force: true });
  ui.setBusy(true);
  ui.setBubbleMood('thinking');
  ui.showBubble('', { mood: 'thinking', status: '正在想…' });
  api.sendMessage(text).catch((err) => {
    ui.showToast(`发送失败：${err.message}`, 8000);
    ui.setBusy(false);
    state.clearOverlay();
  });
}

let streamBuffer = '';

function installIpc() {
  api.onChatStart(({ chatter }) => {
    streamBuffer = '';
    ui.setBusy(true);
    if (chatter) {
      state.setOverlay('thinking', { force: true });
      ui.setBubbleMood('thinking');
      ui.showBubble('', { mood: 'thinking', status: '她想说点什么…' });
    }
  });

  api.onChatDelta(({ text }) => {
    if (!text) return;
    streamBuffer += text;
    ui.appendBubbleText(text);
    ui.setBubbleStatus('');
  });

  api.onChatDone((payload) => {
    ui.setBusy(false);
    const { ok, aborted, error, mood, chatter, text } = payload || {};

    if (aborted) {
      if (streamBuffer) {
        lastBubbleText = streamBuffer;
        ui.setBubbleStatus('（被打断了）');
        ui.scheduleHide();
      } else {
        ui.hideBubble();
      }
      state.clearOverlay();
      return;
    }

    if (!ok) {
      ui.hideBubble();
      ui.showToast(error || '出错了。', 9000);
      state.setOverlay('sad', { duration: 2600, force: true });
      ui.setBubbleMood('error');
      return;
    }

    const finalText = text || streamBuffer;
    if (finalText && finalText !== streamBuffer) ui.setBubbleText(finalText);
    sayReply(finalText, { mood: mood || 'neutral' });
    ui.setBubbleStatus('');
    if (mood) ui.setBubbleMood(mood);
    state.applyMood(mood);
    // Long answers stay up long enough to read, and she stays put meanwhile.
    holdAttentionFor(finalText);
    ui.scheduleHide();
  });

  api.onSettingsChanged((next) => {
    const previous = settings;
    const hadKey = Boolean(previous && previous.hasApiKey);
    const layoutChanged = !previous
      || previous.sizePx !== next.sizePx
      || previous.renderMode !== next.renderMode
      || previous.workMode !== next.workMode;
    settings = next;
    if (layoutChanged) resize();
    if (effects) effects.tintEnabled = next.moodTint !== false;
    applyModeChrome();
    if (!hadKey && next.hasApiKey) {
      ui.clearToast();
      ui.showBubble('Key 收到啦。想聊什么？', { mood: 'happy' });
      state.setOverlay('happy', { duration: 2400, force: true });
      ui.scheduleHide(6000);
      // A brand new key is the right moment to find out what is on the account.
      api.refreshBalance().then((result) => {
        if (result && result.ok) ui.showToast(`余额 ${formatMoney(result.total, result.currency)}`, 6000);
      }).catch(() => {});
    }
  });

  api.onWindowInfo((info) => {
    windowInfo = info;
  });

  api.onCursorPosition((point) => {
    cursorScreen = point;
    cursorEventCount += 1;
  });

  api.onWalkDone(() => {
    behavior.handleWalkDone();
  });

  api.onCommand((command) => {
    if (!command) return;
    if (command.type === 'open-chat') {
      setCapture(true);
      ui.openComposer();
    } else if (command.type === 'greet') {
      const line = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
      sayLine(line);
      state.setOverlay('greet', { duration: 2200, force: true });
    } else if (command.type === 'show-balance') {
      showBalanceBubble(command.payload);
    }
  });

  api.onBalanceLow((info) => {
    // Canned line on purpose: when the balance is nearly gone, spending more
    // tokens to announce it would be self-defeating.
    const line = LOW_BALANCE_LINES[Math.floor(Math.random() * LOW_BALANCE_LINES.length)];
    lastBubbleText = line;
    ui.showBubble(line, {
      mood: 'sad',
      status: `余额只剩 ${formatMoney(info.total, info.currency)} · 去 platform.deepseek.com 充值`,
      pin: true,
    });
    state.setOverlay('sad', { duration: 4200, force: true });
  });
}

/** Show a balance snapshot in the bubble. */
function showBalanceBubble(payload) {
  if (!payload) return;
  if (payload.error) {
    ui.showToast(`查余额失败：${payload.error}`, 9000);
    return;
  }
  if (payload.total == null) {
    ui.showToast('还没有查到余额，先配置 API Key。', 8000);
    return;
  }
  const low = payload.total <= (Number(payload.lowThreshold) || 0);
  const line = low
    ? `余额只剩 ${formatMoney(payload.total, payload.currency)} 了，奶奶我可不想饿肚子。记得去充值。`
    : `账上还有 ${formatMoney(payload.total, payload.currency)}，够我再看一阵子小说。`;
  lastBubbleText = line;
  ui.showBubble(line, {
    mood: low ? 'sad' : 'happy',
    status: `查询于 ${formatTime(payload.checkedAt)}`,
    pin: low,
  });
  ui.scheduleHide();
  state.setOverlay(low ? 'sad' : 'happy', { duration: 3000, force: true });
}

function formatMoney(amount, currency) {
  if (amount == null || !Number.isFinite(Number(amount))) return '—';
  const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : `${currency || ''} `;
  return `${symbol}${Number(amount).toFixed(2)}`;
}

function formatTime(timestamp) {
  if (!timestamp) return '刚刚';
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Mean RGBA of a CSS-pixel box, read back at device resolution. */
function meanOf(context, box, dpr) {
  const x = Math.max(0, Math.round(box.x0 * dpr));
  const y = Math.max(0, Math.round(box.y0 * dpr));
  const w = Math.max(1, Math.round((box.x1 - box.x0) * dpr));
  const h = Math.max(1, Math.round((box.y1 - box.y0) * dpr));
  const { data } = context.getImageData(x, y, w, h);
  let r = 0; let g = 0; let b = 0; let a = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i]; g += data[i + 1]; b += data[i + 2]; a += data[i + 3];
  }
  return [r / n, g / n, b / n, a / n].map((v) => Math.round(v * 10) / 10);
}

function installUiEvents() {
  // Clicking the send button while busy cancels instead of sending.
  document.getElementById('send').addEventListener('click', (event) => {
    if (ui.busy) {
      event.preventDefault();
      api.cancelMessage();
    }
  });
}

/**
 * Debug / automation surface. `npm start -- --selftest` drives the pet through
 * every state through this object and screenshots the result, which is also
 * handy when poking at the renderer by hand.
 */
function exposeDebugSurface() {
  window.__deskpet = {
    get info() {
      const cell = animator.cell;
      return {
        clip: animator.clipName,
        frame: animator.frame,
        frames: animator.clip.frames,
        look: animator.look,
        cell: { row: cell.row, col: cell.col, index: cell.index, canonical: cell.canonical },
        base: state.base,
        overlay: state.overlay,
        effect: effects.kind,
        particles: effects.particles.length,
        mood: ui.bubble.dataset.mood,
        bubbleVisible: ui.bubbleVisible,
        bubblePinned: ui.pinned,
        composerOpen: ui.composerOpen,
        petBox,
        dpr: viewport.dpr,
        viewport: { width: viewport.width, height: viewport.height },
        atlas: {
          defringed: Boolean(atlas && atlas.defringed),
          stats: atlas ? atlas.stats : null,
        },
        settings: {
          sizePx: settings.sizePx,
          renderMode: settings.renderMode,
          defringe: settings.defringe,
        },
      };
    },
    setSize: (sizePx) => api.resizePet(sizePx),
    /**
     * Mean colour of each probe region as actually rendered, plus two strips
     * outside the sprite so background bleed can be detected in the same call.
     */
    measureRegions() {
      probeCanvas.width = canvas.width;
      probeCanvas.height = canvas.height;
      probeCtx.clearRect(0, 0, probeCanvas.width, probeCanvas.height);
      probeCtx.drawImage(canvas, 0, 0);

      const regions = SPRITE_REGIONS.map((r) => ({
        name: r.name,
        tolerance: r.tolerance,
        box: {
          x0: petBox.x + petBox.width * r.x0,
          y0: petBox.y + petBox.height * r.y0,
          x1: petBox.x + petBox.width * r.x1,
          y1: petBox.y + petBox.height * r.y1,
        },
      }));
      regions.push({
        name: 'outside-left',
        tolerance: 0,
        box: { x0: petBox.x - 18, y0: petBox.y + 40, x1: petBox.x - 4, y1: petBox.y + 120 },
      });

      return regions.map((r) => ({
        name: r.name,
        tolerance: r.tolerance,
        mean: meanOf(probeCtx, r.box, viewport.dpr),
      }));
    },
    /** The same regions read straight out of the atlas cell. */
    sampleAtlasRegions() {
      const cell = animator.cell;
      const w = atlas.cellW;
      const h = atlas.cellH;
      atlasProbe.width = w;
      atlasProbe.height = h;
      atlasProbeCtx.imageSmoothingEnabled = false;
      atlasProbeCtx.clearRect(0, 0, w, h);
      atlasProbeCtx.drawImage(atlas.image, cell.col * w, cell.row * h, w, h, 0, 0, w, h);

      return SPRITE_REGIONS.map((r) => ({
        name: r.name,
        tolerance: r.tolerance,
        mean: meanOf(atlasProbeCtx, {
          x0: r.x0 * w, y0: r.y0 * h, x1: r.x1 * w, y1: r.y1 * h,
        }, 1),
      }));
    },
    /** Sample just the outside strip, for the background-leak assertion. */
    measureBackgroundRegions() {
      probeCanvas.width = canvas.width;
      probeCanvas.height = canvas.height;
      probeCtx.clearRect(0, 0, probeCanvas.width, probeCanvas.height);
      probeCtx.drawImage(canvas, 0, 0);
      return [
        { name: 'above', box: { x0: 4, y0: 4, x1: viewport.width - 4, y1: Math.max(5, petBox.y - 10) } },
        { name: 'left', box: { x0: 2, y0: petBox.y, x1: Math.max(3, petBox.x - 6), y1: viewport.height - 2 } },
        { name: 'right', box: { x0: petBox.x + petBox.width + 6, y0: petBox.y, x1: viewport.width - 2, y1: viewport.height - 2 } },
      ].map((r) => ({ name: r.name, mean: meanOf(probeCtx, r.box, viewport.dpr) }));
    },
    /** Hold the current animation frame so pixel measurements are stable. */
    freeze: (frozen) => {
      if (frozen) {
        animator.speed = 0;
      } else {
        state.apply(true);
      }
      return animator.speed;
    },
    /**
     * Average colour of the window canvas outside the sprite.
     *
     * Read back through a dedicated `willReadFrequently` canvas rather than the
     * live one: repeated getImageData on the GPU-backed main canvas is both slow
     * and noisy (Chromium logs a warning about it).
     */
    measureBackground(samples) {
      const points = samples || [
        [4, 4],
        [viewport.width - 6, 6],
        [6, viewport.height / 2],
        [viewport.width - 6, viewport.height / 2],
        [6, petBox.y - 12],
        [viewport.width - 6, petBox.y + 40],
      ];
      probeCanvas.width = canvas.width;
      probeCanvas.height = canvas.height;
      probeCtx.clearRect(0, 0, probeCanvas.width, probeCanvas.height);
      probeCtx.drawImage(canvas, 0, 0);

      return points.map(([x, y]) => {
        const px = Math.max(0, Math.min(probeCanvas.width - 1, Math.round(x * viewport.dpr)));
        const py = Math.max(0, Math.min(probeCanvas.height - 1, Math.round(y * viewport.dpr)));
        const d = probeCtx.getImageData(px, py, 1, 1).data;
        return { x: Math.round(x), y: Math.round(y), rgba: [d[0], d[1], d[2], d[3]] };
      });
    },
    setBase: (name) => state.setBase(name),
    setOverlay: (name, opts) => state.setOverlay(name, { force: true, ...(opts || {}) }),
    clearOverlay: () => state.clearOverlay(),
    setLook: (index) => animator.setLook(index),
    pauseBehavior: (paused) => behavior.setPaused(paused),
    /** How much the current clip moves; guards the "she never sits still" bug. */
    get agitation() {
      return findAgitatedAmbientStates();
    },
    /** Any state pointing at a clip that does not exist. Must be empty. */
    get stateProblems() {
      return validateStates();
    },
    get roaming() {
      return { base: state.base, clip: animator.clipName };
    },
    /** Trigger one of her ambient lines, for testing. */
    mutter: (kind) => behavior.mutter(kind || 'lyingIdle', 1),
    /** Show an answer as if it came from the model, for testing. */
    sayReply: (text) => sayReply(text, { mood: 'neutral' }),
    /** Simulate a click on her, for testing. */
    clickPet: () => handlePetClick(),
    /** Whether she is currently holding still for a reader. */
    get attentive() { return behavior.attentive; },
    /** How long a reply of this length would stay up. */
    replyHideDelay: (text) => Ui.replyHideDelay(text),
    /** How many lines exist in each ambient pool. */
    mutterKinds: () => Object.fromEntries(Object.entries(MUTTERS).map(([k, v]) => [k, v.length])),
    /** Activity pacing, so tests can assert she does not go idle for minutes. */
    get pacing() { return PACING; },
    /** The pose table with its line pools, for the pose/line consistency check. */
    get poses() { return POSES.map((p) => ({ base: p.base, mutters: p.mutters, weight: p.weight })); },
    /** Which clip and motion each settleable pose actually uses. */
    get poseClips() {
      return Object.fromEntries(POSES.map((p) => [p.base, state.describe(p.base)]));
    },
    /** Sample the pose decision many times over. */
    samplePoses(count = 4000) {
      const tally = Object.fromEntries(POSES.map((p) => [p.base, 0]));
      let previous = null;
      for (let i = 0; i < count; i += 1) {
        const pool = POSES.filter((p) => p.base !== previous);
        const total = pool.reduce((s, p) => s + p.weight, 0);
        let roll = Math.random() * total;
        let chosen = pool[pool.length - 1];
        for (const p of pool) { roll -= p.weight; if (roll <= 0) { chosen = p; break; } }
        tally[chosen.base] += 1;
        previous = chosen.base;
      }
      return Object.fromEntries(
        Object.entries(tally).map(([k, n]) => [k, Number((n / count).toFixed(3))]),
      );
    },
    /** Sit up on the cushion for a while, for testing. */
    sit: () => behavior.settleInto(
      POSES.find((p) => p.base === 'seatedQuiet'), performance.now(),
    ),
    /** Kick off a behaviour-driven walk, for testing. */
    startWalk: () => behavior.startWalk(),
    hideBubble: () => ui.hideBubble(),
    showBalance: (payload) => showBalanceBubble(payload),
    /**
     * Force the gaze to evaluate against a given screen point, so the
     * engage/release logic can be tested without moving the real cursor.
     * Pass null to go back to the polled position.
     */
    overrideCursor(point) { cursorOverride = point || null; },
    get gaze() {
      return {
        index: gazeIndex,
        engaged: gazeEngaged,
        look: animator.look,
        cursor: cursorOverride || cursorScreen,
        cursorEvents: cursorEventCount,
      };
    },
    /** Where her head is, in screen coordinates. */
    headScreen() {
      if (!windowInfo) return null;
      return {
        x: windowInfo.x + petBox.x + petBox.width / 2,
        y: windowInfo.y + petBox.y + petBox.height * 0.38,
      };
    },
    say(text, mood = 'neutral') {
      lastBubbleText = text;
      ui.showBubble(text, { mood });
      ui.setBubbleMood(mood);
    },
    openComposer: () => ui.openComposer(),
    closeComposer: () => ui.closeComposer(),
    getSettings: () => settings,
  };
}

boot()
  .then(() => exposeDebugSurface())
  .catch((err) => {
    console.error(err);
    const toast = document.getElementById('toast');
    if (toast) {
      toast.textContent = `启动失败：${err.message}`;
      toast.classList.add('visible');
    }
  });
