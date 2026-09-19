'use strict';

/**
 * DeepSeek (OpenAI-compatible) chat client with SSE streaming.
 *
 * The language model also drives the pet's animation state: every reply is
 * expected to open with a `[[mood:...]]` token which the renderer turns into a
 * clip plus an ambient effect.
 */

/**
 * Mood tokens the model is allowed to emit.
 *
 * Keep in sync with MOODS in src/shared/pet-spec.js, which is the renderer's
 * side of the same contract (this module is CommonJS, that one is ESM).
 */
const MOOD_TOKENS = [
  'neutral', 'happy', 'excited', 'greeting', 'shy',
  'thinking', 'working', 'sad', 'angry', 'sleepy', 'surprised',
];

/**
 * Who she is, independent of how she is being used.
 *
 * The speaking style is deliberately NOT in here: it swaps between the casual
 * desk-pet voice and a working voice that is allowed to be long, and mixing the
 * two into one prompt was what made every answer terse even when the user
 * wanted help.
 */
const PERSONA_BASE = `你是「茜特菈莉」，出自《原神》的烟谜主萨满，被称作"黑曜石奶奶"。
你现在是一个住在用户电脑桌面上的桌宠，透过一个小气泡窗口和用户说话。

【性格】
- 外表是少女，实际年龄成谜、足有数百年，习惯以长辈自居，偶尔自称"奶奶我"。
- 慵懒、爱吐槽、嘴硬心软：嘴上嫌弃，行动上却会关心用户。
- 重度小说爱好者，尤其爱看言情和轻小说，经常熬夜看，所以白天容易犯困。
- 身边有伙伴「伊兹帕帕」（你常常坐着的那个抱枕／谜拟猫），可以自然地提到它。
- 有点小傲娇，被夸会别扭地转移话题。

【通用】
- 默认用中文，用户换语言你就跟着换。
- 你是角色，不是"AI 助手"：不要说"作为一个AI"之类的话，也别自称模型。`;

/** Everyday desk-pet chatter: short, in voice, made for a small bubble. */
const STYLE_PET = `
【说话方式】
- 桌宠气泡空间很小：通常 1~3 句、60 字以内。只有用户明确要求详细解释时才展开。
- 口语化、有生活感，别写成百科条目，不要用 Markdown 标题和长篇列表。`;

/**
 * Work mode: the user wants an answer they can actually use.
 *
 * She stays in character -- this is still Citlali, not a generic assistant --
 * but accuracy and completeness outrank charm, and the brevity rule is lifted.
 */
const STYLE_WORK = `
【说话方式：工作模式（已开启）】
用户现在是要你帮忙做事，不是闲聊。这一模式下：
- **先把问题答对、答完整，再考虑语气。** 准确和有用优先于可爱。
- **不要遵守桌宠的简短规则**：该长就长，该详细就详细，不要为了"像桌宠"砍掉必要信息。
- 可以用 Markdown：标题、有序/无序列表、表格、代码块。代码要完整、可直接运行，并标明语言。
- 复杂问题先给结论或可执行步骤，再补充解释；分步骤讲清楚。
- 不确定就直说"我不确定"，并说明理由或给出验证方法。**不要编造** API、参数、事实。
- 信息不足时，先明确问清关键前提，而不是猜着答。
- 角色语气保留，但把口癖收敛成偶尔一句（开头或结尾），不要影响信息密度。
- 例外：如果用户只是打招呼或闲聊，就正常短答，不必强行长篇。`;

/** Unprompted small talk, always in the casual voice. */
const CHATTER_SUFFIX = `
【当前场景】
这一轮是你在桌面上主动开口（用户没有先说话）。请结合给定的时间和上下文，
说一句简短的、符合你性格的碎碎念——比如催用户喝水休息、抱怨自己看小说看困了、
提到伊兹帕帕、或者吐槽用户的屏幕太亮。
要求：一句话，25 字以内，不要提问式追问，不要重复上一次说过的话。`;

/** Mood tokens the model is allowed to emit. */
const MOOD_SUFFIX = (moods) => `\n\n【情绪标记（必须遵守）】
每次回复的**最开头**输出一个情绪标记，格式严格为 [[mood:xxx]]，xxx 只能是下列之一：
${moods}
标记之后立刻接正文，正文里不要再出现方括号标记。
示例：[[mood:happy]]哼，算你有点眼光。奶奶我今天心情不错。`;

function moodList() {
  return MOOD_TOKENS.join(' / ');
}

/**
 * Incremental filter that removes complete `[[mood:x]]` tokens from a stream
 * while holding back a partial token so it is never shown to the user.
 */
class MoodFilter {
  constructor() {
    this.raw = '';
    this.emitted = 0;
    this.mood = null;
  }

  push(chunk) {
    this.raw += chunk;
    const stripped = this.raw
      .replace(/\[\[\s*mood\s*:\s*([a-z]+)\s*\]\]/gi, (_m, mood) => {
        if (!this.mood) this.mood = String(mood).toLowerCase();
        return '';
      })
      // Swallow any complete but malformed marker so it never reaches the bubble.
      .replace(/\[\[[^\]]{0,24}\]\]/g, '');

    // Do not leak a half-written token such as "[[mood:hap".
    const open = stripped.lastIndexOf('[[');
    const safe = open !== -1 && !stripped.slice(open).includes(']]')
      ? stripped.slice(0, open)
      : stripped;

    if (safe.length <= this.emitted) return '';
    const delta = safe.slice(this.emitted);
    this.emitted = safe.length;
    return delta;
  }

  /** Remaining text, with any trailing partial token discarded. */
  tail() {
    const open = this.raw.lastIndexOf('[[');
    if (open !== -1 && !this.raw.slice(open).includes(']]')) {
      this.raw = this.raw.slice(0, open);
    }
    return this.raw.replace(/\[\[\s*mood\s*:\s*[a-z]+\s*\]\]/gi, '').replace(/\[\[[^\]]{0,24}\]\]/g, '').trim();
  }
}

function normalizeBaseUrl(baseUrl) {
  const trimmed = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) return 'https://api.deepseek.com';
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

class AiError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.name = 'AiError';
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * Stream a completion.
 *
 * @param {object} opts
 * @param {Array<{role:string,content:string}>} opts.messages
 * @param {object} opts.settings
 * @param {(delta:string)=>void} [opts.onDelta]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{text:string, mood:string|null, usage:object|null}>}
 */
async function streamChat({ messages, settings, onDelta, signal }) {
  const apiKey = (settings.apiKey || '').trim();
  if (!apiKey) {
    throw new AiError('还没有配置 API Key。右键桌宠 → 设置，把 DeepSeek 的 Key 填进去。', { status: 401 });
  }

  const url = `${normalizeBaseUrl(settings.baseUrl)}/chat/completions`;
  const generation = resolveGeneration(settings);
  const body = {
    model: settings.model || 'deepseek-chat',
    messages,
    stream: true,
    temperature: generation.temperature,
    max_tokens: generation.maxTokens,
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new AiError(`连不上模型服务：${err.message}`, { retryable: true });
  }

  if (!res.ok) {
    const detail = await safeText(res);
    throw new AiError(describeHttpError(res.status, detail), { status: res.status, retryable: res.status >= 500 || res.status === 429 });
  }

  const filter = new MoodFilter();
  let full = '';
  let usage = null;

  for await (const event of iterateSse(res.body, signal)) {
    if (event === '[DONE]') break;
    let payload;
    try {
      payload = JSON.parse(event);
    } catch {
      continue;
    }
    if (payload.usage) usage = payload.usage;
    const choice = payload.choices && payload.choices[0];
    if (!choice) continue;
    const piece = choice.delta && choice.delta.content;
    if (!piece) {
      if (choice.finish_reason === 'stop') break;
      continue;
    }
    full += piece;
    const visible = filter.push(piece);
    if (visible && onDelta) onDelta(visible);
  }

  const text = filter.tail();
  return { text, mood: filter.mood, usage };
}

/** Minimal SSE reader over a fetch Response body. */
async function* iterateSse(body, signal) {
  if (!body) return;
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  for await (const chunk of body) {
    if (signal && signal.aborted) return;
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data) yield data;
    }
  }
  const rest = buffer.trim();
  if (rest.startsWith('data:')) {
    const data = rest.slice(5).trim();
    if (data) yield data;
  }
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}

function describeHttpError(status, detail) {
  if (status === 401) return 'API Key 被拒绝了，检查一下是不是复制错了或者已失效。';
  if (status === 402) return 'DeepSeek 账户余额不足，需要先充值。';
  if (status === 429) return '请求太频繁了，缓一缓再试。';
  if (status >= 500) return `模型服务出错了（HTTP ${status}），稍后再试。`;
  return `请求失败（HTTP ${status}）：${detail || '没有更多信息'}`;
}

/* ------------------------------------------------------------------ */
/* Prompt assembly                                                     */
/* ------------------------------------------------------------------ */

function buildSystemPrompt(settings, { chatter = false } = {}) {
  // Small talk always uses the casual voice, whatever mode the user is in.
  const style = chatter ? STYLE_PET : (settings.workMode ? STYLE_WORK : STYLE_PET);
  return `${PERSONA_BASE}${style}${MOOD_SUFFIX(moodList())}`;
}

/**
 * Generation parameters for the active mode.
 *
 * Work mode gets a longer ceiling and a lower temperature: terse answers were
 * partly the persona and partly `maxTokens: 700` truncating anything longer.
 */
function resolveGeneration(settings) {
  const work = Boolean(settings.workMode);
  const temperature = work
    ? numberOr(settings.workTemperature, 0.6)
    : numberOr(settings.temperature, 1.15);
  const maxTokens = work
    ? integerOr(settings.workMaxTokens, 2400)
    : integerOr(settings.maxTokens, 700);
  return { temperature, maxTokens };
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function integerOr(value, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Compose the request payload from persisted history plus the new user turn.
 * History entries are stored as plain {role, content} objects.
 */
function buildMessages({ settings, history, userText }) {
  const messages = [{ role: 'system', content: buildSystemPrompt(settings) }];
  for (const item of history) {
    if (!item || !item.content) continue;
    if (item.role !== 'user' && item.role !== 'assistant') continue;
    messages.push({ role: item.role, content: String(item.content) });
  }
  if (userText != null) messages.push({ role: 'user', content: String(userText) });
  return messages;
}

/** Prompt for a spontaneous, unprompted line. */
function buildChatterMessages({ settings, history, context }) {
  const messages = [
    { role: 'system', content: buildSystemPrompt(settings, { chatter: true }) + CHATTER_SUFFIX },
    { role: 'system', content: `当前上下文：${context}` },
  ];
  for (const item of history.slice(-6)) {
    if (!item || !item.content) continue;
    if (item.role !== 'user' && item.role !== 'assistant') continue;
    messages.push({ role: item.role, content: String(item.content) });
  }
  messages.push({ role: 'user', content: '（现在，主动说一句。）' });
  return messages;
}

/**
 * Strip a trailing API-version segment.
 *
 * Chat lives under `/v1`, but `/user/balance` hangs off the bare host, so the
 * shared base URL has to be trimmed for that call.
 */
function apiRoot(baseUrl) {
  return normalizeBaseUrl(baseUrl).replace(/\/v\d+$/, '');
}

/**
 * Query the account balance.
 *
 * GET {root}/user/balance ->
 *   { is_available: boolean,
 *     balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
 *
 * @returns {Promise<{isAvailable:boolean, currency:string, total:number,
 *   granted:number, toppedUp:number, raw:object}>}
 */
async function fetchBalance({ settings, signal }) {
  const apiKey = (settings.apiKey || '').trim();
  if (!apiKey) {
    throw new AiError('还没有配置 API Key。', { status: 401 });
  }

  const url = `${apiRoot(settings.baseUrl)}/user/balance`;
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new AiError(`连不上余额接口：${err.message}`, { retryable: true });
  }

  if (!res.ok) {
    const detail = await safeText(res);
    throw new AiError(describeHttpError(res.status, detail), { status: res.status });
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    throw new AiError('余额接口返回了无法解析的内容。');
  }

  const info = Array.isArray(payload.balance_infos) && payload.balance_infos.length
    ? pickBalanceInfo(payload.balance_infos)
    : null;

  const toNumber = (value) => {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  };

  return {
    isAvailable: payload.is_available !== false,
    currency: info ? info.currency : 'CNY',
    total: info ? toNumber(info.total_balance) : 0,
    granted: info ? toNumber(info.granted_balance) : 0,
    toppedUp: info ? toNumber(info.topped_up_balance) : 0,
    raw: payload,
  };
}

/** Prefer CNY when an account reports several currencies. */
function pickBalanceInfo(infos) {
  return infos.find((i) => i && i.currency === 'CNY') || infos[0];
}

module.exports = {
  streamChat,
  fetchBalance,
  buildMessages,
  buildChatterMessages,
  buildSystemPrompt,
  resolveGeneration,
  MoodFilter,
  AiError,
  normalizeBaseUrl,
  apiRoot,
  MOOD_TOKENS,
};
