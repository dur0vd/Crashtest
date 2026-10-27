import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis';
import { PRESETS } from '../src/presets';
import { reportHtml } from '../src/report-export';
import { simulate } from '../src/sim';
import { DISCLAIMER } from '../src/law';
import { loadCorpus } from '../src/corpus';

describe('Самодостаточный отчёт', () => {
  it('сохраняет классификацию, технический расчёт, нормы и учебную оговорку', async () => {
    const scene = PRESETS[0].build();
    const report = analyze(scene, simulate(scene));
    const html = reportHtml(scene, report, 'data:image/png;base64,aGVsbG8=', await loadCorpus());
    expect(report.collisions.length).toBeGreaterThan(0);
    expect(html).toContain(report.collisions[0].title);
    expect(html).toContain('остановочный путь');
    expect(html).toContain(DISCLAIMER);
    // Оговорка стоит до выводов и повторяется на каждой печатной странице.
    expect(html.indexOf('Учебная модель, не экспертиза')).toBeLessThan(html.indexOf('Классификация и вывод'));
    expect(html).toMatch(/@media print\{[^}]*\}\.stamp\{display:block;position:fixed/);
    expect(html).toContain('data:image/png;base64,aGVsbG8=');
    expect(html).toContain('window.print()');
    const references = [...html.matchAll(/href="#(law-\d+)"/g)].map((match) => match[1]);
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) expect(html).toContain(`id="${reference}"`);
    expect(html).not.toContain('Текст нормы отсутствует');
  });

  it('экранирует имя сцены, выводы и пользовательский текст, не допускает URL вместо PNG', () => {
    const scene = PRESETS[0].build();
    scene.name = '<script>alert("сцена")</script>';
    const report = analyze(scene, simulate(scene));
    report.summary.push('<img src=x onerror=alert(1)>');
    const html = reportHtml(scene, report, '" onerror="alert(2)');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<figure>');
  });

  it('поддерживает сцену без ДТП и все найденные нарушения', () => {
    for (const preset of PRESETS) {
      const scene = preset.build();
      const report = analyze(scene, simulate(scene));
      const html = reportHtml(scene, report, '');
      for (const finding of report.findings) expect(html).toContain(finding.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'));
      expect(html).toContain('Допущения расчёта');
    }
  });
});
