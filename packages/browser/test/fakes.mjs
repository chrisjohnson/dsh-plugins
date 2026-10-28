// Stand-ins for Playwright objects and for dsh-playwright-browser's controller,
// shaped after the real ones so the routing code is exercised without either
// being installed.
import { EventEmitter } from 'node:events'

export class FakePage extends EventEmitter {
  constructor(url = 'about:blank') {
    super()
    this.currentUrl = url
    this.closed = false
  }
  isClosed() {
    return this.closed
  }
  url() {
    return this.currentUrl
  }
  async title() {
    return `title of ${this.currentUrl}`
  }
  locator() {
    return { ariaSnapshot: async () => '- text: hello', innerText: async () => 'hello' }
  }
  async close() {
    this.closed = true
    this.emit('close')
  }
}

export class FakeContext extends EventEmitter {
  constructor(options) {
    super()
    this.options = options
    this.pageList = []
    this.closed = false
    this.defaultTimeout = undefined
    this.defaultNavigationTimeout = undefined
  }
  pages() {
    return this.pageList
  }
  setDefaultTimeout(ms) {
    this.defaultTimeout = ms
  }
  setDefaultNavigationTimeout(ms) {
    this.defaultNavigationTimeout = ms
  }
  async newPage() {
    const page = new FakePage()
    this.pageList.push(page)
    this.emit('page', page)
    return page
  }
  async close() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
}

export class FakeBrowser extends EventEmitter {
  constructor(label) {
    super()
    this.label = label
    this.connected = true
    this.contexts = []
    this.failNewContext = undefined
  }
  isConnected() {
    return this.connected
  }
  async newContext(options) {
    if (this.failNewContext) throw this.failNewContext
    const context = new FakeContext(options)
    this.contexts.push(context)
    return context
  }
  async close() {
    await this.drop()
  }
  /** What the server killing the connection looks like to the client: contexts close, then `disconnected`. */
  async drop() {
    if (!this.connected) return
    this.connected = false
    for (const context of this.contexts) await context.close()
    this.emit('disconnected')
  }
}

/** A connector/launcher pair that hands out FakeBrowsers and counts how often it was asked. */
export function createBackends({ remoteFails = false, localFails = false } = {}) {
  const state = {
    remoteFails,
    localFails,
    remoteConnects: 0,
    localLaunches: 0,
    remotes: [],
    locals: [],
  }
  state.connectRemote = async () => {
    state.remoteConnects += 1
    if (state.remoteFails) throw new Error('browserType.connect: WebSocket error: connect ECONNREFUSED 127.0.0.1:1\nCall log:\n  - a')
    const browser = new FakeBrowser('remote')
    state.remotes.push(browser)
    return browser
  }
  state.launchLocal = async () => {
    state.localLaunches += 1
    if (state.localFails) throw new Error('browserType.launch: Executable does not exist at /nope')
    const browser = new FakeBrowser('local')
    state.locals.push(browser)
    return browser
  }
  return state
}

/**
 * The part of dsh-playwright-browser's BrowserController that the routing code
 * depends on, with the same method names, field names and call structure
 * (public methods go through `start()`, which goes through `launch()`).
 */
export class FakeBaseController {
  constructor(config) {
    this.config = config
    this.context = undefined
    this.starting = undefined
    this.pages = new Map()
    this.pageIds = new WeakMap()
    this.activeTabId = undefined
    this.nextTabNumber = 1
    this.launches = 0
  }
  async start() {
    if (this.context !== undefined) return this.context
    if (this.starting !== undefined) return this.starting
    this.starting = this.launch()
    try {
      return await this.starting
    } finally {
      this.starting = undefined
    }
  }
  async launch() {
    this.launches += 1
    throw new Error('the original launch must never run on a session controller')
  }
  registerPage(page, makeActive) {
    const known = this.pageIds.get(page)
    if (known !== undefined) {
      if (makeActive) this.activeTabId = known
      return known
    }
    const id = `tab-${this.nextTabNumber++}`
    this.pageIds.set(page, id)
    this.pages.set(id, page)
    if (makeActive || this.activeTabId === undefined) this.activeTabId = id
    page.once('close', () => {
      this.pages.delete(id)
      if (this.activeTabId === id) this.activeTabId = this.pages.keys().next().value
    })
    return id
  }
  async open(url) {
    const context = await this.start()
    const page = await context.newPage()
    if (url !== undefined) page.currentUrl = url
    this.registerPage(page, true)
    return this.snapshot(this.activeTabId)
  }
  async snapshot(tabId) {
    await this.start()
    const page = this.pages.get(tabId ?? this.activeTabId)
    if (page === undefined) throw new Error(`unknown or closed tab_id: ${tabId}`)
    return { tabId: tabId ?? this.activeTabId, title: await page.title(), url: page.url(), mode: 'aria', content: '', truncated: false }
  }
  async navigate(url, tabId) {
    await this.start()
    return this.snapshot(tabId)
  }
  async click(target, exact, tabId) {
    return this.snapshot(tabId)
  }
  async fill(target, value, exact, submit, tabId) {
    return this.snapshot(tabId)
  }
  async press(key, target, exact, tabId) {
    return this.snapshot(tabId)
  }
  async history(action, tabId) {
    return this.snapshot(tabId)
  }
  async wait(options, tabId) {
    return this.snapshot(tabId)
  }
  async screenshot(tabId) {
    await this.start()
    return { tabId: tabId ?? this.activeTabId, path: '/x.png', bytes: 1, fullPage: false }
  }
  async listTabs() {
    await this.start()
    return Promise.all([...this.pages].map(async ([id, page]) => ({ id, active: id === this.activeTabId, title: await page.title(), url: page.url() })))
  }
  async selectTab(tabId) {
    await this.start()
    this.activeTabId = tabId
    return this.listTabs()
  }
  async closeTab(tabId) {
    await this.start()
    await this.pages.get(tabId)?.close()
    return this.listTabs()
  }
  async close() {
    const context = this.context
    this.context = undefined
    this.activeTabId = undefined
    this.pages.clear()
    if (context !== undefined) await context.close().catch(() => undefined)
  }
}

export const quietLog = { info() {}, warn() {}, error() {} }
