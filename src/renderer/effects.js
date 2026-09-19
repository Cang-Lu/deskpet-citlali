/**
 * Per-state ambient effects drawn around the sprite.
 *
 * Effects are deliberately cheap: a small particle pool plus a soft aura, all
 * drawn on the same canvas as the pet so there is only one compositing layer.
 */

const PALETTE = {
  ice: '#bfe6f5',
  gold: '#ffd98a',
  warm: '#ff9f7a',
  red: '#ff6b6b',
  white: '#ffffff',
  night: '#8ea8ff',
};

/**
 * Mood tints, as `[r, g, b, alpha]`.
 *
 * Off by default, and the reason is measurable rather than aesthetic taste:
 * her cushion is one large near-white area, so even 0.13 shifts its blue
 * channel by ~11/255, which reads as "the cushion turned cream" -- i.e. she
 * looks recoloured rather than lit. Mood is carried by the particle effects,
 * which never touch her palette. Enable with the "状态色调" setting if wanted.
 */
const AURAS = {
  none: null,
  sparkle: [255, 217, 138, 0.13],
  blush: [255, 150, 170, 0.13],
  rain: [110, 150, 215, 0.13],
  anger: [255, 90, 90, 0.13],
  sleep: [140, 150, 220, 0.11],
  focus: [150, 220, 255, 0.12],
};

/** Soft, centred gradient in sprite-local space; strongest over the body. */
function auraGradient(ctx, box, rgba, pulse) {
  const [r, g, b, a] = rgba;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height * 0.6;
  const radius = Math.max(box.width, box.height) * 0.62 * pulse;
  const gradient = ctx.createRadialGradient(cx, cy, radius * 0.08, cx, cy, radius);
  gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${a})`);
  gradient.addColorStop(0.7, `rgba(${r}, ${g}, ${b}, ${a * 0.55})`);
  gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  return gradient;
}

export class Effects {
  constructor() {
    this.kind = 'none';
    this.particles = [];
    this.time = 0;
    this.spawnAccumulator = 0;
    /**
     * Optional colour cast on the character. Off by default: see the note on
     * `moodTint` in the config, and `MAX_TINT_SHIFT` below.
     */
    this.tintEnabled = false;
  }

  set(kind) {
    const next = kind || 'none';
    if (next === this.kind) return;
    this.kind = next;
    this.particles.length = 0;
    this.spawnAccumulator = 0;
  }

  /** @param {{x:number,y:number,width:number,height:number}} box sprite rect in CSS px */
  update(dt, box) {
    this.time += dt;

    const rate = spawnRate(this.kind);
    if (rate > 0 && box) {
      this.spawnAccumulator += dt * rate;
      while (this.spawnAccumulator >= 1) {
        this.spawnAccumulator -= 1;
        this.particles.push(this.makeParticle(box));
      }
    }

    for (let i = this.particles.length - 1; i >= 0; i -= 1) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += p.gravity * dt;
      p.rotation += p.spin * dt;
    }

    // Keep the pool bounded even if the app is left running for hours.
    if (this.particles.length > 220) this.particles.splice(0, this.particles.length - 220);
  }

  makeParticle(box) {
    const left = box.x;
    const right = box.x + box.width;
    const top = box.y;
    const bottom = box.y + box.height;

    switch (this.kind) {
      case 'sparkle':
        return {
          x: left + Math.random() * box.width,
          y: bottom - Math.random() * box.height * 0.75,
          vx: (Math.random() - 0.5) * 26,
          vy: -22 - Math.random() * 30,
          gravity: -6,
          life: 0.9 + Math.random() * 0.7,
          maxLife: 1.6,
          size: 2 + Math.random() * 3,
          color: Math.random() < 0.5 ? PALETTE.gold : PALETTE.ice,
          shape: 'star',
          rotation: Math.random() * Math.PI,
          spin: (Math.random() - 0.5) * 6,
        };
      case 'rain':
        return {
          x: left + Math.random() * box.width,
          y: top + Math.random() * box.height * 0.4,
          vx: -6 - Math.random() * 10,
          vy: 90 + Math.random() * 70,
          gravity: 40,
          life: 0.7 + Math.random() * 0.4,
          maxLife: 1.1,
          size: 1.6 + Math.random() * 1.6,
          color: PALETTE.night,
          shape: 'drop',
          rotation: 0,
          spin: 0,
        };
      case 'anger':
        return {
          x: right - box.width * 0.22 + Math.random() * 10,
          y: top + box.height * 0.16,
          vx: 12 + Math.random() * 20,
          vy: -26 - Math.random() * 16,
          gravity: 0,
          life: 0.5 + Math.random() * 0.35,
          maxLife: 0.85,
          size: 3 + Math.random() * 3,
          color: Math.random() < 0.6 ? PALETTE.red : PALETTE.warm,
          shape: 'puff',
          rotation: 0,
          spin: 0,
        };
      case 'sleep':
        return {
          x: right - box.width * 0.2 + Math.random() * 8,
          y: top + box.height * 0.2,
          vx: 8 + Math.random() * 10,
          vy: -16 - Math.random() * 10,
          gravity: -2,
          life: 1.4 + Math.random() * 0.8,
          maxLife: 2.2,
          size: 9 + Math.random() * 6,
          color: PALETTE.ice,
          shape: 'z',
          rotation: 0,
          spin: 0,
        };
      case 'focus':
        return {
          x: left + Math.random() * box.width,
          y: top + Math.random() * box.height * 0.5,
          vx: (Math.random() - 0.5) * 12,
          vy: 18 + Math.random() * 22,
          gravity: 0,
          life: 0.6 + Math.random() * 0.5,
          maxLife: 1.1,
          size: 1.8 + Math.random() * 2,
          color: PALETTE.ice,
          shape: 'dot',
          rotation: 0,
          spin: 0,
        };
      case 'blush':
        return {
          x: left + Math.random() * box.width,
          y: top + box.height * 0.55 + Math.random() * 20,
          vx: (Math.random() - 0.5) * 14,
          vy: -10 - Math.random() * 12,
          gravity: 0,
          life: 0.8 + Math.random() * 0.5,
          maxLife: 1.3,
          size: 2.5 + Math.random() * 2.5,
          color: '#ffa8bd',
          shape: 'dot',
          rotation: 0,
          spin: 0,
        };
      default:
        return {
          x: left, y: top, vx: 0, vy: 0, gravity: 0, life: 0.01, maxLife: 0.01,
          size: 1, color: PALETTE.white, shape: 'dot', rotation: 0, spin: 0,
        };
    }
  }

  /**
   * Draw the ambient layer.
   *
   * Must be called AFTER the sprite, because the mood aura is clipped to the
   * sprite's own silhouette with `source-atop`.
   *
   * That clipping is the whole point: an earlier version painted a large
   * `lighter`-composited radial glow behind her. On a dark desktop it read as a
   * tasteful ambient light, but on a light desktop it filled the window with a
   * grey wash that looked like a broken background -- the glow measured ~231
   * against a 255 desktop at its centre. Confining it to the silhouette means
   * the mood is still visible on her body and can never bleed into the desktop.
   */
  draw(ctx, box) {
    const aura = this.tintEnabled ? AURAS[this.kind] : null;
    if (aura && box) {
      // Gentle breathing pulse so the tint never looks like a static overlay.
      const pulse = 1 + Math.sin(this.time * 2.2) * 0.06;
      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = auraGradient(ctx, box, aura, pulse);
      ctx.fillRect(box.x, box.y, box.width, box.height);
      ctx.restore();
    }

    ctx.save();
    for (const p of this.particles) {
      const t = Math.max(0, Math.min(1, p.life / p.maxLife));
      ctx.globalAlpha = p.shape === 'drop' ? Math.min(1, t * 1.4) : t;
      ctx.fillStyle = p.color;

      switch (p.shape) {
        case 'star':
          drawStar(ctx, p.x, p.y, p.size * (0.6 + t * 0.6), p.rotation);
          break;
        case 'drop':
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, p.size * 0.7, p.size * 1.9, 0, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'puff':
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'z':
          ctx.font = `700 ${p.size}px "Segoe UI", system-ui, sans-serif`;
          ctx.fillText('z', p.x, p.y);
          break;
        default:
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
      }
    }
    ctx.restore();
  }
}

function spawnRate(kind) {
  switch (kind) {
    case 'sparkle': return 14;
    case 'rain': return 18;
    case 'anger': return 10;
    case 'sleep': return 1.6;
    case 'focus': return 9;
    case 'blush': return 6;
    default: return 0;
  }
}

function drawStar(ctx, cx, cy, radius, rotation) {
  ctx.beginPath();
  for (let i = 0; i < 8; i += 1) {
    const angle = rotation + (i * Math.PI) / 4;
    const r = i % 2 === 0 ? radius : radius * 0.38;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}
