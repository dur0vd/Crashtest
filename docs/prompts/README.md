# Промпты: одна задача — один файл — одна ветка

20 обязательных заданий, необязательный учебный режим, независимая проверка
и дополнительный промпт итогового объединения — всего 23 TXT.
Каждый файл содержит свой worktree, назначенную ветку, зависимости, проверки и push.
06.3 опубликован: `73db13f`, 710 тестов и build на передаче.

Общая база: `codex/full-simulator-base-v1`; она не обновляется результатами задач.
Сразу можно запускать **1, 2, 4 и 5** в разных worktree/клонах.
Остальные запускать с учётом зависимостей. Итог — **23**, затем проверка **22**.

| № | Файл | Ветка | Зависимости по № | Модель |
| --- | --- | --- | --- | --- |
| 1 | [Этап 06.4 — остановка и стоянка](01-06.4-parking.txt) | `codex/06-04-parking` | база | GPT-6.1 Sol high |
| 2 | [Этап 06.5 — велосипедисты и СИМ](02-06.5-cyclists-sim.txt) | `codex/06-05-cyclists-sim` | база | Claude Opus 5.5 |
| 3 | [Этап 06.6 — световые приборы](03-06.6-lights.txt) | `codex/06-06-lights` | 1 | Claude Sonnet 5.5 |
| 4 | [Этап 06.7 — пассажиры и дети](04-06.7-passengers.txt) | `codex/06-07-passengers` | база | Claude Sonnet 5.5 |
| 5 | [Этап 07.1 — динамическое ядро](05-07.1-dynamics.txt) | `codex/07-01-dynamics` | база | Claude Opus 5.5 |
| 6 | [Этап 07.2 — регулятор и дорожные зоны](06-07.2-controller-road-zones.txt) | `codex/07-02-controller-road-zones` | 1, 2, 3, 4, 5 | GPT-6.1 Sol high |
| 7 | [Этап 08.1 — импульс и послеударное движение](07-08.1-impact-motion.txt) | `codex/08-01-impact-motion` | 6 | Claude Opus 5.5 |
| 8 | [Этап 08.2 — деформации и риск травм](08-08.2-crush-injury-risk.txt) | `codex/08-02-crush-injury-risk` | 7 | GPT-6 Astra high |
| 9 | [Этап 09 — уязвимые участники](09-09-vulnerable-participants.txt) | `codex/09-vulnerable-participants` | 2, 8 | GPT-6 Astra high |
| 10 | [Этап 10 — экспертные параметры и видимость](10-10-expert-visibility.txt) | `codex/10-expert-visibility` | 3, 6 | GPT-6 Astra high |
| 11 | [Этап 11 — доказательства и схема](11-11-evidence-scene.txt) | `codex/11-evidence-scene` | 9, 10 | Claude Sonnet 5.5 |
| 12 | [Этап 12.1 — формулы и обратная задача](12-12.1-calculators-inverse.txt) | `codex/12-01-calculators-inverse` | 11 | Claude Opus 5.5 |
| 13 | [Этап 12.2 — Монте-Карло и чувствительность](13-12.2-monte-carlo.txt) | `codex/12-02-monte-carlo` | 12 | GPT-6.1 Sol high |
| 14 | [Этап 13 — анализ видео](14-13-video.txt) | `codex/13-video` | 11 | Claude Opus 5.5 |
| 15 | [Этап 14 — отчёты PDF/DOCX](15-14-reports.txt) | `codex/14-reports` | 13, 14 | Claude Sonnet 5.5 |
| 16 | [Этап 15.1 — версии и формат проекта](16-15.1-project-format.txt) | `codex/15-01-project-format` | 15 | GPT-6.1 Sol high |
| 17 | [Этап 15.2 — журнал и воспроизводимость](17-15.2-audit-cli.txt) | `codex/15-02-audit-cli` | 16 | GPT-6.1 Sol high |
| 18 | [Этап 16 — мобильный комиссар](18-16-commissioner.txt) | `codex/16-commissioner` | 17 | Claude Sonnet 5.5 |
| 19 | [Этап 17 — верификация и валидация](19-17-validation-ci.txt) | `codex/17-validation-ci` | 13, 14, 17 | GPT-6 Astra high |
| 20 | [Этап 18 — данные и безопасность](20-18-privacy-security.txt) | `codex/18-privacy-security` | 18, 19 | GPT-6.1 Sol high |
| 21 | [Этап 19 — учебный режим, необязательно](21-19-teaching-optional.txt) | `codex/19-teaching` | 20 | Claude Sonnet 5.5 |
| 22 | [Независимая проверка](22-independent-review.txt) | `codex/full-simulator-review` | после 23 | GPT-6 Astra high |
| 23 | [Итоговое объединение](23-final-integration.txt) | `codex/full-simulator-integration` | 1–20; 21 при готовности | GPT-6.1 Sol high |

[Порядок запуска и передача](../BRANCH-WORKFLOW.md).
[Машиночитаемый реестр веток](branches.json).
[Полный план и источники названий моделей](../REMAINING-WORK.md).
[Исходные требования](../FULL-SIMULATOR-REQUEST.md).

Модели — практическая рекомендация, названия сверены 21.10.2026.
GPT-6.1 Sol выбирать в Codex/Work; Claude — в Claude Code с доступом к проекту.
Альтернативная модель указана внутри каждого TXT.
