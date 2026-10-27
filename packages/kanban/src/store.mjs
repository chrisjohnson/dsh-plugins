// dsh-kanban: the store. Every ticket-state mutation in the engine flows
// through this file, inside BEGIN IMMEDIATE, bumping the row version and
// publishing a post-commit event.
//
// There are no config tables here on purpose: providers, roles, prompts and
// limits are YAML (src/config.mjs); this database records what is true.

import { randomUUID } from 'node:crypto';

import { assertTransition, compareQueue, validateTicketModes } from './lifecycle.mjs';

export class StoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.details = details;
  }
}

export const nowIso = () => new Date().toISOString();

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

  createTicket(input) {
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
    const threshold = input.confidenceThreshold;
    if (threshold !== undefined && threshold !== null && (typeof threshold !== 'number' || threshold < 0 || threshold > 1)) {
      throw new StoreError('bad_request', 'confidenceThreshold must be in [0,1]');
    }

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
             needs_attention_reason, confidence_threshold, created_at, updated_at, version)
           VALUES (?, ?, ?, ?, 'backlog', 'plan', ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, NULL, ?, ?, ?, 1)`,
        )
        .run(
          id,
          key,
          title,
          typeof input.body === 'string' ? input.body : '',
          planTiming,
          planQuestions,
          priority,
          sortOrder,
          allowPaid ? 1 : 0,
          budgetUsd,
          typeof input.workspaceCwd === 'string' && input.workspaceCwd !== '' ? input.workspaceCwd : null,
          threshold ?? null,
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
        actor: 'human',
        payload: { key, title, planTiming, planQuestions, priority, allowPaid, budgetUsd },
      });
      return this.getTicket(id);
    });
  }

  getTicket(idOrKey) {
    if (typeof idOrKey !== 'string' || idOrKey === '') return undefined;
    const row = this.db.prepare('SELECT * FROM tickets WHERE id = ? OR key = ?').get(idOrKey, idOrKey);
    return ticketFromRow(row);
  }

  listTickets({ columns = null } = {}) {
    const rows =
      columns === null || columns === undefined
        ? this.db.prepare('SELECT * FROM tickets ORDER BY created_at ASC').all()
        : this.db
            .prepare(`SELECT * FROM tickets WHERE col IN (${columns.map(() => '?').join(',')}) ORDER BY created_at ASC`)
            .all(...columns);
    return rows.map(ticketFromRow).sort(compareQueue);
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
             workspace_cwd = ?, confidence_threshold = ?, plan_timing = ?, plan_questions = ?, updated_at = ?, version = version + 1
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

  transitionTicket(idOrKey, to, { actor = 'engine', reason = '' } = {}) {
    const ticket = this.getTicket(idOrKey);
    if (ticket === undefined) throw new StoreError('not_found', `no ticket ${idOrKey}`);
    const column = to.column ?? ticket.column;
    const phase = to.phase ?? ticket.phase;
    const check = assertTransition(ticket, { column, phase }, { actor, reason });
    if (!check.ok) throw new StoreError('invalid_transition', check.reason, { from: { column: ticket.column, phase: ticket.phase }, to: { column, phase } });
    if (column === ticket.column && phase === ticket.phase) return ticket;
    return this.transact(() => {
      const at = nowIso();
      const closedAt = ['done', 'discarded'].includes(column) ? at : null;
      this.db
        .prepare(
          `UPDATE tickets SET col = ?, phase = ?, updated_at = ?, closed_at = COALESCE(?, closed_at),
             needs_attention_reason = CASE WHEN ? = 'needs_attention' THEN needs_attention_reason ELSE NULL END,
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

  setNeedsAttention(idOrKey, reason, payload = {}) {
    const ticket = this.getTicket(idOrKey);
    if (ticket === undefined) throw new StoreError('not_found', `no ticket ${idOrKey}`);
    if (reason === undefined || reason === null || String(reason).trim() === '') {
      throw new StoreError('bad_request', 'needs_attention requires a reason');
    }
    return this.transact(() => {
      const at = nowIso();
      this.db
        .prepare("UPDATE tickets SET col = 'needs_attention', needs_attention_reason = ?, updated_at = ?, version = version + 1 WHERE id = ?")
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
            'INSERT INTO conditions (ticket_id, plan_version, ordinal, condition_id, statement, how_verified, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(ticketId, planVersion, ordinal, String(condition.id), String(condition.statement), String(condition.howVerified), source, at);
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
    const out = { backlog: 0, now: 0, blocked: 0, needs_attention: 0, done: 0, discarded: 0 };
    for (const row of rows) out[row.col] = Number(row.n);
    return out;
  }
}
