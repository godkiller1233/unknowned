import test from 'node:test';
import assert from 'node:assert/strict';
import { io as createSocket } from 'socket.io-client';
import {
  isPgReachable,
  startDisposableServer,
  waitForEvent,
  sleep,
} from './helpers/disposable-server.js';

test('integration smoke: register/login/socket flows against a disposable database', { timeout: 120000 }, async t => {
  // Skip cleanly when no PostgreSQL admin URL is reachable (CI sets TEST_PG_ADMIN_URL).
  if (!(await isPgReachable())) {
    t.skip('PostgreSQL not reachable — set TEST_PG_ADMIN_URL (e.g. a CI postgres service container) to run integration tests');
    return;
  }

  const srv = await startDisposableServer();
  t.after(() => srv.stop());
  const sockets = [];

  try {
    const { base, api } = srv;

    const apiCall = (path, token, opts = {}) => api(path, token, opts);

    // 1) Register two fresh users; both should auto-join the default public community.
    const stamp = Date.now().toString(36).slice(-6);
    const a = await apiCall('/api/register', null, { method: 'POST', body: { username: `it_a_${stamp}`, password: 'integration-pass-1' } });
    const b = await apiCall('/api/register', null, { method: 'POST', body: { username: `it_b_${stamp}`, password: 'integration-pass-2' } });
    assert.equal(a.status, 200, 'register A failed: ' + JSON.stringify(a));
    assert.equal(b.status, 200, 'register B failed: ' + JSON.stringify(b));
    assert.ok(a.token && b.token, 'register must return tokens');
    assert.notEqual(a.user.id, b.user.id);

    const bootA = await apiCall('/api/bootstrap', a.token);
    const bootB = await apiCall('/api/bootstrap', b.token);
    assert.equal(bootA.memberships.length, 1, 'A should auto-join the default community');
    assert.equal(bootB.memberships.length, 1, 'B should auto-join the default community');
    const welcome = bootA.channels.find(c => c.name === 'welcome');
    assert.ok(welcome, 'seeded #welcome channel must exist');

    // 2) Real socket sessions for both users.
    const sockA = createSocket(base, { auth: { token: a.token }, transports: ['websocket'], reconnection: false });
    const sockB = createSocket(base, { auth: { token: b.token }, transports: ['websocket'], reconnection: false });
    sockets.push(sockA, sockB);
    await Promise.all([
      new Promise((res, rej) => { sockA.once('connect', res); sockA.once('connect_error', rej); }),
      new Promise((res, rej) => { sockB.once('connect', res); sockB.once('connect_error', rej); }),
    ]);
    sockA.emit('join_user', a.user.id);
    sockB.emit('join_user', b.user.id);
    sockA.emit('join', welcome.id);
    sockB.emit('join', welcome.id);
    await sleep(400);

    // 3) Live channel message: B posts via REST, A receives it over the socket.
    const aMsg = waitForEvent(sockA, 'message', 8000, m => m.body && m.body.includes('live channel ping'));
    const post = await apiCall('/api/messages', b.token, {
      method: 'POST',
      body: { channelId: welcome.id, body: `live channel ping from ${b.user.username}` },
    });
    assert.equal(post.status, 200, 'channel post failed: ' + JSON.stringify(post));
    const recv = await aMsg;
    assert.equal(recv.channel_id, welcome.id);
    assert.equal(recv.sender_id, b.user.id);

    // History contains it too (persistence).
    const histRes = await fetch(`${base}/api/channels/${welcome.id}/messages`, { headers: { Authorization: 'Bearer ' + a.token } });
    const hist = await histRes.json();
    const rows = Array.isArray(hist) ? hist : (hist.messages || []);
    assert.ok(Array.isArray(rows) && rows.some(m => m.id === recv.id), 'posted message must appear in history');

    // 4) DM: A opens a DM with B, B replies over the socket, A receives dm_message live.
    const bNewDm = waitForEvent(sockB, 'new_dm', 8000, dm => [dm.user_a, dm.user_b].includes(a.user.id));
    const dmRes = await apiCall('/api/dms', a.token, { method: 'POST', body: { userId: b.user.id } });
    assert.equal(dmRes.status, 200, 'dm create failed: ' + JSON.stringify(dmRes));
    const dm = dmRes.dm || dmRes;
    await bNewDm;
    sockA.emit('join_dm', dm.id);
    sockB.emit('join_dm', dm.id);
    await sleep(300);

    const aDm = waitForEvent(sockA, 'dm_message', 8000, m => m.body && m.body.includes('dm ping'));
    const dmPost = await apiCall('/api/messages', b.token, {
      method: 'POST',
      body: { dmId: dm.id, body: 'dm ping back at you' },
    });
    assert.equal(dmPost.status, 200, 'dm post failed: ' + JSON.stringify(dmPost));
    const dmRecv = await aDm;
    assert.equal(dmRecv.dm_id, dm.id);
    assert.equal(dmRecv.sender_id, b.user.id);

    // 5) Typing indicator rebroadcast (server excludes the sender; B must see A's typing).
    const bTyping = waitForEvent(sockB, 'typing', 8000, d => d.channelId === welcome.id && d.userId === a.user.id);
    sockA.emit('typing', { channelId: welcome.id, userId: a.user.id, username: a.user.username });
    const typingRecv = await bTyping;
    assert.equal(typingRecv.username, a.user.username);

    // 6) Logout revokes the session server-side.
    const logout = await apiCall('/api/logout', a.token, { method: 'POST' });
    assert.equal(logout.status, 200);
    const afterLogout = await fetch(base + '/api/bootstrap', { headers: { Authorization: 'Bearer ' + a.token } });
    assert.equal(afterLogout.status, 401, 'revoked token must be rejected');

    t.diagnostic('integration smoke passed: register → auto-join → live channel/DM sockets → typing → logout revocation');
  } catch (err) {
    throw new Error(`${err.message}\n--- server log tail ---\n${srv.serverLog().slice(-1200)}`);
  } finally {
    for (const s of sockets) { try { s.close(); } catch {} }
  }
});
