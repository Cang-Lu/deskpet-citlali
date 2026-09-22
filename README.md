# Citlali — Desktop Pet

**English** · [简体中文](README.zh-CN.md)

A **standalone** desktop pet for Windows / macOS / Linux. It does not run inside DeepSeek Harness, Codex, or any other agent host — it is just an app.

- The character is **Citlali** from *Genshin Impact*, using community sprite art (see [Assets and licence](#assets-and-licence)).
- She talks through the **DeepSeek API**, with replies shown in a speech bubble above her head.
- A **state machine** drives her animation and particle effects: idle, thinking, talking, happy, sad, dozing, walking, reading…
- She has a **mind of her own**: she settles down, cycles through poses, strolls somewhere new, and mutters to herself along the way.
- **Move the cursor near her** and she sits up and follows it with her eyes, using the atlas's 16 gaze directions.

---

## Quick start

Requires **Node.js 20 or newer** (developed on Node 24).

```bash
npm install
npm start
```

On first launch she says hello and points out that no API key is configured yet. **Right-click the pet** (or the tray icon) → **设置 / Settings…** and paste your key in.

### Prebuilt Windows executable

Download one from the [Releases](../../releases) page — no Node.js required:

| File | What it is |
| --- | --- |
| `Citlali-Setup-x.y.z.exe` | Installer. Lets you pick the install folder and creates Start Menu + desktop shortcuts. |
| `Citlali-Portable-x.y.z.exe` | Single-file portable build. Nothing to install — just run it. |

Both are self-contained, about 90 MB (that is Electron's floor, not the app).

> The build is **not code-signed**, so Windows SmartScreen warns the first time. Choose *More info* → *Run anyway*, or build it yourself from source.

### Building the exe yourself

```bash
npm install
npm run dist            # installer + portable, into dist/
npm run dist:installer  # installer only
npm run dist:portable   # portable only
npm run dist:dir        # unpacked folder; fastest, skips the NSIS download
```

Three things about the packaging config are deliberate:

- **`npmRebuild` is off.** The app has no native dependencies, and the rebuild step only needs a toolchain it does not have.
- **The renderer is served through `fs`, not `net.fetch`.** Inside `app.asar` only Electron's `fs` understands the archive path; handing a `file:` URL to the file loader 404s, which would leave the atlas unloaded and the window blank.
- **`build/icon.png` is generated**, not hand-drawn: `npm run slice` crops it from the sprite sheet at 256×256 for electron-builder to turn into a `.ico`.

### If `npm install` fails at Electron's postinstall step

Some restricted environments (sandboxes, certain corporate security policies) forbid install scripts from spawning child processes. The workaround is to fetch the Electron binary yourself:

```bash
npm install --ignore-scripts
node tools/install-electron.mjs          # prints a ZIP= line and a DEST= line
# then unzip ZIP into DEST, and write "electron.exe" into node_modules/electron/path.txt
```

### Getting a DeepSeek API key

Sign up at <https://platform.deepseek.com>, create a key (it looks like `sk-…`), and paste it into Settings. The **Test connection** button verifies it immediately.

The key is encrypted with Electron's `safeStorage` — the OS keychain, i.e. DPAPI on Windows — and is **never handed to the renderer process**. The settings window only ever shows "saved"; it never displays the key back.

> After typing the key, click **Save** next to the field. (Enter, or clicking *Done*, will also save it.) The hint below the field turns into "saved and encrypted with the system keychain".

### Which model

**`deepseek-chat`** (DeepSeek V3, non-reasoning) at `https://api.deepseek.com` by default. Both the model name and the base URL are configurable, so any OpenAI-compatible endpoint works.

---

## Work mode: when you actually need help

By default her replies are capped at **1–3 sentences, under 60 characters**. That is a hard constraint in her persona — right for a desk pet, useless when you have a real question.

Turn on **work mode** and she:

- **drops the length limit**, and may use Markdown (headings, lists, tables) and complete, runnable code blocks
- puts **accuracy ahead of charm**: she says when she is unsure, asks for missing details instead of guessing, and does not invent APIs
- leads with the conclusion or the executable steps on complex questions
- keeps her voice, but reins in the verbal tics so they do not crowd out information
- **still talks normally when chatting** — greetings and unprompted remarks do not suddenly read like a manual

| | Casual | Work mode |
| --- | --- | --- |
| Temperature | 1.15 | 0.6 |
| Reply ceiling | 700 tokens | 2400 tokens |
| Bubble height | 172px | 320px (the window grows) |

**Three ways to switch:**

- Type **`/work`** in the chat to enter, **`/pet`** to leave (`/工作` and `/闲聊` also work). These are handled locally and **cost no API request**.
- Tray / right-click menu → **工作模式 (Work mode)**
- Settings → Model → Work mode

The composer placeholder and the bubble border change with the mode, so there is never any doubt which one is active.

---

## Using it

| Action | What happens |
| --- | --- |
| Left-click her | Opens the input box (`Enter` sends, `Esc` dismisses) |
| Click and drag | Move her anywhere on screen; the position is remembered |
| **`Ctrl` + scroll wheel** | **Resize her in place** |
| Right-click her, or the tray icon | Menu: size, show/hide, settings, always-on-top, click-through, auto-start, autonomous behaviour, balance, quit |
| `Ctrl+Enter` | Summon the input box at any time (while the window has focus) |
| Move the cursor close | She puts the novel down and sits up to watch it; move ~300px away and she goes back to reading |

Text in the bubble can be selected and copied. **Every line hides itself automatically** so it never blocks your screen — the short ones after 5 seconds. Click her to bring the last line back. Conversation memory is stored locally and can be cleared from the tray menu or the settings page.

### Long answers are protected

| Situation | Behaviour |
| --- | --- |
| How long a reply stays | Scales with length: 7s base, +90ms per character, up to 60s |
| You have not finished reading | She **stays put and stays quiet** until the bubble closes (max 25s) |
| Her ambient muttering | **Skipped entirely** while an answer is on screen — it can never overwrite what you are reading |
| You dismissed the answer | Click her and it comes **back verbatim**; replies are stored separately from small talk, so muttering cannot displace them |
| You want something older | Tray / right-click menu → **对话记录 (History)…** |

---

## Size and image quality

### Size is stepless

- **`Ctrl` + scroll wheel** while hovering her — 16px per notch.
- **Settings → Appearance → Size** — a 96–900px slider, 1px granularity.
- **Tray / right-click menu → Size** — small / medium / large / huge, plus ±8px and ±32px nudges.

Changes apply instantly. There is no snapping to discrete steps.

### Rendering mode

| Mode | Behaviour | When to use |
| --- | --- | --- |
| **Supersampled** (default) | Rasterises the frame at an integer multiple into an offscreen buffer, then scales it to the size you asked for | The default. Sharp at any size |
| **Hard pixel** | No smoothing at all, plain nearest-neighbour upscale | When you want the aliased, retro pixel look |

Why the default manages to be sharp at *any* size: the sprite is first rasterised at an **integer multiple** into an offscreen canvas (nearest-neighbour, so it stays crisp), then that buffer is scaled to the target. At exact multiples the final step is a 1:1 blit and therefore **pixel-exact**; at everything in between it is a **downsample** rather than a stretch, so edges come out smooth instead of jagged. The buffer is cached per frame + factor, costing one extra `drawImage` per frame.

### Edge fringe removal

The source art was matted against a dark background before its alpha was extracted, so the anti-aliased edge pixels carry dark RGB. Composited over a **light desktop**, they produce a dirty grey rim — which reads as the whole character being slightly blurry.

The **Remove edge fringe** setting is on by default: at startup the atlas is scanned and every not-fully-opaque pixel has its RGB replaced with the colour of a nearby solid pixel. **Alpha is untouched.** Measured on the full 1536×2288 atlas: ~130,000 edge pixels repainted in ~130ms, once at startup.

To see the difference, turn it off and run `npm run slice`, which writes `.qa/fringe-proof.png` (original) and `.qa/fringe-after.png` (cleaned) — the same sprite over white, black, magenta and dark. The fringe is most obvious on white.

### About the mood tint

The mood colour cast (warm when happy, cool when sad, red when angry…) is **off by default** and can be enabled in settings.

It is off by default for a measured reason: her cushion is one large near-white surface, so even at low opacity the colour shift is plainly visible across it, and the character reads as **recoloured** rather than lit. Mood is carried by the particle effects instead (sparkles, rain, puffs, drifting `z`, focus motes), which never touch her palette.

When enabled it is **clipped to her silhouette** (`source-atop` at draw time), so it cannot spill onto the desktop — no amount of opacity will produce a grey wash behind her.

> Upgrading from an older build? That version defaulted the switch to on and saved that value to your config. Current builds migrate it off automatically at startup.

---

## Account balance

Uses DeepSeek's own [`GET /user/balance`](https://api-docs.deepseek.com/api/get-user-balance/) endpoint.

- **On demand:** tray / right-click menu → **查询余额 (Check balance)**, or the button on the settings page. The menu also shows the last known balance.
- **Periodically:** a toggle in settings, interval configurable (30 minutes by default). The first check runs about 6 seconds after launch.
- **Low-balance warning:** below your threshold (¥5 by default) Citlali pops a **pinned bubble** telling you to top up, and the tray menu is annotated "low, consider topping up". The same amount is only warned about once every 12 hours.

Granted credit and topped-up balance are shown when the API reports them. The warning uses a **local line** — spending tokens to generate "your balance is nearly gone" would be self-defeating.

`is_available: false` (balance too low to call the API) is called out separately.

---

## States and animations

The atlas has 11 rows: rows 0–8 are the standard animations and rows 9–10 hold 16 gaze directions.

| State | Sprite row | Trigger | Effect |
| --- | --- | --- | --- |
| Lying, reading | 0 | One of the settle poses (highest weight) | — |
| Lying, daydreaming | 7 | One of the settle poses | — |
| Lying, blanking out | 0 (slower) | One of the settle poses | — |
| Sitting, resting | 5 | One of the settle poses | — |
| Sitting, looking around | 8 | One of the settle poses, **max 7s** | — |
| Sitting, dozing | 6 | One of the settle poses, **max 5s** | drifting `z` |
| Asleep | 0 (slowest) | Left alone past the configured timeout | drifting `z` |
| Walking | 1 / 2 | After 2–4 poses | — |
| Thinking | 7 | Message sent, awaiting the model | icy blue halo |
| Happy / excited | 4 | Model returns `happy` / `excited` | gold sparkles |
| Greeting / shy | 3 | Startup greeting, clicking her | sparkles / pink |
| Sad / angry | 5 | An error, or `sad` / `angry` | rain / anger puffs |
| Gaze tracking | 9 / 10 | Cursor comes near | — |

**Clip names describe what the drawing does, not what its row is called** — the atlas row labels are misleading. The full animation sheet is at [`docs/animations.png`](docs/animations.png).

### What she does when idle

The model is simple, and matches how a desk pet reads:

> **Settle somewhere → cycle through a few poses → amble to a new spot → settle again**

While settled she picks at random from these, never repeating the same pose twice in a row:

| Pose | Sprite row | Dwell |
| --- | --- | --- |
| Lying, reading | 0 lying with a novel | 12–26s |
| Lying, daydreaming | 7 lying with a novel (a different animation) | 8–18s |
| Lying, blanking out | 0 (slower) | 7–16s |
| Sitting, resting | 5 seated, head down | 5–9s |
| Sitting, looking around | 8 seated head swing | 4–7s |
| Sitting, dozing | 6 seated nod | 3–5s |

Lying and sitting come out at roughly **53% / 47%**, so she keeps changing pose rather than lying flat the whole time.

**Walking is its own phase, not one of the random poses** — because this atlas's walking artwork *is* a seated sway, and playing it while parked looks exactly like walking on the spot. Every **2–4 poses** she gets up and travels (130–260px, about **2.2–4.5s** at 58px/s, 8fps clip), then settles again.

Also:

- **12 minutes with no interaction → she dozes off** (`z` particles), and looks startled when you come back
- **Cursor comes near → she sits up and watches it**, and goes back to reading once it leaves (~300px)
- **Every 25 minutes** (configurable) she makes one DeepSeek call to strike up a conversation

### Her lines always match her pose

**Every line is attached to a pose**, rather than drawn from a shared pool — so a mismatch like "so sleepy" while clearly awake is structurally impossible:

| Pose | Line pool |
| --- | --- |
| Lying, reading | book-related: "Be quiet, it's just getting good." |
| Lying, daydreaming | small talk: "That glass on your desk has gone cold." |
| Sitting, looking around | "…hm?" "Did I hear something?" |
| Sitting, dozing | **only this pose** says sleepy things: "One more page and I'll sleep… just one." |
| Sitting, head down | "…thinking about something." "Leave me be a moment." |
| While walking | "…my legs have gone numb from sitting." |
| On arrival | "This'll do." "Mm, good light here." |
| Just woken up | "…hn? Did I fall asleep?" |

The self-test asserts this mapping and forbids using the two gaze rows as random poses.

These are a **local line library** (14 pools, 119 lines) and cost no API call — they are ambient noise, and burning tokens on "…sleepy" would be silly. A global quiet gap of 55–150 seconds sits between them, so she does not narrate every pose change.

The **主动开口说话 / speak up on its own** setting covers *everything* she says unprompted, the local lines included. Turning it off leaves her animating silently. That is deliberate: muttering is what users actually notice, so a switch that only silenced the model-generated half looked broken.

Unprompted lines are additionally blocked while a reply is on screen, and for a while after any real conversation — they can never talk over an answer you are reading.

**She knows Teyvat.** The persona is built from her canon characterisation rather than a generic "novel-loving girl": she is the Great Shaman of the Masters of the Night-Wind in Natlan, and the terrifying old-witch act is exactly that — an act. The real her is reserved, easily flustered and anxious about what people think of her.

She is also **two hundred years old and widely read**, so the prompt carries a roster of roughly seventy notable people from all seven nations, plus the rules for using it: recognise a name from anywhere, keep *having heard of someone* and *having met them* clearly apart, and never claim she only knows her own neighbours. She has real history with people outside Natlan — the Harbinger **Sandrone** chartered the ship she worked on as an aquarium receptionist in Fontaine and later came to her house for tea — and she talks about divination, star-omens, the Night Kingdom, phlogiston, her tribe and old memories as readily as about novels. The roster lives in `TEYVAT_ROSTER` in `src/main/ai.js`; its sources and every uncertain detail are collected in [`docs/teyvat-directory.md`](docs/teyvat-directory.md).

To tune how lively she is, edit the `POSES` table (weights, durations) and `WALK_SPEED` at the top of `src/renderer/behavior.js`; the line pools are in `MUTTERS` just above them.

---

## Project layout

```
src/
  main/            Main process (Node side, CommonJS)
    main.js          Lifecycle, custom protocol, IPC wiring
    pet-window.js    Transparent always-on-top window, click-through, walk controller
    ai.js            DeepSeek streaming client + Citlali's persona + mood-token filter
    config.js        Settings and conversation memory (atomic writes)
    secrets.js       Encrypted API key storage
    tray.js          Tray menu + right-click menu (one shared template)
    selftest.js      Self-test: per-state screenshots + assertions
  preload/preload.js Whitelisted API exposed via contextBridge
  renderer/        Renderer process (ESM)
    app.js           Main loop, hit testing, dragging, chat wiring
    sprite.js        Atlas loading + cross-fading frame player
    state.js         Two-layer state machine (base + overlay) with priorities
    behavior.js      Autonomous behaviour engine
    effects.js       State particles and tint
    ui.js            Bubble / composer / toasts
    index.html, styles.css
    settings.html, settings.js, settings.css
    history.html, history.js, history.css   Conversation log window
  shared/pet-spec.js Atlas geometry, row definitions, gaze mapping (the single source of truth)
tools/
  fetch-assets.mjs     Download the sprite sheet and verify its SHA-256
  install-electron.mjs Manually fetch the Electron binary
  test-config.mjs      Settings-migration unit tests (plain Node, no Electron)
  test-secrets.js      API key encrypt/decrypt round-trip (needs Electron)
  slice-atlas.js       Atlas QA: frame counts, per-frame motion, tray icon, gaze sheet, animation sheet
  atlas-slicer.html    WebP decoding and pixel work inside a renderer (nativeImage cannot read WebP)
  inspect-shot.js      Debug helper: crop/zoom a screenshot and print pixel samples
docs/
  animations.png       All 11 rows with their frames, uses and measured motion
  teyvat-directory.md  Who Citlali knows and how she knows them: sources for TEYVAT_ROSTER
```

## Development

```bash
npm start             # Run the app
npm test              # Settings-migration unit tests (plain Node, sub-second)
npm run test:secrets  # API key encrypt/decrypt round-trip (needs Electron)
npm run selftest      # Self-test: per-state screenshots + assertions, output in .qa/
npm run slice         # Re-slice the atlas / build the tray icon / measure frames
npm run fetch-assets  # Re-download the sprite sheet and verify its SHA-256
```

`npm run selftest` launches the real app, walks it through every state, screenshots each one into `.qa/states/`, and asserts — among other things — that the thinking state does not expire instantly, that the gaze left/right mapping is right, that the window becomes visible, that walking physically moves the window, that model errors surface cleanly, that the atlas de-fringe ran, that sizing is stepless (333/400/507 land exactly), that **the mood tint never spills outside her silhouette**, that resizing really resizes, that the balance endpoint's errors are handled, and that the low-balance warning only fires once.

Setting `DESKPET_SELFTEST_NET=1` additionally makes a real request to DeepSeek with an invalid key, exercising the HTTP + SSE path and the balance endpoint.

Output: `.qa/states/*.png` (per-state screenshots), `.qa/settings-window.png` and `-2.png` (both halves of the settings page), `.qa/history-window.png`, `.qa/low-balance.png`, and `.qa/selftest.json` (the report).

When diagnosing a UI problem, `tools/inspect-shot.js` crops and zooms any screenshot and prints pixel samples:

```bash
electron tools/inspect-shot.js <image path> .qa/inspect
```

The renderer exposes `window.__deskpet` for debugging: `__deskpet.setBase('sleepy')`, `__deskpet.setOverlay('happy')`, `__deskpet.setLook(4)`, `__deskpet.setSize(600)`, `__deskpet.measureBackground()`, `__deskpet.info`, and so on.

Settings and conversation memory live in the OS user-data directory by default; set `DESKPET_DATA_DIR` to override it for a portable or isolated run.

---

## Assets and licence

- **Code** (`src/`, `tools/`): **MIT**, see [LICENSE](LICENSE)
- **Artwork** (`assets/citlali/`, `docs/animations.png`): **CC BY-NC 4.0, no commercial use**, full attribution and terms in [ASSETS-LICENSE.md](ASSETS-LICENSE.md)

The art comes from the `pets/citlali--zaytsevzy` package in **[legeling/awesome-codex-pet](https://github.com/legeling/awesome-codex-pet)**, by **ZaytsevZY** ([original source](https://github.com/ZaytsevZY/genshin-pets)). That repository's code is MIT, but its artwork is not — the two licences are independent.

> ⚠️ **This project as a whole therefore may not be used commercially.** For commercial use you must replace the artwork or obtain a separate licence.

*Genshin Impact* and the character Citlali are copyright **miHoYo**. This is a non-commercial fan project, not affiliated with or endorsed by miHoYo or by the upstream artist.

Artwork checksum: `spritesheet.webp` has SHA-256 `9fbe935730ba52af3e80a41e6a698391b73d2a872c9fcf2a7ce9c44e9ec98ed3`, matching the value registered upstream. `npm run fetch-assets` re-verifies it.

