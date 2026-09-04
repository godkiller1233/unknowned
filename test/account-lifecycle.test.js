import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { io as createSocket } from 'socket.io-client';
import {
  isPgReachable,
  startDisposableServer,
  waitForEvent,
  sleep,
  APP_ROOT,
} from './helpers/disposable-server.js';

const UPLOADS_DIR = path.join(APP_ROOT, 'uploads');

function seeded(uploadName) {
  const abs = path.join(UPLOADS_DIR, uploadName);
  fs.writeFileSync(abs, Buffer.from('staging file for account-lifecycle tests'));
  return abs;
}

test('account export: JSON archive covers everything the account owns', { timeout: 120000 }, async t => {
  if (!(await isPgReachable())) {
    t.skip('PostgreSQL not reachable - set TEST_PG_ADMIN_URL to run integration tests');
    return;
  }
  const srv = await startDisposableServer();
  t.after(() => srv.stop());
  try {
    const { api, admin } = srv;
    const stamp = Date.now().toString(36).slice(-6);

    const a = await api('/api/register', null, { method: 'POST', body: { username: `ex_a_${stamp}`, password: 'export-pass-1' } });
    const b = await api('/api/register', null, { method: 'POST', body: { username: `ex_b_${stamp}`, password: 'export-pass-2' } });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const aid = a.user.id;

    // Profile fields.
    await api('/api/profile', a.token, { method: 'PATCH', body: { nickname: 'Exporter', bio: 'my archive should include this' } });

    // DM + messages (channel and DM).
    const bootA = await api('/api/bootstrap', a.token);
    const channel = bootA.channels && bootA.channels.find(c => c.community_id === (bootA.memberships[0] && bootA.memberships[0].community_id));
    assert.ok(channel, 'expected a default community channel to message into');
    const chanMsg = await api('/api/messages', a.token, { method: 'POST', body: { channelId: channel.id, body: 'channel hello from exporter' } });
    assert.equal(chanMsg.status, 200);
    const dmRes = await api('/api/dms', a.token, { method: 'POST', body: { userId: b.user.id } });
    assert.equal(dmRes.status, 200);
    const dm = dmRes.dm || dmRes;
    const dmMsg = await api('/api/messages', a.token, { method: 'POST', body: { dmId: dm.id, body: 'dm hello from exporter', attachment: '/uploads/nope.png' } });
    assert.equal(dmMsg.status, 200);

    // Data that has no REST surface yet - insert rows directly so the export
    // proves the query layers, not just the happy-path endpoints.
    await admin.query(
      "INSERT INTO quest_logs (user_id, quest, day, reward) VALUES ($1, 'share_vision', '2099-01-01', 5) ON CONFLICT DO NOTHING",
      [aid]);
    await admin.query(
      "INSERT INTO anonymous_identities (id, user_id, mask_name, mask_color, mask_emoji, active) VALUES ('anon-export-1', $1, 'Void Runner', '#5865f2', '\\\\u{1F30C}', 1)",
      [aid]);
    await admin.query(
      "INSERT INTO notifications (id, user_id, type, source_id, source_type, body) VALUES ('notif-export-1', $1, 'dm', 'm1', 'dm', 'export me')",
      [aid]);
    await admin.query(
      "INSERT INTO bookmarks (user_id, message_id, folder) VALUES ($1, $2, 'Important')",
      [aid, dmMsg.id || dmMsg.message?.id]);
    await admin.query(
      "INSERT INTO friends (id, requester_id, addressee_id, status) VALUES ('fr-export-1', $1, $2, 'accepted')",
      [aid, b.user.id]);
    await admin.query(
      "INSERT INTO gift_logs (id, from_id, to_id, amount, day) VALUES ('gift-export-1', $1, $2, 10, '2099-01-01')",
      [aid, b.user.id]);

    // Unauthenticated export is rejected.
    const noAuth = await api('/api/me/export', null);
    assert.equal(noAuth.status, 401);

    const ex = await api('/api/me/export', a.token);
    assert.equal(ex.status, 200, JSON.stringify(ex).slice(0, 300));
    assert.equal(ex.account.username, a.user.username);
    assert.equal(ex.account.nickname, 'Exporter');
    assert.ok(ex.counts.memberships >= 1, 'membership auto-join present');
    assert.ok(ex.messages.length >= 2, 'channel + dm messages exported');
    assert.equal(ex.dms.length, 1, 'dm row exported');
    assert.equal(ex.questLogs.length, 1, 'quest log exported');
    assert.equal(ex.anonymousIdentities.length, 1, 'anonymous identity exported');
    assert.ok(ex.notifications.length >= 1, 'notification exported');
    assert.equal(ex.friends.length, 1, 'friend exported');
    assert.equal(ex.bookmarks.length, 1, 'bookmark exported');
    assert.equal(ex.giftLogs.length, 1, 'gift log exported');
    const raw = JSON.stringify(ex);
    assert.ok(!raw.includes('password_hash'), 'export must never contain the password hash');
    assert.ok(!raw.includes('bot_token'), 'export must never contain bot tokens');
  } finally {
    try { fs.rmSync(path.join(UPLOADS_DIR, 'nope.png'), { force: true }); } catch {}
  }
});

test('account deletion: password guard, then a safe cascade with moderation-log retention', { timeout: 120000 }, async t => {
  if (!(await isPgReachable())) {
    t.skip('PostgreSQL not reachable - set TEST_PG_ADMIN_URL to run integration tests');
    return;
  }
  const srv = await startDisposableServer();
  t.after(() => srv.stop());
  const socks = [];
  const createdFiles = [];
  try {
    const { api, admin, base } = srv;
    const stamp = Date.now().toString(36).slice(-6);

    const a = await api('/api/register', null, { method: 'POST', body: { username: `del_a_${stamp}`, password: 'delete-pass-1' } });
    const b = await api('/api/register', null, { method: 'POST', body: { username: `del_b_${stamp}`, password: 'delete-pass-2' } });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const aid = a.user.id;
    const bid = b.user.id;

    // Admin accounts cannot self-delete through the app.
    const adminLogin = await api('/api/login', null, { method: 'POST', body: { username: 'TestAdmin', password: 'test-admin-pass-1' } });
    assert.equal(adminLogin.status, 200);
    const adminDel = await api('/api/me', adminLogin.token, { method: 'DELETE', body: { password: 'test-admin-pass-1' } });
    assert.equal(adminDel.status, 403, 'platform admin must be protected');

    const bootA = await api('/api/bootstrap', a.token);
    const channel = bootA.channels.find(c => c.community_id === (bootA.memberships[0] && bootA.memberships[0].community_id));
    assert.ok(channel);

    // Real uploads referenced by profile + a DM attachment.
    const avFile = `av_${stamp}.png`;
    const msgFile = `msg_${stamp}.png`;
    createdFiles.push(seeded(avFile), seeded(msgFile));
    await api('/api/profile', a.token, { method: 'PATCH', body: { avatar: '/uploads/' + avFile } });

    const dmRes = await api('/api/dms', a.token, { method: 'POST', body: { userId: bid } });
    const dm = dmRes.dm || dmRes;
    const dmMsg = await api('/api/messages', a.token, { method: 'POST', body: { dmId: dm.id, body: 'peer says hi', attachment: '/uploads/' + msgFile } });
    assert.equal(dmMsg.status, 200);
    const chanMsg = await api('/api/messages', a.token, { method: 'POST', body: { channelId: channel.id, body: 'channel post by A' } });
    assert.equal(chanMsg.status, 200);
    // B also speaks inside the DM, then the DM is shared history.
    await api('/api/messages', b.token, { method: 'POST', body: { dmId: dm.id, body: 'B side of the thread' } });

    // Direct-row data to assert the cascade.
    await admin.query("INSERT INTO quest_logs (user_id, quest, day, reward) VALUES ($1, 'daily_visit', '2099-02-02', 3) ON CONFLICT DO NOTHING", [aid]);
    await admin.query("INSERT INTO anonymous_identities (id, user_id, mask_name) VALUES ('anon-del-1', $1, 'Static Echo')", [aid]);
    await admin.query("INSERT INTO notifications (id, user_id, type, body) VALUES ('notif-del-1', $1, 'ping', 'ping me')", [aid]);
    await admin.query("INSERT INTO user_settings (user_id, chat_bg) VALUES ($1, 'dots') ON CONFLICT (user_id) DO UPDATE SET chat_bg='dots'", [aid]);
    await admin.query("INSERT INTO friends (id, requester_id, addressee_id, status) VALUES ('fr-del-1', $1, $2, 'accepted')", [aid, bid]);
    await admin.query("INSERT INTO friends (id, requester_id, addressee_id, status) VALUES ('fr-del-2', $2, $1, 'pending')", [aid, bid]);
    await admin.query("INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)", [aid, bid]);
    await admin.query("INSERT INTO gift_logs (id, from_id, to_id, amount, day) VALUES ('gift-del-1', $1, $2, 5, '2099-03-03')", [aid, bid]);

    // B holds a live socket: it must learn about the deletion in real time.
    const sockB = createSocket(base, { auth: { token: b.token }, transports: ['websocket'], reconnection: false });
    socks.push(sockB);
    await new Promise((res, rej) => { sockB.once('connect', res); sockB.once('connect_error', rej); });
    const gotDeleted = waitForEvent(sockB, 'account_deleted', 6000, d => d && d.userId === aid);

    // Wrong password: nothing may change.
    const wrong = await api('/api/me', a.token, { method: 'DELETE', body: { password: 'not-the-password' } });
    assert.equal(wrong.status, 401);
    assert.equal((await admin.query('SELECT COUNT(*) AS c FROM users WHERE id=$1', [aid])).rows[0].c, '1');
    assert.ok(fs.existsSync(path.join(UPLOADS_DIR, avFile)), 'file untouched after wrong password');

    // Correct password: account + cascade.
    const del = await api('/api/me', a.token, { method: 'DELETE', body: { password: 'delete-pass-1' } });
    assert.equal(del.status, 200, JSON.stringify(del).slice(0, 400));
    assert.equal(del.deleted, true);
    assert.ok(del.summary.messages >= 3, 'own + closed-DM-thread messages removed');
    assert.ok(del.summary.dms >= 1);
    assert.ok(del.summary.questLogs >= 1);
    assert.ok(del.summary.anonymousIdentities >= 1);

    // B's socket hears about it (cross-instance broadcast path).
    const ev = await gotDeleted;
    assert.equal(ev.userId, aid);

    // File removal happened only after commit.
    assert.ok(!fs.existsSync(path.join(UPLOADS_DIR, avFile)), 'avatar file removed');
    assert.ok(!fs.existsSync(path.join(UPLOADS_DIR, msgFile)), 'dm attachment file removed');

    // Direct DB truth for the cascade.
    assert.equal((await admin.query('SELECT COUNT(*) AS c FROM users WHERE id=$1', [aid])).rows[0].c, '0', 'user row gone');
    assert.equal((await admin.query('SELECT COUNT(*) AS c FROM auth_sessions WHERE user_id=$1', [aid])).rows[0].c, '0', 'sessions gone');
    assert.equal((await admin.query('SELECT COUNT(*) AS c FROM messages WHERE sender_id=$1', [aid])).rows[0].c, '0', 'authored messages gone');
    assert.equal((await admin.query('SELECT COUNT(*) AS c FROM messages WHERE dm_id=$1', [dm.id])).rows[0].c, '0', 'closed dm thread fully removed');
    assert.equal((await admin.query('SELECT COUNT(*) AS c FROM dms WHERE id=$1', [dm.id])).rows[0].c, '0', 'dm row gone');
    assert.equal((await admin.query('SELECT COUNT(*) AS c FROM memberships WHERE user_id=$1', [aid])).rows[0].c, '0', 'memberships gone');
    assert.equal((await admin.query('SELECT COUNT(*) AS c FROM quest_logs WHERE user_id=$1', [aid])).rows[0].c, '0', 'quest logs gone');
    assert.equal((await admin.query('SELECT COUNT(*) AS c FROM anonymous_identities WHERE user_id=$1', [aid])).rows[0].c, '0', 'anon identities gone');
    assert.equal((await admin.query('SELECT COUNT(*) AS c FROM notifications WHERE user_id=$1', [aid])).rows[0].c, '0', 'notifications gone');
    assert.equal((await admin.query('SELECT COUNT(*) AS c FROM user_settings WHERE user_id=$1', [aid])).rows[0].c, '0', 'settings gone');
    assert.equal((await admin.query('SELECT COUNT(*) AS c FROM friends WHERE requester_id=$1 OR addressee_id=$1', [aid])).rows[0].c, '0', 'friendships gone');
    assert.equal((await admin.query('SELECT COUNT(*) AS c FROM blocks WHERE blocker_id=$1 OR blocked_id=$1', [aid])).rows[0].c, '0', 'blocks gone');

    // Moderation + economy records survive (nulled, not deleted).
    const logs = (await admin.query("SELECT COUNT(*) AS c FROM moderation_logs WHERE actor_id=$1 AND action='account_self_deleted'", [aid])).rows[0].c;
    assert.ok(Number(logs) >= 1, 'self-deletion audit record retained');
    const gift = (await admin.query('SELECT from_id FROM gift_logs WHERE id=$1', ['gift-del-1'])).rows[0];
    assert.equal(gift.from_id, null, 'gift log kept with sender nulled');

    // The deleted user cannot log in or reuse the token; B is untouched.
    const relogin = await api('/api/login', null, { method: 'POST', body: { username: `del_a_${stamp}`, password: 'delete-pass-1' } });
    assert.equal(relogin.status, 401, 'login must fail after deletion');
    const staleBoot = await api('/api/bootstrap', a.token);
    assert.equal(staleBoot.status, 401, 'old token must be dead');
    assert.equal((await admin.query('SELECT COUNT(*) AS c FROM users WHERE id=$1', [bid])).rows[0].c, '1', 'B unaffected');
    assert.ok((await admin.query('SELECT COUNT(*) AS c FROM memberships WHERE user_id=$1', [bid])).rows[0].c >= 1, 'B still a member');
    assert.ok((await admin.query('SELECT COUNT(*) AS c FROM communities')).rows[0].c >= 1, 'community survives');
  } finally {
    socks.forEach(s => { try { s.close?.(); s.destroy?.(); } catch {} });
    for (const f of createdFiles) { try { fs.rmSync(f, { force: true }); } catch {} }
  }
});

test('account deletion: owned communities transfer or are removed', { timeout: 120000 }, async t => {
  if (!(await isPgReachable())) {
    t.skip('PostgreSQL not reachable - set TEST_PG_ADMIN_URL to run integration tests');
    return;
  }
  const srv = await startDisposableServer();
  t.after(() => srv.stop());
  try {
    const { api, admin } = srv;
    const stamp = Date.now().toString(36).slice(-6);

    const a = await api('/api/register', null, { method: 'POST', body: { username: `own_a_${stamp}`, password: 'owner-pass-1' } });
    const b = await api('/api/register', null, { method: 'POST', body: { username: `own_b_${stamp}`, password: 'owner-pass-2' } });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const aid = a.user.id;
    const bid = b.user.id;

    // Community 1: A owns it, B joins -> should transfer to B.
    const c1 = await api('/api/communities', a.token, { method: 'POST', body: { name: `Transfer Town ${stamp}`, visibility: 'public' } });
    assert.equal(c1.status, 200, JSON.stringify(c1).slice(0, 200));
    const joined = await api('/api/communities/join', b.token, { method: 'POST', body: { inviteCode: c1.inviteCode } });
    assert.equal(joined.status, 200);
    const msg1 = await api('/api/messages', a.token, { method: 'POST', body: { channelId: c1.channel.id, body: 'owner note' } });
    assert.equal(msg1.status, 200);

    // Community 2: A owns it and nobody else is inside -> should vanish.
    const c2 = await api('/api/communities', a.token, { method: 'POST', body: { name: `Solo Spot ${stamp}`, visibility: 'public' } });
    assert.equal(c2.status, 200);
    await api('/api/messages', a.token, { method: 'POST', body: { channelId: c2.channel.id, body: 'lonely message' } });

    const del = await api('/api/me', a.token, { method: 'DELETE', body: { password: 'owner-pass-1' } });
    assert.equal(del.status, 200, JSON.stringify(del).slice(0, 400));

    // Community 1 survived and B became the owner.
    const c1row = (await admin.query('SELECT owner_id FROM communities WHERE id=$1', [c1.id])).rows[0];
    assert.ok(c1row, 'transferred community survives');
    assert.equal(c1row.owner_id, bid, 'ownership transferred to remaining member');
    assert.ok((await admin.query('SELECT COUNT(*) AS c FROM channels WHERE community_id=$1', [c1.id])).rows[0].c >= 1, 'community channels intact');

    // Community 2 was deleted with its channel + messages.
    assert.equal((await admin.query('SELECT COUNT(*) AS c FROM communities WHERE id=$1', [c2.id])).rows[0].c, '0', 'empty owned community removed');
    assert.equal((await admin.query('SELECT COUNT(*) AS c FROM channels WHERE community_id=$1', [c2.id])).rows[0].c, '0', 'its channels removed');
    assert.equal((await admin.query('SELECT COUNT(*) AS c FROM messages WHERE channel_id=$1', [c2.channel.id])).rows[0].c, '0', 'its messages removed');
    assert.equal((await admin.query('SELECT COUNT(*) AS c FROM messages WHERE sender_id=$1', [aid])).rows[0].c, '0', 'no authored messages remain anywhere');
  } finally {
    await sleep(50);
  }
});
