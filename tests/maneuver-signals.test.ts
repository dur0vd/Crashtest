import { describe, expect, it } from 'vitest';
import { type Actor, type Waypoint } from '../src/scene';
import { SIGNAL_LEAD_SECONDS, suggestSignals, suggestedSignalUpdates, vehicleSignalAt } from '../src/maneuver-signals';

type SignalWaypoint = Waypoint & { signal?: 'none' | 'left' | 'right' | 'hazard'; signalAt?: number };
function car(path: SignalWaypoint[] = [], overrides: Partial<Actor> = {}): Actor {
  return { id: 'car', kind: 'vehicle', type: 'car', x: 0, y: 0, heading: 0, speed: 36, color: '#fff', delay: 0,
    flags: { drunk: false, noLicense: false, flees: false }, path, ...overrides };
}

const rightTurn = (overrides: Partial<Actor> = {}) => car([
  { x: 20, y: 0, v: 36 }, { x: 20, y: 20, v: 36 },
], overrides);

describe('команды указателей поворота', () => {
  it('явное абсолютное время не зависит от достижения точки', () => {
    const actor = car([{ x: 20, y: 0, v: 36, signal: 'right', signalAt: 1 }]);
    expect(vehicleSignalAt(actor, 0.9, [-1])).toEqual({ signal: 'none', since: null, source: 'none' });
    expect(vehicleSignalAt(actor, 1, [-1])).toEqual({ signal: 'right', since: 1, source: 'explicit' });
  });

  it('без timestamp использует фактическое прибытие, включая явное выключение', () => {
    const actor = car([{ x: 20, y: 0, v: 36, signal: 'left' }, { x: 40, y: 0, v: 36, signal: 'none' }]);
    expect(vehicleSignalAt(actor, 1.9, [2, 5]).signal).toBe('none');
    expect(vehicleSignalAt(actor, 4, [2, 5])).toEqual({ signal: 'left', since: 2, source: 'observed' });
    expect(vehicleSignalAt(actor, 5, [2, 5])).toEqual({ signal: 'none', since: 5, source: 'observed' });
  });

  it('не заменяет отсутствующие фактические наблюдения оценочным временем', () => {
    const actor = car([{ x: 10, y: 0, v: 36, signal: 'hazard' }]);
    for (const times of [[], [-1], [NaN], [Infinity]]) {
      expect(vehicleSignalAt(actor, 100, times)).toEqual({ signal: 'none', since: null, source: 'none' });
    }
    expect(vehicleSignalAt(actor, 100).source).toBe('estimate');
  });

  it('в предпросмотре учитывает задержку появления и явно помечает оценку', () => {
    const actor = car([{ x: 10, y: 0, v: 36, signal: 'hazard' }], { delay: 2 });
    expect(vehicleSignalAt(actor, 2.9).signal).toBe('none');
    expect(vehicleSignalAt(actor, 3)).toEqual({ signal: 'hazard', since: 3, source: 'estimate' });
  });

  it('оценочный маршрут учитывает паузу в остановочной точке', () => {
    const actor = car([{ x: 10, y: 0, v: 0, hold: 4, signal: 'left' }, { x: 20, y: 0, v: 36, signal: 'none' }]);
    expect(vehicleSignalAt(actor, 7.9).signal).toBe('left');
    expect(vehicleSignalAt(actor, 8).signal).toBe('none');
  });

  it('повтор одинаковой команды не сбрасывает заблаговременность', () => {
    const actor = car([{ x: 20, y: 0, v: 36, signal: 'right', signalAt: 1 }, { x: 40, y: 0, v: 36, signal: 'right' }]);
    expect(vehicleSignalAt(actor, 4, [2, 4])).toEqual({ signal: 'right', since: 1, source: 'explicit' });
  });

  it('одновременное явно заданное событие имеет приоритет над arrival', () => {
    const actor = car([{ x: 20, y: 0, v: 36, signal: 'right', signalAt: 2 }, { x: 40, y: 0, v: 36, signal: 'none' }]);
    expect(vehicleSignalAt(actor, 2, [1, 2]).signal).toBe('right');
  });

  it('undefined не выключает свет, тогда как нормализованный none является командой', () => {
    const actor = car([{ x: 10, y: 0, v: 36, signal: 'left', signalAt: 0 }, { x: 20, y: 0, v: 36 }]);
    expect(vehicleSignalAt(actor, 5, [1, 2]).signal).toBe('left');
    (actor.path[1] as SignalWaypoint).signal = 'none';
    expect(vehicleSignalAt(actor, 5, [1, 2]).signal).toBe('none');
  });

  it('игнорирует неизвестный сигнал и не изменяет исходные команды или timestamps', () => {
    const actor = car([{ x: 10, y: 0, v: 36, signal: 'left', signalAt: 0 }]);
    actor.path.push({ x: 20, y: 0, v: 36, signal: 'unknown' } as unknown as SignalWaypoint);
    const before = structuredClone(actor);
    const arrivals = [1, 2];
    expect(vehicleSignalAt(actor, 5, arrivals).signal).toBe('left');
    expect(actor).toEqual(before);
    expect(arrivals).toEqual([1, 2]);
  });

  it('для остановившегося маршрута с нулевыми скоростями не выдумывает достижение', () => {
    const actor = car([{ x: 10, y: 0, v: 0, signal: 'hazard' }], { speed: 0 });
    expect(vehicleSignalAt(actor, 100)).toEqual({ signal: 'none', since: null, source: 'none' });
  });
});

describe('подсказки изменения направления', () => {
  it.each([
    [20, 'right'], [-20, 'left'],
  ] as const)('изменение Y на %s даёт %s без вывода о преимуществе', (y, signal) => {
    const actor = car([{ x: 20, y: 0, v: 36 }, { x: 20, y, v: 36 }]);
    const hints = suggestSignals(actor, [2, 4]);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ waypointIndex: 0, signal, maneuverTime: 2 });
    expect(hints[0].detail).toContain('не даёт преимущества');
  });

  it('без наблюдений явно указывает оценочность времени', () => {
    const hint = suggestSignals(rightTurn())[0];
    expect(hint.maneuverTime).toBe(2);
    expect(hint.detail).toContain('оценочный предпросмотр');
  });

  it('недостигнутый манёвр сохраняет null вместо оценочного времени', () => {
    const hint = suggestSignals(rightTurn(), [-1, -1])[0];
    expect(hint.maneuverTime).toBeNull();
    expect(hint.detail).toContain('не достигнута');
  });

  it('не предлагает сигнал на прямой траектории', () => {
    expect(suggestSignals(car([{ x: 20, y: 0, v: 36 }, { x: 40, y: 0, v: 36 }]))).toEqual([]);
  });

  it('смена переднего и заднего хода при неизменном курсе кузова не означает разворот', () => {
    const actor = car([{ x: 20, y: 0, v: 0 }, { x: 0, y: 0, v: -18 }]);
    expect(suggestSignals(actor)).toEqual([]);
  });

  it('непосредственный разворот без заднего хода требует левого сигнала', () => {
    const actor = car([{ x: 20, y: 0, v: 18 }, { x: 0, y: 0, v: 18 }]);
    expect(suggestSignals(actor)[0].signal).toBe('left');
  });

  it('плавное смещение в соседнюю полосу не порождает противоположный второй сигнал', () => {
    const actor = car([{ x: 10, y: 0, v: 36 }, { x: 25, y: 3.5, v: 36 }, { x: 40, y: 3.5, v: 36 }]);
    expect(suggestSignals(actor, [1, 2.5, 4])).toMatchObject([{ waypointIndex: 0, signal: 'right', maneuverTime: 1 }]);
    expect(suggestSignals(actor)).toHaveLength(1);
  });

  it('поворот при заднем ходе учитывает курс кузова', () => {
    const actor = car([{ x: -20, y: 0, v: -18 }, { x: -20, y: -20, v: -18 }], { speed: -18 });
    expect(suggestSignals(actor)[0].signal).toBe('right');
  });

  it('повторяющиеся точки не порождают NaN и дублированных подсказок', () => {
    const actor = car([{ x: 20, y: 0, v: 36 }, { x: 20, y: 0, v: 36 }, { x: 20, y: 20, v: 36 }]);
    const hints = suggestSignals(actor, [2, 2, 4]);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ waypointIndex: 0, signal: 'right', maneuverTime: 2 });
  });
});

describe('применение подсказки без скрытого гашения на промежуточном узле', () => {
  it('согласует команды только внутри окна заблаговременного включения', () => {
    const actor = car([
      { x: 10, y: 0, v: 36, signal: 'hazard', signalAt: 0 },
      { x: 20, y: 0, v: 36, signal: 'none' },
      { x: 30, y: 0, v: 36, signal: 'none' },
      { x: 30, y: 20, v: 36, signal: 'none' },
    ]);
    const hint = suggestSignals(actor, [1, 3.5, 5, 7])[0];
    expect(hint.waypointIndex).toBe(2);
    const before = structuredClone(actor);
    const updates = suggestedSignalUpdates(actor, hint, [1, 3.5, 5, 7]);
    expect(updates).toEqual([
      { waypointIndex: 1, signal: 'right', signalAt: 5 - SIGNAL_LEAD_SECONDS },
      { waypointIndex: 2, signal: 'right', signalAt: 5 - SIGNAL_LEAD_SECONDS },
    ]);
    expect(actor).toEqual(before);
    for (const update of updates) Object.assign(actor.path[update.waypointIndex], { signal: update.signal, signalAt: update.signalAt });
    expect(vehicleSignalAt(actor, 5, [1, 3.5, 5, 7])).toEqual({ signal: 'right', since: 3, source: 'explicit' });
    expect(vehicleSignalAt(actor, 7, [1, 3.5, 5, 7]).signal).toBe('none');
    expect(vehicleSignalAt(actor, 1, [1, 3.5, 5, 7]).signal).toBe('hazard');
  });

  it('окно не предшествует появлению участника на сцене', () => {
    const actor = rightTurn({ delay: 4 });
    const hint = suggestSignals(actor, [5, 7])[0];
    expect(suggestedSignalUpdates(actor, hint, [5, 7])[0].signalAt).toBe(4);
  });

  it('без момента манёвра не применяет оценочный fallback к фактическому треку', () => {
    const actor = rightTurn();
    const hint = suggestSignals(actor, [-1, -1])[0];
    expect(suggestedSignalUpdates(actor, hint, [-1, -1])).toEqual([]);
  });

  it('пользовательский ориентир дистанции включает сигнал раньше краткого временного', () => {
    const actor = car([
      { x: 10, y: 0, v: 36, signal: 'none' },
      { x: 30, y: 0, v: 36, signal: 'none' },
      { x: 30, y: 10, v: 36, signal: 'none' },
    ]);
    const hint = suggestSignals(actor, [1, 3, 4])[0];
    const updates = suggestedSignalUpdates(actor, hint, [1, 3, 4], { leadSeconds: 0.5, leadMeters: 20 });
    expect(updates.map(u => u.waypointIndex)).toEqual([0, 1]);
    expect(updates.every(u => u.signalAt === 1)).toBe(true);
    expect(hint.detail).toContain('интерполируется');
  });

  it('пользователь может отключить численные ориентиры для подсказки', () => {
    const actor = rightTurn();
    const hint = suggestSignals(actor, [2, 4])[0];
    expect(suggestedSignalUpdates(actor, hint, [2, 4], { leadSeconds: 0, leadMeters: 0 })[0].signalAt).toBe(2);
  });

  it('невалидная настройка использует ориентиры по умолчанию', () => {
    const actor = rightTurn();
    const hint = suggestSignals(actor, [2, 4])[0];
    expect(suggestedSignalUpdates(actor, hint, [2, 4], { leadSeconds: -2, leadMeters: NaN }))
      .toEqual(suggestedSignalUpdates(actor, hint, [2, 4]));
  });

  it('не выдумывает включение до появления участника при противоречивом времени', () => {
    const actor = rightTurn({ delay: 5 });
    const hint = suggestSignals(actor, [2, 4])[0];
    expect(suggestedSignalUpdates(actor, hint, [2, 4])).toEqual([]);
  });

});
