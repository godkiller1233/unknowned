import test from 'node:test';
import assert from 'node:assert/strict';
import { io as createSocket } from 'socket.io-client';
import {
  isPgReachable,
  startDisposableServer,
  waitForEvent,
  sleep,
} from './helpers/disposable-server.js';

// CI-repeatable coverage for temporary rooms (the RoomView surface) between two
// real users on a disposable database. Rooms deliberately have no typing event
// in the protocol (channel/DM typing is covered by socket-presence.test.js), so
// the live indicators here are room_presence (join/waiting/admitted) and the
// raise-hand event, plus real-time room_message delivery and waiting-room gating.
const PASSWORD = 'room-pass-1';

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

test('temp rooms: two users, open + waiting-room lifecycle, live messages, presence and raise-hand over sockets', { timeout: 120000 }, async t => {
  if (!(await isPgReachable())) {
    t.skip('PostgreSQL not reachable — set TEST_PG_ADMIN_URL (e.g. a CI postgres service container) to run integration tests');
    return;
  }

  const srv = await startDisposableServer();
  t.after(() => srv.stop());

  let a = null;
  let b = null;
  let communityId = null;
  let sockA = null;
  let sockB = null;
  let room1 = null; // open chat room owned by A

  try {
    await t.test('S1: register A and B; A creates an open room and B joins it (presence reached A)', async () => {
      const stamp = Date.now().toString(36).slice(-6);
      const regA = await srv.api('/api/register', null, { method: 'POST', body: { username: `rm_a_${stamp}`, password: PASSWORD } });
      const regB = await srv.api('/api/register', null, { method: 'POST', body: { username: `rm_b_${stamp}`, password: PASSWORD } });
      assert.equal(regA.status, 200, 'register A failed: ' + JSON.stringify(regA));
      assert.equal(regB.status, 200, 'register B failed: ' + JSON.stringify(regB));
      a = regA;
      b = regB;

      const bootA = await srv.api('/api/bootstrap', a.token);
      communityId = bootA.memberships[0].community_id;
      assert.ok(communityId, 'A must be a community member');

      sockA = createSocket(srv.base, { auth: { token: a.token }, transports: ['websocket'], reconnection: false });
      sockB = createSocket(srv.base, { auth: { token: b.token }, transports: ['websocket'], reconnection: false });
      await Promise.all([connect(sockA), connect(sockB)]);
      sockA.emit('join_user', a.user.id); // user room: owner receives room_waiting / room_admitted
      sockB.emit('join_user', b.user.id);
      await sleep(300);

      const create = await srv.api('/api/rooms', a.token, {
        method: 'POST',
        body: { communityId, name: `Harness Chat ${stamp}`, type: 'chat', waitingRoom: false },
      });
      assert.equal(create.status, 200, 'room create failed: ' + JSON.stringify(create));
      room1 = create.room || { id: create.id };
      assert.ok(room1.id, 'room create must return an id');
      sockA.emit('room_join', room1.id);
      await sleep(200);

      // B joins the open room → immediate admit; A's room socket sees the presence.
      const aSeesJoined = waitForEvent(sockA, 'room_presence', 8000, p => p.userId === b.user.id && p.action === 'joined');
      const joinB = await srv.api(`/api/rooms/${room1.id}/join`, b.token, { method: 'POST' });
      assert.equal(joinB.status, 200, 'B room join failed: ' + JSON.stringify(joinB));
      assert.ok(!Number(joinB.waiting), 'open room join must not wait');
      await aSeesJoined;
      sockB.emit('room_join', room1.id);
      await sleep(200);

      const dbRow = await srv.admin.query('SELECT waiting FROM room_members WHERE room_id=$1 AND user_id=$2', [room1.id, b.user.id]);
      assert.equal(dbRow.rows.length, 1, 'B must have a room_members row');
      assert.equal(dbRow.rows[0].waiting, 0, 'B is a full member of the open room');
    });

    await t.test('S2: room messages deliver live over sockets and persist in history', async () => {
      assert.ok(room1 && sockA && sockB && a && b, 'S1 must have set up the room');
      const markerB = `room msg from B ${Date.now()}`;
      const aGets = waitForEvent(sockA, 'room_message', 8000, m => m.room_id === room1.id && m.sender_id === b.user.id && m.body.includes(markerB));
      const postB = await srv.api(`/api/rooms/${room1.id}/messages`, b.token, { method: 'POST', body: { body: markerB } });
      assert.equal(postB.status, 200, 'B room post failed: ' + JSON.stringify(postB));
      const recvB = await aGets;
      assert.equal(recvB.body, markerB);
      assert.equal(recvB.username, b.user.username, 'message must carry sender username');

      const markerA = `room msg from A ${Date.now()}`;
      const bGets = waitForEvent(sockB, 'room_message', 8000, m => m.room_id === room1.id && m.sender_id === a.user.id && m.body.includes(markerA));
      const postA = await srv.api(`/api/rooms/${room1.id}/messages`, a.token, { method: 'POST', body: { body: markerA } });
      assert.equal(postA.status, 200, 'A room post failed: ' + JSON.stringify(postA));
      const recvA = await bGets;
      assert.equal(recvA.body, markerA);

      // The history endpoint returns a bare JSON array, so bypass the object-spreading api helper.
      const histRes = await fetch(`${srv.base}/api/rooms/${room1.id}/messages`, { headers: { Authorization: 'Bearer ' + a.token } });
      assert.equal(histRes.status, 200, 'room history must load');
      const rows = await histRes.json();
      assert.ok(Array.isArray(rows), 'room history must be an array');
      assert.ok(rows.some(m => m.id === recvB.id) && rows.some(m => m.id === recvA.id), 'both messages must persist in history');
    });

    await t.test('S3: raise-hand indicator reaches the other user live, with no self-echo', async () => {
      assert.ok(room1 && sockA && sockB && b, 'S1 must have set up the room');
      const aRaise = waitForEvent(sockA, 'room_raise', 8000, p => p.roomId === room1.id && p.userId === b.user.id);
      sockB.emit('room_raise', { roomId: room1.id });
      const got = await aRaise;
      assert.equal(got.userId, b.user.id, 'raise payload must identify the raiser');

      const selfEcho = await onceOrNull(sockB, 'room_raise', 500);
      assert.equal(selfEcho, null, 'raiser must not receive its own room_raise');
    });

    await t.test('S4: waiting-room lifecycle — queue, owner notified, messages blocked until admit', async () => {
      assert.ok(sockA && sockB && a && b && communityId, 'A and B sessions must exist');
      const stamp = Date.now().toString(36).slice(-6);
      const create = await srv.api('/api/rooms', a.token, {
        method: 'POST',
        body: { communityId, name: `Harness Gate ${stamp}`, type: 'chat', waitingRoom: true },
      });
      assert.equal(create.status, 200, 'waiting room create failed: ' + JSON.stringify(create));
      const room2 = create.room || { id: create.id };
      assert.ok(room2.id);
      sockA.emit('room_join', room2.id);
      await sleep(200);

      // B queues in the waiting room: A's room socket + A's user room both learn.
      const aSeesWaiting = waitForEvent(sockA, 'room_presence', 8000, p => p.userId === b.user.id && p.action === 'waiting');
      const aSeesNotify = waitForEvent(sockA, 'room_waiting', 8000, n => n.roomId === room2.id && n.userId === b.user.id);
      const joinB = await srv.api(`/api/rooms/${room2.id}/join`, b.token, { method: 'POST' });
      assert.equal(joinB.status, 200, 'waiting join failed: ' + JSON.stringify(joinB));
      assert.ok(Number(joinB.waiting), 'B must be queued in the waiting room');
      await aSeesWaiting;
      const notif = await aSeesNotify;
      assert.equal(notif.username, b.user.username, 'owner notification must name the waiting user');

      const dbWait = await srv.admin.query('SELECT waiting FROM room_members WHERE room_id=$1 AND user_id=$2', [room2.id, b.user.id]);
      assert.equal(dbWait.rows[0].waiting, 1, 'B must be waiting=1 in the DB');

      // Waiting users cannot chat in the room.
      const blocked = await srv.api(`/api/rooms/${room2.id}/messages`, b.token, { method: 'POST', body: { body: 'sneaky pre-admit message' } });
      assert.equal(blocked.status, 403, 'waiting user must not be able to post room messages');

      // Owner admits B: A's room socket sees the admit; B's user room is notified.
      const aSeesAdmit = waitForEvent(sockA, 'room_presence', 8000, p => p.userId === b.user.id && p.action === 'admitted');
      const bAdmitted = waitForEvent(sockB, 'room_admitted', 8000, n => n.roomId === room2.id);
      const admit = await srv.api(`/api/rooms/${room2.id}/admit`, a.token, { method: 'POST', body: { userId: b.user.id } });
      assert.equal(admit.status, 200, 'admit failed: ' + JSON.stringify(admit));
      await aSeesAdmit;
      await bAdmitted;

      const dbAdmitted = await srv.admin.query('SELECT waiting FROM room_members WHERE room_id=$1 AND user_id=$2', [room2.id, b.user.id]);
      assert.equal(dbAdmitted.rows[0].waiting, 0, 'B must be waiting=0 after admit');

      // Post-admit, B can chat and A receives the message live in the room.
      const marker = `admitted msg from B ${Date.now()}`;
      const aGets = waitForEvent(sockA, 'room_message', 8000, m => m.room_id === room2.id && m.sender_id === b.user.id && m.body.includes(marker));
      const postB = await srv.api(`/api/rooms/${room2.id}/messages`, b.token, { method: 'POST', body: { body: marker } });
      assert.equal(postB.status, 200, 'post-admit room post failed: ' + JSON.stringify(postB));
      await aGets;
    });

    t.diagnostic('temp rooms passed: open-room presence → live room_message delivery + history → raise-hand → waiting-room queue/admit lifecycle');
  } catch (err) {
    throw new Error(`${err.message}\n--- server log tail ---\n${srv.serverLog().slice(-1200)}`);
  } finally {
    for (const s of [sockA, sockB]) { if (s) { try { s.close(); } catch {} } }
  }
});
