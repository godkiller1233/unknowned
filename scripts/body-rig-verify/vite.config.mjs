// Standalone Vite build for the body-rig verification harness. Kept separate
// from the app's vite.config.js on purpose: a dedicated single-entry build
// (no app index.html in the graph) is what makes the harness page load cleanly
// in any browser, including headless Chromium.
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

export default defineConfig({
  root: here,
  publicDir: path.join(repoRoot, 'public'), // ships /ml (pose_landmarker.task + wasm)
  build: {
    outDir: path.join(repoRoot, '.tmp', 'body-rig-dist'),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { input: path.join(here, 'harness.html') },
  },
});