// TURN / ICE configuration: the server must publish the operator's TURN servers
// in /api/bootstrap (authenticated) and every WebRTC surface (DM calls and the
// voice mesh) must build its RTCPeerConnections from that list, so users behind
// symmetric NAT can actually connect. Runs against a disposable PostgreSQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPgReachable, startDisposableServer, sleep } from './helpers/disposable-server.js';
import { createVoiceMesh } from '../src/mesh.js';
import { DEFAULT_ICE_SERVERS, applyRtcConfig, getIceServers } from '../src/rtc.js';

const TURN_ENV = {
  TURN_URLS: 'turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp',
  TURN_USERNAME: 'rtc-user',
  TURN_CREDENTIAL: 'rtc-secret',
};

// Node has no RTCPeerConnection; a minimal stub that records the constructor
// options so we can assert which ICE servers the mesh actually passes.
const created = [];
class FakePC {
  constructor(opts) { this.opts = opts; created.push(this); }
  addTrack() {}
  async createOffer() { return { type: 'offer', sdp: 'fake-offer' }; }
  async createAnswer() { return { type: 'answer', sdp: 'fake-answer' }; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  close() { this.closed = true; }
}
global.RTCPeerConnection = FakePC;

const fakeStream = () => ({ getTracks: () => [] });

// Minimal socket double: records emits, lets the test fire the mesh's own
// socket-event handlers (voice_roster etc.) directly.
function fakeSocket() {
  const handlers = {};
  const emits = [];
  return {
    handlers, emits, connected: true,
    // The session-keyed offer rule compares socket ids — this fixture must look
    // like a real connected socket that sorts below the roster's 's2'.
    id: 's1',
    on(ev, fn) { handlers[ev] = fn; },
    off(ev) { delete handlers[ev]; },
    emit(ev, payload) { emits.push([ev, payload]); },
    fire(ev, payload) { handlers[ev]?.(payload); },
  };
}

test('bootstrap publishes the operator TURN config to authenticated clients', { timeout: 90000 }, async t => {
  if (!(await isPgReachable())) {
    t.skip('PostgreSQL not reachable — set TEST_PG_ADMIN_URL to run integration tests');
    return;
  }
  const srv = await startDisposableServer({ env: TURN_ENV });
  t.after(() => srv.stop());

  const { api } = srv;
  const stamp = Date.now().toString(36).slice(-6);
  const u = await api('/api/register', null, { method: 'POST', body: { username: `rtc_${stamp}`, password: 'rtc-pass-1' } });
  assert.equal(u.status, 200, JSON.stringify(u));

  const boot = await api('/api/bootstrap', u.token);
  assert.equal(boot.status, 200);
  assert.ok(boot.rtc, 'bootstrap must carry an rtc block');
  assert.deepEqual(boot.rtc.iceServers, [
    { urls: ['stun:stun.l.google.com:19302'] },
    { urls: ['stun:global.stun.twilio.com:3478'] },
    { urls: TURN_ENV.TURN_URLS.split(','), username: TURN_ENV.TURN_USERNAME, credential: TURN_ENV.TURN_CREDENTIAL },
  ]);
});

test('bootstrap falls back to STUN + public TURN relay when no TURN is configured', { timeout: 90000 }, async t => {
  if (!(await isPgReachable())) {
    t.skip('PostgreSQL not reachable — set TEST_PG_ADMIN_URL to run integration tests');
    return;
  }
  const srv = await startDisposableServer({ env: { TURN_URLS: '' } });
  t.after(() => srv.stop());

  const { api } = srv;
  const stamp = Date.now().toString(36).slice(-6);
  const u = await api('/api/register', null, { method: 'POST', body: { username: `rtc_n_${stamp}`, password: 'rtc-pass-1' } });
  assert.equal(u.status, 200, JSON.stringify(u));

  const boot = await api('/api/bootstrap', u.token);
  const ice = boot.rtc.iceServers;
  assert.ok(ice.some(s => s.urls.includes('stun:stun.l.google.com:19302')), 'STUN default still present');
  const relay = ice.find(s => (s.urls || []).some(u => /^turns?:/i.test(u)));
  assert.ok(relay, 'public TURN fallback must be present when no operator relay is configured');
  assert.ok(relay.username && relay.credential, 'fallback relay needs credentials');
});

test('voice mesh builds peer connections with the configured ICE servers', { timeout: 30000 }, async () => {
  const custom = [{ urls: ['stun:custom.example.com:3478'] }, { urls: ['turn:relay.example.com:3478'], username: 'u', credential: 'p' }];

  // 1. Explicit iceServers option wins.
  const sock = fakeSocket();
  const mesh = createVoiceMesh({ socket: sock, channelId: 'ch1', me: { id: '1' }, iceServers: custom });
  mesh.join(fakeStream());
  sock.fire('voice_roster', { channelId: 'ch1', users: [{ userId: '2', socketId: 's2', username: 'b' }] });
  await sleep(30);
  assert.ok(created.length >= 1, 'a peer connection must have been created');
  assert.deepEqual(created[created.length - 1].opts.iceServers, custom, 'mesh must use the passed iceServers');
  mesh.destroy();

  // 2. Without an explicit option the mesh honors the cached bootstrap config.
  const fromBoot = [{ urls: ['stun:stun.l.google.com:19302'] }, { urls: ['turn:relay.example.com:5349'], username: 'x', credential: 'y' }];
  assert.equal(applyRtcConfig({ rtc: { iceServers: fromBoot } }), fromBoot);
  assert.equal(getIceServers(), fromBoot);

  const sock2 = fakeSocket();
  const mesh2 = createVoiceMesh({ socket: sock2, channelId: 'ch2', me: { id: '1' } });
  mesh2.join(fakeStream());
  sock2.fire('voice_roster', { channelId: 'ch2', users: [{ userId: '2', socketId: 's2', username: 'b' }] });
  await sleep(30);
  assert.deepEqual(created[created.length - 1].opts.iceServers, fromBoot, 'mesh must use cached bootstrap iceServers');
  mesh2.destroy();

  // 3. Reset the module cache so other tests start from the STUN default.
  applyRtcConfig({ rtc: { iceServers: DEFAULT_ICE_SERVERS } });
});
