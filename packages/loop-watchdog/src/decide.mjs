// Pure decision logic for dsh-loop-watchdog: verdict parsing, confidence bands,
// the intervention gate, the model request, and the shape of one ledger record.
// No dsh imports and no I/O, so every rule here is tested directly.

/**
 * Producer kind of the note the watchdog steers into a session. Session format
 * V4 refuses the bare kind `plugin` on read, so a message written that way
 * could not be reopened after a restart; the producer-owned kind is
 * `plugin:<plugin-name>`.
 */
export const PLUGIN_SOURCE_KIND = 'plugin:loop-watchdog'

/** Longest one-line `notice` summary the harness accepts (CONTEXT_SUMMARY_MAX_CHARS). */
export const SUMMARY_MAX_CHARS = 120

/** Bound a notice summary to the harness limit, ellipsising when it is longer. */
export function boundSummary(summary) {
  const s = String(summary)
  return s.length > SUMMARY_MAX_CHARS ? `${s.slice(0, SUMMARY_MAX_CHARS - 1)}…` : s
}

// Centred on "did the window produce NEW information", not on "do the actions
// look similar". Similar-looking commands with new results are progress;
// re-run failures with no new results are stuck.
export const WATCHDOG_PROMPT =
  "You are a watchdog judging whether an AI agent is stuck. Its recent actions are shown with each tool call's result. The question is not whether the actions look similar, but whether this window produced NEW information: a new file read, a new symbol or error surfaced, a result that differs from earlier ones, or a step completing its purpose. Progress = actions that change what the agent knows or the state of the work, even when the commands look alike. Stuck = re-running work that already failed or returned nothing new: identical searches with the same empty or failing results, the same question re-asked, or steps that add no new fact. " +
  'Reply with EXACTLY one of these two forms, where N is an integer 0-100 for how sure you are: LOOP:N or PROGRESS:N. Example: LOOP:72. Output nothing else.'

// Non-destructive: a false positive here tells a WORKING agent to abandon its
// strategy. Instead: name the suspected repetition, ask for what has been
// established, and ask for the single cheapest falsifying check.
export const INTERVENTION_MESSAGE =
  '[WATCHDOG NOTE]: A pattern check flagged possible repetition in your recent steps (same actions, no new results). Do not treat this as a verdict. In one short paragraph, state what you have established so far, then take the single cheapest check that could falsify your current approach - or tell the operator what is blocking you.'

export const INTERVENTION_SUMMARY = 'Watchdog flagged repeated actions with no new results'

/** The `source` of the steering message. */
export function interventionSource() {
  return { kind: PLUGIN_SOURCE_KIND, form: 'notice', summary: boundSummary(INTERVENTION_SUMMARY) }
}

// ================================================================
// LENIENT VERDICT PARSER
// The model has produced "LOOP:72", "VERDICT:LOOP", "LOOP 72", "LOOP" (no
// number), and {"verdict","confidence"} JSON. All parse; a bare verdict gets
// confidence null (band 'noise').
// ================================================================
export function parseVerdict(raw) {
  if (!raw) return { verdict: null, confidence: null, inferred: false }
  const t = String(raw).trim()
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t)
      const v = String(o.verdict ?? o.label ?? '').toUpperCase()
      const c = Number(o.confidence ?? o.score ?? NaN)
      if (v === 'PROGRESS' || v === 'LOOP') {
        return { verdict: v, confidence: Number.isFinite(c) ? Math.min(100, Math.max(0, c)) : null, inferred: !Number.isFinite(c) }
      }
    } catch {
      // fall through to the token scan
    }
  }
  const vm = t.match(/(PROGRESS|LOOP)/i)
  if (!vm) return { verdict: null, confidence: null, inferred: false }
  const verdict = vm[1].toUpperCase()
  const cm = t.slice(vm.index + vm[0].length).match(/[:=\s]*(\d{1,3})/)
  if (cm) return { verdict, confidence: Math.min(100, parseInt(cm[1], 10)), inferred: false }
  return { verdict, confidence: null, inferred: true }
}

/**
 * 'stuck' (actionable), 'watch', or 'noise'. The confidence is how sure the
 * model is of ITS verdict, so only a LOOP verdict can land in a stuck or watch
 * band: "PROGRESS:95" is confidence that the agent is working, and must neither
 * paint the session stuck nor extend a stuck streak. A missing confidence is noise.
 */
export function bandOf(confidence, { bandStuck, bandWatch }, verdict = 'LOOP') {
  if (confidence == null || verdict !== 'LOOP') return 'noise'
  if (confidence >= bandStuck) return 'stuck'
  if (confidence >= bandWatch) return 'watch'
  return 'noise'
}

/** Consecutive stuck-band decisions: a stuck one extends the streak, anything else resets it. */
export function nextStreak(previous, band) {
  return band === 'stuck' ? (previous ?? 0) + 1 : 0
}

/**
 * Whether to steer the session. ALL of: a LOOP verdict in the stuck band,
 * SUSTAINED (>= 2 consecutive stuck decisions), act mode, and not already acted
 * in this streak. When it does not act, `reason` says which gate held.
 */
export function interventionGate({ verdict, band, streak, interventionOn, alreadyActed }) {
  if (verdict === 'LOOP' && band === 'stuck' && streak >= 2 && interventionOn && !alreadyActed) {
    return { intervene: true, reason: 'act' }
  }
  const reason =
    band !== 'stuck'
      ? `band=${band}`
      : streak < 2
        ? `streak=${streak}<2`
        : !interventionOn
          ? 'mode=log'
          : alreadyActed
            ? 'already-acted-in-streak'
            : `verdict=${verdict ?? 'none'}`
  return { intervene: false, reason }
}

/**
 * Read the runtime act/log override. The mode file is a small JSON object,
 * `{"interventionEnabled": true|false}`, written by whatever UI or script the
 * operator uses; anything else (absent, corrupt, wrong type) means "no
 * override" and the configured default stands.
 */
export function parseModeOverride(text) {
  try {
    const o = JSON.parse(text)
    return typeof o?.interventionEnabled === 'boolean' ? o.interventionEnabled : null
  } catch {
    return null
  }
}

/**
 * The chat-completions request body. `llmExtraBody` is merged under the fixed
 * fields so a backend-specific switch (a chat-template flag that turns thinking
 * off, say) can be supplied by the deployment without the plugin knowing it.
 */
export function buildRequestBody(llm, transcript) {
  return {
    ...llm.extraBody,
    model: llm.model,
    max_tokens: llm.maxTokens,
    temperature: 0,
    messages: [
      { role: 'system', content: WATCHDOG_PROMPT },
      { role: 'user', content: transcript },
    ],
  }
}

/**
 * Canonical shape of one ledger record (schema v2). Every early-return path
 * emits a well-formed, if sparse, record rather than a ragged partial line.
 */
export function evalRecord(sessionId, events, now = new Date()) {
  return {
    v: 2,
    ts: now.toISOString(),
    sessionId,
    skip: null,
    events: events ?? null,
    code: null,
    model: null,
    source: null,
    verdict: null,
    confidence: null,
    band: null,
    streak: 0,
    mode: null,
    fingerprints: [],
    latencyMs: 0,
    window: '',
    outcome: 'logged',
  }
}
