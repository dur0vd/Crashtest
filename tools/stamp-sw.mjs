// Подставляет версию из package.json в имя кэша dist/sw.js. Запускается после vite build.
import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const file = 'dist/sw.js';
writeFileSync(file, readFileSync(file, 'utf8').replace(/__APP_VERSION__/g, version));
