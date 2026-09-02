import test from 'node:test';
import assert from 'node:assert/strict';
import { stripImageMetadata } from '../server/metadata.js';

// Minimal JPEG: SOI + APP1(Exif) + APP0(JFIF) + SOS + payload + EOI
function buildJpeg() {
  const app1Data = Buffer.from('Exif\0\0GPSLATITUDE42', 'latin1'); // 19 bytes
  const app1Len = app1Data.length + 2;
  const app1 = Buffer.concat([Buffer.from([0xFF, 0xE1, (app1Len >> 8) & 0xFF, app1Len & 0xFF]), app1Data]);
  const app0 = Buffer.from([0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 1, 1, 1, 0, 0, 0, 0, 0, 0]);
  const sos = Buffer.from([0xFF, 0xDA, 0x00, 0x08, 1, 1, 0, 0, 0x3F, 0x00]);
  const payload = Buffer.from([0x12, 0x34, 0xFF, 0xD9]); // scan data + EOI
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), app1, app0, sos, payload]);
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

function buildPng() {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', Buffer.alloc(13)),
    pngChunk('eXIf', Buffer.from('EXIFGPSDATA')),
    pngChunk('tEXt', Buffer.from('Comment\x00secret')),
    pngChunk('IDAT', Buffer.from([1, 2, 3, 4])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function webpChunk(fourcc, data) {
  const header = Buffer.alloc(8);
  header.write(fourcc, 0, 'latin1');
  header.writeUInt32LE(data.length, 4);
  const padded = data.length % 2 ? Buffer.concat([data, Buffer.alloc(1)]) : data;
  return Buffer.concat([header, padded]);
}

function buildWebp() {
  const vp8 = webpChunk('VP8 ', Buffer.from([1, 2, 3]));
  const exif = webpChunk('EXIF', Buffer.from('GPSDATA1234'));
  const chunks = Buffer.concat([vp8, exif]);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(chunks.length + 4, 4);
  riff.write('WEBP', 8, 'latin1');
  return Buffer.concat([riff, chunks]);
}

test('strips EXIF/GPS from JPEG while keeping JFIF and scan data', () => {
  const jpeg = buildJpeg();
  const out = stripImageMetadata(jpeg);
  assert.ok(!out.includes(Buffer.from('Exif')));
  assert.ok(!out.includes(Buffer.from('GPSLATITUDE')));
  assert.ok(out.includes(Buffer.from('JFIF')));
  assert.ok(out.includes(Buffer.from([0x12, 0x34, 0xFF, 0xD9]))); // scan data preserved
});

test('strips eXIf and tEXt chunks from PNG while keeping critical chunks', () => {
  const png = buildPng();
  const out = stripImageMetadata(png);
  assert.ok(!out.includes(Buffer.from('eXIf', 'latin1')));
  assert.ok(!out.includes(Buffer.from('secret')));
  assert.ok(out.includes(Buffer.from('IHDR', 'latin1')));
  assert.ok(out.includes(Buffer.from('IDAT', 'latin1')));
  assert.ok(out.includes(Buffer.from('IEND', 'latin1')));
});

test('strips EXIF chunk from WebP and rebuilds valid RIFF header', () => {
  const webp = buildWebp();
  const out = stripImageMetadata(webp);
  assert.ok(!out.includes(Buffer.from('EXIF')));
  assert.equal(out.toString('latin1', 0, 4), 'RIFF');
  assert.equal(out.toString('latin1', 8, 12), 'WEBP');
  assert.ok(out.includes(Buffer.from('VP8 ', 'latin1')));
  // RIFF size = body + 4, body = everything after byte 12
  assert.equal(out.readUInt32LE(4), out.length - 12 + 4);
});

test('passes through unsupported formats untouched', () => {
  const text = Buffer.from('plain text file, nothing to strip');
  assert.equal(stripImageMetadata(text), text);
  const empty = Buffer.alloc(0);
  assert.equal(stripImageMetadata(empty), empty);
});
