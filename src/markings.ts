// Горизонтальная разметка (приложение 2 к ПДД): как рисуется и какие правила на неё завязаны.

export type MarkingForm = 'line' | 'area' | 'symbol';

export interface MarkingSpec {
  /** номер по приложению 2 к ПДД */
  id: string;
  form: MarkingForm;
  name: string;
  color: string;
  /** толщина линии, м */
  width: number;
  /** штрих и пробел, м */
  dash?: [number, number];
  /** две параллельные линии: [сплошная, прерывистая] или [сплошная, сплошная] */
  pair?: 'solid-solid' | 'solid-dashed' | 'dashed-dashed';
  zigzag?: boolean;
  triangles?: boolean;
  /** пересекать линию запрещено */
  noCross?: boolean;
  /** пересекать можно с одной стороны (линия 1.11) */
  oneSide?: boolean;
  /** остановка и стоянка вдоль линии запрещены */
  noStop?: boolean;
  noParking?: boolean;
  /** въезд на площадку запрещён */
  noEnter?: boolean;
  /** стрелка: допустимые направления дальнейшего движения */
  arrows?: boolean;
}

export const MARKINGS: MarkingSpec[] = [
  { id: '1.1', form: 'line', name: 'Сплошная линия', color: '#f2f4f8', width: 0.15, noCross: true },
  { id: '1.2', form: 'line', name: 'Край проезжей части', color: '#f2f4f8', width: 0.15, noCross: true },
  { id: '1.3', form: 'line', name: 'Двойная сплошная', color: '#f2f4f8', width: 0.15, pair: 'solid-solid', noCross: true },
  { id: '1.4', form: 'line', name: 'Остановка запрещена (жёлтая)', color: '#ffcf3d', width: 0.2, noStop: true },
  { id: '1.5', form: 'line', name: 'Прерывистая', color: '#f2f4f8', width: 0.15, dash: [1, 3] },
  { id: '1.6', form: 'line', name: 'Приближение к 1.1', color: '#f2f4f8', width: 0.15, dash: [3, 1] },
  { id: '1.7', form: 'line', name: 'Полосы на перекрёстке', color: '#f2f4f8', width: 0.15, dash: [1, 1] },
  { id: '1.8', form: 'line', name: 'Граница полосы разгона', color: '#f2f4f8', width: 0.3, dash: [3, 1] },
  { id: '1.9', form: 'line', name: 'Реверсивная полоса', color: '#f2f4f8', width: 0.15, pair: 'dashed-dashed', dash: [3, 3] },
  { id: '1.10', form: 'line', name: 'Стоянка запрещена (жёлтая)', color: '#ffcf3d', width: 0.2, dash: [1, 1], noParking: true },
  { id: '1.11', form: 'line', name: 'Односторонний переход', color: '#f2f4f8', width: 0.15, pair: 'solid-dashed', oneSide: true },
  { id: '1.12', form: 'line', name: 'Стоп-линия', color: '#f2f4f8', width: 0.6 },
  { id: '1.13', form: 'line', name: 'Линия «Уступи дорогу»', color: '#f2f4f8', width: 0.5, triangles: true },
  { id: '1.16.1', form: 'area', name: 'Островок', color: '#f2f4f8', width: 0.15, noEnter: true },
  { id: '1.16.2', form: 'area', name: 'Островок на перекрёстке', color: '#f2f4f8', width: 0.15, noEnter: true },
  { id: '1.16.3', form: 'area', name: 'Островок разделения', color: '#f2f4f8', width: 0.15, noEnter: true },
  // These lines designate stops; section 12 determines prohibitions and exceptions.
  { id: '1.17.1', form: 'line', name: 'Остановка маршрутных ТС и стоянка такси', color: '#ffcf3d', width: 0.2, zigzag: true },
  { id: '1.17.2', form: 'line', name: 'Место остановки трамвая', color: '#ffcf3d', width: 0.2, zigzag: true },
  { id: '1.18', form: 'symbol', name: 'Стрелы направлений', color: '#f2f4f8', width: 0.4, arrows: true },
  { id: '1.19', form: 'symbol', name: 'Сужение полосы', color: '#f2f4f8', width: 0.4 },
  { id: '1.20', form: 'symbol', name: 'Приближение к 1.13', color: '#f2f4f8', width: 0.4 },
  { id: '1.21', form: 'symbol', name: 'Приближение к 1.12', color: '#f2f4f8', width: 0.4 },
  { id: '1.22', form: 'symbol', name: 'Номер дороги', color: '#f2f4f8', width: 0.4 },
  { id: '1.23.1', form: 'symbol', name: 'Полоса для маршрутных ТС', color: '#f2f4f8', width: 0.4 },
  { id: '1.23.2', form: 'symbol', name: 'Пешеходная дорожка', color: '#f2f4f8', width: 0.4 },
  { id: '1.23.3', form: 'symbol', name: 'Велосипедная дорожка / полоса', color: '#f2f4f8', width: 0.4 },
  { id: '1.24.1', form: 'symbol', name: 'Дублирование знака 1.24', color: '#f2f4f8', width: 0.4 },
  { id: '1.24.2', form: 'symbol', name: 'Дублирование знака 3.2x', color: '#f2f4f8', width: 0.4 },
  { id: '1.24.3', form: 'symbol', name: 'Дублирование знака 5.x', color: '#f2f4f8', width: 0.4 },
  { id: '1.25', form: 'symbol', name: 'Искусственная неровность', color: '#f2f4f8', width: 0.4 },
];

export const MARKING_BY_ID: Record<string, MarkingSpec> = Object.fromEntries(MARKINGS.map((m) => [m.id, m]));

/** Варианты стрел 1.18: какие направления дальнейшего движения разрешены. */
export const ARROW_VARIANTS: Record<string, { name: string; allow: ('straight' | 'left' | 'right' | 'uturn')[] }> = {
  straight: { name: 'Прямо', allow: ['straight'] },
  right: { name: 'Направо', allow: ['right'] },
  left: { name: 'Налево', allow: ['left', 'uturn'] },
  'straight-right': { name: 'Прямо или направо', allow: ['straight', 'right'] },
  'straight-left': { name: 'Прямо или налево', allow: ['straight', 'left', 'uturn'] },
  'left-right': { name: 'Налево или направо', allow: ['left', 'right', 'uturn'] },
};
