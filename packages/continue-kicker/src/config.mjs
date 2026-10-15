// Configuration resolution for continue-kicker. Pure: imports nothing from dsh.
//
// Every tunable is a config key with a default here. A key that is unset, or
// set to something unusable, falls back to its default and (for the unusable
// case) produces one warning, so a typo never silently changes behaviour.

export const DEFAULT_CONFIG = Object.freeze({
  cooldownMs: 60000,
  liveKickDelayMs: 3000,
  maxConsecutiveKicks: 5,
  kickOnInterrupted: true,
  kickOnMaxTokens: true,
  kickOnEmptyCompletion: true,
  kickOnError: false,
  includeSubagents: false,
  emptyCompletionMinReasoningChars: 500,
  interruptedKickText:
    'The previous turn was interrupted before producing a response. Please continue from where you left off.',
  maxTokensKickText:
    'Your previous response hit the output token limit before finishing. Do NOT re-derive your thinking from scratch: briefly state your conclusion, then immediately take your next concrete action (make the tool call or give the answer). Be succinct - long reasoning is what hit the limit last time.',
  errorKickText:
    'The previous turn failed with an error and was cut off before it finished. Please continue from where you left off.',
  emptyCompletionKickText:
    'Your previous response reasoned at length but never reached a conclusion or took an action - it ended with no answer and no tool call. Do NOT re-derive your thinking from scratch: state your conclusion now and immediately take your next concrete action (make the tool call or give the answer). Be decisive - reconsidering the same point repeatedly is what caused this.',
})

const NON_NEGATIVE_INTEGERS = ['cooldownMs', 'liveKickDelayMs', 'maxConsecutiveKicks', 'emptyCompletionMinReasoningChars']
const BOOLEANS = ['kickOnInterrupted', 'kickOnMaxTokens', 'kickOnEmptyCompletion', 'kickOnError', 'includeSubagents']
const TEXTS = ['interruptedKickText', 'maxTokensKickText', 'emptyCompletionKickText', 'errorKickText']

/**
 * @param {unknown} config - the plugin row's `config` object (may be absent).
 * @returns {{ settings: typeof DEFAULT_CONFIG, warnings: string[] }}
 */
export function resolveSettings(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const settings = { ...DEFAULT_CONFIG }
  const warnings = []

  for (const key of Object.keys(raw)) {
    if (!(key in DEFAULT_CONFIG)) warnings.push(`unknown config key "${key}" ignored`)
  }
  for (const key of NON_NEGATIVE_INTEGERS) {
    if (raw[key] === undefined) continue
    if (Number.isInteger(raw[key]) && raw[key] >= 0) settings[key] = raw[key]
    else warnings.push(`${key} must be a non-negative integer (got ${JSON.stringify(raw[key])}); using ${DEFAULT_CONFIG[key]}`)
  }
  for (const key of BOOLEANS) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] === 'boolean') settings[key] = raw[key]
    else warnings.push(`${key} must be true or false (got ${JSON.stringify(raw[key])}); using ${DEFAULT_CONFIG[key]}`)
  }
  for (const key of TEXTS) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] === 'string' && raw[key].trim().length > 0) settings[key] = raw[key]
    else warnings.push(`${key} must be a non-empty string; using the built-in text`)
  }
  return { settings, warnings }
}
