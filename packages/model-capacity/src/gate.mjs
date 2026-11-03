// dsh-model-capacity: the `llm/stream` gate.
//
// Every model call — user turns, subagents, judges, titles, compaction — passes
// through here, and every one of them waits in the same per-provider FIFO queue.
// There is no special path for a call because of who started it. The wait
// happens before `next()` reaches the adapter, so the provider's own
// stream-idle timer does not start until a slot exists. The lease is released
// when the stream ends, fails, or is aborted.

/**
 * Wrap one model-call stream.
 *
 * @param {import('./semaphore.mjs').CapacityManager} manager
 * @param {{provider:string, model?:string, sessionId?:string, purpose?:string, signal?:AbortSignal}} options
 * @param {() => AsyncIterable<unknown>} next
 * @param {boolean} enabled
 * @param {((lease: object, chunk: unknown) => void) | null} [tap] observes every chunk the
 *   stream yields; a throwing tap never affects the stream.
 * @returns {AsyncIterable<unknown>}
 */
export async function* gatedStream(manager, options, next, enabled = true, tap = null) {
  if (!enabled) {
    if (tap === null) {
      yield* next();
      return;
    }
    // Inert gate: no slot to hold, but the call still counts toward the rates.
    const unleased = { provider: options.provider, model: options.model ?? null };
    for await (const chunk of next()) {
      try {
        tap(unleased, chunk);
      } catch {
        // Metering must never break a model call.
      }
      yield chunk;
    }
    return;
  }
  const lease = await manager.acquire({
    provider: options.provider,
    model: options.model,
    sessionId: options.sessionId,
    kind: options.purpose ?? 'call',
    signal: options.signal,
  });
  try {
    if (tap === null) {
      yield* next();
    } else {
      for await (const chunk of next()) {
        try {
          tap(lease, chunk);
        } catch {
          // Metering must never break a model call.
        }
        yield chunk;
      }
    }
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
