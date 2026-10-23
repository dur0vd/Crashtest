import type { CalculationRecord, FeatureIssue, InputDescriptor, JsonObject, JsonValue } from '../../parallel/contracts';

/** A calculator input: number, or a value with range and source. */
export interface RangeInput { value: number; min: number; max: number; source?: string }

export interface CalcSpec {
  key: string;
  label: string;
  unit?: string;
  kind: 'number' | 'range' | 'enum' | 'boolean' | 'vector';
  required: boolean;
  choices?: string[];
  minimum?: number;
  maximum?: number;
}

export type CalcResult =
  | { status: 'ok'; records: CalculationRecord[]; issues: FeatureIssue[] }
  | { status: 'insufficient-data' | 'unsupported' | 'error'; issues: FeatureIssue[] };

export interface Calculator {
  id: string;
  title: string;
  inputs: CalcSpec[];
  run(params: JsonObject): CalcResult;
}

export class MissingInput extends Error {
  constructor(readonly keys: string[]) { super(`Нет обязательных входов: ${keys.join(', ')}`); }
}

const isObj = (v: JsonValue | undefined): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);

/** Number or {value,min?,max?,source?}; validates bounds. */
export function readRange(params: JsonObject, key: string, lo = -Infinity, hi = Infinity): RangeInput {
  const raw = params[key];
  let r: RangeInput;
  if (typeof raw === 'number') r = { value: raw, min: raw, max: raw };
  else if (isObj(raw) && typeof raw.value === 'number') {
    r = { value: raw.value, min: typeof raw.min === 'number' ? raw.min : raw.value, max: typeof raw.max === 'number' ? raw.max : raw.value,
      ...(typeof raw.source === 'string' ? { source: raw.source } : {}) };
  } else throw new MissingInput([key]);
  for (const v of [r.value, r.min, r.max]) if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${key}: значение вне ${lo}…${hi}`);
  if (r.min > r.value || r.value > r.max) throw new Error(`${key}: значение вне диапазона min…max`);
  return r;
}

export function readNumber(params: JsonObject, key: string, lo = -Infinity, hi = Infinity): number {
  const raw = params[key];
  if (typeof raw !== 'number') throw new MissingInput([key]);
  if (!Number.isFinite(raw) || raw < lo || raw > hi) throw new Error(`${key}: значение вне ${lo}…${hi}`);
  return raw;
}

export function optionalNumber(params: JsonObject, key: string, lo = -Infinity, hi = Infinity): number | undefined {
  return params[key] === undefined ? undefined : readNumber(params, key, lo, hi);
}

/** Checks required keys first so the caller gets the complete list of missing inputs. */
export function guard(spec: CalcSpec[], params: JsonObject, body: () => CalculationRecord[]): CalcResult {
  const missing = spec.filter(s => s.required && params[s.key] === undefined).map(s => s.key);
  if (missing.length) return { status: 'insufficient-data', issues: missing.map(k => ({ code: 'missing-input', message: `Нет обязательного входа ${k}`, path: k })) };
  try {
    return { status: 'ok', records: body(), issues: [] };
  } catch (error) {
    if (error instanceof MissingInput) return { status: 'insufficient-data', issues: error.keys.map(k => ({ code: 'missing-input', message: `Нет обязательного входа ${k}`, path: k })) };
    return { status: 'error', issues: [{ code: 'invalid-input', message: error instanceof Error ? error.message : String(error) }] };
  }
}

/** Evaluate f at all combinations of range ends (monotone or not) and return min/max. */
export function rangeOf(f: (...xs: number[]) => number | null, ...ranges: RangeInput[]): { min: number; max: number } | null {
  const vals: number[] = [];
  const rec = (i: number, acc: number[]) => {
    if (i === ranges.length) { const v = f(...acc); if (v !== null && Number.isFinite(v)) vals.push(v); return; }
    for (const x of new Set([ranges[i].min, ranges[i].value, ranges[i].max])) rec(i + 1, [...acc, x]);
  };
  rec(0, []);
  return vals.length ? { min: Math.min(...vals), max: Math.max(...vals) } : null;
}

export const fmt = (x: number, d = 3) => String(Math.round(x * 10 ** d) / 10 ** d).replace('.', ',');

export function toDescriptors(spec: CalcSpec[], base: string): InputDescriptor[] {
  return spec.map(s => ({
    path: `${base}/${s.key}`, label: s.label, kind: s.kind === 'range' || s.kind === 'vector' ? 'number' : s.kind === 'enum' ? 'enum' : s.kind,
    ...(s.unit ? { unit: s.unit } : {}), required: s.required,
    ...(s.choices ? { choices: s.choices.map(c => ({ value: c, label: c })) } : {}),
    ...(s.minimum !== undefined ? { minimum: s.minimum } : {}), ...(s.maximum !== undefined ? { maximum: s.maximum } : {}),
  }));
}

export function sourcesOf(...rs: (RangeInput | undefined)[]): string[] {
  return [...new Set(rs.flatMap(r => r?.source ? [r.source] : []))];
}
