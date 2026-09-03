import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPgReachable,
  startDisposableServer,
} from './helpers/disposable-server.js';

// Focused coverage for the register auto-join rule: a fresh account joins the
// public community flagged is_default, with the oldest public community as the
// fallback, and private communities are never auto-joined. The flag itself is
// managed through PATCH /api/communities/:id/default (owner/admin/platform-admin;
// public-only; at most one default).
const PASSWORD = 'autojoin-pass-1';
const stamp = () => Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 6);

async function register(srv, role) {
  const res = await srv.api('/api/register', null, {
    method: 'POST',
    body: { username: `aj_${role}_${stamp()}`, password: PASSWORD },
  });
  assert.equal(res.status, 200, `register ${role} failed: ` + JSON.stringify(res));
  return res;
}

async function login(srv, username, password) {
  const res = await srv.api('/api/login', null, { method: 'POST', body: { username, password } });
  assert.equal(res.status, 200, `login ${username} failed: ` + JSON.stringify(res));
  return res;
}

async function bootstrap(srv, token) {
  const res = await srv.api('/api/bootstrap', token);
  assert.equal(res.status, 200, 'bootstrap failed: ' + JSON.stringify(res));
  return res;
}

async function createCommunity(srv, token, name, visibility) {
  const res = await srv.api('/api/communities', token, {
    method: 'POST',
    body: { name, description: 'auto-join test community', visibility: visibility || 'public' },
  });
  assert.equal(res.status, 200, 'create community failed: ' + JSON.stringify(res));
  return res;
}

async function countDefaults(srv) {
  const r = await srv.admin.query('SELECT COUNT(*)::int AS c FROM communities WHERE is_default=1');
  return r.rows[0].c;
}

async function membershipIn(srv, userId, communityId) {
  const r = await srv.admin.query('SELECT 1 FROM memberships WHERE user_id=$1 AND community_id=$2', [userId, communityId]);
  return r.rowCount === 1;
}

// A brand-new user must have exactly one membership: in the community flagged
// is_default (never a private one). Returns { user, memberships } of that user.
async function assertSingleAutoJoin(srv, role, expectedName) {
  const reg = await register(srv, role);
  const boot = await bootstrap(srv, reg.token);
  assert.equal(boot.memberships.length, 1, `${role} must auto-join exactly one community`);
  const comm = boot.communities.find(c => c.id === boot.memberships[0].community_id);
  assert.ok(comm, `${role} membership must reference a known community`);
  assert.equal(comm.name, expectedName, `${role} should have joined "${expectedName}"`);
  return { ...reg, boot };
}

test('register auto-joins the default public community (is_default flag)', { timeout: 120000 }, async t => {
  if (!(await isPgReachable())) {
    t.skip('PostgreSQL not reachable — set TEST_PG_ADMIN_URL (e.g. a CI postgres service container) to run integration tests');
    return;
  }

  const srv = await startDisposableServer();
  t.after(() => srv.stop());

  // State carried across sequential subtests.
  let lounge = null;             // the seeded default community
  let flagged = null;            // a public community promoted to default in S3
  let flaggedInvite = null;      // its invite code, for the join-permission leg
  let flaggedOwnerToken = null;  // token of the community's owner (creator)

  const loungeName = 'Unknown Lounge';

  try {
    await t.test('S1: fresh registration joins the flagged default public community', async () => {
      const admin = await login(srv, 'TestAdmin', 'test-admin-pass-1');
      const boot = await bootstrap(srv, admin.token);
      lounge = boot.communities.find(c => c.name === loungeName);
      assert.ok(lounge, 'seeded Unknown Lounge must exist');
      assert.equal(Number(lounge.is_default), 1, 'seeded community must be flagged default');
      assert.equal(await countDefaults(srv), 1, 'exactly one default at boot');

      const u = await assertSingleAutoJoin(srv, 'fresh', loungeName);
      assert.ok(await membershipIn(srv, u.user.id, lounge.id), 'membership row must exist in the DB');
    });

    await t.test('S2: private communities are never auto-joined and cannot be flagged default', async () => {
      const owner = await register(srv, 'owner2');
      const priv = await createCommunity(srv, owner.token, `Private ${stamp()}`, 'private');
      assert.ok(priv.id, 'community create must return an id');

      const deny = await srv.api(`/api/communities/${priv.id}/default`, owner.token, {
        method: 'PATCH',
        body: { isDefault: true },
      });
      assert.equal(deny.status, 400, 'private community must be rejected as default');

      const u = await register(srv, 'privfresh');
      const boot = await bootstrap(srv, u.token);
      assert.equal(boot.memberships.length, 1, 'register must not add the private community');
      assert.equal(boot.memberships[0].community_id, lounge.id, 'still joins the public default');
      assert.equal(await membershipIn(srv, u.user.id, priv.id), false, 'no membership row in the private community');
    });

    await t.test('S3: owner flags a public community — single default enforced, new joins follow it', async () => {
      const owner = await register(srv, 'owner3');
      const comm = await createCommunity(srv, owner.token, `Flagged Home ${stamp()}`, 'public');
      flagged = comm.id;
      flaggedInvite = comm.inviteCode;
      flaggedOwnerToken = owner.token;

      const setRes = await srv.api(`/api/communities/${flagged}/default`, owner.token, {
        method: 'PATCH',
        body: { isDefault: true },
      });
      assert.equal(setRes.status, 200, 'owner must be able to set default: ' + JSON.stringify(setRes));
      assert.equal(await countDefaults(srv), 1, 'exactly one default after promotion');

      const u = await assertSingleAutoJoin(srv, 'flagfresh', comm.community.name);
      assert.equal(await membershipIn(srv, u.user.id, flagged), true, 'auto-join targets the flagged community');
      assert.equal(await membershipIn(srv, u.user.id, lounge.id), false, 'previous default is no longer auto-joined');
    });

    await t.test('S4: unsetting the default falls back to the oldest public community', async () => {
      assert.ok(flaggedOwnerToken, 'S3 owner token must be available');
      const unset = await srv.api(`/api/communities/${flagged}/default`, flaggedOwnerToken, {
        method: 'PATCH',
        body: { isDefault: false },
      });
      assert.equal(unset.status, 200, 'owner must be able to unset default: ' + JSON.stringify(unset));
      assert.equal(await countDefaults(srv), 0, 'no default flagged after unset');

      const u = await register(srv, 'unsetfresh');
      const boot = await bootstrap(srv, u.token);
      assert.equal(boot.memberships.length, 1);
      assert.equal(boot.memberships[0].community_id, lounge.id, 'falls back to the oldest public community');
    });

    await t.test('S5: plain members are denied; platform admins can set the default', async () => {
      // Re-promote the flagged community so there is something to act on.
      const member = await register(srv, 'member5');
      const joinRes = await srv.api('/api/communities/join', member.token, {
        method: 'POST',
        body: { inviteCode: flaggedInvite },
      });
      assert.equal(joinRes.status, 200, 'invite join failed: ' + JSON.stringify(joinRes));

      const memberSet = await srv.api(`/api/communities/${flagged}/default`, member.token, {
        method: 'PATCH',
        body: { isDefault: true },
      });
      assert.equal(memberSet.status, 403, 'a plain member must not set the default');

      const admin = await login(srv, 'TestAdmin', 'test-admin-pass-1');
      const adminSet = await srv.api(`/api/communities/${flagged}/default`, admin.token, {
        method: 'PATCH',
        body: { isDefault: true },
      });
      assert.equal(adminSet.status, 200, 'platform admin may set the default: ' + JSON.stringify(adminSet));
      assert.equal(await countDefaults(srv), 1);

      const u = await register(srv, 'adminfresh');
      const boot = await bootstrap(srv, u.token);
      assert.equal(boot.memberships.length, 1);
      assert.equal(boot.memberships[0].community_id, flagged, 'auto-join follows the admin-set flag');
    });

    t.diagnostic('register auto-join passed: flagged default → private excluded → owner promote/single-default → oldest-public fallback → permission guard');
  } catch (err) {
    throw new Error(`${err.message}\n--- server log tail ---\n${srv.serverLog().slice(-1200)}`);
  }
});
