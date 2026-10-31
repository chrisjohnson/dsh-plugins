// dsh-kanban: the human edit boundary.
//
// Every write a person makes from the board goes through this file; every write
// the engine makes goes straight to the store. That split is the whole design.
// The lock — "a ticket that has started is no longer editable" — must not stop
// reorder, worktree creation or a retry patch, so it cannot live in
// `store.updateTicket`; it lives here, at the one place humans write.
//
// Decisions with branches live here, where a test can reach them without a
// Cordis host, so `src/host.mjs` stays thin wiring.

const message = (error) => (error && error.message ? error.message : String(error));
const fail = (code, text, details = {}) => ({ ok: false, error: { code, message: text, details } });

/** The error code every locked human edit answers with. */
export const TICKET_STARTED = 'ticket_started';

/** The one lock message, so every human path says the same thing. */
export function startedFailure(ticket) {
  return fail(
    TICKET_STARTED,
    `${ticket.key} has already started; it can no longer be edited`,
    { id: ticket.id, key: ticket.key, column: ticket.column, phase: ticket.phase },
  );
}

/** A store throw is a client-facing answer, never a 500 from this boundary. */
function fromStoreError(error) {
  return fail(String(error && error.code ? error.code : 'internal'), message(error), (error && error.details) || {});
}

function value(store, ticket) {
  return { ok: true, value: { ticket: store.getTicket(ticket.id), acceptance: store.listAcceptance(ticket.id) } };
}

/**
 * Apply one human edit: the ticket fields plus, optionally, the whole
 * acceptance list, in a single call so the unified editor saves at once.
 *
 * `acceptance` is pulled out of the patch and routed to `setAcceptance`; the
 * remaining fields go to `updateTicket` untouched, which is what keeps the
 * store's own validation (modes, paid-needs-budget) in one place. The
 * acceptance list is validated before anything is written, so a bad line can
 * never leave a half-applied edit.
 */
export function editTicket(store, idOrKey, patch = {}, { reason = 'ticket edit' } = {}) {
  const ticket = store.getTicket(idOrKey);
  if (ticket === undefined) return fail('not_found', `no ticket ${idOrKey}`);
  if (!store.isEditable(ticket.id)) return startedFailure(ticket);
  const input = patch !== null && typeof patch === 'object' ? patch : {};
  const replacesAcceptance = input.acceptance !== undefined;
  if (replacesAcceptance && !Array.isArray(input.acceptance)) {
    return fail('bad_request', 'acceptance must be an array of statements');
  }
  if (replacesAcceptance) {
    for (const statement of input.acceptance) {
      if (typeof statement !== 'string' || statement.trim() === '') {
        return fail('bad_request', 'every acceptance statement must be a non-empty string');
      }
    }
  }
  const fields = {};
  for (const [key, entry] of Object.entries(input)) {
    if (key !== 'acceptance') fields[key] = entry;
  }
  try {
    if (Object.keys(fields).length > 0) store.updateTicket(ticket.id, fields, { actor: 'human', reason });
    if (replacesAcceptance) store.setAcceptance(ticket.id, input.acceptance, { reason });
  } catch (error) {
    return fromStoreError(error);
  }
  return value(store, ticket);
}

/** Append one acceptance statement. Locked by the same rule as any edit. */
export function appendAcceptance(store, idOrKey, statement) {
  const ticket = store.getTicket(idOrKey);
  if (ticket === undefined) return fail('not_found', `no ticket ${idOrKey}`);
  if (!store.isEditable(ticket.id)) return startedFailure(ticket);
  try {
    store.addAcceptance(ticket.id, statement, 'human');
  } catch (error) {
    return fromStoreError(error);
  }
  return value(store, ticket);
}

/** Replace the acceptance list on its own. Locked by the same rule as any edit. */
export function replaceAcceptance(store, idOrKey, statements, { reason = 'acceptance edit' } = {}) {
  const ticket = store.getTicket(idOrKey);
  if (ticket === undefined) return fail('not_found', `no ticket ${idOrKey}`);
  if (!store.isEditable(ticket.id)) return startedFailure(ticket);
  try {
    store.setAcceptance(ticket.id, statements, { reason });
  } catch (error) {
    return fromStoreError(error);
  }
  return value(store, ticket);
}
