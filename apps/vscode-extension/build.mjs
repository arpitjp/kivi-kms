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

// Build webview bundle (browser)
if (!watch) {
  console.log('Building webview...');
  execSync('npx vite build --config vite.webview.config.ts', { stdio: 'inherit' });
  console.log('Webview built.');
}
