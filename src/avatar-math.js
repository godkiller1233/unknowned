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
  (categories || []).forEach(c => {
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
  return null;
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
