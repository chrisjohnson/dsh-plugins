// scheduled-queue: the durable Host half of the composer's scheduled-send feature.
//
// Owns the queue file, a periodic scanner, and delivery of due items.
//
// Delivery goes through `sessionController.prompt` - the call the composer's own
// send button makes. A live session takes the message as a follow-up (or as
// steering, for a `forceSteer` item); a stopped session is resumed first, so the
// message is processed exactly like a normal send. `prompt` dedupes on the
// request id (the item's `messageId`), so a retry after a half-failed admission
// cannot deliver twice. The message is the user's own text, so it carries the
// harness's own `user` source rather than a plugin one.
//
// The browser half reaches this over exact Fetch routes under the authenticated
// /api fence (`connection.fetch.register`), which the client calls as
// `connection.rpc.call('/api', 'scheduledQueue/<endpoint>', payload)`:
//
//   POST /api/scheduledQueue/schedule | list | remove | sendNow | edit
//
// Every endpoint that returns the queue returns it for the one session the
// request names, and every endpoint requires that session; none returns or acts
// on another session's items.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

import { resolveQueueFile, resolveSettings } from './config.mjs'
import {
  createItem,
  dueItems,
  editItem,
  excerpt,
  isPermanentFailure,
  isSessionGone,
  isSessionId,
  ownedBy,
  parsePersisted,
  promptRequest,
  publicQueue,
  retryDelayMs,
} from './queue.mjs'

const PLUGIN_NAME = 'dsh-scheduled-queue'
const API_BASE = '/api/scheduledQueue'
const ENDPOINTS = ['schedule', 'list', 'remove', 'sendNow', 'edit']
// `session/not-found` is also raised transiently (an agent disposed while a prompt
// is being admitted), so a delivery that gets it asks once more after this pause.
const SESSION_RECHECK_MS = 2000

const message = (error) => (error && error.message ? error.message : String(error))
const fail = (code, text) => ({ ok: false, error: { code, message: text, details: {} } })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export default function scheduledQueue(ctx, config = {}) {
  const log = ctx.logger(PLUGIN_NAME)
  const { settings, warnings } = resolveSettings(config)
  for (const warning of warnings) log.warn(warning)

  ctx.inject(['connection', 'sessionController'], (scope) => {
    const connection = scope.connection
    const sessionController = scope.sessionController

    if (connection === undefined || connection === null || sessionController === undefined || sessionController === null) {
      log.error('connection or sessionController service is missing; scheduled messages stay off')
      return
    }

    const FILE = resolveQueueFile(process.env, homedir(), sep)

    let queue = []
    const retryAt = new Map()
    const attempts = new Map()
    const inflight = new Set()
    let scanning = false
    // True while the queue file exists but could not be read. Nothing is written
    // over it until a later read succeeds.
    let readFailed = false

    // --- persistence -------------------------------------------------------

    let writes = Promise.resolve()
    function persist() {
      if (readFailed) {
        log.error('not writing %s: it could not be read, and writing would replace it', FILE)
        return writes
      }
      const snapshot = JSON.stringify(queue, null, 2)
      writes = writes.then(async () => {
        try {
          await mkdir(dirname(FILE), { recursive: true })
          const temp = `${FILE}.${process.pid}.tmp`
          await writeFile(temp, snapshot, 'utf8')
          await rename(temp, FILE)
        } catch (error) {
          log.error('persist failed: %s', message(error))
        }
      })
      return writes
    }

    /** Read the queue file into memory. Items already in memory win over restored ones. */
    async function load() {
      let text
      try {
        text = await readFile(FILE, 'utf8')
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          readFailed = false
          log.info('queue file %s does not exist yet', FILE)
          return
        }
        readFailed = true
        log.error('could not read %s; it will not be overwritten, and the read is retried each scan: %s', FILE, message(error))
        return
      }
      const { items, corrupt } = parsePersisted(text)
      if (corrupt) {
        const aside = `${FILE}.corrupt-${Date.now()}`
        try {
          await rename(FILE, aside)
          readFailed = false
          log.error('%s was not a JSON array; moved to %s and starting empty', FILE, aside)
        } catch (error) {
          readFailed = true
          log.error('%s was not a JSON array and could not be set aside: %s', FILE, message(error))
        }
        return
      }
      const known = new Set(queue.map((it) => it.id))
      const wasFailed = readFailed
      readFailed = false
      queue = [...queue, ...items.filter((it) => !known.has(it.id))]
      log.info('queue file ready: %s (%d item(s) restored)', FILE, items.length)
      if (wasFailed) await persist()
    }

    // Requests and the scanner wait for the first read, so a call that arrives
    // before the file has been read cannot overwrite it with an empty queue.
    const ready = load().catch((error) => log.error('queue restore failed: %s', message(error)))

    // --- delivery ----------------------------------------------------------

    function drop(item) {
      queue = queue.filter((it) => it.id !== item.id)
      retryAt.delete(item.id)
      attempts.delete(item.id)
    }

    /** One `prompt` call that is given up on, and aborted, after the delivery timeout. */
    async function promptWithTimeout(item) {
      const controller = new AbortController()
      let timer
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`no answer from the session within ${settings.deliveryTimeoutMs} ms`)
          controller.abort(error)
          reject(error)
        }, settings.deliveryTimeoutMs)
      })
      try {
        return await Promise.race([sessionController.prompt(promptRequest(item), controller.signal), timeout])
      } finally {
        clearTimeout(timer)
      }
    }

    /** @returns whether the item was handed to its session (and so left the queue). */
    async function deliver(item) {
      if (inflight.has(item.id)) return false
      inflight.add(item.id)
      try {
        try {
          await promptWithTimeout(item)
        } catch (error) {
          if (!isSessionGone(error)) throw error
          await sleep(SESSION_RECHECK_MS)
          await promptWithTimeout(item)
        }
        drop(item)
        await persist()
        return true
      } catch (error) {
        if (isSessionGone(error)) {
          log.warn('dropping scheduled message %s: session %s no longer exists. Text: %s', item.id, item.sessionId, excerpt(item.text))
          drop(item)
          await persist()
          return false
        }
        if (isPermanentFailure(error)) {
          log.warn('dropping scheduled message %s: the harness rejected it (%s). Text: %s', item.id, message(error), excerpt(item.text))
          drop(item)
          await persist()
          return false
        }
        // The item may have been removed while it was being sent; only a queued
        // item gets a retry time.
        if (queue.some((it) => it.id === item.id)) {
          const n = (attempts.get(item.id) ?? 0) + 1
          attempts.set(item.id, n)
          const delay = retryDelayMs(n)
          retryAt.set(item.id, Date.now() + delay)
          log.warn('delivery of %s to session %s failed (attempt %d, retry in %ds): %s', item.id, item.sessionId, n, Math.round(delay / 1000), message(error))
        }
        return false
      } finally {
        inflight.delete(item.id)
      }
    }

    async function scan() {
      if (scanning) return
      scanning = true
      try {
        await ready
        if (readFailed) await load()
        for (const item of dueItems(queue, Date.now(), retryAt)) await deliver(item)
      } catch (error) {
        log.error('scan failed: %s', message(error))
      } finally {
        scanning = false
      }
    }

    // --- endpoints ---------------------------------------------------------

    const beingSent = () => fail('being-sent', 'that message is being sent right now')

    const handler = async (endpoint, payload) => {
      try {
        await ready
        const p = payload !== null && typeof payload === 'object' ? payload : {}
        const sessionId = typeof p.sessionId === 'string' && p.sessionId !== '' ? p.sessionId : undefined
        if (endpoint !== 'schedule' && ENDPOINTS.includes(endpoint) && !isSessionId(sessionId)) {
          return fail('bad-request', `${endpoint} needs the sessionId whose scheduled messages it concerns`)
        }
        const view = () => publicQueue(queue, sessionId)
        switch (endpoint) {
          case 'schedule': {
            const { item, error } = createItem(p, Date.now(), { id: randomUUID(), messageId: randomUUID() })
            if (error !== undefined) return fail('bad-request', error)
            queue.push(item)
            await persist()
            return { ok: true, value: { id: item.id, dueAt: item.dueAt, queue: publicQueue(queue, item.sessionId) } }
          }
          case 'list':
            return { ok: true, value: { queue: view() } }
          case 'remove': {
            const item = queue.find((it) => it.id === p.id)
            if (item === undefined || !ownedBy(item, sessionId)) return { ok: true, value: { removed: false, queue: view() } }
            if (inflight.has(item.id)) return beingSent()
            drop(item)
            await persist()
            return { ok: true, value: { removed: true, queue: view() } }
          }
          case 'sendNow': {
            const item = queue.find((it) => it.id === p.id)
            if (item === undefined || !ownedBy(item, sessionId)) return fail('not-found', 'no scheduled message with that id')
            if (inflight.has(item.id)) return beingSent()
            const delivered = await deliver(item)
            return { ok: true, value: { delivered, queue: view() } }
          }
          case 'edit': {
            const index = queue.findIndex((it) => it.id === p.id)
            if (index === -1 || !ownedBy(queue[index], sessionId)) return fail('not-found', 'no scheduled message with that id')
            if (inflight.has(queue[index].id)) return beingSent()
            const { item, error } = editItem(queue[index], p, Date.now())
            if (error !== undefined) return fail('bad-request', error)
            queue[index] = item
            retryAt.delete(item.id)
            attempts.delete(item.id)
            await persist()
            return { ok: true, value: { queue: view() } }
          }
          default:
            return fail('unknown-endpoint', `unknown endpoint ${String(endpoint)}`)
        }
      } catch (error) {
        return fail('internal', message(error))
      }
    }

    // The route runs after the /api fence has applied the browser trust and
    // authentication checks. It accepts the client-request envelope the browser
    // sends (answering with the matching server-response) or a raw JSON payload.
    const apiFetch = (endpoint) => async (request) => {
      let body
      try {
        body = await request.json()
      } catch {
        body = {}
      }
      const envelope =
        body && typeof body === 'object' && body.type === 'client-request' && typeof body.rpcId === 'string' ? body : null
      const result = await handler(endpoint, envelope ? envelope.payload : body)
      const response = envelope ? { type: 'server-response', rpcId: envelope.rpcId, result } : result
      return Response.json(response, { headers: { 'cache-control': 'no-store' } })
    }

    // `fetch.register` is itself a context-owned effect: the route is removed when
    // this scope is disposed, so it is not wrapped in another effect.
    for (const endpoint of ENDPOINTS) {
      connection.fetch.register({
        path: `${API_BASE}/${endpoint}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: apiFetch(endpoint),
      })
    }

    scope.effect(() => {
      const timer = setInterval(() => void scan(), settings.scanIntervalMs)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    }, `${PLUGIN_NAME}: delivery scan`)

    log.info('applied: file=%s scan=%dms routes=%s/{%s}', FILE, settings.scanIntervalMs, API_BASE, ENDPOINTS.join(','))
  })
}
