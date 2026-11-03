// A scripted engine, store and driver for the recovery suites: the fake driver
// keeps real session bookkeeping (live, lost, reopened) so a test can lose a
// ticket's session and watch what the engine does about it.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { resolveConfig } from '../../src/config.mjs'
import { migrate } from '../../src/db.mjs'
import { KanbanStore } from '../../src/store.mjs'
import { Engine } from '../../src/engine.mjs'

export const CWD = mkdtempSync(join(tmpdir(), 'kanban-recovery-'))

export const PLAN = {
  summary: 'write the file',
  steps: ['create notes.txt'],
  done_when: [{ id: 'notes', statement: 'note exists', how_verified: 'test -f notes.txt' }],
}
export const IMPLEMENTATION = {
  status: 'complete',
  summary: 'created notes.txt',
  changed_files: ['notes.txt'],
  done_when: [{ id: 'notes', met: true, confidence: 0.95, evidence: 'notes.txt:1 hello' }],
  questions: [],
  residual_risks: [],
}
export const REVIEW_PASS = {
  verdict: 'pass',
  reasons: ['matches plan'],
  scope_drift: 'none',
  done_when: [{ id: 'notes', met: true, confidence: 0.95, evidence: 'notes.txt:1 hello' }],
  acceptance_coverage: [{ condition: 'notes', acceptance: 'note exists' }],
}
export const REVIEW_FAIL = {
  verdict: 'fail',
  reasons: ['the file is missing'],
  instruction: 'create notes.txt',
  scope_drift: 'none',
  acceptance_coverage: [],
}
export const PLAN_V2 = {
  summary: 'write the file somewhere safer',
  steps: ['create docs/notes.txt'],
  done_when: [{ id: 'docs-notes', statement: 'docs/notes.txt exists', how_verified: 'test -f docs/notes.txt' }],
}
export const PLAN_GRANTS = {
  summary: 'write outside the workspace',
  steps: ['write /ws/grant/out.txt'],
  done_when: [{ id: 'out', statement: 'the file exists', how_verified: 'test -f /ws/grant/out.txt' }],
  sandbox: {
    grants: { paths: ['/ws/grant'], commands: ['git push'] },
    checks: [{ path: '/ws/grant', check: 'test -w /ws/grant', observed: 'writable' }],
  },
}
export const REVIEW_FAIL_ROW = {
  ...REVIEW_FAIL,
  done_when: [{ id: 'notes', met: false, confidence: 0.9, evidence: 'notes.txt does not exist' }],
}

export const PROMPTS = {
  bodies: {
    'plan-human': 'plan {{ticket_state}}',
    'plan-self': 'plan self {{ticket_state}}',
    implement: 'implement {{plan}} {{done_when}} {{release_scope}}',
    rework: 'rework {{review}} {{release_scope}}',
    review: 'review {{diff}} {{done_when}}',
    approval: 'approval {{plan}} {{review}}{{deferred}}',
  },
  hashes: { plan: 'h' },
}

/**
 * @param {object} queues scripted turn results per role: plan / implement / review / approval.
 *   An entry may be `{ type, value }` (a structured submission), `null` (a turn that
 *   submits nothing), `{ text }` (such a turn that ends on that final text) or `{ fail }`.
 */
export function setup(queues = {}, options = {}) {
  const { config } = resolveConfig({
    roles: {
      planner: { provider: 'local', model: 'm' },
      implementer: { provider: 'local', model: 'm' },
      reviewer: { provider: 'local', model: 'm' },
      approver: { provider: 'local', model: 'm' },
    },
    providers: [{ name: 'local' }],
    confidenceThreshold: 0.7,
    ...(options.config ?? {}),
  })
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const store = new KanbanStore(db)
  const driver = {
    sessions: new Map(),
    ticketSessions: new Map(),
    counter: 0,
    busy: false,
    turns: [],
    closed: [],
    ticketsClosed: [],
    /** every reactivation the engine asked for: { ticketId, purpose } */
    reactivations: [],
    /**
     * What `reactivateSession` answers when no session is live. A function is
     * called with (ticketId, purpose); an object is returned as-is. When the
     * answer is `{ ok: true }` the lost session is made live again.
     */
    reactivation: { ok: false, none: true, reason: 'no earlier session' },
    queues: {
      planner: [...(queues.plan ?? [{ type: 'plan', value: PLAN }])],
      implementer: [...(queues.implement ?? [{ type: 'implementation', value: IMPLEMENTATION }])],
      reviewer: [...(queues.review ?? [{ type: 'review', value: REVIEW_PASS }])],
      approver: [...(queues.approval ?? [null])],
    },
    /** session ids that were live and then dropped, by `${ticketId}:${purpose}` */
    lost: new Map(),
    prep: { cwd: undefined, note: undefined },
    async preparePlanWorktree() { return this.prep },
    async ensureTicketSession({ ticket, role, purpose }) {
      const key = `${ticket.id}:${purpose}`
      let id = this.ticketSessions.get(key)
      if (id === undefined) {
        id = `session-${++this.counter}`
        this.ticketSessions.set(key, id)
        this.sessions.set(id, { role, purpose })
      }
      this.sessions.get(id).role = role
      return { sessionId: id }
    },
    /** Make a ticket's session disappear the way a restart or a close does. */
    dropSession(ticketId, purpose, store) {
      const key = `${ticketId}:${purpose}`
      const id = this.ticketSessions.get(key)
      if (id === undefined) return undefined
      this.ticketSessions.delete(key)
      this.lost.set(key, id)
      store?.markSessionClosed(id)
      return id
    },
    async reactivateSession(ticketId, purpose) {
      this.reactivations.push({ ticketId, purpose })
      const answer = typeof this.reactivation === 'function' ? this.reactivation(ticketId, purpose) : this.reactivation
      if (answer.ok) {
        const key = `${ticketId}:${purpose}`
        const id = this.lost.get(key) ?? answer.sessionId
        this.ticketSessions.set(key, id)
        if (!this.sessions.has(id)) this.sessions.set(id, { role: 'implementer', purpose })
        return { ok: true, sessionId: id, via: 'resumed' }
      }
      return answer
    },
    setPhase(id, role) { this.sessions.get(id).role = role },
    routes: [],
    setRoute(id, route) { this.routes.push({ sessionId: id, route }) },
    async sendTurn({ sessionId }) {
      this.turns.push(sessionId)
      const session = this.sessions.get(sessionId)
      const next = this.queues[session.role]?.shift() ?? null
      if (next !== null && next.fail !== undefined) {
        return { status: 'failed', error: next.fail, finalText: '', usage: { inputTokens: 1, outputTokens: 1 }, events: [] }
      }
      const text = next !== null && next.text !== undefined ? next.text : ''
      const action = next !== null && next.text !== undefined ? null : next
      return { status: 'ok', action, finalText: text, usage: { inputTokens: 1, outputTokens: 1 }, events: [] }
    },
    async waitTurn() { return { status: 'failed', error: 'no recovery scripted', finalText: '', usage: null, events: [] } },
    async closeSession(id) {
      this.closed.push(id)
      for (const [key, value] of [...this.ticketSessions]) {
        if (value !== id) continue
        this.ticketSessions.delete(key)
        this.lost.set(key, id)
      }
    },
    async closeTicketSessions(ticketId) {
      this.ticketsClosed.push(ticketId)
      for (const key of [...this.ticketSessions.keys()]) if (key.startsWith(`${ticketId}:`)) this.ticketSessions.delete(key)
    },
    liveTicketSession(ticketId, purpose) { return this.ticketSessions.get(`${ticketId}:${purpose}`) },
    isLive(id) { return [...this.ticketSessions.values()].includes(id) },
    isTicketBusy() { return this.busy },
    attachWorkspace() {},
    start() {},
    stop() {},
    reconcileTurns() {},
  }
  const log = { info() {}, warn() {}, error() {}, debug() {} }
  const ctx = { get() { return undefined } }
  const engine = new Engine({ ctx, store, driver, getConfig: () => config, getPrompts: () => PROMPTS, log })
  return { store, driver, engine, config }
}

export function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-recovery-git-'))
  const run = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })
  run('init', '-q')
  run('config', 'user.email', 'test@example.com')
  run('config', 'user.name', 'test')
  writeFileSync(join(dir, 'README.md'), 'seed\n')
  run('add', 'README.md')
  run('commit', '-q', '-m', 'seed')
  return dir
}

export function pickedUp(store, extra = {}) {
  const ticket = store.createTicket({ title: 'demo', acceptance: ['note exists'], workspaceCwd: CWD, planTiming: 'at_pickup', planQuestions: 'autonomous', column: 'working', ...extra })
  return store.getTicket(ticket.id)
}

/** The newest prompt text the engine recorded for one role (implementer, reviewer, planner, approver). */
export function lastPrompt(store, ticketId, role) {
  const id = store.latestArtifactIdWithPrefix(ticketId, `${role}_prompt_`)
  return id === 0 ? null : store.getArtifact(id).content
}

export function eventKinds(store, ticketId) {
  return store.listEvents(ticketId, { limit: 500 }).map((event) => event.kind)
}
