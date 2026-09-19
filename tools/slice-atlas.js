// QA + asset helper.
//
//   npm run slice
//
// Produces:
//   .qa/rows/row-NN.png        one 2x strip per animation row, for eyeballing
//   assets/citlali/tray.png    the tray icon cropped from the idle pose
//
// Chromium does the WebP decoding inside a renderer: Electron's `nativeImage`
// cannot decode WebP, and the tray icon must be a format it *can* read.
'use strict';

const { app, BrowserWindow, protocol, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const LOG = path.join(ROOT, '.qa', 'slice.log');
const OUT_DIR = path.join(ROOT, '.qa', 'rows');
const TRAY_OUT = path.join(ROOT, 'assets', 'citlali', 'tray.png');

const APP_SCHEME = 'deskpet';
const APP_ORIGIN = `${APP_SCHEME}://app`;

const COLS = 8;
const ROWS = 11;
const SCALE = 2;
const TRAY_SIZE = 32;
/** electron-builder derives the Windows .ico from this. */
const ICON_SIZE = 256;

const LABELS = [
  'row-00-idle', 'row-01-running-right', 'row-02-running-left', 'row-03-waving',
  'row-04-jumping', 'row-05-failed', 'row-06-waiting', 'row-07-running-working',
  'row-08-review', 'row-09-look-000-157', 'row-10-look-180-337',
];

function log(message) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `${message}\n`);
  } catch { /* best effort */ }
  console.log(message);
}

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

app.setPath('userData', path.join(ROOT, '.electron-userdata'));
app.setPath('crashDumps', path.join(ROOT, '.electron-userdata', 'crash'));
app.disableHardwareAcceleration();

process.on('uncaughtException', (err) => {
  log(`uncaught: ${err && err.stack ? err.stack : err}`);
  app.exit(1);
});

log(`boot pid=${process.pid} argv=${process.argv.slice(1).join(' ')}`);

app.whenReady().then(async () => {
  log('ready');
  try {
    await run();
  } catch (err) {
    log(`failed: ${err && err.stack ? err.stack : err}`);
    app.exit(1);
  }
});

async function run() {
  log('registering protocol handler');
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    const target = path.resolve(ROOT, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
    if (!target.startsWith(ROOT)) return new Response('forbidden', { status: 403 });
    if (!fs.existsSync(target)) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(target).toString());
  });
  log('protocol handler registered');

  const win = new BrowserWindow({
    width: 200,
    height: 200,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  log('window created');

  await win.loadURL(`${APP_ORIGIN}/tools/atlas-slicer.html`);
  log('slicer page loaded');

  const result = await win.webContents.executeJavaScript(
    `window.slice(${JSON.stringify({
      atlasUrl: `${APP_ORIGIN}/assets/citlali/spritesheet.webp`,
      cols: COLS,
      rows: ROWS,
      labels: LABELS,
      scale: SCALE,
      traySize: TRAY_SIZE,
      iconSize: ICON_SIZE,
    })})`,
  );

  log(`atlas: ${result.width}x${result.height}, cell ${result.cellWidth}x${result.cellHeight}`);
  if (result.cellWidth !== 192 || result.cellHeight !== 208) {
    log(`WARNING: expected a 192x208 cell grid`);
  }

  // Frame counts are measured, not assumed: trailing cells in this atlas are
  // frequently empty, and animating into one reads as a glitch.
  const coverage = await win.webContents.executeJavaScript(
    `window.analyze(${JSON.stringify({
      atlasUrl: `${APP_ORIGIN}/assets/citlali/spritesheet.webp`,
      cols: COLS,
      rows: ROWS,
    })})`,
  );

  const MIN_COVERAGE = 0.02;
  const frameCounts = [];
  log('');
  log('row  animation            frames  per-cell opaque coverage');
  for (let r = 0; r < ROWS; r += 1) {
    const row = coverage[r];
    let last = 0;
    for (let c = 0; c < COLS; c += 1) if (row[c] >= MIN_COVERAGE) last = c + 1;
    frameCounts.push(last);
    log(
      `${String(r).padStart(3)}  ${LABELS[r].replace(/^row-\d+-/, '').padEnd(20)} ${String(last).padStart(5)}   ${row.map((v) => v.toFixed(3)).join(' ')}`,
    );
  }
  log('');
  log(`frameCounts=${JSON.stringify(frameCounts)}`);

  fs.writeFileSync(
    path.join(ROOT, '.qa', 'atlas-frames.json'),
    `${JSON.stringify({ frameCounts, coverage }, null, 2)}\n`,
  );

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const strip of result.strips) {
    const file = path.join(OUT_DIR, `${strip.label}.png`);
    fs.writeFileSync(file, Buffer.from(strip.dataUrl.split(',')[1], 'base64'));
    log(`wrote ${path.relative(ROOT, file)}`);
  }

  const lookSheet = await win.webContents.executeJavaScript(
    `window.lookSheet(${JSON.stringify({
      atlasUrl: `${APP_ORIGIN}/assets/citlali/spritesheet.webp`,
      cols: COLS,
      scale: 1.1,
    })})`,
  );
  const lookFile = path.join(ROOT, '.qa', 'look-directions.png');
  fs.writeFileSync(lookFile, Buffer.from(lookSheet.split(',')[1], 'base64'));
  log(`wrote ${path.relative(ROOT, lookFile)}`);

  /* ---- which way does each gaze cell actually face? ---- */

  const bias = await win.webContents.executeJavaScript(
    `window.eyeBias(${JSON.stringify({
      atlasUrl: `${APP_ORIGIN}/assets/citlali/spritesheet.webp`,
      cols: COLS,
      headFraction: 0.45,
      cushionFraction: 0.66,
    })})`,
  );
  log('');
  log('index  eye px  cushion px  eye x   cushion x  delta');
  for (const r of bias) {
    log(`  ${String(r.index).padStart(2)}   ${String(r.eyePixels).padStart(6)}  ${String(r.cushionPixels).padStart(10)}  ` +
      `${String(r.eyeCentre).padStart(6)}  ${String(r.origin).padStart(9)}  ${String(r.bias).padStart(6)}`);
  }
  fs.writeFileSync(path.join(ROOT, '.qa', 'gaze-bias.json'), `${JSON.stringify(bias, null, 2)}\n`);
  log('');
  log('!! Do NOT read a facing direction out of these numbers. They are kept');
  log('!! only as a record of a failed heuristic: the "eye" classifier picks up');
  log('!! her hair shading, not her irises (see .qa/eye-mask.png, where the red');
  log('!! mask covers her whole head of hair and none of her eyes).');
  log('!!');
  log('!! The authoritative left/right check is the rendered app: `npm run');
  log('!! selftest` writes .qa/gaze-cursor-right.png and .qa/gaze-cursor-left.png.');

  const maskSheet = await win.webContents.executeJavaScript(
    `window.eyeMaskSheet(${JSON.stringify({
      atlasUrl: `${APP_ORIGIN}/assets/citlali/spritesheet.webp`,
      cols: COLS,
      headFraction: 0.45,
      indices: [0, 4, 12],
      scale: 2.5,
    })})`,
  );
  const maskFile = path.join(ROOT, '.qa', 'eye-mask.png');
  fs.writeFileSync(maskFile, Buffer.from(maskSheet.split(',')[1], 'base64'));
  log(`wrote ${path.relative(ROOT, maskFile)}  (red = pixels classified as eyes)`);

  /* ---- how much does the head swing in each row? ---- */

  const motion = await win.webContents.executeJavaScript(
    `window.motionProfile(${JSON.stringify({
      atlasUrl: `${APP_ORIGIN}/assets/citlali/spritesheet.webp`,
      cols: COLS,
      headFraction: 0.4,
    })})`,
  );
  log('');
  log('row  animation            frames  avg changed px  peak  widest span');
  const motionLabels = ['idle', 'running-right', 'running-left', 'waving', 'jumping',
    'failed', 'waiting', 'running-working', 'review', 'look-000-157', 'look-180-337'];
  const animationRows = motion.filter((r) => r.row <= 8);
  const ranked = [...animationRows].sort((a, b) => b.avgChanged - a.avgChanged);
  for (const r of motion) {
    const bar = '#'.repeat(Math.min(40, Math.round(r.avgChanged / 40)));
    log(`  ${String(r.row).padStart(2)}  ${motionLabels[r.row].padEnd(20)} ${String(r.pairs).padStart(6)}  ` +
      `${String(r.avgChanged).padStart(14)}  ${String(r.peakChanged).padStart(4)}  ${String(r.widestSpan).padStart(6)}  ${bar}`);
  }
  log(`  -> most movement among the 9 animation rows: row ${ranked[0].row} ` +
    `(${motionLabels[ranked[0].row]}) with ${ranked[0].avgChanged} px changing per frame pair`);
  fs.writeFileSync(path.join(ROOT, '.qa', 'motion-profile.json'), `${JSON.stringify(motion, null, 2)}\n`);

  /* ---- full animation reference sheet ---- */

  const NOTES = [
    ['idle', 'Lying on the cushion with a novel. Gentle breathing and blinks. One of the calmest rows.', 'used for: lying / reading / asleep'],
    ['running-right', 'A seated sway. Played while she travels right.', 'used for: walking right'],
    ['running-left', 'The same, mirrored.', 'used for: walking left'],
    ['waving', 'Lying down, raising a hand. Only 4 frames.', 'used for: greeting / clicking her'],
    ['jumping', 'Lying down, a small hop. 5 frames.', 'used for: happy / excited'],
    ['failed', 'Sitting up, head bowed, then glancing up.', 'used for: sad / angry'],
    ['waiting', 'Sitting and nodding off, one nod at a time.', 'used for: dozing (≤5s, brief)'],
    ['running-working', 'Lying with the novel, slightly busier than idle.', 'used for: thinking / awaiting a reply'],
    ['review', 'Sitting up and swinging the head left-right. The most movement of any row, ~2x idle.', 'time-limited to 7s; never a long rest'],
    ['look-000-157', 'Seated; head turning up -> up-right -> right -> down-right (8 directions).', 'used for: gaze tracking (cursor above)'],
    ['look-180-337', 'Continues: down -> down-left -> left -> up-left (8 directions).', 'used for: gaze tracking (cursor below)'],
  ];
  const sheet = await win.webContents.executeJavaScript(
    `window.animationSheet(${JSON.stringify({
      atlasUrl: `${APP_ORIGIN}/assets/citlali/spritesheet.webp`,
      cols: COLS,
      scale: 0.72,
      labelWidth: 340,
      notes: NOTES,
    })})`,
  );
  const docsDir = path.join(ROOT, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  const sheetFile = path.join(docsDir, 'animations.png');
  fs.writeFileSync(sheetFile, Buffer.from(sheet.split(',')[1], 'base64'));
  log(`wrote ${path.relative(ROOT, sheetFile)}  (all 11 rows with the state mapping)`);

  for (const row of [0, 6, 8]) {
    const strip = await win.webContents.executeJavaScript(
      `window.headStrip(${JSON.stringify({
        atlasUrl: `${APP_ORIGIN}/assets/citlali/spritesheet.webp`,
        cols: COLS,
        row,
        scale: 2,
        headFraction: 0.42,
      })})`,
    );
    const file = path.join(ROOT, '.qa', `head-strip-row-${String(row).padStart(2, '0')}.png`);
    fs.writeFileSync(file, Buffer.from(strip.split(',')[1], 'base64'));
    log(`wrote ${path.relative(ROOT, file)}`);
  }

  const heads = await win.webContents.executeJavaScript(
    `window.zoomSheet(${JSON.stringify({
      atlasUrl: `${APP_ORIGIN}/assets/citlali/spritesheet.webp`,
      cols: COLS,
      indices: [0, 2, 4, 6, 8, 10, 12, 14],
      grid: 4,
      scale: 2.4,
      cropTop: 0.58,
    })})`,
  );
  const headsFile = path.join(ROOT, '.qa', 'look-heads.png');
  fs.writeFileSync(headsFile, Buffer.from(heads.split(',')[1], 'base64'));
  log(`wrote ${path.relative(ROOT, headsFile)}`);

  /* ---- alpha / fringe audit ---- */

  const auditArgs = JSON.stringify({
    atlasUrl: `${APP_ORIGIN}/assets/citlali/spritesheet.webp`,
    cols: COLS,
    buckets: 16,
  });

  for (const [row, col, label] of [[0, 0, 'idle-reading'], [9, 0, 'seated-look']]) {
    const audit = await win.webContents.executeJavaScript(
      `window.alphaAudit(${JSON.stringify({ ...JSON.parse(auditArgs), row, col })})`,
    );
    log('');
    log(`--- alpha audit: ${label} (row ${row} col ${col}) ---`);
    log(`content box: ${JSON.stringify(audit.contentBox)} of ${audit.cell.width}x${audit.cell.height}`);
    log(`opaque pixels touching the cell border: ${audit.borderOpaquePixels}`);
    log('alpha range        pixels   mean RGB of those pixels');
    for (const b of audit.perBucket) {
      if (b.count === 0) continue;
      log(
        `${String(b.alphaFrom).padStart(3)}-${String(b.alphaTo).padEnd(3)}  ${String(b.count).padStart(9)}   ${b.meanRgb ? b.meanRgb.join(', ') : '-'}`,
      );
    }
  }

  const fringe = await win.webContents.executeJavaScript(
    `window.fringeProof(${JSON.stringify({
      atlasUrl: `${APP_ORIGIN}/assets/citlali/spritesheet.webp`,
      cols: COLS,
      row: 0,
      col: 0,
      scale: 2.2,
      pad: 10,
    })})`,
  );
  const fringeFile = path.join(ROOT, '.qa', 'fringe-proof.png');
  fs.writeFileSync(fringeFile, Buffer.from(fringe.split(',')[1], 'base64'));
  log('');
  log(`wrote ${path.relative(ROOT, fringeFile)}`);

  /* ---- defringe: prove the halo fix ---- */

  const clean = await win.webContents.executeJavaScript(
    `window.defringeAtlas(${JSON.stringify({
      atlasUrl: `${APP_ORIGIN}/assets/citlali/spritesheet.webp`,
      opts: { alphaCut: 250, rings: 2 },
    })})`,
  );
  log('');
  log(`defringe: ${clean.stats.bledPixels} edge pixels repainted from ` +
      `${clean.stats.opaqueCount} opaque sources in ${clean.stats.ms} ms`);

  await win.webContents.executeJavaScript(`window.__cleanAtlas = ${JSON.stringify(clean.dataUrl)}; true`);

  const fringeArgs = JSON.stringify({ cols: COLS, row: 0, col: 0, scale: 2.2, pad: 10 });
  const fringeAfter = await win.webContents.executeJavaScript(
    `window.fringeProof({ ...${fringeArgs}, atlasUrl: window.__cleanAtlas })`,
  );
  const fringeAfterFile = path.join(ROOT, '.qa', 'fringe-after.png');
  fs.writeFileSync(fringeAfterFile, Buffer.from(fringeAfter.split(',')[1], 'base64'));
  log(`wrote ${path.relative(ROOT, fringeAfterFile)}`);

  fs.writeFileSync(TRAY_OUT, Buffer.from(result.tray.split(',')[1], 'base64'));
  log(`wrote ${path.relative(ROOT, TRAY_OUT)}`);

  const iconDir = path.join(ROOT, 'build');
  fs.mkdirSync(iconDir, { recursive: true });
  const iconOut = path.join(iconDir, 'icon.png');
  fs.writeFileSync(iconOut, Buffer.from(result.icon.split(',')[1], 'base64'));
  log(`wrote ${path.relative(ROOT, iconOut)}  (${ICON_SIZE}x${ICON_SIZE}, used by electron-builder)`);

  app.exit(0);
}
