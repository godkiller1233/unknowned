import React, { lazy, Suspense, useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import './styles.css';
const Settings = lazy(() => import('./Settings.jsx'));
const Game = lazy(() => import('./Game.jsx'));
import { Logo, Mascot } from './Logo.jsx';
import { mediaConstraints, applySpeakerSink, loadMediaPrefs } from './mediaPrefs.js';
import { createVoiceMesh } from './mesh.js';

// ── Helpers ──────────────────────────────────────────────────────────────────
function storageValue(storage, key) {
  try { return storage.getItem(key) || ''; } catch { return ''; }
}
function setStorageValue(storage, key, value) {
  try { storage.setItem(key, value); } catch {}
}
function removeStorageValue(storage, key) {
  try { storage.removeItem(key); } catch {}
}
const getToken = () => storageValue(sessionStorage, 'token') || storageValue(localStorage, 'rememberToken');
const setToken = (t, remember) => { setStorageValue(sessionStorage, 'token', t); if (remember) setStorageValue(localStorage, 'rememberToken', t); };
const clearToken = () => { removeStorageValue(sessionStorage, 'token'); removeStorageValue(localStorage, 'rememberToken'); };
function readLocalObject(key) {
  try {
    const value = JSON.parse(storageValue(localStorage, key) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
const api = async (path, opts = {}) => {
  const response = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}), Authorization: `Bearer ${getToken()}` },
  });
  let data;
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!data || typeof data !== 'object') data = {};
  if (!response.ok && !data.error) data.error = `Request failed (${response.status})`;
  data.status = response.status;
  return data;
};

const NAME_COLORS = ['#f23f42','#f0b232','#23a559','#00a8fc','#5865f2','#eb459e','#57f287','#e67e22'];
function nameColor(name) { let h = 0; for (let i = 0; i < (name||'').length; i++) h = (name.charCodeAt(i) + h * 31) % NAME_COLORS.length; return NAME_COLORS[h]; }

// Strip a leading emoji token from mask names (e.g. "🎭 Blank Mask" -> "Blank Mask")
const maskName = (m) => String(m||'').replace(/^\S+\s+/, '');

// Cosmetic banner presets (mirrors the server's COSMETIC_BANNER_GRADIENTS)
const COSMETIC_BANNERS = {
  banner_aurora: 'linear-gradient(135deg,#00c6fb 0%,#005bea 50%,#7f00ff 100%)',
  banner_sunset: 'linear-gradient(135deg,#ff9a9e 0%,#fad0c4 40%,#fbc2eb 100%)',
  banner_ocean:  'linear-gradient(135deg,#2e3192 0%,#1bffff 100%)',
};
const COSMETIC_EFFECTS = { effect_sparkle:'✨', effect_flame:'🔥', effect_glow:'💫' };
// Parse the user's starred quick-swap masks (new fav_masks JSON, fallback to legacy fav_mask).
function parseFavMasks(me) {
  if (!me) return [];
  try { const p = JSON.parse(me.fav_masks || '[]'); if (Array.isArray(p) && p.length) return p; } catch {}
  if (me.fav_mask) return [{ name: me.fav_mask, color: me.fav_color, emoji: me.fav_emoji }];
  return [];
}
// Per-server quick-swap presets for a community (empty => falls back to global).
function serverFavMasks(me, communityId) {
  if (!me || !communityId) return null;
  let map = {}; try { const p = JSON.parse(me.server_fav_masks || '{}'); if (p && typeof p === 'object') map = p; } catch {}
  const list = map[communityId];
  return Array.isArray(list) && list.length ? list : null;
}
// Label describing the next quick-swap action (cycle target) given the current identity.
// Optionally pass a server-scoped favorites list; falls back to global.
function nextSwapLabel(me, serverFavs, pinnedMask) {
  const favs = serverFavs || parseFavMasks(me) || [];
  const effective = favs.length ? favs : (pinnedMask ? [pinnedMask] : []);
  if (!effective.length) return '';
  const current = me?.anon_mask;
  const active = effective.some(f => f.name === current);
  if (me?.anon_active && active) {
    const idx = effective.findIndex(f => f.name === current);
    const next = effective[idx + 1];
    return next ? `Swap to ${next.name.replace(/\S+\s+/,'')}` : 'Back to real identity';
  }
  return `Swap to ${effective[0].name.replace(/\S+\s+/,'')}`;
}

// Highlight @mentions in Reveal comment bodies. Clicking one opens the mentioned user's profile.
function mentionize(text, onMention) {
  return String(text || '').split(/(@\w+)/g).map((p, i) => /@\w+/.test(p)
    ? <span key={i} className="comment-mention" title="Open profile" style={{cursor:'pointer'}} onClick={() => onMention?.(p.slice(1))}>@{<b>{p.slice(1)}</b>}</span>
    : <span key={i}>{p}</span>);
}

// ── Bookmarks (private per-user store) ────────────────────────────────────────
const BOOKMARK_FOLDERS = ['School','Games','Ideas','Important'];
let bookmarkState = { items: [], ids: new Set(), loaded: false };
const bookmarkListeners = new Set();
function emitBookmarks() { bookmarkListeners.forEach(fn => fn()); }
function useBookmarks() {
  const [, force] = useState(0);
  useEffect(() => { bookmarkListeners.add(force); return () => bookmarkListeners.delete(force); }, []);
  return bookmarkState;
}
async function refreshBookmarks() {
  const d = await api('/api/bookmarks').catch(() => null);
  if (d && !d.error) {
    bookmarkState = { items: d.bookmarks || [], ids: new Set((d.bookmarks||[]).map(b => b.message_id)), loaded: true };
    emitBookmarks();
  }
}
async function toggleBookmark(msg) {
  const was = bookmarkState.ids.has(msg.id);
  if (was) await api(`/api/bookmarks/${msg.id}`, { method:'DELETE' });
  else await api('/api/bookmarks', { method:'POST', body: JSON.stringify({ messageId: msg.id, folder: 'Important' }) });
  refreshBookmarks();
  return !was;
}
async function moveBookmark(messageId, folder) {
  await api(`/api/bookmarks/${messageId}`, { method:'PATCH', body: JSON.stringify({ folder }) });
  refreshBookmarks();
}

function getDeviceProfile() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  const narrow = width <= 520;
  const tablet = !narrow && width <= 900;
  const compact = width <= 1200 || height <= 720;
  return { width, height, orientation: width >= height ? 'landscape' : 'portrait', input: coarse ? 'touch' : 'mouse', formFactor: narrow ? 'phone' : tablet ? 'tablet' : 'desktop', compact };
}

function useDeviceProfile() {
  const [profile, setProfile] = useState(() => getDeviceProfile());
  useEffect(() => {
    const update = () => setProfile(getDeviceProfile());
    const media = window.matchMedia?.('(pointer: coarse)');
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    media?.addEventListener?.('change', update);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('orientationchange', update); media?.removeEventListener?.('change', update); };
  }, []);
  return profile;
}

function timeAgo(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function fileType(url, mime) {
  if (!url) return null;
  const ext = url.split('.').pop()?.toLowerCase();
  if (['jpg','jpeg','png','gif','webp'].includes(ext) || mime?.startsWith('image/')) return 'image';
  if (['mp4','webm','mov'].includes(ext) || mime?.startsWith('video/')) return 'video';
  if (['mp3','ogg','wav'].includes(ext) || mime?.startsWith('audio/')) return 'audio';
  return 'file';
}

// Apply theme CSS vars
function applyTheme(t) {
  const root = document.documentElement;
  const themes = {
    dark:   { bg:'#313338', panel:'#2b2d31', sidebar:'#1e1f22', soft:'#383a40', hover:'#404249', text:'#dbdee1', muted:'#949ba4', input:'#1e1f22' },
    light:  { bg:'#ffffff', panel:'#f2f3f5', sidebar:'#e3e5e8', soft:'#e3e5e8', hover:'#d4d7dc', text:'#060607', muted:'#4e5058', input:'#e3e5e8' },
    amoled: { bg:'#000000', panel:'#0a0a0a', sidebar:'#050505', soft:'#111111', hover:'#1a1a1a', text:'#ffffff', muted:'#888888', input:'#111111' },
    forest: { bg:'#1a2e1a', panel:'#162614', sidebar:'#0f1c0f', soft:'#1e331e', hover:'#253d25', text:'#c8e6c9', muted:'#81a882', input:'#0f1c0f' },
    ocean:  { bg:'#0a1628', panel:'#0d1f3c', sidebar:'#071323', soft:'#102040', hover:'#16294f', text:'#b3cde0', muted:'#6b8cae', input:'#071323' },
  };
  const vars = themes[t] || themes.dark;
  root.style.setProperty('--bg',    vars.bg);
  root.style.setProperty('--panel', vars.panel);
  root.style.setProperty('--sidebar',vars.sidebar);
  root.style.setProperty('--soft',  vars.soft);
  root.style.setProperty('--hover', vars.hover);
  root.style.setProperty('--text',  vars.text);
  root.style.setProperty('--muted', vars.muted);
  root.style.setProperty('--input-bg', vars.input);
  root.dataset.theme = t;
}

// ── Avatar ───────────────────────────────────────────────────────────────────
// Build a themed gradient so anonymous mask avatars read like real profile pictures.
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

function Avatar({ src, name, size='md', status, official, badge, onClick, anonMask, anonColor }) {
  const cls = ['avatar', `avatar-${size}`, official&&'avatar-official', onClick&&'clickable', anonMask&&'avatar-mask'].filter(Boolean).join(' ');
  const bg  = anonMask ? (maskGradient(anonColor) || undefined) : undefined;
  return (
    <div className={cls} style={bg ? { background: bg } : {}} onClick={onClick} title={name} role={onClick?'button':undefined}>
      {src && !anonMask ? <img src={src} alt="" /> : anonMask
        ? <span style={{fontSize: size==='lg'?'2rem':size==='md'?'1.2rem':'1rem'}}>{anonMask}</span>
        : <span>{(name||'?')[0]?.toUpperCase()}</span>}
      {status && <span className={`status-dot status-${(status||'').toLowerCase().replace(/\s+/g,'-')}`} />}
      {badge === 'Knowns' && <span className="badge-known" title="Knowns">K</span>}
      {String(badge||'').includes('FTD') && <span className="badge-ftd" title="FTD — Freed The Devs">F</span>}
    </div>
  );
}

// ── Attachment ────────────────────────────────────────────────────────────────
function Attachment({ url, name, mime }) {
  const type = fileType(url, mime);
  if (!url) return null;
  if (type === 'image') return <div className="attach-wrap"><img src={url} alt={name||'image'} className="attach-image" onClick={() => window.open(url,'_blank')} /></div>;
  if (type === 'video') return <div className="attach-wrap"><video src={url} controls className="attach-video" /></div>;
  if (type === 'audio') return <div className="attach-wrap"><audio src={url} controls className="attach-audio" /></div>;
  return <a href={url} target="_blank" rel="noopener noreferrer" className="attach-file">📎 {name || url.split('/').pop()}</a>;
}

// ── MsgBody (ping highlights + easter egg) ────────────────────────────────────
function MsgBody({ text, me }) {
  const [revealed, setRevealed] = useState(() => new Set());
  if (!text) return null;
  const tokens = text.split(/(```[\s\S]*?```|\|\|[\s\S]*?\|\||https?:\/\/[^\s]+|@[\w-]+)/g);
  return <span>{tokens.map((p,i) => {
    if (p.startsWith('```')) return <code key={i} className="code-block">{p.slice(3,-3).replace(/^\w+\n/,'')}</code>;
    if (p.startsWith('||') && p.endsWith('||')) return <button key={i} type="button" className={`spoiler${revealed.has(i) ? ' revealed' : ''}`} title={revealed.has(i) ? 'Hide spoiler' : 'Reveal spoiler'} aria-label={revealed.has(i) ? 'Hide spoiler' : 'Reveal spoiler'} onClick={() => setRevealed(prev => { const next = new Set(prev); next.has(i) ? next.delete(i) : next.add(i); return next; })}>{p.slice(2,-2)}</button>;
    if (/^https?:\/\//.test(p)) return <a key={i} href={p} target="_blank" rel="noopener noreferrer" className="message-link">{p}</a>;
    if (/^@[\w-]+$/.test(p)) return <span key={i} className={p===`@${me?.username}`?'ping-me':'ping'}>{p}</span>;
    return p;
  })}</span>;
}

// ── Poll renderer ─────────────────────────────────────────────────────────────
function PollRenderer({ poll: rawPoll, messageId, me }) {
  const [poll, setPoll] = useState(rawPoll);
  if (!poll) return null;
  const options = typeof poll.options === 'string' ? JSON.parse(poll.options || '[]') : (poll.options || []);
  const votes   = poll.votes || poll._votes || [];
  const total   = votes.reduce((a, v) => a + Number(v.count||0), 0);

  async function vote(i) {
    const d = await api(`/api/polls/${poll.id}/vote`, { method:'POST', body:JSON.stringify({ optionIndex:i }) });
    if (d.votes) setPoll(p => ({ ...p, votes: d.votes, myVote: i }));
  }

  return (
    <div className="poll-card">
      <div className="poll-question">📊 {poll.question}</div>
      {options.map((opt, i) => {
        const vCount = Number(votes.find(v => Number(v.option_index) === i)?.count || 0);
        const pct    = total ? Math.round((vCount / total) * 100) : 0;
        const voted  = poll.myVote === i;
        return (
          <button key={i} className={`poll-option${voted?' voted':''}`} onClick={() => vote(i)}>
            <div className="poll-bar" style={{ width: `${pct}%` }} />
            <span className="poll-label">{opt}</span>
            <span className="poll-pct">{pct}%</span>
          </button>
        );
      })}
      <div className="poll-footer">{total} vote{total !== 1 ? 's' : ''}</div>
    </div>
  );
}

// ── Emoji picker ──────────────────────────────────────────────────────────────
const EMOJIS = ['👍','❤️','😂','😮','😢','😡','🔥','🎉','✅','💀','💯','🤔','😭','👀','🙌','🥳','😎','🤯','👏','🙏','✨','🚀','💜','🫶','🎮','🐱','🦊','🌈','☕','🍕'];
// 🎲 DO SOMETHING RANDOM — prompt question + poll catalogs
const RANDOM_PROMPTS = [
  "If your life had a theme song, what would it be and why?",
  "What's a movie you could watch on repeat forever?",
  "If you could instantly master one skill, what would it be?",
  "What's the best meal you've ever had?",
  "If you could meet any fictional character, who would it be?",
  "What's a totally useless talent you're proud of?",
  "If you could live anywhere for a year, where would you go?",
  "What's the most adventurous thing you've ever eaten?",
  "If you had a time machine, would you go to the past or the future?",
  "What's a song that always gets stuck in your head?",
  "If you could only keep one app on your phone, which would it be?",
  "What's the strangest dream you've ever had?",
  "If you could talk to animals, which one would you interview first?",
  "What's something you'd love to learn just for fun?",
  "If you could instantly teleport anywhere right now, where would you go?",
];
const RANDOM_POLLS = [
  { q:'Which would you pick?',                  opts:['🏝 Beach day','⛰ Mountain hike','🌆 City night','🏠 Cozy stay-in'] },
  { q:'Best way to relax after a long day?',    opts:['🎮 Games','📺 Shows','🎵 Music','😴 Sleep'] },
  { q:'Pizza or burgers?',                      opts:['🍕 Pizza','🍔 Burgers','🌮 Tacos','🍣 Sushi'] },
  { q:'How do you take your coffee?',           opts:['☕ Black','🥛 Latte','🍬 Sweet','🚫 No coffee'] },
  { q:'What season is the best?',               opts:['🌸 Spring','☀️ Summer','🍂 Fall','❄️ Winter'] },
  { q:'Cat person or dog person?',              opts:['🐱 Cats','🐶 Dogs','🦎 Other pets','❤️ Both'] },
  { q:'Where should we chat next?',             opts:['💬 This channel','🎙 Voice chat','🎮 A game','📺 Watch together'] },
  { q:'Morning person or night owl?',           opts:['🌅 Morning','🌙 Night','☕ Only after coffee','🦉 Depends'] },
];
function EmojiPicker({ onPick }) {
  const [tab, setTab] = useState('emoji');
  return <div className="emoji-picker"><div className="emoji-tabs"><button className={tab==='emoji'?'active':''} onClick={()=>setTab('emoji')}>Emoji</button><button className={tab==='gif'?'active':''} onClick={()=>setTab('gif')}>GIF</button><button className={tab==='sticker'?'active':''} onClick={()=>setTab('sticker')}>Stickers</button></div>{tab==='emoji' ? EMOJIS.map(e=><button key={e} onClick={()=>onPick(e)}>{e}</button>) : tab==='gif' ? <div className="media-placeholder">GIF links are supported — paste a GIF URL into chat.</div> : <div className="media-placeholder">Sticker links and uploaded stickers are supported.</div>}</div>;
}

// ── PII Warning modal ─────────────────────────────────────────────────────────
function PiiWarning({ warning, onSend, onRewrite }) {
  return (
    <div className="modal-overlay">
      <div className="modal-box">
        <h3>⚠ Personal Info Warning</h3>
        <p>{warning.message}</p>
        <p className="muted-text">Type detected: <b>{warning.type}</b></p>
        <div style={{display:'flex',gap:8,marginTop:12}}>
          <button className="danger-btn" onClick={onSend}>Send anyway</button>
          <button onClick={onRewrite}>Rewrite</button>
        </div>
      </div>
    </div>
  );
}

// ── Call Modal ────────────────────────────────────────────────────────────────
// Live-voice indicator for the DM call. Mute is SIGNALED explicitly between
// the two participants (call_mute events), so a muted peer reads as truly
// muted no matter what their mic does. When they're unmuted we watch the
// energy of their audio track: real speech pushes the average frequency level
// well above the near-zero silence floor, so "speaking" still lights up live.
const CALL_SPEAK_THRESHOLD = 4;
function callMicStateText(s) {
  return s === 'muted'    ? '🔇 Muted — mic off'
    : s === 'speaking'    ? '🔊 Mic live — speaking'
    : s === 'no-audio'    ? '🎙️ Not receiving audio from them'
    : '🎙️ Mic connected';
}

function CallModal({ socket, me, targetUser, dmId, incoming, initialOffer, onClose }) {
  const [status, setStatus] = useState(incoming ? 'incoming' : 'calling');
  const [muted, setMuted]   = useState(false);
  // null | 'denied' | 'nodevice' | 'unexpected' — blocks starting the call until
  // the user fixes their microphone, with a Retry that re-requests capture.
  const [micIssue, setMicIssue] = useState(null);
  const [retrying, setRetrying] = useState(false);
  // 'idle' | 'speaking' | 'no-audio' — live state of the remote user's mic.
  const [peerMic, setPeerMic] = useState('idle');
  // True when the other participant signaled they muted their mic (call_mute).
  const [remoteMuted, setRemoteMuted] = useState(false);
  const localRef  = useRef(null);
  const remoteRef = useRef(null);
  const streamRef = useRef(null);
  const pcRef     = useRef(null);
  const pendingStart = useRef(null);
  const peerTimer = useRef(0);
  const peerCtx = useRef(null);
  const peerAnalyser = useRef(null);
  const peerStream = useRef(null);

  useEffect(() => {
    const isThisCall = d => !d?.dmId || d.dmId === dmId;
    const onAccept  = async d => {
      if (!isThisCall(d) || (d.from && d.from !== targetUser?.id)) return;
      setStatus('connected');
      if (pcRef.current && d.sdp) await pcRef.current.setRemoteDescription(new RTCSessionDescription(d.sdp)).catch(()=>{});
    };
    const onDecline = d => { if (!isThisCall(d)) return; setStatus('declined'); setTimeout(onClose, 1500); };
    const onEnd     = d => { if (!isThisCall(d)) return; cleanup(); onClose(); };
    const onOffer   = async d => {
      if (!isThisCall(d) || (d.from && d.from !== targetUser?.id)) return;
      setStatus('connecting');
      await startCall(false, d);
    };
    const onAnswer  = async d => { if (isThisCall(d) && pcRef.current) await pcRef.current.setRemoteDescription(new RTCSessionDescription(d.sdp)).catch(()=>{}); };
    const onIce     = d => { if (isThisCall(d) && pcRef.current && d.candidate) pcRef.current.addIceCandidate(new RTCIceCandidate(d.candidate)).catch(()=>{}); };
    const onMute    = d => { if (!isThisCall(d) || (d.from && d.from !== targetUser?.id)) return; setRemoteMuted(d.muted === true); };

    socket.on('call_accept',  onAccept);
    socket.on('call_decline', onDecline);
    socket.on('call_end',     onEnd);
    socket.on('rtc_offer',    onOffer);
    socket.on('rtc_answer',   onAnswer);
    socket.on('rtc_ice',      onIce);
    socket.on('call_mute',    onMute);

    if (!incoming) startCall(true);

    return () => {
      socket.off('call_accept', onAccept);
      socket.off('call_decline', onDecline);
      socket.off('call_end', onEnd);
      socket.off('rtc_offer', onOffer);
      socket.off('rtc_answer', onAnswer);
      socket.off('rtc_ice', onIce);
      socket.off('call_mute', onMute);
      cleanup();
    };
  }, []);

  async function startCall(isInitiator, offerData) {
    pendingStart.current = { isInitiator, offerData };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(mediaConstraints('mic'));
    } catch (err) {
      // Microphone unavailable — tell the user exactly why and let them retry
      // instead of showing a dead "could not connect".
      const name = err?.name || '';
      setMicIssue(
        name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError' ? 'denied'
        : (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') ? 'nodevice'
        : 'unexpected');
      setRetrying(false);
      setStatus(isInitiator ? 'micblocked' : 'incoming');
      return;
    }
    setMicIssue(null);
    setRetrying(false);
    try {
      streamRef.current = stream;
      if (localRef.current) localRef.current.srcObject = stream;

      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      pcRef.current = pc;
      stream.getTracks().forEach(t => pc.addTrack(t, stream));

      pc.ontrack = e => {
        if (remoteRef.current) remoteRef.current.srcObject = e.streams[0];
        startPeerMonitor(e.streams[0]);
      };
      pc.onicecandidate = e => {
        if (e.candidate) socket.emit('rtc_ice', { toUserId: targetUser?.id, dmId, candidate: e.candidate });
      };

      if (isInitiator) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('call_invite', { toUserId: targetUser?.id, dmId, sdp: offer });
        setStatus('calling');
      } else if (offerData) {
        await pc.setRemoteDescription(new RTCSessionDescription(offerData.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('call_accept', { toUserId: targetUser?.id, dmId, sdp: answer });
        setStatus('connected');
      }
    } catch { cleanup(); setStatus('error'); }
  }

  // Route the caller's audio to the speaker the user picked in Settings, and
  // start watching their mic if a stream is already attached when we connect.
  useEffect(() => {
    if (status === 'connected') {
      const s = remoteRef.current?.srcObject;
      if (s) startPeerMonitor(s);
    } else if (status === 'micblocked') {
      stopPeerMonitor();
    }
    if (remoteRef.current) applySpeakerSink(remoteRef.current, loadMediaPrefs().speaker);
  }, [status]);

  // Watch the remote audio track and flip the indicator when they actually speak.
  function startPeerMonitor(stream) {
    if (!stream || peerStream.current === stream) return;
    peerStream.current = stream;
    stopPeerMonitor();
    const track = stream.getAudioTracks()[0];
    if (!track) { setPeerMic('no-audio'); return; }
    setPeerMic('idle');
    let ctx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      peerCtx.current = ctx;
      peerAnalyser.current = analyser;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    } catch { return; }
    const levels = new Uint8Array(peerAnalyser.current.frequencyBinCount);
    peerTimer.current = setInterval(() => {
      const an = peerAnalyser.current;
      if (!an) return;
      if (peerCtx.current?.state === 'suspended') peerCtx.current.resume().catch(() => {});
      an.getByteFrequencyData(levels);
      let sum = 0;
      for (let i = 0; i < levels.length; i++) sum += levels[i];
      const speaking = sum / levels.length > CALL_SPEAK_THRESHOLD;
      setPeerMic(p => (p === 'speaking') === speaking ? p : (speaking ? 'speaking' : 'idle'));
    }, 140);
  }

  function stopPeerMonitor() {
    clearInterval(peerTimer.current);
    peerTimer.current = 0;
    peerCtx.current?.close().catch(() => {});
    peerCtx.current = null;
    peerAnalyser.current = null;
    peerStream.current = null;
  }

  function accept() {
    setStatus('connecting');
    startCall(false, initialOffer);
  }

  function decline() {
    socket.emit('call_decline', { toUserId: targetUser?.id, dmId });
    onClose();
  }

  function endCall() {
    socket.emit('call_end', { toUserId: targetUser?.id, dmId });
    cleanup();
    onClose();
  }

  async function retryMic() {
    if (retrying) return;
    setRetrying(true);
    setMicIssue(null);
    const p = pendingStart.current;
    // The browser only re-prompts after a new user gesture — this click is it.
    await startCall(p ? p.isInitiator : true, p ? p.offerData : null);
    setRetrying(false);
  }

  function cleanup() {
    stopPeerMonitor();
    streamRef.current?.getTracks().forEach(t => t.stop());
    pcRef.current?.close();
  }

  function toggleMute() {
    const next = !muted;
    streamRef.current?.getAudioTracks().forEach(t => { t.enabled = !next; });
    setMuted(next);
    // Tell the other participant — their chip flips to a true “muted” state.
    if (socket.connected) socket.emit('call_mute', { toUserId: targetUser?.id, dmId, muted: next });
  }

  // After a (re)connect the other side may have missed our mute state, so
  // re-announce it — they should never have to guess from silence.
  useEffect(() => {
    if (!muted) return undefined;
    const resend = () => { if (socket.connected) socket.emit('call_mute', { toUserId: targetUser?.id, dmId, muted: true }); };
    socket.on('connect', resend);
    return () => socket.off('connect', resend);
  }, [socket, muted, targetUser?.id, dmId]);

  const micWarn = micIssue
    ? micIssue === 'denied' ? 'Microphone permission is blocked, so the call can’t start. Allow mic access for this site (address-bar icon or OS privacy settings), then retry.'
      : micIssue === 'nodevice' ? 'No microphone was found. Connect one, or pick your mic in Settings → Voice & Video, then retry.'
      : 'Could not start your microphone. Retry to try again.'
    : null;

  return (
    <div className="call-modal-overlay">
      <div className="call-modal">
        <div className={`call-ring-wrap${['calling','incoming','connecting'].includes(status)?' ringing':''}`}>
          <Avatar src={targetUser?.avatar} name={targetUser?.nickname||targetUser?.username} size="lg" badge={targetUser?.badge} />
        </div>
        <h3>{targetUser?.nickname || targetUser?.username}</h3>
        <p className="call-status">
          {status === 'calling'    ? '📞 Calling…'
          : status === 'micblocked' ? '🎙️ Microphone needed'
          : status === 'incoming'  ? '📲 Incoming call…'
          : status === 'connected' ? '🟢 Connected'
          : status === 'declined'  ? '❌ Call declined'
          : status === 'error'     ? '⚠ Could not connect'
          : '⏳ Connecting…'}
        </p>
        {status === 'connected' && (() => {
          const micState = remoteMuted ? 'muted' : peerMic;
          const cls = 'call-mic-chip'
            + (micState === 'speaking' ? ' live' : '')
            + (micState === 'muted' ? ' muted' : '')
            + (micState === 'no-audio' ? ' warn' : '');
          return (
            <p className={cls} role="status" aria-live="polite">
              {callMicStateText(micState)}
            </p>
          );
        })()}
        {micWarn && (
          <div className="call-mic-warn" role="alert">
            <p>{micWarn}</p>
            <div className="call-warn-actions">
              <button className="call-btn pill ok" onClick={retryMic} disabled={retrying}>
                {retrying ? '⏳ Requesting…' : '↻ Retry microphone'}
              </button>
              {incoming
                ? <button className="call-btn pill danger" onClick={decline}>✕ Decline</button>
                : <button className="call-btn pill danger" onClick={onClose}>Close</button>}
            </div>
          </div>
        )}
        <audio ref={localRef}  autoPlay muted style={{display:'none'}} />
        <audio ref={remoteRef} autoPlay       style={{display:'none'}} />
        <div className="call-controls">
          {status === 'incoming' && !micWarn ? (
            <>
              <button className="call-btn accept" onClick={accept}>✓ Accept</button>
              <button className="call-btn decline" onClick={decline}>✕ Decline</button>
            </>
          ) : status === 'connected' || status === 'calling' || status === 'connecting' ? (
            <>
              {status === 'connected' && (
                <button className={`call-btn mute${muted?' active':''}`} onClick={toggleMute}>
                  {muted ? '🔇' : '🎤'}
                </button>
              )}
              <button className="call-btn end" onClick={endCall}>End</button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ── Auth ──────────────────────────────────────────────────────────────────────
// ── FTD ARG Easter Egg ────────────────────────────────────────────────────────
// 0.0001% chance glitch screen → inspect → "developer login" → multi-step ARG → FTD badge
const FTD_GLITCH = [
  '0xFF00FF', 'BSOD', 'segfault', '0xDEAD', 'whoami: trapped',
  'corrupted sector 7', '█▓▒░', 'no signal', 'the basement never sleeps',
  '0xBAD', 'traceback (most recent call last)', 'dev_4: still typing…',
];
const FTD_STEPS = ['login','terminal','code','done'];

function FtdEasterEgg({ onOpenArg, onClose }) {
  const [inspected, setInspected] = useState(false);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    // The link fades in after a beat — you have to look closely ("inspect").
    const t = setTimeout(() => setRevealed(true), 2200);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="ftd-glitch" onClick={()=>{ if(!inspected) setInspected(true); }}>
      <div className="ftd-glitch-noise" />
      <div className="ftd-glitch-logo"><Logo size={72} animate /></div>
      <h2 className="ftd-glitch-title">SIGNAL LOST</h2>
      <p className="ftd-glitch-sub">the feed is rotting. something is still in there.</p>
      <div className="ftd-glitch-lines">
        {FTD_GLITCH.map((g,i) => <span key={i} className="ftd-glitch-line">{g}</span>)}
      </div>
      {inspected && !revealed && <p className="ftd-inspect-hint">…almost. look closer.</p>}
      {revealed && (
        <button className="ftd-dev-login" onClick={(e)=>{ e.stopPropagation(); onOpenArg(); }}>
          🔗 developer login — access restricted
        </button>
      )}
      <button className="ftd-close" onClick={(e)=>{ e.stopPropagation(); onClose(); }} title="Close">✕</button>
    </div>
  );
}

function ArgLogin({ onSuccess, notify }) {
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [tries, setTries] = useState(0);
  const [hint, setHint] = useState(false);

  function submit(e) {
    e.preventDefault();
    if (user.trim().toLowerCase() === 'admin' && pass.trim().toLowerCase() === 'onfrzrag') {
      onSuccess();
    } else {
      setTries(t=>t+1); setErr('access denied — credentials rejected.');
    }
  }

  return (
    <div className="arg-step">
      <div className="arg-term-head">UNKNOWN INTERNAL — DEVELOPER ACCESS</div>
      <p className="arg-mono arg-dim">restricted terminal · basement level 13 · {new Date().toLocaleString()}</p>
      <form onSubmit={submit} className="mini arg-login-form">
        <label>username<input value={user} onChange={e=>setUser(e.target.value)} autoFocus placeholder="admin" /></label>
        <label>password<input type="password" value={pass} onChange={e=>setPass(e.target.value)} placeholder="••••••••" /></label>
        {err && <p className="arg-err">{err}</p>}
        <button>Authenticate</button>
      </form>
      <p className="arg-mono arg-dim arg-clue">// the devs were moved 13 floors down. they keep saying where they are, backwards.</p>
      {tries >= 2 && !hint && <button className="ghost arg-hint-btn" onClick={()=>setHint(true)}>💡 Need a hint?</button>}
      {hint && <p className="arg-hint">ROT13: where they are is "onfrzrag" — that's the password. Username is the first account: <b>admin</b>.</p>}
    </div>
  );
}

function ArgTerminal({ onSuccess }) {
  const [log, setLog] = useState([
    '> session opened. 5 devs still trapped.',
    '> type help for commands.',
  ]);
  const [cmd, setCmd] = useState('');
  const [decoded, setDecoded] = useState(false);
  const [hint, setHint] = useState(false);
  const files = {
    'dev_log.txt': 'dev_3 left a note: the manifest is base64. decode what is inside.',
    'manifest.bin': 'RlRE',
    'cells.txt': 'cells 01-05 occupied. do not disturb the workers.',
    'readme.md': 'finish what we started. the word is the key.',
  };

  function run(raw) {
    const c = raw.trim().toLowerCase();
    const lines = [];
    lines.push('> ' + raw);
    if (c === 'help') lines.push('commands: ls · cat &lt;file&gt; · hint · exit');
    else if (c === 'ls') lines.push(Object.keys(files).join('   '));
    else if (c.startsWith('cat ')) {
      const f = c.slice(4).trim();
      if (files[f]) { lines.push(files[f]); if (f === 'manifest.bin') setDecoded(true); }
      else lines.push('cat: ' + f + ': no such file');
    }
    else if (c === 'hint') { lines.push('💡 the manifest is base64. "RlRE" decodes to 3 letters.'); setHint(true); }
    else if (c === 'exit') lines.push('no exit. the door only opens for the word.');
    else lines.push('unknown command. try help.');
    setLog(l => [...l, ...lines]);
  }

  return (
    <div className="arg-step">
      <div className="arg-term-head">BASEMENT SHELL — v0.4.2</div>
      <div className="arg-term-body">
        {log.map((l,i) => <pre key={i} className="arg-mono">{l}</pre>)}
      </div>
      <form className="arg-cmd-form" onSubmit={e=>{ e.preventDefault(); if(cmd.trim()){ run(cmd); setCmd(''); } }}>
        <span className="arg-mono arg-prompt">$</span>
        <input className="arg-mono" value={cmd} onChange={e=>setCmd(e.target.value)} placeholder="type help…" autoFocus />
      </form>
      {decoded && !hint && <button className="ghost arg-hint-btn" onClick={()=>setHint(true)}>💡 Decode it?</button>}
      {hint && <p className="arg-hint">Decode <b>RlRE</b> from base64 → <b>FTD</b>. That's the word the door wants.</p>}
      {decoded && (
        <button className="arg-next-btn" onClick={onSuccess}>I have the word →</button>
      )}
    </div>
  );
}

function ArgCode({ onComplete, notify }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [tries, setTries] = useState(0);
  const [hint, setHint] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (code.trim().toUpperCase() === 'FTD') {
      const d = await api('/api/arg/award', { method:'POST' });
      if (d.awarded) notify('🏆 FTD badge unlocked — the devs are free!','ok');
      else if (d.already) notify('FTD badge already yours. The devs remember you.','ok');
      onComplete(d);
    } else {
      setTries(t=>t+1); setErr('the door hums. wrong word.');
    }
  }

  return (
    <div className="arg-step">
      <div className="arg-term-head">THE DOOR — FINAL CHECK</div>
      <p className="arg-mono arg-dim">"speak the word and we are free." — dev_3</p>
      <form onSubmit={submit} className="mini arg-code-form">
        <input value={code} onChange={e=>setCode(e.target.value)} placeholder="the word…" autoFocus maxLength={8} />
        {err && <p className="arg-err">{err}</p>}
        <button>Unlock</button>
      </form>
      {tries >= 2 && !hint && <button className="ghost arg-hint-btn" onClick={()=>setHint(true)}>💡 Need a hint?</button>}
      {hint && <p className="arg-hint">Three letters. The manifest said it. <b>F</b>·<b>T</b>·<b>D</b>. Type <b>FTD</b>.</p>}
    </div>
  );
}

function ArgDone({ result, onClose }) {
  return (
    <div className="arg-step arg-done">
      <div className="arg-confetti">🎉 🎊 ✨</div>
      <h2 className="arg-done-title">THE DEVS ARE FREE</h2>
      <p className="arg-mono">after all this time, the basement is empty. the workers walked out into the light.</p>
      <p className="arg-mono arg-dim">you now carry the <b className="arg-ftd-word">FTD</b> badge — Found The Devs.</p>
      {result?.badge && <p className="arg-done-badge">badge: {result.badge}</p>}
      <button className="arg-next-btn" onClick={onClose}>Back to Unknown</button>
    </div>
  );
}

function ArgModal({ onClose, notify }) {
  const [step, setStep] = useState(() => {
    const s = localStorage.ftdArgStep;
    return FTD_STEPS.includes(s) ? s : 'login';
  });
  const [result, setResult] = useState(null);

  function go(next) {
    localStorage.ftdArgStep = next;
    setStep(next);
  }

  function close() {
    localStorage.ftdArgStep = 'login';
    onClose();
  }

  return (
    <div className="menu-overlay arg-overlay" onClick={close}>
      <div className="menu-modal arg-modal" onClick={e=>e.stopPropagation()}>
        <div className="menu-modal-header"><h2 className="arg-title">🕳 UNKNOWN INTERNAL</h2><button className="icon-btn" onClick={close}>✕</button></div>
        <div className="menu-modal-body arg-body">
          {step==='login' && <ArgLogin onSuccess={()=>go('terminal')} notify={notify} />}
          {step==='terminal' && <ArgTerminal onSuccess={()=>go('code')} />}
          {step==='code' && <ArgCode onComplete={d=>{ setResult(d); go('done'); }} notify={notify} />}
          {step==='done' && <ArgDone result={result} onClose={close} />}
        </div>
      </div>
    </div>
  );
}

function Auth({ onAuth, initialError = '' }) {
  useEffect(() => {
    if (!('Notification' in window) || Notification.permission !== 'default') return;
    const timer = setTimeout(() => Notification.requestPermission().catch(() => {}), 1200);
    return () => clearTimeout(timer);
  }, []);
  const [mode, setMode]   = useState('login');
  const [form, setForm]   = useState({ username:'', password:'' });
  const [remember, setRemember] = useState(false);
  const [err, setErr]     = useState(initialError);
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    const username = form.username.trim();
    if (!username) {
      setErr('Enter a username to continue.');
      return;
    }
    if (mode === 'register' && form.password.length < 6) {
      setErr('Choose a password with at least 6 characters.');
      return;
    }
    setLoading(true); setErr('');
    try {
      const d = await api(`/api/${mode}`, { method:'POST', body:JSON.stringify({ ...form, username }), headers:{ Authorization:'' } });
      if (d.error) {
        setErr([502, 503, 504].includes(d.status)
          ? 'The chat server is temporarily unavailable. Check that the server is running, then try again.'
          : d.error);
      }
      else if (!d.token || !d.user) setErr('The server returned an incomplete login response. Check the server logs.');
      else { setToken(d.token, remember); onAuth(d.user); }
    } catch (error) {
      setErr(`Unable to reach the server: ${error.message || 'network error'}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth">
      <section className="hero">
        <Logo size={64} animate />
        <div className="hero-title-row">
          <h1 className="hero-title">Unknown</h1>
          <span className="hero-version" title="Version">2.0</span>
        </div>
        <p className="hero-sub">A privacy-focused place to talk, play, study, and connect — without revealing your real identity.</p>
        <div className="first-run-guide" aria-label="Getting started">
          <div className="first-run-heading"><span>Start here</span><small>three quick steps</small></div>
          <ol>
            <li><b>Choose a handle</b><span>Use a name that does not identify you.</span></li>
            <li><b>Find your space</b><span>Join a server or make one for your group.</span></li>
            <li><b>Say hello</b><span>Pick a channel and send your first message.</span></li>
          </ol>
        </div>
        <div className="privacy-card">
          <b>⚠ Personal info warning</b>
          <span>Do not share addresses, real names, phone numbers, emails, passwords, or financial info.</span>
        </div>
        <p className="support-link">Need help? <a href="mailto:bertrude.white2006@gmail.com">bertrude.white2006@gmail.com</a></p>
      </section>
      <form onSubmit={submit} className="panel auth-form">
        <div className="auth-logo"><Logo size={40} /></div>
        <div className="auth-form-heading">
          <div>
            <h2>{mode === 'login' ? 'Welcome back' : 'Create an account'}</h2>
            <p>{mode === 'login' ? 'Pick up where you left off.' : 'Use a handle that keeps your real identity private.'}</p>
          </div>
          <span className="auth-step" aria-label={mode === 'login' ? 'Sign in' : 'Registration'}>{mode === 'login' ? '1 / 1' : '1 / 1'}</span>
        </div>
        <label className="auth-field">Username<input aria-label="Username" placeholder="Choose a handle" value={form.username} onChange={e => setForm({...form,username:e.target.value})} autoComplete="username" required /></label>
        <label className="auth-field">Password<input aria-label="Password" placeholder="Your password" type="password" value={form.password} onChange={e => setForm({...form,password:e.target.value})} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required /></label>
        {err && <p className="error" role="alert" aria-live="polite">{err}</p>}
        <label className="remember"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} /> Keep me signed in</label>
        <button disabled={loading} aria-busy={loading}>{loading ? <><span className="button-spinner" aria-hidden="true" /> {mode === 'login' ? 'Checking…' : 'Creating…'}</> : mode === 'login' ? 'Log in' : 'Register'}</button>
        <button type="button" className="ghost auth-switch" onClick={() => { setMode(mode==='login'?'register':'login'); setForm({ username: form.username, password: '' }); setErr(''); }}>
          {mode === 'login' ? 'Need an account? Register' : 'Have an account? Log in'}
        </button>
      </form>
    </main>
  );
}

// ── Notifications Panel ───────────────────────────────────────────────────────
function GlobalSearch({ onClose, boot, onOpenProfile, notify, onJumpBookmark }) {
  const [q,setQ]=useState(''); const [user,setUser]=useState(''); const [channelId,setChannelId]=useState(''); const [attachment,setAttachment]=useState(false); const [bookmarks,setBookmarks]=useState(false); const [folder,setFolder]=useState(''); const [after,setAfter]=useState(''); const [before,setBefore]=useState(''); const [lastNDays,setLastNDays]=useState(''); const [results,setResults]=useState([]); const [loading,setLoading]=useState(false);
  // Count active filters (excluding the search query itself) for the clear-all badge.
  const activeFilterCount = (user.trim()?1:0) + (channelId?1:0) + (attachment?1:0) + (bookmarks?1:0) + (folder?1:0) + (after?1:0) + (before?1:0) + (lastNDays?1:0);
  const isoDaysAgo = days => { const d=new Date(); d.setDate(d.getDate()-days); return d.toISOString().slice(0,10); };
  const rangeDate = days => {
    if (days === 'month') { const d=new Date(); d.setDate(1); return d.toISOString().slice(0,10); }
    if (days === 'year') { const d=new Date(); d.setMonth(0); d.setDate(1); return d.toISOString().slice(0,10); }
    return isoDaysAgo(Number(days));
  };
  const applyRange = days => { setLastNDays(''); setAfter(rangeDate(days)); setBefore(''); };
  const RANGE_PRESETS = [['today','Today'],['7','Last 7 days'],['30','Last 30 days'],['month','This month'],['year','This year']];
  const rangeActive = days => after===rangeDate(days) && !before;
  const clearAll = () => { setQ(''); setUser(''); setChannelId(''); setAttachment(false); setBookmarks(false); setFolder(''); setAfter(''); setBefore(''); setLastNDays(''); setResults([]); };
  async function search(e){e?.preventDefault(); if(!q.trim())return; setLoading(true); const params=new URLSearchParams({q}); if(user)params.set('user',user); if(channelId)params.set('channelId',channelId); if(attachment)params.set('hasAttachment','true'); const effectiveAfter = lastNDays && Number(lastNDays)>0 ? isoDaysAgo(Math.min(3650, Math.floor(Number(lastNDays)))) : after; if(effectiveAfter)params.set('after',effectiveAfter+'T00:00:00'); if(before)params.set('before',before+'T23:59:59.999'); if(bookmarks){params.set('bookmarks','true'); if(folder)params.set('folder',folder);} const d=await api(`/api/search?${params}`); setResults(Array.isArray(d)?d:[]);setLoading(false);}
  return <div className="search-overlay" onClick={onClose}><div className="search-modal" onClick={e=>e.stopPropagation()}><div className="menu-modal-header"><h2>Search Unknown</h2><div className="search-hdr-actions"><button className={`search-clear-all${activeFilterCount>0 ? ' has-filters' : ''}`} type="button" onClick={clearAll} title="Clear all filters">✕ Clear all{activeFilterCount>0&&<span className="filter-count-badge">{activeFilterCount}</span>}</button><button className="icon-btn" onClick={onClose}>✕</button></div></div><form className="search-form" onSubmit={search}><input autoFocus value={q} onChange={e=>setQ(e.target.value)} placeholder="Search messages…"/><input value={user} onChange={e=>setUser(e.target.value)} placeholder="Username filter"/><select value={channelId} onChange={e=>setChannelId(e.target.value)}><option value="">All channels</option>{(boot?.channels||[]).map(c=><option key={c.id} value={c.id}>#{c.name}</option>)}</select><label className="remember"><input type="checkbox" checked={attachment} onChange={e=>setAttachment(e.target.checked)}/> Attachments only</label><label className="remember schedule"><span className="range-chips">{RANGE_PRESETS.map(([d,l])=><button type="button" key={d} className={`range-chip${rangeActive(d)?' active':''}`} onClick={()=>applyRange(d)}>{l}</button>)}</span><label className="last-days-control">Last <input type="number" min="1" max="3650" inputMode="numeric" value={lastNDays} onChange={e=>{setLastNDays(e.target.value.replace(/\D/g,''));setAfter('');setBefore('');}} placeholder="N" aria-label="Last N days" /> days</label>From<input type="date" value={after} onChange={e=>setAfter(e.target.value)}/></label><label className="remember schedule">To<input type="date" value={before} onChange={e=>setBefore(e.target.value)}/></label><label className="remember"><input type="checkbox" checked={bookmarks} onChange={e=>setBookmarks(e.target.checked)}/> 🔖 Bookmarks only</label>{bookmarks&&<select value={folder} onChange={e=>setFolder(e.target.value)}><option value="">All folders</option>{BOOKMARK_FOLDERS.map(f=><option key={f} value={f}>{f}</option>)}</select>}<button>Search</button></form><div className="search-results">{loading&&<p className="empty-text">Searching…</p>}{!loading&&!results.length&&<p className="empty-text">{bookmarks?'Search your saved bookmarks by keyword, user, or folder.':'Search messages, users, or attachments.'}</p>}{results.map(r=><button className="search-result" key={r.id} onClick={()=>{ if(bookmarks && r.bm_folder && onJumpBookmark) onJumpBookmark({...r, folder:r.bm_folder}); else { navigator.clipboard?.writeText(r.body||''); notify('Message copied','ok'); } }}><b>{r.nickname||r.username}</b><time>{timeAgo(r.created_at)}</time><span>{r.body||'Attachment'}</span>{r.bm_folder&&<small className="bm-tag">🔖 {r.bm_folder}</small>}</button>)}</div></div></div>;
}

function NotificationsPanel({ onClose, onOpenBookmarks, bmCount }) {
  const [notifs, setNotifs] = useState([]);

  useEffect(() => {
    api('/api/notifications').then(n => setNotifs(Array.isArray(n) ? n : []));
  }, []);

  async function markAll() {
    await api('/api/notifications/read', { method:'POST', body:'{}' });
    setNotifs(n => n.map(x => ({...x, read:1})));
  }

  const pings     = notifs.filter(n => n.type === 'ping');
  const dms       = notifs.filter(n => n.type === 'dm' || n.type === 'group');
  const replies   = notifs.filter(n => n.type === 'reply' || n.type === 'friend_request');
  const reminders = notifs.filter(n => n.type === 'reminder');
  const likes     = notifs.filter(n => n.type === 'like');
  const others    = notifs.filter(n => !['ping','dm','group','reply','friend_request','reminder','like'].includes(n.type));

  function Section({ title, items, color }) {
    if (!items.length) return null;
    return (
      <div className="notif-section">
        <div className="notif-section-title" style={{color}}>{title}</div>
        {items.map(n => (
          <div key={n.id} className={`notif-item${n.read?'':' unread'}`} onClick={async () => {
            await api('/api/notifications/read', { method:'POST', body:JSON.stringify({id:n.id}) });
            setNotifs(x => x.map(i => i.id===n.id ? {...i,read:1} : i));
          }}>
            <span className="notif-dot" style={{background:color}} />
            <span className="notif-body">{n.body}</span>
            <time className="notif-time">{timeAgo(n.created_at)}</time>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="notif-panel">
      <div className="notif-header">
        <b>Notifications</b>
        <div style={{display:'flex',gap:4}}>
          <button className="ghost" onClick={markAll} style={{fontSize:'0.75rem'}}>Mark all read</button>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
      </div>
      {notifs.length === 0 && <p className="empty-text">No notifications yet.</p>}
      {onOpenBookmarks && (
        <button className="notif-bookmark-row" onClick={onOpenBookmarks} title="Open bookmarks">
          <span>🔖 Bookmarks</span>
          <span className="notif-bookmark-count">{bmCount||0}</span>
          <span className="notif-bookmark-go">Open →</span>
        </button>
      )}
      <Section title="⏰ Reminders" items={reminders} color="var(--gold)" />
      <Section title="🟢 Pings"   items={pings}   color="var(--brand)" />
      <Section title="💬 Messages" items={dms}     color="var(--ok)" />
      <Section title="↩ Replies"  items={replies} color="var(--warn)" />
      <Section title="👍 Likes"    items={likes}   color="var(--brand)" />
      <Section title="Other"      items={others}  color="var(--muted)" />
    </div>
  );
}

// ── Discovery View ────────────────────────────────────────────────────────────
// ── Reveal (social area) ──────────────────────────────────────────────────────
function RevealView({ me, notify, onViewProfile, boot }) {
  const [posts, setPosts] = useState([]);
  const [people, setPeople] = useState([]);
  const [banned, setBanned] = useState(false);
  const [banReason, setBanReason] = useState('');
  const [filter, setFilter] = useState('all');
  const [sortBy, setSortBy] = useState('new');
  const [followingOnly, setFollowingOnly] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [uploading, setUploading] = useState(false);
  const [quizPick, setQuizPick] = useState({});
  const [composer, setComposer] = useState({ type:'post', body:'', media:null, mediaName:'', mediaType:'', quizQ:'', quizOpts:['',''], quizAns:0 });
  const [openComments, setOpenComments] = useState({});   // postId -> { list, loading }
  const [commentSort, setCommentSort] = useState({});     // postId -> 'new' | 'top'
  const [commentBodies, setCommentBodies] = useState({}); // postId -> draft text
  const [replyTo, setReplyTo] = useState({});             // postId -> comment being replied to
  const [reportMenu, setReportMenu] = useState(null);     // post being reported
  const [mentionBox, setMentionBox] = useState(null);     // { postId, query, start } while typing @mention
  const commentInputRef = useRef(null);
  const [showRemoved, setShowRemoved] = useState(false);  // 'my removed posts' modal
  const [removedPosts, setRemovedPosts] = useState([]);
  const [removedLoading, setRemovedLoading] = useState(false);
  const [appealTexts, setAppealTexts] = useState({});      // postId -> appeal draft
  const [appealBusy, setAppealBusy] = useState(false);
  const fileRef = useRef(null);

  async function load() {
    const params = new URLSearchParams();
    if (filter === 'following' || followingOnly) params.set('following', 'true');
    if (filter !== 'following' && filter !== 'all') params.set('type', filter);
    if (searchQ.trim()) params.set('q', searchQ.trim());
    if (sortBy !== 'new') params.set('sort', sortBy);
    const d = await api(`/api/reveal/feed?${params}`).catch(() => null);
    if (!d || d.error) return;
    setPosts(d.posts || []); setPeople(d.people || []); setBanned(!!d.banned); setBanReason(d.banReason || '');
    const unviewed = (d.posts || []).filter(p => !p.viewed).map(p => p.id);
    if (unviewed.length) {
      api('/api/reveal/views', { method:'POST', body: JSON.stringify({ postIds: unviewed }) }).catch(()=>{});
      setPosts(x => x.map(p => unviewed.includes(p.id) ? { ...p, viewed: true, views: (p.views||0) + 1 } : p));
    }
  }
  // Load the user's saved Reveal sort preference once on mount.
  useEffect(() => {
    api('/api/settings').then(s => {
      if (s && ['new','likes','comments','trending'].includes(s.reveal_sort)) setSortBy(s.reveal_sort);
    }).catch(()=>{});
  }, []);

  // Persist the chosen sort as a saved per-user preference (debounced).
  const sortTouched = useRef(false);
  useEffect(() => {
    if (!sortTouched.current) { sortTouched.current = true; return; }
    const t = setTimeout(() => {
      api('/api/settings').then(s => {
        api('/api/settings', { method: 'PATCH', body: JSON.stringify({ ...s, reveal_sort: sortBy }) }).catch(()=>{});
      }).catch(()=>{});
    }, 400);
    return () => clearTimeout(t);
  }, [sortBy]);

  async function uploadMedia(file) {
    setUploading(true);
    const fd = new FormData(); fd.append('file', file);
    try {
      const d = await fetch('/api/upload', { method:'POST', headers:{ Authorization:`Bearer ${getToken()}` }, body: fd }).then(r=>r.json());
      if (d.url) setComposer(c => ({ ...c, media: d.url, mediaName: d.name, mediaType: d.type }));
      else notify('Upload failed','err');
    } catch { notify('Upload failed','err'); }
    setUploading(false);
  }

  async function submit(e) {
    e.preventDefault();
    if (banned) return notify(`You are banned from posting: ${banReason}`,'err');
    const body = { type: composer.type, body: composer.body, media: composer.media, mediaName: composer.mediaName, mediaType: composer.mediaType };
    if (composer.type === 'quiz') body.quiz = { question: composer.quizQ, options: composer.quizOpts.filter(o=>o.trim()), answer: composer.quizAns };
    const d = await api('/api/reveal/posts', { method:'POST', body: JSON.stringify(body) });
    if (d.error) notify(d.error, 'err');
    else {
      notify('Posted to Reveal!','ok');
      setComposer({ type:'post', body:'', media:null, mediaName:'', mediaType:'', quizQ:'', quizOpts:['',''], quizAns:0 });
      load();
    }
  }

  async function like(p) {
    const d = p.liked
      ? await api(`/api/reveal/posts/${p.id}/like`, { method:'DELETE' })
      : await api(`/api/reveal/posts/${p.id}/like`, { method:'POST' });
    if (d && !d.error) setPosts(x => x.map(q => q.id===p.id ? { ...q, liked: !p.liked, likes: d.likes } : q));
  }
  async function follow(u) {
    const d = u.following
      ? await api(`/api/reveal/users/${u.id}/follow`, { method:'DELETE' })
      : await api(`/api/reveal/users/${u.id}/follow`, { method:'POST' });
    if (d && !d.error) {
      const delta = u.following ? -1 : 1;
      setPosts(x => x.map(q => q.author_id===u.id ? { ...q, following: !u.following, followers: (q.followers||0) + delta } : q));
      setPeople(x => x.map(q => q.id===u.id ? { ...q, following: !u.following, followers: (q.followers||0) + delta } : q));
    }
  }
  async function del(p) {
    if (!confirm('Delete this post?')) return;
    const d = await api(`/api/reveal/posts/${p.id}`, { method:'DELETE' });
    if (!d.error) setPosts(x => x.filter(q => q.id!==p.id));
  }
  async function loadComments(p) {
    setOpenComments(o => ({ ...o, [p.id]: { ...(o[p.id]||{}), loading: true } }));
    const sort = commentSort[p.id] || 'new';
    const d = await api(`/api/reveal/posts/${p.id}/comments?sort=${sort}`).catch(() => null);
    setOpenComments(o => ({ ...o, [p.id]: { list: (d && d.comments) || [], loading: false } }));
  }
  function setCommentsSort(p, sort) {
    setCommentSort(s => ({ ...s, [p.id]: sort }));
    loadComments(p);
  }
  function toggleComments(p) {
    if (openComments[p.id]) setOpenComments(o => { const n = {...o}; delete n[p.id]; return n; });
    else loadComments(p);
  }
  async function postComment(p, parentId) {
    const body = (commentBodies[p.id]||'').trim();
    if (!body) return;
    const d = await api(`/api/reveal/posts/${p.id}/comments`, { method:'POST', body: JSON.stringify({ body, parentId: parentId || null }) });
    if (d.error) notify(d.error, 'err');
    else {
      setCommentBodies(cb => ({ ...cb, [p.id]: '' }));
      setReplyTo(r => { const n = {...r}; delete n[p.id]; return n; });
      setPosts(x => x.map(q => q.id===p.id ? { ...q, comments: (q.comments||0) + 1 } : q));
      loadComments(p);
    }
  }
  // ── @mention autocomplete for comment bodies ────────────────────────────
  function mentionAt(text, pos) {
    const at = (text||'').lastIndexOf('@', pos);
    if (at < 0) return null;
    if (at > 0 && !/\s/.test(text[at-1])) return null;
    const q = (text||'').slice(at+1, pos);
    if (!/^[\w]*$/.test(q)) return null;
    return { query: q, start: at };
  }
  const mentionUsers = (mentionBox ? (boot?.users||[]).filter(u => u.id !== me.id && !u.is_bot) : [])
    .filter(u => { const n = (u.username||'').toLowerCase(); const nn = (u.nickname||u.username||'').toLowerCase(); const q = (mentionBox?.query||'').toLowerCase(); return n.startsWith(q) || nn.startsWith(q); })
    .slice(0, 6);
  function applyMention(u) {
    const pid = mentionBox?.postId;
    if (!pid) return;
    const cur = commentBodies[pid] || '';
    const start = mentionBox.start ?? 0;
    const next = cur.slice(0, start) + '@' + u.username + ' ' + cur.slice(mentionBox.start + mentionBox.query.length);
    setCommentBodies(cb => ({ ...cb, [pid]: next }));
    setMentionBox(null);
    requestAnimationFrame(() => { const el = commentInputRef.current; if (el) el.setSelectionRange(start + u.username.length + 1, start + u.username.length + 1); });
  }
  function onCommentKeyDown(e, p) {
    if (!mentionBox || mentionBox.postId !== p.id || !mentionUsers.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); return; }
    if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); applyMention(mentionUsers[0]); }
    else if (e.key === 'Escape') setMentionBox(null);
  }
  function onCommentInput(e, p) {
    const v = e.target.value;
    const pos = e.target.selectionStart ?? v.length;
    setCommentBodies(cb => ({ ...cb, [p.id]: v }));
    const m = mentionAt(v, pos);
    if (m) setMentionBox({ postId: p.id, query: m.query, start: m.start });
    else if (mentionBox?.postId === p.id) setMentionBox(null);
  }

  // ── 'My removed posts' + appeals ─────────────────────────────────────────
  async function loadRemoved() {
    setRemovedLoading(true);
    const d = await api('/api/reveal/me/removed').catch(() => null);
    if (d && !d.error) setRemovedPosts(d.posts || []);
    setRemovedLoading(false);
  }
  async function submitAppeal(p) {
    const text = (appealTexts[p.id]||'').trim();
    if (!text && p.appeal_status !== 'pending') return notify('Explain why the post should be restored', 'err');
    setAppealBusy(true);
    const d = await api(`/api/reveal/posts/${p.id}/appeal`, { method:'POST', body: JSON.stringify({ text }) }).catch(() => null);
    setAppealBusy(false);
    if (d && !d.error) {
      notify(d.status === 'pending' ? 'Appeal submitted — an admin will review it' : 'Appeal withdrawn', 'ok');
      setAppealTexts(t => ({ ...t, [p.id]: '' }));
      loadRemoved();
    } else notify(d?.error || 'Could not submit appeal', 'err');
  }

  async function pinComment(p, c) {
    const d = await api(`/api/reveal/comments/${c.id}/pin`, { method:'PATCH', body: JSON.stringify({ pinned: !c.pinned }) });
    if (!d.error) loadComments(p);
  }
  async function reportPost(p, cat) {
    const d = await api('/api/reports', { method:'POST', body: JSON.stringify({ targetType:'reveal', targetId:p.id, reason:cat, category:cat }) });
    setReportMenu(null);
    notify(d.error ? d.error : 'Post reported to moderation','ok');
  }
  async function delComment(p, c) {
    if (!confirm('Delete this comment?')) return;
    const d = await api(`/api/reveal/comments/${c.id}`, { method:'DELETE' });
    if (!d.error) {
      setPosts(x => x.map(q => q.id===p.id ? { ...q, comments: Math.max(0, (q.comments||0) - 1) } : q));
      loadComments(p);
    }
  }
  async function likeComment(p, c) {
    const d = c.liked
      ? await api(`/api/reveal/comments/${c.id}/like`, { method:'DELETE' })
      : await api(`/api/reveal/comments/${c.id}/like`, { method:'POST' });
    if (!d || d.error) return;
    const bump = (node) => {
      if (!node) return node;
      if (node.id === c.id) return { ...node, liked: !!d.liked, likes: Number(d.likes) };
      return { ...node, replies: (node.replies || []).map(bump) };
    };
    setOpenComments(o => {
      const cur = o[p.id]; if (!cur) return o;
      return { ...o, [p.id]: { ...cur, list: (cur.list || []).map(bump) } };
    });
  }
  function quizData(p) {
    try { return typeof p.quiz === 'string' ? JSON.parse(p.quiz) : p.quiz; } catch { return null; }
  }

  const FILTERS = [['all','All'],['following','👥 Following'],['post','📝 Posts'],['video','🎬 Videos'],['short','📱 Shorts'],['quiz','❓ Quizzes']];

  function CommentItem({ c, post, depth }) {
    const isAuthor = post.author_id === me.id;
    return (
      <div className={`reveal-comment${c.pinned ? ' pinned' : ''}${depth > 0 ? ' reply' : ''}`}>
        <div className="reveal-comment-head">
          <Avatar src={c.avatar} name={c.nickname||c.username} size="xs" badge={c.badge} onClick={() => onViewProfile({id:c.author_id,username:c.username,tag:c.tag,avatar:c.avatar,nickname:c.nickname,badge:c.badge})} />
          <b onClick={() => onViewProfile({id:c.author_id,username:c.username,tag:c.tag,avatar:c.avatar,nickname:c.nickname,badge:c.badge})} style={{cursor:'pointer'}}>{c.nickname||c.username}</b>
          <time>{timeAgo(c.created_at)}</time>
          {c.pinned ? <span className="comment-pin-tag">📌</span> : null}
        </div>
        <p className="reveal-comment-body">{mentionize(c.body, name => {
          const u = (boot?.users||[]).find(x => x.username === name || x.username?.toLowerCase() === name.toLowerCase());
          if (u) onViewProfile({id:u.id,username:u.username,tag:u.tag,avatar:u.avatar,nickname:u.nickname,badge:u.badge});
          else api(`/api/users/by-username/${encodeURIComponent(name)}`).then(d => { if (d && !d.error) onViewProfile(d.user); }).catch(()=>{});
        })}</p>
        <div className="reveal-comment-actions">
          <button className={`comment-like-btn${c.liked ? ' liked' : ''}`} onClick={() => likeComment(post, c)} title={c.liked ? 'Unlike' : 'Like'}>{c.liked ? '❤️' : '🤍'} {c.likes || 0}</button>
          <button className="comment-reply-btn" onClick={() => setReplyTo(r => ({ ...r, [post.id]: c }))}>Reply</button>
          {(isAuthor || me.is_admin) && (
            <button className="comment-pin-btn" onClick={() => pinComment(post, c)}>{c.pinned ? 'Unpin' : '📌 Pin'}</button>
          )}
          {(c.author_id === me.id || isAuthor || me.is_admin) && (
            <button className="comment-del-btn" onClick={() => delComment(post, c)}>🗑</button>
          )}
        </div>
        {c.replies && c.replies.map(r => <CommentItem key={r.id} c={r} post={post} depth={depth + 1} />)}
      </div>
    );
  }

  function PostCard({ p }) {
    const q = quizData(p);
    const picked = quizPick[p.id];
    const isVid = p.type === 'video' || p.type === 'short';
    const cc = openComments[p.id];
    const replying = replyTo[p.id];
    return (
      <article className="reveal-card">
        <div className="reveal-card-head">
          <Avatar src={p.avatar} name={p.nickname||p.username} size="sm" badge={p.badge} onClick={() => onViewProfile({id:p.author_id,username:p.username,tag:p.tag,avatar:p.avatar,nickname:p.nickname,badge:p.badge})} />
          <div className="reveal-author" onClick={() => onViewProfile({id:p.author_id,username:p.username,tag:p.tag,avatar:p.avatar,nickname:p.nickname,badge:p.badge})}>
            <b>{p.nickname||p.username}</b>
            <small>{p.type==='short'?'📱 Short':p.type==='video'?'🎬 Video':p.type==='quiz'?'❓ Quiz':'📝 Post'} · {timeAgo(p.created_at)}</small>
          </div>
          {p.author_id !== me.id && (
            <button className={`reveal-follow${p.following?' on':''}`} onClick={() => follow(p)}>{p.following ? 'Following' : '+ Follow'}</button>
          )}
        </div>
        {p.body && <p className="reveal-body">{p.body}</p>}
        {p.media && isVid
          ? <video className="reveal-media" src={p.media} controls playsInline />
          : p.media && <img className="reveal-media" src={p.media} alt={p.mediaName||''} loading="lazy" />}
        {q && (
          <div className="reveal-quiz">
            <b>❓ {q.question}</b>
            <div className="g-choices">
              {q.options.map((opt, i) => {
                const revealed = picked !== undefined;
                let cls = 'g-choice';
                if (revealed) cls += i === q.answer ? ' right' : i === picked ? ' wrong' : ' dim';
                return (
                  <button key={i} className={cls} onClick={() => setQuizPick(prev => ({ ...prev, [p.id]: i }))}>
                    {opt}
                  </button>
                );
              })}
            </div>
            {picked !== undefined && <p className={`g-feedback ${picked === q.answer ? 'right' : 'wrong'}`}>{picked === q.answer ? '✅ Correct!' : `❌ Not quite — the answer was ${q.options[q.answer]}`}</p>}
          </div>
        )}
        <div className="reveal-card-foot">
          <button className={`reveal-action${p.liked?' on':''}`} onClick={() => like(p)}>👍 {p.likes||0}</button>
          <button className={`reveal-action${cc ? ' on' : ''}`} onClick={() => toggleComments(p)}>💬 {p.comments||0}</button>
          <span className="reveal-action views">👁 {(p.views||0).toLocaleString()}</span>
          {p.author_id !== me.id && <button className="reveal-action report" title="Report post" onClick={() => setReportMenu(p)}>🚩</button>}
          {(p.author_id === me.id || me.is_admin) && <button className="reveal-action del" onClick={() => del(p)}>🗑</button>}
        </div>
        {reportMenu && reportMenu.id === p.id && (
          <div className="report-menu">
            <b>Report this post?</b>
            {['spam','harassment','personal_info','threats','illegal','other'].map(cat => (
              <button key={cat} onClick={() => reportPost(p, cat)}>{cat.replaceAll('_',' ')}</button>
            ))}
            <button className="ghost" onClick={() => setReportMenu(null)}>Cancel</button>
          </div>
        )}
        {cc && (
          <div className="reveal-comments">
            <div className="comment-sort-row">
              <span className="muted-text">Sort:</span>
              {[['new','Newest'],['top','Top']].map(([v,lbl]) => (
                <button key={v} className={`chip${(commentSort[p.id]||'new')===v?' active':''}`} onClick={()=>setCommentsSort(p, v)}>{lbl}</button>
              ))}
            </div>
            {cc.loading && <p className="empty-text">Loading comments…</p>}
            {!cc.loading && (!cc.list || cc.list.length === 0) && <p className="empty-text">No comments yet — start the conversation!</p>}
            {!cc.loading && cc.list && cc.list.map(c => <CommentItem key={c.id} c={c} post={p} depth={0} />)}
            {replying && (
              <div className="reveal-reply-bar">
                <span>Replying to <b>{replying.nickname||replying.username}</b> — <button onClick={() => setReplyTo(r => { const n = {...r}; delete n[p.id]; return n; })}>cancel</button></span>
              </div>
            )}
            <div className="reveal-comment-compose">
              {mentionBox?.postId === p.id && mentionUsers.length > 0 && (
                <div className="mention-suggest">
                  {mentionUsers.map(u => (
                    <button key={u.id} type="button" onMouseDown={e=>{e.preventDefault(); applyMention(u);}}>
                      <Avatar src={u.avatar} name={u.nickname||u.username} size="xs" badge={u.badge} />
                      <span>{u.nickname||u.username}</span>
                      <small style={{color:'var(--muted)'}}>@{u.username}</small>
                    </button>
                  ))}
                </div>
              )}
              <form className="reveal-comment-form" onSubmit={e => { e.preventDefault(); postComment(p, replying?.id); }}>
                <input ref={commentInputRef} autoFocus value={commentBodies[p.id]||''}
                  onChange={e => onCommentInput(e, p)}
                  onKeyDown={e => onCommentKeyDown(e, p)}
                  onBlur={() => setTimeout(() => setMentionBox(x => x?.postId === p.id ? null : x), 150)}
                  placeholder={replying ? `Reply to ${replying.nickname||replying.username}…` : 'Add a comment…'} />
                <button disabled={!(commentBodies[p.id]||'').trim()}>Post</button>
              </form>
            </div>
          </div>
        )}
      </article>
    );
  }

  return (
    <div className="reveal-view">
      <div className="chat-header">
        <div className="channel-title"><h2>📹 Reveal</h2><span className="channel-topic">Posts · Shorts · Quizzes</span></div>
        <div style={{display:'flex',gap:4,alignItems:'center'}}>
          <input className="reveal-search" placeholder="Search posts or people…" value={searchQ} onChange={e=>setSearchQ(e.target.value)} />
          <button className="icon-btn" title="My removed posts & appeals" onClick={() => { setShowRemoved(true); loadRemoved(); }}>🗑️</button>
        </div>
      </div>
      <div className="reveal-body">
        {banned && <div className="reveal-banned">🚫 You are banned from posting in Reveal{banReason ? `: ${banReason}` : ''}.</div>}

        <form className="reveal-composer" onSubmit={submit}>
          <div className="reveal-type-row">
            {[['post','📝 Post'],['video','🎬 Video'],['short','📱 Short'],['quiz','❓ Quiz']].map(([t,label]) => (
              <button key={t} type="button" className={composer.type===t?'active':''} onClick={()=>setComposer(c=>({...c,type:t}))}>{label}</button>
            ))}
          </div>
          <textarea placeholder={composer.type==='quiz'?'Quiz caption (optional)…':composer.type==='post'?'Share something with the community…':'Caption…'} value={composer.body} onChange={e=>setComposer(c=>({...c,body:e.target.value}))} disabled={banned} rows={2} />
          {composer.type==='quiz' && (
            <div className="reveal-quiz-build">
              <input placeholder="Quiz question…" value={composer.quizQ} onChange={e=>setComposer(c=>({...c,quizQ:e.target.value}))} disabled={banned} />
              {composer.quizOpts.map((o,i)=>(
                <div key={i} className="reveal-quiz-opt">
                  <input placeholder={`Option ${i+1}`} value={o} onChange={e=>{ const a=[...composer.quizOpts]; a[i]=e.target.value; setComposer(c=>({...c,quizOpts:a})); }} disabled={banned} />
                  <label><input type="radio" name="quizAns" checked={composer.quizAns===i} onChange={()=>setComposer(c=>({...c,quizAns:i}))} disabled={banned} /> correct</label>
                </div>
              ))}
              {composer.quizOpts.length < 4 && <button type="button" className="ghost" onClick={()=>setComposer(c=>({...c,quizOpts:[...c.quizOpts,'']}))}>+ Option</button>}
            </div>
          )}
          {(composer.type==='video'||composer.type==='short'||composer.type==='post') && (
            <div className="reveal-composer-media">
              <button type="button" className="composer-attach" onClick={()=>fileRef.current?.click()} disabled={banned||uploading}>📎 {uploading?'Uploading…':'Media'}</button>
              <input type="file" ref={fileRef} style={{display:'none'}} onChange={e=>{ if(e.target.files[0]) uploadMedia(e.target.files[0]); }} accept="image/*,video/*" />
              {composer.media && <span className="reveal-media-chip">📎 {composer.mediaName} <button type="button" onClick={()=>setComposer(c=>({...c,media:null,mediaName:'',mediaType:''}))}>✕</button></span>}
            </div>
          )}
          <button type="submit" disabled={banned}>Post</button>
        </form>

        {people.length > 0 && (
          <div className="reveal-people">
            <h3 className="discover-section-title">⭐ Influencers to follow</h3>
            <div className="reveal-people-row">
              {people.map(u => (
                <div key={u.id} className="reveal-person">
                  <Avatar src={u.avatar} name={u.nickname||u.username} size="sm" badge={u.badge} onClick={() => onViewProfile({id:u.id,username:u.username,tag:u.tag,avatar:u.avatar,nickname:u.nickname,badge:u.badge})} />
                  <b onClick={() => onViewProfile({id:u.id,username:u.username,tag:u.tag,avatar:u.avatar,nickname:u.nickname,badge:u.badge})}>{u.nickname||u.username}</b>
                  <small>{u.followers||0} followers</small>
                  {u.id !== me.id && <button className={`reveal-follow${u.following?' on':''}`} onClick={() => follow(u)}>{u.following?'Following':'+ Follow'}</button>}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="reveal-filter-row">
          {FILTERS.map(([t,label]) => (
            <button key={t} className={filter===t?'active':''} onClick={()=>setFilter(t)}>{label}</button>
          ))}
          {filter !== 'following' && (
            <label className="remember reveal-follow-toggle">
              <input type="checkbox" checked={followingOnly} onChange={e=>setFollowingOnly(e.target.checked)} /> 👥 Following only
            </label>
          )}
          <span className="reveal-sort">
            <label className="reveal-sort-label">Sort</label>
            <select className="reveal-sort-select" value={sortBy} onChange={e=>setSortBy(e.target.value)}>
              <option value="new">🆕 Latest</option>
              <option value="likes">❤️ Most likes</option>
              <option value="comments">💬 Most commented</option>
              <option value="trending">🔥 Trending</option>
            </select>
          </span>
        </div>
        {posts.length === 0 && <p className="empty-text">{filter === 'following' ? 'You aren\'t following anyone yet — hit + Follow on people to see their posts here.' : 'Nothing here yet — be the first to post!'}</p>}
        {posts.map(p => <PostCard key={p.id} p={p} />)}
      </div>

      {showRemoved && (
        <div className="reveal-removed-overlay" onClick={() => setShowRemoved(false)}>
          <div className="reveal-removed-modal" onClick={e => e.stopPropagation()}>
            <div className="reveal-removed-hdr">
              <b>🗑️ My removed posts</b>
              <button className="icon-btn" onClick={() => setShowRemoved(false)}>✕</button>
            </div>
            <p className="muted-text" style={{fontSize:'0.78rem',marginTop:'-0.2rem'}}>Posts removed by moderation. You can appeal any removal — an admin will review it.</p>
            {removedLoading && <p className="empty-text">Loading…</p>}
            {!removedLoading && removedPosts.length === 0 && <p className="empty-text">Nothing here — you have no removed posts.</p>}
            <div className="reveal-removed-list">
              {removedPosts.map(p => {
                const q = typeof p.quiz === 'string' ? (()=>{try{return JSON.parse(p.quiz)}catch{return null}})() : p.quiz;
                const status = p.appeal_status || 'none';
                return (
                  <div key={p.id} className="reveal-removed-item">
                    <div className="reveal-removed-item-hdr">
                      <span className={`removed-type ${p.type}`}>{p.type === 'short' ? '📱 Short' : p.type === 'video' ? '🎬 Video' : p.type === 'quiz' ? '❓ Quiz' : '📝 Post'}</span>
                      <span className="removed-meta">{timeAgo(p.removed_at)}</span>
                    </div>
                    {p.body && <p className="removed-body">{p.body}</p>}
                    {q && <p className="removed-body">❓ {q.question} — {q.options?.map((o,i)=>`${i===q.answer?'✓':''} ${o}`).join(' · ')}</p>}
                    {p.media && <p className="removed-body muted-text">📎 {p.media_name || 'attachment'}</p>}
                    <div className="removed-reason">
                      <b>Removed by</b> {p.mod_nickname || p.mod_username || 'a moderator'}
                      {p.reason ? <span> — <i>{p.reason}</i></span> : null}
                    </div>
                    <div className="removed-appeal">
                      {status === 'pending' ? (
                        <div className="removed-status pending">⏳ Appeal pending — awaiting admin review</div>
                      ) : status === 'accepted' ? (
                        <div className="removed-status accepted">✅ Appeal accepted — post restored</div>
                      ) : status === 'rejected' ? (
                        <div className="removed-status rejected">❌ Appeal rejected{p.appeal_text ? ` — ${p.appeal_text}` : ''}</div>
                      ) : null}
                      {(status === 'none' || status === 'rejected') && (
                        <div className="removed-appeal-box">
                          <textarea placeholder="Explain why this post should be restored…" value={appealTexts[p.id]||''}
                            onChange={e => setAppealTexts(t => ({ ...t, [p.id]: e.target.value }))} rows={2} />
                          <button disabled={appealBusy} onClick={() => submitAppeal(p)}>{status === 'rejected' ? 'Appeal again' : 'Appeal removal'}</button>
                        </div>
                      )}
                      {status === 'pending' && (
                        <button className="ghost" disabled={appealBusy} onClick={() => submitAppeal(p)}>Withdraw appeal</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Bot builder wizard (server owners create custom bots) ────────────────────
function BotBuilderModal({ me, boot, server, onClose, notify, onDone, editBot, currentChannelId }) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('🤖');
  const [botColor, setBotColor] = useState('#5865f2');
  const [category, setCategory] = useState('Custom');
  const [desc, setDesc] = useState('');
  const [editId, setEditId] = useState(null);
  const [cmds, setCmds] = useState([{ command:'', description:'', response:'' }]);

  useEffect(() => {
    if (!editBot) return;
    setEditId(editBot.id);
    setName(editBot.nickname || '');
    setEmoji(editBot.emoji || '🤖');
    setBotColor(editBot.bot_color ? (editBot.bot_color.startsWith('#') ? editBot.bot_color : '#'+editBot.bot_color) : '#5865f2');
    setCategory(editBot.mkt_category || editBot.category || 'Custom');
    setDesc(editBot.mkt_desc || editBot.description || '');
    setCmds((editBot.commands && editBot.commands.length) ? editBot.commands.map(c => ({ ...c })) : [{ command:'', description:'', response:'' }]);
  }, [editBot]);
  const [saving, setSaving] = useState(false);
  const [bot, setBot] = useState(null);
  const [publishing, setPublishing] = useState(false);
  const [randTick, setRandTick] = useState(0);
  const [testChannel, setTestChannel] = useState('');
  const [testArgs, setTestArgs] = useState('');
  const [testRunIdx, setTestRunIdx] = useState(null);
  const [showMarkdownHelp, setShowMarkdownHelp] = useState(false);
  const previewEndRef = useRef(null);
  const srvChannels = (boot?.channels||[]).filter(c => c.community_id === server.id && c.type !== 'voice');
  useEffect(() => {
    if (!srvChannels.length) return;
    if (currentChannelId && srvChannels.some(c => c.id === currentChannelId)) return setTestChannel(currentChannelId);
    if (!testChannel) setTestChannel(srvChannels[0].id);
  }, [testChannel, boot, currentChannelId, server?.id]);

  function previewFor(c) {
    let r = (c.response || '').trim();
    if (!r) return 'Type a reply above to preview it';
    r = r.replace(/\{args\}/g, '(argument)').replace(/\{user\}/g, me?.nickname || me?.username || 'you');
    if (r.startsWith('{{game:')) return '🎮 Interactive game (starts when the command is triggered)';
    if (r.includes('||')) {
      const parts = r.split('||').map(s => s.trim()).filter(Boolean);
      if (parts.length) r = parts[(Math.random() * parts.length) | 0];
    }
    return r;
  }

  function setCmd(i, key, val) {
    const next = cmds.slice(); next[i] = { ...next[i], [key]: val }; setCmds(next);
  }
  function addCmd() { setCmds([...cmds, { command:'', description:'', response:'' }]); }
  useEffect(() => { previewEndRef.current?.scrollIntoView?.({ behavior:'smooth', block:'nearest' }); }, [cmds.length, randTick]);
  function rmCmd(i) { if (cmds.length > 1) setCmds(cmds.filter((_, idx) => idx !== i)); }

  // Live-test a command: ensure the bot is saved (so it has a real id + installed
  // commands), then fire it into the chosen channel via the server's bot pipeline.
  async function testRun(i) {
    const c = cmds[i] || {};
    if (!c.command || !c.response) return notify('Fill in the command and reply first', 'err');
    setTestRunIdx(i);
    let id = editId || bot?.id;
    try {
      if (!id) {
        const d = await api(`/api/servers/${server.id}/bots/custom`, { method:'POST', body: JSON.stringify({ name, emoji, color: botColor, category, description: desc, commands: cmds }) });
        if (d.error) throw new Error(d.error);
        id = d.bot?.id;
        setBot(d.bot);
      }
      if (!testChannel) throw new Error('Choose a channel to test in');
      const r = await api(`/api/servers/${server.id}/bots/${id}/test-run`, { method:'POST', body: JSON.stringify({ channelId: testChannel, command: c.command, argText: testArgs }) });
      if (r.error) throw new Error(r.error);
      notify(`▶ Sent !${c.command} to #${srvChannels.find(ch=>ch.id===testChannel)?.name||'channel'} — check chat!`);
    } catch (e) {
      notify('Test failed: ' + (e.message || e), 'err');
    }
    setTestRunIdx(null);
  }

  async function create() {
    setSaving(true);
    const d = await api(editId ? `/api/servers/${server.id}/bots/${editId}/update` : `/api/servers/${server.id}/bots/custom`, {
      method: editId ? 'PATCH' : 'POST',
      body: JSON.stringify({ name, emoji, color: botColor, category, description: desc, commands: cmds })
    });
    setSaving(false);
    if (d.error) notify(d.error, 'err');
    else {
      setBot(d.bot);
      notify(editId ? `${emoji} ${name} updated! Changes are live` : `${emoji} ${name} created! Try !${cmds[0]?.command} in chat` );
      onDone?.();
    }
  }
  async function publish() {
    setPublishing(true);
    const d = await api('/api/marketplace/publish', {
      method:'POST', body: JSON.stringify({ botId: bot.id, communityId: server.id, emoji, category, description: desc })
    });
    setPublishing(false);
    if (d.error) notify(d.error, 'err');
    else { notify(`${emoji} ${name} published to the marketplace!`, 'ok'); onDone?.(); onClose(); }
  }

  const fill = cmds.every(c => c.command.trim() && c.response.trim());
  return (
    <div className="menu-overlay" onClick={onClose}>
      <div className="menu-modal bot-builder" onClick={e => e.stopPropagation()}>
        <div className="menu-modal-header">
          <h2>{editId ? '✏️ Edit Bot' : '🤖 Bot Builder'}</h2>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="bot-builder-steps">
          <span className={step===1?'active':''}>1 · Info</span>
          <span className={step===2?'active':''}>2 · Commands</span>
          <span className={step===3?'active':''}>3 · Done</span>
        </div>

        {step === 1 && (
          <div className="bot-builder-body">
            <label>Bot name</label>
            <input value={name} maxLength={32} placeholder="e.g. Meme Bot" onChange={e=>setName(e.target.value)} />
            <label>Emoji</label>
            <input value={emoji} maxLength={4} placeholder="🤖" onChange={e=>setEmoji(e.target.value)} />
            <label>Avatar color <span className="muted-text" style={{fontSize:'0.7rem'}}>— the gradient behind your bot in chat</span></label>
            <div className="bb-color-row">
              {['#5865f2','#eb459e','#f23f42','#f0b232','#22b573','#3ba55d','#9b59b6','#00a8fc','#ff8b3d','#ffffff'].map(c => (
                <button key={c} type="button" title={c} className={`bb-swatch${botColor.toLowerCase()===c?' active':''}`} style={{background:c}} onClick={()=>setBotColor(c)} />
              ))}
              <input type="color" value={botColor.startsWith('#')?botColor:'#5865f2'} onChange={e=>setBotColor(e.target.value)} title="Custom color" style={{width:'34px',height:'26px',border:'none',background:'none',padding:0,cursor:'pointer'}} />
            </div>
            <label>Category</label>
            <select value={category} onChange={e=>setCategory(e.target.value)}>
              {['Custom','Games','Community','Moderation','Utility','Fun'].map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <label>Description</label>
            <textarea rows={3} maxLength={300} placeholder="What does this bot do?" value={desc} onChange={e=>setDesc(e.target.value)} />
            <p className="muted-text">Installing into: <b>{server.name}</b></p>
            <button disabled={!name.trim()} onClick={()=>setStep(2)}>Next →</button>
          </div>
        )}

        {step === 2 && (
          <div className="bot-builder-body">
            <p className="muted-text">Each command triggers the bot to reply in chat (e.g. <code>!meme</code>).</p>
            <div className="bb-test-target">
              <label>Test in:</label>
              <select value={testChannel} onChange={e=>setTestChannel(e.target.value)}>
                {srvChannels.map(ch => <option key={ch.id} value={ch.id}>#{ch.name}</option>)}
              </select>
              <label style={{marginLeft:'0.6rem'}}>Arguments</label>
              <input className="bb-test-args" value={testArgs} placeholder="optional, fills {args}" onChange={e=>setTestArgs(e.target.value)} />
              {testRunIdx !== null && <span className="bb-test-spinner">▶ Firing…</span>}
            </div>
            {cmds.map((c, i) => (
              <div key={i} className="bb-cmd">
                <div className="bb-cmd-row">
                  <input value={c.command} maxLength={32} placeholder="command (no !)" onChange={e=>setCmd(i,'command',e.target.value.replace(/[^\w-]/g,''))} />
                  <input value={c.description} maxLength={120} placeholder="short description" onChange={e=>setCmd(i,'description',e.target.value)} />
                  {cmds.length>1 && <button className="icon-btn" title="Remove command" onClick={()=>rmCmd(i)}>🗑</button>}
                </div>
                <div className="bb-response-row">
                  <input className="bb-response" value={c.response} maxLength={1000} placeholder="What the bot replies — separate random replies with ||" onChange={e=>setCmd(i,'response',e.target.value)} />
                  <button type="button" className="bb-markdown-help-btn" onClick={()=>setShowMarkdownHelp(v=>!v)} aria-expanded={showMarkdownHelp} title="Markdown reference">? Markdown</button>
                </div>
                {showMarkdownHelp && <div className="bb-markdown-help" role="dialog" aria-label="Markdown syntax reference">
                  <b>Markdown reference</b>
                  <span><strong>**bold**</strong> → <strong>bold</strong></span>
                  <span><em>*italic*</em> → <em>italic</em></span>
                  <span><code>`code`</code> → <code>code</code></span>
                  <span><code>``` blocks ```</code> → code block</span>
                  <span><span className="spoiler">||spoilers||</span> → click to reveal</span>
                  <span><span className="ping">@mentions</span> → mention a user</span>
                </div>}
                <div className="bb-preview" key={`${i}-${randTick}`}>
                  <div className="bb-preview-hdr">
                    <span className="bb-preview-label">👁 Preview</span>
                    <span className="bb-preview-in-chat">as it looks in chat</span>
                    <button
                      type="button"
                      className="bb-test-run"
                      disabled={testRunIdx !== null || !c.command || !c.response}
                      title="Live-fire this command into the selected channel"
                      onClick={()=>testRun(i)}
                    >{testRunIdx === i ? 'Sending…' : '▶ Test run'}</button>
                    {c.response.split('||').filter(Boolean).length > 1 && <span className="bb-pickcount">{c.response.split('||').filter(Boolean).length} random replies</span>}
                  </div>
                  <div className="bb-user-prompt">
                    <Avatar src={me?.avatar || null} name={me?.username || 'You'} size="sm" />
                    <div className="bb-msg-body">
                      <span className="bb-msg-author">{me?.username || 'You'}</span>
                      <span className="bb-user-cmd">!{c.command}</span>
                    </div>
                  </div>
                  <div className="bb-msg">
                    <Avatar src={null} name={name||'Bot'} size="sm" anonMask={emoji || '🤖'} anonColor={botColor || '#5865f2'} />
                    <div className="bb-msg-body">
                      <span className="bb-msg-author">{name || 'Your Bot'}<small> BOT</small></span>
                      <span className="bb-msg-text"><MsgBody text={previewFor(c)} me={me} /></span>
                    </div>
                    {c.response.includes('||') && <button type="button" className="icon-btn bb-roll" title="Roll another random pick" onClick={()=>setRandTick(t=>t+1)}>🎲</button>}
                  </div>
                </div>
              </div>
            ))}
            <div ref={previewEndRef} className="bb-preview-end" aria-hidden="true" />
            <button className="ghost" onClick={addCmd}>＋ Add command</button>
            <div className="bb-nav">
              <button className="ghost" onClick={()=>setStep(1)}>← Back</button>
              <button disabled={!fill} onClick={create}>{saving ? 'Saving…' : (editId ? 'Save changes' : 'Create bot')}</button>
            </div>
          </div>
        )}

        {step === 3 && bot && (
          <div className="bot-builder-body">
            <p className="bb-done">{emoji} <b>{name}</b>{editId ? ' updated' : ` is live in ${server.name}`}!</p>
            <p className="muted-text">Commands: {cmds.filter(c=>c.command.trim()).map(c => <code key={c.command}>!{c.command}</code>)}</p>
            {!editId && <button disabled={publishing} onClick={publish}>{publishing ? 'Publishing…' : '🌍 Publish to marketplace'}</button>}
            <button className="ghost" onClick={onClose}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}

function BotDetailModal({ bot, boot, mktServer, installedList, onInstall, onRemove, notify, onClose, me, onRefreshInstalled }) {
  const [cur, setCur] = useState(bot);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [posting, setPosting] = useState(false);
  const [reviewSort, setReviewSort] = useState('new');
  const [starFilter, setStarFilter] = useState(0);
  const [editingOwn, setEditingOwn] = useState(false); 
  const [ownDraft, setOwnDraft] = useState({ rating:5, comment:'' });

  async function load(id) {
    setLoading(true);
    const q = reviewSort === 'new' ? '' : `?sort=${reviewSort}`;
    const d = await api(`/api/marketplace/bots/${id}${q}`);
    setData(d && !d.error ? d : null);
    setLoading(false);
  }
  useEffect(() => { load(cur.id); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [cur.id, reviewSort]);
  useEffect(() => { if (data?.myReview) { setRating(data.myReview.rating); setComment(data.myReview.comment || ''); } }, [data]);

  const isInstalled = !!installedList && installedList.some(b => b.nickname === cur.name);

  async function submit() {
    setPosting(true);
    const d = await api(`/api/marketplace/bots/${cur.id}/reviews`, { method:'POST', body: JSON.stringify({ rating, comment }) });
    setPosting(false);
    if (d.error) notify(d.error, 'err');
    else { notify('⭐ Review saved!', 'ok'); load(cur.id); }
  }

  async function removeOwn() {
    const d = await api(`/api/marketplace/bots/${cur.id}/reviews`, { method:'DELETE' });
    if (d.error) notify(d.error, 'err');
    else { notify('Removed your review.', 'ok'); setEditingOwn(false); setRating(5); setComment(''); load(cur.id); }
  }

  async function saveOwnDraft() {
    const d = await api(`/api/marketplace/bots/${cur.id}/reviews`, { method:'POST', body: JSON.stringify({ rating: ownDraft.rating, comment: ownDraft.comment }) });
    if (d.error) notify(d.error, 'err');
    else { notify('⭐ Review saved!', 'ok'); setEditingOwn(false); load(cur.id); }
  }

  function startEditOwn() {
    setOwnDraft({ rating: data.myReview.rating, comment: data.myReview.comment || '' });
    setEditingOwn(true);
  }

  const instRow = (installedList||[]).find(x => x.nickname === cur.name);
  const canEdit = !!(instRow && mktServer && (me?.is_admin || (boot?.memberships||[]).some(m => m.community_id === mktServer && (m.role === 'owner' || m.role === 'admin'))));
  const serverChannels = (boot?.channels||[]).filter(ch => ch.community_id === mktServer && ch.type !== 'voice');
  const serverRoles = (boot?.roles||[]).filter(r => r.community_id === mktServer);

  async function saveCmdVisibility(command, hidden) {
    const d = await api(`/api/servers/${mktServer}/bots/${instRow.id}/visibility-all`, { method:'POST', body: JSON.stringify({ command, hidden }) });
    if (d.error) notify(d.error, 'err');
    else { notify(`!${command} ${hidden ? 'hidden' : 'shown'} in all ${d.channels || 0} text channels`, 'ok'); onRefreshInstalled?.(); }
  }
  async function saveCmdChannelVis(command, channelId, hidden) {
    const d = await api(`/api/servers/${mktServer}/bots/${instRow.id}/visibility`, { method:'PATCH', body: JSON.stringify({ command, channelId, hidden }) });
    if (d.error) notify(d.error, 'err'); else onRefreshInstalled?.();
  }
  async function saveCmdRole(command, kind, roleId) {
    const curList = ((instRow.commandRoles||{})[command] || {})[kind] || [];
    const next = roleId === '__clear__' ? [] : (curList.includes(roleId) ? curList.filter(r => r !== roleId) : [...curList, roleId]);
    const body = kind === 'trigger' ? { command, triggerRoles: next } : { command, blockedRoles: next };
    const d = await api(`/api/servers/${mktServer}/bots/${instRow.id}/command-roles`, { method:'PATCH', body: JSON.stringify(body) });
    if (d.error) notify(d.error, 'err'); else onRefreshInstalled?.();
  }

  function renderReply(r) {
    let s = (r || '').trim();
    if (s.startsWith('{{game:')) return '🎮 Interactive game (runs when triggered)';
    if (s.includes('||')) { const parts = s.split('||').map(x=>x.trim()).filter(Boolean); if (parts.length) s = parts[0] + (parts.length > 1 ? ' …' : ''); }
    return s.slice(0, 90) || '(empty)';
  }

  return (
    <div className="menu-overlay" onClick={onClose}>
      <div className="menu-modal bot-detail" onClick={e => e.stopPropagation()}>
        <div className="menu-modal-header">
          <h2>{data ? `${data.emoji} ${data.name}` : 'Bot'}</h2>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        {loading ? <div className="bot-detail-body"><p className="muted-text">Loading…</p></div> : !data ? (
          <div className="bot-detail-body"><p className="muted-text">Couldn't load this bot.</p></div>
        ) : (
          <div className="bot-detail-body">
            <p className="muted-text"><b>{data.category}</b>{data.author_name ? ` · by ${data.author_name}` : ''}</p>
            <p>{data.desc || 'No description.'}</p>
            <div className="bot-detail-meta">
              {!data.builtin ? <span className="mkt-stat">⚙️ {data.installs} install{data.installs!==1?'s':''}</span> : null}
              {data.reviewCount > 0
                ? <span className="mkt-stat">⭐ {data.avgRating} · {data.reviewCount} review{data.reviewCount!==1?'s':''}</span>
                : <span className="mkt-stat muted-text">⭐ No reviews yet</span>}
              {!data.builtin && data.created_at ? <span className="mkt-stat">📅 {data.created_at}</span> : null}
            </div>

            <h4 className="bot-detail-sub">📜 Commands</h4>
            <div className="bot-cmd-docs">
              {data.commands.length === 0 && <p className="muted-text">No commands yet.</p>}
              {data.commands.map(c => {
                const roleName = id => serverRoles.find(r => r.id === id)?.name || id;
                let trig = [], blk = [];
                const cmdScope = (instRow?.commandRoles||{})[c.command];
                if (cmdScope) { trig = cmdScope.trigger || []; blk = cmdScope.blocked || []; }
                else {
                  try { trig = JSON.parse(instRow?.trigger_roles || '[]'); } catch { trig = []; }
                  try { blk = JSON.parse(instRow?.blocked_roles || '[]'); } catch { blk = []; }
                }
                const hiddenChs = (instRow?.hiddenCommands||{})[c.command] || [];
                return (
                  <div key={c.command} className="bot-cmd-doc">
                    <code>!{c.command}</code>
                    <span className="bot-cmd-desc">{c.description || c.command}</span>
                    <span className="bot-cmd-reply">→ {renderReply(c.response||'')}</span>
                    {instRow && (trig.length > 0 || blk.length > 0 || hiddenChs.length > 0) && (
                      <span className="bot-cmd-chips">
                        {trig.length > 0 && <span className="cmd-lock-chip" title="Only these roles can use this command here">🔒 {trig.length === 1 ? `locked to ${roleName(trig[0])}` : `locked to ${trig.length} roles`}</span>}
                        {blk.length > 0 && <span className="cmd-lock-chip blocked" title="These roles are blocked from this command here">🚫 {blk.length === 1 ? `${roleName(blk[0])} blocked` : `${blk.length} roles blocked`}</span>}
                        {hiddenChs.length > 0 && <span className="cmd-lock-chip hid" title={`Hidden in ${hiddenChs.length} channel${hiddenChs.length===1?'':'s'} — trigger-role holders can still invoke`}>🙈 {hiddenChs.length === 1 ? 'hidden in 1 channel' : `hidden in ${hiddenChs.length} channels`}</span>}
                      </span>
                    )}
                    {canEdit && (
                      <div className="bot-cmd-edit">
                        <div className="bot-cmd-edit-row">
                          <span className="bot-cmd-edit-label">Visibility:</span>
                          <button className="mini" disabled={serverChannels.length===0} onClick={()=>saveCmdVisibility(c.command, true)}>🙈 Hide everywhere</button>
                          <button className="mini" disabled={serverChannels.length===0} onClick={()=>saveCmdVisibility(c.command, false)}>👁 Show everywhere</button>
                        </div>
                        {serverChannels.length > 0 && (
                          <div className="bot-cmd-edit-row wrap">
                            {serverChannels.map(ch => {
                              const hid = hiddenChs.includes(ch.id);
                              return (
                                <label key={ch.id} className={hid?'ch-hid':''} title={hid?`Hidden in #${ch.name}`:`Shown in #${ch.name}`}>
                                  <input type="checkbox" checked={hid} onChange={e=>saveCmdChannelVis(c.command, ch.id, e.target.checked)} />
                                  #{ch.name}
                                </label>
                              );
                            })}
                          </div>
                        )}
                        <div className="bot-cmd-edit-row wrap">
                          <span className="bot-cmd-edit-label">Trigger roles{trig.length?` (${trig.length})`:''}:</span>
                          <label><input type="checkbox" checked={trig.length===0} onChange={e=>{ if(e.target.checked) saveCmdRole(c.command, 'trigger', '__clear__'); }} /> everyone</label>
                          {serverRoles.map(r => (
                            <label key={r.id}><input type="checkbox" checked={trig.includes(r.id)} onChange={()=>saveCmdRole(c.command, 'trigger', r.id)} /> <span style={{color:r.color}}>{r.name}</span></label>
                          ))}
                          {serverRoles.length===0 && <span className="muted-text">no custom roles</span>}
                        </div>
                        <div className="bot-cmd-edit-row wrap">
                          <span className="bot-cmd-edit-label">Blocked roles{blk.length?` (${blk.length})`:''}:</span>
                          <label><input type="checkbox" checked={blk.length===0} onChange={e=>{ if(e.target.checked) saveCmdRole(c.command, 'blocked', '__clear__'); }} /> none</label>
                          {serverRoles.map(r => (
                            <label key={r.id}><input type="checkbox" checked={blk.includes(r.id)} onChange={()=>saveCmdRole(c.command, 'blocked', r.id)} /> <span style={{color:r.color}}>{r.name}</span></label>
                          ))}
                          {serverRoles.length===0 && <span className="muted-text">no custom roles</span>}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {mktServer && (isInstalled
              ? <button className="ghost" onClick={()=>{ const row = installedList.find(b=>b.nickname===cur.name); if (onRemove && row) onRemove(row); onClose(); }}>✓ Installed — Remove</button>
              : <button onClick={()=>{ if (onInstall) onInstall({ id:cur.id, name:cur.name, emoji:cur.emoji, commands:(data && data.commands)||[] }); onClose(); }}>＋ Install into this server</button>)}

            <h4 className="bot-detail-sub">⭐ Reviews {!data.builtin && data.reviewCount>0 ? `(${data.reviewCount})` : ''}</h4>
            {data.builtin
              ? <p className="muted-text">This is a built-in bot — reviews only apply to community-published bots.</p>
              : (<>
                  <div className="bot-review-head">
                    <span className="muted-text">Sort:</span>
                    {[['new','Newest'],['high','Highest rated'],['low','Lowest rated']].map(([v,lbl]) => (
                      <button key={v} className={`chip${reviewSort===v?' active':''}`} onClick={()=>setReviewSort(v)}>{lbl}</button>
                    ))}
                    <span className="muted-text" style={{marginLeft:'0.5rem'}}>Stars:</span>
                    {[0,5,4,3,2,1].map(n => (
                      <button key={n} className={`chip${starFilter===n?' active':''}`} onClick={()=>setStarFilter(n)}>{n===0 ? 'All' : ('⭐'.repeat(n) || String(n))}</button>
                    ))}
                    {data.myReview && <span className="bot-review-actions">
                      <button className="mini" onClick={startEditOwn}>✏️ Edit</button>
                      <button className="mini danger" onClick={removeOwn}>🗑 Remove</button>
                    </span>}
                  </div>
                  <div className="bot-review-list">
                    {(() => { const filtered = data.reviews.filter(r => !starFilter || r.rating === starFilter); return (
                      <>
                    {data.reviews.length === 0 && <p className="muted-text">No reviews yet — be the first!</p>}
                    {starFilter && data.reviews.length>0 && filtered.length===0 && <p className="muted-text">No {starFilter}-star reviews.</p>}
                    {filtered.map(r => {
                      const mine = r.user_id === data.myReview?.user_id;
                      return (
                        <div key={r.user_id} className="bot-review">
                          <div className="bot-review-top">
                            <span className="bot-review-author">{'⭐'.repeat(r.rating)} <b>{r.nickname || r.username || 'Anonymous'}</b>{mine ? <span className="badge">You</span> : null}</span>
                            <time>{r.created_at?.slice?.(0,10)}</time>
                          </div>
                          {mine && editingOwn ? (
                            <div className="bot-review-edit">
                              <div className="bot-review-stars">{[1,2,3,4,5].map(n => <button key={n} type="button" className={n<=ownDraft.rating?'on':''} onClick={()=>setOwnDraft(d=>({...d,rating:n}))}>⭐</button>)}</div>
                              <textarea rows={2} maxLength={500} placeholder="What did you think?" value={ownDraft.comment} onChange={e=>setOwnDraft(d=>({...d,comment:e.target.value}))} />
                              <span className="bot-review-actions">
                                <button className="mini" onClick={saveOwnDraft}>💾 Save</button>
                                <button className="mini ghost" onClick={()=>setEditingOwn(false)}>Cancel</button>
                              </span>
                            </div>
                          ) : (r.comment && <p className="bot-review-comment">{r.comment}</p>)}
                        </div>
                      );
                    })}
                      </>
                    ); })()}
                  </div>
                  <div className="bot-review-form">
                    <div className="bot-review-stars">{[1,2,3,4,5].map(n => <button key={n} type="button" className={n<=rating?'on':''} onClick={()=>setRating(n)}>⭐</button>)}</div>
                    <textarea rows={2} maxLength={500} placeholder="What did you think?" value={comment} onChange={e=>setComment(e.target.value)} />
                    <button disabled={posting} onClick={submit}>{posting ? 'Saving…' : (data.myReview ? 'Update review' : 'Post review')}</button>
                  </div>
                </>)}

            {data.alsoLiked && data.alsoLiked.length > 0 && (
              <div className="also-liked">
                <h4 className="bot-detail-sub">🤝 Also liked</h4>
                <p className="muted-text" style={{ fontSize:'0.75rem', marginTop:'0' }}>Servers that installed this bot also use these:</p>
                <div className="also-liked-row">
                  {data.alsoLiked.map(a => (
                    <button key={a.id} className="also-liked-card" onClick={()=>setCur(a)}>
                      <span className="also-liked-emoji">{a.emoji}</span>
                      <span className="also-liked-name">{a.name}</span>
                      <span className="also-liked-meta">{a.kind==='builtin' ? 'Built-in' : `${a.installs} install${a.installs===1?'':'s'}`}{a.avgRating ? ` · ⭐ ${a.avgRating}` : ''}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function DiscoveryView({ me, boot, notify, onBootRefresh, onJoin, currentChannelId }) {
  const [communities, setCommunities] = useState([]);
  const [recommended, setRecommended] = useState([]);
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [dailyQ, setDailyQ] = useState('');
  const [templates, setTemplates] = useState([]);
  const [mktServer, setMktServer] = useState('');
  const [installed, setInstalled] = useState([]);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editBot, setEditBot] = useState(null);
  const [detailBot, setDetailBot] = useState(null);
  const [cosmetics, setCosmetics] = useState({ catalog: [], owned: [], credits: 0, myEffects: [], gifters: {}, effectEverywhere: null, rotation: [], rotationStart: null, rotationPick: null });
  const [giftServer, setGiftServer] = useState('');
  const [giftData, setGiftData] = useState({ catalog: [], owned: [], credits: 0, myEffects: [], gifters: {}, effectEverywhere: null, rotation: [], rotationStart: null, rotationPick: null });
  const [giftCart, setGiftCart] = useState([]);
  const TAGS = ['gaming','music','art','coding','chill','memes','anime','study','general'];
  const adminServers = (boot?.memberships||[])
    .filter(m => me.is_admin || ['owner','admin'].includes(m.role))
    .map(m => ({ id:m.community_id, name:(boot?.communities||[]).find(c=>c.id===m.community_id)?.name || 'Unknown server' }));
  const mktServers = me.is_admin ? (boot?.communities||[]).map(c=>({id:c.id,name:c.name})) : adminServers;
  // Any server this user is a member of — anyone can gift cosmetics to these.
  const memberServers = (boot?.memberships||[])
    .map(m => ({ id:m.community_id, name:(boot?.communities||[]).find(c=>c.id===m.community_id)?.name || 'Unknown server' }))
    .filter((s,i,arr) => arr.findIndex(x=>x.id===s.id) === i);

  useEffect(() => {
    api('/api/bot-templates').then(d => setTemplates(d.templates||[]));
    if (!mktServer && mktServers.length) setMktServer(mktServers[0].id);
  }, [boot]);

  useEffect(() => {
    if (!mktServer) return;
    api(`/api/servers/${mktServer}/bots`).then(d => setInstalled(Array.isArray(d)?d:[]));
  }, [mktServer]);

  useEffect(() => {
    if (!mktServer) return;
    api(`/api/marketplace/cosmetics?communityId=${mktServer}`).then(d => {
      if (!d.error) setCosmetics({ catalog: d.catalog||[], owned: d.owned||[], credits: Number(d.credits||0), myEffects: d.myEffects||[], gifters: d.gifters||{}, effectEverywhere: d.effectEverywhere||null, rotation: d.rotation||[], rotationStart: d.rotationStart||null, rotationPick: d.rotationPick||null });
    });
  }, [mktServer]);

  useEffect(() => {
    if (!giftServer) return;
    api(`/api/marketplace/cosmetics?communityId=${giftServer}`).then(d => {
      if (!d.error) setGiftData({ catalog: d.catalog||[], owned: d.owned||[], credits: Number(d.credits||0), myEffects: d.myEffects||[], gifters: d.gifters||{}, effectEverywhere: d.effectEverywhere||null, rotation: d.rotation||[], rotationStart: d.rotationStart||null, rotationPick: d.rotationPick||null });
    });
  }, [giftServer]);

  async function install(tpl) {
    if (!mktServer) return notify('Pick a server to install into','err');
    const d = await api(`/api/servers/${mktServer}/bots/install`, { method:'POST', body: JSON.stringify({ templateId:tpl.id }) });
    if (d.error) notify(d.error,'err');
    else {
      notify(`${tpl.emoji} ${tpl.name} installed! Try !${tpl.commands[0]?.command} in chat`,'ok');
      onBootRefresh?.();
      api(`/api/servers/${mktServer}/bots`).then(r => setInstalled(Array.isArray(r)?r:[]));
    }
  }
  async function uninstall(bot) {
    if (!mktServer) return;
    if (!confirm(`Remove ${bot.nickname} from this server?`)) return;
    const d = await api(`/api/servers/${mktServer}/bots/${bot.id}`, { method:'DELETE' });
    if (d.error) notify(d.error,'err');
    else {
      notify(`${bot.nickname} removed`,'ok');
      onBootRefresh?.();
      api(`/api/servers/${mktServer}/bots`).then(r => setInstalled(Array.isArray(r)?r:[]));
    }
  }

  async function publishBot(bot) {
    const d = await api('/api/marketplace/publish', { method:'POST', body: JSON.stringify({ botId: bot.id, communityId: mktServer, emoji: bot.emoji || '🤖', category: 'Custom', description: '' }) });
    if (d.error) notify(d.error,'err');
    else {
      notify(`${bot.nickname} published to the marketplace!`,'ok');
      api('/api/bot-templates').then(d => setTemplates(d.templates||[]));
    }
  }
  async function buyCosmetic(item) {
    if (!mktServer) return notify('Pick a server first','err');
    const d = await api('/api/marketplace/cosmetics/buy', { method:'POST', body: JSON.stringify({ communityId: mktServer, itemId: item.id }) });
    if (d.error) notify(d.error,'err');
    else {
      notify(`${item.emoji} ${item.name} purchased!${d.role ? ' Role created in the server.' : ''}`,'ok');
      setCosmetics(c => ({ ...c, owned: d.owned||c.owned, credits: Number(d.credits) }));
      if (d.role) onBootRefresh?.();
      if (d.banner) onBootRefresh?.();
    }
  }

  async function setActiveEffect(serverId, itemId, which, everywhere) {
    const d = await api('/api/marketplace/cosmetics/effect', { method:'POST', body: JSON.stringify({ communityId: serverId, itemId, everywhere: !!everywhere }) });
    if (d.error) notify(d.error,'err');
    else api(`/api/marketplace/cosmetics?communityId=${serverId}`).then(r => { if (!r.error) which(r); });
  }
  async function toggleEverywhereEffect(serverId, on) {
    // When turning on, use the currently active effect here (or the first owned) as the everywhere pick.
    let pick = cosmetics.myEffects.find(fx => fx.isActive)?.item_id || cosmetics.myEffects[0]?.item_id;
    if (on && !pick) return notify('Pick an effect first — you don\'t own one in this server yet','err');
    await setActiveEffect(serverId, pick, r => setCosmetics({ ...cosmetics, myEffects: r.myEffects||[], effects: r.effects||cosmetics.effects, effectEverywhere: r.effectEverywhere||null }), on);
  }
  async function setEffectRotation(items) {
    const d = await api('/api/marketplace/cosmetics/rotation', { method:'POST', body: JSON.stringify({ items }) });
    if (d.error) notify(d.error,'err');
    else {
      const upd = c => ({ ...c, rotation: d.rotation||[], rotationStart: d.rotationStart||null, rotationPick: d.rotationPick||null });
      setCosmetics(upd); setGiftData(upd);
      notify(d.rotation?.length ? `🔁 Effects will rotate daily: ${d.rotation.map(id => COSMETIC_EFFECTS[id] || id).join(' ')}` : 'Effect rotation turned off','ok');
    }
  }

  async function giftCosmetic(item) {
    if (!giftServer) return notify('Pick a server to gift to','err');
    const d = await api('/api/marketplace/cosmetics/buy', { method:'POST', body: JSON.stringify({ communityId: giftServer, itemId: item.id }) });
    if (d.error) notify(d.error,'err');
    else {
      const target = memberServers.find(s=>s.id===giftServer)?.name || 'the server';
      notify(`🎁 ${item.emoji} ${item.name} gifted to ${target}!${d.role ? ' Role created there.' : ''}`,'ok');
      setGiftData(g => ({ ...g, owned: d.owned||g.owned, credits: Number(d.credits) }));
      if (d.role || d.banner) onBootRefresh?.();
    }
  }
  function toggleGiftCart(item) {
    setGiftCart(c => c.includes(item.id) ? c.filter(x => x !== item.id) : [...c, item.id]);
  }
  function giftCartTotal() {
    return giftCart.reduce((sum, id) => sum + (giftData.catalog.find(i => i.id === id)?.price || 0), 0);
  }
  async function checkoutGiftCart() {
    if (!giftServer) return notify('Pick a server to gift to','err');
    if (!giftCart.length) return notify('Your cart is empty','err');
    const d = await api('/api/marketplace/cosmetics/gift-cart', { method:'POST', body: JSON.stringify({ communityId: giftServer, items: giftCart }) });
    if (d.error) notify(d.error,'err');
    else {
      const target = memberServers.find(s=>s.id===giftServer)?.name || 'the server';
      const names = giftCart.map(id => giftData.catalog.find(i => i.id === id)?.name || id);
      notify(`🎁 ${names.length} item${names.length===1?'':'s'} gifted to ${target}!${d.roles?.length ? ` Roles created: ${d.roles.join(', ')}.` : ''}`,'ok');
      setGiftCart([]);
      setGiftData(g => ({ ...g, owned: d.owned||g.owned, credits: Number(d.credits) }));
      if (d.roles?.length || d.banner) onBootRefresh?.();
    }
  }

  async function updateBotSettings(bot, patch) {
    const d = await api(`/api/servers/${mktServer}/bots/${bot.id}/settings`, { method:'PATCH', body: JSON.stringify(patch) });
    if (d.error) notify(d.error,'err');
    else {
      notify(`${bot.nickname} ${patch.enabled === false ? 'disabled' : patch.enabled === true ? 'enabled' : 'settings updated'}`,'ok');
      api(`/api/servers/${mktServer}/bots`).then(r => setInstalled(Array.isArray(r)?r:[]));
    }
  }
  function toggleChannel(bot, chId) {
    let allowed = [];
    try { allowed = JSON.parse(bot.allowed_channels || '[]'); } catch { allowed = []; }
    const next = allowed.includes(chId) ? allowed.filter(c => c !== chId) : [...allowed, chId];
    updateBotSettings(bot, { allowedChannels: next });
  }
  function toggleBotRole(bot, roleId) {
    let roles = [];
    try { roles = JSON.parse(bot.trigger_roles || '[]'); } catch { roles = []; }
    const next = roles.includes(roleId) ? roles.filter(r => r !== roleId) : [...roles, roleId];
    updateBotSettings(bot, { triggerRoles: next });
  }
  function toggleBlockedBotRole(bot, roleId) {
    let roles = [];
    try { roles = JSON.parse(bot.blocked_roles || '[]'); } catch { roles = []; }
    const next = roles.includes(roleId) ? roles.filter(r => r !== roleId) : [...roles, roleId];
    updateBotSettings(bot, { blockedRoles: next });
  }
  async function toggleBotCommandVisibility(bot, command, channelId, hidden) {
    const d = await api(`/api/servers/${mktServer}/bots/${bot.id}/visibility`, { method:'PATCH', body: JSON.stringify({ command, channelId, hidden }) });
    if (d.error) notify(d.error,'err');
    else api(`/api/servers/${mktServer}/bots`).then(r => setInstalled(Array.isArray(r)?r:[]));
  }
  async function toggleCommandVisibilityEverywhere(bot, command, hidden) {
    const d = await api(`/api/servers/${mktServer}/bots/${bot.id}/visibility-all`, { method:'POST', body: JSON.stringify({ command, hidden }) });
    if (d.error) notify(d.error,'err');
    else {
      notify(`!${command} ${hidden ? 'hidden' : 'shown'} in all ${d.channels || 0} text channels`,'ok');
      api(`/api/servers/${mktServer}/bots`).then(r => setInstalled(Array.isArray(r)?r:[]));
    }
  }
  async function toggleCommandRole(bot, command, kind, roleId) {
    const cur = ((bot.commandRoles||{})[command] || {})[kind] || [];
    const next = roleId === '__clear__' ? [] : (cur.includes(roleId) ? cur.filter(r => r !== roleId) : [...cur, roleId]);
    const body = kind === 'trigger' ? { command, triggerRoles: next } : { command, blockedRoles: next };
    const d = await api(`/api/servers/${mktServer}/bots/${bot.id}/command-roles`, { method:'PATCH', body: JSON.stringify(body) });
    if (d.error) notify(d.error,'err');
    else api(`/api/servers/${mktServer}/bots`).then(r => setInstalled(Array.isArray(r)?r:[]));
  }

  useEffect(() => {
    api('/api/discover').then(d => { setCommunities(d.communities||[]); setRecommended(d.recommended||[]); });
    api('/api/daily-question').then(d => setDailyQ(d.question||''));
  }, []);

  useEffect(() => {
    api(`/api/discover?q=${encodeURIComponent(q)}&tag=${encodeURIComponent(tag)}`).then(d => {
      setCommunities(d.communities||[]);
      setRecommended(d.recommended||[]);
    });
  }, [q, tag]);

  function random() {
    const pub = communities.filter(c => c.visibility === 'public');
    if (pub.length) onJoin(pub[Math.floor(Math.random()*pub.length)]);
  }

  function ServerCard({ c }) {
    return (
      <div className="discover-card">
        <div className="discover-card-icon" style={{background:nameColor(c.name)}}>
          {c.icon ? <img src={c.icon} alt="" /> : c.name[0]}
        </div>
        <div className="discover-card-info">
          <b>{c.name}</b>
          <p>{c.description}</p>
          <div className="discover-tags">
            {(c.tags||'').split(',').filter(Boolean).map(t => (
              <span key={t} className="discover-tag" onClick={() => setTag(t)}>{t}</span>
            ))}
          </div>
        </div>
        <div className="discover-card-meta">
          <span>{c.member_count||0} members</span>
          <button onClick={() => onJoin(c)}>Join</button>
        </div>
      </div>
    );
  }

  return (
    <div className="discovery-view">
      <div className="chat-header">
        <div className="channel-title"><h2>🌐 Discover Servers</h2></div>
        <button className="icon-btn" title="Random server" onClick={random}>🎲 Random</button>
      </div>
      <div className="discovery-body">
        {dailyQ && (
          <div className="daily-question-card">
            <span className="daily-q-label">💬 Daily Question</span>
            <p>{dailyQ}</p>
          </div>
        )}
        <div className="discovery-filters">
          <input placeholder="Search servers…" value={q} onChange={e => setQ(e.target.value)} style={{flex:1}} />
          <div className="discover-tag-row">
            {TAGS.map(t => <button key={t} className={`discover-tag-btn${tag===t?' active':''}`} onClick={() => setTag(tag===t?'':t)}>{t}</button>)}
          </div>
        </div>
        {recommended.length > 0 && (
          <section>
            <h3 className="discover-section-title">⭐ Recommended for you</h3>
            {recommended.map(c => <ServerCard key={c.id} c={c} />)}
          </section>
        )}
        <section>
          <h3 className="discover-section-title">All Public Servers</h3>
          {communities.length === 0 && <p className="empty-text">No servers found.</p>}
          {communities.map(c => <ServerCard key={c.id} c={c} />)}
        </section>

        <section className="marketplace">
          <h3 className="discover-section-title">🤖 Bot Marketplace</h3>
          <p className="empty-text">Install ready-made bots into your servers with one click — then use their commands in chat (e.g. <code>!trivia</code>).</p>
          {mktServers.length === 0 && <p className="empty-text">You need to own or admin a server to install bots.</p>}
          {mktServers.length > 0 && (
            <div className="mkt-server-row">
              <span>Installing into:</span>
              <select value={mktServer} onChange={e=>setMktServer(e.target.value)}>
                {mktServers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <button className="bb-btn" onClick={()=>setBuilderOpen(true)}>🛠 Build your own bot</button>
            </div>
          )}
          <div className="mkt-grid">
            {templates.map(t => {
              const isInstalled = installed.some(b => b.nickname === t.name);
              return (
                <div key={t.id} className="mkt-card">
                  <div className="mkt-card-head">
                    <span className="mkt-emoji">{t.emoji}</span>
                    <div>
                      <b>{t.name}</b>
                      <small>{t.category}</small>
                    </div>
                    {t.custom && <span className="mkt-custom">⭐ Custom</span>}
                  </div>
                  <p>{t.desc}</p>
                  <div className="mkt-cmds">{t.commands.map(c => <code key={c.command}>!{c.command}</code>)}</div>
                  {t.custom && <p className="mkt-author">by {t.author}{t.installs>0 ? ` · ${t.installs} install${t.installs!==1?'s':''}` : ''}{t.reviewCount>0 ? ` · ⭐ ${t.avgRating}` : ''}</p>}
                  <div className="mkt-actions">
                    <button className="ghost" onClick={()=>setDetailBot(t)}>ℹ️ Details</button>
                    {mktServer && (isInstalled
                      ? <button className="ghost" onClick={()=>uninstall(installed.find(b=>b.nickname===t.name))}>✓ Installed — Remove</button>
                      : <button onClick={()=>install(t)}>Install</button>)}
                  </div>
                </div>
              );
            })}
          </div>
          {memberServers.length > 0 && (
            <div className="cosmetics-section gift-section">
              <div className="cosmetics-hdr">
                <b>🎁 Gift a cosmetic</b>
                <span className="credit-pill">✦ {giftData.credits}</span>
              </div>
              <p className="empty-text">Anyone can gift cosmetics to a server they're in — it's charged to your credits, and the server keeps it. Pick a server, then gift an item.</p>
              <div className="mkt-server-row">
                <span>Gift to:</span>
                <select value={giftServer} onChange={e=>setGiftServer(e.target.value)}>
                  <option value="">Choose a server…</option>
                  {memberServers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              {giftServer && (
                <>
                  <div className="mkt-grid">
                    {giftData.catalog.map(item => {
                      const owned = giftData.owned.includes(item.id);
                      const inCart = giftCart.includes(item.id);
                      return (
                        <div key={item.id} className={`mkt-card cosmetic-card${owned?' owned':''}${inCart?' in-cart':''}`}>
                          <div className="mkt-card-head">
                            <span className="mkt-emoji">{item.emoji}</span>
                            <div>
                              <b>{item.name}</b>
                              <small>{item.kind === 'role' ? 'Custom role' : item.kind === 'banner' ? 'Server banner' : 'Profile effect'}</small>
                            </div>
                          </div>
                          <p>{item.desc}</p>
                          {owned
                            ? <span className="cosmetic-owned">✓ Already owned{giftData.gifters?.[item.id] ? ` — gifted by ${giftData.gifters[item.id]}` : ''}</span>
                            : inCart
                              ? <button className="ghost" onClick={()=>toggleGiftCart(item)}>− Remove from cart</button>
                              : <button onClick={()=>toggleGiftCart(item)}>🛒 Add to cart — ✦{item.price}</button>}
                        </div>
                      );
                    })}
                  </div>
                  {giftCart.length > 0 && (
                    <div className="gift-cart-bar">
                      <span className="gift-cart-items">{giftCart.map(id => { const it = giftData.catalog.find(i => i.id === id); return it ? `${it.emoji} ${it.name}` : id; }).join(' · ')}</span>
                      <span className="gift-cart-total">Total: ✦{giftCartTotal()}</span>
                      <span className="gift-cart-actions">
                        <button className="mini ghost" onClick={()=>setGiftCart([])}>✕ Clear</button>
                        <button className="mini" disabled={giftData.credits < giftCartTotal()} onClick={checkoutGiftCart}>🎁 Gift {giftCart.length} item{giftCart.length===1?'':'s'} — ✦{giftCartTotal()}</button>
                      </span>
                    </div>
                  )}
                </>
              )}
              {giftData.myEffects.length > 1 && (
                <div className="active-effect-row">
                  <span>Active effect:</span>
                  {giftData.myEffects.map(fx => (
                    <button key={fx.item_id} className={`effect-chip${fx.isActive?' on':''}`} title={fx.isActive?'Showing by your name here':'Click to show by your name'} onClick={()=>setActiveEffect(giftServer, fx.item_id, r=>setGiftData({ ...giftData, myEffects: r.myEffects||[], effects: r.effects||giftData.effects, effectEverywhere: r.effectEverywhere||null, rotation: r.rotation||[], rotationStart: r.rotationStart||null, rotationPick: r.rotationPick||null }), giftData.effectEverywhere)}>
                      <span className="effect-chip-preview">{me?.nickname || me?.username || 'Your name'}<span className="effect-chip-emoji">{(COSMETIC_EFFECTS[fx.item_id] || fx.item_id)}</span></span>
                    </button>
                  ))}
                  <label className="same-everywhere" title="Rotate through your owned effects automatically — a different one each day">
                    <input type="checkbox" checked={giftData.rotation?.length > 0} onChange={e=>setEffectRotation(e.target.checked ? (giftData.myEffects.map(f=>f.item_id) || []) : [])} />
                    🔁 Rotate daily
                  </label>
                  {giftData.rotation?.length > 0 && (
                    <span className="rotation-today">
                      Today: <b>{(COSMETIC_EFFECTS[giftData.rotationPick] || giftData.rotationPick || '—')}</b>
                    </span>
                  )}
                </div>
              )}


            </div>
          )}
          {mktServer && (
            <div className="cosmetics-section">
              <div className="cosmetics-hdr">
                <b>🛍 Server Cosmetics</b>
                <span className="credit-pill">✦ {cosmetics.credits}</span>
              </div>
              <p className="empty-text">Decorate your server with credits — custom roles, gradient banners, and name effects.</p>
              <div className="mkt-grid">
                {cosmetics.catalog.map(item => {
                  const owned = cosmetics.owned.includes(item.id);
                  return (
                    <div key={item.id} className={`mkt-card cosmetic-card${owned?' owned':''}`}>
                      <div className="mkt-card-head">
                        <span className="mkt-emoji">{item.emoji}</span>
                        <div>
                          <b>{item.name}</b>
                          <small>{item.kind === 'role' ? 'Custom role' : item.kind === 'banner' ? 'Server banner' : 'Profile effect'}</small>
                        </div>
                      </div>
                      <p>{item.desc}</p>
                      {owned
                        ? <span className="cosmetic-owned">✓ Owned{cosmetics.gifters?.[item.id] ? ` — gifted by ${cosmetics.gifters[item.id]}` : ''}</span>
                        : <button disabled={cosmetics.credits < item.price} onClick={()=>buyCosmetic(item)}>Buy — ✦{item.price}</button>}
                    </div>
                  );
                })}
              </div>
              {(cosmetics.myEffects.length > 1 || cosmetics.effectEverywhere || cosmetics.rotation?.length) && (
                <div className="active-effect-row">
                  <span>Active effect:</span>
                  {cosmetics.myEffects.map(fx => (
                    <button key={fx.item_id} className={`effect-chip${fx.isActive?' on':''}`} title={fx.isActive?'Showing by your name here':'Click to show by your name'} onClick={()=>setActiveEffect(mktServer, fx.item_id, r=>setCosmetics({ ...cosmetics, myEffects: r.myEffects||[], effects: r.effects||cosmetics.effects, effectEverywhere: r.effectEverywhere||null, rotation: r.rotation||[], rotationStart: r.rotationStart||null, rotationPick: r.rotationPick||null }), cosmetics.effectEverywhere)}>
                      <span className="effect-chip-preview">{me?.nickname || me?.username || 'Your name'}<span className="effect-chip-emoji">{(COSMETIC_EFFECTS[fx.item_id] || fx.item_id)}</span></span>
                    </button>
                  ))}
                  <label className="same-everywhere" title="Apply the same active effect in every server where you own effects">
                    <input type="checkbox" checked={!!cosmetics.effectEverywhere} onChange={e=>toggleEverywhereEffect(mktServer, e.target.checked)} />
                    Same everywhere
                  </label>
                  <label className="same-everywhere" title="Rotate through your owned effects automatically — a different one each day">
                    <input type="checkbox" checked={cosmetics.rotation?.length > 0} onChange={e=>setEffectRotation(e.target.checked ? (cosmetics.myEffects.map(f=>f.item_id) || []) : [])} />
                    🔁 Rotate daily
                  </label>
                  {cosmetics.rotation?.length > 0 && (
                    <span className="rotation-today">
                      Today: <b>{(COSMETIC_EFFECTS[cosmetics.rotationPick] || cosmetics.rotationPick || '—')}</b>
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
          {installed.length > 0 && (
            <div className="mkt-installed">
              <b>Installed bots in this server:</b>
              {installed.map(b => {
                let allowed = [];
                try { allowed = JSON.parse(b.allowed_channels || '[]'); } catch { allowed = []; }
                let triggerRoles = [];
                try { triggerRoles = JSON.parse(b.trigger_roles || '[]'); } catch { triggerRoles = []; }
                let blockedRoles = [];
                try { blockedRoles = JSON.parse(b.blocked_roles || '[]'); } catch { blockedRoles = []; }
                const serverRoles = (boot?.roles||[]).filter(r => r.community_id === mktServer);
                const serverChannels = (boot?.channels||[]).filter(c => c.community_id === mktServer && c.type !== 'voice');
                return (
                  <div key={b.id} className={`mkt-bot ${Number(b.enabled) === 0 ? 'off' : ''}`}>
                    <div className="mkt-bot-row">
                      <span className="mkt-bot-name">{b.nickname}</span>
                      <label className="switch" title={Number(b.enabled)===0 ? 'Bot is off — enable it' : 'Bot is on'}>
                        <input type="checkbox" checked={Number(b.enabled)!==0} onChange={e=>updateBotSettings(b,{enabled:e.target.checked})} />
                        <span className="slider"></span>
                      </label>
                      {b.is_custom && <>
                        <button className="mkt-pub" title="Edit commands & push live" onClick={()=>{ setEditBot(b); setBuilderOpen(true); }}>✏️</button>
                        <button className="mkt-pub" onClick={()=>publishBot(b)}>🌍 Publish</button>
                      </>}
                    </div>
                    <details className="mkt-bot-channels">
                      <summary>Channels ({allowed.length === 0 ? 'all' : allowed.length})</summary>
                      <div className="mkt-ch-list">
                        <label><input type="checkbox" checked={allowed.length===0} onChange={e=>updateBotSettings(b,{allowedChannels:[]})} /> All channels</label>
                        {serverChannels.map(c => (
                          <label key={c.id}><input type="checkbox" checked={allowed.includes(c.id)} onChange={()=>toggleChannel(b,c.id)} /> #{c.name}</label>
                        ))}
                        {serverChannels.length === 0 && <p className="muted-text">No text channels in this server yet.</p>}
                      </div>
                    </details>
                    <details className="mkt-bot-channels">
                      <summary>Trigger roles ({triggerRoles.length === 0 ? 'everyone' : triggerRoles.length})</summary>
                      <div className="mkt-ch-list">
                        <label><input type="checkbox" checked={triggerRoles.length===0} onChange={e=>updateBotSettings(b,{triggerRoles:[]})} /> Everyone (default)</label>
                        {serverRoles.map(r => (
                          <label key={r.id}><input type="checkbox" checked={triggerRoles.includes(r.id)} onChange={()=>toggleBotRole(b,r.id)} /> <span style={{color:r.color}}>{r.name}</span></label>
                        ))}
                        {serverRoles.length === 0 && <p className="muted-text">No custom roles in this server.</p>}
                      </div>
                    </details>
                    <details className="mkt-bot-channels">
                      <summary>Blocked roles ({blockedRoles.length === 0 ? 'none' : blockedRoles.length})</summary>
                      <div className="mkt-ch-list">
                        <label><input type="checkbox" checked={blockedRoles.length===0} onChange={e=>updateBotSettings(b,{blockedRoles:[]})} /> Nobody blocked (default)</label>
                        {serverRoles.map(r => (
                          <label key={r.id}><input type="checkbox" checked={blockedRoles.includes(r.id)} onChange={()=>toggleBlockedBotRole(b,r.id)} /> <span style={{color:r.color}}>{r.name}</span></label>
                        ))}
                        {serverRoles.length === 0 && <p className="muted-text">No custom roles in this server.</p>}
                      </div>
                    </details>
                    <details className="mkt-bot-channels">
                      <summary>Command visibility</summary>
                      <div className="mkt-ch-list">
                        {(b.commands||[]).length === 0 && <p className="muted-text">No commands.</p>}
                        {(b.commands||[]).map(c => {
                          const cmdRoles = (b.commandRoles||{})[c.command] || { trigger:[], blocked:[] };
                          const cmdTrigger = cmdRoles.trigger || [];
                          const cmdBlocked = cmdRoles.blocked || [];
                          return (
                          <div key={c.command} className="mkt-cmd-vis">
                            <code>!{c.command}</code>
                            <span className="mkt-vis-everywhere">
                              <button className="mini" disabled={serverChannels.length===0} onClick={()=>toggleCommandVisibilityEverywhere(b, c.command, true)}>🙈 Hide everywhere</button>
                              <button className="mini" disabled={serverChannels.length===0} onClick={()=>toggleCommandVisibilityEverywhere(b, c.command, false)}>👁 Show everywhere</button>
                            </span>
                            <div className="mkt-vis-ch">
                              {serverChannels.map(ch => {
                                const hidden = ((b.hiddenCommands||{})[c.command]||[]).includes(ch.id);
                                return (
                                  <label key={ch.id} className={hidden?'ch-hid':''} title={hidden?`Hidden in #${ch.name}`:`Shown in #${ch.name}`}>
                                    <input type="checkbox" checked={hidden} onChange={e=>toggleBotCommandVisibility(b, c.command, ch.id, e.target.checked)} />
                                    #{ch.name}
                                  </label>
                                );
                              })}
                              {serverChannels.length===0 && <p className="muted-text">No text channels.</p>}
                            </div>
                            <div className="mkt-cmd-roles">
                              <span className="mkt-cmd-roles-label">Trigger roles{cmdTrigger.length?` (${cmdTrigger.length})`:''}:</span>
                              <label><input type="checkbox" checked={cmdTrigger.length===0} onChange={e=>{ if(e.target.checked) toggleCommandRole(b, c.command, 'trigger', '__clear__'); }} /> everyone</label>
                              {serverRoles.map(r => (
                                <label key={r.id}><input type="checkbox" checked={cmdTrigger.includes(r.id)} onChange={()=>toggleCommandRole(b, c.command, 'trigger', r.id)} /> <span style={{color:r.color}}>{r.name}</span></label>
                              ))}
                            </div>
                            <div className="mkt-cmd-roles">
                              <span className="mkt-cmd-roles-label">Blocked roles{cmdBlocked.length?` (${cmdBlocked.length})`:''}:</span>
                              <label><input type="checkbox" checked={cmdBlocked.length===0} onChange={e=>{ if(e.target.checked) toggleCommandRole(b, c.command, 'blocked', '__clear__'); }} /> none</label>
                              {serverRoles.map(r => (
                                <label key={r.id}><input type="checkbox" checked={cmdBlocked.includes(r.id)} onChange={()=>toggleCommandRole(b, c.command, 'blocked', r.id)} /> <span style={{color:r.color}}>{r.name}</span></label>
                              ))}
                            </div>
                          </div>
                          );
                        })}
                      </div>
                    </details>
                  </div>
                );
              })}
            </div>
          )}
        </section>        {builderOpen && mktServer && <BotBuilderModal me={me} boot={boot} server={mktServers.find(s=>s.id===mktServer)} editBot={editBot} currentChannelId={currentChannelId} onClose={()=>{ setBuilderOpen(false); setEditBot(null); }} notify={notify} onDone={()=>{ api(`/api/servers/${mktServer}/bots`).then(r=>setInstalled(Array.isArray(r)?r:[])); api('/api/bot-templates').then(d=>setTemplates(d.templates||[])); }} />}
        {detailBot && <BotDetailModal bot={detailBot} boot={boot} mktServer={mktServer} installedList={installed} onInstall={install} onRemove={uninstall} notify={notify} onClose={()=>setDetailBot(null)} me={me} onRefreshInstalled={()=>api(`/api/servers/${mktServer}/bots`).then(r=>setInstalled(Array.isArray(r)?r:[]))} />}      
      </div>
    </div>
  );
}

// ── Reminder menu (right-click a message) ─────────────────────────────────────
function ReminderMenu({ msg, pos, onClose, notify }) {
  const [custom, setCustom] = useState(false);
  const [dt, setDt] = useState('');
  const [saving, setSaving] = useState(false);

  async function setRemind(when) {
    setSaving(true);
    const d = await api('/api/reminders', { method:'POST', body: JSON.stringify({ messageId: msg.id, when }) });
    setSaving(false);
    if (d.error) notify(d.error, 'err');
    else notify('⏰ Reminder set!', 'ok');
    onClose();
  }

  const style = { position:'fixed', top:Math.min(pos.y, window.innerHeight-210), left:Math.min(pos.x, window.innerWidth-220), zIndex:9999 };

  return (
    <div className="menu-overlay reminder-overlay" onClick={onClose}>
      <div className="reminder-menu" style={style} onClick={e=>e.stopPropagation()}>
        <div className="reminder-menu-title">⏰ Remind me</div>
        <div className="reminder-msg-preview">{msg.body?.slice(0,60) || (msg.attachment ? '📎 '+msg.attachment_name : '')}</div>
        <button className="reminder-opt" disabled={saving} onClick={()=>setRemind('1h')}>🔔 In 1 hour</button>
        <button className="reminder-opt" disabled={saving} onClick={()=>setRemind('tomorrow')}>🌅 Tomorrow (9 AM)</button>
        <button className="reminder-opt" disabled={saving} onClick={()=>setCustom(v=>!v)}>📅 Custom…</button>
        {custom && (
          <div className="reminder-custom">
            <input type="datetime-local" value={dt} onChange={e=>setDt(e.target.value)} />
            <button className="ok-btn" disabled={!dt||saving} onClick={()=>setRemind(dt)}>Set</button>
          </div>
        )}
        <button className="ghost reminder-cancel" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

// ── Message component ─────────────────────────────────────────────────────────
function Message({ msg, prev, me, isAdmin, onReply, onReplyAnon, onThread, bookmarked, onBookmark, onViewProfile, onReact, showEmoji, onToggleEmoji, onAdminDelete, notify, onRefresh, onRemind, highlight }) {
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(msg.body);
  const [enableDone, setEnableDone] = useState(false);
  const isOwn     = msg.sender_id === me.id;
  const isOfficial= msg.tag === 'real';
  const isAnon    = Boolean(msg.anonymous_reply);
  const displayName = isAnon ? 'Anonymous' : (msg.nickname || msg.username);
  const authorColor = isAnon ? (msg.anon_name_color || 'var(--muted)') : nameColor(msg.username || '');
  const anonMask = !isAnon ? (msg.anon_active ? (EMOJIS[0]) : null) : null;
  const prevName = prev ? (prev.nickname||prev.username) : null;
  const grouped  = !!(prev && prevName === displayName && (new Date(msg.created_at) - new Date(prev.created_at)) < 5*60*1000);
  const reactions = msg._reactions || [];
  // Parse an optional @@{...}@@ action payload embedded at the start of a message body.
  let action = null, bodyText = msg.body || '';
  const am = bodyText.match(/^@@(\{.*?\})@@\s?/);
  if (am) { try { action = JSON.parse(am[1]); bodyText = bodyText.slice(am[0].length); } catch { action = null; } }

  async function saveEdit(e) {
    e.preventDefault();
    await api(`/api/messages/${msg.id}`, { method:'PATCH', body:JSON.stringify({body:editBody}) });
    setEditing(false); onRefresh?.();
  }

  async function enableBot() {
    if (!action || action.type !== 'enable_bot') return;
    const d = await api(`/api/servers/${action.communityId}/bots/${action.botId}/settings`, { method:'PATCH', body: JSON.stringify({ enabled: true }) });
    if (d.error) notify(d.error || 'Could not enable this bot', 'err');
    else { setEnableDone(true); notify(`✅ ${action.botName || 'Bot'} enabled in this server!`, 'ok'); onRefresh?.(); }
  }

  async function del() {
    if (!confirm('Delete this message?')) return;
    await api(`/api/messages/${msg.id}`, { method:'DELETE' });
    onRefresh?.();
  }

  const EMOJIS_QUICK = ['👍','❤️','😂','😭','💀'];

  return (
    <article id={`msg-${msg.id}`} className={`message${grouped?' grouped':''}${isOfficial?' official':''}${highlight?' highlighted':''}`}
      onContextMenu={e=>{ if(onRemind){ e.preventDefault(); onRemind({x:e.clientX, y:e.clientY}); } }}>
      {!grouped
        ? <Avatar src={(isAnon||msg.is_bot)?null:msg.avatar} name={displayName} official={isOfficial} badge={msg.badge}
            anonMask={isAnon?'👤':(msg.is_bot?(msg.bot_emoji||'🤖'):null)} anonColor={isAnon?'#383a40':(msg.is_bot?(msg.bot_color||'#5865f2'):null)}
            onClick={isAnon?undefined:onViewProfile} />
        : <div className="avatar-spacer" />}
      <div className="message-body">
        {!grouped && (
          <div className="message-meta">
            <span className="author" style={{color: isOfficial?'var(--ok)':authorColor}} onClick={isAnon?undefined:onViewProfile}>
              {displayName}
            </span>
            {isOfficial && <span className="pill official-pill">OFFICIAL</span>}
            {msg.is_bot && <span className="pill bot-pill">🤖 BOT</span>}
            {msg.badge==='Knowns' && <span className="pill knowns-pill">KNOWNS</span>}
            {String(msg.badge||'').includes('FTD') && <span className="pill ftd-pill">FTD</span>}
            {msg.anon_active && !isAnon && <span className="pill anon-pill" style={{color:msg.anon_name_color || nameColor(msg.anon_mask || '')}}>🎭 {maskName(msg.anon_mask)}</span>}
            <time>{timeAgo(msg.created_at)}</time>
            {msg.edited_at && <span className="edited">(edited)</span>}
          </div>
        )}
        {msg.reply_to && <div className="reply-preview">↩ Reply</div>}
        {editing ? (
          <form onSubmit={saveEdit} className="edit-form">
            <input value={editBody} onChange={e => setEditBody(e.target.value)} autoFocus />
            <button>Save</button>
            <button type="button" className="ghost" onClick={() => setEditing(false)}>Cancel</button>
          </form>
        ) : (
          msg._poll ? <PollRenderer poll={msg._poll} messageId={msg.id} me={me} />
          : <p className="msg-text"><MsgBody text={bodyText} me={me} /></p>
        )}
        {action && action.type === 'enable_bot' && !enableDone && (
          <button className="hint-enable-btn" onClick={enableBot}>✅ Enable this bot in the server</button>
        )}
        {action && action.type === 'enable_bot' && enableDone && (
          <span className="hint-enabled-note">✅ Bot enabled in this server</span>
        )}
        {msg.attachment && <Attachment url={msg.attachment} name={msg.attachment_name} mime={msg.attachment_type} />}
        {msg.pinned && <div className="pinned-label">📌 Pinned message</div>}
        {reactions.length > 0 && (
          <div className="reactions">
            {reactions.map(r => (
              <button key={r.emoji} className="reaction-pill" onClick={() => onReact(r.emoji)}>
                {r.emoji} <span>{r.count}</span>
              </button>
            ))}
          </div>
        )}
        <div className="msg-actions">
          <button onClick={onToggleEmoji} title="Emoji, GIF, or sticker">😊</button>
          <button onClick={()=>navigator.clipboard?.writeText(msg.body||'').then(()=>notify('Message copied','ok'))} title="Copy message">📋</button>
          <button onClick={()=>navigator.clipboard?.writeText(`${location.origin}/?message=${msg.id}`).then(()=>notify('Message link copied','ok'))} title="Copy message link">🔗</button>
          <button onClick={onReply} title="Reply">↩</button>
          {onThread && <button onClick={onThread} title="Thread">🧵</button>}
          <button onClick={onBookmark} title={bookmarked?'Remove bookmark':'Bookmark'} className={bookmarked?'bm-on':''}>🔖</button>
          {onRemind && <button onClick={e=>onRemind({x:e.clientX, y:e.clientY})} title="Remind me">⏰</button>}
          {!isAnon && <button onClick={onReplyAnon} title="Reply anonymously" className="ghost">👤↩</button>}
          {isOwn && !editing && <button onClick={() => setEditing(true)} title="Edit">✏</button>}
          {isOwn && <button onClick={del} className="del-btn" title="Delete">🗑</button>}
          {isAdmin && !isOwn && <button onClick={onAdminDelete} className="mod-del-btn" title="Admin delete">⛔</button>}
          <button onClick={() => {
            const cat = prompt('Report reason:\n1. Harassment\n2. Personal info\n3. Spam\n4. Threats\n5. Illegal content\n6. Other\n\nEnter number or type reason:');
            if (cat) api('/api/reports',{method:'POST',body:JSON.stringify({targetType:'message',targetId:msg.id,reason:cat,category:['harassment','personal_info','spam','threats','illegal','other'][parseInt(cat)-1]||cat})}).then(()=>notify('Report submitted.'));
          }} title="Report">🚩</button>
        </div>
        {showEmoji && <EmojiPicker onPick={emoji => { onReact(emoji); onToggleEmoji(); }} />}
      </div>
    </article>
  );
}

// ── Slash commands ────────────────────────────────────────────────────────────
// Shared command catalog — powers /help, the autocomplete dropdown, and the
// suggested-command chips so everything stays in sync.
const SLASH_COMMANDS = [
  { cmd:'help',    args:'',       desc:'Show all commands',                    mod:false, dm:true },
  { cmd:'nick',    args:'<name>', desc:'Set your server nickname',             mod:false },
  { cmd:'topic',   args:'<text>', desc:'Set the channel topic',                mod:true },
  { cmd:'slowmode',args:'<secs>', desc:'Set slow mode (0–3600s)',              mod:true },
  { cmd:'clear',   args:'[n]',    desc:'Delete recent messages (max 50)',      mod:true },
  { cmd:'invite',  args:'',       desc:'Copy the server invite',               mod:false },
  { cmd:'about',   args:'',       desc:'Show server info',                     mod:false },
  { cmd:'me',      args:'<status>',desc:'Set your custom status',              mod:false, dm:true },
  { cmd:'whois',   args:'<user>', desc:'Show member info',                     mod:false },  { cmd:'pin',     args:'',         desc:'Pin the message you replied to',                    mod:false },
  { cmd:'unpin',   args:'',         desc:'Unpin the message you replied to',                  mod:false },
  { cmd:'thread',  args:'',         desc:'Open a thread for the message you replied to',      mod:false },
  { cmd:'reminders', args:'',        desc:'List your pending chat reminders',                   mod:false },
  { cmd:'trivia',  args:'',         desc:'Start a bot trivia question',                        mod:false },
  { cmd:'answer',  args:'<text>',   desc:'Answer the bot trivia question',                     mod:false },
  { cmd:'ttt',     args:'[user]',   desc:'Tic-tac-toe (vs the bot or @user)',                 mod:false },
  { cmd:'move',    args:'<1-9>',    desc:'Play a tic-tac-toe move',                            mod:false },
  { cmd:'score',   args:'',         desc:'Show bot game scores',                               mod:false },
  { cmd:'dmnick',  args:'<name>', desc:'Set a nickname for this DM',           mod:false, dm:true },
];
const SUGGESTED_CHANNEL = ['help','invite','about','me','topic','slowmode','nick'];
const SUGGESTED_DM = ['help','dmnick','me'];

// Discord-style slash commands wired to existing APIs. Returns true when handled.
async function handleSlashCommand(raw, ctx) {
  const m = String(raw||'').trim().match(/^\/(\w+)(?:\s+([\s\S]*))?$/);
  if (!m) return false;
  const cmd = m[1].toLowerCase();
  const args = (m[2]||'').trim();
  const { me, channel, comm, dm, socket, notify, boot, loadMessages, replyTo, openThread } = ctx;
  const membership = comm ? (boot?.memberships||[]).find(x=>x.community_id===comm.id) : null;
  const isMod = me?.is_admin || (membership && ['owner','admin'].includes(membership.role));
  const HELP = SLASH_COMMANDS.map(c => `/${c.cmd}${c.args?` ${c.args}`:''} — ${c.desc}${c.mod?' (mods)':''}`).join('\n');
  try {
    switch (cmd) {
      case 'help': notify('📜 Commands:\n'+HELP, 'ok'); return true;
      case 'nick':
        if (!args || !comm) return notify('Usage: /nick <name>','err');
        await api(`/api/communities/${comm.id}/members/${me.id}`,{method:'PATCH',body:JSON.stringify({nickname:args.slice(0,40)})});
        notify(`Server nickname set to "${args}"`,'ok'); socket?.emit('user_update'); return true;
      case 'topic':
        if (!channel || !isMod) return notify('Moderators only','err');
        await api(`/api/channels/${channel.id}`,{method:'PATCH',body:JSON.stringify({topic:args.slice(0,140)})});
        notify('Channel topic updated','ok'); loadMessages?.(); return true;
      case 'slowmode':
        if (!channel || !isMod) return notify('Moderators only','err');
        const secs = Math.max(0,Math.min(3600,parseInt(args)||0));
        await api(`/api/channels/${channel.id}`,{method:'PATCH',body:JSON.stringify({slowmode:secs})});
        notify(`Slow mode set to ${secs}s`,'ok'); loadMessages?.(); return true;
      case 'clear':
        if (!channel || !isMod) return notify('Moderators only','err');
        if (!comm) return notify('Not in a server','err');
        const n = Math.min(Math.max(1,parseInt(args)||10),50);
        const msgs = await api(`/api/channels/${channel.id}/messages?limit=${n}`);
        for (const msg of (Array.isArray(msgs)?msgs:[])) {
          await api(`/api/communities/${comm.id}/messages/${msg.id}`,{method:'DELETE'}).catch(()=>{});
        }
        notify(`Cleared ${(Array.isArray(msgs)?msgs:[]).length} messages`,'ok'); loadMessages?.(); return true;
      case 'invite':
        if (!comm) return notify('Not in a server','err');
        const d = await api(`/api/communities/${comm.id}/invite`);
        if (d.inviteCode) { navigator.clipboard?.writeText(d.inviteCode).catch(()=>{}); notify(`Invite copied: ${d.inviteCode}`,'ok'); }
        return true;
      case 'about':
        if (!comm) return notify('Not in a server','err');
        const chCount = (boot?.channels||[]).filter(c=>c.community_id===comm.id).length;
        notify(`${comm.name} — ${comm.description||'No description'} · ${chCount} channels · ${comm.visibility||'public'}`,'ok');
        return true;
      case 'me':
        if (!args) return notify('Usage: /me <status>','err');
        await api('/api/profile',{method:'PATCH',body:JSON.stringify({custom_status:args.slice(0,80)})});
        notify('Custom status updated','ok'); return true;
      case 'whois':
        if (!args) return notify('Usage: /whois <username>','err');
        const u = (boot?.users||[]).find(x=>x.username.toLowerCase()===args.toLowerCase());
        if (u) notify(`${u.nickname||u.username}#${u.tag} — ${u.status||'Online'}${u.custom_status?' · '+u.custom_status:''}${u.rank?' · '+u.rank:''}`,'ok');
        else notify('User not found','err');
        return true;
      case 'pin':
        if (!replyTo) return notify('Reply to a message first, then /pin','err');
        await api(`/api/messages/${replyTo.id}/pin`,{method:'POST',body:JSON.stringify({pinned:true})});
        notify('Message pinned','ok'); loadMessages?.(); return true;
      case 'unpin':
        if (!replyTo) return notify('Reply to a message first, then /unpin','err');
        await api(`/api/messages/${replyTo.id}/pin`,{method:'POST',body:JSON.stringify({pinned:false})});
        notify('Message unpinned','ok'); loadMessages?.(); return true;
      case 'dmnick':
        if (!dm) return notify('Use /dmnick only in a DM','err');
        if (!args) return notify('Usage: /dmnick <name>','err');
        await api(`/api/dms/${dm.id}/nickname`,{method:'PATCH',body:JSON.stringify({nickname:args.slice(0,40)})});
        notify('DM nickname set','ok'); return true;
      case 'thread':
        if (!replyTo) return notify('Reply to a message first, then /thread','err');
        if (!openThread) return notify('Threads work in channels, DMs, and group chats','err');
        openThread(replyTo); return true;
      case 'reminders': {
        const list = await api('/api/reminders');
        if (list.error || !Array.isArray(list) || !list.length) return notify('⏰ No reminders set. Right-click a message → Remind me!','ok');
        const txt = list.map(r => `• ${new Date(r.remind_at).toLocaleString()} — "${r.preview}"`).join('\n');
        notify(`⏰ Your reminders:\n${txt}`,'ok'); return true;
      }
      case 'trivia': case 'answer': case 'ttt': case 'move': case 'score': {
        if (!channel) return notify('Bot games are for channels','err');
        const inv = await api('/api/bots/invoke', { method:'POST', body: JSON.stringify({ channelId: channel.id, text: raw }) });
        if (inv && !inv.handled) notify('No bot in this server has that command — install one from the Bot Marketplace!','err');
        return true;
      }
      default: notify(`Unknown command: /${cmd}. Try /help`,'err'); return true;
    }
  } catch { notify('Command failed','err'); return true; }
}

// ── Channel Chat ──────────────────────────────────────────────────────────────
function ChannelChat({ me, channel, comm, socket, notify, onViewProfile, boot, onPollCreate, jumpToMessageId, onJumpDone }) {
  const [messages, setMessages]   = useState([]);
  const [highlightId, setHighlightId] = useState(null);
  const [body, setBody]           = useState('');
  const [replyTo, setReplyTo]     = useState(null);
  const [anonReply, setAnonReply] = useState(false);
  const [typing, setTyping]       = useState([]);
  const [uploading, setUploading] = useState(false);
  const [emojiFor, setEmojiFor]   = useState(null);
  const [hasMore, setHasMore]     = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [slowLeft, setSlowLeft]   = useState(0);
  const [piiWarn, setPiiWarn]     = useState(null);
  const [pendingBody, setPendingBody] = useState('');
  const [rainbow, setRainbow]     = useState(false);
  const [showPoll, setShowPoll]   = useState(false);
  const [pollQ, setPollQ]         = useState('');
  const [pollOpts, setPollOpts]   = useState(['','']);
  const [showComposerEmoji, setShowComposerEmoji] = useState(false);
  const [mentionQuery, setMentionQuery] = useState(null);
  const [cmdQuery, setCmdQuery] = useState(null);
  const [composerFocused, setComposerFocused] = useState(false);
  const [showDown, setShowDown]   = useState(false);
  const [reminder, setReminder]   = useState(null);
  const [threadId, setThreadId]     = useState(null);
  const [threadRoot, setThreadRoot] = useState(null);
  const [threadMsgs, setThreadMsgs] = useState([]);
  const [threadBody, setThreadBody] = useState('');
  const [threadLoading, setThreadLoading] = useState(false);
  const [showThreads, setShowThreads] = useState(false);
  const [threadList, setThreadList] = useState([]);
  const { ids: bmIds } = useBookmarks();
  const isMod = me.is_admin || (boot?.memberships||[]).some(m=>m.community_id===comm?.id && (m.role==='owner'||m.role==='admin'));
  const bottomRef = useRef(null);
  const fileRef   = useRef(null);
  const logoClicks = useRef(0);
  const logoTimer  = useRef(null);
  const threadIdRef = useRef(null);
  useEffect(() => { threadIdRef.current = threadId; }, [threadId]);

  // Easter egg: !konami
  useEffect(() => {
    if (body === '!konami') {
      setRainbow(true);
      setTimeout(() => setRainbow(false), 3000);
    }
  }, [body]);

  useEffect(() => {
    socket.emit('join', channel.id);
    loadMessages();

    const onMsg    = m => { if (m.channel_id === channel.id) { setMessages(x => [...x, m]); setTimeout(() => bottomRef.current?.scrollIntoView({behavior:'smooth'}), 50); } };
    const onEdit   = m => { setMessages(x => x.map(msg => msg.id === m.id ? m : msg)); setThreadMsgs(x => x.map(t => t.id === m.id ? m : t)); };
    const onDel    = ({ id }) => { setMessages(x => x.filter(m => m.id !== id)); setThreadMsgs(x => x.filter(t => t.id !== id)); };
    const onThreadMsg = m => {
      if (threadIdRef.current && m.thread_id === threadIdRef.current) setThreadMsgs(x => x.some(t=>t.id===m.id) ? x : [...x, m]);
      // Keep the threads sidebar live (reply count + last activity)
      if (m.channel_id === channel.id) refreshThreadList();
    };
    const onTyping = d => { if (d.channelId===channel.id && d.userId!==me.id) { setTyping(t=>[...new Set([...t,d.username])]); setTimeout(()=>setTyping(t=>t.filter(n=>n!==d.username)),3000); } };
    const onReact  = ({messageId,reactions}) => setMessages(x => x.map(m => m.id===messageId?{...m,_reactions:reactions}:m));
    const onPoll   = ({pollId,votes}) => setMessages(x => x.map(m => m._poll?.id===pollId?{...m,_poll:{...m._poll,votes}}:m));
    const onRaid   = () => notify('⚠ Possible raid detected. Slow mode enabled.', 'err');

    socket.on('message',        onMsg);
    socket.on('message_edit',   onEdit);
    socket.on('message_delete', onDel);
    socket.on('typing',         onTyping);
    socket.on('reaction_update',onReact);
    socket.on('poll_update',    onPoll);
    socket.on('raid_alert',     onRaid);
    socket.on('thread_message', onThreadMsg);

    return () => {
      socket.off('message',        onMsg);
      socket.off('message_edit',   onEdit);
      socket.off('message_delete', onDel);
      socket.off('typing',         onTyping);
      socket.off('reaction_update',onReact);
      socket.off('poll_update',    onPoll);
      socket.off('raid_alert',     onRaid);      socket.off('thread_message', onThreadMsg);
    };
  }, [channel.id]);

  // Jump to a specific message (e.g. from a bookmark) -> load a window around it,
  // scroll it into view, and flash a highlight. Resolves in a couple of frames so
  // the DOM has rendered before we scroll.
  async function jumpToMessage(targetId) {
    if (!targetId) return;
    const msgs = await api(`/api/channels/${channel.id}/messages?around=${encodeURIComponent(targetId)}`).catch(() => null);
    setMessages(Array.isArray(msgs) ? msgs : []);
    setHasMore(false);
    setHighlightId(targetId);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.getElementById(`msg-${targetId}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => onJumpDone?.(), 60);
      });
    });
  }

  useEffect(() => {
    if (jumpToMessageId) jumpToMessage(jumpToMessageId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpToMessageId, channel.id]);

  async function loadMessages() {
    const msgs = await api(`/api/channels/${channel.id}/messages`);
    setMessages(Array.isArray(msgs) ? msgs : []);
    setHasMore((msgs?.length||0) >= 100);
    setTimeout(() => bottomRef.current?.scrollIntoView(), 80);
  }

  async function loadMore() {
    if (!messages.length || loadingMore || !hasMore) return;
    setLoadingMore(true);
    const more = await api(`/api/channels/${channel.id}/messages?before=${encodeURIComponent(messages[0].created_at)}`);
    if (Array.isArray(more)) { setMessages(x => [...more, ...x]); setHasMore(more.length >= 100); }
    setLoadingMore(false);
  }

  // Slowmode countdown
  useEffect(() => {
    if (!channel.slowmode) return;
    const t = setInterval(() => setSlowLeft(s => s > 0 ? s - 1 : 0), 1000);
    return () => clearInterval(t);
  }, [channel.slowmode]);

  async function doSend(bodyToSend) {
    if (!bodyToSend.trim()) return;
    if (channel.slowmode && slowLeft > 0) { notify(`Slow mode: wait ${slowLeft}s`); return; }
    const d = await api('/api/messages', { method:'POST', body: JSON.stringify({
      channelId: channel.id, body: bodyToSend,
      replyTo: replyTo?.id || null,
      anonymousReply: anonReply
    })});
    if (d.piiWarning) { setPiiWarn(d.piiWarning); setPendingBody(bodyToSend); return; }
    if (channel.slowmode) setSlowLeft(channel.slowmode);
    setBody(''); setReplyTo(null); setAnonReply(false); setMentionQuery(null); setCmdQuery(null);
  }

  async function send(e) {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) return;
    // Slash commands
    const handled = await handleSlashCommand(trimmed, { me, channel, comm, socket, notify, boot, loadMessages, replyTo, openThread });
    if (handled) { setBody(''); setReplyTo(null); setAnonReply(false); setMentionQuery(null); return; }
    // Easter egg: !question
    if (trimmed === '!question') {
      const dq = await api('/api/daily-question');
      if (dq.question) {
        await api('/api/messages', { method:'POST', body:JSON.stringify({channelId:channel.id, body:`💬 Daily Question: ${dq.question}`}) });
        setBody('');
      }
      return;
    }
    await doSend(body);
  }

  async function uploadFile(file) {
    setUploading(true);
    const fd = new FormData(); fd.append('file', file);
    const d = await fetch('/api/upload', { method:'POST', headers:{Authorization:`Bearer ${getToken()}`}, body:fd }).then(r=>r.json());
    if (d.url) await api('/api/messages', { method:'POST', body: JSON.stringify({ channelId:channel.id, body:'', attachment:d.url, attachmentName:d.name, attachmentType:d.type }) });
    setUploading(false);
  }

  async function adminDel(id) {
    if (!confirm('Permanently delete this message?')) return;
    if (comm) {
      const d = await api(`/api/communities/${comm.id}/messages/${id}`, { method:'DELETE' });
      if (!d.error) return;
    }
    await api(`/api/admin/messages/${id}`, { method:'DELETE' });
  }

  async function submitPoll(e) {
    e.preventDefault();
    const opts = pollOpts.filter(o => o.trim());
    if (!pollQ || opts.length < 2) return notify('Need a question and at least 2 options');
    await api('/api/polls', { method:'POST', body:JSON.stringify({question:pollQ,options:opts,channelId:channel.id}) });
    setShowPoll(false); setPollQ(''); setPollOpts(['','']);
  }

  async function refreshThreadList() {
    const d = await api(`/api/channels/${channel.id}/threads`).catch(()=>null);
    if (d && !d.error) setThreadList(d);
  }
  useEffect(() => { if (showThreads) refreshThreadList(); }, [showThreads, channel.id]);

  async function openThread(msg) {
    setThreadRoot(msg); setThreadMsgs([]); setThreadBody(''); setThreadLoading(true);
    const d = await api(`/api/messages/${msg.id}/thread`, { method:'POST' });
    if (d && d.thread) {
      setThreadId(d.thread.id);
      const t = await api(`/api/threads/${d.thread.id}`);
      setThreadMsgs((t && t.messages) || []);
    }
    setThreadLoading(false);
    refreshThreadList();
  }
  function closeThread() { setThreadId(null); setThreadRoot(null); setThreadMsgs([]); setThreadBody(''); setThreadLoading(false); }
  async function sendThread(e) {
    e.preventDefault();
    if (!threadBody.trim() || !threadId) return;
    const d = await api(`/api/threads/${threadId}/messages`, { method:'POST', body: JSON.stringify({ body: threadBody }) });
    if (d && !d.error) { setThreadMsgs(x => x.some(t=>t.id===d.id) ? x : [...x, d]); setThreadBody(''); }
  }

  const dtag = channel.discovery_tag;
  const dtagEmoji = {asleep:'🌙',awake:'☀️',gaming:'🎮',chill:'🌊',unknown:'❓'}[dtag] || '';

  return (
    <div className={`chat-inner${rainbow?' rainbow-bg':''}`} onDrop={e=>{e.preventDefault();const f=e.dataTransfer?.files?.[0];if(f)uploadFile(f);}} onDragOver={e=>e.preventDefault()}>
      {comm?.banner && COSMETIC_BANNERS[comm.banner] && (
        <div className="server-cosmetic-banner" style={{background:COSMETIC_BANNERS[comm.banner]}}>
          <span>{comm.name}</span>
        </div>
      )}
      <div className="chat-header">
        <div className="channel-title">
          <span className="ch-icon-header">#</span>
          <h2>{channel.name} {dtagEmoji && <span className="dtag">{dtagEmoji}</span>}</h2>
          {channel.topic && <span className="channel-topic">{channel.topic}</span>}
        </div>
        <div style={{display:'flex',gap:4}}>
          <button className="icon-btn" onClick={() => setShowPoll(v=>!v)} title="Create poll">📊</button>
          <button className={`icon-btn${showThreads?' active':''}`} onClick={() => setShowThreads(v=>!v)} title="Threads">🧵</button>
        </div>
      </div>

      {showThreads && (
        <div className="threads-sidebar">
          <div className="threads-sidebar-hdr">
            <span>🧵 Threads</span>
            <button className="icon-btn" title="Close" onClick={()=>setShowThreads(false)}>✕</button>
          </div>
          <div className="threads-sidebar-list">
            {threadList.length === 0 && <p className="muted-text threads-empty">No threads yet. Hit 🧵 on a message to start one.</p>}
            {threadList.map(t => {
              const root = t.root;
              return (
                <button key={t.id} className={`threads-sidebar-item${threadId===t.id?' active':''}`} onClick={()=>openThread(root)}>
                  <div className="threads-item-preview">
                    <Avatar src={root.avatar} name={root.nickname||root.username} size="xs" badge={root.badge} />
                    <div style={{minWidth:0}}>
                      <span className="threads-item-author">{root.nickname||root.username}</span>
                      <p>{root.body?.slice(0,90) || (root.attachment ? '📎 '+root.attachment_name : '')}</p>
                    </div>
                  </div>
                  <div className="threads-item-meta">
                    <span className="threads-item-count" title="Replies">💬 {t.reply_count}</span>
                    <span className="threads-item-time" title="Last activity">{timeAgo(t.last_activity)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {comm?.locked && <div className="lockdown-banner">🔒 This server is in lockdown mode. Messaging is disabled.</div>}

      {showPoll && (
        <form className="poll-creator" onSubmit={submitPoll}>
          <input placeholder="Poll question…" value={pollQ} onChange={e=>setPollQ(e.target.value)} />
          {pollOpts.map((o,i) => (
            <input key={i} placeholder={`Option ${i+1}`} value={o} onChange={e=>{ const a=[...pollOpts]; a[i]=e.target.value; setPollOpts(a); }} />
          ))}
          {pollOpts.length < 4 && <button type="button" className="ghost" onClick={() => setPollOpts(p=>[...p,''])}>+ Add option</button>}
          <div style={{display:'flex',gap:6}}><button>Create poll</button><button type="button" className="ghost" onClick={()=>setShowPoll(false)}>Cancel</button></div>
        </form>
      )}

      <div className="messages" onScroll={e=>{ setShowDown(e.target.scrollHeight - e.target.scrollTop - e.target.clientHeight > 150); if(e.target.scrollTop<80&&hasMore) loadMore(); }}>
        {loadingMore && <div className="load-more-spinner"><div className="spinner sm" /></div>}
        {messages.map((m,i) => (
          <Message key={m.id} msg={m} prev={messages[i-1]} me={me} isAdmin={me.is_admin}
            highlight={highlightId === m.id}
            onReply={() => setReplyTo(m)}
            onReplyAnon={() => { setReplyTo(m); setAnonReply(true); }}
            onThread={() => openThread(m)}
            bookmarked={bmIds.has(m.id)}
            onBookmark={() => toggleBookmark(m)}
            onRemind={pos => setReminder({ msg:m, ...pos })}
            onViewProfile={() => onViewProfile(boot?.users?.find(u=>u.id===m.sender_id)||{id:m.sender_id,username:m.username,tag:m.tag,avatar:m.avatar,nickname:m.nickname,badge:m.badge})}
            onReact={emoji => api(`/api/messages/${m.id}/reactions`,{method:'POST',body:JSON.stringify({emoji})})}
            showEmoji={emojiFor===m.id}
            onToggleEmoji={() => setEmojiFor(emojiFor===m.id?null:m.id)}
            onAdminDelete={() => adminDel(m.id)}
            onRefresh={loadMessages}
            notify={notify}
          />
        ))}
        {typing.length > 0 && (
          <div className="typing-indicator">
            <span className="typing-dots"><span/><span/><span/></span>
            {typing.join(', ')} {typing.length===1?'is':'are'} typing…
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      {showDown && <button className="scroll-latest-btn visible" title="Jump to latest" onClick={()=>{ bottomRef.current?.scrollIntoView({behavior:'smooth'}); setShowDown(false); }}>↓</button>}

      {threadRoot && (
        <div className="thread-panel">
          <div className="thread-hdr">
            <div className="thread-root">
              <Avatar src={threadRoot.avatar} name={threadRoot.nickname||threadRoot.username} size="xs" badge={threadRoot.badge} />
              <div style={{minWidth:0}}>
                <b>{threadRoot.nickname||threadRoot.username}</b>
                <p>{threadRoot.body?.slice(0,80) || (threadRoot.attachment ? '📎 '+threadRoot.attachment_name : '')}</p>
              </div>
            </div>
            <button className="icon-btn" title="Close thread" onClick={closeThread}>✕</button>
          </div>
          <div className="thread-msgs">
            {threadLoading && <p className="muted-text">Loading…</p>}
            {!threadLoading && threadMsgs.length === 0 && <p className="muted-text">No replies yet — start the conversation!</p>}
            {threadMsgs.map(m => (
              <div key={m.id} className="thread-msg">
                <Avatar src={m.avatar} name={m.nickname||m.username} size="xs" badge={m.badge} />
                <div style={{minWidth:0}}>
                  <span className="thread-msg-author">{m.nickname||m.username}</span>
                  <p>{m.body}</p>
                </div>
              </div>
            ))}
          </div>
          <form className="thread-composer" onSubmit={sendThread}>
            <input placeholder={`Reply in #${channel.name}…`} value={threadBody} onChange={e=>setThreadBody(e.target.value)} autoFocus />
            <button disabled={!threadBody.trim()}>Send</button>
          </form>
        </div>
      )}

      {reminder && <ReminderMenu msg={reminder.msg} pos={reminder} onClose={()=>setReminder(null)} notify={notify} />}

      {replyTo && (
        <div className="reply-bar">
          <span>Replying to <b>{replyTo.nickname||replyTo.username}</b>{anonReply?' (anonymously)':''}: {replyTo.body?.slice(0,60)}</span>
          <button onClick={() => { setReplyTo(null); setAnonReply(false); }}>✕</button>
        </div>
      )}

      {piiWarn && (
        <PiiWarning warning={piiWarn}
          onSend={async () => {
            setPiiWarn(null);
            await api('/api/messages', { method:'POST', body:JSON.stringify({channelId:channel.id,body:pendingBody,replyTo:replyTo?.id||null,anonymousReply:anonReply}) });
            setBody(''); setReplyTo(null); setAnonReply(false); setPendingBody('');
          }}
          onRewrite={() => { setPiiWarn(null); setBody(pendingBody); setPendingBody(''); }}
        />
      )}

      <form className="composer" onSubmit={send}>
        {composerFocused && !body.trim() && (
          <div className="suggest-chips">
            {SUGGESTED_CHANNEL.map(s=>{ const c=SLASH_COMMANDS.find(x=>x.cmd===s); if(c?.mod && !isMod) return null; return (
              <button key={s} type="button" onMouseDown={e=>{e.preventDefault(); setBody('/'+s+' '); setCmdQuery(null);}} title={`/${s}${c?.args?` ${c.args}`:''} — ${c?.desc||''}`}>/{s}</button>
            );})}
          </div>
        )}
        {cmdQuery !== null && SLASH_COMMANDS.filter(c=>!c.mod || isMod).filter(c=>c.cmd.startsWith(cmdQuery)).length > 0 && (
          <div className="command-suggest">
            {SLASH_COMMANDS.filter(c=>!c.mod || isMod).filter(c=>c.cmd.startsWith(cmdQuery)).map(c=>(
              <button key={c.cmd} type="button" onMouseDown={e=>{e.preventDefault(); const idx=body.lastIndexOf('/'); setBody(body.slice(0,idx)+'/'+c.cmd+' '); setCmdQuery(null);}}>
                <b>/{c.cmd}</b>{c.args&&<span className="cmd-arg">{c.args}</span>}
                <small>{c.desc}{c.mod?' · mods':''}</small>
              </button>
            ))}
          </div>
        )}
        {mentionQuery !== null && (boot?.users||[]).filter(u=>u.id!==me.id && (u.username||'').toLowerCase().startsWith(mentionQuery.toLowerCase())).slice(0,6).length > 0 && (
          <div className="mention-suggest">
            {(boot?.users||[]).filter(u=>u.id!==me.id && (u.username||'').toLowerCase().startsWith(mentionQuery.toLowerCase())).slice(0,6).map(u=>(
              <button key={u.id} type="button" onClick={()=>{ const idx=body.lastIndexOf('@'); setBody(body.slice(0,idx)+'@'+u.username+' '); setMentionQuery(null); }}>
                <Avatar src={u.avatar} name={u.nickname||u.username} size="xs" badge={u.badge} />
                <span>{u.nickname||u.username}</span>
                <small style={{color:'var(--muted)'}}>@{u.username}</small>
              </button>
            ))}
          </div>
        )}
        {showComposerEmoji && <div className="composer-emoji"><EmojiPicker onPick={em=>{ setBody(b=>b+em); setShowComposerEmoji(false); }} /></div>}
        <button type="button" className="composer-attach" onClick={() => fileRef.current?.click()} title="Attach">📎</button>
        <input type="file" ref={fileRef} style={{display:'none'}} onChange={e=>{ if(e.target.files[0]) uploadFile(e.target.files[0]); }} />
        <button type="button" className="composer-attach" onClick={() => setShowComposerEmoji(v=>!v)} title="Emoji picker">😊</button>
        <input
          value={body}
          onChange={e => { const val=e.target.value; setBody(val); socket.emit('typing',{channelId:channel.id,userId:me.id,username:me.nickname||me.username}); const m=val.match(/(?:^|\s)@([\w-]*)$/); setMentionQuery(m?m[1]:null); const cm=val.match(/(?:^|\s)\/([\w]*)$/); setCmdQuery(cm?cm[1]:null); }}
          onFocus={()=>setComposerFocused(true)}
          onBlur={()=>setTimeout(()=>setComposerFocused(false),120)}
          placeholder={uploading?'Uploading…':comm?.locked?'Server is locked':channel.slowmode&&slowLeft>0?`Slow mode — wait ${slowLeft}s…`:`Message #${channel.name}`}
          disabled={uploading || Boolean(comm?.locked)}
        />
        <button type="submit" className="send-btn" disabled={!body.trim()||Boolean(comm?.locked)}>Send</button>
      </form>
    </div>
  );
}

// ── DM Chat ───────────────────────────────────────────────────────────────────
function DmChat({ me, dm, socket, notify, onViewProfile, onCall, jumpToMessageId, onJumpDone }) {
  const [messages, setMessages] = useState([]);
  const [highlightId, setHighlightId] = useState(null);
  const { ids: bmIds } = useBookmarks();
  const [body, setBody]         = useState('');
  const [replyTo, setReplyTo]   = useState(null);
  const [typing, setTyping]     = useState([]);
  const [uploading, setUploading] = useState(false);
  const [showComposerEmoji, setShowComposerEmoji] = useState(false);
  const [cmdQuery, setCmdQuery] = useState(null);
  const [composerFocused, setComposerFocused] = useState(false);
  const [emojiFor, setEmojiFor] = useState(null);
  const [showNick, setShowNick] = useState(false);
  const [nick, setNick]         = useState('');
  const [piiWarn, setPiiWarn]   = useState(null);
  const [pendingBody, setPendingBody] = useState('');
  const [threadId, setThreadId]     = useState(null);
  const [threadRoot, setThreadRoot] = useState(null);
  const [threadMsgs, setThreadMsgs] = useState([]);
  const [threadBody, setThreadBody] = useState('');
  const [threadLoading, setThreadLoading] = useState(false);
  const [reminder, setReminder]   = useState(null);
  const bottomRef = useRef(null);
  const fileRef   = useRef(null);
  const threadIdRef = useRef(null);
  useEffect(() => { threadIdRef.current = threadId; }, [threadId]);

  const isA  = dm.user_a === me.id;
  const other = { id: isA?dm.user_b:dm.user_a, name: isA?(dm.nickname_a||dm.user_b_nick||dm.user_b_name):(dm.nickname_b||dm.user_a_nick||dm.user_a_name), avatar: isA?dm.user_b_avatar:dm.user_a_avatar, badge: isA?dm.user_b_badge:dm.user_a_badge };

  useEffect(() => {
    socket.emit('join_dm', dm.id);
    api(`/api/dms/${dm.id}/messages`).then(msgs => { setMessages(Array.isArray(msgs)?msgs:[]); setTimeout(()=>bottomRef.current?.scrollIntoView(),60); });

    const onMsg    = m => { if(m.dm_id===dm.id){ setMessages(x=>[...x,m]); setTimeout(()=>bottomRef.current?.scrollIntoView({behavior:'smooth'}),50); } };
    const onEdit   = m => setMessages(x => x.map(msg => msg.id===m.id?m:msg));
    const onDel    = ({id}) => setMessages(x => x.filter(m=>m.id!==id));
    const onTyping = d => { if(d.dmId===dm.id&&d.userId!==me.id){ setTyping(t=>[...new Set([...t,d.username])]); setTimeout(()=>setTyping(t=>t.filter(n=>n!==d.username)),3000); } };
    const onReact  = ({messageId,reactions}) => setMessages(x=>x.map(m=>m.id===messageId?{...m,_reactions:reactions}:m));
    const onThreadMsg = m => { if (threadIdRef.current && m.thread_id === threadIdRef.current) setThreadMsgs(x => x.some(t=>t.id===m.id) ? x : [...x, m]); };

    socket.on('dm_message',     onMsg);
    socket.on('message_edit',   onEdit);
    socket.on('message_delete', onDel);
    socket.on('typing',         onTyping);
    socket.on('reaction_update',onReact);
    socket.on('thread_message', onThreadMsg);
    return () => {
      socket.off('dm_message',     onMsg);
      socket.off('message_edit',   onEdit);
      socket.off('message_delete', onDel);
      socket.off('typing',         onTyping);
      socket.off('reaction_update',onReact);
      socket.off('thread_message', onThreadMsg);
    };
  }, [dm.id]);

  async function send(e) {
    e.preventDefault();
    if (!body.trim()) return;
    const handled = await handleSlashCommand(body, { me, dm, socket, notify, boot:null, replyTo, openThread });
    if (handled) { setBody(''); setReplyTo(null); setCmdQuery(null); return; }
    const d = await api('/api/messages', { method:'POST', body:JSON.stringify({dmId:dm.id,body,replyTo:replyTo?.id||null}) });
    if (d.piiWarning) { setPiiWarn(d.piiWarning); setPendingBody(body); return; }
    setBody(''); setReplyTo(null); setCmdQuery(null);
  }

  async function openThread(msg) {
    setThreadRoot(msg); setThreadMsgs([]); setThreadBody(''); setThreadLoading(true);
    const d = await api(`/api/messages/${msg.id}/thread`, { method:'POST' });
    if (d && d.thread) {
      setThreadId(d.thread.id);
      const t = await api(`/api/threads/${d.thread.id}`);
      setThreadMsgs((t && t.messages) || []);
    }
    setThreadLoading(false);
  }
  function closeThread() { setThreadId(null); setThreadRoot(null); setThreadMsgs([]); setThreadBody(''); setThreadLoading(false); }
  async function sendThread(e) {
    e.preventDefault();
    if (!threadBody.trim() || !threadId) return;
    const d = await api(`/api/threads/${threadId}/messages`, { method:'POST', body: JSON.stringify({ body: threadBody }) });
    if (d && !d.error) { setThreadMsgs(x => x.some(t=>t.id===d.id) ? x : [...x, d]); setThreadBody(''); }
  }

  async function uploadFile(file) {
    setUploading(true);
    const fd = new FormData(); fd.append('file',file);
    const d = await fetch('/api/upload',{method:'POST',headers:{Authorization:`Bearer ${getToken()}`},body:fd}).then(r=>r.json());
    if (d.url) await api('/api/messages',{method:'POST',body:JSON.stringify({dmId:dm.id,body:'',attachment:d.url,attachmentName:d.name,attachmentType:d.type})});
    setUploading(false);
  }

  async function saveNick(e) {
    e.preventDefault();
    await api(`/api/dms/${dm.id}/nickname`,{method:'PATCH',body:JSON.stringify({nickname:nick})});
    notify('Nickname saved','ok'); setShowNick(false);
  }

  const [showDown, setShowDown] = useState(false);
  const reload = () => api(`/api/dms/${dm.id}/messages`).then(msgs=>setMessages(Array.isArray(msgs)?msgs:[]));

  // Jump to a specific message (e.g. a bookmarked one in a DM) + flash highlight.
  async function jumpToMessage(targetId) {
    if (!targetId) return;
    const msgs = await api(`/api/dms/${dm.id}/messages?around=${encodeURIComponent(targetId)}`).catch(() => null);
    setMessages(Array.isArray(msgs) ? msgs : []);
    setHighlightId(targetId);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.getElementById(`msg-${targetId}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => onJumpDone?.(), 60);
      });
    });
  }

  useEffect(() => {
    if (jumpToMessageId) jumpToMessage(jumpToMessageId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpToMessageId, dm.id]);

  return (
    <div className="chat-inner">
      <div className="chat-header">
        <div className="channel-title">
          <Avatar src={other.avatar} name={other.name} size="sm" badge={other.badge} onClick={()=>onViewProfile({id:other.id,username:other.name,avatar:other.avatar,badge:other.badge})} />
          <h2>{other.name}</h2>
        </div>
        <div style={{display:'flex',gap:4}}>
          <button className="icon-btn" title="Call" onClick={()=>onCall(other)}>📞</button>
          <button className="icon-btn" title="Nickname" onClick={()=>setShowNick(v=>!v)}>✏️</button>
          <button className="icon-btn" title="Report" onClick={()=>api('/api/reports',{method:'POST',body:JSON.stringify({targetType:'dm',targetId:dm.id,reason:'DM report',category:'other'})}).then(()=>notify('Report submitted.'))}>🚩</button>
          <button className="icon-btn" title="Block user" onClick={async()=>{ if(!confirm(`Block ${other.name}? You won't see their messages.`)) return; await api('/api/blocks',{method:'POST',body:JSON.stringify({userId:other.id})}); notify(`${other.name} blocked`,'ok'); }}>🚫</button>
        </div>
      </div>

      {showNick && (
        <form className="nickname-bar" onSubmit={saveNick}>
          <input placeholder="Set nickname for this DM" value={nick} onChange={e=>setNick(e.target.value)} />
          <button>Save</button>
          <button type="button" className="ghost" onClick={()=>setShowNick(false)}>Cancel</button>
        </form>
      )}

      <div className="messages" onScroll={e=>{ setShowDown(e.target.scrollHeight - e.target.scrollTop - e.target.clientHeight > 150); }}>
        {messages.map((m,i) => (
          <Message key={m.id} msg={m} prev={messages[i-1]} me={me} isAdmin={me.is_admin}
            onReply={() => setReplyTo(m)}
            onReplyAnon={() => setReplyTo(m)}
            onThread={() => openThread(m)}
            bookmarked={bmIds.has(m.id)}
            onBookmark={() => toggleBookmark(m)}
            onRemind={pos => setReminder({ msg:m, ...pos })}
            onViewProfile={() => onViewProfile({id:m.sender_id,username:m.username,tag:m.tag,avatar:m.avatar,nickname:m.nickname,badge:m.badge})}
            onReact={emoji=>api(`/api/messages/${m.id}/reactions`,{method:'POST',body:JSON.stringify({emoji})})}
            showEmoji={emojiFor===m.id}
            onToggleEmoji={()=>setEmojiFor(emojiFor===m.id?null:m.id)}
            onAdminDelete={() => api(`/api/admin/messages/${m.id}`,{method:'DELETE'}).then(reload)}
            onRefresh={reload}
            notify={notify}
            highlight={highlightId === m.id}
          />
        ))}
        {typing.length>0 && <div className="typing-indicator"><span className="typing-dots"><span/><span/><span/></span> {typing.join(', ')} is typing…</div>}
        <div ref={bottomRef} />
      </div>
      {showDown && <button className="scroll-latest-btn visible" title="Jump to latest" onClick={()=>{ bottomRef.current?.scrollIntoView({behavior:'smooth'}); setShowDown(false); }}>↓</button>}

      {threadRoot && (
        <div className="thread-panel">
          <div className="thread-hdr">
            <div className="thread-root">
              <Avatar src={threadRoot.avatar} name={threadRoot.nickname||threadRoot.username} size="xs" badge={threadRoot.badge} />
              <div style={{minWidth:0}}>
                <b>{threadRoot.nickname||threadRoot.username}</b>
                <p>{threadRoot.body?.slice(0,80) || (threadRoot.attachment ? '📎 '+threadRoot.attachment_name : '')}</p>
              </div>
            </div>
            <button className="icon-btn" title="Close thread" onClick={closeThread}>✕</button>
          </div>
          <div className="thread-msgs">
            {threadLoading && <p className="muted-text">Loading…</p>}
            {!threadLoading && threadMsgs.length === 0 && <p className="muted-text">No replies yet — start the conversation!</p>}
            {threadMsgs.map(m => (
              <div key={m.id} className="thread-msg">
                <Avatar src={m.avatar} name={m.nickname||m.username} size="xs" badge={m.badge} />
                <div style={{minWidth:0}}>
                  <span className="thread-msg-author">{m.nickname||m.username}</span>
                  <p>{m.body}</p>
                </div>
              </div>
            ))}
          </div>
          <form className="thread-composer" onSubmit={sendThread}>
            <input placeholder={`Reply in thread…`} value={threadBody} onChange={e=>setThreadBody(e.target.value)} autoFocus />
            <button disabled={!threadBody.trim()}>Send</button>
          </form>
        </div>
      )}

      {reminder && <ReminderMenu msg={reminder.msg} pos={reminder} onClose={()=>setReminder(null)} notify={notify} />}

      {replyTo && <div className="reply-bar"><span>Replying to <b>{replyTo.nickname||replyTo.username}</b>: {replyTo.body?.slice(0,60)}</span><button onClick={()=>setReplyTo(null)}>✕</button></div>}

      {piiWarn && (
        <PiiWarning warning={piiWarn}
          onSend={async()=>{ setPiiWarn(null); await api('/api/messages',{method:'POST',body:JSON.stringify({dmId:dm.id,body:pendingBody,replyTo:replyTo?.id||null})}); setBody(''); setReplyTo(null); setPendingBody(''); }}
          onRewrite={()=>{ setPiiWarn(null); setBody(pendingBody); setPendingBody(''); }}
        />
      )}

      <form className="composer" onSubmit={send}>
        {composerFocused && !body.trim() && (
          <div className="suggest-chips">
            {SUGGESTED_DM.map(s=>{ const c=SLASH_COMMANDS.find(x=>x.cmd===s); return (
              <button key={s} type="button" onMouseDown={e=>{e.preventDefault(); setBody('/'+s+' '); setCmdQuery(null);}} title={`/${s}${c?.args?` ${c.args}`:''} — ${c?.desc||''}`}>/{s}</button>
            );})}
          </div>
        )}
        {cmdQuery !== null && SLASH_COMMANDS.filter(c=>c.dm).filter(c=>c.cmd.startsWith(cmdQuery)).length > 0 && (
          <div className="command-suggest">
            {SLASH_COMMANDS.filter(c=>c.dm).filter(c=>c.cmd.startsWith(cmdQuery)).map(c=>(
              <button key={c.cmd} type="button" onMouseDown={e=>{e.preventDefault(); const idx=body.lastIndexOf('/'); setBody(body.slice(0,idx)+'/'+c.cmd+' '); setCmdQuery(null);}}>
                <b>/{c.cmd}</b>{c.args&&<span className="cmd-arg">{c.args}</span>}
                <small>{c.desc}</small>
              </button>
            ))}
          </div>
        )}
        {showComposerEmoji && <div className="composer-emoji"><EmojiPicker onPick={em=>{ setBody(b=>b+em); setShowComposerEmoji(false); }} /></div>}
        <button type="button" className="composer-attach" onClick={()=>fileRef.current?.click()}>📎</button>
        <input type="file" ref={fileRef} style={{display:'none'}} onChange={e=>{if(e.target.files[0])uploadFile(e.target.files[0]);}} />
        <button type="button" className="composer-attach" onClick={()=>setShowComposerEmoji(v=>!v)} title="Emoji picker">😊</button>
        <input value={body} onChange={e=>{setBody(e.target.value); socket.emit('typing',{dmId:dm.id,userId:me.id,username:me.nickname||me.username}); const cm=e.target.value.match(/(?:^|\s)\/([\w]*)$/); setCmdQuery(cm?cm[1]:null);}} onFocus={()=>setComposerFocused(true)} onBlur={()=>setTimeout(()=>setComposerFocused(false),120)} placeholder={`Message ${other.name}`} disabled={uploading} />
        <button type="submit" className="send-btn" disabled={!body.trim()&&!uploading}>Send</button>
      </form>
    </div>
  );
}

// ── Group Chat ────────────────────────────────────────────────────────────────
function GroupChat({ me, group, socket, notify, onViewProfile, jumpToMessageId, onJumpDone }) {
  const [messages, setMessages] = useState([]);
  const [highlightId, setHighlightId] = useState(null);
  const { ids: bmIds } = useBookmarks();
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [showComposerEmoji, setShowComposerEmoji] = useState(false);
  const [threadId, setThreadId]     = useState(null);
  const [threadRoot, setThreadRoot] = useState(null);
  const [threadMsgs, setThreadMsgs] = useState([]);
  const [threadBody, setThreadBody] = useState('');
  const [threadLoading, setThreadLoading] = useState(false);
  const [reminder, setReminder]   = useState(null);
  const bottomRef = useRef(null);
  const fileRef   = useRef(null);
  const threadIdRef = useRef(null);
  useEffect(() => { threadIdRef.current = threadId; }, [threadId]);

  useEffect(() => {
    socket.emit('join_group', group.id);
    api(`/api/groups/${group.id}/messages`).then(msgs => { setMessages(Array.isArray(msgs)?msgs:[]); setTimeout(()=>bottomRef.current?.scrollIntoView(),60); });
    const onMsg  = m => { if(m.group_id===group.id){ setMessages(x=>[...x,m]); setTimeout(()=>bottomRef.current?.scrollIntoView({behavior:'smooth'}),50); } };
    const onEdit = m => setMessages(x=>x.map(msg=>msg.id===m.id?m:msg));
    const onDel  = ({id}) => setMessages(x=>x.filter(m=>m.id!==id));
    const onThreadMsg = m => { if (threadIdRef.current && m.thread_id === threadIdRef.current) setThreadMsgs(x => x.some(t=>t.id===m.id) ? x : [...x, m]); };
    socket.on('group_message',  onMsg);
    socket.on('message_edit',   onEdit);
    socket.on('message_delete', onDel);
    socket.on('thread_message', onThreadMsg);
    return () => { socket.off('group_message',onMsg); socket.off('message_edit',onEdit); socket.off('message_delete',onDel); socket.off('thread_message', onThreadMsg); };
  }, [group.id]);

  async function send(e) {
    e.preventDefault();
    if (!body.trim()) return;
    const handled = await handleSlashCommand(body, { me, group, socket, notify, boot:null, replyTo, openThread });
    if (handled) { setBody(''); setReplyTo(null); return; }
    await api('/api/messages',{method:'POST',body:JSON.stringify({groupId:group.id,body,replyTo:replyTo?.id||null})});
    setBody(''); setReplyTo(null);
  }

  async function openThread(msg) {
    setThreadRoot(msg); setThreadMsgs([]); setThreadBody(''); setThreadLoading(true);
    const d = await api(`/api/messages/${msg.id}/thread`, { method:'POST' });
    if (d && d.thread) {
      setThreadId(d.thread.id);
      const t = await api(`/api/threads/${d.thread.id}`);
      setThreadMsgs((t && t.messages) || []);
    }
    setThreadLoading(false);
  }
  function closeThread() { setThreadId(null); setThreadRoot(null); setThreadMsgs([]); setThreadBody(''); setThreadLoading(false); }
  async function sendThread(e) {
    e.preventDefault();
    if (!threadBody.trim() || !threadId) return;
    const d = await api(`/api/threads/${threadId}/messages`, { method:'POST', body: JSON.stringify({ body: threadBody }) });
    if (d && !d.error) { setThreadMsgs(x => x.some(t=>t.id===d.id) ? x : [...x, d]); setThreadBody(''); }
  }

  async function uploadFile(file) {
    setUploading(true);
    const fd = new FormData(); fd.append('file',file);
    const d = await fetch('/api/upload',{method:'POST',headers:{Authorization:`Bearer ${getToken()}`},body:fd}).then(r=>r.json());
    if (d.url) await api('/api/messages',{method:'POST',body:JSON.stringify({groupId:group.id,body:'',attachment:d.url,attachmentName:d.name,attachmentType:d.type})});
    setUploading(false);
  }

  const reload = () => api(`/api/groups/${group.id}/messages`).then(msgs=>setMessages(Array.isArray(msgs)?msgs:[]));

  // Jump to a specific message (e.g. a bookmarked one in a group chat) + flash highlight.
  async function jumpToMessage(targetId) {
    if (!targetId) return;
    const msgs = await api(`/api/groups/${group.id}/messages?around=${encodeURIComponent(targetId)}`).catch(() => null);
    setMessages(Array.isArray(msgs) ? msgs : []);
    setHighlightId(targetId);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.getElementById(`msg-${targetId}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => onJumpDone?.(), 60);
      });
    });
  }

  useEffect(() => {
    if (jumpToMessageId) jumpToMessage(jumpToMessageId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpToMessageId, group.id]);

  return (
    <div className="chat-inner">
      <div className="chat-header">
        <div className="channel-title">
          <span>👥</span>
          <h2>{group.name}</h2>
        </div>
      </div>
      <div className="messages">
        {messages.map((m,i) => (
          <Message key={m.id} msg={m} prev={messages[i-1]} me={me} isAdmin={me.is_admin}
            onReply={() => setReplyTo(m)}
            onReplyAnon={() => setReplyTo(m)}
            onThread={() => openThread(m)}
            bookmarked={bmIds.has(m.id)}
            onBookmark={() => toggleBookmark(m)}
            onRemind={pos => setReminder({ msg:m, ...pos })}
            onViewProfile={()=>onViewProfile({id:m.sender_id,username:m.username,tag:m.tag,avatar:m.avatar,nickname:m.nickname,badge:m.badge})}
            onReact={emoji=>api(`/api/messages/${m.id}/reactions`,{method:'POST',body:JSON.stringify({emoji})})}
            showEmoji={false} onToggleEmoji={()=>{}}
            onAdminDelete={()=>api(`/api/admin/messages/${m.id}`,{method:'DELETE'}).then(reload)}
            onRefresh={reload} notify={notify}
            highlight={highlightId === m.id}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      {threadRoot && (
        <div className="thread-panel">
          <div className="thread-hdr">
            <div className="thread-root">
              <Avatar src={threadRoot.avatar} name={threadRoot.nickname||threadRoot.username} size="xs" badge={threadRoot.badge} />
              <div style={{minWidth:0}}>
                <b>{threadRoot.nickname||threadRoot.username}</b>
                <p>{threadRoot.body?.slice(0,80) || (threadRoot.attachment ? '📎 '+threadRoot.attachment_name : '')}</p>
              </div>
            </div>
            <button className="icon-btn" title="Close thread" onClick={closeThread}>✕</button>
          </div>
          <div className="thread-msgs">
            {threadLoading && <p className="muted-text">Loading…</p>}
            {!threadLoading && threadMsgs.length === 0 && <p className="muted-text">No replies yet — start the conversation!</p>}
            {threadMsgs.map(m => (
              <div key={m.id} className="thread-msg">
                <Avatar src={m.avatar} name={m.nickname||m.username} size="xs" badge={m.badge} />
                <div style={{minWidth:0}}>
                  <span className="thread-msg-author">{m.nickname||m.username}</span>
                  <p>{m.body}</p>
                </div>
              </div>
            ))}
          </div>
          <form className="thread-composer" onSubmit={sendThread}>
            <input placeholder={`Reply in thread…`} value={threadBody} onChange={e=>setThreadBody(e.target.value)} autoFocus />
            <button disabled={!threadBody.trim()}>Send</button>
          </form>
        </div>
      )}

      {reminder && <ReminderMenu msg={reminder.msg} pos={reminder} onClose={()=>setReminder(null)} notify={notify} />}

      {replyTo && <div className="reply-bar"><span>Replying to <b>{replyTo.nickname||replyTo.username}</b>: {replyTo.body?.slice(0,60)}</span><button onClick={()=>setReplyTo(null)}>✕</button></div>}

      <form className="composer" onSubmit={send}>
        {showComposerEmoji && <div className="composer-emoji"><EmojiPicker onPick={em=>{ setBody(b=>b+em); setShowComposerEmoji(false); }} /></div>}
        <button type="button" className="composer-attach" onClick={()=>fileRef.current?.click()}>📎</button>
        <input type="file" ref={fileRef} style={{display:'none'}} onChange={e=>{if(e.target.files[0])uploadFile(e.target.files[0]);}} />
        <button type="button" className="composer-attach" onClick={()=>setShowComposerEmoji(v=>!v)} title="Emoji picker">😊</button>
        <input value={body} onChange={e=>setBody(e.target.value)} placeholder={`Message ${group.name}`} disabled={uploading} />
        <button type="submit" className="send-btn" disabled={!body.trim()}>Send</button>
      </form>
    </div>
  );
}

// ── Voice Channel ─────────────────────────────────────────────────────────────
function VoiceChannel({ channel, me, socket }) {
  const [inCall, setInCall] = useState(false);
  const [muted, setMuted]   = useState(false);
  const [sharing, setSharing] = useState(false);
  // Roster rows carry profile + a `live` flag (real audio flowing) per peer.
  const [roster, setRoster] = useState([]);
  const [streamTick, setStreamTick] = useState(0);
  const meshRef = useRef(null);
  const streamRef = useRef(null);
  const screenRef = useRef(null);
  const audioRefs = useRef({});

  // One mesh per channel mount; it stays silent until join() is called.
  useEffect(() => {
    const mesh = createVoiceMesh({
      socket, channelId: channel.id, me,
      onRoster: setRoster,
      onRemoteStream: () => setStreamTick(t => t + 1),
      onRemoteEnd: () => setStreamTick(t => t + 1),
    });
    meshRef.current = mesh;
    return () => { mesh.destroy(); meshRef.current = null; };
  }, [socket, channel.id, me?.id]);

  // Attach remote audio when a stream arrives and route it to the chosen
  // speaker from Settings → Voice & Video.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const speaker = loadMediaPrefs().speaker;
    roster.forEach(u => {
      const el = audioRefs.current[u.userId];
      const s = mesh.streamFor(u.userId);
      if (el) {
        if (s && el.srcObject !== s) el.srcObject = s;
        applySpeakerSink(el, speaker);
      }
    });
  }, [roster, streamTick, inCall]);

  async function joinCall() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints('mic'));
      streamRef.current = stream;
      meshRef.current?.join(stream);
      setInCall(true);
    } catch { alert('Could not access microphone.'); }
  }

  function leaveCall() {
    streamRef.current?.getTracks().forEach(t=>t.stop());
    screenRef.current?.getTracks().forEach(t=>t.stop());
    meshRef.current?.leave();
    audioRefs.current = {};
    setInCall(false); setMuted(false); setSharing(false);
  }

  async function toggleScreen() {
    if (sharing) {
      screenRef.current?.getTracks().forEach(t=>t.stop());
      socket.emit('screen_share_stop',{channelId:channel.id,userId:me.id});
      setSharing(false);
    } else {
      try {
        screenRef.current = await navigator.mediaDevices.getDisplayMedia({video:true});
        socket.emit('screen_share_start',{channelId:channel.id,userId:me.id});
        setSharing(true);
        screenRef.current.getTracks()[0].onended = () => { setSharing(false); socket.emit('screen_share_stop',{channelId:channel.id,userId:me.id}); };
      } catch {}
    }
  }

  function toggleMute() {
    streamRef.current?.getAudioTracks().forEach(t=>{t.enabled=muted;});
    setMuted(m=>!m);
  }

  const displayName = u => u?.nickname || u?.username || 'Unknown';

  return (
    <div className="voice-channel">
      <div className="chat-header">
        <div className="channel-title"><span>🔊</span><h2>{channel.name}</h2></div>
      </div>
      <div className="voice-grid">
        {inCall ? (
          <>
            <div className={`voice-tile self${muted?' muted':''}`}>
              <Avatar src={me?.avatar} name={displayName(me)} size="lg" badge={me?.badge} />
              <span>{displayName(me)}</span>
              <span className="voice-live-dot" title="You're connected" />
              {muted && <span className="mute-badge">🔇</span>}
            </div>
            {roster.map(u => {
              const hasMedia = Boolean(meshRef.current?.streamFor(u.userId));
              return (
                <div key={u.userId} className={`voice-tile${hasMedia?' live':' connecting'}`}>
                  <Avatar src={u.avatar} name={displayName(u)} size="lg" badge={u.badge} />
                  <span>{displayName(u)}</span>
                  <audio ref={el => { audioRefs.current[u.userId] = el; }} autoPlay playsInline style={{display:'none'}} />
                  {hasMedia
                    ? <span className="voice-live-dot" title="Audio live" />
                    : <span className="voice-connecting">connecting…</span>}
                </div>
              );
            })}
            {roster.length === 0 && <p className="voice-empty-note">No one else here yet — share the channel to bring friends in.</p>}
          </>
        ) : <div className="voice-idle"><p>🔊 {channel.name}</p><p className="muted-text">Talk live with everyone in this channel</p></div>}
      </div>
      <div className="voice-controls">
        {!inCall ? (
          <button className="voice-join-btn" onClick={joinCall}>Join Voice</button>
        ) : (
          <>
            <button className={`voice-ctrl-btn${muted?' active':''}`} onClick={toggleMute}>{muted?'🔇 Unmute':'🎤 Mute'}</button>
            <button className={`voice-ctrl-btn${sharing?' active':''}`} onClick={toggleScreen}>{sharing?'🖥 Stop Share':'🖥 Share Screen'}</button>
            <button className="voice-ctrl-btn leave" onClick={leaveCall}>Leave</button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Temporary Rooms ───────────────────────────────────────────────────────────
const ROOM_META = {
  chat:    { icon:'💬', label:'Chat' },
  voice:   { icon:'🎙️', label:'Voice' },
  video:   { icon:'🎥', label:'Video' },
  game:    { icon:'🎮', label:'Game' },
  drawing: { icon:'🎨', label:'Drawing' },
  poll:    { icon:'📋', label:'Poll' },
  watch:   { icon:'📺', label:'Watch' },
  collab:  { icon:'📝', label:'Collab' },
};

function CreateRoomModal({ communityId, onClose, onCreated, notify }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('chat');
  const [duration, setDuration] = useState('30min');
  const [customMin, setCustomMin] = useState('');
  const [waiting, setWaiting] = useState(false);
  const [ptt, setPtt] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    const dur = duration === 'custom' ? (customMin ? `${parseInt(customMin)||1}m` : '30min') : duration;
    const d = await api('/api/rooms', { method:'POST', body: JSON.stringify({ communityId, name:name.trim(), type, expiresIn:dur, waitingRoom:waiting, ptt }) });
    if (d.error) notify(d.error, 'err');
    else { notify(`Room "${d.room?.name}" created!`, 'ok'); onCreated?.(d.room); onClose(); }
  }

  return (
    <div className="menu-overlay" onClick={onClose}>
      <div className="menu-modal room-create-modal" onClick={e=>e.stopPropagation()}>
        <div className="menu-modal-header"><h2>🗂 Create a room</h2><button className="icon-btn" onClick={onClose}>✕</button></div>
        <form onSubmit={submit} className="mini">
          <label>Room name<input value={name} onChange={e=>setName(e.target.value)} placeholder="movie-night" autoFocus /></label>
          <label>Type
            <select value={type} onChange={e=>setType(e.target.value)}>
              {Object.entries(ROOM_META).map(([k,v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
            </select>
          </label>
          <label>Lifetime
            <select value={duration} onChange={e=>setDuration(e.target.value)}>
              <option value="5min">5 minutes</option>
              <option value="30min">30 minutes</option>
              <option value="hour">1 hour</option>
              <option value="day">1 day</option>
              <option value="custom">Custom…</option>
            </select>
          </label>
          {duration==='custom' && <label>Minutes<input type="number" min="1" max="1440" value={customMin} onChange={e=>setCustomMin(e.target.value)} placeholder="90" /></label>}
          <label className="check-row"><input type="checkbox" checked={waiting} onChange={e=>setWaiting(e.target.checked)} /> Waiting room (owner admits people)</label>
          {(type==='voice'||type==='video') && <label className="check-row"><input type="checkbox" checked={ptt} onChange={e=>setPtt(e.target.checked)} /> Push-to-talk</label>}
          <div style={{display:'flex',gap:4}}><button>Create room</button><button type="button" className="ghost" onClick={onClose}>Cancel</button></div>
        </form>
      </div>
    </div>
  );
}

function RoomView({ roomId, me, socket, notify, onLaunchGame }) {
  const [room, setRoom] = useState(null);
  const [messages, setMessages] = useState([]);
  const [msg, setMsg] = useState('');
  const [inCall, setInCall] = useState(false);
  const [muted, setMuted] = useState(false);
  const [pttDown, setPttDown] = useState(false);
  const [polls, setPolls] = useState([]);
  const [pollQ, setPollQ] = useState('');
  const [pollOpts, setPollOpts] = useState(['','']);
  const [watchUrl, setWatchUrl] = useState('');
  const [collab, setCollab] = useState('');
  const [collabSync, setCollabSync] = useState('');
  const [left, setLeft] = useState(0);
  const [joined, setJoined] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const streamRef = useRef(null);
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const lastPt = useRef(null);
  const collabTimer = useRef(null);
  const collabFocused = useRef(false);
  const videoRef = useRef(null);
  const [raises, setRaises] = useState([]);
  const [voiceRoster, setVoiceRoster] = useState([]);   // peers actually live in voice (mesh)
  const [streamTick, setStreamTick] = useState(0);
  const [cameraOn, setCameraOn] = useState(true);       // local camera state (video rooms)
  const meshRef = useRef(null);
  const remoteRefs = useRef({});

  const meta = ROOM_META[room?.type] || ROOM_META.chat;

  // Load room + join the socket room
  useEffect(() => {
    let alive = true;
    api(`/api/rooms/${roomId}`).then(d => { if (alive && !d.error) { setRoom(d); setCollab(d.collab_text||''); setCollabSync(d.collab_text||''); } }).catch(()=>{});
    socket.emit('room_join', roomId);
    return () => { alive = false; socket.emit('room_leave', { roomId, userId: me?.id }); };
  }, [roomId]);

  // Live socket events for this room
  useEffect(() => {
    if (!socket) return;
    const onMsg = m => { if (m.room_id===roomId) setMessages(x=>[...x.filter(y=>y.id!==m.id), m]); };
    const onPresence = () => { api(`/api/rooms/${roomId}`).then(d => { if (!d.error) setRoom(d); }).catch(()=>{}); };
    const onPoll = p => { if (p.room_id===roomId) setPolls(x=>[...x.filter(y=>y.id!==p.id), p]); };
    const onPollVotes = ({pollId, votes}) => setPolls(x=>x.map(p=>p.id===pollId?{...p, votes}:p));
    const onDraw = d => { if (d.roomId===roomId && canvasRef.current) drawStroke(canvasRef.current, d); };
    const onWatch = d => { if (d.roomId!==roomId) return; if (d.url) setWatchUrl(d.url); if (videoRef.current && d.time!=null) { try { videoRef.current.currentTime = d.time; } catch {} } };
    const onCollab = d => { if (d.roomId===roomId && !collabFocused.current) { setCollab(d.text||''); setCollabSync(d.text||''); } };
    const onRaise = d => { if (d.roomId===roomId && d.userId!==me?.id) setRaises(r=>[...new Set([...r, d.userId])]); };
    const onAdmitted = d => { if (d.roomId===roomId) { setWaiting(false); setJoined(true); notify(`Admitted to ${d.roomName||'the room'}!`,'ok'); } };
    socket.on('room_message', onMsg);
    socket.on('room_presence', onPresence);
    socket.on('room_poll', onPoll);
    socket.on('room_poll_votes', onPollVotes);
    socket.on('room_draw', onDraw);
    socket.on('room_watch', onWatch);
    socket.on('room_collab', onCollab);
    socket.on('room_raise', onRaise);
    socket.on('room_admitted', onAdmitted);
    return () => {
      socket.off('room_message', onMsg); socket.off('room_presence', onPresence); socket.off('room_poll', onPoll);
      socket.off('room_poll_votes', onPollVotes); socket.off('room_draw', onDraw); socket.off('room_watch', onWatch);
      socket.off('room_collab', onCollab); socket.off('room_raise', onRaise); socket.off('room_admitted', onAdmitted);
    };
  }, [socket, roomId, me?.id]);

  // Countdown
  useEffect(() => {
    if (!room?.expires_at) return;
    const t = setInterval(() => setLeft(Math.max(0, new Date(room.expires_at).getTime() - Date.now())), 1000);
    setLeft(Math.max(0, new Date(room.expires_at).getTime() - Date.now()));
    return () => clearInterval(t);
  }, [room?.expires_at]);

  useEffect(() => {
    if (room?.type !== 'chat') return;
    api(`/api/rooms/${roomId}/messages`).then(d => { if (!d.error) setMessages(d); }).catch(()=>{});
    socket.emit('room_join', roomId);
  }, [roomId, room?.type]);

  useEffect(() => {
    if (room?.type !== 'poll') return;
    api(`/api/rooms/${roomId}/polls`).then(d => { if (!d.error) setPolls(d); }).catch(()=>{});
  }, [roomId, room?.type]);

  // Voice/video rooms run a real WebRTC mesh over the room's socket room.
  useEffect(() => {
    if (room?.type !== 'voice' && room?.type !== 'video') return undefined;
    const mesh = createVoiceMesh({
      socket, channelId: roomId, me,
      onRoster: setVoiceRoster,
      onRemoteStream: () => setStreamTick(t => t + 1),
      onRemoteEnd: () => setStreamTick(t => t + 1),
    });
    meshRef.current = mesh;
    return () => { mesh.destroy(); meshRef.current = null; };
  }, [roomId, room?.type, me?.id]);

  // Attach remote audio/video as streams arrive; honor the saved speaker.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh || !inCall) return;
    const speaker = loadMediaPrefs().speaker;
    voiceRoster.forEach(u => {
      const el = remoteRefs.current[u.userId];
      const s = mesh.streamFor(u.userId);
      if (!el) return;
      if (s && el.srcObject !== s) el.srcObject = s;
      applySpeakerSink(el, speaker);
    });
  }, [voiceRoster, streamTick, inCall, room?.type]);

  async function joinRoom() {
    const d = await api(`/api/rooms/${roomId}/join`, { method:'POST' });
    if (d.error) { notify(d.error, 'err'); return; }
    if (d.waiting) { setWaiting(true); notify('You are in the waiting room — the owner will admit you','warn'); }
    else { setJoined(true); }
    if (room?.type==='chat') api(`/api/rooms/${roomId}/messages`).then(x=>{ if(!x.error) setMessages(x); }).catch(()=>{});
  }

  function leaveRoom() {
    api(`/api/rooms/${roomId}/leave`, { method:'POST' }).catch(()=>{});
    streamRef.current?.getTracks().forEach(t=>t.stop());
    meshRef.current?.leave();
    setJoined(false); setInCall(false); setWaiting(false); setMessages([]);
  }

  async function admitUser(uid) {
    await api(`/api/rooms/${roomId}/admit`, { method:'POST', body: JSON.stringify({ userId:uid }) });
  }

  async function sendMsg(e) {
    e.preventDefault();
    if (!msg.trim()) return;
    const d = await api(`/api/rooms/${roomId}/messages`, { method:'POST', body: JSON.stringify({ body:msg }) });
    if (!d.error) setMsg('');
  }

  async function createPoll(e) {
    e.preventDefault();
    const opts = pollOpts.map(o=>o.trim()).filter(Boolean);
    if (!pollQ.trim() || opts.length < 2) return;
    const d = await api(`/api/rooms/${roomId}/polls`, { method:'POST', body: JSON.stringify({ question:pollQ, options:opts }) });
    if (!d.error) { setPollQ(''); setPollOpts(['','']); }
  }

  async function votePoll(pollId, idx) {
    await api(`/api/rooms/${roomId}/polls/${pollId}/vote`, { method:'POST', body: JSON.stringify({ optionIndex:idx }) });
  }

  // ── Voice/video: real peer media via the mesh ──
  async function joinVoice() {
    try {
      const wantsVideo = room?.type==='video';
      const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints(wantsVideo ? 'mic+camera' : 'mic'));
      streamRef.current = stream;
      setCameraOn(true);
      meshRef.current?.join(stream);
      setInCall(true);
    } catch { notify('Could not access ' + (room?.type==='video'?'camera':'microphone'), 'err'); }
  }

  function leaveVoice() {
    streamRef.current?.getTracks().forEach(t=>t.stop());
    meshRef.current?.leave();
    remoteRefs.current = {};
    setInCall(false); setMuted(false); setPttDown(false); setCameraOn(true);
  }

  // Turn the local camera off/on: the mesh disables the video track (peers
  // stop receiving video) and broadcasts the state so everyone swaps the
  // frozen frame for a “camera off” tile. Mic audio keeps flowing.
  function toggleCamera() {
    const next = !cameraOn;
    meshRef.current?.setCamera(next);
    setCameraOn(next);
  }

  function toggleMute() {
    streamRef.current?.getAudioTracks().forEach(t=>{ t.enabled = muted; });
    setMuted(m=>!m);
  }

  function pttDownFn() { if (!room?.ptt) return; streamRef.current?.getAudioTracks().forEach(t=>{ t.enabled = true; }); setPttDown(true); }
  function pttUpFn()   { if (!room?.ptt) return; streamRef.current?.getAudioTracks().forEach(t=>{ t.enabled = muted ? false : false; t.enabled = false; }); setPttDown(false); }

  // ── Drawing ──
  function canvasDown(e) {
    const c = canvasRef.current; if (!c) return;
    const r = c.getBoundingClientRect();
    drawingRef.current = true;
    lastPt.current = { x: e.clientX-r.left, y: e.clientY-r.top };
  }
  function canvasMove(e) {
    if (!drawingRef.current || !canvasRef.current) return;
    const c = canvasRef.current, r = c.getBoundingClientRect();
    const pt = { x: e.clientX-r.left, y: e.clientY-r.top };
    const d = { roomId, x1:lastPt.current.x, y1:lastPt.current.y, x2:pt.x, y2:pt.y, color:'#fff', size:3 };
    drawStroke(c, d);
    socket.emit('room_draw', d);
    lastPt.current = pt;
  }
  function canvasUp() { drawingRef.current = false; lastPt.current = null; }

  // ── Collab ──
  function onCollabChange(v) {
    setCollab(v);
    clearTimeout(collabTimer.current);
    collabTimer.current = setTimeout(() => {
      socket.emit('room_collab', { roomId, text:v });
      api(`/api/rooms/${roomId}/collab`, { method:'PUT', body: JSON.stringify({ text:v }) }).catch(()=>{});
    }, 600);
  }

  // ── Watch ──
  function setWatch(v) {
    setWatchUrl(v);
    socket.emit('room_watch', { roomId, url:v, time: videoRef.current?.currentTime || 0 });
  }

  if (!room) return <div className="room-view"><div className="empty-text">Loading room…</div></div>;

  const countdown = left ? `${Math.floor(left/60000)}:${String(Math.floor(left%60000/1000)).padStart(2,'0')}` : '—';
  const admitted = room.members?.filter(m=>!m.waiting) || [];
  const waitingList = room.waiting?.length ? room.waiting : (room.members||[]).filter(m=>m.waiting);
  const canAdmit = room.is_owner;

  return (
    <div className="room-view">
      <div className="room-header">
        <div className="room-title"><span className="room-icon">{meta.icon}</span><h2>{room.name}</h2>
          <span className="room-type-chip">{meta.label}</span>
          {room.expires_at && <span className="room-timer" title="Time left">⏱ {countdown}</span>}
        </div>
        <div className="room-actions">
          {room.is_owner && <button className="icon-btn" title="Delete room" onClick={async()=>{ if(confirm(`Delete room "${room.name}"?`)){ await api(`/api/rooms/${roomId}`,{method:'DELETE'}); notify('Room deleted','ok'); } }}>🗑</button>}
          <button className="icon-btn" title="Leave room" onClick={leaveRoom}>✕</button>
        </div>
      </div>

      <div className="room-members-bar">
        <span className="room-members-label">👥 {admitted.length} in room</span>
        {admitted.map(m => <span key={m.user_id} className="room-member-chip"><Avatar src={m.avatar} name={m.nickname||m.username} size="xs" badge={m.badge} />{m.nickname||m.username}</span>)}
        {canAdmit && waitingList.length>0 && <button className="room-waiting-toggle" onClick={e=>{ e.currentTarget.parentElement.querySelector('.room-waiting-box')?.classList.toggle('open'); }}>🕐 {waitingList.length} waiting</button>}
      </div>

      {canAdmit && waitingList.length>0 && (
        <div className="room-waiting-box">
          {waitingList.map(w => (
            <div key={w.user_id} className="room-waiting-row">
              <Avatar src={w.avatar} name={w.nickname||w.username} size="xs" badge={w.badge} />
              <span>{w.nickname||w.username}</span>
              <button className="ok-btn" onClick={()=>admitUser(w.user_id)}>✓ Admit</button>
            </div>
          ))}
        </div>
      )}

      {waiting && !admitted.some(m=>m.user_id===me?.id) && (
        <div className="room-waiting-screen">
          <div className="room-waiting-msg"><span className="room-icon">🕐</span><h3>Waiting for the host to admit you</h3><p>You're in the waiting room of {room.name}. The owner will let you in shortly.</p></div>
        </div>
      )}

      {!waiting && room.type==='chat' && (
        <div className="room-chat">
          <div className="room-msg-list">
            {messages.map(m => (
              <div key={m.id} className="room-msg">
                <Avatar src={m.avatar} name={m.nickname||m.username} size="xs" badge={m.badge} />
                <div><b>{m.nickname||m.username}</b> <span className="room-msg-body">{m.body}</span></div>
              </div>
            ))}
            {messages.length===0 && <p className="empty-text">No messages yet — say hi!</p>}
          </div>
          <form className="room-composer" onSubmit={sendMsg}>
            <input value={msg} onChange={e=>setMsg(e.target.value)} placeholder="Message the room…" />
            <button>Send</button>
          </form>
        </div>
      )}

      {!waiting && (room.type==='voice'||room.type==='video') && (
        <div className="room-voice">
          <div className="room-voice-body">
            {inCall ? (
              <>
                <div className="room-self-tile">
                  {room.type==='video' && cameraOn
                    ? <video ref={el=>{ if(el) el.srcObject = streamRef.current; }} autoPlay muted playsInline style={{width:'100%',borderRadius:10,aspectRatio:'16/9',background:'#000'}} />
                    : <>
                        <Avatar src={me?.avatar} name={me?.nickname||me?.username} size="lg" badge={me?.badge} />
                        {room.type==='video' && !cameraOn && <span className="cam-off-label">📷 camera off</span>}
                      </>}
                  <span>{me?.nickname||me?.username} {muted && '🔇'}</span>
                </div>
                {voiceRoster.map(u => {
                  const hasMedia = Boolean(meshRef.current?.streamFor(u.userId));
                  const peerCamOn = u.camera !== false;
                  return room.type==='video' ? (
                    <div key={u.userId} className={`room-peer-tile${hasMedia?' live':' connecting'}${peerCamOn?'':' cam-off'}`}>
                      {/* The video element stays mounted even when the peer's camera
                          is off — it quietly carries their audio while hidden. */}
                      <video ref={el => { remoteRefs.current[u.userId] = el; }} className={peerCamOn?'':'room-cam-off-video'} autoPlay playsInline style={{width:'100%',borderRadius:10,aspectRatio:'16/9',background:'#000',objectFit:'cover'}} />
                      {!peerCamOn && (
                        <div className="room-cam-placeholder">
                          <Avatar src={u.avatar} name={u.nickname || u.username} size="md" badge={u.badge} />
                          <span className="cam-off-label">📷 camera off</span>
                        </div>
                      )}
                      <span className="room-peer-name">{u.nickname || u.username}
                        {!peerCamOn ? <em className="voice-connecting">no video</em>
                          : hasMedia ? <em className="voice-live-dot" title="Video live" />
                          : <em className="voice-connecting">connecting…</em>}
                      </span>
                    </div>
                  ) : (
                    <div key={u.userId} className={`room-peer-tile${hasMedia?' live':' connecting'}`}>
                      <Avatar src={u.avatar} name={u.nickname || u.username} size="lg" badge={u.badge} />
                      <audio ref={el => { remoteRefs.current[u.userId] = el; }} autoPlay playsInline style={{display:'none'}} />
                      <span>{u.nickname || u.username}</span>
                      {hasMedia ? <span className="voice-live-dot" title="Audio live" /> : <span className="voice-connecting">connecting…</span>}
                    </div>
                  );
                })}
                {voiceRoster.length === 0 && <p className="voice-empty-note">Waiting for others to join…</p>}
              </>
            ) : <div className="room-idle"><span className="room-icon">{meta.icon}</span><p>Join to talk in this room</p></div>}
          </div>
          <div className="room-voice-ctrls">
            {!inCall ? (
              <button className="voice-join-btn" onClick={joinVoice}>Join {meta.label}</button>
            ) : (
              <>
                {room.ptt ? (
                  <button className={`room-ptt-btn${pttDown?' active':''}`}
                    onMouseDown={pttDownFn} onMouseUp={pttUpFn} onMouseLeave={pttUpFn}
                    onTouchStart={e=>{e.preventDefault(); pttDownFn();}} onTouchEnd={pttUpFn}>🎙 Hold to talk</button>
                ) : (
                  <button className={`voice-ctrl-btn${muted?' active':''}`} onClick={toggleMute}>{muted?'🔇 Unmute':'🎤 Mute'}</button>
                )}
                {room.type==='video' && (
                  <button className={`voice-ctrl-btn${!cameraOn?' active':''}`} onClick={toggleCamera} title={cameraOn ? 'Turn your camera off' : 'Turn your camera back on'}>
                    {cameraOn ? '🎥 Camera' : '📷 Camera Off'}
                  </button>
                )}
                <button className="voice-ctrl-btn leave" onClick={leaveVoice}>Leave</button>
              </>
            )}
          </div>
        </div>
      )}

      {!waiting && room.type==='game' && (
        <div className="room-game">
          <div className="room-idle"><span className="room-icon">🎮</span><p>Pick a game — everyone in the room can play along</p></div>
          <div className="room-game-grid">
            <button onClick={()=>onLaunchGame?.('guess')}>🎯 Guess the Number</button>
            <button onClick={()=>onLaunchGame?.('wyr')}>🤔 Would You Rather</button>
            <button onClick={()=>onLaunchGame?.('truth')}>🔥 Truth or Dare</button>
            <button onClick={()=>onLaunchGame?.('trivia')}>🧠 Trivia</button>
            <button onClick={()=>onLaunchGame?.('scramble')}>🔤 Word Scramble</button>
          </div>
        </div>
      )}

      {!waiting && room.type==='drawing' && (
        <div className="room-drawing">
          <canvas ref={canvasRef} className="room-canvas"
            onMouseDown={canvasDown} onMouseMove={canvasMove} onMouseUp={canvasUp} onMouseLeave={canvasUp}
            onTouchStart={e=>{e.preventDefault(); const t=e.touches[0]; const c=canvasRef.current; if(c){const r=c.getBoundingClientRect(); drawingRef.current=true; lastPt.current={x:t.clientX-r.left,y:t.clientY-r.top};}}} 
            onTouchMove={e=>{e.preventDefault(); if(!drawingRef.current||!canvasRef.current)return; const t=e.touches[0]; const c=canvasRef.current, r=c.getBoundingClientRect(); const pt={x:t.clientX-r.left,y:t.clientY-r.top}; const d={roomId,x1:lastPt.current.x,y1:lastPt.current.y,x2:pt.x,y2:pt.y,color:'#fff',size:3}; drawStroke(c,d); socket.emit('room_draw',d); lastPt.current=pt;}}
            onTouchEnd={canvasUp} />
          <p className="room-hint">✏️ Draw — everyone in the room sees it live</p>
        </div>
      )}

      {!waiting && room.type==='poll' && (
        <div className="room-poll">
          <form className="room-poll-form mini" onSubmit={createPoll}>
            <h3>Create a poll</h3>
            <input placeholder="Question…" value={pollQ} onChange={e=>setPollQ(e.target.value)} />
            {pollOpts.map((o,i)=>(<input key={i} placeholder={`Option ${i+1}`} value={o} onChange={e=>setPollOpts(x=>x.map((y,j)=>j===i?e.target.value:y))} />))}
            <div style={{display:'flex',gap:4}}>
              <button>Post poll</button>
              <button type="button" className="ghost" onClick={()=>setPollOpts(x=>[...x,''])}>+ Option</button>
              {pollOpts.length>2 && <button type="button" className="ghost" onClick={()=>setPollOpts(x=>x.slice(0,-1))}>−</button>}
            </div>
          </form>
          <div className="room-poll-list">
            {polls.map(p => {
              const opts = typeof p.options==='string' ? JSON.parse(p.options||'[]') : (p.options||[]);
              const votes = p.votes||[];
              const total = votes.reduce((a,v)=>a+Number(v.count),0);
              return (
                <div key={p.id} className="poll-card">
                  <div className="poll-question">📊 {p.question}</div>
                  {opts.map((o,i) => {
                    const count = votes.find(v=>Number(v.option_index)===i)?.count||0;
                    const pct = total ? Math.round(count/total*100) : 0;
                    return <button key={i} className={`poll-option${p.myVote===i?' voted':''}`} onClick={()=>votePoll(p.id,i)}>
                      <div className="poll-bar" style={{width:`${pct}%`}} />
                      <span className="poll-label">{o}</span><span className="poll-pct">{pct}%</span>
                    </button>;
                  })}
                  <div className="poll-footer">{total} vote{total!==1?'s':''}</div>
                </div>
              );
            })}
            {polls.length===0 && <p className="empty-text">No polls yet — create one above!</p>}
          </div>
        </div>
      )}

      {!waiting && room.type==='watch' && (
        <div className="room-watch">
          <form className="room-watch-form" onSubmit={e=>{e.preventDefault(); setWatch(watchUrl);}}>
            <input value={watchUrl} onChange={e=>setWatchUrl(e.target.value)} placeholder="Paste a video URL (YouTube, mp4, webm…)" />
            <button>▶ Share</button>
          </form>
          <div className="room-watch-player">
            {watchUrl
              ? (watchUrl.includes('youtube.com')||watchUrl.includes('youtu.be')
                  ? <iframe src={`https://www.youtube.com/embed/${watchUrl.includes('v=')?new URL(watchUrl).searchParams.get('v'):watchUrl.split('/').pop()}`} allow="autoplay; fullscreen" allowFullScreen style={{width:'100%',aspectRatio:'16/9',border:0,borderRadius:10}} />
                  : <video ref={videoRef} src={watchUrl} controls autoPlay style={{width:'100%',maxHeight:'60vh',borderRadius:10,background:'#000'}} />)
              : <div className="room-idle"><span className="room-icon">📺</span><p>Share a video to watch together</p></div>}
          </div>
        </div>
      )}

      {!waiting && room.type==='collab' && (
        <div className="room-collab">
          <div className="room-collab-head"><span className="room-icon">📝</span><h3>Shared document — everyone edits live</h3></div>
          <textarea className="room-collab-text" value={collab} onChange={e=>onCollabChange(e.target.value)}
            onFocus={()=>collabFocused.current=true} onBlur={()=>collabFocused.current=false}
            placeholder="Start writing… (saves live for everyone in the room)" />
          {collab!==collabSync && <span className="room-hint">saving…</span>}
        </div>
      )}
    </div>
  );
}

function drawStroke(c, d) {
  const ctx = c.getContext('2d');
  if (!ctx) return;
  ctx.strokeStyle = d.color || '#fff';
  ctx.lineWidth = d.size || 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(d.x1, d.y1);
  ctx.lineTo(d.x2, d.y2);
  ctx.stroke();
}

// ── Profile Popup ─────────────────────────────────────────────────────────────
function ProfilePopup({ user, me, onClose, onOpenDm, notify, onRequestData }) {
  const isSelf = user.id === me.id;
  const [pet, setPet] = useState(null);
  useEffect(()=>{ api(`/api/users/${user.id}/pet`).then(d=>{ if(d && !d.error) setPet(d.pet||null); }).catch(()=>{}); },[user.id]);
  return (
    <div className="profile-popup-overlay" onClick={onClose}>
      <div className="profile-popup" onClick={e=>e.stopPropagation()}>
        <div className="profile-popup-banner" style={{background:user.banner?`url(${user.banner}) center/cover`:(user.settings?.profile_theme||'var(--brand)')}}>
          <button className="icon-btn popup-close" onClick={onClose}>✕</button>
        </div>
        <div className="profile-popup-body">
          <Avatar src={user.avatar} name={user.nickname||user.username} size="lg" official={user.tag==='real'} badge={user.badge}
            anonMask={user.anon_active?(user.anon_emoji||user.anon_mask?.split(' ')[0]):null} anonColor={user.anon_active?user.anon_color:null} />
          <div className="profile-popup-info">
            <h3>{user.anon_active?maskName(user.anon_mask):(user.nickname||user.username)} {!user.anon_active&&<small>#{user.tag}</small>}</h3>
            {user.badge==='Knowns' && <span className="badge-knowns-label">⭐ Knowns</span>}
            {user.is_admin && <span className="role-tag admin">Admin</span>}
            {user.credits>0 && <span className="karma-badge">✦ {user.credits}</span>}
            {pet && <span className="profile-pet">{pet.emoji} {pet.name}</span>}
            {user.karma>0 && <span className="karma-badge">⚡ {user.karma} karma</span>}
            {user.rank && <span className="profile-rank">🏅 {user.rank}</span>}
            {isSelf && <span className="profile-self-label">This is you</span>}
            {user.custom_status && <p className="popup-custom-status">{user.custom_status}</p>}
            {user.bio && !user.privacy_mode?.includes('private') && <p className="popup-bio">{user.bio}</p>}
            {user.interests && <div className="popup-interests">{user.interests.split(',').filter(Boolean).map(i=><span key={i} className="discover-tag">{i}</span>)}</div>}
          </div>
          {user.id !== me.id && (
            <div className="profile-popup-actions">
              <button onClick={()=>onOpenDm(user.id)}>💬 Message</button>
              <button className="ghost" onClick={()=>{api('/api/reports',{method:'POST',body:JSON.stringify({targetType:'user',targetId:user.id,reason:'User report',category:'other'})});notify('Report submitted.');onClose();}}>🚩 Report</button>
              <button className="ghost" onClick={()=>onRequestData?.(user)}>📋 Request data</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Admin Panel ───────────────────────────────────────────────────────────────
function RolesPanel({ comm, boot, onNotice, onBootRefresh }) {
  const [roles, setRoles] = useState([]); const [name, setName] = useState(''); const [color, setColor] = useState('#5865f2');
  const [permissions, setPermissions] = useState({manage_messages:false,manage_channels:false,manage_roles:false,send_messages:true,read_messages:true,connect_voice:true});
  async function load(){ const d=await api(`/api/communities/${comm.id}/roles`); setRoles(Array.isArray(d)?d:[]); }
  useEffect(()=>{if(comm)load();},[comm?.id]);
  async function create(e){e.preventDefault(); if(!name.trim())return; const d=await api(`/api/communities/${comm.id}/roles`,{method:'POST',body:JSON.stringify({name,color,permissions})}); if(d.id){setName('');load();onNotice('Role created','ok');onBootRefresh?.();}}
  async function toggle(role){ const d=await api(`/api/communities/${comm.id}/roles/${role.id}`,{method:'DELETE'}); if(d.error){onNotice(d.error,'err');return;} const next=roles.filter(r=>r.id!==role.id); setRoles(next); onNotice('Role deleted','ok'); }
  async function setLocked(role, locked){ const d=await api(`/api/communities/${comm.id}/roles/${role.id}`,{method:'PATCH',body:JSON.stringify({locked})}); if(d.error){onNotice(d.error,'err');return;} setRoles(rs=>rs.map(x=>x.id===role.id?{...x,locked:d.locked?1:0}:x)); onNotice(locked?'Role locked — shop roles can\'t be deleted until unlocked':'Role unlocked — it can be deleted now','ok'); }
  function permSummary(role){
    const p = role.permissions || {};
    const on = Object.keys(p).filter(k => p[k]);
    return on.length ? on.map(k => k.replaceAll('_',' ')).join(', ') : 'no special permissions';
  }
  if(!comm)return <p className="empty-text">Select a server to manage roles.</p>;
  return <div className="admin"><h2>Server roles</h2><form className="mini" onSubmit={create}><input placeholder="Role name" value={name} onChange={e=>setName(e.target.value)}/><input type="color" value={color} onChange={e=>setColor(e.target.value)}/><div className="role-permission-grid">{Object.keys(permissions).map(p=><label key={p} className="remember"><input type="checkbox" checked={permissions[p]} onChange={e=>setPermissions(x=>({...x,[p]:e.target.checked}))}/>{p.replaceAll('_',' ')}</label>)}</div><button>Create role</button></form><div className="role-list">{roles.map(r=><div className="role-row" key={r.id}><span className="role-tag" style={{color:r.color}}>{r.name}</span>{r.cosmetic && <span className="role-purchased" title={`${r.cosmeticName ? `Bought with credits — ${r.cosmeticName}` : 'Bought with credits from the shop'}\nGrants: ${permSummary(r)}`}>★ Purchased</span>}{Number(r.locked)===1 && <span className="role-locked" title="Locked shop role — unlock it before deleting">🔒</span>}<button className="mini-btn" title={Number(r.locked)===1?'Unlock so this shop role can be deleted':'Lock this role so it can\'t be deleted'} onClick={()=>setLocked(r, Number(r.locked)!==1)}>{Number(r.locked)===1?'🔓 Unlock':'🔒 Lock'}</button><button className="danger-btn" disabled={Number(r.locked)===1} title={Number(r.locked)===1?'Locked — unlock first':'Delete this role'} onClick={()=>toggle(r)}>Delete</button></div>)}</div></div>;
}

// ── Rewards: Quests / Shop (pets) / Gift ────────────────────────────────────────
const PET_EMOJI = { pet_dot:'🐾', pet_cat:'🐱', pet_dog:'🐶', pet_fox:'🦊', pet_dragon:'🐉', pet_ghost:'👻', pet_robot:'🤖', pet_owl:'🦉', pet_panda:'🐼', pet_dino:'🦖' };
// ── Bookmarks panel ───────────────────────────────────────────────────────────
async function exportBookmarks(notify) {
  try {
    const res = await fetch('/api/bookmarks/export', {
      headers: { Authorization: `Bearer ${getToken()}` }
    });
    if (!res.ok) throw new Error('Export failed');
    const text = await res.text();
    const disp = res.headers.get('Content-Disposition') || '';
    const m = disp.match(/filename="([^"]+)"/);
    const filename = m ? m[1] : 'unknown-bookmarks.txt';
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    if (notify) notify(`Archive saved as ${filename}`,'ok');
  } catch (e) {
    if (notify) notify('Export failed: '+e.message,'err');
  }
}

function BookmarksModal({ onClose, onJump, notify }) {
  const { items } = useBookmarks();
  const [folder, setFolder] = useState('All');
  useEffect(() => { refreshBookmarks(); }, []);
  const list = folder === 'All' ? items : items.filter(b => b.folder === folder);
  return (
    <div className="menu-overlay" onClick={onClose}>
      <div className="menu-modal bookmarks-modal" onClick={e => e.stopPropagation()}>
        <div className="menu-modal-header">
          <h2>🔖 Bookmarks</h2>
          <div>
            <button className="btn small-btn" title="Download all bookmarks as a readable archive" onClick={() => exportBookmarks(notify)}>⬇ Export</button>
            <button className="icon-btn" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="bookmark-folders">
          <button className={folder==='All'?'active':''} onClick={()=>setFolder('All')}>🗂 All</button>
          {BOOKMARK_FOLDERS.map(f => (
            <button key={f} className={folder===f?'active':''} onClick={()=>setFolder(f)}>{f}</button>
          ))}
        </div>
        <div className="bookmark-list">
          {list.length === 0 && <p className="muted-text">No bookmarks{folder!=='All'?` in ${folder}`:''} yet. Hover a message and hit 🔖 to save it privately.</p>}
          {list.map(b => (
            <div key={b.message_id} className="bookmark-item">
              <div className="bookmark-info" onClick={() => onJump(b)} title="Jump to message">
                <b>{b.nickname || b.username}</b>
                <p>{b.body || (b.attachment ? '📎 '+b.attachment_name : '')}</p>
                <small>
                  {b.channel_name ? '#'+b.channel_name : b.group_name || (b.dm_id ? 'DM' : '')}
                  {b.msg_created ? ' · '+timeAgo(b.msg_created) : ''}
                </small>
              </div>
              <select value={b.folder} title="Move to folder" onChange={e => moveBookmark(b.message_id, e.target.value)}>
                {BOOKMARK_FOLDERS.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
              <button className="icon-btn" title="Remove bookmark" onClick={() => toggleBookmark({id:b.message_id})}>🗑</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Admin → Quests: paste-to-add custom quests ────────────────────────────────
// A quest spec is a small JSON object; the server validates it against real
// metrics and merges it into the daily quest list (same claim/credit pipeline).
const QUEST_SPEC_TEMPLATE = `{
  "title": "Late Night Chat",
  "icon": "🌙",
  "description": "Send 3 messages in a server channel today",
  "metric": "server",
  "need": 3,
  "reward": 15
}`;
const QUEST_METRIC_HELP = [
  ['msgs', 'Any message (channels, DMs, groups)'],
  ['server', 'Messages in server channels'],
  ['dm', 'Direct messages'],
  ['group', 'Group chat messages'],
  ['rooms', 'Messages in temp voice/text rooms'],
  ['games', 'Mini games played'],
  ['friends', 'Friends added (accepted requests)'],
];
function AdminQuests() {
  const [list, setList] = useState([]);
  const [editor, setEditor] = useState(QUEST_SPEC_TEMPLATE);
  const [msg, setMsg] = useState(null);

  async function load() {
    const d = await api('/api/admin/quests');
    if (!d.error) setList(Array.isArray(d) ? d : []);
  }
  useEffect(() => { load(); }, []);

  async function save(e) {
    e.preventDefault();
    let spec;
    try { spec = JSON.parse(editor); } catch { setMsg({ type:'err', text:'That is not valid JSON — check quotes, commas and braces.' }); return; }
    const d = await api('/api/admin/quests', { method:'POST', body: JSON.stringify(spec) });
    if (d.error) setMsg({ type:'err', text:d.error });
    else { setMsg({ type:'ok', text:`Quest “${d.quest?.title || spec.title}” saved — live for everyone from the next quests load.` }); load(); }
  }
  async function toggle(q) { await api(`/api/admin/quests/${q.id}`, { method:'PATCH', body: JSON.stringify({ active: !Number(q.active) }) }); load(); }
  async function remove(q) {
    if (!window.confirm(`Delete quest “${q.title}”? It disappears immediately.`)) return;
    await api(`/api/admin/quests/${q.id}`, { method:'DELETE' });
    load();
  }
  function edit(q) { setEditor(JSON.stringify(JSON.parse(q.spec || '{}'), null, 2) || QUEST_SPEC_TEMPLATE); setMsg(null); }

  return (
    <div className="admin-quests">
      <p className="muted-text" style={{ fontSize:'0.75rem', marginBottom:'0.5rem' }}>
        Paste a quest spec below to add it — no redeploy needed. The quest counts real
        activity from today and joins the normal 🎯 Quests list with the daily claim/cap rules.
      </p>
      <div style={{ fontSize:'0.72rem', marginBottom:'0.5rem' }}>
        <b>Metrics you can measure:</b>
        <ul style={{ margin:'0.25rem 0 0 1rem', opacity:0.9 }}>
          {QUEST_METRIC_HELP.map(([k,label]) => <li key={k}><code>{k}</code> — {label}</li>)}
        </ul>
      </div>
      <form onSubmit={save} className="mini">
        <textarea value={editor} onChange={e=>setEditor(e.target.value)} rows={9} spellCheck={false}
          style={{ fontFamily:'monospace', fontSize:'0.78rem', minHeight:'150px' }} aria-label="Quest JSON spec" />
        <button type="submit">＋ Add / Update quest</button>
        {msg && <div className={`notice ${msg.type==='err'?'err':''}`}>{msg.text}</div>}
      </form>
      <div style={{ marginTop:'0.75rem' }}>
        <b>Custom quests</b>
        {!list.length && <p className="empty-text" style={{ marginTop:'0.4rem' }}>None yet — paste a spec above to add your first quest.</p>}
        {list.map(q => (
          <div key={q.id} className="admin-user" style={{ opacity: Number(q.active) ? 1 : 0.55 }}>
            <div className="admin-user-info">
              <b>{q.icon || '🎯'} {q.title} <small className="muted-text">· {q.metric} · {q.need}× · ✦{q.reward}</small></b>
              <small>{q.description || '—'}</small>
              <small className="muted-text">id: <code>{q.id}</code>{Number(q.active) ? ' · live' : ' · paused'}</small>
            </div>
            <button className="ghost" onClick={()=>edit(q)}>Edit</button>
            <button className={Number(q.active)?'ghost':'ok'} onClick={()=>toggle(q)}>{Number(q.active)?'Pause':'Enable'}</button>
            <button className="danger" onClick={()=>remove(q)}>Delete</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function RewardsModal({ me, onClose, notify, onCredits }) {
  const [tab, setTab]                 = useState('quests');
  const [credits, setCredits]         = useState(Number(me.credits||0));
  const [quests, setQuests]           = useState([]);
  const [capInfo, setCapInfo]         = useState(null);
  const [shop, setShop]               = useState([]);
  const [ownedIds, setOwnedIds]       = useState([]);
  const [activePet, setActivePet]     = useState(me.active_pet||null);
  const [petNames, setPetNames]       = useState({});
  const [gift, setGift]               = useState({ to:'', amount:'' });
  const [giftLeft, setGiftLeft]       = useState(null);

  async function refreshCredits() {
    const d = await api('/api/me/credits');
    if (d && !d.error) {
      setCredits(Number(d.credits||0)); setActivePet(d.active_pet||null);
      setShop(d.shop||[]); setOwnedIds(d.ownedIds||[]);
      const names = {}; (d.inventory||[]).forEach(i => names[i.item_id] = i.name); setPetNames(names);
      onCredits(Number(d.credits||0));
    }
  }
  async function loadQuests() {
    const d = await api('/api/quests');
    if (d && !d.error) { setQuests(d.quests||[]); setCapInfo({ cap:d.cap, earnedToday:d.earnedToday||0 }); setCredits(Number(d.credits||0)); }
  }
  useEffect(() => { loadQuests(); refreshCredits(); }, []);

  async function claim(q) {
    const d = await api('/api/quests/claim',{method:'POST',body:JSON.stringify({questId:q.id})});
    if (d.error) notify(d.error,'err');
    else { notify(`+${d.reward} credits earned`,'ok'); setCredits(d.credits); onCredits(d.credits); loadQuests(); }
  }
  async function buy(item) {
    const d = await api('/api/shop/buy',{method:'POST',body:JSON.stringify({itemId:item.id})});
    if (d.error) notify(d.error,'err');
    else { notify(`You got a ${item.name}!`,'ok'); setCredits(d.credits); onCredits(d.credits); refreshCredits(); }
  }
  async function equip(itemId, name) {
    const d = await api('/api/me/pet',{method:'PATCH',body:JSON.stringify({itemId, name})});
    if (d.error) notify(d.error,'err'); else { setActivePet(d.active_pet); if(d.name) setPetNames(p=>({...p,[itemId]:d.name})); notify(name?`Pet renamed`:`${PET_EMOJI[itemId]||'Pet'} equipped`,'ok'); }
  }
  async function unequip() {
    const d = await api('/api/me/pet',{method:'PATCH',body:JSON.stringify({itemId:null})});
    if (!d.error) { setActivePet(null); notify('No pet selected','ok'); }
  }
  async function sendGift(e) {
    e.preventDefault();
    const d = await api('/api/credits/gift',{method:'POST',body:JSON.stringify({to:gift.to, amount:Number(gift.amount)})});
    if (d.error) notify(d.error,'err');
    else { notify(`Gifted ${gift.amount} credits 🎁`,'ok'); setCredits(d.credits); onCredits(d.credits); setGiftLeft({left:5-(d.sentToday-1), sent:d.sentToday}); setGift({to:'',amount:''}); }
  }

  return (
    <div className="menu-overlay" onClick={onClose}>
      <div className="menu-modal rewards-modal" onClick={e=>e.stopPropagation()}>
        <div className="menu-modal-header">
          <h2>🎁 Rewards & Shop</h2>
          <span className="credit-pill">✦ {credits}</span>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="rewards-tabs">
          <button className={tab==='quests'?'active':''} onClick={()=>setTab('quests')}>🎯 Quests</button>
          <button className={tab==='shop'?'active':''} onClick={()=>setTab('shop')}>🛍 Pets Shop</button>
          <button className={tab==='gift'?'active':''} onClick={()=>setTab('gift')}>🎁 Gift</button>
        </div>

        {tab==='quests' && (
          <div className="quest-list">
            {capInfo && <div className="quest-cap">Claimed {capInfo.earnedToday}/{capInfo.cap} credits today (quests reset daily).</div>}
            {quests.map(q=>(
              <div key={q.id} className={`quest-item${q.claimed?' claimed':''}`}>
                <div className="quest-info">
                  <b>{q.title}</b>
                  <small>{q.desc}</small>
                  <div className="quest-bar"><span style={{width:`${q.claimed?100:(q.progress/q.need*100)}%`}} /></div>
                  <small className="quest-progress">{q.claimed?'Claimed ✓':`${q.progress}/${q.need}`}</small>
                </div>
                {!q.claimed && <button disabled={!q.done} onClick={()=>claim(q)} className={q.done?'':'ghost dis'}>
                  {q.done?'Claim':`✦ ${q.reward}`}
                </button>}
              </div>
            ))}
          </div>
        )}

        {tab==='shop' && (
          <div>
            <div className="pet-active">
              <span>Active pet:</span>
              {activePet ? <b>{PET_EMOJI[activePet]||'🐾'} {petNames[activePet]||activePet}</b> : <span className="muted-text">None</span>}
              {activePet && <button className="ghost" onClick={unequip}>Unequip</button>}
            </div>
            <div className="shop-grid">
              {shop.map(item=>{
                const owned = ownedIds.includes(item.id);
                const isActive = activePet===item.id;
                return (
                  <div key={item.id} className={`shop-card${owned?' owned':''}${isActive?' active':''}`}>
                    <div className="shop-emoji">{item.emoji}</div>
                    <b>{item.name}</b>
                    <small>{item.desc}</small>
                    {!owned && <button className="buy-btn" disabled={credits<item.price} onClick={()=>buy(item)}>
                      {credits<item.price?'✦ '+item.price:`Buy · ✦ ${item.price}`}</button>}
                    {owned && !isActive && <button className="ghost" onClick={()=>equip(item.id, petNames[item.id])}>Equip</button>}
                    {owned && <button className="ghost" onClick={()=>{const n=prompt(`Rename your ${item.name}`, petNames[item.id]||item.name); if(n) equip(item.id, n);}}>Rename</button>}
                    {isActive && <span className="pill">Active</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {tab==='gift' && (
          <div>
            <p className="muted-text">Send credits to a friend. You can gift up to 5 times per day.</p>
            {giftLeft && <p className="notice">Gifts sent: {giftLeft.sent} · {giftLeft.left} left today</p>}
            <form onSubmit={sendGift} className="mini">
              <input placeholder="Recipient username" value={gift.to} onChange={e=>setGift({...gift,to:e.target.value})} />
              <input type="number" min="1" placeholder="Amount (✦)" value={gift.amount} onChange={e=>setGift({...gift,amount:e.target.value})} />
              <button>Send gift</button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

function OwnerHistoryModal({ me, boot, onClose, notify }) {
  const [users, setUsers] = useState([]);
  const [sel, setSel]     = useState('');
  const [data, setData]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('channel');
  const [kw, setKw]     = useState('');
  const [fromD, setFromD] = useState('');
  const [toD, setToD]   = useState('');
  const [legalKeywordMode, setLegalKeywordMode] = useState('any');
  useEffect(() => { api('/api/admin/users').then(d => setUsers(Array.isArray(d) ? d : [])).catch(()=>{}); }, []);
  async function loadHistory() {
    if (!sel) return notify('Select a user first','err');
    setLoading(true); setData(null); setActiveTab('channel');
    const d = await api(`/api/owner/history?userId=${encodeURIComponent(sel)}`).catch(() => null);
    setLoading(false);
    if (!d || d.error) { notify((d && d.error) || 'Could not load history','err'); return; }
    setData(d);
  }
  function downloadJson() {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `legal-history-${data.user.username}.json`;
    a.click(); setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
  }
  function csvCell(v){ const s = String(v == null ? '' : v); return /[,"\n\r]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s; }
  async function downloadZip() {
    if (!data) return;
    const sf = data.surfaces || {};
    const json = JSON.stringify(data, null, 2);
    const rows = [['surface','sender','location','type','content','created_at','deleted_at','edited_at']];
    (sf.channel||[]).forEach(m=>rows.push(['channel',m.sender,m.channelName||m.communityName||'','',m.body||(m.attachment?('📎 '+m.attachmentName):''),m.createdAt,m.deletedAt||'',m.editedAt||'']));
    (sf.dm||[]).forEach(m=>{const o=m.participantA?.id===data.user.id?m.participantB:m.participantA; rows.push(['dm',m.sender,o?.name||'','',m.body||(m.attachment?('📎 '+m.attachmentName):''),m.createdAt,m.deletedAt||'',m.editedAt||'']);});
    (sf.group||[]).forEach(m=>rows.push(['group',m.sender,m.groupName||'','',m.body||(m.attachment?('📎 '+m.attachmentName):''),m.createdAt,m.deletedAt||'',m.editedAt||'']));
    const csv=rows.map(r=>r.map(csvCell).join(',')).join('\n');
    const enc=new TextEncoder();
    const hash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(text)))).map(b=>b.toString(16).padStart(2,'0')).join('');
    const manifest={format:'Unknown legal-history evidence bundle',algorithm:'SHA-256',generated_at:new Date().toISOString(),files:{'legal-history.json':await hash(json),'legal-history.csv':await hash(csv)}};
    const files=[['legal-history.json',json],['legal-history.csv','\uFEFF'+csv],['manifest.json',JSON.stringify(manifest,null,2)]];
    const central=[]; let offset=0;
    const u16=n=>new Uint8Array([n&255,(n>>8)&255]); const u32=n=>new Uint8Array([n&255,(n>>8)&255,(n>>16)&255,(n>>24)&255]);
    const join=(...xs)=>{const a=new Uint8Array(xs.reduce((n,x)=>n+x.length,0));let p=0;for(const x of xs){a.set(x,p);p+=x.length;}return a;};
    const enc8=new TextEncoder();
    for(const [name,text] of files){const nb=enc8.encode(name),db=enc8.encode(text),crc=await crc32(db);const local=join(new Uint8Array([80,75,3,4,20,0,0,0,0,0,0,0,0,0]),u32(crc),u32(db.length),u32(db.length),u16(nb.length),u16(0),nb,db); central.push({nb,crc,size:db.length,offset}); offset+=local.length; files[files.findIndex(x=>x[0]===name)][2]=local;}
    let cd=offset; const centralBytes=[]; for(const x of central){const c=join(new Uint8Array([80,75,1,2,20,0,20,0,0,0,0,0,0,0]),u32(x.crc),u32(x.size),u32(x.size),u16(x.nb.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(x.offset),x.nb);centralBytes.push(c);cd+=c.length;}
    const zip=join(...files.map(x=>x[2]),...centralBytes,new Uint8Array([80,75,5,6,0,0,0,0,...u16(files.length),...u16(files.length),...u32(cd-offset),...u32(offset),0,0]));
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([zip],{type:'application/zip'}));a.download=`legal-history-${data.user.username}.zip`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000);
  }
  async function crc32(data){let c=~0;for(const b of data){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (~c)>>>0;}
  function downloadCsv() {
    if (!data) return;
    const sf = data.surfaces || {};
    const rows = [['surface','sender','location','type','content','created_at','deleted_at','edited_at']];
    (sf.channel||[]).forEach(m => rows.push(['channel', m.sender, m.channelName||m.communityName||'', '', m.body||(m.attachment?('📎 '+m.attachmentName):''), m.createdAt, m.deletedAt||'', m.editedAt||'']));
    (sf.dm||[]).forEach(m => { const o=m.participantA?.id===data.user.id?m.participantB:m.participantA; rows.push(['dm', m.sender, o?.name||'', '', m.body||(m.attachment?('📎 '+m.attachmentName):''), m.createdAt, m.deletedAt||'', m.editedAt||'']); });
    (sf.group||[]).forEach(m => rows.push(['group', m.sender, m.groupName||'', '', m.body||(m.attachment?('📎 '+m.attachmentName):''), m.createdAt, m.deletedAt||'', m.editedAt||'']));
    (sf.edits||[]).forEach(e => rows.push(['edit', data.user.username||'', '', 'edit', e.old_body||'', e.edited_at, '', '']));
    (sf.reactions||[]).forEach(r => rows.push(['reaction', data.user.username||'', '', r.emoji||'', r.messageBody||'', r.created_at||'', '', '']));
    (sf.rooms||[]).forEach(m => rows.push(['room', m.sender, '', m.roomType||'', m.body||'', m.createdAt, '', '']));
    (sf.revealPosts||[]).forEach(p => rows.push(['reveal_post', data.user.username||'', '', p.type||'', p.body||(p.media?('📎 '+p.mediaName):''), p.createdAt, p.deletedAt||'', '']));
    (sf.revealComments||[]).forEach(c => rows.push(['reveal_comment', data.user.username||'', '', '', c.body||'', c.createdAt, c.deletedAt||'', '']));
    const csv = rows.map(r => r.map(csvCell).join(',')).join('\n');
    const blob = new Blob(['\uFEFF'+csv], { type:'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `legal-history-${data.user.username}.csv`;
    a.click(); setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
  }
  const surfaces = data?.surfaces || {};
  const TABS = [['channel','💬 Channel'],['dm','📩 DMs'],['group','👥 Groups'],['edits','✏️ Edits'],['reactions','👍 Reactions'],['rooms','🎙 Rooms'],['revealPosts','📹 Posts'],['revealComments','💬 Comments']];
  const sfmt = (x) => { if(!x) return '—'; try { return new Date(x).toLocaleString(); } catch { return x; } };
  // Filters — keyword on any visible text + From/To date range.
  const q    = (kw||'').trim().toLowerCase();
  const fFrom = fromD ? new Date(fromD+'T00:00:00').getTime() : null;
  const fTo   = toD   ? new Date(toD+'T23:59:59.999').getTime() : null;
  const inRange = (d) => { if (!d) return true; const t = new Date(d).getTime(); if (isNaN(t)) return true; if (fFrom && t < fFrom) return false; if (fTo && t > fTo) return false; return true; };
  const recText = (...xs) => xs.filter(x=>x!=null).join(' ').toLowerCase();
  const terms = q ? q.split(/\s+/).filter(Boolean) : [];
  const filterRec = (list, textFn, dateKey) => (list||[]).filter(x => {
    if (!inRange(dateKey ? x[dateKey] : x.createdAt)) return false;
    const text = recText(textFn(x));
    if (terms.length && legalKeywordMode === 'exact' && !text.includes(q)) return false;
    if (terms.length && legalKeywordMode === 'all' && !terms.every(t => text.includes(t))) return false;
    if (terms.length && legalKeywordMode === 'any' && !terms.some(t => text.includes(t))) return false;
    return true;
  });
  const lists = {
    channel: filterRec(surfaces.channel, m=>[m.sender,m.channelName,m.communityName,m.body,m.attachmentName], 'createdAt'),
    dm: filterRec(surfaces.dm, m=>{ const o=m.participantA?.id===data?.user?.id?m.participantB:m.participantA; return [m.sender, o?.name, m.body, m.attachmentName]; }, 'createdAt'),
    group: filterRec(surfaces.group, m=>[m.sender,m.groupName,m.body,m.attachmentName], 'createdAt'),
    edits: filterRec(surfaces.edits, m=>[m.old_body], 'edited_at'),
    reactions: filterRec(surfaces.reactions, r=>[r.emoji,r.messageBody], null),
    rooms: filterRec(surfaces.rooms, m=>[m.sender,m.roomType,m.body], 'createdAt'),
    revealPosts: filterRec(surfaces.revealPosts, m=>[m.type,m.body,m.mediaName], 'createdAt'),
    revealComments: filterRec(surfaces.revealComments, m=>[m.body], 'createdAt'),
  };
  const counts = Object.fromEntries(TABS.map(([k])=>[k, lists[k].length]));
  const filtersActive = !!(kw||fromD||toD);
  function clearFilters(){ setKw(''); setFromD(''); setToD(''); setLegalKeywordMode('any'); }
  const filterBar = (
    <div className="legal-filters">
      <input className="legal-kw" value={kw} placeholder="🔎 Filter keyword…" onChange={e=>setKw(e.target.value)} />
      <select className="legal-keyword-mode" value={legalKeywordMode} onChange={e=>setLegalKeywordMode(e.target.value)} aria-label="Keyword matching mode"><option value="any">Any keyword</option><option value="all">All keywords</option><option value="exact">Exact phrase</option></select>
      <label className="legal-date">From <input type="date" value={fromD} onChange={e=>setFromD(e.target.value)} /></label>
      <label className="legal-date">To <input type="date" value={toD} onChange={e=>setToD(e.target.value)} /></label>
      {filtersActive && <button className="ghost" onClick={clearFilters}>✕ Clear filters</button>}
    </div>
  );
  return (
    <div className="menu-overlay" onClick={onClose}>
      <div className="menu-modal legal-modal" onClick={e=>e.stopPropagation()}>
        <div className="menu-modal-header">
          <h2>🧠 Legal History</h2>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="menu-modal-body">
          <p className="muted-text" style={{fontSize:'0.78rem'}}>Founder/Owner only — forensic, unmodified record for legal requests. Deletions are shown but never hidden.</p>
          <div className="legal-picker">
            <select value={sel} onChange={e=>setSel(e.target.value)}>
              <option value="">Select user…</option>
              {users.filter(u=>!u.is_bot || true).map(u => <option key={u.id} value={u.id}>{u.nickname||u.username}{u.username!==(u.nickname||u.username)?' ('+u.username+')':''} · {u.rank||'Member'}</option>)}
            </select>
            <button onClick={loadHistory} disabled={loading} className="legal-load">{loading?'Loading…':'🔎 Pull full history'}</button>
            {data && <button className="ghost" onClick={downloadJson}>⬇ Export JSON</button>}
            {data && <button className="ghost" onClick={downloadCsv}>⬇ Export CSV</button>}
            {data && <button className="ghost" onClick={downloadZip}>📦 Export evidence ZIP</button>}
          </div>
          {!data && !loading && <p className="empty-text">Pick a user to view every message, edit, reaction, and Reveal post they left across the whole platform.</p>}
          {loading && <p className="empty-text">Assembling forensic record…</p>}
          {data && (
            <>
              <div className="legal-user-card">
                <div><b>{data.user.nickname||data.user.username}</b><small>{data.user.username}#{data.user.tag} · rank {data.user.rank} · joined {sfmt(data.user.created_at)}</small></div>
                <div className="legal-counts">{Object.entries(counts).map(([k,v])=>v>0&&<span key={k} className="legal-count">{k}: {v}</span>)}</div>
              </div>
              <div className="legal-tabs">{TABS.filter(([k])=>counts[k]>0||k==='channel').map(([k,label])=><button key={k} className={activeTab===k?'active':''} onClick={()=>setActiveTab(k)}>{label}{filtersActive&&counts[k]<1?' (0)':''}</button>)}</div>
              {filterBar}
              <div className="legal-list">
                {(activeTab==='channel'&&lists.channel||[]).map(m => (
                  <div key={m.id} className="legal-msg"><b>{m.sender} → #{m.channelName||m.communityName}</b><small>{sfmt(m.createdAt)}{m.deletedAt?<span className="legal-del"> · DELETED {sfmt(m.deletedAt)}</span>:''}{m.editedAt?<span className="legal-edit"> · edited</span>:''}</small><p>{m.body || (m.attachment?('📎 '+m.attachmentName):'(no text)')}</p></div>
                ))}
                {(activeTab==='dm'&&lists.dm||[]).map(m => {
                  const other = m.participantA.id === data.user.id ? m.participantB.name : m.participantA.name;
                  return <div key={m.id} className="legal-msg"><b>{m.sender} ⇄ {other} (DM)</b><small>{sfmt(m.createdAt)}{m.deletedAt?<span className="legal-del"> · DELETED</span>:''}{m.editedAt?<span className="legal-edit"> · edited</span>:''}</small><p>{m.body || (m.attachment?('📎 '+m.attachmentName):'(no text)')}</p></div>;
                })}
                {(activeTab==='group'&&lists.group||[]).map(m => (
                  <div key={m.id} className="legal-msg"><b>{m.sender} → {m.groupName}</b><small>{sfmt(m.createdAt)}{m.deletedAt?<span className="legal-del"> · DELETED</span>:''}{m.editedAt?<span className="legal-edit"> · edited</span>:''}</small><p>{m.body || (m.attachment?('📎 '+m.attachmentName):'(no text)')}</p></div>
                ))}
                {(activeTab==='edits'&&lists.edits||[]).map((e,i) => (
                  <div key={i} className="legal-msg"><b>Edit #{i+1}</b><small>{sfmt(e.edited_at)}</small><p>Old: {e.old_body || '(empty)'}</p></div>
                ))}
                {(activeTab==='reactions'&&lists.reactions||[]).map((r,i) => (
                  <div key={i} className="legal-msg"><b>{r.emoji}</b><small>on:</small><p>{r.messageBody||'(deleted message)'}</p></div>
                ))}
                {(activeTab==='rooms'&&lists.rooms||[]).map(m => (
                  <div key={m.id} className="legal-msg"><b>{m.sender} · {m.roomType} room</b><small>{sfmt(m.createdAt)}</small><p>{m.body}</p></div>
                ))}
                {(activeTab==='revealPosts'&&lists.revealPosts||[]).map(p => (
                  <div key={p.id} className="legal-msg"><b>{p.type}</b><small>{sfmt(p.createdAt)}{p.deletedAt?<span className="legal-del"> · DELETED</span>:''}</small><p>{p.body || (p.media?('📎 '+p.mediaName):'(no text)')}</p></div>
                ))}
                {(activeTab==='revealComments'&&lists.revealComments||[]).map(c => (
                  <div key={c.id} className="legal-msg"><b>Comment</b><small>{sfmt(c.createdAt)}{c.deletedAt?<span className="legal-del"> · DELETED</span>:''}</small><p>{c.body}</p></div>
                ))}
                {counts[activeTab]===0 && <p className="empty-text">{filtersActive?'No '+activeTab+' records match the current filters.':'No '+activeTab+' records.'}</p>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function AdminPanel({ onNotice, boot, onBootRefresh, me }) {
  const [tab, setTab]     = useState('stats');
  const [users, setUsers] = useState([]);
  const [reports, setReports] = useState([]);
  const [stats, setStats] = useState(null);
  const [logs, setLogs]   = useState([]);
  const [bots, setBots]   = useState([]);
  const [search, setSearch] = useState('');
  const [newAdmin, setNewAdmin] = useState({username:'',password:''});
  const [newBot, setNewBot]   = useState({username:'',nickname:''});
  const [created, setCreated] = useState(null);
  const [createdBot, setCreatedBot] = useState(null);
  const [reportMsg, setReportMsg] = useState(null);
  const [resetResult, setResetResult] = useState(null);
  const [noteTarget, setNoteTarget] = useState(null);
  const [noteText, setNoteText] = useState('');
  const [eventForm, setEventForm] = useState({title:'',description:'',starts_at:'',ends_at:''});
  const [events, setEvents] = useState([]);
  const [botCmds, setBotCmds]   = useState([]);
  const [cmdBot, setCmdBot]     = useState(null);
  const [newCmd, setNewCmd]     = useState({command:'', response:''});
  const [annForm, setAnnForm]   = useState({title:'', body:''});
  const [currentAnn, setCurrentAnn] = useState(null);
  const [annError, setAnnError] = useState('');
  const [ranks, setRanks] = useState([...['New','Beginner','Starter','Member','Trusted','Community','Celebrity','Known'],...['Mod','Sr. Mod','Jr. admin','admin','Dev','Head Mod','Head admin','Manager','Administrator','Owner','Founder']]);
  const [rankCatalog, setRankCatalog] = useState(null);

  async function loadLogs(){ setLogs(await api('/api/admin/logs')); }
  async function genFakeLogs(){ const d = await api('/api/dev/fake-logs', { method:'POST', body: JSON.stringify({ count: 12 }) }); if(d.error) onNotice(d.error,'err'); else { onNotice('Added '+d.added+' sample logs','ok'); loadLogs(); } }
  async function clearFakeLogs(){ const d = await api('/api/dev/fake-logs', { method:'DELETE' }); if(d.error) onNotice(d.error,'err'); else { onNotice('Cleared sample logs','ok'); loadLogs(); } }
  async function load() {
    setUsers(await api('/api/admin/users'));
    setReports(await api('/api/admin/reports'));
    setStats(await api('/api/admin/stats'));
    setLogs(await api('/api/admin/logs'));
    setBots(await api('/api/bots'));
    setEvents(await api('/api/events'));
    const a = await api('/api/announcement');
    if (a && !a.error) setCurrentAnn(a.announcement || null);
  }
  useEffect(() => { load(); api('/api/admin/rank-catalog').then(d=>{ if(d&&!d.error) setRankCatalog(d); }).catch(()=>{}); }, []);

  async function postAnn(e) {
    e.preventDefault();
    const d = await api('/api/admin/announcement',{method:'POST',body:JSON.stringify(annForm)});
    if (d.error) setAnnError(d.error);
    else { setCurrentAnn(d.announcement); setAnnForm({title:'', body:''}); setAnnError(''); onNotice('Announcement broadcast to all users','ok'); }
  }
  async function clearAnn() {
    await api('/api/admin/announcement',{method:'DELETE'});
    setCurrentAnn(null); onNotice('Announcement cleared','ok');
  }
  async function setRank(u, rank) {
    const d = await api(`/api/admin/users/${u.id}`,{method:'PATCH',body:JSON.stringify({isAdmin:Boolean(Number(u.is_admin)),banned:Boolean(Number(u.banned)),badge:(u.badge||''),rank})});
    if (d.error) return onNotice(d.error,'err');
    onNotice(`Set ${u.username} rank to ${rank}`,'ok'); load();
  }
  async function nukeServer(c) {
    if (!confirm(`NUKE the server "${c.name}" and delete ALL of its messages, channels, roles, and members? This cannot be undone.`)) return;
    const d = await api(`/api/admin/communities/${c.id}/nuke`,{method:'POST'});
    onNotice(d.ok?`Nuked ${c.name}`:(d.error||'Nuke failed'), d.ok?'ok':'err'); load(); onBootRefresh();
  }

  async function toggleUser(u, field, val) {
    const body = { isAdmin:field==='isAdmin'?val:Boolean(Number(u.is_admin)), banned:field==='banned'?val:Boolean(Number(u.banned)), badge:field==='badge'?val:(u.badge||'') };
    await api(`/api/admin/users/${u.id}`,{method:'PATCH',body:JSON.stringify(body)});
    onNotice(`Updated ${u.username}`,'ok'); load();
  }
  async function giveKnowns(u) {
    const has = u.badge === 'Knowns';
    await api(`/api/admin/users/${u.id}`,{method:'PATCH',body:JSON.stringify({isAdmin:Boolean(Number(u.is_admin)),banned:Boolean(Number(u.banned)),badge:has?'':'Knowns'})});
    onNotice(has?`Removed Knowns from ${u.username}`:`Gave Knowns to ${u.username}`,'ok'); load();
  }
  async function resetPassword(u) {
    const d = await api(`/api/admin/users/${u.id}/reset-password`,{method:'POST',body:JSON.stringify({})});
    setResetResult(d); onNotice(`Password reset for ${u.username}`,'ok');
  }
  async function resolveReport(id, status) {
    await api(`/api/admin/reports/${id}`,{method:'PATCH',body:JSON.stringify({status})});
    onNotice(`Report ${status}`,'ok'); load();
  }
  async function submitNote(e) {
    e.preventDefault();
    await api(`/api/admin/users/${noteTarget.id}/notes`,{method:'POST',body:JSON.stringify({note:noteText})});
    setNoteTarget(null); setNoteText(''); onNotice('Note added','ok');
  }
  async function createAdmin(e) {
    e.preventDefault();
    const d = await api('/api/admin/create-admin',{method:'POST',body:JSON.stringify(newAdmin)});
    setCreated(d); setNewAdmin({username:'',password:''}); load();
  }
  async function createBot(e) {
    e.preventDefault();
    const d = await api('/api/bots/create',{method:'POST',body:JSON.stringify(newBot)});
    setCreatedBot(d); setNewBot({username:'',nickname:''}); load();
  }
  async function createEvent(e) {
    e.preventDefault();
    await api('/api/events',{method:'POST',body:JSON.stringify(eventForm)});
    onNotice('Event created','ok'); setEventForm({title:'',description:'',starts_at:'',ends_at:''}); load();
  }
  async function selectBot(b) {
    setCmdBot(b); setBotCmds(await api(`/api/bots/${b.id}/commands`));
  }
  async function addCmd(e) {
    e.preventDefault();
    if (!cmdBot || !newCmd.command.trim()) return;
    await api(`/api/bots/${cmdBot.id}/commands`,{method:'POST',body:JSON.stringify(newCmd)});
    setNewCmd({command:'',response:''}); onNotice(`Command added to ${cmdBot.username}`,'ok'); selectBot(cmdBot);
  }
  async function delCmd(cmdId) {
    if (!cmdBot) return;
    await api(`/api/bots/${cmdBot.id}/commands/${cmdId}`,{method:'DELETE'});
    selectBot(cmdBot);
  }
  async function renameBot(b, nickname) {
    await api(`/api/bots/${b.id}`,{method:'PATCH',body:JSON.stringify({nickname})});
    onNotice('Bot updated','ok'); load(); if (cmdBot?.id===b.id) selectBot({...cmdBot,nickname});
  }

  const filtered = users.filter(u => !search || u.username.toLowerCase().includes(search.toLowerCase()) || (u.nickname||'').toLowerCase().includes(search.toLowerCase()));

  const [revealBans, setRevealBans] = useState([]);
  const [banForm, setBanForm]   = useState({userId:'', reason:''});
  const [revealMod, setRevealMod] = useState([]);
  const TABS = ['stats','users','reports','events','bots','announce','reveal','logs','quests','create'];

  async function loadRevealMod() {
    const d = await api('/api/reveal/moderation?status=open').catch(() => null);
    setRevealMod((d && d.reports) || []);
  }
  useEffect(() => {
    if (tab === 'reveal') { api('/api/reveal/bans').then(d => setRevealBans(Array.isArray(d)?d:[])).catch(()=>{}); loadRevealMod(); }
  }, [tab]);

  async function addRevealBan(e) {
    e.preventDefault();
    if (!banForm.userId) return onNotice('Pick a user to ban','err');
    const d = await api('/api/reveal/bans', { method:'POST', body: JSON.stringify({ userId: banForm.userId, reason: banForm.reason }) });
    if (d.error) onNotice(d.error,'err');
    else { onNotice('User banned from Reveal','ok'); setBanForm({userId:'',reason:''}); api('/api/reveal/bans').then(x=>setRevealBans(Array.isArray(x)?x:[])); }
  }
  async function removeRevealBan(userId) {
    await api(`/api/reveal/bans/${userId}`, { method:'DELETE' });
    setRevealBans(x => x.filter(b => b.user_id !== userId));
    onNotice('Ban lifted','ok');
  }
  async function modReveal(report, action) {
    if (action === 'remove') {
      if (!confirm('Delete this reported post?')) return;
      await api(`/api/reveal/posts/${report.post_id}`, { method:'DELETE', body: JSON.stringify({ reason: report.reason || report.category || 'Reported' }) });
      onNotice('Post removed and author notified','ok');
    } else if (action === 'ban') {
      if (!confirm(`Ban ${report.post_nickname||report.post_username} from posting in Reveal?`)) return;
      await api('/api/reveal/bans', { method:'POST', body: JSON.stringify({ userId: report.author_id, reason: `Reported: ${report.category||'other'}` }) });
      onNotice('Author banned from Reveal','ok');
    }
    await api(`/api/admin/reports/${report.report_id}`, { method:'PATCH', body: JSON.stringify({ status: 'resolved' }) });
    loadRevealMod();
    api('/api/reveal/bans').then(d => setRevealBans(Array.isArray(d)?d:[]));
  }
  async function dismissReveal(report) {
    await api(`/api/admin/reports/${report.report_id}`, { method:'PATCH', body: JSON.stringify({ status: 'dismissed' }) });
    onNotice('Report dismissed','ok');
    loadRevealMod();
  }

  return (
    <section className="admin panel">
      <h2>⚙ Owner Console</h2>
      {stats && (
        <div className="admin-stats">
          <span>{stats.users} users</span>
          <span>{stats.messages} messages</span>
          <span className={stats.reports>0?'warn':''}>{stats.reports} open reports</span>
          <span>{stats.communities} servers</span>
          <span>{stats.bots} bots</span>
        </div>
      )}
      <div className="admin-tabs">
        {TABS.map(t => <button key={t} className={tab===t?'active':''} onClick={()=>setTab(t)}>{t.charAt(0).toUpperCase()+t.slice(1)}</button>)}
      </div>

      {tab==='stats' && stats && (
        <>
          <div className="stats-grid">
            <div className="stat-card"><span>{stats.users}</span><label>Users</label></div>
            <div className="stat-card"><span>{stats.messages}</span><label>Messages</label></div>
            <div className="stat-card warn"><span>{stats.reports}</span><label>Reports</label></div>
            <div className="stat-card"><span>{stats.communities}</span><label>Servers</label></div>
          </div>
          <div className="nuke-list" style={{marginTop:'0.75rem'}}>
            <b style={{color:'var(--danger,#ed4245)'}}>☢ Danger Zone — Nuke a server</b>
            <p className="muted-text" style={{fontSize:'0.72rem',margin:'0.25rem 0 0.5rem'}}>Permanently deletes a server and everything in it (messages, channels, roles, members).</p>
            {(boot?.communities||[]).map(c=>(
              <div key={c.id} className="admin-user">
                <div className="admin-user-info"><b>{c.name}</b><small>{c.description||''}</small></div>
                <button className="danger" onClick={()=>nukeServer(c)}>💥 Nuke</button>
              </div>
            ))}
            {(boot?.communities||[]).length===0 && <p className="empty-text">No servers.</p>}
          </div>
        </>
      )}

      {tab==='users' && (
        <>
          <input className="admin-search" placeholder="Search users…" value={search} onChange={e=>setSearch(e.target.value)} />
          {resetResult?.temporaryPassword && <div className="notice">Temp password: <code>{resetResult.temporaryPassword}</code> <button onClick={()=>setResetResult(null)}>✕</button></div>}
          {noteTarget && (
            <form onSubmit={submitNote} className="mini" style={{marginBottom:'0.5rem',background:'var(--soft)',padding:'0.5rem',borderRadius:6}}>
              <label>Note for {noteTarget.username}<textarea value={noteText} onChange={e=>setNoteText(e.target.value)} rows={2} /></label>
              <div style={{display:'flex',gap:4}}><button>Save note</button><button type="button" className="ghost" onClick={()=>setNoteTarget(null)}>Cancel</button></div>
            </form>
          )}
          <div className="admin-list">
            {filtered.map(u => (
              <div key={u.id} className={`admin-user${Number(u.banned)?' banned':''}`}>
                <Avatar src={u.avatar} name={u.nickname||u.username} size="xs" official={u.tag==='real'} badge={u.badge} />
                <div className="admin-user-info">
                  <b>{u.nickname||u.username}</b>
                  <small>{u.username}#{u.tag} {u.is_bot?'🤖':''}</small>
                  <small style={{color:'var(--muted)',fontSize:'0.65rem'}}>Joined: {new Date(u.created_at).toLocaleDateString()}</small>
                  {u.badge==='Knowns'&&<small style={{color:'var(--gold)'}}>⭐ Knowns</small>}
                </div>
                <div className="rank-select">
                  <select value={u.rank||'Member'} onChange={e=>setRank(u,e.target.value)} title="Assign rank">
                    <optgroup label="Member ranks">{ranks.slice(0,8).map(r=><option key={r} value={r}>{r}</option>)}</optgroup>
                    <optgroup label="Platform staff ranks">{(rankCatalog?.assignable?.staff||ranks.slice(8)).map(r=><option key={typeof r==='string'?r:r.rank} value={typeof r==='string'?r:r.rank}>{typeof r==='string'?r:r.rank}</option>)}</optgroup>
                  </select>
                </div>
                <div className="admin-actions">
                  <button className={Number(u.is_admin)?'active':''} onClick={()=>toggleUser(u,'isAdmin',!Number(u.is_admin))} title="Toggle admin">{Number(u.is_admin)?'★':'☆'}</button>
                  <button onClick={()=>giveKnowns(u)} className={u.badge==='Knowns'?'active':''} title="Knowns badge">⭐</button>
                  <button onClick={()=>resetPassword(u)} title="Reset password">🔑</button>
                  <button onClick={()=>setNoteTarget(u)} title="Add note">📝</button>
                  <button className={`danger${Number(u.banned)?' active':''}`} onClick={()=>toggleUser(u,'banned',!Number(u.banned))}>{Number(u.banned)?'Unban':'Ban'}</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {tab==='reports' && (
        <div className="report-list">
          {reportMsg && <div className="report-msg-preview"><b>Reported message:</b>{reportMsg.message&&<p><b>{reportMsg.message.username}:</b> {reportMsg.message.body}</p>}<button onClick={()=>setReportMsg(null)}>Close</button></div>}
          {reports.length===0&&<p className="empty-text">No reports.</p>}
          {reports.map(r=>(
            <div key={r.id} className={`report-item status-${r.status}`}>
              <div><b>{r.target_type}</b> · <span className="report-cat">{r.category}</span> · {r.reason}<small> by {r.username}#{r.tag} · {timeAgo(r.created_at)}</small></div>
              <div className="admin-actions">
                <button className="ghost" onClick={async()=>{ const d=await api(`/api/admin/reports/${r.id}/message`); setReportMsg(d); }}>View</button>
                {r.status==='open'&&<><button onClick={()=>resolveReport(r.id,'resolved')}>Resolve</button><button className="ghost" onClick={()=>resolveReport(r.id,'dismissed')}>Dismiss</button></>}
                {r.status!=='open'&&<span className="pill">{r.status}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab==='events' && (
        <div>
          <form onSubmit={createEvent} className="mini" style={{marginBottom:'0.75rem'}}>
            <input placeholder="Event title" value={eventForm.title} onChange={e=>setEventForm({...eventForm,title:e.target.value})} />
            <input placeholder="Description" value={eventForm.description} onChange={e=>setEventForm({...eventForm,description:e.target.value})} />
            <input type="datetime-local" value={eventForm.starts_at} onChange={e=>setEventForm({...eventForm,starts_at:e.target.value})} />
            <button>Create Global Event</button>
          </form>
          <div className="admin-list">
            {events.map(ev=>(
              <div key={ev.id} className="admin-user">
                <div className="admin-user-info"><b>{ev.title}</b><small>{ev.description}</small></div>
                <button className="danger" onClick={()=>api(`/api/events/${ev.id}`,{method:'DELETE'}).then(()=>{onNotice('Event ended','ok');load();})}>End</button>
              </div>
            ))}
            {events.length===0&&<p className="empty-text">No active events.</p>}
          </div>
        </div>
      )}

      {tab==='bots' && (
        <div>
          <form onSubmit={createBot} className="mini" style={{marginBottom:'0.75rem'}}>
            <input placeholder="Bot username (no spaces)" value={newBot.username} onChange={e=>setNewBot({...newBot,username:e.target.value})} />
            <input placeholder="Display name" value={newBot.nickname} onChange={e=>setNewBot({...newBot,nickname:e.target.value})} />
            <button>Create Bot</button>
            {createdBot&&<div className="notice">Bot created! Token: <code style={{wordBreak:'break-all'}}>{createdBot.botToken}</code> <button onClick={()=>navigator.clipboard?.writeText(createdBot.botToken).then(()=>onNotice('Token copied','ok'))}>Copy</button></div>}
          </form>
          <p className="muted-text" style={{fontSize:'0.72rem'}}>Bots reply in any channel when someone types <b>!command</b> or <b>@botname</b>. Use <b>!help</b> to see available commands, <b>{'{user}'}</b> and <b>{'{args}'}</b> in responses, and name a command <b>default</b> to trigger it when the bot is mentioned.</p>
          <div className="admin-list">
            {bots.map(b=>(
              <div key={b.id} className="admin-user">
                <Avatar name={b.nickname||b.username} size="xs" />
                <div className="admin-user-info">
                  <b>{b.nickname||b.username}</b>
                  <small>🤖 {b.username}</small>
                  <small style={{fontFamily:'monospace',fontSize:'0.62rem',wordBreak:'break-all'}}>{b.bot_token}</small>
                </div>
                <div className="admin-actions">
                  <button className={cmdBot?.id===b.id?'active':''} onClick={()=>selectBot(b)} title="Manage commands">⚙</button>
                  <button onClick={()=>{const n=prompt('Bot display name',b.nickname||b.username); if(n)renameBot(b,n);}} title="Rename">✏</button>
                </div>
              </div>
            ))}
          </div>
          {cmdBot && (
            <div className="bot-commands" style={{marginTop:'0.75rem'}}>
              <b>Commands for {cmdBot.nickname||cmdBot.username}</b>
              <form onSubmit={addCmd} className="mini" style={{marginTop:'0.5rem'}}>
                <input placeholder="Command name (e.g. help)" value={newCmd.command} onChange={e=>setNewCmd({...newCmd,command:e.target.value})} />
                <textarea placeholder="Bot response (supports {user} and {args})" value={newCmd.response} onChange={e=>setNewCmd({...newCmd,response:e.target.value})} rows={2} />
                <button>Add command</button>
              </form>
              <div className="admin-list" style={{marginTop:'0.5rem'}}>
                {botCmds.map(c=>(
                  <div key={c.id} className="admin-user">
                    <div className="admin-user-info"><b>!{c.command}</b><small>{c.description}</small><small style={{color:'var(--muted)',fontSize:'0.7rem'}}>{c.response}</small></div>
                    <button className="danger" onClick={()=>delCmd(c.id)}>✕</button>
                  </div>
                ))}
                {botCmds.length===0&&<p className="empty-text">No commands yet. Add one above.</p>}
              </div>
            </div>
          )}
        </div>
      )}

      {tab==='announce' && (
        <div>
          <form onSubmit={postAnn} className="mini" style={{marginBottom:'0.75rem'}}>
            <input placeholder="Title (optional)" value={annForm.title} onChange={e=>setAnnForm({...annForm,title:e.target.value})} />
            <textarea placeholder="Announcement message — shown over every user's screen until closed" value={annForm.body} onChange={e=>setAnnForm({...annForm,body:e.target.value})} rows={3} />
            <button>📢 Broadcast to everyone</button>
          </form>
          {annError && <p className="error">{annError}</p>}
          {currentAnn && (
            <div className="admin-user" style={{marginTop:'0.5rem'}}>
              <div className="admin-user-info"><b>{currentAnn.title||'Announcement'}</b><small>{currentAnn.body}</small><small style={{color:'var(--muted)',fontSize:'0.7rem'}}>Posted {timeAgo(currentAnn.created_at)}</small></div>
              <button className="danger" onClick={clearAnn}>Clear</button>
            </div>
          )}
        </div>
      )}

      {tab==='logs' && (
        <div className="admin-list">
          {boot.devMode && (
            <div className="dev-log-toolbar">
              <span className="dev-log-label">🧪 DEV SAMPLE LOGS</span>
              <button className="mini-btn" onClick={genFakeLogs}>＋ Generate sample logs</button>
              <button className="mini-btn" onClick={clearFakeLogs}>⌫ Clear</button>
            </div>
          )}
          {logs.map(l=>{
            const isDev = (l.action||'').startsWith('dev_');
            let target = l.target?.slice(0,12);
            let note = '';
            if (isDev) { try { const d = JSON.parse(l.details || '{}'); target = 'sample'; note = (d.label?(' · '+d.label):'') + ' · '+(d.generatedAt?new Date(d.generatedAt).toLocaleString():''); } catch {} }
            if (l.action === 'legal_history_view') {
              try { const d = JSON.parse(l.details || '{}'); target = d.target || target; note = ' · 📊 '+[['channel',d.channel],['dm',d.dm],['group',d.group],['edits',d.edits],['reactions',d.reactions],['rooms',d.rooms],['posts',d.revealPosts],['comments',d.revealComments]].filter(([,v])=>v>0).map(([k,v])=>`${k} ${v}`).join(', '); } catch {}
            }
            return (
              <div key={l.id} className={`log-item${isDev?' dev-log-row':''}`}>
                <span className={`log-action${isDev?' dev':''}`}>{l.action}</span>
                <span>{l.username} → <b>{target}</b>{note}{isDev&&<small className="dev-sample-tag"> SAMPLE</small>}</span>
                <time>{timeAgo(l.created_at)}</time>
              </div>
            );
          })}
        </div>
      )}

      {tab==='reveal' && (
        <>
          <h3>🚩 Reveal moderation queue</h3>
          {revealMod.length === 0 && <p className="muted-text">No open reports. 🎉</p>}
          {revealMod.map(r => (
            <div key={r.report_id} className="admin-user" style={{alignItems:'flex-start'}}>
              <div className="admin-user-info" style={{minWidth:0}}>
                <b>{r.post_nickname||r.post_username}</b>
                <small>{r.type === 'short' ? '📱 Short' : r.type === 'video' ? '🎬 Video' : r.type === 'quiz' ? '❓ Quiz' : '📝 Post'} · {timeAgo(r.post_created_at)}</small>
                <small style={{wordBreak:'break-word'}}>{r.post_body || (r.media ? `📎 ${r.media_name||'media'}` : '(no text)')}</small>
                <small style={{color:'var(--muted)',fontSize:'0.68rem'}}>Reported by {r.reporter_nickname||r.reporter_username} · <span className="report-cat">{r.category}</span> · {r.reason} · {timeAgo(r.reported_at)}</small>
              </div>
              <div className="admin-actions">
                <button className="danger" onClick={() => modReveal(r,'remove')}>🗑 Remove</button>
                <button onClick={() => modReveal(r,'ban')}>🚫 Ban author</button>
                <button className="ghost" onClick={() => dismissReveal(r)}>Dismiss</button>
              </div>
            </div>
          ))}
          <h3 style={{marginTop:'1rem'}}>📹 Reveal posting bans</h3>
          <form onSubmit={addRevealBan} className="mini" style={{marginBottom:'0.6rem'}}>
            <select value={banForm.userId} onChange={e=>setBanForm({...banForm,userId:e.target.value})}>
              <option value="">Select user to ban…</option>
              {(users||[]).filter(u=>!u.is_bot).map(u => <option key={u.id} value={u.id}>{u.nickname||u.username}</option>)}
            </select>
            <input placeholder="Reason (optional)" value={banForm.reason} onChange={e=>setBanForm({...banForm,reason:e.target.value})} />
            <button>🚫 Ban from posting</button>
          </form>
          {revealBans.length === 0 && <p className="muted-text">No active Reveal bans.</p>}
          {revealBans.map(b => (
            <div key={b.user_id} className="log-item">
              <span className="log-action">BANNED</span>
              <span>{b.nickname||b.username} {b.reason ? `— ${b.reason}` : ''}</span>
              <button className="ghost" onClick={() => removeRevealBan(b.user_id)}>Unban</button>
            </div>
          ))}
        </>
      )}

      {tab==='quests' && <AdminQuests />}

      {tab==='create' && (
        <form onSubmit={createAdmin} className="mini">
          <input placeholder="New admin username" value={newAdmin.username} onChange={e=>setNewAdmin({...newAdmin,username:e.target.value})} />
          <input placeholder="Password (blank = auto)" type="password" value={newAdmin.password} onChange={e=>setNewAdmin({...newAdmin,password:e.target.value})} />
          <button>Create Admin</button>
          {created?.temporaryPassword&&<div className="notice">Temp password: <code>{created.temporaryPassword}</code></div>}
        </form>
      )}
    </section>
  );
}

// ── Legitimate data-request reviewer ──────────────────────────────────────────
// Submit a request for a user's data, review incoming requests (approve the exact
// record groups to share, or deny), and track the status of outgoing requests.
const DATA_SURFACE_LABELS = [
  ['channel', '💬 Channel messages'], ['dm', '📩 DMs'], ['group', '👥 Group messages'],
  ['edits', '✏️ Message edits'], ['reactions', '👍 Reactions'], ['rooms', '🎙 Room messages'],
  ['revealPosts', '📹 Reveal posts'], ['revealComments', '💬 Reveal comments'],
];
function DataRequestModal({ open, mode, targetUser, me, onClose, notify }) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [incoming, setIncoming] = useState([]);
  const [outgoing, setOutgoing] = useState([]);
  const [active, setActive] = useState(null); // selected incoming request under review
  const [selected, setSelected] = useState({}); // surface name -> bool
  const [redacted, setRedacted] = useState({}); // surface name -> record indexes
  const [note, setNote] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    setRefreshing(true);
    const [i, o] = await Promise.all([
      api('/api/data-requests/incoming').catch(()=>[]),
      api('/api/data-requests/outgoing').catch(()=>[])
    ]);
    setIncoming(Array.isArray(i)?i:[]);
    setOutgoing(Array.isArray(o)?o:[]);
    setRefreshing(false);
  }
  useEffect(()=>{ if(open) load(); },[open]);

  async function submit(e) {
    e.preventDefault();
    if (!targetUser) return notify('No target selected','err');
    setSubmitting(true);
    const d = await api('/api/data-requests', { method:'POST', body: JSON.stringify({ targetId: targetUser.id, reason }) });
    setSubmitting(false);
    if (d.error) notify(d.error, 'err');
    else { notify('Request submitted — the account owner has been notified','ok'); setReason(''); onClose(); }
  }
  async function openReview(r) {
    const d = await api(`/api/data-requests/${r.id}`);
    if (!d || d.error) return notify((d&&d.error)||'Could not load request','err');
    setActive(d);
    const sel = {};
    (d.approvedSurfaces||[]).forEach(k=>sel[k]=true);
    setSelected(sel); setRedacted({}); setNote(d.note||'');
  }
  async function approve() {
    const approved = DATA_SURFACE_LABELS.filter(([k])=>selected[k]).map(([k])=>k);
    const redactions = Object.fromEntries(Object.entries(redacted).filter(([k])=>approved.includes(k) && Array.isArray(redacted[k]) && redacted[k].length).map(([k,v])=>[k,v]));
    const d = await api(`/api/data-requests/${active.id}/approve`, { method:'POST', body: JSON.stringify({ approvedSurfaces: approved, redactions, note }) });
    if (d.error) return notify(d.error,'err');
    notify(`Approved ${d.approvedSurfaceCount} record group(s) to share`,'ok');
    setActive(null); load();
  }
  async function deny() {
    const d = await api(`/api/data-requests/${active.id}/deny`, { method:'POST', body: JSON.stringify({ note }) });
    if (d.error) return notify(d.error,'err');
    notify('Data request denied','ok');
    setActive(null); load();
  }
  if (!open) return null;
  return (
    <div className="menu-overlay" onClick={onClose}>
      <div className="menu-modal data-req-modal" onClick={e=>e.stopPropagation()}>
        <div className="menu-modal-header">
          <h2>📋 Data Requests</h2>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="menu-modal-body">
          <p className="muted-text" style={{fontSize:'0.78rem'}}>For legitimate data/investigative requests. You may submit a request; the account owner is notified, reviews the reason, and approves exactly which record groups get shared.</p>

          {targetUser && (
            <div className="data-req-submit">
              <h3>Request data from {targetUser.nickname || targetUser.username}</h3>
              <form onSubmit={submit}>
                <textarea value={reason} maxLength={1000} rows={3} placeholder="Explain why you need this data (e.g. case number, jurisdiction, purpose)…" onChange={e=>setReason(e.target.value)} />
                <button type="submit" disabled={submitting || !reason.trim()}>{submitting?'Sending…':'Submit request'}</button>
              </form>
            </div>
          )}

          <div className="data-req-or">＋ or view</div>

          <h3>Incoming — requests for your account</h3>
          <div className="data-req-list">
            {!incoming.length && <p className="empty-text">No incoming requests.</p>}
            {incoming.map(r => (
              <div key={r.id} className="data-req-row">
                <div className="data-req-meta">
                  <b>{r.requester}</b>
                  <small className={`data-req-status ${r.status}`}>{r.status} · {timeAgo(r.created_at)}</small>
                  <p>{r.reason}</p>
                </div>
                {r.status === 'pending' && <button className="mini-btn" onClick={()=>openReview(r)}>📂 Review</button>}
                {r.status !== 'pending' && <small className="muted-text" style={{fontSize:'0.72rem'}}>{r.note}</small>}
              </div>
            ))}
          </div>

          <h3>Outgoing — your requests</h3>
          <div className="data-req-list">
            {!outgoing.length && <p className="empty-text">No outgoing requests.</p>}
            {outgoing.map(r => (
              <div key={r.id} className="data-req-row">
                <div className="data-req-meta">
                  <b>{r.target}</b>
                  <small className={`data-req-status ${r.status}`}>{r.status} · {timeAgo(r.created_at)}</small>
                  <p>{r.reason}</p>
                </div>
                {r.status === 'approved' && <button className="mini-btn" onClick={()=>openReview(r)}>👁 View shared</button>}
                {r.status === 'denied' && r.note && <small className="muted-text" style={{fontSize:'0.72rem'}}>{r.note}</small>}
              </div>
            ))}
          </div>

          {active && (
            <div className="data-req-review">
              <div className="data-req-review-hdr">
                <h3>{active.status === 'approved' && active.sharedData ? 'Shared records' : active.status === 'denied' ? 'Denied request' : `Review request from ${(incoming.find(i=>i.id===active.id)||{}).requester||me.username}`}</h3>
                <button className="icon-btn" onClick={()=>setActive(null)}>✕</button>
              </div>
              {active.pendingData && (
                <>
                  <p className="muted-text" style={{fontSize:'0.78rem'}}>Select which record groups to share with { (incoming.find(i=>i.id===active.id)||{}).requester || 'the requester' }:</p>
                  <div className="data-req-surface-grid">
                    {DATA_SURFACE_LABELS.map(([k,label]) => {
                      const list = active.pendingData[k] || [];
                      return (
                        <label key={k} className="data-req-surface">
                          <input type="checkbox" checked={Boolean(selected[k])} onChange={e=>setSelected(x=>({...x,[k]:e.target.checked}))} />
                          <span>{label} ({list.length})</span>
                          {list.length > 0 && <details className="data-req-sample" onClick={e=>e.stopPropagation()}>
                            <div className="data-req-redact-note">Check records to redact before approval:</div>
                            <summary>Preview sample</summary>
                            {list.slice(0,10).map((item,i)=><label key={i} className="data-req-sample-row"><input type="checkbox" checked={(redacted[k]||[]).includes(i)} onChange={e=>setRedacted(prev=>({...prev,[k]:e.target.checked?[...(prev[k]||[]),i]:(prev[k]||[]).filter(x=>x!==i)}))} /><b>{item.sender || item.sender_name || item.roomType || item.emoji || item.type || 'record'}</b><small>{item.createdAt || item.created_at || item.edited_at || 'Undated'}</small><span>{item.body || item.messageBody || item.old_body || item.channelName || item.groupName || '(record)'}</span></label>)}
                          </details>}
                        </label>
                      );
                    })}
                  </div>
                  <textarea value={note} maxLength={500} rows={2} placeholder="Note to the requester…" onChange={e=>setNote(e.target.value)} />
                  <div className="data-req-actions">
                    <button className="danger-btn" onClick={deny}>✕ Deny</button>
                    <button onClick={approve}>✓ Approve selected</button>
                  </div>
                </>
              )}
              {active.status === 'approved' && active.sharedData && (
                <div className="data-req-shared">
                  {!Object.keys(active.sharedData).length && <p className="empty-text">No record groups were shared.</p>}
                  {Object.entries(active.sharedData).map(([k,list]) => (
                    <details key={k} className="data-req-shared-group">
                      <summary>{DATA_SURFACE_LABELS.find(x=>x[0]===k)?.[1]||k} ({list.length})</summary>
                      {list.map((item,i) => (
                        <div key={i} className="legal-msg">
                          <b>{item.sender || item.roomType || item.emoji || item.type || 'record'}</b>
                          <small>{timeAgo(item.createdAt) || timeAgo(item.edited_at)}</small>
                          <p>{item.body || item.messageBody || item.old_body || ''}</p>
                        </div>
                      ))}
                    </details>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
function App() {
  const device = useDeviceProfile();
  const [checking, setChecking] = useState(Boolean(getToken()));
  const [me, setMe]   = useState(null);
  const [boot, setBoot] = useState(null);
  const [bootError, setBootError] = useState('');
  const [view, setView] = useState('server'); // server|dm|friends|discover|group
  const [communityId, setCommunityId] = useState(null);
  const [cosmeticEffects, setCosmeticEffects] = useState([]);
  const [channelId, setChannelId]     = useState(null);
  const [dmId, setDmId]               = useState(null);
  const [groupId, setGroupId]         = useState(null);
  const [theme, setTheme]             = useState(localStorage.theme || 'dark');
  const [notice, setNotice]           = useState('');
  const [noticeType, setNoticeType]   = useState('warn');
  const [showSettings, setShowSettings] = useState(false);
  const [showAdminMenu, setShowAdminMenu] = useState(false);
  const [showOwnerHistory, setShowOwnerHistory] = useState(false);
  const [showGame, setShowGame]         = useState(false);
  const [gamePick, setGamePick]         = useState(null);
  const [showNotifs, setShowNotifs]     = useState(false);
  const [showSearch, setShowSearch]     = useState(false);
  const [showRightPanel, setShowRightPanel] = useState(true);
  const [showMobileChannels, setShowMobileChannels] = useState(false);
  const [rightTab, setRightTab]           = useState('members');
  const [viewingProfile, setViewingProfile] = useState(null);
  const [dataReq, setDataReq] = useState({ open:false, mode:'review', target:null });
  const [unread, setUnread] = useState({});
  const [pings, setPings]   = useState({});
  const [reminderPings, setReminderPings] = useState(0);
  const [activeCall, setActiveCall] = useState(null);
  const [incomingCall, setIncomingCall] = useState(null);
  const [globalEvent, setGlobalEvent] = useState(null);
  const [announcement, setAnnouncement] = useState(null);
  const [challenge, setChallenge] = useState(null);
  const [challengeGone, setChallengeGone] = useState(() => readLocalObject('challengeGone'));
  const [showRewards, setShowRewards] = useState(false);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [jumpToMessageId, setJumpToMessageId] = useState(null);
  const [rooms, setRooms] = useState([]);
  const [activeRoomId, setActiveRoomId] = useState(null);
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [ftdGlitch, setFtdGlitch] = useState(false);
  const [showArg, setShowArg] = useState(false);
  const [screenshotWarn, setScreenshotWarn] = useState(false);
  const [dismissed, setDismissed] = useState(() => readLocalObject('screenshotDismissed'));
  const [newGroupModal, setNewGroupModal] = useState(false);
  const [createGroupName, setCreateGroupName] = useState('');
  const [createGroupMembers, setCreateGroupMembers] = useState([]);
  const socket = useMemo(() => io({ autoConnect: false, transports: ['websocket'] }), []);

  useEffect(() => { applyTheme(theme); localStorage.theme = theme; }, [theme]);

  useEffect(() => {
    if (!me) return;
    const onNotification = ({ message, toast }) => {
      if (toast) notify(toast, 'warn');
      if (message?.body && 'Notification' in window && Notification.permission === 'granted') {
        new Notification('Unknown', { body: message.body, icon: '/assets/unknown-logo-dark.png' });
      }
    };
    socket.on('notification', onNotification);
    return () => socket.off('notification', onNotification);
  }, [me, socket]);

  useEffect(() => {
    if (!getToken()) { setChecking(false); return; }
    api('/api/bootstrap').then(d => {
      if (d.error) {
        if (d.status === 401 || d.status === 403) clearToken();
        setBootError(d.error);
        setChecking(false);
        return;
      }
      setMe(d.me);
      setBoot(d);
      // Only auto-open a community the user actually belongs to; otherwise land on
      // the guided start state (Discover / create / friends) instead of a denied server.
      const joinedIds = new Set((d.memberships || []).map(m => m.community_id));
      const firstComm = (d.communities || []).find(c => joinedIds.has(c.id)) || null;
      if (firstComm) {
        setCommunityId(firstComm.id);
        const firstCh = d.channels?.find(c => c.community_id===firstComm.id && c.type!=='voice');
        if (firstCh) setChannelId(firstCh.id);
      } else {
        setCommunityId(null);
        setChannelId(null);
      }
      if (d.events?.length) setGlobalEvent(d.events[0]);
      setChallenge(d.challenge || null);
      setBootError('');
      api('/api/announcement').then(r => { if (r && !r.error) setAnnouncement(r.announcement || null); }).catch(()=>{});
      api('/api/challenges').then(r => { if (r && !r.error && r.challenge) setChallenge(r.challenge); }).catch(()=>{});
      refreshBookmarks();
      setChecking(false);
    }).catch(error => {
      setBootError(`Unable to load your account: ${error.message || 'network error'}`);
      setChecking(false);
    });
  }, []);

  // FTD easter egg: 0.0001% chance the feed rots after login. One shot per session.
  useEffect(() => {
    if (!me || ftdGlitch || showArg || sessionStorage.ftdGlitchShown) return;
    const roll = Math.random();
    if (roll < 0.000001) {
      sessionStorage.ftdGlitchShown = '1';
      setFtdGlitch(true);
    }
  }, [me]);
  useEffect(() => { window.__forceFtd = () => { sessionStorage.ftdGlitchShown = '1'; setFtdGlitch(true); setShowArg(false); }; }, []);

  // Refresh boot periodically for live updates
  useEffect(() => {
    const t = setInterval(() => {
      if (getToken()) api('/api/bootstrap').then(d => { if (!d.error) setBoot(b => ({...b, ...d})); }).catch(()=>{});
    }, 30000);
    return () => clearInterval(t);
  }, []);  useEffect(() => {
    if (!socket || !me) return;
    socket.auth = { token: getToken() };
    const joinRooms = () => {
      socket.emit('join_user', me.id);
      (boot?.dms || []).forEach(dm => socket.emit('join_dm', dm.id));
      (boot?.groups || []).forEach(g => socket.emit('join_group', g.id));
    };
    const onSocketError = error => notify(`Live updates unavailable: ${error.message || 'connection failed'}`, 'err');
    const onUserUpdate = u => {
      setBoot(b => b ? { ...b, users: b.users.map(x => x.id === u.id ? { ...x, ...u } : x) } : b);
      if (u.id === me.id) setMe(m => ({ ...m, ...u }));
    };
    const onNewDm = dm => { setBoot(b => b ? { ...b, dms: [...(b.dms || []), dm] } : b); socket.emit('join_dm', dm.id); };
    const onNewGroup = g => { setBoot(b => b ? { ...b, groups: [...(b.groups || []), g] } : b); socket.emit('join_group', g.id); };
    const onDmNotification = ({dmId:id}) => setUnread(u => ({...u, [`dm:${id}`]:(u[`dm:${id}`]||0)+1}));
    const onChannelActivity = ({channelId:cid}) => { if (cid !== channelId) setUnread(u => ({...u, [cid]:(u[cid]||0)+1})); };
    const onLiveNotification = ({type,message,reminder}) => {
      if (type === 'ping' && message?.channel_id) setPings(p => ({...p, [message.channel_id]:(p[message.channel_id]||0)+1}));
      if (type === 'reminder') { setReminderPings(c => c + 1); notify(`⏰ ${reminder?.preview||'Reminder!'}`, 'ok'); }
    };
    const onGlobalEvent = ev => setGlobalEvent(ev);
    const onGlobalEventEnd = ({id}) => setGlobalEvent(ge => ge?.id === id ? null : ge);
    const onGlobalAnnouncement = a => setAnnouncement(a);
    const onChallengeRoll = ch => {
      if (!ch) return;
      notify(`🎯 New daily challenge: ${ch.title} — ${ch.desc} (+${ch.reward}✦)`, 'ok');
      setChallenge(ch);
      setChallengeGone(g => { const n = {...g}; delete n[ch.id]; localStorage.challengeGone = JSON.stringify(n); return n; });
    };
    const onCallInvite = d => setIncomingCall(d);
    const onCommunityLocked = () => setBoot(b => b ? {...b} : b);
    // Presence snapshot from the server (pushed on connect/reconnect and after
    // each heartbeat). DB-backed, so it converges statuses even when a
    // user_update event was missed or fired on another app instance.
    const onPresenceSync = list => {
      if (!Array.isArray(list)) return;
      const byId = new Map(list.map(u => [u.id, u]));
      setBoot(b => {
        if (!b) return b;
        let changed = false;
        const users = (b.users || []).map(u => {
          const p = byId.get(u.id);
          if (!p || (u.status || '') === (p.status || '') && (u.custom_status || '') === (p.custom_status || '')) return u;
          changed = true;
          return { ...u, status: p.status, custom_status: p.custom_status };
        });
        return changed ? { ...b, users } : b;
      });
      const self = me && byId.get(me.id);
      if (self) setMe(m => (m.status || '') === (self.status || '') && (m.custom_status || '') === (self.custom_status || '') ? m : { ...m, status: self.status, custom_status: self.custom_status });
    };
    socket.on('connect', joinRooms);
    socket.on('connect_error', onSocketError);
    if (!socket.connected) socket.connect();
    else joinRooms();
    socket.on('user_update', onUserUpdate);
    socket.on('new_dm', onNewDm);
    socket.on('new_group', onNewGroup);
    socket.on('dm_notification', onDmNotification);
    socket.on('channel_activity', onChannelActivity);
    socket.on('notification', onLiveNotification);
    socket.on('global_event', onGlobalEvent);
    socket.on('global_event_end', onGlobalEventEnd);
    socket.on('global_announcement', onGlobalAnnouncement);
    socket.on('challenge_roll', onChallengeRoll);
    socket.on('call_invite', onCallInvite);
    socket.on('community_locked', onCommunityLocked);
    socket.on('presence_sync', onPresenceSync);
    // Presence heartbeat: periodically pull the DB-backed snapshot so statuses
    // apply even if a user_update event was missed or happened on another
    // instance. The server also pushes a snapshot on every (re)connect.
    const heartbeat = setInterval(() => { if (socket.connected) socket.emit('presence_heartbeat'); }, 30000);
    return () => {
      clearInterval(heartbeat);
      socket.off('connect', joinRooms); socket.off('connect_error', onSocketError);
      socket.off('user_update', onUserUpdate); socket.off('new_dm', onNewDm); socket.off('new_group', onNewGroup);
      socket.off('dm_notification', onDmNotification); socket.off('channel_activity', onChannelActivity); socket.off('notification', onLiveNotification);
      socket.off('global_event', onGlobalEvent); socket.off('global_event_end', onGlobalEventEnd); socket.off('global_announcement', onGlobalAnnouncement);
      socket.off('challenge_roll', onChallengeRoll); socket.off('call_invite', onCallInvite); socket.off('community_locked', onCommunityLocked);
      socket.off('presence_sync', onPresenceSync);
    };
  }, [socket, me, channelId, boot?.dms, boot?.groups]);

  function notify(msg, type='warn') { setNotice(msg); setNoticeType(type); setTimeout(()=>setNotice(''),4000); }
  async function logout() {
    await api('/api/logout', { method:'POST' }).catch(() => {});
    clearToken();
    socket.disconnect();
    location.reload();
  }

  // One-click quick-swap: cycles through the current server's starred masks (or global, or back to real).
  async function quickSwapMask() {
    const serverFavs = view === 'server' ? serverFavMasks(me, communityId) : null;
    const comm = view === 'server' ? boot?.communities?.find(c => c.id === communityId) : null;
    const pinned = comm?.pinned_mask ? ((boot?.masks || []).find(m => m.name === comm.pinned_mask) || { name: comm.pinned_mask }) : null;
    const favs = serverFavs || parseFavMasks(me);
    const effectiveFavs = favs.length ? favs : (pinned ? [pinned] : []);
    if (!effectiveFavs.length) return notify(serverFavs ? 'No masks starred for this server — set them in Settings → Anonymous' : 'No quick-swap masks set — star masks in Settings → Anonymous', 'err');
    if (me?.anon_active && effectiveFavs.some(f => f.name === me?.anon_mask)) {
      // Wearing a starred mask — move to the next one (or back to real after the last).
      const idx = effectiveFavs.findIndex(f => f.name === me.anon_mask);
      const next = effectiveFavs[idx + 1] || null;
      if (!next) {
        const d = await api('/api/me/anonymous', { method: 'DELETE' }).catch(()=>null);
        if (d && !d.error) { setMe(m => ({ ...m, anon_active: false, anon_mask: '', anon_color: '', anon_emoji: '' })); notify('Swapped back to your real identity', 'ok'); }
        return;
      }
      const d = await api('/api/me/anonymous', { method: 'POST', body: JSON.stringify({ maskName: next.name }) }).catch(()=>null);
      if (d && !d.error) {
        setMe(m => ({ ...m, anon_active: true, anon_mask: next.name, anon_color: next.color, anon_emoji: next.emoji }));
        notify(`Swapped to ${next.name.replace(/\S+\s+/,'')}`, 'ok');
      }
      return;
    }
    // Real identity (or non-starred mask) — activate the first starred mask.
    const first = effectiveFavs[0];
    const d = await api('/api/me/anonymous', { method: 'POST', body: JSON.stringify({ maskName: first.name }) }).catch(()=>null);
    if (d && !d.error) {
      setMe(m => ({ ...m, anon_active: true, anon_mask: first.name, anon_color: first.color, anon_emoji: first.emoji }));
      notify(`Swapped to ${first.name.replace(/\S+\s+/,'')}`, 'ok');
    }
  }

  function chooseChannel(id) {
    setChannelId(id); setActiveRoomId(null); setView('server'); setShowMobileChannels(false);
    setUnread(u=>{const n={...u};delete n[id];return n;});
    setPings(p=>{const n={...p};delete n[id];return n;});
    // Show screenshot warning once per server
    if (communityId && !dismissed[communityId]) setScreenshotWarn(true);
  }

  function chooseCommunity(id) {
    const isMember = (boot?.memberships || []).some(m => m.community_id === id);
    if (!isMember && !me?.is_admin) {
      notify('Join this community from Discover first','warn');
      setView('discover');
      setShowMobileChannels(false);
      return;
    }
    setCommunityId(id); setActiveRoomId(null); setShowMobileChannels(false);
    const firstCh = boot?.channels?.find(c=>c.community_id===id&&c.type!=='voice');
    if (firstCh) chooseChannel(firstCh.id); else setChannelId(null);
    setView('server');
    // Platform admins may open any server for moderation.
  }

  // Load temporary rooms for the current community
  useEffect(() => {
    if (!communityId) { setRooms([]); return; }
    api(`/api/rooms?communityId=${communityId}`).then(d => { if (!d.error) setRooms(d); }).catch(()=>{});
  }, [communityId]);

  // Load server cosmetics (profile effects for the member list)
  useEffect(() => {
    if (!communityId) { setCosmeticEffects([]); return; }
    api(`/api/marketplace/cosmetics?communityId=${communityId}`).then(d => {
      if (!d.error) setCosmeticEffects(d.effects || []);
    }).catch(()=>{});
  }, [communityId]);

  useEffect(() => {
    if (!socket) return;
    const onRoomUpdate = () => { if (communityId) api(`/api/rooms?communityId=${communityId}`).then(d => { if (!d.error) setRooms(d); }).catch(()=>{}); };
    socket.on('room_update', onRoomUpdate);
    return () => socket.off('room_update', onRoomUpdate);
  }, [socket, communityId]);

  function chooseDm(id) { setDmId(id); setActiveRoomId(null); setView('dm'); setShowMobileChannels(false); socket.emit('join_dm',id); setUnread(u=>{const n={...u};delete n[`dm:${id}`];return n;}); }
  function chooseGroup(id) { setGroupId(id); setActiveRoomId(null); setView('group'); setShowMobileChannels(false); }

  async function openDm(userId) {
    const d = await api('/api/dms',{method:'POST',body:JSON.stringify({userId})});
    if (d.dm) { setBoot(b=>({...b,dms:[...(b.dms||[]).filter(x=>x.id!==d.dm.id),d.dm]})); chooseDm(d.dm.id); }
    setViewingProfile(null);
  }

  async function createGroup(e) {
    e.preventDefault();
    const d = await api('/api/groups',{method:'POST',body:JSON.stringify({name:createGroupName,members:createGroupMembers})});
    if (d.id) { api('/api/bootstrap').then(b=>{if(!b.error)setBoot(b);}); setNewGroupModal(false); chooseGroup(d.id); }
  }

  function jumpToBookmark(b) {
    setShowBookmarks(false);
    const targetMsg = b.message_id || b.id || null;
    if (b.channel_id && b.community_id) {
      setJumpToMessageId(targetMsg);
      setCommunityId(b.community_id); chooseChannel(b.channel_id);
    }
    else if (b.dm_id) {
      setJumpToMessageId(targetMsg);
      const other = b.user_a === me.id ? b.user_b : b.user_a;
      const existing = (boot?.dms||[]).find(x => x.id === b.dm_id);
      if (existing) chooseDm(b.dm_id);
      else if (other) openDm(other);
    }
    else if (b.group_id) { setJumpToMessageId(targetMsg); chooseGroup(b.group_id); }
  }

  function dismissScreenshot() {
    const next = {...dismissed,[communityId]:true};
    setDismissed(next); localStorage.screenshotDismissed = JSON.stringify(next);
    setScreenshotWarn(false);
  }

  // 🎲 DO SOMETHING RANDOM — picks a random action each press
  const randItem = a => a[Math.floor(Math.random()*a.length)];
  async function doSomethingRandom() {
    const act = randItem(['game','channel','user','prompt','poll','challenge']);
    if (act === 'game') {
      setGamePick(randItem(['guess','wyr','truth','trivia','scramble']));
      setShowGame(true);
      notify('🎮 Random pick: play a mini game!','ok');
    } else if (act === 'channel') {
      const textChs = (boot?.channels||[]).filter(c=>c.type!=='voice');
      if (!textChs.length) { notify('No channels to jump to yet','warn'); return; }
      const ch = randItem(textChs);
      const c = boot?.communities?.find(x=>x.id===ch.community_id);
      setCommunityId(ch.community_id);
      chooseChannel(ch.id);
      notify(`📍 Random pick: jump to #${ch.name} in ${c?.name||'a server'}!`,'ok');
    } else if (act === 'user') {
      const others = (boot?.users||[]).filter(u=>u.id!==me.id);
      if (!others.length) { notify('No users to recommend yet','warn'); return; }
      const u = randItem(others);
      notify(`💬 Random pick: say hi to ${u.nickname||u.username}!`,'ok');
      openDm(u.id);
    } else if (act === 'prompt') {
      notify('❓ '+randItem(RANDOM_PROMPTS),'ok');
    } else if (act === 'poll') {
      const p = randItem(RANDOM_POLLS);
      const target = {};
      if (view==='server' && channelId) target.channelId = channelId;
      else if (view==='dm' && dmId)     target.dmId = dmId;
      else if (view==='group' && groupId) target.groupId = groupId;
      if (!target.channelId && !target.dmId && !target.groupId) { notify('Open a chat first so the poll has somewhere to land','warn'); return; }
      const d = await api('/api/polls',{method:'POST',body:JSON.stringify({question:p.q,options:p.opts,...target})});
      if (d.error) notify(d.error,'err');
      else notify('📊 Random poll dropped in chat — go vote!','ok');
    } else if (act === 'challenge') {
      const d = await api('/api/challenges/roll',{method:'POST'});
      if (d.error) { notify(d.error,'err'); return; }
      if (d.challenge) {
        notify(`🎯 Daily challenge rolled: ${d.challenge.title} — ${d.challenge.desc} (+${d.challenge.reward}✦)`,'ok');
        setShowRewards(true);
      }
    }
  }

  // Subscribed before any early return so the hook order never changes across auth states.
  const { items: bookmarkItems } = useBookmarks();
  const bmCount = bookmarkItems.length;

  if (checking) return (
    <main className="auth splash">
      <div className="splash-inner">
        <Mascot size={100} mood="happy" />
        <div className="spinner" />
        <h2>Unknown</h2>
      </div>
    </main>
  );
  if (!me) return <Auth initialError={bootError} onAuth={() => location.reload()} />;

  const comm        = boot?.communities?.find(c=>c.id===communityId);
  const activeCh    = boot?.channels?.find(c=>c.id===channelId);
  const activeDm    = boot?.dms?.find(d=>d.id===dmId);
  const activeGroup = boot?.groups?.find(g=>g.id===groupId);
  const totalUnread = Object.values(unread).reduce((a,b)=>a+b,0);
  const totalPings  = Object.values(pings).reduce((a,b)=>a+b,0);
  const currentServer = view === 'server' ? boot?.communities?.find(c => c.id === communityId) : null;
  const currentServerPinnedMask = currentServer?.pinned_mask ? ((boot?.masks || []).find(m => m.name === currentServer.pinned_mask) || { name: currentServer.pinned_mask }) : null;
  const swapHint = nextSwapLabel(me, view === 'server' ? serverFavMasks(me, communityId) : null, currentServerPinnedMask);

  return (
    <div className={`app device-${device.formFactor} orientation-${device.orientation}${device.compact ? ' compact-ui' : ''} input-${device.input}`} data-device={JSON.stringify(device)}>
      {/* Global event banner */}
      {globalEvent && (
        <div className="global-event-banner">
          🎉 <b>{globalEvent.title}</b> — {globalEvent.description}
          <button onClick={() => setGlobalEvent(null)}>✕</button>
        </div>
      )}

      {/* Global announcement banner (admin broadcast; individual users can close) */}
      {announcement && (
        <div className="announcement-banner">
          {announcement.title && <b>📢 {announcement.title}: </b>}
          <span>{announcement.body}</span>
          <button className="icon-btn" title="Dismiss" onClick={() => setAnnouncement(null)}>✕</button>
        </div>
      )}

      {/* Daily challenge banner (server-wide roll; dismissible per challenge) */}
      {challenge && !challengeGone[challenge.id] && (
        <div className="challenge-banner">
          <span className="challenge-banner-icon">🎯</span>
          <div className="challenge-banner-text">
            <b>Daily challenge: {challenge.title}</b>
            <span>{challenge.desc} · +{challenge.reward}✦</span>
          </div>
          <button className="challenge-banner-go" onClick={() => setShowRewards(true)}>View quests</button>
          <button className="icon-btn" title="Dismiss" onClick={() => setChallengeGone(g => { const n={...g,[challenge.id]:true}; localStorage.challengeGone = JSON.stringify(n); return n; })}>✕</button>
        </div>
      )}

      {/* Anonymous mode banner */}
      {me.anon_active && (
        <div className="anon-banner">
          <span className="anon-banner-avatar" style={{ background: maskGradient(me.anon_color) }}>{me.anon_emoji || me.anon_mask?.split(' ')?.[0] || '🎭'}</span> You are anonymous as <b style={{ color: me.anon_name_color || nameColor(me.anon_mask || '') }}>{me.anon_mask}</b>
          <button onClick={() => api('/api/me/anonymous',{method:'DELETE'}).then(()=>location.reload())}>Deactivate</button>
        </div>
      )}

      {/* Screenshot warning */}
      {screenshotWarn && (
        <div className="screenshot-warn-overlay">
          <div className="screenshot-warn-box">
            <h3>⚠ Heads up</h3>
            <p>Anyone in this server can screenshot chats. <b>Never share personal information.</b></p>
            <button onClick={dismissScreenshot}>Got it</button>
          </div>
        </div>
      )}

      {/* Incoming call */}
      {incomingCall && !activeCall && (
        <CallModal socket={socket} me={me} targetUser={{id:incomingCall.from, username:incomingCall.fromUsername}} dmId={incomingCall.dmId}
          incoming initialOffer={incomingCall} onClose={()=>setIncomingCall(null)} />
      )}

      {/* Active call */}
      {activeCall && (
        <CallModal socket={socket} me={me} targetUser={activeCall} dmId={activeCall.dmId}
          incoming={false} onClose={()=>setActiveCall(null)} />
      )}

      {/* Settings */}
      {showSettings && (
        <Suspense fallback={<div className="lazy-loading" role="status"><span className="spinner sm" /> Loading settings…</div>}>
          <Settings me={me} boot={boot} onClose={()=>setShowSettings(false)} onSave={u=>setMe(m=>({...m,...u}))} onOpenDataRequests={()=>{setShowSettings(false);setDataReq({open:true,mode:'review',target:null});}} currentTheme={theme} onThemeChange={t=>{setTheme(t);applyTheme(t);}} />
        </Suspense>
      )}

      {/* Rewards / Credits modal */}
      {showRewards && <RewardsModal me={me} onClose={()=>setShowRewards(false)} notify={notify}
        onCredits={c=>setMe(m=>({...m,credits:c}))} />}

      {/* Bookmarks modal */}
      {showBookmarks && <BookmarksModal onClose={()=>setShowBookmarks(false)} onJump={jumpToBookmark} notify={notify} />}

      {/* Admin menu */}
      {showAdminMenu && <div className="menu-overlay" onClick={()=>setShowAdminMenu(false)}><div className="menu-modal" onClick={e=>e.stopPropagation()}><div className="menu-modal-header"><h2>Administrator Menu</h2><button className="icon-btn" onClick={()=>setShowAdminMenu(false)}>✕</button></div><div className="menu-modal-body"><AdminPanel me={me} onNotice={notify} boot={boot} onBootRefresh={()=>api('/api/bootstrap').then(d=>{if(!d.error)setBoot(d);})} /><RolesPanel comm={comm} boot={boot} onNotice={notify} onBootRefresh={()=>api('/api/bootstrap').then(d=>{if(!d.error)setBoot(d);})} /></div></div></div>}
      {showOwnerHistory && <OwnerHistoryModal me={me} boot={boot} onClose={()=>setShowOwnerHistory(false)} notify={notify} />}

      {/* FTD easter egg: 0.0001% rot screen */}
      {ftdGlitch && !showArg && <FtdEasterEgg onClose={()=>setFtdGlitch(false)} onOpenArg={()=>{ setFtdGlitch(false); setShowArg(true); }} />}
      {showArg && <ArgModal onClose={()=>setShowArg(false)} notify={notify} />}

      {/* Create room modal */}
      {showCreateRoom && comm && <CreateRoomModal communityId={comm.id} notify={notify}
        onClose={()=>setShowCreateRoom(false)}
        onCreated={r=>{ setRooms(x=>[...x.filter(y=>y.id!==r.id), r]); setActiveRoomId(r.id); }} />}

      {/* Game */}
      {showGame && (
        <Suspense fallback={<div className="lazy-loading" role="status"><span className="spinner sm" /> Loading games…</div>}>
          <Game onClose={()=>{setShowGame(false); setGamePick(null);}} me={me}
            shareTarget={view==='server'&&channelId?{channelId}:view==='dm'&&dmId?{dmId}:view==='group'&&groupId?{groupId}:null}
            initial={gamePick}
            onLog={(game,result)=>api('/api/games/log',{method:'POST',body:JSON.stringify({game,result})}).catch(()=>{})}
            onShare={async text => {
              if (view==='server' && channelId) return api(`/api/channels/${channelId}/messages`,{method:'POST',body:JSON.stringify({body:text})});
              if (view==='dm' && dmId) return api(`/api/dms/${dmId}/messages`,{method:'POST',body:JSON.stringify({body:text})});
              if (view==='group' && groupId) return api(`/api/groups/${groupId}/messages`,{method:'POST',body:JSON.stringify({body:text})});
              return {error:'no chat'};
            }} />
        </Suspense>
      )}

      {/* New group modal */}
      {newGroupModal && (
        <div className="modal-overlay" onClick={()=>setNewGroupModal(false)}>
          <div className="modal-box" onClick={e=>e.stopPropagation()}>
            <h3>New Group Chat</h3>
            <form onSubmit={createGroup} className="mini">
              <label>Group name<input value={createGroupName} onChange={e=>setCreateGroupName(e.target.value)} /></label>
              <label>Add members (click)
                <div className="group-member-picker">
                  {(boot?.users||[]).filter(u=>u.id!==me.id).map(u=>(
                    <button key={u.id} type="button"
                      className={`group-member-chip${createGroupMembers.includes(u.id)?' active':''}`}
                      onClick={()=>setCreateGroupMembers(p=>p.includes(u.id)?p.filter(x=>x!==u.id):[...p,u.id])}>
                      <Avatar src={u.avatar} name={u.nickname||u.username} size="xs" />
                      {u.nickname||u.username}
                    </button>
                  ))}
                </div>
              </label>
              <button>Create</button>
            </form>
          </div>
        </div>
      )}

      {/* ── Rail ── */}
      <aside className="rail">
        <button className="rail-icon rail-home" title="Home" onClick={()=>setView('dm')}>
          <span>U</span>
          {totalUnread>0&&<span className="rail-badge">{totalUnread>99?'99+':totalUnread}</span>}
        </button>
        <div className="rail-divider" />
        {boot?.communities?.map(c => {
          const cUnread = (boot?.channels||[]).filter(ch=>ch.community_id===c.id).reduce((a,ch)=>a+(unread[ch.id]||0),0);
          const cPings  = (boot?.channels||[]).filter(ch=>ch.community_id===c.id).reduce((a,ch)=>a+(pings[ch.id]||0),0);
          return (
            <button key={c.id} className={`rail-icon${c.id===communityId&&view==='server'?' active':''}`}
              onClick={()=>chooseCommunity(c.id)} title={c.name}>
              {c.icon?<img src={c.icon} alt=""/>:c.name[0]?.toUpperCase()}
              {cPings>0?<span className="rail-badge ping">{cPings}</span>:cUnread>0?<span className="rail-badge">{cUnread}</span>:null}
            </button>
          );
        })}
        <button className="rail-icon rail-add" title="Add server" onClick={()=>{setCommunityId(null);setView('create-server');}}>+</button>
        <button className="rail-icon rail-rewards" title="Rewards & Shop" onClick={()=>setShowRewards(true)}>🎁{(me.credits||0)>0&&<span className="credit-badge">{me.credits}</span>}</button>
        <div style={{flex:1}} />
        <button className="rail-icon" title="Discover" onClick={()=>setView('discover')}>🌐</button>
        <button className="rail-icon rail-reveal" title="Reveal — social feed" onClick={()=>setView('reveal')}>📹</button>
        <button className="rail-icon" title="Mini games" onClick={()=>{setGamePick(null);setShowGame(true);}}>🎮</button>
        <button className="rail-icon rail-random" title="🎲 Do something random" onClick={doSomethingRandom}>🎲</button>
      </aside>

      {/* ── Channel/DM list ── */}
      <nav className={`channels${showMobileChannels?' mobile-open':''}`}>
        {view==='dm'||view==='friends' ? (
          <DmList me={me} boot={boot} activeDmId={dmId} activeGroupId={groupId} view={view} setView={setView}
            onChooseDm={chooseDm} onChooseGroup={chooseGroup} onViewProfile={setViewingProfile}
            unread={unread} pings={pings} notify={notify}
            onBootRefresh={()=>api('/api/bootstrap').then(d=>{if(!d.error)setBoot(d);})}
            onNewGroup={()=>setNewGroupModal(true)}
            onCloseNav={()=>setShowMobileChannels(false)}
          />
        ) : view==='create-server' ? (
          <CreateServerPanel
            onDone={(id, created)=>{ if (created?.community) { setBoot(b=>({
                ...b,
                communities:[...(b?.communities||[]).filter(x=>x.id!==created.community.id), created.community],
                channels:[...(b?.channels||[]).filter(x=>x.id!==created.channel?.id), created.channel].filter(Boolean),
                memberships:[...(b?.memberships||[]).filter(x=>x.community_id!==created.community.id), {community_id:created.community.id,user_id:me.id,role:'owner'}]
              })); chooseCommunity(id); }
              api('/api/bootstrap').then(d=>{if(!d.error)setBoot(d);}).catch(()=>{}); }}
            onCancel={()=>setView('server')}
          />
        ) : (
          <ServerChannelList comm={comm} boot={boot} me={me} channelId={channelId}
            onChooseChannel={chooseChannel} theme={theme} setTheme={setTheme}
            notify={notify} unread={unread} pings={pings}
            onBootRefresh={()=>api('/api/bootstrap').then(d=>{if(!d.error)setBoot(d);})}
            onCloseNav={()=>setShowMobileChannels(false)}
            onAddChannel={ch=>setBoot(b=>({...b,channels:[...(b?.channels||[]),ch]}))}
            rooms={rooms} activeRoomId={activeRoomId}
            onChooseRoom={id=>{ setActiveRoomId(id); setView('server'); setShowMobileChannels(false); }}
            onCreateRoom={()=>setShowCreateRoom(true)}
          />
        )}
      </nav>

      {/* ── Chat area ── */}
      <main className="chat">
        {notice && <div className={`toast toast-${noticeType}`}><span>{notice}</span><button onClick={()=>setNotice('')}>✕</button></div>}

        {view==='reveal' ? (
          <RevealView me={me} notify={notify} onViewProfile={setViewingProfile} boot={boot} />
        ) : view==='discover' ? (
          <DiscoveryView me={me} boot={boot} notify={notify} currentChannelId={channelId} onBootRefresh={()=>api('/api/bootstrap').then(d=>{if(!d.error)setBoot(d);})} onJoin={async c => {
            const d = await api('/api/communities/join',{method:'POST',body:JSON.stringify({inviteCode:c.invite_code})});
            if (!d.communityId) return notify(d.error||'Could not join that community','err');
            const b = await api('/api/bootstrap');
            if (b && !b.error) setBoot(b);
            // Navigate straight into the joined server using the fresh membership list.
            const joined = b && !b.error ? b : boot;
            const freshMember = (joined.memberships||[]).some(m => m.community_id === d.communityId);
            if (freshMember || me?.is_admin) {
              setCommunityId(d.communityId); setActiveRoomId(null); setShowMobileChannels(false); setView('server');
              const firstCh = (joined.channels||[]).find(c=>c.community_id===d.communityId&&c.type!=='voice');
              if (firstCh) { setChannelId(firstCh.id); setUnread(u=>{const n={...u};delete n[firstCh.id];return n;}); setPings(p=>{const n={...p};delete n[firstCh.id];return n;}); }
              else setChannelId(null);
            } else {
              notify('Joined — reopen the server from your rail','ok');
              setView('server');
            }
          }} />
        ) : view==='friends' ? (
          <FriendsView me={me} boot={boot} onBootRefresh={()=>api('/api/bootstrap').then(d=>{if(!d.error)setBoot(d);})} onOpenDm={openDm} onViewProfile={setViewingProfile} notify={notify} />
        ) : view==='dm' && activeDm ? (
          <DmChat key={dmId} me={me} dm={activeDm} socket={socket} notify={notify} onViewProfile={setViewingProfile}
            onCall={target=>setActiveCall({...target,dmId})} jumpToMessageId={jumpToMessageId} onJumpDone={() => setJumpToMessageId(null)} />
        ) : view==='group' && activeGroup ? (
          <GroupChat key={groupId} me={me} group={activeGroup} socket={socket} notify={notify} onViewProfile={setViewingProfile} jumpToMessageId={jumpToMessageId} onJumpDone={() => setJumpToMessageId(null)} />
        ) : view==='server' && activeRoomId ? (
          <RoomView key={activeRoomId} roomId={activeRoomId} me={me} socket={socket} notify={notify}
            onLaunchGame={g=>{ setGamePick(g); setShowGame(true); }} />
        ) : view==='server' && activeCh ? (
          activeCh.type==='voice'
            ? <VoiceChannel key={channelId} channel={activeCh} me={me} socket={socket} boot={boot} />
            : <ChannelChat key={channelId} me={me} channel={activeCh} comm={comm} socket={socket} notify={notify} onViewProfile={setViewingProfile} boot={boot} jumpToMessageId={jumpToMessageId} onJumpDone={() => setJumpToMessageId(null)} />
        ) : (
          <div className="empty-state">
            <Mascot size={90} mood="thinking" />
            <span className="empty-kicker">Your workspace is ready</span>
            <h2>Choose where to begin</h2>
            <p>Join a community, create your own, or open your friends list.</p>
            <div className="empty-actions">
              <button className="empty-primary" onClick={() => setView('discover')}>🌐 Discover servers</button>
              <button onClick={() => { setCommunityId(null); setView('create-server'); }}>＋ Create a server</button>
              <button className="ghost" onClick={() => setView('friends')}>👥 Open friends</button>
            </div>
          </div>
        )}

        {/* User bar */}
        <footer className="user-bar">
          <Avatar src={me.anon_active?null:me.avatar} name={me.anon_active?maskName(me.anon_mask):(me.nickname||me.username)}
            size="sm" official={me.tag==='real'} badge={me.badge}
            anonMask={me.anon_active?(me.anon_emoji||me.anon_mask?.split(' ')?.[0]):null} anonColor={me.anon_active?me.anon_color:null}
            status={me.status} onClick={()=>{setRightTab('profile');setShowRightPanel(true);}} />
          <div className="user-info" onClick={()=>{setRightTab('profile');setShowRightPanel(true);}}>
            <span className="user-name">{me.anon_active?maskName(me.anon_mask):(me.nickname||me.username)}</span>
            <span className="user-tag">{me.custom_status||me.status||'Online'}</span>
          </div>
          <div className="user-bar-btns">
            <button className="icon-btn" title="Search messages" onClick={()=>setShowSearch(true)}>🔎</button>
            <button className="icon-btn" title="Bookmarks" onClick={()=>{ refreshBookmarks(); setShowBookmarks(v=>!v); }}>🔖</button>
            <button className="icon-btn" title="Notifications" onClick={()=>{ setShowNotifs(v=>!v); if(!showNotifs) setReminderPings(0); }}>
              🔔{(totalPings+reminderPings)>0&&<span className="notif-badge-mini">{totalPings+reminderPings}</span>}
              {bmCount>0&&<span className="notif-badge-mini bm-badge" title={`${bmCount} bookmark${bmCount!==1?'s':''}`}>{bmCount}</span>}
            </button>
            {me.is_admin && <button className="icon-btn" title="Admin menu" onClick={()=>setShowAdminMenu(true)}>⚙️</button>}
            {me.is_admin && ['Founder','Owner','Administrator'].includes(me.rank) && <button className="icon-btn legal-btn" title="Legal history (Founder/Owner)" onClick={()=>setShowOwnerHistory(true)}>🧠</button>}
            {(() => { const sf = view==='server' ? serverFavMasks(me, communityId) : null; const favs = sf || parseFavMasks(me); const effective = favs.length ? favs : (currentServerPinnedMask ? [currentServerPinnedMask] : []); return effective.length > 0 && <button className="icon-btn quick-swap-btn" title={swapHint ? `${swapHint}${currentServerPinnedMask && !favs.length ? ' · community default' : ''}` : 'Quick-swap mask'} aria-label={swapHint || 'Quick-swap mask'} onClick={quickSwapMask}>{me.anon_active && effective.some(f=>f.name===me.anon_mask) ? '🙂' : '🎭'}</button>; })()}
            <button className="icon-btn" title="Settings" onClick={()=>setShowSettings(true)}>⚙</button>
            <button className="icon-btn mobile-only mobile-nav-arrow" title="Open servers and channels" aria-label="Open servers and channels" onClick={()=>setShowMobileChannels(v=>!v)}>{showMobileChannels?'‹':'›'}</button>
            <button className="icon-btn" title="Toggle panel" onClick={()=>setShowRightPanel(v=>!v)}>👥</button>
            <button className="icon-btn logout-btn" onClick={logout} title="Log out">⏻</button>
          </div>
        </footer>
      </main>

      {/* ── Right panel ── */}
      {showRightPanel && (
        <aside className="info">
          <div className="info-tabs">
            <button className={rightTab==='members'?'active':''} onClick={()=>setRightTab('members')}>Members</button>
            <button className={rightTab==='profile'?'active':''} onClick={()=>setRightTab('profile')}>Profile</button>
            {me.is_admin && <button className={rightTab==='admin'?'active':''} onClick={()=>setRightTab('admin')}>Admin</button>}
          </div>
          <div style={{flex:1,overflow:'auto',padding:'0.5rem'}}>
            {rightTab==='members' && <MemberList users={boot?.users||[]} me={me} comm={comm} effects={cosmeticEffects} onViewProfile={setViewingProfile} />}
            {rightTab==='profile' && <ProfilePanel me={me} onSave={u=>setMe(m=>({...m,...u}))} theme={theme} onThemeChange={t=>{setTheme(t);applyTheme(t);}} currentServer={view==='server'?communityId:null} />}
            {rightTab==='admin' && me.is_admin && <AdminPanel me={me} onNotice={notify} boot={boot} onBootRefresh={()=>api('/api/bootstrap').then(d=>{if(!d.error)setBoot(d);})} />}
          </div>
        </aside>
      )}

      {showSearch && <GlobalSearch boot={boot} onClose={()=>setShowSearch(false)} notify={notify} onJumpBookmark={jumpToBookmark} />}

      {/* Notifications panel */}
      {showNotifs && (
        <div className="notif-panel-wrapper">
          <NotificationsPanel onClose={()=>setShowNotifs(false)}
            onOpenBookmarks={()=>{ setShowNotifs(false); setShowBookmarks(true); }}
            bmCount={bmCount} />
        </div>
      )}

      {/* Profile popup */}
      {viewingProfile && <ProfilePopup user={viewingProfile} me={me} onClose={()=>setViewingProfile(null)} onOpenDm={openDm} notify={notify} onRequestData={(u)=>{ setViewingProfile(null); setDataReq({ open:true, mode:'request', target:u }); }} />}
      {dataReq.open && <DataRequestModal open={dataReq.open} mode={dataReq.mode} targetUser={dataReq.target} me={me} notify={notify} onClose={()=>setDataReq({ open:false, mode:'review', target:null })} />}
    </div>
  );
}

// ── ServerChannelList, DmList, FriendsView, MemberList, ProfilePanel, CreateServerPanel ──

function ServerChannelList({ comm, boot, me, channelId, onChooseChannel, theme, setTheme, notify, unread, pings, onBootRefresh, onCloseNav, onAddChannel, rooms, activeRoomId, onChooseRoom, onCreateRoom }) {
  const [showSettings, setShowSettings] = useState(false);
  const [serverMenu, setServerMenu] = useState(false);
  const [showNewCh, setShowNewCh] = useState(false);
  const channels  = (boot?.channels||[]).filter(c=>c.community_id===comm?.id);
  const categories = [...new Set(channels.map(c=>c.category||'General'))];
  const isMod = me.is_admin || (boot?.memberships||[]).some(m=>m.community_id===comm?.id&&(m.role==='owner'||m.role==='admin'));

  return (
    <>
      <header className="channels-header">
        <h2 title={comm?.name}>{comm?.name||'Unknown'}</h2>
        <button className="icon-btn mobile-only drawer-close" onClick={onCloseNav} title="Close">‹</button>
        <div className="channels-header-btns">
          <button className="icon-btn" onClick={()=>setTheme(theme==='dark'?'light':'dark')} title="Toggle theme">{theme==='dark'?'☀':'🌙'}</button>
          {isMod && <button className="icon-btn" onClick={()=>setServerMenu(true)} title="Server settings">⚙</button>}
        </div>
      </header>
      {serverMenu && comm && <div className="menu-overlay" onClick={()=>setServerMenu(false)}><div className="menu-modal server-menu-modal" onClick={e=>e.stopPropagation()}><div className="menu-modal-header"><h2>{comm.name} — Settings</h2><button className="icon-btn" onClick={()=>setServerMenu(false)}>✕</button></div><div className="menu-modal-body"><ServerSettings comm={comm} me={me} boot={boot} onClose={()=>setServerMenu(false)} onRefresh={()=>onBootRefresh()} notify={notify} /></div></div></div>}
      <div className="channels-scroll">
        <div className="channel-category rooms-category">
          <div className="category-header">
            <span>🗂 Rooms</span>
            <button className="icon-btn category-add" title="Create a room" onClick={onCreateRoom}>+</button>
          </div>
          {(rooms||[]).map(r => {
            const rm = ROOM_META[r.type] || ROOM_META.chat;
            const mine = r.is_owner ? ' 🏠' : '';
            const wait = r.me_waiting ? ' (waiting)' : '';
            return (
              <button key={r.id} className={`channel-btn room-btn${r.id===activeRoomId?' active':''}`} onClick={()=>onChooseRoom(r.id)}>
                <span className="ch-icon">{rm.icon}</span>
                <span className="ch-name">{r.name}{mine}{wait}{r.expires_at&&<span className="temp-badge" title="Temporary room">⏱</span>}</span>
                <span className="room-count" title="Members">{r.member_count||0}</span>
              </button>
            );
          })}
          {(rooms||[]).length===0 && <p className="room-empty-hint">Create a temp room — chat, voice, games, drawing & more</p>}
        </div>
        {categories.map(cat => (
          <div key={cat} className="channel-category">
            <div className="category-header">
              <span>{cat}</span>
              {isMod && <button className="icon-btn category-add" title="Add channel" onClick={()=>setShowNewCh(cat)}>+</button>}
            </div>
            {showNewCh===cat && <NewChannelForm communityId={comm?.id} category={cat} onDone={ch=>{ if(ch) onAddChannel?.(ch); setShowNewCh(false); }} onCancel={()=>setShowNewCh(false)} />}
            {channels.filter(c=>(c.category||'General')===cat).sort((a,b)=>(a.position||0)-(b.position||0)).map(c => {
              const u=unread[c.id]||0, p=pings[c.id]||0;
              const dtag={asleep:'🌙',awake:'☀️',gaming:'🎮',chill:'🌊',unknown:'❓'}[c.discovery_tag]||'';
              return (
                <button key={c.id} className={`channel-btn${c.id===channelId?' active':''}${u>0?' has-unread':''}`} onClick={()=>onChooseChannel(c.id)}>
                  <span className="ch-icon">{c.type==='voice'?'🔊':'#'}</span>
                  <span className="ch-name">{c.name}{dtag&&<span className="dtag"> {dtag}</span>}{c.expires_at&&<span className="temp-badge" title="Temporary channel">⏱</span>}</span>
                  {p>0?<span className="ch-badge ping">{p}</span>:u>0?<span className="ch-badge">{u}</span>:null}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {comm && <div className="invite-bar"><button className="ghost invite-btn" onClick={async()=>{ const d=await api(`/api/communities/${comm.id}/invite`); if(d.inviteCode){navigator.clipboard?.writeText(d.inviteCode).catch(()=>{}); notify(`Invite code: ${d.inviteCode}`,'ok');} }}>📋 Copy invite</button></div>}
    </>
  );
}

function ServerSettings({ comm, me, boot, onClose, onRefresh, notify }) {
  const [tab, setTab] = useState('overview');
  const [name, setName]   = useState(comm.name);
  const [desc, setDesc]   = useState(comm.description||'');
  const [rules, setRules] = useState(comm.rules||'');
  const [vis, setVis]     = useState(comm.visibility||'public');
  const [tags, setTags]   = useState(comm.tags||'');
  const [icon, setIcon]   = useState(comm.icon||'');
  const [banner, setBanner] = useState(comm.banner||'');
  const [invite, setInvite] = useState('');
  const [members, setMembers] = useState([]);
  const [channels, setChannels] = useState([]);
  const [editCh, setEditCh] = useState(null);
  const [chanEdits, setChanEdits] = useState({});

  const membership = (boot?.memberships||[]).find(m=>m.community_id===comm.id);
  const isMod  = me?.is_admin || (membership && ['owner','admin'].includes(membership.role));
  const isOwner = me?.is_admin || membership?.role==='owner';
  // Mirror of the server's hierarchy guard: an actor may only moderate members strictly below them.
  const STAFF_LV = { 'Mod':10,'Sr. Mod':20,'Jr. admin':30,admin:40,Dev:50,'Head Mod':60,'Head admin':70,Manager:80,Administrator:90,Owner:100,Founder:110 };
  const NORM_LV = { New:0,Beginner:1,Starter:2,Member:3,Trusted:4,Community:5,Celebrity:6,Known:7 };
  const rankLv = r => (STAFF_LV[r] ?? (NORM_LV[r] ?? 0));
  const memberLv = r => ({ member:5, mod:10, admin:70, owner:100 })[r] ?? 5;
  const actorLv = Math.max(me.is_admin ? 90 : 0, rankLv(me.rank||''), memberLv(membership?.role||'member'));
  const canMod = m => {
    if (m.user_id === me.id) return true;
    const tLv = Math.max(m.is_admin ? 90 : 0, rankLv(m.platform_rank||''), memberLv(m.role||'member'));
    return actorLv > tLv;
  };

  useEffect(() => {
    api(`/api/communities/${comm.id}/invite`).then(d=>setInvite(d.inviteCode||''));
    api(`/api/communities/${comm.id}/members`).then(setMembers).catch(()=>{});
    setChannels((boot?.channels||[]).filter(c=>c.community_id===comm.id));
  }, [comm.id]);

  async function saveOverview(e){ e.preventDefault(); await api(`/api/communities/${comm.id}`,{method:'PATCH',body:JSON.stringify({name,description:desc,rules,visibility:vis,tags,icon,banner})}); notify('Server updated','ok'); onRefresh?.(); }
  async function regenInvite(){ const d=await api(`/api/communities/${comm.id}/invite/regenerate`,{method:'POST'}); if(d.inviteCode){ setInvite(d.inviteCode); navigator.clipboard?.writeText(d.inviteCode).catch(()=>{}); notify(`New invite: ${d.inviteCode}`,'ok'); onRefresh?.(); } }
  async function copyInvite(){ navigator.clipboard?.writeText(invite).then(()=>notify('Invite copied','ok')); }
  async function saveChannel(ch){ await api(`/api/channels/${ch.id}`,{method:'PATCH',body:JSON.stringify(chanEdits[ch.id]||{})}); notify('Channel updated','ok'); setEditCh(null); onRefresh?.(); }
  async function deleteChannel(ch){ if(!confirm(`Delete #${ch.name}?`)) return; await api(`/api/channels/${ch.id}`,{method:'DELETE'}); notify('Channel deleted','ok'); onRefresh?.(); }
  async function kickMember(m){ if(!confirm(`Kick ${m.user_nickname||m.username}?`)) return; const d=await api(`/api/communities/${comm.id}/members/${m.user_id}`,{method:'DELETE'}); if(d.error) return notify(d.error,'err'); notify('Member kicked','ok'); setMembers(members.filter(x=>x.user_id!==m.user_id)); onRefresh?.(); }
  async function setMemberRole(m, role){ const d=await api(`/api/communities/${comm.id}/members/${m.user_id}`,{method:'PATCH',body:JSON.stringify({role})}); if(d.error) return notify(d.error,'err'); notify('Role updated','ok'); onRefresh?.(); }
  async function lockdown(){ const locked=!comm.locked; await api(`/api/communities/${comm.id}/lockdown`,{method:'POST',body:JSON.stringify({locked:locked?1:0})}); notify(locked?'🔒 Server locked':'🔓 Server unlocked','ok'); onRefresh?.(); }
  async function del(){ if(!confirm(`Delete "${comm.name}"? This is permanent.`)) return; await api(`/api/communities/${comm.id}`,{method:'DELETE'}); location.reload(); }

  const TABS = ['overview','channels','roles','members','invites','moderation'];
  const TAB_LABELS = { overview:'👁 Overview', channels:'📁 Channels', roles:'🎖 Roles', members:'👥 Members', invites:'🔗 Invites', moderation:'🛡 Moderation' };

  return (
    <div className="server-settings-full">
      <div className="settings-inner-tabs">
        {TABS.map(t=>(
          <button key={t} className={`settings-inner-tab${tab===t?' active':''}`} onClick={()=>setTab(t)}>{TAB_LABELS[t]}</button>
        ))}
      </div>

      {tab==='overview' && (
        <form onSubmit={saveOverview} className="mini">
          <label>Server name<input value={name} onChange={e=>setName(e.target.value)} /></label>
          <label>Description<textarea value={desc} onChange={e=>setDesc(e.target.value)} rows={2} /></label>
          <label>Rules<textarea value={rules} onChange={e=>setRules(e.target.value)} rows={2} /></label>
          <label>Tags (comma separated)<input value={tags} onChange={e=>setTags(e.target.value)} placeholder="gaming,chill,art" /></label>
          <label>Icon URL<input value={icon} onChange={e=>setIcon(e.target.value)} placeholder="https://…" /></label>
          <label>Banner URL<input value={banner} onChange={e=>setBanner(e.target.value)} placeholder="https://…" /></label>
          <label>Visibility
            <select value={vis} onChange={e=>setVis(e.target.value)}>
              <option value="public">Public</option>
              <option value="private">Private</option>
            </select>
          </label>
          <button>Save changes</button>
        </form>
      )}

      {tab==='channels' && (
        <div className="channel-manage-list">
          {channels.map(ch=>(
            <div key={ch.id} className="channel-manage-row">
              {editCh===ch.id ? (
                <div className="mini" style={{flex:1}}>
                  <input value={chanEdits[ch.id]?.name ?? ch.name} onChange={e=>setChanEdits(x=>({...x,[ch.id]:{...(x[ch.id]||{}),name:e.target.value}}))} placeholder="Name" />
                  <input value={(chanEdits[ch.id]?.topic ?? ch.topic) || ''} onChange={e=>setChanEdits(x=>({...x,[ch.id]:{...(x[ch.id]||{}),topic:e.target.value}}))} placeholder="Topic" />
                  <input type="number" min="0" value={(chanEdits[ch.id]?.slowmode ?? ch.slowmode) || 0} onChange={e=>setChanEdits(x=>({...x,[ch.id]:{...(x[ch.id]||{}),slowmode:parseInt(e.target.value)||0}}))} placeholder="Slow mode (sec)" />
                  <div style={{display:'flex',gap:4}}><button onClick={()=>saveChannel(ch)}>Save</button><button className="ghost" type="button" onClick={()=>setEditCh(null)}>Cancel</button></div>
                </div>
              ) : (
                <>
                  <span className="ch-icon">{ch.type==='voice'?'🔊':'#'}</span>
                  <div style={{flex:1,minWidth:0}}><b>{ch.name}</b>{ch.topic&&<small style={{display:'block',color:'var(--muted)'}}>{ch.topic}</small>}</div>
                  <button className="ghost" type="button" onClick={()=>{ setEditCh(ch.id); setChanEdits(x=>({...x,[ch.id]:{name:ch.name,topic:ch.topic||'',slowmode:ch.slowmode||0}})); }}>✏</button>
                  <button className="danger-btn" type="button" onClick={()=>deleteChannel(ch)}>🗑</button>
                </>
              )}
            </div>
          ))}
          {channels.length===0&&<p className="empty-text">No channels.</p>}
        </div>
      )}

      {tab==='roles' && <RolesPanel comm={comm} boot={boot} onNotice={notify} onBootRefresh={onRefresh} />}

      {tab==='members' && (
        <div className="channel-manage-list">
          {members.map(m=>(
            <div key={m.user_id} className="channel-manage-row">
              <Avatar src={m.avatar} name={m.user_nickname||m.username} size="xs" badge={m.badge} />
              <div style={{flex:1,minWidth:0}}>
                <b>{m.user_nickname||m.username}</b>
                <small style={{display:'block',color:'var(--muted)'}}>{m.role}{m.nickname&&` · nick: ${m.nickname}`}{Number(m.muted)?' · 🔇':''}</small>
              </div>
              {isMod && canMod(m) && m.role!=='owner' && (
                <>
                  <select value={m.role} onChange={e=>setMemberRole(m,e.target.value)}>
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                  </select>
                  <button className="danger-btn" type="button" onClick={()=>kickMember(m)}>Kick</button>
                </>
              )}
              {isMod && !canMod(m) && <small style={{color:'var(--muted)',fontSize:'0.7rem'}}>Equal/higher rank</small>}
            </div>
          ))}
          {members.length===0&&<p className="empty-text">No members.</p>}
        </div>
      )}

      {tab==='invites' && (
        <div className="invite-panel">
          <p className="muted-text">Share this invite code so people can join <b>{comm.name}</b>.</p>
          <div className="invite-code-box">
            <code>{invite||'…'}</code>
            <button type="button" onClick={copyInvite}>Copy</button>
            {isMod && <button type="button" className="ghost" onClick={regenInvite}>Regenerate</button>}
          </div>
        </div>
      )}

      {tab==='moderation' && (
        <div className="mini">
          <div className="settings-toggle-row">
            <div><b>Lockdown mode</b><p>Disables messaging across the server.</p></div>
            <button type="button" className={comm.locked?'danger-btn':''} onClick={lockdown}>{comm.locked?'🔓 Unlock':'🚨 Lockdown'}</button>
          </div>
          <p className="muted-text">Moderation shortcuts — type in chat: <b>/slowmode 30</b> · <b>/clear 20</b> · <b>/topic text</b> · <b>/nick name</b></p>
          {isOwner && <button type="button" className="danger-btn" onClick={del} style={{marginTop:'1rem'}}>Delete Server</button>}
        </div>
      )}
    </div>
  );
}

function NewChannelForm({ communityId, category, onDone, onCancel }) {
  const [name, setName]   = useState('');
  const [type, setType]   = useState('text');
  const [expire, setExpire] = useState('');
  const [dtag, setDtag]   = useState('');
  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    const d = await api('/api/channels',{method:'POST',body:JSON.stringify({communityId,name:name.toLowerCase().replace(/\s+/g,'-'),type,category,expiresIn:expire||undefined,discovery_tag:dtag})});
    onDone(d.channel);
  }
  return (
    <form onSubmit={submit} className="new-channel-form mini">
      <input placeholder="channel-name" value={name} onChange={e=>setName(e.target.value)} />
      <select value={type} onChange={e=>setType(e.target.value)}>
        <option value="text">Text</option>
        <option value="voice">Voice</option>
      </select>
      <select value={expire} onChange={e=>setExpire(e.target.value)}>
        <option value="">Permanent</option>
        <option value="hour">Disappears in 1 hour</option>
        <option value="day">Disappears in 1 day</option>
        <option value="7days">Disappears in 7 days</option>
      </select>
      <select value={dtag} onChange={e=>setDtag(e.target.value)}>
        <option value="">No discovery tag</option>
        <option value="asleep">🌙 Asleep</option>
        <option value="awake">☀️ Awake</option>
        <option value="gaming">🎮 Gaming</option>
        <option value="chill">🌊 Chill</option>
        <option value="unknown">❓ Unknown</option>
      </select>
      <div style={{display:'flex',gap:4}}>
        <button>Create</button>
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function CreateServerPanel({ onDone, onCancel }) {
  const [name, setName] = useState('');
  const [vis, setVis]   = useState('public');
  const [inv, setInv]   = useState('');
  const [tab, setTab]   = useState('create');
  async function create(e) { e.preventDefault(); if(!name.trim()) return; const d=await api('/api/communities',{method:'POST',body:JSON.stringify({name,visibility:vis})}); if(d.id) onDone(d.id, d); }
  async function join(e)   { e.preventDefault(); const d=await api('/api/communities/join',{method:'POST',body:JSON.stringify({inviteCode:inv})}); if(d.communityId) onDone(d.communityId, d); }
  return (
    <div className="create-server-panel">
      <div className="channels-header"><h2>Add Server</h2><button className="icon-btn" onClick={onCancel}>✕</button></div>
      <div className="admin-tabs" style={{margin:'0.5rem'}}><button className={tab==='create'?'active':''} onClick={()=>setTab('create')}>Create</button><button className={tab==='join'?'active':''} onClick={()=>setTab('join')}>Join</button></div>
      {tab==='create' && <form onSubmit={create} className="mini" style={{padding:'0.5rem'}}><label>Server name<input value={name} onChange={e=>setName(e.target.value)} /></label><label>Visibility<select value={vis} onChange={e=>setVis(e.target.value)}><option value="public">Public</option><option value="private">Private</option></select></label><button>Create</button></form>}
      {tab==='join'   && <form onSubmit={join}   className="mini" style={{padding:'0.5rem'}}><label>Invite code<input value={inv} onChange={e=>setInv(e.target.value)} placeholder="abc12345" /></label><button>Join</button></form>}
    </div>
  );
}

function DmList({ me, boot, activeDmId, activeGroupId, view, setView, onChooseDm, onChooseGroup, onViewProfile, unread, pings, notify, onBootRefresh, onNewGroup, onCloseNav }) {
  const [search, setSearch] = useState('');
  const dms    = boot?.dms    || [];
  const groups = boot?.groups || [];
  const friends= (boot?.friends||[]).filter(f=>f.status==='accepted');
  function getDmDisplay(dm) {
    const isA = dm.user_a === me.id;
    return { id:dm.id, name:isA?(dm.nickname_a||dm.user_b_nick||dm.user_b_name):(dm.nickname_b||dm.user_a_nick||dm.user_a_name), avatar:isA?dm.user_b_avatar:dm.user_a_avatar, badge:isA?dm.user_b_badge:dm.user_a_badge };
  }
  const pending = (boot?.friends||[]).filter(f=>f.status==='pending'&&f.addressee_id===me.id).length;
  return (
    <>
      <header className="channels-header"><h2>Messages</h2><button className="icon-btn mobile-only drawer-close" onClick={onCloseNav} title="Close">‹</button></header>
      <div className="dm-tabs">
        <button className={view==='dm'?'active':''} onClick={()=>setView('dm')}>DMs</button>
        <button className={view==='friends'?'active':''} onClick={()=>setView('friends')}>Friends{pending>0&&<span className="ch-badge ping" style={{marginLeft:4}}>{pending}</span>}</button>
      </div>
      <div className="channels-scroll">
        <input className="dm-search" placeholder="Find a conversation…" value={search} onChange={e=>setSearch(e.target.value)} />
        <div className="category-header" style={{padding:'0.4rem 0.75rem 0.2rem'}}><span>Groups</span><button className="icon-btn category-add" onClick={onNewGroup} title="New group">+</button></div>
        {groups.map(g => (
          <button key={g.id} className={`dm-btn${g.id===activeGroupId?' active':''}`} onClick={()=>onChooseGroup(g.id)}>
            <div className="avatar avatar-sm" style={{background:'var(--brand)'}}>👥</div>
            <span className="dm-name">{g.name}</span>
          </button>
        ))}
        <div className="category-header" style={{padding:'0.4rem 0.75rem 0.2rem'}}><span>Direct Messages</span></div>
        {dms.filter(d=>getDmDisplay(d).name?.toLowerCase().includes(search.toLowerCase())).map(dm => {
          const d=getDmDisplay(dm); const u=unread[`dm:${dm.id}`]||0, p=pings[`dm:${dm.id}`]||0;
          return (
            <button key={dm.id} className={`dm-btn${dm.id===activeDmId?' active':''}${u>0?' has-unread':''}`} onClick={()=>onChooseDm(dm.id)}>
              <Avatar src={d.avatar} name={d.name} size="sm" badge={d.badge} />
              <span className="dm-name">{d.name}</span>
              {p>0?<span className="ch-badge ping">{p}</span>:u>0?<span className="ch-badge">{u}</span>:null}
            </button>
          );
        })}
        {dms.length===0&&<p className="empty-text">No DMs yet.</p>}
      </div>
    </>
  );
}

function FriendsView({ me, boot, onBootRefresh, onOpenDm, onViewProfile, notify }) {
  const [username, setUsername] = useState('');
  const friends = boot?.friends || [];
  const accepted = friends.filter(f=>f.status==='accepted');
  const incoming = friends.filter(f=>f.status==='pending'&&f.addressee_id===me.id);
  const outgoing = friends.filter(f=>f.status==='pending'&&f.requester_id===me.id);
  async function sendReq(e) { e.preventDefault(); const d=await api('/api/friends/request',{method:'POST',body:JSON.stringify({username})}); if(d.error) notify(d.error,'err'); else{notify('Request sent!','ok');setUsername('');onBootRefresh();} }
  async function respond(id,status) { await api(`/api/friends/${id}`,{method:'PATCH',body:JSON.stringify({status})}); onBootRefresh(); }
  async function remove(id) { await api(`/api/friends/${id}`,{method:'DELETE'}); onBootRefresh(); }
  return (
    <div className="friends-view">
      <div className="chat-header"><div className="channel-title"><h2>Friends</h2></div></div>
      <div className="friends-body">
        <form onSubmit={sendReq} className="mini friend-add-form">
          <label>Add friend by username</label>
          <div style={{display:'flex',gap:8}}><input value={username} onChange={e=>setUsername(e.target.value)} placeholder="username" style={{flex:1}} /><button>Add</button></div>
        </form>
        {incoming.length>0&&<section className="friend-section"><h3>Pending — {incoming.length}</h3>{incoming.map(f=>(
          <div key={f.id} className="friend-row"><Avatar src={f.avatar} name={f.nickname||f.username} size="sm" badge={f.badge} onClick={()=>onViewProfile(f)} /><span className="friend-name">{f.nickname||f.username}<small>#{f.tag}</small></span><div className="friend-actions"><button className="ok-btn" onClick={()=>respond(f.id,'accepted')}>✓</button><button className="danger-btn" onClick={()=>respond(f.id,'declined')}>✕</button></div></div>
        ))}</section>}
        {accepted.length>0&&<section className="friend-section"><h3>Friends — {accepted.length}</h3>{accepted.map(f=>(
          <div key={f.id} className="friend-row"><Avatar src={f.avatar} name={f.nickname||f.username} size="sm" badge={f.badge} onClick={()=>onViewProfile(f)} /><span className="friend-name">{f.nickname||f.username}<small>#{f.tag}</small></span><div className="friend-actions"><button onClick={()=>onOpenDm(f.id)} title="Message">💬</button><button className="ghost" onClick={()=>remove(f.id)}>✕</button></div></div>
        ))}</section>}
        {accepted.length===0&&incoming.length===0&&<p className="empty-text">No friends yet. Add someone above!</p>}
      </div>
    </div>
  );
}

function MemberList({ users, me, onViewProfile, effects }) {
  const online  = users.filter(u=>u.status==='Online'||!u.status);
  const away    = users.filter(u=>u.status==='Away');
  const dnd     = users.filter(u=>u.status==='Do Not Disturb');
  const offline = users.filter(u=>u.status==='Invisible'||u.status==='Offline');
  function renderUser(u) {
    const mine = (effects||[]).filter(e => e.purchased_by === u.id);
    const activeFx = mine.filter(e => e.isActive);
    const fx = activeFx.length ? activeFx : (mine.length ? [mine[0]] : []);
    return (
      <li key={u.id} className={`member-item${u.id===me.id?' self':''}`} onClick={()=>onViewProfile(u)}>
        <Avatar src={u.anon_active?null:u.avatar} name={u.anon_active?maskName(u.anon_mask):(u.nickname||u.username)} size="xs" official={u.tag==='real'} badge={u.badge} status={u.status} anonMask={u.anon_active?(u.anon_emoji||u.anon_mask?.split(' ')?.[0]):null} anonColor={u.anon_active?u.anon_color:null} />
        <div className="member-info">
          <span className="member-name" style={{color:u.tag==='real'?'var(--ok)':(u.anon_active ? (u.anon_name_color || nameColor(u.anon_mask || '')) : nameColor(u.username))}}>{u.anon_active?maskName(u.anon_mask):(u.nickname||u.username)}
            {fx.length>0 && <span className="member-effect" title={`${fx.map(e=>COSMETIC_EFFECTS[e.item_id]||e.item_id).join(' ')} effect`}>{fx.map(e=>COSMETIC_EFFECTS[e.item_id]||e.item_id).join('')}</span>}
          </span>
          {u.custom_status&&<span className="member-status">{u.custom_status}</span>}
        </div>
        {u.badge==='Knowns'&&<span className="role-tag knowns">K</span>}
        {u.is_admin&&<span className="role-tag admin">A</span>}
      </li>
    );
  }
  return (
    <section className="members panel">
      {online.length>0&&<><h3>Online — {online.length}</h3><ul className="member-list">{online.map(renderUser)}</ul></>}
      {away.length>0&&<><h3 style={{marginTop:'0.75rem'}}>Away — {away.length}</h3><ul className="member-list">{away.map(renderUser)}</ul></>}
      {dnd.length>0&&<><h3 style={{marginTop:'0.75rem'}}>Do Not Disturb — {dnd.length}</h3><ul className="member-list">{dnd.map(renderUser)}</ul></>}
      {offline.length>0&&<><h3 style={{marginTop:'0.75rem'}}>Offline — {offline.length}</h3><ul className="member-list">{offline.map(renderUser)}</ul></>}
    </section>
  );
}

function ProfilePanel({ me, onSave, theme, onThemeChange, currentServer }) {
  const [nickname, setNickname]       = useState(me.nickname||me.username);
  const [status, setStatus]           = useState(me.status||'Online');
  const [customStatus, setCustomStatus] = useState(me.custom_status||'');
  const [bio, setBio]                 = useState(me.bio||'');
  const [avatar, setAvatar]           = useState(me.avatar||'');
  const [banner, setBanner]           = useState(me.banner||'');
  const [saved, setSaved]             = useState('');

  async function uploadImg(e, setFn) {
    const file = e.target.files?.[0]; if(!file) return;
    const fd = new FormData(); fd.append('file',file);
    const d = await fetch('/api/upload',{method:'POST',headers:{Authorization:`Bearer ${getToken()}`},body:fd}).then(r=>r.json());
    if(d.url) setFn(d.url);
  }

  async function save(e) {
    e.preventDefault();
    const d = await api('/api/profile',{method:'PATCH',body:JSON.stringify({nickname,status,custom_status:customStatus,bio,avatar,banner})});
    if(d.user){onSave(d.user);setSaved('Saved!');setTimeout(()=>setSaved(''),2000);}
  }

  function genAvatar() {
    const colors=['#5865f2','#23a559','#f0b232','#f23f42','#eb459e','#00a8fc'];
    const emojis=['🦊','👾','🌊','🔥','⚡','🌙','🎭','🤖'];
    const c=colors[Math.floor(Math.random()*colors.length)];
    const e=emojis[Math.floor(Math.random()*emojis.length)];
    setAvatar(`data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><rect width='80' height='80' rx='40' fill='${encodeURIComponent(c)}'/><text x='40' y='56' text-anchor='middle' font-size='44'>${e}</text></svg>`);
  }

  return (
    <section className="profile panel">
      <div className="panel-header"><h2>My Profile</h2><span className="profile-rank">🏅 {me.rank || 'Member'}</span></div>
      {(banner||avatar) && <div className="profile-banner-preview" style={{backgroundImage:banner?`url(${banner})`:'none'}}><Avatar src={avatar} name={nickname} size="lg" official={me.tag==='real'} badge={me.badge} /></div>}
      {(() => {
        const sf = currentServer ? serverFavMasks(me, currentServer) : null;
        const favs = sf || parseFavMasks(me);
        const activeFav = me.anon_active && favs.some(f => f.name === me.anon_mask);
        if (!favs.length) return null;
        async function doSwap() {
          let target = null;
          if (activeFav) {
            const idx = favs.findIndex(f => f.name === me.anon_mask);
            const next = favs[idx + 1];
            if (!next) {
              const d = await api('/api/me/anonymous', { method: 'DELETE' }).catch(() => null);
              if (d && !d.error) { onSave({ ...me, anon_active: false, anon_mask: '', anon_color: '', anon_emoji: '' }); setSaved('Back to real identity'); setTimeout(() => setSaved(''), 2000); }
              return;
            }
            target = next;
          } else target = favs[0];
          const d = await api('/api/me/anonymous', { method: 'POST', body: JSON.stringify({ maskName: target.name }) }).catch(() => null);
          if (d && !d.error) { onSave({ ...me, anon_active: true, anon_mask: target.name, anon_color: target.color, anon_emoji: target.emoji }); setSaved(`Swapped to ${target.name.replace(/\S+\s+/,'')}`); setTimeout(() => setSaved(''), 2000); }
        }
        return <button type="button" className="quick-swap-inline" onClick={doSwap}>{activeFav ? '🙂 ' + nextSwapLabel(me, sf) : `🎭 ${nextSwapLabel(me, sf)}`}</button>;
      })()}
      
      <form onSubmit={save} className="mini">
        <label>Display name<input value={nickname} onChange={e=>setNickname(e.target.value)} /></label>
        <label>Status
          <select value={status} onChange={e=>setStatus(e.target.value)}>
            <option>Online</option><option>Away</option><option>Do Not Disturb</option><option>Invisible</option>
          </select>
        </label>
        <label>Custom status<input value={customStatus} onChange={e=>setCustomStatus(e.target.value)} placeholder="What's going on?" /></label>
        <label>Bio<textarea value={bio} onChange={e=>setBio(e.target.value)} rows={3} placeholder="About you…" /></label>
        <label>Avatar URL<input value={avatar} onChange={e=>setAvatar(e.target.value)} placeholder="https://…" /></label>
        <label className="file-label">Upload avatar<input type="file" accept="image/*" onChange={e=>uploadImg(e,setAvatar)} /></label>
        <button type="button" className="ghost" onClick={genAvatar}>🎲 Generate avatar</button>
        <label>Banner URL<input value={banner} onChange={e=>setBanner(e.target.value)} placeholder="https://…" /></label>
        <label className="file-label">Upload banner<input type="file" accept="image/*" onChange={e=>uploadImg(e,setBanner)} /></label>
        <button>Save changes</button>
        {saved&&<small className="saved-msg">{saved}</small>}
      </form>
      <p className="muted-text" style={{fontSize:'0.72rem',marginTop:'0.5rem'}}>⚡ {me.karma||0} karma · {me.username}#{me.tag}</p>
    </section>
  );
}

// ── Error boundary ────────────────────────────────────────────────────────────
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) return (
      <main className="auth"><section className="panel auth-form">
        <Mascot size={80} mood="thinking" />
        <h2>Something went wrong</h2>
        <p className="error">{this.state.error?.message || 'The page could not be loaded.'}</p>
        <button onClick={()=>{ clearToken(); location.reload(); }}>Reset and log in</button>
      </section></main>
    );
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>);
