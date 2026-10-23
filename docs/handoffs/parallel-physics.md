# Handoff: параллельный чат 1 «Физика и численные методы»

- Ветка: `codex/parallel-physics` (черновой PR в базу: dur0vd/Crashtest#6).
- База: `origin/codex/full-simulator-base-v2` = `2e1685b3d6f19e87924388647ddd9d88c655da64`.
- Соседние ветки не подтягивались; `src/parallel/contracts.ts` не менялся.
- Итоговый SHA приводится в ответе чата (не в самом коммите).

## Коммиты подэтапов

| SHA | Подэтап |
| --- | --- |
| `be9129e` | Этап 07: динамический режим, регулятор, зоны, уклоны (07.2) |
| `6a51b35` | Этап 08: импульсный удар, повторные контакты, CRASH3, риск |
| `3ff5b8f` | Этап 09: пешеходы, Searle/Wood, двухколёсное и ездок |
| `2b78a7c` | Этап 10: t1–t3/j, техвозможность по диапазонам, обзорность |
| `fadd52e`, `1031554` | Этап 12: калькуляторы, обратная задача, Монте-Карло (+ исправление импорта в тесте) |
| `f15898b` | Этап 13: видеоматематика |
| финальный | Порт, верификация, документация, этот отчёт |

## Что сделано

Подробности, формулы и проверки — [docs/PHYSICS.md](../PHYSICS.md) (§07.2–13 и
«Порт»), таблица верификации — [docs/VERIFICATION-PHYSICS.md](../VERIFICATION-PHYSICS.md),
источники и хэши — [docs/research/PHYSICS-SOURCES.md](../research/PHYSICS-SOURCES.md).

| Область ТЗ | Готово | Частично / ограничение |
| --- | --- | --- |
| 07 ядро 07.1 | сохранено; аддитивно: `integrateSubstep`, уклон и статическое удержание, `wheelLock`, `wheelMu`, явное сопротивление качению; прежние результаты не изменились | натурной валидации нет |
| 07.2 режим | `env.physics` kinematic/dynamic; pure pursuit/Stanley; профиль скорости; t2/t3 привода; реакция t1 на заданный момент; зоны μ/уклон по полям с приоритетом; неровность — только наблюдение; `Track.dynamics`; явный `unsupported` | регулятор — численная настройка; Stanley только вперёд; влияние неровности TODO(source-check) |
| 08 удар | плоский импульс с вращением, k/μc, полный/скользящий, PDOF, энергия; контакт на подшаге; повторный удар после разъединения; препятствия, отбойник, бордюр; выбег до покоя; CRASH3/EES/обратный Δv; риск Augenstein 2003/Tefft 2011 | Kudlich–Slibar не заявляется; классовые A/B не поставляются; наезд на бордюр и переезд тела не моделируются |
| 09 пешеходы | темп Knoblauch 1996; Searle с высотой, Wood (по Soica 2018), обратный диапазон; фазы полёт/скольжение в сцене; падение двухколёсного и ездок | дети/бег — ввод пользователя; накат не моделируется во времени; первоисточники Searle/Wood TODO(source-check) |
| 10 параметры | `src/expert/params.ts` (структура, нормативы ТР ТС 018/2011 как граница исправного ТС), техвозможность по диапазонам с граничным t1, безопасная скорость, жёлтый — служебное торможение, 2D-обзорность, кандидаты момента опасности | значения t1/t2/t3 методики не внесены — TODO(legal-check)/(source-check); прежний `techFor` (1,0/0,2 с, 100 м) оставлен для совместимости правил |
| 12 реконструкция | 6 калькуляторов + `expert.lateral`; Nelder–Mead/DE с сидом, невязки, неоднозначность; Монте-Карло с распределениями, перцентилями, tornado, прогрессом/отменой, Worker | UI-панель — графика/интегратор |
| 13 видео | DLT ≥4 точек, репроекция, σ калибровки; траектория по PTS со σ; движущаяся камера; наложение | декодирование медиа/UI — графика |
| Порт | `createPhysicsPort()` со всеми 12 ID и `physics.simulate` | подключение UI/CLI — интегратор |

## Публичные экспорты

- `src/physics/port.ts`: `createPhysicsPort(): PhysicsPort`, `PHYSICS_METHOD_IDS`, `physicsInputs`, `describePhysics`.
- `src/sim.ts`: `simulate(scene, options?)`, `PhysicsUnsupportedError`, `dynamicMotionMethod`,
  `projectOnPath`, `barrierContact`, `halfPlaneContact`, типы `TimelinePhysics`, `ImpactRecord`,
  `DynamicTrackSamples`, `RestPose`.
- `src/physics/index.ts`: ядро 07.1 + `zones`, `controller`, `extension`, `impact`, `crash3`,
  `injury`, `pedestrian`, `rng`, `optimize`, `montecarlo`, `inverse`.
  Отдельно: `src/physics/mc-worker.ts` (Worker), `src/physics/mc-client.ts` (`runMonteCarloInWorker`).
- `src/expert/index.ts`: `params`, `stopping`, `visibility`, `hazard`; `src/expert/calc/index.ts`: `CALCULATORS`.
- `src/video-math/index.ts`: `fitHomography`, `planeWithCovariance`, `fitTrajectory`,
  `averageSpeed`, `checkPts`, `carrierSpeed`, `overlay`.
- `Env.physics?: 'kinematic' | 'dynamic'` в `src/scene.ts` (добавочное поле, нормализуется).

## Команды и результаты (2026-10-23)

| Команда | Результат |
| --- | --- |
| `npm test` | 44 файла, 1282 теста — все пройдены (база: 35/1115; прежние сохранены без ослабления) |
| `npm run build` | успешно; прежнее предупреждение о чанке > 500 кБ |
| `node tools/check-physics-parallel-browser.mjs` (dev 5174, Chromium 141) | порт simulate/unsupported/calculate, Worker = прямой расчёт (N=1000), отмена, без ошибок |
| `node tools/check-physics-browser.mjs` (dev 5173 + preview 4173) | прежняя проверка 07.1: ядро, 79 пресетов, UI и отчёт, BSD-лицензия, без ошибок |

Для браузерных проверок в этой среде: `PLAYWRIGHT_MODULE_PATH=/opt/node22/lib/node_modules/playwright/index.mjs`,
`CHROMIUM_PATH=/opt/pw-browsers/chromium`. Таблица верификации:
`PHYSICS_VERIFICATION_OUT=<файл> npx vitest run tests/verification`.

## Файлы

В своей области: `src/physics/**`, `src/expert/**`, `src/video-math/**`, `src/sim.ts`,
`src/analysis/technical.ts`, добавочное `Env.physics` в `src/scene.ts`, тесты
`tests/physics-*.test.ts`, `tests/expert-*.test.ts`, `tests/reconstruction.test.ts`,
`tests/video-math.test.ts`, `tests/verification/*`, документы `docs/PHYSICS.md`,
`docs/VERIFICATION-PHYSICS.md`, `docs/research/PHYSICS-SOURCES.md`, этот отчёт,
проверочный скрипт `tools/check-physics-parallel-browser.mjs` (рядом с прежним
`tools/check-physics-browser.mjs` 07.1). UI, редактор, правила, хранилище,
`package.json`, `contracts.ts` и `docs/LEGAL.md` не менялись.

## Что подключить интегратору

1. Создать `createPhysicsPort()` и передать UI/pipeline/CLI. Порт не требует других портов.
2. UI (графика): переключатель `env.physics`, редактор зон/преград и параметров
   `extensions.physics.*` по `describe()`; визуализация `renderData` (колёса, силы,
   занос, ездоки, конечные позы); панель реконструкции с `runMonteCarloInWorker`
   (Worker подключится в сборку при первом импорте `mc-client.ts`).
3. Правила: брать техвозможность из `calculate('expert.braking', {mode:'scene', …})`
   (кандидаты момента опасности, вывод «мог/не мог/зависит», граничное t1) и
   служебное торможение `{mode:'yellow'}` для п. 6.14; категории `harmFor` остались
   прежними, вероятности риска — в `technical.collisions[].harm[].trace.injuryRisk`.
   Прежние `REACT`/`BRAKE_LAG`/100 м в `techFor` оставлены, чтобы не ломать правила;
   замена — решение интегратора/чата правил.
4. `docs/LEGAL.md` (вне области): предлагаемый абзац — в docs/PHYSICS.md §10.
5. Формат наблюдений видео/конечных положений для `evidence` — таблица в docs/PHYSICS.md («Порт»).
6. Предложения к контракту v2 (сейчас — совместимые адаптеры v1):
   - `calculate` может возвращать `observations` отдельно (сейчас — внутри `result`);
   - стандартные `kind` наблюдений из таблицы выше;
   - коды `unsupported` по участнику (сейчас — `FeatureIssue.code` + `path`).

## Ограничения и открытые проверки

- Натурная валидация не выполнялась; открытых данных с лицензией не подключено.
- TODO(legal-check): методика и таблица t1 (название/год, значения).
- TODO(source-check): табличные t2/t3; сверка ТР ТС 018/2011 с официальным
  текстом и ГОСТ 33997-2016 (Изм. № 1); первоисточники Searle (SAE 831622/930659)
  и Wood (Proc IMechE D 202; SAE 910814); руководство CRASH3 и Campbell 1974;
  книга Brach 1991; полный текст Hoffmann et al. 2007; модель передачи неровности
  в силы; форма «26» в знаменателе остановочного пути; методика формулы следа с t3.
- Модель плоская: без подвески/опрокидывания; координаты — развёртка поверхности
  на уклоне; удар мгновенный, раздвижение тел — численная проекция; пешеходы,
  двухколёсные, рельсовые в ударе — частицы; трамвай на рельсах — бесконечная масса.
- Без заданного сопротивления качению свободное качение по прямой не прекращается
  (видно в `rest.atRest`).
- Кривые риска — популяционные (США), не диагноз; для водителей двухколёсных/СИМ
  и детей до 15 лет кривая не подключена.
- Все пресеты: кинематический режим не изменён; в динамическом — явный
  `unsupported` для ТС без параметров, с синтетическими параметрами легковых —
  конечные результаты (тест на все пресеты).
