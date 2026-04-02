import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  build: {
    outDir: 'dist/webview',
    rollupOptions: {
      input: 'src/webview/index.ts',
      output: {
        entryFileNames: 'webview.js',
        assetFileNames: 'webview.[ext]',
        format: 'iife',
        inlineDynamicImports: true,
      },
    },
    cssCodeSplit: false,
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@kivi/editor-core': path.resolve(__dirname, '../../packages/editor-core/src/index.ts'),
      '@kivi/markdown-parser': path.resolve(__dirname, '../../packages/markdown-parser/src/index.ts'),
      '@kivi/markdown-serializer': path.resolve(__dirname, '../../packages/markdown-serializer/src/index.ts'),
      '@kivi/shared-types': path.resolve(__dirname, '../../packages/shared-types/src/index.ts'),
    },
  },
});
