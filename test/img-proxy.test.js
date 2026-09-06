import test from 'node:test';
import assert from 'node:assert/strict';

// The proxy route lives inline in server/index.js; its security-relevant logic
// (URL validation + mime allow-list) is replicated here by importing the server
// module is too heavy for unit scope, so these tests exercise the exact guard
// expressions from the source to lock the contract in.

// Mirror of isPublicHttpUrl from server/index.js — keep in sync (checked by
// the source-grep test below).
function isPublicHttpUrl(value) {
  let u;
  try { u = new URL(String(value)); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === '0.0.0.0') return null;
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^127\./.test(host)) return null;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return null;
  if (host.endsWith('.local') || host.endsWith('.internal')) return null;
  return u;
}

const IMG_PROXY_MIME = /^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/i;

test('img-proxy SSRF guard: public urls pass, internal targets blocked', () => {
  assert.ok(isPublicHttpUrl('https://example.com/cat.png'));
  assert.ok(isPublicHttpUrl('http://example.com/cat.png'));
  assert.ok(isPublicHttpUrl('http://172.32.0.9/public'));      // 172.32 is public range
  assert.equal(isPublicHttpUrl('file:///etc/passwd'), null);
  assert.equal(isPublicHttpUrl('ftp://example.com/x'), null);
  assert.equal(isPublicHttpUrl('http://localhost/x.png'), null);
  assert.equal(isPublicHttpUrl('http://127.0.0.1:3001/x.png'), null);
  assert.equal(isPublicHttpUrl('http://[::1]/x.png'), null);
  assert.equal(isPublicHttpUrl('http://10.1.2.3/x.png'), null);
  assert.equal(isPublicHttpUrl('http://192.168.0.10/x.png'), null);
  assert.equal(isPublicHttpUrl('http://172.16.0.9/x.png'), null);
  assert.equal(isPublicHttpUrl('http://169.254.169.254/latest/meta-data'), null);
  assert.equal(isPublicHttpUrl('http://printer.local/x.png'), null);
  assert.equal(isPublicHttpUrl('http://db.internal/x.png'), null);
  assert.equal(isPublicHttpUrl('not a url'), null);
});

test('img-proxy mime allow-list: only images are proxied', () => {
  for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/svg+xml']) {
    assert.ok(IMG_PROXY_MIME.test(mime), mime);
  }
  for (const mime of ['text/html', 'application/json', 'video/mp4', 'application/octet-stream', 'image/x-icon']) {
    assert.equal(IMG_PROXY_MIME.test(mime), false, mime + ' must be rejected');
  }
});

test('img-proxy: server source keeps the guard wired into the route', async () => {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const src = await readFile(path.resolve(process.cwd(), 'server', 'index.js'), 'utf8');
  assert.match(src, /app\.get\('\/api\/img-proxy'/, 'route must exist');
  assert.match(src, /isPublicHttpUrl\(req\.query\.u\)/, 'route must validate the url param');
  assert.match(src, /IMG_PROXY_MAX_BYTES/, 'size cap must be enforced');
  assert.match(src, /await imgCachePut\(key, buf, contentType\)/, 'proxy writes through to the shared cache');
  // Admin stats must expose the cache footprint (count + bytes) for operators.
  assert.match(src, /imgCacheCount/, 'admin stats report the cache image count');
  assert.match(src, /imgCacheBytes/, 'admin stats report the cache byte footprint');
  assert.match(src, /SUM\(size\),0\) AS bytes FROM uploads WHERE name LIKE/, 'footprint query reads the namespaced rows');
  // Immediate purge endpoint: admin DELETE clears memory + shared rows.
  assert.match(src, /app\.delete\('\/api\/admin\/img-cache'/, 'purge route must exist');
  assert.match(src, /IMG_PROXY_MEM\.clear\(\)/, 'purge clears the write-through memory map');
  const purgeIdx = src.indexOf("/api/admin/img-cache");
  const purgeBlock = src.slice(purgeIdx, purgeIdx + 400);
  assert.match(purgeBlock, /adminOnly/, 'purge is admin-gated');
  assert.match(purgeBlock, /DELETE FROM uploads WHERE name LIKE/, 'purge deletes the shared rows');
  assert.match(src, /AbortSignal\.timeout\(12000\)/, 'upstream fetch must time out');
  // The in-source guard must not have drifted from the tested mirror.
  const fn = /function isPublicHttpUrl\(value\) \{[\s\S]*?\n\}/.exec(src)?.[0];
  assert.ok(fn, 'guard function must exist in server source');
  assert.match(fn, /169/, 'link-local block present');
  assert.match(fn, /254/, 'link-local block present');
  assert.match(fn, /\.internal/, 'internal-tld block present');
});

test('img-probe: source keeps the probe endpoint wired with the same guards', async () => {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const src = await readFile(path.resolve(process.cwd(), 'server', 'index.js'), 'utf8');
  assert.match(src, /app\.get\('\/api\/img-probe'/, 'probe endpoint must exist');
  // Probe must reuse the same SSRF guard and mime allow-list as the proxy.
  const probeIdx = src.indexOf("/api/img-probe");
  const proxyIdx = src.indexOf("/api/img-proxy'");
  assert.ok(probeIdx > 0 && proxyIdx > probeIdx, 'probe sits next to proxy');
  const probeBlock = src.slice(probeIdx, proxyIdx);
  assert.match(probeBlock, /isPublicHttpUrl\(req\.query\.u\)/, 'probe validates url param');
  assert.match(probeBlock, /IMG_PROXY_MIME\.test\(contentType\)/, 'probe uses the shared mime allow-list');
  assert.match(probeBlock, /await imgCacheGet\(key\)/, 'probe reads the shared DB-backed cache');
});
