// KAN-73: the orchestrator tray and the live border on the Work page's button.
//
// The geometry and the state join are pure, so they are sliced out of the real
// browser half and run here (see test/client-source.mjs); the rest is asserted
// against the source text, the way the file's other UI tests do.

import test from 'node:test'
import assert from 'node:assert/strict'

import { clientSource, loadClientHelpers, sliceFunction } from './client-source.mjs'

const CONSTS = { ORC_SPARKLES: 8, MOBILE_MAX_PX: 768 }

const { isNarrow, orchWorking, orchTitle, sparklePositions, trayStrips, trayPillPos } =
  await loadClientHelpers(['isNarrow', 'orchWorking', 'orchTitle', 'sparklePositions', 'trayStrips', 'trayPillPos'], CONSTS)

// --------------------------------------------------------------------- narrow --

test("a phone is 768 wide or less, the same line the board's CSS breaks on", () => {
  assert.equal(isNarrow(360), true)
  assert.equal(isNarrow(768), true, 'the breakpoint is inclusive, like the media query')
  assert.equal(isNarrow(769), false)
  assert.equal(isNarrow(1440), false)
})

// ------------------------------------------------------------------- working --

test('the ring moves only for a live orchestrator with a turn in flight', () => {
  assert.equal(orchWorking('live', true), true)
  assert.equal(orchWorking('live', false), false, 'idle is not working')
  assert.equal(orchWorking('starting', true), false, 'a session that is not the orchestrator yet cannot be working')
  assert.equal(orchWorking('archived', true), false)
  assert.equal(orchWorking('off', true), false)
  assert.equal(orchWorking(null, true), false)
  assert.equal(orchWorking('live', 1), false, 'the flag is the flag, not truthy noise')
})

test('the tooltip says what the state actually is', () => {
  assert.match(orchTitle('live', true), /working/i)
  assert.match(orchTitle('live', false), /Open the permanent orchestrator session/)
  assert.match(orchTitle('starting', false), /starting/i)
  assert.match(orchTitle('archived', false), /archived/i)
  assert.match(orchTitle('off', false), /turned off/i)
  assert.match(orchTitle(null, false), /Open the permanent orchestrator session/, 'unknown reads as the plain invitation')
})

// ------------------------------------------------------------------ sparkles --

test('eight sparkles sit on the button edge, staggered, drifting outward', () => {
  const spots = sparklePositions(8)
  assert.equal(spots.length, 8)
  for (const s of spots) {
    const onEdge = s.x === 0 || s.x === 50 || s.x === 100 || s.y === 0 || s.y === 50 || s.y === 100
    assert.ok(onEdge, `(${s.x}, ${s.y}) is on the box edge, not floating inside it`)
    assert.ok(s.x >= 0 && s.x <= 100 && s.y >= 0 && s.y <= 100, 'inside the box bounds')
    // The drift points away from the centre, so the shower leaves the ring.
    assert.equal(Math.sign(s.dx || 0), Math.sign(s.x - 50) || Math.sign(s.dx || 0), 'dx follows the outward direction')
    assert.ok(Math.abs(s.dx) <= 7 && Math.abs(s.dy) <= 7, 'and only a few pixels of it')
  }
  const delays = spots.map((s) => s.delay)
  assert.equal(new Set(delays).size, 8, 'no two twinkle in step')
  assert.ok(Math.max(...delays) < 1.5, 'the whole shower fits inside one twinkle cycle')
})

test('the sparkle count is the count, and a silly count still gives something', () => {
  assert.equal(sparklePositions(4).length, 4)
  assert.equal(sparklePositions(12).length, 12)
  assert.equal(sparklePositions(0).length, 8)
  assert.equal(sparklePositions(undefined).length, 8)
})

// --------------------------------------------------------------------- tray ---

const FRAME = { w: 1600, h: 900 }
const HOLE = { left: 300, top: 0, right: 1200, bottom: 900 }

test('the dim is four strips that tile the frame minus the hole', () => {
  const strips = trayStrips(HOLE, FRAME.w, FRAME.h)
  assert.ok(strips, 'a real hole gets a dim')
  assert.equal(strips.length, 2, 'a full-height centre column leaves only the two side strips')
  const area = strips.reduce((sum, s) => sum + s.width * s.height, 0)
  assert.equal(area, (FRAME.w - (HOLE.right - HOLE.left)) * FRAME.h, 'they cover exactly the frame outside the hole')
  for (const s of strips) {
    assert.ok(s.left + s.width <= FRAME.w + 1 && s.top + s.height <= FRAME.h + 1, 'nothing hangs off the frame')
    const overlapsHole = s.left < HOLE.right && s.left + s.width > HOLE.left && s.top < HOLE.bottom && s.top + s.height > HOLE.top
    assert.equal(overlapsHole, false, 'nothing is painted over the tray')
  }
})

test('a hole with margins on all four sides gets all four strips', () => {
  const strips = trayStrips({ left: 300, top: 60, right: 1200, bottom: 800 }, FRAME.w, FRAME.h)
  assert.equal(strips.length, 4)
  const area = strips.reduce((sum, s) => sum + s.width * s.height, 0)
  assert.equal(area, FRAME.w * FRAME.h - 900 * 740)
})

test('no usable hole means no strips: the caller dims the whole frame instead', () => {
  assert.equal(trayStrips(null, FRAME.w, FRAME.h), null)
  assert.equal(trayStrips({ left: 0, top: 0, right: 100, bottom: 900 }, FRAME.w, FRAME.h), null, 'a sliver is not a tray')
  assert.equal(trayStrips({ left: 0, top: 0, right: 1600, bottom: 900 }, FRAME.w, FRAME.h).length, 0, 'a hole the size of the frame dims nothing')
})

test('fractional rects are rounded once, so the strips abut the hole without a seam', () => {
  const a = trayStrips({ left: 300.6, top: 0, right: 1200.4, bottom: 900 }, FRAME.w, FRAME.h)
  const rightStrip = a.find((s) => s.left > 0)
  assert.equal(rightStrip.left, 1200, 'the right strip starts on the same rounded edge the hole ends on')
})

test("the pill floats at the tray's top-right corner", () => {
  const withRightbar = trayPillPos(HOLE, FRAME.w)
  assert.equal(withRightbar.top, 10)
  assert.equal(withRightbar.right, 412, '12px inside the centre column, not out over the right sidebar')
  const noRightbar = trayPillPos({ left: 0, top: 40, right: 1600, bottom: 900 }, FRAME.w)
  assert.deepEqual(noRightbar, { top: 50, right: 12 }, 'with no right column it sits at the frame corner')
  assert.equal(trayPillPos(null, FRAME.w), null)
})

// ------------------------------------------------------------------- stores ---

const { createOrchStore, createTrayStore } = await loadClientHelpers(['orchWorking', 'createOrchStore', 'createTrayStore'], CONSTS)

function fakeList(rows, phase) {
  const listeners = []
  return {
    listeners,
    subscribe: (fn) => {
      listeners.push(fn)
      return () => {
        const at = listeners.indexOf(fn)
        if (at >= 0) listeners.splice(at, 1)
      }
    },
    getSnapshot: () => ({ phase: phase || 'ready', byId: rows }),
    fire: () => listeners.slice().forEach((fn) => fn()),
  }
}

test("the orchestrator store joins the Host's answer with the shell's running flag", () => {
  const rows = { 'kanban-orchestrator': { id: 'kanban-orchestrator', running: false, retainedBy: { mainView: 0 } } }
  const list = fakeList(rows)
  let asked = 0
  const store = createOrchStore({
    rpc: () => {
      asked += 1
      return Promise.resolve({ ok: true, value: { state: 'live', sessionId: 'kanban-orchestrator', paused: false } })
    },
    sessionsList: () => list,
  })

  assert.equal(store.get().working, false, 'nothing is working before anything is known')
  // The list watch is only attached while something on screen reads the answer,
  // so subscribe first — exactly what the Work page button does.
  const stop = store.subscribe(() => {})
  store.setInfo({ state: 'live', sessionId: 'kanban-orchestrator' })
  assert.equal(store.get().working, false, 'live but idle')
  rows['kanban-orchestrator'].running = true
  list.fire()
  assert.equal(store.get().working, true, 'the pushed running flag lights it up without a poll')
  rows['kanban-orchestrator'].running = false
  list.fire()
  assert.equal(store.get().working, false, 'and takes it away again')
  stop()

  return store.refresh().then((ok) => {
    assert.equal(ok, true)
    assert.equal(asked, 1)
    assert.equal(store.get().state, 'live')
    assert.equal(store.get().sessionId, 'kanban-orchestrator')
  })
})

test('the store only watches the session list while something is showing the answer', () => {
  const list = fakeList({ a: { id: 'a', running: false, retainedBy: {} } })
  const store = createOrchStore({ rpc: () => Promise.resolve({ ok: false }), sessionsList: () => list })
  assert.equal(list.listeners.length, 0, 'no subscription before anyone asks')
  const off1 = store.subscribe(() => {})
  assert.equal(list.listeners.length, 1)
  const off2 = store.subscribe(() => {})
  assert.equal(list.listeners.length, 1, 'a second subscriber does not double-watch')
  off1()
  assert.equal(list.listeners.length, 1, 'the first leaving keeps the watch')
  off2()
  assert.equal(list.listeners.length, 0, 'the last one detaches it')
})

test('a store with no session list degrades to never working, not to a crash', () => {
  const store = createOrchStore({ rpc: () => Promise.resolve({ ok: true, value: { state: 'live', sessionId: 'x' } }) })
  store.setInfo({ state: 'live', sessionId: 'x' })
  assert.equal(store.get().running, false)
  assert.equal(store.get().working, false)
  assert.equal(store.isMainSession('x'), null, 'unknown, so nothing auto-closes on a guess')
  assert.equal(typeof store.watchList(() => {}), 'function')
})

test("isMainSession reads the shell's own retention, not a guessed current id", () => {
  const rows = {
    orch: { id: 'orch', running: false, retainedBy: { mainView: 1 } },
    other: { id: 'other', running: false, retainedBy: {} },
  }
  const store = createOrchStore({ rpc: () => Promise.resolve({ ok: false }), sessionsList: () => fakeList(rows) })
  assert.equal(store.isMainSession('orch'), true)
  assert.equal(store.isMainSession('other'), false, 'a session the main view dropped stops being the tray')
  assert.equal(store.isMainSession('gone'), false)
})

test('the tray store publishes open and close, and only when it changed', () => {
  const store = createTrayStore()
  let fired = 0
  const off = store.subscribe(() => { fired += 1 })
  assert.deepEqual(store.get(), { open: false, sessionId: null })
  store.openWith('kanban-orchestrator')
  assert.equal(store.get().open, true)
  assert.equal(store.get().sessionId, 'kanban-orchestrator')
  store.openWith('kanban-orchestrator')
  assert.equal(fired, 1, 're-opening the same session is not a change')
  store.close()
  assert.equal(store.get().open, false)
  assert.equal(store.get().sessionId, null)
  store.close()
  assert.equal(fired, 2, 'a second close is not a change either')
  off()
})

// ----------------------------------------------------------- the browser half --

test('the Work page button carries the ring, the glow and the sparkles', async () => {
  const src = await clientSource()
  const page = sliceFunction(src, 'KanbanPage')
  assert.ok(page.includes('"kb-btn kb-btn-orc" + orchGlowClass(orch.state, orch.paused, orch.working)'), 'one class swap carries all three looks')
  assert.ok(page.includes('className: "kb-orc-ring"'), 'the rotating ring is in the button')
  assert.ok(page.includes('className: "kb-orc-glow"'), 'and the glow with it')
  assert.ok(page.includes('sparklePositions(ORC_SPARKLES)'), 'sparkles are mounted from the shared count')
  assert.ok(page.includes('orch.working ? sparklePositions'), 'only while it is working')
  assert.ok(page.includes('children: "Open orchestrator"'), 'the label is still the label')
  assert.ok(page.includes('onClick: function () { openOrchestratorTray(); }'), 'and it opens the tray')
  // The indicator is a hook, called unconditionally, like every other hook here.
  assert.ok(page.includes('var orch = useOrchWork();'))
  assert.equal(/if[\s\S]{0,40}useOrchWork\(/.test(page), false, 'never a conditional hook')
})

// KAN-73 round 2: the arrow and the two actions left the desktop header for the
// tray pill, and the same component covers the phone, where there is no tray.
test('the switch arrow lives in the tray pill, and in the header only on a phone', async () => {
  const src = await clientSource()
  const page = sliceFunction(src, 'KanbanPage')
  const actions = sliceFunction(src, 'OrchestratorActions')
  const tray = sliceFunction(src, 'OrchestratorTray')

  assert.match(actions, /title: "Switch to the orchestrator session"/)
  assert.match(actions, /children: h\(JumpIcon\)/, 'the same icon a card uses to jump to its session')
  assert.match(actions, /onClick: function \(\) \{ openOrchestrator\(\); \}/, 'a full switch, at every size')
  assert.equal(actions.includes('kb-btn-orc'), false, 'the launcher is not part of the moved row')

  assert.match(tray, /h\(OrchestratorActions, \{ className: "kb-tray-actions" \}\)/, 'the pill renders the row')
  const header = page.slice(page.indexOf('className: "kb-actions"'))
  assert.match(header, /kb-orc-mobileonly/, 'the header keeps a phone-only copy')
  assert.ok(src.includes('.kb-orc-mobileonly{display:none}'), 'hidden on a wide window')
  assert.ok(/@media \(max-width:768px\)\{[\s\S]*\.kb-orc-mobileonly\{display:inline-flex/.test(src), 'shown again at phone width')
})

// KAN-73 round 2: the glow is the enabled/disabled readout; colour alone is not.
test('the glow class says working, disabled, or plain idle — and never guesses', async () => {
  const { orchGlowClass, pillCompact } = await loadClientHelpers(['orchGlowClass', 'pillCompact'], CONSTS)
  assert.equal(orchGlowClass('live', false, true), ' working', 'a turn in flight moves and sparkles')
  assert.equal(orchGlowClass('live', false, false), '', 'enabled and idle: colourful, still, glow steady')
  assert.equal(orchGlowClass('live', true, false), ' disabled', 'a human pause is not an orchestrator that can act')
  assert.equal(orchGlowClass('live', true, true), ' disabled', 'and a pause outranks a turn still winding down')
  assert.equal(orchGlowClass('off', false, true), ' disabled', 'same for an orchestrator that is off')
  assert.equal(orchGlowClass('off', false, false), ' disabled')
  assert.equal(orchGlowClass('archived', false, false), ' disabled')
  assert.equal(orchGlowClass(null, false, false), '', 'before the first read, do not flash the disabled look')
  assert.equal(orchGlowClass(null, false, true), ' working', 'working still wins over an unknown state')
  // The disabled glow must be the dimmer one in the sheet, by a wide margin.
  const src = await clientSource()
  const disabled = src.match(/\.kb-btn-orc\.disabled \.kb-orc-glow\{[^}]*\}/)
  const idle = src.match(/\.kb-orc-glow\{[^}]*\}/)
  assert.ok(disabled, 'the disabled rule exists')
  const dOpacity = Number(/opacity:([\d.]+)/.exec(disabled[0])[1])
  const iOpacity = Number(/opacity:([\d.]+)/.exec(idle[0])[1])
  assert.ok(dOpacity <= 0.1, `disabled glow is almost hidden (${dOpacity})`)
  assert.ok(iOpacity >= 0.25, `idle glow is clearly lit (${iOpacity})`)
  assert.ok(dOpacity * 3 < iOpacity, 'and the two are not hard to tell apart')
  assert.equal(pillCompact(419), true, 'a narrow tray drops the word and keeps the icons')
  assert.equal(pillCompact(420), false)
  assert.equal(pillCompact(1220), false)
})

// KAN-73 round 3: the header is one tidy line, and "paused" is a look on the
// button rather than a badge next to it.
test('the paused badge left the header and the button carries the news instead', async () => {
  const src = await clientSource()
  const page = sliceFunction(src, 'KanbanPage')
  const tray = sliceFunction(src, 'OrchestratorTray')
  assert.equal(page.includes('Orchestrator paused'), false, 'no paused chip in the Work header any more')
  assert.equal(page.includes('orchestratorPaused ? h('), false, 'and no conditional chip element')
  assert.match(tray, /work\.paused \? "Orchestrator paused" : "Orchestrator"/, 'the pill says it in words instead')
  // The board pushes the pause, so the border does not wait for the next status read.
  assert.match(page, /orchStore\.setPaused\(live\.board \? live\.board\.orchestratorPaused : false\)/)
  assert.match(page, /className: "kb-btn kb-btn-orc" \+ orchGlowClass/)
  // A disabled button loses colour, not only the halo.
  const disc = src.match(/\.kb-btn-orc\.disabled \.kb-orc-disc\{[^}]*\}/)
  assert.ok(disc, 'the disabled disc rule exists')
  assert.ok(/opacity:\.(?:[0-3]\d?|0\.\d)/.test(disc[0]), `the ring is dimmed: ${disc[0]}`)
  assert.ok(/saturate\(\.?\d/.test(disc[0]), 'and desaturated')
  // The view switch is a segmented pair, not two buttons competing with actions.
  assert.match(page, /h\(SegmentedControl, \{[\s\S]{0,400}kb-viewseg/)
  assert.match(src, /\.kb-actions\{[^}]*justify-content:flex-end/, 'wrapped action lines stay right-aligned')
  assert.match(src, /\.kb-actions-tail\{/, 'the tail travels as one unit')
})

test('the tray is a frame-wide overlay entry, not part of the board page', async () => {
  const src = await clientSource()
  assert.ok(src.includes('slots.inject("shell.overlay"'), 'registered in the shell overlay layer')
  assert.ok(src.includes('id: "kanban-orchestrator-tray"'))
  const tray = sliceFunction(src, 'OrchestratorTray')
  assert.ok(tray.includes('React.useEffect'), 'its watchers are effects, run unconditionally')
  assert.equal(/if[\s\S]{0,60}React\.use(State|Effect)\(/.test(tray.replace(/function \(\) \{[\s\S]*?\}\s*return undefined;/g, '')), false)
  assert.ok(tray.includes('closeTray(true)'), 'the pill and the dim both go back to the board')
  assert.ok(tray.includes('"Escape"'), 'Esc closes it')
  assert.ok(tray.includes('kb-tray-drop'), 'and the column pulls down as it opens')
})

test('the stylesheet draws the ring in the five workflow colors and stops for reduced motion', async () => {
  const src = await clientSource()
  const ring = src.match(/\.kb-orc-disc\{[^"]*\}/)
  assert.ok(ring, 'the disc rule exists')
  for (const color of ['#2563eb', '#0d9488', '#db2777', '#7c3aed', '#15803d']) {
    assert.ok(ring[0].includes(color), `${color} is one of the five phase colors`)
  }
  assert.ok(/@keyframes kb-orc-spin\{to\{transform:[^}]*rotate\(360deg\)/.test(src), 'the spin is a transform, so it runs on the compositor')
  assert.ok(src.includes('.kb-btn-orc:not(.working) .kb-orc-disc{animation-play-state:paused}'), 'idle freezes the ring where it stands')
  assert.ok(!/\.kb-btn-orc\.working \.kb-orc-spark\{animation/.test(src), 'sparkles are mounted and unmounted, not paused')
  assert.ok(/@media \(prefers-reduced-motion:reduce\)\{[^"]*\.kb-orc-spark\{display:none\}/.test(src), 'reduced motion drops the sparkles')
  assert.ok(src.includes('.kb-tray-dim{position:fixed'), 'the dim is viewport-anchored, so it matches getBoundingClientRect')
})
