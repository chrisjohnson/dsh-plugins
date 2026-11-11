// dsh-kanban: which sessions are offered the board's ticket-management tools.
//
// KAN-81 gives every interactive session the five management tools the
// orchestrator already had (src/orchestrator.mjs: MANAGEMENT_TOOL_SPECS). That
// raises one question this module answers, and it is the only one worth
// isolating: *who must not have them*.
//
// The answer is a session the board already owns. A planner, implementer,
// reviewer or build session is a role working *a* ticket; handing it the board's
// management tools would let it edit or discard the very card it is paid to
// finish — a worker rewriting its own brief, or ending itself because the review
// came back harsh. Those sessions act on their ticket through the workflow, not
// around it. Everything else on the host — a person's chat session, a scheduled
// job, a session doing unrelated work — is exactly who the feature is for.
//
// "Owned by the board" is one cheap store lookup: `sessions` holds a row for every
// session attached to a ticket, so `findSession` answers it without a join. The
// permanent orchestrator session has no such row (it belongs to no ticket) and
// keeps its own scoped registration of the same five specs, which shadows the
// global one — so it is unaffected either way.
//
// Pure on purpose, like the rest of the decision modules: no @deepseek-ai/*
// import, so every branch here is testable on a bare clone. The Cordis wiring in
// src/host.mjs hands in the store and the harness's own activation context.

/**
 * The session id of a harness Agent, however the caller's object is shaped.
 *
 * `ToolActivationContext.agent` is typed as just `{ id }`, while a tool's
 * `exec.agent` is the full Agent, whose `session.header.id` is the durable
 * identity the board stores. Both spell the same string; this prefers the durable
 * one and falls back so a thinner context still resolves rather than silently
 * looking like "no agent".
 *
 * @param {object|null|undefined} agent
 * @returns {string|null} the session id, or null when there is nothing to key on.
 */
export function agentSessionId(agent) {
  if (agent === null || agent === undefined) return null;
  const durable = agent.session?.header?.id ?? agent.session?.id;
  if (typeof durable === 'string' && durable !== '') return durable;
  if (typeof agent.id === 'string' && agent.id !== '') return agent.id;
  return null;
}

/**
 * Whether this session is a role session the board spawned for a ticket.
 *
 * A missing store or an unmounted lookup says *not owned*: the switch is a
 * restriction, and a restriction that cannot be checked must not remove a tool
 * the deployment asked for — the same way an unreadable guard fails open on
 * visibility rather than blanking the board.
 *
 * @param {{findSession?: (id: string) => object|undefined}|null|undefined} store
 * @param {string|null|undefined} sessionId
 * @returns {boolean}
 */
export function isBoardOwnedSession(store, sessionId) {
  if (store === null || store === undefined || typeof store.findSession !== 'function') return false;
  if (typeof sessionId !== 'string' || sessionId === '') return false;
  return store.findSession(sessionId) !== undefined;
}

/**
 * The `when` condition for one globally-registered management tool
 * (`tools.register(definition, { when })`).
 *
 * It is called with the step's activation context, so it answers "may *this*
 * agent see this tool this step", once per tool per step — cheap, because the
 * board lookup is a single indexed read.
 *
 * @param {object} store - the KanbanStore.
 * @returns {(context: {agent?: object}) => boolean}
 */
export function managementToolWhen(store) {
  return (context) => {
    const agent = context?.agent;
    // No agent in context means the caller is not a scoped agent view; there is
    // no ticket for it to interfere with, so the tool stays available.
    if (agent === null || agent === undefined) return true;
    return isBoardOwnedSession(store, agentSessionId(agent)) === false;
  };
}

/**
 * The actor string a board write from an ordinary session is credited to.
 *
 * The orchestrator's writes are credited `orchestrator`; these are credited to
 * the session that made them, so the ticket's event log says *which* session
 * filed, edited or discarded the card rather than reducing every interactive
 * actor to one anonymous `agent`. The `agent:` prefix also keeps the value out
 * of the vocabulary the digest filter uses for the orchestrator's own moves.
 *
 * @param {object|null|undefined} agent
 * @returns {string}
 */
export function managementActor(agent) {
  const sessionId = agentSessionId(agent);
  return sessionId === null ? 'agent' : `agent:${sessionId}`;
}
