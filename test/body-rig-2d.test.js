// Locks the "one tracker, every avatar" contract: the 2D body rig must use the
// same calibrated arm math as the 3D rig (bodyRigPoints2D), and the avatar
// config must round-trip the body toggle so hands/body trackers apply
// identically to 2D, 3D and VRM avatars.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyRigPoints2D } from '../src/avatar-math.js';
import { defaultAvatarConfig, loadAvatarConfig, saveAvatarConfig } from '../src/avatar-store.js';

/** Synthetic 33-landmark Pose body (same layout as body-calibration.test.js). */
function mkBody({ sxL = 0.45, sxR = 0.55, sy = 0.4, span = 0.1,
                  wDyL = 0.3, wDyR = 0.3, wDxL = 0, wDxR = 0 } = {}) {
  const pts = new Array(33).fill(null).map(() => ({ x: 0.5, y: 0.9, z: 0 }));
  const put = (i, x, y) => { pts[i] = { x, y, z: 0 }; };
  const mid = (sxL + sxR) / 2;
  put(11, sxL, sy); put(12, sxR, sy);
  put(13, sxL, sy + wDyL * 0.6); put(14, sxR, sy + wDyR * 0.6);
  put(15, sxL + wDxL * 0.3, sy + wDyL); put(16, sxR + wDxR * 0.3, sy + wDyR);
  put(23, mid - span * 0.3, 0.8); put(24, mid + span * 0.3, 0.8);
  return pts;
}

const W = 640, H = 480;

test('bodyRigPoints2D returns null without enough landmarks', () => {
  assert.equal(bodyRigPoints2D(mkBody().slice(0, 10), null, W, H), null);
  assert.equal(bodyRigPoints2D(null, null, W, H), null);
});

test('raw fallback places joints at the tracked landmark pixels', () => {
  const b = mkBody(); // shoulders 0.45/0.55 y=0.4 -> x 288/352, y 192
  const rig = bodyRigPoints2D(b, null, W, H);
  assert.deepEqual(rig[0], { x: 288, y: 192 });            // L shoulder
  assert.deepEqual(rig[1], { x: 352, y: 192 });            // R shoulder
  assert.deepEqual(rig[4], { x: 288, y: 192 + 0.3 * 480 }); // L wrist (arm down)
  assert.deepEqual(rig[6], { x: (0.5 - 0.03) * W, y: 0.8 * H }); // L hip
});

test('calibrated arms raise to full reach above the shoulders, mirrored sides', () => {
  const cal = {
    lenL: 0.3, lenR: 0.3, torsoScale: 1,
    armL: { raise: 1, out: 0 }, armR: { raise: 1, out: 0 },
  };
  const b = mkBody(); // wrists rest at y=0.7; calibration overrides placement
  const rig = bodyRigPoints2D(b, cal, W, H);
  const shY = 192, lenPx = 0.3 * 480 * 1; // 144px
  // Arms straight overhead: wrists above shoulders by a full arm length.
  assert.ok(rig[4].y < shY - lenPx * 0.9, `L wrist y ${rig[4].y}`);
  assert.ok(rig[5].y < shY - lenPx * 0.9, `R wrist y ${rig[5].y}`);
  // Elbows sit at 55% of the raise, between shoulder and wrist.
  assert.ok(Math.abs(rig[2].y - (shY - lenPx * 0.55)) < 1e-6, `L elbow y ${rig[2].y}`);
  // Shoulders stay at their raw tracked pixels (torso follows the tracker).
  assert.deepEqual(rig[0], { x: 288, y: 192 });
});

test('calibrated lateral spread goes outward on each side', () => {
  const cal = {
    lenL: 0.3, lenR: 0.3, torsoScale: 1,
    armL: { raise: 0, out: 1 }, armR: { raise: 0, out: 1 },
  };
  const rig = bodyRigPoints2D(mkBody(), cal, W, H);
  const lenPx = 0.3 * 480; // 144px
  assert.ok(rig[4].x < rig[0].x - lenPx * 0.9, `L wrist x ${rig[4].x} (should be left of shoulder ${rig[0].x})`);
  assert.ok(rig[5].x > rig[1].x + lenPx * 0.9, `R wrist x ${rig[5].x} (should be right of shoulder ${rig[1].x})`);
});

test('torso scale stretches calibrated arm length', () => {
  const cal = {
    lenL: 0.3, lenR: 0.3, torsoScale: 1.6,
    armL: { raise: 1, out: 0 }, armR: { raise: 1, out: 0 },
  };
  const rig = bodyRigPoints2D(mkBody(), cal, W, H);
  const shY = 192, lenPx = 0.3 * 480 * 1.6; // 230.4px
  assert.ok(Math.abs(rig[4].y - (shY - lenPx)) < 1e-6, `scaled wrist y ${rig[4].y}`);
});

test('avatar config round-trips the body toggle and defaults it on', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => store.has(k) ? store.get(k) : null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  assert.equal(defaultAvatarConfig().body, true);
  assert.equal(loadAvatarConfig().body, true);          // nothing saved yet
  saveAvatarConfig({ mode: '2d', hands: false, body: false });
  const p = loadAvatarConfig();
  assert.equal(p.body, false);
  assert.equal(p.hands, false);
  assert.equal(p.mode, '2d');
  saveAvatarConfig({ mode: '3d', hands: true, body: true });
  assert.equal(loadAvatarConfig().body, true);
  delete globalThis.localStorage;
});