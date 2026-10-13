// loop-watchdog: host-plane Cordis plugin.
//
// A stuck-signal for agent sessions. Before each agent step it produces a
// STUCK / WORKING verdict with a confidence, written as one readable record per
// check to an evaluation ledger, so an operator (or a future escalation
// consumer) can see that a session is looping. Precision over recall: a false
// positive derails a productive session; a false negative costs minutes.
//
// Two layers (the decisions live in decide.mjs / summarize.mjs, pure and tested):
//   1. DETERMINISTIC FINGERPRINT: hash (tool, normalised args) over the raw event
//      tail and flag repetition with no new information. No model call.
//   2. MODEL ADJUDICATION of the windows the first layer did not settle, through
//      an OpenAI-compatible chat-completions endpoint the deployment configures.
//
// The in-session intervention is OFF by default and is one consumer of the
// signal, not its purpose: a non-destructive steering note, only in the stuck
// band, sustained, once per stuck episode.
//
// The same host also serves the ledger to the evals panel (src/client.mjs) on a
// plugin-owned route, `/loopWatchdog/<list|sessions|detail>`. The panel is a pure
// reader; it never writes the ledger and never influences a decision.
//
// DIAGNOSTIC STAGES (grep the log for the tag):
//   [A] loaded / mode changes   [B] before-step fired / skips
//   [C] model request           [D] model response
//   [E] decision                [X] errors

import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { format } from 'node:util'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { resolveSettings } from './config.mjs'
import {
  INTERVENTION_MESSAGE,
  bandOf,
  buildRequestBody,
  evalRecord,
  interventionGate,
  interventionSource,
  nextStreak,
  parseModeOverride,
  parseVerdict,
} from './decide.mjs'
import { answer, parseLedger } from './ledger.mjs'
import { fingerprintReport, isSubstantive, summarizeEvent } from './summarize.mjs'

const PLUGIN_NAME = 'loop-watchdog'
const RPC_PATH = '/loopWatchdog'

export default function loopWatchdog(ctx, config = {}) {
  const { settings, llm, warnings } = resolveSettings(config)
  const rawLog = ctx.logger(PLUGIN_NAME)
  for (const warning of warnings) rawLog.warn('%s', warning)

  // --- log sinks -----------------------------------------------------------
  // console -> the service's stdout (the journal under systemd); the stage lines
  // fire on every step of every session, so it is off by default. file -> the
  // full trail, outside both. dsh -> ctx.logger (never the journal). The ledger
  // is NOT a log and always writes.
  const diag = {
    console: settings.logConsole,
    file: settings.logFile,
    dshLog: settings.logDsh,
    dshLogErrors: settings.logDshErrors,
  }
  let logDirReady = false
  function fileLog(...args) {
    if (!diag.file) return
    try {
      if (!logDirReady) {
        mkdirSync(dirname(settings.logFilePath), { recursive: true })
        logDirReady = true
      }
      // util.format, not String(): the stage lines are printf-style (%s/%d/%j).
      appendFileSync(settings.logFilePath, `[${new Date().toISOString()}] ${format(...args)}\n`)
    } catch {
      // best effort
    }
  }
  function logBoth(...args) {
    if (diag.console) console.log(...args)
    fileLog(...args)
  }
  const level = (name, isError = false) =>
    diag.dshLog || (isError && diag.dshLogErrors) ? rawLog[name].bind(rawLog) : () => {}
  const log = { info: level('info'), warn: level('warn'), error: level('error', true) }

  // --- the ledger ----------------------------------------------------------
  function writeEval(record) {
    try {
      mkdirSync(dirname(settings.ledgerFile), { recursive: true })
      appendFileSync(settings.ledgerFile, `${JSON.stringify(record)}\n`)
    } catch {
      // best effort
    }
  }

  function readModeOverride() {
    try {
      return parseModeOverride(readFileSync(settings.modeFile, 'utf8'))
    } catch {
      return null // absent -> the configured default stands
    }
  }

  const bands = { bandStuck: settings.bandStuck, bandWatch: settings.bandWatch }

  logBoth('[A] PLUGIN LOADED: config=%j', {
    ...settings,
    llm: llm ? { url: llm.url, model: llm.model, apiKeyEnv: llm.apiKeyEnv ?? null } : null,
  })
  log.info('[A] PLUGIN LOADED: interventionEnabled=%s llm=%s', settings.interventionEnabled, llm ? llm.model : 'off')

  const lastCheck = new Map() // sessionId -> time of last evaluation (cooldown gate)
  const lastLlmLatency = new Map() // sessionId -> last model latency (busy-yield gate)
  // Steps arrive far more often than the cooldown allows, so recording every
  // rate-limited step would add a ledger row every few seconds and bury the real
  // evaluations. Only the START of a skip stretch is recorded; a real evaluation
  // ends the stretch.
  const lastSkipKind = new Map()
  // Hysteresis: acting needs SUSTAINED stuck decisions, and after one nudge per
  // streak the watchdog stays silent until the streak breaks.
  const stuckStreak = new Map()
  const intervenedInStreak = new Set()
  let lastEffectiveMode = null

  function isSubagent(session) {
    if (settings.includeSubagents) return false
    const hdr = session?.header ?? {}
    return hdr.origin === 'subagent' || (hdr.delegationDepth ?? 0) > 0
  }

  function skipOnce(sessionId, kind, events, extra = {}) {
    if (lastSkipKind.get(sessionId) === kind) return
    lastSkipKind.set(sessionId, kind)
    writeEval({ ...evalRecord(sessionId, events), skip: kind, outcome: 'skipped', ...extra })
  }

  // Ask the configured model whether the window produced NEW information. Fails
  // open: any error leaves the verdict null (band 'noise') and the turn proceeds.
  async function classifyTrajectory(transcript) {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
      logBoth('[C] classification timed out after %dms', settings.watchdogTimeoutMs)
    }, settings.watchdogTimeoutMs)
    const start = Date.now()
    const body = buildRequestBody(llm, transcript)

    logBoth('[C] SENDING TO MODEL: endpoint=%s model=%s transcript=%d chars', llm.url, llm.model, transcript.length)
    logBoth('[C] --- TRANSCRIPT START ---\n%s\n[C] --- TRANSCRIPT END ---', transcript)

    let text = ''
    let hasReasoning = false
    try {
      const headers = { 'Content-Type': 'application/json' }
      const key = llm.apiKeyEnv ? (process.env[llm.apiKeyEnv] ?? '').trim() : ''
      if (key) headers.Authorization = `Bearer ${key}`
      const res = await fetch(llm.url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
      if (!res.ok) {
        const errBody = await res.text().catch(() => '(no body)')
        throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 300)}`)
      }
      const json = await res.json()
      const choice = json?.choices?.[0]
      text = choice?.message?.content ?? ''
      hasReasoning = choice?.message?.reasoning_content !== undefined
      logBoth('[D] MODEL RESPONSE (took %dms, raw=%j, has_reasoning=%s)', Date.now() - start, text.trim(), hasReasoning)
    } catch (err) {
      logBoth('[X] ERROR in classifyTrajectory: %s', err?.stack ?? err)
      log.error('[X] ERROR in classifyTrajectory: %s', err?.stack ?? err)
    } finally {
      clearTimeout(timer)
    }

    const { verdict, confidence, inferred } = parseVerdict(text)
    if (verdict === null) {
      logBoth('[D] PARSE_FAIL - no verdict in raw=%j', text.trim())
      log.warn('[D] PARSE_FAIL: raw=%j', text.trim())
    }
    return { verdict, confidence, inferred, raw: text.trim(), hasReasoning, latencyMs: Date.now() - start }
  }

  async function checkLoop(agent) {
    const session = agent?.session
    const sessionId = agent?.id
    logBoth('[B] BEFORE-STEP FIRED for session: %s', sessionId)

    try {
      if (session == null) {
        logBoth('[B] skip %s - no session on agent (turn already aborted?)', sessionId)
        return
      }
      if (isSubagent(session)) {
        logBoth('[B] skip %s - subagent session excluded (includeSubagents=%s)', sessionId, settings.includeSubagents)
        return
      }

      // The recent trajectory, SUBSTANTIVE events only: turn-boundary and
      // inbox-splice noise is excluded so kickers and restarts do not pollute it.
      const snapshot = session.snapshotEvents?.()
      const allEvents = Array.isArray(snapshot) ? snapshot : []
      const substantive = allEvents.filter(isSubstantive)
      const recentEvents = substantive.slice(-settings.maxTranscriptLines)
      const counts = { total: allEvents.length, substantive: substantive.length }
      logBoth('[B] snapshot: %d events -> %d substantive, taking last %d', allEvents.length, substantive.length, recentEvents.length)

      // Not enough real activity: skip WITHOUT consuming the cooldown, so a
      // later step with actual signal still gets checked.
      if (recentEvents.length < 2) {
        logBoth('[B] skip %s - only %d substantive events (need >= 2)', sessionId, recentEvents.length)
        skipOnce(sessionId, 'no-signal', counts)
        return
      }

      // Cooldown, checked AFTER the signal test so low-signal steps do not burn it.
      const now = Date.now()
      const elapsed = now - (lastCheck.get(sessionId) ?? 0)
      if (elapsed < settings.cooldownMs) {
        logBoth('[B] COOLDOWN_SKIP %s (%dms < %dms)', sessionId, elapsed, settings.cooldownMs)
        skipOnce(sessionId, 'cooldown', counts)
        return
      }

      const transcript = recentEvents.map(summarizeEvent).join('\n')

      // Layer 1: deterministic. A busy backend is no obstacle to it, so it runs
      // before the busy-yield gate. The code layer's full result is recorded
      // whether or not it fired: "ran, scanned N calls, found nothing" is a real
      // evaluation and the panel exists to make it inspectable.
      const fpReport = fingerprintReport(allEvents.slice(-settings.fpWindowEvents))
      const matchedFps = fpReport.stuck
      const codePhase = {
        ran: true,
        calls: fpReport.calls,
        groupCount: fpReport.groups.length,
        stuckGroups: matchedFps.map((f) => ({ ...f })),
        stuck: matchedFps.length > 0,
        scannedEvents: Math.min(allEvents.length, settings.fpWindowEvents),
        topGroups: fpReport.groups.slice(0, 6).map((f) => ({ ...f })),
      }

      let decision
      let modelPhase = null
      if (matchedFps.length > 0) {
        lastCheck.set(sessionId, now)
        decision = {
          source: 'fingerprint',
          verdict: 'LOOP',
          confidence: 99,
          raw: matchedFps.map((f) => `${f.fp.slice(0, 60)} x${f.count} d${f.distinctResults}`).join('; '),
          latencyMs: 0,
        }
        logBoth('[C] FAST PATH: deterministic stuck, no model call - %s', decision.raw)
      } else {
        if (!llm) {
          // Nothing more can be judged without a model. The cooldown is
          // consumed so the repetition check keeps its normal cadence.
          lastCheck.set(sessionId, now)
          logBoth('[B] NO_LLM %s - repetition check found nothing and no model is configured', sessionId)
          skipOnce(sessionId, 'no-llm', counts, { code: codePhase })
          return
        }
        // Busy-yield: a supervisor that competes with the thing it supervises is
        // a net loss. Does not consume the cooldown.
        const prevLatency = lastLlmLatency.get(sessionId)
        if (prevLatency != null && prevLatency > settings.busyYieldMs) {
          logBoth('[B] BUSY_SKIP %s - previous model check took %dms (> %dms)', sessionId, prevLatency, settings.busyYieldMs)
          skipOnce(sessionId, 'busy', counts, { code: codePhase })
          return
        }
        lastCheck.set(sessionId, now)

        const r = await classifyTrajectory(transcript)
        decision = { source: 'llm', ...r }
        modelPhase = {
          verdict: r.verdict ?? null,
          confidence: r.confidence ?? null,
          inferred: r.inferred ?? false,
          latencyMs: r.latencyMs ?? 0,
          raw: r.raw ?? '',
          hasReasoning: r.hasReasoning ?? false,
        }
        lastLlmLatency.set(sessionId, r.latencyMs ?? 0)
      }
      const band = bandOf(decision.confidence, bands, decision.verdict)

      // Runtime mode: the override file wins over the configured default. Read
      // every check, so a toggle takes effect within one cooldown, no restart.
      const override = readModeOverride()
      const interventionOn = override ?? settings.interventionEnabled
      const effectiveMode = interventionOn ? 'act' : 'log'
      if (lastEffectiveMode !== null && lastEffectiveMode !== effectiveMode) {
        logBoth('[A] MODE CHANGED %s -> %s (source: %s)', lastEffectiveMode, effectiveMode, override !== null ? 'mode-file' : 'config')
        log.info('[A] MODE CHANGED %s -> %s', lastEffectiveMode, effectiveMode)
      }
      lastEffectiveMode = effectiveMode

      const streak = nextStreak(stuckStreak.get(sessionId), band)
      stuckStreak.set(sessionId, streak)
      if (band !== 'stuck') intervenedInStreak.delete(sessionId)

      const record = {
        ...evalRecord(sessionId, counts),
        code: codePhase,
        model: modelPhase,
        source: decision.source,
        verdict: decision.verdict ?? null,
        confidence: decision.confidence ?? null,
        band,
        streak,
        mode: effectiveMode,
        fingerprints: matchedFps.map((f) => ({ fp: f.fp, count: f.count, distinctResults: f.distinctResults })),
        latencyMs: decision.latencyMs ?? 0,
        window: transcript,
        outcome: 'logged',
      }

      const gate = interventionGate({
        verdict: decision.verdict,
        band,
        streak,
        interventionOn,
        alreadyActed: intervenedInStreak.has(sessionId),
      })
      if (gate.intervene) {
        record.outcome = 'intervened'
        intervenedInStreak.add(sessionId)
        logBoth('[E] DECISION LOOP conf=%d streak=%d source=%s - STEERING session %s (%s)', decision.confidence, streak, decision.source, sessionId, decision.raw)
        log.warn('[E] DECISION LOOP conf=%d streak=%d source=%s - steering session %s', decision.confidence, streak, decision.source, sessionId)
        try {
          const message = createUserMessage({
            content: [{ type: 'text', text: INTERVENTION_MESSAGE }],
            source: interventionSource(),
          })
          // steer() splices into the CURRENT turn's next step and wakes the
          // driver: immediate, not queued like followup().
          agent.steer(message)
        } catch (injectErr) {
          record.outcome = 'intervene-error'
          logBoth('[E] ERROR injecting correction: %s', injectErr?.stack ?? injectErr)
          log.error('[E] ERROR injecting correction: %s', injectErr?.stack ?? injectErr)
        }
      } else {
        logBoth(
          '[E] DECISION %s conf=%s band=%s streak=%d source=%s fps=%j - session %s (no action: %s)',
          decision.verdict ?? 'UNPARSEABLE',
          decision.confidence ?? '-',
          band,
          streak,
          decision.source,
          matchedFps.map((f) => `${f.fp.slice(0, 40)} x${f.count}`),
          sessionId,
          gate.reason,
        )
        if (decision.verdict === 'LOOP') {
          log.warn('[E] DECISION LOOP conf=%s band=%s streak=%d session %s', decision.confidence, band, streak, sessionId)
        }
      }

      // A real evaluation ends any skip stretch.
      lastSkipKind.delete(sessionId)
      writeEval(record)
    } catch (err) {
      // Fail open: the main turn proceeds natively.
      logBoth('[X] ERROR in checkLoop for session %s: %s', sessionId, err?.stack ?? err)
      log.error('[X] ERROR in checkLoop for session %s: %s', sessionId, err?.stack ?? err)
    }
  }

  // agent/pre-step is dsh-agent-loop's real "before the model step" waterfall.
  // Contract: await next() first, then fire the check WITHOUT awaiting it and
  // return the decision - this never blocks the turn and never breaks the chain
  // (a listener that does not call next() vetoes the built-in default).
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    checkLoop(agent).catch((err) => {
      logBoth('[X] Unhandled error in agent/pre-step handler for %s: %s', agent?.id, err?.stack ?? err)
      log.error('[X] Unhandled error in agent/pre-step handler: %s', err?.stack ?? err)
    })
    return decision
  })
  logBoth('[A] Registered agent/pre-step event listener')

  // --- the evals panel's read endpoints --------------------------------------
  // Memoised on (mtime, size): the file only grows, so a re-read is cheap and a
  // stale cache cannot survive any write.
  let cache = { mtimeMs: 0, size: -1, led: null }
  function loadLedger() {
    let st
    try {
      st = statSync(settings.ledgerFile)
    } catch {
      // No ledger yet: an empty result is correct, not an error.
      cache = { mtimeMs: 0, size: -1, led: null }
      return { records: [], byId: new Map(), sessions: [], corrupt: 0, error: 'ledger-missing' }
    }
    if (cache.led && st.mtimeMs === cache.mtimeMs && st.size === cache.size) return cache.led
    const led = { ...parseLedger(readFileSync(settings.ledgerFile, 'utf8')), error: null }
    cache = { mtimeMs: st.mtimeMs, size: st.size, led }
    return led
  }

  const readJsonBody = (req) =>
    new Promise((resolve) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve(text.length === 0 ? {} : JSON.parse(text))
        } catch {
          resolve({})
        }
      })
      req.on('error', () => resolve({}))
    })

  const handler = (endpoint, payload) => {
    try {
      return answer(endpoint, payload, loadLedger(), settings.ledgerFile)
    } catch (err) {
      return { ok: false, error: { code: 'internal', message: err?.message ?? String(err), details: {} } }
    }
  }

  // A PLUGIN-OWNED prefix route on the web server, trust-checked through the
  // connection service's public `requestRejection` - the same shape the other
  // plugins in this repository use for their browser halves.
  ctx.inject(['connection', 'webServer'], (scope) => {
    const webServer = scope.get('webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') {
      rawLog.warn('webServer is unavailable; the evals panel has no data route')
      return
    }
    scope.effect(
      () =>
        webServer.register({
          kind: 'prefix',
          path: RPC_PATH,
          handler: async (req, res) => {
            try {
              const connection = scope.get('connection')
              const rejection =
                connection !== undefined && typeof connection.requestRejection === 'function'
                  ? connection.requestRejection(req)
                  : undefined
              if (rejection !== undefined) {
                res.writeHead(rejection)
                res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
                return
              }
              if (req.method !== 'POST') {
                res.writeHead(405)
                res.end('method not allowed')
                return
              }
              const url = new URL(req.url ?? '/', 'http://dsh.internal')
              const endpoint = decodeURIComponent(url.pathname.slice(RPC_PATH.length + 1))
              const result = handler(endpoint, await readJsonBody(req))
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify(result))
            } catch (error) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: String(error?.message ?? error), details: {} } }))
            }
          },
        }),
      `${PLUGIN_NAME}: ledger route`,
    )
  })

  rawLog.info(
    'loop-watchdog active (interventionEnabled=%s, model=%s, ledger=%s, modeFile=%s)',
    settings.interventionEnabled,
    llm ? llm.model : 'off',
    settings.ledgerFile,
    settings.modeFile,
  )
}
