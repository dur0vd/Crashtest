import type { FeatureIssue, JsonObject, JsonValue } from '../parallel/contracts';

export type Known = boolean | null;
export const all = (...facts: (Known | undefined)[]): Known => facts.includes(false) ? false : facts.some(f => f == null) ? null : true;
export const any = (...facts: (Known | undefined)[]): Known => facts.includes(true) ? true : facts.some(f => f == null) ? null : false;
export const not = (fact: Known | undefined): Known => fact == null ? null : !fact;
export const object = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
export const bool = (value: unknown): Known => typeof value === 'boolean' ? value : null;
export const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export const pointer = (value: string): string => value.replace(/~/g, '~0').replace(/\//g, '~1');
export const compliance = (state: Known) => state === true ? 'выполнено' as const : state === false ? 'не выполнено' as const : 'не определить' as const;
export const severity = (state: Known) => state === true ? 'info' as const : state === false ? 'violation' as const : 'contributing' as const;

/** Undefined is not JSON. Keep report traces portable without changing their
 * established technical meanings or substituting zero for missing numbers. */
export function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, v: unknown) => v === undefined || typeof v === 'number' && !Number.isFinite(v) ? null : v)) as T;
}

export function validateFields(value: JsonObject, path: string, booleans: readonly string[], numbers: readonly string[], enums: Record<string, readonly string[]> = {}): FeatureIssue[] {
  const issues: FeatureIssue[] = [];
  for (const [key, v] of Object.entries(value)) {
    if (v === null) continue; // Explicit unknown is a supported JSON representation.
    const invalid = booleans.includes(key) ? typeof v !== 'boolean' : numbers.includes(key) ? number(v) === null
      : enums[key] ? typeof v !== 'string' || !enums[key].includes(v) : false;
    if (invalid) issues.push({ code: 'rules.invalid-fact', path: `${path}/${pointer(key)}`, message: `Недопустимое значение ${key}; требуется исправление исходного факта.` });
  }
  return issues;
}
export function isObject(value: JsonValue | undefined): boolean { return value != null && typeof value === 'object' && !Array.isArray(value); }
