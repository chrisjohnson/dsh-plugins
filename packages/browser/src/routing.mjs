// Per-session routing for dsh-playwright-browser's controller. Pure: the
// controller class is passed in, so tests run against a stand-in and the live
// check runs against the real one.
//
// The original plugin builds ONE controller and every tool closes over it, and
// controller methods never see which session called. So this module
//   1. patches the controller's public methods so that, when a session id is in
//      the async-local store, the call runs on THAT session's controller, and
//   2. gives each session a controller subclass whose browser comes from the
//      shared pool (one context per session) instead of a private local launch.
// Everything else - tab bookkeeping, locators, snapshots, cancellation - is the
// original code, untouched, running with `this` = the session's controller.

import { describeEndpoint } from './config.mjs'

/** The entry points the original tools call; each takes the routed path. */
export const ROUTED_METHODS = Object.freeze([
  'open',
  'navigate',
  'snapshot',
  'click',
  'fill',
  'press',
  'history',
  'wait',
  'screenshot',
  'listTabs',
  'selectTab',
  'closeTab',
])

const SESSION_OWNED = Symbol.for('dsh-browser.session-owned')
const PATCH = Symbol.for('dsh-browser.patch')

/** Session id used when a tool call has no agent (it should not happen; sharing one context is the safe reading). */
export const NO_AGENT_SESSION = '(no-agent)'

/**
 * Build the per-session controller class on top of the original one.
 * @param {new (config: object) => object} Base - dsh-playwright-browser's BrowserController.
 */
export function createSessionControllerClass(Base) {
  return class SessionBrowserController extends Base {
    constructor(config, { sessionId, pool, endpointLabel, remoteEnabled }) {
      super(config)
      this[SESSION_OWNED] = true
      this.sessionId = sessionId
      this.pool = pool
      this.endpointLabel = endpointLabel
      this.remoteEnabled = remoteEnabled
      this.backend = undefined
      this.fallbackReason = null
      this.everStarted = false
      this.pendingNotices = []
    }

    // Replaces the original's private browser launch. The base `start()` still
    // owns caching and in-flight de-duplication.
    async launch() {
      const { context, kind, remoteNote } = await this.pool.acquire(this.sessionId, {
        viewport: { width: this.config.viewportWidth, height: this.config.viewportHeight },
      })
      if (this.everStarted) {
        this.pendingNotices.push(
          'The browser connection was lost and has been re-established. Earlier tabs are gone; their ids are no longer valid. Open a new tab.',
        )
      }
      this.everStarted = true
      this.backend = kind
      this.fallbackReason = kind === 'local' ? remoteNote : null

      context.setDefaultTimeout(this.config.actionTimeoutMs)
      context.setDefaultNavigationTimeout(this.config.navigationTimeoutMs)
      context.on('page', (page) => this.registerPage(page, true))
      for (const page of context.pages()) this.registerPage(page, false)
      // Tab ids keep counting upward across a loss: a stale id then fails as
      // unknown instead of silently naming a different page.
      context.once('close', () => this.forgetContext(context))
      this.context = context
      return context
    }

    // A cached context is only returned while the pool still vouches for it.
    async start() {
      if (this.context !== undefined && !this.pool.isLive(this.sessionId, this.context)) {
        this.forgetContext(this.context)
      }
      return super.start()
    }

    forgetContext(context) {
      if (this.context !== context) return
      this.context = undefined
      this.activeTabId = undefined
      this.pages.clear()
    }

    /** Lines the model must see with this call's result. */
    takeNotices() {
      const notices = this.pendingNotices
      this.pendingNotices = []
      if (this.backend === 'local' && this.fallbackReason !== null) {
        notices.unshift(
          `Remote browser (${this.endpointLabel}) is unreachable (${this.fallbackReason}). This session is using a LOCAL fallback Chromium on the DSH host, not the remote browser.`,
        )
      }
      return notices
    }
  }
}

/**
 * Session registry: one controller per session id, created on first use.
 * @param {object} options
 * @param {ReturnType<typeof createSessionControllerClass>} options.SessionController
 * @param {object} options.pool
 * @param {object} options.controllerOverrides - page/timeout settings that win over the original plugin's.
 * @param {string | undefined} options.connectUrl
 */
export function createSessionRegistry({ SessionController, pool, controllerOverrides, connectUrl }) {
  const controllers = new Map()
  const endpointLabel = connectUrl === undefined ? '(remote disabled)' : describeEndpoint(connectUrl)

  return {
    /** @param original - the controller the tool closed over; its resolved config seeds the session's. */
    controllerFor(sessionId, original) {
      let controller = controllers.get(sessionId)
      if (controller === undefined) {
        controller = new SessionController(
          { ...original.config, ...controllerOverrides },
          { sessionId, pool, endpointLabel, remoteEnabled: connectUrl !== undefined },
        )
        controllers.set(sessionId, controller)
      }
      return controller
    },
    has: (sessionId) => controllers.has(sessionId),
    size: () => controllers.size,
    /** End of a session: close its context and forget its controller. Idempotent. */
    async release(sessionId) {
      const controller = controllers.get(sessionId)
      controllers.delete(sessionId)
      if (controller !== undefined) await controller.close().catch(() => undefined)
      const released = await pool.release(sessionId)
      return controller !== undefined || released
    },
    async releaseAll() {
      await Promise.all([...controllers.keys()].map((sessionId) => this.release(sessionId)))
    },
  }
}

/**
 * Replace the routed methods on the original controller's prototype. Returns an
 * uninstall function that restores them, and only them, if this patch is still
 * the installed one.
 * @param {object} prototype - BrowserController.prototype
 * @param {{ storage: { getStore(): any }, registry: ReturnType<typeof createSessionRegistry> }} deps
 */
export function patchPrototype(prototype, { storage, registry }) {
  // A second install (hot reload, or two copies of this plugin) must not wrap a
  // wrapper: put the pristine methods back first.
  prototype[PATCH]?.restore()

  const originals = {}
  for (const name of ROUTED_METHODS) {
    const original = prototype[name]
    if (typeof original !== 'function') throw new Error(`BrowserController.${name} is not a function; unsupported dsh-playwright-browser version`)
    originals[name] = original
  }

  for (const name of ROUTED_METHODS) {
    const original = originals[name]
    prototype[name] = async function routed(...args) {
      if (this[SESSION_OWNED] === true) return original.apply(this, args)
      const store = storage.getStore()
      if (store === undefined) return original.apply(this, args)
      const controller = registry.controllerFor(store.sessionId, this)
      store.routed = true
      try {
        return await original.apply(controller, args)
      } finally {
        for (const notice of controller.takeNotices()) store.notices.add(notice)
      }
    }
  }

  const handle = {
    restore() {
      if (prototype[PATCH] !== handle) return
      for (const name of ROUTED_METHODS) prototype[name] = originals[name]
      delete prototype[PATCH]
    },
  }
  Object.defineProperty(prototype, PATCH, { value: handle, configurable: true, enumerable: false })
  return () => handle.restore()
}
