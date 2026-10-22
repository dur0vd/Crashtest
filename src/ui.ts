import { STOP_PLACE_KINDS, normalizeStopPlaces } from './stopping-model';
import { type CollisionReport, type Finding, type Report, HARM_LABEL, STATUS_LABEL } from './analysis';
import type { Editor } from './editor';
import { deg, nearestOnPolyline, rad, segIntersect } from './geom';
import { buildGeo } from './geo';
import { imgUrl, loadCorpus, resolveRef } from './corpus';
import { DISCLAIMER, lawRef, describeRef } from './law';
import { ARROW_VARIANTS, MARKINGS, MARKING_BY_ID } from './markings';
import { SIGN_GROUPS, SIGN_IDS, VALUE_SIGNS, signFile, signGroupOf, signTitle } from './signs';
import { SIGNAL_LEAD_METERS, SIGNAL_LEAD_SECONDS, suggestSignals, suggestedSignalUpdates, vehicleSignalAt } from './maneuver-signals';
import {
  type Actor,
  NO_CARGO,
  MOBILITY_SURFACES,
  type MobilityContext,
  dimsOf,
  type Road,
  type Scene,
  type VehicleType,
  PEDESTRIANS,
  SURFACES,
  VEHICLES,
  actorLabels,
  actorTitle,
} from './scene';

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'value') (el as unknown as HTMLInputElement).value = String(v);
    else if (k === 'checked') (el as unknown as HTMLInputElement).checked = !!v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export interface AppApi {
  editor: Editor;
  scene: () => Scene;
  report: () => Report | null;
  /** сообщить об изменении свойств (фиксирует точку отмены) */
  edit: (fn: () => void, rebuild?: boolean) => void;
  seek: (t: number) => void;
  focus: (id: string | null) => void;
}

// ---------------------------------------------------------------------------
// Поля форм

function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), input, hint ? h('small', {}, hint) : null);
}

function num(value: number, onChange: (v: number) => void, o: { min?: number; max?: number; step?: number; disabled?: boolean } = {}): HTMLInputElement {
  const i = h('input', { type: 'number', value: Number.isFinite(value) ? +value.toFixed(3) : 0, min: o.min, max: o.max, step: o.step ?? 1, disabled: o.disabled, inputmode: 'decimal' });
  i.addEventListener('change', () => {
    let v = parseFloat(i.value.replace(',', '.'));
    if (!Number.isFinite(v)) v = value;
    if (o.min !== undefined) v = Math.max(o.min, v);
    if (o.max !== undefined) v = Math.min(o.max, v);
    i.value = String(v);
    onChange(v);
  });
  return i;
}

function select<T extends string>(options: [T, string][], value: T, onChange: (v: T) => void): HTMLSelectElement {
  const s = h('select', {}, ...options.map(([v, l]) => h('option', { value: v, ...(v === value ? { selected: true } : {}) }, l)));
  s.value = value;
  s.addEventListener('change', () => onChange(s.value as T));
  return s;
}

function check(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const i = h('input', { type: 'checkbox', checked: value });
  i.addEventListener('change', () => onChange(i.checked));
  return h('label', { class: 'check' }, i, h('span', {}, label));
}

function optionalNumber(value: number | undefined, onChange: (value: number | undefined) => void, options: { min?: number; max?: number; step?: number } = {}): HTMLInputElement {
  const input = h('input', { type: 'number', value: value ?? '', placeholder: 'Не установлено', min: options.min, max: options.max, step: options.step ?? 0.1, inputmode: 'decimal' });
  input.addEventListener('change', () => {
    if (input.value.trim() === '') return onChange(undefined);
    const parsed = Number(input.value.replace(',', '.'));
    if (!Number.isFinite(parsed)) { input.value = value === undefined ? '' : String(value); return; }
    const next = Math.max(options.min ?? -Infinity, Math.min(options.max ?? Infinity, parsed));
    input.value = String(next);
    onChange(next);
  });
  return input;
}

function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  return h('button', { type: 'button', class: `btn ${cls}`, onclick: onClick }, label);
}

function movementFields(box: HTMLElement, label: string, values: string[], update: (next: string[]) => void, allowUturn = true): void {
  const choices = [['straight', 'Прямо'], ['right', 'Направо'], ['left', 'Налево'], ...(allowUturn ? [['uturn', 'Разворот']] : [])];
  const group = h('div', { class: 'group' }, h('h4', {}, label));
  let current = [...values];
  for (const [key, name] of choices) group.append(check(name, current.includes(key), (enabled) => {
    current = enabled ? [...new Set([...current, key])] : current.filter(v => v !== key);
    update([...current]);
  }));
  box.append(group);
}

// ---------------------------------------------------------------------------
// Свойства выбранного объекта

export function buildInspector(root: HTMLElement, app: AppApi): void {
  root.replaceChildren();
  const ed = app.editor;
  const sel = ed.sel;
  if (!sel) {
    root.append(
      h('div', { class: 'empty' },
        h('h3', {}, 'Ничего не выбрано'),
        h('p', {}, 'Выберите инструмент слева и нарисуйте дорогу, затем поставьте транспорт и пешеходов. Нажмите на объект, чтобы изменить его свойства.'),
        h('ol', { class: 'steps' },
          h('li', {}, 'Нарисуйте дорогу, тротуары, переходы, знаки и светофоры.'),
          h('li', {}, 'Поставьте участников и задайте каждому траекторию и скорость.'),
          h('li', {}, 'Нажмите ▶ — симуляция покажет, что произойдёт, а вкладка «Разбор» — как это оценивается по ПДД, КоАП и УК РФ.'),
        ),
      ),
    );
    return;
  }
  const it = ed.find(sel) as unknown as Record<string, any> | undefined;
  if (!it) return;
  const rebuild = () => buildInspector(root, app);
  const set = <T,>(fn: (v: T) => void) => (v: T) => app.edit(() => fn(v));

  const title = {
    roads: 'Дорога',
    sidewalks: 'Тротуар',
    tracks: it.kind === 'railway' ? 'Железнодорожный путь' : 'Трамвайный путь',
    crosswalks: 'Пешеходный переход',
    lights: 'Светофор',
    signs: 'Дорожный знак',
    markings: 'Дорожная разметка',
    obstacles: 'Препятствие',
    actors: it.railwayTrain ? 'Поезд' : it.kind === 'pedestrian' ? 'Пешеход' : 'Транспортное средство',
  }[sel.col];
  const box = h('div', { class: 'form' }, h('h3', {}, title));

  switch (sel.col) {
    case 'roads':
      box.append(
        field('Тип дороги', select([['road', 'Обычная дорога'], ['adjacent', 'Выезд с прилегающей территории'], ['roundabout', 'Кольцевая проезжая часть']], it.role ?? 'road', set((v) => (it.role = v)))),
        field('Примыкание и парковочные знаки', select([['ordinary', 'Обычное пересечение дорог'], ['nonterminating-minor', 'Полевое/лесное/иное второстепенное без соответствующих знаков']], it.stopZoneJunction ?? 'ordinary', set((v: string) => (it.stopZoneJunction = v))), 'По установленным данным: указанное второстепенное примыкание не прерывает зону 3.27–3.30.'),
        field('Покрытие для определения главной', select([['hard', 'Твёрдое'], ['unpaved', 'Грунтовое'], ['unknown', 'Не установлено']], it.surfacePriority ?? 'hard', set((v) => (it.surfacePriority = v))), 'Для п. 13.9; сцепление задаётся отдельно в условиях.'),
        field('Полос в каждую сторону', num(it.lanes, set((v) => (it.lanes = v)), { min: 1, max: 4 })),
        field('Разметка по оси', select([['none', 'Без разметки'], ['dashed', 'Прерывистая (1.5)'], ['solid', 'Сплошная (1.1)'], ['double', 'Двойная сплошная (1.3)']], it.center, set((v) => (it.center = v)))),
        field('Зона', select([['city', 'Населённый пункт (60)'], ['outside', 'Вне населённого пункта'], ['residential', 'Жилая зона (20)']], it.zone, set((v) => (it.zone = v)))),
        check('Одностороннее движение (по направлению рисования)', it.oneWay, (v) => {
          app.edit(() => {
            it.oneWay = v;
            if (v) it.center = 'none';
          }, true);
        }),
        field('Радиус скругления поворотов, м', num(it.radius ?? 0, set((v) => (it.radius = v)), { min: 0, max: 100, step: 1 }), '0 — острые углы. Скругление дугой по радиусу.'),
        check('Плавный сплайн (если радиус 0)', it.smooth, set((v) => (it.smooth = v))),
        button('Развернуть направление', () => app.edit(() => it.pts.reverse())),
      );
      narrowingForm(box, it as unknown as Road, app);
      roadManeuverForm(box, it as unknown as Road, app);
      routeLanesForm(box, it as unknown as Road, app, rebuild);
      break;
    case 'sidewalks':
      box.append(
        field('Назначение коридора', select(MOBILITY_SURFACES.map(k => [k, MOBILITY_LABELS[k]]), it.mobilityKind ?? 'sidewalk', (v) => app.edit(() => { it.mobilityKind = v; }, true))),
        ...(it.mobilityKind === 'cycle-lane' ? [field('Направление велополосы', select([['unknown', 'Не установлено'], ['forward', 'По направлению рисования'], ['reverse', 'Против направления рисования'], ['both', 'Оба направления (по источнику)']], it.travelDirection ?? 'unknown', value => app.edit(() => { if (value === 'unknown') delete it.travelDirection; else it.travelDirection = value; })), 'Направление полосы не наследуется автоматически от соседней проезжей части.')] : []),
        field('Источник назначения и обмера', h('input', { type: 'text', value: it.source ?? '', onchange: (e: Event) => app.edit(() => { it.source = (e.target as HTMLInputElement).value; }) }), 'Зоны задаются обмеренным коридором. Для велосипедной зоны нужен источник; номер знака автоматически зону не создаёт.'),
        field('Ширина, м', num(it.width, set((v) => (it.width = v)), { min: 1, max: 8, step: 0.5 })),
        field('Радиус скругления, м', num(it.radius ?? 0, set((v) => (it.radius = v)), { min: 0, max: 100 })),
        check('Плавный сплайн (если радиус 0)', it.smooth, set((v) => (it.smooth = v))),
      );
      break;
    case 'tracks':
      box.append(
        field('Назначение пути', select([['tram', 'Трамвайный'], ['railway', 'Железнодорожный']], it.kind ?? 'tram', (value) => app.edit(() => { it.kind = value; }, true))),
        check('Выделенный путь (отделён бордюром)', it.separated, set((v) => (it.separated = v))),
        field('Радиус скругления, м', num(it.radius ?? 0, set((v) => (it.radius = v)), { min: 0, max: 200 })),
        check('Плавный сплайн (если радиус 0)', it.smooth, set((v) => (it.smooth = v))),
        button('Развернуть направление', () => app.edit(() => it.pts.reverse())),
        h('small', {}, it.kind === 'railway' ? 'Поезд следует только железнодорожному пути. Место пересечения с дорогой и управление переездом задаются во вкладке «Среда».' : 'Направление пути важно: выезд на трамвайные пути встречного направления запрещён (п. 9.6 ПДД).'),
      );
      break;
    case 'crosswalks': {
      const lights = app.scene().lights;
      box.append(
        field('Длина поперёк дороги, м', num(it.length, set((v) => (it.length = v)), { min: 2, max: 40, step: 0.5 })),
        field('Ширина, м', num(it.width, set((v) => (it.width = v)), { min: 2, max: 10, step: 0.5 })),
        field('Направление перехода, °', num(deg(it.angle), set((v: number) => (it.angle = rad(v))), { step: 5 })),
        field(
          'Пешеходный светофор',
          select([['', 'Нет — нерегулируемый'], ...lights.map((l, i) => [l.id, `Работает вместе со светофором ${i + 1}`] as [string, string])], it.lightId ?? '', set((v: string) => (v ? (it.lightId = v) : delete it.lightId))),
          'Для обычного транспортного светофора используется противоположная фаза. У явно заданного силуэта пешехода зелёный и красный берутся непосредственно.',
        ),
      );
      break;
    }
    case 'lights':
      box.append(
        field('Управление движением', select([['vehicle', 'Транспортный светофор'], ['bicycle', 'Силуэт велосипеда'], ['pedestrian', 'Силуэт пешехода'], ['tram', 'Трамвайный светофор'], ['reversible', 'Реверсивный светофор'], ['controller', 'Регулировщик']], it.kind ?? 'vehicle', (v) => app.edit(() => { it.kind = v; if (v === 'bicycle' || v === 'pedestrian') { it.yellow = 0; it.mode = 'cycle'; delete it.mainDirections; delete it.extraSection; } }, true))),
        field(it.kind === 'controller' ? 'Направление взгляда регулировщика, °' : 'Направление движения ТС, °', num(deg(it.angle), set((v: number) => (it.angle = rad(v))), { step: 5 }), '0° — вправо, 90° — вниз'),
        field('Режим', select([['cycle', 'Работает'], ...(!it.kind || it.kind === 'vehicle' ? [['flashing-yellow', 'Мигающий жёлтый']] : []), ['off', 'Выключен']] as [string, string][], it.mode ?? 'cycle', set((v) => (it.mode = v)))),
        check('Есть стоп-линия / знак 6.16', it.stopLine !== false, set((v) => (it.stopLine = v))),
        field('Длина стоп-линии, м', num(it.lineLength, set((v) => (it.lineLength = v)), { min: 2, max: 30, step: 0.5 })),
        ...(!it.kind || ['vehicle', 'bicycle', 'pedestrian'].includes(it.kind) ? [
          field('Зелёный, с', num(it.green, set((v) => (it.green = v)), { min: 1, max: 120 })),
          field('Жёлтый, с', num(it.yellow, set((v) => (it.yellow = v)), { min: it.kind === 'bicycle' || it.kind === 'pedestrian' ? 0 : 1, max: 10 })),
          field('Красный, с', num(it.red, set((v) => (it.red = v)), { min: 1, max: 120 })),
          field('Сдвиг цикла, с', num(it.offset, set((v) => (it.offset = v)), { min: 0, max: 240 }), 'Чтобы встречные направления горели по очереди.'),
        ] : []),
      );
      if (it.kind === 'controller') {
        box.append(field('Жест', select([['arms-out', 'Руки в стороны или опущены'], ['right-arm-forward', 'Правая рука вытянута вперёд'], ['arm-up', 'Рука поднята вверх'], ['stop', 'Адресное требование остановки (6.11)']], it.controllerGesture ?? 'arms-out', (v) => app.edit(() => (it.controllerGesture = v), true))),
          h('small', {}, 'Жест и положение регулировщика определяют разрешённые направления по п. 6.10.'));
        if (it.controllerGesture === 'stop') box.append(field('Направление подъезда, которому адресована остановка, °', num(deg(it.controllerTargetHeading ?? it.angle + Math.PI), set((v: number) => (it.controllerTargetHeading = rad(v))), { step: 5 }), 'Курс приближающегося ТС. Направление взгляда регулировщика задаётся отдельно.'));
      } else if (it.kind === 'reversible') {
        box.append(field('Реверсивный сигнал', select([['green', 'Зелёная стрелка вниз'], ['yellow', 'Жёлтая диагональная стрелка'], ['red', 'Красный крест']], it.reversibleState ?? 'green', set((v) => (it.reversibleState = v)))));
      } else if (it.kind === 'tram') {
        movementFields(box, 'Разрешённые трамвайные направления', it.tramDirections ?? [], (v) => app.edit(() => (it.tramDirections = v)), false);
      } else if (it.kind !== 'bicycle' && it.kind !== 'pedestrian') {
        box.append(check('Стрелки на основном сигнале', !!it.mainDirections, (v) => app.edit(() => { it.mainDirections = v ? ['straight'] : undefined; }, true)));
        if (it.mainDirections) movementFields(box, 'Основной сигнал', it.mainDirections, (v) => app.edit(() => (it.mainDirections = v)));
        box.append(check('Дополнительная секция', !!it.extraSection, (v) => app.edit(() => { it.extraSection = v ? { directions: ['right'], on: false } : undefined; }, true)));
        if (it.extraSection) {
          movementFields(box, 'Стрелки дополнительной секции', it.extraSection.directions, (v) => app.edit(() => (it.extraSection.directions = v)));
          box.append(check('Дополнительная секция включена', it.extraSection.on, set((v) => (it.extraSection.on = v))),
            h('small', {}, 'При стрелке вместе с красным или жёлтым необходимо уступить движущимся с других направлений (п. 13.5).'));
        }
      }
      break;
    case 'signs': {
      const vs = VALUE_SIGNS[it.kind];
      box.append(
        h('div', { class: 'sign-current' },
          signThumb(it.kind, 56),
          h('div', {}, h('b', {}, `Знак ${it.kind}`), h('div', { class: 'note' }, signTitle(it.kind))),
        ),
        h('div', { class: 'row' },
          button('Выбрать другой знак', () => openSignPicker({ current: it.kind, onPick: (id) => app.edit(() => { it.kind = id; const v = VALUE_SIGNS[id]; if (v) it.value = it.value ?? v.def; else delete it.value; }, true) })),
          button('Что это за знак?', () => openRefInReference(`sign:${it.kind}`)),
        ),
        ...(vs ? [field(`${vs.label}, ${vs.unit}`, num(it.value ?? vs.def, set((v) => (it.value = v)), { min: vs.min, max: vs.max, step: vs.step }))] : []),
        field('Направление движения, °', num(deg(it.angle), set((v: number) => (it.angle = rad(v))), { step: 5 }), 'Знак действует для ТС, едущих в этом направлении.'),
      );
      const plates = h('div', { class: 'group' }, h('h4', {}, 'Таблички'));
      const list: string[] = it.plates ?? [];
      for (const pl of list) {
        plates.append(h('div', { class: 'plate-row' }, signThumb(pl, 34), h('span', {}, `${pl} ${signTitle(pl)}`), h('button', { type: 'button', class: 'x', title: 'Убрать', onclick: () => app.edit(() => { it.plates = list.filter((x) => x !== pl); if (!it.plates.length) delete it.plates; }, true) }, '✕')));
      }
      plates.append(button('Добавить табличку', () => openSignPicker({ only: '8', onPick: (id) => app.edit(() => { it.plates = [...list, id]; }, true) })));
      if (list.some(p => ['8.2.1', '8.2.2'].includes(p))) plates.append(field('Зона действия, м', optionalNumber(it.zoneLen, set((v: number | undefined) => (it.zoneLen = v)), { min: 0, step: 1 })));
      if (list.includes('8.13') || it.kind === '8.13') {
        const directions = h('input', { type: 'text', value: (it.mainDirections ?? []).map((a: number) => +deg(a).toFixed(1)).join('; '), placeholder: '0; 270' });
        directions.addEventListener('change', () => {
          const values = directions.value.split(';').map((v) => Number(v.trim().replace(',', '.')));
          if (directions.value.trim() && values.length >= 2 && values.every(Number.isFinite)) {
            directions.setCustomValidity('');
            app.edit(() => (it.mainDirections = values.map(rad)));
          } else {
            directions.setCustomValidity('Укажите не менее двух направлений въезда в градусах, разделяя точкой с запятой.');
            directions.reportValidity();
          }
        });
        plates.append(field('Въезды главной дороги, °', directions, 'Курсы движения к перекрёстку: 0° — вправо, 90° — вниз. Например: 0; 270.'));
      }
      box.append(plates);
      if (['3.27', '3.28', '3.29', '3.30'].includes(it.kind)) stoppingSignForm(box, it as Scene['signs'][number], app);
      break;
    }
    case 'markings': {
      const spec = MARKING_BY_ID[it.kind];
      box.append(
        h('div', { class: 'sign-current' }, h('div', {}, h('b', {}, `Разметка ${it.kind}`), h('div', { class: 'note' }, spec?.name ?? ''))),
        field('Вид', select(MARKINGS.map((m) => [m.id, `${m.id} ${m.name}`] as [string, string]), it.kind, (v) => app.edit(() => (it.kind = v), true))),
        ...(spec?.arrows ? [field('Стрела', select(Object.entries(ARROW_VARIANTS).map(([k, v]) => [k, v.name] as [string, string]), it.variant ?? 'straight', set((v: string) => (it.variant = v))))] : []),
        ...(spec?.oneSide ? [check('Сплошная линия справа по ходу рисования', it.solidRight !== false, set((v) => (it.solidRight = v)))] : []),
        ...(spec?.form === 'line' ? [field('Радиус скругления, м', num(it.radius ?? 0, set((v) => (it.radius = v)), { min: 0, max: 100 }))] : []),
        ...(spec?.form === 'symbol' ? [field('Направление, °', num(deg(it.angle ?? 0), set((v: number) => (it.angle = rad(v))), { step: 5 }))] : []),
        button('Что это за разметка?', () => openRefInReference(`marking:${it.kind}`)),
      );
      break;
    }
    case 'obstacles':
      box.append(
        field('Тип', select([['building', 'Здание'], ['fence', 'Забор'], ['tree', 'Дерево'], ['barrier', 'Барьер']], it.kind, set((v) => (it.kind = v)))),
        field('Длина, м', num(it.w, set((v) => (it.w = v)), { min: 0.3, max: 80, step: 0.5 })),
        field('Ширина, м', num(it.h, set((v) => (it.h = v)), { min: 0.3, max: 80, step: 0.5 })),
        field('Поворот, °', num(deg(it.angle), set((v: number) => (it.angle = rad(v))), { step: 5 })),
      );
      break;
    case 'actors':
      actorForm(box, it as unknown as Actor, app, rebuild);
      break;
  }

  box.append(h('div', { class: 'row' }, button('Дублировать', () => ed.duplicateSelection()), button('Удалить', () => ed.deleteSelection(), 'danger')));
  root.append(box);
}

/** Сужения и расширения: точки профиля левой и правой кромок. */
function narrowingForm(box: HTMLElement, road: Road, app: AppApi): void {
  const ed = app.editor;
  const group = h('div', { class: 'group' }, h('h4', {}, 'Сужения и кромки'));
  group.append(
    h('div', { class: 'row' },
      button('Сузить справа', () => app.edit(() => ed.addNarrowing(road, ['r']), true)),
      button('Сузить слева', () => app.edit(() => ed.addNarrowing(road, ['l']), true)),
      button('Сузить с двух сторон', () => app.edit(() => ed.addNarrowing(road, ['l', 'r']), true)),
    ),
    h('small', {}, 'Кромки (оранжевая — левая, бирюзовая — правая) можно гнуть: потяните точку на кромке. Двойной клик по кромке добавляет точку, по точке — удаляет. Сужение любой длины получается из нескольких точек.'),
  );
  const rows: { side: 'l' | 'r'; pt: { s: number; w: number } }[] = [];
  for (const e of road.wl ?? []) rows.push({ side: 'l', pt: e });
  for (const e of road.wr ?? []) rows.push({ side: 'r', pt: e });
  if (rows.length) {
    const table = h('table', { class: 'wp' }, h('tr', {}, h('th', {}, 'Кромка'), h('th', {}, 'от начала, м'), h('th', {}, 'от оси, м'), h('th', {})));
    for (const r of rows) {
      table.append(
        h('tr', {},
          h('td', {}, r.side === 'l' ? 'левая' : 'правая'),
          h('td', {}, num(r.pt.s, (v) => app.edit(() => ((r.pt.s = v), (r.side === 'l' ? road.wl : road.wr)?.sort((a, b) => a.s - b.s)), true), { min: 0, step: 0.5 })),
          h('td', {}, num(r.pt.w, (v) => app.edit(() => (r.pt.w = v)), { min: 0.8, max: 40, step: 0.1 })),
          h('td', {}, h('button', { type: 'button', class: 'x', title: 'Удалить точку', onclick: () => app.edit(() => {
            const key = r.side === 'l' ? 'wl' : 'wr';
            road[key] = (road[key] ?? []).filter((e) => e !== r.pt);
          }, true) }, '✕')),
        ),
      );
    }
    group.append(table, h('div', { class: 'row' }, button('Вернуть постоянную ширину', () => app.edit(() => { delete road.wl; delete road.wr; }, true))));
  }
  box.append(group);
}

/** Груз: масса, свесы, высота и признаки соблюдения раздела 23 ПДД. */
function cargoForm(box: HTMLElement, a: Actor, app: AppApi): void {
  const vs = VEHICLES[a.type as VehicleType];
  const g = h('div', { class: 'group' }, h('h4', {}, 'Груз'));
  g.append(
    check('Перевозит груз', !!a.cargo, (v) =>
      app.edit(() => {
        if (v) a.cargo = { ...NO_CARGO, mass: Math.min(500, vs.payload || 500), height: vs.height };
        else delete a.cargo;
      }, true),
    ),
  );
  const c = a.cargo;
  if (c) {
    const set = <T,>(fn: (v: T) => void) => (v: T) => app.edit(() => fn(v), true);
    const d = dimsOf(a);
    g.append(
      field('Масса груза, кг', num(c.mass, set((v) => (c.mass = v)), { min: 0, max: 60000, step: 50 })),
      field('Выступ спереди, м', num(c.front, set((v) => (c.front = v)), { min: 0, max: 15, step: 0.1 })),
      field('Выступ сзади, м', num(c.rear, set((v) => (c.rear = v)), { min: 0, max: 15, step: 0.1 })),
      field('Выступ слева, м', num(c.left, set((v) => (c.left = v)), { min: 0, max: 4, step: 0.1 })),
      field('Выступ справа, м', num(c.right, set((v) => (c.right = v)), { min: 0, max: 4, step: 0.1 })),
      field('Высота с грузом, м', num(c.height, set((v) => (c.height = v)), { min: 0.5, max: 6, step: 0.1 })),
      check('Знаки «Крупногабаритный груз» нанесены', c.marked, set((v) => (c.marked = v))),
      check('Груз надёжно закреплён', c.secured, set((v) => (c.secured = v))),
      check('Груз закрывает обзор, огни или номер', c.blocksView, set((v) => (c.blocksView = v))),
      check('Опасный груз', c.dangerous, set((v) => (c.dangerous = v))),
      h('small', {}, `С грузом: ${d.length.toFixed(1)} × ${d.width.toFixed(2)} × ${d.height.toFixed(1)} м, масса ${(d.mass / 1000).toFixed(1)} т. Допустимая нагрузка ТС — ${vs.payload} кг (п. 23.1).`),
    );
  }
  box.append(g);
}

function roadManeuverForm(box: HTMLElement, road: Road, app: AppApi): void {
  const group = h('details', { class: 'group' }, h('summary', {}, 'Особенности участка для манёвров и обгона'),
    h('small', {}, 'Отмечайте подтверждённые особенности именно этого участка. Для отдельного моста, переезда или полосы задайте отдельный участок дороги.'));
  group.append(field('Роль полосы', select([['ordinary', 'Обычная'], ['acceleration', 'Полоса разгона'], ['deceleration', 'Полоса торможения']], road.laneRole ?? 'ordinary', value => app.edit(() => { road.laneRole = value; }))),
    field('Установленная видимость дороги, м', optionalNumber(road.visibility, value => app.edit(() => { road.visibility = value; }), { min: 0, max: 10000, step: 1 }), 'Не заполняйте, если дальность не установлена.'));
  const features: [NonNullable<Road['features']>[number], string][] = [
    ['bridge', 'Мост, путепровод, эстакада или участок под ними'],
    ['tunnel', 'Тоннель'],
    ['railway-crossing', 'Железнодорожный переезд'],
    ['limited-visibility', 'Ограниченная видимость, менее 100 м'],
    ['stop-area', 'Место остановки маршрутного транспорта'],
    ['motorway', 'Автомагистраль'],
  ];
  for (const [feature, label] of features) group.append(check(label, !!road.features?.includes(feature), enabled => app.edit(() => {
    road.features = enabled ? [...new Set([...(road.features ?? []), feature])] : (road.features ?? []).filter(value => value !== feature);
  })));
  box.append(group);
}

function routeLanesForm(box: HTMLElement, road: Road, app: AppApi, rebuild: () => void): void {
  type Lane = NonNullable<Road['routeLanes']>[number];
  const geometry = buildGeo(app.scene()).roads.find(item => item.road.id === road.id);
  const total = geometry?.total ?? 0;
  const signs = app.scene().signs.filter(sign => ['5.14', '5.14.1', '5.14.3', '5.11.1', '5.13.1', '5.13.2'].includes(sign.kind));
  const group = h('details', { class: 'group' }, h('summary', {}, 'Полосы для маршрутных ТС'),
    h('p', { class: 'note' }, 'Задайте измеренные границы полосы и свяжите её со знаками. Одна разметка 1.23.1 не подтверждает все условия выделенной полосы.'),
    h('small', {}, `Длина оси дороги: ${total.toFixed(1)} м. Смещение вправо от направления рисования положительное, влево — отрицательное.`));
  const signFields = (host: HTMLElement, ids: string[], update: (next: string[]) => void): void => {
    let current = [...ids];
    host.append(h('h4', {}, 'Связанные знаки начала и конца выделенной полосы'));
    host.append(h('small', {}, 'Привяжите обозначение начала или направления полосы; при наличии добавьте знак конца 5.14.3. Один знак конца не подтверждает наличие выделенной полосы.'));
    if (!signs.length) host.append(h('small', {}, 'На карте пока нет подходящих знаков. Добавьте знак 5.14/5.14.1, 5.14.3, 5.11.1 или 5.13.1/5.13.2.'));
    for (const sign of signs) host.append(check(`${sign.kind} · ${signTitle(sign.kind)} (${sign.id})`, current.includes(sign.id), enabled => {
      current = enabled ? [...new Set([...current, sign.id])] : current.filter(id => id !== sign.id);
      update([...current]);
    }));
    if (ids.some(id => !signs.some(sign => sign.id === id))) host.append(h('small', {}, 'Часть связанных знаков отсутствует или имеет другой вид; проверьте исходные данные.'));
  };
  for (const [index, lane] of (road.routeLanes ?? []).entries()) {
    const panel = h('details', { class: 'group' }, h('summary', {}, `Выделенная полоса ${index + 1} (${lane.id})`));
    const note = h('p', { class: 'note', role: 'status' });
    let fromInput: HTMLInputElement;
    let toInput: HTMLInputElement;
    const position = (key: 'fromS' | 'toS', value: number): void => {
      const from = key === 'fromS' ? value : lane.fromS, to = key === 'toS' ? value : lane.toS;
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || to > total + 0.05) {
        fromInput.value = String(lane.fromS);
        toInput.value = String(lane.toS);
        note.textContent = 'Начало и конец должны находиться на оси дороги; конец должен быть дальше начала.';
        return;
      }
      app.edit(() => { lane[key] = value; });
      note.textContent = '';
    };
    fromInput = num(lane.fromS, value => position('fromS', value), { min: 0, max: total, step: 0.1 });
    toInput = num(lane.toS, value => position('toS', value), { min: 0, max: total, step: 0.1 });
    panel.append(
      field('Начало выделенной полосы от начала оси, м', fromInput),
      field('Конец выделенной полосы от начала оси, м', toInput),
      field('Смещение центра выделенной полосы от оси, м', num(lane.offset, value => app.edit(() => { lane.offset = value; }), { step: 0.1 })),
      field('Измеренная ширина выделенной полосы, м', num(lane.width, value => app.edit(() => { lane.width = value; }), { min: 0.01, step: 0.1 })),
      field('Направление на выделенной полосе', select([['forward', 'По направлению рисования дороги'], ['reverse', 'Против направления рисования дороги']], lane.direction, value => app.edit(() => { lane.direction = value; }))),
      field('Граница выделенной полосы', select([['unknown', 'Не установлена'], ['dashed', 'Прерывистая'], ['solid', 'Сплошная']], lane.boundary ?? 'unknown', value => app.edit(() => { if (value === 'unknown') delete lane.boundary; else lane.boundary = value; }))),
      field('Выделенная полоса является крайней правой', select([['unknown', 'Не установлено'], ['yes', 'Да'], ['no', 'Нет']], lane.rightmost === true ? 'yes' : lane.rightmost === false ? 'no' : 'unknown', value => app.edit(() => { if (value === 'unknown') delete lane.rightmost; else lane.rightmost = value === 'yes'; }))),
      field('Источник геометрии и обозначения выделенной полосы', h('textarea', { rows: 2, value: lane.source ?? '', onchange: (event: Event) => app.edit(() => { lane.source = (event.target as HTMLTextAreaElement).value.trim() || undefined; }) })),
      note,
    );
    signFields(panel, lane.signIds, ids => app.edit(() => { lane.signIds = ids; }));
    panel.append(button('Удалить выделенную полосу', () => { app.edit(() => { road.routeLanes = (road.routeLanes ?? []).filter(item => item.id !== lane.id); }); rebuild(); }));
    group.append(panel);
  }
  let fromS: number | undefined, toS: number | undefined, offset: number | undefined, width: number | undefined;
  let direction: Lane['direction'] = 'forward';
  let signIds: string[] = [];
  const source = h('textarea', { rows: 2, placeholder: 'Схема, измерения, установленные знаки; для учебных данных укажите условность' });
  const note = h('p', { class: 'note', role: 'status' });
  const draft = h('details', { class: 'group' }, h('summary', {}, 'Добавить выделенную полосу'),
    field('Начало новой выделенной полосы, м', optionalNumber(undefined, value => { fromS = value; }, { min: 0, max: total, step: 0.1 })),
    field('Конец новой выделенной полосы, м', optionalNumber(undefined, value => { toS = value; }, { min: 0, max: total, step: 0.1 })),
    field('Смещение центра новой выделенной полосы, м', optionalNumber(undefined, value => { offset = value; }, { step: 0.1 })),
    field('Ширина новой выделенной полосы, м', optionalNumber(undefined, value => { width = value; }, { min: 0.01, step: 0.1 })),
    field('Направление новой выделенной полосы', select([['forward', 'По направлению рисования дороги'], ['reverse', 'Против направления рисования дороги']], direction, value => { direction = value; })),
    field('Источник новой выделенной полосы', source),
  );
  signFields(draft, signIds, ids => { signIds = ids; });
  draft.append(note, button('Добавить выделенную полосу', () => {
    if (![fromS, toS, offset, width].every(value => typeof value === 'number' && Number.isFinite(value))
      || fromS! < 0 || toS! <= fromS! || toS! > total + 0.05 || width! <= 0 || !source.value.trim()) {
      note.textContent = 'Укажите начало, конец, смещение, положительную ширину и источник. Конец должен быть дальше начала и в пределах оси дороги.';
      return;
    }
    app.edit(() => {
      const lanes = road.routeLanes ??= [];
      const ids = new Set(lanes.map(lane => lane.id));
      let number = lanes.length + 1;
      while (ids.has(`${road.id}-route-lane-${number}`)) number++;
      lanes.push({ id: `${road.id}-route-lane-${number}`, fromS: fromS!, toS: toS!, offset: offset!, width: width!, direction, signIds: [...signIds], source: source.value.trim() });
    });
    rebuild();
  }));
  group.append(draft);
  box.append(group);
}

function maneuverContextForm(box: HTMLElement, a: Actor, app: AppApi): void {
  type Context = NonNullable<Actor['maneuverContext']>;
  const group = h('details', { class: 'group' }, h('summary', {}, 'Установленные обстоятельства манёвра'),
    h('small', {}, '«Не установлено» сохраняет неопределённость. Выбирайте «Да» или «Нет» только по исходным материалам. Эти обстоятельства сами по себе не устанавливают нарушение или причинную связь.'));
  const facts: [Exclude<keyof Context, 'handSignal'>, string][] = [
    ['longVehicleException', 'Установлены габаритные причины отступления от крайнего положения'],
    ['cannotKeepExtreme', 'Установлены иные причины невозможности поворота из крайнего положения'],
    ['expectedStraight', 'Участник исходил из прямолинейного движения другого ТС'],
    ['oncomingClear', 'Встречная полоса свободна на достаточном расстоянии'],
    ['overtakeReturnClear', 'Установлена возможность безопасного возвращения после обгона'],
    ['overtakenAccelerates', 'Обгоняемое ТС повышало скорость во время обгона'],
    ['opposingObstacle', 'На стороне участника имеется препятствие встречному разъезду'],
    ['steepSlope', 'Затруднённый разъезд происходит на уклоне'],
    ['slopeDownhill', 'Участник движется на спуск'],
    ['overtakingDifficult', 'Обгон или опережение следующими ТС затруднены'],
    ['keptRight', 'Участник принял возможно правее, чтобы пропустить следующие ТС'],
    ['yieldedByStop', 'Участник остановился, чтобы пропустить следующие ТС'],
    ['indicatorsUnavailable', 'Световые указатели отсутствуют или неисправны'],
  ];
  for (const [key, label] of facts) group.append(field(label, select([['unknown', 'Не установлено'], ['yes', 'Да'], ['no', 'Нет']], a.maneuverContext?.[key] === true ? 'yes' : a.maneuverContext?.[key] === false ? 'no' : 'unknown', value => app.edit(() => {
    const context = a.maneuverContext ??= {};
    if (value === 'unknown') delete context[key];
    else context[key] = value === 'yes';
  }))));
  group.append(field('Установленный сигнал рукой', select([['unknown', 'Не установлено'], ['none', 'Сигнал рукой не подавался'], ['left', 'Левый поворот / разворот'], ['right', 'Правый поворот'], ['stop', 'Торможение']], a.maneuverContext?.handSignal ?? 'unknown', value => app.edit(() => {
    const context = a.maneuverContext ??= {};
    if (value === 'unknown') delete context.handSignal;
    else context.handSignal = value;
  })), 'Сигнал рукой допустим при отсутствии или неисправности световых указателей (п. 8.1).'));
  box.append(group);
}

/** Параметры поезда задаются целиком: неподтверждённого «типового состава» нет. */
function railwayTrainForm(box: HTMLElement, a: Actor, app: AppApi): void {
  const train = a.railwayTrain;
  const group = h('details', { class: 'group', open: !!train }, h('summary', {}, train ? 'Параметры поезда' : 'Задать железнодорожный поезд'),
    h('p', { class: 'note' }, 'Введите массу всего состава, габариты и установленное замедление по исходным материалам. Трамвайные параметры не подставляются. Это упрощённое движение по колее; проверьте применимость постоянного замедления.'));
  let mass = train?.mass;
  let length = train?.length;
  let width = train?.width;
  let brakeDecel = train?.brakeDecel;
  let trackId = train?.trackId;
  const source = h('textarea', { rows: 3, value: train?.source ?? '', placeholder: 'Документ, измерение, страница; для учебных данных — явно указать условность' });
  const note = h('p', { class: 'note', role: 'status' });
  const railwayTracks = app.scene().tracks.filter(track => track.kind === 'railway');
  group.append(
    field('Масса состава, кг', optionalNumber(mass, value => { mass = value; }, { min: 0.001, step: 100 })),
    field('Длина состава, м', optionalNumber(length, value => { length = value; }, { min: 0.001, step: 0.1 })),
    field('Ширина состава, м', optionalNumber(width, value => { width = value; }, { min: 0.001, step: 0.01 })),
    field('Установленное замедление поезда, м/с²', optionalNumber(brakeDecel, value => { brakeDecel = value; }, { min: 0.001, step: 0.01 })),
    field('Источник параметров поезда', source),
    field('Железнодорожный путь поезда', select([['', 'Ближайший железнодорожный путь'], ...railwayTracks.map((track, index) => [track.id, `Железнодорожный путь ${index + 1} (${track.id})`] as [string, string])], trackId ?? '', value => { trackId = value || undefined; })),
    note,
    button(train ? 'Применить параметры поезда' : 'Применить как поезд', () => {
      if (![mass, length, width, brakeDecel].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0) || !source.value.trim()) {
        note.textContent = 'Заполните четыре положительных параметра и укажите их источник. Для учебного примера обозначьте данные как условные.';
        return;
      }
      const trackGeometry = buildGeo(app.scene()).tracks.filter(track => track.item.kind === 'railway' && (!trackId || track.item.id === trackId));
      if (!trackGeometry.some(track => track.pts.length >= 2 && nearestOnPolyline(track.pts, a).dist < 4)) {
        note.textContent = 'Нарисуйте железнодорожный путь и поставьте участника ближе 4 м к выбранному пути. Назначение пути меняется в его свойствах.';
        return;
      }
      app.edit(() => {
        a.railwayTrain = { mass: mass!, length: length!, width: width!, brakeDecel: brakeDecel!, source: source.value.trim(), ...(trackId ? { trackId } : {}) };
        delete a.derail;
      }, true);
    }),
  );
  if (train) group.append(button('Вернуть режим трамвая', () => app.edit(() => { delete a.railwayTrain; }, true)));
  box.append(group);
}

function railwayContextForm(box: HTMLElement, a: Actor, app: AppApi): void {
  type Context = NonNullable<Actor['railwayContext']>;
  const group = h('details', { class: 'group' }, h('summary', {}, 'Установленные обстоятельства на переезде'),
    h('small', {}, 'Отсутствие сведений сохраняется как «Не установлено». Вынужденная остановка оценивается отдельно от запрещённой остановки.'));
  group.append(field('Переезд для этих обстоятельств', select([['', 'Не указан'], ...(app.scene().railwayCrossings ?? []).map((crossing, index) => [crossing.id, `Переезд ${index + 1} (${crossing.id})`] as [string, string])], a.railwayContext?.crossingId ?? '', value => app.edit(() => {
    const context = a.railwayContext ??= {};
    if (value) context.crossingId = value;
    else delete context.crossingId;
  }))));
  const facts: [Exclude<keyof Context, 'crossingId' | 'stopMessengers'>, string][] = [
    ['bypassingWaitingQueue', 'Объезжает ожидающие ТС с выездом на встречную полосу'],
    ['openedBarrier', 'Самовольно открывал шлагбаум'],
    ['machineryTransportPosition', 'Сельскохозяйственная или строительная машина в транспортном положении'],
    ['slowMachinery', 'Конструктивная скорость машины менее 8 км/ч'],
    ['tractorSledge', 'Тракторные сани-волокуши'],
    ['trackAuthorityPermission', 'Имеется разрешение начальника дистанции пути'],
    ['forcedStop', 'Остановка на переезде является вынужденной'],
    ['passengersDisembarked', 'Люди немедленно высажены из ТС'],
    ['clearingCrossing', 'Принимаются меры для освобождения переезда'],
    ['messengersPossible', 'Имелась возможность направить людей вдоль путей'],
    ['stayedByVehicle', 'Водитель остался возле ТС'],
    ['generalAlarm', 'Подаётся сигнал общей тревоги'],
    ['trainStopSignal', 'При приближении поезда подан сигнал остановки навстречу ему'],
  ];
  for (const [key, label] of facts) group.append(field(label, select([['unknown', 'Не установлено'], ['yes', 'Да'], ['no', 'Нет']], a.railwayContext?.[key] === true ? 'yes' : a.railwayContext?.[key] === false ? 'no' : 'unknown', value => app.edit(() => {
    const context = a.railwayContext ??= {};
    if (value === 'unknown') delete context[key];
    else context[key] = value === 'yes';
  }))));
  group.append(field('Люди с сигналом остановки в 1000 м от переезда', select([['unknown', 'Не установлено'], ['both', 'В обе стороны пути'], ['worse-visibility', 'В сторону худшей видимости (один человек)'], ['none', 'Не направлялись']], a.railwayContext?.stopMessengers ?? 'unknown', value => app.edit(() => {
    const context = a.railwayContext ??= {};
    if (value === 'unknown') delete context.stopMessengers;
    else context.stopMessengers = value;
  })), 'П. 15.5: при имеющейся возможности; людям объясняют правила подачи сигнала остановки.'));
  box.append(group);
}

function specialSignalsForm(box: HTMLElement, a: Actor, app: AppApi): void {
  type Signals = NonNullable<Actor['specialSignals']>;
  type Interaction = NonNullable<Actor['specialInteractions']>[number];
  const group = h('details', { class: 'group' }, h('summary', {}, 'Специальные сигналы'),
    h('p', { class: 'note' }, 'Преимущество по п. 3.1–3.2 требует синего маячка и специального звукового сигнала. Сам по себе синий маячок без звука преимущества не даёт; жёлтый и оранжевый маячки преимущества не дают. Требования регулировщика сохраняют силу.'),
    h('small', {}, 'Отступление по п. 3.1 связано с неотложным заданием и обеспечением безопасности. «Не установлено» сохраняет неопределённость; отмечайте обстоятельства по исходным материалам.'));
  group.append(field('Проблесковый маячок', select([['unknown', 'Не установлено'], ['none', 'Не включён'], ['blue', 'Синий'], ['blue-red', 'Синий и красный'], ['yellow', 'Жёлтый'], ['orange', 'Оранжевый'], ['white', 'Бело-лунный']], a.specialSignals?.beacon ?? 'unknown', value => app.edit(() => {
    const signals = a.specialSignals ??= { beacon: 'unknown' };
    signals.beacon = value;
  }))));
  group.append(field('Основание для жёлтого или оранжевого маячка', select([
    ['unknown', 'Не установлено'],
    ['road-work', 'Дорожные работы'],
    ['recovery', 'Эвакуация ТС'],
    ['oversized', 'Движение крупногабаритного ТС'],
    ['high-danger-cargo', 'Перевозка груза повышенной опасности'],
    ['heavy-sign-exemption', 'Тяжеловесное ТС с предусмотренным исключением по знакам'],
    ['oversize-escort', 'Сопровождение крупногабаритного или тяжеловесного ТС'],
    ['dangerous-escort', 'Сопровождение ТС с опасным грузом'],
    ['cycling-training-escort', 'Сопровождение тренировки велосипедистов'],
    ['children-group', 'Организованная перевозка группы детей'],
  ], a.specialSignals?.warningReason ?? 'unknown', value => app.edit(() => {
    const signals = a.specialSignals ??= { beacon: 'unknown' };
    if (value === 'unknown') delete signals.warningReason;
    else signals.warningReason = value;
  })), 'Повышенная опасность груза устанавливается отдельно; отметка об опасном грузе сама по себе её не подтверждает.'));
  const facts: [Exclude<keyof Signals, 'beacon' | 'warningReason'>, string][] = [
    ['siren', 'Специальный звуковой сигнал включён'],
    ['urgentDuty', 'Выполняется неотложное служебное задание'],
    ['colorScheme', 'Имеется специальная цветографическая схема'],
    ['safetyEnsured', 'Безопасность отступления от правил обеспечена'],
  ];
  for (const [key, label] of facts) group.append(field(label, select([['unknown', 'Не установлено'], ['yes', 'Да'], ['no', 'Нет']], a.specialSignals?.[key] === true ? 'yes' : a.specialSignals?.[key] === false ? 'no' : 'unknown', value => app.edit(() => {
    const signals = a.specialSignals ??= { beacon: 'unknown' };
    if (value === 'unknown') delete signals[key];
    else signals[key] = value === 'yes';
  }))));
  const labels = actorLabels(app.scene());
  for (const other of app.scene().actors.filter(actor => actor.id !== a.id && actor.kind === 'vehicle' && !actor.railwayTrain)) {
    const interaction = a.specialInteractions?.find(item => item.otherId === other.id);
    const pair = h('details', { class: 'group' }, h('summary', {}, `В отношении ${actorTitle(other, labels)}`));
    const pairFacts: [Exclude<keyof Interaction, 'otherId'>, string][] = [
      ['yielded', 'Уступил этому участнику'],
      ['yieldingVerified', 'Убедился, что этот участник уступает'],
      ['beaconVisible', 'Маячок этого участника был виден'],
      ['immediateStopPossible', 'Мог немедленно остановиться при приближении к стоящему с маячком'],
      ['organizedMovementObstructed', 'Движением рядом с той же скоростью создаёт помеху организованному движению этого ТС'],
    ];
    for (const [key, label] of pairFacts) pair.append(field(label, select([['unknown', 'Не установлено'], ['yes', 'Да'], ['no', 'Нет']], interaction?.[key] === true ? 'yes' : interaction?.[key] === false ? 'no' : 'unknown', value => app.edit(() => {
      const interactions = a.specialInteractions ??= [];
      let current = interactions.find(item => item.otherId === other.id);
      if (!current && value !== 'unknown') { current = { otherId: other.id }; interactions.push(current); }
      if (!current) return;
      if (value === 'unknown') delete current[key];
      else current[key] = value === 'yes';
      if (Object.keys(current).length === 1) a.specialInteractions = interactions.filter(item => item !== current);
    }))));
    group.append(pair);
  }
  box.append(group);
}

function routeContextForm(box: HTMLElement, a: Actor, app: AppApi): void {
  type Context = NonNullable<Actor['routeContext']>;
  const group = h('details', { class: 'group' }, h('summary', {}, 'Маршрутный транспорт и выделенные полосы'),
    h('p', { class: 'note' }, 'Тип «Автобус» сам по себе не подтверждает регулярный маршрут. Отмечайте известные обстоятельства по исходным материалам; «Не установлено» не означает «Нет».'));
  const set = <K extends keyof Context>(key: K, value: Context[K]): void => app.edit(() => {
    if (value === undefined) { if (a.routeContext) delete a.routeContext[key]; }
    else (a.routeContext ??= {})[key] = value;
    if (a.routeContext && !Object.keys(a.routeContext).length) delete a.routeContext;
  });
  const facts: [keyof Pick<Context, 'regularService' | 'schoolBus' | 'taxi' | 'regionalBusLaneEligible' | 'depotExit' | 'routeVehiclesUnimpeded'>, string][] = [
    ['regularService', 'Выполняет регулярный маршрут с обозначенными остановками'],
    ['schoolBus', 'Школьный автобус'],
    ['taxi', 'Легковое такси'],
    ['regionalBusLaneEligible', 'Региональный допуск на выделенную полосу подтверждён полностью'],
    ['routeVehiclesUnimpeded', 'При въезде на выделенную полосу помех маршрутным ТС не создаётся'],
  ];
  if (a.type === 'tram') facts.push(['depotExit', 'Трамвай выезжает из депо']);
  for (const [key, label] of facts) group.append(field(label, select([['unknown', 'Не установлено'], ['yes', 'Да'], ['no', 'Нет']], a.routeContext?.[key] === true ? 'yes' : a.routeContext?.[key] === false ? 'no' : 'unknown', value => set(key, value === 'unknown' ? undefined : value === 'yes'))));
  group.append(h('small', {}, 'Региональный допуск означает подтверждённые условия п. 18.2: назначение перевозки, места, допустимую максимальную массу и включение в перечень. Большая масса в модели сама по себе этого не доказывает.'),
    field('Цель использования выделенной полосы', select<NonNullable<Context['laneUse']> | 'unknown'>([['unknown', 'Не установлена'], ['through', 'Движение вдоль полосы'], ['turn', 'Перестроение перед поворотом'], ['enter-road', 'Въезд на дорогу'], ['passenger-stop', 'Посадка или высадка пассажиров у правого края']], a.routeContext?.laneUse ?? 'unknown', value => set('laneUse', value === 'unknown' ? undefined : value))));
  if (a.type === 'bus' || a.type === 'trolleybus') {
    group.append(field('Остановочное место, от которого начинается движение', select([['', 'Не установлено'], ...(app.scene().routeStops ?? []).map((stop, index) => [stop.id, `Остановочное место ${index + 1} (${stop.id})`] as [string, string])], a.routeContext?.departureStopId ?? '', value => set('departureStopId', value || undefined))),
      h('small', {}, 'Для п. 18.3 нужны обозначенное место в населённом пункте и фактическое начало движения от него. Перед отъездом водитель автобуса или троллейбуса должен убедиться, что ему уступают.'));
    const labels = actorLabels(app.scene());
    for (const other of app.scene().actors.filter(actor => actor.id !== a.id && actor.kind === 'vehicle' && !actor.railwayTrain)) {
      const known = a.routeContext?.departureChecks?.find(pair => pair.otherId === other.id)?.yieldingVerified;
      group.append(h('details', { class: 'group' }, h('summary', {}, `Перед отъездом: ${actorTitle(other, labels)}`),
        field('Убедился в уступании этого участника перед отъездом', select([['unknown', 'Не установлено'], ['yes', 'Да'], ['no', 'Нет']], known === true ? 'yes' : known === false ? 'no' : 'unknown', value => app.edit(() => {
          if (value === 'unknown' && !a.routeContext) return;
          const context = a.routeContext ??= {};
          const checks = context.departureChecks ??= [];
          let pair = checks.find(item => item.otherId === other.id);
          if (value === 'unknown') context.departureChecks = checks.filter(item => item !== pair);
          else {
            if (!pair) { pair = { otherId: other.id }; checks.push(pair); }
            pair.yieldingVerified = value === 'yes';
          }
          if (!context.departureChecks?.length) delete context.departureChecks;
          if (!Object.keys(context).length) delete a.routeContext;
        })))));
    }
  }
  box.append(group);
}

function stoppingContextForm(box: HTMLElement, a: Actor, app: AppApi): void {
  const group = h('details', { class: 'group' }, h('summary', {}, 'Остановка, стоянка и аварийное обозначение'),
    h('p', { class: 'note' }, 'Нулевая скорость не определяет стоянку. Укажите причину, преднамеренность и известную длительность до начала сцены. Пустое поле означает «не установлено».'));
  type ContextKey = 'stopContext' | 'warningContext' | 'doorContext';
  const set = (context: ContextKey, key: string, value: unknown) => app.edit(() => {
    const facts = (a[context] ??= {}) as Record<string, unknown>;
    if (value === undefined) delete facts[key]; else facts[key] = value;
  });
  const enumField = (context: ContextKey, key: string, label: string, options: [string, string][]) => {
    const value = (a[context] as Record<string, unknown> | undefined)?.[key];
    group.append(field(label, select([['unknown', 'Не установлено'], ...options], typeof value === 'string' ? value : 'unknown', v => set(context, key, v === 'unknown' ? undefined : v))));
  };
  const boolField = (context: ContextKey, key: string, label: string, parent = group) => {
    const value = (a[context] as Record<string, unknown> | undefined)?.[key];
    parent.append(field(label, select([['unknown', 'Не установлено'], ['yes', 'Да'], ['no', 'Нет']], value === true ? 'yes' : value === false ? 'no' : 'unknown', v => set(context, key, v === 'unknown' ? undefined : v === 'yes'))));
  };
  enumField('stopContext', 'reason', 'Причина прекращения движения', [['passengers', 'Посадка/высадка'], ['cargo', 'Загрузка/разгрузка'], ['rest', 'Длительный отдых/ночлег'], ['other-voluntary', 'Иная добровольная причина'], ['traffic', 'Сигнал, затор, требование движения'], ['forced', 'Вынужденная: неисправность, груз, состояние человека, препятствие']]);
  boolField('stopContext', 'intentional', 'Преднамеренное прекращение движения');
  const numbers: [string, string][] = [['durationBeforeStart', 'Неподвижность до начала сцены, с'], ['rowFromEdge', 'Ряд от края проезжей части'], ['permissibleMaxMass', 'Разрешённая максимальная масса, кг'], ['clearanceMeters', 'Зазор до сплошной (не краевой), разделителя или противоположного края, м'], ['visibilityForward', 'Видимость дороги вперёд, м'], ['visibilityBackward', 'Видимость дороги назад, м']];
  for (const [key, label] of numbers) group.append(field(label, optionalNumber((a.stopContext as Record<string, unknown> | undefined)?.[key] as number | undefined, v => set('stopContext', key, v), { min: key === 'rowFromEdge' ? 1 : 0, step: key === 'rowFromEdge' ? 1 : 0.1 })));
  enumField('stopContext', 'side', 'Сторона относительно движения ТС', [['right', 'Правая'], ['left', 'Левая']]);
  enumField('stopContext', 'registeredClass', 'Установленный регистрационный вид ТС', [['passenger-car', 'Легковой автомобиль'], ['motorcycle', 'Мотоцикл'], ['moped', 'Мопед'], ['other', 'Иной']]);
  const placement = h('details', { class: 'group' }, h('summary', {}, 'Место, помехи и способ постановки'));
  const placementFacts: [string, string][] = [
    ['onShoulder', 'На обочине'], ['shoulderPresent', 'Обочина имеется'], ['atCarriagewayEdge', 'У края проезжей части'], ['onCarriageway', 'На проезжей части'], ['stoppingProhibited', 'Запрет остановки в месте установлен по материалам'],
    ['parallelToEdge', 'Параллельно краю'], ['twoWheelsWithoutSidecar', 'Двухколёсное ТС без бокового прицепа'], ['parkingArrangementComplied', 'Способ постановки по 6.4/табличкам/разметке соблюдён'], ['angularParkingGeometrySuitable', 'Уширение и разметка допускают постановку под углом'],
    ['tIntersectionOppositeException', 'Установлено исключение напротив бокового проезда Т-пересечения со сплошной/разделителем'], ['tramObstructed', 'Создаёт помеху трамваю'], ['routeTaxiUnimpeded', 'Посадка/высадка без помех маршрутным ТС и такси'], ['signsSignalsBlocked', 'Закрывает другим знаки/сигналы'], ['otherAccessBlocked', 'Препятствует проезду, въезду или выезду'], ['pedestriansObstructed', 'Создаёт помеху пешеходам'], ['designatedRestArea', 'Предусмотренная площадка для отдыха'], ['outsideRoad', 'За пределами дороги'],
    ['disabledParkingEligible', 'Право на место инвалидов подтверждено'], ['disabilityBadge', 'Опознавательный знак «Инвалид» имеется'], ['disabilityExemptionEligible', 'Полный набор условий льготы инвалидов по 3.28–3.30 подтверждён'], ['postalLiveryEligible', 'Федеральная почтовая связь с установленной цветографикой'], ['taxiMeterOn', 'Таксометр включён'],
    ['relocationPossible', 'Имеется установленная возможность отвода ТС'], ['relocationMeasuresTaken', 'Все возможные меры отвода из запрещённого места приняты']];
  for (const [key, label] of placementFacts) boolField('stopContext', key, label, placement);
  for (const sign of app.scene().signs.filter(sign => ['3.27', '3.28', '3.29', '3.30'].includes(sign.kind) && sign.plates?.some(p => p.startsWith('8.4.')))) {
    const known = a.stopContext?.signApplicability?.find(pair => pair.signId === sign.id)?.applies;
    placement.append(field(`Табличка 8.4 у знака ${sign.kind} (${sign.id}) действует на это ТС`, select([['unknown', 'Не установлено'], ['yes', 'Да'], ['no', 'Нет']], known === true ? 'yes' : known === false ? 'no' : 'unknown', value => app.edit(() => {
      const c = a.stopContext ??= {};
      c.signApplicability = (c.signApplicability ?? []).filter(pair => pair.signId !== sign.id);
      if (value !== 'unknown') c.signApplicability.push({ signId: sign.id, applies: value === 'yes' });
    }))));
  }
  group.append(placement);
  const personal = h('details', { class: 'group' }, h('summary', {}, 'Дверь и уход водителя'));
  for (const [key, label] of [['opened', 'Дверь открыта'], ['createsObstruction', 'Открывание создаёт помеху']] as const) boolField('doorContext', key, label, personal);
  group.append(personal);
  enumField('doorContext', 'operator', 'Кто открывает дверь', [['driver', 'Водитель'], ['passenger', 'Пассажир']]);
  for (const [key, label] of [['driverLeft', 'Водитель покинул место/ТС'], ['rollawaySecured', 'Самопроизвольное движение исключено'], ['unauthorizedUsePrevented', 'Использование без водителя исключено'], ['childUnder7Present', 'В ТС ребёнок младше 7 лет'], ['adultPresent', 'В ТС остаётся совершеннолетний']] as const) boolField('stopContext', key, label, personal);
  personal.append(h('small', {}, 'Помеха от двери не доказывает контакт: отдельная геометрия двери не рассчитывается.'));
  const warning = h('details', { class: 'group' }, h('summary', {}, 'Аварийная сигнализация и треугольник (7.1–7.2)'));
  for (const [key, label] of [['hazardAvailable', 'Аварийная сигнализация исправна и имеется'], ['accident', 'ДТП установлено вне смоделированного контакта'], ['dazzled', 'Ослепление фарами'], ['towedMechanical', 'Буксируемое механическое ТС'], ['childrenBoardingWithSign', 'Посадка/высадка детей с опознавательным знаком'], ['otherDanger', 'Иная опасность, требующая предупреждения'], ['timelyVisibleToOthers', 'ТС своевременно заметно другим водителям'], ['trianglePlaced', 'Треугольник выставлен'], ['trianglePromptly', 'Треугольник выставлен незамедлительно'], ['timelyWarningEnsured', 'Положение треугольника обеспечивает своевременное предупреждение']] as const) boolField('warningContext', key, label, warning);
  warning.append(field('Измеренное расстояние от габарита ТС до треугольника, м', optionalNumber(a.warningContext?.triangleDistance, v => set('warningContext', 'triangleDistance', v), { min: 0 })),
    h('small', {}, 'Активность аварийной сигнализации задаётся существующими сигналами маршрута и их временем. Минимум 15 м в населённом пункте, 30 м вне; фиксированного срока в секундах ПДД не задают.'));
  group.append(warning);
  for (const [context, label] of [['stopContext', 'Источник обстоятельств остановки'], ['doorContext', 'Источник сведений о двери'], ['warningContext', 'Источник аварийного обозначения']] as const) group.append(field(label, h('textarea', { rows: 2, value: a[context]?.source ?? '', onchange: (event: Event) => set(context, 'source', (event.target as HTMLTextAreaElement).value.trim() || undefined) })));
  box.append(group);
}

const MOBILITY_LABELS: Record<typeof MOBILITY_SURFACES[number], string> = {
  sidewalk: 'Тротуар', footpath: 'Пешеходная дорожка', cyclepath: 'Велосипедная дорожка',
  sharedpath: 'Совместная велопешеходная дорожка', 'pedestrian-side': 'Пешеходная сторона раздельной дорожки',
  'cycle-side': 'Велосипедная сторона раздельной дорожки', 'cycle-lane': 'Полоса для велосипедистов',
  shoulder: 'Обочина', 'pedestrian-zone': 'Пешеходная зона', 'cycle-zone': 'Велосипедная зона (обмер)',
};
function mobilityForm(box: HTMLElement, a: Actor, app: AppApi): void {
  if (a.kind === 'pedestrian') {
    box.append(field('Ведёт устройство (пешеход по 1.2)', select([['none', 'Нет'], ['bicycle', 'Велосипед'], ['sim', 'СИМ'], ['moped', 'Мопед'], ['motorcycle', 'Мотоцикл']], a.leadingDevice ?? 'none', value => app.edit(() => {
      if (value === 'none') delete a.leadingDevice; else a.leadingDevice = value;
    }))));
    return;
  }
  if (!['sim', 'bicycle', 'moped'].includes(a.type)) return;
  const group = h('div', { class: 'group' }, h('h4', {}, 'Велосипеды, СИМ и мопеды — раздел 24'));
  group.append(h('p', { class: 'note' }, 'Неизвестные факты оставьте незаданными. Обстоятельства действуют вдоль всей траектории; при их изменении создайте отдельную сцену.'),
    button('Спешиться: вести устройство как пешеход', () => app.edit(() => {
      const type = a.type as 'bicycle' | 'sim' | 'moped';
      a.kind = 'pedestrian'; a.type = 'adult'; a.leadingDevice = type; a.speed = 5;
      a.path.forEach(w => { w.v = 5; }); delete a.simParameters; delete a.cargo;
    }, true)));
  if (a.type === 'sim') {
    group.append(h('h4', {}, 'Параметры СИМ из источника'), h('p', { class: 'note' }, 'Готового подтверждённого набора нет. Для расчёта нужны все параметры и источник. Масса устройства для 35 кг не включает ездока. Скорость задаётся явно; 25 км/ч — правовой предел, а не техническая характеристика.'));
    const fields = [['deviceMass', 'Масса устройства, кг'], ['riderMass', 'Масса ездока, кг'], ['length', 'Длина, м'], ['width', 'Ширина, м'], ['height', 'Высота с ездоком, м'], ['accel', 'Ускорение, м/с²'], ['brakeDecel', 'Замедление на сухом покрытии, м/с²']] as const;
    for (const [key, label] of fields) group.append(field(label, optionalNumber(a.simParameters?.[key], value => app.edit(() => {
      const parameters = a.simParameters ??= {}; if (value === undefined) delete parameters[key]; else parameters[key] = value;
    }), { min: key === 'accel' ? 0 : 0.001, step: 0.1 })));
    group.append(field('Источник параметров СИМ', h('input', { type: 'text', value: a.simParameters?.source ?? '', onchange: (e: Event) => app.edit(() => { (a.simParameters ??= {}).source = (e.target as HTMLInputElement).value; }) }), 'Документ, измерение или явно обозначенные условные параметры учебной сцены. Замедление масштабируется отношением μ/μ сухого покрытия; это упрощение модели.'));
  }
  const facts: [keyof MobilityContext, string][] = [
    ['cycleInfrastructureUnavailable', 'Велодорожки и велополоса отсутствуют или недоступны'],
    ['carriagewayUnavailable', 'Правая кромка проезжей части недоступна'], ['shoulderUnavailable', 'Обочина отсутствует или недоступна'],
    ['pedestrianInfrastructureUnavailable', 'Тротуар и пешеходная дорожка отсутствуют или недоступны'],
    ['accompaniesChildUnder14', 'Сопровождает ребёнка на велосипеде/СИМ до 14 лет'], ['carriesChildUnder7', 'Велосипед: перевозит ребёнка до 7 лет на предназначенном месте'],
    ['adultAccompanied', 'Ребёнок на СИМ сопровождается взрослым'], ['column', 'Велосипедист движется в колонне'],
    ['roadAllowsCycling', 'На дороге разрешено движение велосипедов'], ['roadEquipmentComplete', 'СИМ: весь комплект оборудования из 24.2(1) подтверждён'],
    ['pedestrianObstruction', 'Созданы помехи пешеходам'], ['pedestrianDanger', 'Создана опасность пешеходам'],
    ['pedestrianPriorityRespected', 'Приоритет пешеходов соблюдён'], ['singleFile', 'Движение по правой кромке в один ряд'],
    ['leftBypass', 'СИМ: обгон/объезд транспортного средства слева'], ['leftTurnPermittedFromRight', 'Левый поворот разрешён из правой полосы'],
    ['causedVehicleObstruction', 'Установлено: нарушение причинило помеху транспортным средствам (12.30)'],
  ];
  for (const [key, label] of facts) group.append(field(label, select([['unknown', 'Не установлено'], ['yes', 'Да'], ['no', 'Нет']], a.mobilityContext?.[key] === true ? 'yes' : a.mobilityContext?.[key] === false ? 'no' : 'unknown', value => app.edit(() => {
    const context = a.mobilityContext ??= {}; if (value === 'unknown') delete context[key]; else Object.assign(context, { [key]: value === 'yes' });
  }))));
  for (const [key, label] of [['roadSpeedLimit', 'Разрешённая скорость транспорта на дороге, км/ч'], ['pedestrianSpeedKmh', 'Скорость пешеходов, км/ч']] as const) group.append(field(label, optionalNumber(a.mobilityContext?.[key], value => app.edit(() => {
    const context = a.mobilityContext ??= {}; if (value === undefined) delete context[key]; else context[key] = value;
  }), { min: 0 })));
  group.append(field('Пункт причинного нарушения для 12.30 (например pdd:24.8)', h('input', { type: 'text', value: a.mobilityContext?.consequenceRuleRef ?? '', onchange: (e: Event) => app.edit(() => { (a.mobilityContext ??= {}).consequenceRuleRef = (e.target as HTMLInputElement).value; }) })));
  group.append(field('Установлено: неосторожное причинение вреда нарушением (12.30)', select([['unknown', 'Не установлено'], ['none', 'Нет'], ['light', 'Лёгкий вред'], ['medium', 'Вред средней тяжести']], a.mobilityContext?.negligentHarm ?? 'unknown', value => app.edit(() => {
    const context = a.mobilityContext ??= {}; if (value === 'unknown') delete context.negligentHarm; else context.negligentHarm = value;
  }))), field('Источник обстоятельств и причинных последствий', h('input', { type: 'text', value: a.mobilityContext?.source ?? '', onchange: (e: Event) => app.edit(() => { (a.mobilityContext ??= {}).source = (e.target as HTMLInputElement).value; }) }), 'Для 12.30 нужны установленные нарушение, причинная связь и последствия. Расчётная оценка травмы их не заменяет.'));
  box.append(group);
}

function actorForm(box: HTMLElement, a: Actor, app: AppApi, rebuild: () => void): void {
  const ed = app.editor;
  const set = <T,>(fn: (v: T) => void) => (v: T) => app.edit(() => fn(v));
  const isVeh = a.kind === 'vehicle';
  const types: [string, string][] = isVeh
    ? (Object.keys(VEHICLES) as VehicleType[]).map((k) => [k, k === 'tram' && a.railwayTrain ? 'Поезд (параметры ниже)' : VEHICLES[k].name])
    : (Object.keys(PEDESTRIANS) as (keyof typeof PEDESTRIANS)[]).map((k) => [k, PEDESTRIANS[k].name]);
  const color = h('input', { type: 'color', value: a.color });
  color.addEventListener('change', () => app.edit(() => (a.color = color.value)));
  box.append(
    field('Тип', select(types, a.type, (v) => app.edit(() => { a.type = v as Actor['type']; if (v === 'sim') { a.speed = 0; a.path.forEach(w => w.v = 0); delete a.cargo; } if (v !== 'sim') delete a.simParameters; if (v !== 'tram') delete a.railwayTrain; }, true))),
    field('Цвет', color),
    field('Скорость в начале, км/ч', num(a.speed, value => app.edit(() => { a.speed = value; ed.syncHeading(a); }, true), { min: isVeh ? -50 : 0, max: 250 }), isVeh ? 'Отрицательная скорость — задний ход. Траектория задаёт направление перемещения, кузов обращён в противоположную сторону.' : undefined),
    field('Появится через, с', num(a.delay, set((v) => (a.delay = v)), { min: 0, max: 60, step: 0.5 })),
    field('Курс кузова, °', num(deg(a.heading), set((v: number) => (a.heading = rad(v))), { step: 5, disabled: a.path.length > 0 }), a.path.length ? 'Курс определяется первой точкой и направлением движения: при заднем ходе кузов обращён против перемещения.' : '0° — вправо, 90° — вниз'),
  );
  if (!isVeh || ['sim', 'bicycle', 'moped'].includes(a.type)) {
    const age = h('input', { type: 'number', min: 0, max: 120, step: 1, value: a.age ?? '', placeholder: 'Не указан' });
    age.addEventListener('change', () => app.edit(() => { a.age = age.value === '' ? undefined : Math.max(0, Math.floor(Number(age.value))); }));
    box.append(field('Возраст, полных лет', age, 'До 16 лет административная ответственность не наступает.'));
  }
  if (isVeh) {
    box.append(
      h('div', { class: 'group' },
        h('h4', {}, 'Водитель'),
        check('Нетрезв (опьянение)', a.flags.drunk, set((v) => (a.flags.drunk = v))),
        ...(VEHICLES[a.type as VehicleType].licenseRequired
          ? [check('Нет права управления', a.flags.noLicense, set((v) => (a.flags.noLicense = v)))] : []),
        check('Скрывается с места ДТП', a.flags.flees, set((v) => (a.flags.flees = v))),
        check('Водитель не может определить покрытие (п. 13.13)', !!a.coveringUnknown, set((v) => (a.coveringUnknown = v))),
      ),
    );
  }
  if (isVeh && VEHICLES[a.type as VehicleType].rail) {
    box.append(
      h('div', { class: 'group' },
        h('h4', {}, 'Рельсы'),
        h('p', { class: 'note' }, a.railwayTrain ? 'Поезд следует железнодорожной колее; масса, габариты и замедление берутся из параметров ниже. Модель не рассчитывает сход поезда с рельсов.' : 'Трамвай едет строго по ближайшему трамвайному пути (точки маршрута притягиваются к колее). Удар его не сдвигает, он тормозит на рельсах.'),
        !a.railwayTrain && check('Возможен сход с путей (удар от 20 км/ч)', !!a.derail, set((v) => (a.derail = v))),
      ),
    );
    railwayTrainForm(box, a, app);
  }
  mobilityForm(box, a, app);
  if (isVeh && a.type !== 'sim' && !VEHICLES[a.type as VehicleType].rail) cargoForm(box, a, app);
  if (isVeh && !a.railwayTrain) {
    maneuverContextForm(box, a, app);
    railwayContextForm(box, a, app);
    specialSignalsForm(box, a, app);
    routeContextForm(box, a, app);
    stoppingContextForm(box, a, app);
  }
  // траектория
  const pathBox = h('div', { class: 'group' }, h('h4', {}, 'Траектория'));
  pathBox.append(
    h('div', { class: 'row' },
      button(ed.tool === 'path' ? 'Рисую… (нажмите «Готово»)' : a.path.length ? 'Дорисовать траекторию' : 'Нарисовать траекторию', () => ed.setTool(ed.tool === 'path' ? 'select' : 'path'), 'primary'),
      button('Очистить', () => app.edit(() => ((a.path = []), (ed.selWp = null)), true)),
    ),
    h('small', {}, 'Нажимайте на карту, чтобы ставить точки. Нулевая скорость — остановка, отрицательная — задний ход на сегменте к точке. При смене направления машина сначала останавливается. Сигнал без отдельного времени подаётся при достижении точки; время включения задаётся от начала симуляции.'),
  );
  if (a.path.length) {
    const table = h('table', { class: 'wp' }, h('tr', {}, h('th', {}, '№'), h('th', {}, 'км/ч'), h('th', {}, 'пауза, с'), h('th', {})));
    a.path.forEach((w, i) => {
      const tr = h('tr', { class: ed.selWp === i ? 'on' : '', onclick: () => ed.select(ed.sel, i) },
        h('td', {}, String(i + 1)),
        h('td', {}, num(w.v, value => app.edit(() => { w.v = value; ed.syncHeading(a); }, true), { min: isVeh ? -50 : 0, max: 250 })),
        h('td', {}, Math.abs(w.v) < 0.3 ? num(w.hold ?? 0, set((v) => (w.hold = v)), { min: 0, max: 30, step: 0.5 }) : '—'),
        h('td', {}, h('button', { type: 'button', class: 'x', title: 'Удалить точку', onclick: (e: Event) => { e.stopPropagation(); app.edit(() => { a.path.splice(i, 1); ed.syncHeading(a); ed.selWp = null; }, true); } }, '✕')),
      );
      table.append(tr);
      if (isVeh) table.append(h('tr', {}, h('td', { colspan: 4 },
        field(`Сигнал у точки ${i + 1}`, select([['none', 'Не подаётся / выключить'], ['left', 'Левый'], ['right', 'Правый'], ['hazard', 'Аварийная сигнализация']], w.signal ?? 'none', value => app.edit(() => { w.signal = value; }, true))),
        field('Подать команду в t, с', optionalNumber(w.signalAt, value => app.edit(() => { w.signalAt = value; }, true), { min: 0, max: app.scene().env.duration, step: 0.1 }), 'Пусто — при фактическом достижении точки. «Выключить» также является отдельной командой.'),
      )));
    });
    pathBox.append(table);
    if (isVeh) {
      const signal = vehicleSignalAt(a, 0);
      pathBox.append(h('small', {}, `В начале симуляции: ${signal.signal === 'none' ? 'сигнал выключен' : signal.signal === 'hazard' ? 'аварийная сигнализация' : signal.signal === 'left' ? 'левый сигнал' : 'правый сигнал'}.`));
      const suggestions = suggestSignals(a);
      if (suggestions.length) {
        const proposed = h('details', { class: 'group' }, h('summary', {}, 'Подсказки указателей поворота'),
          h('small', {}, `ПДД не задают число секунд или метров для заблаговременности. Ориентиры ${app.scene().env.signalLeadSeconds ?? SIGNAL_LEAD_SECONDS} с и ${app.scene().env.signalLeadMeters ?? SIGNAL_LEAD_METERS} м — параметры учебной модели, настраиваемые во вкладке «Среда»; время по заданной траектории до расчёта оценочное. Проверьте исходные данные и время фактического манёвра.`));
        for (const suggestion of suggestions) {
          const updates = suggestedSignalUpdates(a, suggestion, undefined, { leadSeconds: app.scene().env.signalLeadSeconds, leadMeters: app.scene().env.signalLeadMeters });
          proposed.append(h('div', {}, h('p', {}, `Точка ${suggestion.waypointIndex + 1}: ${suggestion.signal === 'left' ? 'левый' : 'правый'} сигнал. ${suggestion.detail}`),
            suggestion.maneuverTime === null || !updates.length
              ? h('small', {}, 'Время манёвра не установлено. Задайте время сигнала вручную.')
              : button(`Принять: включить в ${updates[0].signalAt.toFixed(1)} с`, () => app.edit(() => {
                for (const update of updates) {
                  const waypoint = a.path[update.waypointIndex];
                  if (waypoint) { waypoint.signal = update.signal; waypoint.signalAt = update.signalAt; }
                }
              }, true)),
            updates.length ? h('small', {}, `Будут согласованы команды у точек ${updates.map(update => update.waypointIndex + 1).join(', ')} в интервале до манёвра, включая команду выключения в этом интервале. Проверьте выключение сигнала после манёвра.`) : null));
        }
        pathBox.append(proposed);
      }
    }
  }
  box.append(pathBox);
  void rebuild;
}

// ---------------------------------------------------------------------------
// Среда

export function buildEnv(root: HTMLElement, app: AppApi, extra: { grid: boolean; setGrid: (v: boolean) => void }): void {
  root.replaceChildren();
  const s = app.scene();
  const set = <T,>(fn: (v: T) => void) => (v: T) => app.edit(() => fn(v));
  root.append(
    h('div', { class: 'form' },
      h('h3', {}, 'Условия'),
      field('Дата и время ДТП', h('input', {
        type: 'datetime-local', value: s.env.accidentDate, required: true,
        onchange: (e: Event) => {
          const input = e.target as HTMLInputElement;
          if (input.value && input.validity.valid) app.edit(() => { s.env.accidentDate = input.value; });
          else input.value = s.env.accidentDate;
        },
      }), 'Местное время места ДТП. По этой дате выбираются редакции норм.'),
      field('Покрытие', select(Object.entries(SURFACES).map(([k, v]) => [k, `${v.name} (μ = ${v.mu})`] as [string, string]), s.env.surface, set((v: string) => (s.env.surface = v as Scene['env']['surface']))), 'От сцепления зависят тормозной путь и техническая возможность остановиться.'),
      field('Город для специальных составов КоАП', select<NonNullable<Scene['env']['federalCity']> | 'unknown'>([['unknown', 'Не установлен'], ['moscow', 'Москва'], ['saint-petersburg', 'Санкт-Петербург'], ['sevastopol', 'Севастополь'], ['other', 'Другое место']], s.env.federalCity ?? 'unknown', value => app.edit(() => { if (value === 'unknown') delete s.env.federalCity; else s.env.federalCity = value; })), 'Укажите место по исходным материалам; повышенная часть для выделенной полосы относится к Москве и Санкт-Петербургу.'),
      field('Подтверждённый календарный статус даты ДТП для 8.5', select([['unknown', 'Не установлен'], ['working', 'Рабочий день'], ['nonworking', 'Нерабочий/праздничный день']], s.env.dayStatus?.[s.env.accidentDate.slice(0, 10)] ?? 'unknown', value => app.edit(() => { const calendar = s.env.dayStatus ??= {}; const date = s.env.accidentDate.slice(0, 10); if (value === 'unknown') delete calendar[date]; else calendar[date] = value as 'working' | 'nonworking'; }))),
      field('Длительность, с', num(s.env.duration, set((v) => (s.env.duration = v)), { min: 3, max: 120 })),
      h('h3', {}, 'Редактор'),
      button('Добавить кольцевой перекрёсток', () => app.editor.addRoundabout()),
      h('small', {}, 'Кольцо и четыре въезда появятся в центре видимой карты. Знаки 4.3 можно также выбрать в каталоге знаков.'),
      check('Показывать сетку', extra.grid, extra.setGrid),
      check('Привязка к сетке и к концам дорог', app.editor.snap, (v) => (app.editor.snap = v)),
      h('p', { class: 'note' }, 'Чтобы перемещать карту, перетаскивайте пустое место, колесо мыши — масштаб. На телефоне: два пальца — масштаб и перемещение.'),
    ),
  );
  root.append(h('details', { class: 'form' }, h('summary', {}, 'Ориентиры заблаговременности сигнала'),
    h('p', { class: 'note' }, 'ПДД не устанавливают число секунд или метров для заблаговременной подачи сигнала. Это настраиваемые ориентиры учебной модели, а не правовая норма.'),
    field('До манёвра, с', num(s.env.signalLeadSeconds ?? SIGNAL_LEAD_SECONDS, set((value: number) => { s.env.signalLeadSeconds = value; }), { min: 0.1, max: 60, step: 0.1 })),
    field('До манёвра, м', num(s.env.signalLeadMeters ?? SIGNAL_LEAD_METERS, set((value: number) => { s.env.signalLeadMeters = value; }), { min: 1, max: 1000, step: 1 })),
  ));
  intersectionBoundariesForm(root, app, () => buildEnv(root, app, extra));
  railwayCrossingsForm(root, app, () => buildEnv(root, app, extra));
  routeStopsForm(root, app, () => buildEnv(root, app, extra));
  stopPlacesForm(root, app, () => buildEnv(root, app, extra));
}

const STOP_PLACE_LABELS: Record<string, string> = { shoulder: 'Обочина', 'sidewalk-edge': 'Край тротуара', parking: 'Парковочное место', 'disabled-parking': 'Место для инвалидов', tunnel: 'Тоннель', bridge: 'Мост/эстакада', 'under-bridge': 'Под мостом/эстакадой', 'dangerous-bend': 'Опасный поворот', crest: 'Выпуклый перелом', 'intersection-carriageways': 'Пересечение проезжих частей (граница)', 'bicycle-lane': 'Полоса для велосипедистов', 'bicycle-path': 'Велодорожка', 'bicycle-crossing': 'Пересечение велодорожки с проезжей частью', 'pedestrian-ramp': 'Сопряжение тротуара', 'safety-island': 'Островок' };
function stopPlacesForm(root: HTMLElement, app: AppApi, rebuild: () => void): void {
  const group = h('details', { class: 'form' }, h('summary', {}, 'Измеренные места остановки и стоянки'),
    h('p', { class: 'note' }, 'Переходы, переезды, остановки и пути задавайте в существующих объектах. Здесь — локальные границы дополнительных мест. Для 5 м у перекрёстка нужен край пересекаемой проезжей части.'));
  const renderPlace = (place: NonNullable<Scene['stopPlaces']>[number]) => {
    const panel = h('details', { class: 'group', 'data-stop-place': place.id }, h('summary', {}, `${STOP_PLACE_LABELS[place.kind]} (${place.id})`));
    const points = h('textarea', { rows: 4, value: place.boundary.map(p => `${p.x}; ${p.y}`).join('\n') });
    const source = h('textarea', { rows: 2, value: place.source });
    const signs = h('input', { value: (place.signIds ?? []).join(', ') });
    const note = h('p', { class: 'note', role: 'status' });
    panel.append(field('Вид места', select(STOP_PLACE_KINDS.map(kind => [kind, STOP_PLACE_LABELS[kind]]), place.kind, value => app.edit(() => { place.kind = value; }))),
      field('Контур, м: каждая строка X; Y', points), field('Источник обмера', source), field('Связанные знаки 6.4: ID через запятую', signs),
      button('Сохранить место', () => {
        try {
          const boundary = points.value.trim().split('\n').map(line => { const pair = line.split(';'); return { x: pair.length === 2 && pair[0].trim() ? Number(pair[0].trim().replace(',', '.')) : NaN, y: pair.length === 2 && pair[1].trim() ? Number(pair[1].trim().replace(',', '.')) : NaN }; });
          const next = normalizeStopPlaces([{ ...place, boundary, source: source.value.trim(), signIds: signs.value.split(',').map(id => id.trim()).filter(Boolean) }])![0];
          app.edit(() => { Object.assign(place, next); const places = app.scene().stopPlaces ??= []; if (!places.includes(place)) places.push(place); }); note.textContent = 'Измеренное место сохранено.';
        } catch { note.textContent = 'Укажите источник и не менее трёх точек X; Y.'; }
      }), button('Удалить место', () => { app.edit(() => { app.scene().stopPlaces = app.scene().stopPlaces?.filter(p => p.id !== place.id); }); panel.remove(); rebuild(); }), note);
    group.append(panel);
    panel.open = !place.source;
  };
  for (const place of app.scene().stopPlaces ?? []) renderPlace(place);
  group.append(button('Добавить измеренное место', () => {
      const places = app.scene().stopPlaces ?? [], x = app.editor.cam.x, y = app.editor.cam.y;
      let n = 1; while (places.some(p => p.id === `stop-place-${n}`) || group.querySelector(`[data-stop-place="stop-place-${n}"]`)) n++;
      // An unsaved draft is deliberately absent from analysis until a source is supplied.
      renderPlace({ id: `stop-place-${n}`, kind: 'parking', source: '', boundary: [{ x: x - 3, y: y - 2 }, { x: x + 3, y: y - 2 }, { x: x + 3, y: y + 2 }, { x: x - 3, y: y + 2 }] });
  }));
  root.append(group);
}
function stoppingSignForm(box: HTMLElement, sign: Scene['signs'][number], app: AppApi): void {
  const group = h('details', { class: 'group' }, h('summary', {}, 'Условия парковочного знака'), h('small', {}, 'Знак действует на стороне установки. Для табличек вдоль фасада укажите обмеренную зону вдоль оси дороги. Применимость изображённого вида ТС на 8.4 устанавливается отдельно для каждого участника в его свойствах.'));
  type Context = NonNullable<typeof sign.stopRule>;
  const set = <K extends keyof Context>(key: K, value: Context[K]) => app.edit(() => { if (value === undefined) { if (sign.stopRule) delete sign.stopRule[key]; } else (sign.stopRule ??= {})[key] = value; });
  group.append(field('Дорога знака', select([['', 'Ближайшая по геометрии'], ...app.scene().roads.map(r => [r.id, r.id] as [string, string])], sign.stopRule?.roadId ?? '', v => set('roadId', v || undefined))),
    field('Начало зоны от начала оси дороги, м', optionalNumber(sign.stopRule?.fromS, v => set('fromS', v), { min: 0 })),
    field('Конец зоны от начала оси дороги, м', optionalNumber(sign.stopRule?.toS, v => set('toS', v), { min: 0 })),
    field('Дни на установленной табличке 8.5.5–7', select([['unknown', 'Не установлены'], ['working', 'Рабочие'], ['nonworking', 'Нерабочие/праздничные'], ['weekdays', 'Указанные дни недели']], sign.stopRule?.scheduleDays ?? 'unknown', value => set('scheduleDays', value === 'unknown' ? undefined : value as Context['scheduleDays']))),
    field('Дни недели 8.5.3/7 (1=пн…7=вс, через запятую)', h('input', { value: sign.stopRule?.weekdays?.join(', ') ?? '', onchange: (event: Event) => { const text = (event.target as HTMLInputElement).value.trim(); const days = text.split(',').map(Number); if (!text || days.every(d => Number.isInteger(d) && d >= 1 && d <= 7)) set('weekdays', text ? days : undefined); } })));
  const from = h('input', { type: 'time', value: sign.stopRule?.hours?.from ?? '' }), to = h('input', { type: 'time', value: sign.stopRule?.hours?.to ?? '' });
  const hours = () => set('hours', from.value && to.value && from.value !== to.value ? { from: from.value, to: to.value } : undefined);
  from.addEventListener('change', hours); to.addEventListener('change', hours);
  group.append(field('Начало времени действия 8.5', from), field('Конец времени действия 8.5 (не включительно)', to)); box.append(group);
}

function routeStopsForm(root: HTMLElement, app: AppApi, rebuild: () => void): void {
  type Stop = NonNullable<Scene['routeStops']>[number];
  const scene = app.scene();
  const roads = scene.roads.map((road, index) => [road.id, `Дорога ${index + 1} (${road.id})`] as [string, string]);
  const signs = scene.signs.filter(sign => ['5.16', '5.17', '5.18'].includes(sign.kind))
    .map(sign => [sign.id, `${sign.kind} · ${signTitle(sign.kind)} (${sign.id})`] as [string, string]);
  const markings = scene.markings.filter(mark => ['1.17.1', '1.17.2'].includes(mark.kind))
    .map(mark => [mark.id, `${mark.kind} · ${mark.kind === '1.17.2' ? 'Место остановки трамвая' : 'Остановка маршрутных ТС или стоянка такси'} (${mark.id})`] as [string, string]);
  const group = h('details', { class: 'form' }, h('summary', {}, 'Остановочные места маршрутного транспорта'),
    h('p', { class: 'note' }, 'Свяжите место с дорогой и установленным знаком или разметкой. Без подтверждённого обозначения место не считается обозначенной остановкой только по этой точке на карте. Разметка 1.17.2 обозначает остановку трамвая.'));
  for (const [index, stop] of (scene.routeStops ?? []).entries()) {
    const panel = h('details', { class: 'group' }, h('summary', {}, `Остановочное место ${index + 1} (${stop.id})`));
    const set = <K extends keyof Stop>(key: K, value: Stop[K]): void => app.edit(() => { if (value === undefined) delete stop[key]; else stop[key] = value; });
    panel.append(
      field('Дорога остановочного места', select(roads, stop.roadId, value => set('roadId', value))),
      field('X остановочного места, м', num(stop.x, value => set('x', value), { step: 0.1 })),
      field('Y остановочного места, м', num(stop.y, value => set('y', value), { step: 0.1 })),
      field('Курс отправления от остановочного места, °', num(deg(stop.heading), value => set('heading', rad(value)), { step: 1 })),
      field('Знак остановочного места', select([['', 'Не установлен'], ...signs], stop.signId ?? '', value => set('signId', value || undefined))),
      field('Разметка остановочного места', select([['', 'Не установлена'], ...markings], stop.markingId ?? '', value => set('markingId', value || undefined))),
      field('Источник остановочного места', h('textarea', { rows: 2, value: stop.source ?? '', onchange: (event: Event) => set('source', (event.target as HTMLTextAreaElement).value.trim() || undefined) })),
      button('Показать остановочное место', () => { app.editor.cam.x = stop.x; app.editor.cam.y = stop.y; app.editor.onView(); }),
      button('Удалить остановочное место', () => {
        app.edit(() => {
          scene.routeStops = (scene.routeStops ?? []).filter(item => item.id !== stop.id);
          for (const actor of scene.actors) if (actor.routeContext?.departureStopId === stop.id) delete actor.routeContext.departureStopId;
        });
        rebuild();
      }),
    );
    group.append(panel);
  }
  let roadId = roads[0]?.[0] ?? '', signId = '', markingId = '', heading = 0;
  const source = h('textarea', { rows: 2, placeholder: 'Схема, измерение, знак или разметка; для учебных данных укажите условность' });
  const note = h('p', { class: 'note', role: 'status' });
  group.append(h('details', { class: 'group' }, h('summary', {}, 'Добавить остановочное место в центре карты'),
    field('Дорога нового остановочного места', select([['', 'Выберите дорогу'], ...roads], roadId, value => { roadId = value; })),
    field('Курс нового остановочного места, °', num(0, value => { heading = rad(value); }, { step: 1 })),
    field('Знак нового остановочного места', select([['', 'Не установлен'], ...signs], '', value => { signId = value; })),
    field('Разметка нового остановочного места', select([['', 'Не установлена'], ...markings], '', value => { markingId = value; })),
    field('Источник нового остановочного места', source),
    note,
    button('Добавить остановочное место', () => {
      if (!scene.roads.some(road => road.id === roadId) || !source.value.trim()) { note.textContent = 'Выберите существующую дорогу и укажите источник. Место будет добавлено в центре видимой карты.'; return; }
      app.edit(() => {
        const stops = scene.routeStops ??= [], ids = new Set(stops.map(stop => stop.id));
        let number = stops.length + 1;
        while (ids.has(`route-stop-${number}`)) number++;
        stops.push({ id: `route-stop-${number}`, roadId, x: app.editor.cam.x, y: app.editor.cam.y, heading,
          ...(signId ? { signId } : {}), ...(markingId ? { markingId } : {}), source: source.value.trim() });
      });
      rebuild();
    }),
  ));
  root.append(group);
}

function railwayCrossingsForm(root: HTMLElement, app: AppApi, rebuild: () => void): void {
  type Crossing = NonNullable<Scene['railwayCrossings']>[number];
  const group = h('details', { class: 'form' }, h('summary', {}, 'Железнодорожные переезды'),
    h('p', { class: 'note' }, 'Рельсовый путь рисуется на карте с назначением «Железнодорожный». Здесь задаются измеренная область переезда и установленные состояния управления. Неизвестные факты не считаются разрешающими.'));
  for (const [index, crossing] of (app.scene().railwayCrossings ?? []).entries()) {
    const panel = h('details', { class: 'group' }, h('summary', {}, `Переезд ${index + 1} (${crossing.id})`));
    const set = <K extends keyof Crossing>(key: K, value: Crossing[K]) => app.edit(() => { crossing[key] = value; });
    panel.append(
      field('X переезда, м', num(crossing.x, value => set('x', value), { step: 0.1 })),
      field('Y переезда, м', num(crossing.y, value => set('y', value), { step: 0.1 })),
      field('Курс дороги через переезд, °', num(deg(crossing.angle), value => set('angle', rad(value)), { step: 1 })),
      field('Длина между крайними рельсами вдоль дороги, м', num(crossing.length, value => set('length', value), { min: 0.01, step: 0.1 })),
      field('Ширина переезда поперёк дороги, м', num(crossing.width, value => set('width', value), { min: 0.01, step: 0.1 })),
      field('Шлагбаум', select([['unknown', 'Не установлено'], ['none', 'Отсутствует'], ['open', 'Открыт'], ['closing', 'Закрывается'], ['closed', 'Закрыт']], crossing.barrier ?? 'unknown', value => set('barrier', value === 'unknown' ? undefined : value))),
      field('Сигнал на переезде', select([['unknown', 'Не установлен'], ['off', 'Красный и белый выключены'], ['red', 'Запрещающий красный'], ['white', 'Мигающий бело-лунный']], crossing.signal ?? 'unknown', value => set('signal', value === 'unknown' ? undefined : value))),
    );
    const facts: [keyof Pick<Crossing, 'regulated' | 'lightPresent' | 'stopLinePresent' | 'attendantStop' | 'exitBlocked' | 'visibleTrainApproaching'>, string][] = [
      ['regulated', 'Переезд регулируемый'],
      ['lightPresent', 'Светофор физически имеется'],
      ['stopLinePresent', 'Имеется стоп-линия / знак 6.16 или 2.5'],
      ['attendantStop', 'Дежурный подаёт запрещающий сигнал'],
      ['exitBlocked', 'Затор за переездом вынудит остановиться на путях'],
      ['visibleTrainApproaching', 'В пределах видимости приближается поезд'],
    ];
    for (const [key, label] of facts) panel.append(field(label, select([['unknown', 'Не установлено'], ['yes', 'Да'], ['no', 'Нет']], crossing[key] === true ? 'yes' : crossing[key] === false ? 'no' : 'unknown', value => set(key, value === 'unknown' ? undefined : value === 'yes'))));
    panel.append(
      field('От крайнего рельса до стоп-линии / знака, м', optionalNumber(crossing.stopLineDistance, value => set('stopLineDistance', value), { min: 0, step: 0.1 })),
      field('От крайнего рельса до светофора / шлагбаума, м', optionalNumber(crossing.controlDistance, value => set('controlDistance', value), { min: 0, step: 0.1 })),
      h('small', {}, 'Эти расстояния задают симметричное расположение с двух сторон переезда. Если стороны различаются или измерений нет, оставьте поле пустым; расстояние не будет установлено автоматически.'),
      field('Источник геометрии и состояний переезда', h('textarea', { rows: 3, value: crossing.source ?? '', onchange: (event: Event) => set('source', (event.target as HTMLTextAreaElement).value.trim() || undefined) })),
      button('Показать этот переезд', () => { app.editor.cam.x = crossing.x; app.editor.cam.y = crossing.y; app.editor.onView(); }),
      button('Удалить переезд', () => { app.edit(() => { app.scene().railwayCrossings = (app.scene().railwayCrossings ?? []).filter(item => item.id !== crossing.id); }); rebuild(); }),
    );
    group.append(panel);
  }
  let length: number | undefined;
  let width: number | undefined;
  let angle = 0;
  const source = h('textarea', { rows: 2, placeholder: 'Схема, измерения; для учебного примера укажите условность' });
  const note = h('p', { class: 'note', role: 'status' });
  const draft = h('details', { class: 'group' }, h('summary', {}, 'Добавить переезд в центре карты'),
    field('Длина нового переезда между крайними рельсами, м', optionalNumber(undefined, value => { length = value; }, { min: 0.01, step: 0.1 })),
    field('Ширина нового переезда, м', optionalNumber(undefined, value => { width = value; }, { min: 0.01, step: 0.1 })),
    field('Курс дороги нового переезда, °', num(0, value => { angle = rad(value); }, { step: 1 })),
    field('Источник нового переезда', source), note,
    button('Добавить переезд', () => {
      if (!length || !width || !source.value.trim()) { note.textContent = 'Укажите положительные размеры и источник. Для учебной геометрии обозначьте её как условную.'; return; }
      app.edit(() => {
        const crossings = app.scene().railwayCrossings ??= [];
        const ids = new Set(crossings.map(item => item.id));
        let number = crossings.length + 1;
        while (ids.has(`railway-crossing-${number}`)) number++;
        crossings.push({ id: `railway-crossing-${number}`, x: app.editor.cam.x, y: app.editor.cam.y, angle, length: length!, width: width!, source: source.value.trim() });
      });
      rebuild();
    }),
  );
  group.append(draft);
  root.append(group);
}

function intersectionBoundariesForm(root: HTMLElement, app: AppApi, rebuild: () => void): void {
  const intersections = buildGeo(app.scene()).intersections;
  if (!intersections.length) return;
  const group = h('details', { class: 'form' }, h('summary', {}, 'Границы перекрёстков'));
  group.append(h('p', { class: 'note' }, 'Автоматический контур — оценка по геометрии дорог. Для границ по п. 1.2 укажите точки начала закруглений с измеренной схемы. Координаты в метрах.'));
  for (const intersection of intersections) {
    const points = h('textarea', { rows: 5, 'aria-label': `Контур ${intersection.id}`, value: intersection.boundary.map(p => `${+p.x.toFixed(3)}; ${+p.y.toFixed(3)}`).join('\n') });
    const note = h('p', { class: 'note' });
    const panel = h('div', { class: 'group' }, h('h4', {}, `Дороги: ${intersection.roadIds.join(', ')}`), points, note);
    panel.append(button('Сохранить измеренный контур', () => {
      const boundary = points.value.trim().split('\n').map(line => {
        const pair = line.split(';').map(v => Number(v.trim().replace(',', '.')));
        return { x: pair[0], y: pair[1], valid: pair.length === 2 && pair.every(Number.isFinite) };
      });
      let invalid = boundary.length < 3 || boundary.some(p => !p.valid);
      let twiceArea = 0;
      for (let i = 0; i < boundary.length; i++) {
        const next = (i + 1) % boundary.length;
        twiceArea += boundary[i].x * boundary[next].y - boundary[next].x * boundary[i].y;
        for (let j = i + 2; j < boundary.length; j++) {
          if (i === 0 && j === boundary.length - 1) continue;
          if (segIntersect(boundary[i], boundary[next], boundary[j], boundary[(j + 1) % boundary.length])) invalid = true;
        }
      }
      if (invalid || Math.abs(twiceArea) < 0.01) {
        note.textContent = 'Нужен непересекающийся контур из трёх и более точек. Каждая строка: X; Y.';
        return;
      }
      app.edit(() => {
        const bounds = app.scene().intersectionBounds ?? [];
        app.scene().intersectionBounds = [...bounds.filter(b => b.id !== intersection.id), { id: intersection.id, roadIds: [...intersection.roadIds], boundary: boundary.map(({ x, y }) => ({ x, y })) }];
      });
      note.textContent = 'Измеренный контур сохранён.';
    }));
    panel.append(button('Вернуть автоматический контур', () => {
      app.edit(() => { app.scene().intersectionBounds = (app.scene().intersectionBounds ?? []).filter(b => b.id !== intersection.id); });
      rebuild();
    }));
    group.append(panel);
  }
  root.append(group);
}

// ---------------------------------------------------------------------------
// Разбор

let openRefInReference: (id: string) => void = () => {};
export function setRefOpener(fn: (id: string) => void): void {
  openRefInReference = fn;
}

function refChip(id: string, host: HTMLElement, date: string): HTMLElement {
  const r = lawRef(id, date);
  const d = describeRef(id);
  const label = `${d.cite}${d.code === 'ПДД' || d.code === 'КоАП' || d.code === 'УК' ? ' ' + d.code : ''}`;
  const cls = `chip ${d.code === 'ПДД' ? 'pdd' : d.code === 'КоАП' ? 'koap' : d.code === 'УК' ? 'uk' : 'gk'}`;
  const btn = h('button', { type: 'button', class: cls }, label);
  btn.addEventListener('click', () => {
    let box = host.querySelector<HTMLElement>(`.refbox[data-ref="${CSS.escape(id)}"]`);
    if (box) {
      box.remove();
      btn.classList.remove('open');
      return;
    }
    const fallback = () => [
      h('b', {}, `${label}${r ? ' — ' + r.title : ''}`),
      h('p', {}, r.text || r.warning || 'Текст нормы недоступен.'),
      r?.sanction ? h('p', { class: 'sanction' }, h('b', {}, 'Санкция: '), r.sanction) : null,
    ];
    box = h('div', { class: 'refbox', 'data-ref': id }, ...fallback());
    host.append(box);
    btn.classList.add('open');
    // дословный текст нормы подгружается из полного корпуса
    const el = box;
    loadCorpus()
      .then((c) => {
        const full = resolveRef(c, id, date);
        if (!full || !el.isConnected) return;
        el.replaceChildren(
          h('b', {}, `${full.cite}${full.title ? ' — ' + full.title : ''}`),
          ...full.images.slice(0, 4).map((src) => h('img', { src: imgUrl(src), alt: '', class: 'sign-big' })),
          ...full.text.split('\n').map((t) => h('p', {}, t)),
          ...(full.sanction && !full.text.includes(full.sanction.slice(0, 40)) ? [h('p', { class: 'sanction' }, h('b', {}, 'Санкция: '), full.sanction)] : []),
          h('small', {}, 'Справочник показывает последнюю загруженную редакцию. Дата ДТП применяется в этом разборе.'),
          h('button', { type: 'button', class: 'btn', onclick: () => openRefInReference(id) }, 'Открыть в справочнике'),
        );
      })
      .catch(() => {});
  });
  return h('span', {}, btn,
    r.source ? h('small', {}, ` в редакции от ${r.source.revisionDate}, источник `,
      h('a', { href: r.source.url, target: '_blank', rel: 'noopener noreferrer', title: r.source.docTitle }, 'КонсультантПлюс')) : null,
    r.warning ? h('small', { class: 'note' }, ` ${r.warning}`) : null,
  );
}

function refs(ids: string[], date: string): HTMLElement {
  const wrap = h('div', { class: 'refs' });
  const row = h('div', { class: 'chips' });
  const uniq = [...new Set(ids)];
  for (const id of uniq) row.append(refChip(id, wrap, date));
  wrap.prepend(row);
  return wrap;
}

const SEV_LABEL: Record<Finding['severity'], string> = {
  violation: 'Нарушение',
  contributing: 'Сопутствующее обстоятельство',
  info: 'Примечание',
};

export function buildReport(root: HTMLElement, app: AppApi): void {
  root.replaceChildren();
  const rep = app.report();
  if (!rep) {
    root.append(
      h('div', { class: 'empty' },
        h('h3', {}, 'Разбор появится после запуска'),
        h('p', {}, 'Нажмите ▶ внизу: сцена будет просчитана, а здесь появится разбор по ПДД, КоАП и УК РФ.'),
      ),
    );
    return;
  }
  const scene = app.scene();
  const labels = actorLabels(scene);
  const title = (id: string) => {
    const a = scene.actors.find((x) => x.id === id)!;
    return actorTitle(a, labels);
  };
  const dot = (id: string) => h('i', { class: 'dot', style: `background:${scene.actors.find((x) => x.id === id)?.color ?? '#999'}` });

  // сводка
  root.append(
    h('div', { class: `summary ${rep.hasCollision ? 'bad' : 'ok'}` },
      ...rep.summary.map((s, i) => h(i === 0 ? 'h3' : 'p', {}, s)),
    ),
  );

  root.append(h('p', { class: 'note' }, `Дата и время ДТП: ${rep.accidentDate.replace('T', ' ')} (местное время).`));
  if (rep.legalWarnings.length) root.append(
    h('div', { class: 'summary bad' }, h('h4', {}, 'Предупреждения о редакциях норм'),
      ...rep.legalWarnings.map((warning) => h('p', {}, warning))),
  );

  const traceView = (trace: object) => h('details', { class: 'trace' },
    h('summary', {}, 'Данные и расчёты'), h('pre', {}, JSON.stringify(trace, null, 2)));

  const technical = h('section', { class: 'report-technical' }, h('h3', {}, 'Технические выводы'));
  for (const c of rep.technical.collisions) {
    const card = h('div', { class: 'collision' }, h('p', {}, `Контакт в ${c.collision.t.toFixed(1)} с, скорость сближения ${(c.collision.rel * 3.6).toFixed(1)} км/ч.`));
    for (const t of c.tech) card.append(
      h('p', {}, `${title(t.actorId)}: опасность с ${t.tHazard.toFixed(1)} с; скорость ${t.speedKmh.toFixed(1)} км/ч; доступно ${t.available.toFixed(1)} м; остановочный путь ${t.stopDist.toFixed(1)} м. ${t.avoidable ? 'Техническая возможность остановиться была.' : 'Технической возможности остановиться не было.'}`),
      h('p', {}, `Расчётный диапазон остановочного пути: ${t.ranges.stopDist[0].toFixed(1)}–${t.ranges.stopDist[1].toFixed(1)} м при времени реакции ${t.ranges.reaction[0]}–${t.ranges.reaction[1]} с.`), traceView(t.trace));
    for (const harm of c.harm) card.append(h('p', {}, `${title(harm.actorId)}: ${HARM_LABEL[harm.level]}`));
    card.append(traceView(c.trace));
    technical.append(card);
  }
  if (!rep.technical.collisions.length) technical.append(h('p', {}, 'Столкновений не зафиксировано.'));
  for (const e of rep.technical.events.filter(e => e.kind !== 'collision')) technical.append(
    h('details', {}, h('summary', {}, `${e.t.toFixed(1)} с · ${e.text}`), traceView(e.trace)));
  for (const actor of scene.actors) {
    const points = rep.technical.points.filter(p => p.actorId === actor.id);
    if (!points.length) continue;
    // Keep the visible table compact; full frame evidence remains in the report.
    const selected = points.filter((p, index) => index === 0 || index === points.length - 1 || Math.floor(p.t) !== Math.floor(points[index - 1].t));
    const table = h('table', { class: 'wp' }, h('tr', {}, h('th', {}, 'Время'), h('th', {}, 'км/ч'), h('th', {}, 'Положение')));
    for (const p of selected) table.append(h('tr', {},
      h('td', {}, h('button', { type: 'button', class: 'time', onclick: () => app.seek(p.t) }, `${p.t.toFixed(1)} с`)),
      h('td', {}, p.speedKmh.toFixed(1)),
      h('td', {}, p.roads.length === 1 ? `Полоса от оси: ${p.roads[0].laneFromAxis}; смещение ${p.roads[0].lateral.toFixed(1)} м` : p.roads.length ? 'Пересечение дорог' : 'Вне проезжей части')));
    technical.append(h('details', {}, h('summary', {}, `${title(actor.id)}: скорость и положение на траектории`), table));
  }
  for (const event of rep.technical.nearMisses) technical.append(h('p', {}, `Сближение ${title(event.a)} и ${title(event.b)}: просвет ${event.gap.toFixed(1)} м в ${event.t.toFixed(1)} с.`), traceView(event.trace));
  root.append(technical);

  const rules = h('section', { class: 'report-rules' }, h('h3', {}, 'Соответствие ПДД'));
  for (const graph of rep.rules.priorityGraphs) {
    const panel = h('details', { class: 'group', ...(graph.agreementRequired ? { open: true } : {}) },
      h('summary', {}, `Очерёдность проезда: ${graph.participants.map(p => labels.get(p.actorId) ?? p.actorId).join(', ')}`));
    if (graph.agreementRequired) panel.append(h('p', { class: 'note' }, 'В очерёдности проезда возник цикл. Водители договариваются, см. п. 13.11 и 1.5. Нарушитель по одному этому признаку не назначается.'), refs(['pdd:13.11', 'pdd:1.5'], rep.accidentDate));
    for (const edge of graph.edges) panel.append(h('p', {}, `${labels.get(edge.from) ?? edge.from} уступает ${labels.get(edge.to) ?? edge.to}: ${edge.explain}`), refs(edge.refs.filter(r => !r.startsWith('rule:')), rep.accidentDate));
    if (!graph.edges.length) panel.append(h('p', {}, 'Обязанность уступить между этими участниками по заданным данным не установлена.'));
    rules.append(panel);
  }
  for (const v of rep.rules.actors) {
    const card = h('div', { class: `person ${v.status}`, onmouseenter: () => app.focus(v.actorId), onmouseleave: () => app.focus(null) },
      h('div', { class: 'ph' }, dot(v.actorId), h('b', {}, title(v.actorId)), h('span', { class: 'tag' }, STATUS_LABEL[v.status])), h('p', {}, v.text));
    for (const f of rep.rules.findings.filter(f => f.actorId === v.actorId)) card.append(
      h('details', { class: `finding ${f.severity}${f.causal ? ' causal' : ''}` },
        h('summary', {}, h('span', { class: 'sev' }, SEV_LABEL[f.severity] + (f.causal ? ' · причинная связь' : '')), ' ', f.title,
          f.t !== undefined ? h('button', { type: 'button', class: 'time', onclick: (e: Event) => { e.preventDefault(); app.seek(f.t!); } }, `${f.t.toFixed(1)} с`) : null),
        h('p', {}, `${f.requirement}: ${f.compliance}.`), h('p', {}, f.detail),
        h('p', {}, f.prevention === null ? 'Предотвращение ДТП при устранении нарушения: не определить по имеющимся расчётам.' : f.prevention ? 'Устранение нарушения предотвращало ДТП по расчётной модели.' : 'Устранение нарушения не предотвращало ДТП по расчётной модели.'),
        refs(f.refs, rep.accidentDate), traceView(f.trace)));
    rules.append(card);
  }
  for (const c of rep.rules.collisions) rules.append(collisionCard(c, app, title));
  root.append(rules);

  const legal = h('section', { class: 'report-legal' }, h('h3', {}, 'Ориентировочная правовая оценка (решение принимает суд/орган)'),
    h('p', {}, `Дата оценки: ${rep.legal.assessmentDate}. Доступная редакция: ${rep.legal.editionDate}.`));
  for (const v of rep.legal.verdicts) {
    const card = h('div', { class: 'person' }, h('h4', {}, title(v.actorId)));
    if (!v.legal.length) card.append(h('p', {}, 'Оснований для квалификации в пределах модели не выявлено.'));
    for (const l of v.legal) {
      card.append(h('p', {}, l.text), refs(l.refs, rep.legal.assessmentDate));
      for (const sanction of l.sanctions ?? []) card.append(h('p', {}, sanction.text ?? 'Санкция в редакции на дату оценки не определена.'));
      card.append(traceView(l.trace));
    }
    legal.append(card);
  }
  root.append(legal);

  // хронология
  if (rep.events.length) {
    const list = h('ol', { class: 'events' });
    for (const e of rep.events) list.append(h('li', {}, h('button', { type: 'button', class: 'time', onclick: () => app.seek(e.t) }, `${e.t.toFixed(1)} с`), ' ', e.text));
    root.append(h('h4', { class: 'sec' }, 'Хронология'), list);
  }

  if (rep.duties.length) {
    const d = h('div', { class: 'duties' });
    for (const x of rep.duties) d.append(h('div', { class: 'li' }, h('p', {}, x.text), refs(x.refs, rep.legal.assessmentDate)));
    legal.append(h('h4', { class: 'sec' }, 'Что обязаны сделать участники ДТП'), d);
  }

  root.append(
    h('h4', { class: 'sec' }, 'Допущения расчёта'),
    h('ul', { class: 'assume' }, ...rep.assumptions.map((s) => h('li', {}, s))),
    h('p', { class: 'disclaimer' }, DISCLAIMER),
  );
}

function collisionCard(c: CollisionReport, app: AppApi, title: (id: string) => string): HTMLElement {
  const card = h('div', { class: 'collision' },
    h('div', { class: 'ch' }, h('b', {}, c.title), h('button', { type: 'button', class: 'time', onclick: () => app.seek(c.collision.t) }, `${c.collision.t.toFixed(1)} с`)),
    h('p', {}, c.description),
  );
  const harm = h('ul', { class: 'harm' });
  for (const x of c.harm) {
    const isObstacle = !app.scene().actors.some((a) => a.id === x.actorId);
    if (!isObstacle) harm.append(h('li', {}, `${title(x.actorId)}: ${HARM_LABEL[x.level]}`));
  }
  card.append(harm);
  for (const n of c.notes) card.append(h('p', { class: 'note' }, n));
  return card;
}

// ---------------------------------------------------------------------------
// Каталог знаков (выбор знака и таблички)

export function signThumb(id: string, size: number): HTMLElement {
  const f = signFile(id);
  return f ? h('img', { src: imgUrl(f), alt: id, class: 'sign-thumb', style: `width:${size}px;height:${size}px` }) : h('span', { class: 'sign-thumb ph', style: `width:${size}px;height:${size}px` }, id);
}

export function closeModal(): void {
  document.getElementById('modal')?.classList.add('hidden');
}

export function openModal(body: HTMLElement): void {
  document.getElementById('modalBody')?.replaceChildren(body);
  document.getElementById('modal')?.classList.remove('hidden');
}

export interface SignPickerOpts {
  current?: string;
  /** ограничить группой знаков, например '8' — только таблички */
  only?: string;
  onPick: (id: string) => void;
}

/** Контент каталога знаков: поиск, группы и сетка картинок. */
export function signPicker(o: SignPickerOpts, afterPick: () => void): HTMLElement {
  let group = o.only ?? 'all';
  let query = '';
  const grid = h('div', { class: 'sign-grid' });
  const search = h('input', { type: 'search', class: 'ref-search', placeholder: 'Номер или название: 3.24, обгон, пешеход', 'aria-label': 'Поиск знака' });
  const chips = h('div', { class: 'ref-tabs' });
  const draw = () => {
    const q = query.trim().toLowerCase().replace(/ё/g, 'е');
    const ids = SIGN_IDS.filter((id) => (group === 'all' || signGroupOf(id) === group) && (!q || id.startsWith(q) || signTitle(id).toLowerCase().replace(/ё/g, 'е').includes(q)));
    grid.replaceChildren(
      ...ids.map((id) =>
        h('button', { type: 'button', class: `sign-cell${o.current === id ? ' on' : ''}`, title: `${id} ${signTitle(id)}`, onclick: () => { o.onPick(id); afterPick(); } },
          signThumb(id, 56),
          h('span', {}, id),
        ),
      ),
    );
    if (!ids.length) grid.append(h('p', { class: 'note' }, 'Ничего не найдено'));
    chips.replaceChildren(
      ...(o.only ? [] : [{ id: 'all', title: 'Все' }, ...SIGN_GROUPS].map((g) => h('button', { type: 'button', class: `pchip${group === g.id ? ' on' : ''}`, onclick: () => { group = g.id; draw(); } }, g.id === 'all' ? 'Все' : `${g.id}. ${g.title}`))),
    );
  };
  search.addEventListener('input', () => {
    query = search.value;
    draw();
  });
  draw();
  return h('div', { class: 'picker' }, h('h2', {}, o.only === '8' ? 'Таблички' : 'Дорожные знаки'), search, chips, grid);
}

export function openSignPicker(o: SignPickerOpts): void {
  openModal(signPicker(o, closeModal));
}
