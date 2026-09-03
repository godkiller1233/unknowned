// Per-device media preferences. Device IDs are stored per machine/origin in
// localStorage (they are meaningless on another computer), so every call site
// reads them fresh. All helpers fail soft — no device choice means the browser
// default, exactly like before this existed.

const PREFS_KEY = 'unknown_media_prefs';

export function loadMediaPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { mic: '', camera: '', speaker: '' };
    const p = JSON.parse(raw);
    return {
      mic:     typeof p.mic     === 'string' ? p.mic     : '',
      camera:  typeof p.camera  === 'string' ? p.camera  : '',
      speaker: typeof p.speaker === 'string' ? p.speaker : '',
    };
  } catch {
    return { mic: '', camera: '', speaker: '' };
  }
}

export function saveMediaPrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      mic:     prefs.mic     || '',
      camera:  prefs.camera  || '',
      speaker: prefs.speaker || '',
    }));
  } catch { /* storage unavailable (private mode etc.) — defaults apply */ }
}

// Build the constraints object for getUserMedia. `kind` is one of
// 'mic' | 'camera' | 'mic+camera'. A saved deviceId that no longer exists is
// ignored (browser falls back to its default) instead of throwing.
export function mediaConstraints(kind = 'mic') {
  const p = loadMediaPrefs();
  const wantMic = kind === 'mic' || kind === 'mic+camera';
  const wantCam = kind === 'camera' || kind === 'mic+camera';
  const constraints = {};
  if (wantMic) constraints.audio = p.mic ? { deviceId: { exact: p.mic } } : true;
  if (wantCam) constraints.video = p.camera ? { deviceId: { exact: p.camera }, width: { ideal: 1280 }, height: { ideal: 720 } } : { width: { ideal: 1280 }, height: { ideal: 720 } };
  return constraints;
}

// Attempt to honor the saved speaker for an <audio>/<video> element (output
// device). Modern Chromium/Electron expose setSinkId; browsers without it just
// keep using the system default.
export function applySpeakerSink(el, speakerId) {
  if (!el || !speakerId) return;
  try {
    if (typeof el.setSinkId === 'function') {
      el.setSinkId(speakerId).catch(() => { /* device gone — default output */ });
    }
  } catch { /* ignore */ }
}
