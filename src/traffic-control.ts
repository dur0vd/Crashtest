import { angDiff } from './geom';
import { lightPhase, type MobilitySurface, type Movement, type TrafficLight } from './scene';

export interface MovementPermission {
  /** Whether this control determines the intersection's traffic order (13.3).
   * A reversible lane signal controls a lane, not the intersection. */
  regulated: boolean;
  /** null means the scene lacks the direction or other facts needed to decide. */
  allowed: boolean | null;
  yieldToAll: boolean;
  refs: string[];
  reason: string;
}

type DirectedActor = { heading: number; type: string; kind?: string; x?: number; y?: number; signalSurface?: MobilitySurface | 'carriageway' | 'unknown' };
type RequestedMovement = Movement | 'unknown';

const result = (regulated: boolean, allowed: boolean | null, refs: string[], reason: string, yieldToAll = false): MovementPermission =>
  ({ regulated, allowed, yieldToAll, refs, reason });

/** 6.3 explicitly extends a green left arrow to a U-turn. A prohibitory sign
 * still needs to be checked by the caller; an arrow creates no priority. */
function arrowIncludes(directions: Movement[], movement: RequestedMovement): boolean {
  return movement !== 'unknown' && (directions.includes(movement) || movement === 'uturn' && directions.includes('left'));
}

function allDirections(directions: Movement[]): boolean {
  return directions.includes('straight') && directions.includes('right') && directions.includes('left');
}

/** Static traffic control from the checked-in src/data/pdd.json, 6.2–6.8,
 * 6.10, 6.14–6.15 and 13.5–13.6. `allowed` describes the signal only: yellow
 * and an upward arm need the separate stopping-distance exception from 6.14.
 * `stopLine` and the permission to finish crossing (13.7) are checked at entry
 * and exit by the intersection analysis, not by this signal lookup. */
export function movementPermission(
  light: TrafficLight,
  actor: DirectedActor,
  movement: RequestedMovement,
  t: number,
): MovementPermission {
  // An active controller overrides traffic lights, signs and markings (6.15).
  if (light.kind === 'controller') return controllerPermission(light, actor, movement);

  const surface = actor.signalSurface;
  if (actor.type === 'sim') {
    const pedestrian = ['sidewalk', 'footpath', 'pedestrian-side'].includes(surface ?? '');
    const bicycle = ['cyclepath', 'sharedpath', 'cycle-side', 'cycle-lane'].includes(surface ?? '');
    const expected = pedestrian ? 'pedestrian' : bicycle ? 'bicycle' : surface === 'carriageway' || surface === 'cycle-zone' ? 'vehicle' : null;
    if (!expected || (light.kind ?? 'vehicle') !== expected) return result(true, null, ['pdd:6.5'],
      'Для СИМ нужен сигнал, соответствующий установленному месту движения; иной сигнал не подменяет его.');
  }
  if ((light.kind === 'pedestrian' || light.kind === 'bicycle') && (light.mode === 'off' || light.mode === 'flashing-yellow')) return result(false, null, ['pdd:6.5'], 'Силуэтный светофор не работает.');
  if (light.kind === 'pedestrian' || light.kind === 'bicycle') {
    const applies = light.kind === 'pedestrian' ? actor.kind === 'pedestrian' || actor.type === 'sim'
      : actor.type === 'bicycle' || actor.type === 'sim' || actor.type === 'moped' && surface === 'cycle-lane';
    if (!applies) return result(false, null, ['pdd:6.5'], 'Силуэтный сигнал не адресован этому участнику.');
    return result(true, lightPhase(light, t) === 'green', ['pdd:6.5'], 'Сигнал силуэта пешехода или велосипеда по п. 6.5.');
  }
  if (light.kind === 'reversible') {
    // 6.7, not 6.9 (the latter is the white lunar railway-crossing signal).
    if (light.mode === 'off') return result(false, null, ['pdd:6.7'],
      'Реверсивный светофор выключен: въезд запрещён при разметке 1.9 с обеих сторон полосы; наличие этой разметки нужно проверить отдельно.');
    if (light.reversibleState === 'red') return result(false, false, ['pdd:6.7'],
      'Красный X-образный сигнал запрещает движение по полосе.');
    if (light.reversibleState === 'green') return result(false, true, ['pdd:6.7'],
      'Зелёная стрелка вниз разрешает движение по полосе; приоритет на перекрёстке определяется отдельно.');
    if (light.reversibleState === 'yellow') return result(false, true, ['pdd:6.7'],
      'Жёлтая диагональная стрелка требует перестроиться на указанную ею полосу перед сменой сигнала.');
    return result(false, null, ['pdd:6.7'], 'Состояние реверсивного сигнала не задано.');
  }

  if (light.mode === 'off' || light.mode === 'flashing-yellow') return result(false, null, ['pdd:6.2', 'pdd:13.3'],
    light.mode === 'off'
      ? 'Светофор не работает; очерёдность определяется правилами нерегулируемого перекрёстка.'
      : 'Мигающий жёлтый предупреждает об опасности; перекрёсток нерегулируемый.');

  if (light.kind === 'tram') {
    if (!['tram', 'bus', 'trolleybus'].includes(actor.type)) return result(true, null, ['pdd:6.8', 'pdd:18.2'],
      'Не установлено, относится ли участник к транспортным средствам, которым адресован этот светофор на полосе маршрутных ТС.');
    if (movement === 'unknown' || light.tramDirections === undefined) return result(true, null, ['pdd:6.8'],
      'Для трамвайного светофора нужны направление движения и включённые нижний и верхние бело-лунные сигналы.');
    // tramDirections encodes simultaneous lower + corresponding upper signals;
    // [] means no permitted combination. White lunar circles are not the green
    // arrow in 6.3, so a left circle does not imply a tram U-turn.
    const allowed = light.tramDirections.includes(movement);
    return result(true, allowed, ['pdd:6.8'], allowed
      ? 'Одновременно включены нижний и соответствующий направлению верхний бело-лунные сигналы.'
      : 'Нет сочетания нижнего и соответствующего направлению верхнего бело-лунных сигналов; движение запрещено.');
  }

  const phase = lightPhase(light, t);
  const extra = light.extraSection;
  if (movement === 'unknown' && (extra || light.mainDirections && !allDirections(light.mainDirections))) return result(true, null, ['pdd:6.3'],
    'Направление движения не установлено, применимость основной стрелки или дополнительной секции определить нельзя.');

  if (extra && arrowIncludes(extra.directions, movement)) {
    if (!extra.on) return result(true, false, ['pdd:6.3'],
      'Дополнительная секция выключена: движение в регулируемом ею направлении запрещено.');
    const mustYield = phase === 'red' || phase === 'yellow';
    return result(true, true, ['pdd:6.3', ...(mustYield ? ['pdd:13.5', ...(actor.type === 'tram' ? ['pdd:13.6'] : [])] : [])],
      mustYield
        ? 'Дополнительная зелёная стрелка включена с красным или жёлтым: разрешено ехать, уступив ТС с других направлений.'
        : 'Дополнительная зелёная стрелка включена одновременно с основным зелёным сигналом.', mustYield);
  }

  if (light.mainDirections && !arrowIncludes(light.mainDirections, movement)
    && !(movement === 'unknown' && allDirections(light.mainDirections))) return result(true, false, ['pdd:6.3'],
    'Основной сигнал со стрелкой не разрешает выбранное направление.');

  if (phase === 'green') return result(true, true, [light.mainDirections ? 'pdd:6.3' : 'pdd:6.2'],
    'Основной зелёный сигнал разрешает выбранное направление; обязанность уступить проверяется отдельно.');
  if (phase === 'yellow') return result(true, false, ['pdd:6.2', 'pdd:6.14'],
    'Жёлтый запрещает движение, кроме случая невозможности остановиться без экстренного торможения по п. 6.14.');
  return result(true, false, [light.mainDirections ? 'pdd:6.3' : 'pdd:6.2'], 'Красный сигнал запрещает движение.');
}

function controllerPermission(light: TrafficLight, actor: DirectedActor, movement: RequestedMovement): MovementPermission {
  // A 'stop' object is addressed to the participant matched to this control by
  // the caller. Unlike the upward-arm gesture, 6.11 has no 6.14 exception.
  if (light.controllerGesture === 'stop') return result(true, false, ['pdd:6.11', 'pdd:6.15'],
    'Регулировщик адресовал участнику требование остановки; водитель должен остановиться в указанном месте.');
  const refs = ['pdd:6.10', 'pdd:6.15'];
  if (!light.controllerGesture) return result(true, null, refs, 'Жест регулировщика не задан.');
  if (light.controllerGesture === 'arm-up') return result(true, false, [...refs, 'pdd:6.14'],
    'Рука поднята вверх: движение запрещено, кроме случая п. 6.14.');
  if (actor.type === 'sim' || actor.type === 'scooter' || actor.kind === 'pedestrian') {
    if (!Number.isFinite(actor.heading) || !Number.isFinite(light.angle)) return result(true, null, refs, 'Направление движения не установлено.');
    const acrossSides = Math.abs(Math.cos(angDiff(light.angle, actor.heading))) < 0.15;
    if (light.controllerGesture === 'arms-out') return result(true, acrossSides, refs, 'Пешеходный сигнал: переход со стороны левого и правого бока; СИМ следует ему по 6.10.');
    if (!acrossSides) return result(true, false, refs, 'Переход не проходит за спиной регулировщика.');
    if (!Number.isFinite(actor.x) || !Number.isFinite(actor.y)) return result(true, null, refs, 'Для перехода за спиной нужны координаты пути.');
    const behind = (actor.x! - light.x) * Math.cos(light.angle) + (actor.y! - light.y) * Math.sin(light.angle);
    return result(true, Math.abs(behind) < 0.1 ? null : behind < 0, refs, 'Пешеходный сигнал: переход только за спиной регулировщика; положение на границе неопределённо.');
  }
  if (movement === 'unknown' || !Number.isFinite(actor.heading) || !Number.isFinite(light.angle)) return result(true, null, refs,
    'Для сигнала регулировщика не установлены направление подъезда или манёвр.');

  // Coordinates use screen y down: rightOf(angle) is the body's right side.
  // Incoming heading + PI points from the controller to the approaching actor.
  // Relative travel heading: 0 = back, PI = chest, +PI/2 = left side.
  const relative = angDiff(light.angle, actor.heading);
  const q = Math.round(relative / (Math.PI / 2));
  const side = Math.abs(q) === 2 ? 'chest' : q === 1 ? 'left' : q === -1 ? 'right' : 'back';
  const tram = actor.type === 'tram';
  let allowed: boolean;
  if (light.controllerGesture === 'arms-out') {
    allowed = (side === 'left' || side === 'right') && (movement === 'straight' || !tram && movement === 'right');
  } else {
    allowed = side === 'left' && (!tram || movement === 'left') || side === 'chest' && movement === 'right';
  }
  return result(true, allowed, refs, allowed
    ? 'Жест регулировщика разрешает этот манёвр со стороны подъезда участника.'
    : 'Жест регулировщика запрещает этот манёвр со стороны подъезда участника.');
}
