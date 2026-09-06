import test from 'node:test';
import assert from 'node:assert/strict';
import { io as createSocket } from 'socket.io-client';
import {
  isPgReachable,
  startDisposableServer,
  sleep,
} from './helpers/disposable-server.js';
import { createVoiceMesh } from '../src/mesh.js';

// The mesh engine creates real RTCPeerConnection objects. Node has none, so we
// stub the WebRTC surface with a state machine that records the exact signaling
// lifecycle — offers/answers/ICE — while the real server relays the messages.
const fakePCs = [];
class FakePC {
  constructor(opts) {
    this.opts = opts;
    this.tracks = [];
    this.localDescription = null;
    this.remoteDescription = null;
    this.addedIce = [];
    this.offerCount = 0;
    this.answerCount = 0;
    this.closed = false;
    fakePCs.push(this);
  }
  addTrack(track) { this.tracks.push(track); }
  async createOffer() { this.offerCount += 1; return { type: 'offer', sdp: `fake-offer-${this.offerCount}` }; }
  async createAnswer() { this.answerCount += 1; return { type: 'answer', sdp: `fake-answer-${this.answerCount}` }; }
  async setLocalDescription(desc) {
    this.localDescription = desc;
    // Simulate ICE gathering: candidates flow right after local description.
    queueMicrotask(() => {
      if (this.onicecandidate) this.onicecandidate({ candidate: { candidate: `cand-${Math.random()}`, sdpMid: '0', sdpMLineIndex: 0 } });
    });
  }
  async setRemoteDescription(desc) { this.remoteDescription = desc; }
  async addIceCandidate(cand) { this.addedIce.push(cand); }
  close() { this.closed = true; }
}
global.RTCPeerConnection = FakePC;
global.RTCSessionDescription = class { constructor(d) { this.type = d.type; this.sdp = d.sdp; } };
global.RTCIceCandidate = class { constructor(c) { this.candidate = c && c.candidate !== undefined ? c.candidate : c; } };

const fakeStream = () => ({ getTracks: () => [] });
const waitFor = async (fn, ms = 5000, step = 80) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await sleep(step);
  }
  throw new Error('condition not met within ' + ms + 'ms');
};

test('voice mesh: roster, offer/answer/ice lifecycle and leave over real sockets', { timeout: 120000 }, async t => {
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

    const a = await api('/api/register', null, { method: 'POST', body: { username: `vm_a_${stamp}`, password: 'mesh-pass-1' } });
    const b = await api('/api/register', null, { method: 'POST', body: { username: `vm_b_${stamp}`, password: 'mesh-pass-2' } });
    const c = await api('/api/register', null, { method: 'POST', body: { username: `vm_c_${stamp}`, password: 'mesh-pass-3' } });
    assert.equal(a.status, 200, 'register A: ' + JSON.stringify(a));
    assert.equal(b.status, 200, 'register B: ' + JSON.stringify(b));
    assert.equal(c.status, 200, 'register C: ' + JSON.stringify(c));

    const bootA = await api('/api/bootstrap', a.token);
    const voiceCh = bootA.channels.find(ch => ch.type === 'voice');
    assert.ok(voiceCh, 'seeded voice channel must exist for the mesh test');
    assert.ok(a.user.id !== b.user.id);

    const sockA = createSocket(base, { auth: { token: a.token }, transports: ['websocket'], reconnection: false });
    const sockB = createSocket(base, { auth: { token: b.token }, transports: ['websocket'], reconnection: false });
    const sockC = createSocket(base, { auth: { token: c.token }, transports: ['websocket'], reconnection: false });
    sockets.push(sockA, sockB, sockC);
    await Promise.all([sockA, sockB, sockC].map(s => new Promise((res, rej) => { s.once('connect', res); s.once('connect_error', rej); })));
    [sockA, sockB, sockC].forEach(s => s.emit('join_user', s.auth.token && 'ignored')); // harmless; real ids joined on voice_join below

    const state = { aRoster: [], bRoster: [], offerSpoofs: 0 };
    sockA.on('voice_rtc_offer', d => { if (d.fromUserId === c.user.id) state.offerSpoofs += 1; });

    const meshA = createVoiceMesh({
      socket: sockA, channelId: voiceCh.id, me: { id: a.user.id },
      onRoster: r => { state.aRoster = r; }, onRemoteStream: () => {}, onRemoteEnd: () => {},
    });
    const meshB = createVoiceMesh({
      socket: sockB, channelId: voiceCh.id, me: { id: b.user.id },
      onRoster: r => { state.bRoster = r; }, onRemoteStream: () => {}, onRemoteEnd: () => {},
    });
    sockets.push(meshA, meshB); // (no-op on stop; keeps them referenced)

    // 1) A joins first — empty roster — then B joins and both discover each other.
    meshA.join(fakeStream());
    await sleep(300);
    meshB.join(fakeStream());

    await waitFor(() => state.bRoster.some(u => u.userId === a.user.id && u.username === a.user.username), 8000);
    assert.ok(state.bRoster.some(u => u.userId === a.user.id), 'B roster must contain A (profile + socket id)');
    await waitFor(() => state.aRoster.some(u => u.userId === b.user.id), 8000);
    assert.ok(state.aRoster.some(u => u.userId === b.user.id && u.username === b.user.username), 'A roster must contain B with profile');

    // 2) The smaller user id offers; exactly ONE offer is ever created per pair,
    //    and the answerer answers. (Fake ICE flows from both local descriptions.)
    await waitFor(() => fakePCs.reduce((n, p) => n + p.offerCount, 0) === 1, 8000);
    const offers = fakePCs.reduce((n, p) => n + p.offerCount, 0);
    const answers = fakePCs.reduce((n, p) => n + p.answerCount, 0);
    assert.equal(offers, 1, 'mesh must negotiate with exactly one offer (no glare)');
    assert.ok(answers >= 1, 'offer must be answered: ' + answers);

    // 3) Both peers reach the negotiated state: remote descriptions exchanged
    //    and ICE candidates from both directions applied.
    const live = fakePCs.filter(p => !p.closed);
    assert.equal(live.length, 2, 'exactly two peer connections, one per side');
    await waitFor(() => live.every(p => p.remoteDescription), 8000);
    await waitFor(() => live.every(p => p.addedIce.length >= 1), 8000);
    assert.ok(live.every(p => p.remoteDescription), 'both sides must receive the remote SDP');
    assert.ok(live.every(p => p.addedIce.length >= 1), 'both sides must receive ICE');

    // 3b) Camera state: A turns the camera off → B's roster row flips to
    //     camera:false (B's UI would swap the frozen video for a placeholder).
    meshA.setCamera(false);
    await waitFor(() => state.bRoster.find(u => u.userId === a.user.id)?.camera === false, 5000);
    assert.equal(state.bRoster.find(u => u.userId === a.user.id)?.camera, false, 'B must learn A turned the camera off');
    meshA.setCamera(true);
    await waitFor(() => state.bRoster.find(u => u.userId === a.user.id)?.camera === true, 5000);
    assert.equal(state.bRoster.find(u => u.userId === a.user.id)?.camera, true, 'B must learn A turned the camera back on');

    // 4) B leaves → A receives voice_user_left and closes B's peer connection.
    meshB.leave();
    await waitFor(() => state.aRoster.length === 0, 8000);
    assert.equal(state.aRoster.length, 0, 'A roster must drop B after leave');
    await waitFor(() => fakePCs.some(p => p.closed), 8000);

    // 5) Server authorization: C (member, but NOT in the voice room) cannot
    //    inject an offer into the channel — the relay drops it server-side.
    const before = fakePCs.length;
    sockC.emit('voice_rtc_offer', { channelId: voiceCh.id, toSocketId: sockA.id, sdp: { type: 'offer', sdp: 'spoof' } });
    await sleep(800);
    assert.equal(state.offerSpoofs, 0, 'non-members must not reach voice peers');
    assert.ok(fakePCs.length <= before, 'no new peer connection from an unauthorized offer');

    // 6) Cleanup: leaving emits nothing further and sockets close cleanly.
    meshA.leave();
    meshA.destroy();
    meshB.destroy();
    await sleep(200);
  } finally {
    sockets.forEach(s => { try { s.close?.(); s.destroy?.(); } catch {} });
  }
});

test('voice mesh: abrupt disconnect drops the peer (disconnecting broadcast)', { timeout: 120000 }, async t => {
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
    const a = await api('/api/register', null, { method: 'POST', body: { username: `vmx_a_${stamp}`, password: 'mesh-pass-1' } });
    const b = await api('/api/register', null, { method: 'POST', body: { username: `vmx_b_${stamp}`, password: 'mesh-pass-2' } });
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    const bootA = await api('/api/bootstrap', a.token);
    const voiceCh = bootA.channels.find(ch => ch.type === 'voice');
    assert.ok(voiceCh);

    const sockA = createSocket(base, { auth: { token: a.token }, transports: ['websocket'], reconnection: false });
    const sockB = createSocket(base, { auth: { token: b.token }, transports: ['websocket'], reconnection: false });
    sockets.push(sockA, sockB);
    await Promise.all([sockA, sockB].map(s => new Promise((res, rej) => { s.once('connect', res); s.once('connect_error', rej); })));

    const state = { aRoster: [] };
    const closedBeforeKill = fakePCs.filter(p => p.closed).length;
    const meshA = createVoiceMesh({
      socket: sockA, channelId: voiceCh.id, me: { id: a.user.id },
      onRoster: r => { state.aRoster = r; }, onRemoteStream: () => {}, onRemoteEnd: () => {},
    });
    const meshB = createVoiceMesh({
      socket: sockB, channelId: voiceCh.id, me: { id: b.user.id },
      onRoster: () => {}, onRemoteStream: () => {}, onRemoteEnd: () => {},
    });
    meshA.join(fakeStream());
    await sleep(300);
    meshB.join(fakeStream());
    await waitFor(() => state.aRoster.some(u => u.userId === b.user.id), 8000);
    assert.ok(state.aRoster.some(u => u.userId === b.user.id), 'A sees B before the kill');
    // Wait for the pair to actually negotiate so A holds a real peer connection
    // for B — otherwise (A being the larger id) A may not have created one yet,
    // and there is nothing to tear down when B vanishes.
    await waitFor(() => fakePCs.filter(p => !p.closed).some(p => p.remoteDescription), 8000);

    // B's connection dies WITHOUT a voice_leave (tab close / network drop).
    // Server must broadcast voice_user_left from its 'disconnecting' hook —
    // by 'disconnect' time socket.rooms is already empty, so that never fires.
    sockB.close();
    await waitFor(() => state.aRoster.length === 0, 8000);
    assert.equal(state.aRoster.length, 0, 'A roster must drop B after abrupt disconnect');
    await waitFor(() => fakePCs.filter(p => p.closed).length > closedBeforeKill, 8000);
  } finally {
    sockets.forEach(s => { try { s.close?.(); s.destroy?.(); } catch {} });
  }
});


test('voice mesh: one call per account — second device refused, never paired', { timeout: 120000 }, async t => {
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

    // ONE account, TWO devices (two independent sockets, same user token).
    const u = await api('/api/register', null, { method: 'POST', body: { username: `vm3_${stamp}`, password: 'mesh-pass-1' } });
    assert.equal(u.status, 200, 'register: ' + JSON.stringify(u));
    const boot = await api('/api/bootstrap', u.token);
    const voiceCh = boot.channels.find(ch => ch.type === 'voice');
    assert.ok(voiceCh, 'seeded voice channel must exist');

    const sockPhone = createSocket(base, { auth: { token: u.token }, transports: ['websocket'], reconnection: false });
    const sockDesktop = createSocket(base, { auth: { token: u.token }, transports: ['websocket'], reconnection: false });
    sockets.push(sockPhone, sockDesktop);
    await Promise.all([sockPhone, sockDesktop].map(s => new Promise((res, rej) => { s.once('connect', res); s.once('connect_error', rej); })));

    const state = { phoneRoster: [], desktopRoster: [], phoneRejected: null, desktopRejected: null };
    sockPhone.on('voice_join_rejected', d => { state.phoneRejected = d; });
    sockDesktop.on('voice_join_rejected', d => { state.desktopRejected = d; });
    const pcStart = fakePCs.length;
    const meshPhone = createVoiceMesh({
      socket: sockPhone, channelId: voiceCh.id, me: { id: u.user.id },
      onRoster: r => { state.phoneRoster = r; }, onRemoteStream: () => {}, onRemoteEnd: () => {},
    });
    const meshDesktop = createVoiceMesh({
      socket: sockDesktop, channelId: voiceCh.id, me: { id: u.user.id },
      onRoster: r => { state.desktopRoster = r; }, onRemoteStream: () => {}, onRemoteEnd: () => {},
    });

    // 1. Phone joins first — succeeds, alone.
    meshPhone.join(fakeStream());
    await sleep(600);
    assert.equal(state.phoneRejected, null, 'first device must not be rejected');
    assert.equal(state.phoneRoster.length, 0, 'phone is alone — empty roster');

    // 2. Desktop (same account) tries to join — server refuses it and the phone
    //    never learns about the second device. No self-pair, no signaling.
    meshDesktop.join(fakeStream());
    await waitFor(() => state.desktopRejected, 8000);
    assert.equal(state.desktopRejected.reason, 'already-in-call');
    assert.equal(state.desktopRejected.channelId, voiceCh.id);
    await sleep(500);
    assert.equal(state.desktopRoster.length, 0, 'refused device has no roster');
    assert.equal(state.phoneRoster.length, 0, 'in-call device never sees its own account');
    assert.equal(fakePCs.slice(pcStart).length, 0, 'no peer connection may exist for a self-pair');

    // 3. Phone leaves — the busy flag clears with its live socket state.
    meshPhone.leave();
    await sleep(400);

    // 4. Desktop can now join (no rejection).
    state.desktopRejected = null;
    meshDesktop.join(fakeStream());
    await sleep(700);
    assert.equal(state.desktopRejected, null, 'join succeeds once the other device left');

    // 5. …and now the PHONE is the refused one.
    meshPhone.join(fakeStream());
    await waitFor(() => state.phoneRejected, 8000);
    assert.equal(state.phoneRejected.reason, 'already-in-call');

    meshPhone.destroy();
    meshDesktop.destroy();
    await sleep(200);
  } finally {
    sockets.forEach(s => { try { s.close?.(); s.destroy?.(); } catch {} });
  }
});
