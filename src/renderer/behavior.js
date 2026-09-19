/**
 * Autonomous behaviour: what she does when nobody is talking to her.
 *
 * The shape is deliberately simple, and mirrors how a real desk pet reads:
 *
 *   settle somewhere -> idly cycle through a few poses -> stroll to a new
 *   spot -> settle again
 *
 * Poses are drawn randomly from the lying and the seated ones, so she
 * alternates between flat on her cushion and sitting up. Walking is a separate
 * phase rather than one of the random poses, because the only walking artwork
 * in this atlas *is* the seated sway -- playing it while standing still looks
 * exactly like walking in place.
 *
 * Every pose carries its own line pool, so a spoken line can never contradict
 * what is on screen.
 */

/** How long she keeps each pose. Short enough that she visibly changes. */
const POSE_MIN_MS = 4_000;
const POSE_MAX_MS = 22_000;

/** How many poses she works through before moving somewhere else. */
const POSES_BEFORE_WALK_MIN = 2;
const POSES_BEFORE_WALK_MAX = 4;

/**
 * Walking pace.
 *
 * Slow on purpose. At the previous 130 px/s with a 12fps clip she looked like
 * she was hurrying somewhere; a desk pet should amble.
 */
const WALK_SPEED = 58;
const WALK_STEP_MIN = 130;
const WALK_STEP_MAX = 260;

const IDLE_AFTER_ARRIVAL_MIN = 800;
const IDLE_AFTER_ARRIVAL_MAX = 2_500;

/**
 * The poses she can settle into, with weights.
 *
 * `mutters` names the line pool spoken when the pose begins. Keeping it on the
 * pose is what guarantees the words match the animation -- there is no shared
 * pool that a mismatched pose could pull from.
 */
const POSES = [
  { base: 'reading', mutters: 'reading', minMs: 12_000, maxMs: 26_000, weight: 3 },
  { base: 'idle', mutters: 'lyingIdle', minMs: 8_000, maxMs: 18_000, weight: 2 },
  { base: 'daydream', mutters: 'lyingIdle', minMs: 7_000, maxMs: 16_000, weight: 2 },
  { base: 'seatedQuiet', mutters: 'quiet', minMs: 5_000, maxMs: 9_000, weight: 2, chance: 0.3 },
  { base: 'seatedShake', mutters: 'looking', minMs: 4_000, maxMs: 7_000, weight: 2, chance: 0.4 },
  { base: 'seatedNod', mutters: 'nodding', minMs: 3_000, maxMs: 5_000, weight: 2, chance: 0.7 },
];

/**
 * Short lines she mutters to herself.
 *
 * Local, not model-generated: these are ambient and frequent, and spending
 * tokens on "……困了" would be silly. The AI-driven chatter (`idleChatter`) is a
 * separate, much rarer thing.
 */
const MUTTERS = {
  reading: [
    '……这本写得还行。',
    '别吵，正到精彩的地方。',
    '哼，男主角真是个木头。',
    '这一段我看了三遍了，还是想哭。',
    '……新出的那本还没看完呢。',
    '这个作者，下一本什么时候出啊。',
  ],
  lyingIdle: [
    '……今天也挺闲的。',
    '你桌上那杯水，凉了吧。',
    '伊兹帕帕今天也很乖。',
    '……在忙什么呢。',
    '烟谜主也是要休息的。',
    '窗外那朵云，形状有点意思。',
    '……要不要去泡杯茶。',
  ],
  looking: [
    '……嗯？',
    '好像有动静。',
    '……看错了。',
    '有人来了？',
    '……没什么事。',
  ],
  quiet: [
    '……在想事情。',
    '嗯……',
    '让我静静。',
    '……别打扰我。',
  ],
  nodding: [
    '……啊，眼睛睁不开了。',
    '再看一页就睡……就一页。',
    '熬夜看小说的后果，就是白天困成这样。',
    '唔……让我眯一会儿。',
    '……刚才看到哪了。',
  ],
  strolling: [
    '……腿都坐麻了。',
    '起来走两步。',
    '嗯，换个地方看书。',
    '……活动活动。',
  ],
  arrived: [
    '就这儿吧。',
    '……还是这边舒服。',
    '嗯，光线不错。',
  ],
  waking: [
    '……唔，我睡着了？',
    '谁在叫我……哦，是你啊。',
    '我刚刚只是闭目养神，别乱想。',
    '……啊，书还摊着呢。',
  ],
  sleepy: [
    '……真的困了。',
    '看不进去了……先歇会儿。',
    '唔……',
  ],
};

export class Behavior {
  /**
   * @param {object} deps
   * @param {any} deps.api   preload bridge
   * @param {import('./state.js').PetState} deps.state
   * @param {() => any} deps.getSettings
   * @param {(text:string) => void} [deps.onMutter] show a spoken line
   * @param {(base:string) => number} [deps.maxHoldFor] cap for a twitchy pose
   */
  constructor({ api, state, getSettings, onMutter, maxHoldFor }) {
    this.api = api;
    this.state = state;
    this.getSettings = getSettings;
    this.onMutter = onMutter;
    this.maxHoldFor = maxHoldFor || (() => 0);

    this.lastActivity = clock();
    this.nextChangeAt = clock() + randomBetween(4_000, 10_000);
    this.lastBase = null;
    this.walking = false;
    this.sleeping = false;
    this.posesSinceWalk = 0;
    this.posesBeforeWalk = randomInt(POSES_BEFORE_WALK_MIN, POSES_BEFORE_WALK_MAX);
    this.paused = false;
    /** While this is in the future she stays put and keeps quiet. */
    this.attentionUntil = 0;
  }

  /**
   * Hold still while the user is reading something she just said.
   *
   * Passing 0 clears the hold. It used to only ever *extend* the deadline, so
   * the hold could not be released early and she stayed frozen long after the
   * bubble was dismissed.
   */
  setAttentionHold(ms = 0) {
    if (!(ms > 0)) {
      this.attentionUntil = 0;
      return;
    }
    const until = clock() + ms;
    if (until > this.attentionUntil) this.attentionUntil = until;
    // Nothing new starts while she has the user's attention.
    if (this.walking) this.stop();
  }

  /** True while she is deliberately staying put for the reader. */
  get attentive() {
    return clock() < this.attentionUntil;
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
    if (this.paused) this.stop();
  }

  /** Called whenever the user talks to her or drags her. */
  notifyActivity(now = clock()) {
    const wasSleeping = this.sleeping;
    this.lastActivity = now;
    this.sleeping = false;
    this.nextChangeAt = now + randomBetween(3_000, 8_000);
    if (wasSleeping && !this.walking && this.state.isFree) {
      this.state.setBase('idle');
      this.state.setOverlay('surprised', { duration: 2000 });
      this.mutter('waking', 1);
    }
  }

  /** She stopped walking, either on arrival or because it was cancelled. */
  handleWalkDone() {
    if (!this.walking) return;
    this.walking = false;
    // Always drop the walking pose, even if an overlay is on top: a cancelled
    // walk must not leave her stuck mid-stride.
    this.state.setBase('idle');
    this.mutter('arrived', 0.3);
    this.posesSinceWalk = 0;
    this.posesBeforeWalk = randomInt(POSES_BEFORE_WALK_MIN, POSES_BEFORE_WALK_MAX);
    this.nextChangeAt = clock() + randomBetween(IDLE_AFTER_ARRIVAL_MIN, IDLE_AFTER_ARRIVAL_MAX);
  }

  stop() {
    if (!this.walking) return;
    this.walking = false;
    this.api.stopWalk();
    this.state.setBase('idle');
    this.nextChangeAt = clock() + randomBetween(IDLE_AFTER_ARRIVAL_MIN, IDLE_AFTER_ARRIVAL_MAX);
  }

  /** Say one of her ambient lines, from a pool that matches the current pose. */
  mutter(kind, probability = 0.5) {
    if (!this.onMutter) return;
    // Never talk over an answer the user is still reading.
    if (this.attentive) return;
    if (Math.random() > probability) return;
    const pool = MUTTERS[kind];
    if (!pool || !pool.length) return;
    this.onMutter(pool[Math.floor(Math.random() * pool.length)]);
  }

  tick(now) {
    if (this.paused) return;
    // Stay put and quiet while she is being read.
    if (now < this.attentionUntil) return;

    const proactive = this.getSettings().proactive || {};

    if (!proactive.enabled) {
      if (this.walking) this.stop();
      if (this.sleeping) this.sleeping = false;
      if (this.state.base !== 'idle') this.state.setBase('idle');
      return;
    }

    const idleFor = now - this.lastActivity;
    const sleepAfter = Math.max(2, Number(proactive.sleepAfterMinutes) || 12) * 60_000;

    if (!this.walking && !this.sleeping && idleFor > sleepAfter) {
      this.sleeping = true;
      this.state.setBase('sleepy');
      this.mutter('sleepy', 0.7);
      return;
    }

    if (this.walking || this.sleeping) return;
    if (!this.state.isFree) return;
    if (now < this.nextChangeAt) return;

    this.advance(now, proactive);
  }

  /** Either move somewhere new, or settle into another pose. */
  advance(now, proactive) {
    const wander = proactive.wander !== false;
    if (wander && this.posesSinceWalk >= this.posesBeforeWalk) {
      this.posesSinceWalk = 0;
      this.posesBeforeWalk = randomInt(POSES_BEFORE_WALK_MIN, POSES_BEFORE_WALK_MAX);
      this.startWalk();
      return;
    }
    this.posesSinceWalk += 1;
    this.settleInto(this.choosePose(), now);
  }

  /** Pick a pose, avoiding an immediate repeat. Exposed for the self-test. */
  choosePose(random = Math.random()) {
    const pool = POSES.filter((p) => p.base !== this.lastBase);
    const candidates = pool.length ? pool : POSES;
    const total = candidates.reduce((sum, p) => sum + p.weight, 0);
    let roll = random * total;
    for (const pose of candidates) {
      roll -= pose.weight;
      if (roll <= 0) return pose;
    }
    return candidates[candidates.length - 1];
  }

  settleInto(pose, now) {
    this.lastBase = pose.base;
    this.state.setBase(pose.base);
    this.mutter(pose.mutters, pose.chance == null ? 0.35 : pose.chance);

    // A twitchy pose must not be held; cap the dwell at its own limit.
    const hold = this.maxHoldFor(pose.base);
    let dwell = randomBetween(pose.minMs, pose.maxMs);
    if (hold > 0) dwell = Math.min(dwell, hold);
    this.nextChangeAt = now + dwell;
  }

  async startWalk() {
    const info = await this.api.getWindowInfo();
    if (!info || !info.workArea) return;

    const area = info.workArea;
    const margin = 6;
    const minX = area.x + margin;
    const maxX = area.x + area.width - info.width - margin;
    if (maxX - minX < 60) {
      this.settleInto(this.choosePose(), clock());
      return;
    }

    // A nearby destination, in whichever direction has room for it.
    const step = randomBetween(WALK_STEP_MIN, WALK_STEP_MAX);
    const candidates = [info.x + step, info.x - step]
      .map((x) => Math.round(Math.min(maxX, Math.max(minX, x))))
      .filter((x) => Math.abs(x - info.x) >= 60);

    if (candidates.length === 0) {
      this.settleInto(this.choosePose(), clock());
      return;
    }

    const targetX = candidates[Math.floor(Math.random() * candidates.length)];
    const direction = targetX > info.x ? 1 : -1;
    this.walking = true;
    this.state.setBase(direction > 0 ? 'walkRight' : 'walkLeft');
    this.mutter('strolling', 0.3);
    this.api.walk({ direction, speed: WALK_SPEED, targetX });
  }
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function randomInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/**
 * Behaviour timers must share the renderer's clock. `performance.now()` is the
 * same origin as the timestamps handed to `tick()`, unlike `Date.now()`.
 */
function clock() {
  return performance.now();
}

export { MUTTERS, POSES };

/** Exposed so the self-test can assert the pacing and the pose mix. */
export const PACING = {
  poseMs: [POSE_MIN_MS, POSE_MAX_MS],
  posesBeforeWalk: [POSES_BEFORE_WALK_MIN, POSES_BEFORE_WALK_MAX],
  walkSpeed: WALK_SPEED,
  /** Measured length of one stroll, in ms. */
  walkMs: [WALK_STEP_MIN, WALK_STEP_MAX].map((px) => Math.round((px / WALK_SPEED) * 1000)),
  walkClipFps: 8,
  poses: POSES.map((p) => ({ base: p.base, mutters: p.mutters, weight: p.weight })),
  mutterKeys: Object.keys(MUTTERS),
};
