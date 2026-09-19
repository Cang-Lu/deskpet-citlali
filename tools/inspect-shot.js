// Crop and zoom regions of a screenshot so small UI details can be identified.
//
//   electron tools/inspect-shot.js <source.png> <outDir>
'use strict';

const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const source = process.argv[2];
const outDir = process.argv[3] || path.resolve('.qa/inspect');
const LOG = path.resolve('.qa/inspect.log');

function log(message) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `${message}\n`);
  } catch { /* best effort */ }
  console.log(message);
}

app.setPath('userData', path.resolve('.electron-userdata'));
app.setPath('crashDumps', path.resolve('.electron-userdata/crash'));
app.disableHardwareAcceleration();

process.on('uncaughtException', (err) => {
  log(`uncaught: ${err && err.stack ? err.stack : err}`);
  app.exit(1);
});

/** Regions chosen to answer "is this our UI or another app's window?" */
const REGIONS = [
  { name: 'full', x: 0, y: 0, w: 507, h: 617, scale: 1.6 },
  { name: 'bottom-left-controls', x: 0, y: 380, w: 200, h: 237, scale: 3 },
  { name: 'right-edge', x: 420, y: 60, w: 87, h: 500, scale: 2.4 },
  { name: 'left-text', x: 0, y: 230, w: 140, h: 180, scale: 3 },
  { name: 'top-strip', x: 40, y: 80, w: 440, h: 120, scale: 2 },
];

app.whenReady().then(() => {
  fs.mkdirSync(outDir, { recursive: true });
  const image = nativeImage.createFromPath(source);
  const size = image.getSize();
  log(`source: ${source}`);
  log(`size: ${size.width}x${size.height} empty=${image.isEmpty()}`);
  if (image.isEmpty()) {
    app.exit(1);
    return;
  }

  for (const r of REGIONS) {
    const x = Math.min(r.x, size.width - 1);
    const y = Math.min(r.y, size.height - 1);
    const w = Math.min(r.w, size.width - x);
    const h = Math.min(r.h, size.height - y);
    const cropped = image.crop({ x, y, width: w, height: h });
    const scaled = cropped.resize({
      width: Math.round(w * r.scale),
      height: Math.round(h * r.scale),
      quality: 'best',
    });
    const file = path.join(outDir, `${r.name}.png`);
    fs.writeFileSync(file, scaled.toPNG());
    log(`wrote ${path.relative(process.cwd(), file)}  (${w}x${h} @${r.scale}x)`);
  }

  // Sample a grid of pixels so the panel colours can be compared numerically.
  const bitmap = image.toBitmap(); // BGRA
  const at = (x, y) => {
    const i = (y * size.width + x) * 4;
    return [bitmap[i + 2], bitmap[i + 1], bitmap[i]];
  };

  log('');
  log('=== warmth of the bright neutral areas (the cushion, mostly) ===');
  log('bright = min(r,g,b) >= 170 and pixels that are not the pure-white desktop');
  {
    let r = 0; let g = 0; let b = 0; let n = 0;
    const buckets = new Map();
    for (let i = 0; i < size.width * size.height; i += 1) {
      const o = i * 4;
      const pr = bitmap[o + 2]; const pg = bitmap[o + 1]; const pb = bitmap[o];
      const min = Math.min(pr, pg, pb);
      const max = Math.max(pr, pg, pb);
      if (min < 170) continue;
      // Skip the flat white desktop, which would drown out the sprite.
      if (min >= 253 && max - min <= 1) continue;
      r += pr; g += pg; b += pb; n += 1;
      const key = `${Math.round(pr / 16)}-${Math.round(pb / 16)}`;
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    if (n > 0) {
      const mr = Math.round(r / n); const mg = Math.round(g / n); const mb = Math.round(b / n);
      log(`  samples=${n}  mean rgb = ${mr}, ${mg}, ${mb}   b-r = ${mb - mr}   g-r = ${mg - mr}`);
      log(mb - mr <= -6
        ? '  -> WARM cast detected (blue is suppressed)'
        : '  -> neutral / cool, no warm cast');
    } else {
      log('  no qualifying pixels');
    }
  }

  log('');
  log('=== region means (fractional boxes of the image) ===');
  const REGION_BOXES = [
    ['cushion centre', 0.42, 0.78, 0.58, 0.86],
    ['cushion left', 0.24, 0.8, 0.34, 0.87],
    ['hair left', 0.3, 0.45, 0.38, 0.52],
    ['background top-left', 0.02, 0.02, 0.12, 0.08],
  ];
  for (const [label, fx0, fy0, fx1, fy1] of REGION_BOXES) {
    const x0 = Math.round(fx0 * size.width);
    const y0 = Math.round(fy0 * size.height);
    const x1 = Math.round(fx1 * size.width);
    const y1 = Math.round(fy1 * size.height);
    let r = 0; let g = 0; let b = 0; let n = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const i = (y * size.width + x) * 4;
        r += bitmap[i + 2]; g += bitmap[i + 1]; b += bitmap[i]; n += 1;
      }
    }
    if (n === 0) continue;
    log(`  ${label.padEnd(20)} mean rgb = ${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)}  ` +
      `(b-r = ${Math.round(b / n) - Math.round(r / n)})`);
  }

  log('');
  log('=== luminance profile: where does the tint start and end? ===');
  log('(looking for the run of pixels that are lighter than pure white)');

  const nearWhite = (x, y) => {
    const [r, g, b] = at(x, y);
    return r >= 253 && g >= 253 && b >= 253;
  };

  for (const y of [110, 130, 150, 170, 200, 260, 320, 400, 480, 540, 570, 590, 605]) {
    // Walk in from both edges until the pixel stops being pure white.
    let left = -1;
    for (let x = 0; x < size.width; x += 1) {
      if (!nearWhite(x, y)) { left = x; break; }
    }
    let right = -1;
    for (let x = size.width - 1; x >= 0; x -= 1) {
      if (!nearWhite(x, y)) { right = x; break; }
    }
    const mid = at(Math.round(size.width / 2), y);
    log(`  y=${String(y).padStart(3)}  first non-white x=${String(left).padStart(3)}  last x=${String(right).padStart(3)}  centre rgb=${mid.join(',')}`);
  }

  log('');
  log('=== horizontal profile at y=300 (every 20px) ===');
  let line = '  ';
  for (let x = 0; x < size.width; x += 20) {
    line += `${String(x).padStart(4)}:${at(x, 300).join('/').padEnd(12)}`;
    if (line.length > 110) { log(line); line = '  '; }
  }
  log(line);

  app.exit(0);
});
