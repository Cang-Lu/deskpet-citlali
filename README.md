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

This went wrong once, so it is now explicit:

| Situation | Behaviour |
| --- | --- |
| How long a reply stays | Scales with length: 7s base, +90ms per character, up to 60s |
| You have not finished reading | She **stays put and stays quiet** until the bubble closes (max 25s) |
| Her ambient muttering | **Skipped entirely** while an answer is on screen — it can never overwrite what you are reading |
| You dismissed the answer | Click her and it comes **back verbatim**; replies are stored separately from small talk, so muttering cannot displace them |
| You want something older | Tray / right-click menu → **对话记录 (History)…** |

The original bug was three independent defects stacking: the bubble always hid after 5 seconds, ambient lines reused the same bubble *and* overwrote its only copy, and the behaviour engine had no idea anything was on screen.

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

(An earlier version snapped sizes to integer multiples instead, so dragging the slider did nothing for a while and then jumped. That is gone.)

### Edge fringe removal

The source art was matted against a dark background before its alpha was extracted, so the anti-aliased edge pixels carry dark RGB. Composited over a **light desktop**, they produce a dirty grey rim — which reads as the whole character being slightly blurry.

The **Remove edge fringe** setting is on by default: at startup the atlas is scanned and every not-fully-opaque pixel has its RGB replaced with the colour of a nearby solid pixel. **Alpha is untouched.** Measured on the full 1536×2288 atlas: ~130,000 edge pixels repainted in ~130ms, once at startup.

To see the difference, turn it off and run `npm run slice`, which writes `.qa/fringe-proof.png` (original) and `.qa/fringe-after.png` (cleaned) — the same sprite over white, black, magenta and dark. The fringe is most obvious on white.

### About the mood tint

The mood colour cast (warm when happy, cool when sad, red when angry…) is **off by default** and can be enabled in settings.

Turning it off is a measured decision, not a matter of taste: her cushion is one large near-white surface, so **even at 0.13 opacity the blue channel shifts by ~11/255** — visibly "the cushion turned cream", i.e. the character looks **recoloured** rather than lit. Mood is carried by the particle effects instead (sparkles, rain, puffs, drifting `z`, focus motes), which never touch her palette.

When enabled it is **clipped to her silhouette** (`source-atop` at draw time), so it cannot spill onto the desktop — no amount of opacity will produce a grey wash behind her.

This feature got it wrong three times:

1. **The first version drew a near-window-sized radial glow behind her with `lighter`.** Charming ambient light on a dark desktop; on a **light** desktop it became a large grey wash — measured at 231 against a 255 background, looking exactly like a broken window background.
2. **Converting it to a silhouette clip, I also raised opacity from 0.26 to 0.42.** Under additive blending 0.42 is a soft glow; under normal compositing 0.42 **repaints her** — white hair turned cream, skin turned gold.
3. **Even at 0.13 it still looked yellow.** Measuring the actual screenshots settled it: `b-r = -12` over the cushion, plainly visible across such a large flat area. So it became off by default.

The classic "I changed the default but existing users see no difference" trap is worth recording too:

> `deepMerge(DEFAULT_SETTINGS, stored)` lets the **stored** value win. So flipping `moodTint`'s default from `true` to `false` did **nothing for anyone who already had that key saved** — which is exactly what happened: the code was right, but the existing `settings.json` still said `moodTint: true`.
>
> The fix is a `settingsVersion` field plus a migration on load. There is a second trap inside it: the migration must run *after* `deepMerge`, yet the version number must be read from the **raw file** — because `deepMerge` also fills in today's default version, after which the config no longer looks old.

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

**Clip names describe what the drawing does, not what its row is called** — the row labels lie (see below). The full animation sheet is at [`docs/animations.png`](docs/animations.png).

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

> This used to be 130px/s with a 12fps clip, which is the "looks very rushed" report; before that, using row 1 as the seated idle is why she appeared to be walking without moving — that row is the walking artwork.

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

These are a **local line library** (9 pools, 41 lines) and cost no API call — they are high-frequency ambient noise, and burning tokens on "…sleepy" would be silly. The **主动找你说话 / unprompted chatter** setting is a different thing entirely: that one really does call DeepSeek, far less often (25 minutes by default).

Emotions are driven by the model: the system prompt requires a `[[mood:xxx]]` token at the **start** of every reply. The main process strips it out while streaming — so it never appears in the bubble — and maps it onto the states above.

To tune how lively she is, edit the `POSES` table (weights, durations) and `WALK_SPEED` at the top of `src/renderer/behavior.js`.

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
```

### Pitfalls worth recording

1. **The renderer cannot run from `file://`.** Chromium refuses to load ES modules over `file://` on CORS grounds. The app therefore registers a `deskpet://` custom protocol to serve pages and assets — which also keeps the atlas same-origin so the canvas is never tainted.
2. **`nativeImage` cannot decode WebP.** The tray icon cannot be cropped out of the atlas with `nativeImage.createFromPath`, so `npm run slice` does it inside a renderer and exports a PNG.
3. **Rows do not all have 8 frames.** Measured: `[7, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8]` — some rows end in empty cells, and playing a blanket 8 frames flashes blank. `pet-spec.js` uses the measured values.
4. **The renderer needs the network to be impossible.** The renderer never talks to the network; every model call happens in the main process. A `connect-src 'none'` CSP makes that a guarantee rather than a convention.
5. **Row names lie — map states by looking at the animation.** Row 8 is called `review` and sounds like a quiet reading pose; the artwork is a **full left-right head swing**. Row 1 is called `running-right`; the artwork is a **seated sway**. Both names cost me a bug: once the head swing was used as the reading pose (she never stopped shaking her head), once the walking artwork was used as the seated idle (she looked like she was walking on the spot). `npm run slice` prints each row's **per-frame pixel delta** and writes `.qa/motion-profile.json`. Clips are now named after what they draw (`lyingRead` / `seatedShake` / `seatedNod`), and any busy pose must carry a `maxHoldMs` cap — the head swing survives, but for at most 7 seconds.
6. **"She's too quiet" can be a scheduling problem, not a probability problem.** The old implementation pushed the next decision 24–62 seconds out after every walk, so she **walked for 2.5s and then lay flat for a minute** — measured at ~95% lying. Tuning the probabilities would not have helped. It is now "settle (2–4 poses) → stroll → settle", with a deterministic assertion: `samplePoses(6000)` samples the pose distribution and requires both lying and sitting to be ≥30%.
7. **State names and clip names are two vocabularies; confusing them blanks the window.** `thinking` was once written as `clip: 'daydream'` (a state name), and `Animator`'s default clip name still referenced a deleted `'idle'`. Both throw while drawing the **first frame**, so the renderer died and the window stayed empty. `validateStates()` now checks at startup and `Animator.clip` falls back.
8. **A `loop: false` state must not reference a looping clip.** Overlay auto-expiry asks "has the clip finished?", and a looping clip never finishes — so the `sad` / `angry` reactions **flashed for a single frame and vanished**. Also covered by `validateStates()`.
9. **The bubble is a shared resource; "small talk" and "the answer you asked for" must be distinguished.** Ambient lines reused the same bubble *and* overwrote its only copy, so a long answer replaced by "…my legs have gone numb" was **gone for good**. The bubble now carries a `kind`, ambient lines skip while an answer is showing, replies have their own copy, and the history window is the backstop.
10. **"Don't move while I'm reading" needs an explicit attention signal.** The behaviour engine had no idea anything was on screen, so she would wander off and bubble over it. A reply now sets an `attentionUntil` hold, released when the bubble closes (or on timeout).
11. **Cancelling a walk must notify the renderer.** Completion sends `walk:done`, but a walk cut short by `stopWalk()` did not — leaving her stuck in the walking pose, swaying on the spot forever. `stopWalk({notify: true})` is now used on every external cancellation path.
12. **The art carries a dark alpha fringe.** Semi-transparent edge pixels have dark RGB (measured mean `42,29,44` against `183,167,185` for the solid body), which composites into a dirty grey outline on light desktops. A colour-bleed pass runs once at startup; alpha is untouched.
13. **The mood tint has to be clipped to the silhouette and kept very faint — and off by default.** See [About the mood tint](#about-the-mood-tint); the draw order must be character-then-effects for the clip to work at all.
14. **A transparent window's `setPosition` is cheap** (measured ~1–2ms), so walking can move the window per frame — but writing the config file on every move must be debounced.
15. **Stepless *and* sharp scaling needs supersampling, not snapping.** Rasterise at an integer multiple into an offscreen canvas, then scale to the target: exact multiples are a 1:1 blit, everything else is a downsample. Snapping to integer multiples alone makes the size control feel like it has only a few steps.
16. **Gaze tracking cannot rely on `mousemove`.** Once the pointer leaves the window the renderer receives no further move events, so the last known position **freezes** — and if the cursor exited through a side edge, that position was still inside the engage radius, so she stared that way indefinitely. The main process now polls `screen.getCursorScreenPoint()` at 10Hz, which is independent of window bounds, making "the cursor went away" a fact instead of an inference.
17. **Changing a default requires a migration.** `deepMerge(DEFAULT_SETTINGS, stored)` lets the stored value win, so changing a default does nothing for anyone who already saved that key — and the migration must run after the merge while reading the version from the raw file. See [About the mood tint](#about-the-mood-tint).
18. **Never leave Enter as the only way to save a text field.** The API key field originally saved only on Enter, so typing a key and clicking *Done* discarded it silently — and the re-render triggered by any other setting change cleared the field as well. There is now an explicit Save button, save-on-blur, save-before-close, and protection for unsaved input.

---

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

---

## FAQ

**I filled in the API key but it keeps asking for one.** Make sure you clicked **Save** (Enter, or clicking *Done*, also saves). On success the hint below the field reads "saved and encrypted with the system keychain", and the placeholder becomes "saved (leave blank to keep)". If it still fails, click **Test connection** for the actual error.

**Her answers are too short / I want her to actually help.** That is the casual persona's 1–3 sentence constraint. Type **`/work`**, or enable **work mode** in settings; she drops the length limit, allows Markdown and code, and prioritises accuracy over tone. `/pet` switches back.

**An answer disappeared before I finished reading.** It no longer can: long replies stay up proportionally to their length (up to 60s), she neither walks away nor interjects meanwhile, and the reply is stored separately. Click her to bring the last answer back verbatim; older ones are in the tray menu → **History…**.

**She never speaks / reports the API key is rejected.** Check the key was copied in full and that the account has credit (HTTP 402 means insufficient balance). **Test connection** on the settings page shows the reason directly.

**She blocks me from clicking other windows.** Turn on **click-through** (on by default). Only she, the bubble and the composer accept the mouse; the rest of the window passes clicks straight through to the desktop.

**She is above other windows and I want her below.** Turn off **always on top** in the tray or right-click menu.

**How do I stop her wandering?** Right-click menu → Autonomous behaviour → turn off **Wander**. Uncheck **Autonomous behaviour** to stop all of it.

**She shakes her head / sways on the spot for ages.** There were two sources, both fixed: (1) the walking sprite rows are a seated sway, and a walk could previously last close to 20 seconds; (2) the "reading" state used row 8, whose artwork *is* a left-right head swing, and she spent most of her time in that state. Both are resolved — row 8 is now capped at 7 seconds and only used as a brief pose. If you want her calmer still, right-click menu → Autonomous behaviour → turn off **Wander**.

**She stares in one direction and won't stop.** That was a bug in an older version (the gaze froze once the cursor left the window). Gaze now uses the globally polled cursor position and releases once the cursor is ~300px away. If it still happens, check that **gaze follow** is enabled, and whether your display uses Wayland (system cursor position may be unavailable there, in which case it falls back to the old behaviour).

**She looks recoloured.** Check **mood tint** in settings. It is **off by default**; if it is on and looks yellow, turn it off — the particle effects are unaffected.

> Upgrading from an older build? That version defaulted the switch to on and **saved that value to your config**. Current builds migrate it off automatically at startup, so there is nothing to do by hand.

**The edges still look grey, or I want it sharper.** Make sure **Remove edge fringe** is on. Choose **Hard pixel** if you want harder edges, but the supersampled default is recommended. If the whole **area around her** looks grey rather than her edges, that is not a fringe problem — check you are on a current build (older ones had a glow that spilled onto the background).

**The size slider barely does anything.** Current builds are stepless. If dragging seems to have no effect, the window may already be at the screen's height limit; `fitSpriteSize` clamps her back into the available space.

**The balance always says "not checked yet".** An API key is required first. Once saved, click **Check now** on the settings page; if it errors, the message appears in the balance card (a 401 means the key is invalid).

**Auto-start stopped working after I moved the project.** It registers the absolute path of `electron.exe`. If the project moves, toggle **Start on login** off and on again in settings.

**Can I use a different character?** Yes. Replace `assets/citlali/` with any package following the Awesome Codex Pet v2 format (1536×2288 WebP, 8×11, 192×208 per frame), then update `atlasUrl` in `src/preload/preload.js`. If the new artwork's gaze directions are not mirrored, set `LOOK_INDEX_MIRRORED` in `src/shared/pet-spec.js` accordingly, and update `CLIPS` with the frame counts reported by `npm run slice`.
