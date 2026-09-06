// Regression test for the landmark-scaling bug: MediaPipe Tasks returns
// normalized [0,1] landmark coordinates, but createMediaPipeTracker used to
// divide them by the video's pixel size (videoWidth/videoHeight), collapsing
// every tracked point into the top-left corner on non-square camera feeds
// (a hand at x=0.9 became 0.9/1280 ≈ 0.0007 — the rig painted a 4px box).
//
// This test feeds synthetic full-frame hand (and face/body) landmarks through
// the tracker's real detect() normalization path and asserts the engine passes
// them through unscaled. A fake @mediapipe/tasks-vision is injected via the
// engine's __setTrackerLibsForTest seam, so no wasm/GPU is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMediaPipeTracker, __setTrackerLibsForTest } from '../src/avatar-engine.js';

// A synthetic 478-point face spread across the full frame, with the eye/nose
// landmarks the avatar pose math reads pinned to sane positions.
const FACE = Array.from({ length: 478 }, (_, i) => ({ x: 0.9 - i * 0.001, y: 0.8 - i * 0.0005, z: 0 }));
FACE[33] = { x: 0.35, y: 0.4, z: 0 };   // right eye outer
FACE[263] = { x: 0.65, y: 0.4, z: 0 };  // left eye outer
FACE[1] = { x: 0.5, y: 0.52, z: 0 };    // nose tip

// Two full-frame hands: the first spans the right edge (x≈0.9) so the old
// divide-by-videoWidth bug would shove it into the corner.
const handPts = (ox, oy) => Array.from({ length: 21 }, (_, i) => ({ x: ox + Math.cos(i) * 0.02, y: oy + Math.sin(i) * 0.02, z: 0.5 }));
const HANDS = [handPts(0.9, 0.8), handPts(0.1, 0.2)];

// Fake MediaPipe Tasks module: createFromOptions returns landmarkers whose
// detectForVideo answers with normalized full-frame landmarks — the same
// contract the real models use (pixel dimensions are irrelevant to their
// output, which is exactly what the regression is about).
const tv = {
  FilesetResolver: { forVisionTasks: async () => ({}) },
  FaceLandmarker: {
    createFromOptions: async () => ({
      detectForVideo: () => ({ faceLandmarks: [FACE], faceBlendshapes: [{ categories: [{ categoryName: 'jawOpen', score: 0.3 }] }] }),
      close() {},
    }),
  },
  HandLandmarker: {
    createFromOptions: async () => ({
      detectForVideo: () => ({ landmarks: HANDS, handednesses: [[{ categoryName: 'Right' }], [{ categoryName: 'Left' }]] }),
      close() {},
    }),
  },
  PoseLandmarker: {
    createFromOptions: async () => ({
      detectForVideo: () => ({ landmarks: [FACE.slice(0, 33)] }),
      close() {},
    }),
  },
};

test('createMediaPipeTracker passes normalized landmarks through unscaled', async (t) => {
  __setTrackerLibsForTest({ tv, three: {}, GLTFLoader: {} });
  t.after(() => __setTrackerLibsForTest(null));

  // A non-square feed is exactly the case that exposed the bug (1280x720).
  const video = { videoWidth: 1280, videoHeight: 720, currentTime: 1 };
  const tracker = await createMediaPipeTracker({ video, wantHands: true, wantBody: true });
  t.after(() => tracker.dispose());

  const out = tracker.detect();
  assert.ok(out, 'detect() should return results');

  // ── hands: full-frame landmarks must arrive unscaled ──
  assert.equal(out.hands.length, 2);
  assert.equal(out.hands[0].label, 'Right');
  assert.equal(out.hands[1].label, 'Left');
  const j = HANDS[0][5];
  assert.equal(out.hands[0].landmarks[5].x, j.x, 'hand x must not be divided by videoWidth');
  assert.equal(out.hands[0].landmarks[5].y, j.y, 'hand y must not be divided by videoHeight');
  assert.equal(out.hands[0].landmarks[5].z, j.z, 'hand z must pass through');
  assert.ok(
    out.hands[0].landmarks[5].x > 0.5,
    `hand landmark near the right edge must stay right (got ${out.hands[0].landmarks[5].x})`,
  );

  // ── face: same pass-through contract (the bug hit this path too) ──
  assert.ok(out.landmarks);
  assert.equal(out.landmarks[0].x, FACE[0].x, 'face landmark x must pass through unscaled');
  assert.ok(out.landmarks[0].x > 0.5, 'face landmark must not collapse into the top-left corner');
  assert.equal(out.landmarks[33].x, 0.35);
  assert.equal(out.landmarks[1].y, 0.52);

  // ── body: 33 normalized landmarks, same contract ──
  assert.equal(out.body[2].x, FACE[2].x);
});