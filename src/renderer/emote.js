/**
 * Expressions painted over the sprite.
 *
 * This atlas has no angry, dizzy or blushing frames — only the nine animation
 * rows and the 16 gaze directions. Rather than leave her emotional range at
 * "whatever the nine rows happen to suggest", the missing expressions are
 * *derived*: the existing pose is kept, and a small set of symbols is drawn on
 * top of it in her own palette.
 *
 * Deriving them is a deliberate trade. Genuinely new pixel art would look
 * better, but it cannot be produced here, and reusing a pose with a tasteful
 * overlay reads far better than a badly drawn new one.
 *
 * Positions come from `faceAnchorFor(row)` rather than fixed offsets, and every
 * painter branches on `anchor.view`, because the atlas mixes a left-facing
 * profile (lying) with a frontal pose (seated). One visible cheek is not two.
 *
 * To swap in real art later, give the state a `clip` of its own instead of an
 * `emote`, and delete its entry from EMOTES.
 */

const INK = '#2b2233';
const BLUSH = 'rgba(255, 138, 156, 0.55)';
const ANGER = '#ff5a64';
const STEAM = 'rgba(255, 255, 255, 0.55)';
const WATER = 'rgba(150, 212, 245, 0.92)';

/** Cell-normalised point -> screen px. */
function at(box, nx, ny) {
  return { x: box.x + nx * box.width, y: box.y + ny * box.height };
}

/** A length in sprite heights -> px, so overlays scale with her. */
function u(box, scale) {
  return box.height * scale;
}

function fillEllipse(ctx, x, y, rx, ry, fill) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

/**
 * Soft patches on the cheeks — one in profile, two when she faces us.
 *
 * Wide and soft on purpose: at sprite scale a hard dot reads as damage, while a
 * diffuse patch reads as a flush. Alpha is deliberately low because her hair is
 * already pink; anything stronger tints the whole head.
 */
function blush(ctx, box, anchor, t, strength = 1) {
  const face = at(box, anchor.x, anchor.y);
  const rx = u(box, 0.030 * strength);
  const ry = u(box, 0.019 * strength);
  const spread = u(box, anchor.width * (anchor.view === 'profile' ? 0.30 : 0.34));
  const dy = u(box, 0.028);
  ctx.save();
  ctx.globalAlpha = 0.85 + 0.15 * Math.sin(t * 3.4);
  if (anchor.view === 'profile') {
    // Only the cheek turned towards us exists.
    fillEllipse(ctx, face.x - spread * 0.55, face.y + dy, rx, ry, BLUSH);
  } else {
    fillEllipse(ctx, face.x - spread, face.y + dy, rx, ry, BLUSH);
    fillEllipse(ctx, face.x + spread, face.y + dy, rx, ry, BLUSH);
  }
  ctx.restore();
}

/**
 * The four-lobed anger mark, popping in above her head.
 *
 * Each lobe is a filled teardrop plus a stem; the whole thing overshoots on the
 * first fifth of a second so it reads as a pulse rather than a sticker.
 */
function angerMark(ctx, box, anchor, t) {
  const pulse = 0.88 + 0.12 * Math.sin(t * 9);
  const pop = t < 0.22 ? 1.3 - 0.3 * (t / 0.22) : 1;
  const size = u(box, 0.105) * pulse * pop;
  // Directly above her head: the side placement kept landing on a hair bun, and
  // the empty space above her reads far better.
  const p = at(box, anchor.x + anchor.width * 0.35, anchor.top - 0.045);

  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Two passes: a pale one drawn larger, then the mark itself on top. Without
  // the underlay, flat red over near-black hair reads as a smudge.
  for (const pass of [{ k: 1.22, color: 'rgba(255,248,244,0.95)' }, { k: 1, color: ANGER }]) {
    ctx.save();
    ctx.scale(pass.k, pass.k);
    ctx.fillStyle = pass.color;
    ctx.strokeStyle = pass.color;
    for (let i = 0; i < 4; i += 1) {
      ctx.save();
      ctx.rotate((i * Math.PI) / 2 + Math.PI / 4);
      ctx.lineWidth = size * 0.20;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -size * 0.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -size);
      ctx.quadraticCurveTo(size * 0.34, -size * 0.72, 0, -size * 0.40);
      ctx.quadraticCurveTo(-size * 0.34, -size * 0.72, 0, -size);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }
  ctx.restore();
}

/** Puffs of steam rising off the top of her head. */
function steam(ctx, box, anchor, t) {
  const top = at(box, anchor.x, anchor.top + 0.02);
  ctx.save();
  for (let i = 0; i < 3; i += 1) {
    const phase = (t * 0.85 + i * 0.33) % 1;
    const rise = u(box, 0.13) * phase;
    const side = (i - 1) * u(box, 0.045);
    const r = u(box, 0.014) * (0.5 + phase * 1.2);
    ctx.globalAlpha = (1 - phase) * 0.8;
    fillEllipse(ctx, top.x + side, top.y - rise, r, r * 0.85, STEAM);
  }
  ctx.restore();
}

/** A droplet running down from her temple. */
function sweatDrop(ctx, box, anchor, t) {
  const p = at(box, anchor.x + anchor.width * 0.72, anchor.y - 0.055);
  const bob = Math.sin(t * 4) * u(box, 0.004);
  const r = u(box, 0.026);
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = WATER;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y - r * 1.6 + bob);
  ctx.quadraticCurveTo(p.x + r, p.y + bob, p.x, p.y + r * 0.7 + bob);
  ctx.quadraticCurveTo(p.x - r, p.y + bob, p.x, p.y - r * 1.6 + bob);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = u(box, 0.005);
  ctx.stroke();
  ctx.restore();
}

/** Four-point sparkles blooming and fading around her head. */
function sparkleBurst(ctx, box, anchor, t) {
  const head = at(box, anchor.x, anchor.y);
  const count = 6;
  ctx.save();
  ctx.fillStyle = '#ffe9a8';
  for (let i = 0; i < count; i += 1) {
    const phase = (t * 0.9 + i / count) % 1;
    const angle = (i / count) * Math.PI * 2 + t * 0.6;
    const radius = u(box, 0.15) * (0.5 + phase * 0.9);
    const x = head.x + Math.cos(angle) * radius;
    const y = head.y + Math.sin(angle) * radius * 0.65;
    const size = u(box, 0.030) * (1 - phase);
    if (size <= 0.3) continue;
    ctx.globalAlpha = 1 - phase;
    ctx.beginPath();
    ctx.moveTo(x, y - size);
    ctx.quadraticCurveTo(x, y, x + size, y);
    ctx.quadraticCurveTo(x, y, x, y + size);
    ctx.quadraticCurveTo(x, y, x - size, y);
    ctx.quadraticCurveTo(x, y, x, y - size);
    ctx.fill();
  }
  ctx.restore();
}

/** A rotating star above her head, for 得意. */
function prideStar(ctx, box, anchor, t) {
  const p = at(box, anchor.x - anchor.width * 0.55, anchor.top - 0.035);
  const r = u(box, 0.048) * (0.9 + 0.1 * Math.sin(t * 4));
  ctx.save();
  ctx.globalAlpha = 1;
  star(ctx, p.x, p.y, r, t * 0.9, '#ffd66e', 'rgba(120,85,20,0.6)');
  ctx.restore();
}

/** Stars orbiting her head while the world keeps spinning. */
function swirlStars(ctx, box, anchor, t) {
  // Held above the hairline rather than over it: pale gold on lavender hair is
  // nearly invisible, and the empty space is where they read best anyway.
  const head = at(box, anchor.x, anchor.top - 0.045);
  const count = 3;
  ctx.save();
  for (let i = 0; i < count; i += 1) {
    const angle = t * 3.4 + (i / count) * Math.PI * 2;
    const x = head.x + Math.cos(angle) * u(box, 0.14);
    const y = head.y + Math.sin(angle) * u(box, 0.030);
    const size = u(box, 0.030);
    ctx.globalAlpha = 0.45 + 0.55 * Math.sin(angle);
    star(ctx, x, y, size, angle * 0.4, '#ffe9a8', 'rgba(90,70,40,0.55)');
  }
  ctx.restore();
}

/** A five-point star with an outline, used for both the dizzy orbit and 得意. */
function star(ctx, x, y, r, rotation, fill, stroke) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.beginPath();
  for (let i = 0; i < 10; i += 1) {
    const radius = i % 2 === 0 ? r : r * 0.42;
    const angle = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const px = Math.cos(angle) * radius;
    const py = Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(1, r * 0.16);
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
  ctx.restore();
}

const PAINTERS = {
  blush,
  angerMark,
  steam,
  sweatDrop,
  sparkleBurst,
  prideStar,
  swirlStars,
};

/**
 * Every expression this module can draw.
 *
 * `layers` are painted in order, so a pose can combine a flush with steam.
 *
 * Dizziness is deliberately stars-only. Spirals drawn over her eyes were tried
 * and removed: her eyes are closed in every seated pose, so the spirals landed
 * on her eyelids rather than on her eyes, and the result read as a pair of
 * goggles rather than as dizziness. The wobble plus the orbiting stars carry
 * the state on their own.
 */
export const EMOTES = {
  blush: { layers: ['blush'] },
  // No facial layer. The cheek flush added for anger landed at the outer corner
  // of each eye rather than on her cheeks, where it read as a pair of red discs
  // stuck to her face. Same lesson as the watery eyes that used to be drawn for
  // hurt (below) and the spirals that were drawn for dizziness (above): a
  // derived mark on a pixel-art face has to line up with artwork it does not
  // know about, and when it misses it looks pasted on. The mark above her head
  // and the steam carry the state perfectly well.
  angry: { layers: ['angerMark', 'steam'] },
  dizzy: { layers: ['swirlStars'] },
  // hurt deliberately has no facial overlay: the pose she uses already
  // reads as tearful, and a second pair of watery eyes drawn on top landed on
  // her eyelids rather than on her eyes. The state is the whole expression.
  hurt: { layers: [] },
  proud: { layers: ['prideStar'] },
  delighted: { layers: ['blush', 'sparkleBurst'] },
  awkward: { layers: ['sweatDrop'] },
};

/**
 * Layer names for a name.
 *
 * Accepts either an emote (`'angry'`) or a single layer (`'angerMark'`), so the
 * self-test can measure one mark in isolation without it being polluted by the
 * rest of the composite.
 */
export function emoteLayers(name) {
  if (EMOTES[name]) return EMOTES[name].layers;
  return PAINTERS[name] ? [name] : [];
}

/**
 * Paint an expression.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} name an emote name, or a single layer name
 * @param {{x:number,y:number,width:number,height:number}} box sprite rect, CSS px
 * @param {{x:number,y:number,width:number,top:number,view:string}} anchor
 * @param {number} t seconds since the expression began
 */
export function drawEmote(ctx, name, box, anchor, t) {
  const layers = emoteLayers(name);
  if (!layers.length || !anchor) return;
  ctx.save();
  for (const layer of layers) {
    const painter = PAINTERS[layer];
    if (painter) painter(ctx, box, anchor, t);
  }
  ctx.restore();
}
