// dsh-model-capacity: preflight for agent-spawning tools.
//
// `subagent`, `subagent_fork` and `spawn_teammate` do not wait: if their child
// route has no slot, the tool returns an immediate, actionable error instead of
// silently queueing. The reservation they take is consumed by the child's first
// `llm/stream` call (see semaphore.consumeReservation).
//
// `workflow` is deliberately not in the default list: its fan-out is not
// declared in the call, so there is no honest capacity statement to make. Its
// children start sessions normally and queue through the global gate.

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function parseArguments(execution) {
  const raw = execution.arguments;
  if (isObject(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw);
      return isObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** The route the child would use: explicit tool args, else the parent's current request header. */
export function intendedRoute(execution) {
  const args = parseArguments(execution);
  const hasProvider = typeof args.provider === 'string' && args.provider !== '';
  const hasModel = typeof args.model === 'string' && args.model !== '';
  if (hasProvider && hasModel) return { provider: args.provider, model: args.model };
  if (hasProvider || hasModel) return null; // the tool itself rejects a half-specified route
  const agent = execution.agent;
  if (agent === undefined || agent === null) return null;
  const header = typeof agent.session?.requestHeader === 'function' ? agent.session.requestHeader() : undefined;
  if (header?.config?.provider !== undefined) return { provider: header.config.provider, model: header.config.model ?? null };
  if (agent.options?.provider !== undefined) return { provider: agent.options.provider, model: agent.options.model ?? null };
  return null;
}

/** Free routes, as `provider/model`, for the error's "potential solution". */
export function freeRoutes(manager, catalog, excludeProvider) {
  const out = [];
  for (const entry of catalog) {
    if (entry.provider === excludeProvider) continue;
    if (manager.freeSlots(entry.provider) <= 0) continue;
    for (const model of entry.models) {
      out.push(`${entry.provider}/${model.id}`);
      if (out.length >= 4) return out;
    }
  }
  return out;
}

/**
 * Capacity preflight. Returns undefined when the call may proceed (a reservation
 * is held), or a model-visible error string when it must not.
 *
 * @param {object} execution ToolExecution (name, arguments, agent, callId)
 * @param {import('./semaphore.mjs').CapacityManager} manager
 * @param {{subagentTools:string[], enabled:boolean}} config
 * @param {Array<{provider:string, models:Array<{id:string}>}>} catalog
 */
export function checkSubagentCapacity(execution, manager, config, catalog) {
  if (!config.enabled) return undefined;
  if (!config.subagentTools.includes(execution.name)) return undefined;
  const route = intendedRoute(execution);
  if (route === null || route.provider === null) return undefined;
  try {
    manager.reserve({
      provider: route.provider,
      parentSession: execution.agent?.id ?? null,
      tool: execution.name,
      callId: execution.callId ?? null,
    });
    return undefined;
  } catch (error) {
    if (error?.code !== 'CAPACITY_EXCEEDED') return undefined;
    const details = error.details ?? {};
    const model = route.model ?? 'the inherited route';
    const alternatives = freeRoutes(manager, catalog, route.provider);
    const solution =
      alternatives.length > 0
        ? `Free now: ${alternatives.join(', ')}. Retry with provider/model set to one of those.`
        : 'No other provider has a free slot right now; retry after a running turn finishes.';
    return [
      `capacity: provider "${route.provider}" is at its limit (${details.active ?? 0} active, ${details.reserved ?? 0} reserved, ${details.waiting ?? 0} waiting).`,
      `Cannot dispatch "${execution.name}" on "${model}".`,
      solution,
      'This tool does not queue; the child would not start until a slot frees.',
    ].join(' ');
  }
}
