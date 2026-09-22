import {
  CELL,
  DEFAULT_SPRITE_HEIGHT,
  MAX_SPRITE_HEIGHT,
  MIN_SPRITE_HEIGHT,
  directionFromVector,
  fitSpriteSize,
  snapToCellMultiple,
} from '../shared/pet-spec.js';
import { Atlas, Animator, SpriteRenderer } from './sprite.js';
import { Effects } from './effects.js';
import {
  PetState, findAgitatedAmbientStates, maxHoldFor, validateStates,
} from './state.js';
import { Behavior, MUTTERS, POSES, PACING, Temper, TEMPER_MUTTERS } from './behavior.js';
import { Ui } from './ui.js';
import { drawEmote } from './emote.js';
import { Gestures, DIZZY_MS } from './gesture.js';

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
/** Press/drag feedback and the spin easter egg. */
let gestures = null;
/** Her short temper, driven by interaction patterns. */
let temper = null;

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

  gestures = new Gestures({
    setOverlay: (name, opts) => {
      // She has something to say about being spun around.
      if (name === 'dizzy') behavior.mutter('dizzy', 1);
      return state.setOverlay(name, opts);
    },
    onLand: () => behavior.notifyActivity(),
  });

  temper = new Temper({
    react: (name, ms) => state.setOverlay(name, { duration: ms, force: true }),
    // Forced: a temper line is tied to an emotion the user just provoked, and
    // the quiet gap exists for ambient chatter, not for reactions.
    mutter: (kind, chance) => behavior.mutter(kind, chance, { force: true }),
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

  // Pixel art can only be enlarged without resampling at whole multiples of the
  // cell; anything in between has to weight the source rows unevenly, which
  // shows up as faint horizontal banding. `integerScale` keeps her on those
  // sizes; turning it off hands back every size at the cost of that banding.
  const requested = Number(settings.sizePx) || DEFAULT_SPRITE_HEIGHT;
  const target = settings.integerScale === false ? requested : snapToCellMultiple(requested);
  const { width, height } = fitSpriteSize({
    targetHeight: target,
    maxWidth: viewport.width - 4,
    maxHeight: viewport.height - 4,
  });

  /**
   * Snap the sprite box to whole device pixels.
   *
   * On a display with a fractional scale factor, centring a 192px sprite in a
   * 420px window lands its origin on a half device pixel (18 CSS px at 1.25x is
   * 22.5 device px). Chromium then filters every edge across two pixels, which
   * is precisely what "slightly blurry" looks like — and it is invisible at
   * 100%, which is why it only shows up on some machines.
   */
  const snap = (value) => Math.round(value * dpr) / dpr;

  // Any size is allowed; `SpriteRenderer` decides how to rasterise it.
  petBox = {
    x: snap((viewport.width - width) / 2),
    y: snap(viewport.height - height),
    width,
    height,
  };

  const root = document.documentElement.style;
  root.setProperty('--pet-w', `${petBox.width}px`);
  root.setProperty('--pet-h', `${petBox.height}px`);
  // Work mode gives her a taller bubble; the main process owns the number.
  root.setProperty('--bubble-zone', `${Number(settings.bubbleZone) || BUBBLE_ZONE}px`);

  // Assigning to canvas.width/height clears the canvas, and the still-frame
  // skip below would then decide nothing had changed and refuse to repaint --
  // leaving her invisible until the animation happened to advance, which on the
  // slow idle clip is a couple of seconds. Force the next frame to draw.
  lastStillSignature = '';
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

/**
 * Run `draw` inside a pose offset, pivoting on her feet.
 *
 * Pivoting at the bottom rather than the centre is what makes a squash read as
 * her being pressed onto the desktop instead of shrinking in mid air.
 *
 * @param {CanvasRenderingContext2D} context
 * @param {{sx:number,sy:number,rotate:number,ox:number,oy:number}|null} pose
 * @param {() => void} draw
 */
function withPose(context, pose, draw) {
  if (!pose) {
    draw();
    return;
  }
  const pivotX = petBox.x + petBox.width / 2;
  const pivotY = petBox.y + petBox.height;
  context.save();
  context.translate(pivotX + (pose.ox || 0), pivotY + (pose.oy || 0));
  if (pose.rotate) context.rotate(pose.rotate);
  context.scale(pose.sx || 1, pose.sy || 1);
  context.translate(-pivotX, -pivotY);
  draw();
  context.restore();
}

/** Merge the state's own pose tweak with the transient gesture offset. */
function composePose(gesturePose, transform, now) {
  if (!transform && !gesturePose) return null;
  const t = state.stateAge;
  const shake = transform && transform.shake
    ? Math.sin(now / 28) * transform.shake
    : 0;
  const wobble = transform && transform.wobble
    ? Math.sin(now / 165) * transform.wobble
    : 0;
  return {
    sx: (gesturePose ? gesturePose.sx : 1) * (transform && transform.scaleX ? transform.scaleX : 1),
    sy: (gesturePose ? gesturePose.sy : 1) * (transform && transform.scaleY ? transform.scaleY : 1),
    rotate: (gesturePose ? gesturePose.rotate : 0)
      + (transform && transform.rotate ? transform.rotate : 0)
      + shake + wobble,
    ox: (gesturePose ? gesturePose.ox : 0) + (transform && transform.tiltX ? transform.tiltX * petBox.width : 0),
    oy: (gesturePose ? gesturePose.oy : 0) - (transform && transform.lift ? transform.lift * petBox.height : 0),
    // A dizzy lean should breathe rather than sit at one angle.
    tilt: t,
  };
}

/* ------------------------------------------------------------------ */
/* Render loop                                                         */
/* ------------------------------------------------------------------ */

function frame(now) {
  const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;

  behavior.tick(now);
  if (temper) temper.checkNeglect(now);
  state.update(dt, now);
  animator.update(dt);
  updateGaze(now);

  // The cursor may have circled her since the last frame.
  if (windowInfo) {
    gestures.trackSpin(cursorScreen, {
      x: windowInfo.x + petBox.x + petBox.width / 2,
      y: windowInfo.y + petBox.y + petBox.height * 0.45,
    }, now);
  }
  const gesturePose = gestures.update(dt, now);
  const pose = composePose(gesturePose, state.transform, now);

  effects.update(dt, petBox);

  const contentRow = animator.cell.row;
  const anchor = atlas.anchorFor(contentRow);
  const emote = state.emote;

  /**
   * Skip the repaint when the frame cannot have changed.
   *
   * She is still for most of her life — asleep, or a slow idle clip — and
   * redrawing an identical canvas 60 times a second is pure battery drain. The
   * frame only advances when the cell changes, a fade is running, an expression
   * is animating, or particles exist to move.
   */
  const still = !animator.fade
    && state.effectKind === 'none'
    && !emote
    && !pose;
  const signature = still ? `${contentRow}:${animator.cell.col}` : '';
  if (still && signature === lastStillSignature) {
    requestAnimationFrame(frame);
    return;
  }
  lastStillSignature = still ? signature : '';

  ctx.clearRect(0, 0, viewport.width, viewport.height);

  withPose(ctx, pose, () => {
    // Cross-fade the outgoing cell: the atlas mixes two body postures
    // (lying down reading vs. sitting upright), so clips must not hard-cut.
    const alpha = animator.fadeAlpha;
    if (alpha > 0 && animator.fade) {
      paintCell(ctx, { row: animator.fade.row, col: animator.fade.col }, alpha);
    }

    paintCell(ctx, animator.cell);

    // Expressions ride on top of the pose so they follow a wobble or a squash,
    // and are drawn before the particle effects so sparkles sit above them.
    if (emote) drawEmote(ctx, emote, petBox, anchor, state.stateAge);
  });

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

/** Cell signature of the last frame actually painted, for the still-frame skip. */
let lastStillSignature = '';
/** A chat-burst reaction, held back until her reply lands. */
let pendingTemper = null;

function installPointer() {
  window.addEventListener('mousemove', (event) => {
    mouseScreen = { x: event.screenX, y: event.screenY };
    setCapture(shouldCapture(event.clientX, event.clientY));

    if (dragging) {
      const dx = event.screenX - dragging.startScreenX;
      const dy = event.screenY - dragging.startScreenY;
      dragging.moved = Math.max(dragging.moved, Math.hypot(dx, dy));
      api.setWindowPosition(dragging.startWindowX + dx, dragging.startWindowY + dy);
      // She keeps whatever pose she was holding while being carried; see
      // `Gestures.setDragging` for why the facing was removed.
      if (dragging.moved > DRAG_THRESHOLD_PX) gestures.setDragging();
    }
  }, { passive: true });

  window.addEventListener('mousedown', async (event) => {
    if (event.button !== 0) return;
    if (!pointIn(petHitRect(), event.clientX, event.clientY)) return;
    if (!windowInfo) windowInfo = await api.getWindowInfo();
    behavior.notifyActivity();
    api.reportActivity();
    gestures.press();
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
    const wasDragging = dragging.moved >= DRAG_THRESHOLD_PX;
    dragging = null;
    gestures.release();
    if (wasDragging) {
      gestures.land();
      // Put her down: settle into a pose somewhere new rather than staying
      // frozen in whatever she was doing.
      behavior.landed();
    }

    if (wasClick) {
      // If the poking has wound her up, that reaction *is* the feedback;
      // greeting her on top of it would overwrite it in the same frame.
      if (!temper.note('poke')) handlePetClick();
      else behavior.notifyActivity();
    } else {
      if (!temper.note('drag')) {
        state.setOverlay('surprised', { duration: 1400, force: true });
      }
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
  if (!text) return;
  // Only a reply already on screen is newer than the one we remembered. An
  // ambient line is not: she may have muttered something in the meantime, and
  // clicking her should still bring the answer back rather than be swallowed.
  if (ui.showingReply) return;
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
  // A burst of questions annoys her, but the answer has to come first — and
  // "thinking" outranks a reaction, so firing it here would never be seen.
  pendingTemper = temper.note('chat');
  state.setOverlay('thinking', { force: true });
  ui.setBusy(true);
  ui.setBubbleMood('thinking');
  // Kind is `reply`, not the default `ambient`: while this is streaming it must
  // be protected from her muttering, and it must not be auto-hidden mid-answer.
  ui.showBubble('', { mood: 'thinking', status: '正在想…', kind: 'reply' });
  api.sendMessage(text).catch((err) => {
    ui.showToast(`发送失败：${err.message}`, 8000);
    ui.setBusy(false);
    state.clearOverlay();
  });
}

let streamBuffer = '';

function installIpc() {
  api.onChatStart(({ chatter }) => {
    // An unprompted line must never take the screen away from an answer the
    // user asked for. The main process already waits for a quiet spell, but the
    // renderer is the only side that knows an answer is still being read, so the
    // last word on it belongs here.
    if (chatter && ui.showingReply) {
      api.cancelMessage();
      restoreLastLine();
      return;
    }
    streamBuffer = '';
    ui.setBusy(true);
    if (chatter) {
      state.setOverlay('thinking', { force: true });
      ui.setBubbleMood('thinking');
      ui.showBubble('', { mood: 'thinking', status: '她想说点什么…', kind: 'reply' });
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

    // The annoyed reaction was held back until the answer landed. Shown now,
    // right after her reply, where it reads as a reaction to being interrogated.
    if (pendingTemper) {
      const emotion = pendingTemper;
      pendingTemper = null;
      setTimeout(() => {
        if (ui.showingReply) return;
        state.setOverlay(emotion, { duration: 4500, force: true });
      }, 900);
    }
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
        bubbleKind: ui.kind,
        streaming: ui.busy,
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
    mutter: (kind) => behavior.mutter(kind || 'lyingIdle', 1, { force: true }),
    /** Show an answer as if it came from the model, for testing. */
    sayReply: (text) => sayReply(text, { mood: 'neutral' }),
    /** Simulate a click on her, for testing. */
    clickPet: () => handlePetClick(),
    /** Whether she is currently holding still for a reader. */
    get attentive() { return behavior.attentive; },
    /** How long a reply of this length would stay up. */
    replyHideDelay: (text) => Ui.replyHideDelay(text),
    /** Show an emotional overlay indefinitely, for screenshots. */
    emote: (name, duration = 600000) => state.setOverlay(name, { duration, force: true }),
    /** Measured head anchors, so the self-test can sanity-check them. */
    get anchors() { return atlas.anchors; },
    /** Which anchor the current clip resolves to. */
    get currentAnchor() { return atlas.anchorFor(animator.cell.row); },
    /**
     * Draw an expression to an offscreen canvas and report its bounding box.
     *
     * Derived expressions are positioned from the face anchor, so the only way
     * to know they landed on her face rather than in her hair is to measure.
     */
    measureEmote(name, row = animator.cell.row, t = 0.5) {
      const w = Math.max(1, Math.round(viewport.width));
      const h = Math.max(1, Math.round(viewport.height));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const cx = canvas.getContext('2d', { willReadFrequently: true });
      const anchor = atlas.anchorFor(row);
      drawEmote(cx, name, petBox, anchor, t);
      const data = cx.getImageData(0, 0, w, h).data;
      let minX = w;
      let minY = h;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          if (data[(y * w + x) * 4 + 3] <= 10) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      const toNorm = (px) => Number((px - petBox.x) / petBox.width);
      const toNormY = (px) => Number((px - petBox.y) / petBox.height);
      return {
        row,
        anchor,
        facePx: { x: petBox.x + anchor.x * petBox.width, y: petBox.y + anchor.y * petBox.height },
        bbox: maxX < 0 ? null : {
          x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1,
          centreNorm: [toNorm((minX + maxX) / 2), toNormY((minY + maxY) / 2)],
        },
      };
    },
    /** Press/drag/spin state, for the self-test. */
    get gestures() {
      return {
        spinning: gestures.isSpinning,
        reeling: gestures.reeling,
        squash: gestures.squash,
        minSquash: gestures.minSquash,
        maxSquash: gestures.maxSquash,
        dragging: gestures.dragging,
        spinAccum: gestures.spinAccum,
        wobbleDeg: Number(gestures.wobbleDeg.toFixed(2)),
        maxWobbleDeg: Number(gestures.maxWobbleDeg.toFixed(2)),
      };
    },
    resetSquashRange: () => gestures.resetRange(),
    /** Drive the physics directly, since synthetic mouse events are unreliable. */
    press: () => gestures.press(),
    release: () => gestures.release(),
    land: () => gestures.land(),
    drag: (dx) => {
      gestures.setDragging();
      void dx;   // direction is deliberately ignored; see Gestures.setDragging
      return { dragging: gestures.dragging, base: state.base };
    },
    /** Her centre in screen coordinates, which is what `orbit` needs. */
    get centre() {
      return {
        x: (windowInfo ? windowInfo.x : 0) + petBox.x + petBox.width / 2,
        y: (windowInfo ? windowInfo.y : 0) + petBox.y + petBox.height * 0.45,
      };
    },
    /** Feed a cursor position in screen coordinates to the spin detector. */
    orbit: (x, y) => gestures.trackSpin({ x, y }, window.__deskpet.centre, performance.now()),
    dizzyMs: DIZZY_MS,
    /** How many lines exist in each ambient pool. */
    mutterKinds: () => Object.fromEntries(Object.entries(MUTTERS).map(([k, v]) => [k, v.length])),
    /** The area that accepts a click, for synthetic pointer tests. */
    get hitRect() { return petHitRect(); },
    /** Simulate a full press-drag-release on her, through the real handlers. */
    pointerDrag: (dx = 40, dy = 0) => {
      const r = petHitRect();
      const cx = Math.round((r.left + r.right) / 2);
      const cy = Math.round((r.top + r.bottom) / 2);
      const fire = (type, screenX, screenY) => window.dispatchEvent(new MouseEvent(type, {
        bubbles: true, button: 0, clientX: cx, clientY: cy, screenX, screenY,
      }));
      fire('mousedown', 1000, 500);
      fire('mousemove', 1000 + dx, 500 + dy);
      fire('mouseup', 1000 + dx, 500 + dy);
      return { cx, cy, moved: Math.hypot(dx, dy) };
    },
    /** Simulate a click on her, through the real handlers. */
    pointerClick: () => {
      const r = petHitRect();
      const cx = Math.round((r.left + r.right) / 2);
      const cy = Math.round((r.top + r.bottom) / 2);
      const fire = (type) => window.dispatchEvent(new MouseEvent(type, {
        bubbles: true, button: 0, clientX: cx, clientY: cy, screenX: 1000, screenY: 500,
      }));
      fire('mousedown');
      fire('mouseup');
      return { cx, cy };
    },
    temperPools: () => Object.keys(TEMPER_MUTTERS),
    /** Drive the temper directly, when the real triggers are too slow to hit. */
    temper: (kind) => temper.note(kind),
    /** Live temper bookkeeping, so a misfiring trigger can be diagnosed. */
    get temperState() {
      return {
        events: Object.fromEntries(Object.entries(temper.events).map(([k, v]) => [k, v.length])),
        cooldowns: { ...temper.cooldowns },
        windowsMs: { drag: 60000, poke: 30000, chat: 90000 },
        bursts: { drag: 3, poke: 4, chat: 3 },
      };
    },
    /** Force the streaming flag, to test that ambient lines still expire. */
    forceBusy: (value) => ui.setBusy(Boolean(value)),
    /**
     * Mean absolute second difference down the sprite's columns.
     *
     * A resampled image with uneven row weighting shows a strong periodic
     * component along y; a cleanly scaled one does not. Returned with the
     * threshold it should stay under, so the self-test can assert on it.
     */
    rowBanding: () => {
      const w = Math.max(1, Math.round(viewport.width));
      const h = Math.max(1, Math.round(viewport.height));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const cx = canvas.getContext('2d', { willReadFrequently: true });
      cx.drawImage(ctx.canvas, 0, 0);
      const data = cx.getImageData(0, 0, w, h).data;

      const x0 = Math.max(0, Math.floor(petBox.x));
      const x1 = Math.min(w - 1, Math.ceil(petBox.x + petBox.width));
      const y0 = Math.max(1, Math.floor(petBox.y));
      const y1 = Math.min(h - 2, Math.ceil(petBox.y + petBox.height));

      const rows = [];
      for (let y = y0; y <= y1; y += 1) {
        let sum = 0;
        let n = 0;
        for (let x = x0; x <= x1; x += 1) {
          const i = (y * w + x) * 4;
          sum += data[i] + data[i + 1] + data[i + 2];
          n += 1;
        }
        rows.push(n ? sum / n : 0);
      }

      let acc = 0;
      let peak = 0;
      for (let i = 1; i < rows.length - 1; i += 1) {
        const d = Math.abs(rows[i - 1] - 2 * rows[i] + rows[i + 1]);
        acc += d;
        if (d > peak) peak = d;
      }
      return {
        energy: Number((acc / Math.max(1, rows.length - 2)).toFixed(3)),
        peak: Number(peak.toFixed(2)),
        // Calibrated from a build that was verified to be free of banding.
        limit: 12,
      };
    },
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
    /** Kick off a stroll and report what actually happened, for the self-test. */
    walkProbe: async () => {
      const before = state.base;
      await behavior.startWalk();
      return {
        before,
        after: state.base,
        walking: behavior.walking,
        overlay: state.overlay,
        free: state.isFree,
        bounds: windowInfo ? { x: windowInfo.x, width: windowInfo.width } : null,
        workArea: windowInfo ? windowInfo.workArea : null,
      };
    },
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
