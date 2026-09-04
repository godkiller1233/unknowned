// avatar-engine.js — the “virtual camera” for avatar mode.
//
// When a user chooses an avatar instead of their face, every video surface
// (DM call camera, video rooms) sends this engine's canvas stream instead of
// the raw camera. The real camera — when the user allows it — is used ONLY
// locally to track face/hands; it is never transmitted. Without a camera the
// avatar still animates (idle breathing + blinking + mic-talking jaw), so an
// avatar is a privacy option that works even when the webcam stays off.
//
// Tracking: MediaPipe FaceLandmarker (+ optional HandLandmarker) loaded from
// locally-served assets (/ml/…). Rendering: 2D mode draws the imported image
// driven by head pose (position / roll / closeness zoom / yaw lean / talking);
// 3D mode renders an imported .glb with three.js and maps MediaPipe ARKit
// blendshapes onto the model's morph targets by name (VRM/ARKit/FBX/Maya
// conventions). Hand landmarks draw a tracked “hand rig” overlay in both modes.
//
// Heavy libraries (@mediapipe/tasks-vision, three) are imported lazily so the
// main bundle stays small — nothing loads until someone actually starts an
// avatar.

import * as math from './avatar-math.js';

export const AV_OUT_W = 640;
export const AV_OUT_H = 360;
export const AV_FPS = 24;

const ML_BASE = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL
  ? String(import.meta.env.BASE_URL).replace(/\/+$/, '')
  : '') + '/ml';

let libsPromise = null;
function loadLibs() {
  if (!libsPromise) {
    libsPromise = Promise.all([
      import('@mediapipe/tasks-vision'),
      import('three'),
      import('three/examples/jsm/loaders/GLTFLoader.js'),
    ]).then(([tv, three, gltf]) => ({ tv, three, GLTFLoader: gltf.GLTFLoader }));
  }
  return libsPromise;
}

// ---------------------------------------------------------------------------
// MediaPipe tracker — normalized output the engine can also mock in tests.
// detect() returns null when no face is visible this frame.
// ---------------------------------------------------------------------------
async function createMediaPipeTracker({ video, wantHands, onStatus }) {
  const { tv } = await loadLibs();
  let wasm;
  try {
    wasm = await tv.FilesetResolver.forVisionTasks(ML_BASE + '/wasm');
  } catch (err) {
    throw new Error('Could not load the tracking engine (' + (err && err.message ? err.message : 'network') + ') — the avatar still runs, but without face/hand animation.');
  }
  const make = async (Model, opts) => {
    try {
      return await Model.createFromOptions(wasm, { ...opts, baseOptions: { ...(opts.baseOptions || {}), delegate: 'GPU' } });
    } catch {
      return Model.createFromOptions(wasm, { ...opts, baseOptions: { ...(opts.baseOptions || {}), delegate: 'CPU' } });
    }
  };
  const face = await make(tv.FaceLandmarker, {
    baseOptions: { modelAssetPath: ML_BASE + '/face_landmarker.task' },
    runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: false,
  });
  let hand = null;
  if (wantHands) {
    try {
      hand = await make(tv.HandLandmarker, {
        baseOptions: { modelAssetPath: ML_BASE + '/hand_landmarker.task' },
        runningMode: 'VIDEO', numHands: 2,
      });
    } catch { hand = null; }
  }
  const vid = video;
  const ts = () => Math.max(0, performance.now());
  return {
    detect() {
      let faceRes = null, handsRes = null;
      try { faceRes = face.detectForVideo(vid, ts()); } catch { /* frame not ready yet */ }
      let out = null;
      if (faceRes && faceRes.faceLandmarks && faceRes.faceLandmarks.length) {
        // MediaPipe Tasks landmarks are normalized to [0,1] — pass them through
        // untouched (dividing by videoWidth/videoHeight collapsed every tracked
        // point into the top-left corner on non-square camera feeds).
        const lm = faceRes.faceLandmarks[0].map(pt => ({ x: pt.x, y: pt.y }));
        out = { landmarks: lm, blends: faceRes.faceBlendshapes && faceRes.faceBlendshapes[0] ? faceRes.faceBlendshapes[0].categories : null };
      }
      if (hand) {
        try { handsRes = hand.detectForVideo(vid, ts()); } catch {}
        if (handsRes && handsRes.landmarks && handsRes.landmarks.length) {
          out = out || {};
          out.hands = handsRes.landmarks.map((pts, i) => ({
            landmarks: pts.map(pt => ({ x: pt.x, y: pt.y, z: pt.z })),
            label: handsRes.handednesses && handsRes.handednesses[i] ? handsRes.handednesses[i][0].categoryName : (i === 0 ? 'Right' : 'Left'),
          }));
        }
      }
      return out;
    },
    async dispose() {
      try { face.close(); } catch {}
      try { hand && hand.close(); } catch {}
    },
  };
}

// ---------------------------------------------------------------------------
// Talking detection from the call's mic stream (so the avatar “talks” even
// when the webcam is off).
// ---------------------------------------------------------------------------
function makeTalkingSensor(audioStream) {
  let analyser = null, ctx = null, src = null, level = 0;
  if (audioStream && (typeof AudioContext !== 'undefined' || typeof window !== 'undefined')) {
    try {
      const AC = (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) || (typeof AudioContext !== 'undefined' ? AudioContext : null);
      if (AC) {
        ctx = new AC();
        analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        src = ctx.createMediaStreamSource(audioStream);
        src.connect(analyser);
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      }
    } catch { analyser = null; }
  }
  const buf = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
  return {
    level() {
      if (!analyser || !buf) return level;
      try {
        if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
        analyser.getByteFrequencyData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i];
        const avg = sum / buf.length;
        level = level * 0.6 + (avg > 4 ? Math.min(1, (avg - 4) / 90) : 0) * 0.4;
      } catch {}
      return level;
    },
    close() {
      try { src && src.disconnect(); } catch {}
      try { ctx && ctx.close(); } catch {}
      analyser = null; ctx = null; src = null;
    },
  };
}

// ---------------------------------------------------------------------------
// 2D renderer
// ---------------------------------------------------------------------------
function drawAvatar2D(ctx, img, p, hands, t, wantHands, fit) {
  const W = AV_OUT_W, H = AV_OUT_H;
  ctx.clearRect(0, 0, W, H);
  const iw = img.width || 1, ih = img.height || 1;
  const bob = Math.sin(t / 420) * 2 + (p.talking ? Math.sin(t / 90) * 2.5 : 0);
  // Talking “breath” + blink squash (whole-sprite pulse reads well at 24 fps).
  const sy = (1 - p.blink * 0.055) * (1 + p.mouth * 0.035);
  const sx = (1 + p.mouth * 0.012) * Math.cos(math.clamp(p.yaw, -35, 35) * Math.PI / 180 * 0.55);
  const rollRad = p.roll * Math.PI / 180;
  const yawShear = -Math.tan(math.clamp(p.yaw, -38, 38) * Math.PI / 180 * 0.55);
  const pitchShear = Math.tan(math.clamp(p.pitch, -35, 35) * Math.PI / 180 * 0.4);
  const closeness = math.clamp(p.closeness, 0.5, 1.9);
  let ox = 0, oy = 0, dw = 0, dh = 0;
  const fits = fit && fit.leftEye && fit.rightEye;
  if (fits && p.midX != null && p.midY != null && p.eyeDist) {
    // Feature-fitted draw (VSee-style registration): the picture's eyes are
    // pinned onto the tracked face's eyes — position AND size. Leaning closer
    // grows the tracked inter-eye span, so the sprite scales with it; the
    // character turns around its own eye line rather than the image centre.
    const aL = fit.leftEye, aR = fit.rightEye;
    const adist = Math.hypot((aR.x - aL.x) * iw, (aR.y - aL.y) * ih) || 1;
    const targetEye = p.eyeDist * W * 1.15;               // tracked eye span in px
    const scale = Math.max(0.1, targetEye / adist) * 1.05 * closeness;
    dw = iw * scale; dh = ih * scale;
    if (dh > H * 2.2) { const k = (H * 2.2) / dh; dw *= k; dh *= k; }
    // Draw so the avatar eye midpoint lands exactly on the tracked eye midpoint.
    ox = -(((aL.x + aR.x) / 2) * iw) * scale;
    oy = -(((aL.y + aR.y) / 2) * ih) * scale;
    ctx.save();
    ctx.translate(p.midX * W, p.midY * H + bob);
    ctx.rotate(rollRad);
    ctx.transform(1, 0, yawShear, 1, 0, 0);
    ctx.transform(1, pitchShear, 0, 1, 0, 0);
    ctx.scale(sx, sy);
    ctx.drawImage(img, ox, oy, dw, dh);
    ctx.restore();
  } else {
    // Fallback (no fit anchors or no face yet): center the sprite with head-follow.
    const base = Math.min(W / iw, H / ih);
    dw = iw * base * closeness * 1.12;
    dh = ih * base * closeness * 1.12;
    if (dh > H * 1.6) { const k = (H * 1.6) / dh; dw *= k; dh *= k; }
    const cx = W / 2 + (p.noseX - 0.5) * W * 0.5;
    const cy = H * 0.46 + (p.noseY - 0.5) * H * 0.8 + bob;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rollRad);
    ctx.transform(1, 0, yawShear, 1, 0, 0);
    ctx.transform(1, pitchShear, 0, 1, 0, 0);
    ctx.scale(sx, sy);
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }
  if (wantHands && hands) drawHands2D(ctx, hands);
}

function drawHands2D(ctx, hands) {
  ctx.save();
  ctx.lineWidth = 3;
  const PAIRS = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
  hands.forEach((hand, hi) => {
    const color = hi === 0 ? 'rgba(129,140,248,0.95)' : 'rgba(244,114,182,0.95)';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    const pts = hand.landmarks.map(pt => ({ x: pt.x * AV_OUT_W, y: pt.y * AV_OUT_H }));
    PAIRS.forEach(([a, b]) => {
      if (!pts[a] || !pts[b]) return;
      ctx.beginPath();
      ctx.moveTo(pts[a].x, pts[a].y);
      ctx.lineTo(pts[b].x, pts[b].y);
      ctx.stroke();
    });
    pts.forEach(pt => {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 3.4, 0, Math.PI * 2);
      ctx.fill();
    });
  });
  ctx.restore();
}

// Calibration wizard view: the raw (mirrored) camera with the tracked anchors
// drawn on top, so the user can see exactly where the tracker thinks their
// eyes, pupils, mouth and hands are — and verify before saving.
function drawCalibrationOverlay(ctx, video, face, hands) {
  const W = AV_OUT_W, H = AV_OUT_H;
  ctx.clearRect(0, 0, W, H);
  if (video && video.videoWidth > 0) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const k = Math.max(W / vw, H / vh);
    const dw = vw * k, dh = vh * k;
    ctx.save();
    ctx.translate(W, 0); ctx.scale(-1, 1);           // mirror like a mirror view
    ctx.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.restore();
  }
  const X = x => W - x * W;                          // mirror landmark x too
  const Y = y => y * H;
  const dot = (x, y, r, color) => {
    ctx.beginPath(); ctx.arc(X(x), Y(y), r, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
  };
  if (face && face.landmarks) {
    const L = face.landmarks;
    const get = i => L[i] && { x: L[i].x, y: L[i].y };
    const link = (a, b, color, w = 2) => {
      const pa = get(a), pb = get(b);
      if (!pa || !pb) return;
      ctx.beginPath(); ctx.moveTo(X(pa.x), Y(pa.y)); ctx.lineTo(X(pb.x), Y(pb.y));
      ctx.strokeStyle = color; ctx.lineWidth = w; ctx.stroke();
    };
    // Face oval (light guide line) + jaw
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109].forEach((i, n) => {
      const p = get(i); if (!p) return;
      if (n === 0) ctx.moveTo(X(p.x), Y(p.y)); else ctx.lineTo(X(p.x), Y(p.y));
    });
    ctx.stroke();
    // Eyes (cyan rings on outer/inner corners), pupils (white)
    [33, 133, 362, 263].forEach(i => { const p = get(i); if (p) dot(p.x, p.y, 5, '#22d3ee'); });
    [468, 473].forEach(i => { const p = get(i); if (p) dot(p.x, p.y, 3, '#ffffff'); });
    link(33, 133, '#22d3ee', 3); link(362, 263, '#22d3ee', 3);
    // Nose tip (yellow)
    const nz = get(1); if (nz) dot(nz.x, nz.y, 4, '#facc15');
    // Mouth corners + inner lip (pink) — the "open mouth" anchor is 13/14
    [61, 291].forEach(i => { const p = get(i); if (p) dot(p.x, p.y, 5, '#f472b6'); });
    link(61, 291, '#f472b6', 3);
    [13, 14].forEach(i => { const p = get(i); if (p) dot(p.x, p.y, 4, '#fb7185'); });
    link(13, 14, '#fb7185', 3);
    // Chin anchor
    const chin = get(152); if (chin) dot(chin.x, chin.y, 3, 'rgba(255,255,255,0.5)');
  }
  if (hands && hands.length) {
    const PAIRS = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
    hands.forEach((hand, hi) => {
      const color = hi === 0 ? 'rgba(129,140,248,0.95)' : 'rgba(244,114,182,0.95)';
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2.5;
      const pts = (hand.landmarks || []).map(pt => ({ x: X(pt.x), y: Y(pt.y) }));
      PAIRS.forEach(([a, b]) => {
        if (!pts[a] || !pts[b]) return;
        ctx.beginPath(); ctx.moveTo(pts[a].x, pts[a].y); ctx.lineTo(pts[b].x, pts[b].y); ctx.stroke();
      });
      pts.forEach(pt => { ctx.beginPath(); ctx.arc(pt.x, pt.y, 2.6, 0, Math.PI * 2); ctx.fill(); });
    });
  }
}

// ---------------------------------------------------------------------------
// 3D renderer (three.js, lazy)
// ---------------------------------------------------------------------------
const CAM_Z = 3.1;
const HAND_Z = 2.35;

async function setup3D(three, GLTFLoader, assetUrl, onStatus) {
  const renderer = new three.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: false });
  renderer.setSize(AV_OUT_W, AV_OUT_H);
  renderer.setClearColor(0x000000, 0);
  const scene = new three.Scene();
  const camera = new three.PerspectiveCamera(42, AV_OUT_W / AV_OUT_H, 0.05, 50);
  camera.position.set(0, 0, CAM_Z);
  scene.add(new three.HemisphereLight(0xffffff, 0x30303a, 0.9));
  const key = new three.DirectionalLight(0xffffff, 1.1);
  key.position.set(2, 3, 4);
  scene.add(key);
  const fill = new three.DirectionalLight(0xbfc4ff, 0.35);
  fill.position.set(-3, 1, 2);
  scene.add(fill);
  scene.add(new three.AmbientLight(0xffffff, 0.15));

  const group = new three.Group();
  scene.add(group);

  let morphs = [];      // [{ mesh, idx, cats }]
  let hasMorphs = false;

  onStatus('loading-model');
  const gltf = await new Promise((resolve, reject) => {
    new GLTFLoader().load(assetUrl, resolve, undefined, reject);
  });
  const root = gltf.scene || gltf.scenes[0];
  const bbox = new three.Box3().setFromObject(root);
  const size = new three.Vector3();
  bbox.getSize(size);
  const center = new three.Vector3();
  bbox.getCenter(center);
  root.position.x -= center.x;
  root.position.y -= center.y;
  root.position.z -= center.z;
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  // Fit the model so its height fills ~84% of the frame.
  const visibleH = 2 * Math.tan((42 * Math.PI / 180) / 2) * CAM_Z; // ≈ 2.38
  const scale = (visibleH * 0.84) / maxDim;
  root.scale.setScalar(scale);
  group.add(root);

  root.traverse(obj => {
    if (!obj.isMesh || !obj.morphTargetDictionary || !obj.morphTargetInfluences) return;
    const dict = obj.morphTargetDictionary;
    Object.keys(dict).forEach(name => {
      const cats = math.morphTargetChannels(name);
      if (!cats) return; // unmapped targets stay at rest
      hasMorphs = true;
      morphs.push({ mesh: obj, idx: dict[name], cats });
    });
  });

  // Tracked-hand rig: simple translucent “digital glove” primitives always
  // available regardless of the model's own skeleton.
  // Humanoid rig discovery (VRM / VRMA / Mixamo / FBX bone conventions).
  // When the model carries bones for the head / neck / eyes / jaw, tracked
  // motion is applied to those bones locally — the neck bends, the eyes
  // glance, the jaw opens — instead of rotating the whole model like a
  // billboard. Plain .glb characters without a rig fall back to the
  // whole-model path below.
  const rig = { has: {}, bone: {}, base: {}, sm: { hY: 0, hP: 0, hR: 0, nY: 0, nP: 0, eY: 0, eP: 0, jaw: 0 } };
  const rigEuler = new three.Euler(0, 0, 0, 'YXZ');
  const rigQuat = new three.Quaternion();
  root.traverse(obj => {
    if (!obj.isBone) return;
    const cls = math.classifyRigBone(obj.name || obj.userData?.name || '');
    if (!cls) return;
    const key = cls.role === 'eye' ? 'eye' + cls.side : cls.role;
    if (rig.bone[key]) return;              // first joint per role wins
    rig.bone[key] = obj;
    rig.base[key] = obj.quaternion.clone();
    rig.has[key] = true;
  });
  const rigInfo = {
    head: rig.bone.head ? (rig.bone.head.name || 'Head') : null,
    neck: rig.bone.neck ? (rig.bone.neck.name || 'Neck') : null,
    eyeL: rig.bone.eyeL ? (rig.bone.eyeL.name || 'LeftEye') : null,
    eyeR: rig.bone.eyeR ? (rig.bone.eyeR.name || 'RightEye') : null,
    jaw:  rig.bone.jaw  ? (rig.bone.jaw.name || 'Jaw') : null,
  };
  const rigHas = !!(rig.bone.head || rig.bone.neck || rig.bone.eyeL || rig.bone.eyeR || rig.bone.jaw);
  // Don't double-drive: when the model already has morph targets for eye-look
  // or jaw-open (VRoid exports both morphs AND rig bones), the morphs win and
  // the matching bones stay at rest.
  const rigMorphCats = new Set();
  morphs.forEach(m => (m.cats || []).forEach(c => rigMorphCats.add(c)));
  const hasLookMorph = ['eyeLookUpL', 'eyeLookUpR', 'eyeLookDownL', 'eyeLookDownR', 'eyeLookInL', 'eyeLookInR', 'eyeLookOutL', 'eyeLookOutR'].some(c => rigMorphCats.has(c));
  const hasJawMorph = rigMorphCats.has('jawOpen');
  const RIG_DEG = Math.PI / 180;

  // Apply the smoothed pose + canonical channels onto the discovered bones.
  // Gains mirror the whole-model fallback so rigged and unrigged models feel
  // the same; each bone rotates around its own bind-pose rest (base quat).
  function driveRig(pose, channels, k) {
    const sm = rig.sm;
    const tYaw = -pose.yaw * RIG_DEG * 0.85;     // wearer turns right -> +Y (screen-right, same as fallback)
    const tPitch = pose.pitch * RIG_DEG * 0.7;
    const tRoll = -pose.roll * RIG_DEG * 0.6;
    const look = math.eyeLookFromChannels(channels);
    const driveEyes = !!(rig.bone.eyeL && rig.bone.eyeR) && !hasLookMorph;
    const driveJaw = !!rig.bone.jaw && !hasJawMorph;
    if (rig.bone.head || rig.bone.neck) {
      sm.hY += (tYaw - sm.hY) * k;
      sm.hP += (tPitch - sm.hP) * k;
      sm.hR += (tRoll - sm.hR) * k;
      if (rig.bone.head) {
        rigEuler.set(sm.hP, sm.hY, sm.hR, 'YXZ');
        rig.bone.head.quaternion.copy(rig.base.head).multiply(rigQuat.setFromEuler(rigEuler));
      }
      if (rig.bone.neck) {
        sm.nY += (tYaw * 0.25 - sm.nY) * k;
        sm.nP += (tPitch * 0.25 - sm.nP) * k;
        rigEuler.set(sm.nP, sm.nY, 0, 'YXZ');
        rig.bone.neck.quaternion.copy(rig.base.neck).multiply(rigQuat.setFromEuler(rigEuler));
      }
    }
    if (driveEyes) {
      // h > 0 = wearer looks right; +Y turns the eye's +Z toward screen-right.
      // v > 0 = up; -X tilts the +Z front up. Same screen-side convention as
      // the head so a glance never fights the head turn.
      const tEyeY = look.h * 0.34;
      const tEyeP = -look.v * 0.26;
      sm.eY += (tEyeY - sm.eY) * k;
      sm.eP += (tEyeP - sm.eP) * k;
      ['eyeL', 'eyeR'].forEach(ek => {
        const b = rig.bone[ek];
        if (!b) return;
        rigEuler.set(sm.eP, sm.eY, 0, 'YXZ');
        b.quaternion.copy(rig.base[ek]).multiply(rigQuat.setFromEuler(rigEuler));
      });
    }
    if (driveJaw) {
      sm.jaw += (Math.min(1, channels.jawOpen || 0) * 0.55 - sm.jaw) * k;
      rigEuler.set(sm.jaw, 0, 0, 'YXZ');
      rig.bone.jaw.quaternion.copy(rig.base.jaw).multiply(rigQuat.setFromEuler(rigEuler));
    }
    rig.last = {
      yaw: sm.hY, pitch: sm.hP, roll: sm.hR,
      eyeYaw: sm.eY, eyePitch: sm.eP, jaw: sm.jaw,
      eyeL: driveEyes, jawBone: driveJaw,
    };
  }

  const handGroup = new three.Group();
  handGroup.renderOrder = 20;
  scene.add(handGroup);
  const jointGeo = new three.SphereGeometry(0.012, 10, 10);
  const boneGeo = new three.CylinderGeometry(0.0075, 0.0075, 1, 6);
  const handParts = [];
  for (let hi = 0; hi < 2; hi++) {
    const joints = [], bones = [];
    const mat = new three.MeshBasicMaterial({
      color: hi === 0 ? 0x818cf8 : 0xf472b6,
      transparent: true, opacity: 0.85, depthTest: false, depthWrite: false,
    });
    for (let i = 0; i < 21; i++) {
      const j = new three.Mesh(jointGeo, mat);
      joints.push(j);
      handGroup.add(j);
    }
    for (let i = 0; i < 20; i++) {
      const b = new three.Mesh(boneGeo, mat);
      bones.push(b);
      handGroup.add(b);
    }
    handParts.push({ joints, bones, mat, visible: false });
  }

  return {
    renderer, scene, camera, group, morphs, hasMorphs, handGroup, handParts,
    rig, rigHas, rigInfo, driveRig,
    yAxis: new three.Vector3(0, 1, 0),
    v1: new three.Vector3(),
    v2: new three.Vector3(),
    mid: new three.Vector3(),
    dir: new three.Vector3(),
  };
}

function updateHandRig3D(rig, hands) {
  const halfH = Math.tan((42 * Math.PI / 180) / 2) * (CAM_Z - HAND_Z); // ≈0.55
  const halfW = halfH * (AV_OUT_W / AV_OUT_H);
  const up = rig.yAxis, dir = rig.dir, a = rig.v1, b = rig.v2;
  rig.handParts.forEach((part, hi) => {
    const hand = hands && hands[hi];
    const pts = hand && hand.landmarks;
    if (!pts || !hand.visibleFrame) {
      if (part.visible) { part.joints.forEach(j => { j.visible = false; }); part.bones.forEach(x => { x.visible = false; }); part.visible = false; }
      return;
    }
    part.visible = true;
    const world = (pt, out) => {
      out.set((pt.x - 0.5) * 2 * halfW, (0.5 - pt.y) * 2 * halfH, HAND_Z);
      return out;
    };
    for (let i = 0; i < 21; i++) {
      world(pts[i], a);
      part.joints[i].position.copy(a);
      part.joints[i].visible = true;
    }
    for (let i = 0; i < 20; i++) {
      world(pts[i], a);
      world(pts[i + 1], b);
      a.lerp(b, 0.5).copy(part.bones[i].position);
      dir.subVectors(b, a);
      const len = dir.length() || 1e-6;
      part.bones[i].scale.set(1, len, 1);
      part.bones[i].quaternion.setFromUnitVectors(up, dir.normalize());
      part.bones[i].visible = true;
    }
  });
}

function updateMorphs(channels, morphs) {
  for (const m of morphs) {
    let w = 0;
    for (let i = 0; i < m.cats.length; i++) w = Math.max(w, channels[m.cats[i]] || 0);
    m.mesh.morphTargetInfluences[m.idx] = w;
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------
export function createAvatarEngine(opts = {}) {
  const cfg = {
    mode: opts.mode === '3d' ? '3d' : '2d',
    assetUrl: opts.assetUrl || null,
    hands: opts.hands !== false,
    audioStream: opts.audioStream || null,
    cameraStream: opts.cameraStream || null,
    videoSrc: opts.videoSrc || null,   // recorded clip drives MediaPipe (verification / no webcam)
    tracker: opts.tracker || null,          // { detect() -> {landmarks,blends,hands} } (tests)
    calibration: opts.calibration || null,   // per-user neutral pose + expression ranges
    rawOverlay: !!opts.rawOverlay,           // calibration wizard: show camera + tracked anchors
    fit: opts.fit || null,                   // 2D avatar feature anchors {leftEye:{x,y},rightEye:{x,y}}
    onStatus: typeof opts.onStatus === 'function' ? opts.onStatus : () => {},
  };

  const canvas = opts.canvas || document.createElement('canvas');
  canvas.width = AV_OUT_W;
  canvas.height = AV_OUT_H;
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(AV_FPS);
  const track = stream.getVideoTracks()[0];

  let running = false;
  let destroyed = false;
  let raf = 0;
  let sensor = null;
  let mpTracker = null;
  let hiddenVideo = null;
  let img = null;            // 2D source image
  let imgError = null;
  let g3 = null;             // 3D state
  let g3error = null;
  let status = 'idle';
  let lastFaceAt = 0;
  let nextBlinkAt = performance.now() + 2500;
  const pose = { yaw: 0, pitch: 0, roll: 0, closeness: 1, noseX: 0.5, noseY: 0.5, midX: 0.5, midY: 0.5, eyeDist: 0.13, blinkL: 0, blinkR: 0, blink: 0, mouth: 0, smile: 0, browUp: 0, browDown: 0, talking: false };
  let lastHands = null;
  let lastChannels = {};
  let lastHandRig = null;   // observability mirror of the 3D hand rig (harness tests)

  function setStatus(s) { status = s; try { cfg.onStatus(s); } catch {} }

  async function load2DAsset(url) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('Could not load that picture as an avatar.'));
      im.src = url;
    });
  }

  async function initTracker() {
    try {
      // A caller-supplied tracker (custom or test) generates its own landmarks
      // and needs no camera feed, so it takes precedence over the camera check.
      if (cfg.tracker) {
        mpTracker = cfg.tracker;
        setStatus('tracking');
        return;
      }
      if (cfg.videoSrc) {
        // A recorded clip (public-domain talking-head) replaces the camera for
        // MediaPipe; the same hidden-video plumbing feeds both landmarkers.
        if (typeof document === 'undefined') return;
        hiddenVideo = document.createElement('video');
        hiddenVideo.autoplay = true;
        hiddenVideo.muted = true;
        hiddenVideo.loop = true;
        hiddenVideo.playsInline = true;
        hiddenVideo.crossOrigin = 'anonymous';
        hiddenVideo.src = cfg.videoSrc;
        hiddenVideo.setAttribute('aria-hidden', 'true');
        hiddenVideo.style.cssText = 'position:fixed;left:-9999px;width:4px;height:4px;opacity:0;pointer-events:none;';
        document.body.appendChild(hiddenVideo);
        await hiddenVideo.play().catch(() => {});
        mpTracker = await createMediaPipeTracker({ video: hiddenVideo, wantHands: cfg.hands, onStatus: setStatus });
        setStatus('tracking');
        return;
      }
      if (!cfg.cameraStream) { setStatus(cfg.mode === '3d' ? 'no-camera-idle' : 'no-camera-idle'); return; }
      if (typeof document === 'undefined') return;
      hiddenVideo = document.createElement('video');
      hiddenVideo.autoplay = true;
      hiddenVideo.muted = true;
      hiddenVideo.playsInline = true;
      hiddenVideo.srcObject = cfg.cameraStream;
      hiddenVideo.setAttribute('aria-hidden', 'true');
      hiddenVideo.style.cssText = 'position:fixed;left:-9999px;width:4px;height:4px;opacity:0;pointer-events:none;';
      document.body.appendChild(hiddenVideo);
      await hiddenVideo.play().catch(() => {});
      mpTracker = await createMediaPipeTracker({ video: hiddenVideo, wantHands: cfg.hands, onStatus: setStatus });
      setStatus('tracking');
    } catch (err) {
      mpTracker = null;
      setStatus('no-tracking-idle');
    }
  }

  async function loadSource() {
    if (cfg.mode === '2d') {
      imgError = null;
      try {
        img = await load2DAsset(cfg.assetUrl);
        setStatus('tracking-or-idle');
      } catch (err) {
        img = null;
        imgError = String(err && err.message || err);
        setStatus('error:' + imgError);
      }
    } else {
      g3error = null;
      try {
        const { three, GLTFLoader } = await loadLibs();
        if (g3) { try { g3.renderer.dispose(); } catch {} }
        g3 = await setup3D(three, GLTFLoader, cfg.assetUrl, setStatus);
        setStatus('tracking-or-idle');
      } catch (err) {
        g3 = null;
        g3error = String(err && err.message || err);
        setStatus('error:' + g3error);
      }
    }
  }

  async function start() {
    if (destroyed || running) return;
    running = true;
    sensor = makeTalkingSensor(cfg.audioStream);
    await initTracker();
    if (!cfg.rawOverlay && !img && !g3 && !imgError && !g3error) await loadSource();
    const loop = () => {
      if (destroyed || !running) return;
      try { step(); } catch (e) { /* never let one bad frame kill the call */ }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }

  function setEnabled(on) {
    if (on && !running) {
      running = true;
      raf = requestAnimationFrame(() => { const loop = () => { if (destroyed || !running) return; try { step(); } catch {} raf = requestAnimationFrame(loop); }; raf = requestAnimationFrame(loop); });
    } else if (!on && running) {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  function idleBlinkValue(now) {
    if (now >= nextBlinkAt) {
      nextBlinkAt = now + 2600 + Math.random() * 3400;
      return 1;
    }
    return 0;
  }

  function step() {
    const now = performance.now();
    let faceRes = null;
    if (mpTracker) {
      try {
        const res = mpTracker.detect();
        if (res) {
          faceRes = res;
          lastHands = res.hands || null;
          if (res.landmarks) lastFaceAt = now;
        }
      } catch { /* tracking hiccup — keep animating */ }
    }
    const talkingRaw = sensor ? sensor.level() : 0;
    const talking = talkingRaw > 0.24;

    // Face pose (or graceful idle when the face left / camera is off).
    // Per-user calibration zeroes the neutral head hold and stretches each
    // expression's live range across the user's own min..max.
    let freshPose = null, blendsRaw = null;
    if (faceRes && faceRes.landmarks) {
      freshPose = math.applyPoseCalibration(math.poseFromFace(faceRes.landmarks), cfg.calibration);
      blendsRaw = math.calibrateBlends(math.blendValues(faceRes.blends), cfg.calibration);
    }
    const haveFace = freshPose && (now - lastFaceAt) < 900;
    let base;
    if (haveFace) {
      base = freshPose;
    } else if (now - lastFaceAt < 1200 && pose.yaw !== 0) {
      // A few frames after the face disappears: ease the last pose to idle.
      base = { ...pose, detected: false, noseX: 0.5, noseY: 0.5, closeness: 1 };
    } else {
      base = math.idlePose(now, pose);
      blendsRaw = null;
    }
    const blinkEv = haveFace ? 0 : idleBlinkValue(now);
    const channels = blendsRaw || {};
    if (blinkEv > 0) {
      channels.eyeBlinkL = Math.max(channels.eyeBlinkL || 0, blinkEv);
      channels.eyeBlinkR = Math.max(channels.eyeBlinkR || 0, blinkEv);
    }
    if (talking && !haveFace) channels.jawOpen = Math.max(channels.jawOpen || 0, talkingRaw * 0.7);
    lastChannels = channels;
    const target = math.composePose(base, channels, talkingRaw, haveFace);
    const k = 1 - Math.pow(0.0001, 1 / Math.max(1, 16)); // ~0.24/frame at 24fps
    ['yaw', 'pitch', 'roll', 'closeness', 'noseX', 'noseY', 'blinkL', 'blinkR', 'blink', 'mouth', 'smile', 'browUp', 'browDown'].forEach(f => {
      pose[f] = pose[f] + (target[f] - pose[f]) * k;
    });
    // Tracked eye-midpoint + inter-eye span (for fitted 2D avatars). Drift to a
    // centered face when tracking is lost so the fit pivot stays sane.
    if (freshPose && freshPose.midX != null) {
      pose.midX += (freshPose.midX - pose.midX) * k;
      pose.midY += (freshPose.midY - pose.midY) * k;
      pose.eyeDist += ((freshPose.eyeDist || 0.13) - pose.eyeDist) * k;
    } else {
      pose.midX += (0.5 - pose.midX) * k * 0.2;
      pose.midY += (0.5 - pose.midY) * k * 0.2;
      pose.eyeDist += (0.13 - pose.eyeDist) * k * 0.2;
    }
    pose.talking = talking;
    pose.detected = haveFace;

    const drawPose = {
      yaw: pose.yaw, pitch: pose.pitch, roll: pose.roll, closeness: pose.closeness,
      noseX: pose.noseX, noseY: pose.noseY,
      midX: pose.midX, midY: pose.midY, eyeDist: pose.eyeDist,
      blink: pose.blink, mouth: pose.mouth, talking: pose.talking,
    };
    // Hands keep one-frame visibility refresh (they should not pop on/off).
    const handsNow = lastHands && lastHands.map(h => ({ ...h, visibleFrame: true }));

    // Calibration wizard view: show the camera with the tracked anchors instead
    // of the avatar so the user can verify where the tracker sees everything.
    if (cfg.rawOverlay) {
      lastHandRig = null;
      drawCalibrationOverlay(ctx, hiddenVideo, faceRes, lastHands);
      return;
    }

    if (cfg.mode === '2d') {
      lastHandRig = null;
      if (img) {
        drawAvatar2D(ctx, img, drawPose, handsNow && cfg.hands ? handsNow : null, now, cfg.hands, cfg.fit);
      } else {
        ctx.clearRect(0, 0, AV_OUT_W, AV_OUT_H);
        ctx.fillStyle = '#101018';
        ctx.fillRect(0, 0, AV_OUT_W, AV_OUT_H);
        ctx.fillStyle = '#8b8ba7';
        ctx.font = '16px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('Avatar preview unavailable', AV_OUT_W / 2, AV_OUT_H / 2);
      }
    } else if (g3) {
      if (g3.rigHas && g3.driveRig) {
        // Rigged model: the head / eyes / jaw bones carry the tracked motion;
        // the whole model only sways subtly so the body reads as alive.
        g3.driveRig(pose, channels, k);
        g3.group.rotation.y = -pose.yaw * Math.PI / 180 * 0.10;
        g3.group.rotation.x = pose.pitch * Math.PI / 180 * 0.06;
        g3.group.rotation.z = -pose.roll * Math.PI / 180 * 0.14;
      } else {
        // Head-follow fallback: rotate the whole model (robust for rigs whose
        // skeleton we cannot map); yaw sign mirrors the tracked face turn.
        g3.group.rotation.y = -pose.yaw * Math.PI / 180 * 0.85;
        g3.group.rotation.x = pose.pitch * Math.PI / 180 * 0.7;
        g3.group.rotation.z = -pose.roll * Math.PI / 180 * 0.6;
      }
      const idleBreath = 1 + Math.sin(now / 620) * 0.008;
      // “Closeness” = inter-eye distance: lean in and the avatar zooms closer.
      g3.group.scale.setScalar(idleBreath * (0.55 + 0.45 * pose.closeness));
      updateMorphs(channels, g3.morphs);
      if (cfg.hands) updateHandRig3D(g3, handsNow);
      lastHandRig = cfg.hands && g3 ? g3.handParts.map(part => ({
        visible: !!part.visible,
        joints: part.joints.map(j => ({ v: !!j.visible, x: j.position.x, y: j.position.y, z: j.position.z })),
      })) : null;
      g3.renderer.render(g3.scene, g3.camera);
      ctx.clearRect(0, 0, AV_OUT_W, AV_OUT_H);
      ctx.drawImage(g3.renderer.domElement, 0, 0);
    } else {
      ctx.clearRect(0, 0, AV_OUT_W, AV_OUT_H);
    }
  }

  // -- public surface --------------------------------------------------------
  const engine = {
    canvas, stream, track,
    get mode() { return cfg.mode; },
    get status() { return status; },
    get lastPose() { return { ...pose }; },
    get lastChannels() { return { ...lastChannels }; },
    get sourceEl() { return hiddenVideo; },
    get lastHands() { return lastHands ? lastHands.map(h => ({ label: h.label })) : null; },
    get handRig() { return lastHandRig; },
    get rigged() { return !!(g3 && g3.rigHas); },
    get rigInfo() { return g3 ? g3.rigInfo : null; },
    get rigPose() { return (g3 && g3.rig && g3.rig.last) ? { ...g3.rig.last } : null; },
    get hasTracker() { return !!mpTracker; },
    start,
    setEnabled,
    /** Swap mode/asset live (Settings preview). Returns a promise. */
    async setSource(nextMode, assetUrl) {
      cfg.mode = nextMode === '3d' ? '3d' : '2d';
      cfg.assetUrl = assetUrl || cfg.assetUrl;
      img = null; g3 = null; imgError = null; g3error = null;
      await loadSource();
    },
    async setHands(on) {
      cfg.hands = !!on;
      if (mpTracker && mpTracker.__recreate) { /* custom trackers manage their own */ }
    },
    setCameraStream(s) {
      cfg.cameraStream = s;
      if (hiddenVideo) hiddenVideo.srcObject = s;
    },
    setAudioStream(s) {
      cfg.audioStream = s;
      if (sensor) { try { sensor.close(); } catch {} }
      sensor = makeTalkingSensor(s);
    },
    /** One fresh, raw (uncalibrated) tracker snapshot for the wizard. */
    calibrationSample() {
      if (!mpTracker) return null;
      try {
        const res = mpTracker.detect();
        if (!res) return null;
        return {
          landmarks: res.landmarks || null,
          blends: res.blends || null,
          hands: res.hands || null,
          pose: res.landmarks ? math.poseFromFace(res.landmarks) : null,
        };
      } catch {
        return null;
      }
    },
    /** Apply (or clear with null) a saved calibration live. */
    setCalibration(cal) {
      cfg.calibration = cal || null;
    },
    async destroy() {
      destroyed = true;
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      try { sensor && sensor.close(); } catch {}
      try { mpTracker && mpTracker.dispose && await mpTracker.dispose(); } catch {}
      mpTracker = null;
      if (hiddenVideo) {
        try { hiddenVideo.srcObject = null; } catch {}
        try { hiddenVideo.remove(); } catch {}
        hiddenVideo = null;
      }
      if (g3) { try { g3.renderer.dispose(); } catch {} g3 = null; }
      try { cfg.cameraStream && cfg.cameraStream.getTracks().forEach(t => { try { t.stop(); } catch {} }); } catch {}
      try { track.stop(); } catch {}
    },
  };
  return engine;
}
