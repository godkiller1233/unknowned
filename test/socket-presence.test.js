import test from 'node:test';
import assert from 'node:assert/strict';
import { io as createSocket } from 'socket.io-client';
import {
  isPgReachable,
  startDisposableServer,
  waitForEvent,
  sleep,
} from './helpers/disposable-server.js';

// CI-repeatable coverage for the live socket surface between two real users on a
// disposable database: channel typing, DM typing (same `typing` event carrying
// `dmId`), and presence — a PATCH /api/profile status change must broadcast a
// `user_update` the peer socket receives and persist in PostgreSQL.
const PASSWORD = 'presence-pass-1';

// Resolves with the first matching event payload, or null if none arrives within ms.
function onceOrNull(socket, event, ms, predicate) {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function handler(p) {
      if (predicate && !predicate(p)) return;
      done(p);
    }
    function done(val) {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(val ?? null);
    }
    socket.on(event, handler);
  });
}

async function connect(sock) {
  await new Promise((res, rej) => {
    sock.once('connect', res);
    sock.once('connect_error', rej);
  });
}

test('socket presence & typing: two users, channel + DM, typing and status propagate live', { timeout: 120000 }, async t => {
  if (!(await isPgReachable())) {
    t.skip('PostgreSQL not reachable — set TEST_PG_ADMIN_URL (e.g. a CI postgres service container) to run integration tests');
    return;
  }

  const srv = await startDisposableServer();
  t.after(() => srv.stop());

  // Two real socket sessions shared by the sequential subtests below.
  let a = null;
  let b = null;
  let welcome = null;
  let sockA = null;
  let sockB = null;
  let sockC = null;

  try {
    await t.test('S1: register A and B; channel typing reaches B but not A (no self-echo)', async () => {
      const stamp = Date.now().toString(36).slice(-6);
      const regA = await srv.api('/api/register', null, { method: 'POST', body: { username: `ps_a_${stamp}`, password: PASSWORD } });
      const regB = await srv.api('/api/register', null, { method: 'POST', body: { username: `ps_b_${stamp}`, password: PASSWORD } });
      assert.equal(regA.status, 200, 'register A failed: ' + JSON.stringify(regA));
      assert.equal(regB.status, 200, 'register B failed: ' + JSON.stringify(regB));
      assert.ok(regA.token && regB.token, 'register must return tokens');
      a = regA;
      b = regB;

      const bootA = await srv.api('/api/bootstrap', a.token);
      assert.equal(bootA.memberships.length, 1, 'A must auto-join the default community');
      welcome = bootA.channels.find(c => c.name === 'welcome');
      assert.ok(welcome, 'seeded #welcome channel must exist');

      sockA = createSocket(srv.base, { auth: { token: a.token }, transports: ['websocket'], reconnection: false });
      sockB = createSocket(srv.base, { auth: { token: b.token }, transports: ['websocket'], reconnection: false });
      await Promise.all([connect(sockA), connect(sockB)]);
      sockA.emit('join_user', a.user.id);
      sockB.emit('join_user', b.user.id);
      sockA.emit('join', welcome.id);
      sockB.emit('join', welcome.id);
      await sleep(400);

      // A types in #welcome → B must receive the rebroadcast with A's identity.
      const bTyping = waitForEvent(sockB, 'typing', 8000, d => d.channelId === welcome.id && d.userId === a.user.id);
      sockA.emit('typing', { channelId: welcome.id, userId: a.user.id, username: a.user.username });
      const got = await bTyping;
      assert.equal(got.username, a.user.username, 'typing payload must carry the sender username');

      // Server emits with socket.to(...) — the typing socket itself gets nothing.
      const selfEcho = await onceOrNull(sockA, 'typing', 500);
      assert.equal(selfEcho, null, 'sender must not receive its own typing event');
    });

    await t.test('S2: A opens a DM with B; typing with dmId reaches B but not A', async () => {
      assert.ok(sockA && sockB && a && b, 'S1 must have set up both sessions');

      const dmRes = await srv.api('/api/dms', a.token, { method: 'POST', body: { userId: b.user.id } });
      assert.equal(dmRes.status, 200, 'dm create failed: ' + JSON.stringify(dmRes));
      const dm = dmRes.dm || dmRes;
      assert.ok(dm && dm.id, 'dm response must include an id');

      sockA.emit('join_dm', dm.id);
      sockB.emit('join_dm', dm.id);
      await sleep(300);

      const bDmTyping = waitForEvent(sockB, 'typing', 8000, d => d.dmId === dm.id && d.userId === a.user.id);
      sockA.emit('typing', { dmId: dm.id, userId: a.user.id, username: a.user.username });
      const got = await bDmTyping;
      assert.equal(got.username, a.user.username, 'DM typing payload must carry the sender username');

      const selfEcho = await onceOrNull(sockA, 'typing', 500);
      assert.equal(selfEcho, null, 'sender must not receive its own DM typing event');
    });

    await t.test('S3: status changes broadcast user_update to the peer and persist in PostgreSQL', async () => {
      assert.ok(sockA && b, 'S1 must have set up sessions');

      // B goes Away → A's socket must receive the broadcast user_update.
      const aSeesAway = waitForEvent(sockA, 'user_update', 8000, u => u.id === b.user.id);
      const patch = await srv.api('/api/profile', b.token, { method: 'PATCH', body: { status: 'Away' } });
      assert.equal(patch.status, 200, 'status patch failed: ' + JSON.stringify(patch));
      const awayUpdate = await aSeesAway;
      assert.equal(awayUpdate.status, 'Away', 'peer must learn the new status');

      const dbAway = await srv.admin.query('SELECT status FROM users WHERE id=$1', [b.user.id]);
      assert.equal(dbAway.rows[0].status, 'Away', 'status must persist in the database');

      // B returns Online → A learns that too, and the DB row flips back.
      const aSeesOnline = waitForEvent(sockA, 'user_update', 8000, u => u.id === b.user.id && u.status === 'Online');
      const back = await srv.api('/api/profile', b.token, { method: 'PATCH', body: { status: 'Online' } });
      assert.equal(back.status, 200, 'status restore failed: ' + JSON.stringify(back));
      const onlineUpdate = await aSeesOnline;
      assert.equal(onlineUpdate.status, 'Online', 'peer must learn the restored status');

      const dbOnline = await srv.admin.query('SELECT status FROM users WHERE id=$1', [b.user.id]);
      assert.equal(dbOnline.rows[0].status, 'Online', 'restored status must persist in the database');
    });

    await t.test('S4: presence converges without user_update — connect-time snapshot and heartbeat pull', async () => {
      // C registers and connects only AFTER B has already changed status, so C
      // never receives the user_update broadcast for that change — the snapshot
      // pushed on connect must still show B's current DB status.
      const stamp = Date.now().toString(36).slice(-6);
      const regC = await srv.api('/api/register', null, { method: 'POST', body: { username: `ps_c_${stamp}`, password: PASSWORD } });
      assert.equal(regC.status, 200, 'register C failed: ' + JSON.stringify(regC));

      const setAway = await srv.api('/api/profile', b.token, { method: 'PATCH', body: { status: 'Away' } });
      assert.equal(setAway.status, 200, 'B Away patch failed: ' + JSON.stringify(setAway));

      sockC = createSocket(srv.base, { auth: { token: regC.token }, transports: ['websocket'], reconnection: false });
      const connectSync = waitForEvent(sockC, 'presence_sync', 8000, list => Array.isArray(list) && list.some(u => u.id === b.user.id));
      await connect(sockC);
      const snapshot = await connectSync;
      const bInSync = snapshot.find(u => u.id === b.user.id);
      assert.equal(bInSync.status, 'Away', 'connect-time snapshot must include B\'s missed status change');

      // Heartbeat: while connected, B changes again and C pulls via heartbeat.
      // In production this is the path that heals a dropped user_update (or one
      // broadcast only on another app instance) within one heartbeat period.
      const setDnd = await srv.api('/api/profile', b.token, { method: 'PATCH', body: { status: 'Do Not Disturb' } });
      assert.equal(setDnd.status, 200, 'B DND patch failed: ' + JSON.stringify(setDnd));
      const hbSync = waitForEvent(sockC, 'presence_sync', 8000, list => Array.isArray(list) && list.some(u => u.id === b.user.id));
      sockC.emit('presence_heartbeat');
      const hbSnapshot = await hbSync;
      const bFromHb = hbSnapshot.find(u => u.id === b.user.id);
      assert.equal(bFromHb.status, 'Do Not Disturb', 'heartbeat snapshot must reflect the latest DB status');

      // The snapshot is DB truth, not a cached broadcast.
      const dbRow = await srv.admin.query('SELECT status FROM users WHERE id=$1', [b.user.id]);
      assert.equal(dbRow.rows[0].status, 'Do Not Disturb');

      // Restore B for cleanliness.
      const restore = await srv.api('/api/profile', b.token, { method: 'PATCH', body: { status: 'Online' } });
      assert.equal(restore.status, 200);
    });

    t.diagnostic('socket presence & typing passed: channel typing → DM typing → user_update → connect/heartbeat presence convergence');
  } catch (err) {
    throw new Error(`${err.message}\n--- server log tail ---\n${srv.serverLog().slice(-1200)}`);
  } finally {
    for (const s of [sockA, sockB, sockC]) { if (s) { try { s.close(); } catch {} } }
  }
});
