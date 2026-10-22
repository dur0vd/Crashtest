import { DT } from '../sim';
import { lawRef } from '../law';
import { passengerFacts, type Passenger } from '../passengers';
import type { Ctx } from './context';
import type { FindingInput } from './types';

// Conjunction with explicit unknowns: one established failure is sufficient;
// success requires all required conditions to be established.
const all = (...facts: (boolean | undefined)[]): boolean | undefined =>
  facts.includes(false) ? false : facts.includes(undefined) ? undefined : true;

/** Passenger requirements do not establish a cause of the collision. They do
 * not modify harm thresholds or create diagnoses or passenger legal subjects. */
export function checkPassengers(ctx: Ctx, add: (finding: FindingInput) => unknown): void {
  for (const i of ctx.infos.values()) {
    const a = i.a, c = a.passengerContext ?? {};
    if (!i.isVeh || a.railwayTrain || (!a.passengerContext && !a.passengers)) continue;
    let movingFrame: number | undefined;
    for (let k = i.k0; k <= i.kEnd; k++) if (i.tr.present[k] && Math.abs(i.tr.v[k]) > 0) { movingFrame = k; break; }
    const emit = (state: boolean | undefined, title: string, refs: string[], code?: string, p?: Passenger, needsMovement = true) => {
      // No moving transport is established for belts/helmets/carriage rules.
      if (needsMovement && movingFrame === undefined) return;
      const sources = refs.map(ref => lawRef(ref, ctx.scene.env.accidentDate));
      const available = sources.every(ref => !!ref.revision);
      const result = available ? state : undefined;
      add({ actorId: a.id, severity: result === false ? 'violation' : result === true ? 'info' : 'contributing',
        t: (movingFrame ?? i.k0) * DT, causal: false,
        title, detail: `${p ? `Пассажир ${p.id}. ` : ''}${result === false ? 'Установлено несоблюдение требования.' : result === true ? 'Заданные факты соответствуют проверяемому требованию.' : 'Недостаточно установленных фактов или редакции нормы; административный состав не назначается.'} Причинная связь с ДТП и влияние на травмы не определяются.`,
        refs: [...refs, ...(code && result === false ? [code] : [])],
        trace: { passengerFacts: passengerFacts(a), passengerId: p?.id, observedMovingFrame: movingFrame,
          requirementResult: state ?? null, compliance: result === true ? 'выполнено' : result === false ? 'не выполнено' : 'не определить',
          sources, passengerMethod: 'Проверка явно заданных условий по возрасту, месту и оснащению; без медицинской модели',
          limits: 'Статические факты на весь прогон; полнота списка пассажиров задаётся автором сцены' } });
    };
    const motorcycle = a.type === 'motorcycle';
    const moped = a.type === 'moped';
    if (motorcycle || moped) {
      // 12.6 explicitly includes moped drivers; PDD 24.8 supplies their duty.
      emit(c.driverHelmetFastened, 'Мотошлем водителя', [motorcycle ? 'pdd:2.1.2' : 'pdd:24.8'], 'rule:passenger-belt');
    } else if (c.beltsProvided !== false) {
      emit(c.beltsProvided === true ? c.driverBeltUsed : undefined, 'Ремень водителя', ['pdd:2.1.2'], 'rule:passenger-belt');
    }
    if (a.passengers === undefined) emit(undefined, 'Состав пассажиров не установлен', ['pdd:22.8']);
    for (const p of a.passengers ?? []) {
      const age = p.age;
      const child = age !== undefined && age < 12;
      if (motorcycle) {
        emit(p.helmetFastened, 'Мотошлем пассажира', ['pdd:2.1.2', 'pdd:5.1'], 'rule:passenger-belt', p);
        emit(p.place === undefined || age === undefined ? undefined : !(p.place === 'motorcycle-rear' && child),
          'Возраст для заднего сиденья мотоцикла', ['pdd:22.9'], 'rule:passenger-child', p);
      } else if (!moped) {
        const car = c.vehicleClass === 'passenger-car';
        const truckCab = c.vehicleClass === 'truck' && p.place === 'cab';
        const eligible = car && (p.place === 'front' || p.place === 'rear') || truckCab;
        if (child && eligible && c.beltsProvided === true) {
          const restraint = p.restraintUsed === false ? false : p.restraintUsed === true
            ? all(p.restraintFits, p.restraintInstalledCorrectly) : undefined;
          const required = age < 7 || car && p.place === 'front';
          const state = required || p.restraintUsed === true ? restraint : p.beltUsed === true || restraint === true ? true
            : p.beltUsed === false && restraint === false ? false : undefined;
          emit(state, required ? 'Ребёнку требуется подходящее и правильно установленное ДУУ' : 'Ребёнок 7–11 лет: ремень или ДУУ', ['pdd:22.9'], 'rule:passenger-child', p);
        } else if (c.beltsProvided !== false) {
          // Do not turn unknown age/class/place into an adult 12.6 offence.
          const knownGeneral = age !== undefined && age >= 12 || c.vehicleClass === 'other';
          emit(c.beltsProvided === true && knownGeneral ? p.beltUsed : undefined,
            'Ремень пассажира / применимость детского требования', ['pdd:2.1.2', 'pdd:5.1', 'pdd:22.9'], 'rule:passenger-belt', p);
        }
      }
      if (p.place === 'outside') {
        // Truck bodies have explicit exceptions in 22.2/22.5. Do not infer them.
        const prohibited = motorcycle || c.vehicleClass === 'passenger-car';
        emit(prohibited ? false : undefined, 'Перевозка вне предусмотренных мест', ['pdd:22.8'], 'rule:passenger-outside', p);
      }
      if (p.place === 'body' || c.vehicleClass === 'truck' && p.place === 'outside')
        emit(undefined, 'Условия перевозки в кузове требуют отдельной проверки 22.1–22.5', ['pdd:22.1', 'pdd:22.2', 'pdd:22.5'], undefined, p);
    }
    if ((motorcycle || moped) && (a.passengers?.length ?? 0) > 0)
      emit(c.qualifyingLicenseYears === undefined ? undefined : c.qualifyingLicenseYears >= 2,
        'Стаж права управления для перевозки пассажиров', ['pdd:22.2(1)'], 'rule:passenger-general');
    if (a.passengers !== undefined && c.passengerCapacity !== undefined)
      emit(a.passengers.length <= c.passengerCapacity, 'Число пассажиров по технической характеристике', ['pdd:22.8'], 'rule:passenger-general');
    if (c.boardingWhileMoving !== undefined)
      emit(!c.boardingWhileMoving, 'Посадка и высадка только после полной остановки', ['pdd:22.7'], 'rule:passenger-general', undefined, false);
    if (c.doorsClosedWhileMoving !== undefined)
      emit(c.doorsClosedWhileMoving, 'Двери закрыты при движении', ['pdd:22.7'], 'rule:passenger-general');
    if (c.organizedChildren) emit(undefined, 'Организованная перевозка детей требует отдельной проверки', ['pdd:22.6']);
  }
}
