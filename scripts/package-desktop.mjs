#!/usr/bin/env node
// One-command desktop packaging:
//
//   npm run desktop            # build → sync → bump patch → package → verify
//   npm run desktop -- --fast  # skip the web build (reuse ./dist as-is)
//   npm run desktop -- --no-bump
//
// Steps:
//   1. `vite build` the web app (skipped with --fast; --fast fails if dist/ is
//      missing so we never ship a stale renderer by accident).
//   2. Sync the renderer (assets/ + index.html + ml/) into the desktop bundle's
//      renderer/ and the backend into backend/index.js.
//   3. Bump the desktop package.json version (patch by default).
//   4. Run electron-builder (portable, x64).
//   5. Verify the packaged asar actually contains the new version, the fresh
//      bundle files, and the backend — then print the exe path.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(here, '..');
// The desktop workspace lives inside the repo root (untracked local folder).
const DESKTOP = path.join(WEB_ROOT, 'unknown-codex-create-privacy-focused-chat-platform (3)', 'client model');

const args = new Set(process.argv.slice(2));
const fast = args.has('--fast');
const noBump = args.has('--no-bump');

const log = (step, msg) => console.log(`[${step}] ${msg}`);
const die = (step, msg) => { console.error(`[${step}] ERROR: ${msg}`); process.exit(1); };

function run(step, cmd, cmdArgs, opts = {}) {
  log(step, `${cmd} ${cmdArgs.join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, { cwd: opts.cwd || WEB_ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) die(step, `command failed with exit code ${r.status}`);
}

// 0) Sanity: the desktop bundle must exist.
const desktopPkgPath = path.join(DESKTOP, 'package.json');
if (!fs.existsSync(desktopPkgPath)) {
  die('preflight', `desktop bundle not found at ${DESKTOP} — expected the Electron workspace next to the web checkout`);
}
const desktopPkg = JSON.parse(fs.readFileSync(desktopPkgPath, 'utf8'));

// 1) Build the web renderer.
if (fast) {
  if (!fs.existsSync(path.join(WEB_ROOT, 'dist', 'index.html'))) {
    die('build', '--fast requested but dist/index.html is missing — run without --fast once to produce it');
  }
  log('build', 'skipped (--fast): reusing existing dist/');
} else {
  run('build', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build']);
  if (!fs.existsSync(path.join(WEB_ROOT, 'dist', 'index.html'))) die('build', 'vite build produced no dist/index.html');
}

// 2) Sync renderer + backend into the desktop bundle.
log('sync', 'renderer → desktop bundle');
const rendererDir = path.join(DESKTOP, 'renderer');
fs.rmSync(rendererDir, { recursive: true, force: true });
fs.mkdirSync(rendererDir, { recursive: true });
for (const entry of ['assets', 'index.html', 'ml']) {
  const src = path.join(WEB_ROOT, 'dist', entry);
  if (!fs.existsSync(src)) die('sync', `dist/${entry} missing — the web build is incomplete`);
  fs.cpSync(src, path.join(rendererDir, entry), { recursive: true });
}
log('sync', 'backend → desktop bundle');
fs.copyFileSync(path.join(WEB_ROOT, 'server', 'index.js'), path.join(DESKTOP, 'backend', 'index.js'));

// Keep the loose mirror copies byte-identical too (historical layout).
const loose = path.resolve(DESKTOP, '..');
try { fs.copyFileSync(path.join(WEB_ROOT, 'server', 'index.js'), path.join(loose, 'server', 'index.js')); } catch {}
try { fs.copyFileSync(path.join(WEB_ROOT, 'src', 'main.jsx'), path.join(loose, 'src', 'main.jsx')); } catch {}
try { fs.copyFileSync(path.join(WEB_ROOT, 'src', 'main.jsx'), path.join(loose, 'main.jsx')); } catch {}

// Byte-verify the critical sync targets.
const newIdx = fs.readdirSync(path.join(WEB_ROOT, 'dist', 'assets')).find(f => /^index-.*\.js$/.test(f));
if (fs.readFileSync(path.join(WEB_ROOT, 'dist', 'assets', newIdx)).equals(fs.readFileSync(path.join(rendererDir, 'assets', newIdx)))) {
  log('sync', `renderer byte-identical (${newIdx})`);
} else {
  die('sync', 'renderer copy mismatch — aborting before packaging');
}
if (fs.readFileSync(path.join(WEB_ROOT, 'server', 'index.js')).equals(fs.readFileSync(path.join(DESKTOP, 'backend', 'index.js')))) {
  log('sync', 'backend byte-identical');
} else {
  die('sync', 'backend copy mismatch — aborting before packaging');
}

// 3) Version bump.
const oldVersion = desktopPkg.version;
let version = oldVersion;
if (!noBump) {
  const [maj, min, pat] = oldVersion.split('.').map(n => parseInt(n, 10) || 0);
  version = `${maj}.${min}.${pat + 1}`;
  desktopPkg.version = version;
  fs.writeFileSync(desktopPkgPath, JSON.stringify(desktopPkg, null, 2) + '\n');
  log('version', `${oldVersion} → ${version}`);
} else {
  log('version', `kept at ${version} (--no-bump)`);
}

// 4) Package the portable exe.
log('package', 'electron-builder (portable, x64)');
run('package', process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron-builder', '--win', 'portable', '--x64'], { cwd: DESKTOP });

// 5) Verify the packaged asar.
const exePath = path.join(DESKTOP, 'dist', `Unknown ${version}.exe`);
if (!fs.existsSync(exePath)) die('verify', `expected exe not found: ${exePath}`);
const asarPath = path.join(DESKTOP, 'dist', 'win-unpacked', 'resources', 'app.asar');
if (!fs.existsSync(asarPath)) die('verify', `asar not found: ${asarPath}`);
const requireFromDesktop = createRequire(path.join(DESKTOP, 'package.json'));
const asar = requireFromDesktop('@electron/asar');
const tmp = path.join(process.env.TEMP || '/tmp', `desktop-asar-verify-${Date.now()}`);
asar.extractAll(asarPath, tmp);
const packedPkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
if (packedPkg.version !== version) die('verify', `asar version ${packedPkg.version} != ${version}`);
const packedIdx = fs.readdirSync(path.join(tmp, 'renderer', 'assets')).find(f => /^index-.*\.js$/.test(f));
if (!packedIdx || packedIdx !== newIdx) die('verify', `asar renderer has ${packedIdx}, expected ${newIdx}`);
if (!fs.readFileSync(path.join(tmp, 'backend', 'index.js')).equals(fs.readFileSync(path.join(WEB_ROOT, 'server', 'index.js')))) {
  die('verify', 'asar backend does not match the web server source');
}
fs.rmSync(tmp, { recursive: true, force: true });

log('done', `Unknown ${version}.exe packaged and verified`);
log('done', exePath);
