// Engine-level test for the air-pointer gesture window, driven through the
// REAL render loop: a mock tracker (the createAvatarEngine `tracker` seam)
// feeds a frontal face plus a pointing hand, and the assertions watch the
// engine's public pointer/zoom surface and the actual drawImage calls.
//
// Verified contract:
//   1. pointing dwells -> window opens (phase 'shown'); a brief hold never does
//   2. dwelling the fingertip on a cell fires it once: viewZoom steps,
//      and the avatar sprite's drawn size actually scales by the same factor
//   3. reset returns the zoom to exactly 1
//   4. close dismisses the window while the finger stays up
//
// The pointer state machine runs on wall-clock time (performance.now()), so
// the hold is a real 500ms sleep — that is an upper bound, not a race: any
// elapsed time ≥ POINTER_HOLD_MS opens the window, so CI load cannot flake it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAvatarEngine, AV_OUT_W, AV_OUT_H } from '../src/avatar-engine.js';
import { pointerWindowRect, POINTER_ZOOM_STEP } from '../src/avatar-math.js';

const IW = 320, IH = 480;

// --- DOM stubs (same recording-context pattern as avatar-fit-2d.test.js) ----
function makeRecorder() {
  const calls = { drawImage: [], translate: [], scale: [], fillText: [] };
  const rec = name => (...args) => { calls[name].push(args); };
  const ctx = {
    clearRect() {}, save() {}, restore() {}, beginPath() {}, moveTo() {},
    lineTo() {}, arc() {}, fill() {}, stroke() {}, fillRect() {},
    translate: rec('translate'), scale: rec('scale'), drawImage: rec('drawImage'),
    fillText: rec('fillText'), rotate() {}, transform() {}, strokeRect() {},
  };
  return { ctx, calls };
}

const makeCanvasStub = recorder => ({
  width: 0, height: 0,
  getContext: () => recorder.ctx,
  captureStream: () => ({ getVideoTracks: () => [{ stop() {} }] }),
});

class FakeImage {
  constructor() { this.width = 0; this.height = 0; this.onload = null; this.onerror = null; }
  set src(_) {
    queueMicrotask(() => { this.width = IW; this.height = IH; this.onload && this.onload(); });
  }
}

const rafQueue = [];
const pump = n => {
  for (let i = 0; i < n; i++) {
    const frame = rafQueue.shift();
    if (frame) frame(performance.now());
  }
};
globalThis.requestAnimationFrame = fn => rafQueue.push(fn);
globalThis.cancelAnimationFrame = () => {};

// --- synthetic face (frontal, same construction as avatar-fit-2d.test.js) ---
function mkFace({ midX = 0.5, midY = 0.4, eyeDist = 0.13 } = {}) {
  const pts = Array.from({ length: 478 }, () => ({ x: midX, y: midY + 0.2, z: 0 }));
  pts[33] = { x: midX - eyeDist / 2, y: midY, z: 0 };
  pts[263] = { x: midX + eyeDist / 2, y: midY, z: 0 };
  pts[1] = { x: midX, y: midY + 0.44 * 0.22, z: 0 };
  pts[152] = { x: midX, y: midY + 0.22, z: 0 };
  return pts;
}

// --- synthetic pointing hand: lone index extended, tip at (x, y) ------------
function mkPointHand(tipX, tipY) {
  const pts = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.9, z: 0 }));
  pts[0] = { x: 0.5, y: 0.85, z: 0 };               // wrist
  pts[5] = { x: 0.5, y: 0.7, z: 0 };                // index knuckle
  pts[8] = { x: tipX, y: tipY, z: 0 };              // index tip (the cursor)
  for (const [tip, kn] of [[12, 9], [16, 13], [20, 17]]) {
    pts[kn] = { x: 0.5, y: 0.7, z: 0 };
    pts[tip] = { x: 0.5, y: 0.78, z: 0 };           // curled toward the palm
  }
  return pts;
}

const FIT = { leftEye: { x: 0.2, y: 0.3 }, rightEye: { x: 0.7, y: 0.3 } };

async function bootEngine(t) {
  globalThis.Image = FakeImage;
  t.after(() => { delete globalThis.Image; });
  let facePts = mkFace();
  let handPts = null;
  const tracker = {
    detect() {
      return {
        landmarks: facePts, blends: null, body: null,
        hands: handPts ? [{ label: 'Right', landmarks: handPts }] : null,
      };
    },
    async dispose() {},
  };
  const recorder = makeRecorder();
  const engine = createAvatarEngine({
    mode: '2d',
    assetUrl: 'blob:fake-avatar',
    hands: true,
    body: false,
    fit: FIT,
    tracker,
    canvas: makeCanvasStub(recorder),
  });
  t.after(() => engine.destroy());
  await engine.start();
  await new Promise(r => queueMicrotask(r));
  pump(60);   // converge face EMA
  return { engine, recorder, setHand: pts => { handPts = pts; } };
}

// Fitted-path sprite width from the last drawImage call (img, ox, oy, dw, dh).
const lastDw = recorder => recorder.calls.drawImage.at(-1)[3];

test('air-pointer window: hold opens, dwell on cells drives zoom, reset, close', async t => {
  const { engine, recorder, setHand } = await bootEngine(t);

  // Baseline sprite width at zoom 1 (no hand pointing yet).
  const baseline = lastDw(recorder);
  assert.ok(baseline > 0, 'sprite drawn before the gesture');

  // 1) Brief point (well under POINTER_HOLD_MS): window must NOT open.
  setHand(mkPointHand(0.5, 0.42));
  pump(8);
  assert.equal(engine.pointer.phase, 'counting');

  // Lower the hand again briefly, then hold for real: the aborted count must
  // not resurrect as an instant open.
  setHand(null);
  pump(4);
  setHand(mkPointHand(0.5, 0.42));
  pump(4);
  assert.equal(engine.pointer.phase, 'counting');

  await new Promise(r => setTimeout(r, 500));   // real hold (upper bound, race-free)
  pump(8);
  assert.equal(engine.pointer.phase, 'shown', 'window opens after the hold');
  assert.equal(engine.viewZoom, 1);

  // 2) Dwell on zoom-in: cell centers come from the same geometry the engine
  //    hit-tests, with the window frozen at its open position (0.5, 0.42).
  const rect = pointerWindowRect(0.5, 0.42, AV_OUT_W, AV_OUT_H);
  const center = id => {
    const a = rect.actions.find(a => a.id === id);
    return [(a.x + a.w / 2) / AV_OUT_W, (a.y + a.h / 2) / AV_OUT_H];
  };
  const [zx, zy] = center('zoom-in');
  setHand(mkPointHand(zx, zy));
  pump(24);   // EMA-converge the fingertip into the cell
  assert.equal(engine.pointer.action, 'zoom-in');
  assert.ok(Math.abs(engine.viewZoom - (1 + POINTER_ZOOM_STEP)) < 1e-9, 'zoom stepped');
  const grown = lastDw(recorder);
  assert.ok(
    Math.abs(grown / baseline - (1 + POINTER_ZOOM_STEP)) < 0.02,
    `sprite width scales by the zoom factor (${grown} vs ${baseline})`
  );
  // Window chrome is being drawn on top of the avatar.
  assert.ok(recorder.calls.fillText.length > 0, 'window text drawn into the canvas');

  // 3) Reset returns the zoom (and sprite size) to baseline.
  const [rx, ry] = center('reset');
  setHand(mkPointHand(rx, ry));
  pump(24);
  assert.equal(engine.pointer.action, 'reset');
  assert.equal(engine.viewZoom, 1);
  const restored = lastDw(recorder);
  assert.ok(Math.abs(restored - baseline) < baseline * 0.02, 'sprite back to baseline size');

  // 4) Close dismisses while the finger stays up.
  const [cx, cy] = center('close');
  setHand(mkPointHand(cx, cy));
  pump(24);
  assert.equal(engine.pointer.action, 'close');
  assert.equal(engine.pointer.phase, 'hidden');
  pump(24);
  assert.equal(engine.pointer.phase, 'hidden', 'stays closed while still pointing');
});
