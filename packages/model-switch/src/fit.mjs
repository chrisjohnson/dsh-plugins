// The fit guard's decisions, as pure functions.
//
// Everything in here is arithmetic over numbers that came from somewhere else,
// which is exactly why it lives apart from the Cordis wiring in ./host.mjs: the
// question "can this conversation move to that model, and what do we tell the
// user if it cannot" is the part worth testing, and it should not need a running
// harness to be tested. The evidence for each rule is in the comment above it;
// the tests in ../test/fit.test.mjs are what stop those rules from quietly
// drifting back.
//
// The physical premise, from the 2026-09-28 incident in README.md: a model has
// to READ a conversation in order to summarize it, so a route cannot compact a
// transcript larger than its own window. No retry, no tuning and no better
// prompt changes that.

/** `provider/model`, tolerating the undefined that shows up on fresh sessions. */
export function routeLabel(route) {
  if (route === undefined || route === null) return 'unknown';
  return `${route.provider}/${route.model}`;
}

export function sameRoute(a, b) {
  return a !== undefined && b !== undefined && a.provider === b.provider && a.model === b.model;
}

/**
 * The usable share of a destination window.
 *
 * Judgement runs against a FRACTION (default 0.8) rather than the whole window,
 * for two independent reasons: the token meter prices text at ~4 chars/token
 * and under-prices CJK and dense JSON by its own README's admission, and the
 * reply itself needs room. 0.8 is not arbitrary — it is dsh-compaction-basic's
 * own default compaction point, so the guard agrees with what the harness would
 * have done anyway.
 */
export function budgetFor(window, fitRatio) {
  if (typeof window !== 'number' || !Number.isFinite(window)) return undefined;
  return Math.floor(window * fitRatio);
}

/** Does `tokens` fit a destination window under the configured headroom? */
export function fitsWindow(tokens, window, config) {
  const budget = budgetFor(window, config.fitRatio);
  if (budget === undefined) return undefined;
  return tokens <= budget;
}

/**
 * Can this route physically read the transcript?
 *
 * This is the destination window WITHOUT the margin: the margin decides whether
 * to compact, reading is a yes/no. Using the margin here (an earlier build did)
 * means a conversation at 80.3% of its own window gets shipped off to a bigger
 * route and back for a compaction the current route could have done itself.
 */
export function canRead(tokens, window) {
  if (typeof window !== 'number' || !Number.isFinite(window)) return false;
  return tokens <= window;
}

/**
 * Can the route being left compact this conversation for a switch? The tool path
 * keeps the fit margin here: between fitRatio and 1.0 of the current window the
 * summary call itself has no headroom, so the switch is refused with the
 * delegate-to-subagent advice rather than attempted. The interactive repair uses
 * {@link canRead} (the full window) instead.
 */
export function canCompactFrom(tokens, window, fitRatio) {
  const budget = budgetFor(window, fitRatio);
  return budget !== undefined && tokens <= budget;
}

/**
 * Classify one measurement against one route.
 *
 * `fits === false` hides two states that must never be described the same way:
 *
 *   severity 'advisory'  budget < tokens <= window. The next request neither
 *     fails nor strands anything: the harness compacts it first, on this route,
 *     which can still read it. The honest offer is "compact now, where you
 *     choose, or lose the tail to an automatic summary".
 *   severity 'hard'      tokens > window. The request 400s, and overflow
 *     recovery summarizes with the route that just overflowed, so it 400s too.
 *     That is the stranding incident.
 */
export function classifyFit(tokens, window, fitRatio) {
  const budget = budgetFor(window, fitRatio);
  return {
    budget,
    fits: budget === undefined ? true : tokens <= budget,
    exceedsWindow: typeof window === 'number' && Number.isFinite(window) ? tokens > window : undefined,
  };
}

/**
 * Which route to recommend when the current one cannot hold the conversation.
 *
 * "Smallest window that still fits" is the intuitive rule and it is the wrong
 * one in a real catalog: several routes commonly declare the same big number
 * (three on one deployment I run), so the smallest fit lands on a different
 * provider than the operator's actual big model — and shares its model id, which
 * made the resulting button ambiguous too. Preferred routes, in the order the
 * operator configured them, are therefore tried first; smallest-fitting is only
 * the fallback.
 *
 * @param {Array<{provider: string, model: string, contextWindow: number}>} routes
 * @param {number} tokens
 * @param {{fitRatio: number, preferredRoutes?: Array}} config
 * @param {Array} [exclude] routes never to suggest (usually the current one twice)
 */
export function pickSuggestion(routes, tokens, config, exclude) {
  const skip = (exclude ?? []).filter((route) => route !== undefined && route !== null);
  const usable = (routes ?? []).filter(
    (route) => !skip.some((other) => sameRoute(other, route)) && tokens <= Math.floor(route.contextWindow * config.fitRatio),
  );
  if (usable.length === 0) return undefined;
  for (const wanted of config.preferredRoutes ?? []) {
    const hit = usable.find((route) => sameRoute(route, wanted));
    if (hit !== undefined) return { ...hit, preferred: true };
  }
  return [...usable].sort((a, b) => a.contextWindow - b.contextWindow)[0];
}

/**
 * The guard's whole decision, as one pure call.
 *
 * `guardRouteChange` in ./host.mjs measures and (when told to) compacts; the
 * decision of what to do about the measurement is here, because it is the part
 * with five branches, three of them user-facing refusals, and it is exactly the
 * kind of logic a future refactor breaks silently.
 *
 * The refusals are the interesting output. A model that is told "cannot switch"
 * will try the same switch again; a model that is told "delegate this to a local
 * subagent, or move to a larger-window route, and here are the numbers" stops
 * burning turns on it.
 *
 * @param {object} input
 * @param {number|undefined} input.tokens        measured request-and-response pressure
 * @param {number} input.fitRatio                configured headroom fraction
 * @param {() => (number|undefined|Promise<number|undefined>)} input.destWindow
 *        resolves the declared window of the route being moved to; not called
 *        when there is no measurement to judge
 * @param {() => (number|undefined|Promise<number|undefined>)} input.currentWindow
 *        resolves the declared window of the route being left; called only when
 *        the destination does not fit, so a plain allow costs no extra lookup
 * @param {boolean} input.autoCompact            may the guard compact before switching?
 * @param {{provider: string, model: string}} input.dest
 * @param {string} input.routedLabel             `provider/model` currently routed
 * @returns {Promise<{action: 'allow', note?: string, tokens?: number, window?: number}
 *          | {action: 'compact', budget: number, tokens: number, window: number}
 *          | {action: 'refuse', reason: string, tokens: number, window: number}>}
 */
export async function decideFit({ tokens, fitRatio, destWindow, currentWindow, autoCompact, dest, routedLabel }) {
  if (typeof tokens !== 'number') {
    return { action: 'allow', note: 'no token measurement available; the fit check was skipped' };
  }
  const resolvedDest = await destWindow();
  const window = budgetFor(resolvedDest, fitRatio) === undefined ? undefined : resolvedDest;
  if (window === undefined) {
    return { action: 'allow', note: `no declared context window for ${routeLabel(dest)}; the fit check was skipped`, tokens };
  }
  const budget = budgetFor(window, fitRatio);
  if (tokens <= budget) return { action: 'allow', tokens, window };

  // Can the route we are on even READ the transcript? If not, no amount of
  // retrying will compact it, and switching only moves the failure. Say so with
  // numbers instead of switching. The margin applies here (see canCompactFrom).
  const current = await currentWindow();
  if (!canCompactFrom(tokens, current, fitRatio)) {
    return {
      action: 'refuse',
      tokens,
      window,
      reason:
        `context is ~${tokens} tokens and ${routeLabel(dest)} has a ${window}-token window. ` +
        `It cannot be compacted from the current route (${routedLabel}, ` +
        `${current === undefined ? 'no declared window' : `${current} tokens`}) because a model must read a ` +
        `conversation in order to summarize it. Delegate this work to a local subagent instead ` +
        `(the \`subagent\` tool accepts provider/model), or switch to a route with a larger window.`,
    };
  }

  if (autoCompact !== true) {
    return {
      action: 'refuse',
      tokens,
      window,
      reason:
        `context is ~${tokens} tokens and ${routeLabel(dest)} has a ${window}-token window ` +
        `(~${tokens - budget} over the ${budget}-token budget). Automatic fit compaction is disabled ` +
        `(autoCompact: false); compact with /compact first, or delegate to a subagent.`,
    };
  }

  return { action: 'compact', budget, tokens, window };
}

/** Why a compaction did not happen or did not free enough. Refusal copy lives here. */
export function compactionFailureReason({ dest, window, tokens, detail }) {
  return (
    `context is ~${tokens} tokens and ${routeLabel(dest)} has a ${window}-token window. ` +
    `It could not be compacted automatically before the switch: ${detail}. ` +
    `That is a structural limit, not a tuning problem - compaction is composed per agent ` +
    `inside a private realm, so a mid-turn tool cannot reach it (only /compact can, and only ` +
    `while the session is idle). Three ways forward: (1) delegate this work to a local ` +
    `subagent instead of switching - the \`subagent\` tool takes provider/model and the child ` +
    `starts with a fresh, small context; (2) ask the user to use the composer's ` +
    `"Compact and stay" repair, or /compact, and then switch; (3) switch to a route with a ` +
    `larger window.`
  );
}

export function stillTooLargeReason({ dest, window, after, freed, budget }) {
  return (
    `compaction freed ~${freed} tokens but the context is still ~${after} against ` +
    `${routeLabel(dest)}'s ${window}-token window (~${budget} usable). Delegate to a local ` +
    `subagent instead, or switch to a larger-window route.`
  );
}

