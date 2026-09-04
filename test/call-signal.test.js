import test from 'node:test';
import assert from 'node:assert/strict';
import { io as createSocket } from 'socket.io-client';
import {
  isPgReachable,
  startDisposableServer,
  waitForEvent,
  sleep,
} from './helpers/disposable-server.js';

test('DM call mute state: relayed between DM partners, blocked without a DM', { timeout: 120000 }, async t => {
  if (!(await isPgReachable())) {
    t.skip('PostgreSQL not reachable — set TEST_PG_ADMIN_URL (e.g. a CI postgres service container) to run integration tests');
    return;
  }

  const srv = await startDisposableServer();
  t.after(() => srv.stop());
  const sockets = [];

  try {
    const { base, api } = srv;
    const stamp = Date.now().toString(36).slice(-6);

    const a = await api('/api/register', null, { method: 'POST', body: { username: `mu_a_${stamp}`, password: 'mute-pass-1' } });
    const b = await api('/api/register', null, { method: 'POST', body: { username: `mu_b_${stamp}`, password: 'mute-pass-2' } });
    const c = await api('/api/register', null, { method: 'POST', body: { username: `mu_c_${stamp}`, password: 'mute-pass-3' } });
    assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(c.status, 200);

    // A and B share a DM; C does not know A.
    const dmRes = await api('/api/dms', a.token, { method: 'POST', body: { userId: b.user.id } });
    assert.equal(dmRes.status, 200, 'dm create: ' + JSON.stringify(dmRes));
    const dm = dmRes.dm || dmRes;

    const sockA = createSocket(base, { auth: { token: a.token }, transports: ['websocket'], reconnection: false });
    const sockB = createSocket(base, { auth: { token: b.token }, transports: ['websocket'], reconnection: false });
    const sockC = createSocket(base, { auth: { token: c.token }, transports: ['websocket'], reconnection: false });
    sockets.push(sockA, sockB, sockC);
    await Promise.all([sockA, sockB, sockC].map(s => new Promise((res, rej) => { s.once('connect', res); s.once('connect_error', rej); })));
    sockA.emit('join_user', a.user.id);
    sockB.emit('join_user', b.user.id);
    sockC.emit('join_user', c.user.id);
    await sleep(300);

    // 1) A mutes → B receives the true signaled state (with A's identity).
    const gotMuted = waitForEvent(sockB, 'call_mute', 5000, d => d.muted === true && d.dmId === dm.id && d.from === a.user.id);
    sockA.emit('call_mute', { toUserId: b.user.id, dmId: dm.id, muted: true });
    const mutedEv = await gotMuted;
    assert.equal(mutedEv.muted, true, 'B must learn A muted');
    assert.equal(mutedEv.from, a.user.id, 'event must carry the sender');

    // 2) A unmutes → B receives the flip.
    const gotUnmuted = waitForEvent(sockB, 'call_mute', 5000, d => d.muted === false && d.dmId === dm.id);
    sockA.emit('call_mute', { toUserId: b.user.id, dmId: dm.id, muted: false });
    await gotUnmuted;

    // 3) Auth guard: C has no DM with A, so C's spoofed mute must never reach A.
    let received = false;
    sockA.on('call_mute', () => { received = true; });
    sockC.emit('call_mute', { toUserId: a.user.id, dmId: 'fake-dm-id', muted: true });
    await sleep(900);
    sockA.off('call_mute');
    assert.equal(received, false, 'non-DM peer must not be able to signal mute state');
  } finally {
    sockets.forEach(s => { try { s.close?.(); s.destroy?.(); } catch {} });
  }
});


test('DM call camera state: relayed between DM partners, blocked without a DM', { timeout: 120000 }, async t => {
  if (!(await isPgReachable())) {
    t.skip('PostgreSQL not reachable — set TEST_PG_ADMIN_URL (e.g. a CI postgres service container) to run integration tests');
    return;
  }

  const srv = await startDisposableServer();
  t.after(() => srv.stop());
  const sockets = [];

  try {
    const { base, api } = srv;
    const stamp = Date.now().toString(36).slice(-6);

    const a = await api('/api/register', null, { method: 'POST', body: { username: `cam_a_${stamp}`, password: 'cam-pass-1' } });
    const b = await api('/api/register', null, { method: 'POST', body: { username: `cam_b_${stamp}`, password: 'cam-pass-2' } });
    const c = await api('/api/register', null, { method: 'POST', body: { username: `cam_c_${stamp}`, password: 'cam-pass-3' } });
    assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(c.status, 200);

    // A and B share a DM; C does not know A.
    const dmRes = await api('/api/dms', a.token, { method: 'POST', body: { userId: b.user.id } });
    assert.equal(dmRes.status, 200, 'dm create: ' + JSON.stringify(dmRes));
    const dm = dmRes.dm || dmRes;

    const sockA = createSocket(base, { auth: { token: a.token }, transports: ['websocket'], reconnection: false });
    const sockB = createSocket(base, { auth: { token: b.token }, transports: ['websocket'], reconnection: false });
    const sockC = createSocket(base, { auth: { token: c.token }, transports: ['websocket'], reconnection: false });
    sockets.push(sockA, sockB, sockC);
    await Promise.all([sockA, sockB, sockC].map(s => new Promise((res, rej) => { s.once('connect', res); s.once('connect_error', rej); })));
    sockA.emit('join_user', a.user.id);
    sockB.emit('join_user', b.user.id);
    sockC.emit('join_user', c.user.id);
    await sleep(300);

    // 1) A turns the camera on → B learns the state with A's identity.
    const gotOn = waitForEvent(sockB, 'call_camera', 5000, d => d.on === true && d.dmId === dm.id && d.from === a.user.id);
    sockA.emit('call_camera', { toUserId: b.user.id, dmId: dm.id, on: true });
    const camOnEv = await gotOn;
    assert.equal(camOnEv.on, true, 'B must learn A enabled the camera');
    assert.equal(camOnEv.from, a.user.id, 'event must carry the sender');

    // 2) A turns it off → B receives the flip.
    const gotOff = waitForEvent(sockB, 'call_camera', 5000, d => d.on === false && d.dmId === dm.id);
    sockA.emit('call_camera', { toUserId: b.user.id, dmId: dm.id, on: false });
    const camOffEv = await gotOff;
    assert.equal(camOffEv.on, false);

    // 3) Auth guard: C has no DM with A, so C's spoofed camera state must never reach A.
    let received = false;
    sockA.on('call_camera', () => { received = true; });
    sockC.emit('call_camera', { toUserId: a.user.id, dmId: 'fake-dm-id', on: true });
    await sleep(900);
    sockA.off('call_camera');
    assert.equal(received, false, 'non-DM peer must not be able to signal camera state');
  } finally {
    sockets.forEach(s => { try { s.close?.(); s.destroy?.(); } catch {} });
  }
});
