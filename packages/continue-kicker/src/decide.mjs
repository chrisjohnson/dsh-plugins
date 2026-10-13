// Pure decision logic for continue-kicker: should this session be kicked, should
// its runaway counter reset, or should the plugin stop. Imports nothing from dsh;
// the Cordis wiring in host.mjs only feeds it a session's events and applies the
// verdict.
//
// Event shapes (dsh 0.2.0-rc.2, session format V4):
//   user/message       event.data IS the message: { id, role:'user', content,
//                      source:{ kind, ... } }, so the source is event.data.source.
//                      (@deepseek-ai/dsh-session types.d.ts: 'user/message': UserMessage;
//                      @deepseek-ai/dsh-tool-goal reads event.data.source.kind === 'user'.)
//   assistant/message  { turn, step, message:{ role:'assistant', content:[...] }, ... }
//   turn/end           { turn, reason:{ kind } }; kind is one of completed, aborted,
//                      blocked, error, max-tokens, interrupted, forked.
//   content blocks     { type:'text' | 'reasoning' | 'tool-call' | ... }
//                      (@deepseek-ai/dsh-llm types.d.ts).

/** V4 rejects the bare `plugin` kind; a plugin-owned source is `plugin:<name>`. */
export const PLUGIN_SOURCE_KIND = 'plugin:continue-kicker'

/** Source kind of a message the human typed. */
export const USER_SOURCE_KIND = 'user'

/** Turn-end kinds the plugin may kick on. */
const KICKABLE_KINDS = ['interrupted', 'max-tokens']

/** Flavors whose kicks count toward the runaway guard. */
const COUNTED_FLAVORS = ['max-tokens', 'empty-completion']

/**
 * Walks backward from just before `idx` for the assistant message that belongs
 * to the turn ending at `idx`; returns null on reaching a turn boundary or a
 * user message first, which would mean walking into a different turn.
 */
function lastAssistantMessageBefore(events, idx) {
  for (let i = idx - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'assistant/message') return e
    if (e.type === 'turn/end' || e.type === 'turn/start' || e.type === 'user/message') return null
  }
  return null
}

function contentOf(assistantEvent) {
  const content = assistantEvent?.data?.message?.content
  return Array.isArray(content) ? content : []
}

/** True when the message has a non-empty text block or any tool call. */
export function hasRealContent(assistantEvent) {
  return contentOf(assistantEvent).some((b) => {
    if (b?.type === 'tool-call') return true
    if (b?.type === 'text') return (b.text ?? '').trim().length > 0
    return false
  })
}

export function reasoningCharCount(assistantEvent) {
  return contentOf(assistantEvent).reduce((sum, b) => (b?.type === 'reasoning' ? sum + (b.text ?? '').length : sum), 0)
}

/**
 * Classifies the tail of a session's event array.
 * Returns { action:'kick', flavor } or { action:'none', why }, plus:
 *   completedTurn       the tail boundary is a completed turn (counter reset)
 *   genuineUserActivity a message the human typed sits at the tail (counter
 *                       reset, and the "already recovered" exclusion)
 * A tail user-role message from any other producer (this plugin's own kick, a
 * goal, another plugin) is not genuine and never resets the counter.
 */
export function analyzeTail(events, settings) {
  if (!events || events.length === 0) return { action: 'none', why: 'empty session' }

  let boundary = null
  let boundaryIdx = -1
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'user/message') {
      const kind = e.data?.source?.kind
      if (kind === USER_SOURCE_KIND) {
        return { action: 'none', why: 'tail has a genuine user message (recovered or active)', genuineUserActivity: true }
      }
      return {
        action: 'none',
        why: kind === PLUGIN_SOURCE_KIND ? 'tail has a plugin kick awaiting its result' : `tail has a user-role message from source '${kind}'`,
        genuineUserActivity: false,
      }
    }
    if (e.type === 'assistant/message') {
      return { action: 'none', why: 'tail has an assistant message after the last turn/end' }
    }
    if (e.type === 'turn/end') {
      boundary = e
      boundaryIdx = i
      break
    }
  }
  if (!boundary) return { action: 'none', why: 'no turn/end found' }

  const kind = boundary.data?.reason?.kind
  if (kind === 'completed') {
    if (settings.kickOnEmptyCompletion) {
      const msg = lastAssistantMessageBefore(events, boundaryIdx)
      if (msg && !hasRealContent(msg) && reasoningCharCount(msg) >= settings.emptyCompletionMinReasoningChars) {
        return { action: 'kick', flavor: 'empty-completion' }
      }
    }
    return { action: 'none', why: 'last turn completed', completedTurn: true }
  }
  if (kind === 'aborted') return { action: 'none', why: 'last turn aborted by user' }
  if (kind === 'error') return { action: 'none', why: 'last turn errored' }
  if (!KICKABLE_KINDS.includes(kind)) return { action: 'none', why: `unhandled reason kind '${kind}'` }

  if (kind === 'interrupted') {
    if (!settings.kickOnInterrupted) return { action: 'none', why: 'kickOnInterrupted disabled' }
    return { action: 'kick', flavor: 'interrupted' }
  }
  // max-tokens: the API reported this generation was cut off by the output
  // budget, never a model-chosen stop, so no content-shape check is needed.
  if (!settings.kickOnMaxTokens) return { action: 'none', why: 'kickOnMaxTokens disabled' }
  return { action: 'kick', flavor: 'max-tokens' }
}

function kickText(flavor, settings) {
  if (flavor === 'max-tokens') return settings.maxTokensKickText
  if (flavor === 'empty-completion') return settings.emptyCompletionKickText
  return settings.interruptedKickText
}

/** Longest one-line notice summary V4 accepts without ellipsizing. */
export const SUMMARY_MAX_CHARS = 120

export function boundSummary(summary) {
  return summary.length > SUMMARY_MAX_CHARS ? `${summary.slice(0, SUMMARY_MAX_CHARS - 1)}…` : summary
}

function kickSummary(flavor, count, max) {
  if (flavor === 'max-tokens') return boundSummary(`Auto-resumed after a max-tokens halt (${count}/${max})`)
  if (flavor === 'empty-completion') return boundSummary(`Auto-resumed after a reasoning-only completion with no answer (${count}/${max})`)
  return 'Auto-resumed after an interrupted turn'
}

/**
 * The whole decision for one analysis of one session.
 *
 * @param {object} input
 * @param {readonly object[]} input.events - the session's event snapshot.
 * @param {object} input.settings - resolved settings (src/config.mjs).
 * @param {number} input.consecutive - kicks counted since the last reset signal.
 * @param {number} input.lastKickAt - timestamp of this session's last kick (0 if none).
 * @param {number} input.now - current timestamp.
 * @param {boolean} input.isSubagent - the session is a delegated child.
 * @returns {{ action:'kick'|'skip'|'stop', why:string, consecutive:number,
 *             flavor?:string, text?:string, summary?:string, scopeSkipped?:true }}
 *   `consecutive` is the counter the caller must store; on 'kick' the caller
 *   also stores `now` as the session's lastKickAt.
 */
export function decide({ events, settings, consecutive, lastKickAt, now, isSubagent }) {
  const verdict = analyzeTail(events, settings)

  let count = consecutive ?? 0
  if (verdict.completedTurn || verdict.genuineUserActivity) count = 0

  if (isSubagent && !settings.includeSubagents) {
    return { action: 'skip', why: 'subagent session excluded (includeSubagents=false)', consecutive: count, scopeSkipped: true }
  }
  if (verdict.action !== 'kick') return { action: 'skip', why: verdict.why, consecutive: count }

  const { flavor } = verdict
  if (settings.maxConsecutiveKicks === 0) {
    return { action: 'skip', why: 'kicking disabled (maxConsecutiveKicks=0)', consecutive: count }
  }
  if (count >= settings.maxConsecutiveKicks) {
    return {
      action: 'stop',
      why: `${count} consecutive plugin kicks without progress (runaway guard, maxConsecutiveKicks=${settings.maxConsecutiveKicks})`,
      consecutive: count,
    }
  }

  const sinceLast = now - (lastKickAt ?? 0)
  if (sinceLast < settings.cooldownMs) {
    return { action: 'skip', why: `within cooldown (${settings.cooldownMs - sinceLast}ms remaining)`, consecutive: count }
  }

  if (COUNTED_FLAVORS.includes(flavor)) count += 1
  return {
    action: 'kick',
    why: `halt flavor ${flavor}`,
    flavor,
    consecutive: count,
    text: kickText(flavor, settings),
    summary: kickSummary(flavor, count, settings.maxConsecutiveKicks),
  }
}
