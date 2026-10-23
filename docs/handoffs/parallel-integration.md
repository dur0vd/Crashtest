# Handoff: чат 4 «Проверка и объединение»

- Ветка: `codex/parallel-integration` (черновой PR в базу: dur0vd/Crashtest#7).
- База: `codex/full-simulator-base-v2` = `2e1685b3d6f19e87924388647ddd9d88c655da64`.
- Входы: physics `b4cffde`, rules `1d81383`, graphics `58a5797` — все опубликованы,
  общий предок с базой у каждого = `2e1685b`. Снимок — [../integration-inputs.json](../integration-inputs.json).
- Итоговый SHA приводится в ответе чата (не в этом коммите).
- Main, база и ветки авторов не менялись; npm не публиковался, сайт не развёртывался.

## Коммиты

| SHA | Шаг |
| --- | --- |
| `8dde404`, `170c93a`, `bc00a6f` | merge --no-ff physics, rules, graphics (конфликтов нет) |
| `5c192ad` | общий конвейер портов, адаптер торможения физика → правила |
| `4fdb430` | ▶ и рабочая область на реальных портах, выбор режимов |
| `1b4a219` | CLI с реальными портами и версиями |
| `71029c5` | проверки общих границ |
| `d05c3af` | Монте-Карло в Worker; исправление статуса отмены |
| `1ee3c2b` | проверки в Chromium |
| `3fb3a8f` | этап 17: валидация CRASH3 по NHTSA, `npm run validation-report` |
| `bbff757` | одинаковые входы в проверке детерминизма |
| `7f8df67` | этап 18/17: аудит сборки, тесты безопасности, CI |
| финальный | документы: INTEGRATION, README, FULL-SIMULATOR, этот отчёт |

## Что сделано

Подробно — [../INTEGRATION.md](../INTEGRATION.md) (устройство, адаптер, сверка ТЗ 04–19, долги),
[../VALIDATION.md](../VALIDATION.md) (верификация и валидация).

- Реальные `createPhysicsPort()` и `createRulesPort()` подключены к ▶, `mountWorkbench`,
  проверке воспроизводимости и CLI через `src/integration/ports.ts`; заглушек в рабочем пути нет.
- Динамический режим исполняет новое ядро; при отсутствии параметров — явное окно unsupported.
- Экспертный режим не показывает правовую оценку; новая ситуация главного окна — явный учебный.
- Версии: движок 0.3.0, хэш корпуса норм; сохраняются вместе с результатом.
- Валидация CRASH3 на 150 открытых испытаниях: 9,3 % средняя ошибка EES (цель ≤ 15 %).
- CI на PR и отдельный workflow валидации.

## Публичные экспорты (интегратор)

- `src/integration/ports.ts`: `createPorts`, `runProject`, `currentVersions`, `deriveBrakingProofs`,
  `rulesMode`, `issueText`, `ENGINE_VERSION`, типы `IntegratedPorts`, `ProjectRun`, `RulesMode`.
- `src/integration/browser.ts`: `workerMonteCarlo`.
- `src/physics/port.ts`: `createPhysicsPort({monteCarlo?})`, тип `MonteCarloRunner`.
- `tools/audit-build.mjs`: `auditBuild`, `ALLOWED`.

## Команды и результаты (2026-10-23, Node 22.22.0, Chromium 141)

| Команда | Результат |
| --- | --- |
| `npm test` | 1557/1557, 61 файл (база 1115/35 сохранена) |
| `npm run build` | успешно; прежнее предупреждение о чанках > 500 кБ |
| `node tools/audit-build.mjs dist` | внешних адресов вне списка нет |
| `npm audit --omit=dev` / `npm audit --audit-level=high` | 0 уязвимостей / 0 high и critical (3 moderate в dev-цепочке Capacitor CLI) |
| `CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:browser` | 7/7, повторено несколько раз |
| `npm run validation-data && npm run validation-report` | 150 испытаний; верификация и валидация пройдены |

Удалённый запуск workflow этим не подтверждается — смотреть статус CI в PR.
Один ранний прогон Playwright дал сбой теста удаления в мобильном мастере; в последующих
прогонах (более 6) не воспроизвёлся, причина не установлена.

## Файлы вне таблицы владельцев интегратора

Изменены ради подключения, отдельными коммитами с обоснованием:
`src/main.ts`, `src/ui.ts`, `src/workbench/mount.ts`, `src/cli/bin.mjs`, `playwright.config.ts`,
`package.json` (скрипты `validation-*`), `.gitignore`, `tests/browser/graphics.spec.ts`
(ожидание сборки без портов), `src/physics/port.ts` (режим `observed`, исполнитель МК),
`src/rules/expert.ts` (экстренное торможение для `collision-avoidance`). README и
FULL-SIMULATOR.md обновлены. Чужие handoff не менялись.

## Источники

NHTSA Vehicle Crash Test Database API (`nrd.api.nhtsa.dot.gov`) — данные загружаются скриптом,
в репозиторий не входят; условия распространения — TODO(source-check). Остальные источники
формул и норм — в документах чатов physics/rules.

## Ограничения и остаток

См. «Сверка ТЗ», «Долги» и «Остаток работы» в INTEGRATION.md: табличные t1–t3, каталог
динамических параметров, валидация кроме барьерного CRASH3, сверка 850 интервалов корпуса,
нативные сборки, этап 19.
