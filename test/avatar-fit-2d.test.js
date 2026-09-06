// Engine-level test for the fitted 2D draw path (VSee-style registration):
// when the avatar config carries feature anchors (the picture's own eye
// positions), drawAvatar2D must pin those anchors onto the tracked face's
// eye midpoint — position AND size — instead of centering the sprite.
//
// The mock-tracker seam (createAvatarEngine's `tracker` option, built for
// tests) feeds a synthetic 478-landmark face straight into the render loop,
// so no MediaPipe wasm/GPU and no camera are involved. A recording 2D context
// captures the actual translate/drawImage calls, and the assertions check the
// fitted-draw contract from those recorded values:
//   1. the sprite is drawn uniformly scaled so the picture's eye midpoint
//      lands exactly on the tracked eye midpoint (the pin),
//   2. scale follows the tracked inter-eye span (lean in -> zoom),
//   3. moving the tracked face moves the pin with it,
//   4. without fit anchors the sprite falls back to the centered draw.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAvatarEngine, AV_OUT_W, AV_OUT_H } from '../src/avatar-engine.js';

// Dimensions of the fake avatar picture load2DAsset will "load".
const IW = 320, IH = 480;

// ---------------------------------------------------------------------------
// Minimal DOM stubs: a recording canvas context, an Image that reports itself
// loaded on a microtask, and a controllable requestAnimationFrame queue so the
// render loop is pumped frame-by-frame (no timers, fully deterministic).
// ---------------------------------------------------------------------------
function makeRecorder() {
  const calls = { drawImage: [], translate: [], scale: [] };
  const rec = name => (...args) => { calls[name].push(args); };
  const ctx = {
    clearRect() {}, save() {}, restore() {}, beginPath() {}, moveTo() {},
    lineTo() {}, arc() {}, fill() {}, stroke() {}, fillRect() {}, fillText() {},
    translate: rec('translate'), scale: rec('scale'), drawImage: rec('drawImage'),
    rotate() {}, transform() {},
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

// The render loop is driven by requestAnimationFrame / cancelAnimationFrame,
// which Node lacks — install a fully controllable stub for the whole file.
globalThis.requestAnimationFrame = fn => rafQueue.push(fn);
globalThis.cancelAnimationFrame = () => {};

// ---------------------------------------------------------------------------
// Synthetic face: a 478-landmark MediaPipe-style array whose eye/nose/chin
// anchors produce a fully frontal pose (yaw = pitch = roll = 0) at the given
// eye midpoint and inter-eye distance.
// ---------------------------------------------------------------------------
function mkFace({ midX = 0.5, midY = 0.4, eyeDist = 0.13 } = {}) {
  const pts = Array.from({ length: 478 }, () => ({ x: midX, y: midY + 0.2, z: 0 }));
  pts[33] = { x: midX - eyeDist / 2, y: midY, z: 0 };   // left eye outer
  pts[263] = { x: midX + eyeDist / 2, y: midY, z: 0 };  // right eye outer
  // Nose sits at the frontal 44% between eye line and chin -> pitch 0.
  pts[1] = { x: midX, y: midY + 0.44 * 0.22, z: 0 };
  pts[152] = { x: midX, y: midY + 0.22, z: 0 };         // chin
  return pts;
}

const mockTracker = getFace => ({
  detect() { return { landmarks: getFace(), blends: null, hands: null, body: null }; },
  async dispose() {},
});

const FIT = { leftEye: { x: 0.2, y: 0.3 }, rightEye: { x: 0.7, y: 0.3 } };

// The fitted-draw scale formula from drawAvatar2D, for cross-checking the
// recorded sprite size against the tracked inputs.
function expectedScale(eyeDist, closeness) {
  const adist = Math.hypot((FIT.rightEye.x - FIT.leftEye.x) * IW, (FIT.rightEye.y - FIT.leftEye.y) * IH);
  return Math.max(0.1, (eyeDist * AV_OUT_W * 1.15) / adist) * 1.05 * closeness;
}

async function bootEngine(t, { fit, getFace }) {
  const recorder = makeRecorder();
  const engine = createAvatarEngine({
    mode: '2d',
    assetUrl: 'blob:fake-avatar',
    hands: false,
    body: false,
    fit,
    tracker: mockTracker(getFace),
    canvas: makeCanvasStub(recorder),
  });
  t.after(() => engine.destroy());
  await engine.start();
  await new Promise(r => queueMicrotask(r)); // let the fake Image "load"
  pump(60);                                  // converge the pose EMA (~1e-15 residual)
  return { engine, recorder };
}

test('fitted 2D draw pins the sprite anchors onto the tracked eye midpoint', async (t) => {
  globalThis.Image = FakeImage;
  t.after(() => { delete globalThis.Image; });

  let face = mkFace(); // mid (0.5, 0.4), eyeDist 0.13 -> closeness exactly 1
  const { recorder } = await bootEngine(t, { fit: FIT, getFace: () => face });

  // One sprite draw per frame, and the last one reflects the converged pose.
  const draws = recorder.calls.drawImage;
  assert.ok(draws.length >= 1, 'the avatar sprite must be drawn');
  const [img, dx, dy, dw, dh] = draws.at(-1);
  assert.equal(img.width, IW);
  assert.equal(img.height, IH);

  // Uniform scale, matching the fitted formula for the tracked eye span.
  const s = dw / IW;
  assert.ok(Math.abs(dh / IH - s) < 1e-9, 'scale must be uniform');
  assert.ok(Math.abs(s - expectedScale(0.13, 1)) < 1e-6,
    `scale ${s} must equal eyeDist*W*1.15/anchorDist * 1.05 * closeness`);

  // THE PIN: the picture's eye midpoint (in device space) must land exactly on
  // the translate origin, which is the tracked eye midpoint (+ breathing bob).
  const [tx, ty] = recorder.calls.translate.at(-1);
  const midAx = (FIT.leftEye.x + FIT.rightEye.x) / 2;
  const midAy = (FIT.leftEye.y + FIT.rightEye.y) / 2;
  assert.ok(Math.abs(dx + midAx * IW * s) < 1e-6,
    'draw x must cancel the picture eye midpoint offset (anchor pins to origin)');
  assert.ok(Math.abs(dy + midAy * IH * s) < 1e-6,
    'draw y must cancel the picture eye midpoint offset (anchor pins to origin)');
  assert.ok(Math.abs(tx - 0.5 * AV_OUT_W) < 1e-3,
    `translate x ${tx} must sit at the tracked eye midpoint x`);
  assert.ok(ty >= 0.4 * AV_OUT_H - 2.5 && ty <= 0.4 * AV_OUT_H + 2.5,
    `translate y ${ty} must sit at the tracked eye midpoint y (+/- bob amplitude 2px)`);
});

test('the pin follows the tracked face and the sprite zooms with the tracked eye span', async (t) => {
  globalThis.Image = FakeImage;
  t.after(() => { delete globalThis.Image; });

  let face = mkFace();
  const { recorder } = await bootEngine(t, { fit: FIT, getFace: () => face });
  const [, , , dw1] = recorder.calls.drawImage.at(-1);
  const s1 = dw1 / IW;

  // Lean in and drift right/up: wider eyes (eyeDist 0.2 -> closeness 1.538)
  // and a new eye midpoint (0.52, 0.35).
  face = mkFace({ midX: 0.52, midY: 0.35, eyeDist: 0.2 });
  pump(60);

  const [img, dx, dy, dw, dh] = recorder.calls.drawImage.at(-1);
  const s = dw / IW;
  const closeness = Math.min(1.9, Math.max(0.5, 0.2 / 0.13));
  assert.ok(Math.abs(dh / IH - s) < 1e-9, 'scale must stay uniform');
  assert.ok(Math.abs(s - expectedScale(0.2, closeness)) < 1e-6,
    `scale ${s} must follow the wider tracked eye span`);
  assert.ok(s > s1, 'leaning closer must zoom the sprite in');

  // The pin moves with the tracked midpoint, anchors still on the origin.
  const [tx, ty] = recorder.calls.translate.at(-1);
  const midAx = (FIT.leftEye.x + FIT.rightEye.x) / 2;
  const midAy = (FIT.leftEye.y + FIT.rightEye.y) / 2;
  assert.ok(Math.abs(dx + midAx * IW * s) < 1e-6 && Math.abs(dy + midAy * IH * s) < 1e-6,
    'anchors must stay pinned to the translate origin after the face moved');
  assert.ok(Math.abs(tx - 0.52 * AV_OUT_W) < 1e-3,
    `translate x ${tx} must follow the tracked midpoint x`);
  assert.ok(ty >= 0.35 * AV_OUT_H - 2.5 && ty <= 0.35 * AV_OUT_H + 2.5,
    `translate y ${ty} must follow the tracked midpoint y (+/- bob)`);
});

test('without fit anchors the sprite falls back to the centered draw', async (t) => {
  globalThis.Image = FakeImage;
  t.after(() => { delete globalThis.Image; });

  let face = mkFace();
  const { recorder } = await bootEngine(t, { fit: null, getFace: () => face });

  const [img, dx, dy, dw, dh] = recorder.calls.drawImage.at(-1);
  const s = dw / IW;
  // Fallback sizes to fit the canvas and centers the sprite on the translate
  // origin (draw at -dw/2, -dh/2) — no anchor pinning.
  assert.ok(Math.abs(s - Math.min(AV_OUT_W / IW, AV_OUT_H / IH) * 1.12) < 1e-9,
    `fallback scale ${s} must be fit-to-canvas * 1.12 * closeness(1)`);
  assert.equal(dx, -dw / 2, 'fallback draw x must center the sprite');
  assert.equal(dy, -dh / 2, 'fallback draw y must center the sprite');
});
