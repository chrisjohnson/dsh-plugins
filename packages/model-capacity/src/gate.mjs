// dsh-model-capacity: the `llm/stream` gate.
//
// Every model call — user turns, subagents, judges, titles, compaction — passes
// through here. The wait happens before `next()` reaches the adapter, so the
// provider's own stream-idle timer does not start until a slot exists. The lease
// is released when the stream ends, fails, or is aborted.

/**
 * Wrap one model-call stream.
 *
 * @param {import('./semaphore.mjs').CapacityManager} manager
 * @param {{provider:string, model?:string, sessionId?:string, purpose?:string, signal?:AbortSignal}} options
 * @param {() => AsyncIterable<unknown>} next
 * @param {boolean} enabled
 * @returns {AsyncIterable<unknown>}
 */
export async function* gatedStream(manager, options, next, enabled = true) {
  if (!enabled) {
    yield* next();
    return;
  }
  const provider = options.provider;
  // Auxiliary calls (title, compaction) must not consume a subagent reservation:
  // the reservation belongs to the child's first main request.
  const auxiliary = options.purpose === 'session-title' || options.purpose === 'compaction';
  let lease = auxiliary ? null : manager.consumeReservation(options.sessionId, provider);
  if (lease === null) {
    lease = await manager.acquire({
      provider,
      model: options.model,
      sessionId: options.sessionId,
      kind: options.purpose ?? 'call',
      signal: options.signal,
    });
  }
  try {
    yield* next();
  } finally {
    lease.release();
  }
}

/** Async generator suitable for a Cordis `llm/stream` listener. */
export function installGate(ctx, manager, isEnabled) {
  return ctx.on(
    'llm/stream',
    (options, next) => gatedStream(manager, options, next, isEnabled()),
    { global: true, prepend: true },
  );
}
