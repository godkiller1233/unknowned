// Unit tests for src/avatar-math.js — the pure pose/morph math behind the
// avatar virtual camera. No DOM, no WebGL: synthetic landmarks and blendshape
// lists lock the mapping between tracker output, GLB morph-target names and
// the renderer's canonical channels.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blendValues, faceChannels, classifyMorphName, morphTargetChannels,
  poseFromFace, composePose, idlePose, clamp,
  calibrateBlends, applyPoseCalibration,
  classifyRigBone, eyeLookFromChannels,
} from '../src/avatar-math.js';

test('clamp', () => {
  assert.equal(clamp(-1), 0);
  assert.equal(clamp(2), 1);
  assert.equal(clamp(0.5), 0.5);
  assert.equal(clamp(7, 0, 10), 7);
});

test('classifyMorphName understands common exporter conventions', () => {
  const expect = (name, cats) => {
    const got = morphTargetChannels(name);
    assert.deepEqual(got ? got.slice().sort() : null, cats ? cats.slice().sort() : null, name);
  };
  // ARKit / MediaPipe spelling
  expect('eyeBlinkLeft', ['eyeBlinkL']);
  expect('eyeBlinkRight', ['eyeBlinkR']);
  expect('jawOpen', ['jawOpen']);
  expect('mouthSmileLeft', ['mouthSmileL']);
  expect('mouthSmileRight', ['mouthSmileR']);
  expect('browDownLeft', ['browDownL']);
  // VRoid / VRM style
  expect('blink_l', ['eyeBlinkL']);   // unambiguous left
  expect('blink_r', ['eyeBlinkR']);   // unambiguous right
  expect('blink', ['eyeBlinkL', 'eyeBlinkR']); // no side → both
  expect('Aあ', ['jawOpen']);                    // VRM viseme A
  expect('Iい', ['mouthSmileL', 'mouthSmileR']); // VRM viseme I (smile)
  expect('Eえ', ['mouthSmileL', 'mouthSmileR']); // VRM viseme E
  expect('Oお', ['mouthPucker', 'mouthFunnel']);
  expect('Uう', ['mouthPucker', 'mouthFunnel']);
  // Mixamo / generic
  expect('MouthSmile_L', ['mouthSmileL']);
  expect('JawOpen_', ['jawOpen']);
  expect('eyeBlinkLeft_inner', ['eyeBlinkL']);
  expect('viseme_aa', ['jawOpen']);
  expect('Viseme_O', ['mouthPucker', 'mouthFunnel']);
  expect('browInnerUp', ['browInnerUp']);
  // Unknown names must not map to anything (left idle, never misapplied)
  expect('random_custom_thing', null);
  expect('', null);
  expect('DOGU_0', null);
});

test('blendValues maps MediaPipe ARKit categories to canonical channels', () => {
  const cats = [
    { categoryName: 'browDownLeft', score: 0.9 },
    { categoryName: 'browDownRight', score: 0.1 },
    { categoryName: 'eyeBlinkRight', score: 0.8 },
    { categoryName: 'jawOpen', score: 0.5 },
    { categoryName: 'mouthSmileLeft', score: 0.6 },
    { categoryName: 'mouthPucker', score: 0.3 },
  ];
  const b = blendValues(cats);
  assert.equal(b.browDownL, 0.9);
  assert.equal(b.browDownR, 0.1);
  assert.equal(b.eyeBlinkR, 0.8);
  assert.equal(b.jawOpen, 0.5);
  assert.equal(b.mouthSmileL, 0.6);
  assert.equal(b.mouthPucker, 0.3);
  // Unknown category names are ignored instead of throwing
  assert.equal(blendValues([{ categoryName: 'bogus_thing', score: 1 }]).bogus_thing, undefined);
});

test('blendValues also accepts already-keyed channel maps (custom trackers, wizard samples)', () => {
  const b = blendValues({ eyeBlinkRight: 0.8, jawOpen: 0.5, mouthSmileLeft: 0.6, bogusThing: 0.9 });
  assert.equal(b.eyeBlinkR, 0.8);
  assert.equal(b.jawOpen, 0.5);
  assert.equal(b.mouthSmileL, 0.6);
  assert.equal(b.bogusThing, 0.9); // keyed maps are trusted: unknown keys pass through clamped
  assert.deepEqual(blendValues(null), {});
  assert.deepEqual(blendValues(undefined), {});
});

test('faceChannels folds channels into renderer-friendly fields', () => {
  const ch = faceChannels({ eyeBlinkL: 0.9, eyeSquintL: 0.2, eyeBlinkR: 0.7, mouthSmileL: 0.4, mouthSmileR: 0.5, jawOpen: 0.6, mouthPucker: 0.4 });
  assert.equal(ch.blinkL, 0.9);
  assert.equal(ch.blinkR, 0.7);
  assert.equal(ch.blink, 0.9);
  assert.equal(ch.smile, 0.5);
  assert.ok(ch.mouth >= 0.6);
});

function neutralLandmarks() {
  const lm = [];
  for (let i = 0; i < 468; i++) lm.push({ x: 0.5, y: 0.5 });
  // Symmetric frontal face: eye line at y .4 with span .13 (closeness 1),
  // nose tip 44% down the eye→chin span, chin at .75.
  lm[33] = { x: 0.435, y: 0.4 };
  lm[263] = { x: 0.565, y: 0.4 };
  lm[133] = { x: 0.46, y: 0.405 };
  lm[362] = { x: 0.54, y: 0.405 };
  lm[1] = { x: 0.5, y: 0.56 };
  lm[152] = { x: 0.5, y: 0.75 };
  lm[10] = { x: 0.5, y: 0.12 };
  lm[234] = { x: 0.3, y: 0.5 };
  lm[454] = { x: 0.7, y: 0.5 };
  return lm;
}

test('poseFromFace: neutral face gives near-zero yaw/pitch and closeness 1', () => {
  const p = poseFromFace(neutralLandmarks());
  assert.ok(p, 'pose required');
  assert.ok(Math.abs(p.yaw) < 1.5, 'yaw ~0 got ' + p.yaw);
  assert.ok(Math.abs(p.pitch) < 8, 'pitch ~0 got ' + p.pitch);
  assert.ok(Math.abs(p.closeness - 1) < 0.06, 'closeness ~1 got ' + p.closeness);
  assert.ok(Math.abs(p.roll) < 1, 'roll ~0 got ' + p.roll);
  assert.ok(p.detected);
});

test('poseFromFace: turning the head moves yaw monotonically', () => {
  const lm = neutralLandmarks();
  const base = poseFromFace(lm).yaw;
  lm[1] = { x: 0.47, y: 0.56 }; // nose drifts left in frame
  const left = poseFromFace(lm).yaw;
  lm[1] = { x: 0.53, y: 0.56 }; // nose drifts right
  const right = poseFromFace(lm).yaw;
  assert.ok(left < base - 1, 'nose-left yaw should be negative, got ' + left);
  assert.ok(right > base + 1, 'nose-right yaw should be positive, got ' + right);
});

test('poseFromFace: leaning closer raises closeness (eye span proxy)', () => {
  const lm = neutralLandmarks();
  const far = poseFromFace(lm);
  lm[33] = { x: 0.4, y: 0.4 };
  lm[263] = { x: 0.6, y: 0.4 };
  const near = poseFromFace(lm);
  assert.ok(near.closeness > far.closeness + 0.2);
  assert.ok(near.closeness <= 1.9);
  assert.ok(far.closeness >= 0.5);
});

test('poseFromFace: head roll equals the eye-line angle', () => {
  const lm = neutralLandmarks();
  lm[33] = { x: 0.44, y: 0.41 };
  lm[263] = { x: 0.56, y: 0.39 };
  const p = poseFromFace(lm);
  assert.ok(Math.abs(p.roll - (-9.46)) < 0.7, 'roll ' + p.roll);
});

test('poseFromFace rejects malformed landmark arrays', () => {
  assert.equal(poseFromFace(null), null);
  assert.equal(poseFromFace([{ x: 0, y: 0 }]), null);
  const flat = neutralLandmarks().map(p => ({ x: 0.5, y: 0.5 }));
  assert.equal(poseFromFace(flat), null); // zero eye span
});

test('composePose folds tracking + blends + talking into one renderer pose', () => {
  const p = poseFromFace(neutralLandmarks());
  const blends = blendValues([{ categoryName: 'jawOpen', score: 0.8 }, { categoryName: 'eyeBlinkLeft', score: 0.9 }]);
  const out = composePose(p, blends, 0.9, true);
  assert.ok(out.mouth >= 0.8, 'mouth from blends, got ' + out.mouth);
  assert.ok(out.blink >= 0.9, 'blink from blends, got ' + out.blink);
  assert.ok(out.talking);
  assert.ok(out.detected);
  // Talking without a face still drives the mouth (avatar chatters along mic)
  const idle = composePose(null, {}, 0.8, false);
  assert.ok(idle.mouth > 0.5, 'fallback talking mouth, got ' + idle.mouth);
  assert.ok(!idle.detected);
});

test('idlePose is smooth, bounded and deterministic-ish (no NaN)', () => {
  for (const t of [0, 500, 2500, 6400, 10000, 1e9]) {
    const p = idlePose(t);
    for (const k of ['yaw', 'pitch', 'roll']) {
      assert.ok(Number.isFinite(p[k]), k + ' at ' + t);
      assert.ok(Math.abs(p[k]) < 30, k + ' bounded at ' + t);
    }
    assert.ok(p.blink >= 0 && p.blink <= 1);
    assert.equal(p.detected, false);
  }
  // A blink fires at least once every 7 seconds of simulated time
  let sawBlink = false;
  for (let t = 0; t < 7000; t += 250) if (idlePose(t).blink > 0.5) { sawBlink = true; break; }
  assert.ok(sawBlink, 'idle driver blinks');
});

test('applyMorphWeight pushes external weights into canonical channels', async () => {
  const { applyMorphWeight } = await import('../src/avatar-math.js');
  const ch = {};
  applyMorphWeight(ch, 'eyeBlinkLeft', 0.7);
  assert.equal(ch.eyeBlinkL, 0.7);
  assert.equal(ch.eyeBlinkR, undefined);
  applyMorphWeight(ch, 'Blink', 0.9);
  assert.equal(ch.eyeBlinkL, 0.9);
  assert.equal(ch.eyeBlinkR, 0.9);
  applyMorphWeight(ch, 'viseme_aa', 0.5);
  assert.equal(ch.jawOpen, 0.5);
});

// ---------------------------------------------------------------------------
// Per-user calibration
// ---------------------------------------------------------------------------
test("calibrateBlends stretches live values across the user's own range", () => {
  const cal = { channels: { eyeBlinkL: { min: 0.1, max: 0.9 }, jawOpen: { min: 0.05, max: 0.7 } } };
  // Resting values land near 0 …
  assert.ok(Math.abs(calibrateBlends({ eyeBlinkL: 0.1, jawOpen: 0.05 }, cal).eyeBlinkL) < 1e-9);
  // … peaks land near 1 …
  assert.ok(calibrateBlends({ eyeBlinkL: 0.9, jawOpen: 0.7 }, cal).jawOpen > 0.999);
  // … mid values scale linearly.
  assert.ok(Math.abs(calibrateBlends({ eyeBlinkL: 0.5 }, cal).eyeBlinkL - 0.5) < 1e-9);
});

test('calibrateBlends clamps and never over-drives an out-of-range value', () => {
  const cal = { channels: { mouthSmileL: { min: 0.2, max: 0.8 } } };
  const out = calibrateBlends({ mouthSmileL: 1.0 }, cal);
  assert.equal(out.mouthSmileL, 1);
  const below = calibrateBlends({ mouthSmileL: 0.0 }, cal);
  assert.equal(below.mouthSmileL, 0);
});

test('calibrateBlends leaves a channel untouched when the captured range is flat', () => {
  const cal = { channels: { eyeBlinkL: { min: 0.5, max: 0.51 } } }; // user never blinked
  const out = calibrateBlends({ eyeBlinkL: 0.505 }, cal);
  assert.equal(out.eyeBlinkL, 0.505);
});

test('calibrateBlends with no calibration is a transparent passthrough', () => {
  const raw = { eyeBlinkL: 0.3, jawOpen: 0.6 };
  assert.deepEqual(calibrateBlends(raw, null), raw);
  assert.deepEqual(calibrateBlends(raw, { channels: {} }), raw);
});

test('applyPoseCalibration zeroes the neutral head hold', () => {
  const cal = { pose: { yaw: 8, pitch: -4, roll: 2, noseX: 0.56, noseY: 0.47 } };
  const neutral = applyPoseCalibration({ yaw: 8, pitch: -4, roll: 2, noseX: 0.56, noseY: 0.47, closeness: 1 }, cal);
  assert.ok(Math.abs(neutral.yaw) < 1e-9 && Math.abs(neutral.pitch) < 1e-9 && Math.abs(neutral.roll) < 1e-9);
  assert.ok(Math.abs(neutral.noseX - 0.5) < 1e-9 && Math.abs(neutral.noseY - 0.5) < 1e-9);
  assert.equal(neutral.closeness, 1);
});

test('applyPoseCalibration preserves movement around the calibrated hold', () => {
  const cal = { pose: { yaw: 6, pitch: 0, roll: 0, noseX: 0.5, noseY: 0.5 } };
  const out = applyPoseCalibration({ yaw: 18, pitch: 0, roll: 0, noseX: 0.62, noseY: 0.5 }, cal);
  assert.ok(Math.abs(out.yaw - 12) < 1e-9);
  assert.ok(Math.abs(out.noseX - 0.62) < 1e-9); // nose offset unchanged when neutral was centered
});

test('applyPoseCalibration tolerates a missing calibration', () => {
  const pose = { yaw: 3, pitch: 1, roll: 0, noseX: 0.5, noseY: 0.5 };
  assert.equal(applyPoseCalibration(pose, null), pose);
});

// ---- Rig bone classification (bone-driven VRM/VRMA/Mixamo/FBX motion) ----

test('classifyRigBone finds VRM humanoid joints', () => {
  assert.deepEqual(classifyRigBone('J_Bip_C_Head'), { role: 'head' });
  assert.deepEqual(classifyRigBone('J_Bip_C_Neck'), { role: 'neck' });
  assert.deepEqual(classifyRigBone('J_Bip_L_Eye'), { role: 'eye', side: 'L' });
  assert.deepEqual(classifyRigBone('J_Bip_R_Eye'), { role: 'eye', side: 'R' });
});

test('classifyRigBone finds generic humanoid joints', () => {
  assert.deepEqual(classifyRigBone('Head'), { role: 'head' });
  assert.deepEqual(classifyRigBone('Neck'), { role: 'neck' });
  assert.deepEqual(classifyRigBone('LeftEye'), { role: 'eye', side: 'L' });
  assert.deepEqual(classifyRigBone('EyeRight'), { role: 'eye', side: 'R' });
  assert.deepEqual(classifyRigBone('L_Eye'), { role: 'eye', side: 'L' });
  assert.deepEqual(classifyRigBone('eye_l'), { role: 'eye', side: 'L' });
  assert.deepEqual(classifyRigBone('leye'), { role: 'eye', side: 'L' });
  assert.deepEqual(classifyRigBone('Jaw'), { role: 'jaw' });
});

test('classifyRigBone rejects lookalikes and morph-target names', () => {
  // Joints above/around the head are not the head joint.
  assert.equal(classifyRigBone('HeadTop'), null);
  assert.equal(classifyRigBone('Head_End'), null);
  assert.equal(classifyRigBone('Head_Top'), null);
  assert.equal(classifyRigBone('Headphones'), null);
  // Accessory bones and blendshape names must not classify as rig joints.
  assert.equal(classifyRigBone('Necklace'), null);
  assert.equal(classifyRigBone('eyeBlinkLeft'), null);
  assert.equal(classifyRigBone('Blink'), null);
  assert.equal(classifyRigBone('LookUp'), null);
  assert.equal(classifyRigBone('CC_Base_Bone_ROOT'), null);
  assert.equal(classifyRigBone(''), null);
});

// ---- Eye gaze signal (drives eye bones when the rig has them) ----

test('eyeLookFromChannels: looking right drives h positive (InL + OutR)', () => {
  const out = eyeLookFromChannels({ eyeLookInL: 0.9, eyeLookOutR: 0.8, eyeLookOutL: 0.1, eyeLookInR: 0.05 });
  assert.ok(Math.abs(out.h - 1) < 1e-9);
  assert.equal(out.v, 0);
});

test('eyeLookFromChannels: looking left drives h negative', () => {
  const out = eyeLookFromChannels({ eyeLookOutL: 0.9, eyeLookInR: 0.85 });
  assert.ok(out.h < -0.9);
  assert.equal(out.v, 0);
});

test('eyeLookFromChannels: up is v positive, down is v negative', () => {
  assert.ok(eyeLookFromChannels({ eyeLookUpL: 0.6, eyeLookUpR: 0.7 }).v > 0.99);
  assert.ok(eyeLookFromChannels({ eyeLookDownL: 0.6, eyeLookDownR: 0.7 }).v < -0.99);
});

test('eyeLookFromChannels: neutral / empty channels stay at rest', () => {
  assert.deepEqual(eyeLookFromChannels({}), { h: 0, v: 0 });
  assert.deepEqual(eyeLookFromChannels(null), { h: 0, v: 0 });
  assert.deepEqual(eyeLookFromChannels({ eyeBlinkL: 1, jawOpen: 0.5 }), { h: 0, v: 0 });
});
