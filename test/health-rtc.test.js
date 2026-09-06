// /api/health/rtc — operator diagnostics for voice/video calls. Probes real TURN
// urls locally: a UDP url is checked with a genuine STUN binding request (a TURN
// server answers those from the same port), TCP/TLS urls with a TCP connect.
// The endpoint must never echo credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import { isPgReachable, startDisposableServer } from './helpers/disposable-server.js';
import { applyRtcConfig, hasTurnRelay, DEFAULT_ICE_SERVERS } from '../src/rtc.js';

// A minimal TURN-ish UDP peer: answers any STUN binding request by echoing the
// datagram back (magic cookie round-trips), exactly what a relay would do.
function udpStunServer() {
  return new Promise(resolve => {
    const sock = dgram.createSocket('udp4');
    sock.on('message', (buf, rinfo) => {
      try { sock.send(buf, rinfo.port, rinfo.address); } catch {}
    });
    sock.once('error', () => {});
    sock.bind(0, '127.0.0.1', () => resolve({ port: sock.address().port, close: () => new Promise(r => sock.close(() => r())) }));
  });
}

function tcpServer() {
  return new Promise(resolve => {
    const srv = net.createServer(s => s.destroy());
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => new Promise(r => srv.close(() => r())) }));
  });
}

async function closedUdpPort() {
  const s = await udpStunServer();
  await s.close();
  return s.port; // bound then released — nothing listens here
}

test('/api/health/rtc: no TURN configured → degraded, STUN-only, no secrets', { timeout: 90000 }, async t => {
  if (!(await isPgReachable())) {
    t.skip('PostgreSQL not reachable — set TEST_PG_ADMIN_URL to run integration tests');
    return;
  }
  const srv = await startDisposableServer({ env: { TURN_URLS: '' } });
  t.after(() => srv.stop());
  const r = await srv.api('/api/health/rtc'); // public — no token
  assert.equal(r.status, 200);
  // The operator has no relay; bootstrap hands clients a public fallback, but
  // the health report is about OPERATOR config: none configured, none probed.
  assert.equal(r.turn.configured, false);
  assert.equal(r.turn.reachable, null);
  assert.deepEqual(r.turn.urls, []);
});

test('/api/health/rtc: TURN urls probed — reachable and dead endpoints both reported, credentials never echoed', { timeout: 120000 }, async t => {
  if (!(await isPgReachable())) {
    t.skip('PostgreSQL not reachable — set TEST_PG_ADMIN_URL to run integration tests');
    return;
  }
  const good = await udpStunServer();
  const tcp = await tcpServer();
  const dead = await closedUdpPort();
  t.after(async () => { await good.close(); await tcp.close(); });

  const TURN_URLS = `turn:127.0.0.1:${good.port}?transport=udp,turn:127.0.0.1:${dead}?transport=udp,turn:127.0.0.1:${tcp.port}?transport=tcp`;
  const SECRET = 'super-secret-turn-value-xyz';
  const srv = await startDisposableServer({ env: { TURN_URLS, TURN_USERNAME: 'relay-user', TURN_CREDENTIAL: SECRET } });
  t.after(() => srv.stop());

  const r = await srv.api('/api/health/rtc');
  assert.equal(r.status, 200);
  assert.equal(r.turn.configured, true);
  assert.equal(r.degraded, false);
  const body = JSON.stringify(r);
  assert.ok(!body.includes(SECRET) && !body.includes('relay-user'), 'health endpoint must never echo TURN credentials');
  assert.equal(r.turn.urls.length, 3);

  const udpGood = r.turn.urls.find(u => u.transport === 'udp' && Number(u.port) === good.port);
  const udpDead = r.turn.urls.find(u => u.transport === 'udp' && Number(u.port) === dead);
  const tcpOk = r.turn.urls.find(u => u.transport === 'tcp' && Number(u.port) === tcp.port);
  assert.equal(udpGood.reachable, true, 'the live STUN responder must answer the probe');
  assert.equal(udpDead.reachable, false, 'a silent port must report unreachable');
  assert.equal(tcpOk.reachable, true, 'an open TCP port must connect');
  assert.equal(r.turn.reachable, false, 'not every url answering means the relay is healthy');
  assert.equal(r.ok, false, 'mixed reachability must not report fully healthy');
});

test('/api/health/rtc: all TURN urls answering → ok:true', { timeout: 90000 }, async t => {
  if (!(await isPgReachable())) {
    t.skip('PostgreSQL not reachable — set TEST_PG_ADMIN_URL to run integration tests');
    return;
  }
  const good = await udpStunServer();
  t.after(() => good.close());
  const srv = await startDisposableServer({ env: { TURN_URLS: `turn:127.0.0.1:${good.port}?transport=udp` } });
  t.after(() => srv.stop());
  const r = await srv.api('/api/health/rtc');
  assert.equal(r.ok, true);
  assert.equal(r.degraded, false);
  assert.equal(r.turn.reachable, true);
});

test('client rtc.js: hasTurnRelay reflects the bootstrap config', () => {
  applyRtcConfig({ rtc: { iceServers: DEFAULT_ICE_SERVERS } });
  assert.equal(hasTurnRelay(), false, 'STUN-only config has no relay');
  applyRtcConfig({ rtc: { iceServers: [{ urls: ['stun:x'] }, { urls: ['turn:relay.example.com:3478'], username: 'u', credential: 'p' }] } });
  assert.equal(hasTurnRelay(), true, 'a turn: url must count as a relay');
  applyRtcConfig({ rtc: { iceServers: [{ urls: ['turns:relay.example.com:5349'] }] } });
  assert.equal(hasTurnRelay(), true, 'a turns: url must count as a relay');
  applyRtcConfig({ rtc: { iceServers: DEFAULT_ICE_SERVERS } });
});
