// Подписка и пробный режим. Без DOM: проверка кода, учёт пробных моделей, состояние доступа.
//
// Код активации: «CT1.<данные>.<подпись>» (base64url). Данные — JSON с тарифом, названием,
// сроком действия и номером кода; подпись — ECDSA P-256/SHA-256 закрытым ключом правообладателя
// (tools/issue-code.mjs). Приложение хранит только открытые ключи и проверяет код без сервера.

import { COLLECTIONS, type Scene } from './scene';

export type Plan = 'personal' | 'school';

export interface License {
  /** Тариф: личная подписка или автошкола. */
  plan: Plan;
  /** Кому выдан код: имя или название автошколы (показывается в приложении). */
  name: string;
  /** Последний день действия включительно, ГГГГ-ММ-ДД. */
  until: string;
  /** Номер кода — для учёта выданных кодов. */
  id: string;
}

/** Сколько разных моделей можно запустить без подписки. */
export const FREE_MODELS = 5;

const b64urlBytes = (s: string): Uint8Array => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

/** Разбирает и проверяет код. Возвращает лицензию или текст ошибки для пользователя. */
export async function verifyCode(code: string, keys: JsonWebKey[], today: string): Promise<License | string> {
  const parts = code.trim().replace(/\s+/g, '').split('.');
  if (parts.length !== 3 || parts[0] !== 'CT1') return 'Это не код активации Crashtest. Проверьте, что код скопирован целиком.';
  let data: Partial<License>;
  let payload: Uint8Array;
  let signature: Uint8Array;
  try {
    payload = b64urlBytes(parts[1]);
    signature = b64urlBytes(parts[2]);
    data = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return 'Код повреждён. Скопируйте его ещё раз целиком.';
  }
  let valid = false;
  for (const jwk of keys) {
    try {
      const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      if (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature as BufferSource, new TextEncoder().encode(parts[1]) as BufferSource)) {
        valid = true;
        break;
      }
    } catch {
      /* ключ другого формата — пробуем следующий */
    }
  }
  if (!valid) return 'Код не подтверждён. Проверьте, что он скопирован без изменений.';
  if ((data.plan !== 'personal' && data.plan !== 'school') || typeof data.until !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.until)) {
    return 'Код выпущен для другой версии приложения. Обновите приложение.';
  }
  const license: License = { plan: data.plan, name: String(data.name ?? ''), until: data.until, id: String(data.id ?? '') };
  if (license.until < today) return `Срок действия кода истёк ${formatDate(license.until)}.`;
  return license;
}

export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

export function todayIso(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * Ключ модели для пробного режима: состав сцены (идентификаторы объектов и типы участников).
 * Перемещение, скорости и траектории не меняют ключ — подбор одной ситуации не тратит попытки.
 */
export function modelKey(scene: Scene): string {
  const ids: string[] = [];
  for (const c of COLLECTIONS) for (const item of scene[c] as { id: string; type?: string }[]) ids.push(`${c}:${item.id}:${item.type ?? ''}`);
  ids.sort();
  let h = 0x811c9dc5;
  for (const ch of ids.join('|')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export interface TrialState {
  /** Ключи уже запущенных моделей. */
  used: string[];
}

/** Можно ли запустить модель: подписка активна, модель уже запускалась или пробный лимит не исчерпан. */
export function canRun(trial: TrialState, key: string, license: License | null, today: string): boolean {
  if (license && license.until >= today) return true;
  return trial.used.includes(key) || trial.used.length < FREE_MODELS;
}

/** Отмечает запуск модели в пробном режиме. */
export function markRun(trial: TrialState, key: string): TrialState {
  return trial.used.includes(key) ? trial : { used: [...trial.used, key] };
}
