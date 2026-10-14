// Decision logic of dsh-scheduled-queue: per-session scoping, scheduling, edit,
// back-off, delivery request, and reading what earlier versions persisted.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clampMinutes,
  createItem,
  dueItems,
  editItem,
  excerpt,
  isPermanentFailure,
  isInvalidTimeZone,
  isSessionGone,
  validTimeZone,
  itemsForSession,
  ownedBy,
  parsePersisted,
  promptRequest,
  publicItem,
  publicQueue,
  retryDelayMs,
  RETRY_MAX_MS,
} from '../src/queue.mjs'

const item = (over = {}) => ({
  id: 'i1',
  messageId: 'm1',
  sessionId: 'A',
  text: 'hello',
  minutes: 5,
  forceSteer: false,
  dueAt: 1000,
  createdAt: 0,
  ...over,
})

test('itemsForSession: an item scheduled in session A is not visible in session B', () => {
  const queue = [item({ id: 'a1', sessionId: 'A' }), item({ id: 'b1', sessionId: 'B' }), item({ id: 'a2', sessionId: 'A' })]
  assert.deepEqual(itemsForSession(queue, 'A').map((i) => i.id), ['a1', 'a2'])
  assert.deepEqual(itemsForSession(queue, 'B').map((i) => i.id), ['b1'])
  assert.deepEqual(itemsForSession(queue, 'C'), [])
})

test('itemsForSession: no session id means nothing, never the whole queue', () => {
  const queue = [item({ sessionId: 'A' }), item({ id: 'x', sessionId: 'B' })]
  for (const missing of [undefined, null, '', 0, {}]) {
    assert.deepEqual(itemsForSession(queue, missing), [], `sessionId ${JSON.stringify(missing)}`)
  }
  assert.deepEqual(itemsForSession(undefined, 'A'), [])
})

test('publicQueue: scoped to the session and without host-only fields', () => {
  const queue = [item({ id: 'a1', sessionId: 'A' }), item({ id: 'b1', sessionId: 'B' })]
  const view = publicQueue(queue, 'A')
  assert.equal(view.length, 1)
  assert.equal(view[0].id, 'a1')
  assert.equal('messageId' in view[0], false)
  assert.equal('createdAt' in view[0], false)
  assert.deepEqual(Object.keys(publicItem(item())).sort(), ['dueAt', 'forceSteer', 'id', 'minutes', 'sessionId', 'text'])
})

test("ownedBy: a client naming a session cannot touch another session's item", () => {
  assert.equal(ownedBy(item({ sessionId: 'A' }), 'A'), true)
  assert.equal(ownedBy(item({ sessionId: 'A' }), 'B'), false)
  for (const missing of [undefined, null, '', 0]) {
    assert.equal(ownedBy(item({ sessionId: 'A' }), missing), false, `sessionId ${JSON.stringify(missing)} owns nothing`)
  }
})

test('createItem: validates, clamps minutes, computes the due time', () => {
  const ids = { id: 'i', messageId: 'm' }
  assert.ok(createItem({ sessionId: 'A', text: '   ' }, 0, ids).error)
  assert.ok(createItem({ text: 'x' }, 0, ids).error)
  assert.ok(createItem(null, 0, ids).error)

  const { item: made } = createItem({ sessionId: 'A', text: 'ship it', minutes: '3', forceSteer: true }, 10_000, ids)
  assert.equal(made.minutes, 3)
  assert.equal(made.dueAt, 10_000 + 3 * 60_000)
  assert.equal(made.forceSteer, true)
  assert.equal(made.messageId, 'm')

  assert.equal(createItem({ sessionId: 'A', text: 'x', minutes: 0 }, 0, ids).item.minutes, 1)
  assert.equal(createItem({ sessionId: 'A', text: 'x', minutes: -4 }, 0, ids).item.minutes, 1)
  assert.equal(createItem({ sessionId: 'A', text: 'x', minutes: 'soon' }, 0, ids).item.minutes, 1)
  assert.equal(createItem({ sessionId: 'A', text: 'x', minutes: 2.6 }, 0, ids).item.minutes, 3)
  assert.equal(createItem({ sessionId: 'A', text: 'x' }, 0, ids).item.forceSteer, false)
})

test('clampMinutes: falls back for non-numbers, floors at one minute', () => {
  assert.equal(clampMinutes('7'), 7)
  assert.equal(clampMinutes(undefined, 9), 9)
  assert.equal(clampMinutes(undefined), 1)
  assert.equal(clampMinutes(0, 9), 1)
})

test('editItem: restarts the countdown and keeps identity and session', () => {
  const { item: edited } = editItem(item({ minutes: 5, dueAt: 1 }), { text: 'new', minutes: '10', forceSteer: true }, 50_000)
  assert.equal(edited.text, 'new')
  assert.equal(edited.minutes, 10)
  assert.equal(edited.forceSteer, true)
  assert.equal(edited.dueAt, 50_000 + 10 * 60_000)
  assert.equal(edited.id, 'i1')
  assert.equal(edited.sessionId, 'A')
  assert.equal(edited.messageId, 'm1')

  const { item: partial } = editItem(item({ minutes: 5 }), { text: 'only text' }, 0)
  assert.equal(partial.minutes, 5)
  assert.equal(partial.forceSteer, false)
  assert.equal(editItem(item({ minutes: 5 }), { minutes: 'x' }, 0).item.minutes, 5)
})

test('editItem: an empty or whitespace text is rejected, the same rule as scheduling', () => {
  for (const text of ['', '   ', '\n\t']) assert.ok(editItem(item(), { text }, 0).error, JSON.stringify(text))
  assert.equal(editItem(item({ text: 'keep' }), { minutes: 3 }, 0).item.text, 'keep')
})

test('dueItems: oldest due first', () => {
  const queue = [item({ id: 'late', dueAt: 300 }), item({ id: 'early', dueAt: 100 }), item({ id: 'mid', dueAt: 200 })]
  assert.deepEqual(dueItems(queue, 500).map((i) => i.id), ['early', 'mid', 'late'])
})

test('dueItems: due items only, and not while backing off', () => {
  const queue = [item({ id: 'due', dueAt: 100 }), item({ id: 'later', dueAt: 900 }), item({ id: 'backoff', dueAt: 100 })]
  const retryAt = new Map([['backoff', 600]])
  assert.deepEqual(dueItems(queue, 500, retryAt).map((i) => i.id), ['due'])
  assert.deepEqual(dueItems(queue, 600, retryAt).map((i) => i.id), ['due', 'backoff'])
  assert.deepEqual(dueItems(queue, 950).map((i) => i.id), ['due', 'backoff', 'later'])
})

test('retryDelayMs: doubles from five seconds and is capped', () => {
  assert.equal(retryDelayMs(1), 5000)
  assert.equal(retryDelayMs(2), 10000)
  assert.equal(retryDelayMs(3), 20000)
  assert.equal(retryDelayMs(30), RETRY_MAX_MS)
  assert.equal(retryDelayMs(0), 5000)
})

test("promptRequest: the composer's send call, keyed by the item's messageId", () => {
  assert.deepEqual(promptRequest(item({ text: 'go', forceSteer: false })), {
    requestId: 'm1',
    sessionId: 'A',
    mode: 'queue',
    content: [{ type: 'text', text: 'go' }],
  })
  assert.equal(promptRequest(item({ forceSteer: true })).mode, 'steer')
})

test('failure classes: a vanished session is rechecked, a rejected request is final, the rest retry', () => {
  assert.equal(isSessionGone({ code: 'session/not-found' }), true)
  assert.equal(isPermanentFailure({ code: 'session/not-found' }), false)
  assert.equal(isPermanentFailure({ code: 'gateway/bad-request' }), true)
  for (const retryable of [{ code: 'session/agent-busy' }, new Error('boom'), null]) {
    assert.equal(isPermanentFailure(retryable), false)
    assert.equal(isSessionGone(retryable), false)
  }
})

test('excerpt: bounds what a log line carries', () => {
  assert.equal(excerpt('short'), 'short')
  assert.equal(excerpt('x'.repeat(600)).length, 503)
  assert.equal(excerpt(undefined), '')
})

test('time zone: stored when valid, passed to prompt as clientTimeZone, absent for older items', () => {
  const ids = { id: 'i', messageId: 'm' }
  assert.equal(validTimeZone('Europe/Berlin'), 'Europe/Berlin')
  assert.equal(validTimeZone('Not/AZone'), undefined)
  assert.equal(validTimeZone('UTC'), 'UTC')
  for (const alias of ['GMT', 'EST', 'CET', 'utc', 'Zulu', '+05:00', ' Europe/Berlin', 'Europe/Berlin ', '']) {
    assert.equal(validTimeZone(alias), undefined, JSON.stringify(alias))
  }
  assert.equal('timeZone' in createItem({ sessionId: 'A', text: 'x', timeZone: 'EST' }, 0, { id: 'i', messageId: 'm' }).item, false)
  assert.equal(validTimeZone(5), undefined)
  const { item: made } = createItem({ sessionId: 'A', text: 'x', timeZone: 'Europe/Berlin' }, 0, ids)
  assert.equal(made.timeZone, 'Europe/Berlin')
  assert.equal(promptRequest(made).clientTimeZone, 'Europe/Berlin')
  assert.equal('timeZone' in createItem({ sessionId: 'A', text: 'x', timeZone: 'bogus' }, 0, ids).item, false)
  assert.equal('clientTimeZone' in promptRequest(item()), false)
  assert.equal(parsePersisted(JSON.stringify([{ ...made }])).items[0].timeZone, 'Europe/Berlin')
})

test('parsePersisted: reads the format earlier versions wrote', () => {
  const legacy = JSON.stringify(
    [
      { id: 'u1', messageId: 'mm1', sessionId: 'S1', text: 'first', minutes: 5, forceSteer: false, dueAt: 1700000000000, createdAt: 1699999700000 },
      { id: 'u2', messageId: 'mm2', sessionId: 'S2', text: 'second', minutes: 30, forceSteer: true, dueAt: 1700000100000, createdAt: 1699999800000 },
    ],
    null,
    2,
  )
  const { items, corrupt } = parsePersisted(legacy)
  assert.equal(corrupt, false)
  assert.equal(items.length, 2)
  assert.deepEqual(items[0], { id: 'u1', messageId: 'mm1', sessionId: 'S1', text: 'first', minutes: 5, forceSteer: false, dueAt: 1700000000000, createdAt: 1699999700000 })
  assert.equal(items[1].forceSteer, true)
})

test('parsePersisted: drops unusable rows, repairs a missing messageId, flags a corrupt file', () => {
  const { items } = parsePersisted(JSON.stringify([null, 7, { id: 'x' }, { sessionId: 'S' }, { id: 'ok', sessionId: 'S', text: 't', dueAt: 5 }]))
  assert.equal(items.length, 1)
  assert.equal(items[0].messageId, 'ok')
  assert.equal(items[0].minutes, 1)

  assert.deepEqual(parsePersisted('not json'), { items: [], corrupt: true })
  assert.deepEqual(parsePersisted('{"a":1}'), { items: [], corrupt: true })
  assert.deepEqual(parsePersisted('   '), { items: [], corrupt: false })
})

test('isInvalidTimeZone: only the harness refusing a zone', () => {
  assert.equal(isInvalidTimeZone({ code: 'session/invalid-time-zone' }), true)
  assert.equal(isInvalidTimeZone({ code: 'gateway/bad-request' }), false)
})
