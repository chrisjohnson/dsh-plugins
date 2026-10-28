// continue-kicker: host-plane Cordis plugin. Resumes a session whose turn halted
// (output-token limit, crash-recovery marker, or a reasoning-only empty stop) by
// sending one follow-up user message, and stops after maxConsecutiveKicks kicks
// with no progress in between.
//
// All decisions live in decide.mjs (pure, tested). This file only wires them to
// dsh. Two doors feed the same decision:
//
//   - agent/created: inspects the tail including seed/replayed events. Covers
//     crash recovery (interrupted markers are synthesized while LOADING a
//     session and never publish live) and reopen-after-the-fact cases.
//   - Live watcher: a per-agent subscription on the agent's `session/event`
//     stream. A max-tokens halt is a real streamed finish reason that lands on
//     it, and an unattended halt has no reopening event to reach the
//     agent/created door. On every live turn/end it schedules a DELAYED
//     re-analysis (liveKickDelayMs) rather than acting on the event itself: the
//     delay lets a fast manual recovery land first and sidesteps publish-vs-
//     persist ordering. It fires on EVERY turn/end, not only kickable ones, so
//     a completed turn also reaches the decision and resets the runaway counter.
//
// Every decision, kick or skip, is logged with its reason (see README, "Logging", for where the lines go).
//
// The consecutive-kick count is derived from the session's events on every
// analysis (decide.mjs), so the reopen and live paths agree and a restart does
// not lose it. Only the cooldown timestamp lives in memory.
//
// A third door is the `continueKicker` service this plugin provides: another
// plugin (dsh-kanban) that owns a session's lifecycle can ask for one explicit
// recovery kick instead of waiting for these automatic doors. It runs the same
// decide() over the same session, sends the same message, and shares the same
// cooldown map, so one plugin owns the policy and the other just pulls the
// trigger. See README, "Provided service".

import { format } from 'node:util'

import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { resolveSettings } from './config.mjs'
import { decide, PLUGIN_SOURCE_KIND } from './decide.mjs'

const PLUGIN_NAME = 'continue-kicker'

/** The version of the provided service contract (see README, "Provided service"). */
const SERVICE_VERSION = 1

export default function continueKicker(ctx, config = {}) {
  const log = ctx.logger(PLUGIN_NAME)
  const { settings, warnings } = resolveSettings(config)
  for (const warning of warnings) log.warn('%s', warning)

  // dsh 0.2.0-rc.2 installs no console or file exporter on the host logger: a
  // plugin's log lines only reach an in-memory ring buffer nothing reads. This
  // opt-in exporter forwards this plugin's own lines (and no one else's) to
  // stderr, which a service manager captures.
  if (settings.logToStderr) {
    ctx.logger.exporter({
      levels: { default: -1,[PLUGIN_NAME]: 3 },
      export: ({ ts, type, name, args }) => {
        process.stderr.write(`${new Date(ts).toISOString()} ${type.toUpperCase()} ${name} ${format(...args)}\n`)
      },
    })
  }

  const liveAgents = new Set() // session ids with a live watcher
  const lastKick = new Map() // sessionId -> timestamp of last kick
  const pendingTimers = new Map() // sessionId -> scheduled re-analysis timer
  const scopeSkipped = new Set() // sessionIds already logged as scope-excluded

  function isSubagent(agent) {
    const hdr = agent.session?.header ?? {}
    return hdr.origin === 'subagent' || (hdr.delegationDepth ?? 0) > 0
  }

  /**
   * The live agent for a session id, or undefined. Resolved on every call: a
   * service grabbed at boot may not be published yet, and a session that has
   * since been disposed must not be kicked.
   */
  function liveAgent(sessionId) {
    try {
      return ctx.get('agents')?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  /** One analysis of one session, from either door. */
  function analyse(agent, { bypassCooldown = false } = {}) {
    return decide({
      events: agent.session?.snapshotEvents(),
      settings,
      lastKickAt: lastKick.get(agent.id) ?? 0,
      now: Date.now(),
      isSubagent: isSubagent(agent),
      bypassCooldown,
    })
  }

  /** Send the follow-up the decision asked for and record the cooldown. */
  function sendKick(agent, decision) {
    lastKick.set(agent.id, Date.now())
    const message = createUserMessage({
      content: [{ type: 'text', text: decision.text }],
      source: { kind: PLUGIN_SOURCE_KIND, form: 'notice', summary: decision.summary },
    })
    agent.followup(message)
  }

  function maybeKick(agent, trigger) {
    try {
      const sessionId = agent.id
      const decision = analyse(agent)

      if (decision.action === 'skip') {
        if (decision.scopeSkipped) {
          if (scopeSkipped.has(sessionId)) return
          scopeSkipped.add(sessionId)
        }
        log.info('%s: no kick on %s - %s', trigger, sessionId, decision.why)
        return
      }
      if (decision.action === 'stop') {
        log.error('%s: NOT kicking %s - %s. This session needs human attention.', trigger, sessionId, decision.why)
        return
      }

      sendKick(agent, decision)
      log.info('%s: kicked session %s (flavor=%s, consecutive=%d)', trigger, sessionId, decision.flavor, decision.consecutive)
    } catch (err) {
      log.error('%s: failed to kick session %s: %s', trigger, agent?.id, err?.stack ?? err)
    }
  }

  /**
   * The explicit door, for another plugin that owns this session's lifecycle.
   * Same policy as the automatic doors, reported back instead of only logged:
   *
   *   kick(sessionId, { bypassCooldown }) ->
   *     { kicked: true,  flavor, consecutive }
   *     { kicked: false, why, stopped? }   `stopped: true` when the runaway
   *                                       guard declined (needs human attention)
   *
   * Synchronous by contract: it never queues work of its own.
   */
  function kick(sessionId, { bypassCooldown = false } = {}) {
    try {
      const agent = liveAgent(sessionId)
      if (agent === undefined || agent === null) return { kicked: false, why: 'session not live' }
      const decision = analyse(agent, { bypassCooldown })
      if (decision.action === 'skip') {
        log.info('service: no kick on %s - %s', sessionId, decision.why)
        return { kicked: false, why: decision.why }
      }
      if (decision.action === 'stop') {
        log.error('service: NOT kicking %s - %s. This session needs human attention.', sessionId, decision.why)
        return { kicked: false, why: decision.why, stopped: true }
      }
      sendKick(agent, decision)
      log.info('service: kicked session %s (flavor=%s, consecutive=%d)', sessionId, decision.flavor, decision.consecutive)
      return { kicked: true, flavor: decision.flavor, consecutive: decision.consecutive }
    } catch (err) {
      log.error('service: failed to kick session %s: %s', sessionId, err?.stack ?? err)
      return { kicked: false, why: `kick failed: ${err?.message ?? err}` }
    }
  }

  ctx.provide('continueKicker', { version: SERVICE_VERSION, kick })

  ctx.on('agent/created', ({ agent }) => {
    try {
      const sessionId = agent.id
      liveAgents.add(sessionId)

      // Newer turn/end events replace the pending timer so a busy session is
      // not double-kicked mid-activity.
      const onSessionEvent = (_subject, event) => {
        try {
          if (event?.type !== 'turn/end') return
          const existing = pendingTimers.get(sessionId)
          if (existing) clearTimeout(existing)
          const timer = setTimeout(() => {
            pendingTimers.delete(sessionId)
            if (!liveAgents.has(sessionId)) return
            maybeKick(agent, 'live')
          }, settings.liveKickDelayMs)
          pendingTimers.set(sessionId, timer)
        } catch (err) {
          log.error('live watcher error for %s: %s', sessionId, err?.stack ?? err)
        }
      }
      agent.ctx.on('session/event', onSessionEvent)

      maybeKick(agent, 'created')
    } catch (err) {
      log.error('agent/created handler failed for %s: %s', agent?.id, err?.stack ?? err)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent.id
    const timer = pendingTimers.get(sessionId)
    if (timer) clearTimeout(timer)
    pendingTimers.delete(sessionId)
    liveAgents.delete(sessionId)
    lastKick.delete(sessionId)
    scopeSkipped.delete(sessionId)
  })

  log.info(
    'continue-kicker active (logToStderr=%s, cooldownMs=%d, liveKickDelayMs=%d, maxConsecutiveKicks=%d, kickOnInterrupted=%s, kickOnMaxTokens=%s, kickOnEmptyCompletion=%s, kickOnError=%s, includeSubagents=%s); kick service v%d provided',
    settings.logToStderr, settings.cooldownMs, settings.liveKickDelayMs, settings.maxConsecutiveKicks,
    settings.kickOnInterrupted, settings.kickOnMaxTokens, settings.kickOnEmptyCompletion, settings.kickOnError, settings.includeSubagents,
    SERVICE_VERSION,
  )
}
