import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

/** Включает также public/: поздно загружаемые картинки и чанки корпуса. */
export function offlinePlugin(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'полный-офлайн-кэш',
    apply: 'build',
    configResolved(resolved) { config = resolved; },
    closeBundle() {
      const dir = join(config.root, config.build.outDir);
      const files = readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => relative(dir, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
        .filter(path => path !== 'sw.js')
        .sort();
      const hash = createHash('sha256');
      for (const path of files) hash.update(path).update('\0').update(readFileSync(join(dir, path))).update('\0');
      const template = readFileSync(join(config.root, 'public/sw.js'), 'utf8');
      const worker = template
        .replace('__CACHE_VERSION__', hash.digest('hex').slice(0, 20))
        .replace('/* __PRECACHE_URLS__ */', JSON.stringify(files.map(path => `./${path}`)));
      writeFileSync(join(dir, 'sw.js'), worker);
    },
  };
}
