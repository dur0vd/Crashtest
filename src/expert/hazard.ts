import { buildGeo, roadsAt } from '../geo';
import type { OBB, Vec } from '../geom';
import { nearestOnPolyline } from '../geom';
import { type Scene, LANE_WIDTH, dimsOf } from '../scene';
import type { Timeline } from '../sim';
import { type BlindSector, lineOfSight } from './visibility';
import { dm } from '../dmath';

export interface VisibilityOptions {
  /** Driver eye point in the observer body frame (x forward, y right) from the track reference point, m. */
  eyeOffset?: { x: number; y: number; source: string };
  pillars?: BlindSector[];
  /** Measured visibility distance (lighting/weather experiment), m. */
  visibilityDistance?: { value: number; source: string };
  occludingActors?: 'all-vehicles' | 'stationary-vehicles' | 'none';
}

function boxAt(scene: Scene, tl: Timeline, id: string, k: number): OBB {
  const a = scene.actors.find(x => x.id === id)!, tr = tl.tracks.get(id)!, d = dimsOf(a), h = tr.h[k];
  return { cx: tr.x[k] + dm.cos(h) * d.shift, cy: tr.y[k] + dm.sin(h) * d.shift, hl: d.length / 2, hw: d.width / 2, a: h };
}

/** Per-frame 2D visibility of target from observer, with the moment it could first be detected. */
export function visibilityTimeline(scene: Scene, tl: Timeline, observerId: string, targetId: string, opts: VisibilityOptions = {}) {
  const obs = tl.tracks.get(observerId), tgt = tl.tracks.get(targetId);
  if (!obs || !tgt) throw new Error('Обзорность: нет трека участника');
  const geo = buildGeo(scene);
  const frames: { k: number; t: number; visible: boolean; fraction: number; distance: number; blockedBy: string[]; reasons: string[] }[] = [];
  const mode = opts.occludingActors ?? 'all-vehicles';
  for (let k = 0; k < tl.n; k++) {
    if (!obs.present[k] || !tgt.present[k]) continue;
    const h = obs.h[k], off = opts.eyeOffset ?? { x: 0, y: 0 };
    const eye: Vec = { x: obs.x[k] + dm.cos(h) * off.x - dm.sin(h) * off.y, y: obs.y[k] + dm.sin(h) * off.x + dm.cos(h) * off.y };
    const occluders = geo.obstacles.map(o => ({ id: o.item.id, kind: o.item.kind as string, box: o.box }));
    if (mode !== 'none') for (const a of scene.actors) {
      if (a.id === observerId || a.id === targetId || a.kind !== 'vehicle') continue;
      const tr = tl.tracks.get(a.id)!;
      if (!tr.present[k] || mode === 'stationary-vehicles' && tr.v[k] > 0.1) continue;
      occluders.push({ id: a.id, kind: 'vehicle', box: boxAt(scene, tl, a.id, k) });
    }
    const r = lineOfSight({ eye, heading: h, target: boxAt(scene, tl, targetId, k), occluders, pillars: opts.pillars, visibilityDistance: opts.visibilityDistance?.value });
    frames.push({ k, t: k * tl.dt, visible: r.visible, fraction: r.visibleFraction, distance: r.distance, blockedBy: r.blockedBy, reasons: r.reasons });
  }
  const first = frames.find(f => f.visible) ?? null;
  return {
    frames, firstVisible: first ? { frame: first.k, t: first.t, distance: first.distance } : null,
    sources: [...(opts.eyeOffset ? [opts.eyeOffset.source] : []), ...(opts.pillars ?? []).map(p => p.source), ...(opts.visibilityDistance ? [opts.visibilityDistance.source] : [])],
    assumptions: [
      'Плоская (2D) линия видимости до углов и центра контура цели; высоты, прозрачность и ослепление не моделируются.',
      'Здания, ограждения, деревья и препятствия сцены — непрозрачные прямоугольники.',
      opts.eyeOffset ? 'Точка глаз водителя задана пользователем.' : 'Точка глаз не задана: принята опорная точка трека ТС (допущение).',
      opts.visibilityDistance ? `Дальность видимости ${opts.visibilityDistance.value} м — измеренное значение (${opts.visibilityDistance.source}).` : 'Дальность видимости (свет/погода) не установлена: ограничение только геометрическое; прежняя константа 100 м не применяется.',
      `Перекрывающие ТС: ${mode === 'all-vehicles' ? 'все ТС на кадре' : mode === 'stationary-vehicles' ? 'только стоящие (v ≤ 0,1 м/с)' : 'не учитываются'}.`,
    ],
  };
}

export type HazardCriterion = 'entered-carriageway' | 'entered-vehicle-lane' | 'changed-direction' | 'became-visible';

export interface HazardCandidate {
  criterion: HazardCriterion;
  frame: number;
  t: number;
  explanation: string;
  /** Vehicle speed at that moment and distance it travels until the conflict frame. */
  v0: number;
  available: number;
}

/**
 * Candidate moments of hazard onset by expert-practice criteria. The choice
 * among them is the expert's (recorded in the report), not made here.
 */
export function hazardMoments(scene: Scene, tl: Timeline, vehicleId: string, otherId: string,
  opts: { directionChangeDeg?: number; visibility?: VisibilityOptions } = {}) {
  const v = tl.tracks.get(vehicleId), o = tl.tracks.get(otherId);
  if (!v || !o) throw new Error('Опасность: нет трека участника');
  const col = tl.collisions.find(c => c.a === vehicleId && c.b === otherId || c.a === otherId && c.b === vehicleId);
  let conflict = col?.frame ?? -1;
  if (conflict < 0) {
    let best = Infinity;
    for (let k = 0; k < tl.n; k++) if (v.present[k] && o.present[k]) {
      const d = dm.hypot(v.x[k] - o.x[k], v.y[k] - o.y[k]);
      if (d < best) { best = d; conflict = k; }
    }
  }
  if (conflict < 0) throw new Error('Опасность: участники не присутствуют одновременно');
  const travelled = (k0: number) => {
    let s = 0;
    for (let k = k0 + 1; k <= conflict; k++) s += dm.hypot(v.x[k] - v.x[k - 1], v.y[k] - v.y[k - 1]);
    return s;
  };
  const cand = (criterion: HazardCriterion, k: number, explanation: string): HazardCandidate =>
    ({ criterion, frame: k, t: k * tl.dt, explanation, v0: v.v[k], available: travelled(k) });
  const out: HazardCandidate[] = [];
  const geo = buildGeo(scene);
  const firstPresent = [...o.present].indexOf(1);
  for (let k = Math.max(0, firstPresent); k <= conflict; k++) {
    if (!o.present[k]) continue;
    if (roadsAt(geo, { x: o.x[k], y: o.y[k] }).length) {
      out.push(cand('entered-carriageway', k, k === firstPresent ? 'Участник уже на проезжей части при появлении на сцене.' : 'Участник вступил на проезжую часть.'));
      break;
    }
  }
  const path: Vec[] = [];
  for (let k = 0; k < tl.n; k++) if (v.present[k]) path.push({ x: v.x[k], y: v.y[k] });
  if (path.length >= 2) for (let k = Math.max(0, firstPresent); k <= conflict; k++) {
    if (!o.present[k]) continue;
    if (nearestOnPolyline(path, { x: o.x[k], y: o.y[k] }).dist <= LANE_WIDTH / 2) {
      out.push(cand('entered-vehicle-lane', k, `Участник вошёл в полосу шириной ${LANE_WIDTH} м вдоль фактической траектории ТС.`));
      break;
    }
  }
  if (opts.directionChangeDeg !== undefined) {
    const lag = Math.max(1, Math.round(0.25 / tl.dt));
    for (let k = Math.max(firstPresent, 0) + lag; k <= conflict; k++) {
      if (!o.present[k - lag] || o.v[k] < 0.2 || o.v[k - lag] < 0.2) continue;
      let dh = (o.h[k] - o.h[k - lag]) * 180 / Math.PI;
      dh = ((dh + 180) % 360 + 360) % 360 - 180;
      if (Math.abs(dh) >= opts.directionChangeDeg) {
        out.push(cand('changed-direction', k, `Курс участника изменился на ${dh.toFixed(1)}° за ${(lag * tl.dt).toFixed(2)} с (порог ${opts.directionChangeDeg}° — настройка анализа).`));
        break;
      }
    }
  }
  if (opts.visibility) {
    const vis = visibilityTimeline(scene, tl, vehicleId, otherId, opts.visibility);
    if (vis.firstVisible && vis.firstVisible.frame <= conflict) out.push(cand('became-visible', vis.firstVisible.frame, `Участник впервые в зоне видимости на расстоянии ${vis.firstVisible.distance.toFixed(1)} м.`));
  }
  return { conflict: { frame: conflict, t: conflict * tl.dt, kind: col ? 'collision' as const : 'closest-approach' as const }, candidates: out };
}
