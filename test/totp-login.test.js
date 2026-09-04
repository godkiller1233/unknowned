// Integration coverage for the Wave-A security work: TOTP second-factor login,
// recovery-code one-time use, the session/device manager, and the new-login
// sign-in notice. Runs against a real server + disposable PostgreSQL database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPgReachable, startDisposableServer } from './helpers/disposable-server.js';
import { totpAt } from '../server/totp.js';

const PASSWORD = 'wave-a-pass-1';
const stamp = () => Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 6);

async function register(srv, role) {
  const res = await srv.api('/api/register', null, {
    method: 'POST',
    body: { username: `wa_${role}_${stamp()}`, password: PASSWORD, device: role + '-device' },
  });
  assert.equal(res.status, 200, 'register failed: ' + JSON.stringify(res));
  return res;
}

async function login(srv, username, password, device) {
  const res = await srv.api('/api/login', null, { method: 'POST', body: { username, password, device } });
  assert.equal(res.status, 200, 'login failed: ' + JSON.stringify(res));
  return res;
}

function currentCode(secret) {
  return totpAt(secret, Math.floor(Date.now() / 1000));
}

// The shared api() helper spreads JSON bodies into an object, which loses array
// shapes; fetch array endpoints directly.
async function getArray(srv, path, token) {
  const r = await fetch(srv.base + path, { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(r.status, 200, 'GET ' + path + ' failed');
  return r.json();
}

test('TOTP enable/login/disable lifecycle with recovery codes', { timeout: 120000 }, async t => {
  if (!(await isPgReachable())) {
    t.skip('PostgreSQL not reachable — set TEST_PG_ADMIN_URL to run integration tests');
    return;
  }
  const srv = await startDisposableServer();
  t.after(() => srv.stop());

  const reg = await register(srv, 'lifecycle');
  const username = reg.user.username;

  // setup requires the password and returns a base32 secret + otpauth URI
  const badPw = await srv.api('/api/me/2fa/setup', reg.token, { method: 'POST', body: { password: 'nope-nope' } });
  assert.equal(badPw.status, 401, 'setup must require the current password');
  const setup = await srv.api('/api/me/2fa/setup', reg.token, { method: 'POST', body: { password: PASSWORD } });
  assert.equal(setup.status, 200, 'setup failed: ' + JSON.stringify(setup));
  assert.match(setup.secret, /^[A-Z2-7]{16,}$/, 'setup must return a base32 secret');
  assert.ok(setup.otpauthUrl.startsWith('otpauth://totp/'), 'otpauth URI for authenticator apps');

  // wrong code cannot enable
  const badEnable = await srv.api('/api/me/2fa/enable', reg.token, { method: 'POST', body: { code: '000000' } });
  assert.equal(badEnable.status, 401, 'enable must verify the code');
  const row = await srv.admin.query('SELECT totp_enabled FROM users WHERE id=$1', [reg.user.id]);
  assert.equal(Number(row.rows[0].totp_enabled), 0, '2FA must stay disabled after a bad code');

  // correct code enables and returns ten recovery codes
  const enable = await srv.api('/api/me/2fa/enable', reg.token, { method: 'POST', body: { code: currentCode(setup.secret) } });
  assert.equal(enable.status, 200, 'enable failed: ' + JSON.stringify(enable));
  assert.equal(enable.recoveryCodes.length, 10, 'enable returns 10 recovery codes');
  for (const c of enable.recoveryCodes) assert.match(c, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/, 'recovery code shape');
  const row2 = await srv.admin.query('SELECT totp_enabled, recovery_codes FROM users WHERE id=$1', [reg.user.id]);
  assert.equal(Number(row2.rows[0].totp_enabled), 1);
  // stored recovery codes are hashes, never plaintext
  const stored = JSON.parse(row2.rows[0].recovery_codes);
  assert.equal(stored.length, 10);
  assert.ok(!stored.includes(enable.recoveryCodes[0]), 'DB must store hashes, not plaintext recovery codes');

  // second enable is refused
  const dup = await srv.api('/api/me/2fa/enable', reg.token, { method: 'POST', body: { code: currentCode(setup.secret) } });
  assert.equal(dup.status, 400, 'double-enable refused');

  // password-only login now demands the second factor
  const need2fa = await login(srv, username, PASSWORD, 'lifecycle-browser');
  assert.equal(need2fa.need2fa, true, 'login must demand 2FA once enabled');
  assert.ok(need2fa.preToken, 'pre-token for the second step');
  assert.equal(need2fa.token, undefined, 'no session token before 2FA');
  assert.equal(need2fa.totpEnabled, undefined);

  // wrong second-factor code is rejected
  const bad2fa = await srv.api('/api/login/2fa', null, { method: 'POST', body: { preToken: need2fa.preToken, code: '000000' } });
  assert.equal(bad2fa.status, 401, 'bad TOTP rejected at the second step');

  // correct TOTP completes login
  const good2fa = await srv.api('/api/login/2fa', null, {
    method: 'POST',
    body: { preToken: need2fa.preToken, code: currentCode(setup.secret), device: 'lifecycle-browser' },
  });
  assert.equal(good2fa.status, 200, 'TOTP second step failed: ' + JSON.stringify(good2fa));
  assert.equal(good2fa.totpEnabled, true);
  assert.equal(good2fa.usedRecovery, false);
  const boot = await srv.api('/api/bootstrap', good2fa.token);
  assert.equal(boot.status, 200, 'session issued after 2FA must work');

  // a recovery code logs in exactly once and is then consumed
  const needAgain = await login(srv, username, PASSWORD, 'lifecycle-recovery-device');
  assert.equal(needAgain.need2fa, true);
  const recovery = enable.recoveryCodes[0];
  const recLogin = await srv.api('/api/login/2fa', null, {
    method: 'POST',
    body: { preToken: needAgain.preToken, code: recovery, device: 'lifecycle-recovery-device' },
  });
  assert.equal(recLogin.status, 200, 'recovery login failed: ' + JSON.stringify(recLogin));
  assert.equal(recLogin.usedRecovery, true);
  assert.equal((await srv.api('/api/bootstrap', recLogin.token)).status, 200);
  const afterConsume = await srv.admin.query('SELECT recovery_codes FROM users WHERE id=$1', [reg.user.id]);
  assert.equal(JSON.parse(afterConsume.rows[0].recovery_codes).length, 9, 'used recovery code removed');

  // the consumed code must not work a second time
  const reuse = await srv.api('/api/login/2fa', null, {
    method: 'POST',
    body: { preToken: (await login(srv, username, PASSWORD, 'lifecycle-reuse-device')).preToken, code: recovery },
  });
  assert.equal(reuse.status, 401, 'reused recovery code rejected');

  // disable requires password + a valid code and turns 2FA back off
  const disable = await srv.api('/api/me/2fa/disable', good2fa.token, {
    method: 'POST',
    body: { password: PASSWORD, code: currentCode(setup.secret) },
  });
  assert.equal(disable.status, 200, 'disable failed: ' + JSON.stringify(disable));
  const plain = await login(srv, username, PASSWORD, 'lifecycle-plain-device');
  assert.equal(plain.need2fa, undefined, 'password-only login works again after disable');
  assert.ok(plain.token);
});

test('session manager lists devices and revokes other sessions', { timeout: 120000 }, async t => {
  if (!(await isPgReachable())) {
    t.skip('PostgreSQL not reachable — set TEST_PG_ADMIN_URL to run integration tests');
    return;
  }
  const srv = await startDisposableServer();
  t.after(() => srv.stop());

  const reg = await register(srv, 'sessions');
  // device label came from the register body
  let list = await getArray(srv, '/api/me/sessions', reg.token);
  assert.equal(list.length, 1);
  assert.equal(list[0].device, 'sessions-device');
  assert.equal(list[0].current, true);

  // a second login on a different device creates a second live session
  const second = await login(srv, reg.user.username, PASSWORD, 'sessions-phone');
  list = await getArray(srv, '/api/me/sessions', second.token);
  assert.equal(list.length, 2);
  const phone = list.find(s => s.device === 'sessions-phone');
  const desktop = list.find(s => s.device === 'sessions-device');
  assert.ok(phone && desktop, 'both devices listed');
  assert.equal(phone.current, true, 'second session marks itself current');

  // revoke the first session by id; its token stops working immediately
  const revokeOne = await srv.api('/api/me/sessions/revoke', second.token, { method: 'POST', body: { sessionId: desktop.id } });
  assert.equal(revokeOne.status, 200);
  assert.equal((await srv.api('/api/bootstrap', reg.token)).status, 401, 'revoked session rejected');
  assert.equal((await srv.api('/api/bootstrap', second.token)).status, 200, 'current session unaffected');

  // revoke-others keeps only the caller
  const third = await login(srv, reg.user.username, PASSWORD, 'sessions-laptop');
  const revokeAll = await srv.api('/api/me/sessions/revoke-others', third.token, { method: 'POST' });
  assert.equal(revokeAll.status, 200);
  list = await getArray(srv, '/api/me/sessions', third.token);
  assert.equal(list.length, 1, 'only the current session survives revoke-others');
  assert.equal((await srv.api('/api/bootstrap', second.token)).status, 401, 'previous session revoked');
});

test('new-device sign-ins raise a notification only when the account is already live', { timeout: 120000 }, async t => {
  if (!(await isPgReachable())) {
    t.skip('PostgreSQL not reachable — set TEST_PG_ADMIN_URL to run integration tests');
    return;
  }
  const srv = await startDisposableServer();
  t.after(() => srv.stop());

  const reg = await register(srv, 'notify');
  // brand-new account: first login must NOT produce a new-login banner
  const first = await login(srv, reg.user.username, PASSWORD, 'notify-pc');
  let notifs = await getArray(srv, '/api/notifications', first.token);
  assert.equal(notifs.filter(n => n.type === 'new_login').length, 0, 'no self-notification on first login');

  // same device again: still no banner
  const sameDevice = await login(srv, reg.user.username, PASSWORD, 'notify-pc');
  notifs = await getArray(srv, '/api/notifications', sameDevice.token);
  assert.equal(notifs.filter(n => n.type === 'new_login').length, 0, 'known device is not a new sign-in');

  // Backdate the account past the 10-minute onboarding window, then sign in
  // from a genuinely new device while the old session is live: one notification.
  await srv.admin.query("UPDATE users SET created_at = CURRENT_TIMESTAMP - INTERVAL '30 minutes' WHERE id=$1", [reg.user.id]);
  const newDevice = await login(srv, reg.user.username, PASSWORD, 'notify-tablet');
  notifs = await getArray(srv, '/api/notifications', newDevice.token);
  const banners = notifs.filter(n => n.type === 'new_login');
  assert.equal(banners.length, 1, 'exactly one new-login banner');
  assert.equal(banners[0].body, 'New sign-in from notify-tablet');
});