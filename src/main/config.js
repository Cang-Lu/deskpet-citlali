'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Resolve where user data lives.
 *
 * DESKPET_DATA_DIR exists so the app can be run in a portable / sandboxed way
 * (and so tests never touch the real %APPDATA% profile).
 */
function resolveDataDir(defaultDir) {
  return process.env.DESKPET_DATA_DIR
    ? path.resolve(process.env.DESKPET_DATA_DIR)
    : defaultDir;
}

const DEFAULT_SETTINGS = {
  /**
   * Bumped whenever a stored value needs correcting.
   *   1 - original `scale` multiplier
   *   2 - `sizePx` + `renderMode: crisp|smooth`, mood tint defaulted ON
   *   3 - `renderMode: auto|nearest`, mood tint defaults OFF
   * Changing a default does nothing for a config file that already stored the
   * old value, so every such change needs a migration step here.
   */
  settingsVersion: 3,

  // --- model ---
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  temperature: 1.15,
  maxTokens: 700,

  // --- work mode ---
  /**
   * When on, the brevity rule is lifted and she answers properly.
   *
   * Casual desk-pet replies are capped at "1-3 sentences" by the persona, which
   * is right for small talk and useless when you actually want help. This flips
   * the prompt to the working voice and raises the ceiling.
   */
  workMode: false,
  workTemperature: 0.6,
  workMaxTokens: 2400,

  // --- appearance ---
  /** Target sprite height in CSS px; snapped to whole device pixels. */
  sizePx: 416,
  /** 'auto' = supersampled (any size stays clean), 'nearest' = hard pixel edges. */
  renderMode: 'auto',
  /** Strip the dark matte out of the atlas's anti-aliased edges. */
  defringe: true,
  /**
   * Optional mood colour cast on the character herself.
   *
   * Off by default. Even a 0.13 tint shifts the blue channel by ~12/255, and
   * because her cushion is one large near-white area that reads as "the cushion
   * turned cream" -- i.e. she looks recoloured rather than lit. Mood is carried
   * by the particle effects instead, which never touch her palette.
   */
  moodTint: false,
  showBubbleOnReply: true,

  // --- window behaviour ---
  position: null,
  alwaysOnTop: true,
  clickThrough: true,
  autoLaunch: false,
  petName: '茜特菈莉',

  // --- autonomous behaviour ---
  proactive: {
    enabled: true,
    wander: true,
    idleChatter: true,
    chatterMinutes: 25,
    sleepAfterMinutes: 12,
    gazeFollow: true,
  },

  // --- account balance ---
  // The first three fields are user settings; the rest is cached state so the
  // last known balance survives a restart.
  balance: {
    enabled: true,
    intervalMinutes: 30,
    lowThreshold: 5,
    lastAvailable: null,
    lastTotal: null,
    lastCurrency: null,
    lastGranted: null,
    lastToppedUp: null,
    lastCheckedAt: 0,
    lastError: null,
    warnedAt: 0,
    warnedForAmount: null,
  },
};

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)
      && base && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

class Config {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'settings.json');
    this.historyFile = path.join(dataDir, 'history.json');
    this.settings = { ...DEFAULT_SETTINGS };
    this.history = [];
  }

  load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    // The stored version has to be read from the raw file: deepMerge fills in
    // today's default for every key, so after merging nothing looks old.
    const stored = readJson(this.file, {});
    const from = Number(stored.settingsVersion) || 1;
    this.settings = migrate(deepMerge(DEFAULT_SETTINGS, stored), from);
    this.history = readJson(this.historyFile, []);
    if (!Array.isArray(this.history)) this.history = [];
    return this.settings;
  }

  get() {
    return this.settings;
  }

  update(patch) {
    this.settings = deepMerge(this.settings, patch);
    writeJson(this.file, this.settings);
    return this.settings;
  }

  getHistory() {
    return this.history;
  }

  /** Persist dialogue turns, keeping the tail bounded. */
  setHistory(messages, cap = 80) {
    this.history = messages.slice(-cap);
    writeJson(this.historyFile, this.history);
    return this.history;
  }

  clearHistory() {
    this.history = [];
    writeJson(this.historyFile, []);
  }

  /** Path helper used by the renderer to load the atlas. */
  assetPath(...parts) {
    return path.join(...parts);
  }
}

const SETTINGS_VERSION = 3;

/**
 * Bring an older settings file forward.
 *
 * Changing a default in DEFAULT_SETTINGS does NOT update anyone who already has
 * that key stored -- deepMerge keeps the stored value. Anything the defaults
 * change therefore has to be corrected explicitly here, which is why the
 * settings file carries a version.
 *
 * Note that this runs AFTER deepMerge, so the object already contains today's
 * defaults for every key. "Is this key missing?" is never a usable test;
 * migrations have to branch on the stored version instead.
 */
function migrate(settings, from) {
  const next = { ...settings };
  const version = Number(from) || 1;

  // v2 shipped with the mood colour cast ON. It turned out to visibly recolour
  // her -- about 11/255 on the cushion, which reads as "the cushion is cream
  // now" -- so v3 turns it off, including for existing installs.
  if (version < SETTINGS_VERSION) next.moodTint = false;

  // v1 scaled with a multiplier; v2 replaced it with an absolute pixel height.
  if (version < 2 && Number.isFinite(Number(next.scale))) {
    next.sizePx = Math.round(208 * Number(next.scale));
  }
  if (next.renderMode === 'crisp' || next.renderMode === 'smooth') {
    next.renderMode = 'auto';
  }
  next.sizePx = Math.min(900, Math.max(96, Math.round(Number(next.sizePx) || 416)));
  delete next.scale;

  next.settingsVersion = SETTINGS_VERSION;
  return next;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Write via a temp file + rename so a crash can never truncate the config. */
function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[config] failed to write', file, err.message);
  }
}

module.exports = { Config, DEFAULT_SETTINGS, resolveDataDir };
