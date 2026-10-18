import markingIndex from './data/marking-index.json';
import signIndex from './data/sign-index.json';

// Лёгкий справочник знаков для редактора (названия и картинки). Полные тексты — в corpus.ts.

type Index = Record<string, [string, string]>;
const SIGNS = signIndex as unknown as Index;
const MARKS = markingIndex as unknown as Index;

export const SIGN_GROUPS: { id: string; title: string }[] = [
  { id: '1', title: 'Предупреждающие' },
  { id: '2', title: 'Приоритета' },
  { id: '3', title: 'Запрещающие' },
  { id: '4', title: 'Предписывающие' },
  { id: '5', title: 'Особых предписаний' },
  { id: '6', title: 'Информационные' },
  { id: '7', title: 'Сервиса' },
  { id: '8', title: 'Таблички' },
];

/** Старые виды знаков из ранних версий сохранённых сцен. */
export const LEGACY_SIGN_KIND: Record<string, string> = {
  main: '2.1',
  giveway: '2.4',
  stop: '2.5',
  noentry: '3.1',
  limit: '3.24',
  noovertake: '3.20',
  crosswalk: '5.19.1',
};

const numKey = (id: string): number[] => id.split('.').map((n) => parseInt(n, 10));

export const SIGN_IDS: string[] = Object.keys(SIGNS).sort((a, b) => {
  const x = numKey(a);
  const y = numKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? -1) !== (y[i] ?? -1)) return (x[i] ?? -1) - (y[i] ?? -1);
  return 0;
});

export const signTitle = (id: string): string => SIGNS[id]?.[0] ?? `Знак ${id}`;
export const signFile = (id: string): string => SIGNS[id]?.[1] ?? '';
export const hasSign = (id: string): boolean => id in SIGNS;
export const signGroupOf = (id: string): string => id.split('.')[0];
export const markingTitle = (id: string): string => MARKS[id]?.[0] ?? `Разметка ${id}`;
export const markingFile = (id: string): string => MARKS[id]?.[1] ?? '';

/** Знаки, у которых на самом знаке указано число (км/ч, т, м). */
export const VALUE_SIGNS: Record<string, { label: string; unit: string; def: number; min: number; max: number; step: number }> = {
  '3.11': { label: 'Максимальная масса', unit: 'т', def: 7, min: 1, max: 60, step: 0.5 },
  '3.12': { label: 'Масса на ось', unit: 'т', def: 6, min: 1, max: 30, step: 0.5 },
  '3.13': { label: 'Максимальная высота', unit: 'м', def: 3.5, min: 2, max: 6, step: 0.1 },
  '3.14': { label: 'Максимальная ширина', unit: 'м', def: 2.7, min: 1.5, max: 4, step: 0.1 },
  '3.15': { label: 'Максимальная длина', unit: 'м', def: 10, min: 3, max: 30, step: 0.5 },
  '3.16': { label: 'Минимальная дистанция', unit: 'м', def: 50, min: 10, max: 200, step: 5 },
  '3.24': { label: 'Ограничение скорости', unit: 'км/ч', def: 40, min: 5, max: 130, step: 5 },
  '3.25': { label: 'Конец ограничения скорости', unit: 'км/ч', def: 40, min: 5, max: 130, step: 5 },
  '4.6': { label: 'Минимальная скорость', unit: 'км/ч', def: 40, min: 10, max: 130, step: 5 },
  '5.31': { label: 'Ограничение скорости в зоне', unit: 'км/ч', def: 30, min: 5, max: 130, step: 5 },
  '5.32': { label: 'Конец зоны ограничения скорости', unit: 'км/ч', def: 30, min: 5, max: 130, step: 5 },
  '8.2.1': { label: 'Зона действия знака', unit: 'м', def: 150, min: 10, max: 1000, step: 10 },
};
