import { DatabaseSync } from 'node:sqlite';

/** Схема создаётся при открытии базы; `:memory:` используется в тестах. */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      consent_at INTEGER,
      last_seen INTEGER
    );
    CREATE TABLE IF NOT EXISTS login_codes (
      email TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      sent_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scenes (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scenes_user ON scenes(user_id, updated_at DESC);
  `);
  // База, созданная до появления согласия и срока хранения.
  const cols = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map(c => c.name);
  if (!cols.includes('consent_at')) db.exec('ALTER TABLE users ADD COLUMN consent_at INTEGER');
  if (!cols.includes('last_seen')) db.exec('ALTER TABLE users ADD COLUMN last_seen INTEGER');
  return db;
}

/** Срок хранения неактивных аккаунтов (политика конфиденциальности): 24 месяца без входа. */
export const RETENTION_MS = 730 * 24 * 3600_000;

/** Удаляет аккаунты без входа дольше срока хранения вместе со сценами и сессиями; возвращает их число. */
export function purgeInactive(db: DatabaseSync, now: number): number {
  const r = db.prepare('DELETE FROM users WHERE COALESCE(last_seen, created_at) < ?').run(now - RETENTION_MS);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM login_codes WHERE expires_at < ?').run(now);
  return Number(r.changes);
}
