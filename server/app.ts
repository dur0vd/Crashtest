import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { normalizeScene } from '../src/scene';

export interface Mailer {
  sendCode(email: string, code: string): Promise<void>;
}

export interface AppOptions {
  db: DatabaseSync;
  mailer: Mailer;
  now?: () => number;
  /** Разрешённый Origin для CORS (сайт на другом домене или Capacitor); по умолчанию — только свой. */
  allowOrigin?: string;
}

const CODE_TTL = 10 * 60_000;
const RESEND_PAUSE = 60_000;
const MAX_ATTEMPTS = 5;
const SESSION_TTL = 90 * 24 * 3600_000;
const MAX_BODY = 2_000_000;
const MAX_SCENES = 200;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Слишком большой запрос');
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* ниже */ }
  throw new HttpError(400, 'Неверный JSON');
}

/** Обработчик API; сервер собирается отдельно, чтобы тесты работали без сети. */
export function createApp(opts: AppOptions): Server {
  const { db, mailer } = opts;
  const now = opts.now ?? Date.now;

  function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
    res.end(JSON.stringify(body));
  }

  function userOf(req: IncomingMessage): number {
    const m = /^Bearer ([\w-]{20,})$/.exec(req.headers.authorization ?? '');
    const row = m && db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(sha(m[1])) as { user_id: number; expires_at: number } | undefined;
    if (!row || row.expires_at < now()) throw new HttpError(401, 'Нужен вход');
    return row.user_id;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'POST' && path === '/api/auth/request') {
      const email = String((await readJson(req)).email ?? '').trim().toLowerCase();
      if (!EMAIL.test(email)) throw new HttpError(400, 'Неверный адрес почты');
      const prev = db.prepare('SELECT sent_at FROM login_codes WHERE email = ?').get(email) as { sent_at: number } | undefined;
      if (prev && now() - prev.sent_at < RESEND_PAUSE) throw new HttpError(429, 'Код уже отправлен, подождите минуту');
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      db.prepare('INSERT OR REPLACE INTO login_codes (email, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, 0, ?)')
        .run(email, sha(`${email}:${code}`), now() + CODE_TTL, now());
      await mailer.sendCode(email, code);
      return send(res, 200, { ok: true });
    }

    if (method === 'POST' && path === '/api/auth/verify') {
      const body = await readJson(req);
      const email = String(body.email ?? '').trim().toLowerCase();
      const code = String(body.code ?? '').trim();
      const row = db.prepare('SELECT code_hash, expires_at, attempts FROM login_codes WHERE email = ?').get(email) as { code_hash: string; expires_at: number; attempts: number } | undefined;
      if (!row || row.expires_at < now() || row.attempts >= MAX_ATTEMPTS) throw new HttpError(400, 'Код недействителен, запросите новый');
      const given = Buffer.from(sha(`${email}:${code}`));
      if (!timingSafeEqual(given, Buffer.from(row.code_hash))) {
        db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?').run(email);
        throw new HttpError(400, 'Неверный код');
      }
      db.prepare('DELETE FROM login_codes WHERE email = ?').run(email);
      db.prepare('INSERT OR IGNORE INTO users (email, created_at) VALUES (?, ?)').run(email, now());
      const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number };
      const token = randomBytes(32).toString('base64url');
      db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha(token), user.id, now() + SESSION_TTL);
      return send(res, 200, { token, email });
    }

    if (method === 'POST' && path === '/api/auth/logout') {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
      if (m) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(m[1]));
      return send(res, 200, { ok: true });
    }

    // Удаление аккаунта вместе со всеми сценами и сессиями (152-ФЗ: право на удаление).
    if (method === 'DELETE' && path === '/api/account') {
      db.prepare('DELETE FROM users WHERE id = ?').run(userOf(req));
      return send(res, 200, { ok: true });
    }

    if (method === 'GET' && path === '/api/scenes') {
      const rows = db.prepare('SELECT id, name, updated_at AS updatedAt FROM scenes WHERE user_id = ? ORDER BY updated_at DESC').all(userOf(req));
      return send(res, 200, { scenes: rows });
    }

    if (method === 'POST' && path === '/api/scenes') {
      const uid = userOf(req);
      const count = (db.prepare('SELECT COUNT(*) AS n FROM scenes WHERE user_id = ?').get(uid) as { n: number }).n;
      if (count >= MAX_SCENES) throw new HttpError(403, 'Достигнут лимит сохранённых ситуаций');
      const scene = parseScene(await readJson(req));
      const id = randomUUID();
      const t = now();
      db.prepare('INSERT INTO scenes (id, user_id, name, data, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, uid, scene.name, JSON.stringify(scene), t);
      return send(res, 201, { id, updatedAt: t });
    }

    const one = /^\/api\/scenes\/([\w-]{36})$/.exec(path);
    if (one) {
      const uid = userOf(req);
      const row = db.prepare('SELECT data, updated_at FROM scenes WHERE id = ? AND user_id = ?').get(one[1], uid) as { data: string; updated_at: number } | undefined;
      if (!row) throw new HttpError(404, 'Ситуация не найдена');
      if (method === 'GET') return send(res, 200, { id: one[1], updatedAt: row.updated_at, scene: JSON.parse(row.data) });
      if (method === 'DELETE') {
        db.prepare('DELETE FROM scenes WHERE id = ?').run(one[1]);
        return send(res, 200, { ok: true });
      }
      if (method === 'PUT') {
        // Оптимистичная блокировка: клиент присылает updatedAt, который видел последним.
        const body = await readJson(req);
        if (body.baseUpdatedAt !== row.updated_at) {
          return send(res, 409, { error: 'Ситуация изменена на другом устройстве', updatedAt: row.updated_at, scene: JSON.parse(row.data) });
        }
        const scene = parseScene(body);
        const t = Math.max(now(), row.updated_at + 1);
        db.prepare('UPDATE scenes SET name = ?, data = ?, updated_at = ? WHERE id = ?').run(scene.name, JSON.stringify(scene), t, one[1]);
        return send(res, 200, { id: one[1], updatedAt: t });
      }
    }

    throw new HttpError(404, 'Нет такого метода');
  }

  const server = createServer((req, res) => {
    if (opts.allowOrigin) {
      res.setHeader('access-control-allow-origin', opts.allowOrigin);
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    }
    route(req, res).catch((e: unknown) => {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      send(res, 500, { error: 'Внутренняя ошибка' });
    });
  });
  return server;
}

function parseScene(body: Record<string, unknown>) {
  try {
    return normalizeScene(body.scene);
  } catch {
    throw new HttpError(400, 'Неверный формат ситуации');
  }
}
