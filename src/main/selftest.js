'use strict';

/**
 * Headless-ish smoke test.
 *
 *   npm run selftest
 *
 * Drives the real renderer through every animation state and screenshots each
 * one, so the visuals can be verified without a human watching the desktop.
 * Enabled by the DESKPET_SELFTEST environment variable.
 */

const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..', '..');
/**
 * Where screenshots and the report go.
 *
 * Overridable because in a packaged build the app lives inside a read-only
 * `app.asar`, so writing next to the source is impossible there.
 */
const QA_DIR = process.env.DESKPET_QA_DIR || path.join(ROOT, '.qa');
const OUT_DIR = path.join(QA_DIR, 'states');
const REPORT = path.join(QA_DIR, 'selftest.json');
/** Marker used to prove the renderer console capture is actually wired up. */
const PROBE = '__deskpet_console_probe__';

const STEPS = [
  { name: '00-idle', script: `__deskpet.setBase('idle')` },
  { name: '01-reading', script: `__deskpet.setBase('reading')` },
  { name: '02-sleepy', script: `__deskpet.setBase('sleepy')` },
  { name: '03-walking-right', script: `__deskpet.setBase('walkRight')` },
  { name: '04-walking-left', script: `__deskpet.setBase('walkLeft')` },
  { name: '05-seated-quiet', script: `__deskpet.setBase('seatedQuiet')` },
  { name: '05b-seated-shake', script: `__deskpet.setBase('seatedShake')` },
  { name: '05c-seated-nod', script: `__deskpet.setBase('seatedNod')` },
  { name: '05d-reading', script: `__deskpet.setBase('reading')` },
  { name: '06-thinking', script: `__deskpet.setBase('idle'); __deskpet.setOverlay('thinking')` },
  { name: '07-happy', script: `__deskpet.clearOverlay(); __deskpet.setOverlay('happy')` },
  { name: '08-greet', script: `__deskpet.setOverlay('greet')` },
  { name: '09-sad', script: `__deskpet.clearOverlay(); __deskpet.setOverlay('sad', { duration: 600000 })` },
  // Derived expressions. There is no art for these in the atlas, so the shots
  // double as a placement check for the overlays in emote.js.
  { name: '09b-angry', script: `__deskpet.clearOverlay(); __deskpet.emote('angry')` },
  { name: '09c-furious', script: `__deskpet.emote('furious')` },
  { name: '09d-hurt', script: `__deskpet.emote('hurt')` },
  { name: '09e-proud', script: `__deskpet.emote('proud')` },
  { name: '09f-delighted', script: `__deskpet.emote('delighted')` },
  { name: '09g-awkward', script: `__deskpet.emote('awkward')` },
  { name: '09h-dizzy', script: `__deskpet.emote('dizzy')` },
  { name: '10-gaze-right', script: `__deskpet.clearOverlay(); __deskpet.setBase('idle'); __deskpet.setLook(4)` },
  { name: '11-gaze-down-left', script: `__deskpet.setLook(9)` },
  { name: '12-bubble', script: `__deskpet.setLook(null); __deskpet.say('嗯？又是你啊。……别误会，我只是刚好醒着。', 'neutral')` },
  { name: '13-composer', script: `__deskpet.openComposer()` },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run({ app, pet, tray, config, openSettings, openHistory, rendererIssues }) {
  const log = [];
  // main.js owns the capture sink; fall back to a local one if it was not passed.
  const consoleErrors = rendererIssues || [];

  const write = (message) => {
    log.push(message);
    console.log(message);
  };

  const report = { ok: false, consoleErrors, steps: [], log };

  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.mkdirSync(QA_DIR, { recursive: true });

    if (!pet || !pet.win || pet.win.isDestroyed()) throw new Error('the pet window was never created');
    const wc = pet.win.webContents;

    write(`window: ${JSON.stringify(pet.win.getBounds())}, visible=${pet.win.isVisible()}`);
    write(`tray created: ${Boolean(tray && tray.tray)}`);
    write(`data dir: ${app.getPath('userData')}`);

    // Give the renderer time to load the atlas and run a few frames.
    await sleep(2500);

    const ready = await wc.executeJavaScript('Boolean(window.__deskpet)');
    if (!ready) throw new Error('the renderer never exposed window.__deskpet (boot failed)');
    write('renderer booted');

    // Establish a known baseline so the run is deterministic no matter what a
    // previous run (or the user) left in the settings file.
    await wc.executeJavaScript(`
      window.deskpet.saveSettings({
        sizePx: 416,
        renderMode: 'auto',
        defringe: true,
        moodTint: false,
        proactive: { enabled: true },
        balance: {
          enabled: true,
          intervalMinutes: 30,
          lowThreshold: 5,
          // Clear the de-duplication state so the reminder assertion below is
          // not suppressed by a previous run.
          warnedAt: 0,
          warnedForAmount: null,
        },
      })
    `);
    await sleep(700);
    await wc.executeJavaScript('__deskpet.pauseBehavior(true)');
    await sleep(300);
    write('baseline settings applied; autonomous behaviour paused');

    for (const step of STEPS) {
      await wc.executeJavaScript(step.script);
      await sleep(650);
      const info = await wc.executeJavaScript('window.__deskpet.info');
      const image = await wc.capturePage();
      const file = path.join(OUT_DIR, `${step.name}.png`);
      fs.writeFileSync(file, image.toPNG());
      report.steps.push({ name: step.name, info });
      write(`${step.name.padEnd(18)} clip=${info.clip.padEnd(9)} frame=${info.frame}/${info.frames} look=${info.look} effect=${info.effect} particles=${info.particles} bubble=${info.bubbleVisible}`);
    }

    // The atlas itself must be fully loaded and correctly sized.
    const atlasOk = await wc.executeJavaScript(`(() => {
      const box = window.__deskpet.info.petBox;
      return { width: box.width, height: box.height, dpr: window.devicePixelRatio };
    })()`);
    write(`pet box: ${atlasOk.width}x${atlasOk.height} @${atlasOk.dpr}x`);

    /* ---- explicit assertions ---- */

    // 1. A looping overlay with no duration must persist ("she is thinking").
    await wc.executeJavaScript(`__deskpet.clearOverlay(); __deskpet.setOverlay('thinking')`);
    await sleep(1800);
    const thinking = await wc.executeJavaScript('window.__deskpet.info');
    report.assertions = report.assertions || {};
    report.assertions.thinkingPersists = thinking.overlay === 'thinking';
    write(`assert thinking persists: ${report.assertions.thinkingPersists} (overlay=${thinking.overlay})`);
    await wc.executeJavaScript('__deskpet.clearOverlay()');

    // 2. Gaze mapping: canonical 4 = cursor to the screen-right. This atlas
    //    follows the documented convention (see LOOK_INDEX_MIRRORED), so it
    //    resolves to atlas index 4, i.e. row 9 column 4.
    const gazeRight = await wc.executeJavaScript(`(() => {
      __deskpet.setLook(4);
      return window.__deskpet.info.cell;
    })()`);
    report.assertions.gazeRightCell = gazeRight;
    report.assertions.gazeRightOk = gazeRight.row === 9 && gazeRight.col === 4;
    write(`assert gaze-right -> ${JSON.stringify(gazeRight)} ok=${report.assertions.gazeRightOk}`);

    const gazeLeft = await wc.executeJavaScript(`(() => {
      __deskpet.setLook(12);
      return window.__deskpet.info.cell;
    })()`);
    report.assertions.gazeLeftCell = gazeLeft;
    report.assertions.gazeLeftOk = gazeLeft.row === 10 && gazeLeft.col === 4;
    write(`assert gaze-left  -> ${JSON.stringify(gazeLeft)} ok=${report.assertions.gazeLeftOk}`);
    await wc.executeJavaScript('__deskpet.setLook(null)');

    // 3. The pet window must actually become visible.
    report.assertions.windowVisible = pet.win.isVisible();
    write(`assert window visible: ${report.assertions.windowVisible}`);

    // 4. Walking must physically move the window. Walk LEFT: the pet starts
    //    parked against the right edge of the work area, so walking right would
    //    immediately hit the clamp and prove nothing.
    const startX = pet.win.getPosition()[0];
    // Tap the walk completion callback to learn *why* it stopped, then put the
    // real handler back: overwriting it would break the renderer's pose release.
    const originalOnWalkDone = pet.onWalkDone;
    let walkReason = null;
    pet.onWalkDone = (info) => {
      walkReason = info && info.reason;
      if (originalOnWalkDone) originalOnWalkDone(info);
    };
    await wc.executeJavaScript(`window.deskpet.walk(${JSON.stringify({
      direction: -1, speed: 260, targetX: startX - 150,
    })})`);
    await sleep(1500);
    const endX = pet.win.getPosition()[0];
    pet.onWalkDone = originalOnWalkDone;
    report.assertions.walkFrom = startX;
    report.assertions.walkTo = endX;
    report.assertions.walkReason = walkReason;
    report.assertions.walkMoved = endX < startX - 100;
    write(`assert walk moved: ${report.assertions.walkMoved} ` +
      `(${startX} -> ${endX}, reason=${walkReason})`);

    // 4b. How expensive is moving a transparent window? If setPosition costs
    //     tens of milliseconds, a per-frame window walk can never be smooth and
    //     the movement has to happen inside the window instead.
    const benchStart = Date.now();
    const BENCH_N = 40;
    for (let i = 0; i < BENCH_N; i += 1) {
      pet.win.setPosition(startX - 200 + (i % 2), pet.win.getPosition()[1]);
    }
    const perCall = (Date.now() - benchStart) / BENCH_N;
    report.assertions.setPositionMs = Number(perCall.toFixed(2));
    write(`bench setPosition: ${perCall.toFixed(2)} ms/call`);
    pet.win.setPosition(startX, pet.win.getPosition()[1]);

    // 5. Optional: exercise the real HTTP + SSE path against DeepSeek with a
    //    deliberately invalid key, and check the error is reported cleanly.
    if (process.env.DESKPET_SELFTEST_NET) {
      const { writeApiKey } = require('./secrets');
      const original = config.get();
      config.update(writeApiKey('sk-selftest-invalid-key'));
      await wc.executeJavaScript(`
        window.__selftestChat = null;
        window.deskpet.onChatDone((payload) => { window.__selftestChat = payload; });
        window.deskpet.sendMessage('你好');
        true
      `);
      await sleep(12000);
      const chat = await wc.executeJavaScript('window.__selftestChat');
      report.assertions.chatError = chat ? { ok: chat.ok, error: chat.error } : null;
      // A real 401 from the API or a clear local message both count as handled.
      report.assertions.chatErrorHandled = Boolean(chat && !chat.ok && chat.error);
      write(`assert chat error handled: ${report.assertions.chatErrorHandled} -> ${chat && chat.error}`);
      config.update(writeApiKey(''));
      void original;
    }

    // 5c. Rendering quality: the atlas must be de-fringed, and in crisp mode
    //     the drawn sprite must land on whole device pixels.
    const quality = await wc.executeJavaScript(`(() => {
      const i = window.__deskpet.info;
      return {
        defringed: i.atlas.defringed,
        stats: i.atlas.stats,
        dpr: i.dpr,
        box: i.petBox,
        viewport: i.viewport,
        mode: i.settings.renderMode,
        sizePx: i.settings.sizePx,
        windowBounds: null,
      };
    })()`);
    quality.windowBounds = pet.win.getBounds();
    report.assertions.quality = quality;
    report.assertions.defringed = quality.defringed;
    report.assertions.defringeStats = quality.stats;
    write(`assert atlas de-fringed: ${quality.defringed} ${JSON.stringify(quality.stats)}`);
    write(`   sizePx=${quality.sizePx} viewport=${JSON.stringify(quality.viewport)} ` +
      `window=${JSON.stringify(quality.windowBounds)} box=${JSON.stringify(quality.box)} mode=${quality.mode}`);

    const deviceW = quality.box.width * quality.dpr;
    const deviceH = quality.box.height * quality.dpr;
    report.assertions.raster = {
      boxWidth: Number(quality.box.width.toFixed(2)),
      boxHeight: Number(quality.box.height.toFixed(2)),
      deviceWidth: Number(deviceW.toFixed(2)),
      deviceHeight: Number(deviceH.toFixed(2)),
      mode: quality.mode,
    };
    // The sprite must land on whole device pixels: a half-pixel origin makes
    // the browser filter every edge across two pixels.
    report.assertions.rasterOk = Number.isInteger(Number(deviceW.toFixed(3)))
      && Number.isInteger(Number(deviceH.toFixed(3)))
      && Number.isInteger(Number((quality.box.x * quality.dpr).toFixed(3)))
      && Number.isInteger(Number((quality.box.y * quality.dpr).toFixed(3)));
    write(`assert rasterisation: ${report.assertions.rasterOk} ${JSON.stringify(report.assertions.raster)}`);

    // Sizes change through an async IPC plus a window resize, so a measurement
    // taken straight afterwards reads the previous frame. Wait for the sprite
    // box to stop moving before believing anything about it. (Measuring without
    // this is how an earlier version of this test reported four identical
    // numbers for four different sizes.)
    const setSizeAndSettle = async (size, tries = 20) => {
      await wc.executeJavaScript(`__deskpet.setSize(${size})`);
      let last = -1;
      let stable = 0;
      for (let i = 0; i < tries; i += 1) {
        await sleep(140);
        const now = await wc.executeJavaScript(
          'Math.round(window.__deskpet.info.petBox.height)',
        );
        // Require several consecutive identical readings: during a window
        // resize the value sits still for a moment part-way through.
        stable = now > 0 && now === last ? stable + 1 : 0;
        last = now;
        if (stable >= 3) return now;
      }
      return last;
    };

    // 5c2. Resampling must not produce horizontal banding.
    //     Scaling through an offscreen buffer at the next integer multiple made
    //     the final filter average less than one source pixel, so some source
    //     rows claimed one output row and their neighbours claimed two. On her
    //     cushion that read as bands that crawled up and down as she animated.
    //
    //     Measured with integer scaling off, so each size is actually rendered
    //     at that size rather than snapped to a multiple.
    await wc.executeJavaScript(`window.deskpet.saveSettings({ integerScale: false })`);
    await sleep(400);
    const banding = {};
    for (const size of [208, 260, 300, 416]) {
      await setSizeAndSettle(size);
      banding[size] = await wc.executeJavaScript('window.__deskpet.rowBanding()');
    }
    // Calibration: nearest-neighbour at a fractional size has hard block edges,
    // so it must score clearly worse than the smoothed default. Without a
    // comparison there is no way to know the metric detects anything at all.
    await wc.executeJavaScript(`window.deskpet.saveSettings({ renderMode: 'nearest' })`);
    await sleep(600);
    const nearestBanding = await wc.executeJavaScript('window.__deskpet.rowBanding()');
    await wc.executeJavaScript(`window.deskpet.saveSettings({ renderMode: 'auto' })`);
    await sleep(600);

    const distinct = new Set(Object.values(banding).map((b) => b.energy)).size;
    report.assertions.banding = { bySize: banding, nearestAt300: nearestBanding, distinctValues: distinct };

    // 5c3. With integer scaling on -- the default -- every size must land on a
    //     whole multiple of the cell, which is the only band-free enlargement.
    await wc.executeJavaScript(`window.deskpet.saveSettings({ integerScale: true })`);
    await sleep(400);
    const snapped = [];
    for (const want of [300, 520, 700, 900]) {
      snapped.push({ want, got: await setSizeAndSettle(want) });
    }
    // And with it off, an arbitrary size is honoured again.
    await wc.executeJavaScript(`window.deskpet.saveSettings({ integerScale: false })`);
    await sleep(400);
    const freeHeight = await setSizeAndSettle(300);
    await wc.executeJavaScript(`window.deskpet.saveSettings({ integerScale: true })`);
    await sleep(400);
    await setSizeAndSettle(416);

    report.assertions.integerScale = { snapped, freeHeight };
    report.assertions.integerScaleOk =
      // 300 -> 208, 520 -> 624, 700 -> 624, 900 -> 832: whole multiples only.
      snapped.every((s) => s.got % 208 === 0)
      && snapped[0].got === 208
      && snapped[1].got === 624
      && snapped[2].got === 624
      && snapped[3].got === 832
      && freeHeight === 300;

    report.assertions.bandingOk = Object.values(banding).every((b) => b.energy > 0 && b.energy < b.limit)
      && distinct > 1                                        // it actually measured something
      && nearestBanding.energy > banding[300].energy;        // and it can tell the difference
    write(`assert no resampling banding: ${report.assertions.bandingOk} ` +
      `${JSON.stringify(report.assertions.banding)}`);
    write(`assert integer scaling snaps sizes: ${report.assertions.integerScaleOk} ` +
      `${JSON.stringify(report.assertions.integerScale)}`);

    // 5d. Sizing must be continuous, not snapped to a handful of steps.
    //     Checked with integer scaling off, since that is the mode in which any
    //     size is honoured; with it on the snapping is the point, and the
    //     assertion above covers that.
    await wc.executeJavaScript(`window.deskpet.saveSettings({ integerScale: false })`);
    await sleep(400);
    const freeSizes = [];
    for (const want of [333, 400, 507]) {
      const got = await setSizeAndSettle(want);
      freeSizes.push({ want, got });
    }
    await wc.executeJavaScript(`window.deskpet.saveSettings({ integerScale: true })`);
    await sleep(400);
    await setSizeAndSettle(416);

    report.assertions.continuousSize = freeSizes;
    report.assertions.continuousSizeOk = freeSizes.every((s) => Math.abs(s.got - s.want) < 2);
    write(`assert continuous sizing: ${report.assertions.continuousSizeOk} ${JSON.stringify(freeSizes)}`);

    // 5e. The mood aura must stay inside her silhouette. This is the regression
    //     test for the grey wash that filled the window on light desktops.
    await wc.executeJavaScript(`__deskpet.clearOverlay(); __deskpet.setOverlay('sad', { duration: 600000 })`);
    await sleep(1000);
    const probe = await wc.executeJavaScript('window.__deskpet.measureBackground()');
    const leaked = probe.filter((p) => p.rgba[3] > 0);
    report.assertions.auraLeak = { samples: probe.length, leaked: leaked.length, offenders: leaked.slice(0, 4) };
    report.assertions.auraContainedOk = leaked.length === 0;
    write(`assert aura contained: ${report.assertions.auraContainedOk} ` +
      `${leaked.length}/${probe.length} sampled pixels outside her are painted`);
    await wc.executeJavaScript('__deskpet.clearOverlay()');

    // 5f. Resizing must actually change the window.
    await wc.executeJavaScript('__deskpet.setSize(416)');
    await sleep(900);
    const beforeSize = pet.win.getBounds();
    await wc.executeJavaScript('__deskpet.setSize(600)');
    await sleep(1200);
    const afterSize = pet.win.getBounds();
    report.assertions.resize = { fromHeight: beforeSize.height, toHeight: afterSize.height };
    report.assertions.resizeOk = afterSize.height > beforeSize.height + 100;
    write(`assert resize: ${report.assertions.resizeOk} ${JSON.stringify(report.assertions.resize)}`);
    await wc.executeJavaScript('__deskpet.setSize(416)');
    await sleep(900);

    // 5e. The balance endpoint must be reachable and errors reported cleanly.
    if (process.env.DESKPET_SELFTEST_NET) {
      const balance = await wc.executeJavaScript('window.deskpet.refreshBalance()');
      report.assertions.balance = balance
        ? { ok: balance.ok, error: balance.error, hasKey: balance.hasKey }
        : null;
      report.assertions.balanceHandled = Boolean(balance && balance.error);
      write(`assert balance error handled: ${report.assertions.balanceHandled} -> ${balance && balance.error}`);
    }

    // 5g. The low-balance reminder must reach the renderer, show a pinned
    //     bubble, and not repeat for the same amount.
    await wc.executeJavaScript(`
      window.__lowEvents = [];
      window.deskpet.onBalanceLow((info) => window.__lowEvents.push(info));
      true
    `);
    await wc.executeJavaScript('window.deskpet.simulateLowBalance(1.23)');
    await sleep(800);
    const lowState = await wc.executeJavaScript(`({
      events: window.__lowEvents,
      info: window.__deskpet.info,
    })`);
    // A second notification for the same amount must be suppressed.
    await wc.executeJavaScript('window.deskpet.simulateLowBalance(1.23)');
    await sleep(600);
    const lowAgain = await wc.executeJavaScript('window.__lowEvents.length');

    report.assertions.lowBalance = {
      events: lowState.events.length,
      total: lowState.events[0] && lowState.events[0].total,
      bubbleVisible: lowState.info.bubbleVisible,
      pinned: lowState.info.bubblePinned,
      mood: lowState.info.mood,
      duplicateSuppressed: lowAgain === lowState.events.length,
    };
    report.assertions.lowBalanceOk = lowState.events.length === 1
      && lowState.events[0].total === 1.23
      && lowState.info.bubbleVisible
      && lowState.info.bubblePinned
      && lowAgain === 1;
    write(`assert low-balance reminder: ${report.assertions.lowBalanceOk} ${JSON.stringify(report.assertions.lowBalance)}`);

    const lowShot = await wc.capturePage();
    fs.writeFileSync(path.join(QA_DIR, 'low-balance.png'), lowShot.toPNG());
    await wc.executeJavaScript('__deskpet.hideBubble()');

    // 5g. The character must render true to her source art. This is the check
    //     that would have caught the mood tint silently recolouring her: with
    //     the shipped defaults, pixels on the cushion have to match the atlas.
    const { DEFAULT_SETTINGS } = require('./config');
    report.assertions.defaultMoodTintOff = DEFAULT_SETTINGS.moodTint === false;
    // The running config must have been migrated to the current version too,
    // which is what actually turns the tint off for existing installs.
    report.assertions.settingsMigrated = config.get().settingsVersion === DEFAULT_SETTINGS.settingsVersion
      && config.get().moodTint === false;
    write(`assert defaults+ migration: tintDefaultOff=${report.assertions.defaultMoodTintOff} ` +
      `migrated=${report.assertions.settingsMigrated} (v${config.get().settingsVersion}, moodTint=${config.get().moodTint})`);

    await wc.executeJavaScript(`
      __deskpet.clearOverlay();
      __deskpet.setOverlay('sad', { duration: 600000 });
    `);
    await sleep(1600); // let the one-shot clip finish so the frame is stable
    await wc.executeJavaScript('__deskpet.freeze(true)');

    const rendered = await wc.executeJavaScript('window.__deskpet.measureRegions()');
    const source = await wc.executeJavaScript('window.__deskpet.sampleAtlasRegions()');
    // The bleed check is about the mood aura spilling past her silhouette, so
    // it has to run with no particle effect on screen: a rain droplet or a
    // sparkle drifting into a sample region is a false positive, and the
    // `sad` overlay used above emits rain.
    await wc.executeJavaScript('__deskpet.freeze(false)');
    await wc.executeJavaScript(`
      __deskpet.clearOverlay();
      __deskpet.setBase('idle');
      true
    `);
    await sleep(1400);
    await wc.executeJavaScript('__deskpet.freeze(true)');
    await sleep(250);
    const outside = await wc.executeJavaScript('window.__deskpet.measureBackgroundRegions()');

    const fidelity = [];
    // Region tolerances are calibrated for a whole-number scale, where she is
    // drawn 1:1 or N:1 against the source and only a sub-pixel sampling offset
    // can move a block's mean. At a fractional device scale factor every size is
    // resampled, so a flat region legitimately blends neighbouring source pixels
    // and drifts a few more levels. Scale the bound accordingly -- this check
    // exists to catch something *painting over* her (the mood tint and the old
    // aura moved these regions by 11-30 levels), so a resampling allowance still
    // leaves it plenty of teeth.
    const wholeNumberScale =
      Math.round(quality.box.height * quality.dpr) % 208 === 0;
    const resampleAllowance = wholeNumberScale ? 1 : 3;
    for (const r of rendered) {
      if (r.name === 'outside-left') continue;
      const match = source.find((s) => s.name === r.name);
      if (!match) continue;
      if (r.mean[3] < 200 || match.mean[3] < 200) continue; // skip transparent regions
      const delta = Math.max(
        Math.abs(r.mean[0] - match.mean[0]),
        Math.abs(r.mean[1] - match.mean[1]),
        Math.abs(r.mean[2] - match.mean[2]),
      );
      fidelity.push({
        name: r.name,
        rendered: r.mean.slice(0, 3),
        atlas: match.mean.slice(0, 3),
        delta: Number(delta.toFixed(1)),
        tolerance: Number((r.tolerance * resampleAllowance).toFixed(1)),
        withinTolerance: delta <= r.tolerance * resampleAllowance,
      });
    }
    const offenders = fidelity.filter((f) => !f.withinTolerance);
    report.assertions.fidelity = { samples: fidelity.length, regions: fidelity };
    // Only resampling differences are allowed; anything beyond a region's own
    // tolerance means something is painting on top of her.
    report.assertions.fidelityOk = report.assertions.defaultMoodTintOff
      && report.assertions.settingsMigrated
      && fidelity.length >= 3
      && offenders.length === 0;
    write(`assert character fidelity: ${report.assertions.fidelityOk} ` +
      `${fidelity.map((f) => `${f.name}=${f.delta}/${f.tolerance}`).join(' ')}`);

    // The default build must leave the canvas outside her completely empty.
    const bleed = outside.filter((r) => r.mean[3] > 0);
    report.assertions.bleed = outside.map((r) => ({ name: r.name, alpha: r.mean[3] }));
    report.assertions.bleedOk = bleed.length === 0;
    write(`assert no background bleed: ${report.assertions.bleedOk} ${JSON.stringify(report.assertions.bleed)}`);

    // 5g2. The opt-in tint must still work when switched on, and stay subtle.
    //     It rides on the ambient effect, so it needs a state that *has* one —
    //     against the plain idle pose there is no aura to tint and the check
    //     would pass vacuously. The baseline is re-measured here rather than
    //     reused from the fidelity check, because the pose changed in between.
    await wc.executeJavaScript(`
      __deskpet.clearOverlay();
      __deskpet.setOverlay('sad', { duration: 600000 });
      true
    `);
    await sleep(1200);
    await wc.executeJavaScript('__deskpet.freeze(true)');
    await sleep(200);
    const tintBase = await wc.executeJavaScript('window.__deskpet.measureRegions()');
    await wc.executeJavaScript('window.deskpet.saveSettings({ moodTint: true })');
    await sleep(700);
    const tinted = await wc.executeJavaScript('window.__deskpet.measureRegions()');

    const shifts = [];
    for (const r of tinted) {
      const base = tintBase.find((b) => b.name === r.name);
      if (!base || r.mean[3] < 200) continue;
      const delta = Math.max(
        Math.abs(r.mean[0] - base.mean[0]),
        Math.abs(r.mean[1] - base.mean[1]),
        Math.abs(r.mean[2] - base.mean[2]),
      );
      shifts.push({ name: r.name, delta: Number(delta.toFixed(1)) });
    }
    const worst = shifts.reduce((a, b) => (b.delta > a.delta ? b : a), { delta: 0, name: 'none' });
    report.assertions.moodTint = { samples: shifts.length, worst, regions: shifts };
    report.assertions.moodTintSubtleOk = shifts.length >= 3 && worst.delta > 3 && worst.delta <= 30;
    write(`assert optional mood tint: ${report.assertions.moodTintSubtleOk} ` +
      `worst region shift ${worst.delta}/255 (${worst.name})`);

    await wc.executeJavaScript('window.deskpet.saveSettings({ moodTint: false })');
    await wc.executeJavaScript('__deskpet.freeze(false); __deskpet.clearOverlay()');
    await sleep(400);

    // 5i. Gaze must follow the *global* cursor and, crucially, let go of it.
    //     The original bug: gaze was derived from `mousemove`, so when the
    //     pointer left the window the last position stuck -- and exiting through
    //     a side edge was still inside the engage radius, so she stared that way
    //     forever instead of going back to her book.
    await wc.executeJavaScript(`
      __deskpet.clearOverlay();
      __deskpet.setBase('idle');
      __deskpet.overrideCursor(null);
    `);
    await sleep(700);

    const head = await wc.executeJavaScript('window.__deskpet.headScreen()');
    const lookAt = async (dx, dy) => {
      await wc.executeJavaScript(`__deskpet.overrideCursor({ x: ${head.x + dx}, y: ${head.y + dy} })`);
      await sleep(420);
      return wc.executeJavaScript('window.__deskpet.gaze');
    };

    const near = await lookAt(90, 0);           // right next to her
    const hover = await lookAt(340, 0);         // between engage and release radii
    const far = await lookAt(900, 0);           // well away
    const gone = await lookAt(-100000, -100000); // cursor effectively gone
    await wc.executeJavaScript('__deskpet.overrideCursor(null)');

    report.assertions.gaze = {
      cursorEvents: near.cursorEvents,
      near: { engaged: near.engaged, index: near.index, look: near.look },
      hysteresisHold: { engaged: hover.engaged },
      far: { engaged: far.engaged, index: far.index, look: far.look },
      gone: { engaged: gone.engaged, index: gone.index, look: gone.look },
    };
    report.assertions.gazeOk = near.cursorEvents > 0
      && near.engaged && near.look !== null
      && hover.engaged                       // hysteresis keeps her looking
      && !far.engaged && far.look === null
      && !gone.engaged && gone.look === null;
    write(`assert gaze follow+release: ${report.assertions.gazeOk} ${JSON.stringify(report.assertions.gaze)}`);

    // 5i-2. Capture what "cursor to the right" and "cursor to the left"
    //       actually look like, to settle left/right by eye as well as by the
    //       eye-centroid measurement in tools/slice-atlas.js.
    for (const [label, dx] of [['right', 260], ['left', -260]]) {
      await wc.executeJavaScript(
        `__deskpet.overrideCursor({ x: ${head.x + dx}, y: ${head.y} })`,
      );
      await sleep(800);
      const shot = await wc.capturePage();
      fs.writeFileSync(path.join(QA_DIR, `gaze-cursor-${label}.png`), shot.toPNG());
      const g = await wc.executeJavaScript('window.__deskpet.gaze');
      report.assertions[`gazeShot_${label}`] = { canonical: g.index, atlasCell: null };
      write(`gaze screenshot (cursor ${label}): canonical index ${g.index}`);
    }
    await wc.executeJavaScript('__deskpet.overrideCursor(null)');

    // 5i-3. Trace the animation state for a while to catch anything that
    //       oscillates on its own, and to measure how much of the time she is
    //       actually doing something rather than lying flat.
    await wc.executeJavaScript('__deskpet.pauseBehavior(false)');
    const traceSamples = [];
    for (let i = 0; i < 160; i += 1) {
      traceSamples.push(await wc.executeJavaScript(
        `(() => { const s = window.__deskpet.info;
          return s.base + '|' + s.clip + '|' + s.look; })()`,
      ));
      await sleep(100);
    }
    await wc.executeJavaScript('__deskpet.pauseBehavior(true)');

    let transitions = 0;
    for (let i = 1; i < traceSamples.length; i += 1) {
      if (traceSamples[i] !== traceSamples[i - 1]) transitions += 1;
    }
    const counts = new Map();
    for (const s of traceSamples) counts.set(s, (counts.get(s) || 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

    // How is her time split? "Lying" is the flat-on-her-stomach pose, which she
    // used to occupy about 95% of the time.
    const baseOf = (s) => s.split('|')[0];
    const share = { moving: 0, seated: 0, lying: 0, asleep: 0 };
    for (const s of traceSamples) {
      const base = baseOf(s);
      if (base.startsWith('walk')) share.moving += 1;
      else if (base === 'sitting') share.seated += 1;
      else if (base === 'idle' || base === 'reading') share.lying += 1;
      else if (base === 'sleepy') share.asleep += 1;
    }
    const total = traceSamples.length;
    const pct = (n) => Number(((n / total) * 100).toFixed(1));

    const longestWalkingRun = (() => {
      let best = 0;
      let run = 0;
      for (const s of traceSamples) {
        if (baseOf(s).startsWith('walk')) { run += 1; if (run > best) best = run; } else run = 0;
      }
      return best;
    })();

    report.assertions.trace = {
      samples: total,
      transitions,
      longestWalkingRunSamples: longestWalkingRun,
      share: {
        movingPct: pct(share.moving),
        seatedPct: pct(share.seated),
        lyingPct: pct(share.lying),
        asleepPct: pct(share.asleep),
      },
      top: top.map(([state, n]) => ({ state, samples: n })),
    };
    report.assertions.traceCalmOk = longestWalkingRun <= 60;
    write(`assert state is calm: ${report.assertions.traceCalmOk} ` +
      `${transitions} transitions, longest walk ${longestWalkingRun} samples, ` +
      `mix ${JSON.stringify(report.assertions.trace.share)}`);
    write(`   most common: ${top.map(([s, n]) => `${s}×${n}`).join('  ')}`);

    // 5i-3b. The pose mix and the pacing, measured properly. The wall-clock
    //        trace above only sees one pose per window, so it cannot tell a good
    //        distribution from a bad one; sampling the decision does.
    const pacing = await wc.executeJavaScript('window.__deskpet.pacing');
    const poseClips = await wc.executeJavaScript('window.__deskpet.poseClips');
    const sampled = await wc.executeJavaScript('window.__deskpet.samplePoses(6000)');

    const lying = ['idle', 'reading', 'daydream'];
    const seated = ['seatedShake', 'seatedNod', 'seatedQuiet'];
    const shareOf = (bases) => Number(bases.reduce((s, b) => s + (sampled[b] || 0), 0).toFixed(3));
    const lyingShare = shareOf(lying);
    const seatedShare = shareOf(seated);

    report.assertions.pacing = { ...pacing, sampled, poseClips, lyingShare, seatedShare };
    // Both kinds of pose must appear, and neither may crowd the other out.
    report.assertions.poseMixOk = lyingShare >= 0.3 && seatedShare >= 0.3
      && Object.keys(poseClips).length >= 5;
    // Walking must be its own phase, not a pose: the walking artwork is a
    // seated sway, so playing it while parked looks like walking in place.
    report.assertions.walkNotAPoseOk = !pacing.poses.some((p) => p.base.startsWith('walk'));
    // And a stroll has to be a calm amble, not a scurry.
    report.assertions.walkPaceOk = pacing.walkSpeed <= 80
      && pacing.walkMs[0] >= 1_500
      && pacing.walkMs[1] <= 5_000
      && pacing.walkClipFps <= 9;

    write(`assert pose mix: ${report.assertions.poseMixOk} lying ${lyingShare}, seated ${seatedShare} ` +
      `${JSON.stringify(sampled)}`);
    write(`assert walking is a separate, calm phase: ${report.assertions.walkNotAPoseOk && report.assertions.walkPaceOk} ` +
      `speed ${pacing.walkSpeed}px/s, stroll ${pacing.walkMs[0]}-${pacing.walkMs[1]}ms, clip ${pacing.walkClipFps}fps`);

    // 5i-3c. Every pose must speak from its own line pool, so a line can never
    //        contradict what is on screen (no "so sleepy" while wide awake).
    const poses = await wc.executeJavaScript('window.__deskpet.poses');
    const mutterKinds = await wc.executeJavaScript('window.__deskpet.mutterKinds()');
    const missing = poses.filter((p) => !mutterKinds[p.mutters] || mutterKinds[p.mutters] < 3);
    const poolsUsed = new Set(poses.map((p) => p.mutters));
    const gazeRowsUsed = Object.values(poseClips)
      .filter((c) => c && c.row >= 9).map((c) => c.row);
    report.assertions.poseLines = {
      poses: poses.map((p) => `${p.base}->${p.mutters}`),
      missingPools: missing.map((p) => p.mutters),
      unusedPools: Object.keys(mutterKinds).filter((k) => !poolsUsed.has(k)),
      gazeRowsUsed,
    };
    report.assertions.poseLinesOk = missing.length === 0 && gazeRowsUsed.length === 0;
    write(`assert pose lines match poses: ${report.assertions.poseLinesOk} ` +
      `${report.assertions.poseLines.poses.join(' ')}` +
      (gazeRowsUsed.length ? ` | GAZE ROWS LEAKED: ${gazeRowsUsed}` : ''));
    report.assertions.pacingOk = report.assertions.poseMixOk
      && report.assertions.walkNotAPoseOk
      && report.assertions.walkPaceOk
      && report.assertions.poseLinesOk;
    report.assertions.activityMixOk = report.assertions.pacingOk;

    // 5i-4. Walks must be bounded, and a cancelled walk must not leave her
    //       stuck in the walking pose -- that is what looked like endless
    //       head-shaking (the walking clips are a seated sway).
    const walkPoll = async (limitMs) => {
      const started = Date.now();
      for (let i = 0; i < limitMs / 100; i += 1) {
        const base = await wc.executeJavaScript('window.__deskpet.info.base');
        if (!String(base).startsWith('walk')) return { base, elapsed: Date.now() - started };
        await sleep(100);
      }
      const base = await wc.executeJavaScript('window.__deskpet.info.base');
      return { base, elapsed: Date.now() - started, timedOut: true };
    };

    // A normal stroll finishes on its own.
    await wc.executeJavaScript('__deskpet.pauseBehavior(false); true');
    const walkStart = await wc.executeJavaScript('__deskpet.walkProbe()');
    await sleep(500);
    const duringWalk = await wc.executeJavaScript('window.__deskpet.info');
    const finished = await walkPoll(10_000);
    report.assertions.walkCompletes = {
      start: walkStart,
      duringWalk: duringWalk.base,
      after: finished.base,
      elapsedMs: finished.elapsed,
    };
    report.assertions.walkCompletesOk = String(duringWalk.base).startsWith('walk')
      && !String(finished.base).startsWith('walk')
      && finished.elapsed < 8000;

    // And a walk cancelled by a resize releases the pose too.
    await wc.executeJavaScript('__deskpet.startWalk(); true');
    await sleep(500);
    const duringCancel = await wc.executeJavaScript('window.__deskpet.info.base');
    await wc.executeJavaScript('window.deskpet.resizePet(440)');
    await sleep(900);
    const afterCancel = await wc.executeJavaScript('window.__deskpet.info.base');
    await wc.executeJavaScript('window.deskpet.resizePet(416)');
    await sleep(600);

    report.assertions.walkCancel = { duringWalk: duringCancel, afterCancel };
    report.assertions.walkCancelOk = String(duringCancel).startsWith('walk')
      && !String(afterCancel).startsWith('walk');
    write(`assert walks bounded: completes=${report.assertions.walkCompletesOk} ` +
      `${JSON.stringify(report.assertions.walkCompletes)}; ` +
      `cancel releases pose=${report.assertions.walkCancelOk} ${JSON.stringify(report.assertions.walkCancel)}`);

    // 5i-5. She must occasionally mutter to herself while idle.
    const mutter = await wc.executeJavaScript(`
      (() => {
        __deskpet.mutter('reading');
        const i = window.__deskpet.info;
        return { bubbleVisible: i.bubbleVisible, text: document.getElementById('bubble-text').textContent };
      })()
    `);
    report.assertions.mutterOk = mutter.bubbleVisible && mutter.text.length > 0;
    write(`assert idle muttering: ${report.assertions.mutterOk} "${mutter.text}"`);
    await wc.executeJavaScript('__deskpet.hideBubble()');

    // 5i-6. No long-lived state may use an agitated animation row. This is the
    //       regression test for "she keeps shaking her head": `reading` used to
    //       point at the `review` row, which is a wide head swing.
    const agitated = await wc.executeJavaScript('window.__deskpet.agitation');
    const stateProblems = await wc.executeJavaScript('window.__deskpet.stateProblems');
    report.assertions.stateDefinitions = { problems: stateProblems, agitated };
    report.assertions.ambientCalm = agitated;
    report.assertions.ambientCalmOk = Array.isArray(agitated) && agitated.length === 0
      && Array.isArray(stateProblems) && stateProblems.length === 0;
    write(`assert state definitions valid: ${report.assertions.ambientCalmOk} ` +
      `problems=${JSON.stringify(stateProblems)} agitated=${JSON.stringify(agitated)}`);

    // And she must render the calm lying row while reading. The behaviour
    // engine is paused first: `setBase` is ignored while an overlay is up, and
    // an autonomous pose change mid-check would make this a coin flip.
    await wc.executeJavaScript(`
      __deskpet.pauseBehavior(true);
      __deskpet.clearOverlay();
      __deskpet.setBase('reading');
      true
    `);
    await sleep(600);
    const readingInfo = await wc.executeJavaScript('window.__deskpet.info');
    report.assertions.readingClip = readingInfo.clip;
    report.assertions.readingCalmOk = readingInfo.clip === 'lyingRead';
    write(`assert reading uses the calm row: ${report.assertions.readingCalmOk} (clip=${readingInfo.clip})`);

    // 5i-7. The seated poses must actually be reachable and bounded: the head
    //       swing is wanted, but only as a short burst.
    await wc.executeJavaScript(`
      __deskpet.pauseBehavior(true);
      __deskpet.clearOverlay();
      true
    `);
    const seatedShots = {};
    for (const base of ['seatedQuiet', 'seatedShake', 'seatedNod']) {
      await wc.executeJavaScript(`__deskpet.setBase('${base}')`);
      await sleep(700);
      const info = await wc.executeJavaScript('window.__deskpet.info');
      const shot = await wc.capturePage();
      fs.writeFileSync(path.join(QA_DIR, `pose-${base}.png`), shot.toPNG());
      seatedShots[base] = { clip: info.clip, effect: info.effect };
    }
    report.assertions.seatedPoses = seatedShots;
    report.assertions.seatedPosesOk = seatedShots.seatedQuiet.clip === 'seatedQuiet'
      && seatedShots.seatedShake.clip === 'seatedShake'
      && seatedShots.seatedNod.clip === 'seatedNod';
    write(`assert seated poses reachable: ${report.assertions.seatedPosesOk} ${JSON.stringify(seatedShots)}`);

    // The hold limits must be enforced by the state table itself.
    const holds = await wc.executeJavaScript('window.__deskpet.poseClips');
    const twitchy = Object.entries(holds)
      .filter(([, c]) => c && c.motion > 2600)
      .map(([name, c]) => ({ name, motion: c.motion, maxHoldMs: c.maxHoldMs }));
    report.assertions.holdLimits = twitchy;
    report.assertions.holdLimitsOk = twitchy.length > 0
      && twitchy.every((t) => t.maxHoldMs > 0 && t.maxHoldMs <= 10_000);
    write(`assert twitchy poses are time-limited: ${report.assertions.holdLimitsOk} ` +
      `${twitchy.map((t) => `${t.name}(${t.motion}px, ≤${t.maxHoldMs / 1000}s)`).join(' ')}`);

    // 5i-8. Every ambient pool needs enough lines that repetition is not obvious.
    const pools = await wc.executeJavaScript('window.__deskpet.mutterKinds()');
    const thin = Object.entries(pools).filter(([, n]) => n < 3);
    report.assertions.mutterPools = { pools, thin: thin.map(([k]) => k) };
    report.assertions.mutterPoolsOk = thin.length === 0 && Object.keys(pools).length >= 6;
    write(`assert mutter pools: ${report.assertions.mutterPoolsOk} ${JSON.stringify(pools)}`);

    // 5k. Work mode: the prompt, the generation parameters and the window all
    //     have to change, and the mode commands must not cost a request.
    const ai = require('./ai');
    const petPrompt = ai.buildSystemPrompt({ workMode: false });
    const workPrompt = ai.buildSystemPrompt({ workMode: true });
    const chatterPrompt = ai.buildSystemPrompt({ workMode: true }, { chatter: true });
    const petGen = ai.resolveGeneration({ workMode: false });
    const workGen = ai.resolveGeneration({ workMode: true });

    report.assertions.workPrompts = {
      petHasBrevityRule: petPrompt.includes('60 字以内'),
      workHasBrevityRule: workPrompt.includes('60 字以内'),
      workMentionsMode: workPrompt.includes('工作模式'),
      chatterStaysCasual: chatterPrompt.includes('60 字以内'),
      petGen,
      workGen,
    };
    report.assertions.workPromptsOk = report.assertions.workPrompts.petHasBrevityRule
      && !report.assertions.workPrompts.workHasBrevityRule
      && report.assertions.workPrompts.workMentionsMode
      && report.assertions.workPrompts.chatterStaysCasual
      && workGen.maxTokens > petGen.maxTokens
      && workGen.temperature < petGen.temperature;
    write(`assert work mode prompt: ${report.assertions.workPromptsOk} ` +
      `pet(${petGen.maxTokens}tok/${petGen.temperature}) vs work(${workGen.maxTokens}tok/${workGen.temperature}), ` +
      `brevity rule lifted=${!report.assertions.workPrompts.workHasBrevityRule}`);

    // 5k-2. The Teyvat roster: a stable prefix of every request, so every
    //       prompt flavour has to carry it -- and it must not still contain the
    //       wrong names/details that an earlier draft of the persona shipped
    //       (Freminet spelled "弗蕾米内", Enjou as "恩乔", Allier as "阿利耶",
    //       and Sandrone's job as a hotel front desk instead of a ship's).
    const roster = ai.TEYVAT_ROSTER;
    const staleNames = ['弗蕾米内', '恩乔', '阿利耶'];
    report.assertions.personaRoster = {
      chars: roster.length,
      inPet: petPrompt.includes('桑多涅') && petPrompt.includes('维奇琳'),
      inWork: workPrompt.includes('卡皮塔诺'),
      inChatter: chatterPrompt.includes('欧洛伦') && chatterPrompt.includes('派蒙'),
      rulesPresent: roster.includes('绝不说') && roster.includes('星图上没有他'),
      shipNotHotel: roster.includes('维恩歌莱号') && roster.includes('不是酒店前台'),
      noStaleNames: staleNames.filter((n) => roster.includes(n)),
      totalPromptChars: petPrompt.length,
    };
    report.assertions.personaRosterOk = report.assertions.personaRoster.chars > 3000
      && report.assertions.personaRoster.inPet
      && report.assertions.personaRoster.inWork
      && report.assertions.personaRoster.inChatter
      && report.assertions.personaRoster.rulesPresent
      && report.assertions.personaRoster.shipNotHotel
      && report.assertions.personaRoster.noStaleNames.length === 0;
    write(`assert persona roster: ${report.assertions.personaRosterOk} ` +
      `roster=${report.assertions.personaRoster.chars}ch, prompt=${petPrompt.length}ch, ` +
      `stale=${JSON.stringify(report.assertions.personaRoster.noStaleNames)}`);

    const sendAndWait = async (text) => {
      await wc.executeJavaScript(`
        window.__modeReply = null;
        window.deskpet.onChatDone((p) => { window.__modeReply = p; });
        window.deskpet.sendMessage(${JSON.stringify(text)});
        true
      `);
      await sleep(1400);
      return wc.executeJavaScript('window.__modeReply');
    };

    await wc.executeJavaScript('window.deskpet.saveSettings({ workMode: false })');
    await sleep(1400);
    const heightIdle = pet.win.getBounds().height;

    const onReply = await sendAndWait('/work');
    const modeOn = await wc.executeJavaScript('window.__deskpet.getSettings().workMode');
    const heightWork = pet.win.getBounds().height;

    const offReply = await sendAndWait('/pet');
    const modeOff = await wc.executeJavaScript('window.__deskpet.getSettings().workMode');
    const heightBack = pet.win.getBounds().height;

    report.assertions.modeCommand = {
      afterWork: modeOn,
      afterPet: modeOff,
      heightIdle,
      heightWork,
      heightBack,
      replies: [onReply && onReply.text, offReply && offReply.text],
      // No API key is configured, so a reply can only exist if the command was
      // handled locally rather than sent to the model.
      answeredLocally: Boolean(onReply && onReply.ok && onReply.text),
    };
    report.assertions.modeCommandOk = modeOn === true
      && modeOff === false
      && heightWork > heightIdle + 100
      && Math.abs(heightBack - heightIdle) <= 4
      && report.assertions.modeCommand.answeredLocally;
    write(`assert /work and /pet: ${report.assertions.modeCommandOk} ` +
      `${JSON.stringify(report.assertions.modeCommand)}`);

    // 5l. A long answer must survive being read.
    //     The reported failure: she wandered off, muttered a random line over
    //     the top of the reply, and the answer was then gone for good.
    //
    //     A key has to exist first: with no key, clicking her offers to open
    //     Settings instead of restoring a line, which is correct behaviour but
    //     not the path under test here. It is set through the renderer's own
    //     settings API so the change is broadcast, exactly as the UI would.
    await wc.executeJavaScript(
      `window.deskpet.saveSettings({ apiKey: 'sk-selftest-reply-guard' })`,
    );
    await sleep(400);
    await wc.executeJavaScript(`
      __deskpet.pauseBehavior(false);
      window.__longReply = '这是一段很长的回答，用于验证它不会被随机台词覆盖。'.repeat(20);
      __deskpet.sayReply(window.__longReply);
      true
    `);
    await sleep(500);
    const replyState = await wc.executeJavaScript(`({
      chars: document.getElementById('bubble-text').textContent.length,
      kind: document.getElementById('bubble').dataset.kind,
      delay: window.__deskpet.replyHideDelay(window.__longReply),
      attentive: window.__deskpet.attentive,
    })`);

    // Her ambient muttering must refuse to replace it.
    await wc.executeJavaScript('__deskpet.mutter("lyingIdle")');
    await sleep(400);
    const afterMutter = await wc.executeJavaScript(`({
      chars: document.getElementById('bubble-text').textContent.length,
      kind: document.getElementById('bubble').dataset.kind,
    })`);

    // Clicking her brings the answer back after it has been dismissed. The
    // behaviour engine is paused for this: it is not what is under test, and a
    // mutter landing between the two calls would make the check a coin flip.
    await wc.executeJavaScript('__deskpet.pauseBehavior(true)');
    await wc.executeJavaScript('__deskpet.hideBubble()');
    await sleep(300);
    const attentiveAfterHide = await wc.executeJavaScript('__deskpet.attentive');
    await wc.executeJavaScript('__deskpet.clickPet()');
    await sleep(500);
    const restored = await wc.executeJavaScript(
      `document.getElementById('bubble-text').textContent.length`,
    );

    report.assertions.replyProtection = {
      chars: replyState.chars,
      kind: replyState.kind,
      hideDelayMs: replyState.delay,
      attentive: replyState.attentive,
      afterMutter,
      attentiveReleasedOnHide: !attentiveAfterHide,
      restoredChars: restored,
    };
    report.assertions.replyProtectionOk = replyState.kind === 'reply'
      && replyState.chars > 300
      && replyState.delay > 30_000              // long answers get a long timer
      && replyState.attentive === true          // she holds still while it is up
      && afterMutter.chars === replyState.chars // muttering did not clobber it
      && afterMutter.kind === 'reply'
      && !attentiveAfterHide                    // and resumes afterwards
      && restored === replyState.chars;         // and it can be brought back
    write(`assert long replies survive: ${report.assertions.replyProtectionOk} ` +
      `${JSON.stringify(report.assertions.replyProtection)}`);
    await wc.executeJavaScript('__deskpet.hideBubble(); __deskpet.pauseBehavior(true)');
    await wc.executeJavaScript(`window.deskpet.saveSettings({ apiKey: '' })`);
    await sleep(300);

    // 5m. The conversation log must be reachable and show what was said.
    //
    // Seed it rather than relying on what happens to be on disk. The self-test
    // runs in a scratch data directory (see main.js) because it writes settings,
    // and the earlier chat steps cannot leave real turns behind: the key they
    // use is deliberately invalid, so nothing is ever generated to store.
    config.setHistory([
      { role: 'user', content: '你昨天晚上干什么去了？' },
      { role: 'assistant', content: '看小说。看到第三章就睡着了，别问了。' },
      { role: 'user', content: '认识桑多涅吗？' },
      { role: 'assistant', content: '哼，那丫头租过一整条船，我还替她看过前台。' },
    ]);
    if (openHistory) {
      openHistory();
      await sleep(2500);
      const historyWin = BrowserWindow.getAllWindows().find(
        (w) => w !== pet.win && !w.isDestroyed() && /history/.test(w.webContents.getURL()),
      );
      if (historyWin) {
        historyWin.show();
        historyWin.focus();
        await sleep(1500);
        const shown = await historyWin.webContents.executeJavaScript(
          `({ turns: document.querySelectorAll('.turn').length,
              summary: document.getElementById('summary').textContent })`,
        );
        const shot = await historyWin.capturePage();
        if (!shot.isEmpty()) {
          fs.writeFileSync(path.join(QA_DIR, 'history-window.png'), shot.toPNG());
          write(`history window capture: ${JSON.stringify(shot.getSize())}`);
        } else {
          write('history window capture: unavailable');
        }
        report.assertions.historyWindow = shown;
        // The seeded conversation must actually render: two turns on screen and
        // a summary that counts them. Merely finding the window is not enough.
        report.assertions.historyWindowOk = shown.turns >= 2 && /2/.test(shown.summary);
        write(`assert history window: ${report.assertions.historyWindowOk} ${JSON.stringify(shown)}`);
        historyWin.close();
      } else {
        report.assertions.historyWindowOk = false;
        write('ERROR: the history window never opened');
      }
    }

    // 5n. Moving her must not change the window size.
    //     On a display with a fractional scale factor (Windows at 125% or 150%)
    //     `setPosition` only moves the origin, and the DIP -> device pixel ->
    //     DIP round trip rounds up a little each time. Walking or dragging then
    //     inflated the window one pixel per move, stretching the speech bubble
    //     and the composer wider and wider without bound. At 100% scaling the
    //     round trip is exact, so this only reproduces on some machines --
    //     re-run with `--force-device-scale-factor=1.25` to exercise it.
    const beforeMoves = pet.win.getBounds();
    const startInner = await wc.executeJavaScript(
      '({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })',
    );
    for (let i = 0; i < 80; i += 1) {
      await wc.executeJavaScript(
        `window.deskpet.setWindowPosition(${beforeMoves.x + i + 1}, ${beforeMoves.y}); true`,
      );
      await sleep(12);
    }
    await sleep(500);
    const afterMoves = pet.win.getBounds();
    const endInner = await wc.executeJavaScript(
      '({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })',
    );
    report.assertions.moveStableSize = {
      scaleFactor: startInner.dpr,
      before: `${beforeMoves.width}x${beforeMoves.height}`,
      after: `${afterMoves.width}x${afterMoves.height}`,
      innerBefore: `${startInner.w}x${startInner.h}`,
      innerAfter: `${endInner.w}x${endInner.h}`,
      moves: 80,
    };
    // The renderer's own width is what the bubble and composer are laid out
    // against, so that is the number that must hold perfectly still.
    report.assertions.moveStableSizeOk = endInner.w === startInner.w
      && endInner.h === startInner.h
      && Math.abs(afterMoves.width - beforeMoves.width) <= 1
      && Math.abs(afterMoves.height - beforeMoves.height) <= 1;
    write(`assert repeated moves keep the size: ${report.assertions.moveStableSizeOk} ` +
      `${JSON.stringify(report.assertions.moveStableSize)}`);

    // 5o. The derived expressions have to land on her face.
    //     This atlas has no angry or dizzy art, so those poses are an existing
    //     clip plus an overlay positioned from `faceAnchorFor(row)`. Measuring
    //     the drawn overlay is the only way to know it did not end up in her
    //     hair, and the two framings (lying profile / seated frontal) have to
    //     both work.
    const emoteProbe = await wc.executeJavaScript(`
      (() => {
        // hurt is deliberately absent: its pose already reads as tearful and the
        // facial overlay was removed as inaccurate.
        const names = ['angry', 'proud', 'delighted', 'awkward', 'dizzy'];
        const out = {};
        for (const row of [0, 5, 8]) {
          out[row] = {};
          for (const n of names) {
            const m = window.__deskpet.measureEmote(n, row, 0.5);
            out[row][n] = m.bbox
              ? { centre: m.bbox.centreNorm.map((v) => Number(v.toFixed(3))), w: m.bbox.w, h: m.bbox.h }
              : null;
          }
        }
        return out;
      })()
    `);

    const emoteMismatches = [];
    const emoteMismatchesPush = (bbox, list) => {
      if (bbox) list.push(`hurt: expected no facial overlay, got ${bbox.w}x${bbox.h}px`);
    };
    for (const [label, probe] of [['profile', emoteProbe[0]], ['front', emoteProbe[5]]]) {
      for (const [name, m] of Object.entries(probe)) {
        if (!m) { emoteMismatches.push(`${label}/${name}: nothing drawn`); continue; }
        // Everything must at least be inside the sprite and a sane size. The
        // exact centring is checked below, per layer, not per composite.
        if (m.w < 6 || m.h < 6) emoteMismatches.push(`${label}/${name}: only ${m.w}x${m.h}px`);
        if (m.centre[0] < 0 || m.centre[0] > 1 || m.centre[1] < -0.1 || m.centre[1] > 1) {
          emoteMismatches.push(`${label}/${name}: outside the sprite at ${m.centre}`);
        }
      }
    }

    // Marks split into two families. Facial ones belong on her face; the anger
    // mark and the pride star belong *above* her head, which is where the idiom
    // puts them, so they are checked against the head top instead.
    const marks = await wc.executeJavaScript(`
      (() => {
        const out = {};
        for (const [label, row] of [['profile', 0], ['front', 5]]) {
          out[label] = {};
          for (const n of ['blush', 'prideStar', 'angerMark']) {
            const m = window.__deskpet.measureEmote(n, row, 0.5);
            out[label][n] = m.bbox
              ? { centre: m.bbox.centreNorm.map((v) => Number(v.toFixed(3))), w: m.bbox.w, h: m.bbox.h }
              : null;
          }
        }
        return out;
      })()
    `);
    const faceWant = { profile: [0.41, 0.285], front: [0.49, 0.32] };
    for (const [label, probe] of Object.entries(marks)) {
      const [wx, wy] = faceWant[label];
      for (const name of ['blush']) {
        const m = probe[name];
        if (!m) { emoteMismatches.push(`${label}/${name}: nothing drawn`); continue; }
        if (Math.abs(m.centre[0] - wx) > 0.16 || Math.abs(m.centre[1] - wy) > 0.16) {
          emoteMismatches.push(`${label}/${name}: at ${m.centre} want ~[${wx}, ${wy}]`);
        }
      }
      for (const name of ['prideStar', 'angerMark']) {
        const m = probe[name];
        if (!m) { emoteMismatches.push(`${label}/${name}: nothing drawn`); continue; }
        // Above the top of her head (0.05), roughly over her, and not outside.
        if (m.centre[1] > 0.14) emoteMismatches.push(`${label}/${name}: at y=${m.centre[1]}, want above the head`);
        if (Math.abs(m.centre[0] - wx) > 0.34) {
          emoteMismatches.push(`${label}/${name}: at x=${m.centre[0]}, want near her head`);
        }
      }
    }

    // hurt must draw nothing on her face: the pose already reads as tearful,
    // and the watery eyes that used to be drawn on top landed on her eyelids.
    const hurtOverlay = await wc.executeJavaScript(
      "__deskpet.measureEmote('hurt', 5, 0.5).bbox",
    );
    emoteMismatchesPush(hurtOverlay, emoteMismatches);

    report.assertions.emotes = { composite: emoteProbe, marks, mismatches: emoteMismatches };
    report.assertions.emotesOk = emoteMismatches.length === 0;
    write(`assert derived expressions land correctly: ${report.assertions.emotesOk} ` +
      `${emoteMismatches.length ? emoteMismatches.join(' | ') : 'all within tolerance'}`);
    write(`   marks ${JSON.stringify(marks.front)}`);

    // 5p. Touch feedback and the spin easter egg.
    //     The physics is driven directly rather than through synthetic mouse
    //     events, because a synthesised `mousemove` carries no `movementX` and
    //     the drag lean has nothing to read.
    await wc.executeJavaScript('__deskpet.clearOverlay(); __deskpet.pauseBehavior(true)');
    await sleep(300);
    const idlePose = await wc.executeJavaScript('__deskpet.gestures');

    await wc.executeJavaScript('__deskpet.press()');
    await sleep(60);
    const pressedPose = await wc.executeJavaScript('__deskpet.gestures');

    // Release and watch the spring: it has to overshoot the other way (she
    // stretches past her resting height) before settling. The extremes are
    // recorded inside the render loop, because the overshoot only lasts a few
    // tens of milliseconds and polling over IPC would miss it.
    await wc.executeJavaScript('__deskpet.resetSquashRange(); __deskpet.release()');
    await sleep(900);
    const released = await wc.executeJavaScript('__deskpet.gestures');
    const settledPose = released;

    await wc.executeJavaScript('__deskpet.resetSquashRange(); __deskpet.land()');
    await sleep(320);
    const landedPose = await wc.executeJavaScript('__deskpet.gestures');
    await sleep(1100);

    report.assertions.touchFeedback = {
      idle: idlePose.squash,
      pressed: Number(pressedPose.squash.toFixed(4)),
      releaseOvershoot: Number(released.minSquash.toFixed(4)),
      // The peak, not an instant: the spring has already decayed by the time a
      // round trip completes.
      landedPeak: Number(landedPose.maxSquash.toFixed(4)),
      settled: Number(settledPose.squash.toFixed(4)),
    };
    report.assertions.touchFeedbackOk = pressedPose.squash > 0.05   // pressed flatter
      && released.minSquash < -0.02                                 // then stretched past rest
      && landedPose.maxSquash > 0.12                                // landing hits hardest
      && Math.abs(settledPose.squash) < 0.01;                       // and it all relaxes

    // Circling the cursor has to wind her up, and it must take three turns, not
    // one stray arc across the desk. Coordinates are absolute screen positions,
    // because that is what the detector compares against her centre.
    const spinBefore = await wc.executeJavaScript('__deskpet.gestures');
    const centre = await wc.executeJavaScript('__deskpet.centre');
    const orbitScript = (turns, steps) => `
      (() => {
        const c = window.__deskpet;
        const o = ${JSON.stringify(centre)};
        for (let i = 0; i <= ${steps}; i += 1) {
          const a = (i / ${steps}) * Math.PI * 2 * ${turns};
          c.orbit(o.x + Math.cos(a) * 150, o.y + Math.sin(a) * 150);
        }
        return true;
      })()
    `;
    await wc.executeJavaScript(orbitScript(2, 40));
    const spinPartial = await wc.executeJavaScript('__deskpet.gestures');
    await wc.executeJavaScript(orbitScript(3.4, 80));
    const spinFull = await wc.executeJavaScript('__deskpet.gestures');
    await sleep(400);
    const spinOverlay = await wc.executeJavaScript('window.__deskpet.info');

    // The wobble has to decay. Measured as a peak over a window rather than at
    // one instant: it is a sine, so any single sample can land on a zero
    // crossing and look like "no wobble at all".
    await wc.executeJavaScript('__deskpet.resetSquashRange()');
    await sleep(700);
    const wobbleEarly = await wc.executeJavaScript('__deskpet.gestures.maxWobbleDeg');
    await wc.executeJavaScript('__deskpet.resetSquashRange()');
    await sleep(1600);
    const wobbleLate = await wc.executeJavaScript('__deskpet.gestures.maxWobbleDeg');
    const dizzyMs = await wc.executeJavaScript('__deskpet.dizzyMs');

    report.assertions.spin = {
      partialTurns: 2,
      partialSpinning: spinPartial.spinning,
      triggeredSpinning: spinFull.spinning,
      duringOverlay: spinOverlay.overlay,
      wobblePeakDeg: { early: wobbleEarly, late: wobbleLate },
      dizzyMs,
      beforeAccum: Number(spinBefore.spinAccum.toFixed(2)),
    };
    report.assertions.spinOk = spinPartial.spinning === false      // two turns is not enough
      && spinFull.spinning === true                                // three is
      && spinOverlay.overlay === 'dizzy'                           // straight to the wobble
      && wobbleEarly > 3                                           // it is visible
      && wobbleLate < wobbleEarly * 0.6                            // and it dies down
      && dizzyMs === 3000;                                         // over 3s

    // Her temper, driven through the REAL pointer handlers.
    // Driving `temper()` directly proved nothing about the wiring: the emotion
    // was being fired and then immediately overwritten by the ordinary
    // click/drag feedback in the same handler, which is exactly why it was
    // never visible. Synthetic mouse events exercise the whole path.
    await wc.executeJavaScript('__deskpet.clearOverlay(); __deskpet.pauseBehavior(true)');
    await sleep(300);

    const dragCycles = [];
    for (let i = 0; i < 3; i += 1) {
      await wc.executeJavaScript('__deskpet.pointerDrag(60, 20)');
      await sleep(220);
      dragCycles.push(await wc.executeJavaScript('window.__deskpet.info.overlay'));
    }
    const temperState = await wc.executeJavaScript('__deskpet.temperState');

    // Clicking: four pokes in a row should make her smug, and the reaction must
    // survive rather than being replaced by the greeting.
    await wc.executeJavaScript('__deskpet.clearOverlay()');
    await sleep(200);
    const clickCycles = [];
    for (let i = 0; i < 4; i += 1) {
      await wc.executeJavaScript('__deskpet.pointerClick()');
      await sleep(200);
      clickCycles.push(await wc.executeJavaScript('window.__deskpet.info.overlay'));
    }
    await wc.executeJavaScript('__deskpet.clearOverlay()');
    const temperPools = await wc.executeJavaScript('__deskpet.temperPools()');

    report.assertions.temper = {
      dragOverlays: dragCycles,
      temperEvents: temperState.events,
      clickOverlays: clickCycles,
      pools: temperPools,
    };
    report.assertions.temperOk =
      // Three real drags must produce the anger, and it must still be the
      // active overlay after the handler that caused it has finished.
      dragCycles[2] === 'angry'
      && dragCycles[1] !== 'angry'
      && temperState.events.drag === 0      // consumed by the trigger
      // Four real clicks must produce smugness, likewise unclobbered.
      && clickCycles[3] === 'proud'
      && temperPools.length === 4;

    write(`assert touch feedback: ${report.assertions.touchFeedbackOk} ` +
      `${JSON.stringify(report.assertions.touchFeedback)}`);
    write(`assert spinning her around: ${report.assertions.spinOk} ` +
      `${JSON.stringify(report.assertions.spin)}`);
    write(`assert her temper: ${report.assertions.temperOk} ` +
      `${JSON.stringify(report.assertions.temper)}`);
    await wc.executeJavaScript('__deskpet.clearOverlay()');

    // 5q. Being dragged must not change her pose.
    //     Facing the direction of travel was tried and removed: the left/right
    //     artwork is the walking sway, so swapping her out of the pose she was
    //     holding read as broken rather than as being carried. She keeps doing
    //     whatever she was doing; only the squash and the drop change.
    await wc.executeJavaScript('__deskpet.clearOverlay(); __deskpet.pauseBehavior(true)');
    await sleep(300);
    await wc.executeJavaScript(`__deskpet.setBase('reading')`);
    await sleep(400);
    const poseBeforeDrag = await wc.executeJavaScript('window.__deskpet.info');
    // A long, direction-changing drag: it must leave the pose and clip alone.
    for (let i = 0; i < 40; i += 1) {
      await wc.executeJavaScript(`__deskpet.drag(${i < 20 ? 14 : -14})`);
      await sleep(20);
    }
    const poseDuringDrag = await wc.executeJavaScript('window.__deskpet.info');
    await wc.executeJavaScript('__deskpet.release()');
    await sleep(200);
    report.assertions.dragKeepsPose = {
      beforeBase: poseBeforeDrag.base,
      beforeClip: poseBeforeDrag.clip,
      duringBase: poseDuringDrag.base,
      duringClip: poseDuringDrag.clip,
      dragging: true,
    };
    report.assertions.dragKeepsPoseOk = poseBeforeDrag.base === 'reading'
      && poseDuringDrag.base === poseBeforeDrag.base
      && poseDuringDrag.clip === poseBeforeDrag.clip;
    await wc.executeJavaScript('__deskpet.release(); __deskpet.clearOverlay()');

    // Every settle pose and every emotional state needs enough lines that the
    // repetition is not obvious, and the temper pools have to exist at all.
    const linePools = await wc.executeJavaScript('__deskpet.mutterKinds()');
    const lineThin = Object.entries(linePools).filter(([, n]) => n < 3).map(([k]) => k);
    const lineTotal = Object.values(linePools).reduce((a, b) => a + b, 0);
    report.assertions.linePools = { pools: linePools, total: lineTotal, thin: lineThin };
    report.assertions.linePoolsOk = lineThin.length === 0
      && Object.keys(linePools).length >= 13
      && lineTotal >= 100;
    write(`assert dragging keeps her pose: ${report.assertions.dragKeepsPoseOk} ` +
      `${JSON.stringify(report.assertions.dragKeepsPose)}`);
    write(`assert line pools are deep enough: ${report.assertions.linePoolsOk} ` +
      `${Object.keys(linePools).length} pools, ${lineTotal} lines` +
      `${lineThin.length ? ` THIN: ${lineThin}` : ''}`);

    // 5g3. The default size must be a 1:1 blit against the source art.
    //    208 is the atlas cell height, so every source pixel lands on exactly
    //    208/208 of a screen pixel at 100% scaling. Anything else resamples.
    const defaultSize = require('./config').DEFAULT_SETTINGS.sizePx;
    await wc.executeJavaScript('__deskpet.setSize(208)');
    await sleep(700);
    const native = await wc.executeJavaScript(`({
      box: window.__deskpet.info.petBox,
      inner: window.__deskpet.info.viewport,
      dpr: window.__deskpet.info.dpr,
    })`);
    report.assertions.nativeSize = {
      defaultSizePx: defaultSize,
      box: native.box,
      viewport: native.inner,
      dpr: native.dpr,
    };
    report.assertions.nativeSizeOk = defaultSize === 208
      && Math.round(native.box.width) === 192
      && Math.round(native.box.height) === 208
      // A whole-number device origin is what keeps a 1:1 blit from being
      // filtered across two pixels.
      && Number.isInteger(native.box.x * native.dpr)
      && Number.isInteger(native.box.y * native.dpr);
    write(`assert default size is pixel-exact: ${report.assertions.nativeSizeOk} ` +
      `${JSON.stringify(report.assertions.nativeSize)}`);
    await wc.executeJavaScript('__deskpet.setSize(416)');
    await sleep(500);

    // 5r. An ambient line must always time out.
    //     `scheduleHide` used to bail out whenever the streaming flag was set,
    //     so a stale flag left random one-liners on screen indefinitely. The
    //     flag may only protect a reply.
    await wc.executeJavaScript('__deskpet.forceBusy(true)');
    // Dismiss whatever the previous block left on screen first: `sayLine`
    // deliberately refuses to talk over a reply, so without this the mutter is
    // suppressed and the assertion measures the wrong bubble.
    await wc.executeJavaScript('__deskpet.hideBubble()');
    await sleep(200);
    await wc.executeJavaScript(`__deskpet.mutter('reading')`);
    await sleep(300);
    const ambientWhileBusy = await wc.executeJavaScript('window.__deskpet.info');
    await sleep(6200);
    const afterAmbientWait = await wc.executeJavaScript('window.__deskpet.info');
    await wc.executeJavaScript('__deskpet.forceBusy(false)');
    report.assertions.ambientExpires = {
      shownWhileBusy: ambientWhileBusy.bubbleVisible,
      kind: ambientWhileBusy.bubbleKind,
      stillVisibleAfter6s: afterAmbientWait.bubbleVisible,
    };
    report.assertions.ambientExpiresOk = ambientWhileBusy.bubbleVisible === true
      && ambientWhileBusy.bubbleKind === 'ambient'
      && afterAmbientWait.bubbleVisible === false;
    write(`assert ambient lines always expire: ${report.assertions.ambientExpiresOk} ` +
      `${JSON.stringify(report.assertions.ambientExpires)}`);

    // 5h. Prove the console capture itself works. Without this, a zero-error
    //     result is indistinguishable from a broken capture sink.
    await wc.executeJavaScript(`console.error('${PROBE}')`);
    await sleep(400);
    report.assertions.consoleCaptureWorks = consoleErrors.some((m) => m.includes(PROBE));
    write(`assert console capture works: ${report.assertions.consoleCaptureWorks}`);
    // Drop the deliberate probe so it does not read as a real failure.
    for (let i = consoleErrors.length - 1; i >= 0; i -= 1) {
      if (consoleErrors[i].includes(PROBE)) consoleErrors.splice(i, 1);
    }

    // 6. The settings window is a separate page; screenshot it too.
    if (openSettings) {
      // Robust lookup: the window is created asynchronously and may briefly be
      // absent or still loading.
      const findSettingsWindow = async () => {
        for (let i = 0; i < 40; i += 1) {
          const found = BrowserWindow.getAllWindows().find(
            (w) => w !== pet.win && !w.isDestroyed() && !w.webContents.isDestroyed(),
          );
          if (found && !found.webContents.isLoading()) return found;
          await sleep(250);
        }
        return null;
      };

      let settingsWin = await findSettingsWindow();
      if (!settingsWin) {
        openSettings();
        settingsWin = await findSettingsWindow();
      }

      if (settingsWin) {
        settingsWin.show();
        settingsWin.focus();
        await sleep(1500);
        const safeCapture = async (win) => {
          try {
            if (win.isDestroyed() || win.webContents.isDestroyed()) return null;
            return await win.capturePage();
          } catch (err) {
            write(`settings capture failed: ${err.message}`);
            return null;
          }
        };
        const image = await safeCapture(settingsWin);
        report.assertions.settingsWindow = Boolean(image && !image.isEmpty());
        if (image && !image.isEmpty()) {
          report.assertions.settingsWindowSize = image.getSize();
          fs.writeFileSync(path.join(QA_DIR, 'settings-window.png'), image.toPNG());
          write(`settings window capture: ${JSON.stringify(image.getSize())} empty=false`);
        } else {
          write('settings window capture: unavailable');
        }

        // 6b. Typing a key and clicking Save must actually persist it. This is
        //     the regression test for "I entered my API key and it still asks
        //     for one": the field used to save only on Enter, so the natural
        //     flow of typing then clicking 完成 silently discarded it.
        const settingsAlive = () => settingsWin
          && !settingsWin.isDestroyed()
          && !settingsWin.webContents.isDestroyed();
        if (settingsAlive()) {
          await settingsWin.webContents.executeJavaScript(`
            (() => {
              const input = document.getElementById('apiKey');
              input.value = 'sk-selftest-ui-key-0123456789';
              input.dispatchEvent(new Event('input', { bubbles: true }));
              document.getElementById('saveKey').click();
              return true;
            })()
          `);
          await sleep(1500);
        }
        const uiHint = settingsAlive()
          ? await settingsWin.webContents.executeJavaScript(`document.getElementById('keyHint').textContent`)
          : '';
        const storedKey = require('./secrets').readApiKey(config.get());
        report.assertions.keySave = {
          hint: uiHint,
          hintSaysSaved: /已保存/.test(uiHint),
          persisted: storedKey === 'sk-selftest-ui-key-0123456789',
          hasKeyFlag: require('./secrets').hasApiKey(config.get()),
        };
        report.assertions.keySaveOk = report.assertions.keySave.persisted
          && report.assertions.keySave.hasKeyFlag;
        write(`assert API key persists from the UI: ${report.assertions.keySaveOk} ` +
          `${JSON.stringify(report.assertions.keySave)}`);

        // Put it back so the screenshots below show the empty-key state.
        config.update(require('./secrets').writeApiKey(''));
        if (settingsAlive()) {
          await settingsWin.webContents.executeJavaScript(
            `document.getElementById('apiKey').value = '';
             document.getElementById('apiKey').dispatchEvent(new Event('input', { bubbles: true }));
             true`,
          );
          await sleep(500);

          // Scroll down so the balance and behaviour panels are verified too.
          await settingsWin.webContents.executeJavaScript(
            `document.querySelector('main').scrollTop = 460; true`,
          );
          await sleep(700);
          const scrolled = await safeCapture(settingsWin);
          if (scrolled && !scrolled.isEmpty()) {
            fs.writeFileSync(path.join(QA_DIR, 'settings-window-2.png'), scrolled.toPNG());
            write('settings window (scrolled) captured');
          }
        }
        if (settingsAlive()) settingsWin.close();
      } else {
        report.assertions.settingsWindow = false;
        write('ERROR: the settings window never opened');
      }
    }
  } catch (err) {
    report.error = err && err.stack ? err.stack : String(err);
    write(`ERROR: ${report.error}`);
  } finally {
    // Judge by scanning every boolean assertion, not a hand-written list and
    // not by name suffix. Matching on `*Ok` silently ignored `walkMoved`,
    // `windowVisible` and `thinkingPersists` for several runs -- a failing
    // check that the report called a pass.
    const a = report.assertions || {};
    const failed = Object.entries(a)
      .filter(([, value]) => value === false)
      .map(([key]) => key);
    const consoleErrorsNow = consoleErrors.slice();

    report.consoleErrors = consoleErrorsNow;
    report.failedAssertions = failed;
    report.ok = !report.error && consoleErrorsNow.length === 0 && failed.length === 0;
    // The verdict line has to agree with `ok`, or a run can print PASS with a
    // red report sitting right next to it.
    if (report.ok) {
      write('ALL CHECKS PASSED');
    } else {
      const reasons = [
        ...failed,
        ...(consoleErrorsNow.length ? [`${consoleErrorsNow.length} console error(s)`] : []),
        ...(report.error ? ['the run threw'] : []),
      ];
      write(`CHECKS FAILED: ${reasons.join(', ')}`);
    }

    fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
    if (config) config.update({ position: null }); // do not persist test placement
    setTimeout(() => app.exit(report.ok ? 0 : 1), 200);
  }
}

/**
 * Attach renderer console forwarding.
 *
 * Electron changed this event's signature in v35: it is now
 * `(event, details)` where details carries `{level, message, lineNumber,
 * sourceId}`. Older builds pass `(event, level, message, line, sourceId)`.
 * Getting this wrong silently swallows every renderer error, so handle both.
 *
 * @param {Electron.WebContents} webContents
 * @param {string[]} sink
 */
function attachConsoleCapture(webContents, sink) {
  webContents.on('console-message', (...args) => {
    let level;
    let message;

    if (args[1] && typeof args[1] === 'object' && 'message' in args[1]) {
      ({ level, message } = args[1]);
    } else {
      [, level, message] = args;
    }

    const problematic = level === 'error' || level === 'warning' || level === 3 || level === 2;
    if (problematic) sink.push(`[${String(level)}] ${String(message)}`);
  });
}

module.exports = { run, attachConsoleCapture };
