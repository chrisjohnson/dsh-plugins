// dsh-kanban: the Model routing write path, as a decision module.
//
// The dialog sends one item per role; this file decides what is acceptable and
// what the profile row should look like afterwards. It imports nothing from
// `@deepseek-ai/*`: the host passes in a `resolveModel(provider, model)` lookup
// so the exact-catalog checks here are the same ones `src/host.mjs` performs at
// boot and on reload, and so they can be tested without a harness.

/**
 * One `reasoningEffort` from a client payload, as stored config.
 *
 * `null`, `undefined` and `''` all mean "no explicit level — use whatever the
 * route's default is", which is what the dialog's **Default** option sends. Any
 * other non-string is a client error rather than something to coerce.
 */
export function normalizeEffort(value) {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, message: 'reasoningEffort must be a string or null' };
  const trimmed = value.trim();
  return { ok: true, value: trimmed === '' ? null : trimmed };
}

/** The effort ids one resolved model offers, as an array (empty when it is not a reasoning model). */
export function offeredEfforts(info) {
  const efforts = info && info.reasoning && Array.isArray(info.reasoning.efforts) ? info.reasoning.efforts : [];
  return efforts.filter((effort) => effort !== null && typeof effort === 'object' && typeof effort.id === 'string' && effort.id !== '');
}

/**
 * Check one requested effort against one resolved model.
 *
 * Returns `{ ok: true, value }` (value is null for "no explicit level") or
 * `{ ok: false, message }` naming the role, the model and what it offers.
 */
export function checkEffort({ role, provider, model, effort, info }) {
  const normalized = normalizeEffort(effort);
  if (!normalized.ok) return { ok: false, message: `role ${role}: ${normalized.message}` };
  if (normalized.value === null) return { ok: true, value: null };
  const offered = offeredEfforts(info);
  if (offered.length === 0) {
    return { ok: false, message: `role ${role}: model "${provider}/${model}" offers no reasoning effort levels` };
  }
  if (!offered.some((entry) => entry.id === normalized.value)) {
    return { ok: false, message: `role ${role}: effort "${normalized.value}" is not offered by model "${provider}/${model}" (offers: ${offered.map((entry) => entry.id).join(', ')})` };
  }
  return { ok: true, value: normalized.value };
}

/**
 * Validate a whole `setRoutes` payload into the routes to persist.
 *
 * @param {object} input
 * @param {unknown} input.items - the raw `routes` array from the client.
 * @param {object} input.roles - the live role config, used as the set of known roles.
 * @param {Iterable<string>} input.providers - provider ids the host currently offers.
 * @param {(provider: string) => Promise<Array<{id: string}>>} input.listModels
 *   the models one provider advertises; an empty list is treated as "unknown" and
 *   admits any model id, exactly as the endpoint has always done.
 * @param {(provider: string, model: string) => Promise<object|null|undefined>} input.resolveModel
 *   exact model metadata, or null/undefined when the catalog cannot be read.
 * @returns {Promise<{ ok: true, routes: Array<{role: string, provider: string, model: string, reasoningEffort: string|null}> } | { ok: false, code: string, message: string }>}
 */
export async function prepareRoutes({ items, roles, providers, listModels, resolveModel }) {
  const known = new Set(Object.keys(roles ?? {}));
  const hostProviders = new Set(providers ?? []);
  const list = Array.isArray(items) ? items : [];
  const routes = [];
  for (const item of list) {
    const role = String(item?.role ?? '');
    if (!known.has(role)) return { ok: false, code: 'bad_request', message: `unknown role "${role}"` };
    const provider = String(item?.provider ?? '');
    const model = String(item?.model ?? '');
    if (provider === '' || model === '') return { ok: false, code: 'bad_request', message: `role ${role} needs both provider and model` };
    if (!hostProviders.has(provider)) return { ok: false, code: 'bad_request', message: `provider "${provider}" is not offered by the host` };
    const offered = typeof listModels === 'function' ? await listModels(provider).catch(() => []) : [];
    if (offered.length > 0 && !offered.some((candidate) => candidate?.id === model)) {
      return { ok: false, code: 'bad_request', message: `model "${model}" is not offered by provider "${provider}"` };
    }
    const requested = normalizeEffort(item?.reasoningEffort);
    if (!requested.ok) return { ok: false, code: 'bad_request', message: `role ${role}: ${requested.message}` };
    let info = null;
    if (requested.value !== null) {
      try {
        info = await resolveModel(provider, model);
      } catch {
        info = null;
      }
      if (info === null || info === undefined) {
        return { ok: false, code: 'unavailable', message: `role ${role}: could not read the catalog for model "${provider}/${model}"` };
      }
    }
    const effort = checkEffort({ role, provider, model, effort: requested.value, info });
    if (!effort.ok) return { ok: false, code: 'bad_request', message: effort.message };
    routes.push({ role, provider, model, reasoningEffort: effort.value });
  }
  if (routes.length === 0) return { ok: false, code: 'bad_request', message: 'no routes supplied' };
  return { ok: true, routes };
}

/**
 * Fold prepared routes into the kanban config row.
 *
 * `reasoningEffort` is written explicitly — including as `null` — so choosing
 * **Default** clears a level saved earlier instead of leaving it behind.
 */
export function applyRoutes(current, inherited, routes) {
  const next = structuredClone(current ?? {});
  next.roles = { ...(inherited?.roles ?? {}), ...(next.roles ?? {}) };
  for (const route of routes) {
    next.roles[route.role] = {
      ...(next.roles[route.role] ?? {}),
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort ?? null,
    };
  }
  return next;
}

/**
 * Non-fatal check of the saved config against the live catalog.
 *
 * A stale level is not worth taking a profile down for: the request path already
 * rejects it with `UNSUPPORTED_REASONING_EFFORT`, so this only says out loud
 * which role will fail until someone fixes it in the dialog.
 *
 * @returns {Promise<string[]>} one warning per role whose effort is not offered.
 */
export async function staleEffortWarnings(roles, resolveModel) {
  const warnings = [];
  for (const [role, entry] of Object.entries(roles ?? {})) {
    if (entry === null || typeof entry !== 'object') continue;
    const effort = entry.reasoningEffort;
    if (typeof effort !== 'string' || effort === '') continue;
    const provider = typeof entry.provider === 'string' ? entry.provider : null;
    const model = typeof entry.model === 'string' ? entry.model : null;
    if (provider === null || model === null) continue;
    let info = null;
    try {
      info = await resolveModel(provider, model);
    } catch {
      continue;
    }
    if (info === null || info === undefined) continue;
    const offered = offeredEfforts(info);
    if (offered.some((item) => item.id === effort)) continue;
    warnings.push(
      offered.length === 0
        ? `kanban config: roles.${role}.reasoningEffort "${effort}" is ignored — model "${provider}/${model}" offers no reasoning effort levels`
        : `kanban config: roles.${role}.reasoningEffort "${effort}" is not offered by model "${provider}/${model}" (offers: ${offered.map((item) => item.id).join(', ')})`,
    );
  }
  return warnings;
}
