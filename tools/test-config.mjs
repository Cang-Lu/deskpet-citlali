// Unit tests for settings migration.
//
//   node tools/test-config.mjs
//
// These run without Electron: `config.js` only depends on node:fs and node:path.
// The point is to catch the class of bug where a changed default silently does
// nothing for anyone who already has the old value stored.
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Config, DEFAULT_SETTINGS, resolveDataDir } = require('../src/main/config.js');

let failures = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`}`);
}

/** Write a settings file and load it back through Config. */
function load(stored) {
  const dir = mkdtempSync(path.join(tmpdir(), 'deskpet-test-'));
  if (stored) writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(stored, null, 2));
  const config = new Config(dir);
  config.load();
  const result = config.get();
  return { result, dir };
}

/* ------------------------------------------------------------------ */

{
  // A brand new install must get today's defaults.
  const { result, dir } = load(null);
  check('fresh install: version', result.settingsVersion, 3);
  check('fresh install: mood tint off', result.moodTint, false);
  check('fresh install: render mode', result.renderMode, 'auto');
  check('fresh install: size', result.sizePx, DEFAULT_SETTINGS.sizePx);
  rmSync(dir, { recursive: true, force: true });
}

{
  // The exact case that caused a real bug: v2 stored moodTint: true, and simply
  // changing the default left the old value in place.
  const { result, dir } = load({
    settingsVersion: 2,
    moodTint: true,
    sizePx: 520,
    renderMode: 'crisp',
    scale: 1.5,
  });
  check('v2 -> v3: mood tint forced off', result.moodTint, false);
  check('v2 -> v3: render mode normalised', result.renderMode, 'auto');
  check('v2 -> v3: size preserved', result.sizePx, 520);
  check('v2 -> v3: version bumped', result.settingsVersion, 3);
  check('v2 -> v3: legacy scale removed', 'scale' in result, false);
  rmSync(dir, { recursive: true, force: true });
}

{
  // A v1 file has neither sizePx nor a version; the old `scale` should be
  // converted rather than dropped.
  const { result, dir } = load({ scale: 1.5 });
  check('v1 -> v3: size derived from scale', result.sizePx, 312);
  check('v1 -> v3: mood tint off', result.moodTint, false);
  rmSync(dir, { recursive: true, force: true });
}

{
  // Already-current files must be left alone.
  const { result, dir } = load({ settingsVersion: 3, moodTint: true, sizePx: 600 });
  check('v3: explicit mood tint respected', result.moodTint, true);
  check('v3: size respected', result.sizePx, 600);
  rmSync(dir, { recursive: true, force: true });
}

{
  // Out-of-range sizes get clamped.
  const { result, dir } = load({ settingsVersion: 3, sizePx: 99999 });
  check('size clamped to max', result.sizePx, 900);
  rmSync(dir, { recursive: true, force: true });
}

{
  // A corrupt file must not stop the app booting.
  const dir = mkdtempSync(path.join(tmpdir(), 'deskpet-test-'));
  writeFileSync(path.join(dir, 'settings.json'), '{ this is not json');
  const config = new Config(dir);
  config.load();
  check('corrupt file falls back to defaults', config.get().sizePx, DEFAULT_SETTINGS.sizePx);
  rmSync(dir, { recursive: true, force: true });
}

check('DESKPET_DATA_DIR is honoured', resolveDataDir('/default'), process.env.DESKPET_DATA_DIR
  ? path.resolve(process.env.DESKPET_DATA_DIR)
  : '/default');

/* ------------------------------------------------------------------ */

console.log(failures === 0 ? '\nall migration tests passed' : `\n${failures} test(s) failed`);
process.exit(failures === 0 ? 0 : 1);
