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
// Hand-tracking smoothing: MediaPipe's HandLandmarker occasionally drops a hand
// for a frame or two during fast signing (motion blur / occlusion). Without
// smoothing the rig flickers off and on with every miss. HAND_GRACE_MS holds the
// last smoothed pose through those short dropouts; HAND_SMOOTH_K eases joint
// positions toward each fresh detection so jitter and reconnects don't jump.
export const HAND_GRACE_MS = 200;
export const HAND_SMOOTH_K = 0.5;

export function smoothHandsNow(now, raw, handEMA) {
  for (const [label, e] of handEMA) {
    if ((now - e.seenAt) >= HAND_GRACE_MS) handEMA.delete(label);
  }
  const matched = new Set();
  if (raw) {
    for (const h of raw) {
      let e = handEMA.get(h.label);
      if (!e && handEMA.size) {
        // Label flip / mislabel: reuse the nearest in-grace hand's smoothed
        // state instead of teleporting the pose to a new identity.
        let best = null, bestD = Infinity;
        for (const [lab, cand] of handEMA) {
          if (matched.has(lab) || (now - cand.seenAt) >= HAND_GRACE_MS) continue;
          const j0 = cand.x[0];
          const d = (j0 == null || !h.landmarks[0]) ? Infinity
            : Math.hypot(h.landmarks[0].x - j0, h.landmarks[0].y - j0);
          if (d < bestD) { bestD = d; best = [lab, cand]; }
        }
        if (best) { handEMA.delete(best[0]); handEMA.set(h.label, best[1]); e = best[1]; }
      }
      if (!e) e = { seenAt: now, x: [], y: [], z: [] };   // first sighting: snap in
      handEMA.set(h.label, e);                          // register before smoothing
      e.seenAt = now;
      h.landmarks.forEach((pt, i) => {
        const z = pt.z == null ? 0 : pt.z;
        if (e.x[i] == null) { e.x[i] = pt.x; e.y[i] = pt.y; e.z[i] = z; }
        else {
          e.x[i] += (pt.x - e.x[i]) * HAND_SMOOTH_K;
          e.y[i] += (pt.y - e.y[i]) * HAND_SMOOTH_K;
          e.z[i] += (z - e.z[i]) * HAND_SMOOTH_K;
        }
      });
      matched.add(h.label);
    }
  }
  // Fresh hands first (raw order), held hands appended in insertion order.
  const out = [];
  if (raw) {
    for (const h of raw) {
      const e = handEMA.get(h.label);
      if (!e) continue;
      out.push({ label: h.label, landmarks: e.x.map((x, i) => ({ x, y: e.y[i], z: e.z[i] })) });
    }
  }
  for (const [label, e] of handEMA) {
    if (matched.has(label) || (now - e.seenAt) >= HAND_GRACE_MS) continue;
    out.push({ label, landmarks: e.x.map((x, i) => ({ x, y: e.y[i], z: e.z[i] })) });
  }
  return out.length ? out : null;
}

// Body-rig dropout grace: MediaPipe's Pose landmarker occasionally misses the
// body for a frame or two (occlusion, edge of frame, fast motion). Hold the last
// seen body frozen through BODY_GRACE_MS so the arms/torso rig doesn't flicker,
// then expire (hide) once the miss outlasts the window. Fresh detections snap in
// immediately and replace the hold. `state` is a small mutable object
// ({ last, seenAt }) owned by the engine; pass a fresh object to reset.
export const BODY_GRACE_MS = 250;

export function smoothBodyNow(now, raw, state) {
  if (raw) {
    state.last = raw;
    state.seenAt = now;
    return raw;
  }
  if (state.last && (now - state.seenAt) < BODY_GRACE_MS) return state.last; // frozen hold
  state.last = null;                                                          // expired -> hide
  return null;
}

// Face-pose dropout grace: MediaPipe's FaceLandmarker misses frames far more
// often than it loses the user entirely (motion blur, partial occlusion, a
// hand across the cheek). The original implementation baked two magic numbers
// into step(): a 900ms "have face" TTL and a 1200ms ease-to-idle window. This
// pure function makes the same behavior an explicit three-phase state machine
// so the lifecycle is testable and the phases have names:
//   'live'   - fresh detection inside the live window: drive the pose.
//   'hold'   - detection just dropped: freeze the last pose (no flicker).
//   'easing' - dropout persisting: ease the frozen pose toward idle instead
//              of snapping.
//   expired  - gone for good: the engine switches to the idle animation.
// `state` is a small mutable object ({ pose, seenAt }) owned by the engine.
export const FACE_LIVE_MS = 900;
export const FACE_EASE_MS = 1200;

export function faceGracePhase(now, freshPose, state) {
  if (freshPose) {
    state.pose = freshPose;
    state.seenAt = now;
    return 'live';
  }
  if (state.pose && (now - state.seenAt) < FACE_LIVE_MS) return 'hold';
  if (state.pose && (now - state.seenAt) < FACE_LIVE_MS + FACE_EASE_MS) return 'easing';
  state.pose = null; // gone long enough: clear so a stale face can't resurrect
  return 'idle';
}

const ML_BASE = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL
  ? String(import.meta.env.BASE_URL).replace(/\/+$/, '')
  : '') + '/ml';

let libsPromise = null;
// Test-only seam: lets unit tests inject a fake @mediapipe/tasks-vision + three
// so createMediaPipeTracker's detect() normalization can be exercised in plain
// node without real wasm/GPU (see test/landmark-scaling.test.js). Passing null
// restores normal lazy loading.
export function __setTrackerLibsForTest(libs) {
  libsPromise = libs ? Promise.resolve(libs) : null;
}
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
export async function createMediaPipeTracker({ video, wantHands, wantBody, onStatus, delegate }) {
  const { tv } = await loadLibs();
  let wasm;
  try {
    wasm = await tv.FilesetResolver.forVisionTasks(ML_BASE + '/wasm');
  } catch (err) {
    throw new Error('Could not load the tracking engine (' + (err && err.message ? err.message : 'network') + ') — the avatar still runs, but without face/hand animation.');
  }
  // delegate: 'GPU' (default, fastest on real devices) | 'CPU'. CPU is forced by
  // headless/CI callers (scripts/body-rig-verify) because a SwiftShader WebGL
  // context lets the GPU delegate CREATE successfully but then silently produce
  // no detections — explicit CPU keeps the graph honest and deterministic.
  const want = delegate || 'GPU';
  const make = async (Model, opts) => {
    const attempt = d => Model.createFromOptions(wasm, { ...opts, baseOptions: { ...(opts.baseOptions || {}), delegate: d } });
    try {
      return await attempt(want);
    } catch {
      return attempt('CPU');
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
  let pose = null;
  if (wantBody) {
    try {
      pose = await make(tv.PoseLandmarker, {
        baseOptions: { modelAssetPath: ML_BASE + '/pose_landmarker.task' },
        runningMode: 'VIDEO', numPoses: 1,
      });
    } catch { pose = null; }
  }
  const vid = video;
  const ts = () => Math.max(0, performance.now());
  return {
    detect() {
      let faceRes = null, handsRes = null, bodyRes = null;
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
      if (pose) {
        try { bodyRes = pose.detectForVideo(vid, ts()); } catch {}
        if (bodyRes && bodyRes.landmarks && bodyRes.landmarks.length) {
          out = out || {};
          out.body = bodyRes.landmarks[0].map(pt => ({ x: pt.x, y: pt.y, z: pt.z }));   // 33 normalized landmarks
        }
      }
      return out;
    },
    async dispose() {
      try { face.close(); } catch {}
      try { hand && hand.close(); } catch {}
      try { pose && pose.close(); } catch {}
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
function drawAvatar2D(ctx, img, p, hands, t, wantHands, fit, body, bodyCal) {
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
    const scale = Math.max(0.1, targetEye / adist) * 1.05 * closeness * (p.zoom != null ? p.zoom : 1);
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
    const base = Math.min(W / iw, H / ih) * (p.zoom != null ? p.zoom : 1);
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
  if (body && body.length >= 12) drawBody2D(ctx, body, bodyCal);
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

// Tracked-body 2D skeleton: shoulder line, both arms, and the torso/hip frame.
// Uses MediaPipe Pose landmark indices (11/12 shoulders, 13/14 elbows,
// 15/16 wrists, 23/24 hips).
const BODY_PAIRS = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24]];
function drawBody2D(ctx, body, bodyCal) {
  ctx.save();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(52,211,153,0.95)';
  ctx.fillStyle = 'rgba(52,211,153,0.95)';
  // Same 8-slot rig the 3D path uses; bodyCal (when present) drives the arms
  // through the user's calibrated raise/out — identical motion on every avatar.
  const rig = math.bodyRigPoints2D(body, bodyCal, AV_OUT_W, AV_OUT_H);
  if (!rig) { ctx.restore(); return; }
  const SLOTS = [0, 1, 2, 3, 4, 5, 6, 7];
  const PAIRS = [[0, 2], [2, 4], [1, 3], [3, 5], [0, 1], [0, 6], [1, 7], [6, 7]];
  PAIRS.forEach(([a, b]) => {
    if (!rig[a] || !rig[b]) return;
    ctx.beginPath();
    ctx.moveTo(rig[a].x, rig[a].y);
    ctx.lineTo(rig[b].x, rig[b].y);
    ctx.stroke();
  });
  SLOTS.forEach(i => {
    const pt = rig[i];
    if (!pt) return;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 3.4, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}

// Calibration wizard view: the raw (mirrored) camera with the tracked anchors
// drawn on top, so the user can see exactly where the tracker thinks their
// eyes, pupils, mouth and hands are — and verify before saving.
function drawCalibrationOverlay(ctx, video, face, hands, body) {
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
  if (body && body.length) {
    const pts = body.map(pt => ({ x: X(pt.x), y: Y(pt.y) }));
    ctx.strokeStyle = 'rgba(52,211,153,0.9)'; ctx.fillStyle = 'rgba(52,211,153,0.9)'; ctx.lineWidth = 2.5;
    BODY_PAIRS.forEach(([a, b]) => {
      if (!pts[a] || !pts[b]) return;
      ctx.beginPath(); ctx.moveTo(pts[a].x, pts[a].y); ctx.lineTo(pts[b].x, pts[b].y); ctx.stroke();
    });
    [11, 12, 13, 14, 15, 16, 23, 24].forEach(i => {
      if (!pts[i]) return;
      ctx.beginPath(); ctx.arc(pts[i].x, pts[i].y, 3.2, 0, Math.PI * 2); ctx.fill();
    });
  }
}

// ---------------------------------------------------------------------------
// 3D renderer (three.js, lazy)
// ---------------------------------------------------------------------------
const CAM_Z = 3.1;
const HAND_Z = 2.35;
const BODY_Z = 1.95;   // tracked-body plane sits between the avatar and the hands

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
  const rig = { has: {}, bone: {}, base: {}, fingers: {}, fingerBase: {}, hairBones: [], sm: { hY: 0, hP: 0, hR: 0, nY: 0, nP: 0, eY: 0, eP: 0, jaw: 0 } };
  const rigEuler = new three.Euler(0, 0, 0, 'YXZ');
  const rigQuat = new three.Quaternion();
  const MORPHISH = /morph|blend|shape|offset/i;   // guard: never rig a morph-target dummy
  root.traverse(obj => {
    if (!obj.isBone) return;
    // Hair / cloth / accessory chains: bones named like hair/skirt/coat/tail
    // become spring chains anchored at their parent bone (secondary motion).
    // MUST be checked before the classifier early-return: VRoid exports its
    // physics bones as J_Sec_* (Hair/Skirt/Hood/Bust/Sleeve…), which
    // classifyRigBone doesn't know — checking after that return silently
    // disabled gravity physics on every VRM.
    const nm = (obj.name || '').toLowerCase();
    if (/hair|bang|ponytail|twintail|skirt|coat|cape|tail|scarf|ribbon|tie|hood|bust|sleeve|frill/.test(nm) && !obj.name.match(MORPHISH)) {
      rig.hairBones.push(obj);
      return;
    }
    const cls = math.classifyRigBone(obj.name || obj.userData?.name || '');
    if (!cls) return;
    if (cls.role === 'finger') {
      // fingers: 3 phalanges x 5 fingers x 2 sides, keyed L-index-2 etc.
      const key = cls.side + '-' + cls.finger + '-' + cls.ph;
      if (!rig.fingers[key]) { rig.fingers[key] = obj; rig.fingerBase[key] = obj.quaternion.clone(); }
      return;
    }
    if (cls.role === 'tongue') { if (!rig.bone.tongue) { rig.bone.tongue = obj; rig.base.tongue = obj.quaternion.clone(); } return; }
    if (cls.role === 'lip') {
      const key = 'lip' + (cls.part ? '_' + cls.part : '') + (cls.side || '');
      if (!rig.bone[key]) { rig.bone[key] = obj; rig.base[key] = obj.quaternion.clone(); }
      return;
    }
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
  // ── Secondary motion (hair / cloth): one spring chain per top-level ──────
  // hair/cloth bone, hanging from it. Chain tips nudge their bone's rotation
  // so ponytails/skirts sway when the head moves. strength 0..1 = the user's
  // gravity slider (0 freezes chains at rest).
  const springChains = [];
  {
    const seen = new Set();
    for (const bone of rig.hairBones) {
      // Only top-level hair/cloth bones start a chain (skip ones whose parent
      // is also a hair bone) so long braid hierarchies get one chain, not 12.
      let p = bone.parent;
      let isChild = false;
      while (p) { if (rig.hairBones.includes(p)) { isChild = true; break; } p = p.parent; }
      if (isChild) continue;
      const n = 4, segLen = 0.05;
      springChains.push({ bone, chain: math.createSpringChain(n, segLen), base: bone.quaternion.clone() });
      seen.add(bone);
    }
  }
  let gravityStrength = 0.5;   // setup3D-local copy of the user slider (synced via setGravity)
  let lastRigTime = 0;
  const rigWorld = new three.Vector3();
  const rigRootInv = new three.Quaternion();
  const rigRootMat = new three.Matrix4();

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
    // Tongue: tongueOut channel curls the tongue bone down/forward slightly.
    if (rig.bone.tongue) {
      const t = Math.min(1, channels.tongueOut || 0) * 0.5;
      sm.tongue += (t - sm.tongue) * k;
      rigEuler.set(sm.tongue, 0, 0, 'YXZ');
      rig.bone.tongue.quaternion.copy(rig.base.tongue).multiply(rigQuat.setFromEuler(rigEuler));
    }
    // Lips: upper lip rises with smile, lower lip drops with jaw/mouth open.
    // Only drive when the model has no mouth morphs (same no-double-drive rule).
    const hasMouthMorph = rigMorphCats.has('mouthSmileL') || rigMorphCats.has('jawOpen');
    if (!hasMouthMorph) {
      const smile = Math.min(1, channels.mouthSmileL || channels.mouthSmile || 0);
      const open = Math.min(1, channels.jawOpen || 0);
      ['lip', 'lip_upper', 'lip_lower'].forEach(lk => {
        const b = rig.bone[lk];
        if (!b) return;
        const isUpper = lk.includes('upper');
        const target = isUpper ? smile * 0.22 - open * 0.08 : -open * 0.2;
        const sk = 'sm_' + lk;
        sm[sk] = (sm[sk] || 0) + (target - sm[sk]) * k;
        rigEuler.set(sm[sk], 0, 0, 'YXZ');
        b.quaternion.copy(rig.base[lk]).multiply(rigQuat.setFromEuler(rigEuler));
      });
    }
    // Fingers: curl each tracked finger chain from its hand landmarks — the
    // landmark's ring flex (distance from knuckle 0 to mid-joints shrinking)
    // becomes a per-finger curl angle applied at phalange 1 (mostly) and 2.
    if (rig.lastHands && rig.lastHands.length) {
      const SIDE_KEY = { Right: 'L', Left: 'R' };   // mirrored camera space
      for (const hand of rig.lastHands) {
        const side = SIDE_KEY[hand.label] || 'L';
        const L = hand.landmarks || [];
        // per-finger knuckle/mid/tip landmark indices in MediaPipe order
        const FINGER_JOINTS = { thumb: [1, 2, 3, 4], index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16], pinky: [17, 18, 19, 20] };
        for (const [fname, jidx] of Object.entries(FINGER_JOINTS)) {
          const [knuckle, mid, , tip] = jidx;
          if (!L[knuckle] || !L[mid] || !L[tip]) continue;
          // straightness: knuckle->mid vs knuckle->tip distance ratio (~1 straight, <1 curled)
          const dKM = Math.hypot(L[mid].x - L[knuckle].x, L[mid].y - L[knuckle].y);
          const dKT = Math.hypot(L[tip].x - L[knuckle].x, L[tip].y - L[knuckle].y) || 1e-6;
          const straight = Math.min(1, Math.max(0, (dKM / dKT - 0.55) / 0.45));
          const curl = 1 - straight;   // 0 straight .. 1 fist
          for (let ph = 1; ph <= 3; ph++) {
            const b = rig.fingers[side + '-' + fname + '-' + ph];
            if (!b) continue;
            const gain = ph === 1 ? 1.1 : ph === 2 ? 0.9 : 0.5;
            const sk = 'f_' + side + fname + ph;
            sm[sk] = (sm[sk] || 0) + (curl * 1.15 * gain - sm[sk]) * k;
            rigEuler.set(0, 0, -sm[sk] * RIG_DEG * 10, 'YXZ');   // curl around local Z
            b.quaternion.copy(rig.fingerBase[side + '-' + fname + '-' + ph]).multiply(rigQuat.setFromEuler(rigEuler));
          }
        }
      }
    }
    rig.last = {
      yaw: sm.hY, pitch: sm.hP, roll: sm.hR,
      eyeYaw: sm.eY, eyePitch: sm.eP, jaw: sm.jaw,
      eyeL: driveEyes, jawBone: driveJaw,
      fingers: !!rig.lastHands,
    };
    // Spring chains (hair/cloth): pin the root to the bone's world position,
    // integrate gravity*strength, then convert the tip's lateral sag into a
    // small bone rotation so the sway is visible on the model.
    const nowMs = performance.now();
    const dt = Math.min(0.05, Math.max(0.001, (nowMs - (lastRigTime || nowMs - 42)) / 1000));
    lastRigTime = nowMs;
    for (const sc of springChains) {
      if (gravityStrength <= 0) {
        sc.bone.quaternion.copy(sc.base);   // slider at 0: rest pose
        continue;
      }
      sc.bone.getWorldPosition(rigWorld);
      const rootInv = rigRootInv.setFromRotationMatrix(rigRootMat.copy(sc.bone.parent.matrixWorld).invert());
      const lx = rigWorld.x, ly = rigWorld.y, lz = rigWorld.z;
      math.stepSpringChain(sc.chain, lx, ly, lz, dt, gravityStrength, -sm.hY * 0.02);
      // tip offset (world) -> local sway direction
      const tip = sc.chain.pts[sc.chain.pts.length - 1];
      const swayX = Math.max(-1, Math.min(1, (tip.x - lx) * 8));
      const swayZ = Math.max(-1, Math.min(1, (tip.z - lz) * 8));
      rigEuler.set(swayZ * 0.3, 0, -swayX * 0.3, 'YXZ');
      sc.bone.quaternion.copy(sc.base).multiply(rigQuat.setFromEuler(rigEuler));
    }
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

  // Tracked-body rig: one translucent “digital suit” for the shoulders, arms
  // and hips (8 joints + connecting bones) so the model visibly responds to
  // the wearer's body, not only their face and hands.
  const bodyGroup = new three.Group();
  bodyGroup.renderOrder = 16;
  scene.add(bodyGroup);
  const bodyParts = [];
  {
    const joints = [], bones = [];
    const mat = new three.MeshBasicMaterial({
      color: 0x34d399, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false,
    });
    for (let i = 0; i < 8; i++) {
      const j = new three.Mesh(jointGeo, mat);
      joints.push(j);
      bodyGroup.add(j);
    }
    for (let i = 0; i < 8; i++) {
      const b = new three.Mesh(boneGeo, mat);
      bones.push(b);
      bodyGroup.add(b);
    }
    bodyParts.push({ joints, bones, mat, visible: false });
  }

  return {
    renderer, scene, camera, group, morphs, hasMorphs, handGroup, handParts, bodyGroup, bodyParts,
    rig, rigHas, rigInfo, driveRig,
    hairChains: springChains.length,
    /** Sync the user's gravity slider into this model's spring simulation. */
    setGravity(v) { gravityStrength = Math.min(1, Math.max(0, Number(v) || 0)); },
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

// MediaPipe Pose slots we rig: [left shoulder, right shoulder, left elbow,
// right elbow, left wrist, right wrist, left hip, right hip].
const BODY_SLOT_INDICES = [11, 12, 13, 14, 15, 16, 23, 24];
const BODY_SLOT_BONES = [[0, 2], [2, 4], [1, 3], [3, 5], [0, 1], [0, 6], [1, 7], [6, 7]];
function updateBodyRig3D(rig, body, bodyCal) {
  const halfH = Math.tan((42 * Math.PI / 180) / 2) * (CAM_Z - BODY_Z);
  const halfW = halfH * (AV_OUT_W / AV_OUT_H);
  const up = rig.yAxis, dir = rig.dir, a = rig.v1, b = rig.v2;
  const part = rig.bodyParts[0];
  if (!part) return;
  const pts = body && body.length >= 25 ? body : null;   // needs at least shoulders + hips
  if (!pts) {
    if (part.visible) { part.joints.forEach(j => { j.visible = false; }); part.bones.forEach(x => { x.visible = false; }); part.visible = false; }
    return;
  }
  part.visible = true;
  const world = (pt, out) => {
    out.set((pt.x - 0.5) * 2 * halfW, (0.5 - pt.y) * 2 * halfH, BODY_Z);
    return out;
  };
  if (bodyCal) {
    // Calibrated arms: shoulders + hips anchor the torso at their raw tracked
    // positions; elbows/wrists are placed from the user's normalized raise/out
    // around each shoulder (scaled by neutral arm length x torso scale), so
    // full captured reach = full avatar reach regardless of the user's build
    // or distance from the camera. Left arm spreads toward -x, right toward +x.
    BODY_SLOT_INDICES.forEach((lmIdx, slot) => {
      world(pts[lmIdx], a);
      part.joints[slot].position.copy(a);
      part.joints[slot].visible = true;
    });
    const lenWorld = len => len * 2 * halfH * (bodyCal.torsoScale || 1);
    const armSlot = (shoulderSlot, elbowSlot, wristSlot, arm, side) => {
      const sh = part.joints[shoulderSlot].position;
      const len = lenWorld(arm.len);
      const L = side === 'l' ? -1 : 1;
      part.joints[wristSlot].position.set(sh.x + arm.out * len * L, sh.y + arm.raise * len, BODY_Z);
      part.joints[wristSlot].visible = true;
      part.joints[elbowSlot].position.set(sh.x + arm.out * len * 0.55 * L, sh.y + arm.raise * len * 0.55, BODY_Z);
      part.joints[elbowSlot].visible = true;
    };
    armSlot(0, 2, 4, { out: bodyCal.armL.out, raise: bodyCal.armL.raise, len: bodyCal.lenL }, 'l');
    armSlot(1, 3, 5, { out: bodyCal.armR.out, raise: bodyCal.armR.raise, len: bodyCal.lenR }, 'r');
  } else {
    BODY_SLOT_INDICES.forEach((lmIdx, slot) => {
      world(pts[lmIdx], a);
      part.joints[slot].position.copy(a);
      part.joints[slot].visible = true;
    });
  }
  BODY_SLOT_BONES.forEach(([s0, s1], bi) => {
    a.copy(part.joints[s0].position);
    b.copy(part.joints[s1].position);
    a.lerp(b, 0.5).copy(part.bones[bi].position);
    dir.subVectors(b, a);
    const len = dir.length() || 1e-6;
    part.bones[bi].scale.set(1, len, 1);
    part.bones[bi].quaternion.setFromUnitVectors(up, dir.normalize());
    part.bones[bi].visible = true;
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
    body: opts.body !== false,
    smoothHands: opts.smoothHands !== false,
    audioStream: opts.audioStream || null,
    cameraStream: opts.cameraStream || null,
    videoSrc: opts.videoSrc || null,   // recorded clip drives MediaPipe (verification / no webcam)
    tracker: opts.tracker || null,          // { detect() -> {landmarks,blends,hands} } (tests)
    calibration: opts.calibration || null,   // per-user neutral pose + expression ranges
    rawOverlay: !!opts.rawOverlay,           // calibration wizard: show camera + tracked anchors
    fit: opts.fit || null,                   // 2D avatar feature anchors {leftEye:{x,y},rightEye:{x,y}}
    gravity: typeof opts.gravity === 'number' ? Math.min(1, Math.max(0, opts.gravity)) : 0.5,   // hair/cloth spring strength
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
  let faceGrace = { pose: null, seenAt: 0 };   // face-pose dropout-grace state (see faceGracePhase)
  let nextBlinkAt = performance.now() + 2500;
  const pose = { yaw: 0, pitch: 0, roll: 0, closeness: 1, noseX: 0.5, noseY: 0.5, midX: 0.5, midY: 0.5, eyeDist: 0.13, blinkL: 0, blinkR: 0, blink: 0, mouth: 0, smile: 0, browUp: 0, browDown: 0, talking: false };
  let lastHands = null;          // raw hands from the latest detect frame (wizard + mirrors)
  let handEMA = new Map();       // label -> smoothed per-joint display state (see smoothHandsNow)
  let lastChannels = {};
  let lastHandRig = null;   // observability mirror of the 3D hand rig (harness tests)
  let lastBody = null;      // 33 normalized MediaPipe Pose landmarks (body)
  let bodyState = { last: null, seenAt: 0 };  // dropout-grace state (see smoothBodyNow)
  let lastBodyRig = null;   // observability mirror of the 3D body rig (harness tests)
  let lastBodyPose = null;
  // Air-pointer gesture state (zoom window summoned by pointing at the camera).
  // One instance per engine; the pure state machine in avatar-math owns the
  // transitions, the engine feeds it frames and draws the result.
  let viewZoom = 1;
  let gravityStrength = cfg.gravity;   // user slider 0..1 (set via setGravityStrength) — engine scope: loadSource + the slider both write it
  let framesDrawn = 0;   // rendered-frame counter (VRM harness / observability)
  let lastPointer = null;
  let lastPtrAction = null;
  let lastPtrActionSeq = 0;
  const pointerState = { phase: 'hidden', x: 0.5, y: 0.4, holdStart: 0, lastSeenAt: 0, wasInside: false, flash: null, dismissed: false, now: 0 };  // calibrated arm/torso state (null when uncalibrated)

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
        mpTracker = await createMediaPipeTracker({ video: hiddenVideo, wantHands: cfg.hands, wantBody: cfg.body, onStatus: setStatus });
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
      mpTracker = await createMediaPipeTracker({ video: hiddenVideo, wantHands: cfg.hands, wantBody: cfg.body, onStatus: setStatus });
      setStatus('tracking');
    } catch (err) {
      mpTracker = null;
      if (typeof console !== 'undefined') console.error('[initTracker]', err && (err.stack || err.message || err));
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
        g3.setGravity(gravityStrength);
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
    let lastStepErr = '';
    const loop = () => {
      if (destroyed || !running) return;
      try { step(); } catch (e) {
        // A tracker hiccup must never kill the call, but a persistent engine
        // fault should not stay invisible either — log each distinct one once.
        const msg = e && e.message ? e.message : String(e);
        if (msg !== lastStepErr) { lastStepErr = msg; if (typeof console !== 'undefined') console.error('[avatar step]', msg); }
      }
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

  // Temporal hand smoothing for the DISPLAY path. The raw `lastHands` still
  // feeds the calibration wizard untouched, so calibration shows live truth.
  // Per-hand state is keyed by handedness label so a brief single-hand dropout
  // never blanks the other hand or swaps Left/Right identity. Display hands are
  // frozen (not extrapolated) while a hand is inside the grace window — freezing
  // reads as motion blur, while blanking reads as flicker.
  function step() {
    const now = performance.now();
    let faceRes = null;
    if (mpTracker) {
      try {
        const res = mpTracker.detect();
        if (res) {
          faceRes = res;
          lastHands = (res.hands && res.hands.length) ? res.hands : null;
          if (res.body) { lastBody = res.body; }
          if (res.landmarks) lastFaceAt = now;   // (observability mirror; grace tracks its own seenAt)
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
    // Face-pose dropout grace (explicit phases instead of two magic TTLs):
    // 'live' drives the pose, 'hold' freezes it across a missed frame,
    // 'easing' hands back the frozen pose to ease toward idle, 'idle' is the
    // synthetic animation. haveFace stays true through live+hold so
    // expressions/blink logic don't flap during a brief dropout.
    const facePhase = faceGracePhase(now, freshPose, faceGrace);
    const haveFace = facePhase === 'live' || facePhase === 'hold';
    let base;
    if (facePhase === 'live') {
      base = freshPose;
    } else if (facePhase === 'hold') {
      base = faceGrace.pose;   // frozen last pose (identical fields to freshPose)
    } else if (facePhase === 'easing' && pose.yaw !== 0) {
      // Dropout persisting: ease the last pose to idle instead of snapping.
      base = { ...faceGrace.pose, detected: false, noseX: 0.5, noseY: 0.5, closeness: 1 };
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
      zoom: viewZoom,
    };
    // Hands keep one-frame visibility refresh (they should not pop on/off).
    // Display hands: smoothed (EMA + grace hold) so fast signing never flickers
    // the rig during MediaPipe dropouts. Passing null hides the rig instantly —
    // the toggle-off path stays immediate.
    let handsNow = null;
    if (cfg.hands) {
      const disp = smoothHandsNow(now, lastHands, handEMA);
      if (disp) {
        handsNow = disp;
        for (const h of handsNow) h.visibleFrame = true;
      }
    }
    // Body-rig dropout grace: a fresh Pose detection snaps in immediately; a
    // missed frame holds the last body frozen through BODY_GRACE_MS (the same
    // hold the hand rig gets) so arms/torso don't flicker on MediaPipe hiccups.
    const freshBody = (faceRes && faceRes.body) ? faceRes.body : null;
    const bodyNow = cfg.body ? smoothBodyNow(now, freshBody, bodyState) : null;
    const bodyPose = bodyNow ? math.applyBodyCalibration(bodyNow, cfg.calibration) : null;
    lastBodyPose = bodyPose;

    // Air-pointer gesture: point at the camera to summon the floating control
    // window. Evaluated on the display hands (same grace-hold as the drawn
    // rig) so a dropped frame never blinks the window away. viewZoom scales
    // the avatar in BOTH draw paths; the window itself draws unscaled on top.
    let pointingPtr = null;
    if (cfg.hands && handsNow) {
      for (const h of handsNow) {
        if (math.isPointGesture(h.landmarks)) {
          const tip = h.landmarks[8];
          pointingPtr = { x: tip.x, y: tip.y, hand: h.label };
          break;
        }
      }
    }
    const ptrEv = pointingPtr
      ? { pointing: true, x: pointingPtr.x, y: pointingPtr.y, now, viewZoom }
      : { pointing: false, now, viewZoom };
    const ptrRes = math.stepPointerGesture(pointerState, ptrEv);
    viewZoom = ptrRes.viewZoom;
    pointerState.now = now;
    // The fired action is momentary (one frame); expose it sticky so UI/tests
    // polling never miss a dwell-click. Cleared when the gesture re-arms, and
    // actionSeq counts fires monotonically for change detection.
    if (ptrRes.action) { lastPtrAction = ptrRes.action; lastPtrActionSeq++; }
    if (pointerState.phase === 'counting' && !pointerState.lastHit) lastPtrAction = null;
    lastPointer = { phase: pointerState.phase, action: lastPtrAction, actionSeq: lastPtrActionSeq, hand: pointingPtr ? pointingPtr.hand : null };

    // Calibration wizard view: show the camera with the tracked anchors instead
    // of the avatar so the user can verify where the tracker sees everything.
    if (cfg.rawOverlay) {
      lastHandRig = null;
      lastBodyRig = null;
      drawCalibrationOverlay(ctx, hiddenVideo, faceRes, lastHands, bodyNow);
      return;
    }

    if (cfg.mode === '2d') {
      lastHandRig = null;
      lastBodyRig = null;
      if (img) {
        drawAvatar2D(ctx, img, drawPose, handsNow && cfg.hands ? handsNow : null, now, cfg.hands, cfg.fit, cfg.body ? bodyNow : null, cfg.body ? bodyPose : null);
      } else {
        ctx.clearRect(0, 0, AV_OUT_W, AV_OUT_H);
        ctx.fillStyle = '#101018';
        ctx.fillRect(0, 0, AV_OUT_W, AV_OUT_H);
        ctx.fillStyle = '#8b8ba7';
        ctx.font = '16px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('Avatar preview unavailable', AV_OUT_W / 2, AV_OUT_H / 2);
      }
      // Gesture window draws ON TOP of the avatar, unscaled, in canvas space.
      math.drawPointerWindow(ctx, pointerState, { W: AV_OUT_W, H: AV_OUT_H, zoom: viewZoom });
      framesDrawn++;
    } else if (g3) {
      if (g3.rigHas && g3.driveRig) {
        // Hands reach the finger curl driver through the rig object.
        g3.rig.lastHands = cfg.hands ? handsNow : null;
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
      g3.group.scale.setScalar(idleBreath * (0.55 + 0.45 * pose.closeness) * viewZoom);
      updateMorphs(channels, g3.morphs);
      // Passing null (toggle-off or no tracking) makes the driver HIDE the rig
      // meshes — otherwise a previously-visible glove/suit lingers on screen.
      updateHandRig3D(g3, cfg.hands ? handsNow : null);
      lastHandRig = g3 && g3.handParts ? g3.handParts.map(part => ({
        visible: !!part.visible,
        joints: part.joints.map(j => ({ v: !!j.visible, x: j.position.x, y: j.position.y, z: j.position.z })),
      })) : null;
      updateBodyRig3D(g3, cfg.body ? bodyNow : null, bodyPose);
      lastBodyRig = g3 && g3.bodyParts ? g3.bodyParts.map(part => ({
        visible: !!part.visible,
        joints: part.joints.map(j => ({ v: !!j.visible, x: j.position.x, y: j.position.y, z: j.position.z })),
      })) : null;
      g3.renderer.render(g3.scene, g3.camera);
      ctx.clearRect(0, 0, AV_OUT_W, AV_OUT_H);
      ctx.drawImage(g3.renderer.domElement, 0, 0);
      math.drawPointerWindow(ctx, pointerState, { W: AV_OUT_W, H: AV_OUT_H, zoom: viewZoom });
      framesDrawn++;
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
    get lastBody() { return lastBody ? lastBody.map(pt => ({ x: pt.x, y: pt.y })) : null; },
    get bodyRig() { return lastBodyRig; },
    get lastBodyPose() { return lastBodyPose ? { ...lastBodyPose, armL: { ...lastBodyPose.armL }, armR: { ...lastBodyPose.armR } } : null; },
    get rigged() { return !!(g3 && g3.rigHas); },
    get rigInfo() { return g3 ? g3.rigInfo : null; },
    get rigPose() { return (g3 && g3.rig && g3.rig.last) ? { ...g3.rig.last } : null; },
    /** Counts for the VRM regression harness: mapped morph targets and hair/cloth spring chains. */
    get morphCount() { return g3 && g3.morphs ? g3.morphs.length : 0; },
    get hairChainCount() { return g3 ? (g3.hairChains != null ? g3.hairChains : 0) : 0; },
    get framesRendered() { return framesDrawn; },
    get hasTracker() { return !!mpTracker; },
    /** Air-pointer gesture window: current phase ('hidden'/'counting'/'shown') + last fired action. */
    get pointer() { return lastPointer ? { ...lastPointer } : null; },
    get viewZoom() { return viewZoom; },
    setViewZoom(z) { viewZoom = math.clampZoom(Number(z) || 1); },
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
    async setBody(on) {
      cfg.body = !!on;
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
          // Canonical keyed channels (faceBlendshapes categories decoded), the
          // shape the calibration wizard's captures expect — one blends shape
          // for every consumer of the tracker.
          blends: res.blends ? math.blendValues(res.blends) : null,
          hands: res.hands || null,
          body: res.body || null,
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
    /** Hair/cloth spring strength 0..1 (0 freezes secondary motion at rest). */
    setGravityStrength(v) {
      gravityStrength = Math.min(1, Math.max(0, Number(v) || 0));
      cfg.gravity = gravityStrength;
      if (g3 && g3.setGravity) g3.setGravity(gravityStrength);
    },
    get gravityStrength() { return gravityStrength; },
    async destroy() {
      destroyed = true;
      running = false;
      handEMA.clear();
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
