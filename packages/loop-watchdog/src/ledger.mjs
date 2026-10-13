// The READER side of the evaluation ledger: parse, normalise and project the
// JSON-lines file the watchdog appends to. Pure (text in, records out); the host
// does the file I/O. The evals panel is one consumer; the file is the interface.
//
// TWO RECORD SCHEMAS are handled, because history is not rewritten:
//   v2 (current): explicit `code` and `model` phase objects, plus skip records
//                 for steps that were deliberately not evaluated.
//   v1 (older):   decisions only, flattened; `source` says which layer decided
//                 and `fingerprints` holds the code layer's hits. v1 is
//                 NORMALISED into the v2 shape (marked `synthesized`) so a
//                 consumer never needs to know which era a row is from. v1 has no
//                 record for non-decisions, so a v1 timeline is legitimately
//                 sparser than a v2 one.

/**
 * Canonicalise one ledger line into the shape the panel consumes. `id` is the
 * LINE INDEX, stable because the ledger is append-only; the panel uses it to ask
 * for the full record (with its transcript window) of the one row it inspects.
 */
export function normalize(raw, id) {
  const v = Number(raw.v) || 1
  const skip = typeof raw.skip === 'string' && raw.skip ? raw.skip : null
  const source = typeof raw.source === 'string' ? raw.source : null

  let code = raw.code && typeof raw.code === 'object' ? raw.code : null
  let model = raw.model && typeof raw.model === 'object' ? raw.model : null

  if (v < 2) {
    // The code layer ALWAYS ran first, so a v1 llm decision means "code layer
    // ran and found nothing stuck"; `source: 'fingerprint'` means it decided.
    const fps = Array.isArray(raw.fingerprints) ? raw.fingerprints : []
    const codeDecided = source === 'fingerprint' || source === 'fast-path'
    code = {
      ran: true,
      calls: null,
      groupCount: fps.length,
      stuckGroups: fps,
      stuck: codeDecided,
      topGroups: fps,
      synthesized: true,
    }
    model =
      source === 'llm'
        ? {
            verdict: raw.verdict ?? null,
            confidence: raw.confidence ?? null,
            latencyMs: typeof raw.latencyMs === 'number' ? raw.latencyMs : 0,
            raw: '',
            hasReasoning: null,
            inferred: false,
            synthesized: true,
          }
        : null
  }

  // Which layer produced the outcome: code decided, model decided, or the step
  // was never evaluated (a skip). This is the axis the panel splits on.
  const layer = skip !== null ? 'none' : source === 'llm' ? 'model' : source ? 'code' : 'none'

  return {
    id,
    v,
    ts: raw.ts ?? null,
    sessionId: raw.sessionId ?? null,
    skip,
    source,
    layer,
    verdict: raw.verdict ?? null,
    confidence: raw.confidence ?? null,
    band: raw.band ?? null,
    streak: typeof raw.streak === 'number' ? raw.streak : 0,
    mode: raw.mode ?? null,
    outcome: raw.outcome ?? null,
    latencyMs: typeof raw.latencyMs === 'number' ? raw.latencyMs : 0,
    events: raw.events ?? null,
    code,
    model,
    fingerprints: Array.isArray(raw.fingerprints) ? raw.fingerprints : [],
    window: typeof raw.window === 'string' ? raw.window : '',
  }
}

export function summarizeSessions(records) {
  const byId = new Map()
  for (const r of records) {
    let s = byId.get(r.sessionId)
    if (!s) {
      s = { sessionId: r.sessionId, count: 0, code: 0, model: 0, skipped: 0, stuck: 0, firstTs: r.ts, lastTs: r.ts }
      byId.set(r.sessionId, s)
    }
    s.count++
    if (r.layer === 'code') s.code++
    else if (r.layer === 'model') s.model++
    else s.skipped++
    if (r.band === 'stuck') s.stuck++
    if (r.ts && (!s.firstTs || r.ts < s.firstTs)) s.firstTs = r.ts
    if (r.ts && (!s.lastTs || r.ts > s.lastTs)) s.lastTs = r.ts
  }
  return [...byId.values()].sort((a, b) => String(b.lastTs).localeCompare(String(a.lastTs)))
}

/**
 * Parse the whole ledger text. Unparseable lines are counted, not fatal: a
 * half-written final line must not hide the history above it.
 */
export function parseLedger(text) {
  const records = []
  const byId = new Map()
  let corrupt = 0
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    let raw
    try {
      raw = JSON.parse(line)
    } catch {
      corrupt++
      continue
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      corrupt++
      continue
    }
    const rec = normalize(raw, i)
    records.push(rec)
    byId.set(rec.id, rec)
  }
  return { records, byId, sessions: summarizeSessions(records), corrupt }
}

/**
 * List projection: everything the graph and ledger need, WITHOUT the transcript
 * window (several KB per row). The window is fetched per row via `detail`.
 */
export function projectList(r) {
  return {
    id: r.id,
    v: r.v,
    ts: r.ts,
    sessionId: r.sessionId,
    skip: r.skip,
    source: r.source,
    layer: r.layer,
    verdict: r.verdict,
    confidence: r.confidence,
    band: r.band,
    streak: r.streak,
    mode: r.mode,
    outcome: r.outcome,
    latencyMs: r.latencyMs,
    events: r.events,
    code: r.code
      ? {
          ran: !!r.code.ran,
          calls: r.code.calls ?? null,
          groupCount: r.code.groupCount ?? 0,
          stuck: !!r.code.stuck,
          stuckCount: Array.isArray(r.code.stuckGroups) ? r.code.stuckGroups.length : 0,
          synthesized: !!r.code.synthesized,
        }
      : null,
    model: r.model
      ? {
          verdict: r.model.verdict ?? null,
          confidence: r.model.confidence ?? null,
          latencyMs: r.model.latencyMs ?? 0,
          inferred: !!r.model.inferred,
          hasReasoning: r.model.hasReasoning ?? null,
          synthesized: !!r.model.synthesized,
        }
      : null,
    windowChars: r.window.length,
    windowLines: r.window ? r.window.split('\n').length : 0,
  }
}

export const DEFAULT_LIMIT = 2000
export const MAX_LIMIT = 20000

const ok = (value) => ({ ok: true, value })
const fail = (code, message) => ({ ok: false, error: { code, message, details: {} } })

/**
 * The three endpoints the panel calls, over an already-parsed ledger.
 * `led` is parseLedger's result plus an `error` field ('ledger-missing' or null).
 */
export function answer(endpoint, payload, led, ledgerFile) {
  const p = payload && typeof payload === 'object' ? payload : {}

  if (endpoint === 'list') {
    const sessionId = typeof p.sessionId === 'string' && p.sessionId ? p.sessionId : null
    const includeSkipped = p.includeSkipped !== false
    let rows = led.records
    if (sessionId) rows = rows.filter((r) => r.sessionId === sessionId)
    if (!includeSkipped) rows = rows.filter((r) => r.skip === null)

    const requested = Number.isFinite(p.limit) ? p.limit : DEFAULT_LIMIT
    const limit = Math.max(1, Math.min(MAX_LIMIT, requested))
    const truncated = rows.length > limit
    if (truncated) rows = rows.slice(-limit)

    const stats = { total: led.records.length, matched: rows.length, truncated, corrupt: led.corrupt ?? 0 }
    stats.code = led.records.filter((r) => r.layer === 'code').length
    stats.model = led.records.filter((r) => r.layer === 'model').length
    stats.skipped = led.records.filter((r) => r.skip !== null).length
    stats.stuck = led.records.filter((r) => r.band === 'stuck').length

    return ok({
      records: rows.map(projectList),
      stats,
      sessions: led.sessions,
      error: led.error ?? null,
      ledgerFile,
    })
  }

  if (endpoint === 'sessions') return ok({ sessions: led.sessions, error: led.error ?? null })

  if (endpoint === 'detail') {
    const id = Number(p.id)
    if (!Number.isFinite(id)) return fail('bad_request', 'detail requires a numeric id')
    const rec = led.byId.get(id)
    if (!rec) return fail('not_found', `no evaluation with id ${id} (it may have rotated out of the ledger)`)
    return ok({ record: rec })
  }

  return fail('unknown_endpoint', `unknown endpoint ${String(endpoint)}`)
}
