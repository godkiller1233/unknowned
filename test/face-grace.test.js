// Regression tests for the face-pose dropout grace. MediaPipe's FaceLandmarker
// misses frames often (motion blur, occlusion) and the original step() baked
// two magic TTLs (900ms "have face", 1200ms ease-to-idle) into the render
// loop. faceGracePhase() makes that behavior an explicit, pure state machine:
//
//   'live'   - fresh detection snaps in and re-arms the windows
//   'hold'   - a miss inside FACE_LIVE_MS freezes the last pose (no flicker)
//   'easing' - a miss inside FACE_EASE_MS after that eases toward idle
//   'idle'   - gone for good: state clears so a stale pose can't resurrect
//
// A subtle trap this locks down: after expiry, state.pose must be null so a
// late 'hold' can never fire from a stale timestamp (the resurrection bug
// class the body-grace tests caught in the raw mirror).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { faceGracePhase, FACE_LIVE_MS, FACE_EASE_MS } from '../src/avatar-engine.js';

const POSE = { yaw: 12, pitch: -3, roll: 2, closeness: 1.2, noseX: 0.55, noseY: 0.4, detected: true };

test('faceGracePhase lifecycle: live, hold, easing, idle, recovery', () => {
  const state = { pose: null, seenAt: 0 };

  // t=0 — fresh detection snaps in and re-arms the windows
  assert.equal(faceGracePhase(0, POSE, state), 'live');
  assert.equal(state.pose, POSE);
  assert.equal(state.seenAt, 0);

  // t=100 — miss inside the live window: hold (frozen pose, no flicker)
  assert.equal(faceGracePhase(100, null, state), 'hold');

  // just before the live boundary: still hold (boundary is exclusive)
  assert.equal(faceGracePhase(FACE_LIVE_MS - 1, null, state), 'hold');

  // at FACE_LIVE_MS exactly: transitions to easing
  assert.equal(faceGracePhase(FACE_LIVE_MS, null, state), 'easing');

  // just before the easing boundary: still easing
  assert.equal(faceGracePhase(FACE_LIVE_MS + FACE_EASE_MS - 1, null, state), 'easing');

  // at the easing boundary: idle, and state clears (no resurrection)
  assert.equal(faceGracePhase(FACE_LIVE_MS + FACE_EASE_MS, null, state), 'idle');
  assert.equal(state.pose, null);

  // long past: still idle
  assert.equal(faceGracePhase(10 * 1000, null, state), 'idle');

  // recovery: a fresh detection is live again immediately
  assert.equal(faceGracePhase(10 * 1000 + 1, POSE, state), 'live');
  assert.equal(state.seenAt, 10 * 1000 + 1);
});

test('every fresh detection re-arms the grace windows', () => {
  const state = { pose: null, seenAt: 0 };
  faceGracePhase(0, POSE, state);
  assert.equal(faceGracePhase(50, null, state), 'hold');
  // re-detect at t=60 — windows re-arm from here
  assert.equal(faceGracePhase(60, POSE, state), 'live');
  assert.equal(faceGracePhase(60 + FACE_LIVE_MS - 1, null, state), 'hold');
  assert.equal(faceGracePhase(60 + FACE_LIVE_MS, null, state), 'easing');
  assert.equal(faceGracePhase(60 + FACE_LIVE_MS + FACE_EASE_MS, null, state), 'idle');
});

test('expired state cannot resurrect a stale hold (state.clears contract)', () => {
  const state = { pose: null, seenAt: 0 };
  faceGracePhase(0, POSE, state);
  // run out the clock
  faceGracePhase(FACE_LIVE_MS + FACE_EASE_MS + 5, null, state);
  assert.equal(state.pose, null);
  // even if seenAt were corrupted, pose===null forces idle
  assert.equal(faceGracePhase(10, null, state), 'idle');
});

test('live wins over everything the moment a detection returns', () => {
  const state = { pose: null, seenAt: 0 };
  faceGracePhase(0, POSE, state);
  // deep into easing...
  faceGracePhase(FACE_LIVE_MS + 100, null, state);
  // ...one fresh frame snaps straight back to live
  assert.equal(faceGracePhase(FACE_LIVE_MS + 101, POSE, state), 'live');
  assert.equal(state.pose, POSE);
});
