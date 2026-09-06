// Air-pointer gesture: point at the camera to summon a floating zoom window,
// then drive it from the air. These tests lock the pure contract in
// avatar-math.js:
//
//   isPointGesture      - exactly one finger (index) out, others folded
//   stepPointerGesture  - hidden -> counting -> shown state machine, dwell
//                         clicks fire once per entry, zoom clamps, close
//                         dismisses until the hand lowers, aborted counts
//                         never resurrect as instant-open
//   pointerWindowRect   - geometry stays on-canvas; actions are the row cells
//
// All timing is synthetic (explicit `now` values), so the suite is fully
// deterministic under parallel CI load.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isPointGesture,
  stepPointerGesture,
  pointerWindowRect,
  clampZoom,
  POINTER_HOLD_MS,
  POINTER_RELEASE_MS,
  POINTER_ZOOM_STEP,
  POINTER_ZOOM_MIN,
  POINTER_ZOOM_MAX,
} from '../src/avatar-math.js';

// ---------------------------------------------------------------------------
// Synthetic hands: 21 normalized MediaPipe landmarks around a wrist. Tips far
// from the wrist read "out", tips near their knuckle read "folded".
// ---------------------------------------------------------------------------
function mkHand({ index = 'out', middle = 'in', ring = 'in', pinky = 'in' } = {}) {
  const pts = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.9, z: 0 }));
  const place = (tip, knuckle, state) => {
    if (state === 'out') {
      pts[knuckle] = { x: 0.5, y: 0.7, z: 0 };
      pts[tip] = { x: 0.5, y: 0.2, z: 0 };       // far from wrist
    } else {
      pts[knuckle] = { x: 0.5, y: 0.7, z: 0 };
      pts[tip] = { x: 0.5, y: 0.78, z: 0 };      // curled toward the palm (closer to wrist than the knuckle)
    }
  };
  place(8, 5, index);
  place(12, 9, middle);
  place(16, 13, ring);
  place(20, 17, pinky);
  return pts;
}

test('isPointGesture: only a lone extended index finger counts', () => {
  assert.equal(isPointGesture(mkHand()), true, 'index out, others in');
  assert.equal(isPointGesture(mkHand({ middle: 'out' })), false, 'two fingers is not a point');
  assert.equal(isPointGesture(mkHand({ index: 'in' })), false, 'fist is not a point');
  assert.equal(isPointGesture(mkHand({ middle: 'out', ring: 'out', pinky: 'out' })), false, 'open hand');
  assert.equal(isPointGesture(null), false);
  assert.equal(isPointGesture([{ x: 0, y: 0 }]), false, 'short landmark arrays rejected');
});

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------
const freshState = () => ({ phase: 'hidden', x: 0.5, y: 0.4, holdStart: 0, lastSeenAt: 0, wasInside: false, flash: null, dismissed: false, now: 0 });
const point = (x, y) => ({ pointing: true, x, y });
const T0 = 10000;

test('pointer window: hold opens it, a passing gesture never does', () => {
  const st = freshState();
  // Point for less than POINTER_HOLD_MS, then stop -> never opens.
  let r = stepPointerGesture(st, { ...point(0.5, 0.4), now: T0 });
  assert.equal(st.phase, 'counting');
  r = stepPointerGesture(st, { ...point(0.5, 0.4), now: T0 + 100 });
  assert.equal(st.phase, 'counting');
  r = stepPointerGesture(st, { pointing: false, now: T0 + 150 });
  assert.equal(st.phase, 'hidden');
  // Re-point later must NOT instantly open (aborted holdStart reset).
  r = stepPointerGesture(st, { ...point(0.5, 0.4), now: T0 + 900 });
  assert.equal(st.phase, 'counting', 'aborted count must not resurrect');
});

test('pointer window: opens after the hold, lingers after release, then hides', () => {
  const st = freshState();
  stepPointerGesture(st, { ...point(0.4, 0.3), now: T0 });
  stepPointerGesture(st, { ...point(0.4, 0.3), now: T0 + POINTER_HOLD_MS });
  assert.equal(st.phase, 'shown');
  // Window position froze where it opened (so the finger can enter it).
  assert.equal(st.wx, 0.4);
  assert.equal(st.wy, 0.3);
  // Hand vanishes: window stays for the release grace, then hides.
  stepPointerGesture(st, { pointing: false, now: T0 + POINTER_HOLD_MS + 100 });
  assert.equal(st.phase, 'shown', 'brief dropout must not slam the window shut');
  stepPointerGesture(st, { pointing: false, now: T0 + POINTER_HOLD_MS + POINTER_RELEASE_MS + 1 });
  assert.equal(st.phase, 'hidden');
});

// Action-cell centers derived from the same geometry the engine hit-tests —
// driving stepPointerGesture with these coordinates exercises the real path.
function cellCenter(state, id) {
  const rect = pointerWindowRect(state.wx, state.wy);
  const a = rect.actions.find(a => a.id === id);
  return { x: (a.x + a.w / 2) / 640, y: (a.y + a.h / 2) / 360 };
}

function openWindow() {
  const st = freshState();
  stepPointerGesture(st, { ...point(0.45, 0.35), now: T0 });
  stepPointerGesture(st, { ...point(0.45, 0.35), now: T0 + POINTER_HOLD_MS });
  assert.equal(st.phase, 'shown');
  return st;
}

test('dwell clicks: fire once per entry, not while dwelling', () => {
  const st = openWindow();
  const c = cellCenter(st, 'zoom-in');
  // First frame inside the cell fires.
  let r = stepPointerGesture(st, { ...point(c.x, c.y), now: T0 + 1000, viewZoom: 1 });
  assert.equal(r.action, 'zoom-in');
  assert.equal(r.viewZoom, 1 + POINTER_ZOOM_STEP);
  // Still dwelling: no re-fire.
  r = stepPointerGesture(st, { ...point(c.x, c.y), now: T0 + 1060, viewZoom: r.viewZoom });
  assert.equal(r.action, null);
  assert.equal(r.viewZoom, 1 + POINTER_ZOOM_STEP);
  // Leave the row, come back: armed again.
  r = stepPointerGesture(st, { ...point(0.5, 0.1), now: T0 + 1120, viewZoom: r.viewZoom });
  assert.equal(r.action, null);
  r = stepPointerGesture(st, { ...point(c.x, c.y), now: T0 + 1180, viewZoom: r.viewZoom });
  assert.equal(r.action, 'zoom-in');
  assert.ok(Math.abs(r.viewZoom - (1 + 2 * POINTER_ZOOM_STEP)) < 1e-9, 'second entry fires again');
});

test('zoom-out, reset and clamp bounds', () => {
  const st = openWindow();
  const out = cellCenter(st, 'zoom-out');
  let r = stepPointerGesture(st, { ...point(out.x, out.y), now: T0 + 1000, viewZoom: 1 });
  assert.equal(r.action, 'zoom-out');
  assert.equal(r.viewZoom, 1 - POINTER_ZOOM_STEP);

  const rst = cellCenter(st, 'reset');
  r = stepPointerGesture(st, { ...point(rst.x, rst.y), now: T0 + 1100, viewZoom: 1.4 });
  assert.equal(r.action, 'reset');
  assert.equal(r.viewZoom, 1);

  assert.equal(clampZoom(99), POINTER_ZOOM_MAX);
  assert.equal(clampZoom(-5), POINTER_ZOOM_MIN);
  // Clamped ceiling: clicking zoom-in at max stays at max.
  const zin = cellCenter(st, 'zoom-in');
  r = stepPointerGesture(st, { ...point(zin.x, zin.y), now: T0 + 1200, viewZoom: POINTER_ZOOM_MAX });
  assert.equal(r.action, 'zoom-in');
  assert.equal(r.viewZoom, POINTER_ZOOM_MAX);
});

test('close dismisses while pointing, re-arms after the hand lowers', () => {
  const st = openWindow();
  const c = cellCenter(st, 'close');
  let r = stepPointerGesture(st, { ...point(c.x, c.y), now: T0 + 1000 });
  assert.equal(r.action, 'close');
  assert.equal(st.phase, 'hidden');
  // Finger still up (still pointing at the same spot): stays hidden.
  r = stepPointerGesture(st, { ...point(c.x, c.y), now: T0 + 1400 });
  assert.equal(st.phase, 'hidden', 'close must not pop back under the fingertip');
  // Lower the hand, then point again: the hold re-arms.
  stepPointerGesture(st, { pointing: false, now: T0 + 1500 });
  stepPointerGesture(st, { ...point(0.5, 0.4), now: T0 + 2000 });
  assert.equal(st.phase, 'counting');
  stepPointerGesture(st, { ...point(0.5, 0.4), now: T0 + 2000 + POINTER_HOLD_MS });
  assert.equal(st.phase, 'shown');
});

test('pointerWindowRect: geometry stays on-canvas and clamps at edges', () => {
  const W = 640, H = 360;
  // Mid-canvas: box roughly centered under the fingertip.
  const mid = pointerWindowRect(0.5, 0.4, W, H);
  assert.equal(mid.actions.map(a => a.id).join(','), 'zoom-in,zoom-out,reset,close');
  assert.ok(mid.x >= 0 && mid.x + mid.w <= W, 'box inside horizontally');
  assert.ok(mid.y >= 0 && mid.y + mid.h <= H, 'box inside vertically');
  // Extreme corners clamp fully on-screen.
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const r = pointerWindowRect(x, y, W, H);
    assert.ok(r.x >= 0 && r.x + r.w <= W, `x clamp at ${x},${y}`);
    assert.ok(r.y >= 0 && r.y + r.h <= H, `y clamp at ${x},${y}`);
    for (const a of r.actions) {
      assert.ok(a.x >= r.x && a.x + a.w <= r.x + r.w + 0.001, 'cell inside box');
    }
  }
});
