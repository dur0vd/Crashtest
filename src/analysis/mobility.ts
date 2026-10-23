import type { Ctx, Info } from './context';
import type { FindingInput } from './types';
import { isCycleRider, isSmallRider, mobilityPlaceAt, mobilityPlacePermission, any } from '../mobility';
import { kmh, pointInObb, angDiff } from '../geom';
import { roadsAt } from '../geo';
import { posAt, sampleTrace, tOf } from './technical';
import { lawRef } from '../law';

/** Observed route and explicit facts; no synthetic trace is evidence of field validation. */
export function checkMobility(ctx: Ctx, add: (f: FindingInput) => unknown, limitAt: (i: Info, k: number) => { limit: number; refs: string[] } | null): void {
  for (const i of ctx.infos.values()) {
    if (!isSmallRider(i.a)) continue;
    const a = i.a, c = a.mobilityContext ?? {};
    const seen = new Set<string>();
    const emit = (key: string, k: number, allowed: boolean | null, title: string, detail: string, refs: string[], extra: Record<string, unknown> = {}) => {
      if (seen.has(key)) return;
      seen.add(key);
      const sources = refs.filter(ref => !ref.startsWith('rule:')).map(ref => lawRef(ref, ctx.scene.env.accidentDate));
      if (sources.some(source => !source.revision)) allowed = null;
      add({ actorId: a.id, severity: allowed === true ? 'info' : allowed === false ? 'violation' : 'contributing', t: tOf(k), title, detail,
        refs: [...refs, ...(allowed === false ? ['rule:mobility'] : [])], trace: { ...sampleTrace(ctx, i, k),
          mobilityContext: structuredClone(c), simParameters: structuredClone(a.simParameters), age: a.age,
          ...extra, sources, compliance: allowed === true ? 'выполнено' : allowed === false ? 'нарушено' : 'не определить' } });
    };
    for (let k = i.k0; k <= i.kEnd; k++) {
      if (!i.tr.present[k] || Math.abs(i.tr.v[k]) < 0.1) continue;
      const p = posAt(i, k);
      const place = mobilityPlaceAt(ctx.geo, p, i.tr.h[k], i.hw * 2);
      const permission = mobilityPlacePermission(a, place);
      emit(`place:${place.surface}:${permission.allowed}`, k, permission.allowed, permission.allowed === false ? 'место движения не разрешено разделом 24' : permission.allowed === null ? 'допустимость места движения не установлена' : 'место движения соответствует разделу 24',
        permission.reason, permission.refs, { place, edgeToleranceM: 0.75, geometryMethod: 'центр трека в коридоре; правая кромка с учётом ширины ездока' });
      if (a.type === 'sim') {
        const speed = Math.abs(kmh(i.tr.v[k]));
        const limit = limitAt(i, k)!;
        if (speed > limit.limit + 0.01) emit(`speed:${limit.limit}`, k, false, 'СИМ: превышен применимый предел скорости', `Наблюдаемая скорость ${speed.toFixed(1)} км/ч; предел ${limit.limit} км/ч.`, [...limit.refs, 'rule:speed'], { speedKmh: speed, limit: limit.limit, excess: speed - limit.limit, formula: 'v[k] × 3.6 > min(25, применимый меньший предел)', units: 'км/ч' });
      }
      const pedestrianPlace = ['sidewalk', 'footpath', 'pedestrian-side', 'pedestrian-zone', 'shoulder'].includes(place.surface) || place.pedestrianZone;
      const shared = pedestrianPlace || place.surface === 'sharedpath';
      if (shared && isCycleRider(a)) {
        const danger = any(c.pedestrianObstruction, c.pedestrianDanger);
        if (pedestrianPlace && danger !== false) {
          const speed = Math.abs(kmh(i.tr.v[k]));
          const allowed = danger === null ? null : a.type === 'bicycle' ? false : c.pedestrianSpeedKmh === undefined ? null : speed <= c.pedestrianSpeedKmh + 0.01;
          emit('pedestrian-hazard', k, allowed, 'проверка помех и опасности пешеходам', 'Велосипедист должен спешиться; лицо на СИМ — спешиться либо снизить скорость до скорости пешеходов. Опасность и помехи не предполагаются отсутствующими.', ['pdd:24.6'], { speedKmh: speed, pedestrianSpeedKmh: c.pedestrianSpeedKmh });
        }
        emit('pedestrian-priority', k, c.pedestrianPriorityRespected ?? null, 'приоритет пешеходов при совместном движении', 'Во всех случаях совместного движения пешеходы имеют приоритет.', ['pdd:24.6']);
      }
      if (place.surface === 'carriageway' && place.rightEdge) {
        emit('single-file', k, a.type === 'bicycle' && c.column === true && i.hw * 2 <= 0.75 && c.singleFile !== true ? null : c.singleFile ?? null, 'движение в один ряд', 'Правая кромка: требуется один ряд; параметры колонны велосипедистов отдельно не реконструируются.', ['pdd:24.5']);
        if (a.type === 'sim' && c.leftBypass === true) emit('left-bypass', k, false, 'СИМ: обгон или объезд слева', 'По правому краю проезжей части обгон или объезд транспортного средства слева запрещён.', ['pdd:24.5']);
      }
      for (const cw of ctx.geo.crosswalks) {
        if (!pointInObb(p, cw.box) || Math.abs(Math.cos(angDiff(i.tr.h[k], cw.item.angle))) < 0.7) continue;
        // Require actual travel across the road, not mere proximity to a zebra.
        const local = (frame: number) => (i.tr.x[frame] - cw.item.x) * Math.cos(cw.item.angle) + (i.tr.y[frame] - cw.item.y) * Math.sin(cw.item.angle);
        const before = local(i.k0), after = local(i.kEnd);
        const entered = before < -cw.item.length / 2 && after > -cw.item.length / 2 + 0.5 || before > cw.item.length / 2 && after < cw.item.length / 2 - 0.5;
        if (entered || before * after < 0 && Math.abs(before - after) >= 1) emit(`crosswalk:${cw.item.id}`, k, false, 'пересечение дороги по переходу верхом', 'По наблюдаемому движению ездок начал пересекать дорогу по пешеходному переходу. Ведущий устройство пешеход оценивается по разделу 4.', ['pdd:24.8'], { crosswalkId: cw.item.id, beforeM: before, afterM: after, minimumEntryProgressM: 0.5, methodLimit: 'Требуется направленный въезд в коридор либо пересечение его середины; одного касания недостаточно' });
      }
    }
    for (const graph of ctx.priorityGraphs) {
      const pass = graph.participants.find(p => p.actorId === a.id && p.entered && ['left', 'uturn'].includes(p.maneuver));
      if (!pass) continue;
      const road = ctx.scene.roads.find(r => r.id === pass.roadId);
      const place = mobilityPlaceAt(ctx.geo, posAt(i, pass.entryFrame), pass.entryHeading);
      const tram = ctx.geo.tracks.some(t => t.item.kind !== 'railway' && t.pts.some(p => roadsAt(ctx.geo, p).some(hit => hit.rg.road.id === road?.id)));
      if ((road && road.lanes > 1 || tram) && !place.cycleZone) emit(`turn:${graph.intersectionId}`, pass.entryFrame, c.leftTurnPermittedFromRight === undefined ? null : c.leftTurnPermittedFromRight,
        'ограничение левого поворота и разворота', 'На многополосной дороге или дороге с трамвайным движением нужны разрешение из правой полосы либо велосипедная зона.', ['pdd:24.8']);
    }
  }
}
