import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { createSessionManager } from '../server/auth.js';

function createHarness() {
  const sessions = new Map();
  const users = new Map([
    ['u1', { id:'u1', username:'Alice', is_admin:1, banned:0 }],
  ]);
  const store = {
    async run(sql, ...params) {
      if (sql.startsWith('INSERT INTO auth_sessions')) {
        const [id, userId, expiresAt] = params;
        sessions.set(id, { id, user_id:userId, expires_at:expiresAt, revoked_at:null });
      } else if (sql.startsWith('UPDATE auth_sessions SET revoked_at') && sql.includes('id<>')) {
        const [userId, keepId] = params;
        for (const session of sessions.values()) if (session.user_id === userId && session.id !== keepId) session.revoked_at = new Date().toISOString();
      } else if (sql.startsWith('UPDATE auth_sessions SET revoked_at')) {
        const [id] = params;
        const session = sessions.get(id);
        if (session) session.revoked_at = new Date().toISOString();
      }
    },
    async get(sql, ...params) {
      if (sql.includes('FROM auth_sessions')) {
        const [id, userId] = params;
        const session = sessions.get(id);
        if (!session || session.user_id !== userId || session.revoked_at || Date.parse(session.expires_at) <= Date.now()) return undefined;
        return { id:session.id, user_id:session.user_id };
      }
      if (sql.includes('FROM users')) return users.get(params[0]);
      return undefined;
    },
  };
  const manager = createSessionManager({
    store,
    jwt,
    secret:'test-secret-that-is-long-enough-for-the-harness',
    publicUser: user => ({ id:user.id, username:user.username, is_admin:Boolean(user.is_admin) }),
  });
  return { manager, users, sessions };
}

test('session lifecycle revalidates current user and revokes access across instances', async () => {
  const { manager, users, sessions } = createHarness();
  const token = await manager.issue(users.get('u1'));
  const resolved = await manager.resolve(token);
  assert.equal(resolved.id, 'u1');
  assert.equal(resolved.is_admin, true);

  users.get('u1').is_admin = 0;
  assert.equal((await manager.resolve(token)).is_admin, false);

  await manager.revoke(resolved.sessionId);
  await assert.rejects(() => manager.resolve(token), /Session expired or revoked/);
  assert.equal(sessions.size, 1);
});

test('password reset can revoke every session except the current one', async () => {
  const { manager } = createHarness();
  const user = { id:'u1', username:'Alice', is_admin:0, banned:0 };
  const first = await manager.issue(user);
  const second = await manager.issue(user);
  const current = await manager.resolve(first);
  await manager.revokeUserExcept(user.id, current.sessionId);
  assert.equal((await manager.resolve(first)).id, 'u1');
  await assert.rejects(() => manager.resolve(second), /Session expired or revoked/);
});

test('database-expired sessions are rejected even when the JWT is still valid', async () => {
  const { manager, sessions } = createHarness();
  const token = await manager.issue({ id:'u1', username:'Alice', is_admin:0, banned:0 });
  const sessionId = jwt.decode(token).sid;
  sessions.get(sessionId).expires_at = new Date(Date.now() - 1).toISOString();
  await assert.rejects(() => manager.resolve(token), /Session expired or revoked/);
});
