// Unit tests for server/totp.js (pure node, no server/database). Locks the TOTP
// implementation to the official RFC 6238 test vectors so a refactor can never
// silently drift from the spec.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  encodeBase32,
  decodeBase32,
  generateSecret,
  verifyCode,
  totpAt,
  otpauthUri,
  generateRecoveryCodes,
  hashRecoveryCode,
} from '../server/totp.js';

// RFC 6238 Appendix B secret: ASCII "12345678901234567890".
const VECTOR_KEY_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const VECTOR_SECRET_BYTES = Buffer.from('12345678901234567890', 'ascii');

test('base32 round-trips and rejects garbage', () => {
  assert.equal(encodeBase32(VECTOR_SECRET_BYTES), VECTOR_KEY_B32);
  assert.equal(decodeBase32(VECTOR_KEY_B32).toString('ascii'), '12345678901234567890');
  assert.equal(decodeBase32('gezdgnbvgy3tqojqgezdgnbvgy3tqojq').toString('ascii'), '12345678901234567890', 'lowercase + padding tolerated');
  assert.throws(() => decodeBase32('!!not-base32!!'));
});

test('TOTP matches the official RFC 6238 vectors', () => {
  const vectors = [
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ];
  for (const [t, want] of vectors) {
    assert.equal(totpAt(VECTOR_KEY_B32, t), want, 'vector at T=' + t);
  }
});

test('verifyCode accepts the current step and rejects wrong/garbage codes', () => {
  const now = 1_700_000_000_000;
  const current = totpAt(VECTOR_KEY_B32, Math.floor(now / 1000));
  assert.equal(verifyCode(VECTOR_KEY_B32, current, { now }), true);
  assert.equal(verifyCode(VECTOR_KEY_B32, '      ' + current + '  ', { now }), true, 'whitespace tolerated');
  const wrong = String((Number(current) + 1) % 1000000).padStart(6, '0');
  assert.equal(verifyCode(VECTOR_KEY_B32, wrong, { now }), false);
  assert.equal(verifyCode(VECTOR_KEY_B32, '12345', { now }), false, 'short codes rejected');
  assert.equal(verifyCode(VECTOR_KEY_B32, 'abcdef', { now }), false, 'non-numeric rejected');
  assert.equal(verifyCode('', '123456', { now }), false, 'empty secret rejected');
});

test('verifyCode tolerates one step of clock drift either way by default', () => {
  const now = 1_700_000_000_000;
  const prev = totpAt(VECTOR_KEY_B32, Math.floor(now / 1000) - 30);
  const next = totpAt(VECTOR_KEY_B32, Math.floor(now / 1000) + 30);
  assert.equal(verifyCode(VECTOR_KEY_B32, prev, { now }), true);
  assert.equal(verifyCode(VECTOR_KEY_B32, next, { now }), true);
  assert.equal(verifyCode(VECTOR_KEY_B32, prev, { now, window: 0 }), false, 'strict window rejects a drifted code');
});

test('secrets and URIs are authenticator-app compatible', () => {
  const secret = generateSecret();
  assert.equal(secret.length, 32);
  assert.match(secret, /^[A-Z2-7]+$/);
  const uri = otpauthUri(secret, 'alice');
  assert.ok(uri.startsWith('otpauth://totp/' + encodeURIComponent('Unknown:alice') + '?secret=' + secret), uri);
  assert.ok(uri.includes('issuer=' + encodeURIComponent('Unknown')));
  assert.ok(uri.includes('algorithm=SHA1'));
  assert.ok(uri.includes('digits=6'));
});

test('recovery codes are single-format, unique, and stored only as hashes', () => {
  const codes = generateRecoveryCodes(10);
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10, 'codes are unique');
  for (const code of codes) assert.match(code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  const hashes = codes.map(hashRecoveryCode);
  assert.equal(new Set(hashes).size, 10);
  for (const h of hashes) assert.equal(h.length, 64);
  // Hash must not be reversible to the code (spot check a couple of prefixes).
  for (const h of hashes) assert.ok(!codes.some(c => h.startsWith(c) || c.startsWith(h)));
  assert.equal(hashRecoveryCode(codes[0]), hashRecoveryCode(codes[0]), 'deterministic');
});
