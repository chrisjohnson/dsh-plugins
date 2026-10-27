// dsh-kanban: the role tool guard.
//
// This is the control, not the prompt. A role session may execute a tool only
// when its configured allow-list names it; the guard is monotonic (it can deny,
// never allow) and runs for every call in the role agent's scope.
//
// Kanban action tools are registered inside the target session and enforce their
// own phase; the guard lets those names through and checks ordinary tools.

export function roleToolGuard(role, allow) {
  const allowed = new Set(Array.isArray(allow) ? allow : [])
  return function guard(execution) {
    const name = execution === null || execution === undefined ? undefined : execution.name
    if (typeof name !== 'string' || name === '') return `kanban: role "${role}" may not call an unnamed tool`
    if (name.startsWith('kanban_')) return undefined
    return allowed.has(name) ? undefined : `kanban: role "${role}" may not call "${name}"`
  }
}

/** Allow-list guard whose role changes between turns of one shared session. */
export function phaseToolGuard(getRole, getRoles) {
  return function guard(execution) {
    const role = getRole()
    const entry = getRoles()[role]
    const allow = entry === undefined || !Array.isArray(entry.allowTools) ? [] : entry.allowTools
    const name = execution === null || execution === undefined ? undefined : execution.name
    if (typeof name !== 'string' || name === '') return `kanban: role "${role}" may not call an unnamed tool`
    if (name.startsWith('kanban_')) return undefined
    return allow.includes(name) ? undefined : `kanban: role "${role}" may not call "${name}"`
  }
}

/** The names a role may call, for tests and for the prompt's "allowed tools" line. */
export function allowedTools(allow) {
  return Array.isArray(allow) ? allow.slice() : []
}
