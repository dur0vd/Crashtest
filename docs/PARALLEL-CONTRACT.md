# Общая граница трёх чатов

Первые три чата запускаются одновременно в разных worktree/клонах от
`codex/full-simulator-base-v2`. Никто из них не ждёт ветки соседа.
Четвёртый чат объединяет код и подключает реальные реализации.
Старые очереди из 23 файлов заменены этим указанием пользователя.

## Стабильный контракт

В базе есть `src/parallel/contracts.ts`: только TypeScript-типы, без реализации
физики, правил или фиктивного успешного результата. Версия 1 одинакова во всех
ветках. Не менять её односторонне; расширения описывать в handoff и делать
через совместимый адаптер. Изменение общего типа согласует интегратор.

- Физика: `src/physics/port.ts` экспортирует `createPhysicsPort(): PhysicsPort`.
- Правила: `src/rules/port.ts` экспортирует `createRulesPort(): RulesPort`.
- Графика: `src/workbench/mount.ts` экспортирует
  `mountWorkbench(element, {project, ports, onProjectChange})`, возвращает
  `{destroy(): void}`. Никаких прямых импортов двух отсутствующих factories.
- Интегратор создаёт оба порта и передаёт их UI, pipeline расчёта/отчёта и CLI.

`ProjectEnvelope` хранит старый `Scene` плюс независимые `extensions.physics`,
`extensions.rules`, `extensions.workspace` и `evidence`. Все namespace — JSON,
не функции/DOM. Схемы конкретных научных/правовых входов принадлежат их владельцу.
`describe(project)` даёт реальные поля/единицы/возможности; path — RFC6901
JSON Pointer относительно всего envelope. UI сохраняет поля, а их владелец
валидирует значения. Отсутствие boolean не превращать в false.

Минимальные общие пути новых данных:

- `extensions.physics.zones`: измеренные полигоны с id, boundary[{x,y}],
  mu/gradeLongitudinal/gradeCross при известности, source; уклоны безразмерны,
  положительный продольный — подъём вдоль заданного направления зоны.
  Данные неровности хранить как измеренный профиль, не произвольный множитель μ.
- `extensions.physics.vehicles`: параметры по actor ID; braking хранит
  t1/t2/t3 в секундах и j в м/с² с диапазоном/источником, без новых скрытых констант.
- `extensions.rules.lighting`: timeOfDay (day/twilight/night), установленные
  условия видимости/источник, состояния света по actor ID. Активность hazard
  остаётся в существующем Waypoint.signal/vehicleSignalAt, не дублируется.
- `evidence`: id/kind/geometry/values/source/uncertainty. Значения и исходники
  не перезаписывать рассчитанным лучшим совпадением; расчётные observations
  имеют собственное происхождение. Файлы/Blob хранит проектный слой по ID.

Физика возвращает Timeline и CalculationRecord с формулой/inputs/result/units/
sources/assumptions. Сцена сохраняет текущие km/h; ядро — SI, преобразования
явные. IDs методов: expert.braking/skid/lateral/critical-speed/throw/momentum/ees,
reconstruction.inverse/monte-carlo, video.homography/trajectory, visibility.assess.
Кривые/режимы без достаточных данных возвращают insufficient-data/unsupported,
а не ok с нулями. Названия методов сами по себе не обещают реализацию.

Правила получают Timeline и optional PhysicsOutput. Они не вычисляют заново
численную модель. Недостаток технических данных блокирует конкретный вывод,
а не всю реализацию правил. Report остаётся technical/rules/legal, известные
исходные факты не заменяются выводом из контакта или флагом класса ТС.

UI без новых портов сохраняет ввод, материалы и работающие старые функции,
для нового расчёта сообщает недоступность в этой сборке. Демонстрационные
результаты не выдаются за расчёт. В тестах интерфейса допустимы адаптеры-fixtures.
Все реальные связи и end-to-end сценарии проверяет четвёртый чат.

## Кто меняет какие файлы

| Область | Владелец |
| --- | --- |
| physics/expert/video-math, sim, analysis/technical, добавочные физические поля Scene | Физика |
| rules и остальные analysis, traffic-control/restrictions, law/corpus/подтверждённые тексты норм | Правила |
| workbench/evidence/media/reports/project/privacy/CLI, ui/editor/render/main/style, package/lock/index/Capacitor | Графика |
| contracts.ts, связывание factories, конфликты shared-типа, финальный pipeline/CLI/CI и независимая валидация | Интегратор |

Существующие признаки stopContext/mobilityContext/passengers/warningContext
переиспользовать. Новый UI-слой не должен заново определять ядро Scene,
вводить конкурирующую физику или правовую модель. Новые тесты/пресеты хранить
в уникальных профильных файлах, чтобы не создавать лишние конфликты.
Если обязательное изменение затрагивает чужую область — описать необходимый
адаптер/подключение, не тормозить свою независимую библиотеку или редактор.
