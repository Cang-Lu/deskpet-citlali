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
    '这个转折……我早猜到了。',
    '果然，女二号才是最好的。',
    '……下一页呢，下一页呢。',
    '唉，书里的人怎么都这么别扭。',
    '这段写进我的笔记本里。',
    '……看到这里，我居然有点羡慕。',
  ],
  lyingIdle: [
    '……今天也挺闲的。',
    '你桌上那杯水，凉了吧。',
    '伊兹帕帕今天也很乖。',
    '……在忙什么呢。',
    '烟谜主也是要休息的。',
    '窗外那朵云，形状有点意思。',
    '……要不要去泡杯茶。',
    '嗯，今天的光线刚刚好。',
    '……总觉得忘了点什么。',
    '你这椅子，坐久了会腰疼的。',
    '烟谜主的日常工作，就是没有工作。',
    '……要不要跟你说件很久以前的事。',
  ],
  looking: [
    '……嗯？',
    '好像有动静。',
    '……看错了。',
    '有人来了？',
    '……没什么事。',
    '刚刚是不是闪了一下。',
    '……风声而已。',
    '嗯，我什么都没看见。',
    '……谁在叫我。',
    '别躲了，我听见了。',
  ],
  quiet: [
    '……在想事情。',
    '嗯……',
    '让我静静。',
    '……别打扰我。',
    '……这件事得好好想想。',
    '嗯，你不懂。',
    '……几百年了，还是没想明白。',
    '别看我，我没发呆。',
    '……只是有点懒得说话。',
  ],
  nodding: [
    '……啊，眼睛睁不开了。',
    '再看一页就睡……就一页。',
    '熬夜看小说的后果，就是白天困成这样。',
    '唔……让我眯一会儿。',
    '……刚才看到哪了。',
    '唔……这段字怎么在动。',
    '再撑一会儿……就一会儿。',
    '……不行了，眼皮好重。',
    '书……别跑……',
    '嗯……我没睡，我在思考。',
  ],
  strolling: [
    '……腿都坐麻了。',
    '起来走两步。',
    '嗯，换个地方看书。',
    '……活动活动。',
    '……换个角度，书也好看些。',
    '嗯，该挪挪了。',
    '这个姿势维持太久了。',
    '……走两步，醒醒神。',
    '换个地方，换个心情。',
  ],
  arrived: [
    '就这儿吧。',
    '……还是这边舒服。',
    '嗯，光线不错。',
    '……这里背光，凑合。',
    '好，就赖在这儿了。',
    '嗯，这个位置视野好。',
    '……总算到了。',
  ],
  waking: [
    '……唔，我睡着了？',
    '谁在叫我……哦，是你啊。',
    '我刚刚只是闭目养神，别乱想。',
    '……啊，书还摊着呢。',
    '唔……几点了。',
    '……我醒着呢，一直醒着。',
    '别用那种眼神看我。',
    '嗯……梦到很久以前的事了。',
  ],
  sleepy: [
    '……真的困了。',
    '看不进去了……先歇会儿。',
    '唔……',
    '……字都在飘。',
    '让我趴一会儿，就一会儿。',
    '……别吵，我在和周公下棋。',
    '嗯……这本书留着明天看。',
  ],
  dizzy: [
    '……天旋地转的。',
    '唔……别转了。',
    '……我看到两个你了。',
    '哼，等我缓过来再跟你算账。',
    '……星星，好多星星。',
    '别晃了……我认输。',
    '唔……地怎么是斜的。',
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

  /** She was just put down after being carried. */
  landed() {
    this.walking = false;
    this.state.setBase('idle');
    this.mutter('arrived', 0.4);
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

/**
 * A short temper, driven by how the user has been treating her.
 *
 * Reacting to single events covers "click her and she greets you". This covers
 * the *pattern* — being dragged about, asked five things in a row, or ignored
 * for a while. Every rule has a cooldown, because an emotion the user cannot
 * provoke twice is an emotion they never discover.
 */
const TEMPER = {
  // The windows are generous on purpose. A desktop pet gets dragged around at a
  // leisurely pace, and the first cut (three drags inside 25 seconds) was tight
  // enough that it was effectively unreachable by hand even though the code was
  // correct.
  chatBurst: 3,
  chatWindowMs: 90_000,
  chatCooldownMs: 90_000,
  dragBurst: 3,
  dragWindowMs: 60_000,
  dragCooldownMs: 45_000,
  pokeBurst: 4,
  pokeWindowMs: 30_000,
  pokeCooldownMs: 45_000,
  /** Left alone, but not yet asleep: the beat before she gives up. */
  neglectedAfterMs: 5 * 60_000,
  neglectedCooldownMs: 10 * 60_000,
};

/** How long each reaction stays on screen. Long enough to actually notice. */
const TEMPER_REACTION_MS = 4500;

/** Extra lines the temper uses, kept beside it so they travel together. */
const TEMPER_MUTTERS = {
  annoyed: [
    '……你一次问这么多，我怎么答得过来。',
    '停停停，一个一个来。',
    '哼，真当奶奶我是随叫随到的？',
    '你慢点说，我又不会跑。',
    '……问题太多，我拒绝回答。',
    '一次问一件事，这是规矩。',
    '哼，催什么催。',
  ],
  dizzyComplaint: [
    '别晃我！脑袋要晕了。',
    '你再拎着我转，我可要生气了。',
    '……放我下来。',
    '喂！我可不是沙袋。',
    '再晃一下试试。',
    '……我年纪大了，经不起这么折腾。',
    '唔……头晕。',
  ],
  smug: [
    '行了行了，我知道我很好看。',
    '哼，看够了没有。',
    '……再摸一下我可要收钱了。',
    '怎么，看入迷了？',
    '嗯，允许你多看两眼。',
    '哼，眼光不错。',
    '……别以为夸我我就会高兴。',
  ],
  lonely: [
    '……人呢。',
    '一个人待着，也挺无聊的。',
    '哼，反正你也不理我。',
    '……你忙你的吧，我没事。',
    '喂，我在这儿呢。',
    '工作比我好看，是吗。',
    '……算了，我自己看书。',
  ],
};

// The temper's lines are ordinary mutter pools from `mutter()`'s point of view,
// so fold them into the same table rather than special-casing the lookup.
Object.assign(MUTTERS, TEMPER_MUTTERS);

export class Temper {
  /**
   * @param {object} deps
   * @param {(state:string, ms:number) => void} deps.react emotional overlay
   * @param {(kind:string, chance:number) => void} deps.mutter
   */
  constructor({ react, mutter }) {
    this.react = react;
    this.mutter = mutter;
    this.events = { chat: [], drag: [], poke: [] };
    this.cooldowns = {};
    this.lastInteractionAt = clock();
  }

  /**
   * Register an interaction and, if the pattern warrants it, react.
   *
   * @param {'chat'|'drag'|'poke'} kind
   * @returns {string|null} the emotional state it triggered, or null.
   *   The caller needs to know: reacting *and* showing the ordinary
   *   click/drag/thinking feedback meant the feedback overwrote the emotion in
   *   the same frame, so the temper was never visible at all.
   */
  note(kind, now = clock()) {
    this.lastInteractionAt = now;
    const burst = TEMPER[`${kind}Burst`];
    const window = TEMPER[`${kind}WindowMs`];
    const cooldown = TEMPER[`${kind}CooldownMs`];
    const list = this.events[kind];
    if (!list || !burst) return null;

    list.push(now);
    while (list.length && now - list[0] > window) list.shift();
    if (list.length < burst) return null;
    if (now - (this.cooldowns[kind] || -1e9) < cooldown) return null;

    this.cooldowns[kind] = now;
    list.length = 0;

    let emotion = null;
    let pool = null;
    if (kind === 'chat') {
      emotion = 'furious';
      pool = 'annoyed';
    } else if (kind === 'drag') {
      emotion = 'angry';
      pool = 'dizzyComplaint';
    } else {
      emotion = 'proud';
      pool = 'smug';
    }
    this.react(emotion, TEMPER_REACTION_MS);
    this.mutter(pool, 1);
    return emotion;
  }

  /** Called from the behaviour tick; fires at most once per cooldown. */
  checkNeglect(now = clock()) {
    if (now - this.lastInteractionAt < TEMPER.neglectedAfterMs) return false;
    if (now - (this.cooldowns.neglect || -1e9) < TEMPER.neglectedCooldownMs) return false;
    this.cooldowns.neglect = now;
    this.react('hurt', TEMPER_REACTION_MS);
    this.mutter('lonely', 1);
    return true;
  }
}

export { MUTTERS, POSES, TEMPER_MUTTERS };

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
