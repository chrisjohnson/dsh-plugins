// The v4 migration is the one that touches live data: it renames the column
// set in place and must never lose a ticket, an event or a span. These tests
// build a v3 database the way the old plugin did, fill it with rows in every
// retired column, and check the rewrite maps them and keeps the children.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { MIGRATIONS, SCHEMA_VERSION } from '../src/schema.mjs'
import { migrate, openDatabase } from '../src/db.mjs'

/** Apply only the first `upTo` migrations, the way db.mjs does. */
function applyUpTo(db, upTo) {
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);')
  for (const migration of MIGRATIONS) {
    if (migration.version > upTo) continue
    if (migration.before) db.exec(migration.before)
    let failure = null
    db.exec('BEGIN IMMEDIATE;')
    try {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, new Date().toISOString())
      db.exec('COMMIT;')
    } catch (error) {
      failure = error
      db.exec('ROLLBACK;')
    }
    if (migration.after) db.exec(migration.after)
    if (failure !== null) throw failure
  }
}

function v3Database() {
  const db = new DatabaseSync(':memory:')
  applyUpTo(db, 3)
  const at = new Date().toISOString()
  const insert = db.prepare(
    `INSERT INTO tickets (id, key, title, body, col, phase, plan_timing, plan_questions, priority, sort_order,
       allow_paid, budget_usd, spent_usd, attempt_count, escalation_rung, workspace_cwd,
       needs_attention_reason, confidence_threshold, created_at, updated_at, version)
     VALUES (?, ?, ?, '', ?, ?, 'at_pickup', 'interactive', 0, 0, 0, 0, 0, 0, 0, NULL, ?, NULL, ?, ?, 1)`,
  )
  insert.run('id-now', 'KAN-1', 'in flight', 'now', 'implement', null, at, at)
  insert.run('id-attn', 'KAN-2', 'parked', 'needs_attention', 'implement', 'turn failed in implement: boom', at, at)
  insert.run('id-blocked', 'KAN-3', 'blocked', 'blocked', 'plan', null, at, at)
  insert.run('id-done', 'KAN-4', 'done', 'done', 'closed', null, at, at)
  db.prepare('INSERT INTO events (ticket_id, at, kind, actor, payload_json) VALUES (?, ?, ?, ?, ?)').run('id-now', at, 'created', 'human', '{}')
  db.prepare('INSERT INTO spans (id, ticket_id, kind, name, started_at, status) VALUES (?, ?, ?, ?, ?, ?)').run('span-1', 'id-attn', 'agent', 'implement', at, 'ok')
  return db
}

test('v4 maps the retired columns and keeps every row and child', () => {
  const db = v3Database()
  assert.equal(migrate(db), SCHEMA_VERSION)
  const cols = Object.fromEntries(db.prepare('SELECT key, col FROM tickets').all().map((row) => [row.key, row.col]))
  assert.equal(cols['KAN-1'], 'working')
  assert.equal(cols['KAN-2'], 'backlog')
  assert.equal(cols['KAN-3'], 'backlog')
  assert.equal(cols['KAN-4'], 'done')
  // the parked ticket keeps its reason: the card still glows in Backlog
  const reason = db.prepare('SELECT needs_attention_reason AS r FROM tickets WHERE key = ?').get('KAN-2').r
  assert.equal(reason, 'turn failed in implement: boom')
  // children survive: the rewrite must not fire the ON DELETE CASCADEs
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM spans').get().n, 1)
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0)
  assert.equal(db.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get().version, 4)
  // the new CHECK constraint rejects the retired columns
  assert.throws(
    () => db.prepare("INSERT INTO tickets (id, key, title, col, phase, plan_timing, plan_questions, created_at, updated_at) VALUES ('x', 'KAN-9', 'x', 'now', 'plan', 'at_pickup', 'interactive', 'a', 'a')").run(),
    /CHECK constraint failed/,
  )
  // foreign keys are back on after the migration
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
})

test('a fresh database lands on v4 directly', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'kanban-schema-')), 'k.db')
  const db = openDatabase(path)
  assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 4)
  db.close()
})
