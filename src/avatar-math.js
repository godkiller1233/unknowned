// avatar-math.js — pure, dependency-free math for the avatar virtual camera.
// Everything here works in Node (no DOM/WebGL) so it is unit-testable against
// synthetic landmarks and known blendshape-name conventions.

export const clamp = (v, lo = 0, hi = 1) => v < lo ? lo : v > hi ? hi : v;
export const lerp = (a, b, t) => a + (b - a) * t;

/** MediaPipe face landmark indices we rely on (canonical 468-point ordering). */
export const FACE = {
  leftEyeOuter: 33,
  rightEyeOuter: 263,
  leftEyeInner: 133,
  rightEyeInner: 362,
  leftCheek: 234,
  rightCheek: 454,
  noseTip: 1,
  chin: 152,
  forehead: 10,
};

// ---------------------------------------------------------------------------
// Blendshapes → canonical channels
// ---------------------------------------------------------------------------
// MediaPipe FaceLandmarker reports ARKit-style blendshape categories; canonical
// channels below are what renderers actually consume.
export const CATS = [
  'browDownL', 'browDownR', 'browInnerUp', 'browOuterUpL', 'browOuterUpR',
  'cheekPuffL', 'cheekPuffR', 'cheekSquintL', 'cheekSquintR',
  'eyeBlinkL', 'eyeBlinkR', 'eyeLookUpL', 'eyeLookUpR', 'eyeLookDownL', 'eyeLookDownR',
  'eyeLookInL', 'eyeLookInR', 'eyeLookOutL', 'eyeLookOutR', 'eyeSquintL', 'eyeSquintR',
  'eyeWideL', 'eyeWideR',
  'jawForward', 'jawLeft', 'jawOpen', 'jawRight',
  'mouthClose', 'mouthDimpleL', 'mouthDimpleR', 'mouthFrownL', 'mouthFrownR',
  'mouthFunnel', 'mouthLeft', 'mouthLowerDownL', 'mouthLowerDownR',
  'mouthPressL', 'mouthPressR', 'mouthPucker', 'mouthRight',
  'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
  'mouthSmileL', 'mouthSmileR', 'mouthStretchL', 'mouthStretchR',
  'mouthUpperUpL', 'mouthUpperUpR', 'noseSneerL', 'noseSneerR', 'tongueOut',
];

/**
 * Canonical channel id lookup. MediaPipe/ARKit spell sides out in full
 * (eyeBlinkLeft, browDownRight…) while our canonical ids are short (eyeBlinkL).
 * Accept both spellings (and the _neutral pseudo-blendshape is ignored).
 */
const CAT_LOOKUP = {};
CATS.forEach(c => {
  const low = c.toLowerCase();
  CAT_LOOKUP[low] = c;
  if (low.endsWith('l')) CAT_LOOKUP[low.slice(0, -1) + 'left'] = c;
  if (low.endsWith('r')) CAT_LOOKUP[low.slice(0, -1) + 'right'] = c;
});
CAT_LOOKUP['_neutral'] = null;

/**
 * Take a MediaPipe blendshapes array (categories with `categoryName` + `score`)
 * and return a map of canonical channel → 0..1, with mirrored channels
 * averaged into simple fields the renderers use (blink, mouth, smile, brow).
 */
export function blendValues(categories) {
  const raw = {};
  if (!categories) return raw;
  if (!Array.isArray(categories)) {
    // Already-keyed map (custom trackers, test seams, wizard samples): each
    // entry is channel -> score, so just canonicalize the name and clamp.
    Object.entries(categories).forEach(([k, v]) => {
      const key = CAT_LOOKUP[String(k).toLowerCase()] || k;
      if (key) raw[key] = clamp(Number(v) || 0);
    });
    return raw;
  }
  // MediaPipe shape: [{ categoryName, score }, ...].
  categories.forEach(c => {
    const key = CAT_LOOKUP[String(c.categoryName || '').toLowerCase()];
    if (key) raw[key] = clamp(Number(c.score) || 0);
  });
  return raw;
}

/** Convenience pose fields computed from canonical channels (or raw map). */
export function faceChannels(blends) {
  const blinkL = Math.max(blends.eyeBlinkL || 0, blends.eyeSquintL || 0);
  const blinkR = Math.max(blends.eyeBlinkR || 0, blends.eyeSquintR || 0);
  return {
    blinkL, blinkR,
    blink: Math.max(blinkL, blinkR),
    browUp: Math.max(blends.browInnerUp || 0, blends.browOuterUpL || 0, blends.browOuterUpR || 0),
    browDown: Math.max(blends.browDownL || 0, blends.browDownR || 0),
    smile: Math.max(blends.mouthSmileL || 0, blends.mouthSmileR || 0),
    mouth: clamp(Math.max(blends.jawOpen || 0, (blends.mouthFunnel || 0) * 0.7, (blends.mouthPucker || 0) * 0.5)),
    pucker: Math.max(blends.mouthPucker || 0, blends.mouthFunnel || 0),
    frown: Math.max(blends.mouthFrownL || 0, blends.mouthFrownR || 0),
  };
}

/**
 * Eye gaze relative to the head from canonical blendshape channels.
 * Returns { h, v } in -1..1 where h > 0 means the wearer is looking toward
 * their own RIGHT (eyeLookInL / eyeLookOutR) and v > 0 means looking UP.
 * Pure signal — the renderer decides how to turn eye bones with it.
 */
export function eyeLookFromChannels(ch) {
  ch = ch || {};
  const h = (ch.eyeLookInL || 0) + (ch.eyeLookOutR || 0) - (ch.eyeLookOutL || 0) - (ch.eyeLookInR || 0);
  const v = (ch.eyeLookUpL || 0) + (ch.eyeLookUpR || 0) - (ch.eyeLookDownL || 0) - (ch.eyeLookDownR || 0);
  return { h: clamp(h, -1, 1), v: clamp(v, -1, 1) };
}

// ---------------------------------------------------------------------------
// Rig (bone) discovery for 3D models
// ---------------------------------------------------------------------------
// VRM / VRMA / Mixamo / FBX rigs expose real THREE.Bone objects whose names
// follow recognizable humanoid conventions (J_Bip_C_Head, J_Bip_L_Eye,
// Head, LeftEye, Jaw…). We classify a bone NAME into a rig role so the 3D
// renderer can move the head / eyes / jaw locally instead of rotating the
// whole model. Names that merely contain a keyword (eyeBlinkLeft morphs,
// headphones, necklaces) are rejected — separators must bound the keyword.

const SPLIT = /[._\s-]+/;
const isSideL = t => t === 'l' || t === 'left';
const isSideR = t => t === 'r' || t === 'right';
const SIDE_FROM = t => isSideL(t) ? 'L' : isSideR(t) ? 'R' : null;

/**
 * Classify a bone name into { role, side } | null.
 * role: 'head' | 'neck' | 'eye' | 'jaw'   (eye carries side 'L' | 'R')
 * Only objects actually named like rig joints match — accessory bones whose
 * names merely contain a keyword (HeadTop, Head_End, headphones, necklace,
 * eyeBlinkLeft morph targets) are rejected because the keyword must be a
 * bounded token or a recognized fused spelling.
 */
export function classifyRigBone(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const low = n.toLowerCase();
  const tokens = low.split(SPLIT).filter(Boolean);
  const last = tokens[tokens.length - 1];
  // Head: VRM exact name, or a bounded “head” token that isn't a tip joint
  // (HeadTop / Head_End / HeadTop_End are bones above the head, not the head).
  if (low === 'j_bip_c_head' || (tokens.includes('head') && last !== 'top' && last !== 'end' && !/^head(top|end)$/.test(low))) {
    return { role: 'head' };
  }
  if (low === 'j_bip_c_neck' || (tokens.includes('neck') && last !== 'end' && !/^neck(top|end)$/.test(low))) return { role: 'neck' };
  if (low === 'j_bip_c_jaw' || (tokens.includes('jaw') && last !== 'end')) return { role: 'jaw' };
  // Eyes: a bounded eye/eyes token with an adjacent side token (J_Bip_L_Eye,
  // Eye_L, left_eye…), or a fused spelling (LeftEye, EyeLeft, leye, reye).
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t !== 'eye' && t !== 'eyes' && !(t.startsWith('face') && t.endsWith('eye'))) continue;
    const prev = tokens[i - 1], next = tokens[i + 1];
    const side = SIDE_FROM(prev) || SIDE_FROM(next);
    if (side) return { role: 'eye', side };
  }
  let m = /^(left|l|right|r)(eye|eyes)$/.exec(low);
  if (m) return { role: 'eye', side: SIDE_FROM(m[1]) };
  m = /^(eye|eyes)(left|l|right|r)$/.exec(low);
  if (m) return { role: 'eye', side: SIDE_FROM(m[2]) };
  // Tongue: bounded tongue token or fused spelling (TongueBone,
  // J_Bip_C_Tongue, tongue_root…). Nothing else in rig naming contains
  // 'tongue', so a substring check is safe here.
  if ((tokens.includes('tongue') || /tongue/.test(low)) && last !== 'end') return { role: 'tongue' };
  // Lips: upper/lower lip chains — separated spellings (Lip_Lower_L,
  // J_Bip_L_UpperLip) and fused ones (LipLower, UpperLip, LowerLip).
  if (tokens.includes('lip') || tokens.includes('lips') || /(^|[^a-z])(upper|lower|top|bottom)?lip/i.test(low.replace(/([a-z])(upper|lower)/i, '$1 $2'))) {
    const hasLip = tokens.includes('lip') || tokens.includes('lips') || /lip/i.test(low);
    if (hasLip) {
      let part = null;
      if (tokens.includes('upper') || tokens.includes('top') || /upper|^top/i.test(low)) part = 'upper';
      if (tokens.includes('lower') || tokens.includes('bottom') || /lower/i.test(low)) part = part || 'lower';
      let side = null;
      for (let i = 0; i < tokens.length; i++) {
        const sd = SIDE_FROM(tokens[i - 1]) || SIDE_FROM(tokens[i + 1]);
        if (sd) { side = sd; break; }
      }
      if (!side) side = sideOf(low);   // fused spellings (LipLower_L, LipUpperR)
      if (part) return { role: 'lip', part, side };
      return { role: 'lip', part: null, side };
    }
  }
  // Fingers: thumb/index/middle/ring/pinky + 1..3 phalange index, per side.
  // Separated spellings (Thumb_R_1, Index_L), VRM chains (J_Bip_L_IndexIntermediate)
  // and fused ones (LeftIndex, LeftHandMiddle3, RightRingDistal).
  const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky', 'little'];
  const FUSE = /(?:hand)?(?:_?)(thumb|index|middle|ring|pinky|little)(proximal|intermediate|distal|metacarpal)?(\d?)/gi;
  const fm = FUSE.exec(low);
  if (fm) {
    const finger = fm[1] === 'little' ? 'pinky' : fm[1];
    let side = null;
    for (const t of tokens) { side = SIDE_FROM(t) || side; }
    if (!side) side = /^(left|l)/.test(low) ? 'L' : /^(right|r)/.test(low) ? 'R' : null;
    if (side) {
      let ph = fm[3] ? parseInt(fm[3], 10) : 1;
      if (fm[2] === 'distal') ph = 3;
      else if (fm[2] === 'intermediate') ph = 2;
      return { role: 'finger', side, finger, ph };
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!FINGERS.includes(t)) continue;
    const prev = tokens[i - 1], next = tokens[i + 1];
    let side = SIDE_FROM(prev) || SIDE_FROM(next);
    if (!side) side = SIDE_FROM(tokens[0]) || SIDE_FROM(tokens[tokens.length - 1]);
    if (!side) continue;
    let ph = 1;
    const numNext = next && /^\d+$/.test(next) ? parseInt(next, 10) : null;
    if (numNext) ph = numNext;
    else if (next === 'distal' || next === 'tip') ph = 3;
    else if (next === 'intermediate' || next === 'mid') ph = 2;
    else if (next === 'proximal' || next === 'metacarpal') ph = 1;
    return { role: 'finger', side, finger: t === 'little' ? 'pinky' : t, ph };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Point-gesture detection ("window in the air")
// ---------------------------------------------------------------------------
// Detects a deliberate pointing gesture: exactly one finger extended (index),
// the other three folded, with the thumb tolerant (folded OR extended — half
// the population points with the thumb loose). Folding is measured
// rotation-invariantly: a finger counts as folded when its TIP landmark is
// close to the WRIST relative to the knuckle→wrist distance, which holds at
// any hand rotation (tip-vs-mid comparisons flip when the hand points down).
// Deliberateness comes from the strict "exactly one" rule, not from tuning
// per-user thresholds.
//
// `landmarks` are 21 normalized MediaPipe hand landmarks; returns true when
// the hand is pointing.
export const POINT_FOLDED_RATIO = 0.85;

export function isPointGesture(landmarks) {
  if (!landmarks || landmarks.length < 21) return false;
  const at = i => landmarks[i];
  const wrist = at(0);
  const wDist = i => Math.hypot(at(i).x - wrist.x, at(i).y - wrist.y) || 1e-6;
  const folded = (tip, knuckle) => wDist(tip) < wDist(knuckle) * POINT_FOLDED_RATIO;
  // index OUT, middle/ring/pinky IN — thumb free.
  const indexOut = !folded(8, 5);
  const othersIn = folded(12, 9) && folded(16, 13) && folded(20, 17);
  return indexOut && othersIn;
}

// ---------------------------------------------------------------------------
// Air-pointer gesture: point at the camera to summon a floating control
// window (zoom in / zoom out / reset / close), then drive it from the air.
// ---------------------------------------------------------------------------
// The window lives entirely inside the avatar canvas, so it works everywhere
// the avatar stream goes — DM calls, video rooms, the Settings preview — with
// no DOM wiring. Geometry and state are pure so the behavior is unit-testable
// and deterministic under CI load.
//
// Contract:
//   hidden  - no pointing hand; nothing drawn
//   counting - index finger held up; the window materializes with a progress
//              bar (deliberateness: passing gestures never open it)
//   shown   - window open; dwelling the fingertip inside an action cell fires
//             it once per entry (leave the cell to arm it again)
//
// The window lingers through POINTER_RELEASE_MS after the hand vanishes so a
// dropped frame doesn't slam it shut mid-click.

export const POINTER_HOLD_MS = 350;      // dwell before the window opens
export const POINTER_RELEASE_MS = 600;   // linger after the hand is gone
export const POINTER_ZOOM_STEP = 0.08;   // per dwell-click zoom increment
export const POINTER_ZOOM_MIN = 0.75;
export const POINTER_ZOOM_MAX = 1.6;
export const POINTER_ACTIONS = ['zoom-in', 'zoom-out', 'reset', 'close'];

export const clampZoom = z => Math.min(POINTER_ZOOM_MAX, Math.max(POINTER_ZOOM_MIN, z));

// Window geometry for a fingertip at normalized (x, y) on a W×H canvas.
// Clamped so the box always stays fully on-screen. Actions are a row of
// equal cells under the header; the engine draws AND hit-tests from this.
export function pointerWindowRect(x, y, W = 640, H = 360) {
  const w = 190, h = 56, header = 22, gap = 6;
  let bx = Math.min(Math.max(gap, x * W - w / 2), W - w - gap);
  let by = Math.min(Math.max(gap, y * H + 18), H - h - gap);
  const cw = (w - gap * (POINTER_ACTIONS.length + 1)) / POINTER_ACTIONS.length;
  const actions = POINTER_ACTIONS.map((id, i) => ({
    id,
    x: bx + gap + i * (cw + gap),
    y: by + header + gap / 2,
    w: cw,
    h: h - header - gap * 1.5,
  }));
  return { x: bx, y: by, w, h, header, actions };
}

function hitAction(rect, x, y) {
  const px = x * 640, py = y * 360;   // normalized -> canvas px (canvas-space hit test)
  for (const a of rect.actions) {
    if (px >= a.x && px <= a.x + a.w && py >= a.y && py <= a.y + a.h) return a.id;
  }
  return null;
}

// Advance the pointer-gesture state machine one frame. `state` is owned by
// the caller (the engine keeps one); `ev` = { pointing, x, y, now, viewZoom }.
// Mutates state (phase, x, y, holdStart, wasInside, flash) and returns
// { viewZoom, action } — action is the id fired this frame or null.
export function stepPointerGesture(state, ev) {
  const { pointing = false, x = 0, y = 0, now = 0 } = ev;
  let viewZoom = clampZoom(ev.viewZoom != null ? ev.viewZoom : 1);
  let action = null;

  if (!pointing) {
    if (state.phase === 'shown') {
      // Keep the window open briefly after the hand vanishes.
      if (now - (state.lastSeenAt || 0) > POINTER_RELEASE_MS) {
        state.phase = 'hidden';
        state.wasInside = false;
        state.lastHit = null;
        state.wx = null; state.wy = null;
      }
    } else {
      state.phase = 'hidden';
      state.wasInside = false;
      state.lastHit = null;
      state.wx = null; state.wy = null;
    }
    state.holdStart = 0;       // aborted counts must not resurrect as instant-open
    state.dismissed = false;   // pointing stopped: a later point re-arms the hold
    state.flash = null;
    return { viewZoom, action };
  }

  state.lastSeenAt = now;
  state.x = x; state.y = y;
  if (state.flash && now - state.flash.at > 150) state.flash = null;

  if (state.phase === 'hidden' || state.phase === 'counting') {
    if (state.dismissed) return { viewZoom, action };   // close clicked this point: stay hidden
    if (!state.holdStart) state.holdStart = now;
    const opening = (now - state.holdStart) >= POINTER_HOLD_MS;
    state.phase = opening ? 'shown' : 'counting';
    state.lastHit = null;
    if (opening && state.wx == null) {
      // Freeze the window where it opened: from here the fingertip moves over
      // it like a mouse cursor (a window glued to the fingertip could never be
      // entered). wx/wy clear when the window closes.
      state.wx = x; state.wy = y;
    }
    state.wasInside = false;
    return { viewZoom, action };
  }

  // shown: hit-test actions against the FROZEN window rect. A cell fires when
  // the fingertip ENTERS it: dwelling in one cell fires once (lastHit blocks
  // re-fire until exit), and sliding onto a different cell fires immediately —
  // a pointer works like a mouse, not a single-shot switch.
  const rect = pointerWindowRect(state.wx, state.wy);
  const hit = hitAction(rect, x, y);
  if (hit && hit !== state.lastHit) {
    action = hit;
    state.lastHit = hit;
    if (hit === 'zoom-in') viewZoom = clampZoom(viewZoom + POINTER_ZOOM_STEP);
    else if (hit === 'zoom-out') viewZoom = clampZoom(viewZoom - POINTER_ZOOM_STEP);
    else if (hit === 'reset') viewZoom = 1;
    else if (hit === 'close') { state.phase = 'hidden'; state.holdStart = 0; state.dismissed = true; state.wx = null; state.wy = null; }
    state.flash = { id: hit, at: now };
  } else if (!hit) {
    state.lastHit = null;   // exit re-arms the cell for the next entry
  }
  return { viewZoom, action };
}

// Draw the floating window onto the avatar canvas. `ptr` is the engine's
// pointer state (phase/x/y/holdStart/flash); zoom is shown in the header.
export function drawPointerWindow(ctx, ptr, { W = 640, H = 360, zoom = 1 } = {}) {
  if (!ptr || ptr.phase === 'hidden') return;
  const wx = ptr.phase === 'shown' && ptr.wx != null ? ptr.wx : (ptr.x || 0.5);
  const wy = ptr.phase === 'shown' && ptr.wy != null ? ptr.wy : (ptr.y || 0.4);
  const rect = pointerWindowRect(wx, wy, W, H);
  ctx.save();
  // Window chrome
  ctx.fillStyle = ptr.phase === 'shown' ? 'rgba(12,14,24,0.88)' : 'rgba(12,14,24,0.55)';
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.strokeStyle = 'rgba(129,140,248,0.9)';
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (ptr.phase !== 'shown') {
    // Counting: label + progress bar
    const t = Math.min(1, ((ptr.now || 0) - (ptr.holdStart || 0)) / POINTER_HOLD_MS);
    ctx.fillStyle = '#c7c9e0';
    ctx.font = '11px system-ui';
    ctx.fillText('Hold to open', rect.x + rect.w / 2, rect.y + rect.header / 2);
    ctx.fillStyle = 'rgba(129,140,248,0.85)';
    ctx.fillRect(rect.x + 6, rect.y + rect.header + 14, (rect.w - 12) * t, 4);
  } else {
    const pct = Math.round(zoom * 100);
    ctx.fillStyle = '#e6e8f5';
    ctx.font = '11px system-ui';
    ctx.fillText('Zoom ' + pct + '%', rect.x + rect.w / 2, rect.y + rect.header / 2);
    const LABELS = { 'zoom-in': '+', 'zoom-out': '−', 'reset': '↺', 'close': '✕' };
    for (const a of rect.actions) {
      const hot = ptr.flash && ptr.flash.id === a.id;
      ctx.fillStyle = hot ? 'rgba(129,140,248,0.95)' : 'rgba(30,33,54,0.95)';
      ctx.fillRect(a.x, a.y, a.w, a.h);
      ctx.fillStyle = hot ? '#ffffff' : '#aeb2d8';
      ctx.font = '15px system-ui';
      ctx.fillText(LABELS[a.id] || '?', a.x + a.w / 2, a.y + a.h / 2);
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Verlet spring chains for hair / cloth / accessories (secondary motion)
// ---------------------------------------------------------------------------
// Secondary motion — hair swaying as the head turns, a skirt or coat tail
// following the hips — is what makes an avatar read as physical instead of
// floating. This is a small deterministic Verlet chain: points connected by
// distance constraints, gravity pulling down each frame, air drag, and an
// optional per-frame external acceleration (head motion) injected at the root.
//
// All units are model-local (meters for glTF); the engine feeds it the chain's
// attach bone world positions each frame. state is owned per chain by the
// engine. strength is 0..1 (user slider): 0 freezes the chain at its rest
// offsets (no simulation), 1 is full gravity.
export function createSpringChain(n, segLen) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push({ x: 0, y: -i * segLen, z: 0, px: 0, py: -i * segLen, pz: 0 });
  return { pts, segLen, init: false };
}

// Advance one chain: root pinned to the (moving) attach point `ax,ay,az`;
// gravity = 9.8 * strength (model units ~ meters). `dt` clamped by the caller.
export function stepSpringChain(chain, ax, ay, az, dt, strength, swayX = 0) {
  const pts = chain.pts, n = pts.length;
  if (!chain.init) {
    chain.init = true;
    for (let i = 0; i < n; i++) {
      pts[i].x = ax; pts[i].y = ay - i * chain.segLen; pts[i].z = az;
      pts[i].px = pts[i].x; pts[i].py = pts[i].y; pts[i].pz = pts[i].z;
    }
    return;
  }
  if (strength <= 0) {
    // Slider at zero: a true freeze — skip integration AND constraints so the
    // chain holds exactly where it hung (no drift toward the moving root, no
    // recovery to the bind pose). Re-enable snaps the simulation back on.
    return;
  }
  const g = 9.8 * strength;
  for (let i = 1; i < n; i++) {
    const p = pts[i];
    // verlet integrate: next = pos + (pos - prev) * drag + a*dt^2
    const vx = (p.x - p.px) * 0.985, vy = (p.y - p.py) * 0.985, vz = (p.z - p.pz) * 0.985;
    p.px = p.x; p.py = p.y; p.pz = p.z;
    p.x += vx + swayX * dt * dt;
    p.y += vy - g * dt * dt;
    p.z += vz;
  }
  pts[0].x = ax; pts[0].y = ay; pts[0].z = az;
  // Distance constraints — plain position relax (PBD style). The position-only
  // correction IS the velocity dissipation: it both enforces segment length
  // and bleeds off the velocity gravity injected this frame, so the chain
  // settles instead of compounding. 4 iterations hold a resting chain within
  // ~10% on the top segment at 24fps full gravity (visually: taut, no jiggle).
  for (let iter = 0; iter < 4; iter++) {
    for (let i = 0; i < n - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const d = Math.hypot(dx, dy, dz) || 1e-6;
      const diff = (d - chain.segLen) / d * 0.5;
      dx *= diff; dy *= diff; dz *= diff;
      if (i === 0) { b.x -= dx * 2; b.y -= dy * 2; b.z -= dz * 2; }
      else { a.x += dx; a.y += dy; a.z += dz; b.x -= dx; b.y -= dy; b.z -= dz; }
    }
  }
}

// ---------------------------------------------------------------------------
// GLB morph-target name normalization
// ---------------------------------------------------------------------------
// .glb morph target names vary wildly (ARKit English, VRoid/VRM, Maya, Mixamo
// FBX-exported, etc.). We classify each unknown name into a canonical channel
// by keyword + side detection. Classification is best-effort: names we cannot
// classify are left idle rather than misapplied.

const SIDE_L = ['left', 'l_', '_l', 'lft', 'l '];
const SIDE_R = ['right', 'r_', '_r', 'rgt', 'r '];

function sideOf(name) {
  const n = String(name).toLowerCase();
  // “left”/“right” words (incl. separator-suffixed: eyeBlinkLeft_inner) or a
  // separator-terminated single letter (mouthSmile_L, blink_r). Canonical short
  // names (eyeBlinkL) resolve earlier via the exact channel lookup.
  if (/(^|[^a-z])l$|left($|[^a-z])/.test(n)) return 'L';
  if (/(^|[^a-z])r$|right($|[^a-z])/.test(n)) return 'R';
  return null;
}

// keyword → [canonicalChannel, sideAware]
const MORPH_RULES = [
  // Single-letter visemes + Japanese VRM letters (tightly scoped so normal
  // English morph names like “eyeBlinkLeft” never match these).
  [/^[Ii]$|^[Ii][0-9]$|^[Ii]い|い$|viseme.?i|viseme.?e|え|^[Ee]$/, 'mouthSmile', false],
  [/^[Uu]$|う|viseme.?u|viseme.?o|^[Oo]$|お/, 'mouthPucker', false],
  [/あ|viseme.?a|^[Aa]$/, 'jawOpen', false],
  [/browdown|brow.?down|furrow/i, 'browDown', true],
  [/browinnerup|brow.?inner|frown.?brow|innerbrow/i, 'browInnerUp', false],
  [/browouterup|brow.?outer/i, 'browOuterUp', true],
  [/browup/i, 'browInnerUp', false],
  [/blink|eyelid|eye.?close|close.?eye|closel|closer|wink/i, 'eyeBlink', true],
  [/eyesquint|squint/i, 'eyeSquint', true],
  [/eyewide|wide/i, 'eyeWide', true],
  [/eyelook(up|down|in|out)|look(up|down|in|out)/i, 'eyeLook', true],
  [/tongue/i, 'tongueOut', false],
  [/cheekpuff|puff/i, 'cheekPuff', true],
  [/cheeksquint/i, 'cheekSquint', true],
  [/jawopen|mouthopen|open.?mouth|jaw.?drop/i, 'jawOpen', false],
  [/jaw(left|right|fwd|forward|jerk)|jaw.?left|jaw.?right/i, 'jawTurn', true],
  [/mouthsmile|smile/i, 'mouthSmile', true],
  [/mouthfrown|frown/i, 'mouthFrown', true],
  [/mouthpucker|pucker|mouthfunnel|funnel|mou|smallmouth/i, 'mouthPucker', false],
  [/mouthstretch|stretch/i, 'mouthStretch', true],
  [/mouthpress|press/i, 'mouthPress', true],
  [/mouthdimple|dimple/i, 'mouthDimple', true],
  [/mouthclose|close.?mouth|mm/i, 'mouthClose', false],
  [/mouthupperup|upperup/i, 'mouthUpperUp', true],
  [/mouthlowerdown|lowerdown|lowerlip/i, 'mouthLowerDown', true],
  [/mouth(roll|shrug)/i, 'mouthRollShrug', false],
  [/mouthleft|mouthright|mouth.?corner/i, 'mouthCorner', true],
  [/nosesneer|sneer/i, 'noseSneer', true],
  [/brow/i, 'browInnerUp', false],
];

/**
 * Classify an arbitrary morph-target name into { ch, side } where `ch` is one
 * of the canonical channel stems and `side` 'L' | 'R' | null.
 */
export function classifyMorphName(name) {
  if (!name) return null;
  const direct = CAT_LOOKUP[String(name).toLowerCase()];
  if (direct) return { ch: direct, side: null };
  const lower = String(name).toLowerCase();
  // exact ARKit-ish spelled-out names (eyeBlinkLeft → eyeBlinkL …)
  const spelled = lower
    .replace(/left/g, 'L').replace(/right/g, 'R')
    .replace(/^eye(blink|squint|wide|l)(l|r)$/i, (m, stem, s) => stem.toLowerCase() + s.toUpperCase());
  for (const [re, stem, sideAware] of MORPH_RULES) {
    if (re.test(lower)) {
      const side = sideAware ? (sideOf(lower) || null) : null;
      return { ch: stem, side };
    }
  }
  // Channel stems that are already canonical full ids (e.g. exporter kept them)
  const cat = CAT_LOOKUP[lower];
  if (cat) return { ch: cat, side: null };
  void spelled;
  return null;
}

/**
 * Map an arbitrary morph-target name to the canonical channel id(s) it drives.
 * Names with no usable side resolve to BOTH sides (e.g. "Blink" → both eyes)
 * so a single shared target still mirrors both-eye behaviour.
 */
export function morphTargetChannels(name) {
  const cls = classifyMorphName(name);
  if (!cls) return null;
  const cat = (side) => { void side; return null; };
  const pick = (l, r) => cls.side === 'L' ? [l] : cls.side === 'R' ? [r] : [l, r];
  switch (cls.ch) {
    case 'eyeBlink':      return pick('eyeBlinkL', 'eyeBlinkR');
    case 'eyeSquint':     return pick('eyeSquintL', 'eyeSquintR');
    case 'eyeWide':       return pick('eyeWideL', 'eyeWideR');
    case 'eyeLook':       return pick('eyeLookOutL', 'eyeLookOutR');
    case 'browDown':      return pick('browDownL', 'browDownR');
    case 'browOuterUp':   return pick('browOuterUpL', 'browOuterUpR');
    case 'jawOpen':       return ['jawOpen'];
    case 'jawTurn':       return cls.side === 'L' ? ['jawLeft'] : cls.side === 'R' ? ['jawRight'] : ['jawLeft', 'jawRight'];
    case 'mouthSmile':    return pick('mouthSmileL', 'mouthSmileR');
    case 'mouthFrown':    return pick('mouthFrownL', 'mouthFrownR');
    case 'mouthPucker':   return ['mouthPucker', 'mouthFunnel'];
    case 'mouthStretch':  return pick('mouthStretchL', 'mouthStretchR');
    case 'mouthPress':    return pick('mouthPressL', 'mouthPressR');
    case 'mouthDimple':   return pick('mouthDimpleL', 'mouthDimpleR');
    case 'mouthUpperUp':  return pick('mouthUpperUpL', 'mouthUpperUpR');
    case 'mouthLowerDown': return pick('mouthLowerDownL', 'mouthLowerDownR');
    case 'mouthRollShrug': return ['mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper'];
    case 'mouthCorner':   return ['mouthLeft'];
    case 'noseSneer':     return pick('noseSneerL', 'noseSneerR');
    case 'cheekPuff':     return pick('cheekPuffL', 'cheekPuffR');
    case 'browInnerUp':   return ['browInnerUp'];
    case 'tongueOut':     return ['tongueOut'];
    case 'mouthClose':    return ['mouthClose'];
    default: {
      const c = CAT_LOOKUP[String(name).toLowerCase()];
      return c ? [c] : null;
    }
  }
}

/**
 * Apply an external weight (0..1) onto `channels` (canonical map) given a
 * morph-target name. This is the forward direction of morphTargetChannels.
 */
export function applyMorphWeight(channels, name, weight) {
  const cats = morphTargetChannels(name);
  if (!cats) return channels;
  const w = clamp(Number(weight) || 0);
  cats.forEach(c => { channels[c] = Math.max(channels[c] || 0, w); });
  return channels;
}

// ---------------------------------------------------------------------------
// Pose from face landmarks
// ---------------------------------------------------------------------------
// landmarks: array of {x,y} in *normalized* 0..1 space (MediaPipe can give
// pixels; the engine normalizes first). Returns a pose object, or null when the
// required points are absent.
export function poseFromFace(landmarks) {
  if (!landmarks || landmarks.length < 468) return null;
  const at = i => landmarks[i];
  const lx = at(FACE.leftEyeOuter), rx = at(FACE.rightEyeOuter);
  const nose = at(FACE.noseTip), chin = at(FACE.chin), mid = { x: (lx.x + rx.x) / 2, y: (lx.y + rx.y) / 2 };
  const eyeDX = rx.x - lx.x, eyeDY = rx.y - lx.y;
  const eyeDist = Math.hypot(eyeDX, eyeDY);
  if (eyeDist < 1e-4) return null;
  const roll = Math.atan2(eyeDY, eyeDX) * 180 / Math.PI;          // head tilt
  // Yaw: nose drift relative to the eye line. Negative nose offset (nose left
  // of center, user turned to their right) → negative yaw (avatar turns same way).
  let yaw = ((nose.x - mid.x) / eyeDist) * 34;
  yaw = clamp(yaw, -42, 42);
  // Pitch: nose position between the eye line and the chin (0 = level).
  const noseSpan = (nose.y - mid.y);
  const chinSpan = (chin.y - mid.y) || 1;
  // Frontal faces put the nose ~44% of the way from the eye line to the chin;
  // looking up moves the nose toward the eye line (ratio shrinks).
  let pitch = (0.44 - noseSpan / chinSpan) * 55;
  pitch = clamp(pitch, -40, 40);
  // “Closeness”: inter-eye distance grows as you approach the camera. Calibrated
  // so a typical talking-distance frame (eye span ≈ 13% of frame) reads 1.0.
  const closeness = clamp(eyeDist / 0.13, 0.5, 1.9);
  return {
    yaw, pitch, roll,
    closeness,
    eyeDist,
    noseX: nose.x, noseY: nose.y,
    midX: mid.x, midY: mid.y,
    detected: true,
  };
}

// ---------------------------------------------------------------------------
// Synthetic fallback pose driver (idle “alive” animation when nobody is
// tracked — also used by tests to drive the renderer deterministically).
// ---------------------------------------------------------------------------
export function idlePose(t, last = {}) {
  const blinkPhase = ((t / 1000 + (last.phase || 0)) % 6.4);
  const blink = blinkPhase > 6.1 ? 1 - Math.abs(((blinkPhase - 6.1) / 0.3) * 2 - 1) : 0;
  return {
    yaw: Math.sin(t / 9000) * 4,
    pitch: Math.sin(t / 11000) * 2.5,
    roll: Math.sin(t / 13000) * 1.6,
    closeness: 1 + Math.sin(t / 5000) * 0.02,
    noseX: 0.5, noseY: 0.47,
    detected: false,
    blink, blinkL: blink, blinkR: blink,
    mouth: 0, smile: 0.05 + Math.sin(t / 7000) * 0.03,
    browUp: 0, browDown: 0,
  };
}

/** Merge tracking pose with canonical face channels into one renderer pose. */
export function composePose(pose, channels, talking, detected) {
  const ch = faceChannels(channels || {});
  // Fall back to facial channels when no blendshapes exist (e.g. 2D path).
  const blink = Math.max(ch.blink, (pose && pose.blink) || 0);
  return {
    yaw: pose ? pose.yaw : 0,
    pitch: pose ? pose.pitch : 0,
    roll: pose ? pose.roll : 0,
    closeness: pose ? pose.closeness : 1,
    noseX: pose ? pose.noseX : 0.5,
    noseY: pose ? pose.noseY : 0.5,
    detected: !!detected,
    blinkL: Math.max(ch.blinkL, blink > 0 ? blink : 0),
    blinkR: Math.max(ch.blinkR, blink > 0 ? blink : 0),
    blink,
    mouth: Math.max(ch.mouth, talking > 0.2 ? Math.min(1, talking * 1.4) : 0),
    smile: ch.smile,
    browUp: ch.browUp,
    browDown: ch.browDown,
    talking: talking > 0.25,
    pucker: ch.pucker,
    frown: ch.frown,
  };
}

// ---------------------------------------------------------------------------
// Per-user calibration
// ---------------------------------------------------------------------------
// Tracking quality differs per person: natural eye-openness, mouth rest pose,
// smile range and head-hold all vary. A short calibration wizard records each
// user's neutral head pose and per-expression min/max ranges, and these
// functions normalize live values against them so expressions drive the avatar
// fully instead of half-way.
//
// cal shape: { pose: {yaw, pitch, roll, noseX, noseY},
//              channels: { <canonical>: { min, max }, ... } }

/** Normalize live canonical blends against per-channel [min,max] ranges. */
export function calibrateBlends(raw, cal) {
  if (!cal || !cal.channels) return raw;
  const out = {};
  for (const k of Object.keys(raw)) {
    const r = cal.channels[k];
    if (r && r.max - r.min > 0.03) out[k] = clamp((raw[k] - r.min) / (r.max - r.min));
    else out[k] = raw[k];
  }
  return out;
}

/** Zero out the user's neutral head hold so a relaxed face shows straight. */
export function applyPoseCalibration(pose, cal) {
  if (!cal || !cal.pose || !pose) return pose;
  const p = cal.pose;
  return {
    ...pose,
    yaw: pose.yaw - (p.yaw || 0),
    pitch: pose.pitch - (p.pitch || 0),
    roll: pose.roll - (p.roll || 0),
    noseX: clamp(pose.noseX - ((p.noseX || 0.5) - 0.5)),
    noseY: clamp(pose.noseY - ((p.noseY || 0.5) - 0.5)),
  };
}

// ---------------------------------------------------------------------------
// Body (MediaPipe Pose) metrics + per-user calibration
// Pose landmark indices: 11/12 shoulders, 13/14 elbows, 15/16 wrists, 23/24
// hips. All coordinates are normalized [0,1] full-frame. The neutral body
// capture records torso/arm proportions; the arms capture records each wrist's
// motion range relative to its shoulder (normalized by arm length), so the
// avatar's arms reach full extension at the user's real maximum.
// ---------------------------------------------------------------------------
export const BODY_LANDMARKS = {
  shoulderL: 11, shoulderR: 12, elbowL: 13, elbowR: 14,
  wristL: 15, wristR: 16, hipL: 23, hipR: 24,
};

function bodyDist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function bodyMid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

/** Neutral torso/arm metrics from one Pose frame (needs shoulders + hips). */
export function bodyMetrics(body) {
  if (!body || body.length < 25) return null;
  const at = i => body[i];
  const sL = at(11), sR = at(12), wL = at(15), wR = at(16), hL = at(23), hR = at(24);
  const sMid = bodyMid(sL, sR), hMid = bodyMid(hL, hR);
  return {
    midX: sMid.x, midY: sMid.y,
    shoulderSpan: bodyDist(sL, sR),
    hipSpan: bodyDist(hL, hR),
    torsoLen: bodyDist(sMid, hMid),
    armLenL: bodyDist(sL, wL),
    armLenR: bodyDist(sR, wR),
  };
}

/**
 * Normalize a live Pose frame against the user's neutral body calibration so
 * the avatar's torso scale and arm reach follow THEIR motion, not raw pixel
 * spans (a close/tall user would otherwise overflow the rig, a small user
 * underfill it). Returns null when no body calibration exists — the engine
 * then falls back to raw landmarks. `raise` is 0 (arm down)..1 (arm up) and
 * `out` is 0 (at side)..1 (full lateral spread), each mapped through the
 * captured per-user range (fallback: assume a full -1..+1 reach).
 */
export function applyBodyCalibration(body, cal) {
  const n = cal && cal.body;
  if (!n || !body || body.length < 25) return null;
  const at = i => body[i];
  const sL = at(11), sR = at(12), wL = at(15), wR = at(16), hL = at(23), hR = at(24);
  const sMid = bodyMid(sL, sR);
  const span = bodyDist(sL, sR) || 1e-6;
  const range = (v, r) => (r && r.max - r.min > 1e-4) ? clamp((v - r.min) / (r.max - r.min)) : clamp((v + 1) / 2);
  const armPose = (sh, wr, len) => {
    const L = len || 1e-6;
    return { dx: (wr.x - sh.x) / L, dy: (sh.y - wr.y) / L };   // dy + = wrist above shoulder
  };
  const l = armPose(sL, wL, n.armLenL), r = armPose(sR, wR, n.armLenR);
  const rng = side => (n.armRange && n.armRange[side]) || null;
  return {
    midX: clamp(sMid.x - (n.midX || 0.5) + 0.5),
    midY: clamp(sMid.y - (n.midY || 0.5) + 0.5),
    torsoScale: clamp(span / (n.shoulderSpan || span), 0.6, 1.6),
    lean: clamp((sMid.x - (n.midX || 0.5)) * 3, -1, 1),
    lenL: n.armLenL || 0.3, lenR: n.armLenR || 0.3,
    armL: { raise: range(l.dy, rng('l') && rng('l').dy), out: range(l.dx, rng('l') && rng('l').dx) },
    armR: { raise: range(r.dy, rng('r') && rng('r').dy), out: range(r.dx, rng('r') && rng('r').dx) },
  };
}

/**
 * Canvas-space joints for the 2D body rig — the SAME calibrated math the 3D
 * rig uses (updateBodyRig3D), so every avatar type moves identically from one
 * tracker. Shoulders/hips follow the raw tracked landmarks; when a body
 * calibration exists, elbows/wrists are placed from the user's normalized
 * raise/out around each shoulder (scaled by neutral arm length x torso scale),
 * exactly like the 3D armSlot placement. Without calibration the raw landmark
 * positions are used. Returns the 8 rig joints in BODY_SLOT order
 * [L-shoulder, R-shoulder, L-elbow, R-elbow, L-wrist, R-wrist, L-hip, R-hip].
 */
export function bodyRigPoints2D(body, bodyCal, W, H) {
  if (!body || body.length < 25) return null;
  const at = i => body[i];
  const px = (pt) => ({ x: (pt && pt.x != null ? pt.x : 0.5) * W, y: (pt && pt.y != null ? pt.y : 0.5) * H });
  const j = { 0: px(at(11)), 1: px(at(12)), 2: px(at(13)), 3: px(at(14)), 4: px(at(15)), 5: px(at(16)), 6: px(at(23)), 7: px(at(24)) };
  if (bodyCal && bodyCal.armL && bodyCal.armR) {
    const lenPx = side => (side === 'l' ? bodyCal.lenL || 0.3 : bodyCal.lenR || 0.3) * H * (bodyCal.torsoScale || 1);
    const armSlot = (shIdx, elbIdx, wriIdx, arm, side) => {
      const sh = j[shIdx], len = lenPx(side), L = side === 'l' ? -1 : 1;
      // Canvas Y grows downward (three.js world Y grows up): raise must flip
      // sign so a positive raise puts the wrist ABOVE the shoulder, mirroring
      // the 3D rig's placement exactly.
      j[wriIdx] = { x: sh.x + arm.out * len * L, y: sh.y - arm.raise * len };
      j[elbIdx] = { x: sh.x + arm.out * len * 0.55 * L, y: sh.y - arm.raise * len * 0.55 };
    };
    armSlot(0, 2, 4, bodyCal.armL, 'l');
    armSlot(1, 3, 5, bodyCal.armR, 'r');
  }
  return j;
}
