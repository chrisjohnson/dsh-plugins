// dsh-kanban: token pricing. Pure arithmetic over the provider policy YAML and
// the terminal `usage` chunk; there is no provider wire code anywhere.

const MILLION = 1_000_000;

/** Stable identifier for the price set used to compute one cost. */
export function priceVersion(policy) {
  if (policy === undefined || policy === null) return 'unknown';
  const parts = [policy.priceIn, policy.priceOut, policy.priceCacheRead, policy.priceCacheWrite];
  return `p:${parts.map((p) => (p === null || p === undefined ? 'x' : p)).join('/')}`;
}

/**
 * Price one turn. Returns `costUsd: null` — never 0 — when the route has no
 * complete price, so the UI can show `unpriced` instead of a fake $0.00.
 */
export function priceUsage(usage, policy) {
  const version = priceVersion(policy);
  if (usage === undefined || usage === null) return { costUsd: null, priceVersion: version };
  const input = Number(usage.inputTokens ?? 0);
  const output = Number(usage.outputTokens ?? 0);
  const cacheRead = Number(usage.cacheReadTokens ?? 0);
  const cacheWrite = Number(usage.cacheWriteTokens ?? 0);
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) {
    return { costUsd: 0, priceVersion: version };
  }
  const p = policy ?? {};
  const need = [];
  if (input > 0) need.push(p.priceIn);
  if (output > 0) need.push(p.priceOut);
  if (cacheRead > 0) need.push(p.priceCacheRead);
  if (cacheWrite > 0) need.push(p.priceCacheWrite);
  if (need.some((value) => value === null || value === undefined)) {
    return { costUsd: null, priceVersion: version };
  }
  const cost =
    (input * p.priceIn + output * p.priceOut + cacheRead * p.priceCacheRead + cacheWrite * p.priceCacheWrite) / MILLION;
  return { costUsd: cost, priceVersion: version };
}

/**
 * Conservative pre-dispatch estimate for a paid route. Uses ~4 characters per
 * token for the prompt and the configured max output. Returns null when the
 * price is unknown, which the budget check treats as "cannot prove affordable".
 */
export function estimateTurnCost({ policy, promptChars, maxOutputTokens = 8192 }) {
  if (policy === undefined || policy === null) return null;
  if (policy.priceIn === null || policy.priceOut === null) return null;
  const promptTokens = Math.ceil(Math.max(0, promptChars) / 4);
  return (promptTokens * policy.priceIn + maxOutputTokens * policy.priceOut) / MILLION;
}
