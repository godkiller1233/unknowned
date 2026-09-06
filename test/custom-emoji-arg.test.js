import test from 'node:test';
import assert from 'node:assert/strict';
import { io as Client } from 'socket.io-client';
import { isPgReachable, startDisposableServer, sleep } from './helpers/disposable-server.js';

test('custom emojis: add, list, chat token contract, delete', { timeout: 120000 }, async t => {
  if (!(await isPgReachable())) {
    t.skip('PostgreSQL not reachable — set TEST_PG_ADMIN_URL (e.g. a CI postgres service container) to run integration tests');
    return;
  }

  const srv = await startDisposableServer();
  t.after(() => srv.stop());
  const { api } = srv;
  const stamp = Date.now().toString(36).slice(-6);

  const a = await api('/api/register', null, { method: 'POST', body: { username: `emo_${stamp}`, password: 'emoji-pass-1' } });
  assert.equal(a.status, 200, 'register works: ' + JSON.stringify(a));

  // Empty list initially
  let d = await api('/api/emojis', a.token);
  assert.equal(d.status, 200);
  assert.deepEqual(d.emojis, []);

  // Add one (external URL) — name is normalized
  d = await api('/api/emojis', a.token, { method: 'POST', body: { name: 'Parrot!', url: 'https://example.com/parrot.png' } });
  assert.equal(d.status, 200, JSON.stringify(d));
  assert.equal(d.emoji.name, 'parrot');
  assert.equal(d.emoji.url, 'https://example.com/parrot.png');

  // Duplicate name rejected
  d = await api('/api/emojis', a.token, { method: 'POST', body: { name: 'parrot', url: 'https://example.com/x.png' } });
  assert.equal(d.status, 409);

  // Names are sanitized (invalid chars stripped), then the result is validated:
  // only too-short/too-long remainders are rejected.
  for (const bad of ['a', '', '!!!', 'x'.repeat(25)]) {
    d = await api('/api/emojis', a.token, { method: 'POST', body: { name: bad, url: 'https://example.com/x.png' } });
    assert.equal(d.status, 400, `name "${bad}" must be rejected`);
  }
  // "HAS SPACE" sanitizes to "hasspace" — accepted, stored lowercase.
  d = await api('/api/emojis', a.token, { method: 'POST', body: { name: 'HAS SPACE', url: 'https://example.com/x.png' } });
  assert.equal(d.status, 200, JSON.stringify(d));
  assert.equal(d.emoji.name, 'hasspace');
  await api('/api/emojis/hasspace', a.token, { method: 'DELETE' });
  // Invalid URL rejected
  d = await api('/api/emojis', a.token, { method: 'POST', body: { name: 'validname', url: 'ftp://example.com/x.png' } });
  assert.equal(d.status, 400);

  // List shows it
  d = await api('/api/emojis', a.token);
  assert.equal(d.emojis.length, 1);
  assert.equal(d.emojis[0].name, 'parrot');
  assert.equal(d.emojis[0].creator_id, a.user.id);

  // A stranger cannot delete someone else's emoji
  const b = await api('/api/register', null, { method: 'POST', body: { username: `emo2_${stamp}`, password: 'emoji-pass-1' } });
  assert.equal(b.status, 200);
  d = await api('/api/emojis/parrot', b.token, { method: 'DELETE' });
  assert.equal(d.status, 403);

  // Creator can delete
  d = await api('/api/emojis/parrot', a.token, { method: 'DELETE' });
  assert.equal(d.status, 200);
  d = await api('/api/emojis', a.token);
  assert.deepEqual(d.emojis, []);
});

test('arg progress: steps recorded, status reports step, admin view gated', { timeout: 120000 }, async t => {
  if (!(await isPgReachable())) {
    t.skip('PostgreSQL not reachable — set TEST_PG_ADMIN_URL (e.g. a CI postgres service container) to run integration tests');
    return;
  }

  const srv = await startDisposableServer();
  t.after(() => srv.stop());
  const { api } = srv;
  const stamp = Date.now().toString(36).slice(-6);

  const a = await api('/api/register', null, { method: 'POST', body: { username: `arg_${stamp}`, password: 'arg-pass-1' } });
  assert.equal(a.status, 200);

  // Invalid step rejected
  let d = await api('/api/arg/progress', a.token, { method: 'POST', body: { step: 'basement' } });
  assert.equal(d.status, 400);

  // Walk the steps
  for (const step of ['login', 'terminal', 'code']) {
    d = await api('/api/arg/progress', a.token, { method: 'POST', body: { step } });
    assert.equal(d.status, 200, JSON.stringify(d));
    const st = await api('/api/arg/status', a.token);
    assert.equal(st.step, step, 'status must report the latest step');
  }

  // Bootstrap carries argStep too
  const boot = await api('/api/bootstrap', a.token);
  assert.equal(boot.argStep, 'code');

  // Non-admin cannot read the admin view
  d = await api('/api/admin/arg/progress', a.token);
  assert.equal(d.status, 403);

  // Admin sees the player (the harness seeds a deterministic platform admin)
  const adm = await api('/api/login', null, { method: 'POST', body: { username: 'TestAdmin', password: 'test-admin-pass-1' } });
  assert.equal(adm.status, 200, 'seeded admin login: ' + JSON.stringify(adm));
  d = await api('/api/admin/arg/progress', adm.token);
  assert.equal(d.status, 200, JSON.stringify(d));
  const row = (d.progress || []).find(r => r.user_id === a.user.id);
  assert.ok(row, 'the player appears in the admin view');
  assert.equal(row.step, 'code');
  assert.equal(row.completed_at, null, 'not finished yet');
});

test('custom emojis: socket broadcast nudges other sessions', { timeout: 120000 }, async t => {
  if (!(await isPgReachable())) {
    t.skip('PostgreSQL not reachable — set TEST_PG_ADMIN_URL (e.g. a CI postgres service container) to run integration tests');
    return;
  }

  const srv = await startDisposableServer();
  t.after(() => srv.stop());
  const { base, api } = srv;
  const stamp = Date.now().toString(36).slice(-6);

  const a = await api('/api/register', null, { method: 'POST', body: { username: `sock_${stamp}`, password: 'emoji-pass-1' } });
  assert.equal(a.status, 200);
  const sock = Client(base, { auth: { token: a.token }, transports: ['websocket'], reconnection: false });
  t.after(() => { try { sock.close(); } catch {} });
  await new Promise((res, rej) => { sock.once('connect', res); sock.once('connect_error', rej); });

  const updates = [];
  sock.on('custom_emojis_update', () => updates.push(Date.now()));
  await api('/api/emojis', a.token, { method: 'POST', body: { name: 'wave', url: 'https://example.com/wave.png' } });
  await sleep(600);
  assert.ok(updates.length >= 1, 'connected sockets must be notified of emoji changes');
});
