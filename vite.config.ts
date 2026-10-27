import { defineConfig } from 'vitest/config';
import { legalPagesPlugin } from './tools/legal-pages';
import { offlinePlugin } from './tools/offline-plugin';

export default defineConfig({
  base: './',
  plugins: [legalPagesPlugin(), offlinePlugin()],
  build: { outDir: 'dist', target: 'es2022' },
  test: { include: ['tests/**/*.test.ts'] },
});
