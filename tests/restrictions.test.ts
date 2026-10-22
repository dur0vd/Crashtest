import { describe, expect, it } from 'vitest';
import { analyze, type Report } from '../src/analysis';
import { type Actor, type Cargo, type Marking, type Scene, type VehicleType, NO_CARGO, VEHICLES, emptyScene } from '../src/scene';
import { simulate } from '../src/sim';

// Прямая двухполосная дорога вдоль X; правая полоса при движении на восток — y > 0.
function base(duration = 8): Scene {
  const s = emptyScene();
  s.env.duration = duration;
  s.roads.push({ id: 'r1', pts: [{ x: -120, y: 0 }, { x: 120, y: 0 }], lanes: 1, center: 'dashed', oneWay: false, zone: 'city', smooth: false });
  return s;
}

let n = 0;
function veh(s: Scene, type: VehicleType, x: number, y: number, speedKmh: number, path: [number, number][], o: Partial<Actor> = {}): Actor {
  const v = speedKmh;
  const a: Actor = {
    id: `a${++n}`,
    kind: 'vehicle',
    type,
    x,
    y,
    heading: Math.atan2(path[0][1] - y, path[0][0] - x),
    color: VEHICLES[type].color,
    speed: v,
    delay: 0,
    path: path.map(([px, py]) => ({ x: px, y: py, v })),
    flags: { drunk: false, noLicense: false, flees: false },
    ...o,
  };
  s.actors.push(a);
  return a;
}

const run = (s: Scene): Report => analyze(s, simulate(s));
const violations = (rep: Report, id: string) => rep.findings.filter((f) => f.actorId === id && f.severity === 'violation');
const refsOf = (rep: Report, id: string) => violations(rep, id).flatMap((f) => f.refs);
const sign = (s: Scene, kind: string, x: number, y: number, plates?: string[], value?: number) =>
  s.signs.push({ id: `g${++n}`, kind, x, y, angle: 0, value, plates });

describe('запрещающие знаки', () => {
  it('велосипед под 3.9 нарушает; спорная 8.4.15 сохраняет неопределённость без льготы', () => {
    const a = base();
    const bike = veh(a, 'bicycle', -20, 1.75, 20, [[60, 1.75]]);
    bike.age = 30;
    sign(a, '3.9', 0, 5.5);
    const rep = run(a);
    expect(refsOf(rep, bike.id)).toEqual(expect.arrayContaining(['sign:3.9', 'koap:12.29.2']));

    const b = base();
    const bike2 = veh(b, 'bicycle', -20, 1.75, 20, [[60, 1.75]]);
    sign(b, '3.9', 0, 5.5, ['8.4.15']);
    bike2.age = 30;
    const uncertain = run(b).findings.find(f => f.refs.includes('sign:3.9'));
    expect(uncertain?.severity).toBe('contributing');
    expect(uncertain?.compliance).toBe('не определить');
  });

  it('грузовик под знаком 3.4 — ч. 6 ст. 12.16, легковой автомобиль — нет', () => {
    const s = base();
    const truck = veh(s, 'truck', -50, 1.75, 30, [[80, 1.75]]);
    const car = veh(s, 'car', -90, 1.75, 30, [[80, 1.75]]);
    sign(s, '3.4', 0, 5.5);
    const rep = run(s);
    expect(refsOf(rep, truck.id)).toEqual(expect.arrayContaining(['sign:3.4', 'koap:12.16.6']));
    expect(refsOf(rep, car.id)).not.toContain('sign:3.4');
  });

  it('знак 3.11: масса ТС с грузом выше ограничения', () => {
    const s = base();
    const truck = veh(s, 'truck', -50, 1.75, 30, [[80, 1.75]]);
    truck.cargo = { ...NO_CARGO, mass: 4000 };
    sign(s, '3.11', 0, 5.5, undefined, 3);
    const rep = run(s);
    expect(refsOf(rep, truck.id)).toEqual(expect.arrayContaining(['sign:3.11', 'koap:12.21.1#11']));
  });

  it('знак 5.21 «Жилая зона» снижает допустимую скорость до 20 км/ч', () => {
    const s = base();
    const car = veh(s, 'car', -90, 1.75, 50, [[100, 1.75]]);
    sign(s, '5.21', -60, 5.5);
    const rep = run(s);
    expect(refsOf(rep, car.id)).toEqual(expect.arrayContaining(['sign:5.21', 'koap:12.9.2']));
  });
});

describe('повороты', () => {
  function crossing(): Scene {
    const s = base(12);
    s.roads.push({ id: 'r2', pts: [{ x: 0, y: -120 }, { x: 0, y: 120 }], lanes: 1, center: 'dashed', oneWay: false, zone: 'city', smooth: false });
    return s;
  }
  const rightTurn: [number, number][] = [[-40, 1.75], [-20, 1.75], [-8, 1.75], [-1.75, 8], [-1.75, 80]];
  const leftTurn: [number, number][] = [[-40, 1.75], [-20, 1.75], [-8, 1.75], [8, 1.75], [1.75, -8], [1.75, -80]];

  it('знак 3.18.1 запрещает поворот направо, но не налево', () => {
    const s = crossing();
    const car = veh(s, 'car', -60, 1.75, 25, rightTurn);
    sign(s, '3.18.1', -30, 5.5);
    expect(refsOf(run(s), car.id)).toEqual(expect.arrayContaining(['sign:3.18.1', 'koap:12.16.1']));

    const t = crossing();
    const car2 = veh(t, 'car', -60, 1.75, 25, leftTurn);
    sign(t, '3.18.1', -30, 5.5);
    expect(refsOf(run(t), car2.id)).not.toContain('sign:3.18.1');
  });

  it('стрела 1.18 «прямо» и поворот налево — ч. 2 ст. 12.16', () => {
    const s = crossing();
    const car = veh(s, 'car', -60, 1.75, 25, leftTurn);
    s.markings.push({ id: 'm1', kind: '1.18', pts: [{ x: -14, y: 1.75 }], angle: 0, variant: 'straight' });
    expect(refsOf(run(s), car.id)).toEqual(expect.arrayContaining(['marking:1.18', 'koap:12.16.2']));
  });
});

describe('разметка', () => {
  it('пересечение сплошной 1.1 на встречную сторону', () => {
    const s = base(10);
    const m: Marking = { id: 'm1', kind: '1.1', pts: [{ x: -100, y: 0 }, { x: 100, y: 0 }] };
    s.markings.push(m);
    const car = veh(s, 'car', -60, 1.75, 40, [[-20, 1.75], [10, -1.75], [60, -1.75]]);
    const rep = run(s);
    expect(refsOf(rep, car.id)).toEqual(expect.arrayContaining(['marking:1.1', 'koap:12.15.4']));
  });

  it('проезд вдоль линии без пересечения — без нарушений', () => {
    const s = base(10);
    s.markings.push({ id: 'm1', kind: '1.1', pts: [{ x: -100, y: 0 }, { x: 100, y: 0 }] });
    const car = veh(s, 'car', -60, 1.75, 40, [[80, 1.75]]);
    expect(violations(run(s), car.id)).toHaveLength(0);
  });
});

describe('перевозка грузов', () => {
  const cargo = (c: Partial<Cargo>): Cargo => ({ ...NO_CARGO, ...c });

  it('необозначенный свес сзади более 1 м — п. 23.4', () => {
    const s = base();
    const t = veh(s, 'truck', -40, 1.75, 30, [[60, 1.75]]);
    t.cargo = cargo({ rear: 1.8 });
    const rep = run(s);
    expect(refsOf(rep, t.id)).toEqual(expect.arrayContaining(['pdd:23.4', 'koap:12.21#1']));
    t.cargo = cargo({ rear: 1.8, marked: true });
    expect(refsOf(run(s), t.id)).not.toContain('pdd:23.4');
  });

  it('ширина с грузом выше 2,55 м — ст. 12.21.1', () => {
    const s = base();
    const t = veh(s, 'truck', -40, 1.75, 30, [[60, 1.75]]);
    t.cargo = cargo({ left: 0.7, right: 0.7, marked: true });
    const rep = run(s);
    expect(refsOf(rep, t.id)).toEqual(expect.arrayContaining(['pdd:23.5']));
    expect(refsOf(rep, t.id).some((r) => r.startsWith('koap:12.21.1#'))).toBe(true);
  });

  it('груз ограничивает обзор и закреплён плохо', () => {
    const s = base();
    const t = veh(s, 'van', -40, 1.75, 30, [[60, 1.75]]);
    t.cargo = cargo({ secured: false, blocksView: true });
    const refs = refsOf(run(s), t.id);
    expect(refs).toEqual(expect.arrayContaining(['pdd:23.2', 'pdd:23.3']));
  });
});
