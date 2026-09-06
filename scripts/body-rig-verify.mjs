#!/usr/bin/env node
// Repeatable, headless two-phase body-rig verification.
//
//   node scripts/body-rig-verify.mjs --demo
//   node scripts/body-rig-verify.mjs --clip /path/to/clip.webm
//   node scripts/body-rig-verify.mjs --clip https://example.com/clip.webm --points 120 --out result.json
//
// What it does (all in a real local browser, no webcam required):
//   1. Builds the harness page (scripts/body-rig-verify/) with Vite; the build
//      ships the repo's public/ml MediaPipe assets (committed).
//   2. Serves the built page + the recorded clip on a loopback port.
//   3. Drives headless Chromium (Playwright) through the harness, which:
//      a. CAPTURES a wizard-exact body calibration from real MediaPipe Pose
//         detections over the clip (neutral body + arm-sweep range),
//      b. VERIFIES held-out arms-at-sides frames map to raise ~0, the clip's
//         raised frames map to raise ~1, the 2D rig (bodyRigPoints2D — the
//         exact math the 3D rig mirrors) puts wrists below shoulders at rest
//         and above at the top, and calibrated raise rises monotonically with
//         raw wrist height.
//   4. Asserts the results, prints a table, exits 0 (pass) / 1 (fail).
//
// Prerequisites: npm i -D playwright && npx playwright install chromium
// (one-time; the browser binary is NOT committed).
//
// Good clip: full body in frame, decent light, arms clearly at the sides AND
// raised (e.g. jumping jacks, an unweighted overhead press, or a clean &
// press), a few seconds long. The bundled fixture (CC BY-SA 4.0, "Jumping
// jacks and burpees" by Taco Fleur via Wikimedia Commons) satisfies this.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..');
const DIST_DIR = path.join(REPO_ROOT, '.tmp', 'body-rig-dist');
const FIXTURE = path.join(here, 'body-rig-verify', 'fixtures', 'jumping_jacks.webm');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

// --- argument parsing -------------------------------------------------------
function usage() {
  console.log(`Usage: node scripts/body-rig-verify.mjs [options]
  --demo                use the bundled fixture clip (jumping jacks, CC BY-SA)
  --clip <path|url>     recorded clip to verify against (path or http(s) URL)
  --points <n>          seek-sample points across the clip (default 90)
  --out <path>          write the full results JSON to <path>
  --port <n>            explicit port for the local static server (default: free)
  --timeout <ms>        max wait for the browser run (default 300000)
  --keep                keep .tmp/body-rig-dist on exit (debugging)
  --headful             run a visible browser instead of headless`);
  process.exit(2);
}
const argv = process.argv.slice(2);
const opt = { points: 90, timeout: 300000, demo: false, keep: false, headful: false };
let clip = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  if (a === '--demo') opt.demo = true;
  else if (a === '--clip') clip = next();
  else if (a === '--points') opt.points = parseInt(next(), 10);
  else if (a === '--out') opt.out = next();
  else if (a === '--port') opt.port = parseInt(next(), 10);
  else if (a === '--timeout') opt.timeout = parseInt(next(), 10);
  else if (a === '--keep') opt.keep = true;
  else if (a === '--headful') opt.headful = true;
  else { console.error('Unknown option: ' + a); usage(); }
}
if (!opt.demo && !clip) { console.error('Provide --demo or --clip <path|url>'); usage(); }
if (opt.demo && clip) { console.error('--demo and --clip are mutually exclusive'); usage(); }

// --- tiny helpers -----------------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getFreePort = () => new Promise((res, rej) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); });
  srv.on('error', rej);
});
const run = (cmd, args, opts = {}) => new Promise((res, rej) => {
  const c = spawn(cmd, args, { stdio: opts.silent ? 'ignore' : 'inherit', ...opts.spawn });
  c.on('error', rej);
  c.on('exit', code => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`))));
});

// --- static server ----------------------------------------------------------
function serveStatic(dir, port) {
  return new Promise((res) => {
    const srv = createServer((req, rsp) => {
      const url = decodeURIComponent((req.url || '/').split('?')[0]);
      let file = path.normalize(path.join(dir, url));
      if (!file.startsWith(dir)) { rsp.writeHead(403); rsp.end(); return; }
      if (fs.statSync(file, { throwIfNoEntry: false })?.isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file)) { rsp.writeHead(404); rsp.end('not found'); return; }
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const stat = fs.statSync(file);
      // Media elements need HTTP Range support to seek; without it Chromium
      // cannot move currentTime, so the clip-sampling seeks would never land.
      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (m) {
          let start = m[1] ? parseInt(m[1], 10) : 0;
          let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
          if (start >= stat.size || end < start) { rsp.writeHead(416, { 'Content-Range': 'bytes */' + stat.size }); rsp.end(); return; }
          end = Math.min(end, stat.size - 1);
          rsp.writeHead(206, {
            'Content-Type': type, 'Accept-Ranges': 'bytes',
            'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
            'Content-Length': end - start + 1,
          });
          fs.createReadStream(file, { start, end }).pipe(rsp);
          return;
        }
      }
      rsp.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': stat.size });
      fs.createReadStream(file).pipe(rsp);
    });
    srv.listen(port, '127.0.0.1', () => res(srv));
  });
}

// --- assertions -------------------------------------------------------------
const ASSERTIONS = [
  ['enough full-body detections', r => r.sampled >= 40, r => `sampled ${r.sampled}/${opt.points}`],
  ['sweep covers most of the down/up range', r => (r.dyRange.l[1] - r.dyRange.l[0]) >= 0.7, r => `dyRange [${r.dyRange.l[0]}, ${r.dyRange.l[1]}]`],
  ['arms-at-sides frames exist in the sweep', r => r.rest.frames >= 3, r => `${r.rest.frames} rest frames`],
  ['rest maps to raise ~0 (avg)', r => r.rest.raiseAvg != null && r.rest.raiseAvg <= 0.15, r => `rest raise avg ${r.rest.raiseAvg}`],
  ['rest maps to raise ~0 (max)', r => r.rest.raiseMax != null && r.rest.raiseMax <= 0.35, r => `rest raise max ${r.rest.raiseMax}`],
  ['raised frames exist in the sweep', r => r.top.frames >= 3, r => `${r.top.frames} top frames`],
  ['raised frames map high (avg >= 0.55)', r => r.top.raiseAvg != null && r.top.raiseAvg >= 0.55, r => `top raise avg ${r.top.raiseAvg}`],
  ['2D rig: wrists at/below shoulders at rest', r => r.rest.wristNotRaised === true, () => 'rig check'],
  ['2D rig: wrists above shoulders at top', r => r.top.wristAbove === true, () => 'rig check'],
  ['raise rises monotonically with wrist height', r => r.monotonic != null && r.monotonic > 0.4, r => `correlation ${r.monotonic}`],
];

// --- main -------------------------------------------------------------------
async function main() {
  // 1) build the harness FIRST (ships public/ml; emptyOutDir wipes the dir, so
  //    the clip must be copied in after the build)
  console.log('Building harness …');
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const { build } = await import('vite');
  await build({ configFile: path.join(here, 'body-rig-verify', 'vite.config.mjs'), logLevel: 'warn' });

  // 2) resolve the clip into the build dir (keep a real video extension so the
  //    static server serves the right MIME and the browser can decode it)
  const ext = (() => {
    const m = /\.(webm|mp4|mov|ogv|ogg)$/i.exec(clip || '');
    if (m) return m[1].toLowerCase();
    if (clip && !clip.startsWith('http')) { const e = path.extname(clip); if (e) return e.slice(1); }
    return 'webm';
  })();
  const clipName = 'verify-clip.' + ext;
  if (opt.demo) {
    fs.copyFileSync(FIXTURE, path.join(DIST_DIR, clipName));
  } else if (/^https?:\/\//.test(clip)) {
    console.log('Downloading clip from ' + clip + ' …');
    const r = await fetch(clip);
    if (!r.ok) throw new Error('clip download failed: HTTP ' + r.status);
    fs.writeFileSync(path.join(DIST_DIR, clipName), Buffer.from(await r.arrayBuffer()));
  } else {
    fs.copyFileSync(path.resolve(REPO_ROOT, clip), path.join(DIST_DIR, clipName));
  }
  console.log('clip: ' + clipName + ' (' + Math.round(fs.statSync(path.join(DIST_DIR, clipName)).size / 1048576 * 10) / 10 + ' MB)');

  // 3) serve + drive the browser
  const port = opt.port || await getFreePort();
  const srv = await serveStatic(DIST_DIR, port);
  const base = `http://127.0.0.1:${port}`;
  console.log('Serving ' + base + ' …');

  let browser;
  let results = null;
  try {
    const launched = await chromium.launch({
      headless: !opt.headful,
      args: [
        // The harness forces the MediaPipe CPU delegate (see harness.js), so
        // no WebGL is needed — keeping the run deterministic across machines.
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
    browser = launched;
    const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
    const url = `${base}/harness.html?clip=${encodeURIComponent('/' + clipName)}&points=${opt.points}`;
    console.log('Running ' + url);
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.__done !== undefined, null, { timeout: opt.timeout });
    results = await page.evaluate(() => window.__done);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await new Promise(r => srv.close(r));
  }

  if (!results || !results.ok || !results.results) {
    console.error('\nBROWSER RUN FAILED: ' + ((results && results.errors) || []).join('; '));
        const logs = results && results.logs;
    if (logs && logs.length) {
      console.error('--- page log tail ---');
      console.error(logs.slice(-25).join('\n'));
    }
cleanupExit(1, null);
  }

  const r = results.results;
  if (opt.out) {
    fs.writeFileSync(opt.out, JSON.stringify({ ok: results.ok, results: r }, null, 2));
    console.log('Results written to ' + opt.out);
  }

  // 4) assert + report
  let pass = true;
  console.log('\n' + '='.repeat(64));
  for (const [name, test, fmt] of ASSERTIONS) {
    const ok = test(r);
    if (!ok) pass = false;
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + '  —  ' + fmt(r));
  }
  console.log('='.repeat(64));
  console.log(pass ? 'BODY-RIG VERIFICATION PASSED' : 'BODY-RIG VERIFICATION FAILED');
  cleanupExit(pass ? 0 : 1, r);
}

function cleanupExit(code, r) {
  if (!opt.keep) {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
  } else if (r) {
    console.log('(kept ' + DIST_DIR + ' — re-run with --keep removed)');
  }
  process.exit(code);
}

main().catch(e => {
  console.error('FATAL: ' + (e && e.stack || e));
  cleanupExit(1, null);
});