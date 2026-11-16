// dsh-take-a-number: the `llm/stream` gate.
//
// Every model call — user turns, subagents, judges, titles, compaction — passes
// through here. Mapped providers wait in the machine's take-a-number queue for
// their GPU; unmapped providers (cloud routes) pass straight through. The
// lease is released when the stream ends, fails, or is aborted; aborting while
// queued cancels the waiter.
//
// This module imports nothing outside the package: the client is injected, so
// the tests run on a bare clone with no install.

/**
 * Map a dsh `llm/stream` purpose onto a take-a-number call kind. dsh 0.2.2
 * does not pass a `purpose` yet, so everything arrives as `call`; the map is
 * the seam for when it does.
 */
export const KIND_MAP = {
  call: 'call',
  turn: 'interactive-chat',
  'interactive-turn': 'interactive-chat',
  subagent: 'subagent',
  judge: 'judge',
  title: 'set-title',
  'set-title': 'set-title',
  compaction: 'compaction',
  compact: 'compaction',
  generate: 'generate',
  'image-gen': 'image-gen',
};

export function kindFor(options) {
  const purpose = typeof options?.purpose === 'string' && options.purpose !== '' ? options.purpose : 'call';
  return KIND_MAP[purpose] ?? 'call';
}

/**
 * Compose the human-readable description the dashboard shows for this call:
 * `interactive-chat · turn 7 · "Fix the deploy script"` (≤ 160 chars).
 */
export function composeDescription({ kind, turn, title }) {
  const parts = [kind];
  if (Number.isInteger(turn) && turn >= 1) parts.push(`turn ${turn}`);
  if (typeof title === 'string' && title.trim() !== '') parts.push(`“${title.trim()}”`);
  const text = parts.join(' · ');
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

/**
 * Build the acquire fields for one model call.
 *
 * @param {{provider:string, model?:string, sessionId?:string, purpose?:string}} options
 * @param {{sessionTitle?:string|null, turn?:number|null}} meta session metadata
 * @returns {{model?:string, provider?:string, kind:string, description:string, session?:string, sessionTitle?:string, turn?:number}}
 */
export function acquireFields(options, meta = {}) {
  const kind = kindFor(options);
  const fields = {
    provider: typeof options.provider === 'string' ? options.provider : undefined,
    kind,
    description: composeDescription({ kind, turn: meta.turn, title: meta.sessionTitle }),
  };
  if (typeof options.model === 'string' && options.model !== '') fields.model = options.model;
  if (typeof options.sessionId === 'string' && options.sessionId !== '') fields.session = options.sessionId;
  if (typeof meta.sessionTitle === 'string' && meta.sessionTitle !== '') fields.sessionTitle = meta.sessionTitle;
  if (Number.isInteger(meta.turn) && meta.turn >= 1) fields.turn = meta.turn;
  return fields;
}

/**
 * Wrap one model-call stream through the take-a-number gate.
 *
 * @param {object} gate
 * @param {boolean} gate.enabled  false → inert pass-through
 * @param {string|null} gate.queueId  the mapped queue, or null → pass-through
 * @param {object} gate.client  the TanClient
 * @param {(tan:object, fields:object, fn:Function, opts:object) => Promise<unknown>} gate.withLease
 *   injected so this module stays import-free (tests run without an install)
 * @param {() => {sessionTitle?:string|null, turn?:number|null}} [gate.describe]
 * @param {{provider:string, model?:string, sessionId?:string, purpose?:string, signal?:AbortSignal}} options
 * @param {() => AsyncIterable<unknown>} next
 * @returns {AsyncIterable<unknown>}
 */
export async function* gatedStream(gate, options, next) {
  if (!gate.enabled || gate.queueId === null) {
    yield* next();
    return;
  }
  let meta = { sessionTitle: null, turn: null };
  if (typeof gate.describe === 'function') {
    try {
      meta = gate.describe(options.sessionId) ?? meta;
    } catch {
      // Metadata must never break a model call.
    }
  }
  // Degraded pass-through (daemon down) arrives as leaseId === null; the stream
  // runs either way. The lease is released by withLease in all cases.
  yield* await gate.withLease(gate.client, acquireFields(options, meta), (leaseId) => {
    void leaseId;
    return next();
  }, { signal: options.signal });
}
