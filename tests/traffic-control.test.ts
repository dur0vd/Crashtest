import { describe, expect, it } from 'vitest';
import { movementPermission } from '../src/traffic-control';
import type { Movement, TrafficLight } from '../src/scene';

const car = { heading: 0, type: 'car' };
const tram = { heading: 0, type: 'tram' };
const light = (overrides: Partial<TrafficLight> = {}): TrafficLight => ({
  id: 'l1', x: 0, y: 0, angle: 0, lineLength: 3.5,
  green: 10, yellow: 3, red: 10, offset: 0, ...overrides,
});

describe('разрешение направления сигнала, п. 6.2–6.4 и 13.5–13.6', () => {
  it.each([[0, true], [10, false], [13, false], [23, true]] as const)('обычный сигнал в t=%s: %s', (t, allowed) => {
    expect(movementPermission(light(), car, 'straight', t).allowed).toBe(allowed);
  });

  it('жёлтый возвращает запрет с исключением 6.14 для отдельного расчёта торможения', () => {
    const permission = movementPermission(light(), car, 'straight', 11);
    expect(permission.allowed).toBe(false);
    expect(permission.refs).toEqual(['pdd:6.2', 'pdd:6.14']);
  });

  it.each(['flashing-yellow', 'off'] as const)('%s не делает перекрёсток регулируемым', mode => {
    const permission = movementPermission(light({ mode }), car, 'left', 14);
    expect(permission).toMatchObject({ regulated: false, allowed: null, yieldToAll: false });
    expect(permission.refs).toContain('pdd:13.3');
  });

  it.each(['left', 'uturn'] as const)('основная стрелка налево разрешает %s по 6.3', movement => {
    expect(movementPermission(light({ mainDirections: ['left'] }), car, movement, 0).allowed).toBe(true);
    expect(movementPermission(light({ mainDirections: ['left'] }), car, movement, 13).allowed).toBe(false);
  });

  it('основная стрелка не разрешает другие направления и не создаёт преимущество', () => {
    expect(movementPermission(light({ mainDirections: ['straight'] }), car, 'right', 0).allowed).toBe(false);
    expect(movementPermission(light({ mainDirections: ['left'] }), car, 'left', 0).yieldToAll).toBe(false);
  });

  it('выключенная дополнительная секция запрещает её направление даже на зелёный', () => {
    const signal = light({ extraSection: { directions: ['right'], on: false } });
    expect(movementPermission(signal, car, 'right', 0).allowed).toBe(false);
    expect(movementPermission(signal, car, 'straight', 0).allowed).toBe(true);
    expect(movementPermission(signal, car, 'right', 0).refs).toContain('pdd:6.3');
  });

  it.each([10, 13])('стрелка на запрещающем основном в t=%s разрешает движение с уступкой', t => {
    const signal = light({ extraSection: { directions: ['left'], on: true } });
    const permission = movementPermission(signal, car, 'uturn', t);
    expect(permission).toMatchObject({ regulated: true, allowed: true, yieldToAll: true });
    expect(permission.refs).toContain('pdd:13.5');
    expect(movementPermission(signal, car, 'straight', t).allowed).toBe(false);
  });

  it('дополнительная стрелка с зелёным не создаёт обязанность уступить всем', () => {
    const signal = light({ extraSection: { directions: ['right'], on: true } });
    expect(movementPermission(signal, car, 'right', 0)).toMatchObject({ allowed: true, yieldToAll: false });
  });

  it('трамвай со стрелкой на красном тоже уступает по 13.6', () => {
    const signal = light({ extraSection: { directions: ['left'], on: true } });
    const permission = movementPermission(signal, tram, 'left', 14);
    expect(permission.yieldToAll).toBe(true);
    expect(permission.refs).toContain('pdd:13.6');
  });

  it('неизвестный манёвр при стрелочном сигнале не считается разрешённым', () => {
    expect(movementPermission(light({ mainDirections: ['left'] }), car, 'unknown', 0).allowed).toBeNull();
    expect(movementPermission(light({ extraSection: { directions: ['right'], on: true } }), car, 'unknown', 14).allowed).toBeNull();
  });
});

describe('реверсивный сигнал, п. 6.7', () => {
  it.each([['red', false], ['green', true], ['yellow', true]] as const)('%s управляет полосой, приоритет перекрёстка отдельно', (reversibleState, allowed) => {
    const permission = movementPermission(light({ kind: 'reversible', reversibleState }), car, 'straight', 0);
    expect(permission).toMatchObject({ allowed, regulated: false });
    expect(permission.refs).toEqual(['pdd:6.7']);
  });

  it('у выключенного реверсивного нужно отдельно установить 1.9 с обеих сторон', () => {
    const permission = movementPermission(light({ kind: 'reversible', mode: 'off' }), car, 'straight', 0);
    expect(permission.allowed).toBeNull();
    expect(permission.reason).toContain('1.9');
  });

  it('неизвестное состояние не заменяется зелёным обычного цикла', () => {
    expect(movementPermission(light({ kind: 'reversible' }), car, 'straight', 0).allowed).toBeNull();
  });
});

describe('Т-образный бело-лунный светофор, п. 6.8', () => {
  it.each(['tram', 'bus', 'trolleybus'])('комбинация нижнего и верхнего разрешает направление: %s', type => {
    const signal = light({ kind: 'tram', tramDirections: ['left', 'straight'] });
    expect(movementPermission(signal, { ...car, type }, 'left', 14).allowed).toBe(true);
    expect(movementPermission(signal, { ...car, type }, 'right', 0).allowed).toBe(false);
  });

  it('нет нижнего разрешающего сочетания — движение запрещено', () => {
    expect(movementPermission(light({ kind: 'tram', tramDirections: [] }), tram, 'straight', 0).allowed).toBe(false);
  });

  it('бело-лунный верхний левый не подменяется зелёной стрелкой 6.3 для разворота', () => {
    expect(movementPermission(light({ kind: 'tram', tramDirections: ['left'] }), tram, 'uturn', 0).allowed).toBe(false);
  });

  it('неустановленные сигналы или применимость к ТС дают неопределённость', () => {
    expect(movementPermission(light({ kind: 'tram' }), tram, 'straight', 0).allowed).toBeNull();
    expect(movementPermission(light({ kind: 'tram', tramDirections: ['straight'] }), car, 'straight', 0).allowed).toBeNull();
  });
});

describe('статический регулировщик, п. 6.10 и приоритет по 6.15', () => {
  const permission = (gesture: NonNullable<TrafficLight['controllerGesture']>, side: 'left' | 'right' | 'chest' | 'back', type: string, movement: Movement) => {
    const heading = { left: Math.PI / 2, right: -Math.PI / 2, chest: Math.PI, back: 0 }[side];
    return movementPermission(light({ kind: 'controller', controllerGesture: gesture }), { heading, type }, movement, 14);
  };

  it.each(['left', 'right'] as const)('руки в стороны, %s бок: безрельсовые прямо/направо, трамвай прямо', side => {
    expect(permission('arms-out', side, 'car', 'straight').allowed).toBe(true);
    expect(permission('arms-out', side, 'car', 'right').allowed).toBe(true);
    expect(permission('arms-out', side, 'car', 'left').allowed).toBe(false);
    expect(permission('arms-out', side, 'car', 'uturn').allowed).toBe(false);
    expect(permission('arms-out', side, 'tram', 'straight').allowed).toBe(true);
    expect(permission('arms-out', side, 'tram', 'right').allowed).toBe(false);
  });

  it.each(['chest', 'back'] as const)('руки в стороны, %s: всем запрещено', side => {
    expect(permission('arms-out', side, 'car', 'straight').allowed).toBe(false);
    expect(permission('arms-out', side, 'tram', 'right').allowed).toBe(false);
  });

  it.each(['straight', 'right', 'left', 'uturn'] as const)('правая рука вперёд, левый бок: безрельсовому %s', movement => {
    expect(permission('right-arm-forward', 'left', 'car', movement).allowed).toBe(true);
  });

  it('правая рука вперёд: трамвай с левого бока только налево, с груди всем только направо', () => {
    expect(permission('right-arm-forward', 'left', 'tram', 'left').allowed).toBe(true);
    expect(permission('right-arm-forward', 'left', 'tram', 'straight').allowed).toBe(false);
    expect(permission('right-arm-forward', 'chest', 'tram', 'right').allowed).toBe(true);
    expect(permission('right-arm-forward', 'chest', 'car', 'right').allowed).toBe(true);
    expect(permission('right-arm-forward', 'chest', 'car', 'left').allowed).toBe(false);
  });

  it.each(['right', 'back'] as const)('правая рука вперёд, %s: всем запрещено', side => {
    expect(permission('right-arm-forward', side, 'car', 'straight').allowed).toBe(false);
    expect(permission('right-arm-forward', side, 'tram', 'right').allowed).toBe(false);
  });

  it('поднятая рука запрещает всем с сохранением исключения 6.14', () => {
    const p = permission('arm-up', 'left', 'car', 'right');
    expect(p.allowed).toBe(false);
    expect(p.refs).toContain('pdd:6.14');
  });

  it('адресное требование остановки по 6.11 обязательно независимо от стороны и манёвра', () => {
    const signal = light({ kind: 'controller', controllerGesture: 'stop', mode: 'off' });
    const p = movementPermission(signal, { heading: Math.PI / 2, type: 'car' }, 'left', 0);
    expect(p).toMatchObject({ regulated: true, allowed: false, yieldToAll: false });
    expect(p.refs).toEqual(['pdd:6.11', 'pdd:6.15']);
    expect(p.refs).not.toContain('pdd:6.14');
    expect(movementPermission(signal, car, 'unknown', 0).allowed).toBe(false);
  });

  it('угол регулировщика поворачивает разрешённые направления', () => {
    const signal = light({ kind: 'controller', controllerGesture: 'arms-out', angle: Math.PI / 2 });
    expect(movementPermission(signal, car, 'right', 0).allowed).toBe(true);
    expect(movementPermission(signal, { ...car, heading: Math.PI / 2 }, 'straight', 0).allowed).toBe(false);
  });

  it('абсолютные направления: регулировщик смотрит на север, автомобиль с запада едет на восток', () => {
    // Screen coordinates: north is -PI/2 and east is 0. The approach from the
    // west is the controller's left side; these literals do not use the side
    // helper above or derive headings from the implementation's angle formula.
    const signal = light({ kind: 'controller', controllerGesture: 'right-arm-forward', angle: -Math.PI / 2 });
    for (const movement of ['straight', 'right', 'left', 'uturn'] as const) {
      expect(movementPermission(signal, { heading: 0, type: 'car' }, movement, 0).allowed).toBe(true);
    }
    // From the east (right side) and south (back) all vehicle movements stop.
    expect(movementPermission(signal, { heading: Math.PI, type: 'car' }, 'straight', 0).allowed).toBe(false);
    expect(movementPermission(signal, { heading: -Math.PI / 2, type: 'car' }, 'right', 0).allowed).toBe(false);
    // From the north (chest) only the right turn is permitted.
    expect(movementPermission(signal, { heading: Math.PI / 2, type: 'car' }, 'right', 0).allowed).toBe(true);
    expect(movementPermission(signal, { heading: Math.PI / 2, type: 'car' }, 'straight', 0).allowed).toBe(false);
  });

  it('активный регулировщик действует даже при неработающем светофоре', () => {
    const signal = light({ kind: 'controller', controllerGesture: 'right-arm-forward', mode: 'off' });
    const p = movementPermission(signal, { ...car, heading: Math.PI / 2 }, 'left', 14);
    expect(p).toMatchObject({ regulated: true, allowed: true });
    expect(p.refs).toContain('pdd:6.15');
  });

  it('отсутствие жеста, манёвра или пешеходной траектории СИМ не даёт разрешение', () => {
    expect(movementPermission(light({ kind: 'controller' }), car, 'straight', 0).allowed).toBeNull();
    expect(movementPermission(light({ kind: 'controller', controllerGesture: 'arms-out' }), car, 'unknown', 0).allowed).toBeNull();
    expect(permission('right-arm-forward', 'left', 'sim', 'straight').allowed).toBeNull();
  });
});
