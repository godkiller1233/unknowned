// Abrupt-disconnect cleanup for temporary rooms (room_members / live member
// lists), mirroring the voice-channel ghost fix. When a member's socket dies
// without `room_leave` (tab closed, crash, network drop), the server must drop
// their room_members row and tell the remaining members — after a short grace
// that a reconnect can cancel, so a wifi blip does not eject an active user.
import test from 'node:test';
import assert from 'node:assert/strict';
import { io as createSocket } from 'socket.io-client';
import { isPgReachable, startDisposableServer, waitForEvent, sleep } from './helpers/disposable-server.js';

const PASSWORD = 'ghost-pass-1';
const GRACE = 1200; // keep in sync with the ROOM_LEAVE_GRACE_MS env below

async function connect(sock) {
  await new Promise((res, rej) => {
    sock.once('connect', res);
    sock.once('connect_error', rej);
  });
}

test('temp rooms: abrupt disconnect cleans room_members + notifies peers; reconnect inside the grace cancels removal', { timeout: 120000 }, async t => {
  if (!(await isPgReachable())) {
    t.skip('PostgreSQL not reachable — set TEST_PG_ADMIN_URL (e.g. a CI postgres service container) to run integration tests');
    return;
  }

  // Short grace so the test runs fast; production default is 30s.
  const srv = await startDisposableServer({ env: { ROOM_LEAVE_GRACE_MS: String(GRACE) } });
  t.after(() => srv.stop());
  const sockets = [];

  try {
    const { base, api } = srv;
    const stamp = Date.now().toString(36).slice(-6);

    const reg = async (un) => {
      const r = await api('/api/register', null, { method: 'POST', body: { username: un, password: PASSWORD } });
      assert.equal(r.status, 200, 'register: ' + JSON.stringify(r));
      return r;
    };
    const a = await reg(`rg_a_${stamp}`);
    const b = await reg(`rg_b_${stamp}`);
    const c = await reg(`rg_c_${stamp}`);
    const d = await reg(`rg_d_${stamp}`);

    const boot = await api('/api/bootstrap', a.token);
    const communityId = boot.communities[0]?.id;
    assert.ok(communityId, 'seeded community must exist');

    const makeRoom = async (owner, name) => {
      const r = await api('/api/rooms', owner.token, { method: 'POST', body: { communityId, name, type: 'chat' } });
      assert.equal(r.status, 200, 'room create: ' + JSON.stringify(r));
      return r.id;
    };
    const joinRoom = async (u, roomId) => {
      const r = await api(`/api/rooms/${roomId}/join`, u.token, { method: 'POST' });
      assert.equal(r.status, 200, 'room join: ' + JSON.stringify(r));
      assert.equal(r.waiting, 0, 'open room: join must not wait');
    };
    const membersOf = async (u, roomId) => {
      const r = await api(`/api/rooms/${roomId}`, u.token);
      assert.equal(r.status, 200);
      return (r.members || []).filter(m => !Number(m.waiting));
    };
    const openSocket = async (u) => {
      const s = createSocket(base, { auth: { token: u.token }, transports: ['websocket'], reconnection: false });
      sockets.push(s);
      await connect(s);
      return s;
    };
    const joinSocketRoom = async (s, roomId) => {
      s.emit('room_join', roomId);
      await sleep(250);
    };

    // ── Case 1: B vanishes with no room_leave; A must be told and B's row must go.
    await t.test('S1: abrupt disconnect → peer notified + room_members cleaned after the grace', async () => {
      const roomId = await makeRoom(a, `ghost1_${stamp}`);
      await joinRoom(b, roomId);
      const sockA = await openSocket(a);
      const sockB = await openSocket(b);
      await joinSocketRoom(sockA, roomId);
      await joinSocketRoom(sockB, roomId);

      assert.equal((await membersOf(a, roomId)).length, 2, 'both members present before the drop');

      const leftEv = waitForEvent(sockA, 'room_presence', 6000, p => p.action === 'left' && p.userId === b.user.id);
      sockB.close(); // abrupt — no room_leave emitted
      await leftEv;

      // The row must be gone shortly after the grace.
      let members = await membersOf(a, roomId);
      const deadline = Date.now() + 4000;
      while (members.length !== 1 && Date.now() < deadline) {
        await sleep(300);
        members = await membersOf(a, roomId);
      }
      assert.equal(members.length, 1, 'B must be removed from room_members after the grace');
      assert.notEqual(members[0].user_id, b.user.id, 'the survivor must be A');
      sockA.close();
    });

    // ── Case 2: D's network blips but reconnects inside the grace → stays a member.
    await t.test('S2: reconnect within the grace cancels the pending removal', async () => {
      const roomId = await makeRoom(c, `ghost2_${stamp}`);
      await joinRoom(d, roomId);
      const sockC = await openSocket(c);
      const sockD1 = await openSocket(d);
      await joinSocketRoom(sockC, roomId);
      await joinSocketRoom(sockD1, roomId);

      assert.equal((await membersOf(c, roomId)).length, 2);

      // D drops abruptly…
      sockD1.close();

      // …and reconnects + re-announces well inside the grace window.
      await sleep(200);
      const sockD2 = await openSocket(d);
      await joinSocketRoom(sockD2, roomId);

      // No 'left' may reach C for D, and after the grace D's row must still exist.
      let sawLeftForD = false;
      sockC.on('room_presence', p => { if (p.action === 'left' && p.userId === d.user.id) sawLeftForD = true; });
      await sleep(GRACE + 1500);
      const members = await membersOf(c, roomId);
      assert.equal(sawLeftForD, false, 'a reconnect inside the grace must cancel the removal notice');
      assert.equal(members.length, 2, 'D must remain a member after reconnecting inside the grace');
      assert.ok(members.some(m => m.user_id === d.user.id), 'D’s room_members row survives the blip');
      sockC.close();
      sockD2.close();
    });
  } finally {
    sockets.forEach(s => { try { s.close?.(); s.destroy?.(); } catch {} });
  }
});
