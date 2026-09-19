/**
 * DOM layer: the speech bubble, the composer and transient toasts.
 *
 * The pet itself is drawn on a canvas, so this module also owns the list of
 * rectangles that should swallow mouse input (everything else passes through
 * to the desktop underneath).
 */

/**
 * How long a bubble stays before hiding itself.
 *
 * Ambient one-liners get out of the way quickly. A reply is different: an
 * answer the user asked for must not vanish after five seconds, so its delay
 * scales with how much there is to read. Either way she brings the last line
 * back when clicked.
 */
const AMBIENT_HIDE_MS = 5_000;
const REPLY_BASE_MS = 7_000;
const REPLY_PER_CHAR_MS = 90;
const REPLY_MAX_MS = 60_000;

export class Ui {
  constructor({ onSend }) {
    this.onSend = onSend;

    this.bubble = document.getElementById('bubble');
    this.bubbleText = document.getElementById('bubble-text');
    this.bubbleStatus = document.getElementById('bubble-status');
    this.bubbleClose = document.getElementById('bubble-close');

    this.composer = document.getElementById('composer');
    this.input = document.getElementById('input');
    this.sendButton = document.getElementById('send');
    this.dismissComposer = document.getElementById('dismiss-composer');

    this.toast = document.getElementById('toast');

    this.hideTimer = null;
    this.toastTimer = null;
    this.pinned = false;
    this.busy = false;
    /** 'ambient' for her own muttering, 'reply' for an answer she was asked for. */
    this.kind = 'ambient';

    this.bubbleClose.addEventListener('click', () => this.hideBubble());
    this.dismissComposer.addEventListener('click', () => this.closeComposer());
    this.composer.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit();
    });
    this.input.addEventListener('input', () => this.clearToast());
  }

  get composerOpen() {
    return this.composer.classList.contains('visible');
  }

  get bubbleVisible() {
    return this.bubble.classList.contains('visible');
  }

  /** Regions that should capture the mouse instead of passing it through. */
  hitRects() {
    const rects = [];
    if (this.bubbleVisible) rects.push(this.bubble.getBoundingClientRect());
    if (this.composerOpen) rects.push(this.composer.getBoundingClientRect());
    if (this.toast.classList.contains('visible')) rects.push(this.toast.getBoundingClientRect());
    return rects;
  }

  /* --------------------------- bubble --------------------------- */

  clearHideTimer() {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.pin] keep the bubble on screen until dismissed
   * @param {'ambient'|'reply'} [opts.kind] a reply is protected from being
   *        overwritten by her ambient muttering, and hides on a longer timer.
   */
  showBubble(text = '', { mood = 'neutral', status = '', autoHideMs = 0, pin = false, kind = 'ambient' } = {}) {
    // The toast shares this slot, so showing a bubble has to retire it or the
    // two render on top of each other.
    this.clearToast();
    this.clearHideTimer();
    this.pinned = Boolean(pin);
    this.kind = kind;
    this.bubble.dataset.mood = mood;
    this.bubble.dataset.kind = kind;
    this.bubbleText.textContent = text;
    this.bubbleStatus.textContent = status;
    this.bubble.classList.toggle('pinned', this.pinned);
    this.bubble.classList.add('visible');
    this.bubbleText.scrollTop = this.bubbleText.scrollHeight;
    if (autoHideMs > 0) this.scheduleHide(autoHideMs);
  }

  /** True while an answer the user asked for is on screen. */
  get showingReply() {
    return this.bubbleVisible && this.kind === 'reply';
  }

  /** How long a reply of this length should stay up. */
  static replyHideDelay(text) {
    const length = String(text || '').length;
    return Math.min(REPLY_MAX_MS, Math.max(REPLY_BASE_MS, REPLY_BASE_MS + length * REPLY_PER_CHAR_MS));
  }

  /** Replace the visible text wholesale (used while streaming). */
  setBubbleText(text, { keepScroll = false } = {}) {
    const atBottom = this.bubbleText.scrollTop + this.bubbleText.clientHeight
      >= this.bubbleText.scrollHeight - 6;
    this.bubbleText.textContent = text;
    if (keepScroll || atBottom) this.bubbleText.scrollTop = this.bubbleText.scrollHeight;
  }

  appendBubbleText(delta) {
    this.bubbleText.textContent += delta;
    this.bubbleText.scrollTop = this.bubbleText.scrollHeight;
  }

  setBubbleStatus(status) {
    this.bubbleStatus.textContent = status;
  }

  setBubbleMood(mood) {
    this.bubble.dataset.mood = mood;
  }

  /**
   * Auto-hide pacing. Pinned bubbles (low balance) never time out, and a reply
   * waits long enough to actually be read.
   *
   * @returns {number} the delay used, in ms (0 when it will not auto-hide)
   */
  scheduleHide(ms = 0) {
    this.clearHideTimer();
    if (this.busy || this.pinned) return 0;
    const delay = ms || (this.kind === 'reply'
      ? Ui.replyHideDelay(this.bubbleText.textContent)
      : AMBIENT_HIDE_MS);
    this.hideTimer = setTimeout(() => this.hideBubble(), delay);
    return delay;
  }

  hideBubble() {
    this.clearHideTimer();
    this.pinned = false;
    this.bubble.classList.remove('visible', 'pinned');
    if (this.onHidden) this.onHidden();
  }

  /* --------------------------- composer --------------------------- */

  openComposer({ focus = true } = {}) {
    this.composer.classList.add('visible');
    this.clearHideTimer();
    if (focus) {
      this.input.focus();
      this.input.select();
    }
  }

  closeComposer() {
    this.composer.classList.remove('visible');
    this.input.blur();
    if (this.bubbleVisible) this.scheduleHide();
  }

  toggleComposer() {
    if (this.composerOpen) this.closeComposer();
    else this.openComposer();
  }

  submit() {
    const text = this.input.value.trim();
    if (!text) {
      this.closeComposer();
      return;
    }
    this.input.value = '';
    if (this.onSend) this.onSend(text);
  }

  setBusy(busy) {
    this.busy = busy;
    this.sendButton.textContent = busy ? '停止' : '发送';
    this.sendButton.dataset.mode = busy ? 'cancel' : 'send';
    if (busy) this.clearHideTimer();
    else if (this.bubbleVisible) this.scheduleHide();
  }

  /* --------------------------- toast --------------------------- */

  showToast(message, ms = 5000) {
    // The toast occupies the bubble slot, so the two never overlap.
    this.hideBubble();
    this.toast.textContent = message;
    this.toast.classList.add('visible');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.clearToast(), ms);
  }

  clearToast() {
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    this.toast.classList.remove('visible');
  }
}
