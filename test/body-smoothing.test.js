// Regression test for the body-rig dropout grace. MediaPipe's Pose landmarker
// occasionally misses the body for a frame or two (occlusion, edge of frame,
// fast motion); without a grace window the arms/torso rig flickers off and on
// with every miss. The first draft of this feature was a blunt 1s TTL on the
// persistent raw mirror (which never nulls), so an expired body could silently
// resurrect and the hold had no expiry/recovery semantics to lock down.
//
// smoothBodyNow is a pure module-level function (state passed in), so the
// lifecycle is deterministic and DOM-free:
//   1. first sighting registers and renders immediately,
//   2. a miss inside the grace window keeps the rig visible (frozen),
//   3. past the grace window the rig expires and the state clears,
//   4. re-detection recovers immediately,
//   5. a fresh detection always wins over a hold (no EMA lag on the body).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { smoothBodyNow, BODY_GRACE_MS } from '../src/avatar-engine.js';

const mkBody = y => Array.from({ length: 33 }, (_, i) => ({ x: 0.1 + i * 0.02, y, z: 0.6 }));

test('smoothBodyNow holds through grace, expires, and recovers', () => {
  const state = { last: null, seenAt: 0 };
  const a = mkBody(0.8);
  const b = mkBody(0.3);

  // t=0 — first sighting must register and snap in
  let out = smoothBodyNow(0, a, state);
  assert.equal(out, a, 'first sighting returns the fresh body immediately');
  assert.equal(state.seenAt, 0);
  assert.equal(state.last, a);

  // t=40 — miss inside the grace window: rig stays visible, frozen
  out = smoothBodyNow(40, null, state);
  assert.equal(out, a, `rig must hold frozen through a 40ms miss (grace is ${BODY_GRACE_MS}ms)`);

  // t=60 — fresh detection inside the window wins instantly
  out = smoothBodyNow(60, b, state);
  assert.equal(out, b, 'fresh detection replaces the hold immediately');
  assert.equal(state.seenAt, 60);

  // past the grace window — expire and clear (nothing to resurrect later)
  out = smoothBodyNow(60 + BODY_GRACE_MS + 1, null, state);
  assert.equal(out, null, 'rig hides once the miss outlasts the grace window');
  assert.equal(state.last, null, 'expired state is cleared');

  // re-detection recovers immediately
  out = smoothBodyNow(400, a, state);
  assert.equal(out, a, 're-detection recovers immediately');
  assert.equal(state.last, a);
});

test('smoothBodyNow never shows a body before the first sighting', () => {
  const state = { last: null, seenAt: 0 };
  assert.equal(smoothBodyNow(100, null, state), null, 'no body ever seen -> nothing to hold');
  assert.equal(state.last, null);
});

test('grace window boundary is exclusive (BODY_GRACE_MS-1 holds, BODY_GRACE_MS expires)', () => {
  const state = { last: null, seenAt: 0 };
  const a = mkBody(0.5);
  smoothBodyNow(0, a, state);
  assert.equal(smoothBodyNow(BODY_GRACE_MS - 1, null, state), a, 'inside the window -> hold');
  assert.equal(smoothBodyNow(BODY_GRACE_MS, null, state), null, 'at exactly the window -> expired');
});
