# Графика, интерфейс и материалы

База: `2e1685b` (`origin/codex/full-simulator-base-v2`). Ветка: `codex/parallel-graphics`.
Контракт `src/parallel/contracts.ts` версии 1 не меняется. Чужие ветки не импортируются.

## Подэтап 15/18: проектная основа

Реализованы DOM-независимые canonical/SHA256/ZIP, неизменённые оригиналы,
manifest хэшей payload, лимиты и пути импорта, миграция старого Scene,
версии, журнал было/стало/кто/время, undo/redo/restore, IndexedDB CRUD,
общий verifier с инъекцией портов и diff, локальный CLI, PBKDF2/AES-GCM,
консервативный обезличенный производный проект (без оригиналов/истории/расчётов).

Числа: shortest round-trip ECMAScript JSON, без потери значащих разрядов;
-0 канонизируется в 0, NaN/Infinity/undefined отвергаются. Это сознательно
не фиксированное количество десятичных знаков для разноразмерных измерений.
SHA-256 не является электронной подписью/доказательством автора.
Версии неподключённого engine/corpus честно unavailable/unrecorded.

CLI: `npm exec -- crashtest-verify project.crashtest`,
`npx --no-install crashtest-verify --help` после npm install.
`--integrity-only` явно отделён от пересчёта. Без PhysicsPort exit 3.
Пароль: `--password-env NAME` (значение не печатается).
Интегратор передаёт реальные порты в `main(args, ports)` / `verifyProject`.

Проверки и последующие подэтапы дополняются в этом же отчёте.

Проверка подэтапа: `npm test` 1126/1126 (36 файлов), `npm run build` успешно;
`npm exec -- crashtest-verify --help` успешно. Все исходные 1115 тестов сохранены.
Проверка ZIP не распространяется на legacy JSON (integrity: not-checked).
