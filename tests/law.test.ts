import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LAW } from '../src/law';
import { loadCorpus, resolveRef } from '../src/corpus';

describe('база норм', () => {
  it('все ссылки из разбора есть в базе норм или в корпусе', async () => {
    const src = ['src/analysis.ts', 'src/presets.ts', 'src/restrictions.ts', 'src/parking.ts', 'src/visibility.ts'].map((f) => readFileSync(f, 'utf8')).join('\n');
    const used = new Set(src.match(/'(?:pdd|koap|uk|sign|marking|gk|osago):[0-9.()#a-z]*[0-9)]'/g)?.map((s) => s.slice(1, -1)));
    expect(used.size).toBeGreaterThan(30);
    const corpus = await loadCorpus();
    // допускаем префиксы вроде 'koap:12.9' (семейство статей)
    const missing = [...used].filter((id) => !LAW[id] && !resolveRef(corpus, id) && !Object.keys(LAW).some((k) => k.startsWith(`${id}.`)));
    expect(missing).toEqual([]);
  });

  it('у статей КоАП и УК указана санкция', () => {
    for (const r of Object.values(LAW)) {
      if (r.code === 'КоАП' || r.code === 'УК') expect(r.sanction, r.id).toBeTruthy();
    }
  });
});
