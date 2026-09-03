import { nanoid } from 'nanoid';

const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function createSessionManager({ store, jwt, secret, publicUser, sessionTtlMs = DEFAULT_SESSION_TTL_MS }) {
  if (!store || !jwt || !secret || typeof publicUser !== 'function') {
    throw new Error('Session manager requires store, jwt, secret, and publicUser');
  }

  async function issue(user) {
    const sessionId = nanoid(32);
    const expiresAt = new Date(Date.now() + sessionTtlMs).toISOString();
    await store.run(
      'INSERT INTO auth_sessions (id,user_id,expires_at) VALUES (?,?,?)',
      sessionId,
      user.id,
      expiresAt,
    );
    return jwt.sign({ sid: sessionId, id: user.id }, secret, {
      expiresIn: Math.ceil(sessionTtlMs / 1000),
    });
  }

  async function resolve(rawToken) {
    if (typeof rawToken !== 'string' || !rawToken) throw new Error('Authentication required');
    const claims = jwt.verify(rawToken, secret);
    if (!claims?.sid || !claims?.id) throw new Error('Session required');

    const session = await store.get(
      'SELECT id,user_id FROM auth_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP',
      claims.sid,
      claims.id,
    );
    if (!session) throw new Error('Session expired or revoked');

    const user = await store.get('SELECT * FROM users WHERE id=$1', claims.id);
    if (!user || Number(user.banned)) throw new Error('Account unavailable');
    return { ...publicUser(user), sessionId: session.id };
  }

  async function revoke(sessionId) {
    if (!sessionId) return;
    await store.run('UPDATE auth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1', sessionId);
  }

  async function revokeUser(userId) {
    await store.run('UPDATE auth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=$1 AND revoked_at IS NULL', userId);
  }

  async function revokeUserExcept(userId, sessionId) {
    await store.run('UPDATE auth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL', userId, sessionId || '');
  }

  return Object.freeze({ issue, resolve, revoke, revokeUser, revokeUserExcept });
}
