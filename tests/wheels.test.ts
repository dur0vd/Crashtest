import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis';
import { simulate } from '../src/sim';
import { type Actor, type SurfaceType, type VehicleType, NO_CARGO, SURFACES, VEHICLES, emptyScene } from '../src/scene';
import { brakeLimit, dynOf, lateralLimit, steerAngles, tractionLimit, wheelLoads, wheelReport } from '../src/wheels';

const G = 9.81;

function veh(type: VehicleType, o: Partial<Actor> = {}): Actor {
  return {
    id: 'a1',
    kind: 'vehicle',
    type,
    x: 0,
    y: 0,
    heading: 0,
    color: '#fff',
    speed: 0,
    delay: 0,
    path: [],
    flags: { drunk: false, noLicense: false, flees: false },
    ...o,
  };
}

const dyn = (type: VehicleType, o: Partial<Actor> = {}) => dynOf(veh(type, o))!;
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

describe('схема колёс', () => {
  it('число колёс по типам', () => {
    const count = (t: VehicleType) => dyn(t).wheels.length;
    expect(count('bicycle')).toBe(2);
    expect(count('motorcycle')).toBe(2);
    expect(count('car')).toBe(4);
    expect(count('truck')).toBe(6); // задняя ось сдвоенная
    expect(count('bus')).toBe(6);
    expect(count('tram')).toBe(8);
  });

  it('у пешехода колёс нет', () => {
    const p = { ...veh('car'), kind: 'pedestrian', type: 'adult' } as Actor;
    expect(dynOf(p)).toBeNull();
  });

  it('статическая нагрузка складывается в вес, а развесовка совпадает с заданной', () => {
    for (const t of Object.keys(VEHICLES) as VehicleType[]) {
      const d = dyn(t);
      expect(sum(wheelLoads(d, 0, 0))).toBeCloseTo(d.mass * G, 3);
      expect(sum(d.w)).toBeCloseTo(1, 9);
    }
    const car = dyn('car');
    expect(car.w[0]).toBeCloseTo(0.57, 6);
    const truck = dyn('truck');
    expect(truck.w[1]).toBeGreaterThan(0.6); // у грузовика основной вес на заднюю ось
  });

  it('у тележечного трамвая нагрузка поровну на все колёсные пары', () => {
    const d = dyn('tram');
    for (const w of d.w) expect(w).toBeCloseTo(0.25, 9);
  });
});

describe('перенос нагрузки', () => {
  it('при торможении нагрузка уходит на передние колёса, сумма не меняется', () => {
    const d = dyn('car');
    const st = wheelLoads(d, 0, 0);
    const br = wheelLoads(d, 6, 0);
    expect(br[0]).toBeGreaterThan(st[0]);
    expect(br[2]).toBeLessThan(st[2]);
    expect(sum(br)).toBeCloseTo(sum(st), 3);
    // перенос ΔF = m·a·h / L на ось
    const L = d.wb;
    expect(br[0] + br[1] - (st[0] + st[1])).toBeCloseTo((d.mass * 6 * d.hCg) / L, 1);
  });

  it('при разгоне нагрузка уходит назад', () => {
    const d = dyn('car');
    const acc = wheelLoads(d, -3, 0);
    expect(acc[2]).toBeGreaterThan(wheelLoads(d, 0, 0)[2]);
  });

  it('в повороте нагрузка переходит на наружные колёса', () => {
    const d = dyn('car');
    // ay > 0 — центростремительное ускорение вправо, наружные колёса слева (y < 0)
    const f = wheelLoads(d, 0, 5);
    const left = d.wheels.map((w, i) => (w.y < 0 ? f[i] : 0));
    const right = d.wheels.map((w, i) => (w.y > 0 ? f[i] : 0));
    expect(sum(left)).toBeGreaterThan(sum(right));
    expect(sum(f)).toBeCloseTo(d.mass * G, 3);
    // поворот влево — наоборот
    const fl = wheelLoads(d, 0, -5);
    expect(d.wheels.map((w, i) => (w.y > 0 ? fl[i] : 0)).reduce((s, x) => s + x, 0)).toBeGreaterThan(d.wheels.map((w, i) => (w.y < 0 ? fl[i] : 0)).reduce((s, x) => s + x, 0));
  });

  it('при сильном крене внутренние колёса разгружаются до нуля, а вес сохраняется', () => {
    const d = dyn('truck');
    const f = wheelLoads(d, 0, 9);
    expect(Math.min(...f)).toBe(0);
    expect(sum(f)).toBeCloseTo(d.mass * G, 3);
  });

  it('груз сдвигает центр масс: на крыше он поднимается, в хвосте — загружает заднюю ось', () => {
    const empty = dyn('van');
    const roof = dyn('van', { cargo: { ...NO_CARGO, mass: 600, height: 3.3 } });
    expect(roof.hCg).toBeGreaterThan(empty.hCg);
    expect(lateralLimit(roof, 0.7).roll).toBeLessThan(lateralLimit(empty, 0.7).roll);
    const rear = dyn('car', { cargo: { ...NO_CARGO, mass: 400, height: 1.5, rear: 1.2 } });
    expect(rear.w[1]).toBeGreaterThan(dyn('car').w[1]);
  });
});

describe('сцепление и торможение', () => {
  const decel = (t: VehicleType, s: SurfaceType) => brakeLimit(dyn(t), SURFACES[s].mu).peak;

  it('замедление пропорционально сцеплению покрытия', () => {
    expect(decel('car', 'dry')).toBeGreaterThan(6);
    expect(decel('car', 'dry')).toBeLessThan(7.2);
    expect(decel('car', 'wet') / decel('car', 'dry')).toBeCloseTo(0.4 / 0.7, 1);
    expect(decel('car', 'ice')).toBeLessThan(1.1);
    expect(decel('truck', 'dry')).toBeLessThan(decel('car', 'dry'));
  });

  it('у ТС без АБС заблокированные колёса тормозят хуже, чем на пределе', () => {
    const b = brakeLimit(dyn('bicycle'), 0.7);
    expect(b.slide).toBeLessThan(b.peak);
    const c = brakeLimit(dyn('car'), 0.7);
    expect(c.slide).toBe(c.peak);
  });

  it('велосипед и мопед не опрокидываются через руль на сухой дороге, но близки к пределу', () => {
    const d = dyn('bicycle');
    expect(brakeLimit(d, 0.7).peak).toBeLessThanOrEqual(d.pitch + 1e-9);
    expect(d.pitch).toBeGreaterThan(4);
  });

  it('тяга: на льду ведущие колёса не передают больше, чем держит сцепление', () => {
    const car = dyn('car');
    expect(tractionLimit(car, 0.1)).toBeLessThan(VEHICLES.car.accel);
    expect(tractionLimit(car, 0.7)).toBeGreaterThan(VEHICLES.car.accel);
    expect(tractionLimit(dyn('suv'), 0.1)).toBeGreaterThan(tractionLimit(car, 0.1)); // полный привод
    expect(tractionLimit(dyn('cart'), 0.1)).toBe(Infinity);
  });
});

describe('поворот', () => {
  it('легковой теряет сцепление передней осью, грузовик опрокидывается раньше срыва шин', () => {
    const car = lateralLimit(dyn('car'), 0.7);
    expect(car.mode).toBe('understeer');
    expect(car.grip).toBeLessThan(car.roll);
    const truck = lateralLimit(dyn('truck'), 0.7);
    expect(truck.roll).toBeLessThan(truck.grip);
  });

  it('предел бокового ускорения растёт со сцеплением; рельсовое ТС удерживает гребень', () => {
    expect(lateralLimit(dyn('car'), 0.7).grip).toBeGreaterThan(lateralLimit(dyn('car'), 0.1).grip * 5);
    expect(lateralLimit(dyn('tram'), 0.1).grip).toBe(Infinity);
  });

  it('углы поворота: внутреннее переднее колесо поворачивается сильнее наружного, задние неподвижны', () => {
    const d = dyn('car');
    const delta = steerAngles(d, 1 / 15); // поворот вправо, R = 15 м
    // порядок колёс: 1Л, 1П, 2Л, 2П
    expect(delta[1]).toBeGreaterThan(delta[0]); // правое — внутреннее
    expect(delta[0]).toBeGreaterThan(0);
    expect(delta[2]).toBe(0);
    expect(delta[3]).toBe(0);
    // среднее значение ≈ угол велосипедной модели atan(L/R)
    const bike = Math.atan(d.wb / 15);
    expect((delta[0] + delta[1]) / 2).toBeGreaterThan(bike * 0.85);
    expect((delta[0] + delta[1]) / 2).toBeLessThan(bike * 1.15);
    expect(steerAngles(d, 0).every((x) => x === 0)).toBe(true);
    // у рельсового ТС колёсные пары не поворачиваются
    expect(steerAngles(dyn('tram'), 0.05).every((x) => x === 0)).toBe(true);
  });
});

describe('отчёт по ТС', () => {
  it('содержит нагрузку на каждое колесо и согласуется с физикой', () => {
    const r = wheelReport(veh('car'), 'dry')!;
    expect(r.wheels.length).toBe(4);
    expect(r.wheels[0].loadBraking).toBeGreaterThan(r.wheels[0].load);
    expect(r.wheels[2].loadBraking).toBeLessThan(r.wheels[2].load);
    expect(r.abs).toBe(true);
    expect(r.stop50).toBeCloseTo((50 / 3.6) ** 2 / (2 * r.decel), 6);
    expect(wheelReport(veh('truck'), 'dry')!.limit).toBe('roll');
    expect(wheelReport({ ...veh('car'), kind: 'pedestrian', type: 'adult' } as Actor, 'dry')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Колёса в симуляции

/** Дуга радиуса R, 90° влево от курса на восток; точки с шагом по 10°. */
function arc(R: number, kmh: number): Actor['path'] {
  const pts: Actor['path'] = [];
  for (let a = 10; a <= 90; a += 10) {
    const t = (a * Math.PI) / 180;
    pts.push({ x: R * Math.sin(t) + 60, y: -R * (1 - Math.cos(t)), v: kmh });
  }
  const last = pts[pts.length - 1];
  pts.push({ x: last.x, y: last.y - 80, v: kmh });
  return pts;
}

function bend(type: VehicleType, R: number, kmh: number, surface: SurfaceType = 'dry', extra: Partial<Actor> = {}) {
  const s = emptyScene();
  s.env.surface = surface;
  s.env.duration = 12;
  s.actors.push(veh(type, { x: 0, y: 0, speed: kmh, path: [{ x: 60, y: 0, v: kmh }, ...arc(R, kmh)], ...extra }));
  return { scene: s, tl: simulate(s) };
}

describe('колёса в симуляции', () => {
  it('на повороте с безопасной скоростью управляемость сохраняется', () => {
    const { tl } = bend('car', 40, 40);
    expect(tl.events.filter((e) => e.kind !== 'abs')).toEqual([]);
  });

  it('слишком быстрый вход в поворот: легковой сносит передней осью', () => {
    const { tl } = bend('car', 25, 80);
    const e = tl.events.find((x) => x.kind === 'understeer');
    expect(e).toBeDefined();
    expect(e!.ay!).toBeGreaterThan(e!.limit!);
    // после срыва ТС скользит по прямой и дальше уходит от дуги
    const tr = tl.tracks.get('a1')!;
    expect(tr.free[tl.n - 1]).toBe(1);
  });

  it('та же скорость на льду срывает ТС и на более пологой дуге', () => {
    expect(bend('car', 60, 40, 'dry').tl.events.length).toBe(0);
    expect(bend('car', 60, 40, 'ice').tl.events.some((e) => e.kind === 'understeer')).toBe(true);
  });

  it('грузовик на повороте опрокидывается, а скользящее ТС после срыва оказывается на боку', () => {
    const { tl } = bend('truck', 40, 65);
    const e = tl.events.find((x) => x.kind === 'rollover');
    expect(e).toBeDefined();
    const tr = tl.tracks.get('a1')!;
    const nw = tr.nw;
    const k = tl.n - 1;
    for (let w = 0; w < nw; w++) expect(tr.wst[k * nw + w]).toBe(3); // колёса оторваны от дороги
  });

  it('вращение колёс соответствует пройденному пути', () => {
    const s = emptyScene();
    s.env.duration = 3;
    s.actors.push(veh('car', { speed: 36 }));
    const tl = simulate(s);
    const tr = tl.tracks.get('a1')!;
    const d = dynOf(s.actors[0])!;
    const k = tl.n - 1;
    const dist = tr.x[k] - tr.x[0];
    for (let w = 0; w < tr.nw; w++) expect((tr.wspin[k * tr.nw + w] * d.layout.radius) / dist).toBeGreaterThan(0.97);
    for (let w = 0; w < tr.nw; w++) expect((tr.wspin[k * tr.nw + w] * d.layout.radius) / dist).toBeLessThan(1.03);
  });

  it('в повороте наружные колёса вращаются быстрее внутренних', () => {
    const { tl } = bend('car', 40, 30);
    const tr = tl.tracks.get('a1')!;
    const k = tl.n - 1;
    const nw = tr.nw;
    // поворот влево: наружная сторона — правая (колёса 1П, 2П)
    const spin = (w: number) => tr.wspin[k * nw + w];
    expect(spin(1)).toBeGreaterThan(spin(0));
    expect(spin(3)).toBeGreaterThan(spin(2));
  });

  it('торможение на пределе: АБС — колёса вращаются, без АБС — блокируются и оставляют юз', () => {
    const run = (type: VehicleType, kmh: number) => {
      const s = emptyScene();
      s.env.duration = 6;
      // остановиться надо быстрее, чем позволяет сцепление
      s.actors.push(veh(type, { speed: kmh, path: [{ x: 6, y: 0, v: 0 }] }));
      return simulate(s);
    };
    const abs = run('car', 50);
    expect(abs.events.some((e) => e.kind === 'abs')).toBe(true);
    const trA = abs.tracks.get('a1')!;
    expect(Array.from(trA.wst).includes(2)).toBe(false);
    expect(Array.from(trA.wst).includes(1)).toBe(true);

    const bike = run('bicycle', 30);
    expect(bike.events.some((e) => e.kind === 'lock')).toBe(true);
    const trB = bike.tracks.get('a1')!;
    expect(Array.from(trB.wst).includes(2)).toBe(true);
  });

  it('заблокированное колесо стоит на месте, пока ТС скользит', () => {
    const s = emptyScene();
    s.env.duration = 6;
    s.actors.push(veh('bicycle', { speed: 30, path: [{ x: 6, y: 0, v: 0 }] }));
    const tl = simulate(s);
    const tr = tl.tracks.get('a1')!;
    const nw = tr.nw;
    // найти кадры, где оба колеса заблокированы, и убедиться, что угол качения не меняется
    const ks: number[] = [];
    for (let k = 1; k < tl.n; k++) if (tr.wst[k * nw] === 2 && tr.wst[(k - 1) * nw] === 2) ks.push(k);
    expect(ks.length).toBeGreaterThan(5);
    for (const k of ks) expect(tr.wspin[k * nw]).toBeCloseTo(tr.wspin[(k - 1) * nw], 9);
  });

  it('после удара ТС скользит: колёса не катятся и дают следы юза', () => {
    const s = emptyScene();
    s.env.duration = 6;
    s.actors.push(veh('car', { id: 'a1', x: 0, speed: 54 }));
    s.actors.push(veh('car', { id: 'a2', x: 80, y: 0, heading: Math.PI, speed: 54 }));
    const tl = simulate(s);
    const tr = tl.tracks.get('a1')!;
    const k = tl.collisions[0].frame + 2;
    expect(tr.free[k]).toBe(1);
    expect(tr.wst[k * tr.nw]).toBe(2);
  });
});

describe('разбор: потеря управляемости', () => {
  it('срыв на повороте — нарушение п. 10.1, а столкновение после срыва находится в причинной связи', () => {
    const s = emptyScene();
    s.env.duration = 12;
    s.actors.push(veh('car', { x: 0, y: 0, speed: 80, path: [{ x: 60, y: 0, v: 80 }, ...arc(25, 80)] }));
    // забор на пути сноса
    s.obstacles.push({ id: 'o1', x: 100, y: -6, w: 1, h: 60, angle: 0, kind: 'fence' });
    const tl = simulate(s);
    const rep = analyze(s, tl);
    const f = rep.findings.find((x) => x.refs.includes('pdd:10.1') && /поворот/.test(x.title));
    expect(f).toBeDefined();
    expect(f!.severity).toBe('violation');
    expect(f!.detail).toMatch(/м\/с²/);
  });

  it('при безопасной скорости на повороте замечаний о потере управляемости нет', () => {
    const { scene, tl } = bend('car', 40, 40);
    const rep = analyze(scene, tl);
    expect(rep.findings.some((f) => /поворот/.test(f.title))).toBe(false);
  });
});
