import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist/webview',
    emptyOutDir: false,
    rollupOptions: {
      input: 'src/webview/excalidraw-renderer.ts',
      output: {
        entryFileNames: 'excalidraw-renderer.js',
        format: 'iife',
        inlineDynamicImports: true,
      },
    },
    sourcemap: true,
  },
});
