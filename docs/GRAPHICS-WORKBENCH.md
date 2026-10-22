# Рабочая область материалов (контракт 1)

Открытие в приложении: **Меню → Материалы, проекты и мобильный комиссар**.
Существующий редактор, парковка, СИМ и пассажиры сохранены. Его прежняя кнопка
▶ продолжает использовать существующие simulate/analyze; новые динамические
результаты отображаются только после инъекции портов в рабочую область.

```ts
import { mountWorkbench } from './src/workbench/mount';
const handle = mountWorkbench(container, {
  project, ports: { physics, rules },
  onProjectChange(next) { /* host сохраняет/синхронизирует Scene */ },
});
// При закрытии:
handle.destroy();
```

`mountWorkbench` не импортирует factories соседних веток. В этой ветке host
передаёт `{}`; вычисления честно недоступны. Интегратор передаёт настоящие
PhysicsPort/RulesPort. Обязательный контракт не менялся. Дополнительные
необязательные host-поля: `file?: ProjectFile`, `onFileChange(file)`,
`versions?: Versions`. Первые два позволяют разделить оригиналы/журнал с host;
последнее — сравнить реальные текущие версии, а не предположить их равенство.
`destroy()` отменяет принятие результатов, освобождает видео/bitmap/RAF/
ResizeObserver/микрофон. Кооперативная остановка вычислений — RunControl порта.

## Ввод

Формы строятся по `describe(project)`: RFC6901 path, тип, единицы, диапазоны,
варианты. Boolean имеет три состояния: отсутствует / true / false. Новые
параметры сохраняются в namespaces; существующие пути Scene из дескрипторов
также поддержаны. `__proto__`, `prototype`, `constructor` запрещены в pointers.

Измеренные полигоны зон вводятся нажатием точек/координатами и редактируются
в JSON. Базовый путь `extensions.physics.zones`: id, boundary, source,
mu/gradeLongitudinal/gradeCross при известности. Поле direction и измеренный
roughnessProfile[{s,z}] сохраняются; смысл научных параметров валидирует порт.
Неровность не превращается в множитель μ. Ввод t1/t2/t3/j:
`extensions.physics.vehicles[actorId].braking[key]` =
`{value?,min?,max?,source?}`. Диапазон не заменяется произвольным средним.
Если фабрика ожидает другой JSON-вид диапазона, интегратор адаптирует эту
явно описанную структуру, не меняя измеренные значения.

Evidence остаётся в ProjectEnvelope.evidence, не в новом конкурирующем Scene.
Геометрия — points[{x,y}] в метрах; values содержит ширину/колесо/ABS/комментарий,
confidence/establishedBy/heading/actorId/height/C1…C6 при известности. uncertainty.metres
не задаётся автоматически. Сравнение с model observations предупреждает, но
не исправляет исходные наблюдения. Источники, неизвестные C и погрешности видны.

Вкладка материалов сохраняет файлы как есть, отдельно SHA-256/EXIF/время импорта.
В форме наблюдения вложения выбираются по именам (values.attachmentIds);
подложка использует attachmentId и два пиксельных/мировых ориентира. Это
масштабно-поворотная survey-привязка, не исправление перспективы фотографии.
Масштабные SVG/PDF используют настоящие кромки дорог из существующей геометрии
и размеры участников Scene, показывают предупреждение об обрезании рамкой.
Размеры ТС не объявляются независимым обмером. Печать — 100%, без fit-to-page.

## Данные для визуализации и реконструкции

Timeline рисуется с его `dt`, а не константой DT. Позиции/курс/контакты приходят
из порта, UI не интегрирует движение. Вне численной схемы контракта 1 принят
необязательный адаптер renderData:

```ts
{
  samples: [{t, wheels:[{x,y}],
    vectors:[{x,y,dx,dy,label,value,unit}], visibility:[{x,y}]}],
  videoOverlays: [{attachmentId, pts, x, y}]
}
```

Все x/y/dx/dy плана — метры; dx/dy уже задают визуальную длину вектора портом,
value/unit — его численная подпись, не ещё одна сила, вычисленная UI.
videoOverlays — пиксели декодированного кадра. Иные поля не теряются: доступны
в численном renderData/technical trace. Для полноценной отрисовки данных другой
формы интегратор добавляет явный адаптер. Видимость не выводится из камеры UI.

Необязательный формат CalculationRecord.result для графиков/невязок:

```ts
{
  residuals:[{evidenceId,value,unit}],
  figures:[{title,kind:'line'|'histogram'|'tornado',unit,xUnit?,yUnit?,
    points:[{x,y}]}]
}
```

Гистограмма: x — координата столбца, y — предоставленная портом высота.
Tornado: x — знаковое влияние, y — индекс параметра. Никакие распределения,
перцентили или невязки UI не рассчитывает. Неуказанные единицы Y так и помечены.
Панель показывает строку для каждого исходного evidence, включая отсутствие
его residual. Все CalculationRecord доступны полностью с формулой/подстановкой/
единицами/источниками/допущениями. PDF/DOCX включают переданные графики и точки.

## Видео

Локальный demux извлекает реальные контейнерные PTS/duration, сортирует
presentation order и предупреждает о VFR. Кнопки переходят по индексированным
кадрам. Метки можно редактировать и удалять с записью в журнал. Разметка разрешена только после декодирования кадра с соответствующим
PTS; средний FPS и HTMLVideoElement.seek не подставляются вместо времени.
PTS не удостоверяет точность часов камеры. Неподдерживаемый кодек не блокирует
хранение оригинала/индекса, но честно блокирует точную разметку.

В workspace: videoIndexes[attachmentId], videoAnnotations и videoSync.
Аннотация: attachmentId/pts/frameIndex/pixel/sigmaPx/kind, world/sigmaM для
калибровки, optional actorId. Калибровка требует 4+ точек. Математика вызывает
`calculate('video.homography'|'video.trajectory', project, parameters)`;
parameters = attachmentId/frames/annotations/synchronization. Численную схему
адаптирует интегратор к реальному PhysicsPort. Скорости UI не вычисляет.

## Форматы, отчёты и CLI

DOM-независимы canonical/archive/verifier, CLI и генераторы документов.
`ProjectFile` = project + versions + attachments + journal + optional
savedResults/resultInputHash/artifacts. ZIP: scene.json/extensions.json/
evidence.json/journal.json/project.json + attachments/{ID} + manifest.json.
Manifest покрывает каждый payload SHA-256, не самого себя. Формат 1, контракт 1.
Старый Scene JSON мигрируется; он не имеет проверенной ZIP-целостности.
Лимиты: 256 MiB суммарно, 128 MiB/файл, 512 entries, безопасные уникальные пути.
Произвольное округление исходных чисел не применяется: shortest round-trip
finite JSON, -0→0, NaN/Infinity/undefined/разреженные массивы отвергаются.

`verifyProject(file, ports, currentVersions?)` отделяет integrity и calculation;
возвращает JSON-pointer diff, версии, статус сопоставления версий. Без actual
currentVersions статус unavailable, равенство версий не предполагается.
Сохранённые результаты восстанавливаются как данные, с проверкой inputHash;
интерфейс явно отмечает отсутствие пересчёта. Ввод новых данных инвалидирует
прежний расчёт, включая undo/redo/restore. Камера не меняет входы/журнал.

```sh
npm exec -- crashtest-verify --help
npx --no-install crashtest-verify project.crashtest --json
npm exec -- crashtest-verify project.crashtest --integrity-only
```

CLI main(args, ports, versions?) — место инъекции реальных factories интегратором.
Сейчас без PhysicsPort exit 3, а не успешный «пересчёт». Коды: 0 match или явная
ZIP-integrity-only, 1 mismatch, 2 invalid/unverified legacy integrity, 3 unavailable,
4 no baseline, 5 engine error. Выводит хэши входов/материалов, версии, отдельную
savedBaseline и вычисленный результат. `--password-env NAME` читает пароль
из окружения без печати; не передавайте пароль аргументом командной строки.
Пакет остаётся private, npm-публикация не выполнялась.

Отчёты: commissioner/specialist/training, Cyrillic PDF (DejaVu Sans локально)
и редактируемый DOCX. Ответы только по существующим calculation-ID.
technical/rules/legal разделены, legal выключен по умолчанию. Нормативные тексты
принимаются только из переданного Report. TODO(legal-check) по реквизитам
документа не подменяет генерацию реальных файлов. Особенности защиты и
консервативного обезличивания — [PRIVACY.md](PRIVACY.md).

## Мобильный режим и проверки

9 шагов: место → шаблон → участники/номера/ОСАГО → позиции на плане →
следы/рулетка → tap-повреждения → оригиналы фото/чек-лист → пояснения/
локальное аудио (текстовый fallback) → разбор через порты/экспорт.
Пять шаблонов: крест, Т, кольцо, двор, загородная прямая. Шаблон не заменяет
имеющиеся дороги. Крупные светлые элементы и нижняя навигация.

`npm test`, `npm run build`, `npm run test:browser`. Browser tests используют
production preview и отдельный dev-harness с явно синтетическими портами.
Физическая валидация fixtures не заявляется. В Linux проверены `cap sync`
и `cap doctor`: sync успешен, doctor сообщает об отсутствии Xcode; Android SDK
не найден ни в стандартных путях, ни через ANDROID_HOME/ANDROID_SDK_ROOT.
Gradle assembleDebug остановился при загрузке wrapper (Connection refused).
Нативные APK/IPA не собраны и на устройствах не проверены.

Источники/лицензии: fflate, pdf-lib, fontkit, docx, exifr, fast-png, tsx — MIT;
Mediabunny — MPL-2.0, используется без изменения исходников. DejaVu TTF и
оригинальная лицензия лежат в public/fonts. Видео/фото тестов синтетические,
локально сгенерированы, не являются натурными данными ДТП.
