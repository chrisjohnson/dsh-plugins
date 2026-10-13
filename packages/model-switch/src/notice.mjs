// The source attached to the user-role message this plugin steers into a session
// after a switch. No dsh imports, so the shape is testable on a bare clone.
//
// Session format V4 refuses a message whose `source.kind` is the retired shared
// `'plugin'` value when it is read back, so a session written that way cannot be
// reopened after a restart. A producer names itself in `kind`: for a plugin that is
// `plugin:<name>`, the same mapping the V3 -> V4 migrator applies to old logs.

export const SOURCE_KIND = 'plugin:model-switch'

// A `notice` summary is committed to the durable log; dsh bounds it to this many
// characters (CONTEXT_SUMMARY_MAX_CHARS in @deepseek-ai/dsh-llm), so the bound is
// applied here rather than leaving a long route name to be truncated by the host.
export const SUMMARY_MAX_CHARS = 120

export function boundSummary(summary) {
  const text = String(summary)
  return text.length <= SUMMARY_MAX_CHARS ? text : `${text.slice(0, SUMMARY_MAX_CHARS - 1)}…`
}

/** The `source` of a switch notice: producer-owned kind, `notice` form, one-line summary. */
export function noticeSource(summary) {
  return { kind: SOURCE_KIND, form: 'notice', summary: boundSummary(summary) }
}
