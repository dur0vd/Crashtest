/** Lossless finite JSON numbers (ECMAScript shortest round-trip decimal); -0 → 0.
 * No decimal truncation: measured inputs retain every representable significant digit.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('JSON: нечисло или бесконечность');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value))
    return (
      '[' +
      Array.from({ length: value.length }, (_, i) => canonical(value[i])).join(
        ',',
      ) +
      ']'
    );
  if (
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return (
      '{' +
      Object.keys(value as object)
        .sort()
        .map((k) => {
          if (['__proto__', 'prototype', 'constructor'].includes(k))
            throw new Error('Недопустимый ключ JSON');
          return (
            JSON.stringify(k) +
            ':' +
            canonical((value as Record<string, unknown>)[k])
          );
        })
        .join(',') +
      '}'
    );
  }
  throw new Error('Требуется JSON без undefined, Map и бинарных массивов');
}
export const utf8 = (s: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(s);
export async function sha256(data: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
/** Explicit bridge for port outputs; never used to canonicalize original inputs. */
export function resultJSON(value: unknown): unknown {
  if (value instanceof Map)
    return Object.fromEntries([...value].map(([k, v]) => [k, resultJSON(v)]));
  if (ArrayBuffer.isView(value))
    return Array.from(value as unknown as ArrayLike<number>);
  if (Array.isArray(value)) return value.map(resultJSON);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, resultJSON(v)]),
    );
  return value;
}
