// Credential round-trip test. Needs Electron because it uses safeStorage.
//
//   electron tools/test-secrets.js
'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOG = path.resolve('.qa/secrets.log');
const lines = [];

function log(message) {
  lines.push(message);
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.writeFileSync(LOG, `${lines.join('\n')}\n`);
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

app.whenReady().then(() => {
  const { Config } = require('../src/main/config.js');
  const secrets = require('../src/main/secrets.js');

  let failures = 0;
  const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures += 1;
    log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` | expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`}`);
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-secrets-'));
  const config = new Config(dir);
  config.load();

  log(`safeStorage.isEncryptionAvailable() = ${secrets.canEncrypt()}`);
  check('no key initially', secrets.hasApiKey(config.get()), false);
  check('readApiKey empty initially', secrets.readApiKey(config.get()), '');

  // This is exactly what the settings:save IPC handler does.
  const TEST_KEY = 'sk-selftest-roundtrip-0123456789';
  config.update(secrets.writeApiKey(TEST_KEY));

  check('hasApiKey after write', secrets.hasApiKey(config.get()), true);
  check('readApiKey returns the key', secrets.readApiKey(config.get()), TEST_KEY);

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  log(`stored fields: apiKey=${JSON.stringify(onDisk.apiKey)} ` +
    `apiKeyCipher=${onDisk.apiKeyCipher ? `${String(onDisk.apiKeyCipher).slice(0, 16)}… (${onDisk.apiKeyCipher.length} chars)` : '(absent)'}`);
  check('plaintext key not stored in the clear', onDisk.apiKey === '' || !onDisk.apiKey, true);

  // Re-load from disk: this is what a restart does, and it is where a bad
  // migration or a lost field would show up.
  const reloaded = new Config(dir);
  reloaded.load();
  check('survives a reload (hasApiKey)', secrets.hasApiKey(reloaded.get()), true);
  check('survives a reload (value)', secrets.readApiKey(reloaded.get()), TEST_KEY);

  // And clearing must work.
  reloaded.update(secrets.writeApiKey(''));
  check('cleared', secrets.hasApiKey(reloaded.get()), false);
  check('cleared value', secrets.readApiKey(reloaded.get()), '');

  // A tampered/corrupt cipher must not crash the app.
  const broken = new Config(dir);
  broken.load();
  broken.update({ apiKeyCipher: 'not-valid-base64-ciphertext', apiKey: '' });
  check('corrupt cipher degrades to empty', secrets.readApiKey(broken.get()), '');

  fs.rmSync(dir, { recursive: true, force: true });
  log(failures === 0 ? '\nall credential tests passed' : `\n${failures} test(s) failed`);
  app.exit(failures === 0 ? 0 : 1);
});
