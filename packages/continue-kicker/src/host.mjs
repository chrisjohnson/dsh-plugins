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
// Every decision, kick or skip, is logged with its reason.

import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { resolveSettings } from './config.mjs'
import { decide, PLUGIN_SOURCE_KIND } from './decide.mjs'

const PLUGIN_NAME = 'continue-kicker'

export default function continueKicker(ctx, config = {}) {
  const log = ctx.logger(PLUGIN_NAME)
  const { settings, warnings } = resolveSettings(config)
  for (const warning of warnings) log.warn('%s', warning)

  const liveAgents = new Set() // session ids with a live watcher
  const lastKick = new Map() // sessionId -> timestamp of last kick
  const consecutive = new Map() // sessionId -> kicks since the last reset signal
  const pendingTimers = new Map() // sessionId -> scheduled re-analysis timer
  const scopeSkipped = new Set() // sessionIds already logged as scope-excluded

  function isSubagent(agent) {
    const hdr = agent.session?.header ?? {}
    return hdr.origin === 'subagent' || (hdr.delegationDepth ?? 0) > 0
  }

  function maybeKick(agent, trigger) {
    try {
      const sessionId = agent.id
      const decision = decide({
        events: agent.session?.snapshotEvents(),
        settings,
        consecutive: consecutive.get(sessionId) ?? 0,
        lastKickAt: lastKick.get(sessionId) ?? 0,
        now: Date.now(),
        isSubagent: isSubagent(agent),
      })
      consecutive.set(sessionId, decision.consecutive)

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

      lastKick.set(sessionId, Date.now())
      const message = createUserMessage({
        content: [{ type: 'text', text: decision.text }],
        source: { kind: PLUGIN_SOURCE_KIND, form: 'notice', summary: decision.summary },
      })
      agent.followup(message)
      log.info('%s: kicked session %s (flavor=%s, consecutive=%d)', trigger, sessionId, decision.flavor, decision.consecutive)
    } catch (err) {
      log.error('%s: failed to kick session %s: %s', trigger, agent?.id, err?.stack ?? err)
    }
  }

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
    consecutive.delete(sessionId)
    scopeSkipped.delete(sessionId)
  })

  log.info(
    'continue-kicker active (cooldownMs=%d, liveKickDelayMs=%d, maxConsecutiveKicks=%d, kickOnInterrupted=%s, kickOnMaxTokens=%s, kickOnEmptyCompletion=%s, includeSubagents=%s)',
    settings.cooldownMs, settings.liveKickDelayMs, settings.maxConsecutiveKicks,
    settings.kickOnInterrupted, settings.kickOnMaxTokens, settings.kickOnEmptyCompletion, settings.includeSubagents,
  )
}
