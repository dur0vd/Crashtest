import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LAW, lawRef } from '../src/law';
import { corpus, resolveRef, type Corpus } from '../src/corpus';
import { lawDate, revisionAt, sanctionOf, type LawRevision } from '../src/law-version';
import { defaultAccidentDate, emptyScene, normalizeScene } from '../src/scene';
import { analyze } from '../src/analysis';
import { PRESETS } from '../src/presets';
import { simulate } from '../src/sim';

function entries(c: Corpus) {
  return [
    ...c.pdd.sections.flatMap((s) => s.points.map((p) => ({ ...p, id: `pdd:${p.id}` }))),
    ...(c.pdd.basics?.points ?? []).map((p) => ({ ...p, id: `pdd:op:${p.id}` })),
    ...c.pdd.faults.flatMap((s) => s.items.map((p) => ({ ...p, id: `fault:${p.id}` }))),
    ...c.signs.groups.flatMap((g) => g.signs.map((s) => ({ ...s, id: `sign:${s.id}` }))),
    ...[...(c.markings.horizontal?.items ?? []), ...(c.markings.vertical?.items ?? [])].map((s) => ({ ...s, id: `marking:${s.id}` })),
    ...(['koap', 'uk'] as const).flatMap((code) => c[code].articles.flatMap((a) => a.parts.map((p) => ({ ...p, id: `${code}:${a.id}#${p.n}` })))),
  ];
}

const today = defaultAccidentDate();
describe('база норм', () => {
  it('ссылки разбора имеют редакцию на дату по умолчанию либо явный TODO для неподтверждённых источников ГК/ОСАГО', () => {
    const src = ['src/analysis.ts', 'src/analysis/traffic-rules.ts', 'src/analysis/legal.ts', 'src/presets.ts', 'src/restrictions.ts'].map((f) => readFileSync(f, 'utf8')).join('\n');
    const used = new Set(src.match(/'(?:pdd|koap|uk|sign|marking|gk|osago):[0-9.()#a-z]*[0-9)]'/g)?.map((s) => s.slice(1, -1)));
    expect(used.size).toBeGreaterThan(30);
    for (const id of used) {
      const r = lawRef(id, today);
      if (id === 'osago:11.1') {
        expect(r.revision?.validFrom).toBe('2025-07-05');
        expect(r.source?.url).toContain('cons_doc_LAW_36528');
        expect(r.text).toContain('Краткое изложение');
        expect(lawRef(id, '2019-09-30').revision).toBeUndefined();
      } else if (id.startsWith('gk:') || id.startsWith('osago:') || /uk:(109|118)\./.test(id)) {
        expect(r.warning, id).toContain('TODO(legal-check)');
        expect(r.text).toBe('');
      } else if (id === 'koap:12.9') {
        // Это только префикс в startsWith, сам по себе не ссылка на часть статьи.
        expect(Object.keys(LAW).filter((k) => k.startsWith(`${id}.`)).every((k) => lawRef(k, today).revision)).toBe(true);
      } else {
        expect(r.revision, id).toBeDefined();
        expect(r.source?.url, id).toMatch(/^https:\/\/www.consultant.ru\/document\//);
        expect(lawDate(r.source!.revisionDate), id).toBe(r.source!.revisionDate);
      }
    }
  });

  it('санкции справочника дословно получены из соответствующей части корпуса', () => {
    for (const r of Object.values(LAW)) {
      if (r.code !== 'КоАП' && r.code !== 'УК') continue;
      const full = resolveRef(corpus, r.id, today);
      expect(full?.revision, r.id).toBeDefined();
      expect(r.sanction, r.id).toBe(sanctionOf(full!.text));
      expect(lawRef(r.id, today).sanction, r.id).toBe(sanctionOf(full!.text));
      expect(r.sanction, r.id).toBeTruthy();
    }
    for (const id of ['koap:12.21#1', 'koap:12.21.1#11']) {
      const r = lawRef(id, today);
      expect(r.sanction, id).toBe(sanctionOf(r.text));
      expect(r.sanction, id).toBeTruthy();
    }
  });

  it('в корпусе нет пересечений, неверных дат и расходящихся санкций', () => {
    for (const node of entries(corpus)) {
      if (!node.revisions?.length) {
        // Сохранены тексты 109/118 из задачи03, но источник/срок действия не подтверждены.
        expect(node.id, 'только явно неподтверждённые дополнения').toMatch(/^uk:(109|118)#/);
        expect(node.legalCheck).toContain('TODO(legal-check)');
        continue;
      }
      expect(node.revisions?.length, node.id).toBeGreaterThan(0);
      const revisions = [...node.revisions!].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
      for (const [i, r] of revisions.entries()) {
        expect(lawDate(r.validFrom), node.id).toBe(r.validFrom);
        expect(lawDate(r.source.revisionDate), node.id).toBe(r.source.revisionDate);
        expect(r.source.docTitle, node.id).toBeTruthy();
        if (r.validTo) {
          expect(lawDate(r.validTo), node.id).toBe(r.validTo);
          expect(r.validFrom < r.validTo, node.id).toBe(true);
        }
        if (i > 0) expect(revisions[i - 1].validTo && revisions[i - 1].validTo! <= r.validFrom, node.id).toBeTruthy();
        if (r.sanction) expect(r.sanction, node.id).toBe(sanctionOf(r.text));
      }
    }
  });

  it('lawRef и отчёт выбирают разные тексты и санкции на границе редакций', () => {
    const part = corpus.koap.articles.find((a) => a.id === '12.18')!.parts[0];
    const saved = part.revisions;
    // Искусственная история: проверяет маршрутизацию даты, не утверждает исторических сумм.
    const old: LawRevision = { ...revision('2000-01-01', '2010-01-01'), text: 'Тестовая старая норма', sanction: 'Тестовая старая санкция' };
    const next: LawRevision = { ...revision('2010-01-01'), text: 'Тестовая новая норма', sanction: 'Тестовая новая санкция' };
    try {
      part.revisions = [old, next];
      expect(lawRef('koap:12.18', '2009-12-31T23:59').sanction).toBe(old.sanction);
      expect(lawRef('koap:12.18', '2010-01-01T00:00').text).toBe(next.text);
      const scene = PRESETS.find((p) => p.id === 'crosswalk')!.build();
      scene.env.accidentDate = '2009-12-31T23:59';
      expect(analyze(scene, simulate(scene)).laws.find((r) => r.id === 'koap:12.18')?.text).toBe(old.text);
      scene.env.accidentDate = '2010-01-01T00:00';
      expect(analyze(scene, simulate(scene)).laws.find((r) => r.id === 'koap:12.18')?.sanction).toBe(next.sanction);
    } finally {
      part.revisions = saved;
    }
  });

  it('не подставляет текущий текст и санкцию на дату вне корпуса', () => {
    const r = lawRef('koap:12.7.1', '1900-01-01T12:00');
    expect(r.text).toBe('');
    expect(r.sanction).toBeUndefined();
    expect(r.warning).toContain('нет редакции');
    expect(lawRef('pdd:op:1', '1900-01-01').text).toBe('');
    expect(lawRef('unknown:1', today).warning).toContain('TODO(legal-check)');
  });

  it('дата сохраняется, а старые сцены получают сегодняшнюю дату', () => {
    expect(emptyScene().env.accidentDate.slice(0, 10)).toBe(today.slice(0, 10));
    expect(normalizeScene({ env: { surface: 'wet' } }).env.accidentDate.slice(0, 10)).toBe(today.slice(0, 10));
    expect(normalizeScene({ env: { accidentDate: '2020-02-29T23:45' } }).env.accidentDate).toBe('2020-02-29T23:45');
  });

  it('отчёт переносит дату, тексты, источники и предупреждения в сериализуемые данные', () => {
    const scene = PRESETS.find((p) => p.id === 'crosswalk')!.build();
    scene.env.accidentDate = '1900-01-01T12:00';
    const report = analyze(scene, simulate(scene));
    expect(JSON.parse(JSON.stringify(report)).accidentDate).toBe(scene.env.accidentDate);
    expect(report.laws.length).toBeGreaterThan(0);
    expect(report.laws.every((r) => !r.text && !r.sanction && r.warning)).toBe(true);
    expect(report.legalWarnings.length).toBe(report.laws.length);
    expect(report.summary.join(' ')).toContain('предварительная');
    scene.env.accidentDate = today;
    const current = JSON.parse(JSON.stringify(analyze(scene, simulate(scene))));
    const rule = current.laws.find((r: { id: string }) => r.id === 'pdd:14.1');
    expect(rule.source.url).toContain('consultant.ru');
    expect(rule.revision.text).toBe(rule.text);
  });
});

const revision = (validFrom: string, validTo?: string): LawRevision => ({
  validFrom, ...(validTo ? { validTo } : {}), text: validFrom,
  source: { url: 'https://example.test/law', docTitle: 'Тестовые данные', revisionDate: validFrom },
});
describe('выбор редакции', () => {
  it('соблюдает границы [from, to), разрывы и не зависит от порядка', () => {
    const a = revision('2020-01-01', '2021-01-01');
    const b = revision('2021-02-01');
    expect(revisionAt([b, a], '2020-01-01T00:00')).toBe(a);
    expect(revisionAt([b, a], '2020-12-31T23:59:59+03:00')).toBe(a);
    expect(revisionAt([a, b], '2021-01-01')).toBeUndefined();
    expect(revisionAt([a, b], '2021-02-01')).toBe(b);
    expect(revisionAt([a, b], '2019-12-31')).toBeUndefined();
    expect(revisionAt([a, b], '2021-02-30')).toBeUndefined();
    expect(revisionAt([a, b], 'invalid')).toBeUndefined();
    expect(revisionAt([a, b], '2020-12-31T99:00')).toBeUndefined();
    expect(revisionAt([a, revision('2020-06-01')], '2020-07-01')).toBeUndefined();
  });
  it('санкция не захватывает отменённые соседние части', () => {
    expect(sanctionOf('Деяние -\nвлечет предупреждение.\n2 - 3. Утратили силу.')).toBe('влечет предупреждение.');
    expect(sanctionOf('Деяние -\nнаказывается ограничением свободы.')).toBe('наказывается ограничением свободы.');
    expect(sanctionOf('Деяние -\nвлечёт предупреждение.')).toBe('влечёт предупреждение.');
  });
});
