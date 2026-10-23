/**
 * npm run validation-report → docs/VALIDATION.md (stage 17).
 * Runs the verification and validation suites in separate vitest processes,
 * computes the reference scenes for manual cross-checking with other software
 * and states explicitly which areas are not validated.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRESETS } from '../src/presets';
import { createPorts, currentVersions } from '../src/integration/ports';
import { newProject } from '../src/project/model';

const dir = mkdtempSync(join(tmpdir(), 'crashtest-validation-'));
const verificationOut = join(dir, 'verification.md'), validationOut = join(dir, 'validation.json');
const vitest = (target: string, env: Record<string, string>) =>
  spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', target], { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 1 << 26 });

const ver = vitest('tests/verification', { PHYSICS_VERIFICATION_OUT: verificationOut });
const val = vitest('tests/validation', { VALIDATION_OUT: validationOut });
const versions = await currentVersions();
const date = new Date().toISOString().slice(0, 10);

const fmt = (x: number, d = 2) => x.toFixed(d).replace('.', ',');
const pct = (x: number) => `${fmt(100 * x, 1)} %`;

// ---------------------------------------------------------------- validation
type Validation = { source: string; retrieved: string; records: number; targets: { meanAbsRel: number; p90AbsRel: number };
  metrics: { n: number; meanAbsRel: number; p90AbsRel: number; biasKmh: number; rmseKmh: number; maxAbsKmh: number; baselineMeanAbsRel: number };
  byClass: Record<string, { n: number; meanAbsRel: number; biasKmh: number }> };
const validation: Validation | null = existsSync(validationOut) ? JSON.parse(readFileSync(validationOut, 'utf8')) : null;
const validationSection = validation ? [
  `Источник: ${validation.source}, загрузка ${validation.retrieved.slice(0, 10)}, ${validation.records} испытаний (скрипт \`npm run validation-data\`).`,
  'Данные в репозиторий не входят: условия распространения не проверены (TODO(source-check)).', '',
  '| Метрика | Значение | Цель | Статус |', '| --- | --- | --- | --- |',
  `| Средняя abs(EES − V)/V (leave-one-out, n=${validation.metrics.n}) | ${pct(validation.metrics.meanAbsRel)} | ≤ ${pct(validation.targets.meanAbsRel)} | ${validation.metrics.meanAbsRel <= validation.targets.meanAbsRel ? 'выполнена' : 'НЕ выполнена'} |`,
  `| 90-й перцентиль abs(EES − V)/V | ${pct(validation.metrics.p90AbsRel)} | ≤ ${pct(validation.targets.p90AbsRel)} | ${validation.metrics.p90AbsRel <= validation.targets.p90AbsRel ? 'выполнена' : 'НЕ выполнена'} |`,
  `| Смещение | ${fmt(validation.metrics.biasKmh)} км/ч | — | справочно |`,
  `| RMSE | ${fmt(validation.metrics.rmseKmh)} км/ч | — | справочно |`,
  `| Максимальная ошибка | ${fmt(validation.metrics.maxAbsKmh)} км/ч | — | справочно |`,
  `| Базовая модель «средняя скорость обучения» (без деформации) | ${pct(validation.metrics.baselineMeanAbsRel)} | CRASH3 < 0,75 × базовой | ${validation.metrics.meanAbsRel < 0.75 * validation.metrics.baselineMeanAbsRel ? 'выполнена' : 'НЕ выполнена'} |`,
  '', '| Класс массы, кг | n | Средняя относительная ошибка | Смещение, км/ч |', '| --- | --- | --- | --- |',
  ...Object.entries(validation.byClass).map(([c, m]) => `| ${c} | ${m.n} | ${pct(m.meanAbsRel)} | ${fmt(m.biasKmh)} |`),
] : ['**Не выполнена в этом запуске:** нет файла данных `tests/validation/data/nhtsa-frontal-rigid.json`. Загрузите его `npm run validation-data` и повторите `npm run validation-report`.'];

// -------------------------------------------------- reference scenes for cross-check
const ports = createPorts();
const REFERENCE = ['Пешеход выбежал вне перехода', 'Наезд сзади на светофоре', 'Равнозначный перекрёсток: помеха справа', 'Гололёд: скорость не соответствует условиям'];
const external: { scene: string; quantity: string; software: string; version: string; value: number; unit: string; enteredBy: string; date: string }[] =
  existsSync('docs/validation/external-results.json') ? JSON.parse(readFileSync('docs/validation/external-results.json', 'utf8')) : [];
const refRows: string[] = [];
for (const title of REFERENCE) {
  const run = await ports.physics.simulate(newProject(PRESETS.find(p => p.title === title)!.build()).project);
  if (run.status !== 'ok') { refRows.push(`| ${title} | — | ${run.status} | | | |`); continue; }
  const c = run.value.timeline.collisions[0];
  const quantities: [string, string, number][] = c
    ? [['t контакта', 'с', c.t], ['скорость сближения', 'км/ч', c.rel * 3.6], [`Δv ${c.a}`, 'км/ч', c.dvA * 3.6], [`Δv ${c.b}`, 'км/ч', c.dvB * 3.6]]
    : [['столкновение', '—', 0]];
  for (const [q, unit, value] of quantities) {
    const other = external.filter(e => e.scene === title && e.quantity === q);
    refRows.push(`| ${title} | ${q} | ${fmt(value)} ${unit} | ${other.map(o => `${o.software} ${o.version}: ${fmt(o.value)} ${o.unit}`).join('; ') || '—'} | ${other.map(o => fmt(o.value - value)).join('; ') || '—'} |`);
  }
}

// ------------------------------------------------------------------- document
const verification = existsSync(verificationOut) ? readFileSync(verificationOut, 'utf8').trim() : '**Таблица не сформирована — см. вывод теста.**';
const status = (r: ReturnType<typeof spawnSync>) => (r.status === 0 ? 'пройдено' : `ОШИБКА (код ${r.status})`);
const doc = `# Верификация и валидация Crashtest

Документ собран командой \`npm run validation-report\` (${date}). Не редактировать вручную.

| Версия | Значение |
| --- | --- |
| Движок (физика + правила) | ${versions.engine} |
| Интерфейс | ${versions.ui} |
| Корпус норм | \`${versions.corpus}\` |
| Node.js | ${process.version} |

**Верификация** — код считает то, что заявлено (аналитика, ручной расчёт, опубликованный пример).
**Валидация** — модель согласуется с реальными измерениями. Это разные утверждения.

## 1. Верификация формул физики и экспертных расчётов

Набор \`tests/verification\`: ${status(ver)}.

${verification}

Сквозная проверка интеграции (\`tests/integration-*.test.ts\`, \`tests/browser/integration.spec.ts\`):
Timeline порта побитово совпадает с прежним simulate() на всех пресетах, учебный режим правил
сохраняет все прежние выводы, адаптер торможения проверен по независимой формуле, CLI
пересчитывает проект в отдельном процессе Node, хэши результатов Node и Chromium совпадают.

## 2. Валидация по открытым натурным данным

Набор \`tests/validation\`: ${status(val)}.

### 2.1 CRASH3: энергия деформации → скорость удара о жёсткий барьер

Метод: испытания группируются по массе; в каждой группе leave-one-out — модель Кэмпбелла
V = b0 + b1·C̄ подбирается МНК по остальным ТС (b0 ≥ 0), переводится в A/B
(\`stiffnessFromTest\`), энергия удержанного ТС по шести точкам профиля считается
\`crushEnergy\`, EES = √(2E/m) сравнивается с измеренной скоростью удара.
Цели (\`TARGET_*\` в тесте) зафиксированы до первого прогона как проектный критерий
приёмки; литературной оценки точности CRASH3 в проекте нет (TODO(source-check)).
Дополнительно модель должна заметно превосходить базовую модель без деформации.

${validationSection.join('\n')}

Пределы: только фронтальный полный удар о жёсткий барьер, ширина повреждения — по
протоколу (или ширина ТС, если не измерена), отскок не выделен (как при выводе
коэффициентов по барьерным испытаниям). Это не проверяет удар ТС–ТС, вращение, PDOF.

## 3. Не валидировано (явно)

| Область | Состояние |
| --- | --- |
| 07 динамика ТС, шины Dugoff, регулятор | только аналитика/синтетика; натурных траекторий с лицензией нет |
| 08 импульсный удар ТС–ТС, вращение, Δv/PDOF | только предельные случаи; сравнения с акселерометрами NHTSA VTV нет |
| 08 риск травм (Augenstein 2003) | воспроизведена опубликованная параметризация, не проверена на российских данных |
| 09 отброс пешехода Searle/Wood, падение двухколёсного | воспроизведены опубликованные примеры; испытаний с манекенами нет |
| 10 t1–t3/j и техническая возможность | табличные значения методики не внесены (TODO(legal-check)/(source-check)); натурных торможений нет |
| 12 обратная задача и Монте-Карло | синтетические данные; калибровка неопределённости по реальным ДТП не выполнена |
| 13 видео | синтетические проекции и VFR-фикстура; реальных записей с эталонной скоростью нет |
| Правила/правовая часть | проверки на заданных вручную треках; юридическая полнота не заявлена |

## 4. Перекрёстная проверка с другим ПО (ручная таблица)

Эталонные сцены — пресеты Crashtest (кинематический режим, учебные параметры). Чужое ПО
не используется и не копируется: результаты вносит человек в
\`docs/validation/external-results.json\` (поля scene, quantity, software, version, value,
unit, enteredBy, date) и пересобирает отчёт.

| Сцена | Величина | Crashtest | Другое ПО | Разность |
| --- | --- | --- | --- | --- |
${refRows.join('\n')}
`;
writeFileSync('docs/VALIDATION.md', doc);
console.log(`docs/VALIDATION.md: verification ${status(ver)}, validation ${validation ? status(val) : 'not run'}`);
if (ver.status !== 0) { console.error(ver.stdout.slice(-3000)); process.exitCode = 1; }
if (val.status !== 0) { console.error(val.stdout.slice(-3000)); process.exitCode = 1; }
