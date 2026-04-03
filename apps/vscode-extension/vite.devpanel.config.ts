import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist/webview',
    emptyOutDir: false,
    rollupOptions: {
      input: 'src/webview/devpanel.ts',
      output: {
        entryFileNames: 'devpanel.js',
        format: 'iife',
      },
    },
    cssCodeSplit: false,
    sourcemap: true,
  },
});
