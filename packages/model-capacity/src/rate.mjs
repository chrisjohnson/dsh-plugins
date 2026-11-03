// dsh-model-capacity: output-token rate math.
//
// Pure: no dsh imports, no timers. A meter counts tokens into one-second
// buckets held in a fixed ring, so recording is O(1) and memory is bounded
// regardless of traffic. Rates are read by summing the buckets a window covers
// (at most `horizonSec` of them), which happens once per pushed frame, never
// per model chunk.

/** Characters per token used to turn a streamed text fragment into a live estimate. */
export const CHARS_PER_TOKEN = 4;

const WHOLE_SECONDS_FROM = 60;

export const WINDOWS = Object.freeze({ instantSec: 3, oneMinuteSec: 60, fiveMinuteSec: 300, oneHourSec: 3600 });

export class RateMeter {
  /**
   * @param {object} [options]
   * @param {number} [options.horizonSec] ring size; the longest window that can be asked for.
   * @param {() => number} [options.now] epoch milliseconds.
   */
  constructor({ horizonSec = WINDOWS.oneHourSec, now = Date.now } = {}) {
    this.horizonSec = horizonSec;
    this.now = now;
    this.counts = new Float64Array(horizonSec);
    this.stamps = new Float64Array(horizonSec).fill(-1);
    this.startedAtMs = now();
    this.total = 0;
  }

  /** Count `tokens` (may be negative: a correction) at the current time. O(1). */
  add(tokens, at = this.now()) {
    if (!Number.isFinite(tokens) || tokens === 0) return;
    const sec = Math.floor(at / 1000);
    const slot = sec % this.horizonSec;
    if (this.stamps[slot] !== sec) {
      this.stamps[slot] = sec;
      this.counts[slot] = 0;
    }
    this.counts[slot] += tokens;
    this.total += tokens;
  }

  /**
   * Average tokens per second over the trailing `windowSec`, never negative.
   *
   * A short window (the live "now" figure) includes the second still in
   * progress, so it moves with every chunk. A long window counts whole seconds
   * only, so the half-filled current bucket cannot skew an average that is
   * meant to be steady. Either way the window is shortened to the meter's age,
   * so a fresh meter is not diluted by time it never saw.
   */
  rate(windowSec, at = this.now()) {
    const span = Math.min(Math.max(1, Math.floor(windowSec)), this.horizonSec);
    const sec = Math.floor(at / 1000);
    const ageMs = at - this.startedAtMs;
    if (span >= WHOLE_SECONDS_FROM) {
      const completedAgeMs = sec * 1000 - this.startedAtMs;
      if (completedAgeMs >= 1000) {
        const sum = this.#sum(sec - 1, span);
        return Math.max(0, (sum * 1000) / Math.min(span * 1000, completedAgeMs));
      }
    }
    const sum = this.#sum(sec, span);
    const spanMs = (span - 1) * 1000 + (at - sec * 1000);
    return Math.max(0, (sum * 1000) / Math.max(1000, Math.min(spanMs, ageMs)));
  }

  /** Sum of the `count` one-second buckets ending at second `last`. */
  #sum(last, count) {
    let sum = 0;
    for (let back = 0; back < count; back += 1) {
      const wanted = last - back;
      const slot = ((wanted % this.horizonSec) + this.horizonSec) % this.horizonSec;
      if (this.stamps[slot] === wanted) sum += this.counts[slot];
    }
    return sum;
  }

  /** The four rates the Activity page shows, in tokens per second, plus the running total. */
  summary(at = this.now()) {
    return {
      instant: round1(this.rate(WINDOWS.instantSec, at)),
      avg1m: round1(this.rate(WINDOWS.oneMinuteSec, at)),
      avg5m: round1(this.rate(WINDOWS.fiveMinuteSec, at)),
      avg1h: round1(this.rate(WINDOWS.oneHourSec, at)),
      totalTokens: Math.max(0, Math.round(this.total)),
    };
  }
}

/** Meters keyed by provider, created on first use. Bounded by the number of providers. */
export class RateBook {
  constructor({ now = Date.now, horizonSec = WINDOWS.oneHourSec } = {}) {
    this.now = now;
    this.horizonSec = horizonSec;
    this.all = new RateMeter({ now, horizonSec });
    this.byProvider = new Map();
  }

  add(provider, tokens, at = this.now()) {
    this.all.add(tokens, at);
    let meter = this.byProvider.get(provider);
    if (meter === undefined) {
      meter = new RateMeter({ now: this.now, horizonSec: this.horizonSec });
      this.byProvider.set(provider, meter);
    }
    meter.add(tokens, at);
  }

  summary(at = this.now()) {
    return this.all.summary(at);
  }

  providerSummary(provider, at = this.now()) {
    return this.byProvider.get(provider)?.summary(at) ?? null;
  }
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Output tokens implied by one stream chunk, as a live estimate: streamed
 * fragments count their length at {@link CHARS_PER_TOKEN} characters per token.
 * Block, finish and usage chunks carry no new output here (usage is reconciled
 * separately by {@link reconcileUsage}).
 */
export function estimateChunkTokens(chunk) {
  if (chunk === null || typeof chunk !== 'object') return 0;
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return typeof chunk.text === 'string' ? chunk.text.length / CHARS_PER_TOKEN : 0;
    case 'tool-call-delta': {
      const args = typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta.length : 0;
      const name = typeof chunk.name === 'string' ? chunk.name.length : 0;
      return (args + name) / CHARS_PER_TOKEN;
    }
    default:
      return 0;
  }
}

/**
 * The correction that turns a call's streamed estimate into the provider's own
 * count when its usage chunk arrives. Null when the chunk is not a usage chunk
 * or reports no output count.
 */
export function reconcileUsage(chunk, estimatedSoFar) {
  if (chunk === null || typeof chunk !== 'object' || chunk.type !== 'usage') return null;
  const out = chunk.usage?.outputTokens;
  if (typeof out !== 'number' || !Number.isFinite(out) || out < 0) return null;
  return out - estimatedSoFar;
}

/**
 * Per-call counters, mutated in place on the lease. `observe` returns the token
 * delta to add to the meters (an estimate while streaming, a correction on
 * usage), or 0.
 */
export function observeChunk(lease, chunk, at) {
  const correction = reconcileUsage(chunk, lease.outputTokens ?? 0);
  const delta = correction !== null ? correction : estimateChunkTokens(chunk);
  if (delta === 0) return 0;
  if (lease.firstOutputAt === undefined || lease.firstOutputAt === null) lease.firstOutputAt = at;
  lease.outputTokens = (lease.outputTokens ?? 0) + delta;
  lease.lastOutputAt = at;
  return delta;
}

/** Live rate of one running call, or null before it has produced enough to say. */
export function leaseRate(lease, now) {
  if (!lease || typeof lease.firstOutputAt !== 'number') return null;
  const spanMs = now - lease.firstOutputAt;
  if (spanMs < 500) return null;
  return round1(Math.max(0, ((lease.outputTokens ?? 0) * 1000) / spanMs));
}
