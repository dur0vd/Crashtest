import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
async function files(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = dir + '/' + e.name;
    if (e.isDirectory()) out.push(...(await files(path)));
    else out.push(path);
  }
  return out;
}
const all = (await files('dist')).filter((p) => !p.endsWith('/sw.js')).sort();
const hash = createHash('sha256');
for (const p of all) hash.update(await readFile(p));
const list = ['./', ...all.map((p) => './' + p.slice(5))];
const template = await readFile('public/sw.js', 'utf8');
await writeFile(
  'dist/sw.js',
  template
    .replace("['__PRECACHE__']", JSON.stringify(list))
    .replace('__CACHE_HASH__', hash.digest('hex').slice(0, 16)),
);
console.log(`Offline precache: ${list.length} local assets`);
