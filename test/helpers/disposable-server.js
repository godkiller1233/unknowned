// Shared harness for integration tests that need a real server against a real
// PostgreSQL database. Any test that imports this stays green (with a clean
// skip) when PostgreSQL is unreachable — CI provides it via TEST_PG_ADMIN_URL.
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import pg from 'pg';

// Resolve the app root from this file so tests run correctly no matter the cwd.
const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(here, '..', '..');
export const SERVER_PATH = path.join(APP_ROOT, 'server', 'index.js');

// Point TEST_PG_ADMIN_URL at any PostgreSQL superuser database (e.g. a GitHub
// Actions postgres service container) and tests create + drop their own DB.
export const ADMIN_URL = process.env.TEST_PG_ADMIN_URL || 'postgres://postgres@127.0.0.1:5432/postgres';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url + '/api/health');
      if (r.ok) return true;
    } catch {}
    await sleep(400);
  }
  return false;
}

export function waitForEvent(socket, event, timeoutMs, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for socket event "${event}"`));
    }, timeoutMs);
    function handler(payload) {
      if (predicate && !predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

export async function isPgReachable(adminUrl = ADMIN_URL) {
  const pool = new pg.Pool({ connectionString: adminUrl, connectionTimeoutMillis: 3000 });
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

// Boot the real server against a freshly created throwaway database.
// Returns { base, api, admin, serverLog, stop } where `admin` is a pg Pool
// connected to the throwaway database (for direct assertions) and `stop()` is
// idempotent and drops the database even if the server crashed.
export async function startDisposableServer({ adminUrl = ADMIN_URL, env: extraEnv = {}, reuse = null } = {}) {
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  const dbName = reuse ? reuse.dbName : 'unknown_it_' + crypto.randomBytes(4).toString('hex');
  let child = null;
  let serverLog = '';

  if (!reuse) await admin.query(`CREATE DATABASE ${dbName}`);
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  // With `reuse`, boot a second instance against an existing throwaway database
  // (multi-instance tests). The reusing instance never drops the database.
  const dbUrl = reuse ? reuse.dbUrl : adminUrl.replace(/\/[^/]*$/, '/' + dbName);

  const env = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(port),
    DATABASE_URL: dbUrl,
    JWT_SECRET: 'integration-test-secret-' + crypto.randomBytes(16).toString('hex'),
    // Deterministic platform-admin credentials for permission assertions; the
    // seed creates this account with is_admin=1 (tag 'real').
    ADMIN_USERNAME: 'TestAdmin',
    ADMIN_PASSWORD: 'test-admin-pass-1',
    ...extraEnv,
  };
  delete env.UPLOAD_DIR;

  child = spawn(process.execPath, [SERVER_PATH], { cwd: APP_ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', d => { serverLog += d.toString(); });

  const killChild = async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL');
      await Promise.race([new Promise(r => child.once('exit', r)), sleep(3000)]);
    }
  };

  const healthy = await waitForHealth(base, 30000);
  if (!healthy) {
    await killChild();
    await admin.end().catch(() => {});
    throw new Error(`server did not become healthy\n--- server log tail ---\n${serverLog.slice(-1500)}`);
  }

  const api = (urlPath, token, opts = {}) => fetch(base + urlPath, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }).then(async r => { const j = await r.json().catch(() => ({})); return { status: r.status, ...j }; });

  const db = new pg.Pool({ connectionString: dbUrl, max: 2 });

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await killChild();
    // Close the direct-DB pool before the FORCE drop so no live client is
    // terminated mid-query (which would surface as async noise after the test).
    await db.end().catch(() => {});
    if (!reuse) { try { await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); } catch {} }
    await admin.end().catch(() => {});
  };

  return { base, api, admin: db, dbName, dbUrl, serverLog: () => serverLog, stop };
}
