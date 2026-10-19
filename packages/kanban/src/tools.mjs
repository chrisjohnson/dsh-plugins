// dsh-kanban: the role tool guard.
//
// This is the control, not the prompt. A role session may execute a tool only
// when its configured allow-list names it; the guard is monotonic (it can deny,
// never allow) and runs for every call in the role agent's scope.
//
// The plugin registers no board tools at all, so no allow-list entry can name
// one: ticket mutation has no tool surface inside a role session.

export function roleToolGuard(role, allow) {
  const allowed = new Set(Array.isArray(allow) ? allow : [])
  return function guard(execution) {
    const name = execution === null || execution === undefined ? undefined : execution.name
    if (typeof name !== 'string' || name === '') return `kanban: role "${role}" may not call an unnamed tool`
    return allowed.has(name) ? undefined : `kanban: role "${role}" may not call "${name}"`
  }
}

/** The names a role may call, for tests and for the prompt's "allowed tools" line. */
export function allowedTools(allow) {
  return Array.isArray(allow) ? allow.slice() : []
}
