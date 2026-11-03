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
  assert.equal(db.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get().version, SCHEMA_VERSION)
  // the new CHECK constraint rejects the retired columns
  assert.throws(
    () => db.prepare("INSERT INTO tickets (id, key, title, col, phase, plan_timing, plan_questions, created_at, updated_at) VALUES ('x', 'KAN-9', 'x', 'now', 'plan', 'at_pickup', 'interactive', 'a', 'a')").run(),
    /CHECK constraint failed/,
  )
  // foreign keys are back on after the migration
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
})

test('a fresh database lands on the current schema version directly', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'kanban-schema-')), 'k.db')
  const db = openDatabase(path)
  assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, SCHEMA_VERSION)
  db.close()
})

// ---------------------------------------------------------------- KAN-15 v5

test('v5 adds nullable preset and write_mode; migrated rows keep NULL', () => {
  const db = v3Database()
  assert.equal(migrate(db), SCHEMA_VERSION)
  const columns = db.prepare('PRAGMA table_info(tickets)').all().map((row) => row.name)
  assert.ok(columns.includes('preset'), 'tickets.preset exists')
  assert.ok(columns.includes('write_mode'), 'tickets.write_mode exists')
  // Every pre-existing row reads NULL: unchanged behavior, no backfill.
  for (const row of db.prepare('SELECT preset, write_mode FROM tickets').all()) {
    assert.equal(row.preset, null)
    assert.equal(row.write_mode, null)
  }
})

// ---------------------------------------------------------------- KAN-18 v6

test('v6 adds tickets.worktree and every pre-existing row reads 0', () => {
  const db = v3Database()
  assert.equal(migrate(db), SCHEMA_VERSION)
  const column = db.prepare('PRAGMA table_info(tickets)').all().find((row) => row.name === 'worktree')
  assert.ok(column, 'tickets.worktree exists')
  assert.equal(column.notnull, 1, 'NOT NULL')
  assert.equal(String(column.dflt_value), '0', 'DEFAULT 0')
  // Existing rows are untouched and keep their workspace_cwd: a pre-created
  // working copy stays exactly where it was, and 0 means "nothing was asked for".
  const rows = db.prepare('SELECT key, worktree, workspace_cwd FROM tickets ORDER BY key').all()
  assert.equal(rows.length, 4)
  for (const row of rows) assert.equal(row.worktree, 0)
  db.prepare("UPDATE tickets SET workspace_cwd = '/somewhere/managed' WHERE key = 'KAN-1'").run()
  assert.equal(db.prepare("SELECT workspace_cwd AS c FROM tickets WHERE key = 'KAN-1'").get().c, '/somewhere/managed')
})

test('v6 worktree CHECK accepts 0 and 1 and rejects anything else', () => {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const at = new Date().toISOString()
  const insert = (value) =>
    db.prepare(
      `INSERT INTO tickets (id, key, title, col, phase, plan_timing, plan_questions, created_at, updated_at, worktree)
       VALUES (?, ?, 't', 'backlog', 'plan', 'at_pickup', 'interactive', ?, ?, ?)`,
    ).run(`id-wt-${value}`, `KAN-WT-${value}`, at, at, value)
  insert(0)
  insert(1)
  assert.throws(() => insert(2), /CHECK constraint failed/)
  assert.throws(() => insert(null), /CHECK constraint failed|NOT NULL constraint failed/)
})

test('v5 write_mode CHECK accepts the closed vocabulary and rejects anything else', () => {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const at = new Date().toISOString()
  const insert = (mode) =>
    db.prepare(
      `INSERT INTO tickets (id, key, title, col, phase, plan_timing, plan_questions, created_at, updated_at, write_mode)
       VALUES (?, ?, 't', 'backlog', 'plan', 'at_pickup', 'interactive', ?, ?, ?)`,
    ).run(`id-${mode ?? 'null'}`, `KAN-W-${mode ?? 'null'}`, at, at, mode)
  for (const mode of ['read-only', 'workspace-write', 'danger-full-access', null]) {
    insert(mode)
  }
  assert.throws(() => insert('full-access'), /CHECK constraint failed/)
  assert.throws(() => insert('WRITE'), /CHECK constraint failed/)
})

test('v6 on a v5 fixture: existing rows gain worktree 0 and keep their workspace_cwd', () => {
  const db = new DatabaseSync(':memory:')
  applyUpTo(db, 5)
  const at = new Date().toISOString()
  db.prepare(
    `INSERT INTO tickets (id, key, title, col, phase, plan_timing, plan_questions, created_at, updated_at, workspace_cwd, preset, write_mode)
     VALUES ('id-legacy', 'KAN-18', 'lazy worktree', 'working', 'plan', 'at_pickup', 'interactive', ?, ?, '/home/me/.dsh-worktrees/brave-forge', 'standard', 'workspace-write')`,
  ).run(at, at)
  assert.equal(migrate(db), SCHEMA_VERSION)
  const row = db.prepare("SELECT worktree, workspace_cwd, preset, write_mode FROM tickets WHERE key = 'KAN-18'").get()
  assert.equal(row.worktree, 0, 'an eager-era row records no new intent')
  assert.equal(row.workspace_cwd, '/home/me/.dsh-worktrees/brave-forge', 'and keeps the copy it already points at')
  assert.equal(row.preset, 'standard')
  assert.equal(row.write_mode, 'workspace-write')
})

// ---------------------------------------------------------------- KAN-31 v7

test('v7 applies to a v6 database and every pre-existing condition reads not-deferred', () => {
  const db = new DatabaseSync(':memory:')
  applyUpTo(db, 6)
  const at = new Date().toISOString()
  db.prepare(
    `INSERT INTO tickets (id, key, title, col, phase, plan_timing, plan_questions, created_at, updated_at)
     VALUES ('id-v6', 'KAN-31', 'deferred gate', 'working', 'implement', 'at_pickup', 'interactive', ?, ?)`,
  ).run(at, at)
  db.prepare(
    `INSERT INTO conditions (ticket_id, plan_version, ordinal, condition_id, statement, how_verified, source, created_at)
     VALUES ('id-v6', 1, 1, 'unit-tests', 'the suites pass', 'node --test', 'plan', ?)`,
  ).run(at)
  assert.equal(migrate(db), SCHEMA_VERSION)
  const columns = db.prepare('PRAGMA table_info(conditions)').all().map((row) => row.name)
  assert.ok(columns.includes('deferred'), 'conditions.deferred exists')
  assert.ok(columns.includes('human_evidence'), 'conditions.human_evidence exists')
  // The additive ALTERs backfill, they do not reinterpret: a condition written
  // before 0.17.0 was never deferred and must not start riding to approval.
  const row = db.prepare("SELECT deferred, human_evidence FROM conditions WHERE condition_id = 'unit-tests'").get()
  assert.equal(row.deferred, 0)
  assert.equal(row.human_evidence, '')
  // Nothing else about the row moved.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conditions').get().n, 1)
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0)
})

test('v7 deferred CHECK accepts 0 and 1 and rejects anything else', () => {
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const at = new Date().toISOString()
  db.prepare(
    `INSERT INTO tickets (id, key, title, col, phase, plan_timing, plan_questions, created_at, updated_at)
     VALUES ('id-v7', 'KAN-32', 'v7 check', 'working', 'implement', 'at_pickup', 'interactive', ?, ?)`,
  ).run(at, at)
  const insert = (value, evidence = '') =>
    db.prepare(
      `INSERT INTO conditions (ticket_id, plan_version, ordinal, condition_id, statement, how_verified, source, created_at, deferred, human_evidence)
       VALUES ('id-v7', 1, ?, ?, 's', 'v', 'plan', ?, ?, ?)`,
    ).run(value, `c-${value}-${evidence.length}`, at, value, evidence)
  insert(0)
  insert(1, 'git ls-remote prints a sha')
  assert.throws(() => insert(2), /CHECK constraint failed/)
  // NOT NULL: a deferred flag that is not there is 0, never missing.
  assert.throws(() => insert(null), /CHECK constraint failed|NOT NULL constraint failed/)
})
