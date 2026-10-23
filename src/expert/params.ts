/**
 * Expert-calculation parameters (stage 10). A value is used only with a source.
 * Missing methodology values stay null with TODO markers; the user supplies the
 * value (override) and the report records the deviation from the table.
 * Units: seconds for t1/t2/t3, m/s² for j.
 */

export type ParamOrigin = 'table' | 'override' | 'derived' | 'regulatory-bound';

export interface ExpertValue {
  /** Selected (typical) value and the range used in range calculations. */
  value: number;
  min: number;
  max: number;
  origin: ParamOrigin;
  source: string;
  /** Present when an override replaces a tabulated value (recorded in the report). */
  deviation?: string;
  notes: string[];
}

export type ReactionSituation =
  | 'hazard-visible-in-advance'
  | 'sudden-hazard'
  | 'hazard-needs-assessment'
  | 'other';

/**
 * Driver reaction time t1 by road situation. TODO(legal-check): the exact title,
 * year and table of the methodological recommendations used in Russian forensic
 * automotive examinations are not confirmed in this repository, so no value is
 * bundled. The structure is kept so that confirmed values can be added with the
 * exact citation; until then t1 must be entered (with its source) by the expert.
 */
export const T1_TABLE: { situation: ReactionSituation; label: string; value: null; source: null; status: string }[] = [
  { situation: 'hazard-visible-in-advance', label: 'Опасность в поле зрения заранее', value: null, source: null, status: 'TODO(legal-check): методика и значение не подтверждены' },
  { situation: 'sudden-hazard', label: 'Внезапное возникновение опасности', value: null, source: null, status: 'TODO(legal-check): методика и значение не подтверждены' },
  { situation: 'hazard-needs-assessment', label: 'Требуется оценка ситуации', value: null, source: null, status: 'TODO(legal-check): методика и значение не подтверждены' },
  { situation: 'other', label: 'Иное', value: null, source: null, status: 'TODO(legal-check): методика и значение не подтверждены' },
];

/**
 * t2/t3 by brake actuation type and vehicle category: TODO(source-check) — the
 * methodological tables are not confirmed here; values must be entered with a source.
 */
export const T2_T3_TABLE: { actuation: 'hydraulic' | 'pneumatic'; category: string; t2: null; t3: null; status: string }[] = [
  { actuation: 'hydraulic', category: 'M1/N1', t2: null, t3: null, status: 'TODO(source-check): табличные t2/t3 не подтверждены' },
  { actuation: 'pneumatic', category: 'M2/M3/N2/N3', t2: null, t3: null, status: 'TODO(source-check): табличные t2/t3 не подтверждены' },
];

/**
 * Regulatory efficiency of the service brake of a vehicle in use, road test at
 * 40 km/h: Technical Regulation of the Customs Union TR CU 018/2011, Annex 8,
 * Table 1.4 (text obtained 2026-10-22 from the pddmaster.ru transcription;
 * comparison with the official EAEU text and with GOST 33997-2016 incl. its
 * Amendment No. 1 of 2025 — TODO(source-check)). These are bounds of a
 * serviceable vehicle under test conditions, NOT a measurement of the given vehicle.
 */
export const REGULATORY_SERVICE_BRAKE: { category: 'M1' | 'M2/M3' | 'N1' | 'N2/N3'; stoppingDistanceMax: number; steadyDecelMin: number; actuationTimeMax: number }[] = [
  { category: 'M1', stoppingDistanceMax: 16.6, steadyDecelMin: 4.9, actuationTimeMax: 0.6 },
  { category: 'M2/M3', stoppingDistanceMax: 18.6, steadyDecelMin: 4.9, actuationTimeMax: 0.8 },
  { category: 'N1', stoppingDistanceMax: 16.6, steadyDecelMin: 4.9, actuationTimeMax: 0.6 },
  { category: 'N2/N3', stoppingDistanceMax: 20.0, steadyDecelMin: 4.4, actuationTimeMax: 0.8 },
];

export const REGULATORY_SOURCE = 'ТР ТС 018/2011, приложение 8, табл. 1.4 (рабочая тормозная система, дорожные испытания с 40 км/ч); по транскрипции pddmaster.ru, сверка с официальным текстом и ГОСТ 33997-2016 (с Изменением № 1) — TODO(source-check)';

export interface UserValue { value?: number; min?: number; max?: number; source: string }

function fromUser(name: string, u: UserValue, lo: number, hi: number): ExpertValue {
  const vals = [u.value, u.min, u.max].filter((v): v is number => v !== undefined);
  if (!vals.length) throw new Error(`${name}: нет значения`);
  for (const v of vals) if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${name}: значение вне ${lo}…${hi}`);
  if (!u.source?.trim()) throw new Error(`${name}: нужен источник значения`);
  const value = u.value ?? (u.min !== undefined && u.max !== undefined ? (u.min + u.max) / 2 : vals[0]);
  const min = u.min ?? value, max = u.max ?? value;
  if (min > value || value > max) throw new Error(`${name}: значение вне заданного диапазона`);
  return { value, min, max, origin: 'override', source: u.source, notes: [] };
}

/** t1 from the table if a confirmed value exists, otherwise the user's value (override). */
export function reactionTime(situation: ReactionSituation, user?: UserValue): ExpertValue | { insufficient: string } {
  const row = T1_TABLE.find(r => r.situation === situation)!;
  if (!user) return { insufficient: `t1 «${row.label}»: табличное значение отсутствует (${row.status}); задайте t1 с источником` };
  const v = fromUser('t1', user, 0, 10);
  v.notes.push(`Табличное значение для «${row.label}» отсутствует: ${row.status}. Использовано значение эксперта.`);
  return v;
}

export function brakeTiming(kind: 't2' | 't3', user?: UserValue): ExpertValue | { insufficient: string } {
  if (!user) return { insufficient: `${kind}: табличные значения не подтверждены (TODO(source-check)); задайте ${kind} с источником` };
  const v = fromUser(kind, user, 0, 5);
  v.notes.push('Табличные t2/t3 не подтверждены; использовано значение эксперта.');
  return v;
}

/**
 * Steady deceleration j. User value wins (override). Without it a derived range is
 * offered only when the friction is known: upper bound mu*g (tyre-road limit on a
 * flat road); lower bound the regulatory minimum of a serviceable vehicle of the
 * category if it is below mu*g (applying a 40 km/h test norm to this surface is an
 * explicit assumption). Load effects are not tabulated (no verified data).
 */
export function steadyDeceleration(input: { user?: UserValue; mu?: number; category?: typeof REGULATORY_SERVICE_BRAKE[number]['category']; gravity?: number }): ExpertValue | { insufficient: string } {
  if (input.user) return fromUser('j', input.user, 0.01, 20);
  if (input.mu === undefined) return { insufficient: 'j: нет значения эксперта и не установлен коэффициент сцепления' };
  if (!Number.isFinite(input.mu) || input.mu <= 0 || input.mu > 2) throw new Error('j: неверный μ');
  const g = input.gravity ?? 9.81, upper = input.mu * g;
  const reg = input.category ? REGULATORY_SERVICE_BRAKE.find(r => r.category === input.category) : undefined;
  const lower = reg && reg.steadyDecelMin < upper ? reg.steadyDecelMin : upper;
  return { value: upper, min: lower, max: upper, origin: 'derived',
    source: `Сцепление μ=${input.mu}: j≤μ·g${reg ? `; нижняя граница — ${REGULATORY_SOURCE}` : ''}`,
    notes: ['j выведено из μ, а не из табличной методики; влияние нагрузки и уклона не учтено.',
      ...(reg && reg.steadyDecelMin >= upper ? ['Норматив исправного ТС выше μ·g: ограничивает сцепление, нижняя граница = μ·g.'] : [])] };
}

/** Records when an override replaces an existing table value (none are bundled yet). */
export function deviationNote(name: string, table: number | null, used: ExpertValue): ExpertValue {
  if (table !== null && used.origin === 'override' && used.value !== table) {
    return { ...used, deviation: `${name}: использовано ${used.value} вместо табличного ${table} (${used.source})` };
  }
  return used;
}
