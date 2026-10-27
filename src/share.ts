import { normalizeScene, type Scene } from './scene';

/** Совместимый с прежними ссылками UTF-8 JSON в base64url. Модуль не требует DOM. */
export function encodeShare(scene: Scene): string {
  const bytes = new TextEncoder().encode(JSON.stringify(scene));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeShare(encoded: string): Scene {
  if (!/^[\w-]+$/.test(encoded) || encoded.length % 4 === 1) throw new Error('Повреждённая ссылка');
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - b64.length % 4) % 4));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return normalizeScene(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}

/** Плохая ссылка не мешает загрузить сохранение или стартовый пример. */
export function sceneFromHash(hash: string): Scene | null {
  const match = /^#s=([^&]+)$/.exec(hash);
  if (!match) return null;
  try { return decodeShare(match[1]); } catch { return null; }
}
