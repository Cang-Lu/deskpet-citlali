/**
 * Settings window.
 *
 * The API key is write-only: main never sends the stored key back, only a
 * boolean "one is saved". Leaving the field empty therefore means "keep the
 * existing key", and clearing it requires the explicit button.
 */

import {
  DEFAULT_SPRITE_HEIGHT,
  MIN_SPRITE_HEIGHT,
  MAX_SPRITE_HEIGHT,
  supersampleFactor,
} from '../shared/pet-spec.js';

const api = window.deskpet;

const el = (id) => document.getElementById(id);

const fields = {
  apiKey: el('apiKey'),
  baseUrl: el('baseUrl'),
  model: el('model'),
  temperature: el('temperature'),
  temperatureValue: el('temperatureValue'),
  maxTokens: el('maxTokens'),
  workMode: el('workMode'),
  workTemperature: el('workTemperature'),
  workTemperatureValue: el('workTemperatureValue'),
  workMaxTokens: el('workMaxTokens'),

  sizePx: el('sizePx'),
  sizeValue: el('sizeValue'),
  sizeHint: el('sizeHint'),
  renderMode: el('renderMode'),
  integerScale: el('integerScale'),
  defringe: el('defringe'),
  moodTint: el('moodTint'),
  alwaysOnTop: el('alwaysOnTop'),
  clickThrough: el('clickThrough'),
  autoLaunch: el('autoLaunch'),

  balanceAmount: el('balanceAmount'),
  balanceDetail: el('balanceDetail'),
  balanceResult: el('balanceResult'),
  balanceEnabled: el('balanceEnabled'),
  balanceInterval: el('balanceInterval'),
  balanceThreshold: el('balanceThreshold'),

  proactiveEnabled: el('proactiveEnabled'),
  wander: el('wander'),
  gazeFollow: el('gazeFollow'),
  idleChatter: el('idleChatter'),
  chatterMinutes: el('chatterMinutes'),
  sleepAfterMinutes: el('sleepAfterMinutes'),
};

const statusEl = el('status');
const keyHint = el('keyHint');
const testResult = el('testResult');
const historyInfo = el('historyInfo');

let current = null;
let saveTimer = null;
let balanceState = null;
let sizeSaveTimer = null;

/* ------------------------------------------------------------------ */

function render(settings, { resetKeyField = false } = {}) {
  current = settings;
  fields.baseUrl.value = settings.baseUrl || '';
  fields.model.value = settings.model || '';
  fields.temperature.value = String(settings.temperature ?? 1.15);
  fields.temperatureValue.textContent = Number(settings.temperature ?? 1.15).toFixed(2);
  fields.maxTokens.value = String(settings.maxTokens ?? 700);
  fields.workMode.checked = Boolean(settings.workMode);
  fields.workTemperature.value = String(settings.workTemperature ?? 0.6);
  fields.workTemperatureValue.textContent = Number(settings.workTemperature ?? 0.6).toFixed(2);
  fields.workMaxTokens.value = String(settings.workMaxTokens ?? 2400);

  const sizePx = Number(settings.sizePx) || DEFAULT_SPRITE_HEIGHT;
  fields.sizePx.value = String(sizePx);
  fields.sizeValue.textContent = `${sizePx} px`;
  fields.renderMode.value = settings.renderMode === 'nearest' ? 'nearest' : 'auto';
  fields.integerScale.checked = settings.integerScale !== false;
  fields.defringe.checked = settings.defringe !== false;
  fields.moodTint.checked = settings.moodTint !== false;
  fields.alwaysOnTop.checked = Boolean(settings.alwaysOnTop);
  fields.clickThrough.checked = Boolean(settings.clickThrough);
  fields.autoLaunch.checked = Boolean(settings.autoLaunch);

  const balance = settings.balance || {};
  fields.balanceEnabled.checked = balance.enabled !== false;
  fields.balanceInterval.value = String(balance.intervalMinutes ?? 30);
  fields.balanceThreshold.value = String(balance.lowThreshold ?? 5);

  const proactive = settings.proactive || {};
  fields.proactiveEnabled.checked = Boolean(proactive.enabled);
  fields.wander.checked = Boolean(proactive.wander);
  fields.gazeFollow.checked = Boolean(proactive.gazeFollow);
  fields.idleChatter.checked = Boolean(proactive.idleChatter);
  fields.chatterMinutes.value = String(proactive.chatterMinutes ?? 25);
  fields.sleepAfterMinutes.value = String(proactive.sleepAfterMinutes ?? 12);

  // Never blow away a key the user has typed but not saved yet: this function
  // also runs whenever any *other* setting changes.
  if (resetKeyField || !fields.apiKey.value) fields.apiKey.value = '';
  fields.apiKey.placeholder = settings.hasApiKey ? '已保存（留空则保持不变）' : 'sk-…';

  if (fields.apiKey.value.trim()) {
    keyHint.textContent = '还没保存，点右边「保存」或按回车。';
    keyHint.className = 'hint pending';
  } else if (settings.hasApiKey) {
    keyHint.textContent = settings.keyEncrypted
      ? '已保存，并使用系统密钥库加密存储。'
      : '已保存（当前系统不支持加密存储，明文保存在配置文件中）。';
    keyHint.className = 'hint ok';
  } else {
    keyHint.textContent = '还没有配置 Key。到 platform.deepseek.com 申请后填在这里。';
    keyHint.className = 'hint warn';
  }

  updateSizeHint();
  updateSubState();
}

/**
 * Describe what the pet window will actually draw.
 *
 * Sizing is continuous now, so this explains the rasterisation instead of
 * warning about snapped steps.
 */
function updateSizeHint() {
  const dpr = window.devicePixelRatio || 1;
  const target = Number(fields.sizePx.value) || DEFAULT_SPRITE_HEIGHT;
  const requested = `高度 ${target} px`;

  if (fields.renderMode.value === 'nearest') {
    fields.sizeHint.textContent =
      `${requested}。硬边像素模式不做任何平滑，放大时会保留锯齿感。显示器缩放 ${dpr}×。`;
    fields.sizeHint.className = 'hint';
    return;
  }

  const factor = supersampleFactor({ targetHeight: target, dpr });
  const deviceHeight = target * dpr;
  const exact = Math.abs(deviceHeight - factor * 208) < 0.5;
  fields.sizeHint.textContent = exact
    ? `${requested}，正好是 ${factor}× 整数像素，最锐利。任意尺寸都能调，不止这几档。显示器缩放 ${dpr}×。`
    : `${requested}，按 ${factor}× 超采样后缩放，边缘平滑。显示器缩放 ${dpr}×。`;
  fields.sizeHint.className = 'hint';
}

function updateSubState() {
  const on = fields.proactiveEnabled.checked;
  for (const node of [fields.wander, fields.gazeFollow, fields.idleChatter, fields.chatterMinutes, fields.sleepAfterMinutes]) {
    node.disabled = !on;
  }
  const balanceOn = fields.balanceEnabled.checked;
  fields.balanceInterval.disabled = !balanceOn;
  fields.balanceThreshold.disabled = !balanceOn;
}

function flash(message) {
  statusEl.textContent = message;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    statusEl.textContent = '';
  }, 2200);
}

/* ------------------------------------------------------------------ */

async function save(patch) {
  const next = await api.saveSettings(patch);
  render(next);
  flash('已保存');
  return next;
}

/** Collect the current form state into a settings patch. */
function collect() {
  const patch = {
    baseUrl: fields.baseUrl.value.trim(),
    model: fields.model.value.trim(),
    temperature: Number(fields.temperature.value),
    maxTokens: Number(fields.maxTokens.value) || 700,
    workMode: fields.workMode.checked,
    workTemperature: Number(fields.workTemperature.value),
    workMaxTokens: Number(fields.workMaxTokens.value) || 2400,
    sizePx: Number(fields.sizePx.value) || DEFAULT_SPRITE_HEIGHT,
    renderMode: fields.renderMode.value,
    integerScale: fields.integerScale.checked,
    defringe: fields.defringe.checked,
    moodTint: fields.moodTint.checked,
    alwaysOnTop: fields.alwaysOnTop.checked,
    clickThrough: fields.clickThrough.checked,
    autoLaunch: fields.autoLaunch.checked,
    proactive: {
      enabled: fields.proactiveEnabled.checked,
      wander: fields.wander.checked,
      gazeFollow: fields.gazeFollow.checked,
      idleChatter: fields.idleChatter.checked,
      chatterMinutes: Number(fields.chatterMinutes.value) || 25,
      sleepAfterMinutes: Number(fields.sleepAfterMinutes.value) || 12,
    },
    balance: {
      enabled: fields.balanceEnabled.checked,
      intervalMinutes: Number(fields.balanceInterval.value) || 30,
      lowThreshold: Number(fields.balanceThreshold.value) || 0,
    },
  };
  // An empty box means "leave the stored credential alone".
  const key = fields.apiKey.value.trim();
  if (key) patch.apiKey = key;
  return patch;
}

/* ------------------------------------------------------------------ */
/* Balance                                                             */
/* ------------------------------------------------------------------ */

function money(amount, currency) {
  if (amount == null || !Number.isFinite(Number(amount))) return '—';
  const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : `${currency || ''} `;
  return `${symbol}${Number(amount).toFixed(2)}`;
}

function renderBalance(state) {
  balanceState = state;
  if (!state || !state.hasKey) {
    fields.balanceAmount.textContent = '—';
    fields.balanceDetail.textContent = '配置 API Key 后即可查询余额。';
    fields.balanceAmount.className = 'balance-amount';
    return;
  }

  if (state.error) {
    fields.balanceAmount.textContent = '查询失败';
    fields.balanceDetail.textContent = state.error;
    fields.balanceAmount.className = 'balance-amount unknown';
    return;
  }

  if (state.total == null) {
    fields.balanceAmount.textContent = '—';
    fields.balanceDetail.textContent = '还没有查询过。';
    fields.balanceAmount.className = 'balance-amount unknown';
    return;
  }

  const low = state.total <= (Number(state.lowThreshold) || 0);
  fields.balanceAmount.textContent = money(state.total, state.currency);
  fields.balanceAmount.className = `balance-amount${low ? ' low' : ' ok'}`;

  const parts = [];
  if (state.granted) parts.push(`赠金 ${money(state.granted, state.currency)}`);
  if (state.toppedUp) parts.push(`充值 ${money(state.toppedUp, state.currency)}`);
  if (state.isAvailable === false) parts.push('账户余额不足，API 已不可用');
  if (state.checkedAt) {
    parts.push(`查询于 ${new Date(state.checkedAt).toLocaleString()}`);
  }
  fields.balanceDetail.textContent = parts.join(' · ') || '—';
}

/* ------------------------------------------------------------------ */

/**
 * Save just the API key.
 *
 * Deliberately not routed through `collect()`: the key is the one field where a
 * stray side effect is unacceptable, so this sends the credential and nothing
 * else, then re-renders so the "已保存" state is visible immediately.
 */
async function saveApiKey() {
  const key = fields.apiKey.value.trim();
  if (!key) {
    render(await api.getSettings(), { resetKeyField: true });
    return false;
  }
  const next = await api.saveSettings({ apiKey: key });
  render(next, { resetKeyField: true });
  flash(next.hasApiKey ? 'Key 已保存' : '保存失败，请重试');
  return Boolean(next.hasApiKey);
}

function wireHandlers() {
  const auto = ['baseUrl', 'model', 'maxTokens', 'renderMode', 'chatterMinutes', 'sleepAfterMinutes',
    'balanceInterval', 'balanceThreshold', 'workMaxTokens'];
  for (const id of auto) {
    el(id).addEventListener('change', () => save(collect()));
  }
  for (const id of ['alwaysOnTop', 'clickThrough', 'autoLaunch', 'integerScale', 'defringe', 'moodTint', 'workMode',
    'proactiveEnabled', 'wander', 'gazeFollow', 'idleChatter', 'balanceEnabled']) {
    el(id).addEventListener('change', () => {
      updateSubState();
      save(collect());
    });
  }

  // Dragging the sliders should not hammer the disk or the window manager.
  const commitSize = () => save(collect());
  fields.sizePx.addEventListener('input', () => {
    fields.sizeValue.textContent = `${fields.sizePx.value} px`;
    updateSizeHint();
    if (sizeSaveTimer) clearTimeout(sizeSaveTimer);
    sizeSaveTimer = setTimeout(commitSize, 180);
  });
  fields.sizePx.addEventListener('change', () => {
    if (sizeSaveTimer) clearTimeout(sizeSaveTimer);
    commitSize();
  });

  const nudge = (delta) => {
    const next = Math.min(900, Math.max(120, (Number(fields.sizePx.value) || DEFAULT_SPRITE_HEIGHT) + delta));
    fields.sizePx.value = String(next);
    fields.sizeValue.textContent = `${next} px`;
    updateSizeHint();
    commitSize();
  };
  el('sizeSmaller').addEventListener('click', () => nudge(-48));
  el('sizeBigger').addEventListener('click', () => nudge(48));

  fields.temperature.addEventListener('input', () => {
    fields.temperatureValue.textContent = Number(fields.temperature.value).toFixed(2);
  });
  fields.temperature.addEventListener('change', () => save(collect()));

  fields.workTemperature.addEventListener('input', () => {
    fields.workTemperatureValue.textContent = Number(fields.workTemperature.value).toFixed(2);
  });
  fields.workTemperature.addEventListener('change', () => save(collect()));

  // The key field saves on Enter, on blur, and via its own button -- three ways
  // to avoid the original trap where Enter was the only one and nobody knew.
  fields.apiKey.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveApiKey();
    }
  });
  fields.apiKey.addEventListener('blur', () => {
    if (fields.apiKey.value.trim()) saveApiKey();
  });
  fields.apiKey.addEventListener('input', () => {
    keyHint.textContent = fields.apiKey.value.trim()
      ? '还没保存，点右边「保存」或按回车。'
      : (current && current.hasApiKey ? '已保存，留空则保持不变。' : '还没有配置 Key。');
    keyHint.className = fields.apiKey.value.trim() ? 'hint pending' : 'hint';
  });
  el('saveKey').addEventListener('click', () => saveApiKey());

  el('test').addEventListener('click', async () => {
    const button = el('test');
    button.disabled = true;
    testResult.className = 'result';
    testResult.textContent = '正在连接…';
    try {
      const result = await api.testConnection({
        apiKey: fields.apiKey.value.trim() || undefined,
        baseUrl: fields.baseUrl.value.trim(),
        model: fields.model.value.trim(),
      });
      testResult.className = result.ok ? 'result ok' : 'result err';
      testResult.textContent = result.ok
        ? `${result.message}${result.sample ? ` · 回复：“${result.sample}”` : ''}`
        : result.message;
    } catch (err) {
      testResult.className = 'result err';
      testResult.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });

  el('refreshBalance').addEventListener('click', async () => {
    const button = el('refreshBalance');
    button.disabled = true;
    fields.balanceResult.className = 'result';
    fields.balanceResult.textContent = '正在查询…';
    try {
      // Persist first so a just-typed key is the one being tested.
      await api.saveSettings(collect());
      const result = await api.refreshBalance();
      if (result.ok) {
        fields.balanceResult.className = 'result ok';
        fields.balanceResult.textContent =
          `当前余额 ${money(result.total, result.currency)}（${result.isAvailable ? '账户可用' : '余额不足，API 已不可用'}）`;
        renderBalance(result);
      } else {
        fields.balanceResult.className = 'result err';
        fields.balanceResult.textContent = result.error;
        renderBalance({ ...(balanceState || {}), hasKey: true, error: result.error });
      }
    } catch (err) {
      fields.balanceResult.className = 'result err';
      fields.balanceResult.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });

  el('clearKey').addEventListener('click', async () => {
    await api.saveSettings({ clearApiKey: true });
    render(await api.getSettings());
    renderBalance(await api.getBalance());
    testResult.className = 'result';
    testResult.textContent = '已清除本地保存的 Key。';
  });

  el('clearHistory').addEventListener('click', async () => {
    await api.clearHistory();
    await refreshHistory();
    flash('记忆已清空');
  });

  el('close').addEventListener('click', async () => {
    // "完成" must not silently discard a freshly typed key.
    if (fields.apiKey.value.trim()) await saveApiKey();
    window.close();
  });
}

async function refreshHistory() {
  const history = await api.getHistory();
  const turns = history.filter((m) => m.role === 'user').length;
  historyInfo.textContent = turns
    ? `目前记得 ${turns} 轮对话（约 ${history.length} 条消息），保存在本地。`
    : '还没有对话记录。';
}

/* ------------------------------------------------------------------ */

api.onSettingsChanged((next) => {
  // Do not fight the user while they are dragging the size slider.
  if (document.activeElement === fields.sizePx) return;
  render(next);
});
api.onBalanceUpdate(renderBalance);

(async () => {
  render(await api.getSettings());
  wireHandlers();
  renderBalance(await api.getBalance());
  await refreshHistory();
})().catch((err) => {
  statusEl.textContent = `加载失败：${err.message}`;
});
