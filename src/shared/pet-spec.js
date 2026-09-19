/**
 * Sprite-atlas contract for the "Awesome Codex Pet" v2 format.
 *
 * Source package: legeling/awesome-codex-pet -> pets/citlali--zaytsevzy
 * Atlas: 1536x2288 lossless WebP, 8 columns x 11 rows, 192x208 per frame.
 *
 * Rows 0-8 are the nine standard animations. Rows 9-10 hold 16 clockwise
 * look directions, 22.5 degrees apart, starting at "up" and rotating toward
 * screen-right -- though this particular atlas ships them mirrored; see
 * LOOK_INDEX_MIRRORED below.
 */

export const ATLAS = { width: 1536, height: 2288, cols: 8, rows: 11 };

export const CELL = { width: 192, height: 208 };

/** How many distinct gaze directions live in rows 9-10. */
export const LOOK_DIRECTION_COUNT = 16;

/** Degrees between two neighbouring gaze cells. */
export const LOOK_STEP_DEG = 360 / LOOK_DIRECTION_COUNT;

/**
 * The published v2 contract numbers the gaze cells clockwise starting at "up":
 * 0 = up, 4 = screen-right, 8 = down, 12 = screen-left.
 *
 * This atlas follows that convention, so no correction is needed. The flag is
 * kept because a future pet may not.
 *
 * Getting here was messy, so the evidence is worth recording: an earlier
 * version set this to `true` on the strength of a hand-read contact sheet plus
 * an "eye centroid" metric. The metric turned out to be worthless -- rendering
 * its pixel mask (`.qa/eye-mask.png`, `npm run slice`) showed it classifying her
 * entire *hair* as eyes and none of her actual irises, because her hair shading
 * is dark and blue-dominant. The rendered app then plainly contradicted it:
 * with the cursor to the right she looked left.
 *
 * The authoritative check is therefore the rendered app itself: `npm run
 * selftest` writes `.qa/gaze-cursor-right.png` and `.qa/gaze-cursor-left.png`,
 * and she must face the cursor in both.
 */
export const LOOK_INDEX_MIRRORED = false;

/**
 * Map a clockwise look-direction index (0 = up, 4 = screen-right,
 * 8 = down, 12 = screen-left) onto the atlas cell that actually shows it.
 */
export function lookCell(directionIndex) {
  const canonical = ((Math.round(directionIndex) % LOOK_DIRECTION_COUNT) + LOOK_DIRECTION_COUNT)
    % LOOK_DIRECTION_COUNT;
  const atlas = LOOK_INDEX_MIRRORED
    ? (LOOK_DIRECTION_COUNT - canonical) % LOOK_DIRECTION_COUNT
    : canonical;
  return {
    row: 9 + Math.floor(atlas / ATLAS.cols),
    col: atlas % ATLAS.cols,
    index: atlas,
    canonical,
  };
}

/**
 * Standard animation rows.
 *
 * `frames` is NOT 8 across the board. The measured per-row frame counts of this
 * atlas (see `npm run slice`, which writes .qa/atlas-frames.json) are:
 *   [7, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8]
 * The artist only drew as many cells as each loop needed, so playing a blanket
 * 8 frames would flash empty cells. `fps` is tuned for a desktop pet;
 * `loop: false` clips hold their final frame until the state machine leaves.
 */
export const CLIPS = {
  /**
   * Clip names are deliberately row-neutral.
   *
   * The published row labels lie about the artwork -- row 8 is called `review`
   * but is a head swing, row 1 is called `running-right` but is a seated sway.
   * Naming clips after what the drawing actually does makes the mapping
   * readable instead of a guessing game.
   */
  lyingRead: { name: 'lyingRead', row: 0, frames: 7, fps: 5, loop: true },
  lyingIdle: { name: 'lyingIdle', row: 7, frames: 6, fps: 5, loop: true },
  // Walking. Slower than before: at 12fps it read as a hurried scurry.
  runRight: { name: 'runRight', row: 1, frames: 8, fps: 8, loop: true },
  runLeft: { name: 'runLeft', row: 2, frames: 8, fps: 8, loop: true },
  waving: { name: 'waving', row: 3, frames: 4, fps: 6, loop: false },
  jumping: { name: 'jumping', row: 4, frames: 5, fps: 7, loop: false },
  /** Seated, head down then glancing up. */
  seatedQuiet: { name: 'seatedQuiet', row: 5, frames: 8, fps: 6, loop: true },
  /** Seated, nodding off. */
  seatedNod: { name: 'seatedNod', row: 6, frames: 6, fps: 5, loop: true },
  /** Seated, looking around (a wide head swing). */
  seatedShake: { name: 'seatedShake', row: 8, frames: 6, fps: 6, loop: true },
};

/** Canonical row order, handy for QA tooling. */
export const ROW_ORDER = [
  'lyingRead',
  'runRight',
  'runLeft',
  'waving',
  'jumping',
  'seatedQuiet',
  'seatedNod',
  'lyingIdle',
  'seatedShake',
];

/**
 * How much each row actually moves, measured from the atlas.
 *
 * This is the average number of pixels that change between consecutive frames
 * (`npm run slice` prints the table and writes .qa/motion-profile.json). It is
 * here because a row's *name* tells you nothing about its motion.
 *
 * High-motion rows are not banned -- they are fine as short, deliberate
 * gestures. What they must never be is a long resting state, which is exactly
 * how `seatedShake` once made her look like she was shaking her head
 * non-stop. See `maxHoldMs` in state.js.
 */
export const ROW_MOTION = {
  lyingRead: 2190,
  runRight: 2408,
  runLeft: 2078,
  waving: 1981,
  jumping: 1981,
  seatedQuiet: 3307,
  seatedNod: 3180,
  lyingIdle: 2190,
  seatedShake: 4242,
};

/** Rows at or below this are calm enough to sit in for as long as she likes. */
export const CALM_MOTION_LIMIT = 2600;

/**
 * Convert a screen-space vector into a look-direction index.
 *
 * Screen space has +y pointing down, so "up" is a negative dy. The mapping is
 * defined so that (0, -1) -> 0, (1, 0) -> 4, (0, 1) -> 8, (-1, 0) -> 12.
 */
export function directionFromVector(dx, dy) {
  if (dx === 0 && dy === 0) return null;
  const degrees = (Math.atan2(dx, -dy) * 180) / Math.PI;
  const normalized = (degrees + 360) % 360;
  return Math.round(normalized / LOOK_STEP_DEG) % LOOK_DIRECTION_COUNT;
}

/**
 * Moods the language model may request. Each maps onto a clip plus a short
 * burst of ambient styling in the effects layer.
 *
 * The token list is duplicated in src/main/ai.js (MOOD_TOKENS) because that
 * module is CommonJS and this one is ESM. Keep the two in sync.
 */
export const MOODS = {
  neutral: { clip: 'lyingRead', hold: true, effect: 'none' },
  happy: { clip: 'jumping', hold: false, effect: 'sparkle' },
  excited: { clip: 'jumping', hold: false, effect: 'sparkle' },
  greeting: { clip: 'waving', hold: false, effect: 'sparkle' },
  shy: { clip: 'waving', hold: false, effect: 'blush' },
  thinking: { clip: 'lyingIdle', hold: true, effect: 'focus' },
  working: { clip: 'lyingIdle', hold: true, effect: 'focus' },
  sad: { clip: 'seatedQuiet', hold: false, effect: 'rain' },
  angry: { clip: 'seatedQuiet', hold: false, effect: 'anger' },
  sleepy: { clip: 'lyingRead', hold: true, effect: 'sleep' },
  surprised: { clip: 'jumping', hold: false, effect: 'sparkle' },
};

export const DEFAULT_MOOD = 'neutral';

/* ------------------------------------------------------------------ */
/* Rendering geometry                                                  */
/* ------------------------------------------------------------------ */

/** Sprite height in CSS pixels when the user has not chosen anything. */
export const DEFAULT_SPRITE_HEIGHT = 416;

export const MIN_SPRITE_HEIGHT = 96;
export const MAX_SPRITE_HEIGHT = 900;

/** Upper bound on the supersample buffer, to keep memory sane. */
const MAX_SUPERSAMPLE = 10;

/**
 * Fit a requested sprite height into the space actually available.
 * Aspect ratio is always the cell's, so she never distorts.
 */
export function fitSpriteSize({ targetHeight, maxWidth, maxHeight }) {
  let height = Math.min(targetHeight, maxHeight);
  let width = height * (CELL.width / CELL.height);
  if (width > maxWidth) {
    width = maxWidth;
    height = width * (CELL.height / CELL.width);
  }
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

/**
 * Integer factor at which to rasterise a cell before scaling it to size.
 *
 * Rasterising once at an integer multiple and then resampling that buffer is
 * what makes the size control genuinely continuous. At an exact multiple the
 * final blit is 1:1 and therefore pixel-perfect; everywhere in between the
 * sprite is supersampled and filtered down, which is far cleaner than
 * nearest-neighbour stretching from 192px -- that was what made the in-between
 * sizes look jagged, and why the old integer-snapping made the slider feel
 * like it only had a few steps.
 */
export function supersampleFactor({ targetHeight, dpr }) {
  const deviceHeight = Math.max(1, targetHeight * dpr);
  return Math.max(1, Math.min(MAX_SUPERSAMPLE, Math.ceil(deviceHeight / CELL.height)));
}

/**
 * Remove the dark matte baked into the atlas's anti-aliased edge pixels.
 *
 * The source art was matted against a dark background before its alpha was
 * extracted, so the semi-transparent rim carries dark RGB (measured mean
 * ~42,29,44 against ~183,167,185 for the opaque body). Composited over a light
 * desktop that reads as a dirty grey halo. Alpha is preserved; only RGB is
 * repainted, outward from the opaque body a couple of rings.
 *
 * @param {Uint8ClampedArray} data RGBA bytes, modified in place
 * @returns {{opaqueCount:number, bledPixels:number}}
 */
export function defringe(data, width, height, { alphaCut = 250, rings = 2 } = {}) {
  const n = width * height;
  const source = new Uint8ClampedArray(data);
  const state = new Uint8Array(n); // 0 = unresolved, 1 = opaque, >=2 = bled ring
  let opaqueCount = 0;

  for (let i = 0; i < n; i += 1) {
    if (source[i * 4 + 3] >= alphaCut) {
      state[i] = 1;
      opaqueCount += 1;
    }
  }

  const NEIGHBOURS = [-1, 1, -width, width, -width - 1, -width + 1, width - 1, width + 1];
  let bledPixels = 0;

  for (let ring = 2; ring < 2 + rings; ring += 1) {
    const pending = [];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        if (state[i] !== 0) continue;

        let r = 0;
        let g = 0;
        let b = 0;
        let hits = 0;
        for (let k = 0; k < NEIGHBOURS.length; k += 1) {
          const j = i + NEIGHBOURS[k];
          if (j < 0 || j >= n) continue;
          if (Math.abs((j % width) - x) > 1) continue; // no wrap across rows
          if (state[j] === 0) continue;
          const o = j * 4;
          r += source[o];
          g += source[o + 1];
          b += source[o + 2];
          hits += 1;
        }
        if (hits > 0) pending.push(i, r / hits, g / hits, b / hits);
      }
    }

    if (pending.length === 0) break;
    for (let p = 0; p < pending.length; p += 4) {
      const o = pending[p] * 4;
      data[o] = pending[p + 1];
      data[o + 1] = pending[p + 2];
      data[o + 2] = pending[p + 3];
      state[pending[p]] = ring;
      bledPixels += 1;
    }
  }

  // Alpha is never intentionally changed; restore it defensively.
  for (let i = 0; i < n; i += 1) data[i * 4 + 3] = source[i * 4 + 3];

  return { opaqueCount, bledPixels };
}
