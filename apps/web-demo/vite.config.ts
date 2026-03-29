import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@kivi/editor-core': path.resolve(__dirname, '../../packages/editor-core/src/index.ts'),
      '@kivi/markdown-parser': path.resolve(__dirname, '../../packages/markdown-parser/src/index.ts'),
      '@kivi/markdown-serializer': path.resolve(__dirname, '../../packages/markdown-serializer/src/index.ts'),
      '@kivi/shared-types': path.resolve(__dirname, '../../packages/shared-types/src/index.ts'),
    },
  },
});
