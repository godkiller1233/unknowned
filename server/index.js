import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/postgres-adapter';
import { createSessionManager } from './auth.js';
import helmet from 'helmet';
import cors from 'cors';
import multer from 'multer';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import { pii, piiWarning } from './privacy.js';
import { stripImageMetadata } from './metadata.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import net from 'net';
import { randomBytes } from 'crypto';
import { generateSecret, verifyCode, otpauthUri, generateRecoveryCodes, hashRecoveryCode } from './totp.js';
import dgram from 'dgram';
import dns from 'dns/promises';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;
const IS_PRODUCTION = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const JWT_SECRET = process.env.JWT_SECRET || (IS_PRODUCTION ? '' : 'dev-secret-change-me');
if (IS_PRODUCTION && JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be set to at least 32 characters in production');
}
// Dev/staging only — fake sample data and debug tools are gated behind this.
const IS_DEV = String(process.env.NODE_ENV || 'development') !== 'production';
const DATABASE_URL = process.env.DATABASE_URL;
if (IS_PRODUCTION && !DATABASE_URL) {
  throw new Error('DATABASE_URL must be set in production; connect this service to the existing PostgreSQL database');
}
// Bootstrap credentials are read only from environment variables. Never hard-code real passwords.
const OFFICIAL_ACCOUNT_USERNAME = process.env.OFFICIAL_ACCOUNT_USERNAME || 'Unknown';
const OFFICIAL_ACCOUNT_PASSWORD = process.env.OFFICIAL_ACCOUNT_PASSWORD || process.env.ADMIN_BOOTSTRAP_PASSWORD || (IS_PRODUCTION ? '' : 'change-me');
if (IS_PRODUCTION && !OFFICIAL_ACCOUNT_PASSWORD) {
  throw new Error('OFFICIAL_ACCOUNT_PASSWORD must be set in production');
}
const PRIVILEGED_ACCOUNT_CONFIG = Object.freeze([
  { rank: 'Administrator', username: process.env.ADMIN_USERNAME || OFFICIAL_ACCOUNT_USERNAME, password: process.env.ADMIN_PASSWORD || OFFICIAL_ACCOUNT_PASSWORD },
  { rank: 'Owner', username: process.env.OWNER_USERNAME || '', password: process.env.OWNER_PASSWORD || '' },
  { rank: 'Founder', username: process.env.FOUNDER_USERNAME || '', password: process.env.FOUNDER_PASSWORD || '' },
]);
const configuredPrivilegedAccounts = PRIVILEGED_ACCOUNT_CONFIG.filter(account => account.username && account.password && account.password !== 'change-me');
const uploadDir = process.env.UPLOAD_DIR || path.join(root, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

// ── WebRTC / TURN ──────────────────────────────────────────────────────────────
// Operators behind restrictive NATs configure a TURN server so voice/video calls
// can relay. TURN_URLS is a comma-separated list of urls (turn:/turns:), e.g.
//   TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp
// When TURN_USERNAME/TURN_CREDENTIAL are set they are sent on every TURN url.
// The public STUN fallback is always included so host/server-reflexive
// candidates still work when clients are not behind symmetric NAT.
const RTC_SETTING_KEYS = ['rtc_turn_urls', 'rtc_turn_username', 'rtc_turn_credential'];

// Environment fallback (initial value / used when the DB value is cleared).
function envRtcValues() {
  return {
    turnUrls: String(process.env.TURN_URLS || ''),
    username: process.env.TURN_USERNAME || '',
    credential: process.env.TURN_CREDENTIAL || '',
  };
}

// Effective relay config: values stored in the shared PostgreSQL database win;
// the environment variables are the fallback. Read on every bootstrap/health
// call (cheap single-row lookups), so a change saved on one instance is served
// by every other instance immediately — no restart, no per-instance env drift.
async function effectiveRtcValues() {
  let rows = [];
  try {
    rows = await store.all(`SELECT key, value FROM server_settings WHERE key IN (${RTC_SETTING_KEYS.map(() => '?').join(',')})`, ...RTC_SETTING_KEYS);
  } catch {
    // DB not reachable / not initialized yet — fall back to the environment.
  }
  const db = new Map(rows.filter(r => r && r.value).map(r => [r.key, r.value]));
  const env = envRtcValues();
  return {
    turnUrls: db.get('rtc_turn_urls') || env.turnUrls,
    username: db.get('rtc_turn_username') || env.username,
    credential: db.get('rtc_turn_credential') || env.credential,
  };
}

async function rtcIceServers() {
  const { turnUrls: raw, username, credential } = await effectiveRtcValues();
  const turnUrls = String(raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(s => /^turns?:(?:\/\/)?/i.test(s));
  const servers = [{ urls: ['stun:stun.l.google.com:19302'] }];
  if (turnUrls.length) {
    servers.push(username && credential
      ? { urls: turnUrls, username, credential }
      : { urls: turnUrls });
  }
  return servers;
}

// ── RTC health ─────────────────────────────────────────────────────────────────
// Operator-facing diagnostics for voice/video calls. Unlike /api/health (a DB
// liveness ping) this endpoint reports whether a TURN relay is configured and —
// without any credentials in the response — whether it answers. UDP TURN urls
// are probed with a real STUN binding request (TURN servers answer those from
// the same port); TCP/TLS urls with a TCP connect. A STUN-only server is
// reported as "degraded": most calls work, but clients behind symmetric NAT
// cannot connect until the operator configures a relay.
const RTC_PROBE_TIMEOUT = 2500;

function parseTurnUrl(url) {
  const m = /^turns?:(?:\/\/)?([^:/?#]+)(?::(\d+))?(?:\?(.*))?$/i.exec(url);
  if (!m) return null;
  const scheme = /^turns:/i.test(url) ? 'turns' : 'turn';
  const q = new URLSearchParams(m[3] || '');
  return {
    url,
    host: m[1],
    port: Number(m[2]) || (scheme === 'turns' ? 5349 : 3478),
    scheme,
    transport: (q.get('transport') || 'udp').toLowerCase(),
  };
}

function stunProbeUdp(host, port, timeoutMs) {
  return new Promise(resolve => {
    const sock = dgram.createSocket('udp4');
    const done = ok => { try { sock.close(); } catch {}; resolve(ok); };
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.once('message', buf => {
      clearTimeout(timer);
      // A TURN server answers STUN binding requests; the magic cookie round-trips.
      const ok = buf.length >= 20 && buf.readUInt32BE(4) === 0x2112a442;
      done(ok);
    });
    sock.once('error', () => { clearTimeout(timer); done(false); });
    const msg = Buffer.alloc(20);
    msg.writeUInt16BE(0x0001, 0); // binding request
    msg.writeUInt16BE(0, 2);
    msg.writeUInt32BE(0x2112a442, 4); // magic cookie
    randomBytes(12).copy(msg, 8);
    try { sock.send(msg, port, host); } catch { clearTimeout(timer); done(false); }
  });
}

function tcpProbe(host, port, timeoutMs) {
  return new Promise(resolve => {
    const sock = net.connect({ host, port });
    const done = ok => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

async function probeTurnUrl(url) {
  const parsed = parseTurnUrl(url);
  if (!parsed) return { url, reachable: false, note: 'malformed url' };
  const { host, port, scheme, transport } = parsed;
  try {
    await Promise.race([
      dns.lookup(host),
      new Promise((_, rej) => setTimeout(() => rej(new Error('dns timeout')), RTC_PROBE_TIMEOUT)),
    ]);
  } catch {
    return { url, host, port, scheme, transport, reachable: false, note: 'dns failed' };
  }
  let reachable;
  let note;
  if (transport === 'tcp' || scheme === 'turns') {
    reachable = await tcpProbe(host, port, RTC_PROBE_TIMEOUT);
    note = reachable ? 'tcp reachable' : 'tcp connect failed';
  } else {
    reachable = await stunProbeUdp(host, port, RTC_PROBE_TIMEOUT);
    note = reachable ? 'stun binding answered' : 'udp stun request timed out';
  }
  return { url, host, port, scheme, transport, reachable, note };
}

async function rtcHealthReport() {
  const servers = await rtcIceServers();
  const turnUrls = [];
  for (const s of servers) for (const u of s.urls || []) if (/^turns?:/i.test(String(u))) turnUrls.push(String(u));
  const urls = await Promise.all(turnUrls.map(probeTurnUrl));
  const configured = turnUrls.length > 0;
  const reachable = configured ? urls.every(u => u.reachable === true) : null;
  return {
    ok: configured && reachable,   // fully healthy only with an answering relay
    degraded: !configured,         // STUN-only: works for most, fails behind symmetric NAT
    stun: { configured: true },
    turn: { configured, reachable, urls },
  };
}

// ── DB ────────────────────────────────────────────────────────────────────────
function toPostgres(sql) {
  let i = 0;
  return sql
    .replace(/INSERT OR IGNORE INTO/gi, 'INSERT INTO')
    .replace(/INSERT OR REPLACE INTO/gi, 'INSERT INTO')
    .replace(/\?/g, () => `$${++i}`)
    + (sql.match(/INSERT OR IGNORE INTO/i) ? ' ON CONFLICT DO NOTHING' : '')
    + (sql.match(/INSERT OR REPLACE INTO/i) ? ' ON CONFLICT DO NOTHING' : '');
}
// Use SSL for remote DBs (Render), disable for local connections
const isLocalDb = !DATABASE_URL || DATABASE_URL.includes('localhost') || DATABASE_URL.includes('127.0.0.1');
const sslConfig = isLocalDb ? false : { rejectUnauthorized: false };
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: sslConfig,
  max: Number(process.env.PG_POOL_MAX) || 10,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});
pool.on('error', error => console.error('PostgreSQL pool error:', error));
let queryTarget = pool;
const store = {
  type: 'postgres',
  exec: sql => queryTarget.query(sql),
  run: (sql, ...p) => queryTarget.query(toPostgres(sql), p),
  get: async (sql, ...p) => (await queryTarget.query(toPostgres(sql), p)).rows[0],
  all: async (sql, ...p) => (await queryTarget.query(toPostgres(sql), p)).rows,
};

// ── Schema ────────────────────────────────────────────────────────────────────
async function initializeDb() {
  await store.exec(`
    CREATE TABLE IF NOT EXISTS socket_io_attachments (
      id BIGSERIAL UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      payload BYTEA
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      device TEXT DEFAULT '',
      last_seen TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id);
    CREATE TABLE IF NOT EXISTS server_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_by TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE, tag TEXT, password_hash TEXT,
      nickname TEXT, avatar TEXT, banner TEXT, bio TEXT DEFAULT '',
      status TEXT DEFAULT 'Online', custom_status TEXT DEFAULT '',
      is_admin INTEGER DEFAULT 0, is_bot INTEGER DEFAULT 0, bot_token TEXT,
      badge TEXT DEFAULT '', karma INTEGER DEFAULT 0,
      interests TEXT DEFAULT '', anon_active INTEGER DEFAULT 0,
      anon_mask TEXT DEFAULT '', anon_color TEXT DEFAULT '', anon_emoji TEXT DEFAULT '',
      fav_mask TEXT DEFAULT '', fav_color TEXT DEFAULT '', fav_emoji TEXT DEFAULT '',
      privacy_mode TEXT DEFAULT 'standard',
      settings TEXT DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, banned INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY,
      notif_pings INTEGER DEFAULT 1,
      notif_dms INTEGER DEFAULT 1,
      notif_replies INTEGER DEFAULT 1,
      notif_mute_all INTEGER DEFAULT 0,
      privacy_profile INTEGER DEFAULT 0,
      no_friends INTEGER DEFAULT 0,
      chat_bg TEXT DEFAULT 'default',
      profile_theme TEXT DEFAULT '#5865f2',
      show_interests INTEGER DEFAULT 1,
      world_discovery INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS anonymous_identities (
      id TEXT PRIMARY KEY, user_id TEXT, mask_name TEXT, mask_color TEXT,
      mask_emoji TEXT, active INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, gradient TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS friends (
      id TEXT PRIMARY KEY, requester_id TEXT, addressee_id TEXT,
      status TEXT DEFAULT 'pending', created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS communities (
      id TEXT PRIMARY KEY, name TEXT, description TEXT, visibility TEXT,
      owner_id TEXT, rules TEXT, icon TEXT, banner TEXT, invite_code TEXT UNIQUE,
      tags TEXT DEFAULT '', locked INTEGER DEFAULT 0,
      is_topic INTEGER DEFAULT 0, topic_description TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, is_default INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS community_ratings (
      community_id TEXT, user_id TEXT, rating TEXT,
      PRIMARY KEY (community_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS memberships (
      community_id TEXT, user_id TEXT, role TEXT DEFAULT 'member',
      nickname TEXT, muted INTEGER DEFAULT 0,
      PRIMARY KEY (community_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY, community_id TEXT, name TEXT,
      type TEXT DEFAULT 'text', topic TEXT, position INTEGER DEFAULT 0,
      category TEXT DEFAULT 'General', slowmode INTEGER DEFAULT 0,
      expires_at TEXT, is_topic INTEGER DEFAULT 0, topic_description TEXT DEFAULT '',
      discovery_tag TEXT DEFAULT '', locked INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, channel_id TEXT, dm_id TEXT, group_id TEXT,
      sender_id TEXT, body TEXT, reply_to TEXT,
      attachment TEXT, attachment_name TEXT, attachment_type TEXT,
      pinned INTEGER DEFAULT 0, anonymous_reply INTEGER DEFAULT 0,
      edited_at TEXT, deleted_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS message_edits (
      id TEXT PRIMARY KEY, message_id TEXT, old_body TEXT,
      edited_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS reactions (
      message_id TEXT, user_id TEXT, emoji TEXT,
      PRIMARY KEY (message_id, user_id, emoji)
    );
    CREATE TABLE IF NOT EXISTS polls (
      id TEXT PRIMARY KEY, message_id TEXT, channel_id TEXT,
      dm_id TEXT, group_id TEXT, question TEXT, options TEXT,
      created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS poll_votes (
      poll_id TEXT, user_id TEXT, option_index INTEGER,
      PRIMARY KEY (poll_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS dms (
      id TEXT PRIMARY KEY, user_a TEXT, user_b TEXT,
      nickname_a TEXT, nickname_b TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS groups_chat (
      id TEXT PRIMARY KEY, name TEXT, owner_id TEXT,
      icon TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT, user_id TEXT, PRIMARY KEY (group_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY, reporter_id TEXT, target_type TEXT, target_id TEXT,
      reason TEXT, category TEXT DEFAULT 'other', message_body TEXT,
      status TEXT DEFAULT 'open', created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS mod_notes (
      id TEXT PRIMARY KEY, actor_id TEXT, target_user_id TEXT, note TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS blocks (blocker_id TEXT, blocked_id TEXT, PRIMARY KEY (blocker_id, blocked_id));
    CREATE TABLE IF NOT EXISTS moderation_logs (
      id TEXT PRIMARY KEY, actor_id TEXT, action TEXT, target TEXT,
      details TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, user_id TEXT, type TEXT, source_id TEXT,
      source_type TEXT, body TEXT, read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS data_requests (
      id TEXT PRIMARY KEY,
      requester_id TEXT, target_id TEXT,
      reason TEXT DEFAULT '', status TEXT DEFAULT 'pending',
      approved_surfaces TEXT DEFAULT '[]',
      note TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, responded_at TEXT,
      data TEXT
    );
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY, user_id TEXT, message_id TEXT,
      channel_id TEXT, dm_id TEXT, group_id TEXT,
      preview TEXT, remind_at TEXT, fired INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS bot_commands (
      id TEXT PRIMARY KEY, bot_id TEXT, command TEXT, description TEXT,
      response TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS bot_settings (
      community_id TEXT, bot_id TEXT,
      enabled INTEGER DEFAULT 1, allowed_channels TEXT DEFAULT '[]',
      trigger_roles TEXT DEFAULT '[]',
      blocked_roles TEXT DEFAULT '[]',
      PRIMARY KEY (community_id, bot_id)
    );
    CREATE TABLE IF NOT EXISTS bot_command_roles (
      community_id TEXT, bot_id TEXT, command TEXT,
      trigger_roles TEXT DEFAULT '[]', blocked_roles TEXT DEFAULT '[]',
      PRIMARY KEY (community_id, bot_id, command)
    );
    CREATE TABLE IF NOT EXISTS bot_command_visibility (
      community_id TEXT, bot_id TEXT, channel_id TEXT, command TEXT,
      PRIMARY KEY (community_id, bot_id, channel_id, command)
    );
    CREATE TABLE IF NOT EXISTS marketplace_bots (
      id TEXT PRIMARY KEY, name TEXT, emoji TEXT DEFAULT '🤖',
      category TEXT DEFAULT 'Custom', description TEXT,
      commands TEXT, author_id TEXT, author_name TEXT,
      installs INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS bot_releases (
      id TEXT PRIMARY KEY, bot_id TEXT, version TEXT, note TEXT,
      released_by TEXT, released_at TEXT DEFAULT CURRENT_TIMESTAMP,
      commands TEXT
    );
    CREATE TABLE IF NOT EXISTS bot_reviews (
      bot_id TEXT, user_id TEXT, rating INTEGER DEFAULT 5,
      comment TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (bot_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS server_cosmetics (
      community_id TEXT, item_id TEXT, purchased_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (community_id, item_id)
    );
    CREATE TABLE IF NOT EXISTS active_effects (
      community_id TEXT, user_id TEXT, item_id TEXT,
      PRIMARY KEY (community_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS voice_sessions (
      id TEXT PRIMARY KEY, channel_id TEXT, user_id TEXT,
      joined_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS temp_rooms (
      id TEXT PRIMARY KEY, community_id TEXT, name TEXT,
      type TEXT DEFAULT 'chat', owner_id TEXT,
      waiting_room INTEGER DEFAULT 0, ptt INTEGER DEFAULT 0,
      collab_text TEXT DEFAULT '', expires_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS room_members (
      room_id TEXT, user_id TEXT, waiting INTEGER DEFAULT 0,
      joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (room_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS room_messages (
      id TEXT PRIMARY KEY, room_id TEXT, sender_id TEXT, body TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS room_polls (
      id TEXT PRIMARY KEY, room_id TEXT, question TEXT, options TEXT,
      created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS room_poll_votes (
      poll_id TEXT, user_id TEXT, option_index INTEGER,
      PRIMARY KEY (poll_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS arg_completions (
      user_id TEXT PRIMARY KEY, completed_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, title TEXT, description TEXT,
      starts_at TEXT, ends_at TEXT, created_by TEXT, channel_id TEXT,
      active INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS temp_usernames (
      id TEXT PRIMARY KEY, user_id TEXT,      temp_name TEXT, context TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS community_roles (
      id TEXT PRIMARY KEY, community_id TEXT, name TEXT NOT NULL,
      color TEXT DEFAULT '#5865f2', position INTEGER DEFAULT 0,
      permissions TEXT DEFAULT '{}', mentionable INTEGER DEFAULT 0,
      cosmetic TEXT DEFAULT NULL,
      locked INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS member_roles (
      community_id TEXT, user_id TEXT, role_id TEXT,
      PRIMARY KEY (community_id, user_id, role_id)
    );
    CREATE TABLE IF NOT EXISTS channel_permissions (
      channel_id TEXT, role_id TEXT, allow_permissions TEXT DEFAULT '{}', deny_permissions TEXT DEFAULT '{}',
      PRIMARY KEY (channel_id, role_id)
    );
    CREATE TABLE IF NOT EXISTS permission_audit_logs (
      id TEXT PRIMARY KEY, community_id TEXT, actor_id TEXT, action TEXT, target_id TEXT,
      details TEXT DEFAULT '{}', created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS inventory (
      id TEXT PRIMARY KEY, user_id TEXT, item_id TEXT, name TEXT,
      aquired_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS quest_logs (
      user_id TEXT, quest TEXT, day TEXT, reward INTEGER DEFAULT 0,
      PRIMARY KEY (user_id, quest, day)
    );
    -- Admin-defined quests: pasted as a JSON spec (title/icon/metric/need/reward).
    -- computeQuests() merges active rows into the daily quest list automatically.
    CREATE TABLE IF NOT EXISTS custom_quests (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, icon TEXT DEFAULT '🎯',
      description TEXT DEFAULT '', metric TEXT NOT NULL,
      need INTEGER NOT NULL, reward INTEGER NOT NULL,
      active INTEGER DEFAULT 1, spec TEXT DEFAULT '',
      created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS announcements (
      id TEXT PRIMARY KEY, title TEXT, body TEXT, author_id TEXT,
      active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS gift_logs (
      id TEXT PRIMARY KEY, from_id TEXT, to_id TEXT, amount INTEGER, day TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS daily_challenges (
      day TEXT PRIMARY KEY, challenge TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS game_logs (
      id TEXT PRIMARY KEY, user_id TEXT, game TEXT, result TEXT, day TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      root_message_id TEXT UNIQUE,
      channel_id TEXT, dm_id TEXT, group_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS bookmarks (
      user_id TEXT, message_id TEXT, folder TEXT DEFAULT 'Important',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS reveal_posts (
      id TEXT PRIMARY KEY, author_id TEXT, type TEXT DEFAULT 'post',
      body TEXT, media TEXT, media_name TEXT, media_type TEXT,
      quiz TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS reveal_follows (
      follower_id TEXT, followed_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (follower_id, followed_id)
    );
    CREATE TABLE IF NOT EXISTS reveal_likes (
      user_id TEXT, post_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, post_id)
    );
    CREATE TABLE IF NOT EXISTS reveal_post_views (
      user_id TEXT, post_id TEXT, PRIMARY KEY (user_id, post_id)
    );
    CREATE TABLE IF NOT EXISTS reveal_bans (
      user_id TEXT PRIMARY KEY, reason TEXT, banned_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS reveal_removals (
      post_id TEXT PRIMARY KEY, removed_by TEXT, reason TEXT DEFAULT '',
      removed_at TEXT DEFAULT CURRENT_TIMESTAMP,
      appeal_status TEXT DEFAULT 'none', appeal_text TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS reveal_comments (
      id TEXT PRIMARY KEY, post_id TEXT, author_id TEXT, body TEXT,
      parent_id TEXT, pinned INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS reveal_comment_likes (
      comment_id TEXT, user_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (comment_id, user_id)
    );
  `);
  await runMigrations();
  const count = (await store.get('SELECT COUNT(*) AS c FROM users')).c;
  if (!Number(count)) await seed();
  else await ensureOfficialAccount();
  startCleanup();
}

// Prevent two app instances from racing during schema creation and first-run seeding.
// The lock is held in PostgreSQL, so it works across separate Render services too.
async function initDb() {
  const client = await pool.connect();
  const lockKey = 918273645;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [lockKey]);
    // Route the initialization store through the locked session so schema and
    // first-run seeding cannot race when several instances start together.
    queryTarget = client;
    await initializeDb();
  } finally {
    queryTarget = pool;
    try { await client.query('SELECT pg_advisory_unlock($1)', [lockKey]); } catch {}
    client.release();
  }
}

async function runMigrations() {
  const cols = [
    ['users','karma','INTEGER DEFAULT 0'],
    ['users','interests','TEXT DEFAULT \'\''],
    ['users','anon_active','INTEGER DEFAULT 0'],
    ['users','anon_mask','TEXT DEFAULT \'\''],
    ['users','fav_mask','TEXT DEFAULT \'\''],
    ['users','fav_color','TEXT DEFAULT \'\''],
    ['users','fav_emoji','TEXT DEFAULT \'\''],
    ['users','anon_color','TEXT DEFAULT \'\''],
    ['users','anon_emoji','TEXT DEFAULT \'\''],
    ['users','bot_color','TEXT DEFAULT \'\''],
    ['users','bot_emoji','TEXT DEFAULT \'\''],
    ['users','privacy_mode','TEXT DEFAULT \'standard\''],
    ['users','settings','TEXT DEFAULT \'{}\''],
    ['communities','tags','TEXT DEFAULT \'\''],
    ['communities','locked','INTEGER DEFAULT 0'],
    ['communities','is_topic','INTEGER DEFAULT 0'],
    ['communities','topic_description','TEXT DEFAULT \'\''],
    ['channels','expires_at','TEXT'],
    ['channels','is_topic','INTEGER DEFAULT 0'],
    ['channels','topic_description','TEXT DEFAULT \'\''],
    ['channels','discovery_tag','TEXT DEFAULT \'\''],
    ['channels','locked','INTEGER DEFAULT 0'],
    ['messages','group_id','TEXT'],
    ['messages','anonymous_reply','INTEGER DEFAULT 0'],
    ['messages','thread_id','TEXT'],
    ['bot_commands','community_id','TEXT'],
    ['reports','category','TEXT DEFAULT \'other\''],
    ['users','rank','TEXT DEFAULT \'Member\''],
    ['users','credits','INTEGER DEFAULT 0'],
    ['users','active_pet','TEXT'],
    ['community_roles','cosmetic','TEXT'],
    ['community_roles','locked','INTEGER DEFAULT 0'],
    ['bot_settings','blocked_roles','TEXT DEFAULT \'[]\''],
    ['bot_settings','humanize','INTEGER DEFAULT 0'],
    ['users','effect_everywhere','TEXT DEFAULT \'\''],
    ['users','effect_rotation','TEXT DEFAULT \'[]\''],
    ['users','effect_rotation_start','TEXT DEFAULT \'\''],
    ['user_settings','reveal_sort','TEXT DEFAULT \'new\''],
    ['anonymous_identities','gradient','TEXT DEFAULT \'\''],
    ['users','fav_masks','TEXT DEFAULT \'[]\''],
    ['users','server_fav_masks','TEXT DEFAULT \'{}\''],
    ['users','anon_name_color','TEXT DEFAULT \'\''],
    ['communities','pinned_mask','TEXT DEFAULT \'\''],
    ['communities','is_default','INTEGER DEFAULT 0'],
    // quest_logs earnedToday/cap queries SUM(reward); the column was missing on
    // PostgreSQL, which made /api/quests and claiming 500 on Postgres deployments.
    ['quest_logs','reward','INTEGER DEFAULT 0'],
    ['users','totp_secret','TEXT'],
    ['users','totp_enabled','INTEGER DEFAULT 0'],
    ['users','recovery_codes','TEXT DEFAULT \'[]\''],
    ['auth_sessions','device','TEXT DEFAULT \'\''],
    ['auth_sessions','last_seen','TIMESTAMPTZ'],
  ];
  // seed starter credits for existing users
  try {
    await store.exec("UPDATE users SET credits=100 WHERE credits IS NULL OR credits=0 AND is_bot=0");
  } catch {}
  // ensure each user has a default pet in inventory
  try {
    const ids = await store.all("SELECT id FROM users WHERE is_bot=0");
    for (const u of ids) {
      await store.run("INSERT INTO inventory (id,user_id,item_id,name) VALUES (?,?,?,?) ON CONFLICT DO NOTHING", nanoid(), u.id, 'pet_dot', 'Dot');
    }
  } catch {}
  for (const [tbl, col, def] of cols) {
    try { await store.exec(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${def}`); } catch {}
  }
  // ensure invite codes
  try {
    const comms = await store.all("SELECT id FROM communities WHERE invite_code IS NULL OR invite_code=''");
    for (const c of comms) await store.run('UPDATE communities SET invite_code=$1 WHERE id=$2', nanoid(8), c.id);
  } catch {}
  // ensure user_settings rows
  try {
    const users = await store.all('SELECT id FROM users');
    for (const u of users) {
      await store.run('INSERT INTO user_settings (user_id) VALUES (?) ON CONFLICT DO NOTHING', u.id);
    }
  } catch {}
}

function startCleanup() {
  setInterval(async () => {
    try {
      await store.run("DELETE FROM channels WHERE expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP");
      // Temp rooms: purge expired rooms and their children
      const expired = await store.all("SELECT id, community_id FROM temp_rooms WHERE expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP");
      for (const r of expired) {
        await store.run('DELETE FROM room_members WHERE room_id=$1', r.id);
        await store.run('DELETE FROM room_messages WHERE room_id=$1', r.id);
        await store.run('DELETE FROM room_polls WHERE room_id=$1', r.id);
        await store.run('DELETE FROM temp_rooms WHERE id=$1', r.id);
        io.to(r.community_id).emit('room_update', { action:'deleted', id:r.id });
      }
    } catch {}
  }, 60 * 1000);
  // Expired sessions are never accepted and can be pruned without affecting live users.
  setInterval(() => store.run('DELETE FROM auth_sessions WHERE expires_at <= CURRENT_TIMESTAMP OR revoked_at IS NOT NULL').catch(() => {}), 60 * 60 * 1000);
}

async function ensureOfficialAccount() {
  for (const account of configuredPrivilegedAccounts) {
    const existing = await store.get('SELECT * FROM users WHERE username=$1', account.username);
    if (!existing) {
      const created = await createUser(account.username, 'real', account.password);
      await store.run('UPDATE users SET rank=$1,nickname=$2,is_admin=1 WHERE id=$3', account.rank, `${account.rank} Account`, created.id);
    } else {
      await store.run('UPDATE users SET tag=$1,nickname=$2,rank=$3,is_admin=1,password_hash=$4 WHERE username=$5',
        'real', `${account.rank} Account`, account.rank, bcrypt.hashSync(account.password, 10), account.username);
    }
  }
}

async function seed() {
  const primary = configuredPrivilegedAccounts[0] || { rank:'Administrator', username:OFFICIAL_ACCOUNT_USERNAME, password:OFFICIAL_ACCOUNT_PASSWORD };
  const admin = await createUser(primary.username, 'real', primary.password);
  await store.run('UPDATE users SET rank=$1 WHERE id=$2', primary.rank, admin.id);
  for (const account of configuredPrivilegedAccounts.slice(1)) {
    const created = await createUser(account.username, 'real', account.password);
    await store.run('UPDATE users SET rank=$1 WHERE id=$2', account.rank, created.id);
  }
  const comm = nanoid(); const invCode = nanoid(8);
  await store.run(`INSERT INTO communities
    (id,name,description,visibility,owner_id,rules,icon,banner,invite_code,tags,locked,is_topic,topic_description,is_default,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,0,0,?,1,CURRENT_TIMESTAMP)`,
    comm,'Unknown Lounge','Official privacy-first community.','public',admin.id,
    'Avoid personal information. Respect consent. Report abuse.',null,null,invCode,'gaming,general','');
  await store.run('INSERT INTO memberships VALUES (?,?,?,?,0)', comm, admin.id, 'owner', null);
  await store.run('INSERT INTO user_settings (user_id) VALUES (?) ON CONFLICT DO NOTHING', admin.id);
  const chans = [
    ['welcome','text','General','Official updates','0',''],
    ['general','text','General','Anonymous conversation','1','awake'],
    ['gaming','text','Gaming','Find people to play with','2','gaming'],
    ['party-up','text','Gaming','Create a party or game room','3','gaming'],
    ['chill','text','Chill','Just hang out','4','chill'],
    ['voice-lounge','voice','Voice','Hang out','5',''],
  ];
  for (const [name,type,cat,topic,pos,dtag] of chans) {
    await store.run('INSERT INTO channels VALUES (?,?,?,?,?,?,?,0,NULL,0,?,?,0,CURRENT_TIMESTAMP)',
      nanoid(),comm,name,type,topic,parseInt(pos),cat,dtag,'');
  }
}

async function createUser(username, tag, password) {
  const id = nanoid();
  const isAdmin = tag === 'real' ? 1 : 0;
  const nickname = tag === 'real' ? 'Official Administrator' : username;
  await store.run('INSERT INTO users (id,username,tag,password_hash,nickname,is_admin) VALUES (?,?,?,?,?,?)',
    id, username, tag ?? Math.floor(1000+Math.random()*9000).toString(), bcrypt.hashSync(password,10), nickname, isAdmin);
  await store.run('INSERT INTO user_settings (user_id) VALUES (?) ON CONFLICT DO NOTHING', id);
  return { id, username, tag };
}

await initDb();

// ── Helpers ───────────────────────────────────────────────────────────────────
const app = express();
// Blob/data URLs are required by the avatar feature (IndexedDB-hosted 2D/3D
// avatar art is loaded as blob: URLs; canvas streams and data: images are used
// across the media surfaces). Helmet's default CSP only allows 'self'.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'script-src': ["'self'", "'wasm-unsafe-eval'"],
      'img-src': ["'self'", 'data:', 'blob:'],
      'media-src': ["'self'", 'blob:', 'data:'],
      'connect-src': ["'self'", 'blob:'],
      'worker-src': ["'self'", 'blob:'],
    },
  },
}));
const allowedOrigins = String(process.env.CORS_ORIGIN || '')
  .split(',').map(value => value.trim()).filter(Boolean);
// Same-origin deployments do not need CORS. An explicit allowlist is only
// enabled when a separately hosted client is configured.
const corsOrigin = allowedOrigins.length ? allowedOrigins : false;
app.use(cors({
  origin: corsOrigin,
  credentials: false,
}));
app.use(express.json({ limit: '8mb' }));
app.use('/uploads', express.static(uploadDir, {
  dotfiles: 'deny',
  fallthrough: false,
  setHeaders: (res) => {
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  },
}));

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 20 },
  fileFilter: (_req, file, cb) => {
    const allowed = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|ogg|wav))$/i;
    cb(allowed.test(file.mimetype) ? null : new Error('Unsupported upload type'), allowed.test(file.mimetype));
  },
});

const publicUser = u => u && ({
  id:u.id, username:u.username, tag:u.tag, nickname:u.nickname||u.username,
  avatar:u.avatar, banner:u.banner, bio:u.bio||'', status:u.status||'Online',
  custom_status:u.custom_status||'', is_admin:Boolean(Number(u.is_admin)),
  is_bot:Boolean(Number(u.is_bot)), badge:u.badge||'', karma:Number(u.karma||0),
  banned:Boolean(Number(u.banned)), interests:u.interests||'',
  anon_active:Boolean(Number(u.anon_active)), anon_mask:u.anon_mask||'', anon_color:u.anon_color||'', anon_emoji:u.anon_emoji||'', anon_name_color:u.anon_name_color||'',
  bot_color:u.bot_color||'', bot_emoji:u.bot_emoji||'',
  fav_mask:u.fav_mask||'', fav_color:u.fav_color||'', fav_emoji:u.fav_emoji||'',
  fav_masks:u.fav_masks||'[]', server_fav_masks:u.server_fav_masks||'{}', rank:u.rank||'Member',
  privacy_mode:u.privacy_mode||'standard',  credits:Number(u.credits||0), active_pet:u.active_pet||null,
});
const sessions = createSessionManager({ store, jwt, secret: JWT_SECRET, publicUser });

async function resolveRequestUser(req) {
  const authorization = String(req.headers.authorization || '');
  const rawToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  try {
    return await sessions.resolve(rawToken);
  } catch {
    const botToken = req.headers['x-bot-token'];
    if (!botToken) throw new Error('Authentication required');
    const bot = await store.get('SELECT * FROM users WHERE bot_token=$1 AND is_bot=1', botToken);
    if (!bot || Number(bot.banned)) throw new Error('Invalid bot token');
    return publicUser(bot);
  }
}

function auth(req, res, next) {
  resolveRequestUser(req)
    .then(user => { req.user = user; next(); })
    .catch(error => res.status(401).json({ error: error.message === 'Invalid bot token' ? error.message : 'Authentication required' }));
}
function adminOnly(req,res,next){ if(req.user?.is_admin) return next(); res.status(403).json({error:'Admin only'}); }

const ROLE_PERMISSIONS = ['view_channel','read_messages','send_messages','attach_files','add_reactions','connect_voice','speak_voice','share_screen','manage_messages','timeout_members','kick_members','ban_members','manage_channels','manage_roles','manage_server'];
const STAFF_ROLE_LEVELS = { Mod: 10, 'Sr. Mod': 20, 'Jr. admin': 30, admin: 40, Dev: 50, 'Head Mod': 60, 'Head admin': 70, Manager: 80, Administrator: 90, Owner: 100, Founder: 110 };
const NORMAL_RANK_LEVELS = { New: 0, Beginner: 1, Starter: 2, Member: 3, Trusted: 4, Community: 5, Celebrity: 6, Known: 7 };
// Effective staff/membership authority of a user. Uses the highest of the global staff
// rank, the platform normal rank, and (optionally) their per-server membership role.
function rankLevel(u) {
  if (!u) return -1;
  if (STAFF_ROLE_LEVELS[u.rank] != null) return STAFF_ROLE_LEVELS[u.rank];
  if (NORMAL_RANK_LEVELS[u.rank] != null) return NORMAL_RANK_LEVELS[u.rank];
  return u.is_admin ? 90 : 0;
}
const MEMBER_ROLE_LEVELS = { member: 5, mod: 10, admin: 70, owner: 100 };
async function userAuthority(communityId, userId) {
  const u = (await store.get('SELECT rank,is_admin FROM users WHERE id=$1', userId)) || {};
  let lvl = rankLevel(u);
  if (communityId) {
    const mem = await store.get('SELECT role FROM memberships WHERE community_id=$1 AND user_id=$2', communityId, userId);
    if (mem && (MEMBER_ROLE_LEVELS[mem.role] ?? 0) > lvl) lvl = MEMBER_ROLE_LEVELS[mem.role];
  }
  return lvl;
}
// A staff member may only act on someone strictly below them. Founder(110) > Owner(100) >
// Administrator(90) > ... > Mod(10). Equal or higher targets are off-limits.
async function canModerateTarget(actorId, communityId, targetId) {
  const [actorAuth, targetAuth] = await Promise.all([userAuthority(communityId, actorId), userAuthority(communityId, targetId)]);
  return actorAuth > targetAuth;
}
function parsePermissions(value) { try { return typeof value === 'string' ? JSON.parse(value || '{}') : (value || {}); } catch { return {}; } }
async function communityAccess(userId, communityId) {
  const mem = await store.get('SELECT * FROM memberships WHERE community_id=$1 AND user_id=$2', communityId, userId);
  if (!mem) return { member:null, permissions:{} };
  const roles = await store.all(`SELECT r.* FROM community_roles r JOIN member_roles mr ON mr.role_id=r.id AND mr.community_id=$1 AND mr.user_id=$2 ORDER BY r.position DESC`, communityId, userId);
  const permissions = {};
  for (const role of roles) Object.assign(permissions, parsePermissions(role.permissions));
  if (mem.role === 'owner' || mem.role === 'admin') permissions.manage_server = true;
  return { member:mem, roles, permissions };
}
function requirePermission(permission) { return route(async (req,res,next) => {
  if (req.user?.is_admin) return next();
  const access = await communityAccess(req.user.id, req.communityId || req.params.communityId || req.body.communityId);
  if (!access.member || (access.permissions[permission] !== true && !['owner','admin'].includes(access.member.role))) return res.status(403).json({error:`Missing permission: ${permission}`});
  req.access = access; next();
}); }
const route = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);

async function canAccessResource(user, { channelId, dmId, groupId }) {
  const targets = [channelId, dmId, groupId].filter(Boolean);
  if (targets.length !== 1) return false;
  // Platform admin status does not override private DM/group membership. It may
  // still inspect server channels for moderation purposes.
  if (user?.is_admin && channelId) return true;
  if (channelId) {
    const channel = await store.get('SELECT community_id FROM channels WHERE id=$1', channelId);
    if (!channel) return false;
    return Boolean(await store.get('SELECT 1 FROM memberships WHERE community_id=$1 AND user_id=$2', channel.community_id, user.id));
  }
  if (dmId) return Boolean(await store.get('SELECT 1 FROM dms WHERE id=$1 AND (user_a=$2 OR user_b=$2)', dmId, user.id));
  if (groupId) return Boolean(await store.get('SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2', groupId, user.id));
  return false;
}

async function canAccessRoom(user, roomId, requireMember = false) {
  const room = await store.get('SELECT * FROM temp_rooms WHERE id=$1', roomId);
  if (!room) return { room:null, allowed:false };
  if (user?.is_admin) return { room, allowed:true };
  const communityMember = await store.get('SELECT 1 FROM memberships WHERE community_id=$1 AND user_id=$2', room.community_id, user.id);
  if (!communityMember) return { room, allowed:false };
  if (!requireMember) return { room, allowed:true };
  const member = await store.get('SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2 AND waiting=0', room.id, user.id);
  return { room, allowed:Boolean(member) };
}

// slowmode tracking
const lastMsg = new Map(); // `${userId}:${channelId}` -> timestamp

function safeParse(x, fb){ try { return JSON.parse(x); } catch { return fb; } }
async function notifyDataRequest(userId, type, sourceId, body) {
  await createNotification(userId, type, sourceId, 'data_request', body);
  io.to('user:'+userId).emit('notification',{type, sourceId, sourceType:'data_request', body});
}
async function createNotification(userId, type, sourceId, sourceType, body) {
  const id = nanoid();
  await store.run('INSERT INTO notifications VALUES (?,?,?,?,?,?,0,CURRENT_TIMESTAMP)', id, userId, type, sourceId, sourceType, body);
}

// ── Credits / Quests / Shop ───────────────────────────────────────────────────
const SHOP_ITEMS = [
  { id:'pet_dot',   name:'Dot',        emoji:'🐾', price:0,    desc:'A tiny pixel companion every new account owns. Semi-custom: rename it anytime.' },
  { id:'pet_cat',   name:'Midnight Cat', emoji:'🐱', price:200, desc:'A sleek shadow cat that follows your profile.' },
  { id:'pet_dog',   name:'Comet Dog',    emoji:'🐶', price:200, desc:'A loyal little friend. Rename and dress your bond.' },
  { id:'pet_fox',   name:'Neon Fox',     emoji:'🦊', price:350, desc:'A glitch-pixel fox. Semi-custom with your own name.' },
  { id:'pet_dragon',name:'Ember Dragon', emoji:'🐉', price:500, desc:'A rare hatchling with a custom name.' },
  { id:'pet_ghost', name:'Phantom Ghost',emoji:'👻', price:250, desc:'Walks through walls. Yours to name.' },
  { id:'pet_robot', name:'Circuit Bot',  emoji:'🤖', price:300, desc:'Beep boop. Semi-custom companion.' },
  { id:'pet_owl',   name:'Owlbert',     emoji:'🦉', price:300, desc:'A wise companion that hoots at sunrise.' },
  { id:'pet_panda', name:'Bamboo Panda',emoji:'🐼', price:320, desc:'Chill, fuzzy, and definitely napping.' },
  { id:'pet_dino',  name:'Tiny Rex',    emoji:'🦖', price:400, desc:'A fierce but smol dinosaur.' },
];
const DEFAULT_QUEST_LIMIT = 1; // how many times each quest can be claimed per day
const DAILY_REWARD_CAP = 150;  // max credits earnable from quests per day
const DAILY_GIFT_LIMIT = 5;    // max gifts you may send per day
const TODAY = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD (local, matches CURRENT_DATE)

// 🛍 Server cosmetics — purchasable with credits, owned per-server.
// kind: 'role' (creates a custom role) | 'banner' (sets a gradient banner) | 'effect' (shows next to your name in that server)
const SERVER_COSMETICS = [
  { id:'role_gold',  kind:'role',   emoji:'🏅', name:'Golden Role',   price:150, color:'#f0b232', desc:'Creates a prestigious gold role for your server.' },
  { id:'role_neon',  kind:'role',   emoji:'💜', name:'Neon Role',     price:150, color:'#eb459e', desc:'A glowing neon-pink role with serious swagger.' },
  { id:'role_ember', kind:'role',   emoji:'🔥', name:'Ember Role',    price:150, color:'#f23f42', desc:'A fiery role for your most loyal members.' },
  { id:'banner_aurora', kind:'banner', emoji:'🌌', name:'Aurora Banner', price:250, desc:'A shifting aurora gradient for your server header.' },
  { id:'banner_sunset', kind:'banner', emoji:'🌅', name:'Sunset Banner', price:250, desc:'Warm sunset hues wrapped around your server.' },
  { id:'banner_ocean',  kind:'banner', emoji:'🌊', name:'Ocean Banner',  price:250, desc:'Deep blues and teals like the open sea.' },
  { id:'effect_sparkle', kind:'effect', emoji:'✨', name:'Sparkle Effect', price:100, desc:'A sparkle trails your name in this server.' },
  { id:'effect_flame',  kind:'effect', emoji:'🔥', name:'Flame Effect',   price:100, desc:'Your name smolders with fire here.' },
  { id:'effect_glow',   kind:'effect', emoji:'💫', name:'Glow Effect',    price:100, desc:'A soft glow surrounds your name in chat.' },
];
const COSMETIC_BANNER_GRADIENTS = {
  banner_aurora: 'linear-gradient(135deg,#00c6fb 0%,#005bea 50%,#7f00ff 100%)',
  banner_sunset: 'linear-gradient(135deg,#ff9a9e 0%,#fad0c4 40%,#fbc2eb 100%)',
  banner_ocean:  'linear-gradient(135deg,#2e3192 0%,#1bffff 100%)',
};

// 🎲 DO SOMETHING RANDOM → daily challenge pool. Metrics reuse the same
// message counts computeQuests() already computes, so progress is countable
// with zero extra instrumentation. One challenge is live per day for everyone.
const CHALLENGES = [
  { id:'challenge_chatter', title:'Chat Storm',      desc:'Send 7 messages today',                 need:7,  reward:30, metric:'msgs'   },
  { id:'challenge_server',  title:'Server Loyalist', desc:'Send 5 messages in a server today',    need:5,  reward:25, metric:'server' },
  { id:'challenge_dm',      title:'Reach Out',       desc:'Send 3 direct messages today',         need:3,  reward:25, metric:'dm'     },
  { id:'challenge_group',   title:'Squad Up',        desc:'Send 2 messages in a group chat today',need:2,  reward:20, metric:'group'  },
  { id:'challenge_novel',   title:'Marathon',        desc:'Send 20 messages total today',         need:20, reward:45, metric:'msgs'   },
];
async function getTodayChallenge() {
  const row = await store.get('SELECT challenge FROM daily_challenges WHERE day=$1', TODAY());
  if (!row) return null;
  return CHALLENGES.find(c => c.id === row.challenge) || null;
}

// 🤖 Bot marketplace templates — server owners install these with one click.
// A `||` inside a response means "pick one at random" when the bot replies.
const BOT_TEMPLATES = [
  {
    id:'trivia', emoji:'🧠', name:'Trivia Bot', category:'Games',
    desc:'Hosts live trivia games in chat — scores and leaderboard included.',
    commands:[
      { command:'trivia', description:'Start / step a trivia game', response:'{{game:trivia}}' },
      { command:'answer', description:'Answer the current trivia question', response:'{{game:trivia_answer}}' },
      { command:'score', description:'Show bot game scores', response:'{{game:score}}' },
      { command:'fact', description:'Get a random fun fact', response:'💡 Fact: Honey never spoils.||💡 Fact: Octopuses have three hearts.||💡 Fact: Bananas are berries, but strawberries are not.||💡 Fact: A day on Venus is longer than a year on Venus.' },
    ],
  },
  {
    id:'welcome', emoji:'👋', name:'Welcome Bot', category:'Community',
    desc:'Greets new members and points people to your rules.',
    commands:[
      { command:'welcome', description:'Get a warm welcome', response:'👋 Welcome to the server! Say hi and tell everyone a bit about yourself.' },
      { command:'rules', description:'Show the server rules', response:'📜 Rules: 1) Be kind 2) No spam 3) No personal info 4) Have fun! Reach out to a mod if you need help.' },
    ],
  },
  {
    id:'guard', emoji:'🛡️', name:'Guard Bot', category:'Moderation',
    desc:'Helps members report issues and find moderation info.',
    commands:[
      { command:'report', description:'How to report something', response:'🚩 To report a message, hover it and hit 🚩. Reports go straight to the moderation queue.' },
      { command:'mods', description:'Get mod guidance', response:'🛡️ Need a moderator? Tag a mod or check the member list for staff. Serious issues: use the 🚩 report button.' },
    ],
  },
  {
    id:'fun', emoji:'🎲', name:'Fun Bot', category:'Games',
    desc:'Coins, dice, jokes, 8-ball — and hosts tic-tac-toe against you or a friend.',
    commands:[
      { command:'ttt', description:'Start tic-tac-toe (/ttt @user to play a friend)', response:'{{game:ttt}}' },
      { command:'move', description:'Play a tic-tac-toe move (1-9)', response:'{{game:ttt_move}}' },
      { command:'score', description:'Show bot game scores', response:'{{game:score}}' },
      { command:'coin', description:'Flip a coin', response:'🪙 It landed on heads!||🪙 It landed on tails!' },
      { command:'dice', description:'Roll a die', response:'🎲 You rolled a 1!||🎲 You rolled a 2!||🎲 You rolled a 3!||🎲 You rolled a 4!||🎲 You rolled a 5!||🎲 You rolled a 6!' },
      { command:'joke', description:'Tell a joke', response:'😂 Why do programmers prefer dark mode? Because light attracts bugs!||😂 I told my computer I needed a break… now it won\'t stop sending me KitKats.||😂 Why did the server go to therapy? It had too many unresolved connections!' },
      { command:'8ball', description:'Ask the magic 8-ball', response:'🔮 Outlook good.||🔮 Ask again later.||🔮 Definitely not.||🔮 Signs point to yes.||🔮 Cannot predict now.' },
    ],
  },
  {
    id:'poll', emoji:'📊', name:'Poll Bot', category:'Utility',
    desc:'Explains polls and helps run quick votes.',
    commands:[
      { command:'poll', description:'How to make a poll', response:'📊 Hit the 📊 button in the channel header to create a poll, or drop one with the 🎲 button!' },
      { command:'vote', description:'Voting tips', response:'🗳️ You can vote on any poll by clicking an option — results update live for everyone.' },
    ],
  },
  {
    id:'music', emoji:'🎵', name:'Music Bot', category:'Utility',
    desc:'Suggests tunes and shares listening ideas.',
    commands:[
      { command:'song', description:'Get a song suggestion', response:'🎵 You should listen to something by Tame Impala today.||🎵 Try some lo-fi beats to chill out.||🎵 Classic rock always hits — spin some Queen.||🎵 Electronic? Give Daft Punk\'s Discovery a spin.' },
      { command:'playlist', description:'Playlist idea', response:'📻 Playlist idea: 3 upbeat songs, 2 chill, 1 throwback. Share it in chat!' },
    ],
  },
];


function petById(id) { return SHOP_ITEMS.find(p => p.id === id) || null; }

// Quests are measured from data the app already stores (messages have created_at)
// so progress is computed server-side. The daily limit prevents re-claiming them.
async function computeQuests(userId) {
  const day = TODAY();
  async function count(sql) {
    const r = await store.get(sql, userId);
    return Number(r?.c || 0);
  }
  const msgsToday    = await count("SELECT COUNT(*) AS c FROM messages WHERE sender_id=$1 AND created_at::date=CURRENT_DATE");
  const dmToday      = await count("SELECT COUNT(*) AS c FROM messages WHERE sender_id=$1 AND dm_id IS NOT NULL AND created_at::date=CURRENT_DATE");
  const groupToday   = await count("SELECT COUNT(*) AS c FROM messages WHERE sender_id=$1 AND group_id IS NOT NULL AND created_at::date=CURRENT_DATE");
  const serverToday  = await count("SELECT COUNT(*) AS c FROM messages WHERE sender_id=$1 AND channel_id IS NOT NULL AND created_at::date=CURRENT_DATE");
  // Pre-existing bug fix: count() passes only the user id, but this statement has
  // two placeholders, so it crashed /api/quests on PostgreSQL. Pass both values.
  const gamesToday   = Number((await store.get('SELECT COUNT(*) AS c FROM game_logs WHERE user_id=$1 AND day=$2', userId, day))?.c || 0);
  const roomsToday   = await count("SELECT COUNT(*) AS c FROM room_messages WHERE sender_id=$1 AND created_at::date=CURRENT_DATE");
  // NB: this server's placeholder adapter renumbers every occurrence, so each
  // reused value needs its own positional placeholder (pass the user twice).
  const friendsToday = Number((await store.get("SELECT COUNT(*) AS c FROM friends WHERE status='accepted' AND (requester_id=$1 OR addressee_id=$2) AND created_at::date=CURRENT_DATE", userId, userId))?.c || 0);
  const claimedRows  = await store.all('SELECT quest FROM quest_logs WHERE user_id=$1 AND day=$2', userId, day);
  const claimed = new Set(claimedRows.map(r => r.quest));
  // Every timestamped activity surface the app stores counts toward a quest
  // metric, so admin-defined quests can target any of them ("full compatibility").
  const metrics = { msgs: msgsToday, server: serverToday, dm: dmToday, group: groupToday, rooms: roomsToday, games: gamesToday, friends: friendsToday, gamer: gamesToday, arcade: gamesToday };
  const defs = [
    { id:'first',  title:'First Light',      desc:'Send your first message of the day',            need:1,   reward:10 },
    { id:'chatter',title:'Chatter',          desc:'Send 5 messages today',                          need:5,   reward:25 },
    { id:'server', title:'Server Regular',   desc:'Send 3 messages in a server today',             need:3,   reward:20 },
    { id:'dm',     title:'Connector',        desc:'Send a direct message today',                     need:1,   reward:15 },
    { id:'group',  title:'Group Up',         desc:'Send a message in a group chat today',           need:1,   reward:20 },
    { id:'novel',  title:'Rising Star',      desc:'Send 40 messages total today',                    need:40,  reward:60 },
    { id:'gamer',  title:'Player One',       desc:'Play a mini game today',                          need:1,   reward:15 },
    { id:'arcade', title:'Arcade Addict',    desc:'Play 3 mini games today',                         need:3,   reward:30 },
  ];
  // Today's server-wide random challenge (rolled with the 🎲 button) is countable too
  const challenge = await getTodayChallenge();
  if (challenge) {
    defs.push({ id: challenge.id, title: challenge.title, desc: challenge.desc, need: challenge.need, reward: challenge.reward, challenge: true });
    metrics[challenge.id] = metrics[challenge.metric] || 0;
  }
  const progressMap = { first: msgsToday, chatter: msgsToday, server: serverToday, dm: dmToday, group: groupToday, novel: msgsToday };
  // Admin-defined quests (created in the Admin → Quests panel) join the same list,
  // share the same claim/limits/credits pipeline, and surface in every quest UI.
  // They carry their own progress (progressMap/metrics are keyed by built-in ids),
  // so the final map below must not recompute them.
  try {
    const customRows = await store.all('SELECT * FROM custom_quests WHERE active=1 ORDER BY created_at');
    for (const c of customRows) {
      const m = metrics[c.metric];
      if (m === undefined) continue; // unknown metric (should not happen; validation blocks it)
      const need = Number(c.need), reward = Number(c.reward);
      const progress = Math.min(need, m);
      defs.push({
        id: c.id, title: c.title, desc: c.description || c.title, icon: c.icon || '🎯', metric: c.metric,
        need, reward, progress, done: progress >= need, claimed: claimed.has(c.id), custom: true,
      });
    }
  } catch { /* custom quests unavailable (e.g. very old db) — built-ins still work */ }
  return defs.map(d => d.custom
    ? { ...d, claimed: claimed.has(d.id) }
    : { ...d, progress: Math.min(d.need, progressMap[d.id] ?? metrics[d.id] ?? 0), done: (progressMap[d.id] ?? metrics[d.id] ?? 0) >= d.need, claimed: claimed.has(d.id) });
}

async function getUserCredits(userId) {
  const u = await store.get('SELECT credits,active_pet FROM users WHERE id=$1', userId);
  return { credits: Number(u?.credits||0), active_pet: u?.active_pet || null };
}

async function addCredits(userId, amount) {
  await store.run('UPDATE users SET credits=LEAST(GREATEST(credits+$1,0), 100000) WHERE id=$2', Math.round(amount), userId);
}
// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', route(async (_,res) => {
  await store.exec('SELECT 1');
  res.json({ok:true,database:'postgres',service:'unknown-chat-platform'});
}));

// Operator-facing WebRTC/TURN diagnostics. Returns 200 even when degraded so
// dashboards can read the flags; never echoes TURN credentials.
app.get('/api/health/rtc', route(async (_,res) => {
  res.json(await rtcHealthReport());
}));

// ── Relay (TURN) settings ─────────────────────────────────────────────────────
// Operator-editable voice/video relay config, stored in the shared PostgreSQL
// database so every instance serves the same iceServers. The environment
// variables remain the fallback when a value is cleared. The credential is
// write-only: it is never included in any response; the client only learns
// whether one is configured.
app.get('/api/admin/rtc', auth, adminOnly, route(async (req,res) => {
  const { turnUrls, username, credential } = await effectiveRtcValues();
  const rows = await store.all("SELECT key FROM server_settings WHERE key LIKE 'rtc_%'").catch(() => []);
  res.json({
    source: rows.length ? 'db' : 'env',
    turnUrls: String(turnUrls || ''),
    username: username || '',
    credentialConfigured: Boolean(credential),
    health: await rtcHealthReport(),
  });
}));

app.put('/api/admin/rtc', auth, adminOnly, route(async (req,res) => {
  const urls = String(req.body.turnUrls || '').trim();
  const username = String(req.body.username || '').trim();
  const credential = String(req.body.credential || '');
  const clearCredential = Boolean(req.body.clearCredential);
  if (urls) {
    const bad = urls.split(',').map(x => x.trim()).filter(Boolean)
      .find(x => !/^turns?:(?:\/\/)?[^:/?#\s]+(?::\d+)?(?:\?.*)?$/i.test(x));
    if (bad) return res.status(400).json({ error: `Invalid TURN url: ${bad}` });
  }
  const setOrClear = async (key, value) => {
    if (value) {
      await store.run(`INSERT INTO server_settings (key, value, updated_by) VALUES (?,?,?)
        ON CONFLICT (key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=CURRENT_TIMESTAMP`,
        key, value, req.user.id);
    } else {
      await store.run('DELETE FROM server_settings WHERE key=$1', key);
    }
  };
  await setOrClear('rtc_turn_urls', urls);
  await setOrClear('rtc_turn_username', username);
  if (clearCredential) await store.run("DELETE FROM server_settings WHERE key='rtc_turn_credential'");
  else if (credential) await setOrClear('rtc_turn_credential', credential);
  const effective = await effectiveRtcValues();
  res.json({
    ok: true,
    source: 'db',
    credentialConfigured: Boolean(effective.credential),
    health: await rtcHealthReport(),
  });
}));

// TOTP second-factor helpers.
function secretFor(user) {
  const raw = user.totp_secret || '';
  try {
    const s = JSON.parse(raw);
    if (s && typeof s === 'object' && s.v) return String(s.v);
  } catch {}
  // Raw base32 secrets (or any non-JSON value) are accepted as-is.
  return raw;
}
async function consumeRecoveryCode(userId, code) {
  const u = await store.get('SELECT recovery_codes FROM users WHERE id=$1', userId);
  if (!u) return false;
  let list = [];
  try { list = JSON.parse(u.recovery_codes || '[]'); } catch {}
  const h = hashRecoveryCode(code);
  if (!list.includes(h)) return false;
  await store.run('UPDATE users SET recovery_codes=$1 WHERE id=$2', JSON.stringify(list.filter(x => x !== h)), userId);
  return true;
}
async function verifySecondFactor(user, code) {
  const clean = String(code || '').replace(/\s/g, '');
  const secret = secretFor(user);
  if (secret && verifyCode(secret, clean)) return 'totp';
  if (/^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/.test(clean) && await consumeRecoveryCode(user.id, clean.toUpperCase())) return 'recovery';
  return null;
}
async function noteNewDevice(userId, deviceLabel) {
  if (!deviceLabel) return;
  try {
    // A fresh account is still being set up, so the extra live session is just
    // the registration tab - only raise the banner once the account has had a
    // chance to settle and a genuinely new device shows up.
    const settled = await store.get("SELECT id FROM users WHERE id=$1 AND created_at::timestamptz < CURRENT_TIMESTAMP - INTERVAL '10 minutes'", userId);
    if (!settled) return;
    const live = await store.get('SELECT COUNT(*) AS c FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP', userId);
    if (!live || Number(live.c) < 2) return;
    const body = 'New sign-in from ' + deviceLabel;
    await createNotification(userId, 'new_login', '', '', body);
    io.to('user:' + userId).emit('notification', { type: 'new_login', sourceId: '', sourceType: '', body });
  } catch {}
}

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/register', route(async (req,res) => {
  const username = String(req.body.username||'').replace(/[^\w-]/g,'').slice(0,24);
  const password = String(req.body.password||'');
  if (!username || password.length<6) return res.status(400).json({error:'Username and password (min 6 chars) required'});
  try {
    const user = await createUser(username, undefined, password);
    // Auto-join the default public community so first-run users land inside a real
    // space instead of an empty home. Admins can mark one with is_default; otherwise
    // fall back to the oldest public community. Public-only: never force a new
    // account into a private community.
    const defaultComm = await store.get("SELECT id FROM communities WHERE visibility='public' ORDER BY is_default DESC, created_at, id LIMIT 1");
    if (defaultComm) {
      await store.run('INSERT INTO memberships VALUES (?,?,?,?,0) ON CONFLICT DO NOTHING', defaultComm.id, user.id, 'member', null);
    }
    const full = publicUser(await store.get('SELECT * FROM users WHERE id=$1', user.id));
    res.json({token:await sessions.issue(full, { device: String(req.body.device||'').slice(0, 80) }), user:full});
  } catch { res.status(409).json({error:'Username unavailable'}); }
}));

app.post('/api/login', route(async (req,res) => {
  const username = String(req.body.username||'').trim();
  const password = String(req.body.password||'');
  const u = await store.get('SELECT * FROM users WHERE username=$1', username);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) return res.status(401).json({error:'Invalid login'});
  if (Number(u.banned)) return res.status(403).json({error:'Account banned'});
  const pu = publicUser(u);
  if (Number(u.totp_enabled)) {
    // Second step required: hand back a short-lived, purpose-bound pre-token.
    const pre = jwt.sign({ id: u.id, purpose: '2fa' }, JWT_SECRET, { expiresIn: '10m' });
    return res.json({ need2fa: true, preToken: pre, username: u.username });
  }
  const device = String(req.body.device||'').slice(0, 80);
  const knownDevice = device ? await store.get('SELECT id FROM auth_sessions WHERE user_id=$1 AND device=$2 AND revoked_at IS NULL', u.id, device) : null;
  const token = await sessions.issue(pu, { device });
  if (!knownDevice) await noteNewDevice(u.id, device);
  res.json({ token, user: pu, totpEnabled: false });
}));

app.post('/api/login/2fa', route(async (req,res) => {
  let claims;
  try { claims = jwt.verify(String(req.body.preToken||''), JWT_SECRET); } catch {}
  if (!claims || claims.purpose !== '2fa' || !claims.id) return res.status(401).json({error:'Login expired, please sign in again'});
  const u = await store.get('SELECT * FROM users WHERE id=$1', claims.id);
  if (!u || Number(u.banned)) return res.status(403).json({error:'Account unavailable'});
  const kind = await verifySecondFactor(u, String(req.body.code||''));
  if (!kind) return res.status(401).json({error:'Invalid or expired code'});
  const pu = publicUser(u);
  const device = String(req.body.device||'').slice(0, 80);
  const knownDevice = device ? await store.get('SELECT id FROM auth_sessions WHERE user_id=$1 AND device=$2 AND revoked_at IS NULL', u.id, device) : null;
  const token = await sessions.issue(pu, { device });
  if (!knownDevice) await noteNewDevice(u.id, device);
  res.json({ token, user: pu, totpEnabled: true, usedRecovery: kind === 'recovery' });
}));


app.post('/api/logout', auth, route(async (req,res) => {
  await sessions.revoke(req.user.sessionId);
  res.json({ok:true});
}));

app.get('/api/bootstrap', auth, route(async (req,res) => {
  const me = publicUser(await store.get('SELECT * FROM users WHERE id=$1', req.user.id));
  const communities = await store.all('SELECT * FROM communities ORDER BY created_at');
  const channels = await store.all('SELECT * FROM channels ORDER BY position,created_at');
  const users = await store.all('SELECT id,username,tag,nickname,avatar,status,custom_status,is_admin,is_bot,badge,bio,karma,anon_active,anon_mask,anon_color,interests FROM users WHERE banned=0 ORDER BY username');
  const memberships = await store.all('SELECT * FROM memberships WHERE user_id=$1', req.user.id);
  const roles = await store.all('SELECT r.*, mr.user_id FROM community_roles r LEFT JOIN member_roles mr ON mr.role_id=r.id AND mr.user_id=$1', req.user.id);
  const friends = await store.all(`SELECT f.*,u.username,u.tag,u.nickname,u.avatar,u.status,u.badge,u.karma FROM friends f JOIN users u ON u.id=CASE WHEN f.requester_id=$1 THEN f.addressee_id ELSE f.requester_id END WHERE f.requester_id=$1 OR f.addressee_id=$1`, req.user.id);
  const dms = await store.all(`SELECT d.*,ua.username AS user_a_name,ua.tag AS user_a_tag,ua.nickname AS user_a_nick,ua.avatar AS user_a_avatar,ua.status AS user_a_status,ua.badge AS user_a_badge,ua.anon_active AS user_a_anon,ua.anon_mask AS user_a_mask,ub.username AS user_b_name,ub.tag AS user_b_tag,ub.nickname AS user_b_nick,ub.avatar AS user_b_avatar,ub.status AS user_b_status,ub.badge AS user_b_badge,ub.anon_active AS user_b_anon,ub.anon_mask AS user_b_mask FROM dms d JOIN users ua ON ua.id=d.user_a JOIN users ub ON ub.id=d.user_b WHERE d.user_a=$1 OR d.user_b=$1`, req.user.id);
  const groups = await store.all(`SELECT g.*,gm.user_id FROM groups_chat g JOIN group_members gm ON gm.group_id=g.id WHERE gm.user_id=$1`, req.user.id);
  const settings = await store.get('SELECT * FROM user_settings WHERE user_id=$1', req.user.id) || {};
  const events = await store.all("SELECT * FROM events WHERE active=1 ORDER BY starts_at DESC LIMIT 5");
  const unreadNotifs = (await store.get('SELECT COUNT(*) AS c FROM notifications WHERE user_id=$1 AND read=0', req.user.id))?.c || 0;
  const challenge = await getTodayChallenge();
  res.json({me, communities, channels, users, memberships, roles, friends, dms, groups, settings, events, unreadNotifs:Number(unreadNotifs), challenge, devMode: IS_DEV, rtc: { iceServers: await rtcIceServers() }});
}));

// ── Profile ───────────────────────────────────────────────────────────────────
app.patch('/api/profile', auth, route(async (req,res) => {
  const {nickname,status,custom_status,avatar,banner,bio,interests,privacy_mode} = req.body;
  await store.run('UPDATE users SET nickname=$1,status=$2,custom_status=$3,avatar=$4,banner=$5,bio=$6,interests=$7,privacy_mode=$8 WHERE id=$9',
    (nickname||'').slice(0,40),(status||'Online').slice(0,20),(custom_status||'').slice(0,80),
    avatar||null,banner||null,(bio||'').slice(0,300),(interests||'').slice(0,200),privacy_mode||'standard',req.user.id);
  const u = publicUser(await store.get('SELECT * FROM users WHERE id=$1', req.user.id));
  io.emit('user_update', u);
  res.json({user:u});
}));

app.get('/api/users/by-username/:username', auth, route(async (req,res) => {
  const u = await store.get('SELECT * FROM users WHERE LOWER(username)=LOWER($1)', String(req.params.username).slice(0,40));
  if (!u) return res.status(404).json({error:'User not found'});
  res.json({user:publicUser(u)});
}));

app.get('/api/users/:id', auth, route(async (req,res) => {
  const u = await store.get('SELECT * FROM users WHERE id=$1', req.params.id);
  if (!u) return res.status(404).json({error:'Not found'});
  res.json({user:publicUser(u)});
}));

app.get('/api/users/:id/pet', auth, route(async (req,res) => {
  const u = await store.get('SELECT active_pet FROM users WHERE id=$1', req.params.id);
  const pid = u?.active_pet || null;
  const item = pid ? petById(pid) : null;
  let name = null;
  if (pid) {
    const inv = await store.get('SELECT name FROM inventory WHERE user_id=$1 AND item_id=$2', req.params.id, pid);
    name = inv?.name || item?.name || null;
  }
  res.json({ pet: item ? { ...item, name } : null });
}));

app.get('/api/me/privacy-checkup', auth, route(async (req,res) => {
  const u = await store.get('SELECT * FROM users WHERE id=$1', req.user.id);
  const s = await store.get('SELECT * FROM user_settings WHERE user_id=$1', req.user.id) || {};
  res.json({
    visibleToOthers: {
      username: true, tag: true, nickname: true,
      avatar: true, banner: !s.privacy_profile,
      bio: !s.privacy_profile, status: !s.privacy_profile,
      custom_status: !s.privacy_profile, karma: true,
      interests: Boolean(s.show_interests),
      joinDate: true,
    },
    settings: s
  });
}));
// ── Account data export / deletion ─────────────────────────────────────────
// Self-service data portability and erasure (privacy-first). Export returns a
// JSON archive of everything the account owns. DELETE erases the account and
// its authored content inside one transaction; moderation / anti-abuse records
// (moderation_logs, reports, mod_notes, data_requests, permission_audit_logs,
// reveal_removals) are deliberately retained for accountability — they only
// reference user ids as text and never block deletion.
function uploadFileNames(...values) {
  const out = [];
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const m = /^\/uploads\/([A-Za-z0-9._-]{1,200})$/.exec(v.trim());
    if (m) out.push(m[1]);
  }
  return out;
}
const uploadAbsPath = name => path.join(uploadDir, name);

app.get('/api/me/export', auth, route(async (req,res) => {
  const uid = req.user.id;
  const u = await store.get('SELECT * FROM users WHERE id=$1', uid);
  if (!u) return res.status(404).json({ error: 'Account not found' });
  const data = { exportedAt: new Date().toISOString() };
  data.account = {
    id: u.id, username: u.username, tag: u.tag, nickname: u.nickname || u.username,
    avatar: u.avatar, banner: u.banner, bio: u.bio || '', status: u.status || 'Online',
    custom_status: u.custom_status || '', badge: u.badge || '', karma: Number(u.karma || 0),
    interests: u.interests || '', anon_active: Number(u.anon_active || 0),
    anon_mask: u.anon_mask || '', anon_color: u.anon_color || '', anon_emoji: u.anon_emoji || '',
    fav_mask: u.fav_mask || '', fav_color: u.fav_color || '', fav_emoji: u.fav_emoji || '',
    privacy_mode: u.privacy_mode || 'standard', settings: u.settings || '{}',
    banned: Number(u.banned || 0), created_at: u.created_at,
  };
  data.memberships = await store.all(
    'SELECT m.community_id, m.role, m.nickname, m.muted, c.name AS community_name, c.visibility FROM memberships m LEFT JOIN communities c ON c.id = m.community_id WHERE m.user_id=$1', uid);
  data.friends = await store.all(
    'SELECT f.status, f.created_at, u.id AS other_id, u.username AS other_username, u.tag AS other_tag FROM friends f JOIN users u ON u.id = CASE WHEN f.requester_id=$1 THEN f.addressee_id ELSE f.requester_id END WHERE f.requester_id=$1 OR f.addressee_id=$1', uid);
  data.dms = await store.all(
    'SELECT d.id, d.created_at, ua.username AS user_a_name, ua.tag AS user_a_tag, ub.username AS user_b_name, ub.tag AS user_b_tag FROM dms d LEFT JOIN users ua ON ua.id = d.user_a LEFT JOIN users ub ON ub.id = d.user_b WHERE d.user_a=$1 OR d.user_b=$1', uid);
  data.messages = await store.all(
    'SELECT id, channel_id, dm_id, group_id, body, attachment, attachment_name, attachment_type, reply_to, pinned, created_at FROM messages WHERE sender_id=$1 ORDER BY created_at', uid);
  data.roomMessages = await store.all(
    'SELECT rm.id, rm.room_id, rm.body, rm.created_at, tr.name AS room_name FROM room_messages rm LEFT JOIN temp_rooms tr ON tr.id = rm.room_id WHERE rm.sender_id=$1 ORDER BY rm.created_at', uid);
  data.questLogs = await store.all('SELECT quest, day, reward FROM quest_logs WHERE user_id=$1 ORDER BY day', uid);
  data.gameLogs = await store.all('SELECT game, result, day, created_at FROM game_logs WHERE user_id=$1', uid);
  data.inventory = await store.all('SELECT item_id, name, aquired_at FROM inventory WHERE user_id=$1', uid);
  data.bookmarks = await store.all(
    'SELECT b.folder, b.created_at, m.body, m.created_at AS message_at, m.channel_id, m.dm_id, m.group_id FROM bookmarks b LEFT JOIN messages m ON m.id = b.message_id WHERE b.user_id=$1 ORDER BY b.created_at', uid);
  data.anonymousIdentities = await store.all('SELECT id, mask_name, mask_color, mask_emoji, active, gradient, created_at FROM anonymous_identities WHERE user_id=$1', uid);
  data.notifications = await store.all('SELECT type, source_type, body, read, created_at FROM notifications WHERE user_id=$1 ORDER BY created_at', uid);
  data.reminders = await store.all('SELECT preview, remind_at, fired, created_at FROM reminders WHERE user_id=$1', uid);
  data.tempUsernames = await store.all('SELECT temp_name, context, created_at FROM temp_usernames WHERE user_id=$1', uid);
  data.reactions = await store.all('SELECT r.emoji, r.message_id, m.body FROM reactions r LEFT JOIN messages m ON m.id = r.message_id WHERE r.user_id=$1', uid);
  data.pollVotes = await store.all('SELECT pv.option_index, p.question FROM poll_votes pv LEFT JOIN polls p ON p.id = pv.poll_id WHERE pv.user_id=$1', uid);
  data.giftLogs = await store.all('SELECT from_id, to_id, amount, day, created_at FROM gift_logs WHERE from_id=$1 OR to_id=$1 ORDER BY created_at', uid);
  data.revealPosts = await store.all('SELECT id, type, body, media, media_name, quiz, created_at FROM reveal_posts WHERE author_id=$1 ORDER BY created_at', uid);
  data.revealComments = await store.all('SELECT id, post_id, body, created_at FROM reveal_comments WHERE author_id=$1 ORDER BY created_at', uid);
  data.blocks = await store.all('SELECT blocker_id, blocked_id FROM blocks WHERE blocker_id=$1 OR blocked_id=$1', uid);
  data.ratings = await store.all('SELECT cr.community_id, cr.rating, c.name AS community_name FROM community_ratings cr LEFT JOIN communities c ON c.id = cr.community_id WHERE cr.user_id=$1', uid);
  data.dataRequests = await store.all('SELECT id, requester_id, target_id, reason, status, note, created_at, responded_at FROM data_requests WHERE requester_id=$1 OR target_id=$1 ORDER BY created_at', uid);
  const counts = {};
  for (const [key, value] of Object.entries(data)) if (Array.isArray(value)) counts[key] = value.length;
  data.counts = counts;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="unknown-data-' + String(u.username || 'user').replace(/[^A-Za-z0-9_-]/g, '') + '-' + new Date().toISOString().slice(0, 10) + '.json"');
  res.json(data);
}));

// Erase an account and everything it owns, atomically. Everything runs inside
// one transaction so a failure mid-way rolls back to the untouched account.
async function deleteUserAccount(userId, ownedFiles) {
  const files = ownedFiles || [];
  const client = await pool.connect();
  const q = (sql, ...params) => client.query(sql, params);
  try {
    await client.query('BEGIN');
    // Audit first: keep a permanent, self-describing record of the erasure.
    await q("INSERT INTO moderation_logs (id, actor_id, action, target, details, created_at) VALUES ($1,$2,'account_self_deleted',$3,$4,CURRENT_TIMESTAMP)",
      nanoid(), userId, userId, JSON.stringify({ selfService: true }));

    // Messages: the user's own, plus everything inside their closed DM threads
    // (a DM row is shared; removing the account closes the conversation).
    const USER_MSGS = 'sender_id=$1 OR dm_id IN (SELECT id FROM dms WHERE user_a=$1 OR user_b=$1)';
    const msgRows = await q('SELECT id, attachment FROM messages WHERE ' + USER_MSGS, userId);
    for (const row of msgRows.rows) files.push(...uploadFileNames(row.attachment));
    await q('DELETE FROM message_edits WHERE message_id IN (SELECT id FROM messages WHERE ' + USER_MSGS + ')', userId);
    await q('DELETE FROM reactions WHERE user_id=$1 OR message_id IN (SELECT id FROM messages WHERE ' + USER_MSGS + ')', userId);
    await q('DELETE FROM threads WHERE root_message_id IN (SELECT id FROM messages WHERE ' + USER_MSGS + ')', userId);
    await q('DELETE FROM polls WHERE created_by=$1 OR message_id IN (SELECT id FROM messages WHERE ' + USER_MSGS + ')', userId);
    await q('DELETE FROM poll_votes WHERE user_id=$1 OR poll_id IN (SELECT id FROM polls WHERE created_by=$1 OR message_id IN (SELECT id FROM messages WHERE ' + USER_MSGS + '))', userId);
    const delMessages = await q('DELETE FROM messages WHERE ' + USER_MSGS, userId);
    const delDms = await q('DELETE FROM dms WHERE user_a=$1 OR user_b=$1', userId);
    const delRoomMessages = await q('DELETE FROM room_messages WHERE sender_id=$1', userId);
        // Everything keyed by user id: one allowlisted sweep (never a wildcard).
    // Declarative on purpose - adding a user-scoped table is a one-line change.
    const USER_SCOPED = [
      'user_settings', 'notifications', 'reminders',
      'inventory', 'game_logs', 'temp_usernames', 'arg_completions', 'bookmarks',
      'memberships', 'member_roles', 'community_ratings', 'active_effects',
      'bot_reviews', 'voice_sessions', 'room_members', 'room_poll_votes', 'group_members',
    ];
    for (const table of USER_SCOPED) {
      await q('DELETE FROM ' + table + ' WHERE user_id=$1', userId);
    }
    await q('DELETE FROM server_cosmetics WHERE purchased_by=$1', userId);
    // Two-sided relationships belong to both parties.
    await q('DELETE FROM friends WHERE requester_id=$1 OR addressee_id=$1', userId);
    await q('DELETE FROM blocks WHERE blocker_id=$1 OR blocked_id=$1', userId);
    const delQuests = await q('DELETE FROM quest_logs WHERE user_id=$1', userId);
    const delAnon = await q('DELETE FROM anonymous_identities WHERE user_id=$1', userId);
    await q('DELETE FROM events WHERE created_by=$1', userId);

    // Reveal (anonymous posting) content authored by the user, plus the rows
    // attached to it (other users' comments/likes on removed posts).
    const revPosts = await q('SELECT id, media FROM reveal_posts WHERE author_id=$1', userId);
    const revPostIds = revPosts.rows.map(r => r.id);
    for (const row of revPosts.rows) files.push(...uploadFileNames(row.media));
    const revCommentIds = (await q('SELECT id FROM reveal_comments WHERE author_id=$1 OR post_id = ANY($2::text[])', userId, revPostIds)).rows.map(r => r.id);
    await q('UPDATE reveal_comments SET parent_id=NULL WHERE parent_id IN (SELECT id FROM reveal_comments WHERE author_id=$1)', userId);
    await q('DELETE FROM reveal_comment_likes WHERE user_id=$1 OR comment_id = ANY($2::text[]) OR comment_id IN (SELECT id FROM reveal_comments WHERE post_id = ANY($3::text[]))', userId, revCommentIds, revPostIds);
    await q('DELETE FROM reveal_likes WHERE user_id=$1 OR post_id = ANY($2::text[])', userId, revPostIds);
    await q('DELETE FROM reveal_post_views WHERE user_id=$1 OR post_id = ANY($2::text[])', userId, revPostIds);
    await q('DELETE FROM reveal_removals WHERE post_id = ANY($1::text[])', revPostIds);
    await q('DELETE FROM reveal_comments WHERE author_id=$1 OR post_id = ANY($2::text[])', userId, revPostIds);
    await q('DELETE FROM reveal_posts WHERE author_id=$1', userId);
    await q('DELETE FROM reveal_follows WHERE follower_id=$1 OR followed_id=$1', userId);
    await q('DELETE FROM reveal_bans WHERE user_id=$1', userId);

    // Ownership: communities/groups/rooms the user created either transfer to a
    // remaining member or (with nobody left) are removed completely.
    const ownedRooms = await q('SELECT id FROM temp_rooms WHERE owner_id=$1', userId);
    for (const row of ownedRooms.rows) {
      const next = await q('SELECT user_id FROM room_members WHERE room_id=$1 AND user_id<>$2 AND waiting=0 ORDER BY joined_at LIMIT 1', row.id, userId);
      if (next.rows.length) {
        await q('UPDATE temp_rooms SET owner_id=$1 WHERE id=$2', next.rows[0].user_id, row.id);
      } else {
        await q('DELETE FROM room_poll_votes WHERE poll_id IN (SELECT id FROM room_polls WHERE room_id=$1)', row.id);
        await q('DELETE FROM room_polls WHERE room_id=$1', row.id);
        await q('DELETE FROM room_messages WHERE room_id=$1', row.id);
        await q('DELETE FROM room_members WHERE room_id=$1', row.id);
        await q('DELETE FROM temp_rooms WHERE id=$1', row.id);
      }
    }
    const ownedGroups = await q('SELECT id FROM groups_chat WHERE owner_id=$1', userId);
    for (const row of ownedGroups.rows) {
      const next = await q('SELECT user_id FROM group_members WHERE group_id=$1 AND user_id<>$2 ORDER BY user_id LIMIT 1', row.id, userId);
      if (next.rows.length) {
        await q('UPDATE groups_chat SET owner_id=$1 WHERE id=$2', next.rows[0].user_id, row.id);
      } else {
        await q('DELETE FROM poll_votes WHERE poll_id IN (SELECT id FROM polls WHERE group_id=$1)', row.id);
        await q('DELETE FROM polls WHERE group_id=$1', row.id);
        await q('DELETE FROM message_edits WHERE message_id IN (SELECT id FROM messages WHERE group_id=$1)', row.id);
        await q('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE group_id=$1)', row.id);
        await q('DELETE FROM threads WHERE root_message_id IN (SELECT id FROM messages WHERE group_id=$1)', row.id);
        await q('DELETE FROM messages WHERE group_id=$1', row.id);
        await q('DELETE FROM group_members WHERE group_id=$1', row.id);
        await q('DELETE FROM groups_chat WHERE id=$1', row.id);
      }
    }
    const ownedComms = await q('SELECT id FROM communities WHERE owner_id=$1', userId);
    for (const row of ownedComms.rows) {
      const next = await q("SELECT user_id FROM memberships WHERE community_id=$1 AND user_id<>$2 ORDER BY CASE role WHEN 'owner' THEN 100 WHEN 'admin' THEN 90 WHEN 'mod' THEN 10 ELSE 5 END DESC, user_id LIMIT 1", row.id, userId);
      if (next.rows.length) {
        await q('UPDATE communities SET owner_id=$1 WHERE id=$2', next.rows[0].user_id, row.id);
      } else {
        const chans = await q('SELECT id FROM channels WHERE community_id=$1', row.id);
        const chanIds = chans.rows.map(r => r.id);
        if (chanIds.length) {
          await q('DELETE FROM message_edits WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ANY($1::text[]))', chanIds);
          await q('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id = ANY($1::text[]))', chanIds);
          await q('DELETE FROM threads WHERE root_message_id IN (SELECT id FROM messages WHERE channel_id = ANY($1::text[]))', chanIds);
          await q('DELETE FROM poll_votes WHERE poll_id IN (SELECT id FROM polls WHERE channel_id = ANY($1::text[]))', chanIds);
          await q('DELETE FROM polls WHERE channel_id = ANY($1::text[])', chanIds);
          await q('DELETE FROM messages WHERE channel_id = ANY($1::text[])', chanIds);
          await q('DELETE FROM channel_permissions WHERE channel_id = ANY($1::text[])', chanIds);
          await q('DELETE FROM channels WHERE id = ANY($1::text[])', chanIds);
        }
        const rooms = await q('SELECT id FROM temp_rooms WHERE community_id=$1', row.id);
        for (const r2 of rooms.rows) {
          await q('DELETE FROM room_poll_votes WHERE poll_id IN (SELECT id FROM room_polls WHERE room_id=$1)', r2.id);
          await q('DELETE FROM room_polls WHERE room_id=$1', r2.id);
          await q('DELETE FROM room_messages WHERE room_id=$1', r2.id);
          await q('DELETE FROM room_members WHERE room_id=$1', r2.id);
        }
        await q('DELETE FROM temp_rooms WHERE community_id=$1', row.id);
        const roles = await q('SELECT id FROM community_roles WHERE community_id=$1', row.id);
        const roleIds = roles.rows.map(r => r.id);
        if (roleIds.length) {
          await q('DELETE FROM member_roles WHERE role_id = ANY($1::text[])', roleIds);
          await q('DELETE FROM channel_permissions WHERE role_id = ANY($1::text[])', roleIds);
        }
        await q('DELETE FROM community_roles WHERE community_id=$1', row.id);
        await q('DELETE FROM memberships WHERE community_id=$1', row.id);
        await q('DELETE FROM community_ratings WHERE community_id=$1', row.id);
        await q('DELETE FROM active_effects WHERE community_id=$1', row.id);
        await q('DELETE FROM communities WHERE id=$1', row.id);
      }
    }

    // Authored platform content that others still use keeps working: drop the
    // author link instead of deleting the row.
    await q('UPDATE announcements SET author_id=NULL WHERE author_id=$1', userId);
    await q('UPDATE custom_quests SET created_by=NULL WHERE created_by=$1', userId);
    await q('UPDATE marketplace_bots SET author_id=NULL WHERE author_id=$1', userId);
    await q('UPDATE bot_releases SET released_by=NULL WHERE released_by=$1', userId);
    await q('UPDATE gift_logs SET from_id=NULL WHERE from_id=$1', userId);
    await q('UPDATE gift_logs SET to_id=NULL WHERE to_id=$1', userId);

    await q('DELETE FROM auth_sessions WHERE user_id=$1', userId);
    const delUser = await q('DELETE FROM users WHERE id=$1', userId);
    await client.query('COMMIT');
    const summary = {
      account: Number(delUser.rowCount || 0),
      messages: Number(delMessages.rowCount || 0),
      dms: Number(delDms.rowCount || 0),
      roomMessages: Number(delRoomMessages.rowCount || 0),
      questLogs: Number(delQuests.rowCount || 0),
      anonymousIdentities: Number(delAnon.rowCount || 0),
      uploadFiles: files.length,
    };
    return { summary, files };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

app.delete('/api/me', auth, route(async (req,res) => {
  const password = String((req.body && req.body.password) || '');
  const u = await store.get('SELECT * FROM users WHERE id=$1', req.user.id);
  if (!u) return res.status(404).json({ error: 'Account not found' });
  if (Number(u.is_admin)) {
    return res.status(403).json({ error: 'Administrator accounts cannot be deleted from the app; use a normal account for day-to-day use' });
  }
  if (!password || !bcrypt.compareSync(password, u.password_hash)) {
    return res.status(401).json({ error: 'Current password incorrect' });
  }
  const ownedFiles = uploadFileNames(u.avatar, u.banner);
  const { summary, files } = await deleteUserAccount(u.id, ownedFiles);
  // Files are removed only after the transaction committed successfully.
  for (const name of files) { try { fs.rmSync(uploadAbsPath(name), { force: true }); } catch {} }
  // Tell every connected client (this instance and, via the shared adapter,
  // every other instance) that the account is gone, then drop its sockets.
  io.emit('account_deleted', { userId: u.id, username: u.username });
  for (const s of io.sockets.sockets.values()) {
    if (s.data && s.data.user && s.data.user.id === u.id) { try { s.disconnect(true); } catch {} }
  }
  res.json({ ok: true, deleted: true, summary });
}));



// ── Settings ──────────────────────────────────────────────────────────────────
app.get('/api/settings', auth, route(async (req,res) => {
  const s = await store.get('SELECT * FROM user_settings WHERE user_id=$1', req.user.id);
  res.json(s || {user_id: req.user.id});
}));

app.patch('/api/settings', auth, route(async (req,res) => {
  const {notif_pings,notif_dms,notif_replies,notif_mute_all,privacy_profile,no_friends,chat_bg,profile_theme,profile_theme_end,show_interests,world_discovery,reveal_sort} = req.body;
  const validSorts = ['new','likes','comments','trending'];
  const rs = validSorts.includes(reveal_sort) ? reveal_sort : null;
  const base = [req.user.id,notif_pings??1,notif_dms??1,notif_replies??1,notif_mute_all??0,privacy_profile??0,no_friends??0,chat_bg||'default',profile_theme||'#5865f2',show_interests??1,world_discovery??0];
  if (rs) base.push(rs);
  await store.run(`INSERT INTO user_settings (user_id,notif_pings,notif_dms,notif_replies,notif_mute_all,privacy_profile,no_friends,chat_bg,profile_theme,show_interests,world_discovery${rs ? ',reveal_sort' : ''})
    VALUES (${base.map((_,i)=>'?'+i+1).join(',')})
    ON CONFLICT (user_id) DO UPDATE SET notif_pings=$2,notif_dms=$3,notif_replies=$4,notif_mute_all=$5,privacy_profile=$6,no_friends=$7,chat_bg=$8,profile_theme=$9,show_interests=$10,world_discovery=$11${rs ? ',reveal_sort=$12' : ''}`,
    ...base);
  res.json({ok:true});
}));

// ── Password change ───────────────────────────────────────────────────────────
app.post('/api/me/change-password', auth, route(async (req,res) => {
  const {current, newPassword} = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({error:'New password too short'});
  const u = await store.get('SELECT * FROM users WHERE id=$1', req.user.id);
  if (!bcrypt.compareSync(current, u.password_hash)) return res.status(401).json({error:'Current password incorrect'});
  await store.run('UPDATE users SET password_hash=$1 WHERE id=$2', bcrypt.hashSync(newPassword,10), req.user.id);
  await sessions.revokeUserExcept(req.user.id, req.user.sessionId);
  res.json({ok:true});
}));

// ── Two-factor authentication ─────────────────────────────────────────────────
app.post('/api/me/2fa/setup', auth, route(async (req,res) => {
  const u = await store.get('SELECT * FROM users WHERE id=$1', req.user.id);
  if (!bcrypt.compareSync(String(req.body.password||''), u.password_hash)) return res.status(401).json({error:'Password incorrect'});
  if (Number(u.totp_enabled)) return res.status(400).json({error:'Two-factor is already enabled'});
  const secret = generateSecret();
  const label = (u.nickname || u.username) + '@' + (req.get('host') || 'unknown');
  await store.run('UPDATE users SET totp_secret=$1 WHERE id=$2', JSON.stringify({ v: secret }), u.id);
  res.json({ secret, otpauthUrl: otpauthUri(secret, label), account: label });
}));

app.post('/api/me/2fa/enable', auth, route(async (req,res) => {
  const u = await store.get('SELECT * FROM users WHERE id=$1', req.user.id);
  if (Number(u.totp_enabled)) return res.status(400).json({error:'Two-factor is already enabled'});
  const secret = secretFor(u);
  if (!secret) return res.status(400).json({error:'Run setup first'});
  const clean = String(req.body.code||'').replace(/\s/g, '');
  if (!verifyCode(secret, clean)) return res.status(401).json({error:'Code did not verify — check your authenticator app'});
  const codes = generateRecoveryCodes(10);
  await store.run('UPDATE users SET totp_enabled=1, recovery_codes=$1 WHERE id=$2', JSON.stringify(codes.map(hashRecoveryCode)), u.id);
  await sessions.revokeUserExcept(u.id, req.user.sessionId);
  res.json({ ok: true, recoveryCodes: codes });
}));

app.post('/api/me/2fa/disable', auth, route(async (req,res) => {
  const u = await store.get('SELECT * FROM users WHERE id=$1', req.user.id);
  if (!bcrypt.compareSync(String(req.body.password||''), u.password_hash)) return res.status(401).json({error:'Password incorrect'});
  if (!Number(u.totp_enabled)) return res.status(400).json({error:'Two-factor is not enabled'});
  const kind = await verifySecondFactor(u, String(req.body.code||''));
  if (!kind) return res.status(401).json({error:'Invalid or expired code'});
  await store.run("UPDATE users SET totp_enabled=0, totp_secret=NULL, recovery_codes='[]' WHERE id=$1", u.id);
  res.json({ ok: true });
}));

app.get('/api/me/2fa/status', auth, route(async (req,res) => {
  const u = await store.get('SELECT totp_enabled FROM users WHERE id=$1', req.user.id);
  res.json({ enabled: Boolean(u && Number(u.totp_enabled)) });
}));

// ── Session manager ───────────────────────────────────────────────────────────
app.get('/api/me/sessions', auth, route(async (req,res) => {
  const rows = await store.all('SELECT id, device, created_at, last_seen, expires_at FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 50', req.user.id);
  res.json(rows.map(s => ({
    id: s.id,
    device: s.device || 'Unknown device',
    createdAt: s.created_at,
    lastSeen: s.last_seen,
    current: s.id === req.user.sessionId,
  })));
}));

app.post('/api/me/sessions/revoke', auth, route(async (req,res) => {
  const target = String(req.body.sessionId||'');
  if (!target) return res.status(400).json({error:'sessionId required'});
  if (target === req.user.sessionId) return res.status(400).json({error:'Use logout to end the current session'});
  await store.run('UPDATE auth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1 AND user_id=$2', target, req.user.id);
  io.to('user:' + req.user.id).emit('session_revoked', { sessionId: target });
  res.json({ ok: true });
}));

app.post('/api/me/sessions/revoke-others', auth, route(async (req,res) => {
  await sessions.revokeUserExcept(req.user.id, req.user.sessionId);
  io.to('user:' + req.user.id).emit('session_revoked', { allOthers: true });
  res.json({ ok: true });
}));

// ── Anonymous mode ────────────────────────────────────────────────────────────
const MASK_IDENTITIES = [
  // ── Original identities ──
  {name:'Glitchy Neon Fox',emoji:'🦊',color:'#f23f42'},
  {name:'Phantom Tide',emoji:'🌊',color:'#00a8fc'},
  {name:'Shadow Wisp',emoji:'👻',color:'#5865f2'},
  {name:'Static Echo',emoji:'📡',color:'#f0b232'},
  {name:'Void Runner',emoji:'🌌',color:'#23a559'},
  {name:'Crimson Byte',emoji:'🔴',color:'#ed4245'},
  {name:'Frozen Signal',emoji:'❄️',color:'#57d3fb'},
  {name:'Neon Raven',emoji:'🐦‍⬛',color:'#eb459e'},
  {name:'Dust Protocol',emoji:'💨',color:'#949ba4'},
  {name:'Ember Code',emoji:'🔥',color:'#e67e22'},
  {name:'Pixel Ghost',emoji:'👾',color:'#9b59b6'},
  {name:'Chrome Drift',emoji:'⚙️',color:'#95a5a6'},
  {name:'Lunar Wraith',emoji:'🌙',color:'#3498db'},
  {name:'Acid Rain',emoji:'☁️',color:'#2ecc71'},
  {name:'Spectral Fang',emoji:'🐺',color:'#e74c3c'},
  {name:'Binary Moth',emoji:'🦋',color:'#8e44ad'},
  {name:'Neon Lotus',emoji:'🌸',color:'#ff69b4'},
  {name:'Dark Tide',emoji:'🌑',color:'#2c3e50'},
  {name:'Hollow Signal',emoji:'📶',color:'#1abc9c'},
  {name:'Blazing Cipher',emoji:'🔐',color:'#d35400'},
  // ── Simple / expressive masks ──
  {name:'🎭 Blank Mask',emoji:'😐',color:'#8a8f98'},
  {name:'🙂 Happy Mask',emoji:'🙂',color:'#f0b232'},
  {name:'😢 Sad Mask',emoji:'😢',color:'#00a8fc'},
  {name:'😡 Angry Mask',emoji:'😡',color:'#ed4245'},
  {name:'😱 Panic Mask',emoji:'😱',color:'#eb459e'},
  {name:'🤨 Suspicious Mask',emoji:'🤨',color:'#e67e22'},
  {name:'😏 Smug Mask',emoji:'😏',color:'#9b59b6'},
  {name:'😳 Embarrassed Mask',emoji:'😳',color:'#ff69b4'},
  {name:'😴 Sleepy Mask',emoji:'😴',color:'#57d3fb'},
  {name:'🤯 Mind-Blown Mask',emoji:'🤯',color:'#f23f42'},
  // ── Mysterious masks ──
  {name:'🌑 Shadow Mask',emoji:'🌑',color:'#2c3e50'},
  {name:'🕵️ Hooded Mask',emoji:'🕵️',color:'#5865f2'},
  {name:'👾 Glitch Mask',emoji:'👾',color:'#9b59b6'},
  {name:'💔 Cracked Mask',emoji:'💔',color:'#e74c3c'},
  {name:'❓ Unknown Mask',emoji:'❓',color:'#95a5a6'},
  {name:'❔ Question Mask',emoji:'❔',color:'#f0b232'},
  {name:'🙈 Hidden Mask',emoji:'🙈',color:'#23a559'},
  {name:'👀 Peek Mask',emoji:'👀',color:'#00a8fc'},
  // ── Goofy masks ──
  {name:'🤪 Derp Mask',emoji:'🤪',color:'#f23f42'},
  {name:'🤕 Bonk Mask',emoji:'🤕',color:'#e67e22'},
  {name:'🙃 Upside-Down Mask',emoji:'🙃',color:'#8e44ad'},
  {name:'🫠 Melting Mask',emoji:'🫠',color:'#f5a97f'},
  {name:'🎭 Mask With Tiny Mask',emoji:'🎭',color:'#eb459e'},
  {name:'🫥 Mask Falling Off',emoji:'🫥',color:'#7f8c8d'},
  {name:'🙄 Mask Looking Behind',emoji:'🙄',color:'#f0b232'},
  {name:'👁️ Mask With Giant Eyes',emoji:'👁️',color:'#00a8fc'},
  {name:'👁️🗨️ One Giant Eye Mask',emoji:'👁️🗨️',color:'#9b59b6'},
  {name:'🕶️ Mask Wearing Sunglasses',emoji:'🕶️',color:'#2c3e50'},
  // ── Distinctive masks ──
  {name:'👺 Two-Face Mask',emoji:'👺',color:'#ed4245'},
  {name:'🌗 Half Mask',emoji:'🌗',color:'#5865f2'},
  {name:'🪞 Mirror Mask',emoji:'🪞',color:'#3498db'},
  {name:'🕳️ Empty Mask',emoji:'🕳️',color:'#1a1a2e'},
  {name:'💡 Neon Mask',emoji:'💡',color:'#23a559'},
  {name:'📄 Paper Mask',emoji:'📄',color:'#d4a574'},
  {name:'🏺 Ceramic Mask',emoji:'🏺',color:'#d35400'},
  {name:'🎭 Theater Mask',emoji:'🎭',color:'#e74c3c'},
  {name:'😬 Broken Smile',emoji:'😬',color:'#8a8f98'},
  {name:'📺 Static Mask',emoji:'📺',color:'#7f8c8d'},
  {name:'😭 Crying Mask',emoji:'😭',color:'#00a8fc'},
  {name:'💀 Dead Mask',emoji:'💀',color:'#2c3e50'},
];

app.get('/api/anon/masks', auth, (_req, res) => res.json(MASK_IDENTITIES));

app.post('/api/me/anonymous', auth, route(async (req,res) => {
  const mask = MASK_IDENTITIES.find(m => m.name === req.body.maskName) || MASK_IDENTITIES[Math.floor(Math.random()*MASK_IDENTITIES.length)];
  const id = nanoid();
  await store.run('UPDATE anonymous_identities SET active=0 WHERE user_id=$1', req.user.id);
  await store.run('INSERT INTO anonymous_identities VALUES (?,?,?,?,?,1,CURRENT_TIMESTAMP)', id, req.user.id, mask.name, mask.color, mask.emoji);
  await store.run('UPDATE users SET anon_active=1,anon_mask=$1,anon_color=$2,anon_emoji=$3 WHERE id=$4', mask.name, mask.color, mask.emoji, req.user.id);
  const u = publicUser(await store.get('SELECT * FROM users WHERE id=$1', req.user.id));
  io.emit('user_update', u);
  res.json({ok:true, mask});
}));

app.delete('/api/me/anonymous', auth, route(async (req,res) => {
  await store.run('UPDATE anonymous_identities SET active=0 WHERE user_id=$1', req.user.id);
  await store.run("UPDATE users SET anon_active=0,anon_mask='',anon_color='',anon_emoji='' WHERE id=$1", req.user.id);
  const u = publicUser(await store.get('SELECT * FROM users WHERE id=$1', req.user.id));
  io.emit('user_update', u);
  res.json({ok:true});
}));

app.get('/api/me/anonymous/history', auth, route(async (req,res) => {
  res.json(await store.all('SELECT * FROM anonymous_identities WHERE user_id=$1 ORDER BY created_at DESC', req.user.id));
}));

app.post('/api/me/anonymous/reactivate/:id', auth, route(async (req,res) => {
  const identity = await store.get('SELECT * FROM anonymous_identities WHERE id=$1 AND user_id=$2', req.params.id, req.user.id);
  if (!identity) return res.status(404).json({error:'Not found'});
  await store.run('UPDATE anonymous_identities SET active=0 WHERE user_id=$1', req.user.id);
  await store.run('UPDATE anonymous_identities SET active=1 WHERE id=$1', req.params.id);
  await store.run('UPDATE users SET anon_active=1,anon_mask=$1,anon_color=$2,anon_emoji=$3 WHERE id=$4', identity.mask_name, identity.mask_color, identity.mask_emoji, req.user.id);
  const u = publicUser(await store.get('SELECT * FROM users WHERE id=$1', req.user.id));
  io.emit('user_update', u);
  res.json({ok:true, mask:{name:identity.mask_name,color:identity.mask_color,emoji:identity.mask_emoji}});
}));

// Set a custom 3-color gradient for the user's mask background.
// Stored as JSON in anon_color (and mask_color on the active identity) so it
// flows through the same anon_color field every renderer already reads.
app.patch('/api/me/anonymous/name-color', auth, route(async (req,res) => {
  const color = String(req.body?.color || '').trim();
  if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) return res.status(400).json({error:'Invalid name color'});
  await store.run('UPDATE users SET anon_name_color=$1 WHERE id=$2', color, req.user.id);
  const u = publicUser(await store.get('SELECT * FROM users WHERE id=$1', req.user.id));
  io.emit('user_update', u);
  res.json({ok:true, color, user:u});
}));

app.post('/api/me/anonymous/gradient', auth, route(async (req,res) => {
  const me = await store.get('SELECT * FROM users WHERE id=$1', req.user.id);
  if (!me || !Number(me.anon_active)) return res.status(400).json({error:'Activate a mask first'});
  const hexOk = c => /^#[0-9a-fA-F]{6}$/.test(String(c||'').trim());
  const { start, mid, end } = req.body || {};
  if (!hexOk(start)) return res.status(400).json({error:'Invalid start color'});
  if (!hexOk(mid)) return res.status(400).json({error:'Invalid mid color'});
  if (!hexOk(end)) return res.status(400).json({error:'Invalid end color'});
  const gradient = JSON.stringify({ start, mid, end });
  await store.run('UPDATE users SET anon_color=$1 WHERE id=$2', gradient, req.user.id);
  await store.run('UPDATE anonymous_identities SET mask_color=$1 WHERE user_id=$2 AND active=1', gradient, req.user.id);
  const u = publicUser(await store.get('SELECT * FROM users WHERE id=$1', req.user.id));
  io.emit('user_update', u);
  res.json({ok:true, gradient: JSON.parse(gradient)});
}));

// Clear a custom gradient and fall back to the mask's default color.
app.delete('/api/me/anonymous/gradient', auth, route(async (req,res) => {
  const me = await store.get('SELECT * FROM users WHERE id=$1', req.user.id);
  if (!me || !Number(me.anon_active)) return res.status(400).json({error:'Activate a mask first'});
  const mask = MASK_IDENTITIES.find(m => m.name === me.anon_mask) || MASK_IDENTITIES[0];
  await store.run('UPDATE users SET anon_color=$1 WHERE id=$2', mask.color, req.user.id);
  await store.run('UPDATE anonymous_identities SET mask_color=$1 WHERE user_id=$2 AND active=1', mask.color, req.user.id);
  const u = publicUser(await store.get('SELECT * FROM users WHERE id=$1', req.user.id));
  io.emit('user_update', u);
  res.json({ok:true, color: mask.color});
}));

// Save/clear favorite mask(s) as one-click quick-swap presets.
// Accepts a single maskName (legacy toggle) or an array of names (multi-star).
app.post('/api/me/anonymous/favorite', auth, route(async (req,res) => {
  const me = await store.get('SELECT * FROM users WHERE id=$1', req.user.id);
  let favs = [];
  try { const p = JSON.parse(me?.fav_masks || '[]'); if (Array.isArray(p)) favs = p; } catch {}
  const body = req.body || {};
  if (Array.isArray(body.maskNames)) {
    // Multi-star: exactly the provided set (valid names only, in order).
    favs = body.maskNames.slice(0, 20).map(n => MASK_IDENTITIES.find(m => m.name === n)).filter(Boolean);
  } else if (body.maskName) {
    const mask = MASK_IDENTITIES.find(m => m.name === body.maskName);
    if (!mask) return res.status(400).json({error:'Unknown mask'});
    if (favs.some(f => f.name === mask.name)) favs = favs.filter(f => f.name !== mask.name);
    else favs = [...favs, mask];
  } else if (body.maskName === '' || body.maskName === null) {
    favs = [];
  }
  // Keep legacy single-mask fields in sync with the first favorite.
  const first = favs[0] || null;
  await store.run('UPDATE users SET fav_masks=$1, fav_mask=$2, fav_color=$3, fav_emoji=$4 WHERE id=$5',
    JSON.stringify(favs), first?.name || '', first?.color || '', first?.emoji || '', req.user.id);
  const u = publicUser(await store.get('SELECT * FROM users WHERE id=$1', req.user.id));
  io.emit('user_update', u);
  res.json({ok:true, masks: favs, mask: first ? {name:first.name,color:first.color,emoji:first.emoji} : null});
}));

// Per-server quick-swap presets: each community can have its own starred-mask list.
app.post('/api/me/anonymous/server-favorites/:communityId', auth, route(async (req,res) => {
  const me = await store.get('SELECT * FROM users WHERE id=$1', req.user.id);
  let map = {};
  try { const p = JSON.parse(me?.server_fav_masks || '{}'); if (p && typeof p === 'object') map = p; } catch {}
  const communityId = String(req.params.communityId || '').slice(0, 60);
  if (!communityId) return res.status(400).json({error:'Missing community id'});
  const masked = Array.isArray(req.body?.maskNames);
  if (masked) {
    map[communityId] = (req.body.maskNames || []).slice(0, 20).map(n => MASK_IDENTITIES.find(m => m.name === n)).filter(Boolean);
  } else if (req.body?.maskName) {
    const mask = MASK_IDENTITIES.find(m => m.name === req.body.maskName);
    if (!mask) return res.status(400).json({error:'Unknown mask'});
    const cur = map[communityId] || [];
    if (cur.some(f => f.name === mask.name)) map[communityId] = cur.filter(f => f.name !== mask.name);
    else map[communityId] = [...cur, mask];
    if (!map[communityId].length) delete map[communityId];
  } else if (req.body?.maskName === '' || req.body?.maskName === null) {
    delete map[communityId];
  }
  await store.run('UPDATE users SET server_fav_masks=$1 WHERE id=$2', JSON.stringify(map), req.user.id);
  const u = publicUser(await store.get('SELECT * FROM users WHERE id=$1', req.user.id));
  io.emit('user_update', u);
  res.json({ok:true, favorites: map[communityId] || []});
}));

app.post('/api/me/temp-username', auth, route(async (req,res) => {
  const adjectives = ['Silent','Brave','Swift','Bold','Sharp','Mute','Dark','Calm'];
  const nouns = ['Hawk','River','Stone','Flame','Wind','Tide','Echo','Pulse'];
  const name = adjectives[Math.floor(Math.random()*adjectives.length)] + nouns[Math.floor(Math.random()*nouns.length)] + Math.floor(100+Math.random()*900);
  const id = nanoid();
  await store.run('INSERT INTO temp_usernames VALUES (?,?,?,?,CURRENT_TIMESTAMP)', id, req.user.id, name, req.body.context||'');
  res.json({tempName: name});
}));

// ── Friends ───────────────────────────────────────────────────────────────────
app.post('/api/friends/request', auth, route(async (req,res) => {
  const target = await store.get('SELECT * FROM users WHERE username=$1', req.body.username);
  if (!target) return res.status(404).json({error:'User not found'});
  if (target.id === req.user.id) return res.status(400).json({error:'Cannot friend yourself'});
  const existing = await store.get('SELECT * FROM friends WHERE (requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1)', req.user.id, target.id);
  if (existing) return res.status(409).json({error:'Friend request already exists'});
  const id = nanoid();
  await store.run('INSERT INTO friends VALUES (?,?,?,?,CURRENT_TIMESTAMP)', id, req.user.id, target.id, 'pending');
  await createNotification(target.id,'friend_request',req.user.id,'user',`${req.user.username} sent you a friend request`);
  io.to(`user:${target.id}`).emit('notification',{type:'friend_request'});
  res.json({id});
}));

app.patch('/api/friends/:id', auth, route(async (req,res) => {
  const f = await store.get('SELECT * FROM friends WHERE id=$1', req.params.id);
  if (!f || f.addressee_id !== req.user.id) return res.status(403).json({error:'Forbidden'});
  await store.run('UPDATE friends SET status=$1 WHERE id=$2', req.body.status, req.params.id);
  res.json({ok:true});
}));

app.delete('/api/friends/:id', auth, route(async (req,res) => {
  await store.run('DELETE FROM friends WHERE id=$1 AND (requester_id=$2 OR addressee_id=$2)', req.params.id, req.user.id);
  res.json({ok:true});
}));

// ── Communities ───────────────────────────────────────────────────────────────
app.post('/api/communities', auth, route(async (req,res) => {
  const id = nanoid(); const invCode = nanoid(8);
  await store.run(`INSERT INTO communities
    (id,name,description,visibility,owner_id,rules,icon,banner,invite_code,tags,locked,is_topic,topic_description,is_default,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,0,0,?,0,CURRENT_TIMESTAMP)`,
    id,req.body.name,req.body.description||'',req.body.visibility||'public',req.user.id,
    req.body.rules||'Do not share personal information.',req.body.icon||null,null,invCode,req.body.tags||'','');
  await store.run('INSERT INTO memberships VALUES (?,?,?,?,0)', id, req.user.id, 'owner', null);
  const ch = nanoid();
  await store.run('INSERT INTO channels VALUES (?,?,?,?,?,?,?,0,NULL,0,?,?,0,CURRENT_TIMESTAMP)', ch,id,'general','text','Community conversation',0,'General','','');
  const community = await store.get('SELECT * FROM communities WHERE id=$1', id);
  const channel = await store.get('SELECT * FROM channels WHERE id=$1', ch);
  res.json({id, inviteCode:invCode, community, channel});
}));

app.get('/api/communities/:id/pinned-mask', auth, route(async (req,res) => {
  const comm = await store.get('SELECT id,pinned_mask FROM communities WHERE id=$1', req.params.id);
  if (!comm) return res.status(404).json({error:'Not found'});
  const mask = MASK_IDENTITIES.find(m=>m.name===comm.pinned_mask) || null;
  res.json({pinnedMask:mask});
}));
app.patch('/api/communities/:id/pinned-mask', auth, route(async (req,res) => {
  const comm = await store.get('SELECT * FROM communities WHERE id=$1', req.params.id);
  if (!comm) return res.status(404).json({error:'Not found'});
  const mem = await store.get('SELECT role FROM memberships WHERE community_id=$1 AND user_id=$2', req.params.id, req.user.id);
  if (!req.user.is_admin && (!mem || !['owner','admin'].includes(mem.role))) return res.status(403).json({error:'Forbidden'});
  const mask = req.body?.maskName ? MASK_IDENTITIES.find(m=>m.name===req.body.maskName) : null;
  if (req.body?.maskName && !mask) return res.status(400).json({error:'Unknown mask'});
  await store.run('UPDATE communities SET pinned_mask=$1 WHERE id=$2', mask?.name || '', req.params.id);
  io.to(req.params.id).emit('community_pinned_mask',{communityId:req.params.id,pinnedMask:mask});
  res.json({ok:true,pinnedMask:mask});
}));

app.patch('/api/communities/:id', auth, route(async (req,res) => {
  const comm = await store.get('SELECT * FROM communities WHERE id=$1', req.params.id);
  if (!comm) return res.status(404).json({error:'Not found'});
  const mem = await store.get('SELECT * FROM memberships WHERE community_id=$1 AND user_id=$2', req.params.id, req.user.id);
  if (!req.user.is_admin && (!mem || (mem.role !== 'owner' && mem.role !== 'admin'))) return res.status(403).json({error:'Forbidden'});
  const {name,description,rules,icon,banner,visibility,tags,locked} = req.body;
  await store.run('UPDATE communities SET name=$1,description=$2,rules=$3,icon=$4,banner=$5,visibility=$6,tags=$7,locked=$8 WHERE id=$9',
    name||comm.name,description??comm.description,rules??comm.rules,icon??comm.icon,banner??comm.banner,visibility||comm.visibility,tags??comm.tags,locked??comm.locked,req.params.id);
  if (locked !== undefined) io.to(req.params.id).emit('community_locked',{communityId:req.params.id,locked});
  res.json({ok:true});
}));

app.delete('/api/communities/:id', auth, route(async (req,res) => {
  const comm = await store.get('SELECT * FROM communities WHERE id=$1', req.params.id);
  if (!comm) return res.status(404).json({error:'Not found'});
  if (comm.owner_id !== req.user.id && !req.user.is_admin) return res.status(403).json({error:'Forbidden'});
  await store.run('DELETE FROM communities WHERE id=$1', req.params.id);
  await store.run('DELETE FROM channels WHERE community_id=$1', req.params.id);
  await store.run('DELETE FROM memberships WHERE community_id=$1', req.params.id);
  res.json({ok:true});
}));

// Admin nuke: force-remove any server and everything in it.
app.post('/api/admin/communities/:id/nuke', auth, adminOnly, route(async (req,res) => {
  const comm = await store.get('SELECT * FROM communities WHERE id=$1', req.params.id);
  if (!comm) return res.status(404).json({error:'Not found'});
  const chans = await store.all('SELECT id FROM channels WHERE community_id=$1', req.params.id);
  for (const ch of chans) {
    await store.run('DELETE FROM messages WHERE channel_id=$1', ch.id);
    await store.run('DELETE FROM polls WHERE channel_id=$1', ch.id);
    await store.run('DELETE FROM channel_permissions WHERE channel_id=$1', ch.id);
  }
  await store.run('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE community_id=$1))', req.params.id);
  const members = await store.all('SELECT user_id FROM memberships WHERE community_id=$1', req.params.id);
  await store.run('DELETE FROM channels WHERE community_id=$1', req.params.id);
  await store.run('DELETE FROM memberships WHERE community_id=$1', req.params.id);
  await store.run('DELETE FROM community_roles WHERE community_id=$1', req.params.id);
  await store.run('DELETE FROM member_roles WHERE community_id=$1', req.params.id);
  await store.run('DELETE FROM community_ratings WHERE community_id=$1', req.params.id);
  await store.run('DELETE FROM communities WHERE id=$1', req.params.id);
  for (const m of members) io.to(`user:${m.user_id}`).emit('community_kicked',{communityId:req.params.id});
  await store.run('INSERT INTO moderation_logs VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)', nanoid(),req.user.id,'nuke_server',req.params.id,JSON.stringify({name:comm.name}));
  res.json({ok:true});
}));

app.post('/api/communities/join', auth, route(async (req,res) => {
  const comm = await store.get('SELECT * FROM communities WHERE invite_code=$1', req.body.inviteCode);
  if (!comm) return res.status(404).json({error:'Invalid invite code'});
  await store.run('INSERT INTO memberships VALUES (?,?,?,?,0) ON CONFLICT DO NOTHING', comm.id, req.user.id, 'member', null);
  res.json({communityId:comm.id, community:comm});
}));

app.get('/api/communities/:id/invite', auth, route(async (req,res) => {
  const c = await store.get('SELECT invite_code FROM communities WHERE id=$1', req.params.id);
  res.json({inviteCode:c?.invite_code});
}));

app.post('/api/communities/:id/leave', auth, route(async (req,res) => {
  await store.run('DELETE FROM memberships WHERE community_id=$1 AND user_id=$2', req.params.id, req.user.id);
  res.json({ok:true});
}));

// Mark (or unmark) the community that new registrations auto-join. Only one public
// community can be the default; setting one clears the others, and unset falls back
// to the oldest public community at registration time.
app.patch('/api/communities/:id/default', auth, route(async (req,res) => {
  const c = await store.get('SELECT * FROM communities WHERE id=$1', req.params.id);
  if (!c) return res.status(404).json({error:'Community not found'});
  if (!req.user.is_admin) {
    const mem = await store.get('SELECT role FROM memberships WHERE community_id=$1 AND user_id=$2', c.id, req.user.id);
    if (!mem || !['owner','admin'].includes(mem.role)) return res.status(403).json({error:'Only the server owner, a server admin, or a platform admin can set the default'});
  }
  const isDefault = Boolean(req.body?.isDefault);
  if (isDefault && c.visibility !== 'public') return res.status(400).json({error:'Only public communities can be the default'});
  if (isDefault) await store.run('UPDATE communities SET is_default=0 WHERE is_default=1');
  await store.run('UPDATE communities SET is_default=$1 WHERE id=$2', isDefault ? 1 : 0, c.id);
  res.json({ ok:true, is_default: isDefault ? 1 : 0 });
}));

app.post('/api/communities/:id/rate', auth, route(async (req,res) => {
  await store.run('INSERT INTO community_ratings VALUES (?,?,?) ON CONFLICT (community_id,user_id) DO UPDATE SET rating=$3', req.params.id, req.user.id, req.body.rating);
  res.json({ok:true});
}));

app.get('/api/communities/:id/ratings', auth, route(async (req,res) => {
  const ratings = await store.all('SELECT rating,COUNT(*) AS count FROM community_ratings WHERE community_id=$1 GROUP BY rating', req.params.id);
  res.json(ratings);
}));

app.post('/api/communities/:id/lockdown', auth, route(async (req,res) => {
  const mem = await store.get('SELECT * FROM memberships WHERE community_id=$1 AND user_id=$2', req.params.id, req.user.id);
  if (!req.user.is_admin && (!mem || (mem.role !== 'owner' && mem.role !== 'admin'))) return res.status(403).json({error:'Forbidden'});
  const locked = req.body.locked ?? 1;
  await store.run('UPDATE communities SET locked=$1 WHERE id=$2', locked, req.params.id);
  io.to(req.params.id).emit('community_locked',{communityId:req.params.id,locked});
  res.json({ok:true});
}));

// ── Server member management ──────────────────────────────────────────────────
app.get('/api/communities/:id/members', auth, route(async (req,res) => {
  const mem = await store.get('SELECT * FROM memberships WHERE community_id=$1 AND user_id=$2', req.params.id, req.user.id);
  if (!mem && !req.user.is_admin) return res.status(403).json({error:'Forbidden'});
  res.json(await store.all(`SELECT m.*,u.username,u.nickname AS user_nickname,u.avatar,u.badge,u.is_admin,u.status,u.rank AS platform_rank FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.community_id=$1 ORDER BY (m.role='owner') DESC, (m.role='admin') DESC, m.nickname, u.username`, req.params.id));
}));

app.patch('/api/communities/:id/members/:userId', auth, route(async (req,res) => {
  const target = await store.get('SELECT * FROM memberships WHERE community_id=$1 AND user_id=$2', req.params.id, req.params.userId);
  if (!target) return res.status(404).json({error:'Member not found'});
  const actor = await store.get('SELECT * FROM memberships WHERE community_id=$1 AND user_id=$2', req.params.id, req.user.id);
  const isSelf = req.params.userId === req.user.id;
  const isMod = req.user.is_admin || (actor && ['owner','admin'].includes(actor.role));
  if (!isSelf && !isMod) return res.status(403).json({error:'Forbidden'});
  if (!isSelf) {
    if (!(await canModerateTarget(req.user.id, req.params.id, req.params.userId))) {
      return res.status(403).json({error:'You cannot modify a member of equal or higher rank.'});
    }
    if (target.role === 'owner' && !req.user.is_admin) return res.status(403).json({error:'Cannot modify the owner'});
  }
  const role = isSelf ? target.role : (req.body.role || target.role);
  if (!isSelf && role === 'owner' && !req.user.is_admin) return res.status(403).json({error:'Cannot assign owner'});
  await store.run('UPDATE memberships SET nickname=$1,role=$2,muted=$3 WHERE community_id=$4 AND user_id=$5',
    req.body.nickname != null ? String(req.body.nickname).slice(0,40) : target.nickname,
    role, req.body.muted != null ? (req.body.muted ? 1 : 0) : target.muted, req.params.id, req.params.userId);
  res.json({ok:true});
}));

app.delete('/api/communities/:id/members/:userId', auth, route(async (req,res) => {
  const target = await store.get('SELECT * FROM memberships WHERE community_id=$1 AND user_id=$2', req.params.id, req.params.userId);
  if (!target) return res.status(404).json({error:'Member not found'});
  const actor = await store.get('SELECT * FROM memberships WHERE community_id=$1 AND user_id=$2', req.params.id, req.user.id);
  if (!req.user.is_admin && (!actor || !['owner','admin'].includes(actor.role))) return res.status(403).json({error:'Forbidden'});
  if (target.role === 'owner' && !req.user.is_admin) return res.status(403).json({error:'Cannot kick the owner'});
  if (target.role === 'admin' && actor?.role !== 'owner' && !req.user.is_admin) return res.status(403).json({error:'Only the owner can kick admins'});
  if (!(await canModerateTarget(req.user.id, req.params.id, req.params.userId))) {
    return res.status(403).json({error:'You cannot kick a member of equal or higher rank.'});
  }
  await store.run('DELETE FROM memberships WHERE community_id=$1 AND user_id=$2', req.params.id, req.params.userId);
  await store.run('DELETE FROM member_roles WHERE community_id=$1 AND user_id=$2', req.params.id, req.params.userId);
  io.to(`user:${req.params.userId}`).emit('community_kicked',{communityId:req.params.id});
  res.json({ok:true});
}));

app.post('/api/communities/:id/invite/regenerate', auth, route(async (req,res) => {
  const comm = await store.get('SELECT * FROM communities WHERE id=$1', req.params.id);
  if (!comm) return res.status(404).json({error:'Not found'});
  const actor = await store.get('SELECT * FROM memberships WHERE community_id=$1 AND user_id=$2', req.params.id, req.user.id);
  if (!req.user.is_admin && (!actor || !['owner','admin'].includes(actor.role))) return res.status(403).json({error:'Forbidden'});
  const invCode = nanoid(8);
  await store.run('UPDATE communities SET invite_code=$1 WHERE id=$2', invCode, req.params.id);
  res.json({inviteCode:invCode});
}));

app.delete('/api/communities/:communityId/messages/:messageId', auth, route(async (req,res) => {
  const msg = await store.get('SELECT * FROM messages WHERE id=$1 AND channel_id IS NOT NULL AND deleted_at IS NULL', req.params.messageId);
  if (!msg) return res.status(404).json({error:'Message not found'});
  const ch = await store.get('SELECT community_id FROM channels WHERE id=$1', msg.channel_id);
  if (!ch || ch.community_id !== req.params.communityId) return res.status(404).json({error:'Message not found'});
  const actor = await store.get('SELECT * FROM memberships WHERE community_id=$1 AND user_id=$2', req.params.communityId, req.user.id);
  if (!req.user.is_admin && (!actor || !['owner','admin'].includes(actor.role))) return res.status(403).json({error:'Forbidden'});
  // Lower-rank staff must not censor a higher-rank member's message.
  if (!(await canModerateTarget(req.user.id, req.params.communityId, msg.sender_id))) {
    return res.status(403).json({error:'You cannot delete a message from a member of equal or higher rank.'});
  }
  await store.run("UPDATE messages SET deleted_at=CURRENT_TIMESTAMP,body='[deleted]' WHERE id=$1", req.params.messageId);
  io.to(msg.channel_id).emit('message_delete',{id:req.params.messageId,channelId:msg.channel_id});
  res.json({ok:true});
}));

// ── Discovery ─────────────────────────────────────────────────────────────────
app.get('/api/discover', auth, route(async (req,res) => {
  const {category,tag,q} = req.query;
  let communities = await store.all("SELECT c.*,(SELECT COUNT(*) FROM memberships WHERE community_id=c.id) AS member_count FROM communities c WHERE visibility='public' ORDER BY member_count DESC LIMIT 50");
  if (tag) communities = communities.filter(c => (c.tags||'').includes(tag));
  if (q) communities = communities.filter(c => c.name.toLowerCase().includes(q.toLowerCase()));
  const u = await store.get('SELECT interests FROM users WHERE id=$1', req.user.id);
  const userInterests = (u?.interests||'').split(',').filter(Boolean);
  const recommended = userInterests.length ? communities.filter(c => userInterests.some(i => (c.tags||'').includes(i))) : [];
  res.json({communities, recommended});
}));

// ── Roles and channel permissions ─────────────────────────────────────────────
app.get('/api/communities/:communityId/roles', auth, route(async (req,res) => {
  const access = await communityAccess(req.user.id, req.params.communityId);
  if (!access.member && !req.user.is_admin) return res.status(403).json({error:'Forbidden'});
  const roles = await store.all('SELECT * FROM community_roles WHERE community_id=$1 ORDER BY position DESC,created_at', req.params.communityId);
  for (const role of roles) {
    role.permissions = parsePermissions(role.permissions);
    // Name the shop cosmetic this purchased role came from (e.g. 'Golden Role shop item').
    if (role.cosmetic) {
      const item = SERVER_COSMETICS.find(c => c.id === role.cosmetic);
      role.cosmeticName = item ? `${item.name} shop item` : role.cosmetic;
    }
  }
  res.json(roles);
}));
app.post('/api/communities/:communityId/roles', auth, route(async (req,res) => {
  const access = await communityAccess(req.user.id, req.params.communityId);
  if (!req.user.is_admin && (!access.member || !['owner','admin'].includes(access.member.role))) return res.status(403).json({error:'Forbidden'});
  const name = String(req.body.name||'').trim().slice(0,40);
  if (!name) return res.status(400).json({error:'Role name required'});
  const id = nanoid(); const position = Number(req.body.position)||0;
  const permissions = Object.fromEntries(ROLE_PERMISSIONS.map(p => [p, Boolean(req.body.permissions?.[p])]));
  await store.run('INSERT INTO community_roles (id,community_id,name,color,position,permissions,mentionable) VALUES (?,?,?,?,?,?,?)', id, req.params.communityId, name, req.body.color||'#5865f2', position, JSON.stringify(permissions), req.body.mentionable?1:0);
  res.json({id});
}));
app.patch('/api/communities/:communityId/roles/:roleId', auth, route(async (req,res) => {
  const access = await communityAccess(req.user.id, req.params.communityId);
  if (!req.user.is_admin && (!access.member || !['owner','admin'].includes(access.member.role))) return res.status(403).json({error:'Forbidden'});
  const role = await store.get('SELECT * FROM community_roles WHERE id=$1 AND community_id=$2', req.params.roleId, req.params.communityId);
  if (!role) return res.status(404).json({error:'Role not found'});
  const permissions = Object.fromEntries(ROLE_PERMISSIONS.map(p => [p, Boolean(req.body.permissions?.[p])]));
  const locked = req.body.locked !== undefined ? (req.body.locked ? 1 : 0) : Number(role.locked || 0);
  await store.run('UPDATE community_roles SET name=$1,color=$2,position=$3,permissions=$4,mentionable=$5,locked=$6 WHERE id=$7', String(req.body.name||role.name).slice(0,40), req.body.color||role.color, Number(req.body.position ?? role.position), JSON.stringify(permissions), req.body.mentionable?1:0, locked, role.id);
  res.json({ok:true, locked});
}));
app.delete('/api/communities/:communityId/roles/:roleId', auth, route(async (req,res) => {
  const access = await communityAccess(req.user.id, req.params.communityId);
  if (!req.user.is_admin && (!access.member || !['owner','admin'].includes(access.member.role))) return res.status(403).json({error:'Forbidden'});
  const role = await store.get('SELECT locked FROM community_roles WHERE id=$1 AND community_id=$2', req.params.roleId, req.params.communityId);
  if (role && Number(role.locked) === 1) return res.status(403).json({error:'This shop role is locked — unlock it before deleting'});
  await store.run('DELETE FROM member_roles WHERE role_id=$1', req.params.roleId);
  await store.run('DELETE FROM channel_permissions WHERE role_id=$1', req.params.roleId);
  await store.run('DELETE FROM community_roles WHERE id=$1 AND community_id=$2', req.params.roleId, req.params.communityId);
  res.json({ok:true});
}));
app.put('/api/communities/:communityId/members/:userId/roles/:roleId', auth, route(async (req,res) => {
  const access = await communityAccess(req.user.id, req.params.communityId);
  if (!req.user.is_admin && (!access.member || !['owner','admin'].includes(access.member.role))) return res.status(403).json({error:'Forbidden'});
  const role = await store.get('SELECT id FROM community_roles WHERE id=$1 AND community_id=$2', req.params.roleId, req.params.communityId);
  if (!role) return res.status(404).json({error:'Role not found'});
  await store.run('INSERT INTO member_roles VALUES (?,?,?) ON CONFLICT DO NOTHING', req.params.communityId, req.params.userId, req.params.roleId);
  res.json({ok:true});
}));
app.delete('/api/communities/:communityId/members/:userId/roles/:roleId', auth, route(async (req,res) => {
  const access = await communityAccess(req.user.id, req.params.communityId);
  if (!req.user.is_admin && (!access.member || !['owner','admin'].includes(access.member.role))) return res.status(403).json({error:'Forbidden'});
  await store.run('DELETE FROM member_roles WHERE community_id=$1 AND user_id=$2 AND role_id=$3', req.params.communityId, req.params.userId, req.params.roleId);
  res.json({ok:true});
}));
app.get('/api/channels/:channelId/permissions', auth, route(async (req,res) => {
  const ch = await store.get('SELECT * FROM channels WHERE id=$1', req.params.channelId);
  if (!ch) return res.status(404).json({error:'Channel not found'});
  const access = await communityAccess(req.user.id, ch.community_id);
  if (!access.member && !req.user.is_admin) return res.status(403).json({error:'Forbidden'});
  const rows = await store.all('SELECT * FROM channel_permissions WHERE channel_id=$1', ch.id);
  res.json(rows.map(r => ({...r,allow_permissions:parsePermissions(r.allow_permissions),deny_permissions:parsePermissions(r.deny_permissions)})));
}));
app.put('/api/channels/:channelId/permissions/:roleId', auth, route(async (req,res) => {
  const ch = await store.get('SELECT * FROM channels WHERE id=$1', req.params.channelId);
  if (!ch) return res.status(404).json({error:'Channel not found'});
  const access = await communityAccess(req.user.id, ch.community_id);
  if (!req.user.is_admin && (!access.member || !['owner','admin'].includes(access.member.role))) return res.status(403).json({error:'Forbidden'});
  await store.run('INSERT INTO channel_permissions (channel_id,role_id,allow_permissions,deny_permissions) VALUES (?,?,?,?) ON CONFLICT (channel_id,role_id) DO UPDATE SET allow_permissions=$3,deny_permissions=$4', ch.id, req.params.roleId, JSON.stringify(req.body.allow||{}), JSON.stringify(req.body.deny||{}));
  res.json({ok:true});
}));

// ── Channels ──────────────────────────────────────────────────────────────────
app.post('/api/channels', auth, route(async (req,res) => {
  const mem = await store.get('SELECT * FROM memberships WHERE community_id=$1 AND user_id=$2', req.body.communityId, req.user.id);
  if (!req.user.is_admin && (!mem || (mem.role !== 'owner' && mem.role !== 'admin'))) return res.status(403).json({error:'Forbidden'});
  const id = nanoid();
  const pos = (await store.get('SELECT COUNT(*) AS c FROM channels WHERE community_id=$1', req.body.communityId))?.c || 0;
  let expiresAt = null;
  if (req.body.expiresIn) {
    const hours = {hour:1,day:24,'7days':168}[req.body.expiresIn] || 1;
    const d = new Date(); d.setHours(d.getHours()+hours);
    expiresAt = d.toISOString();
  }
  await store.run('INSERT INTO channels VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)',
    id,req.body.communityId,req.body.name,req.body.type||'text',
    req.body.topic||'',Number(pos),req.body.category||'General',
    req.body.slowmode||0,expiresAt,req.body.is_topic?1:0,
    req.body.topic_description||'',req.body.discovery_tag||'',0);
  const channel = await store.get('SELECT * FROM channels WHERE id=$1', id);
  res.json({id, channel});
}));

app.patch('/api/channels/:id', auth, route(async (req,res) => {
  const ch = await store.get('SELECT * FROM channels WHERE id=$1', req.params.id);
  if (!ch) return res.status(404).json({error:'Not found'});
  const mem = await store.get('SELECT * FROM memberships WHERE community_id=$1 AND user_id=$2', ch.community_id, req.user.id);
  if (!req.user.is_admin && (!mem || (mem.role !== 'owner' && mem.role !== 'admin'))) return res.status(403).json({error:'Forbidden'});
  const {name,topic,slowmode,discovery_tag,locked,category} = req.body;
  await store.run('UPDATE channels SET name=$1,topic=$2,slowmode=$3,discovery_tag=$4,locked=$5,category=$6 WHERE id=$7',
    name||ch.name,topic??ch.topic,slowmode??ch.slowmode,discovery_tag??ch.discovery_tag,locked??ch.locked,category||ch.category,req.params.id);
  res.json({ok:true});
}));

app.delete('/api/channels/:id', auth, route(async (req,res) => {
  const ch = await store.get('SELECT * FROM channels WHERE id=$1', req.params.id);
  if (!ch) return res.status(404).json({error:'Not found'});
  const mem = await store.get('SELECT * FROM memberships WHERE community_id=$1 AND user_id=$2', ch.community_id, req.user.id);
  if (!req.user.is_admin && (!mem || (mem.role !== 'owner' && mem.role !== 'admin'))) return res.status(403).json({error:'Forbidden'});
  await store.run('DELETE FROM channels WHERE id=$1', req.params.id);
  res.json({ok:true});
}));

// ── Temporary Rooms ───────────────────────────────────────────────────────────
// Flexible rooms (chat/voice/video/game/drawing/poll/watch/collab) that expire.
const ROOM_TYPES = ['chat','voice','video','game','drawing','poll','watch','collab'];

function roomDurationMs(expiresIn) {
  if (/^\d+m$/.test(String(expiresIn))) return Number(expiresIn.slice(0,-1)) * 60 * 1000;
  const mins = { '5min':5, '30min':30, hour:60, day:1440 }[expiresIn] || 0;
  return mins * 60 * 1000;
}

app.get('/api/rooms', auth, route(async (req,res) => {
  const communityId = req.query.communityId;
  if (!communityId) return res.status(400).json({error:'communityId required'});
  const access = await communityAccess(req.user.id, communityId);
  if (!access.member && !req.user.is_admin) return res.status(403).json({error:'Not a member'});
  const rooms = await store.all('SELECT * FROM temp_rooms WHERE community_id=$1 ORDER BY created_at DESC', communityId);
  const out = [];
  for (const r of rooms) {
    const members = await store.all('SELECT rm.user_id,rm.waiting,u.username,u.nickname,u.avatar,u.badge FROM room_members rm JOIN users u ON u.id=rm.user_id WHERE rm.room_id=$1', r.id);
    const count = members.filter(m=>!Number(m.waiting)).length;
    const waiting = members.filter(m=>Number(m.waiting)).map(m=>({ user_id:m.user_id, username:m.username, nickname:m.nickname, avatar:m.avatar, badge:m.badge }));
    out.push({ ...r, waiting_room:Number(r.waiting_room), ptt:Number(r.ptt), member_count:count, waiting, me_in: members.some(m=>m.user_id===req.user.id && !Number(m.waiting)), me_waiting: members.some(m=>m.user_id===req.user.id && Number(m.waiting)), is_owner: r.owner_id===req.user.id });
  }
  res.json(out);
}));

app.post('/api/rooms', auth, route(async (req,res) => {
  const { communityId, name, type='chat', expiresIn='30min', waitingRoom=false, ptt=false } = req.body;
  if (!communityId || !name) return res.status(400).json({error:'communityId and name required'});
  if (!ROOM_TYPES.includes(type)) return res.status(400).json({error:'Invalid room type'});
  const access = await communityAccess(req.user.id, communityId);
  if (!access.member && !req.user.is_admin) return res.status(403).json({error:'Not a member'});
  const id = nanoid();
  const expiresAt = roomDurationMs(expiresIn) ? new Date(Date.now()+roomDurationMs(expiresIn)).toISOString() : null;
  await store.run('INSERT INTO temp_rooms (id,community_id,name,type,owner_id,waiting_room,ptt,expires_at) VALUES (?,?,?,?,?,?,?,?)',
    id, communityId, name, type, req.user.id, waitingRoom?1:0, ptt?1:0, expiresAt);
  await store.run('INSERT INTO room_members (room_id,user_id,waiting) VALUES (?,?,0)', id, req.user.id);
  const room = await store.get('SELECT * FROM temp_rooms WHERE id=$1', id);
  io.to(communityId).emit('room_update', { action:'created', room });
  res.json({ id, room });
}));

app.get('/api/rooms/:id', auth, route(async (req,res) => {
  const access = await canAccessRoom(req.user, req.params.id);
  const r = access.room;
  if (!r) return res.status(404).json({error:'Room not found'});
  if (!access.allowed) return res.status(403).json({error:'Forbidden'});
  const members = await store.all('SELECT rm.user_id,rm.waiting,u.username,u.nickname,u.avatar,u.badge FROM room_members rm JOIN users u ON u.id=rm.user_id WHERE rm.room_id=$1 ORDER BY rm.joined_at', r.id);
  res.json({ ...r, waiting_room:Number(r.waiting_room), ptt:Number(r.ptt),
    members: members.map(m=>({ user_id:m.user_id, username:m.username, nickname:m.nickname, avatar:m.avatar, badge:m.badge, waiting:Number(m.waiting) })),
    is_owner: r.owner_id===req.user.id });
}));

// Join a room. Waiting-room rooms admit the owner immediately and queue everyone else.
app.post('/api/rooms/:id/join', auth, route(async (req,res) => {
  const access = await canAccessRoom(req.user, req.params.id);
  const r = access.room;
  if (!r) return res.status(404).json({error:'Room not found'});
  if (!access.allowed) return res.status(403).json({error:'Forbidden'});
  const existing = await store.get('SELECT * FROM room_members WHERE room_id=$1 AND user_id=$2', r.id, req.user.id);
  const isOwner = r.owner_id === req.user.id || req.user.is_admin;
  if (existing) {
    if (Number(existing.waiting) && isOwner) await store.run('UPDATE room_members SET waiting=0 WHERE room_id=$1 AND user_id=$2', r.id, req.user.id);
    return res.json({ waiting: Number(existing.waiting) ? !isOwner : false });
  }
  const waiting = Number(r.waiting_room) && !isOwner ? 1 : 0;
  await store.run('INSERT INTO room_members (room_id,user_id,waiting) VALUES (?,?,?)', r.id, req.user.id, waiting);
  io.to(r.community_id).emit('room_update', { action:'joined', id:r.id });
  io.to(`room:${r.id}`).emit('room_presence', { action: waiting?'waiting':'joined', userId:req.user.id });
  if (waiting) {
    // Notify the owner there's someone in the waiting room
    const owner = await store.get('SELECT * FROM users WHERE id=$1', r.owner_id);
    if (owner) io.to(`user:${owner.id}`).emit('room_waiting', { roomId:r.id, roomName:r.name, userId:req.user.id, username:req.user.username });
  }
  res.json({ waiting });
}));

// Owner admits a waiting user
app.post('/api/rooms/:id/admit', auth, route(async (req,res) => {
  const access = await canAccessRoom(req.user, req.params.id);
  const r = access.room;
  if (!r) return res.status(404).json({error:'Room not found'});
  if (!access.allowed) return res.status(403).json({error:'Forbidden'});
  if (r.owner_id !== req.user.id && !req.user.is_admin) return res.status(403).json({error:'Only the owner can admit'});
  await store.run('UPDATE room_members SET waiting=0 WHERE room_id=$1 AND user_id=$2', r.id, req.body.userId);
  io.to(`room:${r.id}`).emit('room_presence', { action:'admitted', userId:req.body.userId });
  io.to(`user:${req.body.userId}`).emit('room_admitted', { roomId:r.id, roomName:r.name });
  res.json({ok:true});
}));

app.post('/api/rooms/:id/leave', auth, route(async (req,res) => {
  const access = await canAccessRoom(req.user, req.params.id);
  if (!access.room) return res.status(404).json({error:'Room not found'});
  if (!access.allowed) return res.status(403).json({error:'Forbidden'});
  await store.run('DELETE FROM room_members WHERE room_id=$1 AND user_id=$2', req.params.id, req.user.id);
  io.to(`room:${req.params.id}`).emit('room_presence', { action:'left', userId:req.user.id });
  res.json({ok:true});
}));

app.delete('/api/rooms/:id', auth, route(async (req,res) => {
  const access = await canAccessRoom(req.user, req.params.id);
  const r = access.room;
  if (!r) return res.status(404).json({error:'Room not found'});
  if (!access.allowed) return res.status(403).json({error:'Forbidden'});
  if (r.owner_id !== req.user.id && !req.user.is_admin) return res.status(403).json({error:'Only the owner can delete'});
  await store.run('DELETE FROM room_members WHERE room_id=$1', r.id);
  await store.run('DELETE FROM room_messages WHERE room_id=$1', r.id);
  await store.run('DELETE FROM room_polls WHERE room_id=$1', r.id);
  await store.run('DELETE FROM temp_rooms WHERE id=$1', r.id);
  io.to(r.community_id).emit('room_update', { action:'deleted', id:r.id });
  res.json({ok:true});
}));

// Room chat messages
app.get('/api/rooms/:id/messages', auth, route(async (req,res) => {
  const access = await canAccessRoom(req.user, req.params.id, true);
  if (!access.room) return res.status(404).json({error:'Room not found'});
  if (!access.allowed) return res.status(403).json({error:'Join the room first'});
  const rows = await store.all(`SELECT rm.*,u.username,u.nickname,u.avatar,u.badge FROM room_messages rm JOIN users u ON u.id=rm.sender_id WHERE rm.room_id=$1 ORDER BY rm.created_at DESC LIMIT 100`, req.params.id);
  rows.reverse();
  res.json(rows);
}));

app.post('/api/rooms/:id/messages', auth, route(async (req,res) => {
  const access = await canAccessRoom(req.user, req.params.id, true);
  const r = access.room;
  if (!r) return res.status(404).json({error:'Room not found'});
  if (!access.allowed) return res.status(403).json({error:'Join the room first'});
  const mem = await store.get('SELECT * FROM room_members WHERE room_id=$1 AND user_id=$2 AND waiting=0', r.id, req.user.id);
  if (!mem && !req.user.is_admin) return res.status(403).json({error:'Join the room first'});
  const id = nanoid();
  await store.run('INSERT INTO room_messages (id,room_id,sender_id,body) VALUES (?,?,?,?)', id, r.id, req.user.id, String(req.body.body||'').slice(0,2000));
  const msg = await store.get(`SELECT rm.*,u.username,u.nickname,u.avatar,u.badge FROM room_messages rm JOIN users u ON u.id=rm.sender_id WHERE rm.id=$1`, id);
  io.to(`room:${r.id}`).emit('room_message', msg);
  res.json(msg);
}));

// Room polls
app.post('/api/rooms/:id/polls', auth, route(async (req,res) => {
  const access = await canAccessRoom(req.user, req.params.id, true);
  const r = access.room;
  if (!r) return res.status(404).json({error:'Room not found'});
  if (!access.allowed) return res.status(403).json({error:'Join the room first'});
  const { question, options } = req.body;
  if (!question || !Array.isArray(options) || options.length < 2) return res.status(400).json({error:'Question and at least 2 options required'});
  const id = nanoid();
  await store.run('INSERT INTO room_polls (id,room_id,question,options,created_by) VALUES (?,?,?,?,?)', id, r.id, question, JSON.stringify(options.slice(0,6)), req.user.id);
  const poll = await store.get('SELECT * FROM room_polls WHERE id=$1', id);
  io.to(`room:${r.id}`).emit('room_poll', { ...poll, options:JSON.parse(poll.options), votes:[] });
  res.json({ ...poll, options:JSON.parse(poll.options), votes:[] });
}));

app.get('/api/rooms/:id/polls', auth, route(async (req,res) => {
  const access = await canAccessRoom(req.user, req.params.id, true);
  if (!access.room) return res.status(404).json({error:'Room not found'});
  if (!access.allowed) return res.status(403).json({error:'Join the room first'});
  const polls = await store.all('SELECT * FROM room_polls WHERE room_id=$1 ORDER BY created_at DESC', req.params.id);
  const out = [];
  for (const p of polls) {
    const votes = await store.all('SELECT option_index,COUNT(*) AS count FROM room_poll_votes WHERE poll_id=$1 GROUP BY option_index', p.id);
    const myVote = await store.get('SELECT option_index FROM room_poll_votes WHERE poll_id=$1 AND user_id=$2', p.id, req.user.id);
    out.push({ ...p, options:JSON.parse(p.options), votes, myVote: myVote?.option_index ?? null });
  }
  res.json(out);
}));

app.post('/api/rooms/:id/polls/:pollId/vote', auth, route(async (req,res) => {
  const access = await canAccessRoom(req.user, req.params.id, true);
  if (!access.room) return res.status(404).json({error:'Room not found'});
  if (!access.allowed) return res.status(403).json({error:'Join the room first'});
  const poll = await store.get('SELECT id FROM room_polls WHERE id=$1 AND room_id=$2', req.params.pollId, req.params.id);
  if (!poll) return res.status(404).json({error:'Poll not found'});
  await store.run('INSERT INTO room_poll_votes VALUES (?,?,?) ON CONFLICT (poll_id,user_id) DO UPDATE SET option_index=$3', req.params.pollId, req.user.id, req.body.optionIndex);
  const votes = await store.all('SELECT option_index,COUNT(*) AS count FROM room_poll_votes WHERE poll_id=$1 GROUP BY option_index', req.params.pollId);
  io.to(`room:${req.params.id}`).emit('room_poll_votes', { pollId:req.params.pollId, votes });
  res.json({ votes });
}));

// Collab text persistence
app.put('/api/rooms/:id/collab', auth, route(async (req,res) => {
  const access = await canAccessRoom(req.user, req.params.id, true);
  if (!access.room) return res.status(404).json({error:'Room not found'});
  if (!access.allowed) return res.status(403).json({error:'Join the room first'});
  const text = String(req.body.text||'').slice(0, 50000);
  await store.run('UPDATE temp_rooms SET collab_text=$1 WHERE id=$2', text, req.params.id);
  res.json({ok:true});
}));

// ── Messages ──────────────────────────────────────────────────────────────────
// Rate tracking for raid detection
const channelMsgRate = new Map();  const botReplyLimit = new Map();
let botTestCapture = null; // { ids:Set, channelId, timeout } set during a test-run
const botHintLimit = new Map(); // disabled-bot hints: `${botId}:${channelId}:${command}`, throttled to avoid spam

// Run a bot command from a chat message: `!command` or `@botname ...`.
// Bots never trigger other bots (prevents infinite loops).
// Post a message as a bot (used by static replies and the game engine)
async function postBotMessage(channelId, botId, body, replyToId) {
  const botMsgId = nanoid();
  await store.run('INSERT INTO messages (id,channel_id,dm_id,group_id,sender_id,body,reply_to) VALUES (?,?,?,?,?,?,?)',
    botMsgId, channelId, null, null, botId, body, replyToId || null);
  const botMsg = await store.get(`SELECT m.*,u.username,u.tag,u.avatar,u.nickname,u.badge,u.is_bot,u.anon_active,u.anon_mask,u.anon_color,u.bot_emoji,u.bot_color FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=$1`, botMsgId);
  io.to(channelId).emit('message', botMsg);
  io.to(channelId).emit('channel_activity',{channelId,messageId:botMsgId});
  // During a test-run, remember the id so we can clear the test output afterwards.
  if (botTestCapture && String(botTestCapture.channelId) === String(channelId)) botTestCapture.ids.add(botMsgId);
  return botMsg;
}

// Send a private hint to the user who ran a command (instead of posting it
// publicly in the channel). Creates a bot↔user DM on first use.
// `action` (optional) is embedded at the start of the body as @@{...}@@ so the
// client can render an inline button (e.g. enable_bot for disabled-bot hints).
async function sendBotDmHint(user, botId, text, action) {
  if (!user?.id || !text) return;
  let dm = await store.get('SELECT * FROM dms WHERE (user_a=$1 AND user_b=$2) OR (user_a=$2 AND user_b=$1)', botId, user.id);
  if (!dm) {
    const id = nanoid();
    await store.run('INSERT INTO dms VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)', id, botId, user.id, null, null);
    dm = await store.get(`SELECT d.*,ua.username AS user_a_name,ua.tag AS user_a_tag,ua.nickname AS user_a_nick,ua.avatar AS user_a_avatar,ua.status AS user_a_status,ua.badge AS user_a_badge,ub.username AS user_b_name,ub.tag AS user_b_tag,ub.nickname AS user_b_nick,ub.avatar AS user_b_avatar,ub.status AS user_b_status,ub.badge AS user_b_badge FROM dms d JOIN users ua ON ua.id=d.user_a JOIN users ub ON ub.id=d.user_b WHERE d.id=$1`, id);
    io.to(`user:${user.id}`).emit('new_dm', dm);
  }
  const msgId = nanoid();
  const body = action ? `@@${JSON.stringify(action)}@@ ${text}` : text;
  await store.run('INSERT INTO messages (id,channel_id,dm_id,group_id,sender_id,body) VALUES (?,?,?,?,?,?)',
    msgId, null, dm.id, null, botId, body);
  const msg = await store.get(`SELECT m.*,u.username,u.tag,u.avatar,u.nickname,u.badge,u.is_bot,u.anon_active,u.anon_mask,u.anon_color,u.bot_emoji,u.bot_color FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=$1`, msgId);
  io.to(`dm:${dm.id}`).emit('dm_message', msg);
  io.to(`user:${user.id}`).emit('dm_notification',{dmId:dm.id,message:msg});
  return msg;
}

// ── Bot-hosted games (trivia + tic-tac-toe) ─────────────────────────────────
const TRIVIA_POOL = [
  { q:'What planet is known as the Red Planet?', o:['Mars','Venus','Jupiter','Mercury'], a:0 },
  { q:'How many continents are there?', o:['5','6','7','8'], a:2 },
  { q:'What is the largest ocean on Earth?', o:['Atlantic','Indian','Arctic','Pacific'], a:3 },
  { q:'Who painted the Mona Lisa?', o:['Van Gogh','Da Vinci','Picasso','Rembrandt'], a:1 },
  { q:'What is the chemical symbol for gold?', o:['Au','Ag','Go','Gd'], a:0 },
  { q:'How many legs does a spider have?', o:['6','8','10','12'], a:1 },
  { q:'What is the smallest prime number?', o:['0','1','2','3'], a:2 },
  { q:'Which country is famous for the Great Wall?', o:['Japan','India','China','Korea'], a:2 },
  { q:'What does "www" stand for?', o:['World Wide Web','World Web Wide','Web World Wide','Wide Web World'], a:0 },
  { q:'How many days are in a leap year?', o:['364','365','366','367'], a:2 },
  { q:'What is the fastest land animal?', o:['Lion','Cheetah','Horse','Leopard'], a:1 },
  { q:'Which gas do plants absorb from the air?', o:['Oxygen','Nitrogen','Carbon dioxide','Hydrogen'], a:2 },
  { q:'What is the tallest mountain on Earth?', o:['K2','Everest','Kilimanjaro','Fuji'], a:1 },
  { q:'How many hearts does an octopus have?', o:['1','2','3','4'], a:2 },
  { q:'What is the capital of Japan?', o:['Seoul','Beijing','Tokyo','Bangkok'], a:2 },
];
const botGames = new Map(); // channelId -> session {type:'trivia'|'ttt', ...}
function shuffleArr(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function scoresText(scores, names) {
  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return 'no scores yet — play a game!';
  return entries.map(([uid, s]) => `${names?.[uid] || uid}: ${s}`).join(' · ');
}
function tttBoard(board) {
  const cell = i => board[i] ? (board[i] === 'X' ? '❌' : '⭕') : String(i + 1);
  return `${cell(0)} | ${cell(1)} | ${cell(2)}\n─────────\n${cell(3)} | ${cell(4)} | ${cell(5)}\n─────────\n${cell(6)} | ${cell(7)} | ${cell(8)}`;
}
function tttWin(board) {
  const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a,b,c] of lines) if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  return null;
}
function tttBotMove(board) {
  const empty = board.map((v,i) => v ? null : i).filter(v => v !== null);
  const winFor = mark => { for (const i of empty) { const b = board.slice(); b[i] = mark; if (tttWin(b) === mark) return i; } return -1; };
  const w = winFor('O'); if (w >= 0) return w;
  const b = winFor('X'); if (b >= 0) return b;
  return empty[Math.floor(Math.random() * empty.length)];
}

async function runBotGame(cmd, commandName, argText, channelId, replyToId, user) {
  const kind = (String(cmd.response).match(/{{game:([^}]+)}}/) || [])[1] || '';
  const bot = cmd.bot_nickname || cmd.bot_username || 'Bot';
  let game = botGames.get(channelId);
  const touchNames = () => {
    if (!game) return;
    game.names = game.names || {};
    if (user) game.names[user.id] = user.username;
  };

  if (kind === 'trivia' || kind === 'trivia_answer') {
    if (!game || game.type !== 'trivia' || game.done) {
      game = { type:'trivia', questions: shuffleArr(TRIVIA_POOL).slice(0, 5), qi: 0, scores: {}, names: {}, done: false };
      botGames.set(channelId, game);
    }
    touchNames();
    if (kind === 'trivia') {
      if (game.qi >= game.questions.length) {
        game.done = true;
        await postBotMessage(channelId, cmd.bot_id, `🏁 Trivia over! Scores: ${scoresText(game.scores, game.names)}`, replyToId);
        botGames.delete(channelId);
        return;
      }
      const q = game.questions[game.qi];
      await postBotMessage(channelId, cmd.bot_id,
        `🧠 ${bot} — Q${game.qi + 1}/${game.questions.length}: ${q.q}\n${q.o.map((o, i) => `${i + 1}. ${o}`).join('\n')}\nAnswer with /answer <text or number>`, replyToId);
      return;
    }
    // trivia_answer
    if (game.qi >= game.questions.length) {
      await postBotMessage(channelId, cmd.bot_id, 'No active question — start one with /trivia', replyToId);
      return;
    }
    const q = game.questions[game.qi];
    const ans = String(argText || '').trim().toLowerCase();
    const correct = ans === q.o[q.a].toLowerCase() || ans === String(q.a + 1) || ans === String.fromCharCode(97 + q.a);
    if (!correct) {
      await postBotMessage(channelId, cmd.bot_id, `❌ Not it, ${user?.username || 'friend'} — guess again!`, replyToId);
      return;
    }
    game.scores[user.id] = (game.scores[user.id] || 0) + 10;
    touchNames();
    game.qi++;
    if (game.qi >= game.questions.length) {
      game.done = true;
      await postBotMessage(channelId, cmd.bot_id, `✅ ${user.username} got it! +10 🏁 Trivia over! Scores: ${scoresText(game.scores, game.names)}`, replyToId);
      botGames.delete(channelId);
      return;
    }
    const nq = game.questions[game.qi];
    await postBotMessage(channelId, cmd.bot_id,
      `✅ ${user.username} got it! +10 · Scores: ${scoresText(game.scores, game.names)}\n\nNext — Q${game.qi + 1}/${game.questions.length}: ${nq.q}\n${nq.o.map((o, i) => `${i + 1}. ${o}`).join('\n')}`, replyToId);
    return;
  }

  if (kind === 'ttt' || kind === 'ttt_move') {
    if (kind === 'ttt') {
      if (game && game.type === 'ttt' && !game.over) {
        await postBotMessage(channelId, cmd.bot_id, 'A tic-tac-toe game is already running! Move with /move 1-9', replyToId);
        return;
      }
      let opponent = null;
      const at = String(argText || '').match(/^@([\w-]+)/);
      if (at) {
        const ou = await store.get('SELECT id FROM users WHERE username=$1 AND banned=0', at[1]);
        opponent = ou ? ou.id : null;
      }
      game = { type:'ttt', board: Array(9).fill(null), turn:'X', players: { X: user.id, O: opponent }, scores: {}, names: {}, over: false, vsBot: !opponent };
      touchNames();
      botGames.set(channelId, game);
      await postBotMessage(channelId, cmd.bot_id,
        `🎮 ${bot} — tic-tac-toe${game.vsBot ? ' (you vs me)' : ` (${user.username} vs ${game.names[opponent] || 'opponent'})`}\n${tttBoard(game.board)}\nX goes first — /move 1-9`, replyToId);
      return;
    }
    // ttt_move
    if (!game || game.type !== 'ttt' || game.over) {
      await postBotMessage(channelId, cmd.bot_id, 'No active game — start one with /ttt [@user]', replyToId);
      return;
    }
    touchNames();
    const idx = parseInt(argText, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx > 8 || game.board[idx]) {
      await postBotMessage(channelId, cmd.bot_id, 'Invalid move — /move 1-9 on an empty cell', replyToId);
      return;
    }
    const current = game.turn === 'X' ? game.players.X : game.players.O;
    if (current && current !== user.id) {
      await postBotMessage(channelId, cmd.bot_id, `Not your turn — it's ${game.turn}'s move`, replyToId);
      return;
    }
    const finish = async (msg, del) => {
      game.over = true;
      await postBotMessage(channelId, cmd.bot_id, msg, replyToId);
      if (del) botGames.delete(channelId);
    };
    const place = async (mark, i) => {
      game.board[i] = mark;
      const win = tttWin(game.board);
      if (win) {
        if (win === 'X' && game.players.X) game.scores[game.players.X] = (game.scores[game.players.X] || 0) + 10;
        if (win === 'O' && game.players.O) game.scores[game.players.O] = (game.scores[game.players.O] || 0) + 10;
        const winnerName = win === 'X' ? (game.names[game.players.X] || 'X') : (game.players.O ? (game.names[game.players.O] || 'O') : bot);
        await finish(`🏆 ${winnerName} wins with ${win}! +10\n${tttBoard(game.board)}\nScores: ${scoresText(game.scores, game.names)}`, true);
        return true;
      }
      if (game.board.every(Boolean)) {
        await finish(`🤝 It's a draw!\n${tttBoard(game.board)}`, true);
        return true;
      }
      game.turn = game.turn === 'X' ? 'O' : 'X';
      return false;
    };
    if (await place(game.turn, idx)) return;
    if (game.vsBot && game.turn === 'O') {
      const bi = tttBotMove(game.board);
      if (bi >= 0) {
        if (await place('O', bi)) return;
      }
      await postBotMessage(channelId, cmd.bot_id, `${tttBoard(game.board)}\nYour turn (X) — /move 1-9`, replyToId);
      return;
    }
    await postBotMessage(channelId, cmd.bot_id, `${tttBoard(game.board)}\n${game.turn === 'X' ? 'X' : 'O'}'s turn — /move 1-9`, replyToId);
    return;
  }

  if (kind === 'score') {
    const g = botGames.get(channelId);
    await postBotMessage(channelId, cmd.bot_id, `🏆 Game scores: ${scoresText(g?.scores || {}, g?.names)}`, replyToId);
    return;
  }
}

app.post('/api/humanize', auth, route(async (req,res) => {
  const text = String(req.body.text || '');
  res.json({ ok:true, text: humanizer(text) });
}));

// Resolve a bot command: static reply or a hosted game. Returns whether handled.
// Natural-language humanizer: light post-processing that makes templated bot
// replies read more naturally (casual filler, urgency softening, trimmed whitespace).
function humanizer(text) {
  text = String(text || '');
  const openers = ['', '', 'Well, ', 'Heads up — ', 'Quick one: ', 'Right — ', 'So, '];
  const opener = openers[Math.floor(Math.random() * openers.length)];
  if (opener && !/^[\s]*([*#-]+\s|\d\.\s|\(|>)/.test(text)) text = opener + text.slice(0,1).toLowerCase() + text.slice(1);
  let out = text
    .replace(/!+/g, '.')
    .replace(/\s+([.,?!])\s*/g, '$1 ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (out && /^[a-z]/.test(out)) out = out[0].toUpperCase() + out.slice(1);
  return out;
}

async function resolveBotCommand(commandName, argText, channelId, replyToId, user) {
  if (!commandName) return false;
  // Scope bot replies to their installed server (global admin bots still work everywhere)
  let commId = null;
  if (channelId) {
    const ch = await store.get('SELECT community_id FROM channels WHERE id=$1', channelId);
    commId = ch?.community_id || null;
  }
  let cmd = null;
  if (commId) {
    cmd = await store.get(`SELECT bc.*, u.username AS bot_username, u.nickname AS bot_nickname, u.avatar AS bot_avatar FROM bot_commands bc JOIN users u ON u.id=bc.bot_id WHERE LOWER(bc.command)=$1 AND u.is_bot=1 AND bc.community_id=$2 ORDER BY bc.created_at DESC LIMIT 1`, commandName, commId);
  }
  if (!cmd) {
    cmd = await store.get(`SELECT bc.*, u.username AS bot_username, u.nickname AS bot_nickname, u.avatar AS bot_avatar FROM bot_commands bc JOIN users u ON u.id=bc.bot_id WHERE LOWER(bc.command)=$1 AND u.is_bot=1 AND bc.community_id IS NULL ORDER BY bc.created_at DESC LIMIT 1`, commandName);
  }
  if (!cmd || !cmd.response) return false;
  // Per-server bot settings: disabled bots don't reply; allowed_channels restricts where they can.
  // Post a short inline hint explaining why (throttled per command+channel so it can't be spammed).
  if (commId) {
    const s = await store.get('SELECT enabled, allowed_channels, trigger_roles, blocked_roles, humanize FROM bot_settings WHERE community_id=$1 AND bot_id=$2', commId, cmd.bot_id);
    // Role context, hoisted so both the invoke gates and channel-visibility can use it.
    // Lists live at bot level (bot_settings) or per command (bot_command_roles, which
    // overrides the bot level when present). Staff always bypass all role gates.
    let triggerRoles = [];
    let blockedRoles = [];
    const cmdRoleRow = await store.get('SELECT trigger_roles, blocked_roles FROM bot_command_roles WHERE community_id=$1 AND bot_id=$2 AND command=$3', commId, cmd.bot_id, commandName);
    if (cmdRoleRow) {
      try { triggerRoles = JSON.parse(cmdRoleRow.trigger_roles || '[]'); } catch { triggerRoles = []; }
      try { blockedRoles = JSON.parse(cmdRoleRow.blocked_roles || '[]'); } catch { blockedRoles = []; }
    } else if (s) {
      try { triggerRoles = JSON.parse(s.trigger_roles || '[]'); } catch { triggerRoles = []; }
      try { blockedRoles = JSON.parse(s.blocked_roles || '[]'); } catch { blockedRoles = []; }
    }
    const memRole = user ? (await store.get('SELECT role FROM memberships WHERE community_id=$1 AND user_id=$2', commId, user.id))?.role : null;
    const staff = !!user?.is_admin || memRole === 'owner' || memRole === 'admin';
    const userRoleIds = user ? (await store.all('SELECT role_id FROM member_roles WHERE community_id=$1 AND user_id=$2', commId, user.id)).map(r => r.role_id) : [];
    if (s) {
      const hkey = `${cmd.bot_id}:${channelId}:${commandName}:${user?.id || 'anon'}`;
      const hNow = Date.now();
      const maybeHint = (text, action) => {
        if ((hNow - (botHintLimit.get(hkey) || 0)) < 15000) return; // throttled per command+channel+user
        botHintLimit.set(hkey, hNow);
        // DM the hint to just the person who ran the command — never clutter the channel.
        sendBotDmHint(user, cmd.bot_id, text, action).catch(()=>{});
      };
      if (Number(s.enabled) === 0) {
        maybeHint(`🚫 ${cmd.bot_nickname || cmd.bot_username} is turned off in this server — a server admin can enable it in Marketplace → Installed bots.`,
          { type:'enable_bot', communityId:commId, botId:cmd.bot_id });
        return false;
      }
      let allowed = [];
      try { allowed = JSON.parse(s.allowed_channels || '[]'); } catch { allowed = []; }
      if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(channelId)) {
        maybeHint(`🚫 ${cmd.bot_nickname || cmd.bot_username} only replies in its allowed channels here — it isn't enabled in this channel.`);
        return false;
      }
      // Deny-list wins: a blocked role cannot use the bot even if also in the allow-list.
      if (Array.isArray(blockedRoles) && blockedRoles.length > 0 && !staff) {
        const blockedByRole = userRoleIds.some(rid => blockedRoles.includes(rid));
        if (blockedByRole) {
          maybeHint(`🚫 Your role is blocked from using ${cmd.bot_nickname || cmd.bot_username} in this server — ask a server admin if this is a mistake.`);
          return false;
        }
      }
      if (Array.isArray(triggerRoles) && triggerRoles.length > 0) {
        const allowedByRole = staff || userRoleIds.some(rid => triggerRoles.includes(rid));
        if (!allowedByRole) {
          maybeHint(`🚫 Only members with an allowed role can use ${cmd.bot_nickname || cmd.bot_username} in this server — ask a server admin if you should have access.`);
          return false;
        }
      }
    }
    // Per-command visibility: a command hidden in the channel won't reply there — but
    // visibility respects trigger roles, so holders of an allowed role (and staff) may
    // still invoke it. Effectively a command can be hidden for non-role members too.
    if (await store.get('SELECT 1 FROM bot_command_visibility WHERE community_id=$1 AND bot_id=$2 AND channel_id=$3 AND command=$4', commId, cmd.bot_id, channelId, commandName)) {
      // Role holders (and staff) may still invoke a hidden command — fall through to the reply.
      const roleExempt = staff || (Array.isArray(triggerRoles) && triggerRoles.length > 0 && userRoleIds.some(rid => triggerRoles.includes(rid)));
      if (!roleExempt) {
        const vkey = `${cmd.bot_id}:${channelId}:${commandName}:${user?.id || 'anon'}`;
        const vNow = Date.now();
        if ((vNow - (botHintLimit.get(vkey) || 0)) >= 15000) {
          botHintLimit.set(vkey, vNow);
          sendBotDmHint(user, cmd.bot_id, `🚫 !${commandName} is hidden in this channel.`).catch(()=>{});
        }
        return false;
      }
    }
  }
  // Rate limit: one bot reply per bot per channel every 2s
  const key = `${cmd.bot_id}:${channelId}`;
  const now = Date.now();
  if (now - (botReplyLimit.get(key) || 0) < 2000) return true;
  botReplyLimit.set(key, now);
  // Game commands are marked with {{game:...}} in the template response
  if (cmd.response.startsWith('{{game:')) {
    await runBotGame(cmd, commandName, argText, channelId, replyToId, user);
    return true;
  }
  let response = cmd.response
    .replace(/\{args\}/g, argText)
    .replace(/\{user\}/g, user?.username || '');
  // `||` in a template response means "pick one at random"
  if (response.includes('||')) {
    const parts = response.split('||').map(s => s.trim()).filter(Boolean);
    if (parts.length) response = parts[Math.floor(Math.random() * parts.length)];
  }
  // Optional humanizer pass (server admins can toggle per bot).
  if (s && Number(s.humanize)) response = humanizer(response);
  await postBotMessage(channelId, cmd.bot_id, response, replyToId);
  return true;
}

async function runBotCommand(body, channelId, replyToId, user) {
  if (!body || !body.trim() || user?.is_bot) return;
  const trimmed = body.trim();
  let commandName = null, argText = '';
  const bang = trimmed.match(/^!(\S+)(?:\s+([\s\S]*))?$/);
  if (bang) { commandName = bang[1].toLowerCase(); argText = (bang[2] || '').trim(); }
  else {
    const at = trimmed.match(/^@([\w-]+)(?:\s+([\s\S]*))?$/);
    if (at) {
      const botUser = await store.get('SELECT id FROM users WHERE username=$1 AND is_bot=1', at[1]);
      if (botUser) { commandName = 'default'; argText = (at[2] || '').trim(); }
    }
  }
  if (!commandName) return;
  await resolveBotCommand(commandName, argText, channelId, replyToId, user);
}

function trackRate(channelId) {
  const now = Date.now();
  const arr = channelMsgRate.get(channelId) || [];
  const recent = arr.filter(t => now-t < 60000);
  recent.push(now);
  channelMsgRate.set(channelId, recent);
  return recent.length;
}

app.get('/api/channels/:id/messages', auth, route(async (req,res) => {
  if (!(await canAccessResource(req.user, { channelId:req.params.id }))) return res.status(403).json({error:'Forbidden'});
  const before = req.query.before;
  const around = req.query.around;
  const limit = Math.min(Number(req.query.limit)||100,200);
  let rows;
  if (around) {
    // Load a window of messages centered on a specific message (e.g. a bookmarked one)
    const pivot = await store.get('SELECT created_at FROM messages WHERE id=$1 AND channel_id=$2 AND deleted_at IS NULL', around, req.params.id);
    if (pivot) {
      const beforeRows = await store.all(`SELECT m.*,u.username,u.tag,u.avatar,u.nickname,u.badge,u.is_bot,u.anon_active,u.anon_mask,u.anon_color,u.bot_emoji,u.bot_color FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.channel_id=$1 AND m.deleted_at IS NULL AND m.created_at<=$2 ORDER BY m.created_at DESC LIMIT $3`, req.params.id, pivot.created_at, 60);
      const afterRows = await store.all(`SELECT m.*,u.username,u.tag,u.avatar,u.nickname,u.badge,u.is_bot,u.anon_active,u.anon_mask,u.anon_color,u.bot_emoji,u.bot_color FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.channel_id=$1 AND m.deleted_at IS NULL AND m.created_at>$2 ORDER BY m.created_at ASC LIMIT 40`, req.params.id, pivot.created_at, 60);
      rows = [...beforeRows.reverse(), ...afterRows];
    } else {
      rows = [];
    }
  } else if (before) {
    rows = await store.all(`SELECT m.*,u.username,u.tag,u.avatar,u.nickname,u.badge,u.is_bot,u.anon_active,u.anon_mask,u.anon_color,u.bot_emoji,u.bot_color FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.channel_id=$1 AND m.deleted_at IS NULL AND m.created_at<$2 ORDER BY m.created_at DESC LIMIT $3`, req.params.id, before, limit);
    rows.reverse();
  } else {
    rows = await store.all(`SELECT m.*,u.username,u.tag,u.avatar,u.nickname,u.badge,u.is_bot,u.anon_active,u.anon_mask,u.anon_color,u.bot_emoji,u.bot_color FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.channel_id=$1 AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT $2`, req.params.id, limit);
    rows.reverse();
  }
  const reactions = await store.all('SELECT * FROM reactions WHERE message_id = ANY($1::text[])', rows.map(r=>r.id));
  const polls = await store.all('SELECT * FROM polls WHERE channel_id=$1', req.params.id);
  rows.forEach(r => {
    r._reactions = reactions.filter(rx=>rx.message_id===r.id);
    r._poll = polls.find(p=>p.message_id===r.id)||null;
    if (r.anonymous_reply && !req.user.is_admin) { r.username='Anonymous'; r.tag='???'; r.avatar=null; r.nickname='Anonymous'; }
  });
  res.json(rows);
}));

app.get('/api/dms/:id/messages', auth, route(async (req,res) => {
  const dm = await store.get('SELECT * FROM dms WHERE id=$1 AND (user_a=$2 OR user_b=$2)', req.params.id, req.user.id);
  if (!dm) return res.status(403).json({error:'Forbidden'});
  let rows;
  const around = req.query.around;
  if (around) {
    const pivot = await store.get('SELECT created_at FROM messages WHERE id=$1 AND dm_id=$2 AND deleted_at IS NULL', around, req.params.id);
    if (pivot) {
      const beforeRows = await store.all(`SELECT m.*,u.username,u.tag,u.avatar,u.nickname,u.badge,u.is_bot,u.bot_emoji,u.bot_color FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.dm_id=$1 AND m.deleted_at IS NULL AND m.created_at<=$2 ORDER BY m.created_at DESC LIMIT 60`, req.params.id, pivot.created_at);
      const afterRows = await store.all(`SELECT m.*,u.username,u.tag,u.avatar,u.nickname,u.badge,u.is_bot,u.bot_emoji,u.bot_color FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.dm_id=$1 AND m.deleted_at IS NULL AND m.created_at>$2 ORDER BY m.created_at ASC LIMIT 40`, req.params.id, pivot.created_at);
      rows = [...beforeRows.reverse(), ...afterRows];
    } else { rows = []; }
  } else {
    rows = await store.all(`SELECT m.*,u.username,u.tag,u.avatar,u.nickname,u.badge,u.is_bot,u.bot_emoji,u.bot_color FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.dm_id=$1 AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 100`, req.params.id);
    rows.reverse();
  }
  const reactions = await store.all('SELECT * FROM reactions WHERE message_id = ANY($1::text[])', rows.map(r=>r.id));
  rows.forEach(r => { r._reactions = reactions.filter(rx=>rx.message_id===r.id); });
  res.json(rows);
}));

app.get('/api/groups/:id/messages', auth, route(async (req,res) => {
  const mem = await store.get('SELECT * FROM group_members WHERE group_id=$1 AND user_id=$2', req.params.id, req.user.id);
  if (!mem) return res.status(403).json({error:'Forbidden'});
  let rows;
  const around = req.query.around;
  if (around) {
    const pivot = await store.get('SELECT created_at FROM messages WHERE id=$1 AND group_id=$2 AND deleted_at IS NULL', around, req.params.id);
    if (pivot) {
      const beforeRows = await store.all(`SELECT m.*,u.username,u.tag,u.avatar,u.nickname,u.badge,u.is_bot,u.bot_emoji,u.bot_color FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.group_id=$1 AND m.deleted_at IS NULL AND m.created_at<=$2 ORDER BY m.created_at DESC LIMIT 60`, req.params.id, pivot.created_at);
      const afterRows = await store.all(`SELECT m.*,u.username,u.tag,u.avatar,u.nickname,u.badge,u.is_bot,u.bot_emoji,u.bot_color FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.group_id=$1 AND m.deleted_at IS NULL AND m.created_at>$2 ORDER BY m.created_at ASC LIMIT 40`, req.params.id, pivot.created_at);
      rows = [...beforeRows.reverse(), ...afterRows];
    } else { rows = []; }
  } else {
    rows = await store.all(`SELECT m.*,u.username,u.tag,u.avatar,u.nickname,u.badge,u.is_bot,u.bot_emoji,u.bot_color FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.group_id=$1 AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 100`, req.params.id);
    rows.reverse();
  }
  res.json(rows);
}));

app.post('/api/messages', auth, route(async (req,res) => {
  const id = nanoid();
  const body = String(req.body.body || '').slice(0, 10000);
  const channelId = req.body.channelId || null;
  const dmId = req.body.dmId || null;
  const groupId = req.body.groupId || null;
  if (!(await canAccessResource(req.user, { channelId, dmId, groupId }))) return res.status(403).json({error:'You do not have access to this conversation'});

  // Check community lock
  if (channelId) {
    const ch = await store.get('SELECT c.locked,ch.locked AS ch_locked FROM channels ch JOIN communities c ON c.id=ch.community_id WHERE ch.id=$1', channelId);
    if (ch && (Number(ch.locked) || Number(ch.ch_locked))) return res.status(403).json({error:'This server or channel is locked'});
    // Slowmode
    const chData = await store.get('SELECT slowmode FROM channels WHERE id=$1', channelId);
    if (chData && Number(chData.slowmode) > 0) {
      const key = `${req.user.id}:${channelId}`;
      const last = lastMsg.get(key) || 0;
      if (Date.now() - last < chData.slowmode * 1000) {
        return res.status(429).json({error:`Slow mode: wait ${Math.ceil((chData.slowmode*1000-(Date.now()-last))/1000)}s`});
      }
      lastMsg.set(key, Date.now());
    }
  }

  // PII check
  const piiResult = piiWarning(body);

  await store.run('INSERT INTO messages (id,channel_id,dm_id,group_id,sender_id,body,reply_to,attachment,attachment_name,attachment_type,anonymous_reply) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    id, channelId, dmId, groupId, req.user.id, body, req.body.replyTo||null,
    req.body.attachment||null, req.body.attachmentName||null, req.body.attachmentType||null,
    req.body.anonymousReply ? 1 : 0);

  const msg = await store.get(`SELECT m.*,u.username,u.tag,u.avatar,u.nickname,u.badge,u.is_bot,u.anon_active,u.anon_mask,u.anon_color,u.bot_emoji,u.bot_color FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=$1`, id);

  // Ping detection
  const pingPattern = /@(\w+)/g; let match;
  while ((match = pingPattern.exec(body)) !== null) {
    const pinged = await store.get('SELECT * FROM users WHERE username=$1', match[1]);
    if (pinged && pinged.id !== req.user.id) {
      await createNotification(pinged.id,'ping',id,'message',`${req.user.username} mentioned you`);
      io.to(`user:${pinged.id}`).emit('notification',{type:'ping',message:msg});
    }
  }

  if (channelId) {
    io.to(channelId).emit('message', msg);
    io.to(channelId).emit('channel_activity',{channelId,messageId:id});
    // Raid detection
    const rate = trackRate(channelId);
    const u = await store.get('SELECT created_at FROM users WHERE id=$1', req.user.id);
    const accountAge = Date.now() - new Date(u?.created_at||Date.now());
    if (rate > 20 && accountAge < 24*60*60*1000) {
      io.to(channelId).emit('raid_alert',{channelId});
      await store.run('UPDATE channels SET slowmode=5 WHERE id=$1', channelId);
    }
  }
  if (dmId) {
    io.to(`dm:${dmId}`).emit('dm_message', msg);
    const dm = await store.get('SELECT * FROM dms WHERE id=$1', dmId);
    if (dm) {
      const otherId = dm.user_a === req.user.id ? dm.user_b : dm.user_a;
      io.to(`user:${otherId}`).emit('dm_notification',{dmId,message:msg});
      await createNotification(otherId,'dm',id,'dm',`New message from ${req.user.username}`);
    }
  }
  // @everyone / @here mention support in server channels
  if (channelId && !req.user.is_bot && /@everyone|@here/.test(body)) {
    const chInfo = await store.get('SELECT community_id FROM channels WHERE id=$1', channelId);
    if (chInfo) {
      const members = await store.all('SELECT user_id FROM memberships WHERE community_id=$1', chInfo.community_id);
      for (const m of members) {
        if (m.user_id !== req.user.id) {
          await createNotification(m.user_id,'ping',id,'message',`${req.user.username} mentioned everyone in a channel`);
          io.to(`user:${m.user_id}`).emit('notification',{type:'ping',message:msg});
        }
      }
    }
  }

  // Bot commands (`!command` or `@botname`)
  if (channelId) await runBotCommand(body, channelId, id, req.user);

  if (groupId) {
    io.to(`group:${groupId}`).emit('group_message', msg);
    const members = await store.all('SELECT user_id FROM group_members WHERE group_id=$1', groupId);
    for (const m of members) {
      if (m.user_id !== req.user.id) {
        await createNotification(m.user_id,'group',id,'group',`New message in group`);
      }
    }
  }

  res.json({message:msg, piiWarning:piiResult});
}));

app.patch('/api/messages/:id', auth, route(async (req,res) => {
  const msg = await store.get('SELECT * FROM messages WHERE id=$1 AND sender_id=$2', req.params.id, req.user.id);
  if (!msg) return res.status(403).json({error:'Forbidden'});
  if (!(await canAccessResource(req.user, { channelId:msg.channel_id, dmId:msg.dm_id, groupId:msg.group_id }))) return res.status(403).json({error:'Forbidden'});
  await store.run('INSERT INTO message_edits VALUES (?,?,?,CURRENT_TIMESTAMP)', nanoid(), req.params.id, msg.body);
  await store.run('UPDATE messages SET body=$1,edited_at=CURRENT_TIMESTAMP WHERE id=$2', req.body.body, req.params.id);
  const updated = await store.get(`SELECT m.*,u.username,u.tag,u.avatar,u.nickname FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=$1`, req.params.id);
  if (updated?.channel_id) io.to(updated.channel_id).emit('message_edit', updated);
  if (updated?.dm_id) io.to(`dm:${updated.dm_id}`).emit('message_edit', updated);
  if (updated?.group_id) io.to(`group:${updated.group_id}`).emit('message_edit', updated);
  res.json({ok:true});
}));

app.get('/api/messages/:id/history', auth, adminOnly, route(async (req,res) => {
  res.json(await store.all('SELECT * FROM message_edits WHERE message_id=$1 ORDER BY edited_at DESC', req.params.id));
}));

app.delete('/api/messages/:id', auth, route(async (req,res) => {
  const msg = await store.get('SELECT * FROM messages WHERE id=$1 AND sender_id=$2', req.params.id, req.user.id);
  if (!msg) return res.status(403).json({error:'Forbidden'});
  if (!(await canAccessResource(req.user, { channelId:msg.channel_id, dmId:msg.dm_id, groupId:msg.group_id }))) return res.status(403).json({error:'Forbidden'});
  await store.run("UPDATE messages SET deleted_at=CURRENT_TIMESTAMP,body='[deleted]' WHERE id=$1", req.params.id);
  if (msg.channel_id) io.to(msg.channel_id).emit('message_delete',{id:req.params.id,channelId:msg.channel_id});
  if (msg.dm_id) io.to(`dm:${msg.dm_id}`).emit('message_delete',{id:req.params.id,dmId:msg.dm_id});
  res.json({ok:true});
}));

app.post('/api/messages/:id/reactions', auth, route(async (req,res) => {
  const target = await store.get('SELECT channel_id,dm_id,group_id FROM messages WHERE id=$1', req.params.id);
  if (!target || !(await canAccessResource(req.user, target))) return res.status(403).json({error:'Forbidden'});
  const emoji = String(req.body.emoji || '👍').slice(0,32);
  const existing = await store.get('SELECT * FROM reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3', req.params.id, req.user.id, emoji);
  if (existing) {
    await store.run('DELETE FROM reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3', req.params.id, req.user.id, emoji);
  } else {
    await store.run('INSERT INTO reactions VALUES (?,?,?) ON CONFLICT DO NOTHING', req.params.id, req.user.id, emoji);
    const msg = await store.get('SELECT sender_id FROM messages WHERE id=$1', req.params.id);
    if (msg && msg.sender_id !== req.user.id) await store.run('UPDATE users SET karma=karma+1 WHERE id=$1', msg.sender_id);
  }
  const counts = await store.all('SELECT emoji,COUNT(*) AS count FROM reactions WHERE message_id=$1 GROUP BY emoji', req.params.id);
  const msg = await store.get('SELECT * FROM messages WHERE id=$1', req.params.id);
  if (msg?.channel_id) io.to(msg.channel_id).emit('reaction_update',{messageId:req.params.id,reactions:counts});
  if (msg?.dm_id) io.to(`dm:${msg.dm_id}`).emit('reaction_update',{messageId:req.params.id,reactions:counts});
  if (msg?.group_id) io.to(`group:${msg.group_id}`).emit('reaction_update',{messageId:req.params.id,reactions:counts});
  res.json({reactions:counts});
}));

app.post('/api/messages/:id/pin', auth, route(async (req,res) => {
  const target = await store.get('SELECT channel_id,dm_id,group_id FROM messages WHERE id=$1', req.params.id);
  if (!target || !(await canAccessResource(req.user, target))) return res.status(403).json({error:'Forbidden'});
  await store.run('UPDATE messages SET pinned=$1 WHERE id=$2', req.body.pinned?1:0, req.params.id);
  res.json({ok:true});
}));

// ── Polls ─────────────────────────────────────────────────────────────────────
app.post('/api/polls', auth, route(async (req,res) => {
  const {question, options, channelId, dmId, groupId} = req.body;
  if (!(await canAccessResource(req.user, { channelId, dmId, groupId }))) return res.status(403).json({error:'You do not have access to this conversation'});
  if (!question || !Array.isArray(options) || options.length < 2) return res.status(400).json({error:'Question and at least 2 options required'});
  // Post a message first
  const msgId = nanoid();
  await store.run('INSERT INTO messages (id,channel_id,dm_id,group_id,sender_id,body) VALUES (?,?,?,?,?,?)',
    msgId, channelId||null, dmId||null, groupId||null, req.user.id, `📊 Poll: ${question}`);
  const pollId = nanoid();
  await store.run('INSERT INTO polls VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)',
    pollId, msgId, channelId||null, dmId||null, groupId||null, question, JSON.stringify(options), req.user.id);
  const msg = await store.get(`SELECT m.*,u.username,u.tag,u.avatar,u.nickname FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=$1`, msgId);
  msg._poll = {id:pollId,question,options:JSON.stringify(options),votes:[]};
  if (channelId) io.to(channelId).emit('message', msg);
  if (dmId) io.to(`dm:${dmId}`).emit('dm_message', msg);
  if (groupId) io.to(`group:${groupId}`).emit('group_message', msg);
  res.json({pollId, messageId:msgId});
}));

app.post('/api/polls/:id/vote', auth, route(async (req,res) => {
  const poll = await store.get('SELECT * FROM polls WHERE id=$1', req.params.id);
  if (!poll || !(await canAccessResource(req.user, { channelId:poll.channel_id, dmId:poll.dm_id, groupId:poll.group_id }))) return res.status(403).json({error:'Forbidden'});
  await store.run('INSERT INTO poll_votes VALUES (?,?,?) ON CONFLICT (poll_id,user_id) DO UPDATE SET option_index=$3', req.params.id, req.user.id, req.body.optionIndex);
  const votes = await store.all('SELECT option_index,COUNT(*) AS count FROM poll_votes WHERE poll_id=$1 GROUP BY option_index', req.params.id);
  const result = {pollId:req.params.id, votes};
  if (poll?.channel_id) io.to(poll.channel_id).emit('poll_update', result);
  if (poll?.dm_id) io.to(`dm:${poll.dm_id}`).emit('poll_update', result);
  res.json(result);
}));

app.get('/api/polls/:id', auth, route(async (req,res) => {
  const poll = await store.get('SELECT * FROM polls WHERE id=$1', req.params.id);
  if (!poll) return res.status(404).json({error:'Not found'});
  if (!(await canAccessResource(req.user, { channelId:poll.channel_id, dmId:poll.dm_id, groupId:poll.group_id }))) return res.status(403).json({error:'Forbidden'});
  const votes = await store.all('SELECT option_index,COUNT(*) AS count FROM poll_votes WHERE poll_id=$1 GROUP BY option_index', req.params.id);
  const myVote = await store.get('SELECT option_index FROM poll_votes WHERE poll_id=$1 AND user_id=$2', req.params.id, req.user.id);
  res.json({...poll, options:JSON.parse(poll.options||'[]'), votes, myVote:myVote?.option_index??null});
}));

// ── Threads ───────────────────────────────────────────────────────────────────
async function threadMsg(id) {
  return store.get(`SELECT m.*,u.username,u.tag,u.avatar,u.nickname,u.badge,u.is_bot,u.anon_active,u.anon_mask,u.anon_color,u.bot_emoji,u.bot_color FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=$1`, id);
}
// Create (or fetch) a thread attached to a message. Idempotent — one thread per message.
app.post('/api/messages/:id/thread', auth, route(async (req,res) => {
  const root = await store.get('SELECT * FROM messages WHERE id=$1', req.params.id);
  if (!root) return res.status(404).json({error:'Message not found'});
  if (!(await canAccessResource(req.user, { channelId:root.channel_id, dmId:root.dm_id, groupId:root.group_id }))) return res.status(403).json({error:'Forbidden'});
  if (!root.channel_id && !root.dm_id && !root.group_id) return res.status(400).json({error:'This message cannot host a thread'});
  let thread = await store.get('SELECT * FROM threads WHERE root_message_id=$1', root.id);
  if (!thread) {
    const tid = nanoid();
    await store.run('INSERT INTO threads (id,root_message_id,channel_id,dm_id,group_id) VALUES (?,?,?,?,?)',
      tid, root.id, root.channel_id||null, root.dm_id||null, root.group_id||null);
    thread = await store.get('SELECT * FROM threads WHERE id=$1', tid);
  }
  res.json({ thread, root: await threadMsg(root.id) });
}));

app.get('/api/threads/:id', auth, route(async (req,res) => {
  const thread = await store.get('SELECT * FROM threads WHERE id=$1', req.params.id);
  if (!thread) return res.status(404).json({error:'Thread not found'});
  if (!(await canAccessResource(req.user, { channelId:thread.channel_id, dmId:thread.dm_id, groupId:thread.group_id }))) return res.status(403).json({error:'Forbidden'});
  const root = await threadMsg(thread.root_message_id);
  const messages = await store.all(`SELECT m.*,u.username,u.tag,u.avatar,u.nickname,u.badge,u.is_bot,u.anon_active,u.anon_mask,u.anon_color,u.bot_emoji,u.bot_color FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.thread_id=$1 AND m.deleted_at IS NULL ORDER BY m.created_at ASC LIMIT 100`, thread.id);
  res.json({ thread, root, messages });
}));

// List every thread in a channel with reply count + last activity (for the threads sidebar)
app.get('/api/channels/:id/threads', auth, route(async (req,res) => {
  const ch = await store.get('SELECT * FROM channels WHERE id=$1', req.params.id);
  if (!ch) return res.status(404).json({error:'Channel not found'});
  if (!(await canAccessResource(req.user, { channelId:ch.id }))) return res.status(403).json({error:'Forbidden'});
  const rows = await store.all(`
    SELECT t.id, t.root_message_id, t.created_at,
      COUNT(m.id) AS reply_count,
      MAX(m.created_at) AS last_activity
    FROM threads t
    LEFT JOIN messages m ON m.thread_id = t.id AND m.deleted_at IS NULL
    WHERE t.channel_id = $1
    GROUP BY t.id
    ORDER BY COALESCE(MAX(m.created_at), t.created_at) DESC`, req.params.id);
  const out = [];
  for (const r of rows) {
    const root = await threadMsg(r.root_message_id);
    if (!root) continue;
    out.push({
      id: r.id, root_message_id: r.root_message_id,
      reply_count: Number(r.reply_count || 0),
      last_activity: r.last_activity || r.created_at,
      root,
    });
  }
  res.json(out);
}));

app.post('/api/threads/:id/messages', auth, route(async (req,res) => {
  const thread = await store.get('SELECT * FROM threads WHERE id=$1', req.params.id);
  if (!thread) return res.status(404).json({error:'Thread not found'});
  if (!(await canAccessResource(req.user, { channelId:thread.channel_id, dmId:thread.dm_id, groupId:thread.group_id }))) return res.status(403).json({error:'Forbidden'});
  const body = String(req.body.body || '').slice(0, 2000);
  if (!body.trim()) return res.status(400).json({error:'Message body required'});
  const id = nanoid();
  await store.run('INSERT INTO messages (id,channel_id,dm_id,group_id,sender_id,body,thread_id) VALUES (?,?,?,?,?,?,?)',
    id, thread.channel_id||null, thread.dm_id||null, thread.group_id||null, req.user.id, body, thread.id);
  const msg = await threadMsg(id);
  if (thread.channel_id) io.to(thread.channel_id).emit('thread_message', msg);
  if (thread.dm_id) io.to(`dm:${thread.dm_id}`).emit('thread_message', msg);
  if (thread.group_id) io.to(`group:${thread.group_id}`).emit('thread_message', msg);
  res.json(msg);
}));

// ── Bookmarks (private, per-user) ─────────────────────────────────────────────
app.post('/api/bookmarks', auth, route(async (req,res) => {
  const messageId = req.body.messageId;
  if (!messageId) return res.status(400).json({error:'messageId required'});
  const msg = await store.get('SELECT id,channel_id,dm_id,group_id FROM messages WHERE id=$1', messageId);
  if (!msg) return res.status(404).json({error:'Message not found'});
  const f = String(req.body.folder || 'Important').slice(0, 24);
  await store.run('INSERT INTO bookmarks VALUES (?,?,?,CURRENT_TIMESTAMP) ON CONFLICT (user_id,message_id) DO UPDATE SET folder=$3', req.user.id, messageId, f);
  res.json({ok:true});
}));

app.get('/api/bookmarks', auth, route(async (req,res) => {
  const bookmarks = await store.all(`SELECT
      b.message_id, b.folder, b.created_at,
      m.body, m.attachment, m.attachment_name, m.created_at AS msg_created,
      m.channel_id, m.dm_id, m.group_id,
      u.username, u.nickname, u.avatar, u.tag, u.badge,
      ch.name AS channel_name, ch.community_id,
      dm.user_a, dm.user_b,
      g.name AS group_name
    FROM bookmarks b
    JOIN messages m ON m.id = b.message_id
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN channels ch ON ch.id = m.channel_id
    LEFT JOIN dms dm ON dm.id = m.dm_id
    LEFT JOIN groups_chat g ON g.id = m.group_id
    WHERE b.user_id = $1
    ORDER BY b.created_at DESC`, req.user.id);
  res.json({ bookmarks });
}));

app.patch('/api/bookmarks/:messageId', auth, route(async (req,res) => {
  const f = String(req.body.folder || 'Important').slice(0, 24);
  await store.run('UPDATE bookmarks SET folder=$1 WHERE user_id=$2 AND message_id=$3', f, req.user.id, req.params.messageId);
  res.json({ok:true});
}));

app.delete('/api/bookmarks/:messageId', auth, route(async (req,res) => {
  await store.run('DELETE FROM bookmarks WHERE user_id=$1 AND message_id=$2', req.user.id, req.params.messageId);
  res.json({ok:true});
}));

// Export all of a user's bookmarks as a readable archive
const BOOKMARK_FOLDERS = ['School','Games','Ideas','Important'];
function fmtArchiveDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString('en-US', { dateStyle:'medium', timeStyle:'short' });
}
app.get('/api/bookmarks/export', auth, route(async (req,res) => {
  const bookmarks = await store.all(`SELECT
      b.message_id, b.folder, b.created_at,
      m.body, m.attachment, m.attachment_name, m.created_at AS msg_created,
      m.channel_id, m.dm_id, m.group_id,
      u.username, u.nickname, u.tag,
      ch.name AS channel_name, ch.community_id,
      dm.user_a, dm.user_b,
      g.name AS group_name
    FROM bookmarks b
    JOIN messages m ON m.id = b.message_id
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN channels ch ON ch.id = m.channel_id
    LEFT JOIN dms dm ON dm.id = m.dm_id
    LEFT JOIN groups_chat g ON g.id = m.group_id
    WHERE b.user_id = $1
    ORDER BY b.created_at DESC`, req.user.id);
  const me = await store.get('SELECT username, nickname FROM users WHERE id=$1', req.user.id);
  const display = me?.nickname || me?.username || 'Unknown user';

  const lines = [];
  lines.push(`Unknown — Bookmark Archive`);
  lines.push(`User: ${display}`);
  lines.push(`Exported: ${fmtArchiveDate(new Date().toISOString())}`);
  lines.push(`Total: ${bookmarks.length} bookmark${bookmarks.length === 1 ? '' : 's'}`);
  lines.push('');

  const byFolder = {};
  for (const b of bookmarks) (byFolder[b.folder || 'Important'] = byFolder[b.folder || 'Important'] || []).push(b);
  const folderOrder = [...BOOKMARK_FOLDERS.filter(f => byFolder[f]), ...Object.keys(byFolder).filter(f => !BOOKMARK_FOLDERS.includes(f))];

  for (const folder of folderOrder) {
    const items = byFolder[folder];
    lines.push(`━━━ ${folder} (${items.length}) ━━━`);
    lines.push('');
    items.forEach((b, i) => {
      const author = b.nickname || b.username || 'Unknown';
      const where = b.channel_name ? `#${b.channel_name}` : b.group_name ? b.group_name : b.dm_id ? 'DM' : '—';
      lines.push(`[${i + 1}] ${author} · ${where}`);
      lines.push(`    When: ${fmtArchiveDate(b.msg_created)}`);
      if (b.body) lines.push(`    ${b.body}`);
      if (b.attachment) lines.push(`    📎 ${b.attachment_name || 'attachment'}: ${b.attachment}`);
      lines.push('');
    });
  }

  const filename = `unknown-bookmarks-${req.user.id.slice(0, 8)}.txt`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(lines.join('\n'));
}));

// ── Reveal (social area: posts / videos / shorts / quizzes) ───────────────────
const REVEAL_TYPES = ['post','video','short','quiz'];

app.get('/api/reveal/feed', auth, route(async (req,res) => {
  const type = REVEAL_TYPES.includes(req.query.type) ? req.query.type : null;
  const q = String(req.query.q || '').trim();
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  let sql = `SELECT p.*, u.username,u.nickname,u.avatar,u.tag,u.badge,u.rank,
      (SELECT COUNT(*) FROM reveal_likes l WHERE l.post_id=p.id) AS likes,
      (SELECT COUNT(*) FROM reveal_post_views v WHERE v.post_id=p.id) AS views,
      (SELECT COUNT(*) FROM reveal_comments c WHERE c.post_id=p.id AND c.deleted_at IS NULL) AS comments,
      (SELECT COUNT(*) FROM reveal_follows f WHERE f.followed_id=p.author_id) AS followers,
      (SELECT 1 FROM reveal_likes l WHERE l.post_id=p.id AND l.user_id=$1) AS liked,
      (SELECT 1 FROM reveal_follows f WHERE f.followed_id=p.author_id AND f.follower_id=$1) AS following,
      (SELECT 1 FROM reveal_post_views v WHERE v.post_id=p.id AND v.user_id=$1) AS viewed
    FROM reveal_posts p JOIN users u ON u.id=p.author_id
    WHERE p.deleted_at IS NULL`;
  const params = [req.user.id];
  if (req.query.following === 'true') {
    // Only posts from people this user follows
    sql += ` AND EXISTS (SELECT 1 FROM reveal_follows f WHERE f.followed_id=p.author_id AND f.follower_id=$${params.length})`;
  }
  if (type) { params.push(type); sql += ` AND p.type=$${params.length}`; }
  if (q) { params.push(`%${q.replace(/%/g,'')}%`); sql += ` AND (p.body ILIKE $${params.length} OR u.username ILIKE $${params.length} OR u.nickname ILIKE $${params.length})`; }
  if (req.query.sort === 'comments') sql += ` ORDER BY comments DESC, p.created_at DESC LIMIT $${params.length + 1}`;
  else if (req.query.sort === 'likes') sql += ` ORDER BY likes DESC, p.created_at DESC LIMIT $${params.length + 1}`;
  else if (req.query.sort === 'trending') sql += ` ORDER BY (likes * 2 + comments * 1.5) DESC, p.created_at DESC LIMIT $${params.length + 1}`;
  else sql += ` ORDER BY p.created_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);
  const rows = await store.all(sql, ...params);
  const posts = rows.map(p => ({ ...p, liked: !!p.liked, following: !!p.following, viewed: !!p.viewed }));
  const people = await store.all(`SELECT u.id,u.username,u.nickname,u.avatar,u.tag,u.badge,u.rank,
      (SELECT COUNT(*) FROM reveal_follows f WHERE f.followed_id=u.id) AS followers,
      (SELECT 1 FROM reveal_follows f WHERE f.followed_id=u.id AND f.follower_id=$1) AS following
    FROM users u WHERE u.banned=0 AND u.is_bot=0
    ORDER BY followers DESC, u.created_at ASC LIMIT 12`, req.user.id);
  const ban = await store.get('SELECT * FROM reveal_bans WHERE user_id=$1', req.user.id);
  res.json({ posts, people: people.map(p => ({ ...p, following: !!p.following })), banned: !!ban, banReason: ban?.reason || '' });
}));

app.post('/api/reveal/posts', auth, route(async (req,res) => {
  const ban = await store.get('SELECT * FROM reveal_bans WHERE user_id=$1', req.user.id);
  if (ban) return res.status(403).json({ error: `You are banned from posting in Reveal${ban.reason ? `: ${ban.reason}` : ''}` });
  const type = REVEAL_TYPES.includes(req.body.type) ? req.body.type : 'post';
  const body = String(req.body.body || '').slice(0, 1000);
  if (type === 'post' && !body.trim() && !req.body.media) return res.status(400).json({ error: 'Write something or attach media' });
  let quiz = null;
  if (type === 'quiz') {
    const question = String(req.body.quiz?.question || '').slice(0, 200);
    const options = (req.body.quiz?.options || []).map(o => String(o).slice(0, 120)).filter(Boolean);
    if (!question || options.length < 2) return res.status(400).json({ error: 'Quiz needs a question and 2+ options' });
    const answer = Math.min(Math.max(parseInt(req.body.quiz?.answer) || 0, 0), options.length - 1);
    quiz = JSON.stringify({ question, options: options.slice(0, 6), answer });
  }
  const id = nanoid();
  await store.run('INSERT INTO reveal_posts (id,author_id,type,body,media,media_name,media_type,quiz) VALUES (?,?,?,?,?,?,?,?)',
    id, req.user.id, type, body, req.body.media || null, req.body.mediaName || null, req.body.mediaType || null, quiz);
  const post = await store.get(`SELECT p.*,u.username,u.nickname,u.avatar,u.tag,u.badge FROM reveal_posts p JOIN users u ON u.id=p.author_id WHERE p.id=$1`, id);
  res.json({ post: { ...post, likes: 0, views: 0, liked: false, following: false, viewed: false } });
}));

app.get('/api/reveal/posts/:id', auth, route(async (req,res) => {
  const post = await store.get(`SELECT p.*,u.username,u.nickname,u.avatar,u.tag,u.badge,
      (SELECT COUNT(*) FROM reveal_likes l WHERE l.post_id=p.id) AS likes,
      (SELECT COUNT(*) FROM reveal_post_views v WHERE v.post_id=p.id) AS views,
      (SELECT 1 FROM reveal_likes l WHERE l.post_id=p.id AND l.user_id=$1) AS liked
    FROM reveal_posts p JOIN users u ON u.id=p.author_id WHERE p.id=$2 AND p.deleted_at IS NULL`, req.user.id, req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  await store.run('INSERT INTO reveal_post_views VALUES (?,?) ON CONFLICT DO NOTHING', req.user.id, post.id);
  res.json({ post: { ...post, liked: !!post.liked } });
}));

// Batch register views (fire-and-forget after a feed load)
app.post('/api/reveal/views', auth, route(async (req,res) => {
  const ids = Array.isArray(req.body.postIds) ? req.body.postIds.slice(0, 100).filter(Boolean) : [];
  for (const pid of ids) await store.run('INSERT INTO reveal_post_views VALUES (?,?) ON CONFLICT DO NOTHING', req.user.id, pid);
  res.json({ ok: true });
}));

app.delete('/api/reveal/posts/:id', auth, route(async (req,res) => {
  const post = await store.get('SELECT * FROM reveal_posts WHERE id=$1', req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.author_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Forbidden' });
  await store.run('UPDATE reveal_posts SET deleted_at=CURRENT_TIMESTAMP WHERE id=$1', req.params.id);
  // If a moderator/admin removes someone else's post, notify the author with the reason.
  if (req.user.is_admin && post.author_id !== req.user.id) {
    const reason = String(req.body?.reason || req.body?.category || '').trim();
    const label = post.type === 'short' ? '📱 short' : post.type === 'video' ? '🎬 video' : post.type === 'quiz' ? '❓ quiz' : '📝 post';
    const modHandle = req.user.nickname || req.user.username;
    const body = `Your ${label} was removed by moderation${modHandle ? ` (actioned by ${modHandle})` : ''}.` + (reason ? ` Reason: ${reason}` : '');
    await createNotification(post.author_id, 'moderation', post.id, 'reveal', body);
    // Live socket: online authors get an inline toast on top of the persisted bell notification.
    io.to(`user:${post.author_id}`).emit('notification', { type: 'moderation', message: { body }, reason, moderator: modHandle || null, toast: body });
    await store.run('INSERT INTO moderation_logs VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)', nanoid(), req.user.id, 'mod_remove_reveal', post.id, reason);
    // Track the removal so the author can see it and appeal.
    await store.run(`INSERT INTO reveal_removals (post_id, removed_by, reason) VALUES (?,?,?)
      ON CONFLICT (post_id) DO UPDATE SET removed_by=$2, reason=$3, removed_at=CURRENT_TIMESTAMP, appeal_status='none', appeal_text=''`,
      post.id, req.user.id, reason);
  }
  io.to('reveal').emit('post_delete', { id: post.id, authorId: post.author_id });
  res.json({ ok: true });
}));

// The author's own removed posts, with why they were taken down and appeal status.
app.get('/api/reveal/me/removed', auth, route(async (req,res) => {
  const rows = await store.all(`SELECT p.*, r.removed_by, r.reason, r.removed_at, r.appeal_status, r.appeal_text,
      u.username AS mod_username, u.nickname AS mod_nickname
    FROM reveal_posts p
    JOIN reveal_removals r ON r.post_id = p.id
    LEFT JOIN users u ON u.id = r.removed_by
    WHERE p.author_id = $1
    ORDER BY r.removed_at DESC`, req.user.id);
  res.json({ posts: rows.map(p => ({ ...p, quiz: p.quiz || null })) });
}));

// Submit or withdraw an appeal on a removed post.
app.post('/api/reveal/posts/:id/appeal', auth, route(async (req,res) => {
  const post = await store.get('SELECT * FROM reveal_posts WHERE id=$1', req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.author_id !== req.user.id) return res.status(403).json({ error: 'Only the author can appeal' });
  const removal = await store.get('SELECT * FROM reveal_removals WHERE post_id=$1', req.params.id);
  if (!removal) return res.status(400).json({ error: 'This post was not removed by moderation' });
  const text = String(req.body?.text || '').slice(0, 1000);
  if (removal.appeal_status === 'pending' && !text.trim()) {
    // Withdraw the pending appeal.
    await store.run("UPDATE reveal_removals SET appeal_status='none', appeal_text='' WHERE post_id=$1", req.params.id);
    return res.json({ ok: true, status: 'none' });
  }
  if (!text.trim()) return res.status(400).json({ error: 'Explain why the post should be restored' });
  await store.run("UPDATE reveal_removals SET appeal_status='pending', appeal_text=$1 WHERE post_id=$2", text.trim(), req.params.id);
  // Notify platform admins so someone can review.
  const admins = await store.all("SELECT id FROM users WHERE is_admin=1");
  for (const a of admins) {
    const byName = req.user.nickname || req.user.username;
    const body = `🔔 ${byName} appealed the removal of a Reveal post: ${text.trim().slice(0, 120)}`;
    await createNotification(a.id, 'moderation', req.params.id, 'reveal', body);
    io.to(`user:${a.id}`).emit('notification', { type: 'moderation', message: { body }, toast: body, appealPostId: req.params.id });
  }
  res.json({ ok: true, status: 'pending' });
}));

app.post('/api/reveal/posts/:id/like', auth, route(async (req,res) => {
  await store.run('INSERT INTO reveal_likes VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING', req.user.id, req.params.id);
  const likes = Number((await store.get('SELECT COUNT(*) AS c FROM reveal_likes WHERE post_id=$1', req.params.id))?.c || 0);
  res.json({ likes });
}));
app.delete('/api/reveal/posts/:id/like', auth, route(async (req,res) => {
  await store.run('DELETE FROM reveal_likes WHERE user_id=$1 AND post_id=$2', req.user.id, req.params.id);
  const likes = Number((await store.get('SELECT COUNT(*) AS c FROM reveal_likes WHERE post_id=$1', req.params.id))?.c || 0);
  res.json({ likes });
}));

app.post('/api/reveal/users/:id/follow', auth, route(async (req,res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot follow yourself' });
  await store.run('INSERT INTO reveal_follows VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING', req.user.id, req.params.id);
  res.json({ ok: true });
}));
app.delete('/api/reveal/users/:id/follow', auth, route(async (req,res) => {
  await store.run('DELETE FROM reveal_follows WHERE follower_id=$1 AND followed_id=$2', req.user.id, req.params.id);
  res.json({ ok: true });
}));

// ── Reveal comments & replies ───────────────────────────────────────────────
// Flat comment list with author info; replies nest under parent_id.
app.get('/api/reveal/posts/:id/comments', auth, route(async (req,res) => {
  const post = await store.get('SELECT * FROM reveal_posts WHERE id=$1 AND deleted_at IS NULL', req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  // sort=new (default, chronological) | top (most-liked first)
  const orderBy = req.query.sort === 'top'
    ? 'c.pinned DESC, likes DESC, c.created_at ASC'
    : 'c.pinned DESC, c.created_at ASC';
  const rows = await store.all(`SELECT c.*, u.username,u.nickname,u.avatar,u.tag,u.badge,
      (SELECT COUNT(*) FROM reveal_comment_likes cl WHERE cl.comment_id=c.id) AS likes,
      (SELECT 1 FROM reveal_comment_likes cl WHERE cl.comment_id=c.id AND cl.user_id=$2) AS liked
    FROM reveal_comments c JOIN users u ON u.id=c.author_id
    WHERE c.post_id=$1 AND c.deleted_at IS NULL
    ORDER BY ${orderBy}`, req.params.id, req.user.id);
  // Nest replies under their parent; orphaned replies become top-level
  const byId = {};
  const roots = [];
  for (const c of rows) {
    byId[c.id] = { ...c, replies: [], likes: Number(c.likes||0), liked: !!c.liked };
  }
  for (const c of rows) {
    if (c.parent_id && byId[c.parent_id]) byId[c.parent_id].replies.push(byId[c.id]);
    else roots.push(byId[c.id]);
  }
  res.json({ comments: roots });
}));

app.post('/api/reveal/posts/:id/comments', auth, route(async (req,res) => {
  const ban = await store.get('SELECT * FROM reveal_bans WHERE user_id=$1', req.user.id);
  if (ban) return res.status(403).json({ error: `You are banned from Reveal${ban.reason ? `: ${ban.reason}` : ''}` });
  const post = await store.get('SELECT * FROM reveal_posts WHERE id=$1 AND deleted_at IS NULL', req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const body = String(req.body.body || '').slice(0, 600);
  if (!body.trim()) return res.status(400).json({ error: 'Write a comment' });
  let parentId = null;
  if (req.body.parentId) {
    const parent = await store.get('SELECT * FROM reveal_comments WHERE id=$1 AND post_id=$2 AND deleted_at IS NULL', req.body.parentId, req.params.id);
    if (!parent) return res.status(404).json({ error: 'Parent comment not found' });
    // Only one level of nesting — grandchild replies become child replies
    parentId = parent.parent_id || parent.id;
  }
  const id = nanoid();
  await store.run('INSERT INTO reveal_comments (id,post_id,author_id,body,parent_id,pinned) VALUES (?,?,?,?,?,0)',
    id, req.params.id, req.user.id, body, parentId);
  const c = await store.get(`SELECT c.*,u.username,u.nickname,u.avatar,u.tag,u.badge
    FROM reveal_comments c JOIN users u ON u.id=c.author_id WHERE c.id=$1`, id);
  const count = Number((await store.get('SELECT COUNT(*) AS c FROM reveal_comments WHERE post_id=$1 AND deleted_at IS NULL', req.params.id))?.c || 0);
  // @mention support: notify each mentioned user (except the author)
  const mentionRe = /@(\w+)/g; let mm;
  while ((mm = mentionRe.exec(body)) !== null) {
    const target = await store.get('SELECT * FROM users WHERE username=$1', mm[1]);
    if (target && target.id !== req.user.id && !target.is_bot) {
      const mentionMsg = `${req.user.nickname || req.user.username} mentioned you in a Reveal comment: ${body.slice(0, 60)}`;
      await createNotification(target.id, 'ping', id, 'comment', mentionMsg);
      io.to(`user:${target.id}`).emit('notification', { type:'ping', message: { body: mentionMsg }, comment: { ...c, id }, postId: req.params.id });
    }
  }
  res.json({ comment: { ...c, replies: [], likes: 0, liked: false }, count });
}));

// Like / unlike a Reveal comment.
app.post('/api/reveal/comments/:id/like', auth, route(async (req,res) => {
  const c = await store.get('SELECT id, author_id, post_id FROM reveal_comments WHERE id=$1 AND deleted_at IS NULL', req.params.id);
  if (!c) return res.status(404).json({ error: 'Comment not found' });
  const already = await store.get('SELECT 1 FROM reveal_comment_likes WHERE comment_id=$1 AND user_id=$2', req.params.id, req.user.id);
  if (!already) {
    await store.run('INSERT INTO reveal_comment_likes (comment_id,user_id) VALUES (?,?) ON CONFLICT DO NOTHING', req.params.id, req.user.id);
    // Notify the comment author when someone likes their comment (not for self-likes).
    if (c.author_id !== req.user.id) {
      const byName = req.user.nickname || req.user.username;
      await createNotification(c.author_id, 'like', req.params.id, 'comment', `${byName} liked your comment on Reveal`);
      io.to(`user:${c.author_id}`).emit('notification', { type:'like', commentId: req.params.id, postId: c.post_id });
    }
  }
  const likes = Number((await store.get('SELECT COUNT(*) AS c FROM reveal_comment_likes WHERE comment_id=$1', req.params.id))?.c || 0);
  res.json({ likes, liked: true });
}));

app.delete('/api/reveal/comments/:id/like', auth, route(async (req,res) => {
  const c = await store.get('SELECT id FROM reveal_comments WHERE id=$1 AND deleted_at IS NULL', req.params.id);
  if (!c) return res.status(404).json({ error: 'Comment not found' });
  await store.run('DELETE FROM reveal_comment_likes WHERE comment_id=$1 AND user_id=$2', req.params.id, req.user.id);
  const likes = Number((await store.get('SELECT COUNT(*) AS c FROM reveal_comment_likes WHERE comment_id=$1', req.params.id))?.c || 0);
  res.json({ likes, liked: false });
}));

app.patch('/api/reveal/comments/:id/pin', auth, route(async (req,res) => {
  const c = await store.get('SELECT * FROM reveal_comments WHERE id=$1', req.params.id);
  if (!c || c.deleted_at) return res.status(404).json({ error: 'Comment not found' });
  const post = await store.get('SELECT author_id FROM reveal_posts WHERE id=$1', c.post_id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.author_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Only the post author can pin comments' });
  const pinned = req.body.pinned ? 1 : 0;
  await store.run('UPDATE reveal_comments SET pinned=$1 WHERE id=$2', pinned, req.params.id);
  res.json({ ok: true, pinned: !!pinned });
}));

app.delete('/api/reveal/comments/:id', auth, route(async (req,res) => {
  const c = await store.get('SELECT * FROM reveal_comments WHERE id=$1', req.params.id);
  if (!c || c.deleted_at) return res.status(404).json({ error: 'Comment not found' });
  const post = await store.get('SELECT author_id FROM reveal_posts WHERE id=$1', c.post_id);
  const isPostAuthor = post && post.author_id === req.user.id;
  if (c.author_id !== req.user.id && !isPostAuthor && !req.user.is_admin) return res.status(403).json({ error: 'Forbidden' });
  await store.run('UPDATE reveal_comments SET deleted_at=CURRENT_TIMESTAMP WHERE id=$1', req.params.id);
  // Also soft-delete replies so threads don't dangle
  await store.run('UPDATE reveal_comments SET deleted_at=CURRENT_TIMESTAMP WHERE parent_id=$1', req.params.id);
  res.json({ ok: true });
}));

// Posting bans (admin)
app.get('/api/reveal/bans', auth, adminOnly, route(async (_req,res) => {
  res.json(await store.all(`SELECT b.*,u.username,u.nickname FROM reveal_bans b JOIN users u ON u.id=b.user_id ORDER BY b.created_at DESC`));
}));
app.post('/api/reveal/bans', auth, adminOnly, route(async (req,res) => {
  const target = await store.get('SELECT * FROM users WHERE id=$1', req.body.userId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (req.body.userId !== req.user.id && !(await canModerateTarget(req.user.id, null, req.body.userId))) {
    return res.status(403).json({ error: 'You cannot ban a user of equal or higher rank.' });
  }
  await store.run('INSERT INTO reveal_bans VALUES (?,?,?,CURRENT_TIMESTAMP) ON CONFLICT (user_id) DO UPDATE SET reason=$2,banned_by=$3',
    target.id, String(req.body.reason || '').slice(0, 200), req.user.id);
  res.json({ ok: true });
}));app.delete('/api/reveal/bans/:userId', auth, adminOnly, route(async (req,res) => {
  await store.run('DELETE FROM reveal_bans WHERE user_id=$1', req.params.userId);
  res.json({ok:true});
}));

// Reveal moderation queue — reported posts with full context
app.get('/api/reveal/moderation', auth, adminOnly, route(async (req,res) => {
  const status = String(req.query.status || 'open');
  const rows = await store.all(`SELECT r.id AS report_id, r.reporter_id, r.reason, r.category, r.status, r.created_at AS reported_at,
      r.message_body AS reported_body,
      p.id AS post_id, p.author_id, p.type, p.body, p.media, p.media_name, p.media_type, p.created_at AS post_created_at,
      pu.username AS post_username, pu.nickname AS post_nickname, pu.avatar AS post_avatar, pu.badge AS post_badge,
      ru.username AS reporter_username, ru.nickname AS reporter_nickname
    FROM reports r
    JOIN reveal_posts p ON p.id = r.target_id AND r.target_type='reveal'
    JOIN users pu ON pu.id = p.author_id
    JOIN users ru ON ru.id = r.reporter_id
    WHERE r.status=$1
    ORDER BY r.created_at DESC LIMIT 100`, status);
  res.json({ reports: rows });
}));

// ── DMs ───────────────────────────────────────────────────────────────────────
app.post('/api/dms', auth, route(async (req,res) => {
  const targetId = req.body.userId;
  if (!targetId || targetId === req.user.id) return res.status(400).json({error:'Invalid user'});
  const target = await store.get('SELECT id FROM users WHERE id=$1 AND banned=0', targetId);
  if (!target) return res.status(404).json({error:'User not found'});
  const existing = await store.get('SELECT * FROM dms WHERE (user_a=$1 AND user_b=$2) OR (user_a=$2 AND user_b=$1)', req.user.id, targetId);
  if (existing) return res.json({dm:existing});
  const id = nanoid();
  await store.run('INSERT INTO dms VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)', id, req.user.id, targetId, null, null);
  const dm = await store.get(`SELECT d.*,ua.username AS user_a_name,ua.tag AS user_a_tag,ua.nickname AS user_a_nick,ua.avatar AS user_a_avatar,ua.status AS user_a_status,ua.badge AS user_a_badge,ub.username AS user_b_name,ub.tag AS user_b_tag,ub.nickname AS user_b_nick,ub.avatar AS user_b_avatar,ub.status AS user_b_status,ub.badge AS user_b_badge FROM dms d JOIN users ua ON ua.id=d.user_a JOIN users ub ON ub.id=d.user_b WHERE d.id=$1`, id);
  io.to(`user:${targetId}`).emit('new_dm', dm);
  res.json({dm});
}));

app.patch('/api/dms/:id/nickname', auth, route(async (req,res) => {
  const dm = await store.get('SELECT * FROM dms WHERE id=$1 AND (user_a=$2 OR user_b=$2)', req.params.id, req.user.id);
  if (!dm) return res.status(403).json({error:'Forbidden'});
  if (dm.user_a === req.user.id) await store.run('UPDATE dms SET nickname_a=$1 WHERE id=$2', req.body.nickname, req.params.id);
  else await store.run('UPDATE dms SET nickname_b=$1 WHERE id=$2', req.body.nickname, req.params.id);
  res.json({ok:true});
}));

// ── Groups ────────────────────────────────────────────────────────────────────
app.post('/api/groups', auth, route(async (req,res) => {
  const id = nanoid();
  await store.run('INSERT INTO groups_chat VALUES (?,?,?,?,CURRENT_TIMESTAMP)', id, req.body.name||'Group Chat', req.user.id, req.body.icon||null);
  await store.run('INSERT INTO group_members VALUES (?,?) ON CONFLICT DO NOTHING', id, req.user.id);
  for (const uid of (req.body.members||[])) {
    if (uid !== req.user.id) await store.run('INSERT INTO group_members VALUES (?,?) ON CONFLICT DO NOTHING', id, uid);
  }
  const group = await store.get('SELECT * FROM groups_chat WHERE id=$1', id);
  const members = await store.all('SELECT user_id FROM group_members WHERE group_id=$1', id);
  for (const m of members) io.to(`user:${m.user_id}`).emit('new_group', group);
  res.json({id});
}));

app.post('/api/groups/:id/members', auth, route(async (req,res) => {
  const g = await store.get('SELECT * FROM groups_chat WHERE id=$1', req.params.id);
  if (!g) return res.status(404).json({error:'Not found'});
  if (g.owner_id !== req.user.id) return res.status(403).json({error:'Forbidden'});
  await store.run('INSERT INTO group_members VALUES (?,?) ON CONFLICT DO NOTHING', req.params.id, req.body.userId);
  res.json({ok:true});
}));

// ── Reports ───────────────────────────────────────────────────────────────────
app.post('/api/reports', auth, route(async (req,res) => {
  const id = nanoid();
  let msgBody = '';
  if (req.body.targetType === 'message' && req.body.targetId) {
    const m = await store.get('SELECT body FROM messages WHERE id=$1', req.body.targetId);
    msgBody = m?.body || '';
  }
  if (req.body.targetType === 'reveal' && req.body.targetId) {
    const p = await store.get('SELECT body FROM reveal_posts WHERE id=$1', req.body.targetId);
    msgBody = p?.body || '';
  }
  await store.run('INSERT INTO reports VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)',
    id, req.user.id, req.body.targetType, req.body.targetId, req.body.reason, req.body.category||'other', msgBody, 'open');
  res.json({id});
}));

// ── Upload ────────────────────────────────────────────────────────────────────
app.post('/api/upload', auth, upload.single('file'), (req,res) => {
  if (!req.file) return res.status(400).json({error:'No file'});
  const allowed = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|ogg|wav))$/i;
  if (!allowed.test(req.file.mimetype)) {
    fs.rmSync(req.file.path, { force: true });
    return res.status(415).json({error:'Unsupported upload type'});
  }
  try {
    // Strip EXIF/GPS/XMP/comments from images before storing (privacy first).
    const original = fs.readFileSync(req.file.path);
    const cleaned = stripImageMetadata(original);
    if (cleaned && cleaned !== original) fs.writeFileSync(req.file.path, cleaned);
  } catch {
    // Keep the file if metadata stripping fails; type and size are still validated.
  }
  const ext = path.extname(req.file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '');
  const newName = `${req.file.filename}${ext}`;
  fs.renameSync(req.file.path, path.join(uploadDir, newName));
  res.json({url:`/uploads/${newName}`, name:req.file.originalname.slice(0,255), type:req.file.mimetype, size:req.file.size});
});

// ── Search ────────────────────────────────────────────────────────────────────
app.get('/api/search', auth, route(async (req,res) => {
  const params = [`%${String(req.query.q||'').replace(/%/g,'')}%`];
  const filters = ['m.body ILIKE $1','m.deleted_at IS NULL'];
  const bookmarksOnly = req.query.bookmarks === 'true';
  let select = `m.*,u.username,u.nickname,u.avatar`;
  let joins = `FROM messages m JOIN users u ON u.id=m.sender_id`;
  if (bookmarksOnly) {
    // Restrict to messages this user bookmarked; expose the folder + when they saved it.
    joins += ` JOIN bookmarks bm ON bm.message_id = m.id AND bm.user_id = $${params.length + 1}`;
    params.push(req.user.id);
    select += `, bm.folder AS bm_folder, bm.created_at AS bm_saved_at`;
    const folder = String(req.query.folder || '').trim();
    if (folder) { params.push(folder); filters.push(`bm.folder=$${params.length}`); }
  }
  // community_id needed for jumping to a bookmarked channel message
  joins += ` LEFT JOIN channels ch ON ch.id = m.channel_id`;
  select += `, ch.community_id`;
  if (req.query.user) { params.push(String(req.query.user)); filters.push(`u.username=$${params.length}`); }
  if (req.query.channelId) { params.push(String(req.query.channelId)); filters.push(`m.channel_id=$${params.length}`); }
  if (req.query.before) { params.push(String(req.query.before)); filters.push(`m.created_at < $${params.length}`); }
  if (req.query.after) { params.push(String(req.query.after)); filters.push(`m.created_at > $${params.length}`); }
  if (req.query.hasAttachment === 'true') filters.push('m.attachment IS NOT NULL');
  res.json(await store.all(`SELECT ${select} ${joins} WHERE ${filters.join(' AND ')} ORDER BY m.created_at DESC LIMIT 100`, ...params));
}));

// ── Notifications ─────────────────────────────────────────────────────────────
app.get('/api/notifications', auth, route(async (req,res) => {
  res.json(await store.all('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', req.user.id));
}));

app.post('/api/notifications/read', auth, route(async (req,res) => {
  if (req.body.id) await store.run('UPDATE notifications SET read=1 WHERE id=$1 AND user_id=$2', req.body.id, req.user.id);
  else await store.run('UPDATE notifications SET read=1 WHERE user_id=$1', req.user.id);
  res.json({ok:true});
}));

// ── Chat Reminders ────────────────────────────────────────────────────────────
// Resolve a friendly "when" to a timestamp: 1h | tomorrow | ISO date/time
function resolveRemindAt(when) {
  if (when === '1h') return new Date(Date.now() + 60*60*1000).toISOString();
  if (when === 'tomorrow') {
    const d = new Date(Date.now() + 24*60*60*1000);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  }
  const custom = new Date(when);
  if (!isNaN(custom.getTime())) return custom.toISOString();
  return null;
}

app.get('/api/reminders', auth, route(async (req,res) => {
  res.json(await store.all('SELECT * FROM reminders WHERE user_id=$1 ORDER BY remind_at ASC LIMIT 100', req.user.id));
}));

app.post('/api/reminders', auth, route(async (req,res) => {
  const msg = await store.get('SELECT * FROM messages WHERE id=$1', req.body.messageId);
  if (!msg) return res.status(404).json({error:'Message not found'});
  if (!(await canAccessResource(req.user, msg))) return res.status(403).json({error:'Forbidden'});
  const remindAt = resolveRemindAt(req.body.when);
  if (!remindAt) return res.status(400).json({error:'Invalid reminder time'});
  const id = nanoid();
  await store.run('INSERT INTO reminders (id,user_id,message_id,channel_id,dm_id,group_id,preview,remind_at) VALUES (?,?,?,?,?,?,?,?)',
    id, req.user.id, msg.id, msg.channel_id||null, msg.dm_id||null, msg.group_id||null,
    String(msg.body||(msg.attachment?'📎 '+msg.attachment_name:'')).slice(0,120), remindAt);
  const rem = await store.get('SELECT * FROM reminders WHERE id=$1', id);
  res.json(rem);
}));

app.delete('/api/reminders/:id', auth, route(async (req,res) => {
  await store.run('DELETE FROM reminders WHERE id=$1 AND user_id=$2', req.params.id, req.user.id);
  res.json({ok:true});
}));

// Fire due reminders: create a notification + push it over the socket
async function fireDueReminders() {
  try {
    const due = await store.all('SELECT id FROM reminders WHERE fired=0 AND remind_at <= CURRENT_TIMESTAMP LIMIT 50');
    for (const reminder of due) {
      // Claim atomically so two app instances cannot deliver the same reminder.
      const claimed = await store.all('UPDATE reminders SET fired=1 WHERE id=$1 AND fired=0 RETURNING *', reminder.id);
      const r = claimed[0];
      if (!r) continue;
      await createNotification(r.user_id, 'reminder', r.id, 'reminder', `⏰ Reminder: "${r.preview}"`);
      io.to(`user:${r.user_id}`).emit('notification', { type:'reminder', reminder:r });
    }
  } catch {}
}
setInterval(fireDueReminders, 30 * 1000);

// ── Events ────────────────────────────────────────────────────────────────────
app.post('/api/events', auth, adminOnly, route(async (req,res) => {
  const id = nanoid();
  await store.run('INSERT INTO events VALUES (?,?,?,?,?,?,?,1,CURRENT_TIMESTAMP)',
    id, req.body.title, req.body.description||'', req.body.starts_at||new Date().toISOString(),
    req.body.ends_at||null, req.user.id, req.body.channelId||null);
  const ev = await store.get('SELECT * FROM events WHERE id=$1', id);
  io.emit('global_event', ev);
  res.json(ev);
}));

app.delete('/api/events/:id', auth, adminOnly, route(async (req,res) => {
  await store.run('UPDATE events SET active=0 WHERE id=$1', req.params.id);
  io.emit('global_event_end', {id:req.params.id});
  res.json({ok:true});
}));

app.get('/api/events', auth, route(async (_req,res) => {
  res.json(await store.all("SELECT * FROM events WHERE active=1 ORDER BY starts_at DESC"));
}));

// ── Daily question ────────────────────────────────────────────────────────────
const DAILY_QUESTIONS = [
  "What's a completely useless skill you're secretly proud of?",
  "If you could add one rule to the internet, what would it be?",
  "What's the most anonymous thing you've ever done?",
  "What app do you use the most but wouldn't admit to?",
  "If the internet disappeared tomorrow, what would you miss the least?",
  "What's a hot take you have about technology?",
  "If your username was your actual name, what would people think of you?",
  "What's the weirdest thing you've searched for lately?",
  "Would you rather lose all your photos or all your contacts?",
  "What's something you've never told anyone online?",
  "What video game world would you actually want to live in?",
  "What's your go-to way to waste time online?",
  "If you could be permanently anonymous online, would you change how you act?",
  "What's the strangest community you've been part of online?",
  "What's something the internet made better? Worse?",
  "If you had to delete all social media except one, which stays?",
  "What's a hill you'll die on in any online argument?",
  "What's the most interesting person you've met online?",
  "What would your 'About Me' say if you had to be 100% honest?",
  "What's a skill you learned entirely from the internet?",
];

app.get('/api/daily-question', auth, (_,res) => {
  const idx = Math.floor(Date.now() / (24*60*60*1000)) % DAILY_QUESTIONS.length;
  res.json({question: DAILY_QUESTIONS[idx]});
});

// ── Blocks ────────────────────────────────────────────────────────────────────
app.post('/api/blocks', auth, route(async (req,res) => {
  await store.run('INSERT INTO blocks VALUES (?,?) ON CONFLICT DO NOTHING', req.user.id, req.body.userId);
  res.json({ok:true});
}));

app.delete('/api/blocks/:id', auth, route(async (req,res) => {
  await store.run('DELETE FROM blocks WHERE blocker_id=$1 AND blocked_id=$2', req.user.id, req.params.id);
  res.json({ok:true});
}));

// ── Credits / Quests / Shop API ──────────────────────────────────────────────
app.get('/api/me/credits', auth, route(async (req,res) => {
  const { credits, active_pet } = await getUserCredits(req.user.id);
  const owner = req.user.id;
  const inventory = await store.all(`SELECT i.*, u.username FROM inventory i JOIN users u ON u.id=i.user_id WHERE i.user_id=$1 ORDER BY i.aquired_at DESC`, owner);
  const gaps = SHOP_ITEMS.filter(p => !inventory.some(i => i.item_id === p.id));
  res.json({ credits, active_pet, inventory, shop: SHOP_ITEMS, ownedIds: SHOP_ITEMS.filter(p => inventory.some(i => i.item_id === p.id)).map(p => p.id) });
}));

app.get('/api/quests', auth, route(async (req,res) => {
  const quests = await computeQuests(req.user.id);
  const { credits } = await getUserCredits(req.user.id);
  const earnedToday = (await store.get('SELECT COALESCE(SUM(reward),0) AS t FROM quest_logs WHERE user_id=$1 AND day=$2', req.user.id, TODAY()))?.t || 0;
  res.json({ quests, credits, cap: DAILY_REWARD_CAP, earnedToday: Number(earnedToday) });
}));

app.post('/api/quests/claim', auth, route(async (req,res) => {
  const quests = await computeQuests(req.user.id);
  const q = quests.find(x => x.id === req.body.questId);
  if (!q) return res.status(404).json({error:'Quest not found'});
  if (!q.done) return res.status(400).json({error:'Quest not complete yet'});
  if (q.claimed) return res.status(409).json({error:'Already claimed today'});
  const earnedToday = Number((await store.get('SELECT COALESCE(SUM(reward),0) AS t FROM quest_logs WHERE user_id=$1 AND day=$2', req.user.id, TODAY()))?.t || 0);
  if (earnedToday + q.reward > DAILY_REWARD_CAP) return res.status(400).json({error:`Daily reward cap reached (${DAILY_REWARD_CAP})`});
  await store.run('INSERT INTO quest_logs (user_id,quest,day,reward) VALUES (?,?,?,?) ON CONFLICT DO NOTHING', req.user.id, q.id, TODAY(), q.reward);
  await addCredits(req.user.id, q.reward);
  const { credits } = await getUserCredits(req.user.id);
  res.json({ ok:true, questId:q.id, reward:q.reward, credits });
}));

// ── Admin quests (paste-to-add) ───────────────────────────────────────────────
// The admin pastes a JSON spec for a quest — title, icon, metric, need, reward.
// The metric is measured from real stored activity (see computeQuests), so a new
// quest works with every surface the app already records and shares the normal
// daily claim/credit pipeline. Scripts are validated specs, never executable code.
const QUEST_METRICS = ['msgs','server','dm','group','rooms','games','friends'];
function sanitizeQuestSpec(input) {
  const spec = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  const title = String(spec.title || '').trim().slice(0, 80);
  const icon = String(spec.icon || '🎯').trim().slice(0, 8) || '🎯';
  const description = String(spec.description || spec.desc || '').trim().slice(0, 200);
  const metric = String(spec.metric || '').trim();
  const need = Number(spec.need);
  const reward = Number(spec.reward);
  if (!title) return { error: 'title is required' };
  if (!QUEST_METRICS.includes(metric)) return { error: `metric must be one of: ${QUEST_METRICS.join(', ')}` };
  if (!Number.isInteger(need) || need < 1 || need > 100000) return { error: 'need must be an integer between 1 and 100000' };
  if (!Number.isInteger(reward) || reward < 1 || reward > DAILY_REWARD_CAP) return { error: `reward must be an integer between 1 and ${DAILY_REWARD_CAP}` };
  const slug = String(spec.id || title).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'quest';
  return { id: slug.startsWith('custom_') ? slug : `custom_${slug}`, title, icon, description, metric, need, reward };
}

app.get('/api/admin/quests', auth, adminOnly, route(async (_req,res) => {
  res.json(await store.all('SELECT * FROM custom_quests ORDER BY created_at'));
}));

app.post('/api/admin/quests', auth, adminOnly, route(async (req,res) => {
  const s = sanitizeQuestSpec(req.body?.spec ?? req.body);
  if (s.error) return res.status(400).json({ error: s.error });
  const existing = await store.get('SELECT 1 FROM custom_quests WHERE id=$1', s.id);
  if (existing) {
    await store.run('UPDATE custom_quests SET title=$1,icon=$2,description=$3,metric=$4,need=$5,reward=$6,spec=$7,active=1 WHERE id=$8',
      s.title, s.icon, s.description, s.metric, s.need, s.reward, JSON.stringify(req.body?.spec ?? req.body), s.id);
  } else {
    await store.run('INSERT INTO custom_quests (id,title,icon,description,metric,need,reward,active,spec,created_by) VALUES (?,?,?,?,?,?,?,1,?,?)',
      s.id, s.title, s.icon, s.description, s.metric, s.need, s.reward, JSON.stringify(req.body?.spec ?? req.body), req.user.id);
  }
  res.json({ ok:true, quest: await store.get('SELECT * FROM custom_quests WHERE id=$1', s.id) });
}));

app.patch('/api/admin/quests/:id', auth, adminOnly, route(async (req,res) => {
  const exists = await store.get('SELECT 1 FROM custom_quests WHERE id=$1', req.params.id);
  if (!exists) return res.status(404).json({ error: 'Quest not found' });
  await store.run('UPDATE custom_quests SET active=$1 WHERE id=$2', req.body.active ? 1 : 0, req.params.id);
  res.json({ ok:true });
}));

app.delete('/api/admin/quests/:id', auth, adminOnly, route(async (req,res) => {
  await store.run('DELETE FROM custom_quests WHERE id=$1', req.params.id);
  res.json({ ok:true });
}));

// ── Daily challenge (🎲 DO SOMETHING RANDOM) ─────────────────────────────────
// One challenge per day, shared by everyone; rolled randomly via the button and
// broadcast live so all clients see it. Counts toward the quest/credit system.
app.get('/api/challenges', auth, route(async (_req,res) => {
  const challenge = await getTodayChallenge();
  res.json({ challenge });
}));

app.post('/api/challenges/roll', auth, route(async (_req,res) => {
  const current = (await getTodayChallenge())?.id;
  const pool = CHALLENGES.filter(c => c.id !== current);
  const ch = (pool.length ? pool : CHALLENGES)[Math.floor(Math.random() * (pool.length ? pool.length : CHALLENGES.length))];
  await store.run('INSERT INTO daily_challenges VALUES (?,?) ON CONFLICT (day) DO UPDATE SET challenge=$2', TODAY(), ch.id);
  const challenge = await getTodayChallenge();
  io.emit('challenge_roll', challenge);
  res.json({ challenge });
}));

// ── Mini games ────────────────────────────────────────────────────────────────
// Clients log a finished game here so the gamer/arcade quests can count plays.
app.post('/api/games/log', auth, route(async (req,res) => {
  const game = String(req.body.game || '').slice(0, 24);
  const result = String(req.body.result || 'played').slice(0, 32);
  if (!game) return res.status(400).json({ error: 'game required' });
  await store.run('INSERT INTO game_logs (id,user_id,game,result,day) VALUES (?,?,?,?,?)', nanoid(), req.user.id, game, result, TODAY());
  const playedToday = Number((await store.get('SELECT COUNT(*) AS c FROM game_logs WHERE user_id=$1 AND day=$2', req.user.id, TODAY()))?.c || 0);
  res.json({ ok:true, playedToday });
}));

app.post('/api/shop/buy', auth, route(async (req,res) => {
  const item = petById(req.body.itemId);
  if (!item) return res.status(404).json({error:'Item not found'});
  const { credits } = await getUserCredits(req.user.id);
  const owned = await store.get('SELECT 1 FROM inventory WHERE user_id=$1 AND item_id=$2', req.user.id, item.id);
  if (owned) return res.status(409).json({error:'You already own this pet'});
  if (credits < item.price) return res.status(400).json({error:'Not enough credits'});
  await addCredits(req.user.id, -item.price);
  await store.run('INSERT INTO inventory (id,user_id,item_id,name) VALUES (?,?,?,?)', nanoid(), req.user.id, item.id, item.name);
  const after = await getUserCredits(req.user.id);
  res.json({ ok:true, ...after });
}));

app.patch('/api/me/pet', auth, route(async (req,res) => {
  if (req.body.itemId === null || req.body.itemId === undefined) {
    await store.run("UPDATE users SET active_pet=null WHERE id=$1", req.user.id);
    return res.json({ ok:true, active_pet:null });
  }
  const owned = await store.get('SELECT * FROM inventory WHERE user_id=$1 AND item_id=$2', req.user.id, req.body.itemId);
  if (!owned) return res.status(404).json({error:'You do not own this pet'});
  const name = req.body.name ? String(req.body.name).slice(0,20) : owned.name;
  if (name !== owned.name) await store.run('UPDATE inventory SET name=$1 WHERE id=$2', name, owned.id);
  await store.run('UPDATE users SET active_pet=$1 WHERE id=$2', req.body.itemId, req.user.id);
  const u = publicUser(await store.get('SELECT * FROM users WHERE id=$1', req.user.id));
  io.emit('user_update', u);
  res.json({ ok:true, active_pet:req.body.itemId, name });
}));

app.post('/api/credits/gift', auth, route(async (req,res) => {
  const amount = Math.floor(Number(req.body.amount)||0);
  if (amount < 1) return res.status(400).json({error:'Enter an amount to gift'});
  const target = await store.get('SELECT * FROM users WHERE username=$1', req.body.to);
  if (!target) return res.status(404).json({error:'User not found'});
  if (target.id === req.user.id) return res.status(400).json({error:'You cannot gift yourself'});
  const sentToday = (await store.get("SELECT COUNT(*) AS c FROM gift_logs WHERE from_id=$1 AND day=$2", req.user.id, TODAY()))?.c || 0;
  if (sentToday >= DAILY_GIFT_LIMIT) return res.status(400).json({error:`Daily gift limit reached (${DAILY_GIFT_LIMIT})`});
  const { credits } = await getUserCredits(req.user.id);
  if (credits < amount) return res.status(400).json({error:'Not enough credits'});
  await addCredits(req.user.id, -amount);
  await addCredits(target.id, amount);
  const id = nanoid();
  await store.run('INSERT INTO gift_logs VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)', id, req.user.id, target.id, amount, TODAY());
  await createNotification(target.id,'gift',req.user.id,'user',`${req.user.username} gifted you ${amount} credits 🎁`);
  io.to(`user:${target.id}`).emit('notification',{type:'gift'});
  res.json({ ok:true, credits:credits-amount, sentToday:sentToday+1 });
}));

app.get('/api/shop', auth, route(async (_req,res) => {
  res.json(SHOP_ITEMS);
}));

// ── Announcements ─────────────────────────────────────────────────────────────
app.get('/api/announcement', auth, route(async (_req,res) => {
  const a = await store.get("SELECT * FROM announcements WHERE active=1 ORDER BY created_at DESC LIMIT 1");
  res.json({ announcement: a || null });
}));

app.post('/api/admin/announcement', auth, adminOnly, route(async (req,res) => {
  const title = String(req.body.title||'').slice(0,80);
  const body = String(req.body.body||'').slice(0,400);
  if (!body) return res.status(400).json({error:'Announcement message required'});
  const id = nanoid();
  await store.run("UPDATE announcements SET active=0 WHERE active=1");
  await store.run('INSERT INTO announcements VALUES (?,?,?,?,1,CURRENT_TIMESTAMP)', id, title, body, req.user.id);
  const a = await store.get('SELECT * FROM announcements WHERE id=$1', id);
  io.emit('global_announcement', a);
  res.json({ announcement: a });
}));

app.delete('/api/admin/announcement', auth, adminOnly, route(async (_req,res) => {
  await store.run('UPDATE announcements SET active=0 WHERE active=1');
  io.emit('global_announcement', null);
  res.json({ ok:true });
}));

// ── Admin ─────────────────────────────────────────────────────────────────────
app.get('/api/admin/users', auth, adminOnly, route(async (_,res) => {
  res.json(await store.all('SELECT *,created_at FROM users ORDER BY created_at DESC'));
}));

app.get('/api/admin/staff-ranks', auth, adminOnly, route(async (req,res) => {
  const actor = await store.get('SELECT id,rank,is_admin FROM users WHERE id=$1', req.user.id);
  const actorLevel = STAFF_RANK_LEVELS[actor?.rank] || 0;
  res.json({ ranks: STAFF_RANKS.map(rank => ({ rank, level: STAFF_RANK_LEVELS[rank], assignable: actorLevel >= STAFF_RANK_LEVELS[rank] && (actor.rank === 'Founder' || STAFF_RANK_LEVELS[rank] < actorLevel) })) });
}));

// Rank catalog for the rank editor: what the current staff tier may assign.
app.get('/api/admin/rank-catalog', auth, adminOnly, route(async (req,res) => {
  const actorLv = STAFF_RANK_LEVELS[req.user.rank];
  res.json({
    actorRank: req.user.rank,
    actorTier: actorLv || 0,
    assignable: assignableRanksFor(req.user),
    allMemberRanks: MEMBER_RANKS,
    allStaffRanks: STAFF_RANKS,
    staffLevels: STAFF_RANK_LEVELS,
  });
}));

app.post('/api/admin/create-admin', auth, adminOnly, route(async (req,res) => {
  const username = (req.body.username||'').replace(/[^\w-]/g,'').slice(0,24);
  const password = req.body.password||nanoid(14);
  if (!username) return res.status(400).json({error:'Username required'});
  const user = await createUser(username, req.body.tag||Math.floor(1000+Math.random()*9000).toString(), password);
  await store.run('UPDATE users SET is_admin=1,nickname=$1 WHERE id=$2', req.body.nickname||`${username} Admin`, user.id);
  res.json({user:publicUser(await store.get('SELECT * FROM users WHERE id=$1', user.id)), temporaryPassword:password});
}));

const MEMBER_RANKS = ['New','Beginner','Starter','Member','Trusted','Community','Celebrity','Known'];
// Staff ranks ordered low->high. A staff tier may assign any rank BELOW itself:
// e.g. Manager can hand out everything through 'Head admin' but not Manager+
// (unless they are the very Founder, who may assign the full tree).
const STAFF_RANKS = ['Mod','Sr. Mod','Jr. admin','admin','Dev','Head Mod','Head admin','Manager','Administrator','Owner','Founder'];
const STAFF_RANK_LEVELS = { 'Mod':1,'Sr. Mod':2,'Jr. admin':3,admin:4,Dev:5,'Head Mod':6,'Head admin':7,Manager:8,Administrator:9,Owner:10,Founder:11 };
// Everything the given actor is allowed to assign, ordered. Any staff rank below the
// actor's own; Final founder sees the whole tree above members.
function assignableRanksFor(actor) {
  const actorLv = STAFF_RANK_LEVELS[actor?.rank];
  if (!actorLv) return { member: [], staff: [] };
  const assignableStaff = actorLv >= STAFF_RANK_LEVELS.Founder
    ? STAFF_RANKS.slice()
    : STAFF_RANKS.filter(r => STAFF_RANK_LEVELS[r] < actorLv);
  return { member: MEMBER_RANKS.slice(), staff: assignableStaff };
}
function canAssignRank(actor, newRank) {
  // Founder may assign any rank; everyone else only strictly below their own tier.
  if (STAFF_RANK_LEVELS[actor?.rank] >= STAFF_RANK_LEVELS.Founder) return true;
  if (STAFF_RANK_LEVELS[newRank] != null) {
    return STAFF_RANK_LEVELS[newRank] < (STAFF_RANK_LEVELS[actor?.rank] || 0);
  }
  return true; // member ranks are assignable by any staff
}
// Legal-history access: top-level privileged accounts only (Owner + above).
function legalHistoryAllowed(user) {
  return user?.is_admin && ['Founder','Owner','Administrator'].includes(user.rank);
}
async function logLegalHistoryAttempt(req, outcome, detail = {}) {
  try {
    await store.run('INSERT INTO moderation_logs VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)', nanoid(), req.user?.id || 'anonymous', `legal_history_${outcome}`, req.query?.userId || detail.targetId || '', JSON.stringify({
      path:req.originalUrl, method:req.method, ip:req.ip || '', userAgent:req.get?.('user-agent') || '', ...detail
    }));
  } catch {}
}
function legalHistoryOnly(req, res, next) {
  if (!legalHistoryAllowed(req.user)) {
    logLegalHistoryAttempt(req, 'denied', { reason:'insufficient_privilege', rank:req.user?.rank || null, isAdmin:Boolean(req.user?.is_admin) });
    return res.status(403).json({ error: 'Founder/Owner only — legal history is restricted.' });
  }
  next();
}

app.patch('/api/admin/users/:id', auth, adminOnly, route(async (req,res) => {
  const {isAdmin,banned,badge,rank} = req.body;
  const rankList = [...MEMBER_RANKS, ...STAFF_RANKS];
  const newRank = rank != null && rankList.includes(rank) ? rank : null;
  if (newRank && STAFF_RANK_LEVELS[newRank] != null && !req.user.rank) return res.status(403).json({error:'Only platform staff may assign staff ranks.'});
  // An admin cannot modify a user of equal or higher rank (founders/owners immune).
  if (req.params.id !== req.user.id && !(await canModerateTarget(req.user.id, null, req.params.id))) {
    return res.status(403).json({error:'You cannot modify a user of equal or higher rank.'});
  }
  // Hierarchy: founder may assign anything; everyone else only strictly below their tier.
  if (newRank && newRank !== req.user.rank && !canAssignRank(req.user, newRank)) {
    return res.status(403).json({error:'You may only assign ranks below your own tier.'});
  }
  const sql = 'UPDATE users SET is_admin=$1,banned=$2,badge=$3' + (newRank ? ',rank=$5' : '') + ' WHERE id=$4';
  const args = newRank ? [isAdmin?1:0, banned?1:0, badge||'', req.params.id, newRank] : [isAdmin?1:0, banned?1:0, badge||'', req.params.id];
  await store.run(sql, ...args);
  await store.run('INSERT INTO moderation_logs VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)', nanoid(),req.user.id,banned?'ban':'update',req.params.id,JSON.stringify({isAdmin,banned,badge,rank:newRank}));
  const u = publicUser(await store.get('SELECT * FROM users WHERE id=$1', req.params.id));
  io.emit('user_update', u);
  res.json({ok:true, user:u});
}));

// ── Legal history (Founder/Owner only) — raw, unmodified, undeleted ────────────
// Builds a forensic record of everything a single user posted across every surface
// (channel/DM/group/thread messages, edits, reactions, room messages, Reveal posts
// & comments), intended for legal requests. Rows keep deleted_at so deletions are
// still visible; nothing is redacted or overwritten here.
function historySurfaceLabel(kind, c, d, g) {
  if (kind === 'channel') return c ? `#${c.name} (server)` : 'channel';
  if (kind === 'dm') return 'DM';
  if (kind === 'group') return g ? `group:${g.name}` : 'group chat';
  return kind;
}
// Collect every surface record a user has left across the platform (legal history
// + the data-request reviewer). Deletions are shown, never hidden.
async function fetchDataSurfaces(uid) {
  const chanMsgs = await store.all(`SELECT m.*, c.name AS channel_name, c.id AS cid, c.community_id, cm.name AS comm_name,
      u2.username AS sender_name, u2.nickname AS sender_nick
    FROM messages m
    JOIN channels c ON c.id = m.channel_id
    JOIN users u2 ON u2.id = m.sender_id
    LEFT JOIN communities cm ON cm.id = c.community_id
    WHERE m.sender_id = $1 ORDER BY m.created_at DESC LIMIT 1000`, uid);
  const dmRows = await store.all(`SELECT id FROM dms WHERE user_a=$1 OR user_b=$1`, uid);
  const dmIds = dmRows.map(r=>r.id);
  let dmMsgs = [];
  if (dmIds.length) {
    dmMsgs = await store.all(`SELECT m.*, ua.username AS a_name, ua.id AS a_id, ub.username AS b_name, ub.id AS b_id,
        u2.username AS sender_name, u2.nickname AS sender_nick
      FROM messages m
      JOIN dms d ON d.id = m.dm_id
      JOIN users ua ON ua.id = d.user_a
      JOIN users ub ON ub.id = d.user_b
      JOIN users u2 ON u2.id = m.sender_id
      WHERE m.dm_id = ANY($1::text[]) AND (m.sender_id = $2 OR d.user_a = $2 OR d.user_b = $2)
      ORDER BY m.created_at DESC LIMIT 2000`, dmIds, uid);
  }
  const grpRows = await store.all(`SELECT g.id,g.name FROM group_members gm JOIN groups_chat g ON g.id=gm.group_id WHERE gm.user_id=$1`, uid);
  const grpIds = grpRows.map(r=>r.id);
  let grpMsgs = [];
  if (grpIds.length) {
    grpMsgs = await store.all(`SELECT m.*, g.name AS group_name, u2.username AS sender_name, u2.nickname AS sender_nick
      FROM messages m JOIN groups_chat g ON g.id=m.group_id JOIN users u2 ON u2.id=m.sender_id
      WHERE m.group_id = ANY($1::text[]) ORDER BY m.created_at DESC LIMIT 2000`, grpIds);
  }
  const edits = await store.all(`SELECT me.*, m.channel_id, m.dm_id, m.group_id FROM message_edits me JOIN messages m ON m.id=me.message_id WHERE m.sender_id=$1 ORDER BY me.edited_at DESC LIMIT 500`, uid);
  const reactions = await store.all(`SELECT r.*, m.body AS msg_body FROM reactions r JOIN messages m ON m.id=r.message_id WHERE r.user_id=$1 ORDER BY m.created_at DESC LIMIT 500`, uid);
  const roomMsgs = await store.all(`SELECT rm.*, r.type AS room_type, r.name AS room_name, u2.username AS sender_name FROM room_messages rm
    JOIN temp_rooms r ON r.id=rm.room_id JOIN users u2 ON u2.id=rm.sender_id
    WHERE rm.sender_id=$1 ORDER BY rm.created_at DESC LIMIT 500`, uid);
  const revealPosts = await store.all(`SELECT p.*, p.deleted_at AS post_deleted_at FROM reveal_posts p WHERE p.author_id=$1 ORDER BY p.created_at DESC LIMIT 500`, uid);
  const revealComments = await store.all(`SELECT c.* FROM reveal_comments c WHERE c.author_id=$1 ORDER BY c.created_at DESC LIMIT 500`, uid);
  return {
    channel: chanMsgs.map(m => ({ id:m.id, surface:historySurfaceLabel('channel', m), channelName:m.channel_name, communityName:m.comm_name, sender:m.sender_nick||m.sender_name, body:m.body, attachment:m.attachment, attachmentName:m.attachment_name, attachmentType:m.attachment_type, replyTo:m.reply_to, pixel:m.anonymous_reply?'1':'0', editedAt:m.edited_at, deletedAt:m.deleted_at, createdAt:m.created_at })),
    dm: dmMsgs.map(m => ({ id:m.id, dmId:m.dm_id, participantA:{id:m.a_id,name:m.a_name}, participantB:{id:m.b_id,name:m.b_name}, sender:m.sender_nick||m.sender_name, body:m.body, attachment:m.attachment, attachmentName:m.attachment_name, attachmentType:m.attachment_type, editedAt:m.edited_at, deletedAt:m.deleted_at, createdAt:m.created_at })),
    group: grpMsgs.map(m => ({ id:m.id, groupId:m.group_id, groupName:m.group_name, sender:m.sender_nick||m.sender_name, body:m.body, attachment:m.attachment, editedAt:m.edited_at, deletedAt:m.deleted_at, createdAt:m.created_at })),
    edits,
    reactions: reactions.map(r => ({ userId:r.user_id, emoji:r.emoji, messageBody:r.msg_body })),
    rooms: roomMsgs.map(m => ({ id:m.id, roomType:m.room_type, sender:m.sender_name, body:m.body, createdAt:m.created_at })),
    revealPosts: revealPosts.map(p => ({ id:p.id, type:p.type, body:p.body, media:p.media, mediaName:p.media_name, quiz:p.quiz, deletedAt:p.post_deleted_at, createdAt:p.created_at })),
    revealComments: revealComments.map(c => ({ id:c.id, postId:c.post_id, body:c.body, parentId:c.parent_id, deletedAt:c.deleted_at, createdAt:c.created_at })),
  };
}

app.get('/api/owner/history', auth, async (req,res,next) => {
  if (!legalHistoryAllowed(req.user)) {
    await logLegalHistoryAttempt(req, 'denied', { reason:'insufficient_privilege', rank:req.user?.rank || null, isAdmin:Boolean(req.user?.is_admin) });
    return res.status(403).json({ error: 'Founder/Owner only — legal history is restricted.' });
  }
  next();
}, route(async (req,res) => {
  const uid = req.query.userId;
  if (!uid) return res.status(400).json({error:'userId required'});
  const target = publicUser(await store.get('SELECT * FROM users WHERE id=$1', uid));
  if (!target) return res.status(404).json({error:'User not found'});
  const surfaces = await fetchDataSurfaces(uid);
  await store.run('INSERT INTO moderation_logs VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)', nanoid(), req.user.id, 'legal_history_view', uid, JSON.stringify({
    target: target.username,
    channel: surfaces.channel.length, dm: surfaces.dm.length, group: surfaces.group.length,
    edits: surfaces.edits.length, reactions: surfaces.reactions.length, rooms: surfaces.rooms.length,
    revealPosts: surfaces.revealPosts.length, revealComments: surfaces.revealComments.length,
    at: new Date().toISOString()
  }));
  const actorName = req.user.nickname || req.user.username || 'A privileged user';
  const founders = await store.all("SELECT id FROM users WHERE is_admin=1 AND rank='Founder' AND id<>$1", req.user.id);
  for (const founder of founders) {
    await createNotification(founder.id, 'legal_history_access', req.user.id, 'legal_history', `${actorName} pulled legal history for ${target.username}`);
    io.to(`user:${founder.id}`).emit('legal_history_access', { actorId:req.user.id, actorName, targetId:uid, targetName:target.username, at:new Date().toISOString() });
  }
  res.json({ user: target, generated: new Date().toISOString(), surfaces });
}));

// ── Legitimate data-request reviewer ─────────────────────────────────────────
// A user may request another account's data. The target owner is notified, reviews
// exactly which record groups to share, and approves the precise subset.
app.get('/api/data-requests/incoming', auth, route(async (req,res) => {
  const rows = await store.all('SELECT * FROM data_requests WHERE target_id=$1 ORDER BY created_at DESC LIMIT 100', req.user.id);
  const out = [];
  for (const r of rows) {
    const reqr = await store.get('SELECT username, nickname FROM users WHERE id=$1', r.requester_id);
    out.push({ id:r.id, status:r.status, reason:r.reason, note:r.note||'', createdAt:r.created_at, respondedAt:r.responded_at||null,
      requester: reqr ? (reqr.nickname||reqr.username) : 'unknown', requesterId:r.requester_id });
  }
  res.json(out);
}));

app.get('/api/data-requests/outgoing', auth, route(async (req,res) => {
  const rows = await store.all('SELECT * FROM data_requests WHERE requester_id=$1 ORDER BY created_at DESC LIMIT 100', req.user.id);
  const out = [];
  for (const r of rows) {
    const tg = await store.get('SELECT username, nickname FROM users WHERE id=$1', r.target_id);
    out.push({ id:r.id, status:r.status, reason:r.reason, note:r.note||'', approvedSurfaces:safeParse(r.approved_surfaces,[]), createdAt:r.created_at, respondedAt:r.responded_at||null,
      target: tg ? (tg.nickname||tg.username) : 'unknown', targetId:r.target_id });
  }
  res.json(out);
}));

app.get('/api/data-requests/:id', auth, route(async (req,res) => {
  const r = await store.get('SELECT * FROM data_requests WHERE id=$1', req.params.id);
  if (!r) return res.status(404).json({error:'Request not found'});
  const requester = r.requester_id === req.user.id;
  const isTarget = r.target_id === req.user.id;
  if (!requester && !isTarget) return res.status(403).json({error:'Forbidden'});
  res.json({
    id:r.id, status:r.status, reason:r.reason, note:r.note||'', approvedSurfaces:safeParse(r.approved_surfaces,[]),
    createdAt:r.created_at, respondedAt:r.responded_at||null,
    pendingData: (isTarget && r.status==='pending') ? safeParse(r.data, null) : null,
    sharedData: (requester && r.status==='approved') ? safeParse(r.data, null) : null,
  });
}));

app.post('/api/data-requests', auth, route(async (req,res) => {
  const targetId = req.body.targetId;
  const reason = String(req.body.reason || '').trim().slice(0,1000);
  if (!targetId) return res.status(400).json({error:'targetId required'});
  if (targetId === req.user.id) return res.status(400).json({error:'You cannot request your own data'});
  const target = await store.get('SELECT * FROM users WHERE id=$1', targetId);
  if (!target) return res.status(404).json({error:'User not found'});
  if (target.is_bot) return res.status(400).json({error:'Bots do not hold personal data'});
  if (!reason) return res.status(400).json({error:'Please explain why you need this data (legal/investigative reason)'});
  const existing = await store.get("SELECT * FROM data_requests WHERE requester_id=$1 AND target_id=$2 AND status='pending'", req.user.id, targetId);
  if (existing) return res.status(409).json({error:'You already have a pending request for this user'});
  const id = nanoid();
  const surfaces = await fetchDataSurfaces(targetId);
  await store.run('INSERT INTO data_requests (id,requester_id,target_id,reason,status,created_at,data) VALUES (?,?,?,?,?,CURRENT_TIMESTAMP,?)',
    id, req.user.id, targetId, reason, 'pending', JSON.stringify(surfaces));
  await store.run('INSERT INTO moderation_logs VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)', nanoid(), req.user.id, 'data_request_submit', targetId, JSON.stringify({reason}));
  await notifyDataRequest(targetId, 'data_request', id, (req.user.username || req.user.nickname) + ' submitted a data request for your account');
  res.json({ ok:true, id });
}));

app.post('/api/data-requests/:id/approve', auth, route(async (req,res) => {
  const r = await store.get('SELECT * FROM data_requests WHERE id=$1', req.params.id);
  if (!r) return res.status(404).json({error:'Request not found'});
  if (r.target_id !== req.user.id) return res.status(403).json({error:'Only the account owner can approve'});
  const approved = Array.isArray(req.body.approvedSurfaces) ? req.body.approvedSurfaces.filter(k=>typeof k==='string') : [];
  const requestedRedactions = req.body.redactions && typeof req.body.redactions === 'object' ? req.body.redactions : {};
  const redactions = Object.fromEntries(Object.entries(requestedRedactions).filter(([k,v])=>approved.includes(k) && Array.isArray(v)).map(([k,v])=>[k,[...new Set(v.map(Number).filter(Number.isInteger).filter(i=>i>=0))]]));
  const note = String(req.body.note || '').trim().slice(0,500);
  const data = safeParse(r.data, {});
  const shared = {};
  for (const key of approved) if (data[key]) shared[key] = data[key].filter((_, i) => !(redactions[key]||[]).includes(i));
  await store.run("UPDATE data_requests SET status='approved', approved_surfaces=?, note=?, responded_at=CURRENT_TIMESTAMP, data=? WHERE id=?",
    JSON.stringify(approved), note, JSON.stringify(shared), req.params.id);
  await store.run('INSERT INTO moderation_logs VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)', nanoid(), req.user.id, 'data_request_approved', r.requester_id,
    JSON.stringify({approved, redactions, surfaceCounts:Object.fromEntries(Object.entries(shared).map(([k,v])=>[k,(v&&v.length)||0]))}));
  await notifyDataRequest(r.requester_id, 'data_approved', r.id, 'Your data request was approved — ' + Object.keys(shared).length + ' record group(s) shared');
  res.json({ ok:true, approvedSurfaceCount: Object.keys(shared).length });
}));

app.post('/api/data-requests/:id/deny', auth, route(async (req,res) => {
  const r = await store.get('SELECT * FROM data_requests WHERE id=$1', req.params.id);
  if (!r) return res.status(404).json({error:'Request not found'});
  if (r.target_id !== req.user.id) return res.status(403).json({error:'Only the account owner can deny'});
  const note = String(req.body.note || r.note || 'Declined by the account owner').trim().slice(0,500);
  await store.run("UPDATE data_requests SET status='denied', note=?, responded_at=CURRENT_TIMESTAMP WHERE id=?", note, req.params.id);
  await store.run('INSERT INTO moderation_logs VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)', nanoid(), req.user.id, 'data_request_denied', r.requester_id, note);
  await notifyDataRequest(r.requester_id, 'data_denied', r.id, 'Your data request was declined');
  res.json({ ok:true });
}));

app.post('/api/admin/users/:id/reset-password', auth, adminOnly, route(async (req,res) => {
  const newPass = req.body.newPassword || nanoid(12);
  await store.run('UPDATE users SET password_hash=$1 WHERE id=$2', bcrypt.hashSync(newPass,10), req.params.id);
  await sessions.revokeUser(req.params.id);
  await store.run('INSERT INTO moderation_logs VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)', nanoid(),req.user.id,'reset_password',req.params.id,'');
  res.json({ok:true, temporaryPassword:newPass});
}));

app.get('/api/admin/reports', auth, adminOnly, route(async (_,res) => {
  res.json(await store.all(`SELECT r.*,u.username,u.tag FROM reports r JOIN users u ON u.id=r.reporter_id ORDER BY r.created_at DESC LIMIT 200`));
}));

app.get('/api/admin/reports/:id/message', auth, adminOnly, route(async (req,res) => {
  const report = await store.get('SELECT * FROM reports WHERE id=$1', req.params.id);
  let msg = null;
  if (report?.target_type === 'message') {
    msg = await store.get(`SELECT m.*,u.username,u.tag FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=$1`, report.target_id);
  }
  res.json({report, message:msg});
}));

app.patch('/api/admin/reports/:id', auth, adminOnly, route(async (req,res) => {
  await store.run('UPDATE reports SET status=$1 WHERE id=$2', req.body.status||'resolved', req.params.id);
  res.json({ok:true});
}));

app.delete('/api/admin/messages/:id', auth, adminOnly, route(async (req,res) => {
  const msg = await store.get('SELECT * FROM messages WHERE id=$1', req.params.id);
  if (!msg) return res.status(404).json({error:'Not found'});
  if (msg.sender_id !== req.user.id && !(await canModerateTarget(req.user.id, null, msg.sender_id))) {
    return res.status(403).json({error:'You cannot delete a message from a user of equal or higher rank.'});
  }
  await store.run('DELETE FROM messages WHERE id=$1', req.params.id);
  await store.run('DELETE FROM reactions WHERE message_id=$1', req.params.id);
  await store.run('INSERT INTO moderation_logs VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)', nanoid(),req.user.id,'hard_delete',req.params.id,'');
  if (msg.channel_id) io.to(msg.channel_id).emit('message_delete',{id:req.params.id,channelId:msg.channel_id});
  if (msg.dm_id) io.to(`dm:${msg.dm_id}`).emit('message_delete',{id:req.params.id,dmId:msg.dm_id});
  res.json({ok:true});
}));

app.get('/api/admin/stats', auth, adminOnly, route(async (_,res) => {
  const users = (await store.get('SELECT COUNT(*) AS c FROM users')).c;
  const messages = (await store.get('SELECT COUNT(*) AS c FROM messages')).c;
  const reports = (await store.get("SELECT COUNT(*) AS c FROM reports WHERE status='open'")).c;
  const communities = (await store.get('SELECT COUNT(*) AS c FROM communities')).c;
  const bots = (await store.get('SELECT COUNT(*) AS c FROM users WHERE is_bot=1')).c;
  res.json({users,messages,reports,communities,bots});
}));

app.get('/api/admin/logs', auth, adminOnly, route(async (_,res) => {
  // Dev/staging sample rows are clearly labled with a `dev_` action prefix and are
  // stripped out entirely in production, so they can never appear on real accounts.
  const devClause = IS_DEV ? '' : " AND l.action NOT LIKE 'dev_%'";
  res.json(await store.all(`SELECT l.*,u.username FROM moderation_logs l JOIN users u ON u.id=l.actor_id WHERE 1=1${devClause} ORDER BY l.created_at DESC LIMIT 300`));
}));

// Generate clearly-labeled fake sample logs for development/staging UI testing.
// Gated to dev servers; refuses to run in production. Rows use a dev_ action prefix
// so they are filtered from real accounts and can be cleared in one call.
app.post('/api/dev/fake-logs', auth, adminOnly, route(async (req,res) => {
  if (!IS_DEV) return res.status(403).json({error:'Fake logs are only available on development/staging builds.'});
  const count = Math.min(Math.max(Number(req.body.count) || 10, 1), 40);
  const samples = [
    ['dev_warn_user','warned a member for spamming', 'User report'],
    ['dev_ban_user','issued a 7-day ban', 'Spam'],
    ['dev_delete_msg','deleted a message in #general', 'Rule violation'],
    ['dev_promote','promoted a member to Moderator', 'Staff action'],
    ['dev_timeout','timed out a member for 10 minutes', 'Harassment'],
    ['dev_nuke','nuked a channel after raid', 'Raid cleanup'],
    ['dev_legal','opened legal history for a member', 'Legal request'],
    ['dev_shop','awarded a shop cosmetic', 'Cosmetic grant'],
    ['dev_reset_pass','reset a member password', 'Account recovery'],
    ['dev_role','created a role', 'Server setup'],
    ['dev_poll','created a poll', 'Community'],
    ['dev_reveal','removed a Reveal post', 'Moderation'],
  ];
  for (let i = 0; i < count; i++) {
    const [action, label, cate] = samples[Math.floor(Math.random() * samples.length)];
    const detail = JSON.stringify({ fake:true, dev:true, label, category: cate, sample: (i+1), generatedAt:new Date().toISOString() });
    await store.run('INSERT INTO moderation_logs VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)', nanoid(), req.user.id, action, nanoid(), detail);
  }
  res.json({ ok:true, added:count, total: (await store.get("SELECT COUNT(*) AS c FROM moderation_logs WHERE action LIKE 'dev_%'"))?.c || 0 });
}));

app.delete('/api/dev/fake-logs', auth, adminOnly, route(async (_,res) => {
  if (!IS_DEV) return res.status(403).json({error:'Fake logs are only available on development/staging builds.'});
  await store.run("DELETE FROM moderation_logs WHERE action LIKE 'dev_%'");
  res.json({ ok:true, cleared:true });
}));

app.post('/api/admin/users/:id/notes', auth, adminOnly, route(async (req,res) => {
  const id = nanoid();
  await store.run('INSERT INTO mod_notes VALUES (?,?,?,?,CURRENT_TIMESTAMP)', id, req.user.id, req.params.id, req.body.note);
  res.json({id});
}));

app.get('/api/admin/users/:id/notes', auth, adminOnly, route(async (req,res) => {
  res.json(await store.all(`SELECT n.*,u.username AS actor FROM mod_notes n JOIN users u ON u.id=n.actor_id WHERE n.target_user_id=$1 ORDER BY n.created_at DESC`, req.params.id));
}));

// ── Bots ──────────────────────────────────────────────────────────────────────
app.post('/api/bots/create', auth, adminOnly, route(async (req,res) => {
  const username = (req.body.username||'').replace(/[^\w-]/g,'').slice(0,24);
  if (!username) return res.status(400).json({error:'Username required'});
  const id = nanoid(); const botToken = nanoid(32);
  await store.run('INSERT INTO users (id,username,tag,password_hash,nickname,is_bot,bot_token) VALUES (?,?,?,?,?,1,?)',
    id, username, 'bot', bcrypt.hashSync(nanoid(16),10), req.body.nickname||username, botToken);
  await store.run('INSERT INTO user_settings (user_id) VALUES (?) ON CONFLICT DO NOTHING', id);
  res.json({id, botToken, username});
}));

app.get('/api/bots', auth, adminOnly, route(async (_,res) => {
  res.json(await store.all('SELECT id,username,tag,nickname,avatar,is_bot,bot_token FROM users WHERE is_bot=1'));
}));

app.post('/api/bots/:id/commands', auth, route(async (req,res) => {
  const bot = await store.get('SELECT * FROM users WHERE id=$1', req.params.id);
  if (!bot?.is_bot) return res.status(404).json({error:'Bot not found'});
  if (!req.user.is_admin && req.user.id !== req.params.id) return res.status(403).json({error:'Forbidden'});
  const command = String(req.body.command||'').trim().slice(0,32).toLowerCase();
  if (!command) return res.status(400).json({error:'Command name required'});
  const id = nanoid();
  await store.run('INSERT INTO bot_commands (id,bot_id,command,description,response,community_id,created_at) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)',
    id, req.params.id, command, req.body.description||'', req.body.response||'', req.body.communityId||null);
  res.json({id});
}));

app.get('/api/bots/:id/commands', auth, route(async (req,res) => {
  const bot = await store.get('SELECT * FROM users WHERE id=$1', req.params.id);
  if (!bot?.is_bot) return res.status(404).json({error:'Bot not found'});
  if (!req.user.is_admin && req.user.id !== req.params.id) return res.status(403).json({error:'Forbidden'});
  res.json(await store.all('SELECT * FROM bot_commands WHERE bot_id=$1 ORDER BY created_at DESC', req.params.id));
}));

app.delete('/api/bots/:id/commands/:cmdId', auth, route(async (req,res) => {
  const bot = await store.get('SELECT * FROM users WHERE id=$1', req.params.id);
  if (!bot?.is_bot) return res.status(404).json({error:'Bot not found'});
  if (!req.user.is_admin && req.user.id !== req.params.id) return res.status(403).json({error:'Forbidden'});
  await store.run('DELETE FROM bot_commands WHERE id=$1 AND bot_id=$2', req.params.cmdId, req.params.id);
  res.json({ok:true});
}));

app.patch('/api/bots/:id', auth, route(async (req,res) => {
  const bot = await store.get('SELECT * FROM users WHERE id=$1', req.params.id);
  if (!bot?.is_bot) return res.status(404).json({error:'Bot not found'});
  if (!req.user.is_admin && req.user.id !== req.params.id) return res.status(403).json({error:'Forbidden'});
  await store.run('UPDATE users SET nickname=$1,avatar=$2 WHERE id=$3', (req.body.nickname||bot.nickname||bot.username).slice(0,40), req.body.avatar||bot.avatar||null, bot.id);
  res.json({ok:true});
}));

// ── Bot marketplace (server installs) ─────────────────────────────────────────
// Slash-path bot invocation: clients send unknown /commands here so bots can
// answer with static replies or host games. Returns handled so clients can show
// a friendly "no bot has that command" message instead of posting stray text.
app.post('/api/bots/invoke', auth, route(async (req,res) => {
  const channelId = req.body.channelId;
  if (!channelId) return res.status(400).json({ error: 'channelId required' });
  const m = String(req.body.text || '').trim().match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!m) return res.json({ handled: false });
  const handled = await resolveBotCommand(m[1].toLowerCase(), (m[2] || '').trim(), channelId, null, req.user);
  res.json({ handled });
}));

app.get('/api/bot-templates', auth, route(async (_req,res) => {
  // Built-in templates + user-published bots from the marketplace
  const published = await store.all('SELECT * FROM marketplace_bots ORDER BY installs DESC, created_at DESC');
  const reviews = published.length
    ? await store.all('SELECT bot_id, rating FROM bot_reviews WHERE bot_id = ANY($1::text[])', published.map(b=>b.id))
    : [];
  const revMap = {};
  reviews.forEach(r => { (revMap[r.bot_id] = revMap[r.bot_id] || []).push(r.rating); });
  const custom = published.map(b => {
    const rv = revMap[b.id] || [];
    return {
      id: b.id, emoji: b.emoji, name: b.name, category: b.category,
      desc: b.description, custom: true, author: b.author_name, author_id: b.author_id, installs: Number(b.installs||0),
      reviewCount: rv.length, avgRating: rv.length ? +(rv.reduce((a,x)=>a+x,0)/rv.length).toFixed(1) : null,
      commands: (() => { try { return JSON.parse(b.commands||'[]'); } catch { return []; } })(),
    };
  });
  res.json({ templates: [...BOT_TEMPLATES, ...custom] });
}));

// 'Also liked' cross-sell: other bots that often share a server with the current one.
// Identity keys: 'mb:<botUserId>' for published custom bots, 'tpl:<templateId>' for built-ins.
async function computeAlsoLiked(communityIds, excludeIdentity) {
  if (!communityIds.length) return [];
  const rows = await store.all(
    `SELECT m.community_id, u.id AS bot_user_id, u.username
     FROM memberships m JOIN users u ON u.id=m.user_id
     WHERE m.community_id = ANY($1::text[]) AND u.is_bot=1`, communityIds);
  if (!rows.length) return [];
  const mbIds = [...new Set(rows.map(r=>r.bot_user_id))];
  const mbs = mbIds.length ? await store.all('SELECT id,emoji,name,description AS desc,category,installs FROM marketplace_bots WHERE id = ANY($1::text[])', mbIds) : [];
  const mbMap = {}; mbs.forEach(b=>mbMap[b.id]=b);
  const acc = {};
  rows.forEach(r=>{
    const mb = mbMap[r.bot_user_id];
    let ident, disp;
    if (mb) {
      ident='mb:'+r.bot_user_id;
      disp={ kind:'custom', id:r.bot_user_id, emoji:mb.emoji, name:mb.name, desc:mb.desc, category:mb.category, installs:Number(mb.installs||0) };
    } else {
      const tplId = String(r.username||'').split('_')[0];
      const tpl = BOT_TEMPLATES.find(t=>t.id===tplId);
      if (!tpl) return;
      ident='tpl:'+tplId;
      disp={ kind:'builtin', id:tpl.id, emoji:tpl.emoji, name:tpl.name, desc:tpl.desc, category:tpl.category, installs:null };
    }
    if (ident===excludeIdentity) return;
    if (!acc[ident]) acc[ident]={ set:new Set(), disp };
    acc[ident].set.add(r.community_id);
  });
  const list = Object.values(acc).map(a=>({ ...a.disp, coCount:a.set.size }))
    .sort((x,y)=> (y.coCount - x.coCount) || ((y.installs||0)-(x.installs||0)))
    .slice(0,4);
  // Attach ratings for custom bots.
  const cIds = list.filter(x=>x.kind==='custom').map(x=>x.id);
  if (cIds.length) {
    const revs = await store.all('SELECT bot_id,rating FROM bot_reviews WHERE bot_id = ANY($1::text[])', cIds);
    const agg = {}; revs.forEach(r=>{ (agg[r.bot_id]=agg[r.bot_id]||[]).push(r.rating); });
    list.forEach(x=>{ if (x.kind==='custom'){ const rv=agg[x.id]||[]; x.avgRating= rv.length ? +(rv.reduce((a,b)=>a+b,0)/rv.length).toFixed(1) : null; x.reviewCount=rv.length; } });
  }
  return list;
}

// Bot detail page (works for built-in templates and user-published bots), with reviews.
app.get('/api/marketplace/bots/:id', auth, route(async (req,res) => {
  const tpl = BOT_TEMPLATES.find(t => t.id === req.params.id);
  if (tpl) {
    const instComms = await store.all(`SELECT m.community_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.is_bot=1 AND u.username LIKE $1`, tpl.id+'_%');
    const alsoLiked = await computeAlsoLiked(instComms.map(c=>c.community_id), 'tpl:'+tpl.id);
    return res.json({ id:tpl.id, name:tpl.name, emoji:tpl.emoji, category:tpl.category, desc:tpl.desc,
      commands:tpl.commands, builtin:true, installs:null, author_name:null,
      created_at:null, reviews:[], avgRating:null, reviewCount:0, myReview:null, alsoLiked });
  }
  const b = await store.get('SELECT * FROM marketplace_bots WHERE id=$1', req.params.id);
  if (!b) return res.status(404).json({error:'Bot not found'});
  let commands = []; try { commands = JSON.parse(b.commands||'[]'); } catch { commands = []; }
  // Review sorting: newest (default) / highest / lowest rated.
  let reviewOrder = 'r.created_at DESC';
  if (req.query.sort === 'high') reviewOrder = 'r.rating DESC, r.created_at ASC';
  else if (req.query.sort === 'low') reviewOrder = 'r.rating ASC, r.created_at DESC';
  const reviews = await store.all(`SELECT r.*, u.nickname, u.username, u.avatar,
    (SELECT emoji FROM marketplace_bots mb WHERE mb.id=u.id) AS bot_emoji
    FROM bot_reviews r JOIN users u ON u.id=r.user_id WHERE r.bot_id=$1 ORDER BY ${reviewOrder}`, b.id);
  const ratings = reviews.map(r => r.rating);
  const releases = await store.all(`SELECT r.*, u.username AS released_name FROM bot_releases r LEFT JOIN users u ON u.id=r.released_by WHERE r.bot_id=$1 ORDER BY r.released_at DESC LIMIT 50`, b.id);
  const isAuthor = req.user.id === b.author_id;
  const instComms = await store.all('SELECT community_id FROM memberships WHERE user_id=$1', b.id);
  const alsoLiked = await computeAlsoLiked(instComms.map(c=>c.community_id), 'mb:'+b.id);
  res.json({
    id:b.id, name:b.name, emoji:b.emoji, category:b.category, desc:b.description,
    commands, builtin:false, installs:Number(b.installs||0), author_name:b.author_name, created_at:b.created_at,
    author_id:b.author_id, is_author:isAuthor, can_release:(isAuthor || req.user.is_admin), releases,
    reviews, avgRating: ratings.length ? +(ratings.reduce((a,x)=>a+x,0)/ratings.length).toFixed(1) : null,
    reviewCount: ratings.length, myReview: reviews.find(r => r.user_id === req.user.id) || null,
    alsoLiked,
  });
}));

// Post (or update) a review for a published custom bot.
app.post('/api/marketplace/bots/:id/reviews', auth, route(async (req,res) => {
  const b = await store.get('SELECT id FROM marketplace_bots WHERE id=$1', req.params.id);
  if (!b) return res.status(404).json({error:'Only published custom bots can be reviewed'});
  const rating = Math.max(1, Math.min(5, Number(req.body.rating) || 5));
  const comment = String(req.body.comment || '').slice(0, 500);
  await store.run('INSERT INTO bot_reviews (bot_id,user_id,rating,comment,created_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)'
    + ' ON CONFLICT (bot_id,user_id) DO UPDATE SET rating=$3, comment=$4, created_at=CURRENT_TIMESTAMP',
    req.params.id, req.user.id, rating, comment);
  res.json({ ok:true });
}));

// Delete your own review for a published custom bot.
app.delete('/api/marketplace/bots/:id/reviews', auth, route(async (req,res) => {
  const b = await store.get('SELECT id FROM marketplace_bots WHERE id=$1', req.params.id);
  if (!b) return res.status(404).json({error:'Only published custom bots can be reviewed'});
  await store.run('DELETE FROM bot_reviews WHERE bot_id=$1 AND user_id=$2', req.params.id, req.user.id);
  res.json({ ok:true });
}));

// Create a custom bot for a server (owners/admins only)
app.post('/api/servers/:communityId/bots/custom', auth, route(async (req,res) => {
  const comm = await store.get('SELECT id,name FROM communities WHERE id=$1', req.params.communityId);
  if (!comm) return res.status(404).json({error:'Server not found'});
  if (!(await canManageServer(req, req.params.communityId))) return res.status(403).json({error:'Server admins only'});
  const name = String(req.body.name||'').trim().slice(0,32);
  if (!name) return res.status(400).json({error:'Bot name required'});
  const commands = Array.isArray(req.body.commands) ? req.body.commands
    .filter(c => String(c.command||'').trim() && String(c.response||'').trim())
    .map(c => ({ command:String(c.command).trim().toLowerCase().slice(0,32), description:String(c.description||'').slice(0,120), response:String(c.response).slice(0,1000) }))
    .slice(0,20) : [];
  if (!commands.length) return res.status(400).json({error:'Add at least one command with a response'});
  const emoji = String(req.body.emoji||'🤖').slice(0,4);
  const botColor = String(req.body.color||'').trim().slice(0,9);
  const description = String(req.body.description||'').slice(0,300);
  const category = String(req.body.category||'Custom').slice(0,24);
  const id = nanoid();
  const username = `custom_${id.slice(0,8)}`;
  await store.run('INSERT INTO users (id,username,tag,password_hash,nickname,is_bot,bot_token,bot_emoji,bot_color) VALUES (?,?,?,?,?,1,?,?,?)',
    id, username, 'bot', bcrypt.hashSync(nanoid(16),10), name, nanoid(32), emoji, botColor);
  await store.run('INSERT INTO user_settings (user_id) VALUES (?) ON CONFLICT DO NOTHING', id);
  await store.run('INSERT INTO memberships VALUES (?,?,?,?,0)', req.params.communityId, id, 'bot', null);
  await store.run('INSERT INTO bot_settings (community_id,bot_id,enabled,allowed_channels) VALUES (?,?,1,\'[]\')', req.params.communityId, id);
  for (const c of commands) {
    await store.run('INSERT INTO bot_commands (id,bot_id,command,description,response,community_id,created_at) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)',
      nanoid(), id, c.command, c.description, c.response, req.params.communityId);
  }
  io.emit('user_update', publicUser(await store.get('SELECT * FROM users WHERE id=$1', id)));
  res.json({ ok:true, bot: { id, username, nickname:name, emoji } });
}));

// Fire a bot command into a chosen channel as a live test-run (server admins/mods).
app.post('/api/servers/:communityId/bots/:botId/test-run', auth, route(async (req,res) => {
  if (!(await canManageServer(req, req.params.communityId))) return res.status(403).json({error:'Server admins only'});
  const bot = await store.get('SELECT id,nickname,username,emoji FROM users WHERE id=$1 AND is_bot=1', req.params.botId);
  if (!bot) return res.status(404).json({error:'Bot not found'});
  const mem = await store.get('SELECT 1 FROM memberships WHERE community_id=$1 AND user_id=$2', req.params.communityId, req.params.botId);
  if (!mem) return res.status(404).json({error:'Bot is not installed in this server'});
  const channelId = req.body.channelId;
  if (!channelId) return res.status(400).json({error:'Choose a channel to test in'});
  const ch = await store.get('SELECT id,community_id FROM channels WHERE id=$1', channelId);
  if (!ch || ch.community_id !== req.params.communityId) return res.status(400).json({error:'Channel must belong to this server'});
  const command = String(req.body.command || '').trim().toLowerCase().replace(/^!/,'');
  const argText = String(req.body.argText || '').trim();
  if (!command) return res.status(400).json({error:'Command required'});
  // Tag messages the bot posts during this test run so we can clear the test output.
  const capture = { ids:new Set(), channelId: String(channelId) };
  const prevCapture = botTestCapture;
  botTestCapture = capture;
  let handled = false, cleared = 0;
  try {
    handled = await resolveBotCommand(command, argText, channelId, null, { ...req.user, is_admin: true });
    if (capture.ids.size) {
      const idList = [...capture.ids];
      await store.run('UPDATE messages SET deleted_at=CURRENT_TIMESTAMP,body=\'[deleted]\' WHERE id = ANY($1::text[])', idList);
      for (const id of idList) io.to(channelId).emit('message_delete',{ id, channelId });
      cleared = idList.length;
    }
  } finally {
    botTestCapture = prevCapture;
  }
  res.json({ ok:true, replied: !!handled, cleared });
}));

// Publish a custom bot to the marketplace (owner of the server it lives in)
app.post('/api/marketplace/publish', auth, route(async (req,res) => {
  const botId = req.body.botId; const communityId = req.body.communityId;
  if (!botId || !communityId) return res.status(400).json({error:'botId and communityId required'});
  if (!(await canManageServer(req, communityId))) return res.status(403).json({error:'Server admins only'});
  const bot = await store.get('SELECT * FROM users WHERE id=$1 AND is_bot=1', botId);
  if (!bot) return res.status(404).json({error:'Bot not found'});
  const mem = await store.get('SELECT 1 FROM memberships WHERE community_id=$1 AND user_id=$2', communityId, botId);
  if (!mem) return res.status(404).json({error:'Bot is not installed in this server'});
  const cmds = await store.all('SELECT command,description,response FROM bot_commands WHERE bot_id=$1 AND community_id=$2 ORDER BY created_at ASC', botId, communityId);
  if (!cmds.length) return res.status(400).json({error:'Bot has no commands to publish'});
  const existing = await store.get('SELECT id FROM marketplace_bots WHERE id=$1', botId);
  if (existing) {
    await store.run('UPDATE marketplace_bots SET name=$1,emoji=$2,category=$3,description=$4,commands=$5,author_name=$6 WHERE id=$7',
      bot.nickname||bot.username, req.body.emoji||'🤖', String(req.body.category||'Custom').slice(0,24),
      String(req.body.description||'').slice(0,300), JSON.stringify(cmds), req.user.nickname||req.user.username, botId);
  } else {
    await store.run('INSERT INTO marketplace_bots (id,name,emoji,category,description,commands,author_id,author_name) VALUES (?,?,?,?,?,?,?,?)',
      botId, bot.nickname||bot.username, req.body.emoji||'🤖', String(req.body.category||'Custom').slice(0,24),
      String(req.body.description||'').slice(0,300), JSON.stringify(cmds), req.user.id, req.user.nickname||req.user.username);
  }
  res.json({ ok:true, published:true });
}));

// Author edits their own published bot's commands directly (no server-admin needed).
// Writes to the marketplace listing AND syncs to every server where the bot is installed.
app.patch('/api/marketplace/bots/:id/commands', auth, route(async (req,res) => {
  const pub = await store.get('SELECT * FROM marketplace_bots WHERE id=$1', req.params.id);
  if (!pub) return res.status(404).json({error:'Bot not found / not published'});
  if (req.user.id !== pub.author_id && !req.user.is_admin) {
    return res.status(403).json({error:'Only the author can edit this bot'});
  }
  const name = String(req.body.name || pub.name || '').trim().slice(0,32);
  const commands = Array.isArray(req.body.commands)
    ? req.body.commands
        .filter(c => String(c.command||'').trim() && String(c.response||'').trim())
        .map(c => ({ command:String(c.command).trim().toLowerCase().slice(0,32), description:String(c.description||'').slice(0,120), response:String(c.response).slice(0,1000) }))
        .slice(0,20)
    : null;
  if (commands !== null && !commands.length) return res.status(400).json({error:'Add at least one command with a response'});
  if (commands !== null) {
    await store.run('UPDATE marketplace_bots SET name=$1,emoji=$2,commands=$3 WHERE id=$4',
      name, String(req.body.emoji || pub.emoji || '🤖').slice(0,4), JSON.stringify(commands), pub.id);
    // Sync to every installed server.
    const installs = await store.all(`SELECT m.community_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.user_id=$1 AND u.is_bot=1`, pub.id);
    for (const inst of installs) {
      await store.run('DELETE FROM bot_commands WHERE bot_id=$1 AND community_id=$2', pub.id, inst.community_id);
      for (const c of commands) {
        await store.run('INSERT INTO bot_commands (id,bot_id,command,description,response,community_id,created_at) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)',
          nanoid(), pub.id, c.command, c.description, c.response, inst.community_id);
      }
    }
    // Record a release so installed servers see what changed.
    const version = String(req.body.version || '').trim().slice(0,40);
    const note = String(req.body.note || '').trim().slice(0,300);
    await store.run('INSERT INTO bot_releases (id,bot_id,version,note,released_by,commands) VALUES (?,?,?,?,?,?)',
      nanoid(), pub.id, version || 'v'+new Date().toISOString().slice(0,10), note, req.user.id, JSON.stringify(commands));
    return res.json({ ok:true, published:true, bootRefresh:true });
  }
  res.json({ ok:true, published:true });
}));

// Per-command delta edit for an author's published bot: change one reply/description
// (and optionally rename the command) without resubmitting the whole command set.
// Synced to the marketplace listing and every installed server, with a release note.
app.patch('/api/marketplace/bots/:id/command', auth, route(async (req,res) => {
  const pub = await store.get('SELECT * FROM marketplace_bots WHERE id=$1', req.params.id);
  if (!pub) return res.status(404).json({error:'Bot not found / not published'});
  if (req.user.id !== pub.author_id && !req.user.is_admin) {
    return res.status(403).json({error:'Only the author can edit this bot'});
  }
  let commands = []; try { commands = JSON.parse(pub.commands || '[]'); } catch { commands = []; }
  const cur = String(req.body.command || '').trim().toLowerCase().slice(0,32);
  if (!cur) return res.status(400).json({error:'command required'});
  const idx = commands.findIndex(c => String(c.command).toLowerCase() === cur);
  if (idx === -1) return res.status(404).json({error:'Command not found'});
  const existing = commands[idx];
  const newCmd = String((req.body.newCommand !== undefined ? req.body.newCommand : existing.command) || '').trim().toLowerCase().slice(0,32);
  const newDesc = String((req.body.description !== undefined ? req.body.description : existing.description) || '').slice(0,120);
  const newResp = String((req.body.response !== undefined ? req.body.response : existing.response) || '').slice(0,1000);
  if (!newCmd) return res.status(400).json({error:'Command name required'});
  if (!newResp) return res.status(400).json({error:'Response required'});
  const clash = newCmd !== cur && commands.some((c,i) => i !== idx && String(c.command).toLowerCase() === newCmd);
  if (clash) return res.status(400).json({error:'Another command already uses that name'});
  commands[idx] = { command: newCmd, description: newDesc, response: newResp };
  await store.run('UPDATE marketplace_bots SET name=$1,emoji=$2,commands=$3 WHERE id=$4',
    String(req.body.name || pub.name || '').trim().slice(0,32) || pub.name,
    String(req.body.emoji || pub.emoji || '🤖').slice(0,4), JSON.stringify(commands), pub.id);
  // Update just this command in every installed server.
  const installs = await store.all(`SELECT m.community_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.user_id=$1 AND u.is_bot=1`, pub.id);
  for (const inst of installs) {
    await store.run('DELETE FROM bot_commands WHERE bot_id=$1 AND community_id=$2 AND LOWER(command)=$3', pub.id, inst.community_id, cur);
    await store.run('INSERT INTO bot_commands (id,bot_id,command,description,response,community_id,created_at) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)',
      nanoid(), pub.id, newCmd, newDesc, newResp, inst.community_id);
  }
  // Release note.
  const version = String(req.body.version || '').trim().slice(0,40);
  const note = String(req.body.note || '').trim().slice(0,300);
  await store.run('INSERT INTO bot_releases (id,bot_id,version,note,released_by,commands) VALUES (?,?,?,?,?,?)',
    nanoid(), pub.id, version || 'v'+new Date().toISOString().slice(0,10), note || `Updated !${cur}`, req.user.id, JSON.stringify([commands[idx]]));
  res.json({ ok:true, command: commands[idx], bootRefresh:true });
}));

app.delete('/api/marketplace/:botId', auth, route(async (req,res) => {
  const row = await store.get('SELECT author_id FROM marketplace_bots WHERE id=$1', req.params.botId);
  if (!row) return res.status(404).json({error:'Not published'});
  if (req.user.id !== row.author_id && !req.user.is_admin) return res.status(403).json({error:'Only the author can unpublish'});
  await store.run('DELETE FROM marketplace_bots WHERE id=$1', req.params.botId);
  res.json({ ok:true });
}));

// ── Server cosmetics marketplace (credits) ───────────────────────────────────
app.get('/api/marketplace/cosmetics', auth, route(async (req,res) => {
  const communityId = req.query.communityId;
  if (!communityId) return res.status(400).json({error:'communityId required'});
  const comm = await store.get('SELECT * FROM communities WHERE id=$1', communityId);
  if (!comm) return res.status(404).json({error:'Server not found'});
  const access = await communityAccess(req.user.id, communityId);
  if (!access.member && !req.user.is_admin) return res.status(403).json({error:'Forbidden'});
  const owned = await store.all('SELECT * FROM server_cosmetics WHERE community_id=$1', communityId);
  const ownedIds = owned.map(o => o.item_id);
  // Gifter attribution: who purchased/gifted each owned item, for the "gifted by" label.
  const gifters = owned.length
    ? await store.all(`SELECT sc.item_id, u.username, u.nickname
      FROM server_cosmetics sc JOIN users u ON u.id=sc.purchased_by
      WHERE sc.community_id=$1 AND sc.item_id = ANY($2::text[])`, communityId, ownedIds)
    : [];
  const gifterMap = {};
  gifters.forEach(g => { gifterMap[g.item_id] = g.nickname || g.username; });
  const { credits } = await getUserCredits(req.user.id);
  // Effects with purchaser info so the member list can decorate names
  const effects = await store.all(`SELECT sc.item_id, sc.purchased_by, u.username, u.nickname
    FROM server_cosmetics sc JOIN users u ON u.id=sc.purchased_by
    WHERE sc.community_id=$1 AND sc.item_id LIKE 'effect_%'`, communityId);
  // Active-effect selections: one chosen effect per member (fallback = first they own)
  const activeRows = await store.all('SELECT user_id, item_id FROM active_effects WHERE community_id=$1', communityId);
  const activeMap = {};
  activeRows.forEach(a => { activeMap[a.user_id] = a.item_id; });
  const ownedByUser = {};
  effects.forEach(e => { (ownedByUser[e.purchased_by] = ownedByUser[e.purchased_by] || []).push(e.item_id); });
  // 'Same everywhere' mode: a single effect id the user chose applies in every
  // server they own effects in. Overrides the per-server active_effects row.
  const purchaserIds = [...new Set(effects.map(e => e.purchased_by))];
  const ewRows = purchaserIds.length ? await store.all('SELECT id, effect_everywhere FROM users WHERE id = ANY($1::text[])', purchaserIds) : [];
  const ewMap = {};
  ewRows.forEach(r => { if (r.effect_everywhere) ewMap[r.id] = r.effect_everywhere; });
  // Scheduled rotation: each user may have a list that cycles daily (different effect per day).
  const rotRows = purchaserIds.length ? await store.all('SELECT id, effect_rotation, effect_rotation_start FROM users WHERE id = ANY($1::text[])', purchaserIds) : [];
  const rotMap = {};
  rotRows.forEach(r => {
    let list = [];
    try { list = JSON.parse(r.effect_rotation || '[]'); } catch { list = []; }
    if (Array.isArray(list) && list.length) rotMap[r.id] = { list, start: r.effect_rotation_start || '' };
  });
  effects.forEach(e => {
    const mine = ownedByUser[e.purchased_by] || [];
    const rot = rotMap[e.purchased_by];
    const rotPick = rot ? rotationPickFor(rot.list, rot.start) : null;
    const ew = ewMap[e.purchased_by];
    // Precedence: scheduled rotation > same-everywhere > per-server pick > first owned.
    e.isActive = rotPick ? rotPick === e.item_id : (ew ? ew === e.item_id : (activeMap[e.purchased_by] ? activeMap[e.purchased_by] === e.item_id : mine[0] === e.item_id));
  });
  const myEffects = effects
    .filter(e => e.purchased_by === req.user.id)
    .map(e => ({ item_id: e.item_id, isActive: e.isActive }));
  const banner = comm.banner && COSMETIC_BANNER_GRADIENTS[comm.banner] ? comm.banner : null;
  const meRow = await store.get('SELECT effect_everywhere, effect_rotation, effect_rotation_start FROM users WHERE id=$1', req.user.id);
  const meEw = meRow?.effect_everywhere || '';
  let meRot = [];
  try { meRot = JSON.parse(meRow?.effect_rotation || '[]'); } catch { meRot = []; }
  const meRotStart = meRow?.effect_rotation_start || '';
  res.json({ catalog: SERVER_COSMETICS, owned: ownedIds, credits, effects, myEffects, banner, gifters: gifterMap, effectEverywhere: meEw || null, rotation: meRot, rotationStart: meRotStart || null, rotationPick: rotationPickFor(meRot, meRotStart) });
}));

// Which rotation item applies today for a user's scheduled effect rotation.
// A different effect each day, cycling through the list by elapsed days.
function rotationPickFor(list, start) {
  if (!Array.isArray(list) || !list.length) return null;
  if (!start) return list[0];
  const parts = String(start).split('-').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return list[0];
  const a = new Date(parts[0], parts[1]-1, parts[2]);
  const now = new Date();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.max(0, Math.round((b - a) / 86400000));
  return list[days % list.length];
}

// Set which owned effect shows by a user's name in a server.
// With `everywhere` true, the same effect applies to every server the user owns it in.
app.post('/api/marketplace/cosmetics/effect', auth, route(async (req,res) => {
  const communityId = req.body.communityId; const itemId = req.body.itemId;
  const everywhere = !!req.body.everywhere;
  if (!communityId || !itemId) return res.status(400).json({error:'communityId and itemId required'});
  if (!itemId.startsWith('effect_')) {
    // "none" removes the active selection
    if (itemId === 'none') {
      await store.run('DELETE FROM active_effects WHERE community_id=$1 AND user_id=$2', communityId, req.user.id);
      if (everywhere) await store.run("UPDATE users SET effect_everywhere='' WHERE id=$1", req.user.id);
      return res.json({ ok:true, itemId: null, effectEverywhere: null });
    }
    return res.status(400).json({error:'Only profile effects can be active'});
  }
  const owned = await store.get('SELECT 1 FROM server_cosmetics WHERE community_id=$1 AND item_id=$2 AND purchased_by=$3', communityId, itemId, req.user.id);
  if (!owned) return res.status(403).json({error:'You don\'t own this effect in that server'});
  if (everywhere) {
    // Apply this effect in every server the user owns it, and remember the choice globally.
    await store.run('UPDATE users SET effect_everywhere=$1 WHERE id=$2', itemId, req.user.id);
    const comms = await store.all('SELECT DISTINCT community_id FROM server_cosmetics WHERE purchased_by=$1 AND item_id=$2', req.user.id, itemId);
    for (const c of comms) {
      await store.run('INSERT INTO active_effects (community_id,user_id,item_id) VALUES (?,?,?) ON CONFLICT (community_id,user_id) DO UPDATE SET item_id=$3',
        c.community_id, req.user.id, itemId);
    }
    res.json({ ok:true, itemId, effectEverywhere: itemId, synced: comms.length });
  } else {
    // Per-server pick: clear any global "same everywhere" choice so per-server rules apply.
    if (req.body.everywhere !== undefined) await store.run("UPDATE users SET effect_everywhere='' WHERE id=$1", req.user.id);
    await store.run('INSERT INTO active_effects (community_id,user_id,item_id) VALUES (?,?,?) ON CONFLICT (community_id,user_id) DO UPDATE SET item_id=$3',
      communityId, req.user.id, itemId);
    res.json({ ok:true, itemId, effectEverywhere: null });
  }
}));

// Set (or clear) a user's scheduled daily effect rotation: a different owned effect
// each day, cycling through the list. Empty list disables rotation.
app.post('/api/marketplace/cosmetics/rotation', auth, route(async (req,res) => {
  let items = Array.isArray(req.body.items) ? [...new Set(req.body.items.map(String))].filter(id => id.startsWith('effect_')).slice(0, 10) : [];
  if (items.length) {
    // Only keep effects the user actually owns somewhere.
    const ownedIds = await store.all('SELECT DISTINCT item_id FROM server_cosmetics WHERE purchased_by=$1 AND item_id = ANY($2::text[])', req.user.id, items);
    items = ownedIds.map(r => r.item_id);
    if (items.length) {
      await store.run("UPDATE users SET effect_rotation=$1, effect_rotation_start=$2 WHERE id=$3", JSON.stringify(items), TODAY(), req.user.id);
    }
  } else {
    await store.run("UPDATE users SET effect_rotation='[]', effect_rotation_start='' WHERE id=$1", req.user.id);
  }
  const row = await store.get('SELECT effect_rotation, effect_rotation_start FROM users WHERE id=$1', req.user.id);
  let list = [];
  try { list = JSON.parse(row?.effect_rotation || '[]'); } catch { list = []; }
  res.json({ ok:true, rotation: list, rotationStart: row?.effect_rotation_start || null, rotationPick: rotationPickFor(list, row?.effect_rotation_start || '') });
}));

app.post('/api/marketplace/cosmetics/buy', auth, route(async (req,res) => {
  const communityId = req.body.communityId; const itemId = req.body.itemId;
  if (!communityId || !itemId) return res.status(400).json({error:'communityId and itemId required'});
  const item = SERVER_COSMETICS.find(c => c.id === itemId);
  if (!item) return res.status(404).json({error:'Cosmetic not found'});
  // Anyone who is a member may gift a cosmetic to the server (charged to their credits).
  const access = await communityAccess(req.user.id, communityId);
  if (!access.member && !req.user.is_admin) return res.status(403).json({error:'You must be a member of this server to gift a cosmetic'});
  const { credits } = await getUserCredits(req.user.id);
  if (credits < item.price) return res.status(400).json({error:'Not enough credits'});
  const existing = await store.get('SELECT 1 FROM server_cosmetics WHERE community_id=$1 AND item_id=$2', communityId, itemId);
  if (existing) return res.status(409).json({error:'Already owned by this server'});
  await addCredits(req.user.id, -item.price);
  await store.run('INSERT INTO server_cosmetics (community_id,item_id,purchased_by) VALUES (?,?,?)', communityId, itemId, req.user.id);
  if (item.kind === 'role') {
    // Create the custom role in the server, tagged with the cosmetic source so it's easy to spot.
    const roleId = nanoid();
    const perms = Object.fromEntries(ROLE_PERMISSIONS.map(p => [p, false]));
    await store.run('INSERT INTO community_roles (id,community_id,name,color,position,permissions,mentionable,cosmetic,locked) VALUES (?,?,?,?,?,?,?,?,1)',
      roleId, communityId, item.name, item.color, 0, JSON.stringify(perms), 0, itemId);
    io.emit('roles_update', { communityId });
  } else if (item.kind === 'banner') {
    await store.run('UPDATE communities SET banner=$1 WHERE id=$2', itemId, communityId);
  }
  const after = await getUserCredits(req.user.id);
  const owned = await store.all('SELECT item_id FROM server_cosmetics WHERE community_id=$1', communityId);
  res.json({ ok:true, credits: after.credits, owned: owned.map(o => o.item_id), role: item.kind==='role' ? item.name : null, banner: item.kind==='banner' ? itemId : null });
}));

// Gift several cosmetics to a server in one transaction (charged to your credits once).
app.post('/api/marketplace/cosmetics/gift-cart', auth, route(async (req,res) => {
  const communityId = req.body.communityId;
  const itemIds = Array.isArray(req.body.items) ? [...new Set(req.body.items.map(String))].slice(0, 50) : [];
  if (!communityId) return res.status(400).json({error:'communityId required'});
  if (!itemIds.length) return res.status(400).json({error:'Add at least one item to your cart'});
  const items = itemIds.map(id => SERVER_COSMETICS.find(c => c.id === id)).filter(Boolean);
  if (items.length !== itemIds.length) return res.status(404).json({error:'One or more cosmetics not found'});
  // Anyone who is a member may gift cosmetics to the server (charged to their credits).
  const access = await communityAccess(req.user.id, communityId);
  if (!access.member && !req.user.is_admin) return res.status(403).json({error:'You must be a member of this server to gift a cosmetic'});
  const total = items.reduce((sum, it) => sum + Number(it.price || 0), 0);
  const { credits } = await getUserCredits(req.user.id);
  if (credits < total) return res.status(400).json({error:`Not enough credits — this cart costs ✦${total}`});
  // Reject any item the server already owns so a stale cart can't double-buy.
  const existingRows = await store.all('SELECT item_id FROM server_cosmetics WHERE community_id=$1 AND item_id = ANY($2::text[])', communityId, itemIds);
  if (existingRows.length) {
    return res.status(409).json({ error:'Already owned by this server', owned: existingRows.map(r => r.item_id) });
  }
  await addCredits(req.user.id, -total);
  const createdRoles = [];
  let bannerId = null;
  for (const item of items) {
    await store.run('INSERT INTO server_cosmetics (community_id,item_id,purchased_by) VALUES (?,?,?)', communityId, item.id, req.user.id);
    if (item.kind === 'role') {
      const roleId = nanoid();
      const perms = Object.fromEntries(ROLE_PERMISSIONS.map(p => [p, false]));
    await store.run('INSERT INTO community_roles (id,community_id,name,color,position,permissions,mentionable,cosmetic,locked) VALUES (?,?,?,?,?,?,?,?,1)',
      roleId, communityId, item.name, item.color, 0, JSON.stringify(perms), 0, item.id);
      createdRoles.push(item.name);
    } else if (item.kind === 'banner') {
      await store.run('UPDATE communities SET banner=$1 WHERE id=$2', item.id, communityId);
      bannerId = item.id;
    }
  }
  if (createdRoles.length) io.emit('roles_update', { communityId });
  const after = await getUserCredits(req.user.id);
  const owned = await store.all('SELECT item_id FROM server_cosmetics WHERE community_id=$1', communityId);
  res.json({ ok:true, credits: after.credits, owned: owned.map(o => o.item_id), roles: createdRoles, banner: bannerId });
}));

app.get('/api/servers/:communityId/bots', auth, route(async (req,res) => {
  const bots = await store.all(`SELECT u.id,u.username,u.nickname,u.avatar,
      CASE WHEN u.username LIKE 'custom_%' THEN 1 ELSE 0 END AS is_custom,
      (SELECT emoji FROM marketplace_bots mb WHERE mb.id=u.id) AS emoji,
      (SELECT category FROM marketplace_bots mb WHERE mb.id=u.id) AS mkt_category,
      (SELECT description FROM marketplace_bots mb WHERE mb.id=u.id) AS mkt_desc,
      COALESCE(bs.enabled,1) AS enabled,
      COALESCE(bs.allowed_channels,'[]') AS allowed_channels,
      COALESCE(bs.trigger_roles,'[]') AS trigger_roles,
      COALESCE(bs.blocked_roles,'[]') AS blocked_roles
    FROM memberships m JOIN users u ON u.id=m.user_id
    LEFT JOIN bot_settings bs ON bs.community_id=m.community_id AND bs.bot_id=u.id
    WHERE m.community_id=$1 AND u.is_bot=1`, req.params.communityId);
  if (bots.length) {
    // Attach each bot's commands so authors can edit/push them live.
    const ids = bots.map(b=>b.id);
    const bcs = await store.all('SELECT bot_id,command,description,response FROM bot_commands WHERE community_id=$1 AND bot_id = ANY($2::text[]) ORDER BY created_at ASC', req.params.communityId, ids);
    const byBot = {};
    bcs.forEach(c => { (byBot[c.bot_id] = byBot[c.bot_id] || []).push({ command:c.command, description:c.description, response:c.response }); });
    bots.forEach(b => b.commands = byBot[b.id] || []);
    // Per-command role scopes: { command: { trigger:[...], blocked:[...] } }
    const cmdRoles = await store.all('SELECT bot_id,command,trigger_roles,blocked_roles FROM bot_command_roles WHERE community_id=$1 AND bot_id = ANY($2::text[])', req.params.communityId, ids);
    const rolesByBot = {};
    cmdRoles.forEach(v => {
      let tr = [], br = [];
      try { tr = JSON.parse(v.trigger_roles || '[]'); } catch { tr = []; }
      try { br = JSON.parse(v.blocked_roles || '[]'); } catch { br = []; }
      (rolesByBot[v.bot_id] = rolesByBot[v.bot_id] || {})[v.command] = { trigger:tr, blocked:br };
    });
    bots.forEach(b => b.commandRoles = rolesByBot[b.id] || {});
    // Per-command visibility: { command: [channelId, ...] } of channels where the command is hidden.
    const vis = await store.all('SELECT bot_id, channel_id, command FROM bot_command_visibility WHERE community_id=$1 AND bot_id = ANY($2::text[])', req.params.communityId, ids);
    const visByBot = {};
    vis.forEach(v => { (visByBot[v.bot_id] = visByBot[v.bot_id] || {})[v.command] = [...((visByBot[v.bot_id] && visByBot[v.bot_id][v.command]) || []), v.channel_id]; });
    bots.forEach(b => b.hiddenCommands = visByBot[b.id] || {});
  }
  res.json(bots);
}));

// Toggle whether a specific bot command is hidden in a specific channel.
app.patch('/api/servers/:communityId/bots/:botId/visibility', auth, route(async (req,res) => {
  if (!(await canManageServer(req, req.params.communityId))) return res.status(403).json({error:'Server admins only'});
  const bot = await store.get('SELECT id FROM users WHERE id=$1 AND is_bot=1', req.params.botId);
  if (!bot) return res.status(404).json({error:'Bot not found'});
  const command = String(req.body.command || '').trim().toLowerCase().slice(0,32);
  const channelId = String(req.body.channelId || '');
  if (!command || !channelId) return res.status(400).json({error:'command and channelId required'});
  const existing = await store.get('SELECT 1 FROM bot_command_visibility WHERE community_id=$1 AND bot_id=$2 AND channel_id=$3 AND command=$4', req.params.communityId, req.params.botId, channelId, command);
  let hide = req.body.hidden !== undefined ? !!req.body.hidden : !existing; // default: toggle
  if (hide && !existing) {
    await store.run('INSERT INTO bot_command_visibility (community_id,bot_id,channel_id,command) VALUES (?,?,?,?)', req.params.communityId, req.params.botId, channelId, command);
  } else if (!hide && existing) {
    await store.run('DELETE FROM bot_command_visibility WHERE community_id=$1 AND bot_id=$2 AND channel_id=$3 AND command=$4', req.params.communityId, req.params.botId, channelId, command);
  }
  res.json({ ok:true, hidden: hide });
}));

// Toggle a bot command's visibility in EVERY text channel of the server at once.
app.post('/api/servers/:communityId/bots/:botId/visibility-all', auth, route(async (req,res) => {
  if (!(await canManageServer(req, req.params.communityId))) return res.status(403).json({error:'Server admins only'});
  const bot = await store.get('SELECT id FROM users WHERE id=$1 AND is_bot=1', req.params.botId);
  if (!bot) return res.status(404).json({error:'Bot not found'});
  const command = String(req.body.command || '').trim().toLowerCase().slice(0,32);
  if (!command) return res.status(400).json({error:'command required'});
  const hide = req.body.hidden !== undefined ? !!req.body.hidden : true; // default: hide everywhere
  const channels = await store.all("SELECT id FROM channels WHERE community_id=$1 AND type!='voice'", req.params.communityId);
  await store.run('DELETE FROM bot_command_visibility WHERE community_id=$1 AND bot_id=$2 AND command=$3', req.params.communityId, req.params.botId, command);
  if (hide) {
    for (const ch of channels) {
      await store.run('INSERT INTO bot_command_visibility (community_id,bot_id,channel_id,command) VALUES (?,?,?,?)', req.params.communityId, req.params.botId, ch.id, command);
    }
  }
  res.json({ ok:true, hidden: hide, channels: channels.length });
}));

// Set per-command trigger/blocked role scopes for a bot command.
// Command-level scopes override the bot-level scopes for that command.
app.patch('/api/servers/:communityId/bots/:botId/command-roles', auth, route(async (req,res) => {
  if (!(await canManageServer(req, req.params.communityId))) return res.status(403).json({error:'Server admins only'});
  const bot = await store.get('SELECT id FROM users WHERE id=$1 AND is_bot=1', req.params.botId);
  if (!bot) return res.status(404).json({error:'Bot not found'});
  const command = String(req.body.command || '').trim().toLowerCase().slice(0,32);
  if (!command) return res.status(400).json({error:'command required'});
  const triggerRoles = Array.isArray(req.body.triggerRoles) ? req.body.triggerRoles.map(String).slice(0,200) : null;
  const blockedRoles = Array.isArray(req.body.blockedRoles) ? req.body.blockedRoles.map(String).slice(0,200) : null;
  const existing = await store.get('SELECT * FROM bot_command_roles WHERE community_id=$1 AND bot_id=$2 AND command=$3', req.params.communityId, req.params.botId, command);
  const triggerJson = triggerRoles !== null ? JSON.stringify(triggerRoles) : (existing ? existing.trigger_roles : '[]');
  const blockedJson = blockedRoles !== null ? JSON.stringify(blockedRoles) : (existing ? existing.blocked_roles : '[]');
  if (existing) {
    await store.run('UPDATE bot_command_roles SET trigger_roles=$1, blocked_roles=$2 WHERE community_id=$3 AND bot_id=$4 AND command=$5', triggerJson, blockedJson, req.params.communityId, req.params.botId, command);
  } else {
    await store.run('INSERT INTO bot_command_roles (community_id,bot_id,command,trigger_roles,blocked_roles) VALUES (?,?,?,?,?)', req.params.communityId, req.params.botId, command, triggerJson, blockedJson);
  }
  res.json({ ok:true, command, triggerRoles: JSON.parse(triggerJson), blockedRoles: JSON.parse(blockedJson) });
}));

// Edit a custom bot in-place: updates its live commands in this server, and if the
// bot is published to the marketplace by this user, refreshes the marketplace
// snapshot too — so new installs pick up changes without re-publishing.
app.patch('/api/servers/:communityId/bots/:botId/update', auth, route(async (req,res) => {
  if (!(await canManageServer(req, req.params.communityId))) return res.status(403).json({error:'Server admins only'});
  const bot = await store.get('SELECT * FROM users WHERE id=$1 AND is_bot=1', req.params.botId);
  if (!bot) return res.status(404).json({error:'Bot not found'});
  const mem = await store.get('SELECT 1 FROM memberships WHERE community_id=$1 AND user_id=$2', req.params.communityId, req.params.botId);
  if (!mem) return res.status(404).json({error:'Bot is not installed in this server'});
  const name = String(req.body.name || bot.nickname || bot.username || '').trim().slice(0,32);
  const commands = Array.isArray(req.body.commands) ? req.body.commands
    .filter(c => String(c.command||'').trim() && String(c.response||'').trim())
    .map(c => ({ command:String(c.command).trim().toLowerCase().slice(0,32), description:String(c.description||'').slice(0,120), response:String(c.response).slice(0,1000) }))
    .slice(0,20) : null;
  if (commands !== null && !commands.length) return res.status(400).json({error:'Add at least one command with a response'});
  const botEmoji = String(req.body.emoji || bot.bot_emoji || '🤖').slice(0,4);
  const botColor = String(req.body.color || bot.bot_color || '').trim().slice(0,9);
  await store.run('UPDATE users SET nickname=?,bot_emoji=?,bot_color=? WHERE id=?', name, botEmoji, botColor, req.params.botId);
  if (commands !== null) {
    await store.run('DELETE FROM bot_commands WHERE bot_id=$1 AND community_id=$2', req.params.botId, req.params.communityId);
    for (const c of commands) {
      await store.run('INSERT INTO bot_commands (id,bot_id,command,description,response,community_id,created_at) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)',
        nanoid(), req.params.botId, c.command, c.description, c.response, req.params.communityId);
    }
  }
  // Push changes to the marketplace listing if this bot is published and the author/admin edits it.
  const pub = await store.get('SELECT * FROM marketplace_bots WHERE id=$1', req.params.botId);
  if (pub && (req.user.id === pub.author_id || req.user.is_admin)) {
    const cmds = commands !== null ? commands
      : await store.all('SELECT command,description,response FROM bot_commands WHERE bot_id=$1 AND community_id=$2 ORDER BY created_at ASC', req.params.botId, req.params.communityId);
    await store.run('UPDATE marketplace_bots SET name=$1,emoji=$2,category=$3,description=$4,commands=$5 WHERE id=$6',
      name, String(req.body.emoji || pub.emoji || '🤖').slice(0,4),
      String(req.body.category || pub.category || 'Custom').slice(0,24),
      String(req.body.description || pub.description || '').slice(0,300),
      JSON.stringify(cmds), req.params.botId);
  }
  io.emit('user_update', publicUser(await store.get('SELECT * FROM users WHERE id=$1', req.params.botId)));
  res.json({ ok:true, bot: { id: req.params.botId, nickname: name } });
}));

// Release the author's current command set to EVERY server where the bot is
// installed, recording a version note. Author of the bot, or a server admin of
// the source server, may release.
app.post('/api/servers/:communityId/bots/:botId/release', auth, route(async (req,res) => {
  const bot = await store.get('SELECT * FROM users WHERE id=$1 AND is_bot=1', req.params.botId);
  if (!bot) return res.status(404).json({error:'Bot not found'});
  const mem = await store.get('SELECT 1 FROM memberships WHERE community_id=$1 AND user_id=$2', req.params.communityId, req.params.botId);
  if (!mem) return res.status(404).json({error:'Bot is not installed in this server'});
  const pub = await store.get('SELECT * FROM marketplace_bots WHERE id=$1', req.params.botId);
  const isAuthor = pub ? req.user.id === pub.author_id : false;
  if (!req.user.is_admin && !isAuthor && !(await canManageServer(req, req.params.communityId))) {
    return res.status(403).json({error:'Only the bot author or a server admin can release updates'});
  }
  // The source server holds the author's authoritative command set.
  const cmds = await store.all('SELECT command,description,response FROM bot_commands WHERE bot_id=$1 AND community_id=$2 ORDER BY created_at ASC', req.params.botId, req.params.communityId);
  if (!cmds.length) return res.status(400).json({error:'No commands to release — add at least one command first'});
  const cleansed = cmds.map(c => ({ command:String(c.command).trim().toLowerCase().slice(0,32), description:String(c.description).slice(0,120), response:String(c.response).slice(0,1000) }));
  // Sync to every server this bot is installed in.
  const installs = await store.all(`SELECT m.community_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.user_id=$1 AND u.is_bot=1`, req.params.botId);
  for (const inst of installs) {
    await store.run('DELETE FROM bot_commands WHERE bot_id=$1 AND community_id=$2', req.params.botId, inst.community_id);
    for (const c of cleansed) {
      await store.run('INSERT INTO bot_commands (id,bot_id,command,description,response,community_id,created_at) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)',
        nanoid(), req.params.botId, c.command, c.description, c.response, inst.community_id);
    }
  }
  // Record the release (version note).
  const version = String(req.body.version || '').trim().slice(0,40);
  const note = String(req.body.note || '').trim().slice(0,300);
  const relId = nanoid();
  await store.run('INSERT INTO bot_releases (id,bot_id,version,note,released_by,commands) VALUES (?,?,?,?,?,?)',
    relId, req.params.botId, version || 'v'+new Date().toISOString().slice(0,10), note, req.user.id, JSON.stringify(cleansed));
  // Keep the marketplace listing in sync with the newest command set.
  if (pub && (isAuthor || req.user.is_admin)) {
    await store.run('UPDATE marketplace_bots SET name=$1,commands=$2 WHERE id=$3', bot.nickname||bot.username, JSON.stringify(cleansed), req.params.botId);
  }
  io.to(`user:${req.params.botId}`).emit('bot_release', { botId: req.params.botId, version, note });
  res.json({ ok:true, released: { id: relId, version: version || 'v'+new Date().toISOString().slice(0,10), note, servers: installs.length } });
}));

// Release history for a bot (any included author can read).
app.get('/api/servers/:communityId/bots/:botId/releases', auth, route(async (req,res) => {
  const bot = await store.get('SELECT id FROM users WHERE id=$1 AND is_bot=1', req.params.botId);
  if (!bot) return res.status(404).json({error:'Bot not found'});
  res.json(await store.all(`SELECT r.*, u.username AS released_name FROM bot_releases r LEFT JOIN users u ON u.id=r.released_by WHERE r.bot_id=$1 ORDER BY r.released_at DESC LIMIT 50`, req.params.botId));
}));

app.patch('/api/servers/:communityId/bots/:botId/settings', auth, route(async (req,res) => {
  if (!(await canManageServer(req, req.params.communityId))) return res.status(403).json({error:'Server admins only'});
  const bot = await store.get('SELECT * FROM users WHERE id=$1 AND is_bot=1', req.params.botId);
  if (!bot) return res.status(404).json({error:'Bot not found'});
  const mem = await store.get('SELECT 1 FROM memberships WHERE community_id=$1 AND user_id=$2', req.params.communityId, req.params.botId);
  if (!mem) return res.status(404).json({error:'Bot is not installed in this server'});
  const existing = await store.get('SELECT * FROM bot_settings WHERE community_id=$1 AND bot_id=$2', req.params.communityId, req.params.botId);
  const enabled = req.body.enabled !== undefined ? (req.body.enabled ? 1 : 0) : (existing ? Number(existing.enabled) : 1);
  const allowed = Array.isArray(req.body.allowedChannels) ? req.body.allowedChannels.map(String).slice(0,200) : null;
  const allowedJson = allowed !== null ? JSON.stringify(allowed) : (existing ? existing.allowed_channels : '[]');
  const triggerRoles = Array.isArray(req.body.triggerRoles) ? req.body.triggerRoles.map(String).slice(0,200) : null;
  const triggerJson = triggerRoles !== null ? JSON.stringify(triggerRoles) : (existing ? existing.trigger_roles : '[]');
  const blockedRoles = Array.isArray(req.body.blockedRoles) ? req.body.blockedRoles.map(String).slice(0,200) : null;
  const blockedJson = blockedRoles !== null ? JSON.stringify(blockedRoles) : (existing ? existing.blocked_roles : '[]');
  if (existing) {
    if (req.body.humanize !== undefined) {
    await store.run('UPDATE bot_settings SET humanize=$1 WHERE community_id=$2 AND bot_id=$3', Number(req.body.humanize)?1:0, req.params.communityId, req.params.botId);
  }
  await store.run('UPDATE bot_settings SET enabled=$1, allowed_channels=$2, trigger_roles=$3, blocked_roles=$4 WHERE community_id=$5 AND bot_id=$6', enabled, allowedJson, triggerJson, blockedJson, req.params.communityId, req.params.botId);
  } else {
    await store.run('INSERT INTO bot_settings (community_id,bot_id,enabled,allowed_channels,trigger_roles,blocked_roles) VALUES (?,?,?,?,?,?)', req.params.communityId, req.params.botId, enabled, allowedJson, triggerJson, blockedJson);
  }
  res.json({ ok:true, enabled, allowedChannels: JSON.parse(allowedJson), triggerRoles: JSON.parse(triggerJson), blockedRoles: JSON.parse(blockedJson) });
}));

async function canManageServer(req, communityId) {
  const mem = await store.get('SELECT * FROM memberships WHERE community_id=$1 AND user_id=$2', communityId, req.user.id);
  return req.user.is_admin || (mem && ['owner','admin'].includes(mem.role));
}

app.post('/api/servers/:communityId/bots/install', auth, route(async (req,res) => {
  const comm = await store.get('SELECT id,name FROM communities WHERE id=$1', req.params.communityId);
  if (!comm) return res.status(404).json({error:'Server not found'});
  if (!(await canManageServer(req, req.params.communityId))) return res.status(403).json({error:'Server admins only'});
  let tpl = BOT_TEMPLATES.find(t => t.id === req.body.templateId);
  if (!tpl) {
    // Marketplace-published custom bot
    const pb = await store.get('SELECT * FROM marketplace_bots WHERE id=$1', req.body.templateId);
    if (pb) {
      let commands = [];
      try { commands = JSON.parse(pb.commands||'[]'); } catch { commands = []; }
      tpl = { id:pb.id, emoji:pb.emoji, name:pb.name, category:pb.category, desc:pb.description, commands };
    }
  }
  if (!tpl) return res.status(404).json({error:'Template not found'});
  const already = await store.get(`SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.community_id=$1 AND u.is_bot=1 AND u.nickname=$2`, req.params.communityId, tpl.name);
  if (already) return res.status(409).json({error:`${tpl.name} is already installed in ${comm.name}`});
  const id = nanoid();
  const username = `${tpl.id}_${nanoid(4).toLowerCase()}`;
  await store.run('INSERT INTO users (id,username,tag,password_hash,nickname,is_bot,bot_token) VALUES (?,?,?,?,?,1,?)',
    id, username, 'bot', bcrypt.hashSync(nanoid(16),10), tpl.name, nanoid(32));
  await store.run('INSERT INTO user_settings (user_id) VALUES (?) ON CONFLICT DO NOTHING', id);
  await store.run('INSERT INTO memberships VALUES (?,?,?,?,0)', req.params.communityId, id, 'bot', null);
  await store.run('INSERT INTO bot_settings (community_id,bot_id,enabled,allowed_channels) VALUES (?,?,1,\'[]\')', req.params.communityId, id);
  for (const c of tpl.commands) {
    await store.run('INSERT INTO bot_commands (id,bot_id,command,description,response,community_id,created_at) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)',
      nanoid(), id, c.command, c.description, c.response, req.params.communityId);
  }
  if (req.body.templateId !== tpl.id || !BOT_TEMPLATES.some(t => t.id === req.body.templateId)) {
    await store.run('UPDATE marketplace_bots SET installs=installs+1 WHERE id=$1', req.body.templateId).catch(()=>{});
  }
  io.emit('user_update', publicUser(await store.get('SELECT * FROM users WHERE id=$1', id)));
  res.json({ ok:true, bot: { id, username, nickname: tpl.name, emoji: tpl.emoji } });
}));

app.delete('/api/servers/:communityId/bots/:botId', auth, route(async (req,res) => {
  if (!(await canManageServer(req, req.params.communityId))) return res.status(403).json({error:'Server admins only'});
  await store.run('DELETE FROM memberships WHERE community_id=$1 AND user_id=$2', req.params.communityId, req.params.botId);
  await store.run('DELETE FROM bot_commands WHERE bot_id=$1 AND community_id=$2', req.params.botId, req.params.communityId);
  res.json({ok:true});
}));

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err,_req,res,_next) => { console.error(err); res.status(500).json({error:'Internal server error'}); });

// ── Socket.IO ─────────────────────────────────────────────────────────────────
const server = http.createServer(app);
const socketOrigins = corsOrigin;
const io = new Server(server, {
  cors: { origin: socketOrigins },
  // WebSocket-only transport avoids requiring sticky sessions when several
  // instances sit behind Render's load balancer.
  transports: ['websocket'],
});
io.adapter(createAdapter(pool, {
  errorHandler: error => console.error('Socket.IO PostgreSQL adapter error:', error),
}));
io.use(async (socket, next) => {
  try {
    const rawToken = socket.handshake.auth?.token;
    if (!rawToken) throw new Error('Authentication required');
    const user = await sessions.resolve(rawToken);
    socket.data.user = user;
    next();
  } catch {
    next(new Error('Authentication required'));
  }
});

// DB-backed presence snapshot: id + status for every visible user. Reading the
// users table (not local memory) means a snapshot reflects the truth even when
// a `user_update` broadcast was missed or the change happened on another app
// instance — each instance serves its own sockets but shares one database.
async function presenceSnapshot() {
  return store.all('SELECT id,status,custom_status FROM users WHERE banned=0');
}

function sendPresence(socket) {
  presenceSnapshot().then(list => socket.emit('presence_sync', list)).catch(() => {});
}

// Temp-room membership cleanup with a grace period. When a socket dies without
// sending `room_leave` (tab closed, crash, network drop) its room_members row is
// deleted — and remaining members are told — after ROOM_LEAVE_GRACE_MS, UNLESS
// the user reconnects first (re-emitting `room_join` cancels the pending removal).
// A grace is required here (unlike voice rooms, which the mesh re-joins on
// reconnect) because a plain network blip must not drop an active member, and
// the member list is DB-backed: there is no live "this user left" signal to
// recover from otherwise.
const ROOM_LEAVE_GRACE_MS = Math.max(1000, Number(process.env.ROOM_LEAVE_GRACE_MS) || 30000);
const roomLeaveTimers = new Map(); // `${roomId}|${userId}` -> timeout handle
function cancelRoomLeaveTimer(roomId, userId) {
  const key = `${roomId}|${userId}`;
  const t = roomLeaveTimers.get(key);
  if (t) { clearTimeout(t); roomLeaveTimers.delete(key); }
}

io.on('connection', socket => {
  const userId = socket.data.user.id;
  socket.on('join', async id => {
    if (typeof id !== 'string' || id.length > 128) return;
    try {
      const channel = await store.get('SELECT community_id FROM channels WHERE id=$1', id);
      if (!channel) return;
      const member = await store.get('SELECT 1 FROM memberships WHERE community_id=$1 AND user_id=$2', channel.community_id, userId);
      if (member || socket.data.user.is_admin) socket.join(id);
    } catch {}
  });
  socket.on('join_dm', async id => {
    if (typeof id !== 'string' || id.length > 128) return;
    try {
      const dm = await store.get('SELECT 1 FROM dms WHERE id=$1 AND (user_a=$2 OR user_b=$2)', id, userId);
      if (dm) socket.join(`dm:${id}`);
    } catch {}
  });
  socket.on('join_user', id => {
    if (!id || String(id) === String(userId)) socket.join(`user:${userId}`);
  });
  socket.on('join_group', async id => {
    if (typeof id !== 'string' || id.length > 128) return;
    try {
      const member = await store.get('SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2', id, userId);
      if (member) socket.join(`group:${id}`);
    } catch {}
  });
  socket.on('join_community', async id => {
    if (typeof id !== 'string' || id.length > 128) return;
    try {
      const member = await store.get('SELECT 1 FROM memberships WHERE community_id=$1 AND user_id=$2', id, userId);
      if (member || socket.data.user.is_admin) socket.join(id);
    } catch {}
  });

  socket.on('typing', data => {
    if (!data || typeof data !== 'object') return;
    if (typeof data.channelId === 'string' && data.channelId.length <= 128 && socket.rooms.has(data.channelId)) socket.to(data.channelId).emit('typing', data);
    if (typeof data.dmId === 'string' && data.dmId.length <= 128 && socket.rooms.has(`dm:${data.dmId}`)) socket.to(`dm:${data.dmId}`).emit('typing', data);
    if (typeof data.groupId === 'string' && data.groupId.length <= 128 && socket.rooms.has(`group:${data.groupId}`)) socket.to(`group:${data.groupId}`).emit('typing', data);
  });

  // ── Voice: real WebRTC mesh (members hear/see each other). Presence events
  // ride the same rooms; signaling (offer/answer/ice) is relayed point-to-point
  // to a specific socket. Because Socket.IO runs on a shared PostgreSQL adapter,
  // the `voice:` rooms and socket ids are global across app instances, so two
  // users connected to different servers still negotiate a direct peer link.
  function voicePeerPayload(u) {
    if (!u) return null;
    return {
      userId:   u.id ?? u.userId,
      username: u.username ?? '',
      nickname: u.nickname ?? '',
      avatar:   u.avatar ?? '',
      badge:    u.badge ?? '',
    };
  }

  // Live roster for a voice room: every connected socket (any instance) with the
  // profile + socket id a new joiner needs to start the peer connections.
  async function voiceRoomUsers(roomName, exceptSocketId) {
    try {
      const socks = await io.in(roomName).fetchSockets();
      return socks
        .filter(s => s.id !== exceptSocketId && s.data?.user)
        .map(s => ({ ...voicePeerPayload(s.data.user), socketId: s.id }))
        .filter(u => u.userId);
    } catch { return []; }
  }

  socket.on('voice_join', async data => {
    const channelId = data?.channelId;
    if (typeof channelId !== 'string' || channelId.length > 128) return;
    let member = await store.get('SELECT 1 FROM memberships m JOIN channels c ON c.community_id=m.community_id WHERE c.id=$1 AND m.user_id=$2', channelId, userId).catch(() => null);
    if (!member) {
      member = await store.get('SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2 AND waiting=0', channelId, userId).catch(() => null);
    }
    if (!member && !socket.data.user.is_admin) return;
    const roomName = `voice:${channelId}`;
    socket.join(roomName);
    try {
      await store.run('DELETE FROM voice_sessions WHERE channel_id=$1 AND user_id=$2', channelId, userId);
      await store.run('INSERT INTO voice_sessions VALUES (?,?,?,CURRENT_TIMESTAMP)', nanoid(), channelId, userId);
    } catch {}
    const profile = voicePeerPayload(socket.data.user) || { userId };
    // Existing members: a new socket joined (id + profile) so they can connect to it.
    socket.to(roomName).emit('voice_user_joined', { channelId, ...profile, socketId: socket.id });
    // The joiner: the full current roster (cross-instance via the shared adapter).
    const users = await voiceRoomUsers(roomName, socket.id);
    socket.emit('voice_roster', { channelId, users });
    io.to(roomName).emit('voice_state', { channelId, userId, joined: true });
  });

  socket.on('voice_leave', async data => {
    const channelId = data?.channelId;
    if (typeof channelId !== 'string' || channelId.length > 128 || !socket.rooms.has(`voice:${channelId}`)) return;
    const roomName = `voice:${channelId}`;
    socket.leave(roomName);
    try { await store.run('DELETE FROM voice_sessions WHERE channel_id=$1 AND user_id=$2', channelId, userId); } catch {}
    socket.to(roomName).emit('voice_user_left', { channelId, userId, socketId: socket.id });
    io.to(roomName).emit('voice_state', { channelId, userId, joined: false });
  });

  // Camera on/off state for video rooms. Members just broadcast their own
  // state; peers hide the frozen video and show a placeholder instead.
  socket.on('voice_camera', data => {
    const channelId = data?.channelId;
    if (typeof channelId !== 'string' || channelId.length > 128 || !socket.rooms.has(`voice:${channelId}`)) return;
    socket.to(`voice:${channelId}`).emit('voice_camera', { channelId, userId, on: data.on === true });
  });

  // Mesh signaling. The sender must currently be a member of that voice room;
  // the target socket id comes from the roster this server handed out, so a
  // client can only ever talk to sockets it was told are in the same room.
  const relayVoiceSignal = (event, data) => {
    const channelId = data?.channelId;
    const toSocketId = data?.toSocketId;
    if (typeof channelId !== 'string' || channelId.length > 128 || !socket.rooms.has(`voice:${channelId}`)) return;
    if (typeof toSocketId !== 'string' || toSocketId.length > 64) return;
    const payload = { channelId, fromUserId: userId, fromSocketId: socket.id };
    if (event === 'voice_rtc_ice') {
      if (!data.candidate || typeof data.candidate !== 'object') return;
      payload.candidate = data.candidate;
    } else {
      if (!data.sdp || typeof data.sdp !== 'object') return;
      payload.sdp = data.sdp;
    }
    io.to(toSocketId).emit(event, payload);
  };
  socket.on('voice_rtc_offer',  d => relayVoiceSignal('voice_rtc_offer', d));
  socket.on('voice_rtc_answer', d => relayVoiceSignal('voice_rtc_answer', d));
  socket.on('voice_rtc_ice',    d => relayVoiceSignal('voice_rtc_ice', d));

  // Temporary rooms
  socket.on('room_join', async d => {
    const roomId = typeof d === 'string' ? d : d?.roomId;
    if (typeof roomId !== 'string' || roomId.length > 128) return;
    try {
      cancelRoomLeaveTimer(roomId, userId);
      const member = await store.get('SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2', roomId, userId);
      if (member || socket.data.user.is_admin) socket.join(`room:${roomId}`);
    } catch {}
  });
  socket.on('room_leave', d => {
    const roomId = typeof d === 'string' ? d : d?.roomId;
    if (typeof roomId !== 'string' || roomId.length > 128) return;
    const roomName = `room:${roomId}`;
    if (!socket.rooms.has(roomName)) return;
    cancelRoomLeaveTimer(roomId, userId);
    socket.leave(roomName);
    store.run('DELETE FROM room_members WHERE room_id=$1 AND user_id=$2', roomId, userId).catch(()=>{});
    io.to(roomName).emit('room_presence', { action:'left', userId });
  });
  // Drawing strokes (fire-and-forget broadcast to the room)
  socket.on('room_draw', d => {
    if (typeof d?.roomId !== 'string' || !socket.rooms.has(`room:${d.roomId}`)) return;
    socket.to(`room:${d.roomId}`).emit('room_draw', d);
  });
  // Watch-together sync (URL, playing state, current time)
  socket.on('room_watch', d => {
    if (typeof d?.roomId !== 'string' || !socket.rooms.has(`room:${d.roomId}`)) return;
    socket.to(`room:${d.roomId}`).emit('room_watch', d);
  });
  // Collab text sync (debounced on the client)
  socket.on('room_collab', d => {
    if (typeof d?.roomId !== 'string' || !socket.rooms.has(`room:${d.roomId}`)) return;
    socket.to(`room:${d.roomId}`).emit('room_collab', d);
  });
  // Raise hand / speaker queue
  socket.on('room_raise', d => {
    if (typeof d?.roomId !== 'string' || !socket.rooms.has(`room:${d.roomId}`)) return;
    socket.to(`room:${d.roomId}`).emit('room_raise', { roomId:d.roomId, userId });
  });

  async function callPeerIsAuthorized(data) {
    if (!data || typeof data.toUserId !== 'string' || data.toUserId.length > 128) return false;
    if (!data.dmId || typeof data.dmId !== 'string' || data.dmId.length > 128) return false;
    if (data.toUserId === userId) return false;
    const dm = await store.get(
      'SELECT 1 FROM dms WHERE id=$1 AND ((user_a=$2 AND user_b=$3) OR (user_a=$3 AND user_b=$2))',
      data.dmId,
      userId,
      data.toUserId,
    ).catch(() => null);
    return Boolean(dm);
  }

  // Route WebRTC signaling through authenticated user rooms. User IDs work across
  // instances; raw socket IDs are local to one server and are not trusted targets.
  const relayToUser = async (event, data) => {
    if (!(await callPeerIsAuthorized(data))) return;
    socket.to(`user:${data.toUserId}`).emit(event, { ...data, from:userId });
  };
  socket.on('rtc_offer',  d => relayToUser('rtc_offer', d));
  socket.on('rtc_answer', d => relayToUser('rtc_answer', d));
  socket.on('rtc_ice',    d => relayToUser('rtc_ice', d));
  // Mic mute state for DM calls — the receiver shows a true “muted” chip instead
  // of guessing from silence. Same DM-auth + user-room routing as the other
  // call signals, so it works across app instances.
  socket.on('call_mute',   d => relayToUser('call_mute', d));
  // Camera on/off state for DM calls — lets the peer swap the video for a
  // “camera off” placeholder instead of a frozen last frame. Same DM-auth +
  // user-room routing as the other call signals.
  socket.on('call_camera', d => relayToUser('call_camera', d));

  // Screen share is restricted to an authenticated voice room membership.
  const relayScreenShare = (event, data) => {
    const channelId = data?.channelId;
    if (typeof channelId !== 'string' || channelId.length > 128 || !socket.rooms.has(`voice:${channelId}`)) return;
    socket.to(`voice:${channelId}`).emit(event, { ...data, from:userId });
  };
  socket.on('screen_share_start', d => relayScreenShare('screen_share_start', d));
  socket.on('screen_share_stop', d => relayScreenShare('screen_share_stop', d));
  socket.on('screen_control_request', d => relayToUser('screen_control_request', d));
  socket.on('screen_control_granted', d => relayToUser('screen_control_granted', d));

  // Personal calls require a DM relationship and are routed through the other
  // participant's private room, including when that participant is on another instance.
  socket.on('call_invite', async d => {
    if (!(await callPeerIsAuthorized(d))) return;
    socket.to(`user:${d.toUserId}`).emit('call_invite', { ...d, from:userId, fromUsername:socket.data.user.username });
  });
  socket.on('call_accept',  d => relayToUser('call_accept', d));
  socket.on('call_decline', d => relayToUser('call_decline', d));
  socket.on('call_end',     d => relayToUser('call_end', d));
  // Presence heartbeat: the client asks for the current DB-backed snapshot so
  // statuses converge even when individual `user_update` events were missed (or
  // happened on another instance). The same snapshot is pushed on connect below.
  socket.on('presence_heartbeat', () => sendPresence(socket));

  // "disconnecting" fires BEFORE socket.io cleans up socket.rooms (unlike
  // "disconnect", where rooms are already empty) — so this is the only place
  // we can still tell which voice rooms the socket was in and tell peers to
  // tear down their peer connection instead of showing a ghost tile.
  socket.on('disconnecting', () => {
    for (const roomName of socket.rooms) {
      if (roomName.startsWith('voice:')) {
        const channelId = roomName.slice('voice:'.length);
        socket.to(roomName).emit('voice_user_left', { channelId, userId, socketId: socket.id });
        io.to(roomName).emit('voice_state', { channelId, userId, joined: false });
        continue;
      }
      if (!roomName.startsWith('room:')) continue;
      // Abrupt disconnect from a temp room: schedule membership cleanup unless
      // the user reconnects within the grace window (room_join cancels it).
      const roomId = roomName.slice('room:'.length);
      const key = `${roomId}|${userId}`;
      if (roomLeaveTimers.has(key)) continue; // another of this user's sockets already pending
      const timer = setTimeout(async () => {
        roomLeaveTimers.delete(key);
        try {
          await store.run('DELETE FROM room_members WHERE room_id=$1 AND user_id=$2', roomId, userId);
        } catch {}
        io.to(`room:${roomId}`).emit('room_presence', { action: 'left', userId });
      }, ROOM_LEAVE_GRACE_MS);
      roomLeaveTimers.set(key, timer);
    }
  });
  socket.on('disconnect', () => {
    store.run('DELETE FROM voice_sessions WHERE user_id=$1', userId).catch(() => {});
  });

  // Send the current presence right after connecting (and after every reconnect),
  // so a client never has to wait for the next event or heartbeat to converge.
  sendPresence(socket);
});

// ── FTD ARG ───────────────────────────────────────────────────────────────────
// Award the FTD badge once a user completes the ARG. One-time per user.
app.get('/api/arg/status', auth, route(async (req,res) => {
  const done = await store.get('SELECT * FROM arg_completions WHERE user_id=$1', req.user.id);
  res.json({ completed: !!done });
}));

app.post('/api/arg/award', auth, route(async (req,res) => {
  const existing = await store.get('SELECT * FROM arg_completions WHERE user_id=$1', req.user.id);
  if (existing) return res.json({ awarded:false, already:true, badge:'FTD' });
  const u = await store.get('SELECT * FROM users WHERE id=$1', req.user.id);
  if (!u) return res.status(404).json({error:'Not found'});
  await store.run('INSERT INTO arg_completions (user_id) VALUES (?)', req.user.id);
  // Award the FTD badge (append if they already have a badge like Knowns)
  const current = (u.badge || '').split(',').map(s=>s.trim()).filter(Boolean);
  if (!current.includes('FTD')) current.push('FTD');
  const newBadge = current.join(',');
  await store.run('UPDATE users SET badge=$1 WHERE id=$2', newBadge, req.user.id);
  const fresh = await store.get('SELECT * FROM users WHERE id=$1', req.user.id);
  io.to(`user:${req.user.id}`).emit('user_update', publicUser(fresh));
  res.json({ awarded:true, badge:newBadge });
}));

// ── Static ────────────────────────────────────────────────────────────────────
if (fs.existsSync(path.join(root, 'dist'))) {
  app.use(express.static(path.join(root, 'dist')));
  app.use((req,res,next) => { if(req.path.startsWith('/api/')) return next(); res.sendFile(path.join(root,'dist','index.html')); });
}

server.listen(PORT, process.env.HOST || '0.0.0.0', () => console.log(`Unknown running on ${PORT}`));
export { app, store };