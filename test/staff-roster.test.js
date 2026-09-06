import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPgReachable,
  startDisposableServer,
} from './helpers/disposable-server.js';

// Staff roster: Founder-only view of who holds staff ranks and when the rank
// was granted. Grants made through the rank editor record the granting user;
// bootstrap grants (seed/ensureOfficialAccount) are recorded as system grants.
test('staff roster: founder-only listing with grant timestamps and granter', { timeout: 120000 }, async t => {
  if (!(await isPgReachable())) {
    t.skip('PostgreSQL not reachable — set TEST_PG_ADMIN_URL (e.g. a CI postgres service container) to run integration tests');
    return;
  }

  const srv = await startDisposableServer({
    env: { FOUNDER_USERNAME: 'TestFounder', FOUNDER_PASSWORD: 'founder-pass-1' },
  });
  t.after(() => srv.stop());

  try {
    const { api } = srv;

    // Bootstrap: TestAdmin (Administrator) and TestFounder (Founder) exist.
    const founder = await api('/api/login', null, { method: 'POST', body: { username: 'TestFounder', password: 'founder-pass-1' } });
    assert.equal(founder.status, 200, 'founder login failed: ' + JSON.stringify(founder));
    const admin = await api('/api/login', null, { method: 'POST', body: { username: 'TestAdmin', password: 'test-admin-pass-1' } });
    assert.equal(admin.status, 200, 'admin login failed');

    // 1) Founder sees the roster; both bootstrap staff accounts are listed.
    const res = await api('/api/admin/staff-roster', founder.token);
    assert.equal(res.status, 200, 'founder roster fetch failed: ' + JSON.stringify(res));
    const roster = res.roster || [];
    const byName = Object.fromEntries(roster.map(r => [r.username, r]));
    assert.ok(byName.TestFounder && byName.TestFounder.rank === 'Founder', 'founder listed');
    assert.ok(byName.TestAdmin && byName.TestAdmin.rank === 'Administrator', 'admin listed');
    assert.ok(byName.TestFounder.rank_granted_at, 'bootstrap grant has a timestamp');
    assert.equal(byName.TestFounder.granted_by_name ?? null, null, 'bootstrap grant has no granter (system)');
    // Ordered most-senior first: Founder before Administrator.
    assert.ok(roster.findIndex(r => r.username === 'TestFounder') < roster.findIndex(r => r.username === 'TestAdmin'), 'seniority order');

    // 2) Non-Founder staff (Administrator) is denied.
    const asAdmin = await api('/api/admin/staff-roster', admin.token);
    assert.equal(asAdmin.status, 403, 'Administrator must not read the roster');

    // 3) Regular users are denied (adminOnly gate).
    const stamp = Date.now().toString(36).slice(-6);
    const reg = await api('/api/register', null, { method: 'POST', body: { username: `roster_${stamp}`, password: 'roster-pass-1' } });
    assert.equal(reg.status, 200);
    const asUser = await api('/api/admin/staff-roster', reg.token);
    assert.equal(asUser.status, 403, 'regular user must not read the roster');

    // 4) Granting a rank through the editor records who granted it and when.
    const grant = await api(`/api/admin/users/${reg.user.id}`, founder.token, {
      method: 'PATCH',
      body: { isAdmin: true, banned: false, badge: '', rank: 'Mod' },
    });
    assert.equal(grant.status, 200, 'rank grant failed: ' + JSON.stringify(grant));
    const after = (await api('/api/admin/staff-roster', founder.token)).roster;
    const mod = after.find(r => r.username === `roster_${stamp}`);
    assert.ok(mod, 'newly promoted Mod appears in roster');
    assert.equal(mod.rank, 'Mod');
    assert.equal(mod.granted_by_name, 'TestFounder', 'granter recorded');
    assert.equal(mod.granted_by_rank, 'Founder');
    assert.ok(mod.rank_granted_at, 'grant timestamp recorded');
    const grantedAt1 = mod.rank_granted_at;

    // 5) Idempotent re-save (same rank) must NOT reset the grant timestamp.
    await api(`/api/admin/users/${reg.user.id}`, founder.token, {
      method: 'PATCH',
      body: { isAdmin: true, banned: false, badge: '', rank: 'Mod' },
    });
    const afterResave = (await api('/api/admin/staff-roster', founder.token)).roster;
    const modResave = afterResave.find(r => r.username === `roster_${stamp}`);
    assert.equal(modResave.rank_granted_at, grantedAt1, 're-saving the same rank preserves the original grant time');
  } catch (e) {
    e.message += '\n--- server log tail ---\n' + (srv.serverLog || '').slice(-1200);
    throw e;
  }
});
