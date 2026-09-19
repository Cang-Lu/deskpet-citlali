# Development notes

Implementation findings, measurements and dead ends encountered while building
this project. Not required reading to use or run the app — it is here so that
whoever changes the code next does not have to rediscover it.

---

## Row names lie — map states by looking at the animation

The published atlas row labels describe the artwork badly:

| Row | Label | What it actually draws |
| --- | --- | --- |
| 1 | `running-right` | A **seated sway**, not a run |
| 8 | `review` | A **full left-right head swing**, not quiet reading |

Both names cost a bug. Row 8 was assigned to the reading state — the state she
spends most of her time in — so she appeared to shake her head constantly. Row 1
was later reused as a seated idle pose, which made her look like she was walking
on the spot.

`npm run slice` prints each row's **per-frame pixel delta** and writes
`.qa/motion-profile.json`:

| Row | Animation | Avg changed px per frame pair |
| --- | --- | --- |
| 0 | idle | 2190 |
| 1 | running-right | 2408 |
| 2 | running-left | 2078 |
| 3 | waving | 1981 |
| 4 | jumping | 1981 |
| 5 | failed | 3307 |
| 6 | waiting | 3180 |
| 7 | running-working | 2190 |
| 8 | review | 4242 |
| 9 | look-000-157 | 3267 |
| 10 | look-180-337 | 3633 |

`CALM_MOTION_LIMIT` is 2600. Clips are now named after what they draw
(`lyingRead`, `seatedShake`, `seatedNod`) rather than after their row, and any
busy pose must carry a `maxHoldMs` cap — the head swing survives as a gesture,
but for at most 7 seconds.

## Frame counts are not uniform

Measured: `[7, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8]`. Several rows end in empty cells;
playing a blanket 8 frames flashes blank cells.

## "Too quiet" was a scheduling bug, not a probability bug

The first implementation pushed the next decision 24–62 seconds out after every
walk, so she **walked for 2.5 seconds and then lay flat for a minute** — measured
at roughly 95% lying. Tuning the probabilities would not have helped; the
intervals were the problem.

It is now "settle (2–4 poses) → stroll → settle", with a deterministic
assertion: `samplePoses(6000)` samples the pose distribution and requires both
lying and seated poses to be ≥30%.

## Walking pace

Walking at 130 px/s with a 12fps clip read as a hurried scurry. It is now
58 px/s with an 8fps clip, over a 130–260px step (2.2–4.5s).

An earlier version also let a walk run up to 19 seconds across the screen, which
looked like rocking in place because the walking artwork is a seated sway. The
main process now enforces an 8-second ceiling.

## Cancelling a walk must notify the renderer

Completion sends `walk:done`, but a walk cut short by `stopWalk()` originally did
not — leaving her stuck in the walking pose, swaying on the spot forever.
`stopWalk({ notify: true })` is now used on every external cancellation path.

## The renderer cannot run from `file://`

Chromium refuses to load ES modules over `file://` on CORS grounds. The app
registers a `deskpet://` custom protocol to serve pages and assets, which also
keeps the atlas same-origin so the canvas is never tainted.

## `nativeImage` cannot decode WebP

The tray icon cannot be cropped out of the atlas with
`nativeImage.createFromPath`, so `npm run slice` does it inside a renderer and
exports a PNG.

## The renderer must be unable to reach the network

Every model call happens in the main process. A `connect-src 'none'` CSP makes
that a guarantee rather than a convention.

## State names and clip names are two vocabularies

`thinking` was once written as `clip: 'daydream'` — a *state* name, not a clip
name — and `Animator`'s default clip still referenced a deleted `'idle'`. Both
throw while drawing the **first frame**, so the renderer died and the window came
up blank.

`validateStates()` now checks at startup and `Animator.clip` falls back rather
than returning undefined.

## A `loop: false` state must not reference a looping clip

Overlay auto-expiry asks "has the clip finished?", and a looping clip never
finishes — so the `sad` / `angry` reactions **flashed for a single frame and
vanished**. Also covered by `validateStates()`.

## The bubble is a shared resource

Ambient lines reused the same bubble as real replies *and* overwrote its only
copy, so a long answer replaced by "…my legs have gone numb" was gone for good —
clicking her could not bring it back either.

The bubble now carries a `kind`; ambient lines skip while an answer is showing;
replies are stored separately; and the history window is the backstop.

## "Don't move while I'm reading" needs an explicit attention signal

The behaviour engine had no idea anything was on screen, so she would wander off
and bubble over the top of an answer. A reply now sets an `attentionUntil` hold,
released when the bubble closes or on timeout.

Note: passing `0` to that setter must *clear* the hold. The first version only
ever extended the deadline, so the hold could not be released early.

## Gaze tracking cannot rely on `mousemove`

Once the pointer leaves the window the renderer receives no further move events,
so the last known position freezes — and if the cursor exited through a side
edge, that position was still inside the engage radius, so she stared that way
indefinitely.

The main process now polls `screen.getCursorScreenPoint()` at 10Hz, which is
independent of window bounds, making "the cursor went away" a fact rather than an
inference.

## The atlas carries a dark alpha fringe

Semi-transparent edge pixels have dark RGB — measured mean `42,29,44`, against
`183,167,185` for the solid body — which composites into a dirty grey outline on
light desktops. A colour-bleed pass runs once at startup; alpha is untouched.
Measured: ~130,000 edge pixels repainted from 1,226,127 opaque sources in 133ms.

## The mood tint: three attempts and a migration trap

`moodTint` is off by default. Getting there took three tries, each wrong in a
different way:

1. **The first version drew a near-window-sized radial glow behind her with
   `lighter`.** Charming ambient light on a dark desktop; on a **light** desktop
   it became a large grey wash — measured at 231 against a 255 background,
   looking exactly like a broken window background.
2. **Converting it to a silhouette clip, the opacity was also raised from 0.26
   to 0.42.** Under additive blending 0.42 is a soft glow; under normal
   compositing 0.42 **repaints her** — white hair turned cream, skin turned gold.
3. **Even at 0.13 it still looked yellow.** Measuring actual screenshots settled
   it: `b-r = -12` over the cushion, plainly visible across such a large flat
   area. Her cushion is one big near-white surface, so even 11/255 is obvious.

It is now off by default, and when enabled it is clipped to her silhouette with
`source-atop` at draw time, so it cannot spill onto the desktop. The draw order
must be character-then-effects for that clip to work at all.

### The migration trap

`deepMerge(DEFAULT_SETTINGS, stored)` lets the **stored** value win. Flipping
`moodTint`'s default from `true` to `false` therefore did **nothing for anyone
who already had that key saved** — the code was right, the existing
`settings.json` still said `moodTint: true`.

The fix is a `settingsVersion` field plus a migration on load. There is a second
trap inside it: the migration must run *after* `deepMerge`, while the version
number must be read from the **raw file** — because `deepMerge` also fills in
today's default version, after which the config no longer looks old.

## Stepless *and* sharp scaling needs supersampling

Rasterise at an integer multiple into an offscreen canvas, then scale to the
target: at exact multiples the final step is a 1:1 blit and therefore
pixel-exact, and everything in between is a *downsample* rather than a stretch,
so edges come out smooth instead of jagged.

Snapping sizes to integer multiples instead (an earlier approach) makes the size
control feel like it has only a few steps: dragging does nothing for a while,
then jumps.

## A transparent window's `setPosition` is cheap

Measured ~1–2ms per call, so walking can move the window per frame — but writing
the config file on every move must be debounced, and bounds notifications
throttled.

## Never leave Enter as the only way to save a text field

The API key field originally saved only on Enter, so typing a key and clicking
*Done* discarded it silently — and a re-render triggered by any other setting
change cleared the field too. There is now an explicit Save button, save-on-blur,
save-before-close, and protection for unsaved input.

## Testing notes

The self-test judges by **scanning** the assertion object: every key ending in
`Ok` must be true, every key ending in `Handled` must not be false. The earlier
hand-maintained `report.ok` expression silently passed a failing check the moment
a new assertion was added and forgotten — which is exactly what happened.

Screenshots are the authoritative check for anything visual. A hand-read contact
sheet and an "eye centroid" heuristic both got the gaze direction backwards:
the mask classified her **hair shading** as eyes (see `.qa/eye-mask.png`, where
the red mask covers her whole head of hair and none of her eyes). The rendered
app is the source of truth.

The self-test output directory is overridable via `DESKPET_QA_DIR`, because in a
packaged build the app lives in a read-only `app.asar`.

## Packaging notes

- **`npmRebuild` is disabled.** The app has no native dependencies, and the
  rebuild step only demands a toolchain it does not need.
- **The custom protocol reads through `fs`, not `net.fetch`.** Inside `app.asar`
  only Electron's `fs` understands the archive path; handing a `file:` URL to the
  file loader 404s, leaving the atlas unloaded and the window blank.
- **`build/icon.png` is generated**, not hand-drawn: `npm run slice` crops it
  from the sprite sheet at 256×256 for electron-builder to turn into a `.ico`.
