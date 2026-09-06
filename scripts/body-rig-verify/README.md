# Body-rig verification (headless, no webcam required)

Repeatable two-phase check that the avatar body rig — calibration capture and
calibrated arm motion — works against **real MediaPipe Pose** detections, using
a recorded clip instead of a live camera. This is the same check that was
originally run by hand through the preview browser; this script makes it a
one-command, CI-runnable tool.

## How it works

`body-rig-verify.mjs` (node driver) does four things:

1. **Build** — bundles the harness page (`harness.html` + `harness.js`) with a
   dedicated Vite config that also ships the repo's committed `public/ml`
   MediaPipe assets (`pose_landmarker.task`, wasm). Kept separate from the
   app's `vite.config.js` on purpose (a single-entry build loads cleanly in
   headless browsers).
2. **Serve** — a tiny loopback static server serves the built page and the
   recorded clip.
3. **Run** — headless Chromium (Playwright) loads the harness, which:
   - **Phase 1 (capture):** seeks N points across the clip and derives a
     wizard-exact calibration the same way the calibration wizard does:
     `bodyMetrics()` averages over the first half of points for the neutral
     body, and a per-frame `(shoulder.y − wrist.y) / armLen` min…max over the
     even-indexed points (padded ±0.06) for the arm sweep.
   - **Phase 2 (verify):** applies that calibration to the **odd-indexed**
     points (a training-free split by parity — a timeline half-split would
     starve one endpoint because a clip's overhead phase is temporally
     clustered) and checks the claims below.
4. **Assert** — prints a PASS/FAIL table and exits `0` / `1`.

## Usage

```bash
# one-time setup
npm i -D playwright
npx playwright install chromium

# bundled demo clip (jumping jacks — arms at the sides AND raised)
node scripts/body-rig-verify.mjs --demo

# your own recorded clip (path or URL)
node scripts/body-rig-verify.mjs --clip /path/to/clip.webm
node scripts/body-rig-verify.mjs --clip https://example.com/clip.webm --points 120 --out result.json
```

Options: `--points <n>` (default 90), `--out <path>` (write results JSON),
`--port <n>`, `--timeout <ms>` (default 300000), `--keep` (keep the build dir
for debugging), `--headful` (watch it run in a visible browser).

`--points` below ~40 is smoke-test territory: the parity split halves the
sample set, so the rest/top frame-count assertions need enough points to have
coverage. Use the default for real verification.

## Assertions

| check | threshold |
| --- | --- |
| full-body detections across the sweep | ≥ 40 of the sampled points |
| captured sweep span (`dyRange` width) | ≥ 0.7 |
| arms-at-sides frames present (bottom quantile of the verify set) | ≥ 3 |
| **rest → raise** (avg / max) | ≤ 0.15 / ≤ 0.35 |
| raised frames present (top quantile of the verify set) | ≥ 3 |
| raised frames → raise | avg ≥ 0.55 |
| 2D rig motion (wrists vs shoulders) | at/below at rest, above at top |
| raise monotonic with raw wrist height | Pearson r > 0.4 |

Rest/top frames are selected by **quantile of the verify set** (bottom/top 15%),
not by an absolute threshold on the captured band: real clips' overhead moments
have slightly bent elbows, which shorten the neutral-arm-normalized reach. What
the assertions guard is the mapping, not the absolute reach — a clip without
genuine raised frames still fails the "top maps high" check.

The rest-endpoint assertions are the ones a shoulder-press-only clip can never
satisfy — the clip must contain genuine arms-at-sides frames for them to pass.
That is the point: a real user's calibration is captured from the same motion.

## Picking a good clip

Full body in frame, decent light, arms clearly **at the sides** and clearly
**raised overhead** (jumping jacks, an unweighted overhead press, or a clean &
press). A few seconds is plenty. MediaPipe Pose tracks best when the whole
torso stays in frame; raised arms drifting out of the top of the frame count as
missed frames, which just reduces sample coverage.

## Fixture

`fixtures/jumping_jacks.webm` — "Jumping jacks and burpees" by **Taco Fleur**,
Wikimedia Commons, licensed **CC BY-SA 4.0**
(https://creativecommons.org/licenses/by-sa/4.0/). It satisfies the
arms-at-sides + raised requirement and is the reference the thresholds are
calibrated against (rest raise avg ≈ 0.01, top raise avg ≈ 0.75).

## Notes

- The browser binary is not committed — CI must run `npx playwright install
  chromium` (see the prerequisites). No system packages are needed on the
  default GitHub Actions `ubuntu-latest` image.
- The harness forces the engine's MediaPipe `delegate: 'CPU'` (a small option
  added to `createMediaPipeTracker` in `src/avatar-engine.js`, default stays
  GPU-first for real devices). In headless Chromium, a SwiftShader WebGL
  context lets the GPU delegate *create* successfully but its graph then
  silently produces no detections; explicit CPU is deterministic everywhere.
- No backend/database is involved; the script never touches the network except
  for an optional `--clip <url>` download.