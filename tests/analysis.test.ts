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
    expect(verdict(rep, ids[0]).status).toBe('guilty');
    expect(refsOf(rep, ids[0])).toEqual(expect.arrayContaining(['pdd:14.1', 'koap:12.18']));
    expect(verdict(rep, ids[1]).status).toBe('clean');
    expect(rep.collisions[0].tech[0].avoidable).toBe(true);
  });

  it('пешеход выбежал вне перехода: нарушил пешеход, у водителя нет технической возможности', () => {
    const { rep, ids } = run('ped-run');
    expect(verdict(rep, ids[0]).status).toBe('clean');
    expect(verdict(rep, ids[1]).status).toBe('guilty');
    expect(refsOf(rep, ids[1])).toContain('pdd:4.3');
    expect(rep.collisions[0].tech[0].avoidable).toBe(false);
  });

  it('пешеход на красный: нарушил п. 4.4', () => {
    const { rep, ids } = run('ped-red');
    expect(refsOf(rep, ids[1])).toContain('pdd:4.4');
    expect(verdict(rep, ids[0]).status).toBe('clean');
  });

  it('проезд на красный: виноват проехавший на красный', () => {
    const { rep, ids } = run('red-light');
    expect(rep.collisions.length).toBe(1);
    expect(verdict(rep, ids[0]).status).toBe('guilty');
    expect(refsOf(rep, ids[0])).toEqual(expect.arrayContaining(['pdd:6.2', 'koap:12.12.1']));
    expect(verdict(rep, ids[1]).status).toBe('clean');
  });

  it('помеха справа: уступает тот, у кого другой справа', () => {
    const { rep, ids } = run('right-hand');
    expect(verdict(rep, ids[1]).status).toBe('guilty');
    expect(refsOf(rep, ids[1])).toEqual(expect.arrayContaining(['pdd:13.11', 'koap:12.13.2']));
    expect(verdict(rep, ids[0]).status).toBe('clean');
  });

  it('знаки приоритета: уступает знак 2.4', () => {
    const { rep, ids } = run('giveway');
    expect(refsOf(rep, ids[0])).toEqual(expect.arrayContaining(['sign:2.4', 'pdd:13.9']));
    expect(verdict(rep, ids[1]).status).toBe('clean');
  });

  it('встречное: выезд через сплошную, УК РФ при опьянении', () => {
    const { rep, ids } = run('head-on');
    expect(refsOf(rep, ids[0])).toEqual(expect.arrayContaining(['pdd:9.1(1)', 'koap:12.15.4']));
    expect(legalRefs(rep, ids[0])).toContain('uk:264.2');
    expect(legalRefs(rep, ids[0])).not.toContain('koap:12.8.1');
    expect(verdict(rep, ids[1]).status).toBe('clean');
  });

  it('наезд сзади: виноват задний', () => {
    const { rep, ids } = run('rear-end');
    expect(refsOf(rep, ids[1])).toEqual(expect.arrayContaining(['pdd:9.10', 'koap:12.15.1']));
    expect(verdict(rep, ids[0]).status).toBe('clean');
  });

  it('гололёд: остановочный путь больше расстояния', () => {
    const { rep, ids } = run('ice');
    const g = rep.collisions[0];
    expect(g.title).toMatch(/наезд сзади/i);
    expect(verdict(rep, ids[2]).status).toBe('guilty');
    expect(g.notes.join(' ')).toMatch(/дорожным условиям/);
  });

  it('трамвай имеет преимущество', () => {
    const { rep, ids } = run('tram');
    expect(verdict(rep, ids[0]).status).toBe('clean');
    expect(verdict(rep, ids[1]).status).toBe('guilty');
    expect(refsOf(rep, ids[1])).toContain('pdd:13.11');
  });

  it('жилая зона: превышение скорости — причина наезда', () => {
    const { rep, ids } = run('speeding');
    expect(verdict(rep, ids[0]).status).toBe('guilty');
    expect(refsOf(rep, ids[0])).toContain('pdd:10.2');
    expect(verdict(rep, ids[1]).status).toBe('clean');
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
    expect(verdict(rep, first).status).toBe('guilty');
    expect(verdict(rep, second).status).toBe('clean');
    expect(refsOf(rep, dps)).toHaveLength(0);
    expect(scene.markings.some((m) => m.kind === '1.16.1')).toBe(true);
  });
});
