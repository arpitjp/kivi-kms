import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
  },
  resolve: {
    alias: {
      '@kivi/markdown-parser': path.resolve(__dirname, '../markdown-parser/src/index.ts'),
      '@kivi/shared-types': path.resolve(__dirname, '../shared-types/src/index.ts'),
    },
  },
});
