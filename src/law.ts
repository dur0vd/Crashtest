import { corpus, resolveRef, revisionsFor } from './corpus';
import type { LawRevision, LawSource } from './law-version';
import { defaultAccidentDate } from './scene';
import { supplementalAt, supplementalNorm } from './law-supplement';
// Метаданные ссылок разбора. Текст и санкция выбранной редакции — только из корпуса.

export type LawCode = 'ПДД' | 'КоАП' | 'УК' | 'ГК' | 'ОСАГО' | 'ФЗ' | 'УПК' | 'ПП';

export interface LawRef {
  id: string;
  code: LawCode;
  /** «п. 10.1», «ч. 4 ст. 12.15» */
  cite: string;
  title: string;
  text: string;
  sanction?: string;
  revision?: LawRevision;
  source?: LawSource;
  warning?: string;
}

export const DISCLAIMER =
  'Учебная модель. Разбор строится на упрощённой физике и правилах и не заменяет автотехническую экспертизу, ' +
  'решение суда, ГИБДД или консультацию юриста. Редакции норм и сроки их действия требуют проверки по источникам; предупреждения TODO(legal-check) ограничивают правовые выводы.';

type LawMetadata = Pick<LawRef, 'id' | 'code' | 'cite' | 'title'>;
const L: LawMetadata[] = [
  // ---- ПДД ---------------------------------------------------------------
  { id: 'pdd:1.5', code: 'ПДД', cite: 'п. 1.5', title: 'Общая обязанность участников движения' },
  { id: 'pdd:2.5', code: 'ПДД', cite: 'п. 2.5', title: 'Обязанности водителя при ДТП' },
  { id: 'pdd:2.6', code: 'ПДД', cite: 'п. 2.6', title: 'ДТП с пострадавшими' },
  { id: 'pdd:2.6.1', code: 'ПДД', cite: 'п. 2.6.1', title: 'ДТП без пострадавших' },
  { id: 'pdd:2.7', code: 'ПДД', cite: 'п. 2.7', title: 'Запрет управления в состоянии опьянения' },
  { id: 'pdd:4.3', code: 'ПДД', cite: 'п. 4.3', title: 'Где переходить дорогу' },
  { id: 'pdd:4.4', code: 'ПДД', cite: 'п. 4.4', title: 'Регулируемые переходы' },
  { id: 'pdd:4.5', code: 'ПДД', cite: 'п. 4.5', title: 'Нерегулируемые переходы' },
  { id: 'pdd:6.2', code: 'ПДД', cite: 'п. 6.2', title: 'Сигналы светофора' },
  { id: 'pdd:6.13', code: 'ПДД', cite: 'п. 6.13', title: 'Остановка у стоп-линии' },
  { id: 'pdd:6.14', code: 'ПДД', cite: 'п. 6.14', title: 'Жёлтый сигнал' },
  { id: 'pdd:8.1', code: 'ПДД', cite: 'п. 8.1', title: 'Безопасность манёвра' },
  { id: 'pdd:8.3', code: 'ПДД', cite: 'п. 8.3', title: 'Выезд с прилегающей территории' },
  { id: 'pdd:8.4', code: 'ПДД', cite: 'п. 8.4', title: 'Перестроение' },
  { id: 'pdd:8.8', code: 'ПДД', cite: 'п. 8.8', title: 'Поворот налево и разворот вне перекрёстка' },
  { id: 'pdd:9.1', code: 'ПДД', cite: 'п. 9.1', title: 'Полосы движения' },
  { id: 'pdd:9.1(1)', code: 'ПДД', cite: 'п. 9.1(1)', title: 'Запрет выезда на встречную полосу' },
  { id: 'pdd:9.2', code: 'ПДД', cite: 'п. 9.2', title: 'Дороги с четырьмя и более полосами' },
  { id: 'pdd:9.4', code: 'ПДД', cite: 'п. 9.4', title: 'Держаться правее' },
  { id: 'pdd:9.6', code: 'ПДД', cite: 'п. 9.6', title: 'Трамвайные пути' },
  { id: 'pdd:9.7', code: 'ПДД', cite: 'п. 9.7', title: 'Движение по полосам' },
  { id: 'pdd:9.9', code: 'ПДД', cite: 'п. 9.9', title: 'Тротуары и обочины' },
  { id: 'pdd:9.10', code: 'ПДД', cite: 'п. 9.10', title: 'Дистанция и боковой интервал' },
  { id: 'pdd:10.1', code: 'ПДД', cite: 'п. 10.1', title: 'Выбор скорости' },
  { id: 'pdd:10.2', code: 'ПДД', cite: 'п. 10.2', title: 'Скорость в населённых пунктах' },
  { id: 'pdd:10.3', code: 'ПДД', cite: 'п. 10.3', title: 'Скорость вне населённых пунктов' },
  { id: 'pdd:10.5', code: 'ПДД', cite: 'п. 10.5', title: 'Запрет резкого торможения' },
  { id: 'pdd:11.1', code: 'ПДД', cite: 'п. 11.1', title: 'Условия обгона' },
  { id: 'pdd:11.4', code: 'ПДД', cite: 'п. 11.4', title: 'Запрет обгона' },
  { id: 'pdd:13.3', code: 'ПДД', cite: 'п. 13.3', title: 'Регулируемые перекрёстки' },
  { id: 'pdd:13.4', code: 'ПДД', cite: 'п. 13.4', title: 'Левый поворот на зелёный' },
  { id: 'pdd:13.8', code: 'ПДД', cite: 'п. 13.8', title: 'Начало движения на зелёный' },
  { id: 'pdd:13.9', code: 'ПДД', cite: 'п. 13.9', title: 'Неравнозначные перекрёстки' },
  { id: 'pdd:13.11', code: 'ПДД', cite: 'п. 13.11', title: 'Равнозначные перекрёстки' },
  { id: 'pdd:13.12', code: 'ПДД', cite: 'п. 13.12', title: 'Левый поворот на нерегулируемом' },
  { id: 'pdd:14.1', code: 'ПДД', cite: 'п. 14.1', title: 'Нерегулируемый пешеходный переход' },
  { id: 'pdd:14.2', code: 'ПДД', cite: 'п. 14.2', title: 'Остановившееся перед переходом ТС' },
  { id: 'pdd:14.3', code: 'ПДД', cite: 'п. 14.3', title: 'Регулируемый пешеходный переход' },
  { id: 'pdd:17.1', code: 'ПДД', cite: 'п. 17.1', title: 'Жилая зона' },
  { id: 'sign:2.1', code: 'ПДД', cite: 'знак 2.1', title: 'Главная дорога' },
  { id: 'sign:2.4', code: 'ПДД', cite: 'знак 2.4', title: 'Уступите дорогу' },
  { id: 'sign:2.5', code: 'ПДД', cite: 'знак 2.5', title: 'Движение без остановки запрещено' },
  { id: 'sign:3.1', code: 'ПДД', cite: 'знак 3.1', title: 'Въезд запрещён' },
  { id: 'sign:3.20', code: 'ПДД', cite: 'знак 3.20', title: 'Обгон запрещён' },
  { id: 'sign:3.24', code: 'ПДД', cite: 'знак 3.24', title: 'Ограничение максимальной скорости' },
  { id: 'sign:5.5', code: 'ПДД', cite: 'знак 5.5', title: 'Дорога с односторонним движением' },

  // ---- КоАП --------------------------------------------------------------
  { id: 'koap:12.7.1', code: 'КоАП', cite: 'ч. 1 ст. 12.7', title: 'Управление без права управления' },
  { id: 'koap:12.8.1', code: 'КоАП', cite: 'ч. 1 ст. 12.8', title: 'Управление в состоянии опьянения' },
  { id: 'koap:12.9.2', code: 'КоАП', cite: 'ч. 2 ст. 12.9', title: 'Превышение скорости на 20–40 км/ч' },
  { id: 'koap:12.9.3', code: 'КоАП', cite: 'ч. 3 ст. 12.9', title: 'Превышение скорости на 40–60 км/ч' },
  { id: 'koap:12.9.4', code: 'КоАП', cite: 'ч. 4 ст. 12.9', title: 'Превышение скорости на 60–80 км/ч' },
  { id: 'koap:12.9.5', code: 'КоАП', cite: 'ч. 5 ст. 12.9', title: 'Превышение скорости более чем на 80 км/ч' },
  { id: 'koap:12.12.1', code: 'КоАП', cite: 'ч. 1 ст. 12.12', title: 'Проезд на запрещающий сигнал светофора' },
  { id: 'koap:12.13.2', code: 'КоАП', cite: 'ч. 2 ст. 12.13', title: 'Непредоставление преимущества на перекрёстке' },
  { id: 'koap:12.14.3', code: 'КоАП', cite: 'ч. 3 ст. 12.14', title: 'Непредоставление преимущества при манёвре' },
  { id: 'koap:12.15.1', code: 'КоАП', cite: 'ч. 1 ст. 12.15', title: 'Нарушение расположения ТС на проезжей части' },
  { id: 'koap:12.15.2', code: 'КоАП', cite: 'ч. 2 ст. 12.15', title: 'Движение по тротуарам и велодорожкам' },
  { id: 'koap:12.15.4', code: 'КоАП', cite: 'ч. 4 ст. 12.15', title: 'Выезд на встречную полосу' },
  { id: 'koap:12.16.1', code: 'КоАП', cite: 'ч. 1 ст. 12.16', title: 'Несоблюдение требований знаков и разметки' },
  { id: 'koap:12.16.3', code: 'КоАП', cite: 'ч. 3 ст. 12.16', title: 'Встречное движение по одностороннему' },
  { id: 'koap:12.18', code: 'КоАП', cite: 'ст. 12.18', title: 'Непропуск пешеходов' },
  { id: 'koap:12.24.1', code: 'КоАП', cite: 'ч. 1 ст. 12.24', title: 'Нарушение ПДД, повлёкшее лёгкий вред здоровью' },
  { id: 'koap:12.24.2', code: 'КоАП', cite: 'ч. 2 ст. 12.24', title: 'Нарушение ПДД, повлёкшее вред здоровью средней тяжести' },
  { id: 'koap:12.27.1', code: 'КоАП', cite: 'ч. 1 ст. 12.27', title: 'Невыполнение обязанностей водителя при ДТП' },
  { id: 'koap:12.27.2', code: 'КоАП', cite: 'ч. 2 ст. 12.27', title: 'Оставление места ДТП' },
  { id: 'koap:12.29.1', code: 'КоАП', cite: 'ч. 1 ст. 12.29', title: 'Нарушение ПДД пешеходом' },

  // ---- УК ----------------------------------------------------------------
  { id: 'uk:264.1', code: 'УК', cite: 'ч. 1 ст. 264', title: 'Нарушение ПДД, повлёкшее тяжкий вред здоровью' },
  { id: 'uk:264.2', code: 'УК', cite: 'ч. 2 ст. 264', title: 'Тяжкий вред при отягчающих обстоятельствах' },
  { id: 'uk:264.3', code: 'УК', cite: 'ч. 3 ст. 264', title: 'Нарушение ПДД, повлёкшее смерть' },
  { id: 'uk:264.4', code: 'УК', cite: 'ч. 4 ст. 264', title: 'Смерть при отягчающих обстоятельствах' },
  { id: 'uk:264.5', code: 'УК', cite: 'ч. 5 ст. 264', title: 'Смерть двух и более лиц' },
  { id: 'uk:264.6', code: 'УК', cite: 'ч. 6 ст. 264', title: 'Смерть двух и более лиц при отягчающих обстоятельствах' },

  // ---- Гражданское право ------------------------------------------------
  { id: 'gk:1064', code: 'ГК', cite: 'ст. 1064 ГК РФ', title: 'Общие основания ответственности за вред' },
  { id: 'gk:1079', code: 'ГК', cite: 'ст. 1079 ГК РФ', title: 'Источник повышенной опасности' },
  { id: 'osago:11.1', code: 'ОСАГО', cite: 'ст. 11.1 закона об ОСАГО', title: 'Оформление ДТП без полиции' },
];

/** Метаданные справочника. Дословные тексты и санкции берём только из корпуса. */
export const LAW: Record<string, LawMetadata & { revisions: LawRevision[]; readonly sanction?: string }> = Object.fromEntries(L.map((r) => [r.id, {
  ...r, revisions: revisionsFor(r.id),
  get sanction() { return lawRef(r.id, defaultAccidentDate()).sanction; },
}]));

export function lawRef(id: string, date: string): LawRef {
  const supplement = supplementalAt(id, date);
  if (supplement) return { id, code: supplement.code, cite: supplement.cite, title: supplement.title,
    text: supplement.revision?.text ?? '', revision: supplement.revision, source: supplement.revision?.source,
    warning: supplement.revision ? supplement.revision.legalCheck : `TODO(legal-check): нет проверенной редакции ${id} на дату ${date}.` };
  const full = resolveRef(corpus, id, date);
  const meta = L.find((r) => r.id === id);
  const d = describeRef(id);
  return {
    id, code: (d.code || 'ПДД') as LawCode, cite: d.cite, title: full?.title ?? meta?.title ?? id,
    text: full?.text ?? '', sanction: full?.sanction ?? undefined,
    revision: full?.revision, source: full?.revision?.source,
    warning: full?.warning ?? (!full ? `TODO(legal-check): нет редакции ${id} на дату ${date}; источник и дата редакции не подтверждены.` : undefined),
  };
}

export function refLabel(id: string): string {
  const r = LAW[id];
  return r ? `${r.cite} ${r.code === 'ПДД' || r.code === 'КоАП' || r.code === 'УК' ? r.code + ' РФ' : ''}`.trim() : id;
}

/** Подпись нормы для любой ссылки, в том числе той, которой нет в кратком справочнике выше. */
export function describeRef(id: string): { cite: string; code: LawCode | '' } {
  const supplement = supplementalNorm(id);
  if (supplement) return { cite: supplement.cite, code: supplement.code };
  const known = LAW[id];
  if (known) return { cite: known.cite, code: known.code };
  const kind = id.slice(0, id.indexOf(':'));
  const rest = id.slice(id.indexOf(':') + 1);
  switch (kind) {
    case 'pdd':
      return { cite: rest.startsWith('op:') ? `п. ${rest.slice(3)} ОП` : `п. ${rest}`, code: 'ПДД' };
    case 'sign':
      return { cite: `знак ${rest}`, code: 'ПДД' };
    case 'marking':
      return { cite: `разметка ${rest}`, code: 'ПДД' };
    case 'koap':
    case 'uk': {
      const [article, part] = rest.includes('#') ? rest.split('#') : kind === 'koap' ? [rest.split('.').slice(0, 2).join('.'), rest.split('.').slice(2).join('.')] : [rest.split('.')[0], rest.split('.').slice(1).join('.')];
      return { cite: part ? `ч. ${part} ст. ${article}` : `ст. ${article}`, code: kind === 'koap' ? 'КоАП' : 'УК' };
    }
    default:
      return { cite: id, code: '' };
  }
}
