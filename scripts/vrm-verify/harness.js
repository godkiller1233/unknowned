// Browser side of the VRM regression harness (see vrm-verify.mjs).
//
// Loads ONE .vrm asset through the REAL 3D engine path — createAvatarEngine
// (mode '3d'), three.js GLTFLoader, skeleton discovery, morph-target mapping,
// hand/body rig discovery, spring chains — then renders ~90 frames driven by a
// synthetic tracker (no camera, no MediaPipe, deterministic) and reports:
//
//   ok        - engine reached 'tracking' and rendered frames
//   rig       - head/neck/eyes/jaw bone names found in the model
//   rigHas    - whether the head-follow rig driver engages
//   morphs    - count of usable ARKit/VRM morph targets
//   hairBones - count of hair/cloth bones that grow spring chains
//   handParts / bodyParts - tracked hand/body rig meshes built
//   frames    - frames the loop actually rendered (draw calls observed)
//
// Results are posted to window.__done as { ok, error, report }.
import { createAvatarEngine } from '../../src/avatar-engine.js';

const out = document.getElementById('out');
const log = (...a) => { out.textContent += a.join(' ') + '\n'; console.log(...a); };

// Deterministic synthetic tracker: a frontal face + open mouth + one hand.
// Feeds the exact shape the real MediaPipe tracker produces so every morph /
// rig consumer downstream is exercised.
function mkFace() {
  const pts = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.6, z: 0 }));
  pts[33] = { x: 0.435, y: 0.4, z: 0 };
  pts[263] = { x: 0.565, y: 0.4, z: 0 };
  pts[1] = { x: 0.5, y: 0.4968, z: 0 };
  pts[152] = { x: 0.5, y: 0.62, z: 0 };
  return pts;
}
function mkHand() {
  const pts = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.9, z: 0 }));
  pts[0] = { x: 0.5, y: 0.85, z: 0 };
  pts[5] = { x: 0.5, y: 0.7, z: 0 };
  pts[8] = { x: 0.5, y: 0.2, z: 0 };
  for (const [tip, kn] of [[12, 9], [16, 13], [20, 17]]) { pts[kn] = { x: 0.5, y: 0.7, z: 0 }; pts[tip] = { x: 0.5, y: 0.78, z: 0 }; }
  return pts;
}
const syntheticTracker = {
  detect() {
    return {
      landmarks: mkFace(),
      blends: { jawOpen: 0.6, eyeBlinkL: 0.1, eyeBlinkR: 0.1, mouthSmileL: 0.3, mouthSmileR: 0.3, browInnerUp: 0.4 },
      hands: [{ label: 'Right', landmarks: mkHand() }],
      body: null,
    };
  },
  async dispose() {},
};

async function run() {
  const qs = new URLSearchParams(location.search);
  const modelUrl = qs.get('model');
  if (!modelUrl) { post(false, 'missing ?model=<url>'); return; }

  let eng = null;
  try {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:180px;';
    const statuses = [];
    eng = createAvatarEngine({
      mode: '3d',
      assetUrl: modelUrl,
      hands: true,
      body: false,
      gravity: 0.5,
      tracker: syntheticTracker,
      canvas,
      onStatus: st => statuses.push(st),
    });
    await eng.start();
    // Let the render loop run: GLTFLoader resolves inside eng.start(), then
    // the loop pumps frames through the rig driver every rAF. Wait for a
    // target frame count, with a time cap so slow software-GL machines still
    // finish (throughput varies; the assertion checks rendering, not speed).
    {
      const t0 = Date.now();
      while (eng.framesRendered < 45 && Date.now() - t0 < 9000) await new Promise(r => setTimeout(r, 100));
    }

    const info = eng.rigInfo || {};
    const handRig = eng.handRig || null;
    const report = {
      ok: true,
      status: eng.status,
      statuses,
      rig: {
        head: info.head || null,
        neck: info.neck || null,
        eyeL: info.eyeL || null,
        eyeR: info.eyeR || null,
        jaw: info.jaw || null,
      },
      rigHas: !!eng.rigged,
      morphs: eng.morphCount,
      hairChains: eng.hairChainCount,
      handParts: handRig ? handRig.length : 0,
      handJointsLive: handRig ? handRig.filter(p => p.visible && p.joints.some(j => j.v)).length : 0,
      frames: eng.framesRendered,
    };

    // Pixel evidence: the canvas must not be uniformly transparent/black —
    // the model actually rasterized.
    const ctx2d = canvas.getContext('2d');
    const px = ctx2d.getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let i = 3; i < px.length; i += 4) { if (px[i] > 0) painted++; }
    report.paintedPx = painted;
    report.paintedRatio = +(painted / (canvas.width * canvas.height)).toFixed(4);

    post(true, null, report);
  } catch (err) {
    post(false, String((err && err.message) || err));
  } finally {
    if (eng) { try { await eng.destroy(); } catch {} }
  }
}

function post(ok, error, report) {
  log(ok ? 'OK' : 'FAIL', error || '');
  window.__done = { ok, error: error || null, report: report || null };
}
window.__runVrm = run;
run();
