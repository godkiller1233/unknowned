// Standalone Vite build for the VRM regression harness. Same pattern as the
// body-rig harness: a dedicated single-entry build (no app index.html in the
// graph) so the page loads cleanly in any browser, including headless
// Chromium. No publicDir override — the synthetic tracker means MediaPipe
// assets are never fetched.
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

export default defineConfig({
  root: here,
  build: {
    outDir: path.join(repoRoot, '.tmp', 'vrm-dist'),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { input: path.join(here, 'harness.html') },
  },
});
