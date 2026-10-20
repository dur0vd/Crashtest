# 05. Объединение всех веток

Ветка: `codex/integration` ← от `main` + влить `codex/01…04`

## Промпт

```
Работай в ветке codex/integration. Создай её от актуального main.
Не коммить в main напрямую. В конце: git push -u origin codex/integration.

Прочитай AGENTS.md и docs/codex/README.md. Задачи 01–04 выполнены, каждая в своей ветке:
codex/01-fix-known-bugs, codex/02-law-versions, codex/03-qualification, codex/04-full-simulator.
Объедини их в codex/integration.

1. git fetch origin. Проверь, что все четыре ветки есть в origin; если какой-то нет — назови её и остановись.
2. Вливай строго по порядку: 01, 02, 03, 04 (git merge --no-ff, без rebase и без squash). Ветки, уже
   вошедшие в 04, вольются без изменений — это нормально.
3. После каждого merge: npm ci (если менялся package-lock.json), npm test, npm run build. Если сломалось —
   исправь отдельным коммитом «Интеграция: …» сразу после этого merge.
4. Конфликты: сохраняй поведение обеих сторон. Особое внимание — src/scene.ts (миграции формата сцены
   в одну цепочку версий), src/law.ts и src/data/*.json (не терять редакции норм), src/analysis/*, src/ui.ts.
   Если конфликт меняет смысл правовой нормы или физической формулы и выбрать нельзя — оставь обе версии
   под флагом, добавь TODO(merge-check) и опиши в итоговом сообщении.
5. Финальная проверка: npm test, npm run build, npm run validation-report (этап 17 задачи 04); все пресеты
   открываются и считаются в обоих режимах физики; сцены, сохранённые в версии из main, открываются.
6. Обнови README.md: что умеет программа, раздел «Ограничения», ссылки на docs/VALIDATION.md,
   docs/PRIVACY.md, docs/LEGAL.md.
7. Итог: список влитых веток, коммиты «Интеграция: …», все TODO(legal-check), TODO(source-check) и
   TODO(merge-check) в коде (grep) — их должен проверить человек перед слиянием в main.
```
