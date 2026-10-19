import { type ActorVerdict, type CollisionReport, type Finding, type Report, HARM_LABEL } from './analysis';
import type { Editor } from './editor';
import { deg, rad } from './geom';
import { imgUrl, loadCorpus, resolveRef } from './corpus';
import { DISCLAIMER, LAW, LAW_CHECKED, describeRef } from './law';
import { ARROW_VARIANTS, MARKINGS, MARKING_BY_ID } from './markings';
import { SIGN_GROUPS, SIGN_IDS, VALUE_SIGNS, signFile, signGroupOf, signTitle } from './signs';
import {
  type Actor,
  NO_CARGO,
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

function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  return h('button', { type: 'button', class: `btn ${cls}`, onclick: onClick }, label);
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
    tracks: 'Трамвайный путь',
    crosswalks: 'Пешеходный переход',
    lights: 'Светофор',
    signs: 'Дорожный знак',
    markings: 'Дорожная разметка',
    obstacles: 'Препятствие',
    actors: it.kind === 'pedestrian' ? 'Пешеход' : 'Транспортное средство',
  }[sel.col];
  const box = h('div', { class: 'form' }, h('h3', {}, title));

  switch (sel.col) {
    case 'roads':
      box.append(
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
      break;
    case 'sidewalks':
      box.append(
        field('Ширина, м', num(it.width, set((v) => (it.width = v)), { min: 1, max: 8, step: 0.5 })),
        field('Радиус скругления, м', num(it.radius ?? 0, set((v) => (it.radius = v)), { min: 0, max: 100 })),
        check('Плавный сплайн (если радиус 0)', it.smooth, set((v) => (it.smooth = v))),
      );
      break;
    case 'tracks':
      box.append(
        check('Выделенный путь (отделён бордюром)', it.separated, set((v) => (it.separated = v))),
        field('Радиус скругления, м', num(it.radius ?? 0, set((v) => (it.radius = v)), { min: 0, max: 200 })),
        check('Плавный сплайн (если радиус 0)', it.smooth, set((v) => (it.smooth = v))),
        button('Развернуть направление', () => app.edit(() => it.pts.reverse())),
        h('small', {}, 'Направление пути важно: выезд на трамвайные пути встречного направления запрещён (п. 9.6 ПДД).'),
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
          'Пешеходам горит зелёный, пока у ТС красный.',
        ),
      );
      break;
    }
    case 'lights':
      box.append(
        field('Направление движения ТС, °', num(deg(it.angle), set((v: number) => (it.angle = rad(v))), { step: 5 }), '0° — вправо, 90° — вниз'),
        field('Длина стоп-линии, м', num(it.lineLength, set((v) => (it.lineLength = v)), { min: 2, max: 30, step: 0.5 })),
        field('Зелёный, с', num(it.green, set((v) => (it.green = v)), { min: 1, max: 120 })),
        field('Жёлтый, с', num(it.yellow, set((v) => (it.yellow = v)), { min: 1, max: 10 })),
        field('Красный, с', num(it.red, set((v) => (it.red = v)), { min: 1, max: 120 })),
        field('Сдвиг цикла, с', num(it.offset, set((v) => (it.offset = v)), { min: 0, max: 240 }), 'Чтобы встречные направления горели по очереди.'),
      );
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
      if (list.includes('8.2.1')) plates.append(field('Зона действия, м', num(it.zoneLen ?? VALUE_SIGNS['8.2.1'].def, set((v) => (it.zoneLen = v)), { min: 10, max: 1000, step: 10 })));
      box.append(plates);
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

function actorForm(box: HTMLElement, a: Actor, app: AppApi, rebuild: () => void): void {
  const ed = app.editor;
  const set = <T,>(fn: (v: T) => void) => (v: T) => app.edit(() => fn(v));
  const isVeh = a.kind === 'vehicle';
  const types: [string, string][] = isVeh
    ? (Object.keys(VEHICLES) as VehicleType[]).map((k) => [k, VEHICLES[k].name])
    : (Object.keys(PEDESTRIANS) as (keyof typeof PEDESTRIANS)[]).map((k) => [k, PEDESTRIANS[k].name]);
  const color = h('input', { type: 'color', value: a.color });
  color.addEventListener('change', () => app.edit(() => (a.color = color.value)));
  box.append(
    field('Тип', select(types, a.type, (v) => app.edit(() => (a.type = v as Actor['type']), true))),
    field('Цвет', color),
    field('Скорость в начале, км/ч', num(a.speed, set((v) => (a.speed = v)), { min: 0, max: 250 })),
    field('Появится через, с', num(a.delay, set((v) => (a.delay = v)), { min: 0, max: 60, step: 0.5 })),
    field('Курс, °', num(deg(a.heading), set((v: number) => (a.heading = rad(v))), { step: 5, disabled: a.path.length > 0 }), a.path.length ? 'Курс задаёт первая точка траектории.' : '0° — вправо, 90° — вниз'),
  );
  if (isVeh) {
    box.append(
      h('div', { class: 'group' },
        h('h4', {}, 'Водитель'),
        check('Нетрезв (опьянение)', a.flags.drunk, set((v) => (a.flags.drunk = v))),
        check('Нет права управления', a.flags.noLicense, set((v) => (a.flags.noLicense = v))),
        check('Скрывается с места ДТП', a.flags.flees, set((v) => (a.flags.flees = v))),
      ),
    );
  }
  if (isVeh && VEHICLES[a.type as VehicleType].rail) {
    box.append(
      h('div', { class: 'group' },
        h('h4', {}, 'Рельсы'),
        h('p', { class: 'hint' }, 'Трамвай едет строго по ближайшему пути (точки маршрута притягиваются к колее). Удар его не сдвигает, он тормозит на рельсах.'),
        check('Возможен сход с путей (удар от 20 км/ч)', !!a.derail, set((v) => (a.derail = v))),
      ),
    );
  }
  if (isVeh && !VEHICLES[a.type as VehicleType].rail) cargoForm(box, a, app);
  // траектория
  const pathBox = h('div', { class: 'group' }, h('h4', {}, 'Траектория'));
  pathBox.append(
    h('div', { class: 'row' },
      button(ed.tool === 'path' ? 'Рисую… (нажмите «Готово»)' : a.path.length ? 'Дорисовать траекторию' : 'Нарисовать траекторию', () => ed.setTool(ed.tool === 'path' ? 'select' : 'path'), 'primary'),
      button('Очистить', () => app.edit(() => ((a.path = []), (ed.selWp = null)), true)),
    ),
    h('small', {}, 'Нажимайте на карту, чтобы ставить точки. Скорость в точке — та, с которой ТС её проезжает; тормозит максимально поздно. Нулевая скорость — остановка в точке.'),
  );
  if (a.path.length) {
    const table = h('table', { class: 'wp' }, h('tr', {}, h('th', {}, '№'), h('th', {}, 'км/ч'), h('th', {}, 'пауза, с'), h('th', {})));
    a.path.forEach((w, i) => {
      const tr = h('tr', { class: ed.selWp === i ? 'on' : '', onclick: () => ed.select(ed.sel, i) },
        h('td', {}, String(i + 1)),
        h('td', {}, num(w.v, set((v) => (w.v = v)), { min: 0, max: 250 })),
        h('td', {}, w.v < 0.3 ? num(w.hold ?? 0, set((v) => (w.hold = v)), { min: 0, max: 30, step: 0.5 }) : '—'),
        h('td', {}, h('button', { type: 'button', class: 'x', title: 'Удалить точку', onclick: (e: Event) => { e.stopPropagation(); app.edit(() => { a.path.splice(i, 1); ed.syncHeading(a); ed.selWp = null; }, true); } }, '✕')),
      );
      table.append(tr);
    });
    pathBox.append(table);
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
      field('Покрытие', select(Object.entries(SURFACES).map(([k, v]) => [k, `${v.name} (μ = ${v.mu})`] as [string, string]), s.env.surface, set((v: string) => (s.env.surface = v as Scene['env']['surface']))), 'От сцепления зависят тормозной путь и техническая возможность остановиться.'),
      field('Длительность, с', num(s.env.duration, set((v) => (s.env.duration = v)), { min: 3, max: 120 })),
      h('h3', {}, 'Редактор'),
      check('Показывать сетку', extra.grid, extra.setGrid),
      check('Привязка к сетке и к концам дорог', app.editor.snap, (v) => (app.editor.snap = v)),
      h('p', { class: 'note' }, 'Чтобы перемещать карту, перетаскивайте пустое место, колесо мыши — масштаб. На телефоне: два пальца — масштаб и перемещение.'),
    ),
  );
}

// ---------------------------------------------------------------------------
// Разбор

let openRefInReference: (id: string) => void = () => {};
export function setRefOpener(fn: (id: string) => void): void {
  openRefInReference = fn;
}

function refChip(id: string, host: HTMLElement): HTMLElement {
  const r = LAW[id];
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
      r ? h('p', {}, r.text) : h('p', {}, 'Текст нормы недоступен.'),
      r?.sanction ? h('p', { class: 'sanction' }, h('b', {}, 'Санкция: '), r.sanction) : null,
    ];
    box = h('div', { class: 'refbox', 'data-ref': id }, ...fallback());
    host.append(box);
    btn.classList.add('open');
    // дословный текст нормы подгружается из полного корпуса
    const el = box;
    loadCorpus()
      .then((c) => {
        const full = resolveRef(c, id);
        if (!full || !el.isConnected) return;
        el.replaceChildren(
          h('b', {}, `${full.cite}${full.title ? ' — ' + full.title : ''}`),
          ...full.images.slice(0, 4).map((src) => h('img', { src: imgUrl(src), alt: '', class: 'sign-big' })),
          ...full.text.split('\n').map((t) => h('p', {}, t)),
          ...(full.sanction && !full.text.includes(full.sanction.slice(0, 40)) ? [h('p', { class: 'sanction' }, h('b', {}, 'Санкция: '), full.sanction)] : []),
          h('button', { type: 'button', class: 'btn', onclick: () => openRefInReference(id) }, 'Открыть в справочнике'),
        );
      })
      .catch(() => {});
  });
  return btn;
}

function refs(ids: string[]): HTMLElement {
  const wrap = h('div', { class: 'refs' });
  const row = h('div', { class: 'chips' });
  const uniq = [...new Set(ids)];
  for (const id of uniq) row.append(refChip(id, wrap));
  wrap.prepend(row);
  return wrap;
}

const SEV_LABEL: Record<Finding['severity'], string> = {
  violation: 'Нарушение',
  contributing: 'Сопутствующее обстоятельство',
  info: 'Примечание',
};

const STATUS_LABEL: Record<ActorVerdict['status'], string> = {
  guilty: 'Нарушения в причинной связи с ДТП',
  minor: 'Есть нарушения',
  clean: 'Нарушений не выявлено',
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

  // участники
  const people = h('div', { class: 'people' });
  for (const v of rep.verdicts) {
    const card = h('div', { class: `person ${v.status}`, onmouseenter: () => app.focus(v.actorId), onmouseleave: () => app.focus(null) },
      h('div', { class: 'ph' }, dot(v.actorId), h('b', {}, title(v.actorId)), h('span', { class: 'tag' }, STATUS_LABEL[v.status])),
      h('p', {}, v.text),
    );
    const mine = rep.findings.filter((f) => f.actorId === v.actorId);
    for (const f of mine) {
      const det = h('details', { class: `finding ${f.severity}${f.causal ? ' causal' : ''}` },
        h('summary', {},
          h('span', { class: 'sev' }, SEV_LABEL[f.severity] + (f.causal ? ' · причинная связь' : '')),
          ' ',
          f.title,
          f.t !== undefined ? h('button', { type: 'button', class: 'time', onclick: (e: Event) => { e.preventDefault(); app.seek(f.t!); } }, `${f.t.toFixed(1)} с`) : null,
        ),
        h('p', {}, f.detail),
        refs(f.refs),
      );
      card.append(det);
    }
    if (v.legal.length) {
      const legal = h('div', { class: 'legal' }, h('h4', {}, 'Возможная ответственность'));
      for (const l of v.legal) legal.append(h('div', { class: 'li' }, h('p', {}, l.text), refs(l.refs)));
      card.append(legal);
    }
    people.append(card);
  }
  root.append(h('h4', { class: 'sec' }, 'Участники'), people);

  // столкновения
  if (rep.collisions.length) {
    root.append(h('h4', { class: 'sec' }, 'Столкновения и техническая возможность предотвращения'));
    for (const c of rep.collisions) root.append(collisionCard(c, app, title));
  }

  // хронология
  if (rep.events.length) {
    const list = h('ol', { class: 'events' });
    for (const e of rep.events) list.append(h('li', {}, h('button', { type: 'button', class: 'time', onclick: () => app.seek(e.t) }, `${e.t.toFixed(1)} с`), ' ', e.text));
    root.append(h('h4', { class: 'sec' }, 'Хронология'), list);
  }

  if (rep.duties.length) {
    const d = h('div', { class: 'duties' });
    for (const x of rep.duties) d.append(h('div', { class: 'li' }, h('p', {}, x.text), refs(x.refs)));
    root.append(h('h4', { class: 'sec' }, 'Что обязаны сделать участники ДТП'), d);
  }

  root.append(
    h('h4', { class: 'sec' }, 'Допущения расчёта'),
    h('ul', { class: 'assume' }, ...rep.assumptions.map((s) => h('li', {}, s))),
    h('p', { class: 'disclaimer' }, DISCLAIMER, ` Нормы сверены: ${LAW_CHECKED}.`),
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
