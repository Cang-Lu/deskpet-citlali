import {
  ATLAS,
  CELL,
  CLIPS,
  faceAnchorFor,
  lookCell,
  defringe,
} from '../shared/pet-spec.js';

/** Load an <img> and resolve once the bitmap is actually decoded. */
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`精灵图加载失败：${url}`));
    image.src = url;
  });
}

/**
 * Thin wrapper over the atlas bitmap that knows the 8x11 cell grid.
 *
 * The bitmap is normally an offscreen canvas rather than the decoded file,
 * because the source art needs its dark edge matte removed first (see
 * `defringe` in pet-spec.js). Without that pass every sprite carries a dirty
 * grey halo on light backgrounds.
 */
export class Atlas {
  constructor(source, { defringed = false, stats = null } = {}) {
    this.image = source;
    this.defringed = defringed;
    this.stats = stats;
    this.cols = ATLAS.cols;
    this.rows = ATLAS.rows;
    this.cellW = CELL.width;
    this.cellH = CELL.height;
    this.width = ATLAS.width;
    this.height = ATLAS.height;
  }

  /**
   * Where her face is in a given row, in cell-normalised coordinates.
   *
   * Facial overlays are positioned from this rather than from fixed offsets,
   * because the atlas mixes a left-facing profile with a frontal pose.
   */
  anchorFor(row) {
    return faceAnchorFor(row);
  }

  /**
   * @param {string} url
   * @param {{defringe?: boolean}} [opts] `defringe: false` keeps the raw pixels,
   *        which is only useful for comparing the two side by side.
   */
  static async load(url, { defringe: shouldDefringe = true } = {}) {
    const image = await loadImage(url);
    if (!shouldDefringe) return new Atlas(image);

    try {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const stats = defringe(imageData.data, canvas.width, canvas.height);
      ctx.putImageData(imageData, 0, 0);
      return new Atlas(canvas, { defringed: true, stats });
    } catch (err) {
      // A tainted canvas or a decode oddity must not stop the pet appearing.
      console.warn('[atlas] de-fringe skipped:', err.message);
      return new Atlas(image);
    }
  }

  /** Draw one cell, scaled into the destination rect. */
  draw(ctx, row, col, dx, dy, dw, dh) {
    ctx.drawImage(
      this.image,
      col * this.cellW,
      row * this.cellH,
      this.cellW,
      this.cellH,
      dx,
      dy,
      dw,
      dh,
    );
  }
}

/**
 * Draws atlas cells at arbitrary sizes.
 *
 * Two cases, and only two:
 *
 * - **Whole-number scale** (208, 416, 624 at 100%): nearest-neighbour straight
 *   from the source is exact, so every source pixel becomes a clean NxN block.
 * - **Anything else**: the source cell is drawn directly and the browser's
 *   high-quality filter interpolates it.
 *
 * There used to be a third path in between: rasterise into an offscreen buffer
 * at the next integer multiple, then scale that buffer down to the target. It
 * was meant to make intermediate sizes smooth, and it did the opposite. At a
 * target of 300 the buffer is a 2x *nearest* copy of the source -- hard 2x2
 * blocks -- and the final downscale only averages 1.39 buffer pixels, which is
 * **less than one source pixel**. The filter cannot cover the block edges, so
 * some source pixels claim one output pixel and their neighbours claim two.
 * On a large flat area like her cushion that reads as horizontal banding, and
 * because the artwork animates the bands appear to crawl up and down.
 *
 * Going straight from the source removes the block structure entirely: there is
 * nothing left for the filter to fail to hide.
 */
export class SpriteRenderer {
  constructor(atlas) {
    this.atlas = atlas;
  }

  /**
   * @param {CanvasRenderingContext2D} ctx destination context, already scaled by dpr
   * @param {{row:number, col:number}} cell
   * @param {{x:number, y:number, width:number, height:number}} box CSS pixels
   * @param {number} dpr
   * @param {number} [alpha]
   */
  drawCell(ctx, cell, box, dpr, alpha = 1) {
    const deviceW = Math.round(box.width * dpr);
    const deviceH = Math.round(box.height * dpr);
    const wholeNumber = deviceH > 0
      && deviceH % this.atlas.cellH === 0
      && deviceW % this.atlas.cellW === 0
      && deviceH / this.atlas.cellH === deviceW / this.atlas.cellW;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = !wholeNumber;
    ctx.imageSmoothingQuality = 'high';
    this.atlas.draw(ctx, cell.row, cell.col, box.x, box.y, box.width, box.height);
    ctx.restore();
  }
}

/** Name used before any clip has been requested. Must exist in CLIPS. */
const DEFAULT_CLIP = 'lyingRead';

/**
 * Frame-accurate clip player with cross-fading.
 *
 * `look` overrides the drawn cell with one of the 16 gaze directions; it is
 * cleared whenever a new clip is started so reactions always read correctly.
 *
 * Cross-fading matters more than usual for this atlas: it contains two
 * different body postures (lying down reading a novel, and sitting upright),
 * so hard-cutting between rows produces a visible pop.
 */
export class Animator {
  constructor(atlas) {
    this.atlas = atlas;
    this.clipName = DEFAULT_CLIP;
    this.frame = 0;
    this.elapsed = 0;
    this.done = false;
    this.look = null;
    this.speed = 1;
    this.fade = null;
    this.fadeDuration = 0.22;
  }

  /**
   * Never hand back undefined.
   *
   * A stale clip name used to throw while drawing the very first frame, which
   * meant the renderer died and the window stayed blank -- a far worse failure
   * than playing the wrong animation.
   */
  get clip() {
    return CLIPS[this.clipName] || CLIPS[DEFAULT_CLIP];
  }

  /** Snapshot the currently drawn cell so it can fade out. */
  beginFade(duration = this.fadeDuration) {
    const from = this.cell;
    this.fade = { row: from.row, col: from.col, remaining: duration, duration };
  }

  play(name, { restart = false } = {}) {
    if (!CLIPS[name]) return;
    if (this.clipName === name && !restart) return;
    this.beginFade();
    this.clipName = name;
    this.frame = 0;
    this.elapsed = 0;
    this.done = false;
    this.look = null;
  }

  /** Restart the current clip from frame 0 even if it is the same clip. */
  replay(name = this.clipName) {
    this.play(name, { restart: true });
  }

  setLook(directionIndex) {
    const next = directionIndex == null ? null : directionIndex;
    // Only fade when switching between the gaze rows and the animation rows;
    // sliding between two gaze cells is continuous rotation, not a cut.
    if ((this.look == null) !== (next == null)) this.beginFade(0.18);
    this.look = next;
  }

  /** True while a one-shot clip is still playing. */
  get busy() {
    return !this.clip.loop && !this.done;
  }

  update(dtSeconds) {
    if (this.fade) {
      this.fade.remaining -= dtSeconds;
      if (this.fade.remaining <= 0) this.fade = null;
    }

    const clip = this.clip;
    if (!clip.loop && this.done) return;

    this.elapsed += dtSeconds * this.speed;
    const secondsPerFrame = 1 / clip.fps;

    // Guard against huge dt (window was hidden) so we never spin here.
    let guard = 64;
    while (this.elapsed >= secondsPerFrame && guard-- > 0) {
      this.elapsed -= secondsPerFrame;
      this.frame += 1;
      if (this.frame >= clip.frames) {
        if (clip.loop) {
          this.frame = 0;
        } else {
          this.frame = clip.frames - 1;
          this.done = true;
          break;
        }
      }
    }
  }

  get cell() {
    if (this.look != null) return lookCell(this.look);
    return { row: this.clip.row, col: this.frame };
  }

  /** Opacity of the outgoing cell, 0 when there is nothing to fade. */
  get fadeAlpha() {
    if (!this.fade) return 0;
    return Math.max(0, Math.min(1, this.fade.remaining / this.fade.duration));
  }
}
