import React, { useEffect, useRef, useState } from 'react';

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
  const [err, setErr] = useState('');
  const [selectedInterests, setSelectedInterests] = useState([]);

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

  const TABS = [
    { id: 'account',      emoji: '👤', label: 'Account' },
    { id: 'ranks',        emoji: '🏆', label: 'Ranks & perks' },
    { id: 'privacy',      emoji: '🔒', label: 'Privacy' },
    { id: 'notifications',emoji: '🔔', label: 'Notifications' },
    { id: 'appearance',   emoji: '🎨', label: 'Appearance' },
    { id: 'interests',    emoji: '⭐', label: 'Interests' },
    { id: 'anonymous',    emoji: '🎭', label: 'Anonymous' },
    { id: 'checkup',      emoji: '🕵️', label: 'Privacy Checkup' },
    { id: 'support',      emoji: '💬', label: 'Support' },
  ];

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
          <button className="settings-tab danger" onClick={onClose} style={{ marginTop: 'auto' }}>✕ Close</button>
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
            </div>
          )}

          {/* ── Ranks ── */}
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
                  <span className="masked-name-preview" style={{ color: anonNameColor || 'var(--muted)', fontWeight:700 }}>{p ? p.name.replace(/^\S+\s+/,'') : 'Anonymous'}</span>
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
