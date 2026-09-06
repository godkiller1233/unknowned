// DB-backed, admin-editable TURN relay settings. The operator saves the relay
// config in the shared PostgreSQL database (server_settings) instead of per
// instance environment, so every app instance serves the same iceServers. The
// environment variables remain the fallback when a value is cleared, and the
// credential is write-only (never returned by any endpoint).
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { isPgReachable, startDisposableServer } from './helpers/disposable-server.js';

const ADMIN = { username: 'TestAdmin', password: 'test-admin-pass-1' };

// Minimal TURN-ish UDP peer: echoes any STUN binding request back so the probe
// (which checks the magic-cookie round-trip) reports the url as reachable.
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

async function login(srv, username = ADMIN.username, password = ADMIN.password) {
  const r = await srv.api('/api/login', null, { method: 'POST', body: { username, password } });
  assert.equal(r.status, 200, `login failed for ${username}: ${JSON.stringify(r).slice(0, 200)}`);
  return r.token;
}

test('rtc admin: non-admin forbidden; env source reported; credential never returned', { timeout: 120000 }, async t => {
  if (!(await isPgReachable())) {
    t.skip('PostgreSQL not reachable — set TEST_PG_ADMIN_URL to run integration tests');
    return;
  }
  const srv = await startDisposableServer({ env: { TURN_URLS: 'turn:relay.env.example:3478?transport=udp', TURN_USERNAME: 'env-user', TURN_CREDENTIAL: 'env-secret' } });
  t.after(() => srv.stop());

  const reg = await srv.api('/api/register', null, { method: 'POST', body: { username: 'plainuser', password: 'secret123' } });
  assert.equal(reg.status, 200);
  const denied = await srv.api('/api/admin/rtc', reg.token);
  assert.equal(denied.status, 403, 'non-admin must be forbidden');

  const token = await login(srv);
  const get = await srv.api('/api/admin/rtc', token);
  assert.equal(get.status, 200);
  assert.equal(get.source, 'env', 'no DB rows yet → env fallback is the source');
  assert.equal(get.credentialConfigured, true, 'env credential counts as configured');
  const body = JSON.stringify(get);
  assert.ok(!body.includes('env-secret'), 'credential must never be echoed');

  const r2 = await srv.api('/api/admin/rtc', token, { method: 'PUT', body: { turnUrls: 'turn:bad url', username: 'u', credential: 'c' } });
  assert.equal(r2.status, 400, 'invalid TURN url must be rejected');
});

test('rtc admin: save applies immediately — bootstrap carries relay + credential, credential write-only, blank keeps it, clear removes it', { timeout: 120000 }, async t => {
  if (!(await isPgReachable()) && (t.skip('PostgreSQL not reachable — set TEST_PG_ADMIN_URL to run integration tests'), true)) return;
  const echo = await udpStunServer();
  const srv = await startDisposableServer({ env: { TURN_URLS: '' } });
  t.after(async () => { await srv.stop(); await echo.close(); });
  const token = await login(srv);
  const urls = `turn:127.0.0.1:${echo.port}?transport=udp`;

  // Fresh DB, no env → no operator relay (clients get the public fallback).
  const before = await srv.api('/api/health/rtc');
  assert.equal(before.turn.configured, false);

  const put = await srv.api('/api/admin/rtc', token, { method: 'PUT', body: { turnUrls: urls, username: 'relay-user', credential: 'super-secret-pass' } });
  assert.equal(put.status, 200, JSON.stringify(put));
  assert.equal(put.credentialConfigured, true);
  assert.equal(put.health.ok, true, 'live probe must answer the configured relay');
  assert.ok(!JSON.stringify(put).includes('super-secret-pass'), 'PUT response must not echo credential');

  // Same instance, no restart: bootstrap serves the saved relay.
  const boot = await srv.api('/api/bootstrap', token);
  const ice = boot.rtc?.iceServers || [];
  const relay = ice.find(s => (s.urls || []).some(u => u.startsWith('turn:')));
  assert.ok(relay, 'bootstrap must carry the saved TURN relay');
  assert.equal(relay.username, 'relay-user');
  assert.equal(relay.credential, 'super-secret-pass', 'clients legitimately receive the credential for the call');

  // GET: never the credential, but flags it as configured.
  const get = await srv.api('/api/admin/rtc', token);
  assert.equal(get.source, 'db');
  assert.equal(get.username, 'relay-user');
  assert.equal(get.credentialConfigured, true);
  assert.ok(!JSON.stringify(get).includes('super-secret-pass'));

  // Second PUT with a blank credential must keep the stored one.
  const put2 = await srv.api('/api/admin/rtc', token, { method: 'PUT', body: { turnUrls: urls, username: 'relay-user-2' } });
  assert.equal(put2.status, 200);
  assert.equal(put2.credentialConfigured, true, 'blank credential must keep the stored credential');
  const boot2 = await srv.api('/api/bootstrap', token);
  const relay2 = (boot2.rtc?.iceServers || []).find(s => (s.urls || []).some(u => u.startsWith('turn:')));
  assert.equal(relay2.username, 'relay-user-2');
  assert.equal(relay2.credential, 'super-secret-pass');

  // clearCredential removes it (env empty here → no credential at all).
  const put3 = await srv.api('/api/admin/rtc', token, { method: 'PUT', body: { turnUrls: urls, username: 'relay-user-2', clearCredential: true } });
  assert.equal(put3.credentialConfigured, false);
  const boot3 = await srv.api('/api/bootstrap', token);
  const relay3 = (boot3.rtc?.iceServers || []).find(s => (s.urls || []).some(u => u.startsWith('turn:')));
  assert.ok(relay3 && !relay3.credential && !relay3.username, 'credential and username cleared');
});

test('rtc admin: cross-instance sync — save on instance A is served by instance B with no restart', { timeout: 180000 }, async t => {
  if (!(await isPgReachable()) && (t.skip('PostgreSQL not reachable — set TEST_PG_ADMIN_URL to run integration tests'), true)) return;
  const echo = await udpStunServer();
  const urls = `turn:127.0.0.1:${echo.port}?transport=udp`;
  const srvA = await startDisposableServer({ env: { TURN_URLS: '' } });
  // Second instance: same database, own process, own JWT secret, no TURN env.
  const srvB = await startDisposableServer({ reuse: { dbName: srvA.dbName, dbUrl: srvA.dbUrl }, env: { TURN_URLS: '' } });
  t.after(async () => { await srvB.stop(); await srvA.stop(); await echo.close(); });

  // Instance B starts with no operator relay even though it shares A's DB
  // (bootstrap carries the STUN pair + the public fallback relay entry).
  const bootB0 = await srvB.api('/api/bootstrap', await login(srvB));
  const iceB0 = bootB0.rtc?.iceServers || [];
  assert.ok(!iceB0.some(s => (s.urls || []).some(u => /127\.0\.0\.1/.test(u))), 'no operator relay before the save');
  assert.ok(iceB0.some(s => (s.urls || []).some(u => /^turns?:/i.test(u))), 'public fallback relay present');

  // Admin on instance A saves the relay.
  const tokenA = await login(srvA);
  const put = await srvA.api('/api/admin/rtc', tokenA, { method: 'PUT', body: { turnUrls: urls, username: 'shared-relay', credential: 'shared-pass' } });
  assert.equal(put.status, 200, JSON.stringify(put));

  // Instance B serves the same config immediately — no restart, no env on B.
  const getB = await srvB.api('/api/admin/rtc', await login(srvB));
  assert.equal(getB.source, 'db');
  assert.equal(getB.turnUrls, urls);
  assert.equal(getB.credentialConfigured, true);
  const bootB = await srvB.api('/api/bootstrap', await login(srvB));
  const relay = (bootB.rtc?.iceServers || []).find(s => (s.urls || []).some(u => u.startsWith('turn:')));
  assert.ok(relay, 'instance B must serve the relay saved on instance A');
  assert.equal(relay.username, 'shared-relay');
  assert.equal(relay.credential, 'shared-pass');

  // Clearing on B (both have empty env fallback) is visible on A too.
  const clear = await srvB.api('/api/admin/rtc', await login(srvB), { method: 'PUT', body: { turnUrls: '', username: '', clearCredential: true } });
  assert.equal(clear.status, 200);
  const getA = await srvA.api('/api/admin/rtc', tokenA);
  assert.equal(getA.source, 'env');
  assert.equal(getA.turnUrls, '', 'A sees the cleared value → env fallback (empty)');
  assert.equal(getA.credentialConfigured, false);
});
