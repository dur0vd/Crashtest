import { emptyScene, type Actor, type Scene } from './scene';

const source = 'Условная учебная сцена 06.4; не натурная валидация';
function base(): Scene {
  const s = emptyScene(); s.name = 'Остановка и стоянка';
  s.env = { accidentDate: '2026-10-21T12:00', surface: 'dry', duration: 8, federalCity: 'other' };
  s.roads = [{ id: 'road', pts: [{ x: -70, y: 0 }, { x: 70, y: 0 }], lanes: 1, center: 'dashed', oneWay: false, smooth: false, zone: 'city' }];
  return s;
}
function car(s: Scene, x = 0): Actor {
  const a: Actor = { id: 'parked', kind: 'vehicle', type: 'car', x, y: 2.5, heading: 0, speed: 0, delay: 0,
    path: [], color: '#3e9bff', flags: { drunk: false, noLicense: false, flees: false },
    stopContext: { reason: 'other-voluntary', intentional: true, durationBeforeStart: 600, side: 'right', shoulderPresent: false,
      onShoulder: false, atCarriagewayEdge: true, rowFromEdge: 1, parallelToEdge: true, source } };
  s.actors.push(a); return a;
}
export const PARKING_PRESETS: { id: string; title: string; hint: string; build: () => Scene }[] = [
  { id: 'parking-yellow-bad', title: 'Стоянка у жёлтой прерывистой', hint: 'Известно 10 минут стоянки до начала. 1.10 запрещает стоянку; скорость и длина прогона не заменяют длительность.', build: () => {
    const s = base(); s.name = 'Стоянка у 1.10'; car(s); s.markings = [{ id: 'yellow', kind: '1.10', pts: [{ x: -30, y: 3.5 }, { x: 30, y: 3.5 }] }]; return s;
  } },
  { id: 'parking-yellow-good', title: 'Короткая остановка у 1.10', hint: '20 секунд до начала + 8 секунд в сцене. Запрет стоянки 1.10 не запрещает такую остановку.', build: () => {
    const s = PARKING_PRESETS[0].build(); s.name = 'Короткая остановка у 1.10'; s.actors[0].stopContext!.durationBeforeStart = 20; return s;
  } },
  { id: 'parking-crosswalk-bad', title: 'Стоянка в 4 м перед переходом', hint: 'До перехода 4 м от переднего габарита. Нарушение места не означает доказанной причинности возможного наезда.', build: () => {
    const s = base(); s.name = 'Стоянка перед переходом'; car(s, -8.25); s.crosswalks = [{ id: 'cross', x: 0, y: 0, angle: Math.PI / 2, length: 8, width: 4 }]; return s;
  } },
  { id: 'parking-crosswalk-good', title: 'Стоянка в 5 м перед переходом', hint: 'Ровно 5 м от габарита до границы перехода: запрет «ближе 5 м» не установлен.', build: () => {
    const s = PARKING_PRESETS[2].build(); s.name = 'Пять метров перед переходом'; s.actors[0].x = -9.25; return s;
  } },
  { id: 'parking-forced-bad', title: 'Поломка: аварийная выключена, треугольник в 14 м', hint: 'Вынужденная остановка в запрещённом месте. Проверки 7.1, 7.2 и 12.6 отделены от добровольной стоянки.', build: () => {
    const s = base(); s.name = 'Вынужденная остановка без предупреждения'; const a = car(s);
    a.stopContext = { reason: 'forced', durationBeforeStart: 60, stoppingProhibited: true, relocationPossible: true, relocationMeasuresTaken: false, source };
    a.path = [{ x: 0, y: 2.5, v: 0, signal: 'none', signalAt: 0 }];
    a.warningContext = { hazardAvailable: true, trianglePlaced: true, triangleDistance: 14, trianglePromptly: true, timelyWarningEnsured: false, source }; return s;
  } },
  { id: 'parking-forced-good', title: 'Поломка: аварийная и треугольник в 15 м', hint: 'Включена аварийная; треугольник выставлен незамедлительно в 15 м и своевременное предупреждение подтверждено.', build: () => {
    const s = PARKING_PRESETS[4].build(); s.name = 'Вынужденная остановка с предупреждением'; const a = s.actors[0];
    a.path[0].signal = 'hazard'; a.stopContext!.relocationMeasuresTaken = true;
    a.warningContext = { ...a.warningContext, triangleDistance: 15, timelyWarningEnsured: true }; return s;
  } },
  { id: 'parking-door-bad', title: 'Дверь создаёт помеху', hint: 'Установлена помеха от открывания двери водителем. Контакт с дверью и отдельная геометрия двери не моделируются.', build: () => {
    const s = base(); const a = car(s); a.doorContext = { opened: true, createsObstruction: true, operator: 'driver', source }; return s;
  } },
  { id: 'parking-door-good', title: 'Дверь открыта без помех', hint: 'Само открытое положение двери не доказывает нарушение 12.7.', build: () => {
    const s = PARKING_PRESETS[6].build(); s.actors[0].doorContext!.createsObstruction = false; return s;
  } },
];
