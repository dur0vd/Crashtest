import { defineConfig } from 'vitest/config';
import { offlinePlugin } from './tools/offline-plugin';

export default defineConfig({
  base: './',
  plugins: [offlinePlugin()],
  build: { outDir: 'dist', target: 'es2022' },
  test: { include: ['tests/**/*.test.ts'] },
});
