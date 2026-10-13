// The switch tool's guard and switch sequence, with every dsh service passed in as
// a dependency so the whole path runs under node:test without a harness.
//
// `deps`:
//   service(agent, name)                    a mounted service or undefined
//   readPressure(agent, session)            { totalTokens, nodes } or undefined
//   resolveWindow(agent, provider, model, signal)  declared window or undefined
//   compactToFit(agent, budget, config, signal, log)  { ok, freed } | { ok:false, reason }
//   createUserMessage(input)                dsh-llm's message constructor

import {
  compactionFailureReason,
  decideFit,
  fitsWindow,
  routeLabel,
  sameRoute,
  stillTooLargeReason
} from './fit.mjs'
import { noticeSource } from './notice.mjs'

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

function catalogRouteList(catalog) {
  const routes = []
  for (const group of catalog?.groups ?? []) {
    for (const model of group?.models ?? []) routes.push(`${group.id}/${model.id}`)
  }
  return routes
}

// ================================================================
// THE GUARD
// ================================================================

/**
 * Decide whether one route change is safe, and make it safe when it is not.
 *
 * @returns {Promise<{allowed: boolean, reason?: string, note?: string,
 *   tokens?: number, window?: number, compacted?: boolean, freed?: number}>}
 */
export async function guardRouteChange(deps, agent, provider, model, config, signal, log) {
  const routed = agent.session.requestHeader()?.config
  const dest = { provider, model }
  // Every judgement - allow, skip, refuse, or compact first - is made by the
  // pure decideFit() in fit.mjs, where the branches have tests. This function
  // only measures, acts on the verdict, and re-measures.
  const decision = await decideFit({
    tokens: deps.readPressure(agent, agent.session)?.totalTokens,
    fitRatio: config.fitRatio,
    destWindow: () => deps.resolveWindow(agent, provider, model, signal),
    currentWindow: () => deps.resolveWindow(agent, routed?.provider, routed?.model, signal),
    autoCompact: config.autoCompact,
    dest,
    routedLabel: routeLabel(routed)
  })
  if (decision.action === 'allow') {
    return { allowed: true, note: decision.note, tokens: decision.tokens, window: decision.window }
  }
  if (decision.action === 'refuse') {
    return { allowed: false, tokens: decision.tokens, window: decision.window, reason: decision.reason }
  }

  log?.info(
    'fit-guard: %s -> %s needs ~%d tokens vs window %d; compacting first',
    routeLabel(routed),
    `${provider}/${model}`,
    decision.tokens,
    decision.window,
  )
  const result = await deps.compactToFit(agent, decision.budget, config, signal, log)
  if (!result.ok) {
    return {
      allowed: false,
      tokens: decision.tokens,
      window: decision.window,
      reason: compactionFailureReason({ dest, window: decision.window, tokens: decision.tokens, detail: result.reason })
    }
  }

  const after = deps.readPressure(agent, agent.session)?.totalTokens
  if (after !== undefined && !fitsWindow(after, decision.window, config)) {
    return {
      allowed: false,
      tokens: after,
      window: decision.window,
      reason: stillTooLargeReason({ dest, window: decision.window, after, budget: decision.budget, freed: result.freed })
    }
  }

  return {
    allowed: true,
    tokens: after ?? decision.tokens,
    window: decision.window,
    compacted: result.freed > 0,
    freed: result.freed
  }
}

// ================================================================
// SWITCH
// ================================================================

/**
 * Validate + install a model selection for one agent, then queue the
 * agent-authored first message for the new model's next turn.
 * Returns { ok, from, to, alreadyOnRoute } or { ok: false, error }.
 */
export async function switchAgentModel(deps, log, config, agent, provider, model, text, noticeSummary, signal) {
  const controller = deps.service(agent, 'sessionController')
  if (controller === undefined) {
    return {
      ok: false,
      error: 'model switching is unavailable in this profile (no sessionController service).'
    }
  }

  const from = agent.session.requestHeader()?.config

  let guard
  try {
    guard = await guardRouteChange(deps, agent, provider, model, config, signal, log)
  } catch (error) {
    return { ok: false, error: `context fit check failed: ${message(error)}` }
  }
  if (!guard.allowed) {
    log?.warn('switch to %s/%s refused by fit guard: %s', provider, model, guard.reason)
    return { ok: false, error: `model switch refused: ${guard.reason}` }
  }

  let to
  try {
    to = (await controller.selectModel({ sessionId: agent.id, provider, model })).selected
  } catch (error) {
    let hint = ''
    try {
      const routes = catalogRouteList(await controller.modelCatalog())
      if (routes.length > 0) hint = ` Available routes: ${routes.join(', ')}.`
    } catch {
      // catalog is a convenience; never mask the real error with it
    }
    log?.warn('switch to %s/%s failed: %s', provider, model, message(error))
    return { ok: false, error: `model switch failed: ${message(error)}${hint}` }
  }

  const fitNote =
    guard.compacted === true
      ? ` The conversation was compacted first (~${guard.freed} tokens freed) so it fits ${provider}/${model};`
      : ''
  agent.steer(
    deps.createUserMessage({
      content: [{ type: 'text', text: fitNote.length > 0 ? `${fitNote} ${text}` : text }],
      source: noticeSource(noticeSummary)
    }),
  )

  const alreadyOnRoute = sameRoute(from, to)
  log?.info(
    'session %s: model %s -> %s (%s)',
    agent.id,
    routeLabel(from),
    routeLabel(to),
    alreadyOnRoute ? 'already on route, message queued only' : 'switched',
  )
  return {
    ok: true,
    from: routeLabel(from),
    to: routeLabel(to),
    alreadyOnRoute,
    compacted: guard.compacted === true,
    freed: guard.freed,
    tokens: guard.tokens,
    window: guard.window
  }
}
