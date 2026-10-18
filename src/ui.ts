import { type ActorVerdict, type CollisionReport, type Finding, type Report, HARM_LABEL } from './analysis';
import type { Editor } from './editor';
import { deg, rad } from './geom';
import { DISCLAIMER, LAW, LAW_CHECKED } from './law';
import {
  type Actor,
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
    case 'signs':
      box.append(
        field(
          'Знак',
          select(
            [['main', '2.1 Главная дорога'], ['giveway', '2.4 Уступите дорогу'], ['stop', '2.5 Движение без остановки запрещено'], ['noentry', '3.1 Въезд запрещён'], ['limit', '3.24 Ограничение скорости'], ['noovertake', '3.20 Обгон запрещён'], ['crosswalk', '5.19.1 Пешеходный переход']],
            it.kind,
            (v) => app.edit(() => ((it.kind = v), v === 'limit' && !it.value && (it.value = 40)), true),
          ),
        ),
        ...(it.kind === 'limit' ? [field('Ограничение, км/ч', num(it.value ?? 40, set((v) => (it.value = v)), { min: 5, max: 130, step: 5 }))] : []),
        field('Направление движения, °', num(deg(it.angle), set((v: number) => (it.angle = rad(v))), { step: 5 }), 'Знак действует для ТС, едущих в этом направлении.'),
      );
      break;
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

function refChip(id: string, host: HTMLElement): HTMLElement {
  const r = LAW[id];
  const label = r ? `${r.cite}${r.code === 'ПДД' || r.code === 'КоАП' || r.code === 'УК' ? ' ' + r.code : ''}` : id;
  const cls = r ? `chip ${r.code === 'ПДД' ? 'pdd' : r.code === 'КоАП' ? 'koap' : r.code === 'УК' ? 'uk' : 'gk'}` : 'chip';
  const btn = h('button', { type: 'button', class: cls }, label);
  btn.addEventListener('click', () => {
    let box = host.querySelector<HTMLElement>(`.refbox[data-ref="${id}"]`);
    if (box) {
      box.remove();
      btn.classList.remove('open');
      return;
    }
    if (!r) return;
    box = h('div', { class: 'refbox', 'data-ref': id },
      h('b', {}, `${r.cite} ${r.code === 'ГК' || r.code === 'ОСАГО' ? '' : r.code + ' РФ'} — ${r.title}`),
      h('p', {}, r.text),
      r.sanction ? h('p', { class: 'sanction' }, h('b', {}, 'Санкция: '), r.sanction) : null,
    );
    host.append(box);
    btn.classList.add('open');
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
