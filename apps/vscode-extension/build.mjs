import * as esbuild from 'esbuild';
import { execSync } from 'child_process';

const watch = process.argv.includes('--watch');

// Build extension host (Node.js)
const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outdir: 'dist',
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
  minify: !watch,
});

if (watch) {
  await ctx.watch();
  console.log('Watching extension host...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log('Extension host built.');
}

// Build webview bundles (browser)
if (!watch) {
  console.log('Building editor webview...');
  execSync('npx vite build --config vite.webview.config.ts', { stdio: 'inherit' });
  console.log('Editor webview built.');

  // Monaco editor worker — built AFTER Vite (which cleans outDir)
  console.log('Building Monaco editor worker...');
  await esbuild.build({
    entryPoints: ['node_modules/monaco-editor/esm/vs/editor/editor.worker.js'],
    bundle: true,
    outfile: 'dist/webview/editor.worker.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    sourcemap: false,
  });
  console.log('Monaco editor worker built.');

  console.log('Building graph webview...');
  execSync('npx vite build --config vite.graph.config.ts', { stdio: 'inherit' });
  console.log('Graph webview built.');

  console.log('Building dev panel webview...');
  execSync('npx vite build --config vite.devpanel.config.ts', { stdio: 'inherit' });
  console.log('Dev panel webview built.');

  console.log('Building excalidraw renderer...');
  execSync('npx vite build --config vite.excalidraw.config.ts', { stdio: 'inherit' });
  console.log('Excalidraw renderer built.');
}
