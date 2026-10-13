// Reading session events: transcript lines for the model, and the deterministic
// repetition fingerprint. No dsh imports; every function takes plain event
// objects, so the tests feed it the shapes the harness really writes.
//
// SESSION FORMAT V4 event shapes this module reads (dsh-session 0.2.0):
//
//   user/message       data IS the message:  { id, role:'user', content, source }
//   assistant/message  data.message is the message; its content holds
//                      { type:'tool-call', id, name, arguments: <raw JSON string> }
//   tool/call          data: { turn, step, callId, name, arguments }
//                      (dsh-agent-loop appendToolCall)
//   tool/result        data.message is a first-class tool-role message:
//                      { id, role:'tool', toolCallId, isError?, source:{kind:'tool', callId},
//                        content: [{ type:'text', text }, ...] }
//                      (dsh-agent-loop appendToolResult -> createToolResultMessage;
//                      dsh-session surface fold: user/message -> event.data,
//                      the other surface events -> event.data.message)
//
// The tool result's call id is message.toolCallId, NOT a field on content[0], and
// its text is the content array itself, not a nested `tool-result` block.

/** Cap on one summarised transcript line. */
const LINE_CAP = 300
/** Cap on one block of tool output inside a line. */
const BLOCK_CAP = 80

/** Message-bearing event types and where the message sits. */
const MESSAGE_TYPES = new Set(['assistant/message', 'tool/result', 'system/message', 'developer/message'])

/**
 * The conversation message an event carries, or null for events that carry none.
 * A bare message object (no `type`) is returned as-is so a caller holding the
 * message itself can still summarise it.
 */
export function eventMessage(e) {
  if (!e || typeof e !== 'object') return null
  if (e.type === 'user/message') return e.data && typeof e.data === 'object' ? e.data : null
  if (MESSAGE_TYPES.has(e.type)) return e.data?.message ?? null
  if (e.type === undefined && typeof e.role === 'string') return e
  return null
}

/** Text of a tool-role message: its text blocks joined, other blocks named by type. */
export function toolResultText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (block?.type === 'text') return String(block.text ?? '')
      return block?.type ? `[${block.type}]` : ''
    })
    .join(' ')
}

function argumentText(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** One human-readable line for the transcript the model judges and the ledger records. */
export function summarizeEvent(e) {
  if (!e || typeof e !== 'object') return `[raw] ${String(e)}`

  if (e.type === 'turn/start') return `[turn/start #${e.data?.turn ?? '?'}]`
  if (e.type === 'turn/end') return `[turn/end reason=${e.data?.reason?.kind ?? '?'}]`

  const msg = eventMessage(e)
  const role = msg?.role ?? e.role ?? String(e.type ?? 'unknown')

  let text = ''
  const content = msg?.content
  if (role === 'tool' && Array.isArray(content)) {
    text = toolResultText(msg)
    if (msg.isError === true) text = `[error] ${text}`
  } else if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (!block) continue
      if (block.type === 'text') parts.push(String(block.text ?? ''))
      else if (block.type === 'reasoning') parts.push(`[reasoning ${String(block.text ?? '').length} chars]`)
      else if (block.type === 'tool-call') {
        parts.push(`${block.name ?? 'unknown'}(${argumentText(block.arguments).slice(0, BLOCK_CAP)})`)
      } else if (block.type === 'file') parts.push(`[file: ${block.attachment?.name ?? '?'}]`)
      else parts.push(`[${block.type}]`)
    }
    text = parts.join(' ')
  } else if (typeof content === 'string') {
    text = content
  }

  if (text.length > LINE_CAP) text = `${text.slice(0, LINE_CAP)}...`
  return `[Role: ${role}] ${text || '[non-text event]'}`
}

/**
 * Harness lifecycle events that carry no agent decision-making. They come from
 * turn boundaries, process restarts (synthetic `turn/end reason=interrupted`)
 * and inbox splices (kickers' injections). When they dominate the last-N window
 * they read to the classifier as a repeating pattern, the main source of false
 * LOOP verdicts, so they are dropped before the transcript is built.
 */
export const NOISE_EVENT_TYPES = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'session/end-seed',
  'agent/inbox/spliced',
  'request/header',
  'system/message',
  'llm/retry',
  'llm/retry-started',
])

/** Whether an event is real user/assistant/tool activity worth showing the model. */
export function isSubstantive(e) {
  if (!e || typeof e !== 'object') return false
  if (NOISE_EVENT_TYPES.has(e.type)) return false
  const msg = eventMessage(e)
  // An empty tool result is itself the signal ("the search returned nothing"),
  // so every tool-role message counts.
  if (msg?.role === 'tool') return true
  const content = msg?.content
  if (Array.isArray(content)) {
    return content.some((b) => {
      if (!b) return false
      if (b.type === 'tool-call' || b.type === 'file') return true
      if (b.type === 'text' && String(b.text ?? '').trim().length > 0) return true
      return false
    })
  }
  return typeof content === 'string' && content.trim().length > 0
}

// ================================================================
// DETERMINISTIC FINGERPRINT (no model call)
// The discriminating axis is repetition with NO new information: hash (tool
// name, normalised args) over a wide raw tail and flag
//   count >= 3 with <= 1 distinct result (all-empty included), or
//   count >= 5 with <= 2 distinct results.
// It cannot hallucinate confidence, and it decides on its own; the model only
// adjudicates windows it did not settle.
// ================================================================

export function normArgs(a) {
  return argumentText(a).replace(/\s+/g, ' ').trim()
}

/**
 * {id, name, args, result} per tool call in the events. `tool/call` events are
 * the canonical per-call records; each is matched to its `tool/result` by
 * call id (`message.toolCallId`).
 */
export function extractCalls(events) {
  const calls = []
  const byId = new Map()
  for (const e of events) {
    if (e?.type !== 'tool/call') continue
    const c = { id: e.data?.callId, name: e.data?.name ?? 'unknown', args: normArgs(e.data?.arguments), result: '' }
    calls.push(c)
    if (c.id) byId.set(c.id, c)
  }
  for (const e of events) {
    if (e?.type !== 'tool/result') continue
    const message = e.data?.message
    const target = byId.get(message?.toolCallId ?? message?.source?.callId)
    if (target) target.result = toolResultText(message).trim().slice(0, 200)
  }
  return calls
}

/**
 * The FULL code-layer result, not just the stuck subset: the evals panel shows
 * what the deterministic layer actually saw (how many calls, how many distinct
 * fingerprints, which repeated), so a "found nothing" verdict is inspectable.
 */
export function fingerprintReport(events) {
  const groups = new Map()
  let calls = 0
  for (const c of extractCalls(events)) {
    calls++
    const fp = `${c.name}|${c.args.slice(0, 120)}`
    if (!groups.has(fp)) groups.set(fp, { fp, count: 0, results: new Set() })
    const g = groups.get(fp)
    g.count++
    g.results.add(c.result || '(empty)')
  }
  const stuck = []
  const all = []
  for (const g of groups.values()) {
    const d = g.results.size
    const entry = { fp: g.fp, count: g.count, distinctResults: d }
    all.push(entry)
    if ((g.count >= 3 && d <= 1) || (g.count >= 5 && d <= 2)) stuck.push(entry)
  }
  all.sort((a, b) => b.count - a.count)
  return { stuck, groups: all, calls }
}
