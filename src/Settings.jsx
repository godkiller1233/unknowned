import React, { useEffect, useRef, useState } from 'react';
import { loadMediaPrefs, saveMediaPrefs, isVirtualCamLabel, externalVideoConstraints } from './mediaPrefs.js';
import { loadAvatarConfig, saveAvatarConfig, saveAvatarFile, removeAvatarFile, getAvatarFile, saveAvatarFit, loadCalibration, saveCalibration, clearCalibration, notifyCalibrationChanged, canUseVrmAvatar, isVrmAssetName, VRM_ALLOWED_RANKS } from './avatar-store.js';
import { createAvatarEngine } from './avatar-engine.js';
import { bodyMetrics } from './avatar-math.js';

const getToken = () => sessionStorage.token || localStorage.rememberToken || '';
const api = (path, opts = {}) =>
  fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}), Authorization: `Bearer ${getToken()}` }
  }).then(r => r.json());

const MASK_EMOJIS = ['🦊','🌊','👻','📡','🌌','🔴','❄️','🐦‍⬛','💨','🔥','👾','⚙️','🌙','☁️','🐺','🦋','🌸','🌑','📶','🔐'];
// Mirrors the chat name-color hash so the preview tint matches real messages.
const NAME_COLOR_PALETTE = ['#5865f2','#eb459e','#00a8fc','#23a559','#f0b232','#f23f42','#e67e22','#57f287'];
const maskNameColor = (n) => { let h = 0; for (let i = 0; i < (n||'').length; i++) h = (n.charCodeAt(i) + h * 31) % NAME_COLOR_PALETTE.length; return NAME_COLOR_PALETTE[h]; };

// Mirrors the avatar gradient used in chat/avatar rendering. Accepts a hex color
// (derives light/mid/dark) or a custom {start,mid,end} gradient object/JSON.
function maskGradient(color) {
  let grad = null;
  if (typeof color === 'object' && color) grad = color;
  else if (typeof color === 'string' && color.trim().startsWith('{')) {
    try { const p = JSON.parse(color); if (p.start && p.mid && p.end) grad = p; } catch {}
  }
  if (grad) return `radial-gradient(circle at 30% 22%, ${grad.start} 0%, ${grad.mid} 52%, ${grad.end} 100%)`;
  const m = /^#([0-9a-f]{6})$/i.exec(String(color||'').trim());
  if (!m) return 'linear-gradient(135deg, #6d28d9, #9333ea 45%, #0ea5e9)';
  const hex = m[1];
  const r = parseInt(hex.slice(0,2),16), g = parseInt(hex.slice(2,4),16), b = parseInt(hex.slice(4,6),16);
  const mix = (c, t, amt) => Math.round(c + (t - c) * amt);
  const light = `rgb(${mix(r,255,0.45)},${mix(g,255,0.45)},${mix(b,255,0.45)})`;
  const dark  = `rgb(${mix(r,0,0.45)},${mix(g,0,0.45)},${mix(b,0,0.45)})`;
  return `radial-gradient(circle at 30% 22%, ${light} 0%, ${color} 52%, ${dark} 100%)`;
}

const INTERESTS_LIST = [
  'Gaming','Music','Art','Coding','Memes','Anime','Sports','Movies',
  'Study','Science','Cooking','Travel','Fitness','Photography','Fashion','Books'
];

const THEMES = [
  { id: 'dark',   label: 'Dark',   preview: '#313338' },
  { id: 'light',  label: 'Light',  preview: '#ffffff' },
  { id: 'amoled', label: 'AMOLED', preview: '#000000' },
  { id: 'forest', label: 'Forest', preview: '#1a2e1a' },
  { id: 'ocean',  label: 'Ocean',  preview: '#0a1628' },
];

const BG_OPTIONS = [
  { id: 'default',   label: 'Default' },
  { id: 'dots',      label: 'Dots' },
  { id: 'grid',      label: 'Grid' },
  { id: 'gradient1', label: 'Sunset' },
  { id: 'gradient2', label: 'Ocean' },
  { id: 'gradient3', label: 'Forest' },
];

export default function Settings({ me, boot, onClose, onSave, currentTheme, onThemeChange, onOpenDataRequests }) {
  const [tab, setTab] = useState('account');
  const [settings, setSettings] = useState({});
  const [profile, setProfile] = useState({ nickname: me?.nickname||'', bio: me?.bio||'', custom_status: me?.custom_status||'', interests: me?.interests||'' });
  const [passwords, setPasswords] = useState({ current: '', newPassword: '', confirm: '' });
  const [masks, setMasks] = useState([]);
  const [activeAnon, setActiveAnon] = useState(null);
  const [anonHistory, setAnonHistory] = useState([]);
  const [favMasks, setFavMasks] = useState(() => {
    try { const p = JSON.parse(me?.fav_masks || '[]'); if (Array.isArray(p) && p.length) return p; } catch {}
    return me?.fav_mask ? [{ name: me.fav_mask, color: me.fav_color, emoji: me.fav_emoji }] : [];
  });
  const [srvFavSel, setSrvFavSel] = useState('');           // communityId being edited for per-server presets
  const [srvFavs, setSrvFavs] = useState(() => {
    try { const p = JSON.parse(me?.server_fav_masks || '{}'); if (p && typeof p === 'object') return p; } catch {}
    return {};
  });
  const [previewMask, setPreviewMask] = useState(null);  // { name, emoji, color } shown in live picker preview
  const [customGrad, setCustomGrad] = useState(() => {
    try { const p = JSON.parse(me?.anon_color || ''); if (p.start && p.mid && p.end) return p; } catch {}
    return null;
  });
  const [anonNameColor, setAnonNameColor] = useState(me?.anon_name_color || '');
  const maskGridRef = useRef([]);
  const [privacyCheckup, setPrivacyCheckup] = useState(null);
  const [tempName, setTempName] = useState('');
  const [saved, setSaved] = useState('');
  const [delPassword, setDelPassword] = useState('');
  const [delConfirm, setDelConfirm] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [err, setErr] = useState('');
  // ── Security: two-factor auth + session manager ─────────────────────────
  const [secBusy, setSecBusy] = useState(false);
  const [secMsg, setSecMsg] = useState('');
  const [secError, setSecError] = useState('');
  const [totpEnabled, setTotpEnabled] = useState(false);
  const [setupPending, setSetupPending] = useState(null);   // { secret, otpauthUrl, account }
  const [recoveryCodes, setRecoveryCodes] = useState(null); // shown exactly once after enabling
  const [secPassword, setSecPassword] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [sessions, setSessions] = useState([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [selectedInterests, setSelectedInterests] = useState([]);

  // ── Avatar (virtual camera: 2D image or 3D model instead of your face) ────
  const [avatarCfg, setAvatarCfg] = useState(loadAvatarConfig);
  const [avatarAssets, setAvatarAssets] = useState({ '2d': null, '3d': null }); // {name} | null
  const [avatarStatus, setAvatarStatus] = useState('');
  // Which avatar sources this account's rank unlocks (VRM models are staff-only;
  // everything else is available to everyone).
  const vrmUnlocked = canUseVrmAvatar(me?.rank);
  const avatarUnlocks = [
    { id: 'camera', label: 'Real camera', note: 'Always available' },
    { id: '2d', label: '2D picture', note: 'Always available' },
    { id: '3d', label: '3D model (.glb)', note: 'Always available' },
    { id: 'vrm', label: '3D VRM model', note: vrmUnlocked ? `Unlocked by your ${me?.rank} rank` : `Founder / ${VRM_ALLOWED_RANKS.filter(r => r !== 'founder').map(r => r[0].toUpperCase() + r.slice(1)).join(' / ')} only` },
  ];
  const [avatarPreviewOn, setAvatarPreviewOn] = useState(false);
  const avatarEngineRef = useRef(null);
  const avatarPrevRef = useRef(null);
  const avatarFileRef = useRef({ '2d': null, '3d': null });
  const avatarCamRef = useRef(null);

  async function refreshAvatarAssets() {
    const out = { '2d': null, '3d': null };
    const [a, b] = await Promise.all([getAvatarFile('2d'), getAvatarFile('3d')]);
    if (a) out['2d'] = { name: a.name, url: a.url, fit: a.fit || null };
    if (b) out['3d'] = { name: b.name, url: b.url, fit: b.fit || null };
    setAvatarAssets(out);
    return out;
  }

  async function stopAvatarPreview() {
    setAvatarPreviewOn(false);
    avatarCamRef.current?.getTracks().forEach(t => { try { t.stop(); } catch {} });
    avatarCamRef.current = null;
    const eng = avatarEngineRef.current;
    avatarEngineRef.current = null;
    if (eng) { try { await eng.destroy(); } catch {} }
    if (avatarPrevRef.current) avatarPrevRef.current.srcObject = null;
  }

  async function startAvatarPreview() {
    await stopAvatarPreview();
    const cfg = loadAvatarConfig();
    if (cfg.mode === 'camera') { setAvatarStatus('Choose a 2D, 3D avatar or an external app camera above to preview it.'); return; }
    if (cfg.mode === 'external') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(externalVideoConstraints(cfg.externalId));
        if (!stream.getVideoTracks().length) { stream.getTracks().forEach(t => t.stop()); setAvatarStatus('That device has no video track — pick the app’s virtual camera.'); return; }
        avatarCamRef.current = stream;
        const v = avatarPrevRef.current;
        if (v) { v.srcObject = stream; v.play().catch(() => {}); }
        setAvatarStatus('Showing the external app’s camera feed — calls will send exactly what it renders.');
        setAvatarPreviewOn(true);
      } catch (err) {
        setAvatarStatus(String(err?.name || '').includes('NotAllowed')
          ? 'Camera permission is blocked — allow it for this site, then try again.'
          : String(err?.name || '').includes('NotFound') || String(err?.name || '').includes('Overconstrained')
            ? 'That camera is gone — start the app (VTube Studio / OBS / Snap) and rescan devices.'
            : 'Could not start that camera: ' + (err?.message || 'unknown error'));
      }
      return;
    }
    const kind = cfg.mode === '2d' ? '2d' : '3d';
    const asset = await getAvatarFile(kind);
    if (!asset) { setAvatarStatus('Upload ' + (kind === '2d' ? 'a picture' : 'a 3D model') + ' first — then it will preview here.'); return; }
    if (kind === '3d' && isVrmAssetName(asset.name) && !canUseVrmAvatar(me?.rank)) { setAvatarStatus('VRM avatars are limited to the Founder, Owner and Administrator ranks — pick a .glb model or switch to 2D.'); return; }
    // The webcam is optional: it only powers face/hand tracking and is never sent.
    let cam = null;
    try { cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 } } }); } catch { cam = null; }
    avatarCamRef.current = cam;
    setAvatarStatus('Starting…');
    const cal = await loadCalibration();
    const eng = createAvatarEngine({
      mode: cfg.mode, assetUrl: asset.url, hands: cfg.hands, body: cfg.body, cameraStream: cam, calibration: cal, fit: asset.fit || null,
      onStatus: st => { if (avatarEngineRef.current === eng) setAvatarStatus(st === 'tracking' ? '✅ Tracking your face — move to see the avatar react.' + (cal ? ' (calibrated)' : '') : st === 'tracking-or-idle' ? 'Tracking your face…' : st === 'no-camera-idle' ? 'No webcam needed — the avatar animates on its own. Allow the camera for face tracking.' : st === 'no-tracking-idle' ? 'Tracking unavailable — the avatar animates on its own.' : String(st)); },
    });
    avatarEngineRef.current = eng;
    eng.start().catch(() => {});
    const v = avatarPrevRef.current;
    if (v) { v.srcObject = eng.stream; v.play().catch(() => {}); }
    setAvatarPreviewOn(true);
  }

  async function pickAvatarFile(kind) {
    avatarFileRef.current[kind]?.click();
  }

  async function onAvatarFile(kind, ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    if (kind === '3d' && !/\.(glb|vrm)$/i.test(file.name)) { notify('3D avatars must be a .glb or .vrm model file.', 'err'); return; }
    if (kind === '3d' && isVrmAssetName(file.name) && !canUseVrmAvatar(me?.rank)) { notify('VRM avatars are limited to the Founder, Owner and Administrator ranks. Use a .glb model instead.', 'err'); return; }
    if (kind === '2d' && !/\.(png|jpe?g|webp|gif)$/i.test(file.name)) { notify('2D avatars must be a picture (PNG/JPG/WebP/GIF).', 'err'); return; }
    if (file.size > 40 * 1024 * 1024) { notify('That file is too large (max 40 MB).', 'err'); return; }
    try {
      await saveAvatarFile(kind, file);
      await refreshAvatarAssets();
      notify((kind === '2d' ? 'Picture' : '3D model') + ' saved — use it as your avatar by picking the mode above.');
      if (loadAvatarConfig().mode === (kind === '2d' ? '2d' : '3d')) startAvatarPreview();
    } catch { notify('Could not save that file on this device.', 'err'); }
  }

  async function removeAvatarAsset(kind) {
    try { await removeAvatarFile(kind); } catch {}
    if (avatarEngineRef.current && loadAvatarConfig().mode === (kind === '2d' ? '2d' : '3d')) await stopAvatarPreview();
    await refreshAvatarAssets();
    notify('Avatar ' + (kind === '2d' ? 'picture' : 'model') + ' removed.');
  }

  async function setAvatarMode(mode) {
    const next = { ...avatarCfg, mode };
    setAvatarCfg(next);
    saveAvatarConfig(next);
    if (mode === 'camera') { await stopAvatarPreview(); setAvatarStatus(''); }
    else if (mode === 'external') { await stopAvatarPreview(); refreshDevices(); setAvatarStatus('Pick the app’s virtual camera below — VTube Studio, OBS, Snap Camera etc. ("External app").'); }
    else startAvatarPreview();
  }

  // ── 2D avatar feature-fit editor (eyes on the picture) ───────────────────────────────────────────────────────────────────────────
  const [fitOpen, setFitOpen] = useState(false);
  const [fitDraft, setFitDraft] = useState(null); // { leftEye:{x,y}, rightEye:{x,y} } normalized to the image
  const fitDragRef = useRef(null); // 'left' | 'right' while dragging
  const fitImgRef = useRef(null);

  const defaultFit = () => ({ leftEye: { x: 0.36, y: 0.42 }, rightEye: { x: 0.64, y: 0.42 } });

  function openFitEditor() {
    const asset = avatarAssets['2d'];
    setFitDraft(asset && asset.fit ? { leftEye: { ...asset.fit.leftEye }, rightEye: { ...asset.fit.rightEye } } : defaultFit());
    setFitOpen(true);
  }

  async function saveFit() {
    if (!fitDraft) return;
    try { await saveAvatarFit('2d', { leftEye: fitDraft.leftEye, rightEye: fitDraft.rightEye }); } catch { notify('Could not save the fit on this device.', 'err'); return; }
    await refreshAvatarAssets();
    setFitOpen(false);
    notify('Avatar face fit saved — its eyes now track yours.');
    if (avatarEngineRef.current && avatarPreviewOn && loadAvatarConfig().mode === '2d') { try { startAvatarPreview(); } catch {} }
  }

  function fitPointer(e, which) {
    if (!fitDraft || !fitImgRef.current) return;
    const rect = fitImgRef.current.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    setFitDraft(d => ({ ...d, [which]: { x: +x.toFixed(3), y: +y.toFixed(3) } }));
  }

  function onFitMove(e) { if (fitDragRef.current) fitPointer(e, fitDragRef.current); }
  function onFitUp() { fitDragRef.current = null; }

  function onFitDown(e, which) {
    fitDragRef.current = which;
    fitPointer(e, which);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  }

  function resetFit() { setFitDraft(defaultFit()); }

  // ── Avatar tracking calibration wizard ────────────────────────────────────────────────────────────
  // Each person's neutral head-hold and expression ranges differ, so a short
  // guided capture (neutral pose, then eyes-closed / open-mouth / smile /
  // brows-up, then a hands check) records min/max ranges that stretch the
  // user's real movement across the avatar's full range of motion.
  const CAL_STAGES = ['pose', 'body', 'blink', 'mouth', 'smile', 'brows', 'hands', 'arms'];
  const CAL_META = [
    { id: 'pose', icon: '🧍', label: 'Neutral pose', tip: 'Face the camera, head straight, relaxed face. We record where your eyes, nose and mouth sit so the avatar lines up with you.' },
    { id: 'body', icon: '🚶', label: 'Stand up straight', tip: "Step back so your whole torso is in frame, arms relaxed at your sides. We record your shoulder span and arm length so the avatar's body matches your build." },
    { id: 'blink', icon: '😑', label: 'Close your eyes', tip: 'Squeeze both eyes shut for a moment, then relax.', channels: ['eyeBlinkL', 'eyeBlinkR', 'eyeSquintL', 'eyeSquintR'] },
    { id: 'mouth', icon: '😮', label: 'Open your mouth wide', tip: 'A big yawn-sized opening.', channels: ['jawOpen'] },
    { id: 'smile', icon: '😁', label: 'Big smile', tip: 'A wide grin — show teeth if you can.', channels: ['mouthSmileL', 'mouthSmileR'] },
    { id: 'brows', icon: '🤨', label: 'Raise your eyebrows', tip: 'Look surprised.', channels: ['browInnerUp', 'browOuterUpL', 'browOuterUpR'] },
    { id: 'hands', icon: '🖐️', label: 'Show your hands', tip: 'Raise both hands, palms facing the camera, fingers apart.', channels: [] },
    { id: 'arms', icon: '🙆', label: 'Sweep your arms', tip: 'Slowly raise both arms STRAIGHT up overhead (no bent elbows — they shrink the top of your range), then lower them and spread out wide. Watch the meter fill as you sweep.', channels: [] },
  ];
  const [calOpen, setCalOpen] = useState(false);
  const [calBusy, setCalBusy] = useState(false);
  const [calMsg, setCalMsg] = useState('');
  const [calStream, setCalStream] = useState(null);
  const [calRecs, setCalRecs] = useState({});
  const [armSweep, setArmSweep] = useState(null);   // { l, r } raise 0..1 during the arms capture
  const [calHas, setCalHas] = useState(false);
  const calEngRef = useRef(null);
  const calCamRef = useRef(null);
  const calDataRef = useRef(null);
  const waitMs = ms => new Promise(r => setTimeout(r, ms));
  async function openCalibration() {
    if (calOpen) return;
    setCalOpen(true);
    setCalBusy(false);
    setCalMsg('Starting your camera…');
    setCalRecs({});
    calDataRef.current = { pose: null, base: {}, peaks: {}, body: null, armRange: null };
    setCalHas(!!(await loadCalibration()));
    let cam = null;
    try { cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 } } }); } catch { cam = null; }
    calCamRef.current = cam;
    const eng = createAvatarEngine({
      mode: '2d', rawOverlay: true, hands: true, cameraStream: cam,
      onStatus: st => { if (calEngRef.current === eng) setCalMsg(st === 'tracking' ? 'Face found — the rings should sit on your eyes and mouth. Now run each capture below.' : st === 'no-tracking-idle' ? 'Tracking unavailable — allow the camera and try again.' : st === 'no-camera-idle' ? 'No camera access — the wizard cannot see you. Allow camera permission in the browser and reopen this.' : String(st)); },
    });
    calEngRef.current = eng;
    setCalStream(eng.stream);
    eng.start().catch(() => {});
    setCalMsg('Waiting for your camera… center your face in the frame.');
  }

  async function closeCalibration() {
    if (!calOpen) return;
    setCalOpen(false);
    setCalStream(null);
    setCalMsg('');
    const eng = calEngRef.current; calEngRef.current = null;
    if (eng) { try { await eng.destroy(); } catch {} }
    const cam = calCamRef.current; calCamRef.current = null;
    if (cam) { try { cam.getTracks().forEach(t => t.stop()); } catch {} }
    setCalHas(!!(await loadCalibration()));
  }

  /** Poll N calibration samples; cb returns per-sample data. */
  async function collectSamples(n, every, cb) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const snap = calEngRef.current && calEngRef.current.calibrationSample();
      try { out.push(cb(snap)); } catch {}
      await waitMs(every);
    }
    return out;
  }

  async function capturePose() {
    setCalBusy(true);
    setCalMsg('Keep your head still, face straight on, relaxed…');
    const poses = [], blists = [];
    await collectSamples(16, 110, snap => { if (snap) { if (snap.pose && snap.landmarks) poses.push(snap.pose); if (snap.blends) blists.push(snap.blends); } });
    setCalBusy(false);
    if (poses.length < 7) { setCalMsg('⚠️ We could not see your face clearly. Face the camera in good light, head fully in frame, then capture again.'); return; }
    const avg = (arr, k) => arr.reduce((x, p) => x + (p[k] || 0), 0) / arr.length;
    calDataRef.current.pose = {
      yaw: avg(poses, 'yaw'), pitch: avg(poses, 'pitch'), roll: avg(poses, 'roll'),
      noseX: avg(poses, 'noseX'), noseY: avg(poses, 'noseY'),
    };
    // Neutral baseline per channel: 30th percentile (a stray blink mid-capture
    // must not inflate the resting value).
    const base = {};
    blists.forEach(b => Object.entries(b).forEach(([k, v]) => { (base[k] = base[k] || []).push(v); }));
    const lows = {};
    Object.entries(base).forEach(([k, arr]) => {
      const sorted = arr.slice().sort((a, b) => a - b);
      lows[k] = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.3))] || 0;
    });
    calDataRef.current.base = lows;
    setCalRecs(r => ({ ...r, pose: '✓ Neutral captured' }));
    setCalMsg('Neutral pose saved — the avatar will face straight when you relax. Now capture each expression below.');
  }

  async function captureBody() {
    setCalBusy(true);
    setCalMsg('Stand back from the camera, arms relaxed at your sides, facing straight on…');
    const metrics = [];
    await collectSamples(16, 110, snap => {
      if (!snap || !snap.body || snap.body.length < 25) return;
      const m = bodyMetrics(snap.body);
      if (m) metrics.push(m);
    });
    setCalBusy(false);
    if (metrics.length < 7) { setCalMsg('⚠️ We could not see your full body. Step back so your shoulders and torso are fully in frame, in decent light, then capture again.'); return; }
    const avg = (arr, k) => arr.reduce((x, m) => x + (m[k] || 0), 0) / arr.length;
    const body = {
      midX: avg(metrics, 'midX'), midY: avg(metrics, 'midY'),
      shoulderSpan: avg(metrics, 'shoulderSpan'),
      armLenL: avg(metrics, 'armLenL'), armLenR: avg(metrics, 'armLenR'),
    };
    if (body.shoulderSpan < 0.02) { setCalMsg('⚠️ You look too close — step back until your whole torso fits in frame, then capture again.'); return; }
    calDataRef.current.body = body;
    setCalRecs(r => ({ ...r, body: '✓ Body measured' }));
    setCalMsg("Body saved — the avatar's torso and arms now match your build. Next, the arm sweep.");
  }

  // Arms sweep: normalize each frame against a ROLLING neutral arm length —
  // the elbow chain (shoulder→elbow + elbow→wrist) — instead of the static
  // captured armLen. A user drifting toward the camera would otherwise have
  // their range compressed (bigger limbs) or inflated (smaller limbs), which
  // is exactly the distance-drift artifact seen in clip-based verification.
  // Returns {dy, dx} or null when the frame lacks landmarks.
  function armSweepSide(b, shIdx, elIdx, wrIdx) {
    const sh = b[shIdx], el = b[elIdx], wr = b[wrIdx];
    if (!sh || !el || !wr) return null;
    const chain = Math.hypot(el.x - sh.x, el.y - sh.y) + Math.hypot(wr.x - el.x, wr.y - el.y);
    if (!(chain > 1e-6)) return null;
    return { dy: (sh.y - wr.y) / chain, dx: (wr.x - sh.x) / chain, chain };
  }

  async function captureArms() {
    const body = calDataRef.current.body;
    if (!body) { setCalMsg('Capture your standing body measurement first.'); return; }
    setCalBusy(true);
    setArmSweep(null);
    setCalMsg('Slowly sweep: arms down → straight up overhead → out wide to your sides…');
    const rng = { l: { dy: [9, -9], dx: [9, -9] }, r: { dy: [9, -9], dx: [9, -9] } };
    let good = 0, bentTop = false;
    const PAD = 0.06, TOP_WARN = 0.75;   // pads match applyBodyCalibration's expectations
    const onSample = snap => {
      if (!snap || !snap.body || snap.body.length < 25) return;
      const b = snap.body;
      const l = armSweepSide(b, 11, 13, 15);
      const r = armSweepSide(b, 12, 14, 16);
      if (!l && !r) return;
      good++;
      const acc = (sideKey, v) => {
        if (!v) return;
        const t = rng[sideKey];
        t.dy[0] = Math.min(t.dy[0], v.dy); t.dy[1] = Math.max(t.dy[1], v.dy);
        t.dx[0] = Math.min(t.dx[0], v.dx); t.dx[1] = Math.max(t.dx[1], v.dx);
      };
      acc('l', l); acc('r', r);
      // Live raise meter: map the current dy into the running range so the user
      // sees the calibration bar fill as they sweep (0 = arms down, 1 = top).
      const norm = (v, t) => (v === null || t.dy[1] <= t.dy[0]) ? 0 : Math.min(1, Math.max(0, (v.dy - t.dy[0]) / (t.dy[1] - t.dy[0])));
      setArmSweep({ l: norm(l, rng.l), r: norm(r, rng.r) });
      // Straight-overhead arms give dy ≈ 1 (wrist above shoulder ≈ full chain
      // length). Bent elbows at the top shrink dy well below 1 — flag it so
      // users know to straighten before saving a squashed top of range.
      const topCheck = v => { if (v && v.dy > 0.55 && v.dy < TOP_WARN) bentTop = true; };
      topCheck(l); topCheck(r);
    };
    await collectSamples(18, 130, onSample);
    setCalBusy(false);
    setArmSweep(null);
    if (good < 7) { setCalMsg('⚠️ We lost your body mid-sweep — keep your whole torso in frame and capture again.'); return; }
    const span = Math.max(rng.l.dy[1] - rng.l.dy[0], rng.r.dy[1] - rng.r.dy[0]);
    if (span < 0.25) { setCalMsg('⚠️ That sweep only raised your arms ' + Math.round(span * 100) + '% of your reach — raise them higher (straight overhead) and spread wider, then capture again.'); return; }
    // Pad the captured band so resting positions don't sit exactly on the range edge.
    const pad = (t) => ({ min: +(t[0] - PAD).toFixed(3), max: +(t[1] + PAD).toFixed(3) });
    calDataRef.current.armRange = { l: { dy: pad(rng.l.dy), dx: pad(rng.l.dx) }, r: { dy: pad(rng.r.dy), dx: pad(rng.r.dx) } };
    setCalRecs(r => ({ ...r, arms: '✓ Full reach learned' }));
    setCalMsg(bentTop
      ? 'Reach learned — tip: you bent your elbows at the top, which shrinks the overhead range. Redo the sweep with straight arms for a fuller reach.'
      : 'Everything is captured — review the list, then hit "Save calibration".');
  }

  async function captureExpr(id) {
    const meta = CAL_META.find(m => m.id === id);
    if (!meta) return;
    setCalBusy(true);
    setCalMsg('Hold it: ' + meta.label.toLowerCase() + '…');
    const peaks = {};
    let good = 0;
    await collectSamples(12, 110, snap => {
      if (!snap || !snap.blends) return;
      good++;
      Object.entries(snap.blends).forEach(([k, v]) => { peaks[k] = Math.max(peaks[k] || 0, v); });
    });
    setCalBusy(false);
    if (good < 6) { setCalMsg('⚠️ We lost your face mid-capture — keep your head in frame and capture again.'); return; }
    const peak = Math.max(...(meta.channels || []).map(c => peaks[c] || 0));
    if (peak < 0.18) {
      setCalMsg('⚠️ That read as only ' + Math.round(peak * 100) + '% on "' + meta.label.toLowerCase() + '" — the avatar would barely move. Try again with more of the expression.');
      return;
    }
    calDataRef.current.peaks[id] = peaks;
    setCalRecs(r => ({ ...r, [id]: '✓ ' + Math.round(peak * 100) + '%' }));
    const idx = CAL_STAGES.indexOf(id);
    if (idx >= 0 && idx < CAL_STAGES.length - 1) setCalMsg(CAL_META[idx + 1].tip + ' Capture it when ready.');
    else setCalMsg('');
  }

  async function captureHands() {
    setCalBusy(true);
    setCalMsg('Raise both hands, palms facing the camera, fingers spread…');
    const counts = await collectSamples(12, 110, snap => (snap && snap.hands) ? snap.hands.length : 0);
    setCalBusy(false);
    const saw = counts.filter(n => n >= 1).length;
    const both = counts.filter(n => n >= 2).length;
    if (saw < 7) { setCalMsg('⚠️ We could not see your hands. Raise them into the frame, palms open, fingers apart, then capture again.'); return; }
    calDataRef.current.hands = { seen: both / counts.length };
    setCalRecs(r => ({ ...r, hands: both >= 3 ? '✓ Both hands seen' : '✓ Hands seen' }));
    const idx = CAL_STAGES.indexOf('hands');
    if (idx >= 0 && idx < CAL_STAGES.length - 1) setCalMsg(CAL_META[idx + 1].tip + ' Capture it when ready.');
    else setCalMsg('Everything is captured — review the list, then hit "Save calibration".');
  }

  const allCalCaptured = () => CAL_STAGES.every(id => calRecs[id]);

  async function saveCalibrationNow() {
    const d = calDataRef.current;
    if (!d.pose) { setCalMsg('Capture your neutral pose first.'); return; }
    if (!allCalCaptured()) { setCalMsg('Finish (or redo) every capture above first.'); return; }
    setCalBusy(true);
    const channels = {};
    const loOf = ch => (d.base[ch] !== undefined ? Math.min(d.base[ch], 0.3) : 0);
    CAL_META.filter(m => m.channels.length).forEach(meta => {
      const pk = d.peaks[meta.id]; if (!pk) return;
      meta.channels.forEach(ch => {
        const lo = +loOf(ch).toFixed(3);
        const hi = +(Math.max(pk[ch] || 0, lo + 0.05)).toFixed(3);
        channels[ch] = { min: lo, max: hi };
      });
    });
    const body = d.body ? { ...d.body, armRange: d.armRange || null } : null;
    const cal = { pose: d.pose, channels, hands: d.hands || { seen: 0 }, body, savedAt: Date.now() };
    try { await saveCalibration(cal); } catch { setCalBusy(false); setCalMsg('⚠️ Could not save the calibration on this device.'); return; }
    const eng = avatarEngineRef.current;
    if (eng) { try { eng.setCalibration(cal); } catch {} }
    // Push to every other running avatar engine (live calls, other instances) —
    // “one tracker, every avatar” stays true even mid-session.
    notifyCalibrationChanged(cal);
    setCalBusy(false);
    setCalHas(true);
    setCalRecs(r => ({ ...r, saved: '✓ Calibration saved' }));
    notify('Tracking calibration saved — expressions will now drive your avatar at full strength.');
    if (avatarEngineRef.current && avatarPreviewOn) { try { startAvatarPreview(); } catch {} }
  }

  async function resetCalibration() {
    calDataRef.current = { pose: null, base: {}, peaks: {}, body: null, armRange: null };
    await clearCalibration();
    const eng = avatarEngineRef.current;
    if (eng) { try { eng.setCalibration(null); } catch {} }
    notifyCalibrationChanged(null);
    setCalRecs({});
    setCalHas(false);
    setCalMsg('Calibration cleared — start over whenever you are ready.');
    notify('Tracking calibration cleared.');
  }

  // ── Voice & Video devices (per machine, kept in localStorage) ──────────────
  const [mediaPrefs, setMediaPrefs] = useState(loadMediaPrefs);
  const [mediaDevices, setMediaDevices] = useState({ audioinput: [], audiooutput: [], videoinput: [] });
  const [mediaStatus, setMediaStatus] = useState('');
  const micStreamRef = useRef(null);
  const camStreamRef = useRef(null);
  const micLevelRef = useRef(null);
  const camPreviewRef = useRef(null);
  const micRafRef = useRef(null);
  const micCtxRef = useRef(null);
  const [micTesting, setMicTesting] = useState(false);
  const [camOn, setCamOn] = useState(false);

  function stopMicTestStream() {
    micStreamRef.current?.getTracks().forEach(t => t.stop());
    micStreamRef.current = null;
    setMicTesting(false);
    if (micRafRef.current) { cancelAnimationFrame(micRafRef.current); micRafRef.current = null; }
    if (micLevelRef.current) micLevelRef.current.style.width = '0%';
    try { micCtxRef.current?.close(); } catch {}
    micCtxRef.current = null;
  }

  function stopCamPreview() {
    camStreamRef.current?.getTracks().forEach(t => t.stop());
    camStreamRef.current = null;
    setCamOn(false);
    if (camPreviewRef.current) camPreviewRef.current.srcObject = null;
  }

  function refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then(list => {
      const next = { audioinput: [], audiooutput: [], videoinput: [] };
      list.forEach(d => {
        if (next[d.kind]) next[d.kind].push({ id: d.deviceId, label: d.label || d.kind });
      });
      setMediaDevices(next);
    }).catch(() => {});
  }

  // Scan once when the tab opens (permission prompt reveals real device labels),
  // then keep the lists fresh when hardware is plugged/unplugged.
  useEffect(() => {
    if (tab !== 'voice') return;
    (async () => {
      try {
        // Unlock labels by requesting access once; the streams are stopped immediately.
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        probe.getTracks().forEach(t => t.stop());
        setMediaStatus('Found your devices — pick your favourites below.');
      } catch (err) {
        if (String(err?.name || '').includes('NotAllowed')) setMediaStatus('Permission was blocked. Allow microphone & camera access in your browser, then scan again.');
        else if (String(err?.name || '').includes('NotFound')) setMediaStatus('No microphone or camera was found on this device.');
        else setMediaStatus('Could not list devices: ' + (err?.message || 'unknown error'));
      }
      refreshDevices();
    })();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    refreshAvatarAssets();
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
      stopMicTestStream();
      stopCamPreview();
      stopAvatarPreview();
    };
  }, [tab]);

  function saveMediaPref(kind, id) {
    const next = { ...mediaPrefs, [kind]: id };
    setMediaPrefs(next);
    saveMediaPrefs(next);
    notify('Saved on this device');
  }

  // Show a live input-level bar through the chosen microphone for ~4s.
  async function testMic() {
    if (micStreamRef.current) { stopMicTestStream(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: mediaPrefs.mic ? { deviceId: { exact: mediaPrefs.mic } } : true,
      });
      micStreamRef.current = stream;
      setMicTesting(true);
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      micCtxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (!micStreamRef.current) return;
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs(data[i] - 128) / 128;
          if (v > peak) peak = v;
        }
        if (micLevelRef.current) micLevelRef.current.style.width = Math.min(100, Math.round(peak * 320)) + '%';
        micRafRef.current = requestAnimationFrame(tick);
      };
      micRafRef.current = requestAnimationFrame(tick);
      setTimeout(stopMicTestStream, 4000);
      notify('Speak now — watch the meter', false);
    } catch {
      notify('Could not start that microphone', true);
    }
  }

  // Play a short tone out of the chosen speaker (uses setSinkId when available).
  function testSpeaker() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const dest = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      gain.gain.value = 0.15;
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      osc.frequency.setValueAtTime(660, ctx.currentTime + 0.4);
      osc.connect(gain);
      gain.connect(dest);
      const el = document.createElement('audio');
      el.srcObject = dest.stream;
      el.autoplay = true;
      if (mediaPrefs.speaker && typeof el.setSinkId === 'function') {
        el.setSinkId(mediaPrefs.speaker).catch(() => {});
      }
      document.body.appendChild(el);
      osc.start();
      osc.stop(ctx.currentTime + 0.9);
      setTimeout(() => {
        try { osc.disconnect(); gain.disconnect(); dest.disconnect(); ctx.close(); } catch {}
        el.remove();
      }, 1100);
      notify('Playing a test tone…');
    } catch {
      notify('Could not play a test tone', true);
    }
  }

  async function toggleCameraPreview() {
    if (camStreamRef.current) { stopCamPreview(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: mediaPrefs.camera ? { deviceId: { exact: mediaPrefs.camera } } : { width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      camStreamRef.current = stream;
      setCamOn(true);
      requestAnimationFrame(() => {
        if (camPreviewRef.current) camPreviewRef.current.srcObject = stream;
      });
    } catch {
      notify('Could not start that camera', true);
    }
  }

  function deviceSelect(label, kind, list, icon) {
    const realDevices = list.filter(d => d.id && d.id !== 'default' && d.id !== 'communications');
    return (
      <div className="device-row">
        <span className="device-row-label">{icon} {label}</span>
        <select
          value={mediaPrefs[kind] || ''}
          onChange={e => saveMediaPref(kind, e.target.value)}
        >
          <option value="">System default</option>
          {realDevices.map(d => (
            <option key={d.id} value={d.id}>{d.label || 'Unnamed device'}</option>
          ))}
        </select>
      </div>
    );
  }

  useEffect(() => {
    api('/api/settings').then(s => setSettings(s));
    api('/api/anon/masks').then(m => setMasks(m));
    api('/api/me/anonymous/history').then(h => {
      setAnonHistory(h);
      setActiveAnon(h.find(i => i.active));
    });
    if (me?.interests) setSelectedInterests(me.interests.split(',').filter(Boolean));
  }, []);

  function notify(msg, isErr = false) {
    if (isErr) setErr(msg);
    else setSaved(msg);
    setTimeout(() => { setSaved(''); setErr(''); }, 3000);
  }

  async function saveSettings(patch) {
    const merged = { ...settings, ...patch };
    setSettings(merged);
    await api('/api/settings', { method: 'PATCH', body: JSON.stringify(merged) });
    notify('Saved!');
  }

  async function saveProfile(e) {
    e.preventDefault();
    const d = await api('/api/profile', { method: 'PATCH', body: JSON.stringify({ ...profile, interests: selectedInterests.join(',') }) });
    if (d.user) { onSave(d.user); notify('Profile saved!'); }
    else notify(d.error, true);
  }

  async function changePassword(e) {
    e.preventDefault();
    if (passwords.newPassword !== passwords.confirm) return notify('Passwords do not match', true);
    const d = await api('/api/me/change-password', { method: 'POST', body: JSON.stringify({ current: passwords.current, newPassword: passwords.newPassword }) });
    if (d.ok) { notify('Password changed!'); setPasswords({ current:'', newPassword:'', confirm:'' }); }
    else notify(d.error, true);
  }

  async function activateAnon(mask) {
    const d = await api('/api/me/anonymous', { method: 'POST', body: JSON.stringify({ maskName: mask.name }) });
    if (d.ok) {
      setActiveAnon({ mask_name: mask.name, mask_color: mask.color, mask_emoji: mask.emoji, active: 1 });
      api('/api/me/anonymous/history').then(h => setAnonHistory(h));
      onSave({ ...me, anon_active: true, anon_mask: mask.name, anon_color: mask.color });
      notify('Anonymous mode activated!');
    }
  }

  async function deactivateAnon() {
    await api('/api/me/anonymous', { method: 'DELETE' });
    setActiveAnon(null);
    onSave({ ...me, anon_active: false, anon_mask: '', anon_color: '' });
    notify('Anonymous mode deactivated.');
  }

  async function saveAnonNameColor() {
    const color = anonNameColor || '';
    const d = await api('/api/me/anonymous/name-color', { method:'PATCH', body: JSON.stringify({ color }) });
    if (d.error) return notify(d.error, true);
    onSave({ ...me, anon_name_color: color });
    notify(color ? 'Anonymous name color saved.' : 'Anonymous name color reset to automatic.');
  }

  async function applyGradient() {
    if (!activeAnon && !me?.anon_active) return notify('Activate a mask first', true);
    const g = customGrad || {};
    const d = await api('/api/me/anonymous/gradient', { method: 'POST', body: JSON.stringify({ start: g.start, mid: g.mid, end: g.end }) });
    if (d.error) return notify(d.error, true);
    onSave({ ...me, anon_color: JSON.stringify(d.gradient) });
    notify('Gradient applied — your mask background is updated everywhere.');
  }

  async function resetGradient() {
    if (!activeAnon && !me?.anon_active) return notify('Activate a mask first', true);
    const d = await api('/api/me/anonymous/gradient', { method: 'DELETE' });
    if (d.error) return notify(d.error, true);
    const mask = masks.find(m => m.name === me?.anon_mask);
    setCustomGrad(null);
    onSave({ ...me, anon_color: mask?.color || d.color || '' });
    notify('Gradient reset to the mask default.');
  }

  async function saveServerFavs(communityId, next) {
    const d = await api(`/api/me/anonymous/server-favorites/${encodeURIComponent(communityId)}`, { method: 'POST', body: JSON.stringify({ maskNames: next.map(f => f.name) }) });
    if (d.ok) {
      onSave({ ...me, server_fav_masks: JSON.stringify({ ...srvFavs, [communityId]: next.length ? next : undefined }) });
      notify(next.length ? `⭐ ${next.length} mask${next.length!==1?'s':''} starred for this server` : 'Cleared this server\'s presets');
    } else notify(d.error || 'Could not save server presets', true);
  }

  function maskKeyNav(e, list) {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const cur = e.currentTarget.getAttribute('data-idx');
    const next = Math.min(list.length - 1, Math.max(0, (cur == null ? 0 : Number(cur)) + dir));
    const ref = maskGridRef.current && maskGridRef.current[next];
    if (ref) ref.focus();
    setPreviewMask({ name: list[next].name, emoji: list[next].emoji, color: list[next].color });
  }

  async function saveFavorite(mask) {
    const next = mask ? (favMasks.some(f => f.name === mask.name) ? favMasks.filter(f => f.name !== mask.name) : [...favMasks, mask]) : [];
    const d = await api('/api/me/anonymous/favorite', { method: 'POST', body: JSON.stringify({ maskNames: next.map(f => f.name) }) });
    if (d.ok) {
      setFavMasks(next);
      const first = next[0] || null;
      onSave({ ...me, fav_masks: JSON.stringify(next), fav_mask: first?.name || '', fav_color: first?.color || '', fav_emoji: first?.emoji || '' });
      notify(mask ? (next.some(f => f.name === mask.name) ? `⭐ Starred ${mask.name.replace(/\S+\s+/,'')} — quick-swap cycles through ${next.length}` : `Removed ${mask.name.replace(/\S+\s+/,'')} from quick-swap`) : 'Quick-swap masks cleared');
    } else notify(d.error || 'Could not save', true);
  }

  async function quickSwap() {
    if (!favMasks.length) return notify('No quick-swap masks set — star one below', true);
    const current = activeAnon?.mask_name || me?.anon_mask;
    if (current && favMasks.some(f => f.name === current)) {
      // Wearing a starred mask — cycle to the next, or back to real after the last.
      const idx = favMasks.findIndex(f => f.name === current);
      const next = favMasks[idx + 1];
      if (!next) return await deactivateAnon();
      const mask = masks.find(m => m.name === next.name) || (await api('/api/anon/masks')).find(m => m.name === next.name);
      if (mask) { await activateAnon(mask); notify(`Swapped to ${mask.name.replace(/\S+\s+/,'')}`); }
    } else {
      const mask = masks.find(m => m.name === favMasks[0].name) || (await api('/api/anon/masks')).find(m => m.name === favMasks[0].name);
      if (mask) { await activateAnon(mask); notify(`Swapped to ${mask.name.replace(/\S+\s+/,'')}`); }
    }
  }

  async function reactivateAnon(id) {
    const d = await api(`/api/me/anonymous/reactivate/${id}`, { method: 'POST' });
    if (d.ok) { setActiveAnon(anonHistory.find(a => a.id === id)); api('/api/me/anonymous/history').then(h => setAnonHistory(h)); notify('Identity reactivated!'); }
  }

  async function genTempName() {
    const d = await api('/api/me/temp-username', { method: 'POST', body: JSON.stringify({ context: 'general' }) });
    setTempName(d.tempName || '');
    if (d.tempName) navigator.clipboard?.writeText(d.tempName).catch(() => {});
  }

  async function loadPrivacyCheckup() {
    const d = await api('/api/me/privacy-checkup');
    setPrivacyCheckup(d);
  }

  function toggleInterest(i) {
    setSelectedInterests(prev => prev.includes(i) ? prev.filter(x => x !== i) : [...prev, i]);
  }

  async function exportData() {
    setErr(''); setSaved(''); setExporting(true);
    try {
      const r = await fetch('/api/me/export', { headers: { Authorization: 'Bearer ' + getToken() } });
      if (!r.ok) {
        let msg = 'Export failed';
        try { const d = await r.json(); if (d && d.error) msg = d.error; } catch {}
        setErr(msg);
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'unknown-data-' + String((me && me.username) || 'user').replace(/[^A-Za-z0-9_-]/g, '') + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setSaved('Your data archive is downloading.');
    } catch { setErr('Export failed - try again.'); }
    finally { setExporting(false); }
  }

  async function deleteAccount() {
    setErr(''); setSaved(''); setDeleteBusy(true);
    try {
      const d = await api('/api/me', { method: 'DELETE', body: JSON.stringify({ password: delPassword }) });
      if (d.ok) {
        try { sessionStorage.removeItem('token'); } catch {}
        try { localStorage.removeItem('rememberToken'); } catch {}
        location.reload();
      } else {
        setErr(d.error || 'Could not delete the account');
        setDelPassword('');
      }
    } catch { setErr('Could not delete the account'); }
    finally { setDeleteBusy(false); }
  }
  const TABS = [
    { id: 'account',      emoji: '👤', label: 'Account' },
    { id: 'security',     emoji: '🔑', label: 'Security' },
    { id: 'ranks',        emoji: '🏆', label: 'Ranks & perks' },
    { id: 'privacy',      emoji: '🔒', label: 'Privacy' },
    { id: 'notifications',emoji: '🔔', label: 'Notifications' },
    { id: 'voice',        emoji: '🎙️', label: 'Voice & Video' },
    { id: 'appearance',   emoji: '🎨', label: 'Appearance' },
    { id: 'interests',    emoji: '⭐', label: 'Interests' },
    { id: 'anonymous',    emoji: '🎭', label: 'Anonymous' },
    { id: 'checkup',      emoji: '🕵️', label: 'Privacy Checkup' },
    { id: 'support',      emoji: '💬', label: 'Support' },
  ];

  // ── Security tab logic ───────────────────────────────────────────────────
  async function loadSecurity() {
    try {
      const status = await api('/api/me/2fa/status');
      if (typeof status.enabled === 'boolean') setTotpEnabled(status.enabled);
      const list = await api('/api/me/sessions');
      if (Array.isArray(list)) setSessions(list);
    } catch {}
    setSessionsLoaded(true);
  }
  const secNotice = (m) => { setSecMsg(m); setSecError(''); };
  const secFail = (m) => { setSecError(m); setSecMsg(''); };
  async function beginSetup(e) {
    e.preventDefault();
    setSecBusy(true); setSecMsg(''); setSecError('');
    try {
      const d = await api('/api/me/2fa/setup', { method: 'POST', body: JSON.stringify({ password: secPassword }) });
      if (d.error) return secFail(d.error);
      setSetupPending({ secret: d.secret, otpauthUrl: d.otpauthUrl, account: d.account });
      setVerifyCode('');
      setSecPassword('');
    } finally { setSecBusy(false); }
  }
  async function enableTotp(e) {
    e.preventDefault();
    setSecBusy(true); setSecMsg(''); setSecError('');
    try {
      const d = await api('/api/me/2fa/enable', { method: 'POST', body: JSON.stringify({ code: verifyCode.trim() }) });
      if (d.error) return secFail(d.error);
      setTotpEnabled(true);
      setSetupPending(null);
      setVerifyCode('');
      setRecoveryCodes(d.recoveryCodes || []);
      await loadSecurity();
    } finally { setSecBusy(false); }
  }
  async function disableTotp(e) {
    e.preventDefault();
    setSecBusy(true); setSecMsg(''); setSecError('');
    try {
      const d = await api('/api/me/2fa/disable', { method: 'POST', body: JSON.stringify({ password: disablePassword, code: disableCode.trim() }) });
      if (d.error) return secFail(d.error);
      setTotpEnabled(false);
      setDisablePassword(''); setDisableCode('');
      setRecoveryCodes(null);
      secNotice('Two-factor authentication is now off.');
      await loadSecurity();
    } finally { setSecBusy(false); }
  }
  async function revokeSession(id) {
    const d = await api('/api/me/sessions/revoke', { method: 'POST', body: JSON.stringify({ sessionId: id }) });
    if (d.error) return secFail(d.error);
    setSessions(s => s.filter(x => x.id !== id));
  }
  async function revokeOtherSessions() {
    const d = await api('/api/me/sessions/revoke-others', { method: 'POST', body: '{}' });
    if (d.error) return secFail(d.error);
    setSessions(s => s.filter(x => x.current));
    secNotice('Signed out of every other device.');
  }
  useEffect(() => {
    if (tab === 'security') loadSecurity();
  }, [tab]);

  const ago = (iso) => {
    if (!iso) return 'never';
    const ms = Date.now() - new Date(String(iso).replace(' ', 'T')).getTime();
    if (!(ms >= 0)) return 'just now';
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={e => e.stopPropagation()}>
        <div className="settings-sidebar">
          <div className="settings-title">Settings</div>
          {TABS.map(t => (
            <button key={t.id} title={t.emoji + ' ' + t.label} aria-label={t.label} className={`settings-tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
              <span className="settings-tab-emoji">{t.emoji}</span>
              <span className="settings-tab-label">{t.label}</span>
            </button>
          ))}
          <button className="settings-tab danger" onClick={onClose} title="Close settings" aria-label="Close settings" style={{ marginTop: 'auto' }}>✕</button>
        </div>

        <div className="settings-content">
          {saved && <div className="settings-banner ok">{saved}</div>}
          {err   && <div className="settings-banner err">{err}</div>}

          {/* ── Account ── */}
          {tab === 'account' && (
            <div className="settings-section">
              <h2>Account</h2>
              <form onSubmit={saveProfile} className="mini">
                <label>Display name<input value={profile.nickname} onChange={e => setProfile({...profile, nickname:e.target.value})} /></label>
                <label>Bio<textarea value={profile.bio} onChange={e => setProfile({...profile, bio:e.target.value})} rows={3} placeholder="Tell people about yourself…" /></label>
                <label>Custom status<input value={profile.custom_status} onChange={e => setProfile({...profile, custom_status:e.target.value})} placeholder="What's going on?" /></label>
                <button>Save profile</button>
              </form>

              <hr className="settings-hr" />
              <h3>Change Password</h3>
              <form onSubmit={changePassword} className="mini">
                <label>Current password<input type="password" value={passwords.current} onChange={e => setPasswords({...passwords,current:e.target.value})} /></label>
                <label>New password<input type="password" value={passwords.newPassword} onChange={e => setPasswords({...passwords,newPassword:e.target.value})} /></label>
                <label>Confirm new password<input type="password" value={passwords.confirm} onChange={e => setPasswords({...passwords,confirm:e.target.value})} /></label>
                <button>Change password</button>
              </form>

              <hr className="settings-hr" />
              <p className="muted-text">Your username: <b>{me?.username}#{me?.tag}</b></p>
              <hr className="settings-hr" />
              <h3>Your data</h3>
              <p className="muted-text">Download a JSON archive of your account: profile, messages, DMs, quest progress, uploads, anonymous identities and more. Nothing is hidden from you.</p>
              <button type="button" onClick={exportData} disabled={exporting}>{exporting ? 'Preparing archive...' : 'Download my data (JSON)'}</button>

              <hr className="settings-hr" />
              <h3 style={{ color: 'var(--danger)' }}>Delete account</h3>
              <p className="muted-text">Permanently deletes your account, your messages, DMs, uploads, quest progress and anonymous identities. Communities you own transfer to another member or are removed if empty. Moderation records are kept for safety. This cannot be undone.</p>
              <form className="mini" onSubmit={e => { e.preventDefault(); deleteAccount(); }}>
                <label>Password<input type="password" value={delPassword} onChange={e => setDelPassword(e.target.value)} placeholder="Enter your current password" /></label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '0.4rem 0' }}>
                  <input type="checkbox" checked={delConfirm} onChange={e => setDelConfirm(e.target.checked)} />
                  <span>I understand everything will be permanently erased.</span>
                </label>
                <button type="submit" className="danger-btn" disabled={!delPassword || !delConfirm || deleteBusy}>{deleteBusy ? 'Deleting...' : 'Delete my account'}</button>
              </form>
            </div>
          )}

          {/* ── Security ── */}
          {tab === 'security' && (
            <div className="settings-section">
              <h2>Security</h2>
              {secMsg && <p className="settings-saved">{secMsg}</p>}
              {secError && <p className="error" role="alert">{secError}</p>}

              <h3>Two-factor authentication</h3>
              <p className="muted-text">Protect this account with a one-time code from an authenticator app (Google Authenticator, Authy, 1Password…). You will be asked for a code after your password when signing in.</p>

              {!totpEnabled && !setupPending && (
                <form className="mini" onSubmit={beginSetup}>
                  <label>Password<input type="password" value={secPassword} onChange={e => setSecPassword(e.target.value)} autoComplete="current-password" placeholder="Confirm your password" /></label>
                  <button disabled={!secPassword || secBusy}>Turn on two-factor</button>
                </form>
              )}

              {!totpEnabled && setupPending && (
                <div className="mini">
                  <p className="muted-text">Add the account to your authenticator app with the setup link or secret below, then enter the 6-digit code it shows.</p>
                  <p className="muted-text">Account: <b>{setupPending.account}</b></p>
                  <p className="muted-text">Secret: <code>{setupPending.secret}</code></p>
                  <p className="muted-text">Setup link: <a href={setupPending.otpauthUrl} target="_blank" rel="noreferrer">open in authenticator</a></p>
                  <form onSubmit={enableTotp}>
                    <label>6-digit code<input aria-label="Authenticator code" value={verifyCode} onChange={e => setVerifyCode(e.target.value.replace(/[^0-9a-zA-Z-]/g, ''))} placeholder="000000" inputMode="numeric" autoFocus /></label>
                    <button disabled={verifyCode.trim().length < 6 || secBusy}>Verify and enable</button>
                    <button type="button" className="ghost" onClick={() => { setSetupPending(null); setSecPassword(''); setSecError(''); }}>Cancel</button>
                  </form>
                </div>
              )}

              {totpEnabled && (
                <div className="mini">
                  <p className="settings-saved">✓ Two-factor authentication is on.</p>
                  <p className="muted-text">To turn it off, enter your password and a current code from your authenticator app.</p>
                  <form onSubmit={disableTotp}>
                    <label>Password<input type="password" value={disablePassword} onChange={e => setDisablePassword(e.target.value)} autoComplete="current-password" /></label>
                    <label>Code<input aria-label="Authenticator code" value={disableCode} onChange={e => setDisableCode(e.target.value.replace(/[^0-9a-zA-Z-]/g, ''))} placeholder="000000" inputMode="numeric" /></label>
                    <button type="submit" disabled={!disablePassword || disableCode.trim().length < 6 || secBusy}>Turn off two-factor</button>
                  </form>
                </div>
              )}

              {recoveryCodes && (
                <div className="mini">
                  <b>Save these recovery codes</b>
                  <p className="muted-text">Each works once to sign in if you lose your authenticator. Store them somewhere safe — they are shown only this one time.</p>
                  <pre>{recoveryCodes.join('\n')}</pre>
                  <button type="button" onClick={() => { navigator.clipboard?.writeText(recoveryCodes.join('\n')).catch(() => {}); secNotice('Recovery codes copied to clipboard.'); }}>Copy codes</button>
                </div>
              )}

              <hr className="settings-hr" />
              <h3>Active sessions</h3>
              <p className="muted-text">Devices currently signed in to your account. Sign out anything you do not recognize — a new sign-in from an unknown device also sends you a notice.</p>
              {sessionsLoaded && sessions.length === 0 && <p className="empty-text">No active sessions.</p>}
              {sessions.map(s => (
                <div className="settings-toggle-row" key={s.id}>
                  <div>
                    <b>{s.device}{s.current && ' (this device)'}</b>
                    <p>Last active {ago(s.lastSeen || s.createdAt)} · signed in {ago(s.createdAt)}</p>
                  </div>
                  {!s.current && <button className="ghost" onClick={() => revokeSession(s.id)}>Sign out</button>}
                  {s.current && <span className="badge">Current</span>}
                </div>
              ))}
              {sessions.length > 1 && (
                <button type="button" className="ghost" onClick={revokeOtherSessions}>Log out all other sessions</button>
              )}
            </div>
          )}          {/* ── Ranks ── */}
          {tab === 'ranks' && (
            <div className="settings-section">
              <h2>Ranks & perks</h2>
              <p className="muted-text">Your current rank is <b>{me?.rank || (me?.badge === 'Knowns' ? 'Known' : 'Member')}</b>. Higher ranks unlock more community tools.</p>
              <div className="rank-list">
                {['New','Beginner','Starter','Member','Trusted','Community','Celebrity','Known'].map((rank, i) => (
                  <div key={rank} className={`rank-card${(me?.rank || 'Member') === rank ? ' current' : ''}`}>
                    <span className="rank-level">{i + 1}</span><div><b>{rank}</b><small>{['Join the community','Complete your profile','Participate positively','Chat and create','Earn trust','Lead communities','Stand out','All normal-user perks'][i]}</small></div>
                  </div>
                ))}
              </div>
              <p className="muted-text">Staff roles are granted only by official administrators and are separate from normal ranks.</p>
            </div>
          )}

          {/* ── Privacy ── */}
          {tab === 'privacy' && (
            <div className="settings-section">
              <h2>Privacy</h2>

              <div className="settings-toggle-row">
                <div>
                  <b>Private Profile Mode</b>
                  <p>Others only see your username and avatar. Bio, status, and banner are hidden.</p>
                </div>
                <label className="toggle">
                  <input type="checkbox" checked={Boolean(settings.privacy_profile)} onChange={e => saveSettings({privacy_profile: e.target.checked ? 1 : 0})} />
                  <span className="toggle-slider" />
                </label>
              </div>

              <div className="settings-toggle-row">
                <div>
                  <b>No Friends Mode</b>
                  <p>Disables friend requests. People cannot add you as a friend.</p>
                </div>
                <label className="toggle">
                  <input type="checkbox" checked={Boolean(settings.no_friends)} onChange={e => saveSettings({no_friends: e.target.checked ? 1 : 0})} />
                  <span className="toggle-slider" />
                </label>
              </div>

              <div className="settings-toggle-row">
                <div>
                  <b>Show Interests</b>
                  <p>Let others see your interest tags on your profile.</p>
                </div>
                <label className="toggle">
                  <input type="checkbox" checked={Boolean(settings.show_interests ?? 1)} onChange={e => saveSettings({show_interests: e.target.checked ? 1 : 0})} />
                  <span className="toggle-slider" />
                </label>
              </div>

              <div className="settings-toggle-row">
                <div>
                  <b>World Discovery</b>
                  <p>Tag your activity (gaming, sleeping, etc.) so others can find active people.</p>
                </div>
                <label className="toggle">
                  <input type="checkbox" checked={Boolean(settings.world_discovery)} onChange={e => saveSettings({world_discovery: e.target.checked ? 1 : 0})} />
                  <span className="toggle-slider" />
                </label>
              </div>

              <hr className="settings-hr" />
              <h3>Data requests</h3>
              <p className="muted-text">Review incoming requests for your account or track requests you have submitted.</p>
              <button type="button" onClick={onOpenDataRequests}>📋 Open data requests</button>

              <hr className="settings-hr" />
              <h3>One-Time Username</h3>
              <p className="muted-text">Generate a temporary anonymous username for a conversation. It gets copied to your clipboard.</p>
              <button onClick={genTempName}>Generate temp username</button>
              {tempName && <div className="settings-banner ok">Generated: <b>{tempName}</b> (copied to clipboard)</div>}

              <hr className="settings-hr" />
              <p className="muted-text" style={{fontSize:'0.8rem'}}>⚠ Remember: anyone in a chat can screenshot. Don't share personal information.</p>
            </div>
          )}

          {/* ── Notifications ── */}
          {tab === 'notifications' && (
            <div className="settings-section">
              <h2>Notifications</h2>

              <div className="settings-toggle-row">
                <div><b>Mute all notifications</b><p>No banners or sounds for anything.</p></div>
                <label className="toggle">
                  <input type="checkbox" checked={Boolean(settings.notif_mute_all)} onChange={e => saveSettings({notif_mute_all: e.target.checked ? 1 : 0})} />
                  <span className="toggle-slider" />
                </label>
              </div>
              <div className="settings-toggle-row">
                <div><b>Ping notifications (@mentions)</b></div>
                <label className="toggle">
                  <input type="checkbox" checked={Boolean(settings.notif_pings ?? 1)} onChange={e => saveSettings({notif_pings: e.target.checked ? 1 : 0})} />
                  <span className="toggle-slider" />
                </label>
              </div>
              <div className="settings-toggle-row">
                <div><b>DM notifications</b></div>
                <label className="toggle">
                  <input type="checkbox" checked={Boolean(settings.notif_dms ?? 1)} onChange={e => saveSettings({notif_dms: e.target.checked ? 1 : 0})} />
                  <span className="toggle-slider" />
                </label>
              </div>
              <div className="settings-toggle-row">
                <div><b>Reply notifications</b></div>
                <label className="toggle">
                  <input type="checkbox" checked={Boolean(settings.notif_replies ?? 1)} onChange={e => saveSettings({notif_replies: e.target.checked ? 1 : 0})} />
                  <span className="toggle-slider" />
                </label>
              </div>
            </div>
          )}

          {/* ── Appearance ── */}
          {tab === 'appearance' && (
            <div className="settings-section">
              <h2>Appearance</h2>
              <h3>Theme</h3>
              <div className="theme-grid">
                {THEMES.map(t => (
                  <button
                    key={t.id}
                    className={`theme-swatch${currentTheme === t.id ? ' active' : ''}`}
                    style={{ background: t.preview }}
                    onClick={() => { onThemeChange(t.id); notify('Theme applied!'); }}
                    title={t.label}
                  >
                    <span>{t.label}</span>
                  </button>
                ))}
              </div>

              <hr className="settings-hr" />
              <h3>Chat Background</h3>
              <div className="bg-grid">
                {BG_OPTIONS.map(b => (
                  <button
                    key={b.id}
                    className={`bg-swatch bg-${b.id}${settings.chat_bg === b.id ? ' active' : ''}`}
                    onClick={() => saveSettings({ chat_bg: b.id })}
                  >
                    {b.label}
                  </button>
                ))}
              </div>

              <hr className="settings-hr" />
              <h3>Profile Accent Color</h3>
              <label className="appearance-control">Gradient end color
              <input
                type="color"
                value={settings.profile_theme_end || '#eb459e'}
                onChange={e => saveSettings({ profile_theme_end: e.target.value })}
                style={{ width: 48, height: 36, padding: 2, cursor: 'pointer' }}
              /></label>
              <input
                type="color"
                value={settings.profile_theme || '#5865f2'}
                onChange={e => saveSettings({ profile_theme: e.target.value })}
                style={{ width: 48, height: 36, padding: 2, cursor: 'pointer' }}
              />
            </div>
          )}

          {/* ── Voice & Video ── */}
          {tab === 'voice' && (
            <div className="settings-section">
              <h2>Voice & Video</h2>
              <p className="muted-text">Choose the microphone, speaker, and camera this device uses for calls, voice channels, and video rooms. Choices are stored on this device only.</p>

              <div className="settings-toggle-row" style={{ alignItems: 'center' }}>
                <button onClick={() => { setMediaStatus('Scanning…'); (async () => { try { const p = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }); p.getTracks().forEach(t => t.stop()); setMediaStatus(''); } catch {} refreshDevices(); setMediaStatus('Devices refreshed.'); })(); }}>🔄 Scan for devices</button>
                <span className="muted-text" style={{ fontSize: '.82rem' }}>{mediaStatus}</span>
              </div>

              {deviceSelect('Microphone', 'mic', mediaDevices.audioinput, '🎤')}
              {deviceSelect('Speaker / Output', 'speaker', mediaDevices.audiooutput, '🔈')}
              {deviceSelect('Camera', 'camera', mediaDevices.videoinput, '📷')}

              <hr className="settings-hr" />
              <h3>Test your setup</h3>
              <div className="settings-toggle-row" style={{ flexWrap: 'wrap', gap: '.5rem' }}>
                <button onClick={testMic}>{micTesting ? '⏹ Stop test' : '🎤 Test microphone'}</button>
                <button onClick={testSpeaker}>🔊 Test speaker</button>
                <button onClick={toggleCameraPreview}>{camOn ? '⏹ Stop camera' : '📷 Preview camera'}</button>
              </div>
              <div className="mic-level-track" style={{ height: 10, borderRadius: 5, background: 'var(--bg)', border: '1px solid var(--border)', overflow: 'hidden', marginTop: '.6rem' }}>
                <div ref={micLevelRef} className="mic-level-fill" style={{ width: '0%', height: '100%', background: micTesting ? 'var(--brand, #5865f2)' : 'var(--border)', transition: 'width 60ms linear' }} />
              </div>
              <video ref={camPreviewRef} autoPlay muted playsInline style={{ width: '100%', maxHeight: 220, borderRadius: 8, background: '#000', marginTop: '.6rem', display: camOn ? 'block' : 'none' }} />

              <hr className="settings-hr" />
              <h3>🤖 Your avatar — use it instead of your face</h3>
              <p className="muted-text" style={{ fontSize: '.85rem', marginTop: '.35rem' }}>
                In video rooms and when you turn the camera on in a call, you can send an animated avatar instead of your real face.
                Your webcam (if you allow it) is used <b>only on this device</b> to track your face, eyes, mouth, hands and body — it is never transmitted.
                Without a camera the avatar still breathes, blinks and talks along with your microphone.
              </p>

              <div className="avatar-unlocks" aria-label="Avatar types unlocked by your rank">
                {avatarUnlocks.map(u => (
                  <span key={u.id} className={`avatar-unlock${vrmUnlocked || u.id !== 'vrm' ? '' : ' locked'}`} title={u.note}>
                    {u.label}{u.id === 'vrm' && vrmUnlocked && <b className="unlock-check"> ✓</b>}
                    <small>{u.note}</small>
                  </span>
                ))}
              </div>

              <div className="avatar-mode-row">
                {[['camera', '📷', 'Real camera'], ['2d', '🖼️', '2D picture'], ['3d', '🧍', '3D model'], ['external', '🧪', 'External app']].map(([id, ic, label]) => (
                  <button key={id} className={`avatar-mode-btn${avatarCfg.mode === id ? ' active' : ''}`} onClick={() => setAvatarMode(id)}>
                    {ic} {label}{id === '3d' && !vrmUnlocked && <span className="mode-staff-dot" title="VRM models are staff-only (.glb available to all)" />}
                  </button>
                ))}
              </div>

              <div className="avatar-asset-grid">
                <div className="avatar-asset-card">
                  <div className="avatar-asset-title">🖼️ 2D picture</div>
                  <p className="muted-text" style={{ fontSize: '.8rem' }}>PNG / WebP / JPG / GIF. Head-follow, closeness zoom, roll &amp; talking motion. Transparent PNGs look best.</p>
                  {avatarAssets['2d']
                    ? <div className="avatar-asset-file"><span>📄 {avatarAssets['2d'].name}</span><button className="avatar-asset-remove" onClick={() => removeAvatarAsset('2d')}>Remove</button></div>
                    : <button className="avatar-asset-add" onClick={() => pickAvatarFile('2d')}>⬆ Upload picture</button>}
                </div>
                <div className="avatar-asset-card">
                  <div className="avatar-asset-title">🧍 3D model {!vrmUnlocked && <span className="staff-badge" title={`VRM models need the Founder, Owner or Administrator rank — your rank: ${me?.rank || 'Member'}`}>🔒 VRM staff-only</span>}</div>
                  <p className="muted-text" style={{ fontSize: '.8rem' }}>.glb{vrmUnlocked ? ' / .vrm' : ''}. Full face animation — blink, eyes, brows, mouth — drives the model's morph targets when names match (VRM, ARKit, common exports).{!vrmUnlocked && ' VRM uploads need a staff rank — .glb works for everyone.'}</p>
                  {avatarAssets['3d']
                    ? <div className="avatar-asset-file"><span>📄 {avatarAssets['3d'].name}</span><button className="avatar-asset-remove" onClick={() => removeAvatarAsset('3d')}>Remove</button></div>
                    : <button className="avatar-asset-add" onClick={() => pickAvatarFile('3d')}>⬆ Upload model</button>}
                </div>
              </div>

              {avatarAssets['2d'] && (
                <div className="avatar-fit-toggle">
                  <button onClick={openFitEditor}>🎯 {avatarAssets['2d'].fit ? "Refit avatar's eyes (fitted ✓)" : "Fit avatar's eyes"}</button>
                  <span className="muted-text" style={{ fontSize: '.78rem' }}>
                    If the picture's face is not centered, drag the markers onto its eyes so head-follow, closeness and turns pivot from its real face (like avatar software fitting).
                  </span>
                </div>
              )}

              {fitOpen && avatarAssets['2d'] && (
                <div className="fit-editor">
                  <b>Drag the markers onto the picture's eyes</b>
                  <p className="muted-text" style={{ fontSize: '.8rem', margin: '.25rem 0 .5rem' }}>
                    The ● markers track the picture's left and right eye. When saved, the avatar's eyes pin to the position and size of <i>your</i> tracked eyes.
                  </p>
                  <div className="fit-stage" onPointerMove={onFitMove} onPointerUp={onFitUp} onPointerLeave={onFitUp}>
                    <img ref={fitImgRef} src={avatarAssets['2d'].url} alt="Avatar picture for eye fitting" draggable={false} />
                    {fitDraft && (
                      <>
                        <button className="fit-marker fit-left" style={{ left: (fitDraft.leftEye.x * 100) + '%', top: (fitDraft.leftEye.y * 100) + '%' }}
                          onPointerDown={e => onFitDown(e, 'leftEye')} aria-label="Left eye marker">L</button>
                        <button className="fit-marker fit-right" style={{ left: (fitDraft.rightEye.x * 100) + '%', top: (fitDraft.rightEye.y * 100) + '%' }}
                          onPointerDown={e => onFitDown(e, 'rightEye')} aria-label="Right eye marker">R</button>
                      </>
                    )}
                  </div>
                  <div className="fit-actions">
                    <button onClick={resetFit}>Reset</button>
                    <button onClick={() => setFitOpen(false)}>Cancel</button>
                    <button className="cal-save" onClick={saveFit}>Save fit</button>
                  </div>
                </div>
              )}

              {avatarCfg.mode !== 'camera' && (
                <div className="avatar-preview-block">
                  {avatarCfg.mode === 'external' && (
                    <div className="avatar-external-device">
                      <b>🧪 External avatar app camera</b>
                      <p className="muted-text" style={{ fontSize: '.82rem', margin: '.2rem 0 .4rem' }}>
                        Run <b>VTube Studio</b>, <b>OBS</b>, <b>Snap Camera</b> (or any app that offers a virtual camera) and pick its device below.
                        Calls and video rooms then send <i>exactly what that app renders</i> — no built-in face tracking is involved.
                        “System default” auto-picks the first virtual camera the browser can find.
                      </p>
                      <select
                        aria-label="External camera app device"
                        value={mediaDevices.videoinput.some(d => d.id === avatarCfg.externalId) ? avatarCfg.externalId : ''}
                        onChange={async (e) => {
                          const next = { ...avatarCfg, externalId: e.target.value };
                          setAvatarCfg(next);
                          saveAvatarConfig(next);
                          if (avatarPreviewOn) startAvatarPreview();
                        }}
                      >
                        <option value="">System default (auto-detect virtual camera)</option>
                        {(mediaDevices.videoinput || []).filter(d => d.id && d.id !== 'default' && d.id !== 'communications').map(d => (
                          <option key={d.id} value={d.id}>{d.label || 'Unnamed device'}{isVirtualCamLabel(d.label) ? ' (virtual cam)' : ''}</option>
                        ))}
                      </select>
                      {(!mediaDevices.videoinput || mediaDevices.videoinput.length === 0) && (
                        <p className="muted-text" role="status" style={{ fontSize: '.8rem' }}>No cameras found — press 🔄 Scan (or allow camera access), start the app, then scan again.</p>
                      )}
                    </div>
                  )}
                  <div className="settings-toggle-row">
                    <button onClick={startAvatarPreview} disabled={avatarPreviewOn || (avatarCfg.mode === 'external' ? !(mediaDevices.videoinput && mediaDevices.videoinput.length) : !(avatarCfg.mode === '2d' ? avatarAssets['2d'] : avatarAssets['3d']))}>
                      {avatarPreviewOn ? '▶ Previewing…' : (avatarCfg.mode === 'external' ? '▶ Preview external camera' : '▶ Preview avatar')}
                    </button>
                    {avatarPreviewOn && <button onClick={() => stopAvatarPreview()}>⏹ Stop preview</button>}
                    {avatarCfg.mode !== 'external' && (
                      <>
                        <label className="avatar-hands-label">
                          <input type="checkbox" checked={avatarCfg.hands} onChange={async (e) => { const next = { ...avatarCfg, hands: e.target.checked }; setAvatarCfg(next); saveAvatarConfig(next); const eng = avatarEngineRef.current; if (eng) { try { eng.setHands(next.hands); } catch {} } }} />
                          <span>Show tracked hands 🖐️</span>
                        </label>
                        <label className="avatar-hands-label">
                          <input type="checkbox" checked={avatarCfg.body !== false} onChange={async (e) => { const next = { ...avatarCfg, body: e.target.checked }; setAvatarCfg(next); saveAvatarConfig(next); const eng = avatarEngineRef.current; if (eng) { try { eng.setBody(next.body); } catch {} } }} />
                          <span>Show tracked body 🦴</span>
                        </label>
                      </>
                    )}
                    {avatarCfg.mode === '3d' && (
                      <label className="avatar-hands-label" style={{ width: '100%' }}>
                        <span style={{ whiteSpace: 'nowrap' }}>Gravity for hair &amp; clothes 🪐</span>
                        <input type="range" min="0" max="1" step="0.05" value={avatarCfg.gravity ?? 0.5}
                          onChange={async (e) => { const next = { ...avatarCfg, gravity: parseFloat(e.target.value) }; setAvatarCfg(next); saveAvatarConfig(next); const eng = avatarEngineRef.current; if (eng) { try { eng.setGravityStrength(next.gravity); } catch {} } }}
                          aria-label="Gravity strength for hair and clothes" style={{ flex: 1 }} />
                        <small className="muted-text" style={{ minWidth: 34, textAlign: 'right' }}>{Math.round((avatarCfg.gravity ?? 0.5) * 100)}%</small>
                      </label>
                    )}
                  </div>
                  {avatarStatus && <p className="muted-text avatar-status" role="status">{avatarStatus}</p>}
                  {avatarCfg.mode !== 'external' && (
                    <div className="settings-toggle-row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                      <button onClick={openCalibration} disabled={calOpen}>📏 Calibrate tracking{calHas ? ' (calibrated ✓)' : ''}</button>
                      <span className="muted-text" style={{ fontSize: '.8rem' }}>
                        A 30-second guided setup — neutral pose, standing body, eyes-closed, open mouth, smile, brows, hands, arm sweep — so the tracker stretches <i>your</i> real ranges across every avatar's full motion.
                      </span>
                    </div>
                  )}
                  <video ref={avatarPrevRef} autoPlay muted playsInline style={{ display: avatarPreviewOn ? 'block' : 'none', width: '100%', maxHeight: 240, borderRadius: 10, background: '#0b0b12', marginTop: '.5rem', transform: 'scaleX(-1)' }} />
                </div>
              )}

              <hr className="settings-hr" />
              <h3>Need help?</h3>
              <p className="muted-text" style={{ fontSize: '.82rem' }}>If a device doesn't appear, make sure it is connected and that this site has permission to use it (the 🔄 Scan button asks for access). When an avatar mode is active above, calls send your avatar instead of the camera.</p>
              {calOpen && (
                <div className="cal-overlay" role="dialog" aria-modal="true" aria-label="Calibrate avatar tracking">
                  <div className="cal-modal">
                    <div className="cal-head">
                      <h3 style={{ margin: 0 }}>📏 Calibrate your avatar tracking</h3>
                      <button className="cal-close" onClick={closeCalibration} aria-label="Close">✕</button>
                    </div>
                    <p className="muted-text" style={{ fontSize: '.83rem', margin: '.35rem 0 .7rem' }}>
                      The rings show where the tracker sees your <b>eyes, pupils, mouth, hands and body</b> — if they sit on the right spots, run the eight captures below. Each capture only takes a second and you can redo any of them.
                    </p>
                    <div className="cal-body">
                      <div className="cal-stage">
                        <video className="cal-video" ref={el => { if (el && el.srcObject !== calStream) el.srcObject = calStream; }} autoPlay muted playsInline />
                        <div className="cal-msg" role="status">{calMsg}</div>
                        {calHas && <div className="cal-has">✓ You already have a saved calibration — redo it any time for a better fit.</div>}
                      </div>
                      <div className="cal-steps">
                        {CAL_META.map((m, i) => (
                          <div key={m.id} className={'cal-step' + (calRecs[m.id] ? ' done' : '')}>
                            <span className="cal-step-icon">{m.icon}</span>
                            <div className="cal-step-info">
                              <b>{i + 1}. {m.label}</b>
                              <p>{m.tip}</p>
                            </div>
                            <button className="cal-capture" disabled={calBusy}
                              onClick={() => { m.id === 'pose' ? capturePose() : m.id === 'body' ? captureBody() : m.id === 'hands' ? captureHands() : m.id === 'arms' ? captureArms() : captureExpr(m.id); }}>
                              {calBusy ? '…' : calRecs[m.id] ? 'Redo' : 'Capture'}
                            </button>
                            {calRecs[m.id] && <span className="cal-step-done">{calRecs[m.id]}</span>}
                            {m.id === 'arms' && armSweep && !calRecs[m.id] && (
                              <span className="arm-meter" role="meter" aria-label="Arm raise coverage" aria-valuemin={0} aria-valuemax={1} aria-valuenow={Math.round(Math.max(armSweep.l, armSweep.r) * 100) / 100}>
                                <span className="arm-meter-bar"><span className="arm-meter-fill" style={{ width: Math.round(Math.max(armSweep.l, armSweep.r) * 100) + '%' }} /></span>
                                <small>{Math.round(Math.max(armSweep.l, armSweep.r) * 100)}% raised</small>
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="cal-foot">
                      <button onClick={resetCalibration} disabled={calBusy}>🗑 Reset calibration</button>
                      <span style={{ flex: 1 }} />
                      <button onClick={closeCalibration} disabled={calBusy}>Cancel</button>
                      <button className="cal-save" onClick={saveCalibrationNow} disabled={calBusy || !allCalCaptured()}>💾 Save calibration</button>
                    </div>
                  </div>
                </div>
              )}
              <input ref={el => { avatarFileRef.current['2d'] = el; }} type="file" accept=".png,.jpg,.jpeg,.webp,.gif,image/*" style={{ display: 'none' }} onChange={(e) => onAvatarFile('2d', e)} />
              <input ref={el => { avatarFileRef.current['3d'] = el; }} type="file" accept=".glb,.vrm,model/gltf-binary" style={{ display: 'none' }} onChange={(e) => onAvatarFile('3d', e)} />
            </div>
          )}

          {/* ── Interests ── */}
          {tab === 'interests' && (
            <div className="settings-section">
              <h2>Your Interests</h2>
              <p className="muted-text">Select what you're into. We'll use this to recommend public servers.</p>
              <div className="interests-grid">
                {INTERESTS_LIST.map(i => (
                  <button
                    key={i}
                    className={`interest-chip${selectedInterests.includes(i) ? ' active' : ''}`}
                    onClick={() => toggleInterest(i)}
                  >
                    {i}
                  </button>
                ))}
              </div>
              <button style={{ marginTop: '1rem' }} onClick={() => {
                api('/api/profile', { method: 'PATCH', body: JSON.stringify({ interests: selectedInterests.join(',') }) }).then(d => {
                  if (d.user) { onSave(d.user); notify('Interests saved!'); }
                });
              }}>Save interests</button>
            </div>
          )}

          {/* ── Anonymous ── */}
          {tab === 'anonymous' && (
            <div className="settings-section">
              <h2>Anonymous Mode</h2>
              <p className="muted-text">Go anonymous with a mask identity. Your real username is hidden from other users. Admins can still identify you if needed.</p>

              {activeAnon ? (
                <div className="anon-active-card">
                  <span
                    className="anon-active-avatar"
                    style={{ background: maskGradient(activeAnon.mask_color || me?.anon_color) }}
                  >{masks.find(m => m.name === activeAnon.mask_name)?.emoji || '🎭'}</span>
                  <div>
                    <b>{activeAnon.mask_name}</b>
                    <p>Anonymous mode is ON</p>
                  </div>
                  <button className="danger-btn" onClick={deactivateAnon}>Deactivate</button>
                </div>
              ) : (
                <p className="muted-text">Anonymous mode is off. Pick a mask to activate it.</p>
              )}

              <hr className="settings-hr" />
              <h3>Choose a mask</h3>
              {favMasks.length > 0 && (
                <div className="fav-quick-swap" style={{ background:'rgba(250,168,26,0.12)', border:'1px solid rgba(250,168,26,0.3)', borderRadius:'8px', padding:'0.55rem 0.7rem', marginBottom:'0.6rem', display:'flex', alignItems:'center', gap:'0.6rem' }}>
                  <span style={{fontSize:'1.3rem'}}>{me?.fav_emoji || '⭐'}</span>
                  <div style={{flex:1, minWidth:0}}>
                    <b style={{fontSize:'0.85rem'}}>Quick-swap presets ({favMasks.length})</b>
                    <p style={{margin:0, fontSize:'0.74rem', color:'var(--muted)'}}>Each press cycles: {favMasks.map(f => f.name.replace(/^\S+\s+/,'')).join(' → ')} → real identity.</p>
                  </div>
                  <button onClick={quickSwap}>{(activeAnon?.mask_name && favMasks.some(f => f.name === activeAnon?.mask_name)) ? '▶ Cycle' : '⚡ Swap'}</button>
                  <button className="ghost" title="Clear all quick-swap masks" onClick={() => saveFavorite(null)}>✕</button>
                </div>
              )}
              {(() => {
                const p = previewMask || (me?.anon_active ? { emoji: me.anon_emoji || '🎭', color: me.anon_color, name: me.anon_mask } : null);
                return (
                  <div className="mask-preview">
                    <div
                      className="mask-preview-avatar"
                      style={{ background: p ? maskGradient(p.color) : 'var(--soft)' }}
                    >
                      <span>{p ? p.emoji : '🎭'}</span>
                    </div>
                    <div className="mask-preview-meta">
                      <small>{previewMask ? 'Hover preview' : (me?.anon_active ? 'Current look' : 'Preview')}</small>
                      <div className="mask-preview-chip">
                        <span className="mask-preview-mini" style={{ background: p ? maskGradient(p.color) : 'var(--soft)' }}>{p ? p.emoji : '🎭'}</span>
                        <b style={{ color: maskNameColor(me?.username||'') }}>{p ? p.name.replace(/^\S+\s+/,'') : 'mask'}</b>
                      </div>
                      <p style={{fontSize:'0.74rem',color:'var(--muted)',margin:'0.2rem 0 0'}}>In chat, your name shows as <b style={{color:maskNameColor(me?.username||'')}}>{p ? p.name.replace(/^\S+\s+/,'') : 'mask'}</b> beside this avatar.</p>
                      <span className={"mask-preview-strip " + (p ? 'mask-preview-strip-filled' : 'mask-preview-strip-default')} style={p ? { '--strip-start': p.color, '--strip-mid': (typeof p.color === 'object' && p.color && p.color.mid) ? p.color.mid : p.color, '--strip-end': (typeof p.color === 'object' && p.color && p.color && p.color.end) ? p.color.end : p.color } : {} }></span>
                    </div>
                  </div>
                );
              })()}
              <div className="anon-name-color-picker" style={{ marginTop:'0.75rem', padding:'0.7rem', background:'var(--soft)', borderRadius:'10px' }}>
                <b>✍️ Anonymous name color</b>
                <p className="muted-text" style={{ margin:'0.15rem 0 0.5rem', fontSize:'0.74rem' }}>Choose the color of your anonymous persona's name instead of the automatic username tint.</p>
                <div style={{ display:'flex', alignItems:'center', gap:'0.55rem', flexWrap:'wrap' }}>
                  <input type="color" value={anonNameColor || '#5865f2'} onChange={e => setAnonNameColor(e.target.value)} style={{ width:42, height:30, padding:2, cursor:'pointer' }} />
                  <span className="masked-name-preview" style={{ color: anonNameColor || 'var(--muted)', fontWeight:700 }}>{String(previewMask?.name ?? (me?.anon_active ? me.anon_mask : '')).replace(/^\S+\s+/,'') || 'Anonymous'}</span>
                  <button onClick={saveAnonNameColor} disabled={!activeAnon && !me?.anon_active}>Save color</button>
                  <button className="ghost" onClick={() => { setAnonNameColor(''); api('/api/me/anonymous/name-color', { method:'PATCH', body:JSON.stringify({color:''}) }); onSave({ ...me, anon_name_color:'' }); }} disabled={!me?.anon_name_color}>Reset</button>
                </div>
              </div>
              <div className="anon-gradient-picker">
                <b>🎨 Custom gradient</b>
                <p className="muted-text" style={{margin:'0.15rem 0 0.5rem', fontSize:'0.74rem'}}>Pick your own background colors — the mask avatar updates everywhere (chat, DMs, profile).</p>
                <div className="anon-gradient-row">
                  <label>Start <input type="color" value={customGrad?.start || '#6d28d9'} onChange={e => setCustomGrad(g => ({ ...(g||{}), start: e.target.value }))} /></label>
                  <label>Mid <input type="color" value={customGrad?.mid || '#9333ea'} onChange={e => setCustomGrad(g => ({ ...(g||{}), mid: e.target.value }))} /></label>
                  <label>End <input type="color" value={customGrad?.end || '#0ea5e9'} onChange={e => setCustomGrad(g => ({ ...(g||{}), end: e.target.value }))} /></label>
                </div>
                <div className="anon-gradient-actions">
                  <button onClick={applyGradient} disabled={!(activeAnon || me?.anon_active)}>Apply gradient</button>
                  <button className="ghost" onClick={resetGradient} disabled={!(activeAnon || me?.anon_active)}>Reset to mask default</button>
                </div>
              </div>
              <div className="mask-grid">
                {masks.map((m, idx) => (
                  <button
                    key={m.name}
                    ref={el => { maskGridRef.current[idx] = el; }}
                    data-idx={idx}
                    tabIndex={0}
                    className={`mask-card${activeAnon?.mask_name === m.name ? ' active' : ''}${me?.anon_active && me?.anon_mask === m.name && String(me?.anon_color || '').trim().startsWith('{') ? ' custom-gradient-active' : ''}`}
                    style={{ '--mask-color': m.color, '--custom-mask-gradient': me?.anon_active && me?.anon_mask === m.name && String(me?.anon_color || '').trim().startsWith('{') ? maskGradient(me.anon_color) : 'none' }}
                    onClick={() => activateAnon(m)}
                    onKeyDown={e => maskKeyNav(e, masks)}
                    onMouseEnter={() => setPreviewMask({ name:m.name, emoji:m.emoji, color:m.color })}
                    onMouseLeave={() => setPreviewMask(null)}
                    title={favMasks.some(f => f.name === m.name) ? 'Quick-swap preset' : undefined}
                  >
                    <span className="mask-card-avatar-row">
                      <span className="mask-mini-avatar" style={{ background: maskGradient(m.color) }}>{m.emoji}</span>
                      <span className="mask-card-name" style={{ color: anonNameColor || maskNameColor(m.name) }}>{m.name.replace(/^\S+\s+/,'')}</span>
                    </span>
                    <span
                      role="button"
                      className={`mask-star${favMasks.some(f => f.name === m.name) ? ' on' : ''}`}
                      title={favMasks.some(f => f.name === m.name) ? 'Remove from quick-swap' : 'Add to quick-swap'}
                      onClick={e => { e.stopPropagation(); saveFavorite(m); }}
                    >{favMasks.some(f => f.name === m.name) ? '★' : '☆'}</span>
                  </button>
                ))}
              </div>

              <hr className="settings-hr" />
              <h3>Per-server quick-swap presets</h3>
              {(boot?.communities?.length || 0) > 0 ? (
                <>
                  <select
                    value={srvFavSel}
                    onChange={e => setSrvFavSel(e.target.value)}
                    style={{ padding:'0.35rem 0.6rem', borderRadius:'6px', border:'1px solid var(--border)', background:'var(--panel)', color:'var(--text)', fontSize:'0.82rem', marginBottom:'0.5rem', maxWidth:'100%' }}
                  >
                    {(boot?.communities||[]).map(c => <option key={c.id} value={c.id}>{c.icon||'🏠'} {c.name}</option>)}
                  </select>
                  {srvFavSel ? (
                    <p className="muted-text" style={{fontSize:'0.74rem',margin:'0 0 0.5rem'}}>Star the masks to cycle through when you quick-swap inside this server (empty = falls back to your global presets).</p>
                  ) : null}
                  <div className="mask-grid">
                    {masks.map((m, idx) => {
                      const sel = srvFavs[srvFavSel] || [];
                      const on = sel.some(f => f.name === m.name);
                      return (
                        <button key={m.name} ref={el => { maskGridRef.current[masks.length + idx] = el; }} data-idx={masks.length + idx} tabIndex={0}
                          className={`mask-card${on ? ' active' : ''}${me?.anon_active && me?.anon_mask === m.name && String(me?.anon_color || '').trim().startsWith('{') ? ' custom-gradient-active' : ''}`} style={{ '--mask-color': m.color, '--custom-mask-gradient': me?.anon_active && me?.anon_mask === m.name && String(me?.anon_color || '').trim().startsWith('{') ? maskGradient(me.anon_color) : 'none' }}
                          onKeyDown={e => maskKeyNav(e, masks)}
                          onClick={() => {
                            const next = on ? sel.filter(f => f.name !== m.name) : [...sel, m];
                            const map = { ...srvFavs, [srvFavSel]: next };
                            if (!next.length) delete map[srvFavSel];
                            setSrvFavs(map);
                            saveServerFavs(srvFavSel, next);
                          }}>
                          <span className="mask-mini-avatar" style={{ background: maskGradient(m.color) }}>{m.emoji}</span>
                          <span className="mask-name">{m.name.replace(/^\S+\s+/,'')} {on ? '★' : '☆'}</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : (
                <p className="muted-text" style={{fontSize:'0.8rem'}}>Join a server first to set per-server quick-swap presets.</p>
              )}

              {anonHistory.length > 0 && (
                <>
                  <hr className="settings-hr" />
                  <h3>Past identities</h3>
                  <p className="muted-text" style={{fontSize:'0.8rem'}}>These identities were previously used. You can reactivate one.</p>
                  <div className="anon-history">
                    {anonHistory.map(a => (
                      <div key={a.id} className="anon-history-item">
                        <span>{masks.find(m => m.name === a.mask_name)?.emoji || '🎭'}</span>
                        <span>{a.mask_name}</span>
                        <span className="muted-text" style={{fontSize:'0.72rem'}}>{new Date(a.created_at).toLocaleDateString()}</span>
                        {!a.active && <button onClick={() => reactivateAnon(a.id)}>Reuse</button>}
                        {a.active && <span className="pill ok-pill">Active</span>}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Privacy Checkup ── */}
          {tab === 'checkup' && (
            <div className="settings-section">
              <h2>Privacy Checkup</h2>
              <p className="muted-text">See exactly what other users can currently see about you.</p>
              {!privacyCheckup ? (
                <button onClick={loadPrivacyCheckup}>Run privacy checkup</button>
              ) : (
                <div className="checkup-list">
                  {Object.entries(privacyCheckup.visibleToOthers).map(([key, visible]) => (
                    <div key={key} className={`checkup-row${visible ? '' : ' hidden'}`}>
                      <span className="checkup-icon">{visible ? '👁' : '🚫'}</span>
                      <span className="checkup-key">{key.replace(/_/g,' ')}</span>
                      <span className={`checkup-val${visible ? ' visible' : ' hidden'}`}>{visible ? 'Visible' : 'Hidden'}</span>
                    </div>
                  ))}
                  <button style={{marginTop:'1rem'}} onClick={() => setTab('privacy')}>Adjust privacy settings →</button>
                </div>
              )}
            </div>
          )}

          {/* ── Support ── */}
          {tab === 'support' && (
            <div className="settings-section">
              <h2>Support</h2>
              <div className="support-card">
                <h3>Need help?</h3>
                <p>Contact the administrator for support, law enforcement requests, or platform issues.</p>
                <a href="mailto:bertrude.white2006@gmail.com" className="support-email">
                  📧 bertrude.white2006@gmail.com
                </a>
                <p className="muted-text" style={{marginTop:'1rem',fontSize:'0.82rem'}}>
                  For law enforcement or legal requests, please include your jurisdiction and case number. Response times vary.
                </p>
              </div>

              <hr className="settings-hr" />
              <h3>About Unknown</h3>
              <p className="muted-text">A privacy-focused anonymous chat platform. Your identity is protected. Admins only access your real identity when a report is filed against you.</p>
              <p className="muted-text" style={{fontSize:'0.8rem'}}>⚠ Anyone in a chat can screenshot. Never share personal information.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
