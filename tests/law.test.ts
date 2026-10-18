import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LAW } from '../src/law';

describe('база норм', () => {
  it('все ссылки из разбора есть в базе норм', () => {
    const src = ['src/analysis.ts', 'src/presets.ts'].map((f) => readFileSync(f, 'utf8')).join('\n');
    const used = new Set(src.match(/'(?:pdd|koap|uk|sign|gk|osago):[0-9.()]+'/g)?.map((s) => s.slice(1, -1)));
    expect(used.size).toBeGreaterThan(30);
    // допускаем префиксы вроде 'koap:12.9' (семейство статей)
    const missing = [...used].filter((id) => !LAW[id] && !Object.keys(LAW).some((k) => k.startsWith(`${id}.`)));
    expect(missing).toEqual([]);
  });

  it('у статей КоАП и УК указана санкция', () => {
    for (const r of Object.values(LAW)) {
      if (r.code === 'КоАП' || r.code === 'УК') expect(r.sanction, r.id).toBeTruthy();
    }
  });
});
