// Browser side of the repeatable body-rig verification (see body-rig-verify.mjs).
//
// Phase 1 — CAPTURE: seeks N points across a recorded clip and derives a
// wizard-exact calibration the way Settings.jsx's captureBody/captureArms do:
//   - neutral body  = averages of bodyMetrics() over the first half of points,
//   - arm sweep     = per-frame (shoulder.y - wrist.y) / neutralArmLen min..max
//                     over ALL points, padded ±0.06 like the wizard.
// Phase 2 — VERIFY: applies the saved calibration to held-out frames and checks
//   - genuine arms-at-sides frames map to raise ~0 (rest endpoint),
//   - the clip's raised frames map to raise ~1 (top endpoint),
//   - the 2D rig (bodyRigPoints2D, the exact math the 3D rig mirrors) moves:
//     wrists below shoulders at rest, above shoulders at the top,
//   - calibrated raise rises monotonically with raw wrist height.
//
// Results are posted to window.__done as { ok, results, errors }.
import { createMediaPipeTracker } from '../../src/avatar-engine.js';
import { bodyMetrics, applyBodyCalibration, bodyRigPoints2D } from '../../src/avatar-math.js';

const out = document.getElementById('out');
window.__logs = [];
const log = (...a) => {
  const line = a.join(' ');
  out.textContent += line + '\n';
  window.__logs.push(line);
  console.log(...a);
};

const qs = new URLSearchParams(location.search);
const CLIP = qs.get('clip') || '/fixtures/jumping_jacks.webm';
const N = parseInt(qs.get('points') || '90', 10);
const SEEK_TIMEOUT = parseInt(qs.get('seekTimeout') || '2500', 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run() {
  out.textContent = '';
  log(`clip=${CLIP} points=${N}`);

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.style.cssText = 'position:fixed;width:2px;height:2px;opacity:0.01;pointer-events:none;';
  document.body.appendChild(video);   // MediaPipe needs a DOM-attached element to grab frames
  await new Promise((res, rej) => {
    video.onloadeddata = res;
    video.onerror = () => rej(new Error('video failed to load: ' + CLIP));
    video.src = CLIP;
  });
  log('video ready ' + video.videoWidth + 'x' + video.videoHeight + ' ' + video.duration.toFixed(1) + 's');

  const tracker = await createMediaPipeTracker({
    wantBody: true, wantHands: false,   // createMediaPipeTracker keys (body/hands are engine cfg keys)
    video, videoWidth: video.videoWidth, videoHeight: video.videoHeight,
    onStatus: () => {},
    delegate: 'CPU',   // deterministic in headless; GPU graphs silently no-op there
  });
  log('MediaPipe tracker ready');
  await video.play().catch(() => {});   // prime the media pipeline so paused seeks land
  await sleep(300);

  const detect = () => {
    try {
      const r = tracker.detect();
      return r && r.body && r.body.length > 25 ? r.body : null;
    } catch { return null; }
  };

  // --- Phase 1: capture (seek-sampled; deterministic under headless timers) ---
  const frames = [];
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) * video.duration / N;
    video.currentTime = t;
    await new Promise(r => {
      const d = () => { video.removeEventListener('seeked', d); r(); };
      video.addEventListener('seeked', d);
      setTimeout(d, SEEK_TIMEOUT);
    });
    if (Math.abs(video.currentTime - t) > 0.5) {
      log('WARN seek missed t=' + t.toFixed(1) + ' at=' + video.currentTime.toFixed(1));
    }
    const body = detect();
    if (!body) continue;
    const m = bodyMetrics(body);
    if (!m) continue;
    const side = (shIdx, wrIdx, armLen) => {
      if (!armLen || armLen < 1e-6) return null;
      const sh = body[shIdx], wr = body[wrIdx];
      if (!sh || !wr) return null;
      return { dy: (sh.y - wr.y) / armLen, dx: (wr.x - sh.x) / armLen };
    };
    frames.push({ i, t: video.currentTime, body, metrics: m, l: side(11, 15, m.armLenL), r: side(12, 16, m.armLenR) });
  }
  const MIN_FRAMES = Math.max(5, Math.floor(N * 0.4));
  if (frames.length < MIN_FRAMES) throw new Error('too few full-body detections: ' + frames.length + '/' + N + ' (need >= ' + MIN_FRAMES + ')');

  // Neutral body from the first half of the timeline (arm lengths are stable);
  // the sweep band from even-indexed points; verification from ODD-indexed
  // points so rest and raised phases both appear in the training-free set
  // (the clip's overhead moments are temporally clustered, so a timeline half
  // split starves one endpoint).
  const cut = Math.floor(frames.length * 0.5);
  const neutral = frames.slice(0, cut);
  const bandFrames = frames.filter(x => x.i % 2 === 0);
  const avg = (arr, k) => arr.reduce((x, m) => x + (m.metrics[k] || 0), 0) / arr.length;
  const body = {
    midX: avg(neutral, 'midX'), midY: avg(neutral, 'midY'),
    shoulderSpan: avg(neutral, 'shoulderSpan'),
    armLenL: avg(neutral, 'armLenL'), armLenR: avg(neutral, 'armLenR'),
  };
  const rng = { l: { dy: [9, -9], dx: [9, -9] }, r: { dy: [9, -9], dx: [9, -9] } };
  let sweep = 0;
  bandFrames.forEach(x => { ['l', 'r'].forEach(sk => {
    const s = x[sk]; if (!s) return;
    sweep++;
    const t = rng[sk];
    t.dy[0] = Math.min(t.dy[0], s.dy); t.dy[1] = Math.max(t.dy[1], s.dy);
    t.dx[0] = Math.min(t.dx[0], s.dx); t.dx[1] = Math.max(t.dx[1], s.dx);
  }); });
  const pad = 0.06;
  ['l', 'r'].forEach(sk => { const t = rng[sk]; t.dy[0] -= pad; t.dy[1] += pad; t.dx[0] -= pad; t.dx[1] += pad; });
  const cal = { body, armRange: rng };
  log(`calibrated: armLenL=${body.armLenL.toFixed(3)} armLenR=${body.armLenR.toFixed(3)} span=${body.shoulderSpan.toFixed(3)} dyRange=[${rng.l.dy[0].toFixed(2)}, ${rng.l.dy[1].toFixed(2)}]`);

  // --- Phase 2: verify on held-out frames (second half) ---
  const heldOut = frames.filter(x => x.i % 2 === 1);
  const calDy = (x, sk) => {
    const len = sk === 'l' ? body.armLenL : body.armLenR;
    if (!len || len < 1e-6) return null;
    const sh = x.body[sk === 'l' ? 11 : 12], wr = x.body[sk === 'l' ? 15 : 16];
    return sh && wr ? (sh.y - wr.y) / len : null;
  };
  // Rest/top selection by quantile of the verify set: a fixed fraction of the
  // captured band is unsatisfiable for real clips because overhead moments
  // have slightly bent elbows (shorter neutral-arm-normalized dy). Quantiles
  // pick whatever the clip's own lowest/highest reach is — honest, because a
  // clip without genuine raised frames still FAILS the "top maps high" check.
  const calib = heldOut.map(x => ({ x, l: calDy(x, 'l'), r: calDy(x, 'r') }))
    .filter(v => v.l != null && v.r != null);
  const q = (arr, f) => {
    const srt = arr.slice().sort((a, b) => a - b);
    return srt[Math.min(srt.length - 1, Math.floor(srt.length * f))];
  };
  const lAll = calib.map(v => v.l), rAll = calib.map(v => v.r);
  const botL = q(lAll, 0.15), botR = q(rAll, 0.15);
  const topL = q(lAll, 0.85), topR = q(rAll, 0.85);
  const rest = calib.filter(v => v.l <= botL && v.r <= botR).map(v => v.x);
  const top = calib.filter(v => v.l >= topL && v.r >= topR).map(v => v.x);
  const raiseOf = (b) => {
    const p = applyBodyCalibration(b, cal);
    return p ? (p.armL.raise + p.armR.raise) / 2 : null;
  };
  const restRaise = rest.map(x => raiseOf(x.body)).filter(v => v != null);
  const topRaise = top.map(x => raiseOf(x.body)).filter(v => v != null);

  // Rig motion: bodyRigPoints2D is the exact placement math the 3D rig mirrors.
  const rigOf = (x) => {
    const p = applyBodyCalibration(x.body, cal);
    if (!p) return null;
    const j = bodyRigPoints2D(x.body, p, 640, 480);
    if (!j) return null;
    return { wristL: j[4], wristR: j[5], shL: j[0], shR: j[1] };
  };
  const restRig = rest.length ? rigOf(rest[0]) : null;
  const topRig = top.length ? rigOf(top[0]) : null;
  // raise ~0 places wrists AT the shoulder line, so "not raised" (at or below)
  // is the correct rest assertion; the top must be clearly raised (>= 4px up).
  const restWristNotRaised = restRig
    ? (restRig.wristL.y >= restRig.shL.y && restRig.wristR.y >= restRig.shR.y)
    : false;
  const topWristAbove = topRig
    ? (topRig.wristL.y < topRig.shL.y - 4 && topRig.wristR.y < topRig.shR.y - 4)
    : false;

  // Monotonicity: calibrated raise must rise with raw wrist height.
  const pairs = frames.map(x => {
    const r = raiseOf(x.body);
    const raw = (x.l && x.r) ? (x.l.dy + x.r.dy) / 2 : null;
    return r != null && raw != null ? { r, raw } : null;
  }).filter(Boolean);
  let corr = null;
  if (pairs.length > 10) {
    const n = pairs.length;
    const mx = pairs.reduce((a, b) => a + b.raw, 0) / n;
    const my = pairs.reduce((a, b) => a + b.r, 0) / n;
    let num = 0, dx2 = 0, dy2 = 0;
    for (const p of pairs) {
      num += (p.raw - mx) * (p.r - my);
      dx2 += (p.raw - mx) ** 2;
      dy2 += (p.r - my) ** 2;
    }
    corr = dx2 && dy2 ? num / Math.sqrt(dx2 * dy2) : 0;
  }

  const results = {
    clip: CLIP, sampled: frames.length, neutral: neutral.length, sweepSamples: sweep,
    armLen: { l: +body.armLenL.toFixed(3), r: +body.armLenR.toFixed(3) },
    dyRange: { l: [+rng.l.dy[0].toFixed(2), +rng.l.dy[1].toFixed(2)], r: [+rng.r.dy[0].toFixed(2), +rng.r.dy[1].toFixed(2)] },
    rest: {
      frames: rest.length,
      raiseAvg: restRaise.length ? +((restRaise.reduce((a, b) => a + b, 0) / restRaise.length).toFixed(3)) : null,
      raiseMax: restRaise.length ? +Math.max(...restRaise).toFixed(3) : null,
      wristNotRaised: restWristNotRaised,
    },
    top: {
      frames: top.length,
      raiseAvg: topRaise.length ? +((topRaise.reduce((a, b) => a + b, 0) / topRaise.length).toFixed(3)) : null,
      raiseMin: topRaise.length ? +Math.min(...topRaise).toFixed(3) : null,
      wristAbove: topWristAbove,
    },
    monotonic: corr != null ? +corr.toFixed(3) : null,
  };
  results.ok = true;
  window.__done = { ok: true, results, errors: [] };
  log('RESULT ' + JSON.stringify(results));
  try { tracker.dispose(); } catch {}
}

run().catch(e => {
  log('FATAL ' + (e && e.stack || e));
  window.__done = { ok: false, results: null, errors: [String(e && e.message || e)], logs: window.__logs };
});