# Проверки графической ветки

2026-10-22. Все данные сценариев синтетические; фото создано локально Pillow,
видео — FFmpeg testsrc2. Это не натурная/юридическая валидация.

- desktop.png / mobile.png: Chromium, фактический production UI и мобильный мастер.
- network.json: запросы production UI, включая материалы/PDF/перезагрузку офлайн;
  allowlist — только origin приложения, blob локален. Внешние запросы приводят
  к падению browser test. Это не аудит сетевых действий всей ОС.
- cli.txt: реальный локальный bin через npm exec/npx, integrity отдельно от
  недоступного пересчёта, с кодами завершения.

Повторить: `npm test && npm run build && npm run test:browser`.
Playwright использует `/usr/bin/chromium`; для другой установки поменяйте
executablePath в playwright.config.ts. Dev-harness содержит только тестовые
синтетические порты, production их не импортирует.

Нативные SDK и истинные factories отсутствуют. Полный отчёт и границы:
`../handoffs/parallel-graphics.md` и `../GRAPHICS-WORKBENCH.md`.
