'use strict';

const { Tray, Menu, app, shell } = require('electron');

/**
 * Build the shared menu template.
 *
 * Used both for the tray icon's context menu and for the right-click menu on
 * the pet itself, so the two can never drift apart. Checkbox items write
 * through `deps.update`, which persists the change and applies its side effects.
 *
 * @param {object} deps
 * @param {import('./config').Config} deps.config
 * @param {(patch:object) => void} deps.update
 * @param {() => void} deps.onToggleVisible
 * @param {() => void} deps.onOpenChat
 * @param {() => void} deps.onOpenSettings
 * @param {() => void} deps.onClearHistory
 * @param {() => void} deps.onQuit
 * @param {() => boolean} deps.isVisible
 * @param {() => void} [deps.onRebuild]
 */
function createMenuTemplate(deps) {
  const settings = deps.config.get();
  const proactive = settings.proactive || {};
  const balance = settings.balance || {};
  const rebuild = () => {
    if (deps.onRebuild) deps.onRebuild();
  };

  const sizePx = Number(settings.sizePx) || 416;
  const stepSize = (delta) => deps.update({ sizePx: Math.min(900, Math.max(96, sizePx + delta)) });

  return [
    { label: '茜特菈莉', enabled: false },
    { type: 'separator' },
    {
      label: deps.isVisible() ? '隐藏桌宠' : '显示桌宠',
      click: () => {
        deps.onToggleVisible();
        rebuild();
      },
    },
    { label: '和她说话…', click: () => deps.onOpenChat() },
    {
      label: '工作模式（认真回答）',
      type: 'checkbox',
      checked: Boolean(settings.workMode),
      click: (item) => deps.update({ workMode: item.checked }),
    },
    { label: '设置…', click: () => deps.onOpenSettings() },
    { label: '对话记录…', click: () => deps.onOpenHistory && deps.onOpenHistory() },
    { type: 'separator' },
    {
      label: `大小 · 当前 ${Math.round(sizePx)}px`,
      submenu: [
        { label: '小', type: 'radio', checked: sizePx < 320, click: () => deps.update({ sizePx: 240 }) },
        { label: '中', type: 'radio', checked: sizePx >= 320 && sizePx < 480, click: () => deps.update({ sizePx: 416 }) },
        { label: '大', type: 'radio', checked: sizePx >= 480 && sizePx < 640, click: () => deps.update({ sizePx: 560 }) },
        { label: '很大', type: 'radio', checked: sizePx >= 640, click: () => deps.update({ sizePx: 720 }) },
        { type: 'separator' },
        { label: '放大 8px', click: () => stepSize(8) },
        { label: '缩小 8px', click: () => stepSize(-8) },
        { label: '放大 32px', click: () => stepSize(32) },
        { label: '缩小 32px', click: () => stepSize(-32) },
        { type: 'separator' },
        { label: '提示：Ctrl+滚轮 可无级调整，或用设置里的滑块', enabled: false },
      ],
    },
    { type: 'separator' },
    {
      label: '总在最前',
      type: 'checkbox',
      checked: Boolean(settings.alwaysOnTop),
      click: (item) => deps.update({ alwaysOnTop: item.checked }),
    },
    {
      label: '鼠标穿透（只点得到她本人）',
      type: 'checkbox',
      checked: Boolean(settings.clickThrough),
      click: (item) => deps.update({ clickThrough: item.checked }),
    },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: Boolean(settings.autoLaunch),
      click: (item) => deps.update({ autoLaunch: item.checked }),
    },
    { type: 'separator' },
    {
      label: '自主行为',
      type: 'checkbox',
      checked: Boolean(proactive.enabled),
      click: (item) => deps.update({ proactive: { enabled: item.checked } }),
    },
    {
      label: '　随机走动',
      type: 'checkbox',
      enabled: Boolean(proactive.enabled),
      checked: Boolean(proactive.wander),
      click: (item) => deps.update({ proactive: { wander: item.checked } }),
    },
    {
      label: '　主动搭话',
      type: 'checkbox',
      enabled: Boolean(proactive.enabled),
      checked: Boolean(proactive.idleChatter),
      click: (item) => deps.update({ proactive: { idleChatter: item.checked } }),
    },
    {
      label: '　视线跟随鼠标',
      type: 'checkbox',
      enabled: Boolean(proactive.enabled),
      checked: Boolean(proactive.gazeFollow),
      click: (item) => deps.update({ proactive: { gazeFollow: item.checked } }),
    },
    { type: 'separator' },
    { label: describeBalance(balance), enabled: false },
    { label: '查询余额', click: () => deps.onCheckBalance && deps.onCheckBalance() },
    { type: 'separator' },
    { label: '清空对话记忆', click: () => deps.onClearHistory() },
    { label: '打开数据目录', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: '退出', click: () => deps.onQuit() },
  ];
}

/** One-line balance summary for the menu, or a prompt to set things up. */
function describeBalance(balance) {
  const symbol = balance.lastCurrency === 'USD' ? '$' : '¥';
  if (balance.lastTotal == null) return '余额：尚未查询';
  const amount = `${symbol}${Number(balance.lastTotal).toFixed(2)}`;
  if (balance.lastTotal <= (Number(balance.lowThreshold) || 0)) return `余额：${amount}（偏低，建议充值）`;
  return `余额：${amount}`;
}

/**
 * System-tray integration. The menu is rebuilt from settings every time
 * something changes so the checkboxes always reflect reality.
 */
class PetTray {
  /** @param {object} deps see {@link createMenuTemplate} */
  constructor(deps) {
    this.deps = deps;
    this.tray = null;
  }

  create() {
    if (this.tray) return this.tray;
    if (!this.deps.icon) {
      console.warn('[tray] no icon available; tray disabled');
      return null;
    }
    try {
      this.tray = new Tray(this.deps.icon);
    } catch (err) {
      console.error('[tray] unavailable:', err.message);
      return null;
    }
    this.tray.setToolTip('茜特菈莉 · 桌宠');
    this.tray.on('click', () => this.deps.onToggleVisible());
    this.tray.on('double-click', () => this.deps.onOpenChat());
    this.rebuild();
    return this.tray;
  }

  rebuild() {
    if (!this.tray) return;
    this.tray.setContextMenu(Menu.buildFromTemplate(createMenuTemplate({
      ...this.deps,
      onRebuild: () => this.rebuild(),
    })));
  }

  destroy() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

module.exports = { PetTray, createMenuTemplate };
