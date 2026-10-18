import './style.css';
import { analyze, type Report } from './analysis';
import { type Tool, Editor, POLY_TOOLS } from './editor';
import { clamp } from './geom';
import { PRESETS } from './presets';
import { Renderer } from './render';
import { type Scene, VEHICLES, PEDESTRIANS, emptyScene, normalizeScene } from './scene';
import { DT, type Timeline, simulate } from './sim';
import { DISCLAIMER, LAW_CHECKED } from './law';
import { type AppApi, buildEnv, buildInspector, buildReport, h, openSignPicker, setRefOpener, signThumb } from './ui';
import { ARROW_VARIANTS, MARKINGS, MARKING_BY_ID } from './markings';
import { VALUE_SIGNS, signTitle } from './signs';
import { buildReference, focusRef } from './reference';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const STORE = 'crashtest.scene.v1';

// ---------------------------------------------------------------------------
// Загрузка и сохранение

function encodeShare(scene: Scene): string {
  const json = JSON.stringify(scene);
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeShare(s: string): Scene {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return normalizeScene(JSON.parse(new TextDecoder().decode(bytes)));
}

function loadInitial(): Scene {
  try {
    const m = location.hash.match(/^#s=(.+)$/);
    if (m) return decodeShare(m[1]);
  } catch {
    /* повреждённая ссылка — открываем пример */
  }
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) {
      const s = normalizeScene(JSON.parse(raw));
      if (s.roads.length || s.actors.length) return s;
    }
  } catch {
    /* хранилище недоступно */
  }
  return PRESETS[0].build();
}

// ---------------------------------------------------------------------------
// Состояние приложения

const canvas = $<HTMLCanvasElement>('cv');
const renderer = new Renderer(canvas);
const editor = new Editor(loadInitial(), canvas, renderer);

let mode: 'edit' | 'play' = 'edit';
let t = 0;
let tl: Timeline | null = null;
let report: Report | null = null;
let playing = false;
let speed = 1;
let focus: string | null = null;
let grid = true;
let follow = true;
let dirty = true;
let saveTimer = 0;

const api: AppApi = {
  editor,
  scene: () => editor.scene,
  report: () => report,
  edit(fn, rebuild) {
    editor.checkpoint();
    fn();
    editor.changed(true);
    if (rebuild) refreshInspector();
    updateHint();
  },
  seek(time) {
    if (!tl) runSim(false);
    if (!tl) return;
    enterPlay();
    playing = false;
    t = clamp(time - 0.3, 0, tl.duration);
    syncPlayer();
    dirty = true;
  },
  focus(id) {
    focus = id;
    dirty = true;
  },
};

// ---------------------------------------------------------------------------
// Симуляция

function invalidate(): void {
  if (tl || report || mode === 'play') {
    tl = null;
    report = null;
    mode = 'edit';
    playing = false;
    editor.locked.value = false;
    $('repBadge').classList.add('hidden');
    buildReport($('pane-report'), api);
    syncPlayer();
  }
}

function enterPlay(): void {
  mode = 'play';
  editor.locked.value = true;
  document.body.classList.add('playing');
}

function leavePlay(): void {
  if (follow && mode === 'play') editor.fit();
  mode = 'edit';
  playing = false;
  editor.locked.value = false;
  document.body.classList.remove('playing');
  syncPlayer();
  dirty = true;
}

function runSim(start = true): void {
  if (editor.tool === 'path' || editor.drawing?.pts.length) editor.finishDrawing();
  if (!editor.scene.actors.length) {
    toast('Сначала добавьте на сцену транспорт или пешехода');
    return;
  }
  tl = simulate(editor.scene);
  report = analyze(editor.scene, tl);
  enterPlay();
  t = 0;
  playing = start;
  follow = true;
  syncFollow();
  openedReport = false;
  buildReport($('pane-report'), api);
  const badge = $('repBadge');
  badge.textContent = report.hasCollision ? '!' : '✓';
  badge.className = `badge ${report.hasCollision ? 'bad' : 'ok'}`;
  if (!isMobile()) showTab('report');
  syncPlayer();
  dirty = true;
}

// ---------------------------------------------------------------------------
// Интерфейс

const isMobile = (): boolean => window.matchMedia('(max-width: 860px)').matches;

function toast(text: string): void {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  window.clearTimeout((toast as unknown as { id?: number }).id);
  (toast as unknown as { id?: number }).id = window.setTimeout(() => el.classList.add('hidden'), 2600);
}

const TOOLS: [Tool, string, string][] = [
  ['select', '↖', 'Выбрать'],
  ['pan', '✋', 'Рука'],
  ['road', '🛣️', 'Дорога'],
  ['sidewalk', '▭', 'Тротуар'],
  ['track', '🚋', 'Трамв. путь'],
  ['crosswalk', '🦓', 'Переход'],
  ['light', '🚦', 'Светофор'],
  ['sign', '⚠️', 'Знак'],
  ['marking', '═', 'Разметка'],
  ['obstacle', '🏢', 'Препятствие'],
  ['vehicle', '🚗', 'Транспорт'],
  ['ped', '🚶', 'Пешеход'],
  ['path', '〰️', 'Траектория'],
];

const HINTS: Partial<Record<Tool, string>> = {
  select: 'Нажмите на объект, чтобы изменить. Перетаскивайте пустое место — двигаете карту.',
  pan: 'Перетаскивайте карту. Колесо мыши или два пальца — масштаб.',
  road: 'Нажимайте, чтобы ставить точки оси. Повороты скругляются по выбранному радиусу. Двойной клик или «Готово» — завершить. Кромки и сужения — после выбора дороги.',
  sidewalk: 'Нажимайте, чтобы ставить точки тротуара. Двойной клик или «Готово» — завершить.',
  track: 'Рисуйте путь по направлению движения трамвая. «Готово» — завершить.',
  crosswalk: 'Нажмите на дороге — переход встанет поперёк. Потяните, чтобы задать направление.',
  light: 'Нажмите у края дороги: светофор и стоп-линия встанут по ходу полосы. Потяните, чтобы задать направление.',
  marking: 'Выберите вид разметки. Линии и площадки рисуются точками («Готово» — завершить), стрелы ставятся нажатием на полосу.',
  sign: 'Нажмите у края дороги — знак встанет лицом к ближайшей полосе. Потяните, чтобы задать направление.',
  obstacle: 'Нажмите, чтобы поставить препятствие. Потяните, чтобы повернуть.',
  vehicle: 'Нажмите на полосе — машина встанет по ходу движения. Потяните, чтобы задать курс вручную.',
  ped: 'Нажмите, чтобы поставить пешехода. Потяните, чтобы задать направление.',
  path: 'Нажимайте на карте, чтобы ставить точки траектории выбранного участника. «Готово» — завершить.',
};

function buildTools(): void {
  const nav = $('tools');
  nav.replaceChildren(
    ...TOOLS.map(([tool, icon, label]) =>
      h('button', { type: 'button', class: 'tool', 'data-tool': tool, title: label, onclick: () => pickTool(tool) }, h('span', { class: 'ti' }, icon), h('span', { class: 'tl' }, label)),
    ),
  );
}

function pickTool(tool: Tool): void {
  if (mode === 'play') leavePlay();
  if (tool === 'path' && !editor.selectedActor()) {
    toast('Сначала выберите транспорт или пешехода, затем «Траектория»');
    return;
  }
  editor.setTool(editor.tool === tool && tool !== 'select' ? 'select' : tool);
}

function updateTools(): void {
  document.querySelectorAll<HTMLElement>('.tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === editor.tool));
  renderPalette();
  updateHint();
  refreshInspector();
}

function updateHint(): void {
  const hint = $('hint');
  hint.textContent = HINTS[editor.tool] ?? '';
  const d = editor.drawing;
  const bar = $('drawbar');
  const active = !!d && (POLY_TOOLS.includes(editor.tool) || editor.tool === 'path' || editor.tool === 'marking');
  bar.classList.toggle('hidden', !active);
  if (active) {
    $('drawText').textContent =
      editor.tool === 'path'
        ? `Точек в траектории: ${editor.selectedActor()?.path.length ?? 0}`
        : d!.pts.length
          ? `Точек: ${d!.pts.length}`
          : 'Нажмите на карте';
  }
  hint.classList.toggle('hidden', editor.tool === 'select' && !!editor.sel);
}

function chips<T extends string>(items: [T, string][], cur: T, on: (v: T) => void): HTMLElement {
  return h('div', { class: 'chips-row' }, ...items.map(([v, l]) => h('button', { type: 'button', class: `pchip${v === cur ? ' on' : ''}`, onclick: () => on(v) }, l)));
}

function renderPalette(): void {
  const el = $('palette');
  el.replaceChildren();
  const b = editor.brush;
  const again = () => renderPalette();
  const opt = (label: string, node: HTMLElement) => h('label', { class: 'popt' }, h('span', {}, label), node);
  const sel = <T extends string>(items: [T, string][], v: T, on: (v: T) => void) => {
    const s = h('select', {}, ...items.map(([k, l]) => h('option', { value: k }, l)));
    s.value = v;
    s.addEventListener('change', () => on(s.value as T));
    return s;
  };
  const chk = (label: string, v: boolean, on: (v: boolean) => void) => {
    const i = h('input', { type: 'checkbox', checked: v });
    i.addEventListener('change', () => on(i.checked));
    return h('label', { class: 'popt' }, i, h('span', {}, label));
  };
  const radiusOpt = () =>
    opt('Поворот', sel([['0', 'Острый угол'], ['6', 'Радиус 6 м'], ['12', 'Радиус 12 м'], ['25', 'Радиус 25 м'], ['50', 'Радиус 50 м'], ['-1', 'Плавная кривая']], b.smooth ? '-1' : String(b.radius), (v) => {
      const n = parseInt(v, 10);
      b.smooth = n < 0;
      b.radius = n < 0 ? 0 : n;
      dirty = true;
    }));
  switch (editor.tool) {
    case 'vehicle':
      el.append(chips((Object.keys(VEHICLES) as (keyof typeof VEHICLES)[]).map((k) => [k, VEHICLES[k].name] as [string, string]), b.vehicle, (v) => ((b.vehicle = v as typeof b.vehicle), again())));
      break;
    case 'ped':
      el.append(chips((Object.keys(PEDESTRIANS) as (keyof typeof PEDESTRIANS)[]).map((k) => [k, PEDESTRIANS[k].name] as [string, string]), b.ped, (v) => ((b.ped = v as typeof b.ped), again())));
      break;
    case 'sign':
      el.append(
        h('button', { type: 'button', class: 'sign-pick', onclick: () => openSignPicker({ current: b.sign, onPick: (id) => { b.sign = id; b.signValue = VALUE_SIGNS[id]?.def ?? b.signValue; again(); } }) },
          signThumb(b.sign, 44),
          h('span', {}, h('b', {}, `Знак ${b.sign}`), h('small', {}, signTitle(b.sign))),
          h('span', { class: 'pick-hint' }, 'сменить'),
        ),
      );
      if (VALUE_SIGNS[b.sign]) {
        const vs = VALUE_SIGNS[b.sign];
        const num = h('input', { type: 'number', value: b.signValue, min: vs.min, max: vs.max, step: vs.step });
        num.addEventListener('change', () => (b.signValue = parseFloat(num.value) || vs.def));
        el.append(h('label', { class: 'popt' }, h('span', {}, vs.unit), num));
      }
      break;
    case 'marking': {
      el.append(opt('Разметка', sel(MARKINGS.map((m) => [m.id, `${m.id} ${m.name}`] as [string, string]), b.markingKind, (v) => ((b.markingKind = v), editor.brushChanged(), again()))));
      const spec = MARKING_BY_ID[b.markingKind];
      if (spec?.arrows) el.append(opt('Стрела', sel(Object.entries(ARROW_VARIANTS).map(([k, v]) => [k, v.name] as [string, string]), b.arrowVariant, (v) => (b.arrowVariant = v))));
      if (spec?.form === 'line') el.append(radiusOpt());
      break;
    }
    case 'obstacle':
      el.append(chips([['building', 'Здание'], ['fence', 'Забор'], ['tree', 'Дерево'], ['barrier', 'Барьер']], b.obstacle, (v) => ((b.obstacle = v), again())));
      break;
    case 'road':
      el.append(
        opt('Полос в сторону', sel([['1', '1'], ['2', '2'], ['3', '3']], String(b.lanes) as '1', (v) => (b.lanes = parseInt(v, 10)))),
        opt('Разметка', sel([['dashed', 'Прерывистая'], ['solid', 'Сплошная'], ['double', 'Двойная'], ['none', 'Нет']], b.center, (v) => (b.center = v))),
        opt('Зона', sel([['city', 'Город'], ['outside', 'Вне города'], ['residential', 'Жилая зона']], b.zone, (v) => (b.zone = v))),
        chk('Односторонняя', b.oneWay, (v) => (b.oneWay = v)),
        radiusOpt(),
      );
      break;
    case 'sidewalk':
      el.append(opt('Ширина, м', sel([['2', '2'], ['3', '3'], ['4', '4'], ['6', '6']], String(b.sidewalkWidth) as '3', (v) => (b.sidewalkWidth = parseInt(v, 10)))), radiusOpt());
      break;
    case 'track':
      el.append(chk('Выделенный путь', b.separated, (v) => (b.separated = v)), radiusOpt());
      break;
    default:
      break;
  }
  el.classList.toggle('hidden', !el.childElementCount);
}

function refreshInspector(): void {
  buildInspector($('pane-props'), api);
  buildEnv($('pane-env'), api, {
    grid,
    setGrid: (v) => {
      grid = v;
      dirty = true;
    },
  });
  if (editor.sel && !isMobile()) showTab('props');
  updateUndo();
}

function updateUndo(): void {
  ($('btnUndo') as HTMLButtonElement).disabled = !editor.canUndo;
  ($('btnRedo') as HTMLButtonElement).disabled = !editor.canRedo;
}

type TabName = 'props' | 'env' | 'report' | 'ref';
function showTab(tab: TabName): void {
  document.querySelectorAll<HTMLElement>('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  for (const n of ['props', 'env', 'report', 'ref'] as TabName[]) $(`pane-${n}`).classList.toggle('hidden', n !== tab);
  if (tab === 'ref' && !$('pane-ref').childElementCount) buildReference($('pane-ref'));
}

function openSheet(open: boolean): void {
  document.body.classList.toggle('sheet', open);
}

// ---------------------------------------------------------------------------
// Плеер

function syncFollow(): void {
  $('zoomFollow').classList.toggle('on', follow);
}

function syncPlayer(): void {
  const dur = tl?.duration ?? editor.scene.env.duration;
  const seek = $<HTMLInputElement>('seek');
  seek.max = String(Math.round(dur / DT));
  seek.value = String(Math.round(t / DT));
  seek.disabled = !tl;
  $('timeLabel').textContent = `${t.toFixed(1)} / ${dur.toFixed(1)} с`;
  $('btnPlay').textContent = playing ? '⏸' : '▶';
  $('btnPlay').title = playing ? 'Пауза' : tl ? 'Продолжить' : 'Запустить симуляцию';
  ($('btnEdit') as HTMLElement).classList.toggle('hidden', mode !== 'play');
}

let openedReport = false;

/** Камера плавно следует за участниками: охватывает пострадавших в первом ДТП или всех. */
function followCamera(dt: number): void {
  if (!tl) return;
  const k = Math.min(tl.n - 1, Math.max(0, Math.round(t / DT)));
  const first = tl.collisions[0];
  const ids = first ? [first.a, first.b] : editor.scene.actors.map((a) => a.id);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const id of ids) {
    const tr = tl.tracks.get(id);
    if (!tr || !tr.present[k]) continue;
    x0 = Math.min(x0, tr.x[k]);
    x1 = Math.max(x1, tr.x[k]);
    y0 = Math.min(y0, tr.y[k]);
    y1 = Math.max(y1, tr.y[k]);
  }
  if (!Number.isFinite(x0)) return;
  const pad = 14;
  const s = clamp(Math.min(renderer.w / (x1 - x0 + 2 * pad), renderer.h / (y1 - y0 + 2 * pad)), 2.5, 16);
  const a = 1 - Math.exp(-dt * 3.5);
  const cam = editor.cam;
  cam.x += ((x0 + x1) / 2 - cam.x) * a;
  cam.y += ((y0 + y1) / 2 - cam.y) * a;
  cam.s += (s - cam.s) * a;
}

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (playing && tl) {
    let k = speed;
    // замедление вокруг столкновения, чтобы успеть разглядеть
    for (const c of tl.collisions) if (t > c.t - 0.35 && t < c.t + 1.0) k *= 0.35;
    t += dt * k;
    if (t >= tl.duration) {
      t = tl.duration;
      playing = false;
    }
    syncPlayer();
    dirty = true;
    if (!playing && isMobile() && !openedReport) {
      openedReport = true;
      showTab('report');
      openSheet(true);
    }
  }
  if (mode === 'play' && follow && tl) {
    followCamera(dt);
    dirty = true;
  }
  if (dirty) {
    dirty = false;
    renderer.draw({
      scene: editor.scene,
      cam: editor.cam,
      mode,
      t,
      tl,
      report,
      sel: editor.sel,
      selWp: editor.selWp,
      drawing: editor.drawing,
      pathActor: editor.tool === 'path' ? (editor.sel?.id ?? null) : null,
      ghost: editor.ghost,
      grid: grid && mode === 'edit',
      brush: editor.brush,
      focus,
    });
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Меню, файлы, справка

function closeMenus(): void {
  document.querySelectorAll('.dropdown').forEach((d) => d.classList.add('hidden'));
}

function menuItem(label: string, on: () => void, sub?: string): HTMLElement {
  return h('button', { type: 'button', class: 'mi', onclick: () => (closeMenus(), on()) }, h('b', {}, label), sub ? h('small', {}, sub) : null);
}

function loadScene(s: Scene): void {
  if (mode === 'play') leavePlay();
  editor.setScene(s, true);
  $<HTMLInputElement>('sceneName').value = s.name;
  invalidate();
  updateTools();
  save();
}

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openFile(): void {
  const inp = h('input', { type: 'file', accept: '.json,application/json' });
  inp.addEventListener('change', async () => {
    const f = inp.files?.[0];
    if (!f) return;
    try {
      loadScene(normalizeScene(JSON.parse(await f.text())));
      toast('Ситуация загружена');
    } catch {
      toast('Не удалось прочитать файл');
    }
  });
  inp.click();
}

async function copyLink(): Promise<void> {
  const url = `${location.origin}${location.pathname}#s=${encodeShare(editor.scene)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Ссылка скопирована');
  } catch {
    window.prompt('Скопируйте ссылку:', url);
  }
}

function showModal(body: HTMLElement): void {
  $('modalBody').replaceChildren(body);
  $('modal').classList.remove('hidden');
}

function help(): void {
  showModal(
    h('div', { class: 'doc' },
      h('h2', {}, 'Crashtest — симулятор дорожных ситуаций'),
      h('p', {}, 'Нарисуйте дорогу, расставьте транспорт и пешеходов, задайте каждому траекторию и скорость — и посмотрите, что произойдёт. Приложение разберёт ситуацию по Правилам дорожного движения РФ, Кодексу об административных правонарушениях и Уголовному кодексу.'),
      h('h3', {}, 'Как пользоваться'),
      h('ol', {},
        h('li', {}, h('b', {}, 'Дорога. '), 'Инструмент «Дорога», затем точки на карте. Число полос и разметку выберите в панели над картой.'),
        h('li', {}, h('b', {}, 'Объекты. '), 'Тротуары, трамвайные пути, переходы, светофоры, знаки, здания и препятствия.'),
        h('li', {}, h('b', {}, 'Участники. '), 'Транспорт — от велосипеда и гужевой повозки до грузовика и трамвая. Нажмите на полосе, и машина встанет по ходу движения.'),
        h('li', {}, h('b', {}, 'Траектория. '), 'Выберите участника, нажмите «Траектория» и расставьте точки. У каждой точки есть скорость; нулевая — остановка.'),
        h('li', {}, h('b', {}, 'Запуск. '), 'Кнопка ▶ рассчитывает ситуацию. Ползунок позволяет перематывать, а вкладка «Разбор» объясняет, кто и какие нормы нарушил.'),
      ),
      h('h3', {}, 'Что учитывается в разборе'),
      h('p', {}, 'Скорость и её ограничения, разметка и выезд на встречную полосу, светофоры, знаки приоритета и запрещающие знаки, очерёдность проезда перекрёстков (включая трамвай и помеху справа), пешеходные переходы, дистанция, трамвайные пути, тротуары, сцепление покрытия, техническая возможность остановиться, примерная тяжесть вреда здоровью и квалификация по КоАП РФ и УК РФ.'),
      h('p', { class: 'disclaimer' }, DISCLAIMER),
      h('p', { class: 'disclaimer' }, `Нормы права и размеры санкций сверены: ${LAW_CHECKED}.`),
    ),
  );
}

function buildMenus(): void {
  const ex = $('menuExamples');
  ex.replaceChildren(...PRESETS.map((p) => menuItem(p.title, () => loadScene(p.build()), p.hint)));
  const main = $('menuMain');
  main.replaceChildren(
    menuItem('Новая ситуация', () => loadScene(emptyScene())),
    menuItem('Сохранить в файл', () => download(`${editor.scene.name || 'crashtest'}.json`, JSON.stringify(editor.scene, null, 2), 'application/json')),
    menuItem('Открыть из файла', openFile),
    menuItem('Скопировать ссылку на ситуацию', copyLink),
    menuItem('Как это работает', help),
  );
}

function save(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify(editor.scene));
    } catch {
      /* хранилище недоступно */
    }
  }, 400);
}

// ---------------------------------------------------------------------------
// Запуск

function init(): void {
  buildTools();
  buildMenus();
  $<HTMLInputElement>('sceneName').value = editor.scene.name;
  $<HTMLInputElement>('sceneName').addEventListener('change', (e) => {
    editor.checkpoint();
    editor.scene.name = (e.target as HTMLInputElement).value;
    save();
  });

  renderer.onImage = () => (dirty = true);
  editor.onView = () => (dirty = true);
  editor.onTool = updateTools;
  editor.onSelect = () => {
    refreshInspector();
    updateHint();
    dirty = true;
  };
  editor.onSceneChange = (final) => {
    invalidate();
    dirty = true;
    updateHint();
    if (final) {
      save();
      updateUndo();
    }
  };

  $('btnUndo').addEventListener('click', () => (mode === 'play' && leavePlay(), editor.undo()));
  $('btnRedo').addEventListener('click', () => (mode === 'play' && leavePlay(), editor.redo()));
  $('btnDone').addEventListener('click', () => editor.finishDrawing());
  $('btnCancel').addEventListener('click', () => editor.cancelDrawing());
  $('zoomIn').addEventListener('click', () => editor.zoomBy(1.3));
  $('zoomOut').addEventListener('click', () => editor.zoomBy(1 / 1.3));
  $('zoomFit').addEventListener('click', () => {
    follow = false;
    syncFollow();
    editor.fit();
  });
  $('zoomFollow').addEventListener('click', () => {
    follow = !follow;
    syncFollow();
    dirty = true;
  });
  editor.onUserCam = () => {
    if (follow && mode === 'play') {
      follow = false;
      syncFollow();
    }
  };

  $('btnPlay').addEventListener('click', () => {
    if (!tl) runSim(true);
    else {
      if (t >= tl.duration - 1e-6) t = 0;
      playing = !playing;
      enterPlay();
      syncPlayer();
    }
  });
  $('btnRestart').addEventListener('click', () => {
    if (!tl) return;
    follow = true;
    syncFollow();
    t = 0;
    playing = false;
    syncPlayer();
    dirty = true;
  });
  $('btnEdit').addEventListener('click', () => leavePlay());
  $<HTMLInputElement>('seek').addEventListener('input', (e) => {
    if (!tl) return;
    t = parseInt((e.target as HTMLInputElement).value, 10) * DT;
    playing = false;
    syncPlayer();
    dirty = true;
  });
  $<HTMLSelectElement>('speed').addEventListener('change', (e) => (speed = parseFloat((e.target as HTMLSelectElement).value)));

  setRefOpener((id) => {
    focusRef(id).then(() => {
      $('pane-ref').replaceChildren();
      showTab('ref');
      openSheet(true);
    });
  });
  document.querySelectorAll<HTMLElement>('.tab').forEach((b) => b.addEventListener('click', () => (showTab(b.dataset.tab as TabName), openSheet(true))));
  $('btnSheet').addEventListener('click', () => openSheet(!document.body.classList.contains('sheet')));
  $('sheetClose').addEventListener('click', () => openSheet(false));

  const toggle = (btn: string, menu: string) =>
    $(btn).addEventListener('click', (e) => {
      e.stopPropagation();
      const m = $(menu);
      const wasHidden = m.classList.contains('hidden');
      closeMenus();
      m.classList.toggle('hidden', !wasHidden);
    });
  toggle('btnExamples', 'menuExamples');
  toggle('btnMenu', 'menuMain');
  document.addEventListener('click', closeMenus);
  $('modalClose').addEventListener('click', () => $('modal').classList.add('hidden'));
  $('modal').addEventListener('click', (e) => e.target === $('modal') && $('modal').classList.add('hidden'));

  const resize = () => {
    renderer.resize();
    dirty = true;
  };
  new ResizeObserver(resize).observe($('stage'));
  resize();
  editor.fit();

  // Закрываем обучение: первая ситуация сразу готова к запуску
  updateTools();
  syncPlayer();
  requestAnimationFrame(frame);

  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !import.meta.env.DEV) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
