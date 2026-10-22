import { checkPassengers } from './passengers';
import {
  roadsAt,
  intersectionAt,
  sidewalkAt,
  trackAt,
} from '../geo';
import {
  type Vec,
  angDiff,
  dist,
  dot,
  fromAngle,
  kmh,
  pointInObb,
  angleOf,
  toLocal,
} from '../geom';
import { type Collision, DT } from '../sim';
import { type Kit, checkCargoRules, checkMarkingRules, checkSignRules, cargoInvolved, classOf, computeGateEnds, signApplies } from '../restrictions';
import {
  type CenterMarking,
  type Sign,
  type VehicleType,
  VEHICLES,
  SURFACES,
  lightPhase,
  pedestrianGreen,
} from '../scene';

import type { Ctx, Info } from './context';
import { checkManeuvers, maneuverPriority } from './maneuvers';
import { checkRailway, railwayPriority } from './railway';
import { applySpecialDeparture, blueBeacon, checkSpecialSignals, specialPairState, specialPriority } from './special-signals';
import { admittedRouteDirection, checkRouteTransport, routeLaneAt, routeLaneDirectionMatches, routePriority, routeSignException } from './route-transport';
import { movementPermission } from '../traffic-control';
import { buildPriorityGraphs, checkIntersectionObservations, controllerAt, graphPriority, turningVulnerablePriority, movementFor } from './intersections';
import type { FindingInput, DraftFinding, TechAssessment, CollisionReport, Finding, RulesSection, ActorVerdict } from './types';
import { type TechnicalContext, boxAt, posAt, tOf, leftmostLat, stoppingCalculation, regionOf, sampleTrace } from './technical';

function addFinding(ctx: Ctx, f: FindingInput): DraftFinding {
  const full: DraftFinding = { causal: false, ...applySpecialDeparture(ctx, f) };
  ctx.findings.push(full);
  if (full.t !== undefined && full.severity !== 'info') {
    ctx.events.push({ t: full.t, text: `${ctx.infos.get(full.actorId)!.label}: ${full.title}` });
  }
  return full;
}

/** Знаки, действующие для участника в кадре (с учётом пройденного после знака пути). */
function activeSigns(ctx: Ctx, actorId: string, frame: number, maxDist: number): Sign[] {
  const i = ctx.infos.get(actorId)!;
  return ctx.gates
    .filter((g) => g.actorId === actorId && g.sign && g.frame <= frame && (g.until === undefined || frame < g.until) && i.trav[frame] - g.dist <= maxDist)
    .map((g) => g.sign!);
}

// ---------------------------------------------------------------------------
// Проверки движения отдельных участников

function zoneLimit(type: VehicleType, zone: 'city' | 'outside' | 'residential'): { limit: number; ref: string } | null {
  if (zone === 'residential') return { limit: 20, ref: 'pdd:10.2' };
  if (zone === 'city') return { limit: 60, ref: 'pdd:10.2' };
  const vs = VEHICLES[type];
  if (vs.rail) return null;
  if (type === 'bicycle' || type === 'cart') return null;
  if (type === 'truck' || type === 'trolleybus') return { limit: 70, ref: 'pdd:10.3' };
  return { limit: 90, ref: 'pdd:10.3' };
}

export function speedLimitAt(ctx: Ctx, i: Info, k: number): { limit: number; refs: string[] } | null {
  if (i.a.railwayTrain) return null;
  const hits = roadsAt(ctx.geo, posAt(i, k), 1);
  if (!hits.length) return null;
  const active = activeSigns(ctx, i.a.id, k, 100000);
  const sign = active.filter((s) => s.kind === '3.24').pop();
  if (sign?.value && signApplies(sign, classOf(i))) return { limit: sign.value, refs: ['sign:3.24'] };
  // знаки зон: 5.21 (жилая зона), 5.23.1/5.24.1 (начало населённого пункта / выезд), 5.31 (зона с ограничением скорости)
  const zoneSign = active.filter((s) => ['5.21', '5.23.1', '5.24.1', '5.31'].includes(s.kind)).pop();
  if (zoneSign) {
    const type = i.a.type as VehicleType;
    if (zoneSign.kind === '5.31' && zoneSign.value) return { limit: zoneSign.value, refs: ['sign:5.31'] };
    if (zoneSign.kind === '5.21') return { limit: 20, refs: ['sign:5.21', 'pdd:17.1'] };
    const z = zoneLimit(type, zoneSign.kind === '5.23.1' ? 'city' : 'outside');
    if (z) return { limit: z.limit, refs: [`sign:${zoneSign.kind}`, z.ref] };
  }
  const z = zoneLimit(i.a.type as VehicleType, hits[0].rg.road.zone);
  return z ? { limit: z.limit, refs: [z.ref] } : null;
}

function checkSpeed(ctx: Ctx, i: Info): void {
  let run = 0;
  interface SpeedHit {
    excess: number;
    k: number;
    limit: number;
    refs: string[];
  }
  let best: SpeedHit | null = null as SpeedHit | null;
  let runBest: SpeedHit | null = null as SpeedHit | null;
  for (let k = Math.max(i.k0, 0); k <= i.kEnd; k++) {
    const lim = speedLimitAt(ctx, i, k);
    const v = kmh(i.tr.v[k]);
    if (lim && v > lim.limit + 0.5) {
      run++;
      const ex = v - lim.limit;
      if (!runBest || ex > runBest.excess) runBest = { excess: ex, k, limit: lim.limit, refs: lim.refs };
      if (run >= 12 && runBest && (!best || runBest.excess > best.excess)) best = runBest;
    } else {
      run = 0;
      runBest = null;
    }
  }
  if (!best) return;
  const refs = [...best.refs];
  refs.push('rule:speed');
  const over = Math.round(best.excess);
  addFinding(ctx, {
    actorId: i.a.id,
    severity: 'violation',
    t: tOf(best.k),
    trace: { ...sampleTrace(ctx, i, best.k), limit: best.limit, excess: best.excess, minimumRunFrames: 12 },
    title: `превышение скорости на ${over} км/ч`,
    detail:
      `Скорость ${Math.round(kmh(i.tr.v[best.k]))} км/ч при допустимых ${best.limit} км/ч.`,
    refs,
  });
}

function checkPosition(ctx: Ctx, i: Info): void {
  if (!i.isVeh || i.rail) return;
  let sidewalk = 0;
  let sidewalkK = -1;
  let wrongWay = 0;
  let wrongWayK = -1;
  let tramOnc = 0;
  let tramOncK = -1;
  const oncFrames: number[] = [];
  let center: CenterMarking = 'none';
  let lanes = 1;
  for (let k = i.k0; k <= i.kEnd; k++) {
    const p = posAt(i, k);
    const hits = roadsAt(ctx.geo, p);
    if (hits.length === 0) {
      if (sidewalkAt(ctx.geo, p)) {
        sidewalk++;
        if (sidewalkK < 0) sidewalkK = k;
      }
    } else if (hits.length === 1) {
      const h = hits[0];
      const fwd = dot(fromAngle(i.tr.h[k]), h.near.tangent) >= 0;
      const lane = routeLaneAt(ctx, i, k);
      const routeAdmission = admittedRouteDirection(ctx, i, k);
      if (lane && routeLaneDirectionMatches(lane) && routeAdmission !== false) continue;
      if (h.rg.road.oneWay) {
        if (!fwd && i.tr.v[k] > 0.5) {
          if (lane && lane.lane.direction === 'reverse') {
            oncFrames.push(k);
            center = h.rg.road.center;
            lanes = h.rg.road.lanes;
            continue;
          }
          wrongWay++;
          if (wrongWayK < 0) wrongWayK = k;
        }
      } else if (leftmostLat(i, k, h.near) < -0.15) {
        oncFrames.push(k);
        center = h.rg.road.center;
        lanes = h.rg.road.lanes;
      }
    }
    const tk = trackAt(ctx.geo, p, 1.1);
    if (tk && tk.tg.item.kind !== 'railway' && dot(fromAngle(i.tr.h[k]), tk.near.tangent) < -0.3 && i.tr.v[k] > 0.5) {
      tramOnc++;
      if (tramOncK < 0) tramOncK = k;
    }
  }
  if (sidewalk >= 20) {
    addFinding(ctx, {
      actorId: i.a.id,
      severity: 'violation',
      t: tOf(sidewalkK),
      trace: { durationFrames: sidewalk, thresholdFrames: 20 },
      title: 'движение по тротуару',
      detail: 'Транспортное средство выехало на тротуар.',
      refs: ['pdd:9.9', 'rule:sidewalk'],
    });
  }
  if (wrongWay >= 12) {
    addFinding(ctx, {
      actorId: i.a.id,
      severity: 'violation',
      t: tOf(wrongWayK),
      trace: { durationFrames: wrongWay, thresholdFrames: 12 },
      title: 'движение во встречном направлении по дороге с односторонним движением',
      detail: 'Направление движения противоположно разрешённому на односторонней дороге.',
      refs: ['sign:5.5', 'rule:one-way'],
    });
  }
  if (tramOnc >= 12) {
    addFinding(ctx, {
      actorId: i.a.id,
      severity: 'violation',
      t: tOf(tramOncK),
      trace: { durationFrames: tramOnc, thresholdFrames: 12 },
      title: 'выезд на трамвайные пути встречного направления',
      detail: 'ТС движется по трамвайным путям против их направления.',
      refs: ['pdd:9.6', 'rule:opposing-lane'],
    });
  }
  if (oncFrames.length >= 4) ctx.onc.set(i.a.id, { frames: oncFrames, center, lanes, tramTrack: tramOnc > 0 });
}

function checkLights(ctx: Ctx, i: Info): void {
  for (const g of ctx.gates.filter(x => x.actorId === i.a.id && x.light)) {
    const light = g.light!;
    const t = tOf(g.frame);
    const route = movementFor(ctx, i, g.frame, light);
    const controller = controllerAt(ctx, route.intersection, route.movement?.entryHeading ?? i.tr.h[g.frame]);
    const controlling = controller ?? light;
    const movement = route.movement?.maneuver ?? 'unknown';
    const permission = movementPermission(controlling, { ...i.a, heading: route.movement?.entryHeading ?? i.tr.h[g.frame] }, movement, t);
    if (!permission.regulated && permission.allowed !== false) continue;
    const evidence = ctx.technical.events.find(e => e.actorId === i.a.id && e.kind === 'stop-line' && e.t === t);
    const phase = lightPhase(light, t);
    const prior = ctx.gates.filter(p => p.actorId === i.a.id && p.light && p.frame < g.frame)
      .find(p => p.light !== light && movementPermission(p.light!, { ...i.a, heading: route.movement?.entryHeading ?? i.tr.h[p.frame] }, movement, tOf(p.frame)).allowed === true);
    if (!controller && light.stopLine === false && prior && route.intersection) {
      addFinding(ctx, { actorId: i.a.id, severity: 'info', t, title: 'завершение проезда по разрешённому въезду', detail: 'Выходной сигнал без внутренней стоп-линии не запрещает завершить проезд в намеченном направлении (п. 13.7).', refs: ['pdd:13.7'], trace: { lightId: light.id, entryLightId: prior.light!.id, entryFrame: prior.frame, compliance: 'выполнено' } });
      continue;
    }
    if (permission.allowed === true) {
      addFinding(ctx, { actorId: i.a.id, severity: 'info', t, title: 'проезд при разрешающем сигнале', detail: permission.reason,
        refs: permission.refs, trace: { ...evidence?.trace, permission, compliance: 'выполнено' } });
      continue;
    }
    if (permission.allowed === null) continue;
    let bad = true;
    let note = '';
    // 6.14 concerns the transition to yellow, not a permanently disabled extra section.
    if (!controller && phase === 'yellow' && (!light.kind || light.kind === 'vehicle') && !light.extraSection?.directions.includes(movement as 'straight' | 'right' | 'left' | 'uturn')) {
      const yellow = evidence?.trace.yellow as { frame: number; v0: number; available: number; S: number } | undefined;
      if (yellow) {
        if (yellow.S <= yellow.available) note = ` При включении жёлтого скорость ${Math.round(kmh(yellow.v0))} км/ч, до стоп-линии ${yellow.available.toFixed(0)} м — остановиться служебным торможением было возможно.`;
        else {
          bad = false;
          addFinding(ctx, { actorId: i.a.id, severity: 'info', t, trace: { ...evidence?.trace, compliance: 'выполнено' }, title: 'проезд на жёлтый сигнал', detail: 'Остановиться без экстренного торможения уже было нельзя, поэтому дальнейшее движение допустимо (п. 6.14).', refs: ['pdd:6.14'] });
        }
      }
    }
    if (bad) {
      const finding = addFinding(ctx, { actorId: i.a.id, severity: 'violation', t,
        trace: { ...evidence?.trace, permission, light: controlling },
        title: controlling.kind === 'controller' ? 'не выполнено требование регулировщика' : phase === 'red' ? 'проезд на красный сигнал светофора' : 'проезд при запрещённом направлении или сигнале',
        detail: `${permission.reason}. Скорость ${Math.round(kmh(i.tr.v[g.frame]))} км/ч.${note}`,
        refs: [...permission.refs, 'pdd:6.13', ...(prior && light.stopLine !== false ? ['pdd:13.7'] : []), 'rule:signal'] });
      if (finding.severity === 'violation') {
        const list = ctx.lightViolations.get(i.a.id) ?? [];
        list.push({ light: controlling, frame: g.frame });
        ctx.lightViolations.set(i.a.id, list);
      }
    }
  }
}

function checkSigns(ctx: Ctx, i: Info): void {
  for (const g of ctx.gates.filter((x) => x.actorId === i.a.id && x.sign)) {
    const s = g.sign!;
    const t = tOf(g.frame);
    const route = movementFor(ctx, i, g.frame);
    const controller = controllerAt(ctx, route.intersection, route.movement?.entryHeading ?? i.tr.h[g.frame]);
    if (s.kind === '2.5' && (controller || ctx.scene.lights.some(l => l.kind !== 'reversible' && dist(s, l) <= 30 && Math.abs(angDiff(s.angle, l.angle)) < 0.3 && movementPermission(l, i.a, route.movement?.maneuver ?? 'unknown', t).regulated))) continue;
    if (s.kind === '2.5' || s.kind === '3.17.3') {
      let stopped = false;
      for (let k = g.frame; k >= i.k0 && i.trav[g.frame] - i.trav[k] <= 30; k--) {
        if (i.tr.v[k] < 0.5) {
          stopped = true;
          break;
        }
      }
      if (!stopped) {
        const finding = addFinding(ctx, {
          actorId: i.a.id,
          severity: 'violation',
          t,
          title: 'проезд знака «Движение без остановки запрещено» без остановки',
          detail: `Скорость при пересечении линии — ${Math.round(kmh(i.tr.v[g.frame]))} км/ч, полной остановки не было.`,
          refs: ['sign:2.5', 'rule:sign-requirement'],
        });
        if (finding.severity === 'violation') {
          const list = ctx.stopSkipped.get(i.a.id) ?? [];
          list.push(g.frame);
          ctx.stopSkipped.set(i.a.id, list);
        }
      }
    } else if (s.kind === '3.1') {
      const routeException = routeSignException(ctx, i, s, g.frame);
      if (routeException !== false) {
        addFinding(ctx, { actorId: i.a.id, severity: routeException === true ? 'info' : 'contributing', t,
          title: routeException === true ? 'исключение для маршрутного транспортного средства' : 'применимость запрета к маршрутному ТС не установлена',
          detail: routeException === true ? 'По примечанию группы 3 знак 3.1 не распространяется на установленное маршрутное ТС.'
            : 'Тип автобуса или троллейбуса не доказывает регулярный маршрут по определению 1.2; выполнение регулярной перевозки не задано.',
          refs: ['sign:3.1'], trace: { regularService: i.a.routeContext?.regularService,
            compliance: routeException === true ? 'выполнено' : 'не определить' } });
        continue;
      }
      const onOneWay = roadsAt(ctx.geo, posAt(i, g.frame), 2).some((h) => h.rg.road.oneWay);
      addFinding(ctx, {
        actorId: i.a.id,
        severity: 'violation',
        t,
        title: 'въезд под знак «Въезд запрещён»',
        detail: 'Участок пройден в запрещённом направлении.',
        refs: onOneWay ? ['sign:3.1', 'rule:one-way'] : ['sign:3.1', 'rule:sign-requirement'],
      });
    }
  }
}

/** Пешеход находится в зоне действия знака 5.21 «Жилая зона» (до ближайшего 5.22 в радиусе 150 м). */
function inLivingZone(ctx: Ctx, p: Vec): boolean {
  const near = (kind: string): number =>
    ctx.scene.signs.filter((s) => s.kind === kind).reduce((m, s) => Math.min(m, dist(p, { x: s.x, y: s.y })), Infinity);
  const a = near('5.21');
  return a <= 150 && a < near('5.22');
}

function checkPedestrian(ctx: Ctx, i: Info): void {
  const geo = ctx.geo;
  let wasOn = false;
  for (let k = i.k0; k <= i.kEnd; k++) {
    const p = posAt(i, k);
    const onRoad = roadsAt(geo, p).length > 0;
    if (onRoad && !wasOn && !ctx.pedEntry.has(i.a.id)) {
      const cw = geo.crosswalks.find((c) => pointInObb(p, c.box, 0.6));
      const green = cw ? pedestrianGreen(ctx.scene, cw.item, tOf(k)) : null;
      ctx.pedEntry.set(i.a.id, { frame: k, onCrosswalk: !!cw, pedGreen: green, crosswalkId: cw?.item.id });
      const res = roadsAt(geo, p)[0].rg.road.zone === 'residential' || inLivingZone(ctx, p);
      if (!cw && !res) {
        const nearest = geo.crosswalks.reduce((m, c) => Math.min(m, dist(p, { x: c.item.x, y: c.item.y })), Infinity);
        if (nearest <= 100) {
          addFinding(ctx, {
            actorId: i.a.id,
            severity: 'violation',
            t: tOf(k),
            title: 'переход проезжей части вне пешеходного перехода',
            detail: `Ближайший пешеходный переход находится в ${Math.round(nearest)} м — в зоне видимости.`,
            refs: ['pdd:4.3', 'rule:pedestrian-crossing'],
          });
        } else {
          addFinding(ctx, {
            actorId: i.a.id,
            severity: 'info',
            t: tOf(k),
            title: 'переход вне пешеходного перехода',
            detail: 'Перехода поблизости нет; дорогу нужно пересекать под прямым углом там, где она хорошо просматривается (п. 4.3).',
            refs: ['pdd:4.3'],
          });
        }
      }
      if (cw && green === false) {
        addFinding(ctx, {
          actorId: i.a.id,
          severity: 'violation',
          t: tOf(k),
          title: 'выход на проезжую часть на запрещающий сигнал пешеходного светофора',
          detail: 'Пешеход вступил на переход, когда для него горел красный сигнал.',
          refs: ['pdd:4.4', 'rule:pedestrian-crossing'],
        });
      }
    }
    wasOn = onRoad;
  }
}

// ---------------------------------------------------------------------------
// Техническая возможность предотвратить столкновение

function techText(t: TechAssessment, self: string, otherName: string): string {
  if (t.available < 2) {
    return `${self}: опасность (${otherName}) возникла, когда до места столкновения оставалось менее 2 м, — остановиться было невозможно.`;
  }
  const base =
    `${self}: опасность — с t = ${t.tHazard.toFixed(1)} с (${otherName}), скорость ${Math.round(t.speedKmh)} км/ч, до места удара ${t.available.toFixed(0)} м, ` +
    `остановочный путь ${t.stopDist.toFixed(0)} м. `;
  return (
    base +
    (t.avoidable
      ? 'Остановиться до места столкновения было возможно.'
      : `Остановиться до места столкновения не удавалось (безопасная скорость в этой ситуации — не более ${Math.floor(t.safeKmh)} км/ч).`)
  );
}

function analyzeCollisions(ctx: Ctx): CollisionReport[] {
  const reports: CollisionReport[] = [];
  const geo = ctx.geo;

  for (const col of ctx.tl.collisions) {
    const A = ctx.infos.get(col.a)!;
    const Bi = ctx.infos.get(col.b) ?? null;
    const notes: string[] = [];
    const tech: TechAssessment[] = [];
    const frame = col.frame;
    const kp = Math.max(0, frame - 1);
    const t = col.t;
    const impactKmh = Math.round(kmh(col.rel));
    let title = '';
    let description = '';

    const addTech = (v: Info, otherId: string) => {
      const source = ctx.technical.collisions.find(c => c.collision.frame === frame && c.collision.a === col.a && c.collision.b === col.b);
      const original = source?.tech.find(t => t.actorId === v.a.id && t.otherId === otherId);
      const r = original ? structuredClone(original) : null;
      if (r) {
        const lim = speedLimitAt(ctx, v, Math.round(r.tHazard / DT));
        if (lim && r.speedKmh > lim.limit) {
          const vl = lim.limit / 3.6;
          const counterfactual = stoppingCalculation(vl, v.brake, r.available);
          const stopAtLimit = counterfactual.S;
          r.limitKmh = lim.limit;
          r.avoidableAtLimit = stopAtLimit <= r.available;
          r.trace = { ...r.trace, limitKmh: lim.limit, stopAtLimit, avoidableAtLimit: r.avoidableAtLimit, counterfactual };
        }
      }
      if (r) tech.push(r);
      return r;
    };

    // ---- наезд на препятствие
    if (col.kind === 'vo') {
      const ob = geo.obstacles.find((x) => x.item.id === col.b)!;
      title = 'Наезд на препятствие';
      description = `${A.label} столкнулся с препятствием (${obstacleName(ob.item.kind)}) на скорости около ${impactKmh} км/ч.`;
      if (A.a.railwayTrain) {
        const assessment = addTech(A, col.b);
        if (assessment) notes.push(techText(assessment, A.label, obstacleName(ob.item.kind)));
        notes.push('Для поезда приведён технический расчёт по заданным параметрам. Причина столкновения и обязанности машиниста по дорожным правилам не устанавливаются.');
        reports.push(finishCollision(ctx, col, title, description, tech, notes));
        continue;
      }
      const onRoad = roadsAt(geo, posAt(A, kp), 1).length > 0;
      const tr = addTech(A, col.b);
      if (!onRoad) {
        if (!ctx.findings.some((f) => f.actorId === A.a.id && f.refs.includes('pdd:9.9'))) {
          addFinding(ctx, {
            actorId: A.a.id,
            severity: 'violation',
            t,
            causal: true,
            title: 'выезд за пределы проезжей части',
            detail: 'Транспортное средство покинуло проезжую часть и столкнулось с препятствием.',
            refs: ['pdd:9.9', 'pdd:10.1'],
          });
        } else markCausal(ctx, A.a.id);
      } else {
        addFinding(ctx, {
          actorId: A.a.id,
          severity: 'violation',
          t,
          causal: true,
          title: 'наезд на препятствие',
          detail: `Водитель не выбрал скорость, позволяющую контролировать движение${tr ? (tr.avoidable ? ' и имел возможность остановиться' : '') : ''}.`,
          refs: ['pdd:10.1'],
        });
      }
      reports.push(finishCollision(ctx, col, title, description, tech, notes));
      ctx.events.push({ t, text: `${A.label} — наезд на препятствие, ~${impactKmh} км/ч` });
      continue;
    }

    const B = Bi!;

    // ---- наезд на пешехода
    if (col.kind === 'vp') {
      const veh = A.isVeh ? A : B;
      const ped = A.isVeh ? B : A;
      title = 'Наезд на пешехода';
      description = `${veh.label} сбил(а) ${ped.label.toLowerCase()} на скорости около ${Math.round(kmh(len2(col.vA, col.vB)))} км/ч.`;
      const pPos = posAt(ped, kp);
      const cw = geo.crosswalks.find((c) => pointInObb(pPos, c.box, 0.6));
      const entry = ctx.pedEntry.get(ped.a.id);
      const road = roadsAt(geo, pPos, 1)[0];
      const resZone = road?.rg.road.zone === 'residential';
      const tr = addTech(veh, ped.a.id);
      if (veh.a.railwayTrain) {
        if (tr) notes.push(techText(tr, veh.label, ped.label));
        notes.push('Железнодорожный состав не получает обязанности водителя дорожного ТС по разделам 13–14 ПДД. Условия появления человека на путях и причины наезда требуют отдельных исходных данных.');
        reports.push(finishCollision(ctx, col, title, description, tech, notes));
        continue;
      }
      const onSidewalk = !road && !!sidewalkAt(geo, pPos);
      let driverBlamed = false;

      const turnDuty = turningVulnerablePriority(ctx, veh.a.id, ped.a.id, col.point);
      if (turnDuty) {
        addFinding(ctx, { actorId: veh.a.id, severity: 'violation', t, causal: true, title: 'не уступил пересекающему дорогу при повороте', detail: turnDuty.explain, refs: turnDuty.refs, trace: turnDuty.trace });
        driverBlamed = true;
      } else if (onSidewalk) {
        if (!ctx.findings.some((f) => f.actorId === veh.a.id && f.refs.includes('pdd:9.9'))) {
          addFinding(ctx, { actorId: veh.a.id, severity: 'violation', t, causal: true, title: 'наезд на пешехода на тротуаре', detail: 'ТС выехало на тротуар.', refs: ['pdd:9.9', 'rule:sidewalk'] });
        } else markCausal(ctx, veh.a.id);
        driverBlamed = true;
      } else if (cw || resZone) {
        const pedRed = entry?.pedGreen === false;
        if (cw?.item.lightId && pedRed) {
          description += ' Пешеход вступил на переход на запрещающий для него сигнал.';
          markCausal(ctx, ped.a.id);
          notes.push('Пешеход начал переход на красный сигнал (п. 4.4). Водитель при этом остаётся обязанным принять меры к остановке, если опасность можно было обнаружить (п. 10.1).');
          if (tr?.avoidable) {
            addFinding(ctx, { actorId: veh.a.id, severity: 'violation', t, causal: true, title: 'не принял мер к остановке перед пешеходом', detail: 'Опасность была заметна заранее, остановиться было возможно.', refs: ['pdd:10.1'] });
            driverBlamed = true;
          } else {
            notes.push('Технической возможности остановиться у водителя не было — причиной ДТП стало нарушение пешехода.');
          }
        } else if (cw?.item.lightId) {
          // зелёный для пешехода — водитель поехал на красный или не уступил завершающим переход
          if (!ctx.findings.some((f) => f.actorId === veh.a.id && f.causal && f.refs.includes('rule:signal'))) {
            addFinding(ctx, { actorId: veh.a.id, severity: 'violation', t, causal: true, title: 'не уступил пешеходу на регулируемом переходе', detail: 'Пешеход шёл на разрешающий сигнал или заканчивал переход.', refs: ['pdd:14.3', 'pdd:13.8', 'rule:pedestrian-priority'] });
          } else markCausal(ctx, veh.a.id);
          driverBlamed = true;
        } else if (!tr || tr.avoidable) {
          addFinding(ctx, {
            actorId: veh.a.id,
            severity: 'violation',
            t,
            causal: true,
            title: resZone && !cw ? 'не уступил пешеходу в жилой зоне' : 'не уступил пешеходу на нерегулируемом переходе',
            detail: 'Пешеход находился на проезжей части в зоне, где имеет преимущество; водитель успевал остановиться.',
            refs: resZone && !cw ? ['pdd:17.1', 'pdd:10.1'] : ['pdd:14.1', 'pdd:10.1', 'rule:pedestrian-priority'],
          });
          driverBlamed = true;
        } else if (!cw) {
          notes.push('В жилой зоне пешеходы имеют преимущество на всей проезжей части (п. 17.1), поэтому вины пешехода здесь нет. Остановиться при такой скорости водитель не успевал; при допустимых 20 км/ч наезда, как правило, удаётся избежать.');
        } else {
          notes.push('Пешеход находился на переходе, но вышел на проезжую часть слишком близко к ТС: остановиться до места наезда водитель технически не мог. Пешеход нарушил п. 4.5 (не оценил расстояние и скорость).');
          addFinding(ctx, { actorId: ped.a.id, severity: 'violation', t, causal: true, title: 'выход на проезжую часть перед близко идущим ТС', detail: 'Пешеход не оценил расстояние до приближающегося автомобиля и его скорость.', refs: ['pdd:4.5', 'rule:pedestrian-crossing'] });
        }
        // остановившееся рядом ТС (п. 14.2)
        if (cw && driverBlamed) {
          const halted = [...ctx.infos.values()].find(
            (o) =>
              o.isVeh &&
              o !== veh &&
              o.tr.v[kp] < 1 &&
              Math.abs(angDiff(o.tr.h[kp], veh.tr.h[kp])) < 0.5 &&
              dist(posAt(o, kp), { x: cw.item.x, y: cw.item.y }) < 25,
          );
          if (halted) {
            addFinding(ctx, { actorId: veh.a.id, severity: 'violation', t, causal: true, title: `продолжил движение, хотя ${halted.label} остановилось перед переходом`, detail: 'Остановившееся рядом ТС закрывало обзор — следовало остановиться и убедиться в отсутствии пешеходов.', refs: ['pdd:14.2'] });
          }
        }
      } else {
        // вне перехода
        if (entry && !entry.onCrosswalk) markCausal(ctx, ped.a.id);
        if (tr?.avoidable) {
          addFinding(ctx, { actorId: veh.a.id, severity: 'violation', t, causal: true, title: 'не принял мер к остановке при обнаружении пешехода', detail: 'Пешеход был виден заранее, остановиться до места наезда успевали.', refs: ['pdd:10.1'] });
          driverBlamed = true;
          notes.push('Пешеход нарушил правила перехода, но и водитель мог предотвратить наезд — возможна обоюдная ответственность.');
        } else {
          notes.push('Пешеход вышел на проезжую часть вне перехода; у водителя не было технической возможности остановиться. Причинная связь с действиями водителя не установлена.');
          if (tr?.avoidableAtLimit && ctx.findings.some(f => f.actorId === veh.a.id && f.severity === 'violation' && f.refs.includes('rule:speed'))) {
            notes.push('При скорости в пределах допустимой наезда удалось бы избежать — превышение скорости находится в причинной связи.');
          }
        }
      }
      if (tr) notes.unshift(techText(tr, veh.label, ped.label));
      reports.push(finishCollision(ctx, col, title, description, tech, notes));
      ctx.events.push({ t, text: `${veh.label} сбил(а) ${ped.label.toLowerCase()}, ~${Math.round(kmh(len2(col.vA, col.vB)))} км/ч` });
      continue;
    }

    // ---- столкновение двух ТС
    const dh = Math.abs(angDiff(A.tr.h[kp], B.tr.h[kp]));
    const rA = regionOf(A, frame, col.point);
    const rB = regionOf(B, frame, col.point);
    const atInter = !!intersectionAt(geo, col.point);
    const trA = addTech(A, B.a.id);
    const trB = addTech(B, A.a.id);
    if (A.a.railwayTrain && B.a.railwayTrain) {
      title = 'Столкновение поездов';
      description = `${A.label} и ${B.label} столкнулись на железнодорожных путях.`;
      notes.push('Правила очерёдности дорожных ТС к двум железнодорожным составам не применяются; приведены заданные параметры и технический расчёт.');
      reports.push(finishCollision(ctx, col, title, description, tech, notes));
      continue;
    }

    const railway = railwayPriority(ctx, A.a.id, B.a.id, col);
    const special = specialPriority(ctx, A.a.id, B.a.id, kp);
    const movingSpecial = blueBeacon(A.a) && A.tr.v[kp] > 0.1 || blueBeacon(B.a) && B.tr.v[kp] > 0.1;
    const specialState = movingSpecial ? specialPairState(A.a, B.a) : 'none';
    const routeTransport = routePriority(ctx, A.a.id, B.a.id, col);
    const turnDuty = turningVulnerablePriority(ctx, A.a.id, B.a.id, col.point);
    const maneuverDuty = maneuverPriority(ctx, A.a.id, B.a.id, col);
    if (!railway && (special || specialState === 'both' || specialState === 'unknown') && dh < 0.7
      && ((rA === 'front' && rB === 'rear') || (rB === 'front' && rA === 'rear'))) {
      const rear = rA === 'front' ? A : B, leader = rear === A ? B : A;
      const first = Math.max(rear.k0, leader.k0, kp - Math.ceil(1 / DT));
      const stableLeader = Array.from({ length: kp - first + 1 }, (_, index) => first + index).every(k => {
        const local = toLocal(posAt(leader, k), { cx: rear.tr.x[k], cy: rear.tr.y[k], a: rear.tr.h[k] });
        return leader.tr.v[k] < 0.1 && local.x > 0 && Math.abs(local.y) < rear.hw + leader.hw;
      });
      // Blue lights do not establish the stopped leading driver's ability to
      // clear a lane. Preserve the independently observed rear driver's unsafe
      // movement; the separate 3.1/3.2 analysis cannot erase this contact.
      if (stableLeader && rear.tr.v[kp] > 0.1 && !rear.tr.reversing?.[kp]) addFinding(ctx, {
        actorId: rear.a.id, severity: 'violation', causal: true, t,
        title: 'не обеспечено безопасное приближение к стоящему впереди ТС',
        detail: 'Движущийся участник въехал передней частью в заднюю часть ТС, неподвижного в том же ряду. Специальные сигналы не устраняют требование безопасности; возможность впереди стоящего водителя освободить полосу отдельно не установлена.',
        refs: ['pdd:9.10', 'pdd:10.1', 'rule:spacing'],
        trace: { collisionFrame: frame, otherActorId: leader.a.id, stationaryLeaderObservationSeconds: (kp - first) * DT,
          independentSafetyAssessment: true } });
    }
    if (railway) {
      title = 'Столкновение с поездом';
      description = `${A.label} и ${B.label} столкнулись на железнодорожных путях, скорость сближения около ${impactKmh} км/ч.`;
      notes.push(railway.explain);
      if (railway.failureEstablished) {
        addFinding(ctx, { actorId: railway.from, severity: 'violation', t, causal: true,
          title: 'не уступил дорогу поезду', detail: railway.explain, refs: railway.refs, trace: railway.trace });
        for (const finding of ctx.findings) if (finding.actorId === railway.from && finding.refs.includes('rule:railway-prohibited-entry')) finding.causal = true;
      } else {
        addFinding(ctx, { actorId: railway.from, severity: 'contributing', t,
          title: 'данных о причине остановки или пересечении путей недостаточно', detail: railway.explain,
          refs: ['pdd:15.1'], trace: { ...railway.trace, compliance: 'не определить' } });
      }
      for (const [i, assessment] of [[A, trA], [B, trB]] as const) if (assessment) notes.push(techText(assessment, i.label, i === A ? B.label : A.label));
    } else if (special) {
      title = 'Столкновение при приближении спецтранспорта';
      description = special.explain;
      notes.push(special.explain);
      notes.push('Обязанность уступить по п. 3.2 и условия использования приоритета по п. 3.1 оцениваются отдельно; специальные сигналы не исключают нарушения у обоих водителей.');
      for (const [i, assessment] of [[A, trA], [B, trB]] as const) if (assessment) notes.push(techText(assessment, i.label, i === A ? B.label : A.label));
    } else if (specialState === 'both' || specialState === 'unknown') {
      title = 'Столкновение с неопределёнными условиями специального приоритета';
      description = specialState === 'both' ? 'Специальные сигналы обоих участников не определяют преимущество одного перед другим.'
        : 'Включение специального звукового сигнала не установлено; очередность с учётом п. 3.2 определить нельзя.';
      notes.push(description);
    } else if (routeTransport) {
      title = routeTransport.refs.includes('pdd:18.3') ? 'Столкновение при выезде автобуса или троллейбуса от остановки' : 'Столкновение с трамваем вне перекрёстка';
      description = routeTransport.explain;
      notes.push(routeTransport.explain);
      addFinding(ctx, { actorId: routeTransport.from, severity: routeTransport.failureEstablished ? 'violation' : 'contributing',
        t, causal: routeTransport.failureEstablished, title: routeTransport.failureEstablished ? 'не предоставлено установленное преимущество по разделу 18' : 'данных об установленном преимуществе недостаточно',
        detail: routeTransport.explain, refs: routeTransport.failureEstablished ? routeTransport.refs : routeTransport.refs.filter(ref => !ref.startsWith('rule:')),
        trace: { ...routeTransport.trace, compliance: 'не определить' } });
      for (const [i, assessment] of [[A, trA], [B, trB]] as const) if (assessment) notes.push(techText(assessment, i.label, i === A ? B.label : A.label));
    } else if (turnDuty) {
      title = 'Столкновение при повороте с пересекающим дорогу велосипедистом';
      description = turnDuty.explain;
      addFinding(ctx, { actorId: turnDuty.from, severity: 'violation', t, causal: true, title: 'не уступил пересекающему дорогу при повороте', detail: turnDuty.explain, refs: turnDuty.refs, trace: turnDuty.trace });
    } else if (atInter) {
      title = 'Столкновение на перекрёстке';
      description = `${A.label} и ${B.label} столкнулись на пересечении дорог, скорость сближения около ${impactKmh} км/ч.`;
      const decision = graphPriority(ctx, A.a.id, B.a.id, col.point, frame);
      const relation = decision.edge;
      if (decision.cycle) {
        notes.push('Водители договариваются, см. п. 13.11 и 1.5. Цикл уступания не определяет нарушителя.');
      } else if (relation) {
        const Y = ctx.infos.get(relation.from)!;
        const P = ctx.infos.get(relation.to)!;
        notes.push(relation.explain);
        if (relation.refs.includes('rule:signal')) {
          for (const f of ctx.findings) if (f.actorId === Y.a.id && f.refs.includes('rule:signal')) f.causal = true;
        } else {
          addFinding(ctx, { actorId: Y.a.id, severity: 'violation', t, causal: true, title: 'не уступил дорогу участнику, имеющему преимущество', detail: relation.explain, refs: relation.refs, trace: { ...relation.trace, priorityGraph: decision.graph?.trace } });
        }
        const trP = P === A ? trA : trB;
        if (trP) notes.push(techText(trP, P.label, Y.label));
      } else {
        notes.push('Очерёдность по наблюдавшимся сигналам и траекториям однозначно не определена.');
        for (const i of [A, B]) addFinding(ctx, { actorId: i.a.id, severity: 'contributing', t, title: 'недостаточно данных об очерёдности проезда', detail: 'Граф приоритета не устанавливает однозначной обязанности уступить; нарушение приоритета не назначается.', refs: ['pdd:1.5'] });
      }
    } else if (maneuverDuty) {
      title = 'Столкновение при манёвре';
      description = maneuverDuty.explain;
      notes.push(maneuverDuty.explain);
      if (!ctx.findings.some(f => f.actorId === maneuverDuty.from && f.causal && f.refs.some(ref => maneuverDuty.refs.includes(ref)))) {
        addFinding(ctx, { actorId: maneuverDuty.from, severity: 'violation', causal: true, t, title: 'манёвр создал помеху имеющему преимущество', detail: maneuverDuty.explain, refs: maneuverDuty.refs, trace: maneuverDuty.trace });
      }
    } else if (dh < 0.7 && ((rA === 'front' && rB === 'rear') || (rB === 'front' && rA === 'rear'))) {
      // ---- попутное, наезд сзади
      const R = rA === 'front' ? A : B;
      const L = R === A ? B : A;
      const trR = R === A ? trA : trB;
      title = 'Попутное столкновение (наезд сзади)';
      description = `${R.label} въехал в заднюю часть ${L.label}. Скорость сближения около ${impactKmh} км/ч.`;
      addFinding(ctx, {
        actorId: R.a.id,
        severity: 'violation',
        t,
        causal: true,
        title: 'не соблюдал дистанцию до впереди идущего ТС',
        detail: `Дистанция не позволила избежать столкновения${trR ? (trR.avoidable ? '; остановиться перед ТС впереди было возможно' : '') : ''}.`,
        refs: ['pdd:9.10', 'pdd:10.1', 'rule:spacing'],
      });
      if (trR && !trR.avoidable && ctx.tl.mu < 0.5) {
        notes.push(`Скорость не соответствовала дорожным условиям (${SURFACES[ctx.scene.env.surface].name.toLowerCase()}): остановочный путь больше расстояния до препятствия (п. 10.1).`);
      }
      // необоснованное торможение лидера
      const decel = (L.tr.v[Math.max(L.k0, kp - 80)] - L.tr.v[kp]) / (80 * DT);
      if (decel > 4 && !reasonToBrake(ctx, L, kp)) {
        addFinding(ctx, {
          actorId: L.a.id,
          severity: 'contributing',
          t,
          causal: true,
          title: 'резкое торможение без видимой причины',
          detail: 'Впереди идущее ТС затормозило с замедлением более 4 м/с², хотя причин для экстренной остановки по обстановке нет.',
          refs: ['pdd:10.5'],
        });
        notes.push('Водитель впереди идущего ТС мог нарушить п. 10.5, но водитель сзади всё равно обязан выдерживать безопасную дистанцию.');
      }
    } else if (dh > 2.4) {
      // ---- встречное
      title = 'Встречное столкновение';
      description = `Лобовое/встречное столкновение ${A.label} и ${B.label}, скорость сближения около ${impactKmh} км/ч.`;
      const wrong = (i: Info) => {
        const w = ctx.onc.get(i.a.id);
        return w && w.frames.some((f) => f >= frame - 80 && f <= frame) ? w : null;
      };
      const wa = wrong(A);
      const wb = wrong(B);
      const blame = (i: Info, w: NonNullable<ReturnType<typeof wrong>>) => {
        const solid = w.center === 'solid' || w.center === 'double';
        const refs = solid ? ['pdd:9.1(1)'] : ['pdd:9.1', 'pdd:9.4', 'pdd:11.1'];
        if (w.lanes >= 2) refs.push('pdd:9.2');
        if (w.tramTrack) refs.push('pdd:9.6');
        refs.push('rule:opposing-lane');
        addFinding(ctx, {
          actorId: i.a.id,
          severity: 'violation',
          t,
          causal: true,
          title: 'выезд на полосу встречного движения',
          detail: solid ? 'Пересечена сплошная линия разметки, разделяющая потоки противоположных направлений.' : 'Выезд на встречную сторону проезжей части создал помеху встречному ТС.',
          refs,
        });
      };
      if (wa) blame(A, wa);
      if (wb) blame(B, wb);
      if (!wa && !wb) {
        notes.push('По заданной геометрии ни один из участников не пересекал ось дороги: определить, кто выехал на встречную сторону, нельзя (проверьте положение ТС и разметку).');
        for (const i of [A, B]) {
          addFinding(ctx, { actorId: i.a.id, severity: 'contributing', t, title: 'не обеспечил безопасный боковой интервал', detail: 'Столкновение на встречных курсах без явного выезда одного из участников.', refs: ['pdd:9.10', 'pdd:1.5'] });
        }
      }
      for (const [i, r] of [[A, trA], [B, trB]] as const) {
        const w = i === A ? wa : wb;
        if (r && !w) {
          notes.push(techText(r, i.label, (i === A ? B : A).label));
          if (r.avoidable) {
            addFinding(ctx, { actorId: i.a.id, severity: 'contributing', t, causal: false, title: 'имел возможность избежать столкновения торможением', detail: 'Опасность была заметна заранее (п. 10.1, ч. 2).', refs: ['pdd:10.1'] });
          }
        }
      }
    } else {
      // ---- вне перекрёстка: перестроение, выезд с территории, поворот
      title = dh < 0.7 ? 'Попутное боковое столкновение' : 'Столкновение при манёвре';
      description = `${A.label} и ${B.label} столкнулись вне перекрёстка, скорость сближения около ${impactKmh} км/ч.`;
      const startOff = (i: Info) => roadsAt(geo, posAt(i, i.k0), 0.5).length === 0;
      const onNow = (i: Info) => roadsAt(geo, posAt(i, kp), 1).length > 0;
      let Y: Info | null = null;
      let reasonRefs: string[] = [];
      let why = '';
      if (startOff(A) !== startOff(B) && onNow(A) && onNow(B)) {
        Y = startOff(A) ? A : B;
        reasonRefs = ['pdd:8.3', 'rule:maneuver-priority'];
        why = `${Y.label} выезжал с прилегающей территории и обязан был уступить дорогу.`;
      } else {
        // манёвр: на сколько курс ушёл от оси дороги по сравнению с началом последних 2 с (кривизна дороги не в счёт)
        const devOver = (i: Info): number | null => {
          const k0 = Math.max(i.k0, kp - 80);
          const signed = (k: number): number | null => {
            const hits = roadsAt(geo, posAt(i, k), 1);
            return hits.length ? angDiff(angleOf(hits[0].near.tangent), i.tr.h[k]) : null;
          };
          const base = signed(k0);
          if (base === null) return null;
          let m = 0;
          for (let k = k0; k <= kp; k += 5) {
            const d = signed(k);
            if (d !== null) m = Math.max(m, Math.abs(angDiff(base, d)));
          }
          return m;
        };
        const dA = devOver(A);
        const dB = devOver(B);
        const a2 = dA ?? 0;
        const b2 = dB ?? 0;
        if (Math.max(a2, b2) > 0.12 && Math.abs(a2 - b2) > 0.08) {
          Y = a2 > b2 ? A : B;
          if (dh < 0.7) {
            reasonRefs = ['pdd:8.4', 'pdd:8.1', 'rule:maneuver-priority'];
            why = `${Y.label} менял полосу/смещался в сторону и должен был уступить попутному ТС.`;
          } else {
            reasonRefs = ['pdd:8.8', 'pdd:8.1', 'rule:maneuver-priority'];
            why = `${Y.label} выполнял поворот или разворот вне перекрёстка и должен был уступить дорогу.`;
          }
        }
      }
      if (Y) {
        notes.push(why);
        addFinding(ctx, { actorId: Y.a.id, severity: 'violation', t, causal: true, title: 'манёвр, создавший помеху другому ТС', detail: why, refs: reasonRefs });
        const P = Y === A ? B : A;
        const trP = P === A ? trA : trB;
        if (trP) notes.push(techText(trP, P.label, Y.label));
      } else {
        notes.push('Кто именно совершал манёвр, по траекториям определить не удаётся: оба водителя обязаны были выдерживать боковой интервал.');
        for (const i of [A, B]) {
          addFinding(ctx, { actorId: i.a.id, severity: 'contributing', t, title: 'не выдержал боковой интервал', detail: 'Безопасный боковой интервал не был соблюдён.', refs: ['pdd:9.10', 'pdd:1.5'] });
        }
      }
    }

    // нарушения, допущенные раньше (разметка, знак) и приведшие к ДТП
    for (const i of [A, B]) {
      for (const f of ctx.findings) {
        if (f.actorId === i.a.id && f.severity === 'violation' && !f.causal && f.t !== undefined && f.t <= t && t - f.t < 6 && f.refs.some((r) => ['rule:signal', 'rule:opposing-lane', 'rule:one-way', 'rule:sign-requirement', 'rule:turn-sign', 'rule:sidewalk', 'rule:nonmotor-road'].includes(r))) {
          f.causal = true;
        }
      }
    }
    // груз, выступающий за габариты ТС, участвовал в контакте
    for (const i of [A, Bi]) {
      if (!i || i.a.railwayTrain || !i.a.cargo || !cargoInvolved(i, boxAt, kp, col.point)) continue;
      notes.push(`${i.label}: удар пришёлся на груз, выступающий за габариты ТС (п. 23.1–23.4 ПДД).`);
      for (const f of ctx.findings) {
        if (f.actorId === i.a.id && f.severity === 'violation' && !f.causal && f.refs.some((r) => r.startsWith('pdd:23.'))) f.causal = true;
      }
    }
    reports.push(finishCollision(ctx, col, title, description, tech, notes));
    ctx.events.push({ t, text: `Столкновение ${A.label} и ${B.label}, скорость сближения ~${impactKmh} км/ч` });
  }
  return reports;
}

function len2(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function obstacleName(k: string): string {
  return { building: 'здание', fence: 'ограждение', tree: 'дерево', barrier: 'барьер' }[k] ?? 'препятствие';
}

function markCausal(ctx: Ctx, actorId: string): void {
  for (const f of ctx.findings) if (f.actorId === actorId && f.severity === 'violation') f.causal = true;
}

function reasonToBrake(ctx: Ctx, i: Info, k: number): boolean {
  const f = fromAngle(i.tr.h[k]);
  const p = posAt(i, k);
  const ahead = (q: Vec, maxDist: number, lat = i.hw + 1.2): boolean => {
    const l = toLocal(q, { cx: p.x, cy: p.y, a: i.tr.h[k] });
    return l.x > 0 && l.x < maxDist && Math.abs(l.y) < lat;
  };
  for (const lg of ctx.geo.lights) {
    const mid = { x: (lg.line.a.x + lg.line.b.x) / 2, y: (lg.line.a.y + lg.line.b.y) / 2 };
    if (dot(f, fromAngle(lg.light.angle)) > 0.5 && ahead(mid, 45, 8)) {
      const route = movementFor(ctx, i, k, lg.light);
      const controller = controllerAt(ctx, route.intersection, route.movement?.entryHeading ?? i.tr.h[k]);
      if (movementPermission(controller ?? lg.light, { ...i.a, heading: route.movement?.entryHeading ?? i.tr.h[k] }, route.movement?.maneuver ?? 'unknown', tOf(k)).allowed === false) return true;
    }
  }
  for (const o of ctx.infos.values()) {
    if (o === i || !o.tr.present[k]) continue;
    if (ahead(posAt(o, k), o.isVeh ? 30 : 35)) return true;
  }
  for (const ob of ctx.geo.obstacles) if (ahead({ x: ob.box.cx, y: ob.box.cy }, 30)) return true;
  for (const sg of ctx.geo.signs) {
    if ((sg.sign.kind === '2.5' || sg.sign.kind === '3.17.3') && dot(f, fromAngle(sg.sign.angle)) > 0.5 && ahead(sg.gate.b, 30, 10)) return true;
  }
  return false;
}

function finishCollision(ctx: Ctx, col: Collision, title: string, description: string, tech: TechAssessment[], notes: string[]): CollisionReport {
  const source = ctx.technical.collisions.find(c => c.collision.frame === col.frame && c.collision.a === col.a && c.collision.b === col.b)!;
  return { collision: col, title, description, harm: source.harm, tech, notes, trace: source.trace };
}

// ---------------------------------------------------------------------------
// Околосвязанные проверки

function nearMisses(ctx: Ctx): void {
  for (const event of ctx.technical.nearMisses) {
    const A = ctx.infos.get(event.a)!;
    const B = ctx.infos.get(event.b)!;
    ctx.events.push({ t: event.t, text: `Опасное сближение ${A.label} и ${B.label}: просвет ${event.gap.toFixed(1)} м` });
    for (const i of [A, B].filter(i => !i.a.railwayTrain)) ctx.findings.push({ actorId: i.a.id, severity: 'info', t: event.t, causal: false,
      title: `опасное сближение с ${(i === A ? B : A).label}`,
      detail: `Минимальный просвет между кузовами — ${event.gap.toFixed(1)} м. Столкновения не произошло.`,
      refs: ['pdd:9.10'], trace: event.trace });
  }
}

function missedWrongSide(ctx: Ctx): void {
  // выезд на встречную без столкновения
  for (const [id, w] of ctx.onc) {
    const i = ctx.infos.get(id)!;
    const already = ctx.findings.some((f) => f.actorId === id && f.refs.includes('rule:opposing-lane'));
    if (already) continue;
    const t = tOf(w.frames[0]);
    if (w.center === 'solid' || w.center === 'double') {
      const refs = ['pdd:9.1(1)'];
      if (w.lanes >= 2) refs.push('pdd:9.2');
      refs.push('rule:opposing-lane');
      addFinding(ctx, {
        actorId: id,
        severity: 'violation',
        t,
        title: 'пересечение сплошной линии разметки / выезд на встречную полосу',
        detail: 'Разметка 1.1/1.3 запрещает пересекать линию и выезжать на сторону встречного движения.',
        refs,
      });
    } else {
      ctx.findings.push({
        actorId: id,
        severity: 'info',
        causal: false,
        t,
        title: 'выезд на полосу встречного движения',
        detail: 'Разметка допускает пересечение, но манёвр разрешён только если он безопасен и не создаёт помех встречным ТС (п. 11.1).',
        refs: ['pdd:11.1'],
      });
    }
    void i;
  }
}

// ---------------------------------------------------------------------------
// Правовая оценка


export function analyzeRules(technical: TechnicalContext): { ctx: Ctx; section: RulesSection; events: { t: number; text: string }[] } {
  const ctx: Ctx = { ...technical, gates: technical.gates.map(g => ({ ...g })), findings: [], events: [], priorityGraphs: [], onc: new Map(), lightViolations: new Map(), stopSkipped: new Map(), pedEntry: new Map() };
  computeGateEnds(ctx);
  for (const i of ctx.infos.values()) {
    if (i.isVeh && !i.a.railwayTrain) {
      checkSpeed(ctx, i);
      checkPosition(ctx, i);
      checkLights(ctx, i);
      checkSigns(ctx, i);
    } else if (!i.isVeh) {
      checkPedestrian(ctx, i);
    }
  }
  ctx.priorityGraphs = buildPriorityGraphs(ctx);
  checkIntersectionObservations(ctx, f => addFinding(ctx, f));
  checkSpecialSignals(ctx, f => addFinding(ctx, f));
  checkRouteTransport(ctx, f => addFinding(ctx, f));
  checkPassengers(ctx, f => addFinding(ctx, f));
  checkManeuvers(ctx, f => addFinding(ctx, f));
  checkRailway(ctx, f => addFinding(ctx, f));
  const addRequirement = (finding: FindingInput) => {
    const directional = finding.refs.some(ref => /^sign:(?:3\.18\.[12]|3\.19|4\.1\.[1-6])$/.test(ref) || ref === 'marking:1.18');
    if (directional) {
      const i = ctx.infos.get(finding.actorId)!;
      const frame = Math.min(ctx.tl.n - 1, Math.max(i.k0, Math.round((finding.t ?? 0) / DT)));
      const route = movementFor(ctx, i, frame);
      const controller = controllerAt(ctx, route.intersection, route.movement?.entryHeading ?? i.tr.h[frame]);
      if (controller && route.movement) {
        const permission = movementPermission(controller, { ...i.a, heading: route.movement.entryHeading }, route.movement.maneuver, tOf(frame));
        if (permission.allowed === true) {
          return addFinding(ctx, { actorId: finding.actorId, severity: 'info', t: finding.t, title: 'направление движения определено жестом регулировщика',
            detail: 'Разрешённый жест регулировщика имеет преимущество перед противоречащим ему требованием направления движения (п. 6.15).',
            refs: [...permission.refs, 'pdd:6.15'], trace: { controllerId: controller.id, overriddenRequirement: finding.refs, intendedManeuver: route.movement.maneuver, compliance: 'выполнено' } });
        }
      }
    }
    return addFinding(ctx, finding);
  };
  const kit: Kit = { add: addRequirement, reasonToBrake, boxAt, posAt };
  checkSignRules(ctx, kit);
  checkMarkingRules(ctx, kit);
  checkCargoRules(ctx, kit);
  const collisions = analyzeCollisions(ctx);
  nearMisses(ctx);
  missedWrongSide(ctx);

  // скорость — причина, если при допустимой скорости столкновения удалось бы избежать
  for (const r of collisions) {
    for (const t of r.tech) {
      if (t.avoidableAtLimit && !t.avoidable && ctx.findings.some(f => f.actorId === t.actorId && f.severity === 'violation' && f.refs.includes('rule:speed'))) {
        for (const f of ctx.findings) {
          if (f.actorId === t.actorId && f.severity === 'violation' && f.refs.some((x) => x === 'rule:speed')) f.causal = true;
        }
        r.notes.push(`${ctx.infos.get(t.actorId)!.label}: при допустимой скорости (${t.limitKmh} км/ч) остановиться до места столкновения удавалось бы — превышение скорости находится в причинной связи с ДТП.`);
      }
    }
  }


  const findings: Finding[] = ctx.findings.map(f => {
    const i = ctx.infos.get(f.actorId)!;
    const frame = Math.round((f.t ?? tOf(i.k0)) / DT);
    const refs = f.refs.filter(r => !r.startsWith('rule:'));
    const assessments = collisions.flatMap(c => c.tech.filter(t => t.actorId === f.actorId));
    const speedAssessment = f.refs.includes('rule:speed') ? assessments.find(t => t.avoidableAtLimit !== undefined) : undefined;
    const prevention = speedAssessment ? !!speedAssessment.avoidableAtLimit : f.causal && f.refs.includes('pdd:10.1') && assessments.some(t => t.avoidable) ? true : null;
    return { ...f, refs, requirement: `Требование ${refs.map(r => r.startsWith('pdd:') ? `п. ${r.slice(4)}` : r.startsWith('sign:') ? `знак ${r.slice(5)}` : `разметка ${r.slice(8)}`).join(', ')}`,
      compliance: f.severity === 'violation' ? 'не выполнено' : f.trace?.compliance === 'выполнено' || f.refs.includes('pdd:6.14') ? 'выполнено' : 'не определить',
      prevention,
      trace: { ...sampleTrace(ctx, i, frame), ...f.trace, ruleCodes: f.refs.filter(r => r.startsWith('rule:')),
        gates: ctx.technical.events.filter(e => e.actorId === i.a.id && e.t <= (f.t ?? Infinity)).map(e => e.trace),
        inputs: { lights: structuredClone(ctx.scene.lights), signs: structuredClone(ctx.scene.signs), markings: structuredClone(ctx.scene.markings), crosswalks: structuredClone(ctx.scene.crosswalks) },
        otherParticipants: [...ctx.infos.values()].filter(other => other.a.id !== i.a.id && other.tr.present[Math.min(ctx.tl.n - 1, frame)]).map(other => sampleTrace(ctx, other, frame)),
        overtakes: ctx.technical.overtakes.filter(o => o.overtaker === i.a.id || o.overtaken === i.a.id),
        opposingLane: ctx.onc.get(i.a.id), pedestrianEntry: ctx.pedEntry.get(i.a.id), skippedStops: ctx.stopSkipped.get(i.a.id),
        requirementRefs: refs, causal: f.causal, assessments: assessments.map(t => t.trace),
        method: f.causal ? 'Причинная связь по правилам модели и условиям конфликта; отдельный контрфактический прогон траекторий не выполнялся' : 'Причинная связь не установлена',
      },
    };
  });
  const actors = ctx.scene.actors.map(a => {
    const mine = findings.filter(f => f.actorId === a.id);
    const viol = mine.filter(f => f.severity === 'violation');
    const causal = viol.filter(f => f.causal);
    const i = ctx.infos.get(a.id)!;
    let status: ActorVerdict['status'];
    let text: string;
    if (a.railwayTrain) {
      status = 'insufficient-data';
      text = 'Для поезда выполнен технический расчёт по заданным параметрам. Соблюдение железнодорожных обязанностей машиниста дорожная модель не определяет.';
    } else if (causal.length) {
      status = 'causal-violation';
      text = `Нарушения в причинной связи со столкновением: ${causal.map(f => f.title).join('; ')}.`;
    } else if (viol.length) {
      status = 'noncausal-violation';
      text = collisions.length ? `Нарушения ПДД есть, но прямой причинной связи со столкновением не установлено: ${viol.map(f => f.title).join('; ')}.` : `Выявлены нарушения: ${viol.map(f => f.title).join('; ')}.`;
    } else if (i.k0 >= ctx.tl.n || mine.some(f => f.severity === 'contributing' || f.trace.priorityCycle)) {
      status = 'insufficient-data'; text = 'Недостаточно данных для оценки соблюдения требований ПДД.';
    } else {
      status = 'no-violations';
      text = collisions.length && !collisions.some(c => c.collision.a === a.id || c.collision.b === a.id) ? 'В столкновении не участвовал, нарушений ПДД не выявлено.' : 'Нарушений ПДД не выявлено.';
    }
    return { actorId: a.id, status, text, trace: { actorId: a.id, firstFrame: i.k0, lastFrame: i.kEnd, findings: mine.map(f => f.trace) } };
  });
  return { ctx, section: { actors, findings, collisions, priorityGraphs: ctx.priorityGraphs }, events: ctx.events.sort((a,b) => a.t-b.t) };
}
