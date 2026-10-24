import type { Ctx, Finding, Info } from './analysis';
import { roadsAt } from './geo';
import { angDiff, angleOf, buildPath, nearestOnPolyline, type Vec } from './geom';
import type { Actor, TurnSignal } from './scene';
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
  if (!i.isVeh || i.rail || !i.a.path.length) return;
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
    if (inManeuver || Math.abs(deviation) < 0.10) continue;
    inManeuver = true;
    const expected: TurnSignal = deviation < 0 ? 'left' : 'right';
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
