import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPgReachable,
  startDisposableServer,
} from './helpers/disposable-server.js';

// Admin pasted quests: an admin POSTs a JSON quest spec; it joins the daily
// quest pipeline (progress from real activity, claim, credits, daily cap), is
// validated server-side, and can be paused/deleted — while non-admins are denied.
const PASSWORD = 'quests-pass-1';
const stamp = () => Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 6);

async function register(srv, role) {
  const res = await srv.api('/api/register', null, { method: 'POST', body: { username: `q_${role}_${stamp()}`, password: PASSWORD } });
  assert.equal(res.status, 200, 'register failed: ' + JSON.stringify(res));
  return res;
}

test('admin pasted quests: create, measure, claim, pause — validated and admin-only', { timeout: 120000 }, async t => {
  if (!(await isPgReachable())) {
    t.skip('PostgreSQL not reachable — set TEST_PG_ADMIN_URL (e.g. a CI postgres service container) to run integration tests');
    return;
  }

  const srv = await startDisposableServer();
  t.after(() => srv.stop());

  let user = null;
  let questId = null;

  try {
    await t.test('S1: admin adds a quest from a pasted JSON spec; it appears for a fresh user at 0 progress', async () => {
      const admin = await srv.api('/api/login', null, { method: 'POST', body: { username: 'TestAdmin', password: 'test-admin-pass-1' } });
      assert.equal(admin.status, 200, 'admin login failed');
      user = await register(srv, 'u1');

      const spec = { title: 'Room Racer', icon: '🏁', description: 'Send 2 temp-room messages today', metric: 'rooms', need: 2, reward: 12 };
      const add = await srv.api('/api/admin/quests', admin.token, { method: 'POST', body: spec });
      assert.equal(add.status, 200, 'admin add quest failed: ' + JSON.stringify(add));
      assert.ok(add.quest && add.quest.id.startsWith('custom_'), 'quest id must be namespaced: ' + JSON.stringify(add));
      questId = add.quest.id;

      const qs = await srv.api('/api/quests', user.token);
      assert.equal(qs.status, 200);
      const q = qs.quests.find(x => x.id === questId);
      assert.ok(q, 'custom quest must appear in the daily list');
      assert.equal(q.title, 'Room Racer');
      assert.equal(q.icon, '🏁');
      assert.equal(q.metric, 'rooms');
      assert.equal(q.progress, 0);
      assert.equal(q.done, false);
      assert.equal(q.custom, true, 'custom quests are flagged');
    });

    await t.test('S2: real temp-room activity advances progress; quest can be claimed for credits', async () => {
      assert.ok(user && questId, 'S1 must have set up the quest and user');
      const boot = await srv.api('/api/bootstrap', user.token);
      const communityId = boot.memberships[0].community_id;
      assert.ok(communityId);

      const room = await srv.api('/api/rooms', user.token, { method: 'POST', body: { communityId, name: `Quest Room ${stamp()}`, type: 'chat' } });
      assert.equal(room.status, 200, 'room create failed: ' + JSON.stringify(room));
      const roomId = (room.room || room).id;
      for (let i = 0; i < 2; i++) {
        const post = await srv.api(`/api/rooms/${roomId}/messages`, user.token, { method: 'POST', body: { body: `quest progress ${i}` } });
        assert.equal(post.status, 200, 'room message failed: ' + JSON.stringify(post));
      }

      const before = await srv.api('/api/quests', user.token);
      const q = before.quests.find(x => x.id === questId);
      assert.equal(q.progress, 2, 'room messages must count toward the quest');
      assert.equal(q.done, true, 'quest must be complete');

      const claim = await srv.api('/api/quests/claim', user.token, { method: 'POST', body: { questId: questId } });
      assert.equal(claim.status, 200, 'claim failed: ' + JSON.stringify(claim));
      assert.equal(claim.reward, 12);
      assert.ok(claim.credits >= 12, 'credits must increase: ' + JSON.stringify(claim));

      const dup = await srv.api('/api/quests/claim', user.token, { method: 'POST', body: { questId: questId } });
      assert.equal(dup.status, 409, 're-claiming must be rejected');

      const row = await srv.admin.query('SELECT credits FROM users WHERE id=$1', [user.user.id]);
      assert.ok(Number(row.rows[0].credits) >= 12, 'credits must persist in the DB');
    });

    await t.test('S3: validation and permissions — bad specs 400, non-admins 403', async () => {
      assert.ok(user, 'S1 must have set up the user');
      const admin = await srv.api('/api/login', null, { method: 'POST', body: { username: 'TestAdmin', password: 'test-admin-pass-1' } });

      const badMetric = await srv.api('/api/admin/quests', admin.token, { method: 'POST', body: { title: 'Bad', metric: 'arbitrary_code', need: 1, reward: 5 } });
      assert.equal(badMetric.status, 400, 'unknown metric must be rejected: ' + JSON.stringify(badMetric));

      const noTitle = await srv.api('/api/admin/quests', admin.token, { method: 'POST', body: { metric: 'msgs', need: 1, reward: 5 } });
      assert.equal(noTitle.status, 400, 'missing title must be rejected');

      const bigReward = await srv.api('/api/admin/quests', admin.token, { method: 'POST', body: { title: 'Too Rich', metric: 'msgs', need: 1, reward: 99999 } });
      assert.equal(bigReward.status, 400, 'reward above the daily cap must be rejected: ' + JSON.stringify(bigReward));

      const nonAdmin = await srv.api('/api/admin/quests', user.token, { method: 'POST', body: { title: 'Sneaky', metric: 'msgs', need: 1, reward: 5 } });
      assert.equal(nonAdmin.status, 403, 'regular users must not manage quests');
    });

    await t.test('S4: pausing hides the quest from users; enabling brings it back', async () => {
      assert.ok(user && questId, 'setup required');
      const admin = await srv.api('/api/login', null, { method: 'POST', body: { username: 'TestAdmin', password: 'test-admin-pass-1' } });

      const pause = await srv.api(`/api/admin/quests/${questId}`, admin.token, { method: 'PATCH', body: { active: false } });
      assert.equal(pause.status, 200, 'pause failed: ' + JSON.stringify(pause));
      const hidden = await srv.api('/api/quests', user.token);
      assert.ok(!hidden.quests.some(x => x.id === questId), 'paused quest must not appear for users');

      const enable = await srv.api(`/api/admin/quests/${questId}`, admin.token, { method: 'PATCH', body: { active: true } });
      assert.equal(enable.status, 200);
      const shown = await srv.api('/api/quests', user.token);
      assert.ok(shown.quests.some(x => x.id === questId), 'enabled quest must reappear');

      const del = await srv.api(`/api/admin/quests/${questId}`, admin.token, { method: 'DELETE' });
      assert.equal(del.status, 200, 'delete failed: ' + JSON.stringify(del));
      const gone = await srv.api('/api/quests', user.token);
      assert.ok(!gone.quests.some(x => x.id === questId), 'deleted quest must be gone');
    });

    t.diagnostic('custom quests passed: admin paste → real-activity progress → claim/credits → validation/perms → pause/enable/delete');
  } catch (err) {
    throw new Error(`${err.message}\n--- server log tail ---\n${srv.serverLog().slice(-1200)}`);
  }
});
