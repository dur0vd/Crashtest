import { defineConfig } from 'vite';

// Сборка API одним файлом: сервер использует чистые модули из src/ (scene.ts и др.).
export default defineConfig({
  build: {
    ssr: 'server/index.ts',
    outDir: 'dist-server',
    emptyOutDir: true,
    copyPublicDir: false,
    target: 'node22',
  },
});
