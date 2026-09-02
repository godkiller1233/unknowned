// server/metadata.js
// Strips privacy-relevant metadata (EXIF, GPS, XMP, comments, text chunks) from
// image uploads before they are stored. Pure Node.js — no native dependencies.
// Unsupported formats and malformed files pass through untouched (never corrupt
// an upload).

function isJpeg(buf) { return buf.length > 2 && buf[0] === 0xFF && buf[1] === 0xD8; }
function isPng(buf) {
  return buf.length > 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
    buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A;
}
function isWebp(buf) {
  return buf.length > 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP';
}

// JPEG: walk marker segments, drop APP1 (EXIF/XMP), APP13 (Photoshop/IRB) and
// COM (comments). Everything from SOS onward is entropy data — copied verbatim.
function stripJpeg(buf) {
  const out = [0xFF, 0xD8];
  const len = buf.length;
  let i = 2;
  while (i + 1 < len) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xD9) { out.push(0xFF, 0xD9); return Buffer.from(out); } // EOI
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { out.push(0xFF, marker); i += 2; continue; }
    if (marker === 0xDA) { // SOS — copy the rest as-is
      out.push(0xFF, 0xDA);
      for (let j = i + 2; j < len; j++) out.push(buf[j]);
      return Buffer.from(out);
    }
    if (i + 3 >= len) break;
    const segLen = (buf[i + 2] << 8) | buf[i + 3];
    if (segLen < 2 || i + 2 + segLen > len) break;
    const drop = marker === 0xE1 || marker === 0xED || marker === 0xFE; // APP1, APP13, COM
    if (!drop) {
      out.push(0xFF, marker);
      for (let j = i + 2; j < i + 2 + segLen; j++) out.push(buf[j]);
    }
    i += 2 + segLen;
  }
  return Buffer.from(out);
}

// PNG: drop ancillary chunks that carry metadata/comments. Critical chunks
// (IHDR, PLTE, IDAT, IEND) and color chunks (iCCP, gAMA, sRGB) are preserved.
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);
function stripPng(buf) {
  const out = [];
  for (let i = 0; i < 8 && i < buf.length; i++) out.push(buf[i]);
  const len = buf.length;
  let i = 8;
  while (i + 8 <= len) {
    const cLen = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const end = i + 8 + cLen + 4; // data + CRC
    if (end > len) break;
    if (!PNG_DROP.has(type)) {
      for (let j = i; j < end; j++) out.push(buf[j]);
    }
    i = end;
  }
  return Buffer.from(out);
}

// WebP: drop EXIF and XMP chunks, rebuild the RIFF header with the new size.
function stripWebp(buf) {
  const kept = [];
  const len = buf.length;
  let i = 12;
  while (i + 8 <= len) {
    const fourcc = buf.toString('latin1', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    const padded = size + (size % 2);
    const start = i + 8;
    const end = Math.min(start + padded, len);
    if (fourcc !== 'EXIF' && fourcc !== 'XMP ') {
      kept.push(buf.slice(i, end));
    }
    i = end;
  }
  if (kept.length === 0) return buf;
  const body = Buffer.concat(kept);
  const out = Buffer.alloc(12 + body.length);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(body.length + 4, 4);
  out.write('WEBP', 8, 'latin1');
  body.copy(out, 12);
  return out;
}

/**
 * Remove metadata from an image buffer. Returns a new buffer for images whose
 * metadata was stripped, or the original buffer for unsupported formats.
 */
export function stripImageMetadata(buf) {
  if (!buf || buf.length < 12) return buf;
  try {
    if (isJpeg(buf)) return stripJpeg(buf);
    if (isPng(buf)) return stripPng(buf);
    if (isWebp(buf)) return stripWebp(buf);
  } catch {
    // Never let a stripping failure break an upload.
  }
  return buf;
}
