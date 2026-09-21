/**
 * Physical feedback for touching her, and the "spun dizzy" easter egg.
 *
 * Kept out of the state machine on purpose: these are sub-second, continuous
 * pose offsets layered *on top of* whatever state she is in, not states of
 * their own. Pressing her while she is reading should squash her without
 * interrupting the reading.
 */

/** Press/release/landing squash, as a damped spring back to rest. */
const SPRING_STIFFNESS = 220;
const SPRING_DAMPING = 17;

/** How hard each interaction shoves that spring. */
const PRESS_SQUASH = 0.085;
/** Upward kick on release, so the spring overshoots into a stretch. */
const RELEASE_KICK = -1.7;
const LAND_SQUASH = 0.14;

/** Cursor orbits needed to make her dizzy, and the band it must stay in. */
const SPIN_TURNS = 3;
const SPIN_MIN_RADIUS = 45;
const SPIN_MAX_RADIUS = 340;
/** Orbits decay if the cursor stops circling for this long. */
const SPIN_MEMORY_MS = 2600;

/** Dizzy duration, as asked for. */
export const DIZZY_MS = 3000;

/**
 * How hard she reels, and how fast it dies down.
 *
 * There is deliberately no multi-turn spin on trigger. Whirling her through
 * several full rotations was tried and removed: it read as slapstick rather
 * than as being dizzy, and at sprite scale a 360-degree turn just looks like
 * the artwork breaking. A wobble that decays to nothing sells the same idea
 * and leaves her standing.
 */
const DIZZY_WOBBLE = 0.12;
const DIZZY_WOBBLE_HZ = 2.6;
/** A short jolt on trigger, so the wobble does not fade in from nothing. */
const DIZZY_JOLT = 0.09;

/** Time source shared with the rest of the renderer. */
function clock() {
  return performance.now();
}

export class Gestures {
  /**
   * @param {object} deps
   * @param {(name:string, opts?:object)=>boolean} deps.setOverlay
   * @param {() => void} [deps.onLand] fired when a drag ends, for dust
   */
  constructor({ setOverlay, onLand } = {}) {
    this.setOverlay = setOverlay || (() => false);
    this.onLand = onLand || (() => {});

    this.squash = 0;
    this.squashV = 0;
    /**
     * Extremes reached since the last {@link resetRange}.
     *
     * Tracked inside the update loop rather than sampled from outside: the
     * overshoot lasts a few tens of milliseconds, so polling it over IPC would
     * report whatever happened to land between round trips.
     */
    this.minSquash = 0;
    this.maxSquash = 0;
    this.lift = 0;
    this.dragging = false;
    this.pressing = false;

    /** Signed radians the cursor has orbited her with. */
    this.spinAccum = 0;
    this.lastAngle = null;
    this.lastOrbitAt = 0;
    this.dizzyStartedAt = 0;
    this.dizzyUntil = 0;
    this.lastSpinAt = -1e9;
  }

  press() {
    this.pressing = true;
    this.squash = PRESS_SQUASH;
    this.squashV = 0;
  }

  /**
   * Let go.
   *
   * The spring is kicked upward rather than assigned a new squash: releasing
   * into a *negative* squash and letting the spring settle is what produces the
   * overshoot that reads as bounce. Assigning a positive value here made press
   * and release identical, so she just stayed squashed.
   */
  release() {
    this.pressing = false;
    this.squashV = RELEASE_KICK;
    if (this.dragging) {
      this.dragging = false;
      this.onLand();
    }
    this.lift = 0;
  }

  /** She was just dropped back onto the desktop. */
  land() {
    this.squash = LAND_SQUASH;
    this.squashV = 0;
  }

  /**
   * Start (or continue) a drag.
   *
   * Deliberately does nothing to her pose. Turning her to face the direction of
   * travel was tried and removed: the left/right artwork is the walking sway,
   * and swapping her out of the pose she was holding just to face sideways read
   * as broken rather than as being carried. She keeps doing whatever she was
   * doing, and only the squash and the drop feedback change.
   */
  setDragging() {
    this.dragging = true;
  }

  /**
   * Feed the global cursor position in screen coordinates.
   *
   * @param {{x:number,y:number}} cursor
   * @param {{x:number,y:number}} centre her sprite centre, same space
   * @param {number} now
   */
  trackSpin(cursor, centre, now) {
    if (!cursor || !centre) {
      this.lastAngle = null;
      return;
    }
    const dx = cursor.x - centre.x;
    const dy = cursor.y - centre.y;
    const radius = Math.hypot(dx, dy);
    if (radius < SPIN_MIN_RADIUS || radius > SPIN_MAX_RADIUS) {
      // Outside the band: treat as a fresh start rather than teleporting a big
      // delta into the accumulator.
      this.lastAngle = null;
      return;
    }

    const angle = Math.atan2(dy, dx);
    if (this.lastAngle !== null) {
      let delta = angle - this.lastAngle;
      // Unwrap so a crossing of the +/-pi seam is not read as a near-full turn.
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      this.spinAccum += delta;
      if (Math.abs(delta) > 1e-4) this.lastOrbitAt = now;
    }
    this.lastAngle = angle;

    // Forget a stale partial orbit, so twirling once a minute never adds up.
    if (now - this.lastOrbitAt > SPIN_MEMORY_MS) this.spinAccum = 0;

    if (this.dizzyUntil > now) return;
    if (now - this.lastSpinAt < 4000) return;
    if (Math.abs(this.spinAccum) < SPIN_TURNS * Math.PI * 2) return;

    this.spinAccum = 0;
    this.lastSpinAt = now;
    this.dizzyStartedAt = now;
    this.dizzyUntil = now + DIZZY_MS;
    // A jolt, so she reacts to the spin rather than drifting into it.
    this.squash = DIZZY_JOLT;
    this.squashV = 0;
    this.maxWobble = 0;
    this.setOverlay('dizzy', { duration: DIZZY_MS, force: true });
  }

  /** True while she is still reeling. */
  get isSpinning() {
    return clock() < this.dizzyUntil;
  }

  /** Forget the recorded extremes, so the next interaction is measured alone. */
  resetRange() {
    this.minSquash = this.squash;
    this.maxSquash = this.squash;
    this.maxWobble = Math.abs(this.lastWobble || 0);
  }

  /**
   * Advance the springs.
   *
   * @returns {{sx:number, sy:number, rotate:number, ox:number, oy:number}|null}
   *          a pose offset, or null when she is perfectly at rest.
   */
  update(dt, now) {
    // Damped spring back to rest.
    this.squashV += (-SPRING_STIFFNESS * this.squash - SPRING_DAMPING * this.squashV) * dt;
    this.squash += this.squashV * dt;
    if (this.squash < this.minSquash) this.minSquash = this.squash;
    if (this.squash > this.maxSquash) this.maxSquash = this.squash;

    let rotate = 0;
    let wobble = 0;

    if (now < this.dizzyUntil) {
      // Wobble that decays to nothing, so she ends up standing steady rather
      // than being left at an angle.
      const remaining = (this.dizzyUntil - now) / DIZZY_MS;
      const settle = remaining * remaining;
      wobble = Math.sin((now - this.dizzyStartedAt) / 1000 * DIZZY_WOBBLE_HZ * Math.PI * 2)
        * DIZZY_WOBBLE * settle;
      rotate += wobble;
    }
    this.lastWobble = wobble;
    if (Math.abs(wobble) > (this.maxWobble || 0)) this.maxWobble = Math.abs(wobble);

    const atRest = Math.abs(this.squash) < 0.0015
      && Math.abs(this.squashV) < 0.006
      && Math.abs(this.lift) < 0.001
      && Math.abs(rotate) < 0.0015;
    if (atRest) {
      this.squash = 0;
      this.squashV = 0;
      return null;
    }

    return {
      sx: 1 + this.squash,
      sy: 1 - this.squash,
      rotate,
      ox: 0,
      oy: -this.lift * 0,
    };
  }

  /** True while she is dizzy, for the behaviour engine to leave her alone. */
  get reeling() {
    return this.dizzyUntil > 0;
  }

  /** Current wobble angle in degrees, and the largest reached since a reset. */
  get wobbleDeg() {
    return (this.lastWobble || 0) * (180 / Math.PI);
  }

  get maxWobbleDeg() {
    return (this.maxWobble || 0) * (180 / Math.PI);
  }
}
