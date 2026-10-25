import type { Ctx, Finding, Info } from './analysis';
import { roadsAt, widthsAt } from './geo';
import { angDiff, angleOf, buildPath, nearestOnPolyline, type Vec } from './geom';
import { type Actor, type TurnSignal, type VehicleType, VEHICLES, LANE_WIDTH } from './scene';
import { DT } from './sim';

/** Указатель задаётся для участка, заканчивающегося соответствующей точкой. */
export function signalAtDistance(a: Actor, distance: number): TurnSignal {
  if (!a.path.length) return 'none';
  const route = buildPath([{ x: a.x, y: a.y }, ...a.path], true);
  const index = a.path.findIndex((_, i) => distance < route.nodeS[i + 1] - 0.01);
  return index < 0 ? 'none' : a.path[index].signal ?? 'none';
}

export function signalAtPosition(a: Actor, p: Vec): TurnSignal {
  if (!a.path.length) return 'none';
  const route = buildPath([{ x: a.x, y: a.y }, ...a.path], true);
  return signalAtDistance(a, nearestOnPolyline(route.pts, p).s);
}

/** Выделяет заметное отклонение от направления дороги, исключая следование её изгибу. */
export function checkTurnSignals(ctx: Ctx, i: Info, add: (f: Omit<Finding, 'causal'>) => void): void {
  if (!i.isVeh || VEHICLES[i.a.type as VehicleType].rail || !i.a.path.length) return;
  const candidates: { frame: number; expected: TurnSignal }[] = [];
  let inManeuver = false;
  for (let k = i.k0; k <= i.kEnd; k++) {
    if (!i.tr.present[k] || i.tr.v[k] < 0.5) continue;
    const hits = roadsAt(ctx.geo, { x: i.tr.x[k], y: i.tr.y[k] }, 1);
    let deviation = angDiff(i.tr.h[i.k0], i.tr.h[k]);
    if (hits.length) {
      const candidates = hits.map((h) => {
        const axis = angleOf(h.near.tangent);
        const forward = Math.abs(angDiff(axis, i.tr.h[k])) < Math.PI / 2 ? axis : axis + Math.PI;
        return angDiff(forward, i.tr.h[k]);
      });
      deviation = candidates.reduce((a, b) => Math.abs(a) < Math.abs(b) ? a : b);
    }
    if (Math.abs(deviation) < 0.06) { inManeuver = false; continue; }
    if (inManeuver || Math.abs(deviation) < 0.20) continue;
    inManeuver = true;
    candidates.push({ frame: k, expected: deviation < 0 ? 'left' : 'right' });
  }

  // Плавное перестроение может почти не менять курс: проверяем также переход
  // центра ТС через границу полосы относительно оси той же самой дороги.
  for (const rg of ctx.geo.roads) {
    if (rg.road.lanes < 2) continue;
    let baseline: { k: number; d: number; lane: number } | null = null;
    for (let k = i.k0; k <= i.kEnd; k++) {
      const hit = roadsAt(ctx.geo, { x: i.tr.x[k], y: i.tr.y[k] }).find((h) => h.rg === rg);
      if (!hit) { baseline = null; continue; }
      const d = hit.near.d;
      const w = widthsAt(rg, hit.near.s);
      const lane = Math.floor((d + (rg.road.oneWay ? w.l : 0)) / LANE_WIDTH);
      if (!baseline) { baseline = { k, d, lane }; continue; }
      if (lane === baseline.lane || Math.abs(d - baseline.d) < 0.8) continue;
      let onset = baseline.k;
      for (let q = baseline.k; q < k; q++) {
        const near = nearestOnPolyline(rg.pts, { x: i.tr.x[q], y: i.tr.y[q] });
        if (Math.abs(near.d - baseline.d) > 0.2) { onset = q; break; }
      }
      const forward = Math.abs(angDiff(angleOf(hit.near.tangent), i.tr.h[k])) < Math.PI / 2;
      const right = (d > baseline.d) === forward;
      candidates.push({ frame: onset, expected: right ? 'right' : 'left' });
      baseline = { k, d, lane };
    }
  }

  let previous = -Infinity;
  for (const { frame: k, expected } of candidates.sort((a, b) => a.frame - b.frame)) {
    if (k - previous < Math.round(2 / DT)) continue;
    previous = k;
    const before = Math.max(i.k0, k - Math.round(1 / DT));
    let correct = true;
    for (let q = before; q <= k; q++) {
      if (signalAtDistance(i.a, i.trav[q]) !== expected) { correct = false; break; }
    }
    if (correct) continue;
    add({
      actorId: i.a.id, severity: 'violation', t: k * DT,
      title: 'манёвр без заблаговременного сигнала поворота',
      detail: `Перед смещением ${expected === 'left' ? 'влево' : 'вправо'} не был заранее включён соответствующий указатель. Учебный критерий — непрерывный сигнал за 1 с до заметного отклонения курса; если сцена начинается позже, проверяется весь доступный интервал. Сам сигнал не даёт преимущества.`,
      refs: ['pdd:8.1', 'pdd:8.2', 'koap:12.14.1'],
    });
  }
}
