import type {
  ProjectEnvelope,
  WorkbenchPorts,
  PhysicsOutput,
  CalculationRecord,
  FeatureDescriptor,
  JsonObject,
  JsonValue,
} from '../parallel/contracts';
import type { Report } from '../analysis/types';
import { emptyScene, type Scene } from '../scene';
import { addRoundaboutTemplate } from '../editor';
import {
  newProject,
  ProjectHistory,
  inputHash,
  type ProjectFile,
  type Versions,
} from '../project/model';
import { resultJSON, utf8 } from '../project/canonical';
import { exportProject, importProject } from '../project/archive';
import { saveLocal, deleteLocal } from '../project/storage';
import { verifyProject } from '../project/verifier';
import { savedData } from '../project/results';
import { encryptProject, decryptProject, isEncrypted } from '../privacy/crypto';
import { redactProject } from '../privacy/redact';
import { blurRegions } from '../privacy/blur';
import {
  EVIDENCE_KINDS,
  newEvidence,
  evidenceIssues,
  rasterTransform,
  type Point,
  type RasterCalibration,
} from '../evidence/model';
import { schemeSVG } from '../evidence/svg';
import { readAttachment } from '../media/attachments';
import {
  LocalVideo,
  videoCalculation,
  timelineTime,
  type VideoIndex,
  type VideoAnnotation,
} from '../media/video';
import {
  reportDocument,
  REPORT_TITLES,
  type ReportOptions,
  type ReportTemplate,
} from '../reports/model';
import { exportPDF, exportDOCX, schemePDF } from '../reports/export';
import { readPointer, writePointer, validateInput } from './inputs';
import { diagnostics } from './diagnostics';
import { chartSegments } from '../reports/charts';
import { mountPlan } from './plan';
import {
  el,
  button,
  input,
  textarea,
  select,
  label,
  details,
  jsonText,
  downloadBytes,
} from './dom';
import './style.css';
export interface WorkbenchContext {
  project: ProjectEnvelope;
  ports: WorkbenchPorts;
  onProjectChange: (project: ProjectEnvelope) => void;
  /** Optional host-owned file state; the required v1 mount boundary stays unchanged. */
  file?: ProjectFile;
  versions?: Versions;
  onFileChange?: (file: ProjectFile) => void;
}
const UNAVAILABLE = 'Расчёт недоступен в этой сборке';
const TABS = [
  'Проект',
  'Параметры',
  'Вещественная обстановка',
  'Видео и фото',
  'Реконструкция',
  'Документы',
  'Мобильный комиссар',
];
export function mountWorkbench(
  element: HTMLElement,
  context: WorkbenchContext,
): { destroy(): void } {
  let file = context.file ?? {
      ...newProject(context.project.scene),
      project: structuredClone(context.project),
    },
    history = new ProjectHistory(file);
  let output: PhysicsOutput | undefined,
    calculations: CalculationRecord[] = [],
    report: Report | undefined;
  let tab = 0,
    dead = false,
    generation = 0,
    busy = false;
  const cleanups: (() => void)[] = [];
  const root = el('section', '', 'ct-workbench'),
    nav = el('nav', '', 'ct-nav'),
    body = el('div', '', 'ct-body'),
    status = el('p', 'Данные остаются на этом устройстве.', 'ct-status');
  status.setAttribute('role', 'status');
  root.append(el('h2', 'Материалы и реконструкция'), nav, status, body);
  element.replaceChildren(root);
  const project = () => file.project;
  function message(text: string) {
    if (!dead) status.textContent = text;
  }
  const act = (fn: () => void | Promise<void>) => async () => {
    try {
      await fn();
    } catch (error) {
      message(error instanceof Error ? error.message : String(error));
    }
  };
  const btn = (text: string, fn: () => void | Promise<void>) =>
    button(text, act(fn));
  async function persist() {
    context.onFileChange?.(file);
    try {
      await saveLocal('current', file);
      message('Сохранено на устройстве (IndexedDB).');
    } catch (error) {
      message(
        `Автосохранение не удалось: ${String(error)}. Экспортируйте файл.`,
      );
    }
  }
  function changed(next: ProjectEnvelope, action: string) {
    if (dead) return;
    if (history.change(next, action)) {
      generation++;
      busy = false;
      output = undefined;
      calculations = [];
      report = undefined;
      context.onProjectChange(structuredClone(file.project));
      void persist();
    }
  }
  function set(
    path: string,
    value: JsonValue | undefined,
    action = 'Изменение поля',
  ) {
    changed(writePointer(project(), path, value), `${action}: ${path}`);
  }
  function afterHistory() {
    generation++;
    busy = false;
    output = undefined;
    calculations = [];
    report = undefined;
    context.onProjectChange(structuredClone(project()));
    void persist();
    render();
  }
  function row(...nodes: HTMLElement[]) {
    const r = el('div', '', 'ct-row');
    r.append(...nodes);
    return r;
  }
  function field(
    text: string,
    value: string,
    onChange: (v: string) => void,
    type = 'text',
  ) {
    const c = input(value, type);
    c.onchange = () => {
      try {
        onChange(c.value);
      } catch (error) {
        message(String(error));
      }
    };
    return label(text, c);
  }
  function numeric(
    text: string,
    value: unknown,
    onChange: (n: number | undefined) => void,
  ) {
    return field(
      text,
      typeof value === 'number' ? String(value) : '',
      (v) => {
        const n = v === '' ? undefined : Number(v);
        if (n !== undefined && !Number.isFinite(n))
          throw new Error('Введите конечное число');
        onChange(n);
      },
      'number',
    );
  }
  function render() {
    if (dead) return;
    while (cleanups.length) cleanups.pop()!();
    body.replaceChildren();
    root.classList.toggle('ct-commissioner', tab === 6);
    nav.replaceChildren(
      ...TABS.map((name, i) => {
        const b = btn(name, () => {
          tab = i;
          render();
        });
        b.setAttribute('aria-current', String(tab === i));
        return b;
      }),
    );
    [
      projectTab,
      parametersTab,
      evidenceTab,
      mediaTab,
      reconstructionTab,
      reportsTab,
      mobileTab,
    ][tab]();
  }
  async function restoreSaved() {
    const token = generation;
    const restored = await savedData(file);
    if (dead || token !== generation) return;
    output = restored.output;
    calculations = restored.calculations;
    report = restored.report;
    if (output || calculations.length) {
      render();
      message('Показаны сохранённые результаты. Пересчёт не выполнялся.');
    }
  }
  async function saveArtifacts() {
    file.artifacts = {
      inputHash: await inputHash(project()),
      calculations: resultJSON(calculations) as JsonValue,
      report: resultJSON(report ?? null) as JsonValue,
    };
    await persist();
  }
  async function exportZIP(redacted = false) {
    const derivative = redacted ? redactProject(file) : file;
    let bytes = await exportProject(derivative);
    const password =
      (root.querySelector('[data-password]') as HTMLInputElement | null)
        ?.value ?? '';
    if (password) bytes = await encryptProject(bytes, password);
    downloadBytes(
      redacted ? 'redacted.crashtest' : 'project.crashtest',
      bytes,
      'application/octet-stream',
    );
    message(
      redacted
        ? 'Обезличенная производная: исходные фото, EXIF, свободный текст, журнал и результаты исключены.'
        : 'Проект экспортирован.',
    );
  }
  function projectTab() {
    body.append(
      el('h3', 'Локальный проект'),
      el(
        'p',
        'Файл .crashtest содержит исходные материалы, версии и журнал. Для пересчёта требуется подключённый движок.',
      ),
    );
    const pwd = input('', 'password');
    pwd.dataset.password = '';
    pwd.autocomplete = 'new-password';
    body.append(
      label('Пароль экспорта / импорта (пусто — без шифрования)', pwd),
      row(
        btn('Экспорт .crashtest', () => exportZIP()),
        btn('Экспорт без ПДн', () => exportZIP(true)),
      ),
    );
    const upload = input('', 'file');
    upload.accept = '.crashtest,.json';
    upload.onchange = act(async () => {
      const f = upload.files?.[0];
      if (!f) return;
      if (f.size > 256 * 1024 * 1024) throw new Error('Лимит проекта 256 MiB');
      let bytes: Uint8Array = new Uint8Array(await f.arrayBuffer());
      if (isEncrypted(bytes)) bytes = await decryptProject(bytes, pwd.value);
      const imported = await importProject(bytes);
      if (dead) return;
      file = imported;
      history = new ProjectHistory(file);
      afterHistory();
      void restoreSaved();
      message('Проект импортирован. Оригиналы и журнал сохранены.');
    });
    body.append(label('Открыть проект или старую сцену', upload));
    body.append(
      field('Автор журнала', history.who, (v) => {
        history.who = v;
      }),
      details('Версии', jsonText(file.versions)),
      row(
        btn('Отменить правку', () => {
          history.undo();
          afterHistory();
        }),
        btn('Повторить правку', () => {
          history.redo();
          afterHistory();
        }),
        btn('Проверить воспроизводимость', async () => {
          const verified = await importProject(await exportProject(file));
          const result = await verifyProject(
            verified,
            context.ports,
            context.versions,
          );
          body.append(
            details('Целостность и пересчёт — отдельно', jsonText(result)),
          );
          message(
            `Целостность: ${result.integrity}; пересчёт: ${result.calculation}`,
          );
        }),
      ),
    );
    if (file.savedResults !== undefined)
      body.append(
        details(
          'Сохранённые результаты (без пересчёта)',
          jsonText(file.savedResults),
        ),
      );
    const journal = el('div');
    file.journal.forEach((entry, i) => {
      const d = details(
        `${i + 1}. ${entry.at} · ${entry.who}: ${entry.action}`,
        jsonText({ before: entry.before, after: entry.after }),
      );
      d.append(
        btn('Откат к этой версии', () => {
          history.restore(i);
          afterHistory();
        }),
      );
      journal.append(d);
    });
    body.append(el('h3', `Журнал (${file.journal.length})`), journal);
    body.append(
      btn('Удалить проект и вложения с устройства', async () => {
        await deleteLocal('current');
        localStorage.removeItem('crashtest.scene.v1');
        file = newProject(emptyScene());
        history = new ProjectHistory(file);
        output = undefined;
        calculations = [];
        report = undefined;
        generation++;
        context.onFileChange?.(file);
        context.onProjectChange(structuredClone(project()));
        render();
        message(
          'Проект и вложения удалены из IndexedDB. Экспортированные пользователем файлы удаляются вручную.',
        );
      }),
    );
  }
  function descriptorForm(features: FeatureDescriptor[]) {
    for (const feature of features) {
      const group = el('fieldset');
      group.append(el('legend', feature.title));
      if (!feature.available)
        group.append(el('p', feature.reason ?? UNAVAILABLE));
      for (const d of feature.inputs) {
        let value: JsonValue | undefined;
        try {
          value = readPointer(project(), d.path);
        } catch (error) {
          group.append(el('p', `${d.label}: ${String(error)}`));
          continue;
        }
        let control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        if (d.kind === 'boolean')
          control = select(
            [
              ['', 'Неизвестно'],
              ['true', 'Да — установлено'],
              ['false', 'Нет — установлено'],
            ],
            value === undefined || value === null ? '' : String(value),
          );
        else if (d.kind === 'enum')
          control = select(
            [
              ['', 'Неизвестно'],
              ...(d.choices ?? []).map(
                (c) => [c.value, c.label] as [string, string],
              ),
            ],
            typeof value === 'string' ? value : '',
          );
        else if (d.kind === 'geometry')
          control = textarea(value === undefined ? '' : jsonText(value));
        else {
          control = input(
            value === undefined ? '' : String(value),
            d.kind === 'number' ? 'number' : 'text',
          );
          if (d.kind === 'number') {
            control.step = 'any';
            if (d.minimum !== undefined) control.min = String(d.minimum);
            if (d.maximum !== undefined) control.max = String(d.maximum);
          }
        }
        control.onchange = () => {
          try {
            set(d.path, validateInput(d, control.value), 'Параметр порта');
          } catch (error) {
            message(String(error));
          }
        };
        group.append(
          label(
            `${d.label}${d.unit ? ` (${d.unit})` : ''}${d.required ? ' *' : ''}`,
            control,
          ),
        );
      }
      body.append(group);
    }
  }
  function parametersTab() {
    body.append(el('h3', 'Параметры по описанию подключённых портов'));
    if (context.ports.physics)
      descriptorForm(context.ports.physics.describe(project()));
    else body.append(el('p', UNAVAILABLE));
    if (context.ports.rules)
      descriptorForm(context.ports.rules.describe(project()));
    else
      body.append(
        el(
          'p',
          'Новые правовые подсказки недоступны. Установленные факты остаются в проекте.',
        ),
      );
    body.append(
      el('h3', 'Измеренные зоны дороги'),
      el(
        'p',
        'μ безразмерен; уклоны — отношение высот к длине. Положительный продольный уклон — подъём вдоль направления зоны. Неровность хранится как измеренный профиль.',
      ),
    );
    const zonePoints = textarea('[]'),
      zoneSource = input(''),
      zoneMu = input('', 'number'),
      zoneLong = input('', 'number'),
      zoneCross = input('', 'number');
    body.append(
      label(
        'Новая зона: полигон [{x,y}], м (или нажмите точки на плане)',
        zonePoints,
      ),
    );
    const zonePlan = planPanel((point) => {
      const points = JSON.parse(zonePoints.value);
      points.push(point);
      zonePoints.value = jsonText(points);
    });
    body.append(
      row(
        label('Измеренный μ', zoneMu),
        label('Продольный уклон', zoneLong),
        label('Поперечный уклон', zoneCross),
      ),
      label('Источник обмера зоны', zoneSource),
      btn('Добавить измеренный полигон', () => {
        const boundary = JSON.parse(zonePoints.value);
        if (
          !Array.isArray(boundary) ||
          boundary.length < 3 ||
          boundary.some((p: Point) => ![p.x, p.y].every(Number.isFinite)) ||
          !zoneSource.value
        )
          throw new Error('Нужны три точки и источник');
        const zone: JsonObject = {
          id: crypto.randomUUID(),
          boundary,
          source: zoneSource.value,
        };
        for (const [key, control] of [
          ['mu', zoneMu],
          ['gradeLongitudinal', zoneLong],
          ['gradeCross', zoneCross],
        ] as const) {
          if (control.value !== '') {
            const n = Number(control.value);
            if (!Number.isFinite(n)) throw new Error('Неверное число');
            zone[key] = n;
          }
        }
        set(
          '/extensions/physics/zones',
          [
            ...((project().extensions.physics.zones ?? []) as JsonValue[]),
            zone,
          ],
          'Измеренный полигон',
        );
        zonePlan.draw();
        zones.value = jsonText(project().extensions.physics.zones);
      }),
    );
    const zones = textarea(jsonText(project().extensions.physics.zones ?? []));
    body.append(
      label(
        'Полигоны boundary[{x,y}], mu, gradeLongitudinal, gradeCross, direction, roughnessProfile[{s,z}], source',
        zones,
      ),
      btn('Сохранить зоны', () => {
        const data = JSON.parse(zones.value);
        if (!Array.isArray(data)) throw new Error('Нужен массив зон');
        for (const z of data) {
          if (
            !z.id ||
            !Array.isArray(z.boundary) ||
            z.boundary.length < 3 ||
            !z.source
          )
            throw new Error('Для зоны нужны id, 3+ точки boundary и source');
          if (z.boundary.some((p: Point) => ![p.x, p.y].every(Number.isFinite)))
            throw new Error('Координаты зоны');
          for (const k of ['mu', 'gradeLongitudinal', 'gradeCross'])
            if (z[k] !== undefined && !Number.isFinite(z[k]))
              throw new Error('Неизвестный параметр нужно опустить');
        }
        set('/extensions/physics/zones', data, 'Измеренные зоны');
      }),
    );
    body.append(
      el('h3', 'Измеренные t1–t3 и j по участнику'),
      el(
        'p',
        'Паспортные/измеренные значения, диапазоны и источник. Пустое поле означает неизвестность.',
      ),
    );
    for (const actor of project().scene.actors) {
      const id = actor.id.replace(/~/g, '~0').replace(/\//g, '~1'),
        base = `/extensions/physics/vehicles/${id}/braking`;
      const group = el('fieldset');
      group.append(el('legend', actor.id));
      for (const key of ['t1', 't2', 't3', 'j']) {
        const value = readPointer(project(), `${base}/${key}`) as
          JsonObject | undefined;
        const cells = [
          numeric(`${key} (${key === 'j' ? 'м/с²' : 'с'})`, value?.value, (n) =>
            set(`${base}/${key}/value`, n),
          ),
          numeric('Минимум', value?.min, (n) => set(`${base}/${key}/min`, n)),
          numeric('Максимум', value?.max, (n) => set(`${base}/${key}/max`, n)),
          field(
            'Источник',
            typeof value?.source === 'string' ? value.source : '',
            (v) => set(`${base}/${key}/source`, v),
          ),
        ];
        group.append(row(...cells));
      }
      body.append(group);
    }
  }
  function planPanel(onPoint: (p: Point) => void) {
    const c = el('canvas', '', 'ct-plan');
    c.setAttribute(
      'aria-label',
      'План сцены: нажмите для измеренной координаты; колесо — масштаб, Shift+колесо — перемещение',
    );
    body.append(c);
    const plan = mountPlan(
      c,
      project,
      () => output,
      onPoint,
      () => file.attachments,
    );
    cleanups.push(plan.destroy);
    return plan;
  }
  function evidenceTab() {
    body.append(
      el('h3', 'Наблюдения и измерения'),
      el(
        'p',
        'Координаты в метрах. Нажатия на плане добавляют точки; исходные наблюдения не подгоняются под модель.',
      ),
    );
    const kind = select(
        Object.entries(EVIDENCE_KINDS) as [string, string][],
        'braking',
      ),
      source = input(''),
      comment = textarea(''),
      points = textarea('[]'),
      width = input('', 'number'),
      measurementHeight = input('', 'number'),
      sigma = input('', 'number'),
      wheel = input(''),
      abs = select([
        ['', 'Неизвестно'],
        ['true', 'ABS-прерывистость установлена'],
        ['false', 'Непрерывный след установлен'],
      ]),
      confidence = input('', 'number'),
      who = input(''),
      heading = input('', 'number'),
      actor = input('');
    const plan = planPanel((p) => {
      const pts = JSON.parse(points.value);
      pts.push({ x: Number(p.x.toFixed(4)), y: Number(p.y.toFixed(4)) });
      points.value = jsonText(pts);
    });
    const linkedFiles = select(
      file.attachments.map((a) => [a.id, a.name] as [string, string]),
    );
    linkedFiles.multiple = true;
    for (const o of linkedFiles.options) o.selected = false;
    const cInputs = Array.from({ length: 6 }, (_, i) =>
      label(`C${i + 1} (м)`, input('', 'number')),
    );
    let editing: string | undefined;
    const list = select([
      ['', 'Новое наблюдение'],
      ...project().evidence.map(
        (e) => [e.id, `${e.kind} · ${e.id}`] as [string, string],
      ),
    ]);
    list.onchange = () => {
      const e = project().evidence.find((e) => e.id === list.value);
      editing = e?.id;
      kind.value = e?.kind ?? 'braking';
      source.value = e?.source ?? '';
      comment.value = String(e?.values.comment ?? '');
      points.value = jsonText(e?.geometry.points ?? []);
      sigma.value =
        e?.uncertainty?.metres === undefined
          ? ''
          : String(e.uncertainty.metres);
      width.value = String(e?.values.width ?? '');
      measurementHeight.value = String(e?.values.height ?? '');
      for (const o of linkedFiles.options)
        o.selected =
          Array.isArray(e?.values.attachmentIds) &&
          e.values.attachmentIds.includes(o.value);
      wheel.value = String(e?.values.wheel ?? '');
      abs.value =
        e?.values.absIntermittent === undefined
          ? ''
          : String(e.values.absIntermittent);
      who.value = String(e?.values.establishedBy ?? '');
      confidence.value = String(e?.values.confidence ?? '');
      heading.value = String(e?.values.heading ?? '');
      actor.value = String(e?.values.actorId ?? '');
      cInputs.forEach(
        (l, i) =>
          (l.querySelector('input')!.value = String(
            e?.values[`C${i + 1}`] ?? '',
          )),
      );
    };
    body.append(
      label('Наблюдение', list),
      label('Вид', kind),
      label('Координаты [{x,y}] (м)', points),
      row(
        label('Источник', source),
        label('Погрешность ±м (пусто — неизвестна)', sigma),
      ),
      label('Комментарий / зафиксированный сигнал', comment),
      label('Вложения наблюдения (можно выбрать несколько)', linkedFiles),
      label('Высота сечения измерения, м', measurementHeight),
      row(label('Ширина, м', width), label('Колесо', wheel), label('ABS', abs)),
      row(
        label('Уверенность 0…1', confidence),
        label('Кем установлено', who),
        label('Курс, рад', heading),
        label('ID участника', actor),
      ),
      row(...cInputs),
      row(
        btn('Сохранить наблюдение', () => {
          const values: JsonObject = { comment: comment.value };
          const put = (k: string, v: string) => {
            if (v !== '') {
              const n = Number(v);
              if (!Number.isFinite(n))
                throw new Error('Нужны числовые измерения');
              values[k] = n;
            }
          };
          put('width', width.value);
          put('height', measurementHeight.value);
          values.attachmentIds = Array.from(linkedFiles.selectedOptions).map(
            (o) => o.value,
          );
          put('confidence', confidence.value);
          put('heading', heading.value);
          if (
            confidence.value !== '' &&
            (Number(confidence.value) < 0 || Number(confidence.value) > 1)
          )
            throw new Error('Уверенность от 0 до 1');
          if (
            sigma.value !== '' &&
            (!Number.isFinite(Number(sigma.value)) || Number(sigma.value) < 0)
          )
            throw new Error('Погрешность неотрицательна');
          if (wheel.value) values.wheel = wheel.value;
          if (abs.value) values.absIntermittent = abs.value === 'true';
          if (who.value) values.establishedBy = who.value;
          if (actor.value) values.actorId = actor.value;
          cInputs.forEach((l, i) =>
            put(`C${i + 1}`, l.querySelector('input')!.value),
          );
          const e = newEvidence(
            kind.value as keyof typeof EVIDENCE_KINDS,
            JSON.parse(points.value),
            values,
            source.value,
            sigma.value === '' ? undefined : Number(sigma.value),
          );
          if (editing) e.id = editing;
          const p = structuredClone(project());
          p.evidence = p.evidence.filter((v) => v.id !== e.id);
          p.evidence.push(e);
          changed(p, 'Наблюдение');
          render();
        }),
        btn('Удалить наблюдение', () => {
          if (!editing) return;
          const p = structuredClone(project());
          p.evidence = p.evidence.filter((e) => e.id !== editing);
          changed(p, 'Удаление наблюдения');
          render();
        }),
      ),
    );
    for (const issue of evidenceIssues(project(), output?.observations))
      body.append(el('p', issue, 'ct-warning'));
    const refs = textarea(
      jsonText(
        project().extensions.workspace.landmarks ?? {
          A: { x: 0, y: 0, label: '' },
          B: { x: 10, y: 0, label: '' },
        },
      ),
    );
    body.append(
      label('Два неподвижных ориентира A/B и подписи (м)', refs),
      btn('Сохранить ориентиры', () => {
        const v = JSON.parse(refs.value);
        if (
          ![v.A?.x, v.A?.y, v.B?.x, v.B?.y].every(Number.isFinite) ||
          Math.hypot(v.A.x - v.B.x, v.A.y - v.B.y) === 0
        )
          throw new Error('Два различных ориентира');
        set('/extensions/workspace/landmarks', v);
      }),
    );
    const raster = textarea(
      jsonText(
        project().extensions.workspace.raster ?? {
          attachmentId: '',
          pixelA: { x: 0, y: 0 },
          pixelB: { x: 100, y: 0 },
          worldA: { x: 0, y: 0 },
          worldB: { x: 10, y: 0 },
          opacity: 0.4,
        },
      ),
    );
    body.append(
      label(
        'Растровая подложка: ID фото, две пиксельные и мировые точки, opacity 0…1',
        raster,
      ),
      btn('Привязать подложку', () => {
        const c = JSON.parse(raster.value) as RasterCalibration;
        rasterTransform(c);
        if (
          !file.attachments.some(
            (a) => a.id === c.attachmentId && a.type.startsWith('image/'),
          )
        )
          throw new Error('Загрузите фото и укажите его ID');
        set('/extensions/workspace/raster', c as unknown as JsonValue);
        plan.draw();
      }),
    );
    const scale = input('100', 'number'),
      ox = input('0', 'number'),
      oy = input('0', 'number');
    body.append(
      row(
        label('Масштаб 1:', scale),
        label('Начало X, м', ox),
        label('Начало Y, м', oy),
      ),
      row(
        btn('Схема SVG', () =>
          downloadBytes(
            'scheme.svg',
            utf8(
              schemeSVG(project(), {
                scale: Number(scale.value),
                originX: Number(ox.value),
                originY: Number(oy.value),
              }),
            ),
            'image/svg+xml',
          ),
        ),
        btn('Схема PDF', async () =>
          downloadBytes(
            'scheme.pdf',
            await schemePDF(
              project(),
              {
                scale: Number(scale.value),
                originX: Number(ox.value),
                originY: Number(oy.value),
              },
              await font(),
            ),
            'application/pdf',
          ),
        ),
      ),
    );
  }
  async function addFiles(files: FileList | null) {
    if (!files) return;
    const target = file;
    for (const f of Array.from(files)) {
      const a = await readAttachment(f);
      if (dead || file !== target) return;
      file.attachments.push(a);
      set(
        `/extensions/workspace/attachments/${a.id}`,
        { name: a.name, sha256: a.metadata.sha256, type: a.type },
        'Вложение',
      );
    }
    await persist();
    render();
  }
  function mediaTab() {
    body.append(
      el('h3', 'Локальные оригиналы'),
      el(
        'p',
        'Фото и видео хранятся как есть. EXIF/дата/геометка сохраняются при наличии в оригинале. Приложение не отправляет материалы.',
      ),
    );
    const upload = input('', 'file');
    upload.multiple = true;
    upload.accept = 'image/*,video/*,audio/*,.pdf';
    upload.onchange = act(() => addFiles(upload.files));
    body.append(label('Добавить материалы', upload));
    for (const a of file.attachments) {
      const d = details(`${a.name} · ID ${a.id}`, jsonText(a.metadata));
      d.append(
        btn('Скачать оригинал', () => downloadBytes(a.name, a.bytes, a.type)),
      );
      if (a.type.startsWith('video/'))
        d.append(btn('Открыть покадровый анализ', () => openVideo(a.id)));
      if (a.type.startsWith('image/')) {
        const img = el('img');
        const url = URL.createObjectURL(
          new Blob([new Uint8Array(a.bytes)], { type: a.type }),
        );
        img.src = url;
        img.draggable = false;
        img.alt = a.name;
        img.className = 'ct-photo';
        d.append(img);
        cleanups.push(() => URL.revokeObjectURL(url));
        const regions = textarea('[]');
        let start: Point | undefined;
        img.onpointerdown = (e) => {
          const r = img.getBoundingClientRect();
          start = {
            x: ((e.clientX - r.left) * img.naturalWidth) / r.width,
            y: ((e.clientY - r.top) * img.naturalHeight) / r.height,
          };
        };
        img.onpointerup = (e) => {
          if (!start) return;
          const r = img.getBoundingClientRect(),
            end = {
              x: ((e.clientX - r.left) * img.naturalWidth) / r.width,
              y: ((e.clientY - r.top) * img.naturalHeight) / r.height,
            };
          regions.value = jsonText([
            ...JSON.parse(regions.value),
            {
              x: Math.min(start.x, end.x),
              y: Math.min(start.y, end.y),
              width: Math.abs(end.x - start.x),
              height: Math.abs(end.y - start.y),
            },
          ]);
          start = undefined;
        };
        d.append(
          label(
            'Ручные области маскирования [{x,y,width,height}], px; протяните по фото',
            regions,
          ),
          btn('Сохранить и скачать маскированный PNG', async () => {
            const blob = await blurRegions(
              new Blob([new Uint8Array(a.bytes)]),
              JSON.parse(regions.value),
            );
            const derivative = await readAttachment(
              new File([blob], 'masked.png', { type: 'image/png' }),
            );
            file.attachments.push(derivative);
            set(
              `/extensions/workspace/attachments/${derivative.id}`,
              { derivedFrom: a.id, manualMask: true },
              'Ручная маска',
            );
            downloadBytes('masked.png', derivative.bytes, 'image/png');
            await persist();
            render();
          }),
        );
      }
      d.append(
        btn('Удалить вложение', () => {
          file.attachments = file.attachments.filter((v) => v.id !== a.id);
          set(
            `/extensions/workspace/attachments/${a.id}`,
            undefined,
            'Удаление вложения',
          );
          void persist();
          render();
        }),
      );
      body.append(d);
    }
  }
  async function openVideo(id: string) {
    const a = file.attachments.find((a) => a.id === id);
    if (!a) return;
    while (cleanups.length) cleanups.pop()!();
    body.replaceChildren();
    const video = new LocalVideo(
      new Blob([new Uint8Array(a.bytes)], { type: a.type }),
    );
    let stopped = false;
    cleanups.push(() => {
      stopped = true;
      video.destroy();
    });
    body.append(
      btn('К материалам', () => render()),
      el('h3', a.name),
    );
    const text = el('p', 'Чтение реальных PTS…');
    body.append(text);
    let index: VideoIndex;
    try {
      index = await video.index({
        isCancelled: () => dead || stopped,
        onProgress: (n) => (text.textContent = `Прочитано ${n} кадров`),
      });
    } catch (error) {
      text.textContent = String(error);
      return;
    }
    if (stopped) return;
    const p = structuredClone(project());
    const indexes = (p.extensions.workspace.videoIndexes ?? {}) as JsonObject;
    indexes[id] = index as unknown as JsonValue;
    p.extensions.workspace.videoIndexes = indexes;
    changed(p, 'Индекс PTS локального видео');
    const canvas = el('canvas', '', 'ct-video');
    body.append(canvas);
    const stamp = el('p'),
      seek = input('0', 'range');
    seek.min = '0';
    seek.max = String(index.frames.length - 1);
    seek.step = '1';
    let frame = 0,
      decoded = false,
      decodeGeneration = 0;
    const kind = select([
        ['wheel-ground', 'Контакт колеса с дорогой'],
        ['calibration', 'Калибровочная точка'],
      ]),
      wx = input('', 'number'),
      wy = input('', 'number'),
      sigma = input('', 'number'),
      sigmaM = input('', 'number'),
      actor = input('');
    const marks = el('div');
    let editingAnnotation: number | undefined;
    let decodeQueue: Promise<unknown> = Promise.resolve();
    function showMarks() {
      marks.replaceChildren(
        details(
          'Сохранённая разметка',
          jsonText(project().extensions.workspace.videoAnnotations ?? []),
        ),
      );
      const annotations = (project().extensions.workspace.videoAnnotations ??
        []) as unknown as VideoAnnotation[];
      annotations.forEach((ann, i) => {
        if (ann.attachmentId !== id) return;
        marks.append(
          row(
            el('span', `${ann.kind} · PTS ${ann.pts} с · ±${ann.sigmaPx} px`),
            btn('Изменить метку', async () => {
              editingAnnotation = i;
              frame = ann.frameIndex;
              seek.value = String(frame);
              kind.value = ann.kind;
              wx.value = ann.world ? String(ann.world.x) : '';
              wy.value = ann.world ? String(ann.world.y) : '';
              sigma.value = String(ann.sigmaPx);
              sigmaM.value = ann.sigmaM === undefined ? '' : String(ann.sigmaM);
              actor.value = ann.actorId ?? '';
              message(
                'Укажите исправленную точку на кадре. Прежнее наблюдение останется в журнале.',
              );
              await draw();
            }),
            btn('Удалить метку', () => {
              set(
                '/extensions/workspace/videoAnnotations',
                annotations.filter((_, j) => j !== i) as unknown as JsonValue,
                'Удаление видео-метки',
              );
              editingAnnotation = undefined;
              showMarks();
              void draw();
            }),
          ),
        );
      });
      marks.append(
        btn('Новая метка', () => {
          editingAnnotation = undefined;
          message('Следующее нажатие добавит новую метку.');
        }),
      );
    }
    async function draw() {
      decoded = false;
      delete canvas.dataset.pts;
      const token = ++decodeGeneration;
      const f = index.frames[frame];
      stamp.textContent = `Кадр ${frame + 1}/${index.frames.length} · PTS ${f.pts.toFixed(6)} с · длительность ${f.duration.toFixed(6)} с`;
      try {
        decodeQueue = decodeQueue
          .catch(() => undefined)
          .then(() => video.draw(f, canvas));
        await decodeQueue;
        if (stopped || token !== decodeGeneration) return;
        decoded = true;
        canvas.dataset.pts = String(f.pts);
        const annotations = (project().extensions.workspace.videoAnnotations ??
          []) as unknown as VideoAnnotation[];
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#ff355a';
        ctx.font = '18px sans-serif';
        for (const ann of annotations.filter(
          (m) => m.attachmentId === id && m.pts === f.pts,
        )) {
          ctx.beginPath();
          ctx.arc(ann.pixel.x, ann.pixel.y, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillText(ann.kind, ann.pixel.x + 8, ann.pixel.y);
        }
        const overlays = output?.renderData?.videoOverlays;
        if (Array.isArray(overlays))
          for (const o of overlays) {
            if (
              o &&
              typeof o === 'object' &&
              !Array.isArray(o) &&
              o.attachmentId === id &&
              o.pts === f.pts &&
              typeof o.x === 'number' &&
              typeof o.y === 'number'
            ) {
              ctx.strokeStyle = '#34eb9b';
              ctx.strokeRect(o.x - 10, o.y - 10, 20, 20);
            }
          }
      } catch (error) {
        text.textContent = String(error);
      }
    }
    seek.oninput = () => {
      frame = Number(seek.value);
      void draw();
    };
    text.textContent = `${index.codec ?? 'неизвестный кодек'} · ${index.width}×${index.height}. ${index.vfr ? 'ВНИМАНИЕ: VFR, интервалы кадров неравномерны.' : 'Метки кадров равномерны в этом файле.'} Время берётся из PTS контейнера. Точность часов камеры отдельно не подтверждена.`;
    body.append(
      stamp,
      row(
        btn('Предыдущий кадр', async () => {
          frame = Math.max(0, frame - 1);
          seek.value = String(frame);
          await draw();
        }),
        seek,
        btn('Следующий кадр', async () => {
          frame = Math.min(index.frames.length - 1, frame + 1);
          seek.value = String(frame);
          await draw();
        }),
      ),
      label('Разметка', kind),
      row(
        label('X на плане, м (для калибровки)', wx),
        label('Y на плане, м', wy),
        label('Погрешность клика ±px', sigma),
        label('Погрешность ориентира ±м', sigmaM),
        label('ID участника', actor),
      ),
      el(
        'p',
        'Нажмите на декодированном кадре. Для гомографии нужны 4+ калибровочные точки с мировыми координатами.',
      ),
      marks,
    );
    canvas.onclick = (e) => {
      try {
        if (!decoded) throw new Error('Точный кадр не декодирован');
        if (!Number.isFinite(Number(sigma.value)) || Number(sigma.value) <= 0)
          throw new Error('Погрешность клика должна быть >0');
        const r = canvas.getBoundingClientRect(),
          ann: VideoAnnotation = {
            attachmentId: id,
            pts: index.frames[frame].pts,
            frameIndex: frame,
            kind: kind.value as VideoAnnotation['kind'],
            pixel: {
              x: ((e.clientX - r.left) * canvas.width) / r.width,
              y: ((e.clientY - r.top) * canvas.height) / r.height,
            },
            sigmaPx: Number(sigma.value),
          };
        if (ann.kind === 'calibration') {
          if (
            wx.value === '' ||
            wy.value === '' ||
            sigmaM.value === '' ||
            ![Number(wx.value), Number(wy.value), Number(sigmaM.value)].every(
              Number.isFinite,
            ) ||
            Number(sigmaM.value) < 0
          )
            throw new Error('Нужны мировые координаты и погрешность ориентира');
          ann.world = { x: Number(wx.value), y: Number(wy.value) };
          ann.sigmaM = Number(sigmaM.value);
        }
        if (actor.value) ann.actorId = actor.value;
        const annotations = (project().extensions.workspace.videoAnnotations ??
          []) as JsonValue[];
        set(
          '/extensions/workspace/videoAnnotations',
          editingAnnotation === undefined
            ? [...annotations, ann as unknown as JsonValue]
            : annotations.map((a, i) =>
                i === editingAnnotation ? (ann as unknown as JsonValue) : a,
              ),
          editingAnnotation === undefined
            ? 'Видео-разметка'
            : 'Правка видео-разметки',
        );
        editingAnnotation = undefined;
        showMarks();
        void draw();
      } catch (error) {
        message(String(error));
      }
    };
    const timeline = input('', 'number'),
      signal = input('');
    body.append(
      row(
        label('Наблюдаемое время Timeline, с, для текущего PTS', timeline),
        label('Зафиксированный сигнал / источник', signal),
      ),
      btn('Сохранить синхронизацию', () => {
        if (timeline.value === '' || !Number.isFinite(Number(timeline.value)))
          throw new Error('Нужно наблюдаемое время');
        set(
          `/extensions/workspace/videoSync/${id}`,
          {
            videoPTS: index.frames[frame].pts,
            timelineSeconds: Number(timeline.value),
            signal: signal.value,
          },
          'Синхронизация',
        );
        message(
          `Текущий PTS соответствует ${timelineTime(index.frames[frame].pts, index.frames[frame].pts, Number(timeline.value))} с Timeline`,
        );
      }),
      row(
        btn('Гомография через PhysicsPort', () =>
          calculateVideo('video.homography'),
        ),
        btn('Траектория/скорость через PhysicsPort', () =>
          calculateVideo('video.trajectory'),
        ),
      ),
    );
    async function calculateVideo(
      method: 'video.homography' | 'video.trajectory',
    ) {
      const annotations = (
        (project().extensions.workspace.videoAnnotations ??
          []) as unknown as VideoAnnotation[]
      ).filter((a) => a.attachmentId === id);
      if (
        method === 'video.homography' &&
        annotations.filter((a) => a.kind === 'calibration').length < 4
      )
        throw new Error('Нужны минимум четыре измеренные калибровочные точки');
      const token = generation;
      const result = await videoCalculation(
        context.ports.physics,
        method,
        project(),
        {
          attachmentId: id,
          frames: index.frames as unknown as JsonValue,
          annotations: annotations as unknown as JsonValue,
          synchronization:
            (
              project().extensions.workspace.videoSync as JsonObject | undefined
            )?.[id] ?? null,
        },
      );
      if (dead || stopped || generation !== token) return;
      body.append(details(method, jsonText(result)));
      if (result.status === 'ok') {
        calculations.push(...result.value);
        await saveArtifacts();
      } else message(result.issues.map((i) => i.message).join('; '));
    }
    showMarks();
    await draw();
  }
  async function run(method?: string, parameters: JsonObject = {}) {
    if (busy) return;
    if (!context.ports.physics) {
      message(UNAVAILABLE);
      return;
    }
    busy = true;
    const token = ++generation;
    const isCancelled = () => dead || token !== generation;
    const control = {
      isCancelled,
      // A late progress event of a cancelled run must not overwrite the cancel status.
      onProgress: (n: number, total: number) => {
        if (!isCancelled()) message(`Расчёт: ${n}${total ? ` / ${total}` : ''}`);
      },
    };
    try {
      if (method) {
        const result = await context.ports.physics.calculate(
          method,
          project(),
          parameters,
          control,
        );
        if (control.isCancelled()) return;
        if (result.status !== 'ok') {
          message(
            result.issues.map((i) => i.message).join('; ') || result.status,
          );
          return;
        }
        calculations = [...calculations, ...result.value];
      } else {
        const result = await context.ports.physics.simulate(project(), control);
        if (control.isCancelled()) return;
        if (result.status !== 'ok') {
          message(
            result.issues.map((i) => i.message).join('; ') || result.status,
          );
          return;
        }
        output = result.value;
        calculations = result.value.calculations;
        report = undefined;
        if (context.ports.rules) {
          const legal = await context.ports.rules.evaluate(
            project(),
            output.timeline,
            output,
          );
          if (control.isCancelled()) return;
          if (legal.status === 'ok') report = legal.value;
          else
            message(
              legal.issues.map((i) => i.message).join('; ') || legal.status,
            );
        }
        file.savedResults = resultJSON({
          physics: output,
          rules: report ?? null,
        }) as JsonValue;
        file.resultInputHash = await inputHash(project());
        // Saved results record the engine/corpus versions that produced them.
        if (context.versions) file.versions = structuredClone(context.versions);
        await persist();
      }
      if (!control.isCancelled()) {
        await saveArtifacts();
        render();
        message('Результат получен от подключённого порта.');
      }
    } finally {
      if (token === generation) busy = false;
    }
  }
  function reconstructionTab() {
    body.append(
      el('h3', 'Реконструкция и неопределённость'),
      el(
        'p',
        'Ограничения, распределения и единицы задаются в параметрах подключённого движка. Наблюдения остаются исходными.',
      ),
    );
    if (!context.ports.physics) body.append(el('p', UNAVAILABLE));
    else
      descriptorForm(
        context.ports.physics
          .describe(project())
          .filter((f) => f.id.startsWith('reconstruction.')),
      );
    const params = textarea(
      jsonText(project().extensions.workspace.reconstruction ?? {}),
    );
    body.append(
      label(
        'Ограничения / диапазоны / распределения / seed / N (JSON, схема движка)',
        params,
      ),
      btn('Сохранить условия', () =>
        set(
          '/extensions/workspace/reconstruction',
          JSON.parse(params.value),
          'Условия реконструкции',
        ),
      ),
      row(
        btn('Моделировать через порт', () => run()),
        btn('Обратная задача', () =>
          run('reconstruction.inverse', JSON.parse(params.value)),
        ),
        btn('Монте-Карло', () =>
          run('reconstruction.monte-carlo', JSON.parse(params.value)),
        ),
        btn('Отменить расчёт', () => {
          generation++;
          busy = false;
          message('Отмена запрошена.');
        }),
      ),
    );
    const diag = diagnostics(calculations);
    body.append(el('h4', 'Невязки по каждому наблюдению'));
    for (const e of project().evidence) {
      const r = diag.residuals.find((r) => r.evidenceId === e.id);
      body.append(
        el(
          'p',
          `${e.id}: ${r ? `${r.value} ${r.unit}` : 'невязка не предоставлена портом'}`,
        ),
      );
    }
    for (const figure of diag.figures) {
      const canvas = el('canvas', '', 'ct-chart');
      canvas.width = 700;
      canvas.height = 220;
      body.append(
        el('h4', `${figure.title} · ${figure.calculationId}`),
        canvas,
      );
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 700, 220);
      ctx.strokeStyle = '#155b8f';
      ctx.fillStyle = '#155b8f';
      for (const s of chartSegments(figure)) {
        ctx.lineWidth = s.bar ? 7 : 2;
        ctx.beginPath();
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
        ctx.stroke();
      }
      const xs = figure.points.map((p) => p.x),
        ys = figure.points.map((p) => p.y);
      ctx.font = '12px sans-serif';
      ctx.fillText(
        `X: ${Math.min(...xs)} … ${Math.max(...xs)} ${figure.xUnit ?? figure.unit}; Y: ${Math.min(...ys)} … ${Math.max(...ys)} ${figure.yUnit ?? 'единицы не предоставлены'}`,
        15,
        210,
      );
    }
    for (const c of calculations)
      body.append(
        details(`${c.id} · ${c.method} · формула и trace`, jsonText(c)),
      );
    if (output) {
      const plan = planPanel(() => {}),
        seek = input('0', 'range'),
        timeLabel = el('p', '0 с');
      seek.min = '0';
      seek.max = String(output.timeline.duration);
      seek.step = String(output.timeline.dt);
      let playing = false,
        raf = 0,
        last = 0;
      const draw = () => {
        const t = Number(seek.value);
        plan.draw(t);
        timeLabel.textContent = `${t.toFixed(3)} / ${output!.timeline.duration} с · dt ${output!.timeline.dt} с`;
      };
      seek.oninput = draw;
      const tick = (now: number) => {
        if (!playing || !output) return;
        const next = Math.min(
          output.timeline.duration,
          Number(seek.value) + (now - last) / 1000,
        );
        last = now;
        seek.value = String(next);
        draw();
        if (next < output.timeline.duration) raf = requestAnimationFrame(tick);
        else playing = false;
      };
      body.append(
        row(
          btn('Воспроизвести / пауза', () => {
            playing = !playing;
            if (playing) {
              last = performance.now();
              raf = requestAnimationFrame(tick);
            } else cancelAnimationFrame(raf);
          }),
          seek,
          timeLabel,
        ),
        details(
          'renderData и technical: данные порта',
          jsonText({
            renderData: output.renderData,
            technical: output.technical,
          }),
        ),
      );
      cleanups.push(() => {
        playing = false;
        cancelAnimationFrame(raf);
      });
    }
  }
  async function font() {
    const response = await fetch(
      new URL('fonts/DejaVuSans.ttf', document.baseURI),
    );
    if (!response.ok)
      throw new Error('Локальный кириллический шрифт недоступен');
    return new Uint8Array(await response.arrayBuffer());
  }
  function reportsTab() {
    body.append(
      el('h3', 'Документы'),
      el(
        'p',
        'Правовой раздел включается отдельно. Ответы на вопросы требуют существующих calculation-ID; без расчёта численный вывод не создаётся.',
      ),
    );
    const saved = (project().extensions.workspace.reportOptions ??
      {}) as unknown as Partial<ReportOptions>;
    let template = (saved.template ?? 'specialist') as ReportTemplate;
    const templates = select(
      Object.entries(REPORT_TITLES) as [string, string][],
      template,
    );
    templates.onchange = () => {
      template = templates.value as ReportTemplate;
    };
    const author = input(saved.author ?? ''),
      request = textarea(saved.request ?? ''),
      date = input(saved.date ?? new Date().toISOString().slice(0, 10), 'date'),
      questions = textarea(
        saved.questions?.map((q) => q.text).join('\n') ?? '',
      ),
      ids = textarea(
        saved.questions?.map((q) => q.calculationIds.join(',')).join('\n') ??
          '',
      ),
      legal = input('', 'checkbox');
    legal.checked = saved.includeLegal === true;
    const options = (): ReportOptions => ({
      template,
      author: author.value,
      request: request.value,
      date: date.value,
      includeLegal: legal.checked,
      questions: questions.value
        .split('\n')
        .filter(Boolean)
        .map((text, i) => ({
          text,
          calculationIds: (ids.value.split('\n')[i] ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        })),
    });
    body.append(
      label('Шаблон', templates),
      label('Автор', author),
      label('Запрос', request),
      label('Дата', date),
      label('Вопросы, по одному на строке', questions),
      label('Calculation-ID для соответствующей строки (через запятую)', ids),
      label('Включить Legal из переданного Report', legal),
      btn('Сохранить реквизиты', () =>
        set(
          '/extensions/workspace/reportOptions',
          options() as unknown as JsonValue,
        ),
      ),
      el(
        'p',
        `Доступные calculation-ID: ${calculations.map((c) => c.id).join(', ') || 'нет'}`,
      ),
      row(
        btn('Просмотр текста', async () => {
          body.append(
            details(
              'Текст документа',
              (await reportDocument(file, calculations, report, options()))
                .text,
            ),
          );
        }),
        btn('Скачать PDF', async () =>
          downloadBytes(
            'report.pdf',
            await exportPDF(
              await reportDocument(file, calculations, report, options()),
              await font(),
            ),
            'application/pdf',
          ),
        ),
        btn('Скачать DOCX', async () =>
          downloadBytes(
            'report.docx',
            await exportDOCX(
              await reportDocument(file, calculations, report, options()),
            ),
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          ),
        ),
        btn('Обезличенный PDF', async () =>
          downloadBytes(
            'redacted-report.pdf',
            await exportPDF(
              await reportDocument(redactProject(file), [], undefined, {
                template,
                author: '',
                request: 'Обезличенная производная',
                date: '',
                questions: [],
              }),
              await font(),
            ),
            'application/pdf',
          ),
        ),
      ),
    );
  }
  let mobileStep = 0;
  function mobileTab() {
    root.classList.add('ct-commissioner');
    const steps = [
      'Дата и место',
      'Шаблон',
      'Участники',
      'Позиции',
      'Следы',
      'Повреждения',
      'Фото',
      'Пояснения',
      'Разбор и экспорт',
    ];
    const data = (project().extensions.workspace.commissioner ??
      {}) as JsonObject;
    body.append(
      el('h3', `${mobileStep + 1}/9 · ${steps[mobileStep]}`),
      el(
        'p',
        navigator.onLine
          ? 'Автосохранение на этом устройстве'
          : 'Офлайн · автосохранение на этом устройстве',
      ),
    );
    if (mobileStep === 0) {
      body.append(
        field(
          'Дата и время места ДТП',
          typeof data.date === 'string' ? data.date : '',
          (v) => set('/extensions/workspace/commissioner/date', v),
          'datetime-local',
        ),
        field(
          'Адрес',
          typeof data.address === 'string' ? data.address : '',
          (v) => set('/extensions/workspace/commissioner/address', v),
        ),
        btn(
          'Записать текущую геопозицию',
          () =>
            new Promise<void>((resolve, reject) =>
              navigator.geolocation.getCurrentPosition(
                (p) => {
                  set(
                    '/extensions/workspace/commissioner/geo',
                    {
                      latitude: p.coords.latitude,
                      longitude: p.coords.longitude,
                      accuracyM: p.coords.accuracy,
                      timestamp: p.timestamp,
                    },
                    'Геопозиция',
                  );
                  message(
                    `Геопозиция записана, точность ±${p.coords.accuracy} м`,
                  );
                  resolve();
                },
                reject,
                { enableHighAccuracy: true },
              ),
            ),
        ),
        details('Зафиксированная геопозиция', jsonText(data.geo ?? null)),
      );
    }
    if (mobileStep === 1) {
      const template = select([
        ['cross', 'Крестообразный'],
        ['t', 'Т-образный'],
        ['ring', 'Кольцо'],
        ['yard', 'Двор / парковка'],
        ['highway', 'Загородная прямая'],
      ]);
      body.append(
        label('Схема места', template),
        btn('Добавить шаблон дорог', () => {
          const p = structuredClone(project());
          if (p.scene.roads.length)
            throw new Error(
              'В сцене уже есть дороги. Создайте новый проект или отредактируйте существующие дороги.',
            );
          if (template.value === 'ring')
            addRoundaboutTemplate(p.scene, { x: 0, y: 0 });
          else {
            const paths =
              template.value === 'cross'
                ? [
                    [
                      { x: -45, y: 0 },
                      { x: 45, y: 0 },
                    ],
                    [
                      { x: 0, y: -45 },
                      { x: 0, y: 45 },
                    ],
                  ]
                : template.value === 't'
                  ? [
                      [
                        { x: -45, y: 0 },
                        { x: 45, y: 0 },
                      ],
                      [
                        { x: 0, y: 0 },
                        { x: 0, y: 40 },
                      ],
                    ]
                  : [
                      [
                        { x: -60, y: 0 },
                        { x: 60, y: 0 },
                      ],
                    ];
            p.scene.roads = paths.map((pts) => ({
              id: crypto.randomUUID(),
              pts,
              lanes: 1,
              center: 'dashed',
              oneWay: false,
              zone:
                template.value === 'yard'
                  ? 'residential'
                  : template.value === 'highway'
                    ? 'outside'
                    : 'city',
              smooth: false,
            }));
          }
          changed(p, 'Мобильный шаблон');
          message('Шаблон добавлен; существующие участники сохранены.');
        }),
      );
    }
    if (mobileStep === 2) {
      for (const a of project().scene.actors) {
        const id = a.id.replace(/~/g, '~0').replace(/\//g, '~1'),
          personal = (data.participants as JsonObject | undefined)?.[a.id] as
            JsonObject | undefined;
        body.append(
          el('h4', a.id),
          field('Госномер', String(personal?.plate ?? ''), (v) =>
            set(
              `/extensions/workspace/commissioner/participants/${id}/plate`,
              v,
            ),
          ),
          field('ОСАГО', String(personal?.policy ?? ''), (v) =>
            set(
              `/extensions/workspace/commissioner/participants/${id}/policy`,
              v,
            ),
          ),
          field('Участник / контакт', String(personal?.name ?? ''), (v) =>
            set(
              `/extensions/workspace/commissioner/participants/${id}/name`,
              v,
            ),
          ),
        );
      }
      body.append(
        btn('Добавить легковой автомобиль', () => {
          const p = structuredClone(project());
          p.scene.actors.push({
            id: crypto.randomUUID(),
            kind: 'vehicle',
            type: 'car',
            x: 0,
            y: 0,
            heading: 0,
            color: '#1c69a4',
            speed: 0,
            delay: 0,
            path: [],
            flags: { drunk: false, noLicense: false, flees: false },
          } as Scene['actors'][number]);
          changed(p, 'Добавлен участник');
          render();
        }),
      );
    }
    if (mobileStep === 3) {
      const actor = select(
        project().scene.actors.map((a) => [a.id, a.id] as [string, string]),
      );
      body.append(label('Выберите ТС и нажмите его позицию на плане', actor));
      const plan = planPanel((point) => {
        const p = structuredClone(project()),
          a = p.scene.actors.find((a) => a.id === actor.value);
        if (a) {
          a.x = point.x;
          a.y = point.y;
          changed(p, 'Зафиксированная позиция ТС');
          plan.draw();
        }
      });
    }
    if (mobileStep === 4) {
      body.append(
        btn('Открыть редактор следов / осыпи / измерений', () => {
          tab = 2;
          render();
        }),
      );
      const measurement = (data.measurement ?? {}) as JsonObject;
      body.append(
        numeric('Измеренная длина рулеткой, м', measurement.value, (v) =>
          set('/extensions/workspace/commissioner/measurement/value', v),
        ),
        numeric('Точность ±м', measurement.uncertainty, (v) =>
          set('/extensions/workspace/commissioner/measurement/uncertainty', v),
        ),
        field('Прибор / источник', String(measurement.source ?? ''), (v) =>
          set('/extensions/workspace/commissioner/measurement/source', v),
        ),
      );
    }
    if (mobileStep === 5) {
      body.append(
        el(
          'p',
          'Выберите участника и нажмите зону кузова. Глубины C1–C6 вводятся в редакторе наблюдений.',
        ),
      );
      const actor = select(
        project().scene.actors.map((a) => [a.id, a.id] as [string, string]),
      );
      body.append(label('Участник', actor));
      const damage = el('div', '', 'ct-damage');
      for (const zone of [
        'Передняя часть',
        'Левая сторона',
        'Крыша',
        'Правая сторона',
        'Задняя часть',
      ])
        damage.append(
          btn(zone, () => {
            const p = structuredClone(project()),
              a = p.scene.actors.find((a) => a.id === actor.value);
            if (!a) throw new Error('Добавьте участника');
            p.evidence.push(
              newEvidence(
                'crush',
                [{ x: a.x, y: a.y }],
                {
                  actorId: a.id,
                  zone,
                  comment: 'Зафиксировано вручную; C1–C6 ещё не измерены',
                },
                'Мобильный осмотр',
              ),
            );
            changed(p, 'Tap-повреждение');
            message(`Записано: ${zone}`);
          }),
        );
      body.append(damage);
    }
    if (mobileStep === 6) {
      const capture = input('', 'file');
      capture.accept = 'image/*';
      capture.multiple = true;
      capture.setAttribute('capture', 'environment');
      capture.onchange = act(() => addFiles(capture.files));
      body.append(label('Снять / добавить оригинальные фото', capture));
      for (const [key, title] of [
        ['overview', 'Общий план'],
        ['plates', 'Номера'],
        ['damage', 'Повреждения'],
        ['markings', 'Положение относительно разметки'],
      ]) {
        const check = input('', 'checkbox');
        check.checked =
          (data.photoChecklist as JsonObject | undefined)?.[key] === true;
        check.onchange = () =>
          set(
            `/extensions/workspace/commissioner/photoChecklist/${key}`,
            check.checked,
          );
        body.append(label(title, check));
      }
      body.append(
        el(
          'p',
          `Вложений: ${file.attachments.length}. Время/геометка EXIF сохраняются при наличии; текущая геопозиция фиксируется отдельно, не подменяет EXIF.`,
        ),
      );
    }
    if (mobileStep === 7) {
      const note = textarea(String(data.statement ?? ''));
      note.onchange = () =>
        set('/extensions/workspace/commissioner/statement', note.value);
      body.append(
        label('Пояснения участника', note),
        el(
          'p',
          'Локальное распознавание речи не подключено. Введите текст; браузерная облачная диктовка автоматически не запускается. Можно сохранить локальную аудиозапись.',
        ),
      );
      const recordingFile = file;
      let recorder: MediaRecorder | undefined, stream: MediaStream | undefined;
      const chunks: BlobPart[] = [];
      body.append(
        btn('Начать локальную аудиозапись', async () => {
          if (recorder?.state === 'recording') return;
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          if (dead || file !== recordingFile) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          recorder = new MediaRecorder(stream);
          recorder.ondataavailable = (e) => chunks.push(e.data);
          recorder.onstop = () => {
            stream?.getTracks().forEach((t) => t.stop());
            if (dead || file !== recordingFile) return;
            void act(async () => {
              const a = await readAttachment(
                new File(
                  [new Blob(chunks, { type: recorder!.mimeType })],
                  'statement.webm',
                  { type: recorder!.mimeType },
                ),
              );
              if (dead || file !== recordingFile) return;
              file.attachments.push(a);
              await persist();
              message('Аудиозапись сохранена локально.');
            })();
          };
          recorder.start();
          message('Идёт локальная запись микрофона.');
        }),
        btn('Остановить запись', () => {
          if (recorder?.state === 'recording') recorder.stop();
        }),
      );
      cleanups.push(() => {
        if (recorder?.state === 'recording') recorder.stop();
        stream?.getTracks().forEach((t) => t.stop());
      });
    }
    if (mobileStep === 8) {
      body.append(
        el(
          'p',
          context.ports.rules
            ? 'Подсказки по оформлению зависят от редакции и установленных фактов.'
            : 'Европротокол и правовые подсказки недоступны без RulesPort.',
        ),
      );
      if (context.ports.rules)
        descriptorForm(context.ports.rules.describe(project()));
      body.append(
        row(
          btn('Предварительный разбор через порты', () => run()),
          btn('Справка / PDF / DOCX', () => {
            tab = 5;
            render();
          }),
          btn('Экспорт .crashtest', () => exportZIP()),
        ),
      );
      if (report)
        body.append(details('Переданный RulesPort Report', jsonText(report)));
    }
    body.append(
      row(
        btn('Назад', () => {
          mobileStep = Math.max(0, mobileStep - 1);
          render();
        }),
        btn(mobileStep === 8 ? 'К первому шагу' : 'Далее', () => {
          mobileStep = (mobileStep + 1) % 9;
          render();
        }),
      ),
    );
  }
  render();
  void restoreSaved().catch((error) => message(String(error)));
  return {
    destroy() {
      dead = true;
      generation++;
      while (cleanups.length) cleanups.pop()!();
      root.remove();
    },
  };
}
