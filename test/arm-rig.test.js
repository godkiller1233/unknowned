// Tests for the 3D arm rig chain: classification of arm bones, the raw
// (uncalibrated) body pose fallback, and the arm target vector the rig
// driver rotates bones toward. Together they lock the contract that makes
// a VRM's own arm bones follow tracked body motion — the bug this guards
// is silent: arm bones that fail classification simply never move.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyRigBone, rawBodyPose, armTargetVec, armChainTargets, elbowBend, applyBodyCalibration } from '../src/avatar-math.js';

test('classifyRigBone: arm chains in separated, VRM-chain, fused and namespaced spellings', () => {
  // VRM (J_Bip) chains
  assert.deepEqual(classifyRigBone('J_Bip_L_UpperArm'), { role: 'arm', side: 'L', part: 'upper' });
  assert.deepEqual(classifyRigBone('J_Bip_R_LowerArm'), { role: 'arm', side: 'R', part: 'lower' });
  assert.deepEqual(classifyRigBone('J_Bip_L_Shoulder'), { role: 'arm', side: 'L', part: 'shoulder' });
  assert.deepEqual(classifyRigBone('J_Bip_L_Hand'), { role: 'arm', side: 'L', part: 'hand' });
  // Mixamo namespaces + fused spellings
  assert.deepEqual(classifyRigBone('mixamorig:LeftArm'), { role: 'arm', side: 'L', part: 'upper' });
  assert.deepEqual(classifyRigBone('mixamorig:RightForeArm'), { role: 'arm', side: 'R', part: 'lower' });
  assert.deepEqual(classifyRigBone('LeftForeArm'), { role: 'arm', side: 'L', part: 'lower' });
  assert.deepEqual(classifyRigBone('RightHand'), { role: 'arm', side: 'R', part: 'hand' });
});

test('classifyRigBone: finger phalanges still win over the arm/hand rules', () => {
  // 'RightHandMiddle3' contains the 'hand' token but is a finger phalange.
  assert.deepEqual(classifyRigBone('RightHandMiddle3'), { role: 'finger', side: 'R', finger: 'middle', ph: 3 });
  assert.deepEqual(classifyRigBone('LeftHandRing1'), { role: 'finger', side: 'L', finger: 'ring', ph: 1 });
  assert.deepEqual(classifyRigBone('Thumb_R_1'), { role: 'finger', side: 'R', finger: 'thumb', ph: 1 });
});

test('classifyRigBone: arm-like accessory names stay null (no false positives)', () => {
  assert.equal(classifyRigBone('armband'), null);
  assert.equal(classifyRigBone('handcuffs'), null);
  assert.equal(classifyRigBone('armor'), null);
  assert.equal(classifyRigBone('alarm'), null);
  assert.equal(classifyRigBone('J_Sec_ArmBand_01'), null);   // VRoid physics bone stays a hair-class bone
});

test('rawBodyPose: rest, T-pose and overhead map to the calibrated 0..1 semantics', () => {
  // Unmirrored camera: the wearer's LEFT shoulder (landmark 11) is image-right.
  const body = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  body[11] = { x: 0.6, y: 0.35, z: 0 };
  body[12] = { x: 0.4, y: 0.35, z: 0 };

  // Arms hanging: wrists below shoulders, near the body.
  body[15] = { x: 0.58, y: 0.75, z: 0 };
  body[16] = { x: 0.42, y: 0.75, z: 0 };
  const rest = rawBodyPose(body);
  assert.equal(rest.armL.raise < 0.1, true, 'hanging wrists must map to raise ~0');
  assert.equal(rest.armR.raise < 0.1, true);
  assert.equal(rest.armL.out < 0.15, true, 'arms at the sides must map to out ~0');
  assert.equal(rest.armR.out < 0.15, true);

  // T-pose: wrists at shoulder height, fully spread.
  body[15] = { x: 0.95, y: 0.35, z: 0 };
  body[16] = { x: 0.05, y: 0.35, z: 0 };
  const tp = rawBodyPose(body);
  assert.equal(tp.armL.out > 0.9, true, 'full spread must map to out ~1');
  assert.equal(tp.armR.out > 0.9, true);
  assert.ok(Math.abs(tp.armL.raise - 0.5) < 0.05, 'wrist at shoulder height maps to raise ~0.5');

  // Overhead: wrists above shoulders.
  body[15] = { x: 0.62, y: 0.05, z: 0 };
  body[16] = { x: 0.38, y: 0.05, z: 0 };
  const up = rawBodyPose(body);
  assert.equal(up.armL.raise > 0.9, true, 'overhead wrists must map to raise ~1');
  assert.equal(up.armR.raise > 0.9, true);
});

test('rawBodyPose: null/degenerate input returns null, no throw', () => {
  assert.equal(rawBodyPose(null), null);
  assert.equal(rawBodyPose([]), null);
  assert.equal(rawBodyPose(Array.from({ length: 10 }, () => ({ x: 0.5, y: 0.5 }))), null);
});

test('armTargetVec: rest hangs down, T-pose aims outward per side, overhead aims up', () => {
  const body = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  body[11] = { x: 0.6, y: 0.35, z: 0 };
  body[12] = { x: 0.4, y: 0.35, z: 0 };

  body[15] = { x: 0.95, y: 0.35, z: 0 };  // left arm out wide
  body[16] = { x: 0.42, y: 0.75, z: 0 };  // right arm hanging
  const tp = rawBodyPose(body);
  const l = armTargetVec(tp, 'L');
  const r = armTargetVec(tp, 'R');
  // Real unmirrored frames: the wearer's LEFT wrist T-poses at image-RIGHT
  // (x 0.95 in the fixture above), so the tracked-left target aims +x — the
  // same canvas side the facing model's own L bones occupy.
  assert.ok(l.x > 0.9 && Math.abs(l.y) < 0.45, `tracked-left target aims canvas-right (got ${l.x.toFixed(2)},${l.y.toFixed(2)})`);
  assert.ok(Math.abs(r.x) < 0.2 && r.y < -0.9, `hanging right target aims down (got ${r.x.toFixed(2)},${r.y.toFixed(2)})`);

  body[15] = { x: 0.62, y: 0.05, z: 0 };
  body[16] = { x: 0.38, y: 0.05, z: 0 };
  const up = armTargetVec(rawBodyPose(body), 'L');
  assert.ok(up.y > 0.9, `overhead target aims up (got ${up.y.toFixed(2)})`);

  // Degenerate pose falls back to "rest" instead of NaN.
  const dead = armTargetVec(null, 'L');
  assert.ok(Number.isFinite(dead.x) && Number.isFinite(dead.y));
  assert.ok(Math.abs(dead.y) + Math.abs(dead.x) > 0.5, 'degenerate input still yields a unit-ish direction');
});

test('calibrated raise is monotonic in wrist height and both paths read clearly raised at the top', () => {
  // Calibrated raise normalizes by the captured per-user range, raw raise by
  // shoulder span — they agree in DIRECTION (monotonic, up = higher), not in
  // absolute value; matching the user's true captured range is exactly what
  // the calibration wizard is for.
  const body = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  body[11] = { x: 0.6, y: 0.35, z: 0 };
  body[12] = { x: 0.4, y: 0.35, z: 0 };
  const cal = {
    body: {
      midX: 0.5, midY: 0.5, shoulderSpan: 0.2, armLenL: 0.35, armLenR: 0.35,
      armRange: { l: { dy: { min: -1.6, max: 1.6 }, dx: { min: -0.6, max: 1.6 } }, r: { dy: { min: -1.6, max: 1.6 }, dx: { min: -1.6, max: 0.6 } } },
    },
  };
  const raises = [];
  for (const wrY of [0.75, 0.35, 0.05]) {   // hanging -> horizontal -> overhead
    body[15] = { x: 0.62, y: wrY, z: 0 };
    body[16] = { x: 0.38, y: wrY, z: 0 };
    const c = applyBodyCalibration(body, cal);
    const r = rawBodyPose(body);
    raises.push({ c: c.armL.raise, r: r.armL.raise });
  }
  assert.ok(raises[0].c < raises[1].c && raises[1].c < raises[2].c,
    `calibrated raise rises with wrist height (got ${raises.map(x => x.c.toFixed(2)).join(' < ')})`);
  assert.ok(raises[0].r < raises[1].r && raises[1].r < raises[2].r,
    `raw raise rises with wrist height (got ${raises.map(x => x.r.toFixed(2)).join(' < ')})`);
  assert.ok(raises[2].c > 0.5, `calibrated overhead is clearly raised (got ${raises[2].c.toFixed(2)})`);
  assert.ok(raises[2].r > 0.9, `raw overhead is clearly raised (got ${raises[2].r.toFixed(2)})`);
});

test('elbowBend: straight arm ~0, right angle ~mid, folded ~1, degenerate -> 0', () => {
  // Straight: shoulder->elbow and elbow->wrist collinear.
  const sh = { x: 0.5, y: 0.5 }, el = { x: 0.6, y: 0.5 }, wr = { x: 0.7, y: 0.5 };
  assert.ok(elbowBend(sh, el, wr) < 0.05, `straight ${elbowBend(sh, el, wr)}`);
  // 90-degree interior angle -> theta = pi/2 -> bend = (pi - pi/2)/(pi - 0.5) ≈ 0.65.
  const b90 = elbowBend(sh, { x: 0.6, y: 0.5 }, { x: 0.6, y: 0.4 });
  assert.ok(b90 > 0.55 && b90 < 0.75, `90deg ${b90}`);
  // Fully folded (elbow back on the shoulder side, wrist near elbow).
  const folded = elbowBend(sh, { x: 0.4, y: 0.5 }, { x: 0.42, y: 0.5 });
  assert.ok(folded > 0.9, `folded ${folded}`);
  assert.equal(elbowBend(null, el, wr), 0);
  assert.equal(elbowBend(sh, { x: sh.x, y: sh.y }, wr), 0);   // zero-length upper
});

test('armChainTargets: wrist stays on the chord, elbow bows outward, straight degenerates to chord', () => {
  // Left arm hanging with a 90-degree-ish bend: upper aims down-out, lower aims in-up.
  const arm = { raise: 0.25, out: 0.1, bend: 0.65 };
  const { upper, lower } = armChainTargets(arm, 'L');
  // Straight arm: both segments degenerate to the chord (old behavior).
  const straight = armChainTargets({ raise: 0.5, out: 1, bend: 0 }, 'L');
  assert.ok(Math.abs(straight.upper.x - straight.lower.x) < 1e-9 && Math.abs(straight.upper.y - straight.lower.y) < 1e-9,
    'bend 0 must equal the shared chord target');
  // Both unit-length.
  for (const v of [upper, lower]) assert.ok(Math.abs(Math.hypot(v.x, v.y) - 1) < 1e-9, `unit (${v.x},${v.y})`);
  // Outward bow: the upper segment's component along the outward perpendicular
  // (+x side for L) is positive, the lower's negative — the elbow bows out.
  const chord = armTargetVec({ armL: arm }, 'L');
  const px = -chord.y, py = chord.x;              // outward perpendicular for L
  const alongP = v => v.x * px + v.y * py;
  assert.ok(alongP(upper) > 0.2 && alongP(lower) < -0.2,
    `left elbow bows outward (upper·p ${alongP(upper).toFixed(3)}, lower·p ${alongP(lower).toFixed(3)})`);
  // Right side mirrors: bows -x.
  const armR = { raise: 0.25, out: 0.1, bend: 0.65 };
  const { upper: uR, lower: lR } = armChainTargets(armR, 'R');
  const chordR = armTargetVec({ armR: armR }, 'R');
  const pxR = chordR.y, pyR = -chordR.x;          // outward for R mirrors L's perpendicular
  const alongPR = v => v.x * pxR + v.y * pyR;
  assert.ok(alongPR(uR) > 0.2 && alongPR(lR) < -0.2, 'right elbow bows outward too');
  // The off-chord components cancel EXACTLY: (upper+lower) is parallel to the
  // chord (cross product zero). The chord component shrinks by cos(half) per
  // segment — physically correct, a bent arm's wrist sits closer to the
  // shoulder than a straight one's.
  const cross = (upper.x + lower.x) * chord.y - (upper.y + lower.y) * chord.x;
  assert.ok(Math.abs(cross) < 1e-9, `upper+lower parallel to chord (cross ${cross.toExponential(2)})`);
  // Degenerate arm pose still finite.
  const dead = armChainTargets(null, 'L');
  assert.ok(Number.isFinite(dead.upper.x) && Number.isFinite(dead.lower.y));
});

test('calibrated and raw arm poses carry the tracked bend', () => {
  // Bent left arm: shoulder (0.6,0.35), elbow out-down, wrist folded back in.
  const body = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  body[11] = { x: 0.6, y: 0.35, z: 0 };   // L shoulder (image-right on unmirrored)
  body[12] = { x: 0.4, y: 0.35, z: 0 };
  body[13] = { x: 0.72, y: 0.5, z: 0 };   // L elbow out and down
  body[14] = { x: 0.28, y: 0.75, z: 0 };
  body[15] = { x: 0.66, y: 0.62, z: 0 };  // L wrist folded back toward the body
  body[16] = { x: 0.34, y: 0.75, z: 0 };
  const raw = rawBodyPose(body);
  assert.ok(raw.armL.bend > 0.3, `raw bend ${raw.armL.bend}`);
  const cal = { body: { midX: 0.5, midY: 0.5, shoulderSpan: 0.2, armLenL: 0.25, armLenR: 0.25 } };
  const c = applyBodyCalibration(body, cal);
  assert.ok(c.armL.bend > 0.3, `calibrated bend ${c.armL.bend}`);
  // Straight arm -> bend ~0 in both paths.
  body[13] = { x: 0.66, y: 0.5, z: 0 };
  body[15] = { x: 0.72, y: 0.65, z: 0 };
  assert.ok(rawBodyPose(body).armL.bend < 0.1, 'straight arm maps to bend ~0');
});

test('smoothBend: first frame snaps, jitter is damped, slew caps real snaps', async () => {
  const { smoothBend, BEND_SLEW_PER_SEC, BEND_GAP_RESNAP_MS } = await import('../src/avatar-math.js');
  const st = { v: null, at: 0 };
  // First observation snaps instantly (no easing from a made-up zero).
  assert.equal(smoothBend(0.8, st, 1000), 0.8);
  // Tiny jitter (one noisy frame flips the value) barely moves the output.
  const jitter = smoothBend(0.0, st, 1033);   // 33ms later, raw snaps to 0
  assert.ok(jitter > 0.5, `one noisy frame must not snap the rig (got ${jitter})`);
  // Sustained target: value converges over time (EMA + slew both finite).
  let t = 1033, v = jitter;
  for (let i = 0; i < 60; i++) { t += 33; v = smoothBend(0.0, st, t); }
  assert.ok(v < 0.05, `sustained straight arm converges (got ${v})`);
  // A real snap is capped: max movement per second is BEND_SLEW_PER_SEC.
  const st2 = { v: 0, at: 0 };
  smoothBend(0, st2, 0);
  const stepped = smoothBend(1, st2, 100);    // 100ms -> max 0.3 of travel
  assert.ok(Math.abs(stepped - 0.3) < 1e-9, `slew cap 100ms -> 0.3 (got ${stepped})`);
  // Frame-rate independence: two 50ms steps equal one 100ms step (slew stage).
  const stA = { v: 0, at: 0 }, stB = { v: 0, at: 0 };
  smoothBend(0, stA, 0); smoothBend(1, stA, 50); smoothBend(1, stA, 100);
  smoothBend(0, stB, 0); smoothBend(1, stB, 100);
  assert.ok(Math.abs(stA.v - stB.v) < 0.02, `frame-rate independence (${stA.v} vs ${stB.v})`);
  // A gap longer than BEND_GAP_RESNAP_MS re-snaps (no easing across a dropout).
  const st3 = { v: 0.9, at: 0 };
  smoothBend(0.9, st3, 0);
  assert.equal(smoothBend(0.1, st3, BEND_GAP_RESNAP_MS + 50), 0.1);
  // Negative/NaN raw clamps to 0..1 and never produces NaN state.
  const st4 = { v: 0.5, at: 0 };
  smoothBend(0.5, st4, 0);
  const bad = smoothBend(NaN, st4, 33);
  assert.ok(Number.isFinite(bad) && bad >= 0 && bad <= 1);
});
