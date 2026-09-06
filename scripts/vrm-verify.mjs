#!/usr/bin/env node
// Repeatable VRM regression verification — loads EVERY .vrm fixture through
// the REAL 3D avatar engine path (createAvatarEngine mode '3d' → three.js
// GLTFLoader → skeleton discovery → morph mapping → rig driver → rendered
// frames) in a real browser, driven by a deterministic synthetic tracker (no
// camera, no MediaPipe, no network).
//
//   node scripts/vrm-verify.mjs                     # all fixtures in fixtures/vrm
//   node scripts/vrm-verify.mjs --model a.vrm       # one specific file
//   node scripts/vrm-verify.mjs --out results.json  # also write JSON
//
// Per model it asserts:
//   1. the engine reaches a tracking status (GLTFLoader parsed the VRM),
//   2. the render loop drew frames onto the canvas,
//   3. the canvas actually rasterized pixels (not uniformly transparent),
//   4. head-follow rig evidence: head/eye/jaw bone names discovered (rigHas),
//   5. morph-target mapping produced at least a few channels (best-effort —
//      reported and tallied, but only a warning when a model has none),
//   6. tracked-hand rig meshes were built (handParts > 0),
//   7. no page errors were thrown during the load.
//
// The fixtures are large personal files and are NOT committed (fixtures/vrm is
// gitignored); the script skips politely when the directory is absent so CI
// environments without the models still pass.

import { createServer } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..');
const DIST_DIR = path.join(REPO_ROOT, '.tmp', 'vrm-dist');
const FIXTURE_DIR = path.join(REPO_ROOT, 'fixtures', 'vrm');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.vrm': 'application/octet-stream',
  '.glb': 'application/octet-stream',
};

// --- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = { out: null, timeout: 60000, headful: false, model: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  if (a === '--out') opt.out = next();
  else if (a === '--timeout') opt.timeout = parseInt(next(), 10);
  else if (a === '--headful') opt.headful = true;
  else if (a === '--model') opt.model = next();
  else { console.error('Unknown option: ' + a); process.exit(2); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const getFreePort = () => new Promise((res, rej) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); });
  srv.on('error', rej);
});

// --- static server (Range support: GLTFLoader uses fetch + may seek) --------
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

// --- fixtures ----------------------------------------------------------------
function listModels() {
  if (!fs.existsSync(FIXTURE_DIR)) return null;   // fixtures not present (CI) — skip politely
  const files = fs.readdirSync(FIXTURE_DIR).filter(f => /\.vrm$/i.test(f));
  if (opt.model) {
    const hits = files.filter(f => f.toLowerCase() === opt.model.toLowerCase());
    if (!hits.length) { console.error('No fixture matches --model ' + opt.model); process.exit(2); }
    return hits;
  }
  return files;
}

// --- one model through the harness ------------------------------------------
async function verifyModel(page, base, name) {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', msg => { if (msg.type() === 'error') console.log('  [console]', msg.text().slice(0, 300)); });
  // Navigate fresh per model — the harness auto-runs on load with ?model=.
  await page.goto(`${base}/harness.html?model=${encodeURIComponent('/models/' + encodeURIComponent(name))}`, { waitUntil: 'domcontentloaded' });
  // __done starts undefined (page script still loading) and becomes null-able
  // only through post(); `!= null` waits through both undefined and null.
  await page.waitForFunction(() => window.__done != null, null, { timeout: opt.timeout });
  const done = await page.evaluate(() => window.__done);
  if (!done) return { ok: false, error: 'harness never reported', report: null };
  done.pageErrors = errors;
  return done;
}

// --- assertions --------------------------------------------------------------
function assess(name, r) {
  const checks = [];
  const rep = r.report || {};
  const add = (label, pass, detail) => checks.push({ label, pass: !!pass, detail: detail == null ? '' : String(detail) });

  const reachedTracking = r.ok && (rep.status === 'tracking' || (rep.statuses || []).includes('tracking'));
  add('engine reached tracking', reachedTracking, reachedTracking ? (rep.status || 'tracking') : ('status=' + (rep.status || '?') + ' ' + (r.error || '')));
  add('frames rendered', (rep.frames | 0) >= 12, rep.frames);   // floor proves the loop renders; throughput is machine-dependent under SwiftShader
  add('canvas painted (not blank)', (rep.paintedRatio || 0) > 0.005, rep.paintedRatio);
  add('head/eye/jaw rig discovered (rigHas)', rep.rigHas === true, rep.rig && [rep.rig.head, rep.rig.eyeL, rep.rig.eyeR, rep.rig.jaw].filter(Boolean).join(', ') || '-');
  add('morph targets mapped', true, rep.morphs, true);   // informative; overridden below
  checks[checks.length - 1].pass = true;                  // always pass; severity via warn
  add('hand rig meshes built', (rep.handParts | 0) > 0, rep.handParts);
  add('no page errors', (r.pageErrors || []).length === 0, (r.pageErrors || []).join(' | ').slice(0, 200));

  const warns = [];
  if (!(rep.morphs > 0)) warns.push('no morph targets mapped (expressions will not drive this model)');
  if (!(rep.hairChains > 0)) warns.push('no hair/cloth spring chains (no hair-classified bones)');
  return { checks, warns };
}

// --- main ---------------------------------------------------------------------
async function main() {
  const models = listModels();
  if (models === null) {
    console.log('fixtures/vrm not present — skipping (nothing to verify).');
    return;
  }
  if (!models.length) {
    console.log('fixtures/vrm contains no .vrm files — nothing to verify.');
    return;
  }

  console.log('Building harness …');
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const { build } = await import('vite');
  await build({ configFile: path.join(here, 'vrm-verify', 'vite.config.mjs'), logLevel: 'warn' });

  // Copy models into the served root AFTER the build (emptyOutDir wipes it).
  console.log(`Copying ${models.length} model(s) …`);
  fs.mkdirSync(path.join(DIST_DIR, 'models'), { recursive: true });
  for (const m of models) fs.copyFileSync(path.join(FIXTURE_DIR, m), path.join(DIST_DIR, 'models', m));

  const port = await getFreePort();
  const srv = await serveStatic(DIST_DIR, port);
  const base = `http://127.0.0.1:${port}`;

  let browser;
  const results = [];
  let failed = false;
  try {
    browser = await chromium.launch({
      headless: !opt.headful,
      args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
    });
    const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await ctx.newPage();

    for (const name of models) {
      const label = name;
      process.stdout.write(label.padEnd(28) + ' ');
      let r;
      try {
        r = await verifyModel(page, base, name);
      } catch (e) {
        r = { ok: false, error: String(e && e.message || e), report: null, pageErrors: [] };
      }
      const { checks, warns } = assess(label, r);
      const hardFail = checks.some(c => !c.pass);
      if (hardFail) failed = true;
      results.push({ model: name, report: r.report, checks, warns, ok: !hardFail });

      for (const c of checks) {
        console.log((c.pass ? '  ✔ ' : '  ✖ ') + c.label + (c.detail ? `  (${c.detail})` : ''));
      }
      for (const w of warns) console.log('  ⚠ ' + w);
      console.log('');
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.close();
  }

  if (opt.out) {
    fs.writeFileSync(path.resolve(opt.out), JSON.stringify(results, null, 2));
    console.log('Results written to ' + opt.out);
  }

  const passCount = results.filter(r => r.ok).length;
  console.log('─'.repeat(60));
  console.log(`${passCount}/${results.length} models fully passed. ${failed ? 'FAILURES PRESENT.' : 'All hard checks green.'}`);
  if (failed) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
