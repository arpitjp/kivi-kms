import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/test/**/*.test.js',
  workspaceFolder: './test-fixtures',
  mocha: {
    timeout: 30000,
  },
});
