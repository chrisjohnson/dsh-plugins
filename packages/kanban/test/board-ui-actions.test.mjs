// Start build, session titles, the card's host-derived facts and the drag
// arithmetic, checked against the real client and host sources.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { canStartBuild as hostCanStartBuild } from '../src/build.mjs'
import { clientSource, loadClientHelpers } from './client-source.mjs'

const HOST = fileURLToPath(new URL('../src/host.mjs', import.meta.url))
const DISPATCH = fileURLToPath(new URL('../src/dispatch.mjs', import.meta.url))

test('the card offers Start build exactly where the host would accept it', async () => {
  const { canStartBuild } = await loadClientHelpers(['canStartBuild'])
  const columns = ['backlog', 'working', 'done', 'discarded']
  const phases = ['plan', 'implement', 'review', 'verify', 'closed']
  for (const column of columns) {
    for (const phase of phases) {
      for (const status of [undefined, 'idle', 'active', 'attention']) {
        for (const awaitingQuestion of [undefined, false, true]) {
          const t = { column, phase, status, awaitingQuestion }
          assert.equal(canStartBuild(t), hostCanStartBuild(t), JSON.stringify(t))
        }
      }
    }
  }
  assert.equal(canStartBuild(null), false)
})

test('Start build is a host action over the same move the drag makes', async () => {
  const host = await readFile(HOST, 'utf8')
  assert.match(host, /import \{ moveToColumn, startBuild \} from '\.\/build\.mjs'/)
  const action = host.slice(host.indexOf("case 'action':"))
  assert.match(action, /if \(action === 'startBuild'\) \{/)
  // KAN-72: both entry points carry the WIP gate, so the cap is enforced at the
  // same seam a human drag goes through — neither path can skip it.
  assert.match(action, /const result = startBuild\(\{ store, engine: engineRef\.current, ticket, reason: p\.reason, wip: engineRef\.current\.wip \}\);/)
  const move = host.slice(host.indexOf("case 'move':"), host.indexOf("case 'resolve':"))
  assert.match(move, /wip: engineRef\.current\.wip,/)
  assert.match(move, /moved\.queued === undefined \? \{ ticket: moved\.ticket \} : \{ ticket: moved\.ticket, queued: moved\.queued \}/)
})

test('the client sends Start build as an action from the card and from the ticket page', async () => {
  const src = await clientSource()
  assert.match(src, /function startBuildNow\(id\) \{\s*\n\s*return act\("action", \{ id: id, action: "startBuild" \}\);/)
  assert.match(src, /onStartBuild: props\.onStartBuild/)
  assert.match(src, /onStartBuild: startBuildNow/)
  const hero = src.slice(src.indexOf('function TicketDetail(props)'), src.indexOf('function ApprovalPanel'))
  assert.match(hero, /canStartBuild\(\{ column: t\.column, phase: t\.phase, status: detailStatus, awaitingQuestion: d\.awaitingQuestion \}\)/)
  assert.match(hero, /props\.onAction\(t\.id, "startBuild", \{\}\)/)
})

test('workflow sessions are titled from the ticket id, session type and ticket title', async () => {
  const dispatch = await readFile(DISPATCH, 'utf8')
  assert.match(dispatch, /titles\.rename\(handle\.agent\.session, sessionTitle\(ticket, purpose\)\)/)
  // Lookups key on the sessions table and the driver's `${ticketId}:${purpose}` map, never a title.
  assert.equal(/\.title\b.*(startsWith|indexOf|includes)|(startsWith|indexOf|includes).*\.title\b/.test(dispatch), false)
})

test('the card reads host-derived facts and keeps no counters of its own', async () => {
  const src = await clientSource()
  const card = src.slice(src.indexOf('function Card(props)'), src.indexOf('function Column(props)'))
  assert.match(card, /t\.attemptLabel/)
  assert.match(card, /h\(LiveDur, \{ ticket: t \}\)/)
  assert.match(src, /var ms = \(t\.workingMs \|\| 0\) \+ \(t\.accruing/)
  assert.match(src, /return fmtDur\(ms\)/)
  assert.equal(/"try "/.test(src), false, 'the "try N" badge is gone')
  assert.equal(/kb-total|kb-age/.test(src), false)
})

test('where a drag lands is read from the pointer against the card midpoints', async () => {
  const { dropBefore, dropIsNoop } = await loadClientHelpers(['dropBefore', 'dropIsNoop'])
  const rects = [{ id: 'a', top: 0, height: 100 }, { id: 'b', top: 108, height: 100 }, { id: 'c', top: 216, height: 100 }]
  assert.equal(dropBefore(rects, -20), 'a')
  assert.equal(dropBefore(rects, 49), 'a')
  assert.equal(dropBefore(rects, 51), 'b', 'past the middle of a, before b')
  assert.equal(dropBefore(rects, 104), 'b', 'in the gap between cards the answer does not jump to the end')
  assert.equal(dropBefore(rects, 157), 'b')
  assert.equal(dropBefore(rects, 159), 'c')
  assert.equal(dropBefore(rects, 260), 'c')
  assert.equal(dropBefore(rects, 300), null, 'below the last midpoint is the end of the column')
  assert.equal(dropBefore([], 10), null)
  assert.equal(dropIsNoop(['a', 'b', 'c'], 'b', 'c'), true)
  assert.equal(dropIsNoop(['a', 'b', 'c'], 'c', null), true)
  assert.equal(dropIsNoop(['a', 'b', 'c'], 'c', undefined), true)
  assert.equal(dropIsNoop(['a', 'b', 'c'], 'a', 'c'), false)
  assert.equal(dropIsNoop(['a', 'b', 'c'], 'a', null), false)
  assert.equal(dropIsNoop(['a', 'b'], 'zzz', null), false, 'a card from another column always moves')
})

test('the board shows a drop at once, without mutating the board it was handed', async () => {
  const { moveInColumns } = await loadClientHelpers(['moveInColumns'])
  const t = (id) => ({ id, column: 'x' })
  const columns = { backlog: [t('a'), t('b'), t('c')], working: [t('w')], done: [t('d')], discarded: [] }
  const frozen = JSON.stringify(columns)
  assert.deepEqual(moveInColumns(columns, 'c', 'backlog', 'a').backlog.map((x) => x.id), ['c', 'a', 'b'])
  assert.deepEqual(moveInColumns(columns, 'a', 'backlog', null).backlog.map((x) => x.id), ['b', 'c', 'a'])
  const across = moveInColumns(columns, 'b', 'working', 'w')
  assert.deepEqual(across.backlog.map((x) => x.id), ['a', 'c'])
  assert.deepEqual(across.working.map((x) => x.id), ['b', 'w'])
  assert.equal(across.working[0].column, 'working')
  assert.deepEqual(moveInColumns(columns, 'nope', 'working', null), columns)
  assert.equal(JSON.stringify(columns), frozen)
})

test('the cards have no drop handlers of their own: the column owns the drop', async () => {
  const src = await clientSource()
  const card = src.slice(src.indexOf('function Card(props)'), src.indexOf('function Column(props)'))
  assert.equal(/onDragOver|onDrop\b/.test(card.replace(/\/\/.*$/gm, '')), false)
  const column = src.slice(src.indexOf('function Column(props)'), src.indexOf('function SegmentedControl'))
  assert.match(column, /onDragOver: function \(ev\)/)
  assert.match(column, /onDrop: function \(ev\)/)
})

// ------------------------------------------------------------------ KAN-72 --
//
// The cap is the engine's rule; the page is where a person changes it and where
// a queued move has to explain itself. These are source contracts over the real
// browser half and the real host, the same way the Start build wiring is pinned.

test('setWipCap is a registered endpoint the header control calls', async () => {
  const host = await readFile(HOST, 'utf8')
  assert.match(host, /'setWipCap',/, 'it must be in ENDPOINTS or the route is never registered')
  const endpoint = host.slice(host.indexOf("case 'setWipCap'"), host.indexOf("case 'create'"))
  assert.match(endpoint, /engineRef\.current\.setWipCap\(p\.cap, \{ actor: 'human' \}\)/)
  assert.match(endpoint, /boardFeedRef\.current\?\.notify\(\)/, 'a cap change wakes the push channel so every open page redraws')
})

test('the header carries a WIP pill that opens the cap dialog', async () => {
  const src = await clientSource()
  assert.match(src, /function WipControl\(props\) \{/)
  assert.match(src, /children: "WIP " \+ occupancy \+ "\/" \+ \(cap === null \? "\?" : cap\)/)
  assert.match(src, /h\(WipControl, \{ wip: board \? board\.wip : null, onSave: function \(cap\) \{ return act\("setWipCap", \{ cap: cap \}\); \} \}\)/)
  // The dialog edits a whole number of at least one and refuses anything else.
  assert.match(src, /type: "number", min: "1", step: "1"/)
  assert.match(src, /The cap has to be a whole number of at least 1\./)
})

test('the Working column header speaks in the cap units the pill uses', async () => {
  const src = await clientSource()
  assert.match(src, /var wipLabel = wipInfo && typeof wipInfo\.occupancy === "number" \? wipInfo\.occupancy \+ "\/" \+ wipInfo\.cap : null;/)
  assert.match(src, /column: "working", label: "Working", items: columns\.working, countLabel: wipLabel, countTitle: wipTitle/)
  assert.match(src, /children: props\.countLabel === undefined \|\| props\.countLabel === null \? items\.length : props\.countLabel/)
})

test('a queued move reads as a queue place, not a failure, in both paths', async () => {
  const src = await clientSource()
  // The action path (Start build, the ticket page) and the drag path both show
  // the engine's own sentence when the board was full.
  assert.match(src, /var queued = res\.value && res\.value\.queued;\s*\n\s*setNotice\(queued \? queued\.reason : null\);/)
  assert.match(src, /else if \(res && res\.value && res\.value\.queued\) setNotice\(res\.value\.queued\.reason\);/)
})
