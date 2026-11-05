// dsh-kanban: the store. Every ticket-state mutation in the engine flows
// through this file, inside BEGIN IMMEDIATE, bumping the row version and
// publishing a post-commit event.
//
// There are no config tables here on purpose: providers, roles, prompts and
// limits are YAML (src/config.mjs); this database records what is true. The one
// exception is `runtime_state` (v8): a switch a *person* flips from the board —
// the orchestrator pause, the WIP cap — which is not configuration they should
// have to edit a file and restart for, and which has to survive a restart.

import { randomUUID } from 'node:crypto';

import { assertTransition, compareQueue, validateTicketModes } from './lifecycle.mjs';
import { isWipQueuePark, WIP_QUEUE_PREFIX } from './wip.mjs';

export class StoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.details = details;
  }
}

export const nowIso = () => new Date().toISOString();

/** The closed DSH sandbox vocabulary a ticket may choose as its build write mode. */
export const WRITE_MODES = ['read-only', 'workspace-write', 'danger-full-access'];

/** Normalize a ticket's optional preset id: a non-empty string or null (harness default). */
export function normalizePreset(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StoreError('bad_request', 'preset must be a non-empty string or null');
  }
  return value.trim();
}

/** Normalize a ticket's optional build write mode: a vocabulary member or null (purpose default). */
export function normalizeWriteMode(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !WRITE_MODES.includes(value)) {
    throw new StoreError('bad_request', `writeMode must be one of ${WRITE_MODES.join(', ')} or null`, { writeMode: value });
  }
  return value;
}

/** The event kinds the board's derived facts (phase path, working time) read. */
const BOARD_EVENT_KINDS = [
  'phase_changed',
  'column_changed',
  'needs_attention',
  'attention_cleared',
  'session_reactivated',
  'human_wait_started',
  'human_wait_ended',
];

/** Every tickets column except the body (see listTickets). */
const TICKET_SUMMARY_COLUMNS = [
  'id', 'key', 'title', 'col', 'phase', 'plan_timing', 'plan_questions', 'priority', 'sort_order', 'allow_paid',
  'budget_usd', 'spent_usd', 'attempt_count', 'escalation_rung', 'workspace_cwd', 'preset', 'write_mode', 'worktree',
  'needs_attention_reason', 'confidence_threshold', 'created_at', 'updated_at', 'closed_at', 'version',
].join(', ');

const TICKET_FIELDS = [
  'title',
  'body',
  'priority',
  'sortOrder',
  'allowPaid',
  'budgetUsd',
  'workspaceCwd',
  'confidenceThreshold',
  'planTiming',
  'planQuestions',
  'preset',
  'writeMode',
  // KAN-18: the recorded *intent* to work in a git worktree. The copy itself is
  // created when planning starts, not when the ticket is made.
  'worktree',
];

function ticketFromRow(row) {
  if (row === undefined) return undefined;
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    body: row.body,
    column: row.col,
    phase: row.phase,
    planTiming: row.plan_timing,
    planQuestions: row.plan_questions,
    priority: Number(row.priority),
    sortOrder: Number(row.sort_order),
    allowPaid: Number(row.allow_paid) === 1,
    budgetUsd: Number(row.budget_usd),
    spentUsd: Number(row.spent_usd),
    attemptCount: Number(row.attempt_count),
    escalationRung: Number(row.escalation_rung),
    workspaceCwd: row.workspace_cwd,
    preset: row.preset ?? null,
    writeMode: row.write_mode ?? null,
    worktree: Number(row.worktree) === 1,
    needsAttentionReason: row.needs_attention_reason,
    confidenceThreshold: row.confidence_threshold === null ? null : Number(row.confidence_threshold),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    version: Number(row.version),
  };
}

function eventFromRow(row) {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    at: row.at,
    kind: row.kind,
    phaseFrom: row.phase_from,
    phaseTo: row.phase_to,
    actor: row.actor,
    payload: safeParse(row.payload_json, {}),
  };
}

function spanFromRow(row) {
  if (row === undefined) return undefined;
  return {
    id: row.id,
    ticketId: row.ticket_id,
    runId: row.run_id,
    parentSpanId: row.parent_span_id,
    kind: row.kind,
    name: row.name,
    role: row.role,
    sessionId: row.session_id,
    provider: row.provider,
    model: row.model,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    status: row.status,
    attempt: Number(row.attempt),
    error: row.error,
    promptHash: row.prompt_hash,
  };
}

function safeParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export class KanbanStore {
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {{onEvent?: (event: object) => void}} [options]
   */
  constructor(db, options = {}) {
    this.db = db;
    this.onEvent = options.onEvent ?? (() => {});
    this.pendingEvents = [];
    this.closed = false;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** Run one mutation atomically and publish its events only after commit. */
  transact(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      const events = this.pendingEvents;
      this.pendingEvents = [];
      for (const event of events) {
        try {
          this.onEvent(event);
        } catch {
          // A listener must never roll back committed state.
        }
      }
      return result;
    } catch (error) {
      this.pendingEvents = [];
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The transaction may already be gone; the original error is the useful one.
      }
      throw error;
    }
  }

  #event(ticketId, kind, { phaseFrom = null, phaseTo = null, actor = 'engine', payload = {} } = {}) {
    const at = nowIso();
    this.db
      .prepare('INSERT INTO events (ticket_id, at, kind, phase_from, phase_to, actor, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ticketId, at, kind, phaseFrom, phaseTo, actor, JSON.stringify(payload ?? {}));
    const event = { ticketId, at, kind, phaseFrom, phaseTo, actor, payload: payload ?? {} };
    this.pendingEvents.push(event);
    return event;
  }

  /** Public event append used by the engine's non-ticket state transitions. */
  appendEvent(ticketId, kind, options = {}) {
    return this.#event(ticketId, kind, options);
  }

  // ---------------------------------------------------------------- tickets

  /**
   * File a new ticket. `options.actor` is who the `created` event records: the
   * human paths leave it at `'human'`, the orchestrator's `kanban_create` passes
   * `'orchestrator'` so the board can tell authorship apart without a second
   * write path (KAN-63).
   */
  createTicket(input, { actor = 'human' } = {}) {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (title === '') throw new StoreError('bad_request', 'title is required');
    const planTiming = input.planTiming ?? 'at_pickup';
    const planQuestions = input.planQuestions ?? 'interactive';
    const modes = validateTicketModes(planTiming, planQuestions);
    if (!modes.ok) throw new StoreError('invalid_modes', modes.reason, { planTiming, planQuestions });
    const allowPaid = input.allowPaid === true;
    const budgetUsd = input.budgetUsd === undefined || input.budgetUsd === null ? 0 : Number(input.budgetUsd);
    if (!Number.isFinite(budgetUsd) || budgetUsd < 0) throw new StoreError('bad_request', 'budgetUsd must be >= 0');
    if (allowPaid && budgetUsd <= 0) {
      throw new StoreError('bad_request', 'paid tickets need a positive budgetUsd');
    }
    const priority = Number.isInteger(input.priority) ? input.priority : 0;
    const column = input.column === 'working' ? 'working' : 'backlog';
    const threshold = input.confidenceThreshold;
    if (threshold !== undefined && threshold !== null && (typeof threshold !== 'number' || threshold < 0 || threshold > 1)) {
      throw new StoreError('bad_request', 'confidenceThreshold must be in [0,1]');
    }
    // KAN-15: the two new ticket options. The store only checks shape — a
    // preset id's existence is the host's job (it owns the preset registry);
    // the write mode is a closed vocabulary both the store and the column CHECK
    // enforce. NULL on either means "no opinion", i.e. exactly the pre-0.12.0
    // behavior.
    const preset = normalizePreset(input.preset);
    const writeMode = normalizeWriteMode(input.writeMode);
    // KAN-18: the worktree switch records intent only, so it is a plain 0/1.
    // Anything that is not exactly `true` stores 0, which is the old behavior.
    const worktree = input.worktree === true ? 1 : 0;

    return this.transact(() => {
      const maxRow = this.db.prepare("SELECT MAX(CAST(SUBSTR(key, 5) AS INTEGER)) AS n FROM tickets WHERE key LIKE 'KAN-%'").get();
      const next = (maxRow?.n === null || maxRow?.n === undefined ? 0 : Number(maxRow.n)) + 1;
      const key = `KAN-${next}`;
      const orderRow = this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS n FROM tickets').get();
      const sortOrder = Number(orderRow?.n ?? 0) + 1000;
      const at = nowIso();
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO tickets (id, key, title, body, col, phase, plan_timing, plan_questions, priority, sort_order,
             allow_paid, budget_usd, spent_usd, attempt_count, escalation_rung, workspace_cwd,
             needs_attention_reason, confidence_threshold, preset, write_mode, worktree, created_at, updated_at, version)
           VALUES (?, ?, ?, ?, ?, 'plan', ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, NULL, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          id,
          key,
          title,
          typeof input.body === 'string' ? input.body : '',
          column,
          planTiming,
          planQuestions,
          priority,
          sortOrder,
          allowPaid ? 1 : 0,
          budgetUsd,
          typeof input.workspaceCwd === 'string' && input.workspaceCwd !== '' ? input.workspaceCwd : null,
          threshold ?? null,
          preset,
          writeMode,
          worktree,
          at,
          at,
        );
      if (Array.isArray(input.acceptance)) {
        let ordinal = 0;
        for (const statement of input.acceptance) {
          if (typeof statement !== 'string' || statement.trim() === '') continue;
          ordinal += 1;
          this.db
            .prepare('INSERT INTO acceptance (ticket_id, ordinal, statement, source, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(id, ordinal, statement, 'human', at);
        }
      }
      this.#event(id, 'created', {
        actor,
        payload: { key, title, planTiming, planQuestions, priority, allowPaid, budgetUsd, preset, writeMode, worktree: worktree === 1 },
      });
      return this.getTicket(id);
    });
  }

  getTicket(idOrKey) {
    if (typeof idOrKey !== 'string' || idOrKey === '') return undefined;
    const row = this.db.prepare('SELECT * FROM tickets WHERE id = ? OR key = ?').get(idOrKey, idOrKey);
    return ticketFromRow(row);
  }

  /**
   * Every ticket, or those in the given columns, in queue order. `withBody:
   * false` leaves the (large, rarely needed) body out of the read: the board
   * and the scheduler never look at it, and on a long-lived board the bodies
   * are most of the bytes in the table.
   */
  listTickets({ columns = null, withBody = true } = {}) {
    const fields = withBody ? '*' : TICKET_SUMMARY_COLUMNS;
    const rows =
      columns === null || columns === undefined
        ? this.db.prepare(`SELECT ${fields} FROM tickets ORDER BY created_at ASC`).all()
        : this.db
            .prepare(`SELECT ${fields} FROM tickets WHERE col IN (${columns.map(() => '?').join(',')}) ORDER BY created_at ASC`)
            .all(...columns);
    return rows.map(ticketFromRow).sort(compareQueue);
  }

  /**
   * The tickets the scheduler could launch right now, in launch order: those in
   * Working that are not parked, then Backlog tickets asked to plan now. The
   * filter runs in SQL so a board where everything is parked, done or waiting
   * costs the tick one indexed read and no row decoding.
   */
  listRunnable() {
    const unparked = "(needs_attention_reason IS NULL OR needs_attention_reason = '')";
    const working = this.db.prepare(`SELECT ${TICKET_SUMMARY_COLUMNS} FROM tickets WHERE col = 'working' AND ${unparked}`).all();
    const planNow = this.db
      .prepare(`SELECT ${TICKET_SUMMARY_COLUMNS} FROM tickets WHERE col = 'backlog' AND phase = 'plan' AND plan_timing = 'now' AND ${unparked}`)
      .all();
    return [...working.map(ticketFromRow).sort(compareQueue), ...planNow.map(ticketFromRow).sort(compareQueue)];
  }

  /** Just the id and phase of every ticket: the cheap list the live-state signature walks. */
  listTicketHeads() {
    return this.db.prepare('SELECT id, phase FROM tickets').all().map((row) => ({ id: row.id, phase: row.phase }));
  }

  /**
   * A token that differs whenever any row of the database changed: the
   * connection's own write count plus SQLite's data version (which moves when
   * another connection wrote). Two equal tokens mean nothing stored changed in
   * between; it says nothing about in-memory state or the clock.
   */
  changeToken() {
    this.changeStatements ??= {
      total: this.db.prepare('SELECT total_changes() AS n'),
      version: this.db.prepare('PRAGMA data_version'),
    };
    return `${this.changeStatements.total.get().n}.${this.changeStatements.version.get().data_version}`;
  }

  /** Whether a human has paused the orchestrator. Persisted, so a restart keeps it. */
  isOrchestratorPaused() {
    const row = this.db.prepare("SELECT value FROM runtime_state WHERE key = 'orchestrator_paused'").get();
    return row !== undefined && row.value === '1';
  }

  /** Set the orchestrator pause. Returns the stored value. */
  setOrchestratorPaused(paused) {
    const value = paused === true ? '1' : '0';
    this.db.prepare(
      "INSERT INTO runtime_state (key, value, updated_at) VALUES ('orchestrator_paused', ?, ?) "
      + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).run(value, new Date().toISOString());
    return value === '1';
  }

  /**
   * A durable switch a person set from the board, read back as text (KAN-72).
   * `runtime_state` is that table: the orchestrator pause lives there, and so
   * does the WIP cap, because "the limit is 3 now" is a switch the board owner
   * flips, not a value they edit in YAML and restart for. `null` means nobody
   * has ever set it, which is not the same as a stored `'0'`.
   */
  getSetting(key) {
    const row = this.db.prepare('SELECT value FROM runtime_state WHERE key = ?').get(String(key));
    return row === undefined ? null : row.value;
  }

  /**
   * Write a board switch and record that it was written. A setting belongs to no
   * ticket, so the `setting_changed` event carries a null ticket id; the board
   * feed wakes on it anyway (the change token moves with the row) and the event
   * log says who set what.
   */
  setSetting(key, value, { actor = 'human', reason = '' } = {}) {
    return this.transact(() => {
      this.db.prepare(
        'INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?) '
        + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      ).run(String(key), String(value), nowIso());
      this.#event(null, 'setting_changed', { actor, payload: { key: String(key), value: String(value), reason } });
      return String(value);
    });
  }

  // ---------------------------------------------------------------------- WIP

  /**
   * How many Working slots are taken: in Working and not parked. A ticket held
   * at the approval gate waits on a person, not on a worker, so it is not
   * occupancy — src/wip.mjs states the definition, this is the same count in
   * SQL so a tick does not decode every row to get it.
   */
  countWorkingOccupancy() {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM tickets WHERE col = 'working' AND (needs_attention_reason IS NULL OR needs_attention_reason = '')")
      .get();
    return Number(row?.n ?? 0);
  }

  /** The occupancy itself, in queue order — the list a lowered cap trims. */
  listWorkingOccupancy() {
    return this.db
      .prepare(
        `SELECT ${TICKET_SUMMARY_COLUMNS} FROM tickets `
        + "WHERE col = 'working' AND (needs_attention_reason IS NULL OR needs_attention_reason = '')",
      )
      .all()
      .map(ticketFromRow)
      .sort(compareQueue);
  }

  /**
   * The WIP queue: Backlog tickets parked with a queue notice, head first. The
   * engine's tick promotes from the front of this list whenever a slot frees.
   * The prefix holds no LIKE wildcards, so the pattern is the prefix itself;
   * the filter re-checks the decoded reason so a hand-written lookalike cannot
   * slip in.
   */
  listWipQueue() {
    return this.db
      .prepare("SELECT " + TICKET_SUMMARY_COLUMNS + " FROM tickets WHERE col = 'backlog' AND needs_attention_reason LIKE ?")
      .all(`${WIP_QUEUE_PREFIX}%`)
      .map(ticketFromRow)
      .filter((ticket) => isWipQueuePark(ticket.needsAttentionReason))
      .sort(compareQueue);
  }

  updateTicket(idOrKey, patch, { actor = 'human', reason = '' } = {}) {
    const ticket = this.getTicket(idOrKey);
    if (ticket === undefined) throw new StoreError('not_found', `no ticket ${idOrKey}`);
    const next = { ...ticket };
    for (const field of TICKET_FIELDS) {
      if (patch[field] === undefined) continue;
      next[field] = patch[field];
    }
    if (patch.planTiming !== undefined || patch.planQuestions !== undefined) {
      const modes = validateTicketModes(next.planTiming, next.planQuestions);
      if (!modes.ok) throw new StoreError('invalid_modes', modes.reason);
    }
    // Same shape checks as createTicket: an explicit null clears the option
    // back to "no opinion"; anything else must be well-formed.
    if (patch.preset !== undefined) next.preset = normalizePreset(patch.preset);
    if (patch.writeMode !== undefined) next.writeMode = normalizeWriteMode(patch.writeMode);
    // KAN-18: intent is a boolean at this boundary, 0/1 in the row.
    if (patch.worktree !== undefined) next.worktree = patch.worktree === true;
    if (next.allowPaid && !(next.budgetUsd > 0)) {
      throw new StoreError('bad_request', 'paid tickets need a positive budgetUsd');
    }
    const changed = TICKET_FIELDS.filter((field) => patch[field] !== undefined && patch[field] !== ticket[field]);
    if (changed.length === 0) return ticket;
    return this.transact(() => {
      const at = nowIso();
      this.db
        .prepare(
          `UPDATE tickets SET title = ?, body = ?, priority = ?, sort_order = ?, allow_paid = ?, budget_usd = ?,
             workspace_cwd = ?, confidence_threshold = ?, plan_timing = ?, plan_questions = ?, preset = ?, write_mode = ?,
             worktree = ?, updated_at = ?, version = version + 1
           WHERE id = ?`,
        )
        .run(
          next.title,
          next.body,
          next.priority,
          next.sortOrder,
          next.allowPaid ? 1 : 0,
          next.budgetUsd,
          next.workspaceCwd,
          next.confidenceThreshold,
          next.planTiming,
          next.planQuestions,
          next.preset,
          next.writeMode,
          next.worktree === true ? 1 : 0,
          at,
          ticket.id,
        );
      this.#event(ticket.id, 'ticket_updated', {
        actor,
        payload: { fields: changed, values: Object.fromEntries(changed.map((f) => [f, next[f]])), reason },
      });
      return this.getTicket(ticket.id);
    });
  }

  /**
   * The human edit boundary's only question: has any engine touched this ticket?
   *
   * "Started in any way" is deliberately broad, because the thing the lock
   * protects is a role already working from what is on the card. A ticket is
   * editable only while it is pristine: still at the plan phase in backlog or
   * working, no attempt, no spend, not parked, and no child row in sessions,
   * runs, spans or conditions. The child-row check is what catches the quiet
   * touches — a plan session that attached and was cancelled leaves a session
   * row behind and nothing else you could see from the ticket columns.
   *
   * `updateTicket` itself stays open on purpose: reorder, worktree creation and
   * the retry patch are engine-internal writes against a started ticket and
   * must keep working. The guard lives at the human boundary (src/edit.mjs).
   */
  isEditable(idOrKey) {
    const ticket = this.getTicket(idOrKey);
    if (ticket === undefined) return false;
    return this.isEditableTicket(ticket);
  }

  /** `isEditable` for a ticket row already in hand: the board asks it for every card. */
  isEditableTicket(ticket) {
    if (ticket.column !== 'backlog' && ticket.column !== 'working') return false;
    if (ticket.phase !== 'plan') return false;
    if (Number(ticket.attemptCount) > 0) return false;
    if (Number(ticket.spentUsd) > 0) return false;
    if (ticket.needsAttentionReason !== null && ticket.needsAttentionReason !== undefined) return false;
    const touched = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM sessions WHERE ticket_id = ?1) AS sessions,
           (SELECT COUNT(*) FROM runs WHERE ticket_id = ?1) AS runs,
           (SELECT COUNT(*) FROM spans WHERE ticket_id = ?1) AS spans,
           (SELECT COUNT(*) FROM conditions WHERE ticket_id = ?1) AS conditions`,
      )
      .get(ticket.id);
    return (
      Number(touched.sessions) + Number(touched.runs) + Number(touched.spans) + Number(touched.conditions) === 0
    );
  }

  transitionTicket(idOrKey, to, { actor = 'engine', reason = '', outsideEngine = false } = {}) {
    const ticket = this.getTicket(idOrKey);
    if (ticket === undefined) throw new StoreError('not_found', `no ticket ${idOrKey}`);
    const column = to.column ?? ticket.column;
    const phase = to.phase ?? ticket.phase;
    const check = assertTransition(ticket, { column, phase }, { actor, reason, outsideEngine });
    if (!check.ok) throw new StoreError('invalid_transition', check.reason, { from: { column: ticket.column, phase: ticket.phase }, to: { column, phase } });
    if (column === ticket.column && phase === ticket.phase) return ticket;
    return this.transact(() => {
      const at = nowIso();
      const closedAt = ['done', 'discarded'].includes(column) ? at : null;
      this.db
        .prepare(
          `UPDATE tickets SET col = ?, phase = ?, updated_at = ?, closed_at = COALESCE(?, closed_at),
             needs_attention_reason = CASE WHEN ? = col THEN needs_attention_reason ELSE NULL END,
             version = version + 1
           WHERE id = ?`,
        )
        .run(column, phase, at, closedAt, column, ticket.id);
      this.#event(ticket.id, column !== ticket.column ? 'column_changed' : 'phase_changed', {
        actor,
        phaseFrom: ticket.phase,
        phaseTo: phase,
        payload: { from: ticket.column, to: column, reason },
      });
      return this.getTicket(ticket.id);
    });
  }

  /**
   * Park a ticket in place: the reason is a card-level visual status, not a
   * column move. The ticket keeps its column and glows red until a human
   * resolves it (or a column transition clears it).
   */
  setNeedsAttention(idOrKey, reason, payload = {}) {
    const ticket = this.getTicket(idOrKey);
    if (ticket === undefined) throw new StoreError('not_found', `no ticket ${idOrKey}`);
    if (reason === undefined || reason === null || String(reason).trim() === '') {
      throw new StoreError('bad_request', 'needs_attention requires a reason');
    }
    return this.transact(() => {
      const at = nowIso();
      this.db
        .prepare('UPDATE tickets SET needs_attention_reason = ?, updated_at = ?, version = version + 1 WHERE id = ?')
        .run(String(reason), at, ticket.id);
      this.#event(ticket.id, 'needs_attention', {
        actor: 'engine',
        phaseFrom: ticket.phase,
        phaseTo: ticket.phase,
        payload: { reason, ...payload },
      });
      return this.getTicket(ticket.id);
    });
  }

  /** Lift the park: clear the reason in place (retry, human submission, session reactivation). */
  clearNeedsAttention(idOrKey, { actor = 'human', reason = '' } = {}) {
    const ticket = this.getTicket(idOrKey);
    if (ticket === undefined) throw new StoreError('not_found', `no ticket ${idOrKey}`);
    if (ticket.needsAttentionReason === undefined || ticket.needsAttentionReason === null) return ticket;
    return this.transact(() => {
      const at = nowIso();
      this.db
        .prepare('UPDATE tickets SET needs_attention_reason = NULL, updated_at = ?, version = version + 1 WHERE id = ?')
        .run(at, ticket.id);
      this.#event(ticket.id, 'attention_cleared', {
        actor,
        phaseFrom: ticket.phase,
        phaseTo: ticket.phase,
        payload: { priorReason: ticket.needsAttentionReason, reason },
      });
      return this.getTicket(ticket.id);
    });
  }

  setColumn(idOrKey, column, { actor = 'human', reason = '' } = {}) {
    return this.transitionTicket(idOrKey, { column, phase: undefined }, { actor, reason });
  }

  setPhase(idOrKey, phase, { actor = 'engine', reason = '' } = {}) {
    return this.transitionTicket(idOrKey, { phase }, { actor, reason });
  }

  addAcceptance(ticketId, statement, source = 'human') {
    if (typeof statement !== 'string' || statement.trim() === '') {
      throw new StoreError('bad_request', 'acceptance statement is required');
    }
    if (source !== 'human') throw new StoreError('bad_request', 'bad acceptance source');
    return this.transact(() => {
      const row = this.db.prepare('SELECT COALESCE(MAX(ordinal), 0) AS n FROM acceptance WHERE ticket_id = ?').get(ticketId);
      const ordinal = Number(row?.n ?? 0) + 1;
      const at = nowIso();
      this.db
        .prepare('INSERT INTO acceptance (ticket_id, ordinal, statement, source, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(ticketId, ordinal, statement, source, at);
      this.#event(ticketId, 'acceptance_added', { actor: source === 'human' ? 'human' : 'engine', payload: { source, statement } });
      return this.listAcceptance(ticketId);
    });
  }

  /**
   * Replace the whole acceptance list in one step, so editing and deleting a
   * statement are the same operation as adding one. The event carries both the
   * prior and the new statements: acceptance is the human's own words, so what
   * was removed has to stay readable in the audit trail. An empty array is a
   * legitimate answer — it says the ticket has no acceptance criteria.
   */
  setAcceptance(idOrKey, statements, { reason = '' } = {}) {
    const ticket = this.getTicket(idOrKey);
    if (ticket === undefined) throw new StoreError('not_found', `no ticket ${idOrKey}`);
    if (!Array.isArray(statements)) throw new StoreError('bad_request', 'acceptance must be an array of statements');
    const next = [];
    for (const statement of statements) {
      if (typeof statement !== 'string' || statement.trim() === '') {
        throw new StoreError('bad_request', 'every acceptance statement must be a non-empty string');
      }
      next.push(statement);
    }
    const prior = this.listAcceptance(ticket.id).map((row) => row.statement);
    const unchanged = prior.length === next.length && prior.every((statement, index) => statement === next[index]);
    if (unchanged) return this.listAcceptance(ticket.id);
    return this.transact(() => {
      const at = nowIso();
      this.db.prepare('DELETE FROM acceptance WHERE ticket_id = ?').run(ticket.id);
      let ordinal = 0;
      for (const statement of next) {
        ordinal += 1;
        this.db
          .prepare('INSERT INTO acceptance (ticket_id, ordinal, statement, source, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(ticket.id, ordinal, statement, 'human', at);
      }
      this.#event(ticket.id, 'acceptance_set', { actor: 'human', payload: { prior, next, reason } });
      return this.listAcceptance(ticket.id);
    });
  }

  listAcceptance(ticketId) {
    return this.db
      .prepare('SELECT ordinal, statement, source, created_at FROM acceptance WHERE ticket_id = ? ORDER BY ordinal ASC')
      .all(ticketId)
      .map((row) => ({ ordinal: Number(row.ordinal), statement: row.statement, source: row.source, createdAt: row.created_at }));
  }

  replaceConditions(ticketId, planVersion, conditions, source = 'plan') {
    if (!Array.isArray(conditions) || conditions.length === 0) {
      throw new StoreError('bad_request', 'a plan needs at least one done_when condition');
    }
    return this.transact(() => {
      const at = nowIso();
      this.db.prepare('DELETE FROM conditions WHERE ticket_id = ? AND plan_version = ?').run(ticketId, planVersion);
      let ordinal = 0;
      for (const condition of conditions) {
        ordinal += 1;
        this.db
          .prepare(
            'INSERT INTO conditions (ticket_id, plan_version, ordinal, condition_id, statement, how_verified, source, created_at, deferred, human_evidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            ticketId,
            planVersion,
            ordinal,
            String(condition.id),
            String(condition.statement),
            String(condition.howVerified),
            source,
            at,
            condition.deferred === true ? 1 : 0,
            condition.humanEvidence === undefined || condition.humanEvidence === null ? '' : String(condition.humanEvidence),
          );
      }
      this.#event(ticketId, 'conditions_set', { payload: { planVersion, count: conditions.length, source } });
      return this.listConditions(ticketId, planVersion);
    });
  }

  listConditions(ticketId, planVersion = null) {
    const version = planVersion ?? this.currentPlanVersion(ticketId);
    return this.db
      .prepare('SELECT * FROM conditions WHERE ticket_id = ? AND plan_version = ? ORDER BY ordinal ASC')
      .all(ticketId, version)
      .map((row) => ({
        id: row.condition_id,
        statement: row.statement,
        howVerified: row.how_verified,
        source: row.source,
        ordinal: Number(row.ordinal),
        planVersion: Number(row.plan_version),
        // KAN-31: the deferred marker rides with the condition everywhere the
        // condition does — plan artifact, build prompt, review gate, approval.
        deferred: Number(row.deferred) === 1,
        humanEvidence: row.human_evidence,
      }));
  }

  currentPlanVersion(ticketId) {
    const row = this.db.prepare('SELECT COALESCE(MAX(plan_version), 0) AS n FROM conditions WHERE ticket_id = ?').get(ticketId);
    return Number(row?.n ?? 0);
  }

  // ----------------------------------------------------------------- events

  listEvents(ticketId, { limit = 200, before = null } = {}) {
    const rows =
      before === null
        ? this.db.prepare('SELECT * FROM events WHERE ticket_id = ? ORDER BY id DESC LIMIT ?').all(ticketId, limit)
        : this.db.prepare('SELECT * FROM events WHERE ticket_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(ticketId, before, limit);
    return rows.map(eventFromRow).reverse();
  }

  /**
   * What the board derives per-ticket facts from, for every ticket in three
   * queries: phase transitions and attention events, work spans, and attached
   * sessions. Returned as Map(ticketId -> {transitions, events, spans, sessions}).
   *
   * `scope` is null (every ticket), one ticket id, or a list of ids: a scoped
   * read goes through the per-ticket indexes instead of scanning the whole
   * event log. `sessions: false` skips the session read (see boardSessions).
   */
  boardTelemetry(scope = null, { sessions = true } = {}) {
    if (Array.isArray(scope)) {
      // Bound-variable limits: read a long id list in slices.
      const merged = new Map();
      for (let at = 0; at < scope.length; at += 400) {
        for (const [id, entry] of this.#telemetry(scope.slice(at, at + 400), sessions)) merged.set(id, entry);
      }
      return merged;
    }
    return this.#telemetry(scope === null ? null : [scope], sessions);
  }

  #telemetry(ids, sessions) {
    const only = ids === null ? '' : ` AND ticket_id IN (${ids.map(() => '?').join(',')})`;
    const arg = ids === null ? [] : ids;
    const out = new Map();
    const bucket = (ticketId) => {
      let entry = out.get(ticketId);
      if (entry === undefined) {
        entry = { transitions: [], events: [], spans: [], sessions: [] };
        out.set(ticketId, entry);
      }
      return entry;
    };
    const events = this.db
      .prepare(
        `SELECT id, ticket_id, at, kind, phase_from, phase_to FROM events
         WHERE ticket_id IS NOT NULL AND kind IN (${BOARD_EVENT_KINDS.map(() => '?').join(',')})${only} ORDER BY id ASC`,
      )
      .all(...BOARD_EVENT_KINDS, ...arg);
    for (const row of events) {
      const entry = bucket(row.ticket_id);
      if (row.kind === 'phase_changed' || row.kind === 'column_changed') {
        if (row.phase_to !== null && row.phase_to !== row.phase_from) entry.transitions.push({ from: row.phase_from, to: row.phase_to });
      }
      entry.events.push({ id: Number(row.id), at: row.at, kind: row.kind });
    }
    for (const row of this.db.prepare(`SELECT ticket_id, kind, status, started_at, ended_at FROM spans WHERE 1 = 1${only}`).all(...arg)) {
      bucket(row.ticket_id).spans.push({ kind: row.kind, status: row.status, startedAt: row.started_at, endedAt: row.ended_at });
    }
    if (!sessions) return out;
    for (const row of this.db.prepare(`SELECT ticket_id, dsh_session_id, role, purpose FROM sessions WHERE ticket_id IS NOT NULL${only} ORDER BY id ASC`).all(...arg)) {
      bucket(row.ticket_id).sessions.push({ sessionId: row.dsh_session_id, role: row.role, purpose: row.purpose });
    }
    return out;
  }

  /** Attached sessions of every ticket, oldest first: Map(ticketId -> [{sessionId, role, purpose}]). */
  boardSessions() {
    const out = new Map();
    for (const row of this.db.prepare('SELECT ticket_id, dsh_session_id, role, purpose FROM sessions WHERE ticket_id IS NOT NULL ORDER BY id ASC').all()) {
      let list = out.get(row.ticket_id);
      if (list === undefined) {
        list = [];
        out.set(row.ticket_id, list);
      }
      list.push({ sessionId: row.dsh_session_id, role: row.role, purpose: row.purpose });
    }
    return out;
  }

  // --------------------------------------------------------------- sessions

  attachSession({ ticketId = null, dshSessionId, role, purpose = null, preset = null, provider = null, model = null }) {
    if (typeof dshSessionId !== 'string' || dshSessionId === '') throw new StoreError('bad_request', 'dshSessionId is required');
    return this.transact(() => {
      const at = nowIso();
      const existing = this.db.prepare('SELECT * FROM sessions WHERE dsh_session_id = ?').get(dshSessionId);
      if (existing !== undefined) {
        this.db.prepare('UPDATE sessions SET ticket_id = ?, role = ?, purpose = ?, provider = ?, model = ?, closed_at = NULL WHERE id = ?').run(ticketId, role, purpose, provider, model, existing.id);
        if (existing.ticket_id !== ticketId || existing.role !== role || existing.purpose !== purpose) {
          this.#event(ticketId, 'session_attached', { payload: { sessionId: dshSessionId, role, purpose, retroactive: true } });
        }
        return Number(existing.id);
      }
      const result = this.db
        .prepare('INSERT INTO sessions (ticket_id, dsh_session_id, role, purpose, preset, provider, model, created_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)')
        .run(ticketId, dshSessionId, role, purpose, preset, provider, model, at);
      this.#event(ticketId, 'session_attached', { payload: { sessionId: dshSessionId, role, purpose } });
      return Number(result.lastInsertRowid);
    });
  }

  detachSession(dshSessionId) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE dsh_session_id = ?').get(dshSessionId);
    if (row === undefined) return false;
    const ticketId = row.ticket_id;
    return this.transact(() => {
      this.db.prepare('UPDATE sessions SET ticket_id = NULL, closed_at = ? WHERE id = ?').run(nowIso(), row.id);
      this.#event(ticketId, 'session_detached', { payload: { sessionId: dshSessionId } });
      return true;
    });
  }

  markSessionClosed(dshSessionId) {
    const at = nowIso();
    this.db.prepare('UPDATE sessions SET closed_at = ? WHERE dsh_session_id = ? AND closed_at IS NULL').run(at, dshSessionId);
  }

  listOpenSessions() {
    return this.db
      .prepare('SELECT * FROM sessions WHERE closed_at IS NULL ORDER BY id ASC')
      .all()
      .map((row) => ({ ticketId: row.ticket_id, sessionId: row.dsh_session_id, role: row.role, purpose: row.purpose }));
  }

  listAllSessions() {
    return this.db
      .prepare('SELECT * FROM sessions WHERE ticket_id IS NOT NULL ORDER BY id ASC')
      .all()
      .map((row) => ({ ticketId: row.ticket_id, sessionId: row.dsh_session_id, role: row.role, purpose: row.purpose }));
  }

  findSession(dshSessionId) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE dsh_session_id = ?').get(dshSessionId);
    if (row === undefined) return undefined;
    return {
      ticketId: row.ticket_id,
      sessionId: row.dsh_session_id,
      role: row.role,
      purpose: row.purpose,
      provider: row.provider,
      model: row.model,
      closedAt: row.closed_at,
    };
  }

  listSessions(ticketId) {
    return this.db
      .prepare('SELECT * FROM sessions WHERE ticket_id = ? ORDER BY id ASC')
      .all(ticketId)
      .map((row) => ({
        id: Number(row.id),
        ticketId: row.ticket_id,
        sessionId: row.dsh_session_id,
        role: row.role,
        purpose: row.purpose,
        preset: row.preset,
        provider: row.provider,
        model: row.model,
        createdAt: row.created_at,
        closedAt: row.closed_at,
      }));
  }

  orphanSessions() {
    return this.db.prepare('SELECT * FROM sessions WHERE ticket_id IS NULL ORDER BY id DESC LIMIT 100').all();
  }

  // ------------------------------------------------------------------ runs

  startRun({ id = randomUUID(), ticketId, configHash, promptHashes }) {
    return this.transact(() => {
      this.db
        .prepare('INSERT INTO runs (id, ticket_id, config_hash, prompt_hashes_json, started_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, ticketId, String(configHash), JSON.stringify(promptHashes ?? {}), nowIso());
      this.#event(ticketId, 'run_started', { payload: { runId: id, configHash } });
      return id;
    });
  }

  endRun(id) {
    this.db.prepare('UPDATE runs SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(nowIso(), id);
  }

  getRun(id) {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    if (row === undefined) return undefined;
    return { ...row, promptHashes: safeParse(row.prompt_hashes_json, {}) };
  }

  // ----------------------------------------------------------------- spans

  startSpan(span) {
    const id = span.id ?? randomUUID();
    const startedAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO spans (id, ticket_id, run_id, parent_span_id, kind, name, role, session_id, provider, model,
           started_at, ended_at, duration_ms, status, attempt, error, prompt_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'running', ?, NULL, ?)`,
      )
      .run(
        id,
        span.ticketId,
        span.runId ?? null,
        span.parentSpanId ?? null,
        span.kind,
        span.name,
        span.role ?? null,
        span.sessionId ?? null,
        span.provider ?? null,
        span.model ?? null,
        startedAt,
        span.attempt ?? 0,
        span.promptHash ?? null,
      );
    return { ...span, id, startedAt };
  }

  endSpan(id, { status = 'ok', error = null, durationMs = null } = {}) {
    const span = this.getSpan(id);
    if (span === undefined) return undefined;
    const endedAt = nowIso();
    this.db
      .prepare('UPDATE spans SET ended_at = ?, duration_ms = ?, status = ?, error = ? WHERE id = ?')
      .run(endedAt, durationMs === null ? null : Math.max(0, Math.round(durationMs)), status, error === null ? null : String(error), id);
    return this.getSpan(id);
  }

  getSpan(id) {
    return spanFromRow(this.db.prepare('SELECT * FROM spans WHERE id = ?').get(id));
  }

  listSpans(ticketId) {
    return this.db.prepare('SELECT * FROM spans WHERE ticket_id = ? ORDER BY started_at ASC, rowid ASC').all(ticketId).map(spanFromRow);
  }

  listAllSpans() {
    return this.db.prepare('SELECT * FROM spans ORDER BY started_at ASC, rowid ASC').all().map(spanFromRow);
  }

  runningSpans() {
    return this.db.prepare("SELECT * FROM spans WHERE status = 'running' ORDER BY started_at ASC").all().map(spanFromRow);
  }

  recordUsage(usage) {
    this.db
      .prepare(
        `INSERT INTO usage (span_id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, price_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(span_id) DO UPDATE SET
           provider = excluded.provider, model = excluded.model,
           input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
           cache_read_tokens = excluded.cache_read_tokens, cache_write_tokens = excluded.cache_write_tokens,
           cost_usd = excluded.cost_usd, price_version = excluded.price_version`,
      )
      .run(
        usage.spanId,
        usage.provider,
        usage.model,
        usage.inputTokens ?? 0,
        usage.outputTokens ?? 0,
        usage.cacheReadTokens ?? 0,
        usage.cacheWriteTokens ?? 0,
        usage.costUsd ?? null,
        usage.priceVersion ?? null,
      );
  }

  recordVerification(ticketId, verification) {
    this.db
      .prepare(
        `INSERT INTO verifications (span_id, ticket_id, condition_id, met, confidence, evidence, cycle, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        verification.spanId ?? null,
        ticketId,
        verification.conditionId,
        verification.met ? 1 : 0,
        Number(verification.confidence ?? 0),
        verification.evidence ?? '',
        verification.cycle ?? 0,
        nowIso(),
      );
  }

  // ------------------------------------------------------------- artifacts

  addArtifact(ticketId, kind, content, { spanId = null, maxBytes = 2_000_000 } = {}) {
    let text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    if (typeof text !== 'string') text = String(content);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > maxBytes) text = `${text.slice(0, maxBytes)}\n[artifact truncated at ${maxBytes} bytes]`;
    const result = this.db
      .prepare('INSERT INTO artifacts (ticket_id, span_id, kind, content, created_at, bytes) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ticketId, spanId, kind, text, nowIso(), bytes);
    return Number(result.lastInsertRowid);
  }

  listArtifacts(ticketId, { kind = null, limit = 100 } = {}) {
    const rows =
      kind === null
        ? this.db.prepare('SELECT id, kind, span_id, created_at, bytes FROM artifacts WHERE ticket_id = ? ORDER BY id DESC LIMIT ?').all(ticketId, limit)
        : this.db
            .prepare('SELECT id, kind, span_id, created_at, bytes FROM artifacts WHERE ticket_id = ? AND kind = ? ORDER BY id DESC LIMIT ?')
            .all(ticketId, kind, limit);
    return rows.map((row) => ({
      id: Number(row.id),
      kind: row.kind,
      spanId: row.span_id,
      createdAt: row.created_at,
      bytes: Number(row.bytes),
    }));
  }

  /** `listArtifacts` with each artifact's content, in one read instead of one per artifact. */
  listArtifactsWithContent(ticketId, { limit = 100 } = {}) {
    return this.db
      .prepare('SELECT id, kind, span_id, created_at, bytes, content FROM artifacts WHERE ticket_id = ? ORDER BY id DESC LIMIT ?')
      .all(ticketId, limit)
      .map((row) => ({
        id: Number(row.id),
        kind: row.kind,
        spanId: row.span_id,
        createdAt: row.created_at,
        bytes: Number(row.bytes),
        content: row.content ?? '',
      }));
  }

  getArtifact(id) {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id);
    if (row === undefined) return undefined;
    return { id: Number(row.id), ticketId: row.ticket_id, kind: row.kind, spanId: row.span_id, content: row.content, createdAt: row.created_at };
  }

  latestArtifact(ticketId, kind) {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE ticket_id = ? AND kind = ? ORDER BY id DESC LIMIT 1').get(ticketId, kind);
    if (row === undefined) return undefined;
    return { id: Number(row.id), kind: row.kind, content: row.content, createdAt: row.created_at, spanId: row.span_id };
  }

  /**
   * The highest artifact id whose kind starts with `prefix`, or 0 when there is
   * none. Prompts are recorded as `<role>_prompt_<span>` artifacts, so this is
   * "the last time that role was spoken to", compared against later writes by id.
   */
  latestArtifactIdWithPrefix(ticketId, prefix) {
    const row = this.db
      .prepare('SELECT MAX(id) AS id FROM artifacts WHERE ticket_id = ? AND substr(kind, 1, ?) = ?')
      .get(ticketId, prefix.length, prefix);
    return row === undefined || row.id === null ? 0 : Number(row.id);
  }

  pruneArtifacts(cutoffIso) {
    const result = this.db.prepare('DELETE FROM artifacts WHERE created_at < ?').run(cutoffIso);
    return Number(result.changes ?? 0);
  }

  // --------------------------------------------------------------- rollups

  usageForTicket(ticketId) {
    return this.db
      .prepare(
        `SELECT u.*, s.role, s.attempt, s.kind, s.name FROM usage u JOIN spans s ON s.id = u.span_id
         WHERE s.ticket_id = ? ORDER BY s.started_at ASC`,
      )
      .all(ticketId)
      .map((row) => ({
        spanId: row.span_id,
        provider: row.provider,
        model: row.model,
        role: row.role,
        attempt: Number(row.attempt),
        kind: row.kind,
        name: row.name,
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        cacheReadTokens: Number(row.cache_read_tokens),
        cacheWriteTokens: Number(row.cache_write_tokens),
        costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
        priceVersion: row.price_version,
      }));
  }

  rollup(ticketId) {
    const rows = this.usageForTicket(ticketId);
    const total = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      unpriced: false,
      byModel: {},
    };
    for (const row of rows) {
      total.inputTokens += row.inputTokens;
      total.outputTokens += row.outputTokens;
      total.cacheReadTokens += row.cacheReadTokens;
      total.cacheWriteTokens += row.cacheWriteTokens;
      const key = `${row.provider}/${row.model}`;
      const bucket = total.byModel[key] ?? {
        provider: row.provider,
        model: row.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        unpriced: false,
      };
      bucket.inputTokens += row.inputTokens;
      bucket.outputTokens += row.outputTokens;
      bucket.cacheReadTokens += row.cacheReadTokens;
      bucket.cacheWriteTokens += row.cacheWriteTokens;
      if (row.costUsd === null) {
        bucket.unpriced = true;
        total.unpriced = true;
      } else {
        bucket.costUsd += row.costUsd;
        total.costUsd += row.costUsd;
      }
      total.byModel[key] = bucket;
    }
    return total;
  }

  addSpend(ticketId, usd) {
    if (!Number.isFinite(usd) || usd <= 0) return;
    this.db.prepare('UPDATE tickets SET spent_usd = spent_usd + ?, updated_at = ?, version = version + 1 WHERE id = ?').run(usd, nowIso(), ticketId);
  }

  setAttempt(ticketId, attempt, rung) {
    this.db
      .prepare('UPDATE tickets SET attempt_count = ?, escalation_rung = ?, updated_at = ?, version = version + 1 WHERE id = ?')
      .run(attempt, rung, nowIso(), ticketId);
  }

  // ------------------------------------------------------------ analytics

  /** Attempts-to-done distribution. */
  attemptsToDone() {
    return this.db
      .prepare("SELECT attempt_count AS attempts, COUNT(*) AS tickets FROM tickets WHERE col = 'done' GROUP BY attempt_count ORDER BY attempt_count")
      .all()
      .map((row) => ({ attempts: Number(row.attempts), tickets: Number(row.tickets) }));
  }

  /** Per provider/model success rate: a model "succeeds" when the ticket it worked reached done. */
  modelSuccessRate() {
    return this.db
      .prepare(
        `SELECT s.provider, s.model, COUNT(DISTINCT s.ticket_id) AS tickets,
           COUNT(DISTINCT CASE WHEN t.col = 'done' THEN s.ticket_id END) AS done
         FROM spans s JOIN tickets t ON t.id = s.ticket_id
         WHERE s.kind = 'agent' AND s.status = 'ok' AND s.provider IS NOT NULL
         GROUP BY s.provider, s.model ORDER BY tickets DESC`,
      )
      .all()
      .map((row) => ({
        provider: row.provider,
        model: row.model,
        tickets: Number(row.tickets),
        done: Number(row.done),
        rate: Number(row.tickets) === 0 ? null : Number(row.done) / Number(row.tickets),
      }));
  }

  /** Confidence calibration: average predicted confidence by verdict and final ticket outcome. */
  calibration() {
    return this.db
      .prepare(
        `SELECT CASE WHEN v.met = 1 THEN 'met' ELSE 'unmet' END AS verdict,
           CAST(v.confidence * 10 AS INTEGER) / 10.0 AS bucket,
           COUNT(*) AS n, SUM(CASE WHEN t.col = 'done' THEN 1 ELSE 0 END) AS done
         FROM verifications v JOIN tickets t ON t.id = v.ticket_id
         GROUP BY verdict, bucket ORDER BY bucket`,
      )
      .all()
      .map((row) => ({ verdict: row.verdict, bucket: Number(row.bucket), n: Number(row.n), done: Number(row.done) }));
  }

  /** Average wall-clock time spent in each phase, from the phase_changed event chain. */
  timeInPhase() {
    return this.db
      .prepare(
        `WITH steps AS (
           SELECT ticket_id, phase_to AS phase, at,
             LEAD(at) OVER (PARTITION BY ticket_id ORDER BY id) AS next_at
           FROM events WHERE kind = 'phase_changed' AND phase_to IS NOT NULL
         )
         SELECT phase, COUNT(*) AS transitions,
           AVG((julianday(next_at) - julianday(at)) * 86400000.0) AS avg_ms
         FROM steps WHERE next_at IS NOT NULL GROUP BY phase ORDER BY phase`,
      )
      .all()
      .map((row) => ({ phase: row.phase, transitions: Number(row.transitions), avgMs: row.avg_ms === null ? null : Math.round(Number(row.avg_ms)) }));
  }

  costPerTicket() {
    return this.db
      .prepare(
        `SELECT s.ticket_id, t.key, SUM(CASE WHEN u.cost_usd IS NOT NULL THEN u.cost_usd ELSE 0 END) AS cost_usd,
           SUM(CASE WHEN u.cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced_rows,
           SUM(u.input_tokens) AS input_tokens, SUM(u.output_tokens) AS output_tokens
         FROM usage u JOIN spans s ON s.id = u.span_id JOIN tickets t ON t.id = s.ticket_id
         GROUP BY s.ticket_id ORDER BY cost_usd DESC`,
      )
      .all()
      .map((row) => ({
        ticketId: row.ticket_id,
        key: row.key,
        costUsd: Number(row.cost_usd),
        unpricedRows: Number(row.unpriced_rows),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
      }));
  }

  stallRate() {
    return this.db
      .prepare(
        `SELECT role, COUNT(*) AS spans, SUM(CASE WHEN status = 'abandoned' THEN 1 ELSE 0 END) AS abandoned
         FROM spans WHERE kind = 'agent' AND role IS NOT NULL GROUP BY role ORDER BY role`,
      )
      .all()
      .map((row) => ({
        role: row.role,
        spans: Number(row.spans),
        abandoned: Number(row.abandoned),
        rate: Number(row.spans) === 0 ? null : Number(row.abandoned) / Number(row.spans),
      }));
  }

  counts() {
    const rows = this.db.prepare('SELECT col, COUNT(*) AS n FROM tickets GROUP BY col').all();
    const out = { backlog: 0, working: 0, done: 0, discarded: 0 };
    for (const row of rows) out[row.col] = Number(row.n);
    return out;
  }

  // ---------------------------------------------------------------------- kv --
  //
  // The board's runtime state that is not a ticket (v9): today, which session id
  // the orchestrator is living in after a "Restart orchestrator" rotation. These
  // are not configuration — a person never edits them — which is why they can sit
  // here while providers, roles and prompts stay in YAML.

  /** The stored value for `key`, or null when nothing is stored under it. */
  kvGet(key) {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(String(key));
    return row === undefined ? null : String(row.value);
  }

  /** Store `value` under `key`, replacing whatever was there. */
  kvSet(key, value) {
    const text = String(value);
    this.db
      .prepare(
        `INSERT INTO kv (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(String(key), text);
    return text;
  }
}
