// Unit tests for the body-calibration math behind the wizard's new
// "Stand up straight" and "Sweep your arms" stages. MediaPipe Pose landmark
// slots: 11/12 shoulders, 13/14 elbows, 15/16 wrists, 23/24 hips (normalized
// coordinates). These tests lock the contract between what the wizard saves
// (cal.body) and what the engine consumes (applyBodyCalibration) so a neutral
// capture + arm sweep maps the user's real reach onto the full avatar range.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyMetrics, applyBodyCalibration, clamp } from '../src/avatar-math.js';

/** Build a synthetic 33-landmark Pose body. Offsets are in normalized units. */
function mkBody({ sxL, sxR, sy = 0.4, span = 0.1,
                  wDyL = 0.3, wDyR = 0.3, wDxL = 0, wDxR = 0 } = {}) {
  // Shoulders default to centered with the given span so `span: 0.2` really
  // widens the torso; explicit sxL/sxR still override (offset test).
  if (sxL === undefined) sxL = 0.5 - span / 2;
  if (sxR === undefined) sxR = 0.5 + span / 2;
  const pts = new Array(33).fill(null).map(() => ({ x: 0.5, y: 0.9, z: 0 }));
  const put = (i, x, y) => { pts[i] = { x, y, z: 0 }; };
  const mid = (sxL + sxR) / 2;
  put(11, sxL, sy); put(12, sxR, sy);                 // shoulders
  put(13, sxL, sy + wDyL * 0.6); put(14, sxR, sy + wDyR * 0.6); // elbows
  // Wrist x-offset is in arm-length units (0.3 = the default neutral arm
  // length), so dx = (wr.x - sh.x) / armLen comes out exactly as requested.
  put(15, sxL + wDxL * 0.3, sy + wDyL); put(16, sxR + wDxR * 0.3, sy + wDyR); // wrists
  put(23, mid - span * 0.3, 0.8); put(24, mid + span * 0.3, 0.8);  // hips
  return pts;
}

/** The neutral body the wizard would save from a standing capture. */
function neutralCal() {
  const b = mkBody(); // shoulders 0.45/0.55 y=0.4, wrists 0.7 -> armLen 0.3
  const m = bodyMetrics(b);
  return {
    midX: m.midX, midY: m.midY,
    shoulderSpan: m.shoulderSpan,
    armLenL: m.armLenL, armLenR: m.armLenR,
  };
}

test('bodyMetrics measures the neutral body the wizard saves', () => {
  const m = bodyMetrics(mkBody());
  assert.ok(Math.abs(m.midX - 0.5) < 1e-9);
  assert.ok(Math.abs(m.midY - 0.4) < 1e-9);
  assert.ok(Math.abs(m.shoulderSpan - 0.1) < 1e-9);
  assert.ok(Math.abs(m.armLenL - 0.3) < 1e-9);
  assert.ok(Math.abs(m.armLenR - 0.3) < 1e-9);
  // Too few landmarks -> null (the engine guard needs >= 25).
  assert.equal(bodyMetrics(mkBody().slice(0, 12)), null);
});

test('applyBodyCalibration returns null without a body calibration', () => {
  assert.equal(applyBodyCalibration(mkBody(), null), null);
  assert.equal(applyBodyCalibration(mkBody(), { pose: {}, channels: {} }), null);
  assert.equal(applyBodyCalibration(mkBody().slice(0, 10), { body: neutralCal() }), null);
});

test('calibrated arm raise maps real reach onto the full avatar range', () => {
  const cal = { body: { ...neutralCal(), armRange: {
    l: { dy: { min: -1.2, max: 1.0 }, dx: { min: -1.4, max: 0.2 } },
    r: { dy: { min: -1.2, max: 1.0 }, dx: { min: -0.2, max: 1.4 } },
  } } };

  // Arms relaxed at the sides: wrist level with the neutral capture -> raise ~0.
  const rest = applyBodyCalibration(mkBody(), cal);
  assert.ok(rest.armL.raise < 0.15, `rest raise ${rest.armL.raise}`);
  assert.ok(rest.armR.raise < 0.15, `rest raise ${rest.armR.raise}`);

  // Arms straight overhead (wrist above shoulder beyond the captured max) -> raise 1.
  const up = applyBodyCalibration(mkBody({ wDyL: -0.3, wDyR: -0.3 }), cal);
  assert.ok(up.armL.raise > 0.9, `up raise ${up.armL.raise}`);
  assert.ok(up.armR.raise > 0.9, `up raise ${up.armR.raise}`);

  // Half raise -> somewhere in between (monotonic, not teleported).
  const half = applyBodyCalibration(mkBody({ wDyL: 0.15, wDyR: 0.15 }), cal);
  assert.ok(half.armL.raise > rest.armL.raise && half.armL.raise < up.armL.raise, `half ${half.armL.raise}`);

  // Lateral spread: left wrist reaches image-left, right wrist image-right.
  const wide = applyBodyCalibration(mkBody({ wDxL: -1.4, wDxR: 1.4 }), cal);
  assert.ok(wide.armL.out < 0.1, `left out ${wide.armL.out}`);
  assert.ok(wide.armR.out > 0.9, `right out ${wide.armR.out}`);
});

test('no armRange falls back to the full reach assumption', () => {
  const cal = { body: neutralCal() }; // wizard saved body but no sweep yet
  const rest = applyBodyCalibration(mkBody(), cal);
  const up = applyBodyCalibration(mkBody({ wDyL: -0.3, wDyR: -0.3 }), cal);
  // Fallback is (v + 1) / 2: down = 0, overhead > 0.5, monotonic.
  assert.ok(Math.abs(rest.armL.raise) < 0.05);
  assert.ok(up.armL.raise > 0.5 && up.armL.raise <= 1);
  assert.ok(up.armL.raise > rest.armL.raise);
});

test('torso scale and lean respond to camera distance and offset', () => {
  const cal = { body: neutralCal() };
  // User steps closer: shoulder span doubles -> torsoScale clamps at 1.6.
  const close = applyBodyCalibration(mkBody({ span: 0.2 }), cal);
  assert.equal(clamp(close.torsoScale, 0, 1.6), 1.6);
  // User shifts right: midX 0.6 -> positive lean, midX recentered.
  const right = applyBodyCalibration(mkBody({ sxL: 0.55, sxR: 0.65 }), cal);
  assert.ok(right.lean > 0.2, `lean ${right.lean}`);
  assert.ok(right.midX > 0.55 && right.midX < 0.65, `midX ${right.midX}`);
});