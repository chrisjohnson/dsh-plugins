// What the scheduler's tick costs when there is nothing to launch, and that it
// still launches what it should; plus the browser half's polling rules, pinned
// at the source the way the other client contracts are.

import test from 'node:test'
import assert from 'node:assert/strict'

import { setup } from './support/engine-harness.mjs'
import { clientSource } from './client-source.mjs'

test('a tick with nothing runnable reads one narrow query and decodes no tickets', async () => {
  const { engine, store } = setup()
  for (let i = 0; i < 20; i += 1) {
    const t = store.createTicket({ title: `parked ${i}`, column: 'working' })
    store.setNeedsAttention(t.id, 'stuck')
    store.createTicket({ title: `waiting ${i}` })
  }
  engine.recovered = true
  const calls = []
  const runnable = store.listRunnable.bind(store)
  store.listRunnable = () => { const rows = runnable(); calls.push(rows.length); return rows }
  store.listTickets = () => { throw new Error('the tick must not list every ticket') }
  await engine.tick()
  await engine.tick()
  assert.deepEqual(calls, [0, 0])
  assert.equal(engine.active.size, 0)
})

test('a tick at the concurrency cap does not read the store at all', async () => {
  const { engine, store } = setup()
  engine.recovered = true
  engine.active.set('x', Promise.resolve())
  engine.active.set('y', Promise.resolve())
  engine.active.set('z', Promise.resolve())
  store.listRunnable = () => { throw new Error('at the cap nothing can launch') }
  await engine.tick()
})

test('a tick still launches runnable tickets in queue order, up to the cap, and skips parked and busy ones', async () => {
  const { engine, store, driver } = setup(undefined, { config: { wipCap: 2 } })
  engine.recovered = true
  const parked = store.createTicket({ title: 'parked', column: 'working' })
  store.setNeedsAttention(parked.id, 'stuck')
  const busy = store.createTicket({ title: 'busy', column: 'working' })
  const first = store.createTicket({ title: 'first', column: 'working' })
  const second = store.createTicket({ title: 'second', column: 'working' })
  const third = store.createTicket({ title: 'third', column: 'working' })
  driver.isTicketBusy = (id) => id === busy.id
  const launched = []
  engine.launch = (ticket) => { launched.push(ticket.id); engine.active.set(ticket.id, Promise.resolve()) }
  await engine.tick()
  assert.deepEqual(launched, [first.id, second.id])
  assert.equal(launched.includes(third.id), false, 'the cap holds the rest back')
})

test('the browser half polls nothing on a timer: the board comes by stream and the ticket by token', async () => {
  const src = await clientSource()
  const page = src.slice(src.indexOf('function KanbanPage()'), src.indexOf('PhaseBanner'))
  assert.equal(/setInterval\(\s*function \(\) \{\s*poll/.test(page), false)
  assert.equal(/rpc\("board"/.test(page), false, 'the page never asks for the board itself')
  assert.match(page, /rpc\("ticket", \{ id: id, since: since, events: false \}\)/, 'the ticket is asked with its token and without the event log')
  assert.match(page, /if \(res\.value && res\.value\.unchanged\) return;/)
  assert.match(page, /React\.useEffect\(function \(\) \{\s*if \(!routingOpen\) return;\s*rpc\("config"/, 'routing is read when its dialog opens')
  assert.equal(/setInterval\(loadRouting/.test(page), false)
  assert.match(page, /\}, \[creating\]\);/, 'workspaces and presets are read with the form, not per selection')
  assert.match(page, /if \(!document\.hidden\) loadDetail/, 'the live-bar refresh pauses with the tab')
  assert.match(src, /var STREAM_URL = "\/api\/kanban\/stream"/)
  assert.match(src, /var BoardCard = React\.memo\(Card, sameCard\)/)
  assert.match(src, /nextFrame\(function \(\) \{/, 'drag measurement is once per frame')
})
