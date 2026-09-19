'use strict';

const { safeStorage } = require('electron');

/**
 * Keep the API key out of plain-text settings and out of the renderer.
 *
 * When the OS keychain is available (DPAPI on Windows, Keychain on macOS,
 * libsecret on Linux) the key is stored encrypted; otherwise we fall back to
 * plain text and say so, rather than silently pretending it is protected.
 */

const CIPHER_FIELD = 'apiKeyCipher';
const PLAIN_FIELD = 'apiKey';

function canEncrypt() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** Pull the usable key out of a settings object. */
function readApiKey(settings) {
  if (settings[CIPHER_FIELD]) {
    try {
      return safeStorage.decryptString(Buffer.from(settings[CIPHER_FIELD], 'base64'));
    } catch (err) {
      console.error('[secrets] could not decrypt the stored key:', err.message);
      return '';
    }
  }
  return settings[PLAIN_FIELD] || '';
}

/**
 * Produce the settings patch that stores `key`.
 * Passing an empty string clears the stored credential.
 */
function writeApiKey(key) {
  const patch = { [PLAIN_FIELD]: '', [CIPHER_FIELD]: '' };
  const trimmed = (key || '').trim();
  if (!trimmed) return patch;

  if (canEncrypt()) {
    patch[CIPHER_FIELD] = safeStorage.encryptString(trimmed).toString('base64');
  } else {
    patch[PLAIN_FIELD] = trimmed;
  }
  return patch;
}

/** True when a credential already exists, without revealing it. */
function hasApiKey(settings) {
  return Boolean(settings[CIPHER_FIELD] || settings[PLAIN_FIELD]);
}

module.exports = { readApiKey, writeApiKey, hasApiKey, canEncrypt };
