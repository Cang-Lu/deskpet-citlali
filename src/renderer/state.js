import { MOODS, DEFAULT_MOOD, CLIPS, ROW_MOTION, CALM_MOTION_LIMIT } from '../shared/pet-spec.js';

/**
 * Two-layer state machine.
 *
 *  - `base`    is the resting activity chosen by the behaviour engine
 *              (idle / sleepy / reading / walking).
 *  - `overlay` is a temporary, higher-priority state such as an emotional
 *              reaction or "she is thinking about your message".
 *
 * Whatever the layers say, they both resolve to a clip + an ambient effect.
 */

export const PRIORITY = {
  ambient: 0,
  movement: 1,
  speech: 2,
  reaction: 3,
  busy: 4,
};

const STATES = {
  /* --- base: settled in one place --- */
  idle: { clip: 'lyingRead', effect: 'none', speed: 0.85, loop: true, priority: PRIORITY.ambient },
  reading: { clip: 'lyingRead', effect: 'none', speed: 0.6, loop: true, priority: PRIORITY.ambient },
  daydream: { clip: 'lyingIdle', effect: 'none', speed: 0.7, loop: true, priority: PRIORITY.ambient },
  sleepy: { clip: 'lyingRead', effect: 'sleep', speed: 0.45, loop: true, priority: PRIORITY.ambient },
  /**
   * Seated poses.
   *
   * `maxHoldMs` is the contract: these rows move 1.5-2x more than the lying
   * ones, which is fine as a deliberate gesture but reads as a tic if held.
   * The behaviour engine honours it, and `findAgitatedAmbientStates` refuses to
   * let a high-motion pose into a long rest without one.
   */
  seatedShake: {
    clip: 'seatedShake', effect: 'none', speed: 0.8, loop: true,
    priority: PRIORITY.ambient, maxHoldMs: 7_000,
  },
  seatedNod: {
    clip: 'seatedNod', effect: 'sleep', speed: 0.8, loop: true,
    priority: PRIORITY.ambient, maxHoldMs: 5_000,
  },
  seatedQuiet: {
    clip: 'seatedQuiet', effect: 'none', speed: 0.6, loop: true,
    priority: PRIORITY.ambient, maxHoldMs: 9_000,
  },
  walkRight: { clip: 'runRight', effect: 'none', speed: 1, loop: true, priority: PRIORITY.movement },
  walkLeft: { clip: 'runLeft', effect: 'none', speed: 1, loop: true, priority: PRIORITY.movement },

  /* --- overlay --- */
  thinking: { clip: 'lyingIdle', effect: 'focus', speed: 1, loop: true, priority: PRIORITY.busy },
  speaking: { clip: 'lyingRead', effect: 'none', speed: 1.25, loop: true, priority: PRIORITY.speech },
  happy: { clip: 'jumping', effect: 'sparkle', speed: 1, loop: false, priority: PRIORITY.reaction },
  greet: { clip: 'waving', effect: 'sparkle', speed: 1, loop: false, priority: PRIORITY.reaction },
  shy: { clip: 'waving', effect: 'blush', speed: 1, loop: false, priority: PRIORITY.reaction },
  /**
   * Sad/angry ride a *looping* clip, so they must be sustained states with an
   * explicit duration rather than "play once and finish". Declaring them
   * `loop: false` made the overlay-expiry check think the clip was already over
   * and drop the reaction after a single frame.
   */
  sad: { clip: 'seatedQuiet', effect: 'rain', speed: 1, loop: true, priority: PRIORITY.reaction },
  angry: { clip: 'seatedQuiet', effect: 'anger', speed: 1, loop: true, priority: PRIORITY.reaction },
  surprised: { clip: 'jumping', effect: 'sparkle', speed: 1, loop: false, priority: PRIORITY.reaction },
};

/** Mood token from the model -> overlay state. */
const MOOD_STATE = {
  neutral: null,
  happy: 'happy',
  excited: 'happy',
  greeting: 'greet',
  shy: 'shy',
  thinking: 'thinking',
  working: 'thinking',
  sad: 'sad',
  angry: 'angry',
  sleepy: 'sleepy',
  surprised: 'surprised',
};

export class PetState {
  constructor(animator, effects) {
    this.animator = animator;
    this.effects = effects;
    this.base = 'idle';
    this.overlay = null;
    this.overlayExpiresAt = 0;
    this.now = 0;
    this.apply();
  }

  get current() {
    return this.overlay || this.base;
  }

  /** Switch the resting activity. Ignored while an overlay is showing. */
  setBase(name) {
    if (!STATES[name]) return false;
    if (this.base === name) return false;
    this.base = name;
    if (!this.overlay) this.apply();
    return true;
  }

  /**
   * Show a temporary state.
   *
   * @param {string} name
   * @param {{duration?:number, force?:boolean}} [opts] duration in ms;
   *        omit it for one-shot clips that end on their own.
   */
  setOverlay(name, { duration = 0, force = false } = {}) {
    const def = STATES[name];
    if (!def) return false;

    if (this.overlay && !force) {
      const active = STATES[this.overlay];
      const stillRunning = this.overlayExpiresAt === 0
        ? this.animator.busy
        : this.now < this.overlayExpiresAt;
      if (stillRunning && active.priority > def.priority) return false;
    }

    const previous = this.overlay;
    this.overlay = name;
    this.overlayExpiresAt = duration > 0 ? this.now + duration : 0;
    this.apply(previous !== name);
    return true;
  }

  clearOverlay() {
    if (!this.overlay) return;
    this.overlay = null;
    this.overlayExpiresAt = 0;
    this.apply(true);
  }

  /** React to an emotional token returned by the model. */
  applyMood(mood) {
    const key = MOODS[mood] ? mood : DEFAULT_MOOD;
    const state = MOOD_STATE[key];
    if (!state) {
      this.clearOverlay();
      return;
    }
    if (state === 'sleepy') {
      this.setOverlay('sleepy', { duration: 4000 });
      return;
    }
    if (state === 'thinking') {
      this.setOverlay('thinking', { duration: 2500 });
      return;
    }
    // One-shot reactions hold for a beat even after the clip ends.
    this.setOverlay(state, { duration: 2600, force: true });
  }

  apply(restart = false) {
    const def = STATES[this.current] || STATES.idle;
    this.animator.speed = def.speed;
    this.animator.play(def.clip, { restart });
    this.effects.set(def.effect);
  }

  /** What clip/effect a named state resolves to, for tooling and tests. */
  describe(name) {
    const def = STATES[name];
    if (!def) return null;
    const clip = CLIPS[def.clip];
    return {
      clip: def.clip,
      row: clip ? clip.row : -1,
      motion: ROW_MOTION[def.clip] ?? 0,
      maxHoldMs: def.maxHoldMs || 0,
    };
  }

  update(dt, now) {
    this.now = now;
    if (this.overlay) {
      const def = STATES[this.overlay];
      const expiredByTime = this.overlayExpiresAt > 0 && now >= this.overlayExpiresAt;
      // A *looping* overlay with no explicit duration is meant to persist until
      // something clears it ("she is thinking"). Only one-shot clips end by
      // themselves.
      const expiredByClip = this.overlayExpiresAt === 0 && !def.loop && !this.animator.busy;
      if (expiredByTime || expiredByClip) {
        this.overlay = null;
        this.overlayExpiresAt = 0;
        this.apply(true);
      }
    }
  }

  /** True when nothing temporary is on screen and the base can be changed. */
  get isFree() {
    return !this.overlay;
  }
}

export { STATES };

/**
 * Every state must point at a clip that exists.
 *
 * A typo here -- or confusing a state name with a clip name, which is easy now
 * that both vocabularies exist -- used to blow up while drawing the very first
 * frame, so the window never appeared at all.
 *
 * @returns {string[]} human-readable problems, empty when healthy
 */
export function validateStates() {
  const problems = [];
  for (const [name, def] of Object.entries(STATES)) {
    const clip = CLIPS[def.clip];
    if (!clip) {
      problems.push(`state "${name}" references unknown clip "${def.clip}"`);
      continue;
    }
    if (def.maxHoldMs && def.maxHoldMs > 30_000) {
      problems.push(`state "${name}" maxHoldMs ${def.maxHoldMs} is not a short gesture`);
    }
    // "Finishes by itself" only works for clips that actually finish. A
    // one-shot state over a looping clip expires on the very first frame.
    if (!def.loop && clip.loop) {
      problems.push(
        `state "${name}" is loop:false but clip "${def.clip}" loops, so it can never finish on its own`,
      );
    }
  }
  return problems;
}

/** Every pose she can settle into when nobody is around. */
export const AMBIENT_STATES = [
  'idle', 'reading', 'daydream', 'sleepy',
  'seatedShake', 'seatedNod', 'seatedQuiet',
];

/** The hold limit a behaviour engine must respect for a given state. */
export function maxHoldFor(base) {
  const def = STATES[base];
  return def && def.maxHoldMs ? def.maxHoldMs : 0;
}

/**
 * Long-lived poses that would look twitchy if held.
 *
 * A row's name says nothing about its motion, so this uses measured frame
 * deltas. High motion is allowed -- `seatedShake` is a lovely "looking around"
 * gesture -- but only with a `maxHoldMs` on it. Without that it becomes the
 * non-stop head-shaking bug again.
 *
 * @returns {{state:string, clip:string, row:number, motion:number}[]} offenders
 */
export function findAgitatedAmbientStates() {
  const offenders = [];
  for (const name of AMBIENT_STATES) {
    const def = STATES[name];
    if (!def) continue;
    if (!CLIPS[def.clip]) continue; // validateStates reports this one
    const motion = ROW_MOTION[def.clip] ?? 0;
    if (motion > CALM_MOTION_LIMIT && !def.maxHoldMs) {
      offenders.push({ state: name, clip: def.clip, row: CLIPS[def.clip].row, motion });
    }
  }
  return offenders;
}
