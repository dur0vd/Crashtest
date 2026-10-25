// Знаки (приложение 1 к ПДД), разметка (приложение 2) и перевозка грузов (раздел 23):
// проверки поверх готовой симуляции. Используются из analysis.ts.

import type { Ctx, Finding, GateEvent, Info } from './analysis';
import { roadsAt } from './geo';
import { densify } from './geo';
import {
  type OBB,
  type Vec,
  angDiff,
  dist,
  dot,
  fromAngle,
  kmh,
  nearestOnPolyline,
  obbCorners,
  rightOf,
} from './geom';
import { ARROW_VARIANTS, MARKING_BY_ID } from './markings';
import { type Sign, VEHICLES, dimsOf, hasEmergencySignals, type VehicleType } from './scene';
import { VALUE_SIGNS, signTitle } from './signs';
import { DT } from './sim';

export interface Kit {
  add: (f: Omit<Finding, 'causal'> & { causal?: boolean }) => Finding;
  reasonToBrake: (ctx: Ctx, i: Info, k: number) => boolean;
  boxAt: (i: Info, k: number) => OBB;
  posAt: (i: Info, k: number) => Vec;
}

const tOf = (k: number): number => k * DT;

// ---------------------------------------------------------------------------
// Классы участников и действие табличек

export type VClass = 'car' | 'truck' | 'bus' | 'tram' | 'motorcycle' | 'moped' | 'bicycle' | 'cart';

export function classOf(i: Info): VClass {
  switch (i.a.type as VehicleType) {
    case 'suv':
    case 'van':
    case 'car':
      return 'car';
    case 'truck':
      return 'truck';
    case 'bus':
    case 'trolleybus':
      return 'bus';
    case 'tram':
      return 'tram';
    case 'motorcycle':
      return 'motorcycle';
    case 'moped':
      return 'moped';
    case 'bicycle':
      return 'bicycle';
    default:
      return 'cart';
  }
}

// Таблички 8.4.x: какие из них однозначно привязаны к виду ТС по тексту приложения 1.
const PLATE_ONLY: Record<string, VClass[]> = { '8.4.1': ['truck'], '8.4.3': ['car'], '8.4.7': ['bicycle'] };
const PLATE_EXCEPT: Record<string, VClass[]> = { '8.4.9': ['truck'], '8.4.11': ['car'], '8.4.15': ['bicycle'] };

/** Распространяется ли знак на участника с учётом табличек «вид ТС» и «кроме». */
export function signApplies(sign: Sign, cls: VClass): boolean {
  const plates = sign.plates ?? [];
  const only = plates.filter((p) => PLATE_ONLY[p]).flatMap((p) => PLATE_ONLY[p]);
  if (only.length && !only.includes(cls)) return false;
  const except = plates.filter((p) => PLATE_EXCEPT[p]).flatMap((p) => PLATE_EXCEPT[p]);
  return !except.includes(cls);
}

const BAN: Record<string, (c: VClass) => boolean> = {
  '3.2': (c) => c !== 'tram',
  '3.3': (c) => ['car', 'truck', 'bus', 'motorcycle', 'moped'].includes(c),
  '3.4': (c) => c === 'truck',
  '3.5': (c) => c === 'motorcycle',
  '3.8': (c) => c === 'cart',
  '3.9': (c) => c === 'bicycle',
  '5.1': (c) => ['bicycle', 'cart', 'moped'].includes(c),
  '5.3': (c) => ['bicycle', 'cart', 'moped'].includes(c),
};

// ---------------------------------------------------------------------------
// Зона действия знака

/** Знаки, зона действия которых — до ближайшего перекрёстка за ними (приложение 1, п. 3). */
const TILL_JUNCTION = new Set(['3.16', '3.20', '3.22', '3.24', '3.26', '3.27', '3.28', '3.29', '3.30']);

/** Чем отменяется действие знака. */
const CANCELLED_BY: Record<string, string[]> = {
  '2.1': ['2.2'],
  '3.20': ['3.21', '3.31'],
  '3.22': ['3.23', '3.31'],
  '3.24': ['3.24', '3.25', '3.31'],
  '3.16': ['3.31'],
  '3.26': ['3.31'],
  '3.27': ['3.31'],
  '3.28': ['3.31'],
  '3.29': ['3.31'],
  '3.30': ['3.31'],
  '4.6': ['4.7'],
  '5.21': ['5.22'],
  '5.23.1': ['5.23.2', '5.24.1'],
  '5.24.1': ['5.23.1'],
  '5.31': ['5.32', '5.31'],
};

/** Рассчитывает, до какого кадра действует каждый пройденный знак. */
export function computeGateEnds(ctx: Ctx): void {
  for (const i of ctx.infos.values()) {
    if (!i.isVeh || i.a.type === 'train') continue;
    const mine = ctx.gates.filter((g) => g.actorId === i.a.id && g.sign).sort((a, b) => a.frame - b.frame);
    for (const g of mine) {
      let until = i.kEnd + 1;
      const sign = g.sign!;
      // отмена другим знаком
      for (const o of mine) {
        if (o.frame > g.frame && CANCELLED_BY[sign.kind]?.includes(o.sign!.kind)) until = Math.min(until, o.frame);
      }
      // табличка 8.2.1: действует на заданной длине
      if (sign.plates?.includes('8.2.1')) {
        const len = sign.zoneLen ?? VALUE_SIGNS['8.2.1'].def;
        for (let k = g.frame; k <= i.kEnd; k++) {
          if (i.trav[k] - g.dist >= len) {
            until = Math.min(until, k);
            break;
          }
        }
      } else if (TILL_JUNCTION.has(sign.kind)) {
        // до ближайшего перекрёстка: действует и в нём, заканчивается на выезде из него
        let inside = false;
        for (let k = g.frame; k <= i.kEnd; k++) {
          const at = roadsAt(ctx.geo, { x: i.tr.x[k], y: i.tr.y[k] }).length >= 2 && i.trav[k] - g.dist > 2;
          if (at) inside = true;
          else if (inside) {
            until = Math.min(until, k);
            break;
          }
        }
      }
      g.until = until;
    }
  }
}

// ---------------------------------------------------------------------------
// Классификация поворота после пересечения знака или стрелы

type Turn = 'straight' | 'left' | 'right' | 'uturn';

/** Куда повернул участник за ближайшие `reach` метров после кадра `frame`; null — путь слишком короткий. */
function turnAfter(i: Info, frame: number, reach = 35): Turn | null {
  let k = frame;
  while (k < i.kEnd && i.trav[k] - i.trav[frame] < reach) k++;
  if (i.trav[k] - i.trav[frame] < 12) return null;
  const d = angDiff(i.tr.h[frame], i.tr.h[k]);
  if (Math.abs(d) > 2.4) return 'uturn';
  if (d > 0.6) return 'right';
  if (d < -0.6) return 'left';
  return 'straight';
}

const TURN_RU: Record<Turn, string> = { straight: 'прямо', left: 'налево', right: 'направо', uturn: 'разворот' };

/** Какие манёвры разрешены или запрещены знаком. */
const TURN_ALLOW: Record<string, Turn[]> = {
  '4.1.1': ['straight'],
  '4.1.2': ['right'],
  '4.1.3': ['left', 'uturn'],
  '4.1.4': ['straight', 'right'],
  '4.1.5': ['straight', 'left', 'uturn'],
  '4.1.6': ['left', 'right', 'uturn'],
};
const TURN_BAN: Record<string, Turn[]> = {
  '3.18.1': ['right'],
  '3.18.2': ['left'],
  '3.19': ['uturn'],
};

function turnViolation(kit: Kit, i: Info, frame: number, refBase: string, allowed: Turn[] | null, banned: Turn[] | null, label: string): void {
  const turn = turnAfter(i, frame);
  if (!turn) return;
  const bad = allowed ? !allowed.includes(turn) : !!banned?.includes(turn);
  if (!bad) return;
  const leftish = turn === 'left' || turn === 'uturn';
  kit.add({
    actorId: i.a.id,
    severity: 'violation',
    t: tOf(frame),
    title: `манёвр «${TURN_RU[turn]}» вопреки ${label}`,
    detail: `После ${label} участник выполнил манёвр «${TURN_RU[turn]}», который запрещён.`,
    refs: [refBase, leftish ? 'koap:12.16.2' : 'koap:12.16.1'],
  });
}

// ---------------------------------------------------------------------------
// Знаки

export function checkSignRules(ctx: Ctx, kit: Kit): void {
  for (const g of ctx.gates) {
    if (!g.sign) continue;
    const i = ctx.infos.get(g.actorId)!;
    const cls = classOf(i);
    if (cls === 'tram' || hasEmergencySignals(i.a)) continue;
    const s = g.sign;
    if (!signApplies(s, cls)) continue;
    const label = `знаку ${s.kind} «${signTitle(s.kind)}»`;
    const t = tOf(g.frame);
    const dims = dimsOf(i.a);
    const ref = `sign:${s.kind}`;

    if (BAN[s.kind]?.(cls)) {
      kit.add({
        actorId: i.a.id,
        severity: 'violation',
        t,
        title: `движение вопреки знаку ${s.kind} «${signTitle(s.kind)}»`,
        detail: `${i.label} (${i.a.kind === 'vehicle' ? VEHICLES[i.a.type as VehicleType].name.toLowerCase() : ''}) проехал(а) под знаком, запрещающим такое движение.`,
        refs: s.kind === '5.1' || s.kind === '5.3' ? [ref, 'pdd:16.1', cls === 'moped' ? 'koap:12.16.1' : 'koap:12.29.2'] : [ref, s.kind === '3.4' ? 'koap:12.16.6' : 'koap:12.16.1'],
      });
      continue;
    }
    // ограничения по массе, высоте, ширине и длине
    const lim = VALUE_SIGNS[s.kind];
    const val = s.value ?? lim?.def ?? 0;
    const dimCheck = (over: boolean, what: string, has: string, refs: string[]) => {
      if (!over) return;
      kit.add({ actorId: i.a.id, severity: 'violation', t, title: `${what} превышает значение на знаке ${s.kind}`, detail: `${has}; на знаке — ${val} ${lim?.unit ?? ''}.`, refs });
    };
    if (s.kind === '3.11') dimCheck(dims.mass > val * 1000, 'масса ТС', `Фактическая масса ТС с грузом ${(dims.mass / 1000).toFixed(1)} т`, [ref, 'koap:12.21.1#11']);
    if (s.kind === '3.13') dimCheck(dims.height > val, 'высота ТС', `Высота ТС с грузом ${dims.height.toFixed(1)} м`, [ref, 'koap:12.16.1']);
    if (s.kind === '3.14') dimCheck(dims.width > val, 'ширина ТС', `Ширина ТС с грузом ${dims.width.toFixed(2)} м`, [ref, 'koap:12.16.1']);
    if (s.kind === '3.15') dimCheck(dims.length > val, 'длина ТС', `Длина ТС с грузом ${dims.length.toFixed(1)} м`, [ref, 'koap:12.16.1']);

    // повороты и направления движения
    if (TURN_BAN[s.kind]) turnViolation(kit, i, g.frame, ref, null, TURN_BAN[s.kind], label);
    if (TURN_ALLOW[s.kind]) turnViolation(kit, i, g.frame, ref, TURN_ALLOW[s.kind], null, label);

    // минимальная скорость (4.6)
    if (s.kind === '4.6') {
      let run = 0;
      for (let k = g.frame; k < Math.min(g.until ?? i.kEnd + 1, i.kEnd + 1); k++) {
        if (kmh(i.tr.v[k]) < val - 0.5 && i.tr.v[k] > 0.3) run++;
        else run = 0;
        if (run >= 80) {
          kit.add({ actorId: i.a.id, severity: 'violation', t: tOf(k), title: `скорость ниже минимальной по знаку 4.6 (${val} км/ч)`, detail: `Скорость ${Math.round(kmh(i.tr.v[k]))} км/ч.`, refs: [ref, 'koap:12.16.1'] });
          break;
        }
      }
    }

    // остановка и стоянка (3.27, 3.28)
    if (s.kind === '3.27' || s.kind === '3.28') {
      const end = Math.min(g.until ?? i.kEnd + 1, i.kEnd + 1);
      let from = -1;
      for (let k = g.frame; k < end; k++) {
        if (i.tr.v[k] < 0.3) {
          if (from < 0) from = k;
          const needed = s.kind === '3.27' ? 4 : Math.min(i.kEnd * DT, 10);
          if ((k - from) * DT >= needed - 1e-9) {
            if (kit.reasonToBrake(ctx, i, from)) break; // остановка по требованиям ПДД (светофор, пешеход, затор)
            kit.add({
              actorId: i.a.id,
              severity: 'violation',
              t: tOf(from),
              title: s.kind === '3.27' ? 'остановка в зоне знака «Остановка запрещена»' : 'стоянка в зоне знака «Стоянка запрещена»',
              detail: s.kind === '3.27' ? 'ТС остановилось в зоне действия знака 3.27.' : 'ТС остаётся на месте в зоне действия знака 3.28 (условно: стоянка — стоит всё время расчёта).',
              refs: [ref, 'pdd:12.4', 'koap:12.16.4'],
            });
            break;
          }
        } else from = -1;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Разметка

function crossingNote(ctx: Ctx, mid: Vec): { separates: boolean } {
  const hits = roadsAt(ctx.geo, mid, 1);
  if (!hits.length) return { separates: false };
  const near = hits[0].near;
  return { separates: Math.abs(near.d) < 0.9 && !hits[0].rg.road.oneWay };
}

export function checkMarkingRules(ctx: Ctx, kit: Kit): void {
  for (const m of ctx.scene.markings) {
    const spec = MARKING_BY_ID[m.kind];
    if (!spec || !m.pts.length) continue;
    const dense = spec.form === 'symbol' ? m.pts : densify(m.pts, !!m.smooth, m.radius ?? 0);

    for (const i of ctx.infos.values()) {
      if (!i.isVeh || i.a.type === 'train' || classOf(i) === 'tram' || hasEmergencySignals(i.a)) continue;

      // пересечение сплошных линий
      if (spec.form === 'line' && (spec.noCross || spec.oneSide) && dense.length >= 2) {
        let run = 0;
        let before = 0;
        for (let k = Math.max(i.k0, 1); k <= i.kEnd; k++) {
          const c = kit.posAt(i, k);
          const near = nearestOnPolyline(dense, c);
          let straddle = false;
          if (near.dist < 4 && !near.beyond) {
            const r = rightOf(Math.atan2(near.tangent.y, near.tangent.x));
            const ds = obbCorners(kit.boxAt(i, k)).map((p) => dot({ x: p.x - near.point.x, y: p.y - near.point.y }, r));
            straddle = Math.min(...ds) < -0.05 && Math.max(...ds) > 0.05;
            if (!straddle && near.dist < 3.5) before = Math.sign(near.d) || before;
          }
          run = straddle ? run + 1 : 0;
          if (run === 8) {
            // 1.11: можно пересекать, если подъезжаем со стороны прерывистой линии
            const solidSide = m.solidRight === false ? -1 : 1;
            if (spec.oneSide && before !== solidSide) break;
            const mid = dense[Math.floor(dense.length / 2)];
            const { separates } = crossingNote(ctx, mid);
            kit.add({
              actorId: i.a.id,
              severity: 'violation',
              t: tOf(k - 7),
              title: `пересечение линии разметки ${m.kind}`,
              detail: `Линию ${m.kind} (${spec.name.toLowerCase()}) пересекать запрещено.${separates ? ' Она разделяет потоки противоположных направлений: ТС оказалось на встречной стороне.' : ''}`,
              refs: separates ? [`marking:${m.kind}`, 'pdd:9.1(1)', 'koap:12.15.4'] : [`marking:${m.kind}`, 'pdd:9.7', 'koap:12.16.1'],
            });
            break;
          }
        }
      }

      // остановка у линий, запрещающих её
      if (spec.form === 'line' && spec.noStop && dense.length >= 2) {
        let from = -1;
        for (let k = i.k0; k <= i.kEnd; k++) {
          const near = nearestOnPolyline(dense, kit.posAt(i, k));
          const close = near.dist < 2.5 && !near.beyond;
          if (close && i.tr.v[k] < 0.3) {
            if (from < 0) from = k;
            if ((k - from) * DT >= 4) {
              if (kit.reasonToBrake(ctx, i, from)) break;
              kit.add({
                actorId: i.a.id,
                severity: 'violation',
                t: tOf(from),
                title: `остановка у разметки ${m.kind}, запрещающей остановку`,
                detail: `ТС остановилось у линии ${m.kind} (${spec.name.toLowerCase()}).`,
                refs: [`marking:${m.kind}`, 'pdd:12.4', 'koap:12.16.4'],
              });
              break;
            }
          } else from = -1;
        }
      }

      // въезд на островки
      if (spec.form === 'area' && spec.noEnter && m.pts.length >= 3 && Math.max(...i.tr.v) > 0.3) {
        let run = 0;
        for (let k = i.k0; k <= i.kEnd; k++) {
          const c = kit.posAt(i, k);
          if (inPolygon(m.pts, c)) run++;
          else run = 0;
          if (run === 4) {
            kit.add({
              actorId: i.a.id,
              severity: 'violation',
              t: tOf(k - 3),
              title: `въезд на островок, обозначенный разметкой ${m.kind}`,
              detail: 'Разметка 1.16 обозначает островки, въезд на которые запрещён.',
              refs: [`marking:${m.kind}`, 'koap:12.16.1'],
            });
            break;
          }
        }
      }

      // стрелы 1.18: разрешённые направления на полосе
      if (spec.arrows) {
        const p = m.pts[0];
        const dir = fromAngle(m.angle ?? 0);
        let best = -1;
        let bd = 3;
        for (let k = i.k0; k <= i.kEnd; k++) {
          if (dot(fromAngle(i.tr.h[k]), dir) < 0.75) continue;
          const d = dist(kit.posAt(i, k), p);
          if (d < bd) {
            bd = d;
            best = k;
          }
        }
        if (best >= 0) {
          const allow = (ARROW_VARIANTS[m.variant ?? 'straight']?.allow ?? ['straight']) as Turn[];
          turnViolation(kit, i, best, `marking:${m.kind}`, allow, null, `стреле на полосе (${ARROW_VARIANTS[m.variant ?? 'straight']?.name.toLowerCase()})`);
        }
      }
    }
  }
}

function inPolygon(poly: Vec[], p: Vec): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Перевозка грузов (раздел 23 ПДД, ст. 12.21 КоАП)

export function checkCargoRules(ctx: Ctx, kit: Kit): void {
  for (const i of ctx.infos.values()) {
    const c = i.a.cargo;
    if (!i.isVeh || !c) continue;
    const vs = VEHICLES[i.a.type as VehicleType];
    const d = dimsOf(i.a);
    const t = tOf(i.k0);
    const add = (title: string, detail: string, refs: string[], severity: Finding['severity'] = 'violation') =>
      kit.add({ actorId: i.a.id, severity, t, title, detail, refs });

    if (c.mass > vs.payload && vs.payload > 0) {
      add('масса груза превышает допустимую для ТС', `Груз ${c.mass} кг при допустимой нагрузке ${vs.payload} кг.`, ['pdd:23.1', 'koap:12.21#1']);
    }
    if (!c.secured) {
      add('груз закреплён ненадлежащим образом', 'Груз может упасть или создать помехи движению. Водитель обязан контролировать размещение и крепление груза.', ['pdd:23.2', 'koap:12.21#1']);
    }
    if (c.blocksView) {
      add('груз ограничивает обзор или закрывает световые приборы, номера', 'Перевозка допускается только при условии, что груз не ограничивает водителю обзор и не закрывает внешние световые приборы и регистрационные знаки.', ['pdd:23.3', 'koap:12.21#1']);
    }
    const over = c.front > 1 || c.rear > 1 || c.left > 0.4 || c.right > 0.4;
    if (over && !c.marked) {
      add('выступающий груз не обозначен знаками «Крупногабаритный груз»', `Свесы: спереди ${c.front} м, сзади ${c.rear} м, слева ${c.left} м, справа ${c.right} м. Груз, выступающий более чем на 1 м спереди или сзади либо на 0,4 м сбоку, должен быть обозначен.`, ['pdd:23.4', 'koap:12.21#1']);
    } else if (over) {
      add('выступающий груз обозначен знаками «Крупногабаритный груз»', 'Требование п. 23.4 выполнено; в тёмное время суток дополнительно нужны белый фонарь спереди и красный сзади.', ['pdd:23.4'], 'info');
    }
    // п. 23.5: превышение габаритов требует специального разрешения
    const limits: [string, number, number][] = [
      ['ширина', d.width, 2.55],
      ['высота', d.height, 4],
      ['длина', d.length, 20],
    ];
    const exceeded = limits.filter(([, v, lim]) => v > lim + 1e-9);
    if (c.rear > 2) exceeded.push(['свес сзади', c.rear, 2]);
    for (const [what, v, lim] of exceeded) {
      const cm = (v - lim) * 100;
      const part = cm <= 10 ? '1' : cm <= 20 ? '4' : cm <= 50 ? '5' : '6';
      add(`${what} с грузом превышает допустимую без специального разрешения`, `${what}: ${v.toFixed(2)} м при допустимых ${lim} м (превышение ${Math.round(cm)} см). Движение допускается по специальному разрешению в соответствии со специальными правилами.`, ['pdd:23.5', `koap:12.21.1#${part}`]);
    }
    if (c.dangerous) {
      add('перевозка опасного груза', 'Опасные грузы перевозятся по специальным правилам (допуск ТС и водителя, аварийная карточка, знаки).', ['pdd:23.5', 'koap:12.21.2#2'], 'info');
    }
  }
}

/** Участвовал ли груз в контакте: точка удара лежит за габаритами самого ТС. */
export function cargoInvolved(i: Info, boxAt: (i: Info, k: number) => OBB, frame: number, point: Vec): boolean {
  if (!i.a.cargo) return false;
  const b = boxAt(i, frame);
  const l = { x: dot({ x: point.x - b.cx, y: point.y - b.cy }, fromAngle(b.a)), y: dot({ x: point.x - b.cx, y: point.y - b.cy }, rightOf(b.a)) };
  // габариты самого ТС относительно смещённого центра кузова с грузом
  const x0 = -i.shift - i.hlBase;
  const x1 = -i.shift + i.hlBase;
  return l.x > x1 + 0.1 || l.x < x0 - 0.1 || l.y < -(i.hwBase + 0.1) || l.y > i.hwBase + 0.1;
}

export type { GateEvent };
