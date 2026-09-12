import test from 'node:test';
import assert from 'node:assert/strict';
import { isPgReachable, startDisposableServer } from './helpers/disposable-server.js';

test('mic loopback returns the submitted recording without persisting it', { timeout: 120000 }, async t => {
  if (!(await isPgReachable())) {
    t.skip('PostgreSQL not reachable — set TEST_PG_ADMIN_URL to run integration tests');
    return;
  }
  const srv = await startDisposableServer();
  t.after(() => srv.stop());
  const stamp = Date.now().toString(36).slice(-6);
  const registered = await srv.api('/api/register', null, {
    method: 'POST',
    body: { username: `mic_${stamp}`, password: 'mic-pass-1' },
  });
  assert.equal(registered.status, 200, JSON.stringify(registered));

  const payload = Buffer.from('synthetic microphone recording');
  const response = await fetch(srv.base + '/api/me/mic-test', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${registered.token}`,
      'Content-Type': 'audio/webm;codecs=opus',
    },
    body: payload,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-mic-test-server'), 'loopback');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);

  const unauthorized = await fetch(srv.base + '/api/me/mic-test', {
    method: 'POST',
    headers: { 'Content-Type': 'audio/webm' },
    body: payload,
  });
  assert.equal(unauthorized.status, 401);
});
