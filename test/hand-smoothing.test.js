// Regression test for the hand-smoothing display path. The first implementation
// created first-sighting entries in smoothHandsNow but never registered them in
// the handEMA map — the handEMA.set(h.label, e) call was missing — so the
// display rig was ALWAYS null: the "flicker fix" disabled hand rendering
// entirely, and no test caught it because the engine loop needed a real DOM.
//
// smoothHandsNow is now a pure module-level function (handEMA passed in), so
// these four behaviors are locked in deterministically:
//   1. first sighting registers and renders,
//   2. a dropout inside the grace window keeps the rig visible (frozen),
//   3. past the grace window the rig expires,
//   4. re-detection re-registers and recovers.
// Plus the per-joint EMA easing contract (no teleporting to new detections).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { smoothHandsNow, HAND_GRACE_MS, HAND_SMOOTH_K } from '../src/avatar-engine.js';

const handPts = (cx, cy) => Array.from({ length: 21 }, (_, i) => ({ x: cx + Math.cos(i * 1.7) * 0.02, y: cy + Math.sin(i * 1.1) * 0.02, z: 0.5 }));
const HANDS = () => [
  { label: 'Right', landmarks: handPts(0.9, 0.8) },
  { label: 'Left', landmarks: handPts(0.1, 0.2) },
];

test('smoothHandsNow tracks, holds through grace, expires, and recovers', () => {
  const ema = new Map();

  // t=0 — first sighting must register (the missing handEMA.set returned null here)
  let disp = smoothHandsNow(0, HANDS(), ema);
  assert.ok(disp, 'hands must be visible on first sighting (registers in handEMA)');
  assert.equal(disp.length, 2);
  assert.equal(disp[0].label, 'Right');
  assert.equal(disp[1].label, 'Left');
  assert.equal(disp[0].landmarks.length, 21, 'all 21 joints per hand');
  assert.equal(disp[0].landmarks[5].z, 0.5, 'z passes through');

  // t=40 — dropout inside the grace window: rig stays visible, positions frozen
  disp = smoothHandsNow(40, null, ema);
  assert.ok(disp, `rig must hold through a 40ms dropout (grace is ${HAND_GRACE_MS}ms)`);
  assert.equal(disp.length, 2, 'both hands keep identity during grace');
  assert.equal(disp[0].landmarks[5].x, 0.9 + Math.cos(5 * 1.7) * 0.02, 'held pose is frozen (no extrapolation)');

  // t=260 — past the grace window: rig expires
  disp = smoothHandsNow(260, null, ema);
  assert.equal(disp, null, `rig must expire once ${HAND_GRACE_MS}ms pass without detections`);

  // t=320 — recovery re-registers through the first-sighting path again
  disp = smoothHandsNow(320, HANDS(), ema);
  assert.ok(disp, 'rig recovers when tracking resumes');
  assert.equal(disp.length, 2);
});

test('smoothHandsNow eases joints toward fresh detections instead of snapping', () => {
  const ema = new Map();
  const first = HANDS();
  smoothHandsNow(0, first, ema);
  const j0 = first[0].landmarks[5];

  const moved = HANDS();
  moved[0].landmarks[5] = { x: j0.x + 0.1, y: j0.y + 0.1, z: 0.5 };   // +10% of frame
  const disp = smoothHandsNow(16, moved, ema);
  const out = disp[0].landmarks[5];

  const expectX = j0.x + 0.1 * HAND_SMOOTH_K;
  const expectY = j0.y + 0.1 * HAND_SMOOTH_K;
  assert.ok(Math.abs(out.x - expectX) < 1e-6, `joint eased toward new x (got ${out.x}, want ~${expectX})`);
  assert.ok(Math.abs(out.y - expectY) < 1e-6, `joint eased toward new y (got ${out.y}, want ~${expectY})`);
  assert.ok(Math.abs(out.x - moved[0].landmarks[5].x) > 0.04, 'joint must not jump straight to the new detection');
});