// Tests for the extended 3D rig mapping and secondary-motion physics:
//
// 1. classifyRigBone now recognizes finger phalanges (separated, VRM-chain and
//    fused spellings), tongue bones and upper/lower lip bones — so tracked
//    hands drive finger curls and mouth channels drive lips/tongue on models
//    whose rigs carry those bones.
// 2. createSpringChain/stepSpringChain: deterministic Verlet chains used for
//    hair/cloth secondary motion — gravity sags the chain, movement at the
//    root carries the tip, the chain stays segment-length constrained, and a
//    strength of 0 (the user's gravity slider at zero) leaves the chain at
//    rest. Determinism matters: the same inputs must produce the same chain
//    positions on every machine (no Date.now / Math.random inside the sim).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyRigBone, createSpringChain, stepSpringChain } from '../src/avatar-math.js';

test('classifyRigBone: finger phalanges in separated, VRM-chain and fused spellings', () => {
  // separated (ARKit-ish / FBX)
  assert.deepEqual(classifyRigBone('Thumb_R_1'), { role: 'finger', side: 'R', finger: 'thumb', ph: 1 });
  assert.deepEqual(classifyRigBone('Middle_L'), { role: 'finger', side: 'L', finger: 'middle', ph: 1 });
  // VRM chains
  assert.deepEqual(classifyRigBone('J_Bip_L_IndexIntermediate'), { role: 'finger', side: 'L', finger: 'index', ph: 2 });
  // fused (Mixamo / glTF exports)
  assert.deepEqual(classifyRigBone('LeftHandMiddle3'), { role: 'finger', side: 'L', finger: 'middle', ph: 3 });
  assert.deepEqual(classifyRigBone('RightRingDistal'), { role: 'finger', side: 'R', finger: 'ring', ph: 3 });
  assert.deepEqual(classifyRigBone('LeftThumbProximal'), { role: 'finger', side: 'L', finger: 'thumb', ph: 1 });
  // 'little' normalizes to 'pinky'
  const got = classifyRigBone('LeftLittle1');
  assert.equal(got.finger, 'pinky');
});

test('classifyRigBone: tongue and lip bones', () => {
  assert.deepEqual(classifyRigBone('J_Bip_C_Tongue'), { role: 'tongue' });
  assert.deepEqual(classifyRigBone('TongueBone'), { role: 'tongue' });
  assert.deepEqual(classifyRigBone('UpperLip'), { role: 'lip', part: 'upper', side: null });
  assert.deepEqual(classifyRigBone('LipLower_L'), { role: 'lip', part: 'lower', side: 'L' });
  assert.deepEqual(classifyRigBone('Lip_Lower_L'), { role: 'lip', part: 'lower', side: 'L' });
});

test('classifyRigBone: non-rig names stay null (no false positives)', () => {
  assert.equal(classifyRigBone('HeadTop_End'), null);
  assert.equal(classifyRigBone('necklace'), null);       // 'neck' keyword inside an accessory
  assert.equal(classifyRigBone('eyeBlinkLeft'), null);   // morph name, not a bone
  assert.equal(classifyRigBone('hairFront_01'), null);   // hair handled by chain discovery, not roles
  assert.equal(classifyRigBone(''), null);
  assert.equal(classifyRigBone(null), null);
});

test('spring chain: gravity sags the chain and constraints hold segment length', () => {
  const chain = createSpringChain(4, 0.05);
  // init at origin
  stepSpringChain(chain, 0, 0, 0, 1 / 24, 1);
  // settle under gravity
  for (let i = 0; i < 240; i++) stepSpringChain(chain, 0, 0, 0, 1 / 24, 1);
  const pts = chain.pts;
  // root pinned
  assert.equal(pts[0].x, 0);
  assert.equal(pts[0].y, 0);
  // segments stay taut: gravity may stretch the top segment ~10% but never
  // rubber-band it, and no segment ever collapses
  for (let i = 0; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y, pts[i + 1].z - pts[i].z);
    assert.ok(d < 0.05 * 1.12, `segment ${i} length ${d} should stay taut (<= 5.6cm)`);
    assert.ok(d > 0.049, `segment ${i} length ${d} should not collapse`);
  }
  // hanging straight down under gravity (settled overshoot: the PBD relax
  // bleeds velocity, so the chain hangs ~5% past its 0.15 rest depth)
  assert.ok(Math.abs(pts[3].x) < 1e-4, `tip x ${pts[3].x} should be ~0 (straight down)`);
  assert.ok(Math.abs(pts[3].y + 0.1579) < 0.004, `tip y ${pts[3].y} should be ~-0.158 (settled hang)`);
});

test('spring chain: strength 0 applies no gravity or sway (slider at zero)', () => {
  const chain = createSpringChain(4, 0.05);
  stepSpringChain(chain, 0, 0, 0, 1 / 24, 1);            // init
  // settle under gravity first, so there IS a hanging configuration to hold
  for (let i = 0; i < 240; i++) stepSpringChain(chain, 0, 0, 0, 1 / 24, 1);
  const settled = chain.pts.map(p => ({ ...p }));
  // strength drops to 0 mid-session: the chain must freeze exactly where it
  // hangs (no further falling, no recovering to the bind pose).
  for (let i = 0; i < 60; i++) stepSpringChain(chain, 0, 0, 0, 1 / 24, 0);
  for (let i = 0; i < chain.pts.length; i++) {
    assert.ok(Math.abs(chain.pts[i].y - settled[i].y) < 1e-9, `point ${i} frozen at strength 0`);
    assert.ok(Math.abs(chain.pts[i].x - settled[i].x) < 1e-9, `point ${i} x frozen at strength 0`);
  }
});

test('spring chain: lateral root acceleration swings the tip (deterministic)', () => {
  const a = createSpringChain(4, 0.05);
  const b = createSpringChain(4, 0.05);
  // identical runs must be identical (no hidden randomness)
  const run = ch => {
    stepSpringChain(ch, 0, 0, 0, 1 / 24, 1);
    for (let i = 0; i < 60; i++) stepSpringChain(ch, 0, 0, 0, 1 / 24, 0.8, 6);
    return ch.pts.map(p => [+p.x.toFixed(6), +p.y.toFixed(6)]);
  };
  const ra = run(a), rb = run(b);
  assert.deepEqual(ra, rb, 'two identical runs must match exactly');
  // sway pushes the tip +x
  assert.ok(a.pts[3].x > 0.01, `tip x ${a.pts[3].x} should swing right under sustained +x sway`);
});
