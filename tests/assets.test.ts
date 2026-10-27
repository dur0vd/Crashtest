import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import signIndex from '../src/data/sign-index.json';
import markingIndex from '../src/data/marking-index.json';

// Допустимые лицензии изображений: общественное достояние, CC0, CC BY и CC BY-SA, либо собственная отрисовка.
const ALLOWED = /^(PD|CC0|CC BY|CC-BY|проприетарная)/i;

type Index = Record<string, [string, string]>;
type Manifest = { items: { file: string; ids: string[]; license: string; source: string; attribution?: string | null }[] };
const manifestOf = (dir: string): Manifest => JSON.parse(readFileSync(`public/${dir}/SOURCES.json`, 'utf8'));

function check(index: Record<string, [string, string]>, dir: string): void {
  const manifest = manifestOf(dir);
  for (const [id, [, file]] of Object.entries(index)) {
    expect(existsSync(`public/${file}`), `нет файла ${file} для ${id}`).toBe(true);
    const item = manifest.items.find((i) => i.file === file);
    expect(item, `нет записи в манифесте для ${file}`).toBeDefined();
    expect(item!.license, file).toMatch(ALLOWED);
    expect(item!.source, file).toBeTruthy();
    if (/^CC BY/i.test(item!.license)) expect(item!.attribution, `нет атрибуции для ${file}`).toBeTruthy();
  }
}

describe('изображения знаков и разметки', () => {
  it('у каждого знака есть файл и запись в манифесте с допустимой лицензией', () => {
    check(signIndex as unknown as Index, 'signs');
  });

  it('у каждой разметки есть файл и запись в манифесте с допустимой лицензией', () => {
    check(markingIndex as unknown as Index, 'markings');
  });
});
