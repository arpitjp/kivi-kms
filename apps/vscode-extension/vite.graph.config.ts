import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  build: {
    outDir: 'dist/webview',
    emptyOutDir: false,
    rollupOptions: {
      input: 'src/webview/graph.ts',
      output: {
        entryFileNames: 'graph.js',
        format: 'iife',
      },
    },
    cssCodeSplit: false,
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@kivi/vault': path.resolve(__dirname, '../../packages/vault/src/index.ts'),
      '@kivi/shared-types': path.resolve(__dirname, '../../packages/shared-types/src/index.ts'),
      '@kivi/markdown-parser': path.resolve(__dirname, '../../packages/markdown-parser/src/index.ts'),
    },
  },
});
