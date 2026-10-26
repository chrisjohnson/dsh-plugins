// dsh-kanban: SQLite connection and migration runner.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { MIGRATIONS, SCHEMA_VERSION } from './schema.mjs';

/**
 * Open (and migrate) the board database.
 *
 * WAL keeps a reader (the UI) from blocking the engine's writes; an explicit
 * busy timeout means a concurrent reader waits instead of failing. Every write
 * in the store runs in `BEGIN IMMEDIATE`, which is what turns "read, decide,
 * write" into one serialized transition.
 *
 * @param {string} path absolute database path.
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  migrate(db);
  return db;
}

export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);');
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
  const current = row === undefined || row.version === null ? 0 : Number(row.version);
  if (current > SCHEMA_VERSION) {
    throw new Error(`kanban database schema ${current} is newer than this plugin (${SCHEMA_VERSION}); upgrade dsh-kanban`);
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, new Date().toISOString());
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
  }
  return SCHEMA_VERSION;
}
