// avatar-store.js — per-user avatar preferences + avatar art persistence.
// Config lives in localStorage (cheap, sync); the 2D/3D art itself can be
// several MB, so it is stored as blobs in IndexedDB and exposed as fresh
// object URLs on load.

export const AVATAR_CFG_KEY = 'unknown_avatar_cfg';
const DB_NAME = 'unknown_avatar_assets';
const DB_STORE = 'files';

export function defaultAvatarConfig() {
  return { mode: 'camera', hands: true };
}

export function loadAvatarConfig() {
  try {
    const raw = localStorage.getItem(AVATAR_CFG_KEY);
    if (!raw) return defaultAvatarConfig();
    const p = JSON.parse(raw);
    return {
      mode: p.mode === '2d' || p.mode === '3d' || p.mode === 'external' ? p.mode : 'camera',
      hands: p.hands !== false,
      externalId: typeof p.externalId === 'string' ? p.externalId : '',
    };
  } catch {
    return defaultAvatarConfig();
  }
}

export function saveAvatarConfig(cfg) {
  try {
    localStorage.setItem(AVATAR_CFG_KEY, JSON.stringify({
      mode: cfg.mode === '2d' || cfg.mode === '3d' || cfg.mode === 'external' ? cfg.mode : 'camera',
      hands: cfg.hands !== false,
      externalId: typeof cfg.externalId === 'string' ? cfg.externalId : '',
    }));
  } catch { /* storage unavailable — defaults apply this session */ }
}

// -- IndexedDB ---------------------------------------------------------------

function idb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no indexeddb')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'kind' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('idb open failed'));
  });
}

async function tx(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(DB_STORE, mode);
    const store = t.objectStore(DB_STORE);
    const out = fn(store);
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : null);
    t.onerror = () => reject(t.error || new Error('idb tx failed'));
    t.onabort = () => reject(t.error || new Error('idb tx aborted'));
  });
}

/** Persist an uploaded File/Blob under kind '2d' | '3d'. */
export async function saveAvatarFile(kind, file, fit) {
  if (kind !== '2d' && kind !== '3d') throw new Error('bad avatar kind');
  await tx('readwrite', store => store.put({ kind, name: file.name || (kind === '2d' ? 'avatar.png' : 'avatar.glb'), blob: file, fit: fit || null }));
}

/**
 * Feature-fit anchors for a 2D picture: normalized (0..1) positions of the
 * avatar's left/right eye on the imported image. The engine pins these to the
 * tracked face's eyes so head-follow, closeness zoom and yaw/pitch rotate
 * around the character's real features (VSee/avatar-software style fitting).
 */
export async function saveAvatarFit(kind, fit) {
  if (kind !== '2d') return;
  await tx('readwrite', store => {
    const req = store.get(kind);
    req.onsuccess = () => {
      const rec = req.result;
      if (rec && rec.blob) {
        rec.fit = fit || null;
        store.put(rec);
      }
    };
  });
}

/** Remove the saved asset for a kind. */
export async function removeAvatarFile(kind) {
  await tx('readwrite', store => store.delete(kind));
}

/** Load the saved asset for a kind; returns { name, url } or null. */
export async function getAvatarFile(kind) {
  try {
    const rec = await tx('readonly', store => store.get(kind));
    if (!rec || !rec.blob) return null;
    const name = rec.name || (kind === '2d' ? 'avatar.png' : 'avatar.glb');
    return { name, blob: rec.blob, url: URL.createObjectURL(rec.blob), fit: rec.fit || null };
  } catch {
    return null;
  }
}

// -- calibration ------------------------------------------------------------
const CAL_KIND = 'cal';

/** Persist the user's tracking calibration (neutral pose + expression ranges). */
export async function saveCalibration(cal) {
  await tx('readwrite', store => store.put({ kind: CAL_KIND, value: cal }));
}

/** Load the saved calibration, or null when the user never calibrated. */
export async function loadCalibration() {
  try {
    const rec = await tx('readonly', store => store.get(CAL_KIND));
    return rec && rec.value ? rec.value : null;
  } catch {
    return null;
  }
}

/** Forget the calibration (the wizard's Reset button). */
export async function clearCalibration() {
  try { await tx('readwrite', store => store.delete(CAL_KIND)); } catch {}
}

/** List the kinds that have an imported asset (for badge/UI state). */
export async function avatarAssetKinds() {
  try {
    const all = await tx('readonly', store => store.getAll());
    return (all || []).filter(r => r && r.kind && r.blob).map(r => r.kind);
  } catch {
    return [];
  }
}

// -- helpers shared by call surfaces ----------------------------------------

/** True when the user has chosen an avatar mode (2d/3d) in settings. */
export function avatarModeActive() {
  const cfg = loadAvatarConfig();
  return cfg.mode === '2d' || cfg.mode === '3d';
}
