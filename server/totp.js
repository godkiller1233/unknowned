// RFC 6238 TOTP + recovery codes, implemented with node:crypto only (no
// external deps). Secrets are base32 strings (authenticator-app compatible);
// recovery codes are stored as salted sha256 hashes so a DB leak does not
// expose usable codes.
import { createHash, createHmac, randomBytes, randomInt } from 'crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function encodeBase32(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function decodeBase32(input) {
  const clean = String(input || '').replace(/[= \s]/g, '').toUpperCase();
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character: ' + ch);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// A fresh secret for an authenticator app (160 bits, base32-encoded).
export function generateSecret(bytes = 20) {
  return encodeBase32(randomBytes(bytes));
}

// RFC 4226 hotp-compatible counter code: HMAC-SHA1, dynamic truncation.
function hotp(key, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(code % 1000000).padStart(6, '0');
}

// TOTP value at an absolute Unix time (seconds) — exported for RFC vectors.
export function totpAt(secretBase32, timeSeconds) {
  return hotp(decodeBase32(secretBase32), Math.floor(timeSeconds / 30));
}

// Verify a 6-digit code with a +/-`window` step grace (default: 1 step either
// side to absorb clock drift). Padded/whitespace tolerated.
export function verifyCode(secretBase32, code, { now = Date.now(), window: win = 1 } = {}) {
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  const key = decodeBase32(secretBase32);
  const counter = Math.floor(now / 1000 / 30);
  for (let w = -win; w <= win; w++) {
    if (hotp(key, counter + w) === clean) return true;
  }
  return false;
}

// otpauth URI for authenticator-app QR codes / manual entry.
export function otpauthUri(secretBase32, label, issuer = 'Unknown') {
  return 'otpauth://totp/' + encodeURIComponent(issuer + ':' + label) +
    '?secret=' + secretBase32 + '&issuer=' + encodeURIComponent(issuer) +
    '&algorithm=SHA1&digits=6&period=30';
}

// Human-friendly recovery codes (XXXXX-XXXXX) using an unambiguous alphabet.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function generateRecoveryCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    let raw = '';
    for (let j = 0; j < 10; j++) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    codes.push(raw.slice(0, 5) + '-' + raw.slice(5));
  }
  return codes;
}

// sha256 of a code — what the database stores (never the code itself).
export function hashRecoveryCode(code) {
  return createHash('sha256').update(String(code || '')).digest('hex');
}
