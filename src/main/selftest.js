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
    await wc.executeJavaScript(`window.deskpet.walk(${JSON.stringify({
      direction: -1, speed: 260, targetX: startX - 150,
    })})`);
    await sleep(1500);
    const endX = pet.win.getPosition()[0];
    report.assertions.walkFrom = startX;
    report.assertions.walkTo = endX;
    report.assertions.walkMoved = endX < startX - 100;
    write(`assert walk moved: ${report.assertions.walkMoved} (${startX} -> ${endX})`);

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
      supersample: quality.box.supersample,
      mode: quality.mode,
    };
    report.assertions.rasterOk = quality.mode === 'nearest'
      || (Number.isInteger(quality.box.supersample) && quality.box.supersample >= 1);
    write(`assert rasterisation: ${report.assertions.rasterOk} ${JSON.stringify(report.assertions.raster)}`);

    // 5d. Sizing must be continuous, not snapped to a handful of steps.
    const freeSizes = [];
    for (const want of [333, 400, 507]) {
      await wc.executeJavaScript(`__deskpet.setSize(${want})`);
      await sleep(700);
      const got = await wc.executeJavaScript('window.__deskpet.info');
      freeSizes.push({ want, got: Number(got.petBox.height.toFixed(1)) });
    }
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
    const outside = await wc.executeJavaScript('window.__deskpet.measureBackgroundRegions()');

    const fidelity = [];
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
        tolerance: r.tolerance,
        withinTolerance: delta <= r.tolerance,
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
    await wc.executeJavaScript('window.deskpet.saveSettings({ moodTint: true })');
    await sleep(700);
    const tinted = await wc.executeJavaScript('window.__deskpet.measureRegions()');

    const shifts = [];
    for (const r of tinted) {
      const base = rendered.find((b) => b.name === r.name);
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
    await wc.executeJavaScript('__deskpet.pauseBehavior(false); __deskpet.startWalk(); true');
    await sleep(500);
    const duringWalk = await wc.executeJavaScript('window.__deskpet.info');
    const finished = await walkPoll(10_000);
    report.assertions.walkCompletes = {
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

    // And she must render the calm lying row while reading.
    await wc.executeJavaScript(`__deskpet.setBase('reading')`);
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
        report.assertions.historyWindowOk = shown.turns > 0;
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
    // Judge by scanning the assertions instead of listing them by hand.
    // The hand-maintained list silently passed a failing check the moment a new
    // assertion was added and forgotten -- which is exactly what happened.
    const a = report.assertions || {};
    const failed = [
      ...Object.entries(a).filter(([k, v]) => k.endsWith('Ok') && v !== true).map(([k]) => k),
      ...Object.entries(a).filter(([k, v]) => k.endsWith('Handled') && v === false).map(([k]) => k),
    ];
    if (a.settingsWindow === false) failed.push('settingsWindow');

    report.consoleErrors = consoleErrors.slice();
    report.failedAssertions = failed;
    report.ok = !report.error && consoleErrors.length === 0 && failed.length === 0;
    write(failed.length ? `CHECKS FAILED: ${failed.join(', ')}` : 'ALL CHECKS PASSED');

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
