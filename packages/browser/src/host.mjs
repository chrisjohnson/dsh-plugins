// dsh-browser: host-plane Cordis plugin. Gives dsh-playwright-browser's tools a
// browser context per DSH session on one shared remote Browserless connection,
// without re-registering a single tool.
//
// Wiring only; the decisions live in pool.mjs (connections, contexts, fallback),
// routing.mjs (which controller serves a call) and config.mjs, none of which
// import dsh.
//
// How a call finds its session: the original tools close over one controller
// and never pass a session id. A `tools/execute` wrapper runs each browser_*
// call inside an AsyncLocalStorage store holding the calling agent's id, and the
// patched controller methods read it. That only works if the controller class
// patched here is the SAME module instance the original plugin's tools use,
// which holds because both import dsh-playwright-browser's one controller file
// (README, "Module identity").

import { AsyncLocalStorage } from 'node:async_hooks'
import { format } from 'node:util'

import { createToolBridge } from './bridge.mjs'
import { resolveSettings } from './config.mjs'
import { createBrowserPool } from './pool.mjs'
import { createSessionControllerClass, createSessionRegistry, patchPrototype } from './routing.mjs'

const PLUGIN_NAME = 'browser'

// Imported at the top so a missing peer produces one clear log line at boot
// instead of an import error that takes the profile down with it.
let peers = null
let peersError = null
try {
  const [{ BrowserController }, { chromium }] = await Promise.all([
    import('dsh-playwright-browser/controller'),
    import('playwright-core'),
  ])
  peers = { BrowserController, chromium }
} catch (error) {
  peersError = error
}

const PROMPT_SECTION = `Browser sessions: the browser_* tools give this session its own isolated browser context (own tabs, cookies and logins) that no other session can see. The browser usually runs on a shared remote host, so do not install browsers: never run "npx playwright install" or any browser installer here, even if a startup error seems to suggest it; report the diagnostic instead. A line starting with "dsh-browser:" in a tool result describes the connection (a re-established connection, or a local fallback browser in use); read it, and open a fresh tab if it says earlier tabs are gone.`

export default function browser(ctx, config = {}) {
  const log = ctx.logger(PLUGIN_NAME)
  if (peers === null) {
    log.error(
      'dsh-browser is inactive: dsh-playwright-browser and playwright-core must be installed beside it (%s)',
      peersError instanceof Error ? peersError.message : String(peersError),
    )
    return
  }
  const { BrowserController, chromium } = peers

  const { settings, warnings } = resolveSettings(config)

  // dsh 0.2.0-rc.2 installs no console or file exporter, so a plugin's lines
  // reach nobody unless it forwards its own (and only its own) to stderr.
  if (settings.logToStderr) {
    ctx.logger.exporter({
      levels: { default: -1, [PLUGIN_NAME]: 3 },
      export: ({ ts, type, name, args }) => {
        process.stderr.write(`${new Date(ts).toISOString()} ${type.toUpperCase()} ${name} ${format(...args)}\n`)
      },
    })
  }
  for (const warning of warnings) log.warn('%s', warning)

  const logLine = (level) => (...args) => log[level]('%s', format(...args))
  const pool = createBrowserPool({
    connectRemote:
      settings.connectUrl === undefined
        ? undefined
        : () => chromium.connect(settings.connectUrl, { timeout: settings.connectTimeoutMs }),
    launchLocal: () =>
      chromium.launch({
        headless: true,
        ...(settings.fallbackExecutablePath === undefined ? {} : { executablePath: settings.fallbackExecutablePath }),
      }),
    retryRemoteAfterMs: settings.retryRemoteAfterMs,
    log: { info: logLine('info'), warn: logLine('warn') },
  })
  const SessionController = createSessionControllerClass(BrowserController)
  const registry = createSessionRegistry({
    SessionController,
    pool,
    controllerOverrides: settings.controllerOverrides,
    connectUrl: settings.connectUrl,
  })
  const storage = new AsyncLocalStorage()

  ctx.effect(() => {
    const unpatch = patchPrototype(BrowserController.prototype, { storage, registry })
    return async () => {
      unpatch()
      await registry.releaseAll()
      await pool.closeAll()
    }
  }, 'dsh-browser: per-session routing and connection')

  const bridge = createToolBridge({ storage, log })
  ctx.on('tools/execute', bridge.execute)
  ctx.on('tools/post-execute', bridge.postExecute)

  // Either event can announce the end of a session; releasing is idempotent.
  const release = (sessionId) => {
    registry.release(sessionId).catch((error) => {
      log.warn('releasing session %s failed: %s', sessionId, error instanceof Error ? error.message : String(error))
    })
  }
  ctx.on('agent/disposed', ({ agent }) => release(agent.id))
  ctx.on('session/disposed', (session) => release(session.id))

  ctx.inject(['systemPrompt'], (scope) => {
    scope.effect(
      () => scope.systemPrompt.section({ name: 'tool:browser-sessions', order: 113, text: PROMPT_SECTION }),
      'dsh-browser: session note',
    )
  })

  if (settings.connectUrl === undefined) log.info('remote connections are off (connectUrl is empty); sessions use a local browser')
}
