import { describe, expect, it } from 'vitest';
import { PRESETS } from '../src/presets';
import { simulate } from '../src/sim';
import { analyze, type Report } from '../src/analysis';
import type { Scene } from '../src/scene';

function run(id: string): { scene: Scene; rep: Report; ids: string[] } {
  const scene = PRESETS.find((x) => x.id === id)!.build();
  const rep = analyze(scene, simulate(scene));
  return { scene, rep, ids: scene.actors.map((a) => a.id) };
}

const verdict = (rep: Report, id: string) => rep.verdicts.find((v) => v.actorId === id)!;
const refsOf = (rep: Report, id: string) => rep.findings.filter((f) => f.actorId === id && f.severity === 'violation').flatMap((f) => f.refs);
const legalRefs = (rep: Report, id: string) => verdict(rep, id).legal.flatMap((l) => l.refs);

describe('разбор готовых ситуаций', () => {
  it('пешеходный переход: виноват водитель', () => {
    const { rep, ids } = run('crosswalk');
    expect(rep.collisions[0].collision.kind).toBe('vp');
    expect(verdict(rep, ids[0]).status).toBe('causal-violation');
    expect(refsOf(rep, ids[0])).toEqual(expect.arrayContaining(['pdd:14.1', 'koap:12.18']));
    expect(verdict(rep, ids[1]).status).toBe('no-violations');
    expect(rep.collisions[0].tech[0].avoidable).toBe(true);
  });

  it('пешеход выбежал вне перехода: нарушил пешеход, у водителя нет технической возможности', () => {
    const { rep, ids } = run('ped-run');
    expect(verdict(rep, ids[0]).status).toBe('no-violations');
    expect(verdict(rep, ids[1]).status).toBe('causal-violation');
    expect(refsOf(rep, ids[1])).toContain('pdd:4.3');
    expect(rep.collisions[0].tech[0].avoidable).toBe(false);
  });

  it('пешеход на красный: нарушил п. 4.4', () => {
    const { rep, ids } = run('ped-red');
    expect(refsOf(rep, ids[1])).toContain('pdd:4.4');
    expect(verdict(rep, ids[0]).status).toBe('no-violations');
  });

  it('проезд на красный: виноват проехавший на красный', () => {
    const { rep, ids } = run('red-light');
    expect(rep.collisions.length).toBe(1);
    expect(verdict(rep, ids[0]).status).toBe('causal-violation');
    expect(refsOf(rep, ids[0])).toEqual(expect.arrayContaining(['pdd:6.2', 'koap:12.12.1']));
    expect(verdict(rep, ids[1]).status).toBe('no-violations');
  });

  it('помеха справа: уступает тот, у кого другой справа', () => {
    const { rep, ids } = run('right-hand');
    expect(verdict(rep, ids[1]).status).toBe('causal-violation');
    expect(refsOf(rep, ids[1])).toEqual(expect.arrayContaining(['pdd:13.11', 'koap:12.13.2']));
    expect(verdict(rep, ids[0]).status).toBe('no-violations');
  });

  it('знаки приоритета: уступает знак 2.4', () => {
    const { rep, ids } = run('giveway');
    expect(refsOf(rep, ids[0])).toEqual(expect.arrayContaining(['sign:2.4', 'pdd:13.9']));
    expect(verdict(rep, ids[1]).status).toBe('no-violations');
  });

  it('встречное: выезд через сплошную, УК РФ при опьянении', () => {
    const { rep, ids } = run('head-on');
    expect(refsOf(rep, ids[0])).toEqual(expect.arrayContaining(['pdd:9.1(1)', 'koap:12.15.4']));
    expect(legalRefs(rep, ids[0])).toContain('uk:264.2');
    expect(legalRefs(rep, ids[0])).not.toContain('koap:12.8.1');
    expect(verdict(rep, ids[1]).status).toBe('no-violations');
  });

  it('наезд сзади: виноват задний', () => {
    const { rep, ids } = run('rear-end');
    expect(refsOf(rep, ids[1])).toEqual(expect.arrayContaining(['pdd:9.10', 'koap:12.15.1']));
    expect(verdict(rep, ids[0]).status).toBe('no-violations');
  });

  it('гололёд: остановочный путь больше расстояния', () => {
    const { rep, ids } = run('ice');
    const g = rep.collisions[0];
    expect(g.title).toMatch(/наезд сзади/i);
    expect(verdict(rep, ids[2]).status).toBe('causal-violation');
    expect(g.notes.join(' ')).toMatch(/дорожным условиям/);
  });

  it('трамвай имеет преимущество', () => {
    const { rep, ids } = run('tram');
    expect(verdict(rep, ids[0]).status).toBe('no-violations');
    expect(verdict(rep, ids[1]).status).toBe('causal-violation');
    expect(refsOf(rep, ids[1])).toContain('pdd:13.11');
  });

  it('жилая зона: превышение скорости — причина наезда', () => {
    const { rep, ids } = run('speeding');
    expect(verdict(rep, ids[0]).status).toBe('causal-violation');
    expect(refsOf(rep, ids[0])).toContain('pdd:10.2');
    expect(verdict(rep, ids[1]).status).toBe('no-violations');
  });
});

describe('знаки и грузы в готовых ситуациях', () => {
  it('необозначенный свес груза: нарушение п. 23.4 и удар пришёлся на груз', () => {
    const { rep, ids } = run('overhang');
    expect(rep.collisions.length).toBeGreaterThan(0);
    expect(refsOf(rep, ids[0])).toEqual(expect.arrayContaining(['pdd:23.4']));
    expect(rep.collisions[0].notes.join(' ')).toMatch(/груз/);
  });

  it('поворот под запрещающий знак 3.18.1', () => {
    const { rep, ids } = run('no-right-turn');
    expect(refsOf(rep, ids[0])).toEqual(expect.arrayContaining(['sign:3.18.1']));
  });
});

describe('съезд на трассу', () => {
  it('перестраивающийся по п. 8.4 уступает, машина ДПС на островке не нарушает', () => {
    const { scene, rep, ids } = run('ramp-merge');
    expect(rep.collisions.length).toBe(1);
    const [dps, first, second] = ids;
    expect(refsOf(rep, first)).toEqual(expect.arrayContaining(['pdd:8.4']));
    expect(verdict(rep, first).status).toBe('causal-violation');
    expect(verdict(rep, second).status).toBe('no-violations');
    expect(refsOf(rep, dps)).toHaveLength(0);
    expect(scene.markings.some((m) => m.kind === '1.16.1')).toBe(true);
  });
});

// Квалификацию проверяем на заданной оценке удара, независимо от порогов физической модели.
function withHarm(scene: Scene, otherKmh: number, selfKmh = 0): Report {
  const tl = simulate(scene);
  expect(tl.collisions.length).toBeGreaterThan(0);
  for (const c of tl.collisions) {
    c.dvA = selfKmh / 3.6;
    c.dvB = otherKmh / 3.6;
    c.rel = otherKmh / 3.6;
  }
  return analyze(scene, tl);
}
const preset = (id: string) => PRESETS.find((p) => p.id === id)!.build();

describe('регрессии правовой оценки', () => {
  it.each(['bicycle', 'cart'] as const)('%s: специальные составы и отсутствие требования прав', (type) => {
    const scene = preset('red-light');
    scene.actors[0].type = type;
    scene.actors[0].age = 30;
    scene.actors[0].flags.noLicense = true;
    const rep = analyze(scene, simulate(scene));
    const refs = legalRefs(rep, scene.actors[0].id);
    expect(refs).toContain('koap:12.29.2');
    expect(refs.some((r) => /^koap:12\.(7|8|12)\./.test(r))).toBe(false);
    expect(refs.some((r) => r.startsWith('uk:264.'))).toBe(false);
    scene.actors[0].flags.drunk = true;
    const drunk = legalRefs(analyze(scene, simulate(scene)), scene.actors[0].id);
    expect(drunk).toContain('koap:12.29.3');
    expect(drunk).not.toContain('koap:12.29.2');
  });

  it.each([[45, 'uk:118.1'], [60, 'uk:109.1']] as const)('велосипед: вред %s км/ч — ориентир %s', (speed, ref) => {
    const scene = preset('red-light');
    scene.actors[0].type = 'bicycle';
    const rep = withHarm(scene, speed);
    expect(legalRefs(rep, scene.actors[0].id)).toContain(ref);
    expect(legalRefs(rep, scene.actors[0].id).some((r) => r.startsWith('uk:264.'))).toBe(false);
    expect(verdict(rep, scene.actors[0].id).legal.map((l) => l.text).join(' ')).toContain('TODO(legal-check)');
  });

  it.each([[15, 'koap:12.24.1'], [30, 'koap:12.24.2'], [45, 'uk:264.1'], [60, 'uk:264.3']] as const)('причинное нарушение включено в %s / %s', (speed, ref) => {
    const scene = preset('crosswalk');
    const rep = withHarm(scene, speed);
    const legal = verdict(rep, scene.actors[0].id).legal;
    expect(legalRefs(rep, scene.actors[0].id)).not.toContain('koap:12.18');
    expect(legal.some((l) => l.refs.includes(ref) && /образующее объективную сторону/.test(l.text))).toBe(true);
    expect(refsOf(rep, scene.actors[0].id)).toContain('koap:12.18');
  });

  it('непричинное нарушение остаётся самостоятельным', () => {
    const scene = preset('crosswalk');
    scene.actors[0].flags.noLicense = true;
    expect(legalRefs(withHarm(scene, 45), scene.actors[0].id)).toContain('koap:12.7.1');
  });

  it('запрещённый поворот приводит к столкновению со встречным ТС', () => {
    const { rep, ids } = run('no-right-turn');
    expect(rep.collisions.length).toBeGreaterThan(0);
    expect(rep.findings.some((f) => f.actorId === ids[0] && f.refs.includes('sign:3.18.1') && f.causal)).toBe(true);
  });

  it('точный пересказ 13.9 и 13.11 сохраняет ограничения преимущества трамвая', async () => {
    const { lawRef } = await import('../src/law');
    expect(lawRef('pdd:13.9', '2026-10-20').text).toContain('в попутном или встречном направлении по равнозначной дороге');
    expect(lawRef('pdd:13.11', '2026-10-20').text).toContain('13.11(1)');
    expect(lawRef('pdd:13.11', '2026-10-20').text).toContain('между собой водители трамваев');
  });

  it('на зелёный знаки приоритета и помеха справа не определяют виновника', () => {
    const scene = preset('giveway');
    scene.lights = [
      { id: 'l1', x: -6, y: 3.5, angle: 0, lineLength: 3.5, green: 60, yellow: 2, red: 20, offset: 0 },
      { id: 'l2', x: -3.5, y: -6, angle: Math.PI / 2, lineLength: 3.5, green: 60, yellow: 2, red: 20, offset: 0 },
    ];
    const rep = analyze(scene, simulate(scene));
    expect(rep.collisions.length).toBeGreaterThan(0);
    expect(rep.findings.filter((f) => f.causal).flatMap((f) => f.refs)).not.toEqual(expect.arrayContaining(['pdd:13.9']));
    expect(rep.findings.some((f) => f.causal && f.refs.includes('pdd:13.11'))).toBe(false);
  });

  it('вред только самому виновнику указан отдельно', () => {
    const scene = preset('red-light');
    const rep = withHarm(scene, 0, 45);
    const text = verdict(rep, scene.actors[0].id).legal.map((l) => l.text).join(' ');
    expect(text).toContain('вред здоровью другим участникам маловероятен');
    expect(text).toContain('самому водителю — возможен тяжкий вред здоровью');
    expect(text).toContain('на квалификацию по ст. 12.24 / 264 не влияет');
  });

  it.each(['drunk', 'noLicense', 'flees'] as const)('лесенка учитывает отягчающее обстоятельство %s', (flag) => {
    const scene = preset('red-light');
    scene.actors[0].flags[flag] = true;
    const rep = withHarm(scene, 45);
    const ladder = verdict(rep, scene.actors[0].id).legal.find((l) => l.text.startsWith('Окончательная квалификация'))!;
    expect(ladder.refs).toEqual(expect.arrayContaining(['uk:264.2', 'uk:264.4', 'uk:264.6']));
    expect(ladder.refs).not.toContain('uk:264.1');
    expect(ladder.text).toContain('ч. 6 ст. 264');
  });
});

it('ориентиры 118 и 109 сохранены без выдуманной редакции и санкции', async () => {
  const { loadCorpus, resolveRef } = await import('../src/corpus');
  const corpus = await loadCorpus();
  for (const ref of ['uk:118.1', 'uk:109.1', 'uk:109.3']) {
    const selected = resolveRef(corpus, ref, '2026-10-20');
    expect(selected, ref).toBeTruthy();
    expect(selected!.warning).toContain('TODO(legal-check)');
    expect(selected!.sanction).toBeNull();
    expect(selected!.revision).toBeUndefined();
    const article = ref.slice(3).split('.')[0];
    expect(corpus.uk.articles.find(a => a.id === article)!.parts[0].text).toBeTruthy();
  }
});

it('поворот налево на зелёный уступает встречному даже при знаке главной дороги', () => {
  const scene = preset('giveway');
  const [a, b] = scene.actors;
  a.speed = 25;
  a.path = [{ x: -8, y: 1.75, v: 25 }, { x: 1.75, y: -8, v: 25 }, { x: 1.75, y: -80, v: 25 }];
  Object.assign(b, { type: 'car', x: 70, y: -1.75, heading: Math.PI, speed: 30, path: [{ x: -110, y: -1.75, v: 30 }] });
  scene.signs[0].kind = '2.1';
  Object.assign(scene.signs[1], { kind: '2.4', x: 14, y: -5, angle: Math.PI });
  scene.lights = [
    { id: 'l1', x: -10, y: 3.5, angle: 0, lineLength: 3.5, green: 60, yellow: 2, red: 20, offset: 0 },
    { id: 'l2', x: 10, y: -3.5, angle: Math.PI, lineLength: 3.5, green: 60, yellow: 2, red: 20, offset: 0 },
  ];
  const rep = analyze(scene, simulate(scene));
  expect(rep.collisions.length).toBeGreaterThan(0);
  expect(rep.findings.some((f) => f.actorId === a.id && f.causal && f.refs.includes('pdd:13.4'))).toBe(true);
  expect(rep.findings.some((f) => f.causal && f.refs.includes('pdd:13.9'))).toBe(false);
  expect(verdict(rep, b.id).status).toBe('no-violations');
});

it('на новый зелёный уступает завершающему проезд по п. 13.8, несмотря на знаки', () => {
  const scene = preset('giveway');
  scene.signs[0].kind = '2.1';
  scene.signs[1].kind = '2.4';
  scene.lights = [
    { id: 'l1', x: -6, y: 3.5, angle: 0, lineLength: 3.5, green: 60, yellow: 2, red: 20, offset: 78.2 },
    { id: 'l2', x: -3.5, y: -6, angle: Math.PI / 2, lineLength: 3.5, green: 60, yellow: 2, red: 20, offset: 0 },
  ];
  const rep = analyze(scene, simulate(scene));
  expect(rep.collisions.length).toBeGreaterThan(0);
  expect(rep.findings.some((f) => f.actorId === scene.actors[0].id && f.causal && f.refs.includes('pdd:13.8'))).toBe(true);
  expect(verdict(rep, scene.actors[1].id).status).toBe('no-violations');
});

it('мопед требует права управления и подпадает под ст. 264 УК', () => {
  const scene = preset('red-light');
  scene.actors[0].type = 'moped';
  scene.actors[0].flags.noLicense = true;
  const refs = legalRefs(withHarm(scene, 45), scene.actors[0].id);
  expect(refs).toEqual(expect.arrayContaining(['uk:264.2', 'koap:12.7.1']));
  expect(refs).not.toContain('koap:12.29.2');
});

it('знак 2.5 не требует остановки при проезде регулируемого перекрёстка на зелёный', () => {
  const scene = preset('giveway');
  scene.signs[0].kind = '2.5';
  scene.lights = [
    { id: 'l1', x: -6, y: 3.5, angle: 0, lineLength: 3.5, green: 60, yellow: 2, red: 20, offset: 0 },
    { id: 'l2', x: -3.5, y: -6, angle: Math.PI / 2, lineLength: 3.5, green: 60, yellow: 2, red: 20, offset: 0 },
  ];
  const rep = analyze(scene, simulate(scene));
  expect(refsOf(rep, scene.actors[0].id)).not.toContain('sign:2.5');
});

it('непричинное превышение скорости остаётся самостоятельным при составе за вред', () => {
  const scene = preset('crosswalk');
  scene.signs.push({ id: 'speed', kind: '3.24', x: -40, y: 5, angle: 0, value: 20 });
  const rep = withHarm(scene, 45);
  const speeding = rep.findings.find((f) => f.actorId === scene.actors[0].id && f.refs.includes('koap:12.9.2'))!;
  expect(speeding).toBeDefined();
  expect(speeding.causal).toBe(false);
  expect(legalRefs(rep, scene.actors[0].id)).toContain('koap:12.9.2');
  expect(legalRefs(rep, scene.actors[0].id)).not.toContain('koap:12.18');
});
