import type {
  ProjectEnvelope,
  JsonValue,
  InputDescriptor,
} from '../parallel/contracts';
export function pointerParts(path: string): string[] {
  if (!path.startsWith('/')) throw new Error('Нужен RFC6901 pointer');
  const parts = path
    .slice(1)
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (parts.some((k) => ['__proto__', 'prototype', 'constructor'].includes(k)))
    throw new Error('Запрещённый путь');
  if (
    !['scene', 'extensions', 'evidence'].includes(parts[0]) ||
    (parts[0] === 'extensions' &&
      !['physics', 'rules', 'workspace'].includes(parts[1]))
  )
    throw new Error('Путь вне контракта ProjectEnvelope');
  return parts;
}
export function readPointer(
  project: ProjectEnvelope,
  path: string,
): JsonValue | undefined {
  return pointerParts(path).reduce<any>((o, k) => o?.[k], project);
}
export function writePointer(
  project: ProjectEnvelope,
  path: string,
  value: JsonValue | undefined,
): ProjectEnvelope {
  const out = structuredClone(project),
    parts = pointerParts(path);
  let cursor: any = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cursor[k] === undefined)
      cursor[k] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    if (!cursor[k] || typeof cursor[k] !== 'object')
      throw new Error('Путь проходит через скаляр');
    cursor = cursor[k];
  }
  const last = parts.at(-1)!;
  if (value === undefined) {
    if (Array.isArray(cursor))
      throw new Error('Неизвестное значение массива задаётся null');
    delete cursor[last];
  } else cursor[last] = value;
  return out;
}
export function validateInput(
  d: InputDescriptor,
  text: string,
): JsonValue | undefined {
  if (text === '') return undefined;
  if (d.kind === 'number') {
    const n = Number(text);
    if (
      !Number.isFinite(n) ||
      (d.minimum !== undefined && n < d.minimum) ||
      (d.maximum !== undefined && n > d.maximum)
    )
      throw new Error('Число вне допустимого диапазона');
    return n;
  }
  if (d.kind === 'boolean') {
    if (!['true', 'false'].includes(text)) throw new Error('Состояние факта');
    return text === 'true';
  }
  if (d.kind === 'geometry') return JSON.parse(text);
  if (d.kind === 'enum' && !d.choices?.some((c) => c.value === text))
    throw new Error('Неизвестный вариант');
  return text;
}
