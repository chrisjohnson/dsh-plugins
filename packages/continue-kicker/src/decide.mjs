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
//                      blocked, error, max-tokens, interrupted, forked. An error
//                      reason is { kind:'error', error:{ message, code, status?, ... } }
//                      (LlmFailure, @deepseek-ai/dsh-llm types.d.ts; TurnEndReasonMap in
//                      @deepseek-ai/dsh-session types.d.ts).
//   content blocks     { type:'text' | 'reasoning' | 'tool-call' | ... }
//                      (@deepseek-ai/dsh-llm types.d.ts).

import { DEFAULT_CONFIG } from './config.mjs'

/** V4 rejects the bare `plugin` kind; a plugin-owned source is `plugin:<name>`. */
export const PLUGIN_SOURCE_KIND = 'plugin:continue-kicker'

/** Source kind of a message the human typed. */
export const USER_SOURCE_KIND = 'user'

/** Turn-end kinds the plugin may kick on. */
const KICKABLE_KINDS = ['interrupted', 'max-tokens']


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

/** True for a completed turn whose final assistant message is reasoning only (a kickable halt). */
function isEmptyCompletion(events, turnEndIdx, settings) {
  if (!settings.kickOnEmptyCompletion) return false
  const msg = lastAssistantMessageBefore(events, turnEndIdx)
  return Boolean(msg) && !hasRealContent(msg) && reasoningCharCount(msg) >= settings.emptyCompletionMinReasoningChars
}

function firstText(message) {
  const block = Array.isArray(message?.content) ? message.content.find((b) => b?.type === 'text') : undefined
  return block?.text
}

/**
 * True for a user/message event this plugin sent. Current kicks carry source
 * kind PLUGIN_SOURCE_KIND. The retired bare kind 'plugin' (written before
 * session format V4) counts only when it names this plugin and carries one of
 * the known kick texts, so another plugin's bare-kind message is never miscounted.
 */
export function isKickMessage(event, settings) {
  if (event?.type !== 'user/message') return false
  const source = event.data?.source
  if (source?.kind === PLUGIN_SOURCE_KIND) return true
  if (source?.kind !== 'plugin' || source.plugin !== 'continue-kicker') return false
  const text = firstText(event.data)
  const known = [settings, DEFAULT_CONFIG].flatMap((c) => [c.interruptedKickText, c.maxTokensKickText, c.emptyCompletionKickText, c.errorKickText])
  return known.includes(text)
}

/**
 * Consecutive kicks this plugin has sent, derived from the session's own events
 * so it survives restarts and agrees between the live and reopen paths. Walks
 * back from the tail counting kick messages (every flavor together) and stops
 * at the nearest reset signal: a genuine user message (source kind 'user'), or
 * a turn that completed normally. A reasoning-only completion is a kickable
 * halt, not progress, so it does not reset.
 */
export function countConsecutiveKicks(events, settings) {
  let count = 0
  for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'user/message') {
      if (e.data?.source?.kind === USER_SOURCE_KIND) break
      if (isKickMessage(e, settings)) count += 1
    } else if (e.type === 'turn/end' && e.data?.reason?.kind === 'completed' && !isEmptyCompletion(events, i, settings)) {
      break
    }
  }
  return count
}

/**
 * Classifies the tail of a session's event array.
 * Returns { action:'kick', flavor } or { action:'none', why }. A tail
 * user-role message means the session was already recovered (or a kick is
 * awaiting its result), so nothing is kicked. Reset signals are not decided
 * here; see countConsecutiveKicks.
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
        return { action: 'none', why: 'tail has a genuine user message (recovered or active)' }
      }
      return {
        action: 'none',
        why: kind === PLUGIN_SOURCE_KIND ? 'tail has a plugin kick awaiting its result' : `tail has a user-role message from source '${kind}'`,
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
    if (isEmptyCompletion(events, boundaryIdx, settings)) return { action: 'kick', flavor: 'empty-completion' }
    return { action: 'none', why: 'last turn completed' }
  }
  if (kind === 'aborted') return { action: 'none', why: 'last turn aborted by user' }
  if (kind === 'error') {
    // A failed turn (`reason.error` is the LlmFailure: message, code, ...). The
    // other non-completing kinds are deliberate or have their own flavor and
    // never reach this branch: aborted is a user or system cancel, blocked is a
    // pre-step rejection, forked is a fork-seed marker.
    if (!settings.kickOnError) return { action: 'none', why: 'last turn errored (kickOnError disabled)' }
    return { action: 'kick', flavor: 'error' }
  }
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
  if (flavor === 'error') return settings.errorKickText
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
  if (flavor === 'error') return boundSummary(`Auto-resumed after a failed turn (${count}/${max})`)
  return 'Auto-resumed after an interrupted turn'
}

/**
 * The whole decision for one analysis of one session. Stateless apart from the
 * cooldown: the consecutive-kick count comes from the events themselves.
 *
 * @param {object} input
 * @param {readonly object[]} input.events - the session's event snapshot.
 * @param {object} input.settings - resolved settings (src/config.mjs).
 * @param {number} input.lastKickAt - timestamp of this process's last kick for the session (0 if none).
 * @param {number} input.now - current timestamp.
 * @param {boolean} input.isSubagent - the session is a delegated child.
 * @returns {{ action:'kick'|'skip'|'stop', why:string, consecutive:number,
 *             flavor?:string, text?:string, summary?:string, scopeSkipped?:true }}
 *   `consecutive` is the count including the kick being sent; on 'kick' the
 *   caller records `now` as the session's lastKickAt.
 */
export function decide({ events, settings, lastKickAt, now, isSubagent }) {
  const verdict = analyzeTail(events, settings)
  const count = countConsecutiveKicks(events, settings)

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

  return {
    action: 'kick',
    why: `halt flavor ${flavor}`,
    flavor,
    consecutive: count + 1,
    text: kickText(flavor, settings),
    summary: kickSummary(flavor, count + 1, settings.maxConsecutiveKicks),
  }
}
