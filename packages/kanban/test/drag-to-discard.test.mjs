// KAN-85: dragging a ticket onto the merged "Done / Discarded" column discards
// it, but only after a confirmation prompt. The board's closed column used to be
// hard-wired non-droppable on the client while the host already accepted a move
// to `discarded`; these source contracts pin the new behaviour against the real
// browser half (and the host guard that keeps `done` approval-only).
//
// The drag handlers live inside the KanbanPage component, so they are not
// top-level functions the client-source slicer can lift out; like the other
// board-ui checks these are regexes over the exact source the browser runs.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { clientSource, loadClientHelpers } from './client-source.mjs'

const HOST = fileURLToPath(new URL('../src/host.mjs', import.meta.url))

function slice(src, from, to) {
  const start = src.indexOf(from)
  assert.ok(start >= 0, `client.mjs has no ${from}`)
  const end = src.indexOf(to, start)
  assert.ok(end > start, `could not find the end of ${from}`)
  return src.slice(start, end)
}

test('the closed column is a drop target like the others', async () => {
  const src = await clientSource()
  const column = slice(src, 'function Column(props)', 'function SegmentedControl')
  // The old `droppable = props.column !== "done"` gate is gone entirely.
  assert.equal(/droppable/.test(column), false, 'no per-column droppable restriction remains')
  // drag-over and drop now run for every column, gated only on a drag being live.
  assert.match(column, /onDragOver: function \(ev\) \{\s*\n\s*if \(!dragging\) return;/)
  assert.match(column, /onDrop: function \(ev\) \{\s*\n\s*ev\.preventDefault\(\);/)
  // And the board keeps reporting the pointer position over the closed column.
  const dragOver = slice(src, 'function dragOverColumn(', 'function dropAt(')
  assert.match(dragOver, /if \(dragId === null\) return;/)
  assert.equal(/column === "done"/.test(dragOver), false, 'dragOverColumn no longer drops the closed column on the floor')
})

test('a drop onto the closed column opens the prompt and sends nothing', async () => {
  const src = await clientSource()
  const dropAt = slice(src, 'function dropAt(', 'function discardTicket(')
  assert.match(dropAt, /if \(column === "done"\) \{/)
  assert.match(dropAt, /setConfirmDiscard\(id\);/)
  // The closed-column branch returns before any hold / optimistic move / RPC, so
  // the drop itself is inert; only the confirm acts.
  const branch = dropAt.slice(dropAt.indexOf('if (column === "done")'), dropAt.indexOf('var source ='))
  assert.match(branch, /return;/, 'the done branch returns before the ordinary move path')
  assert.equal(/rpc\(|boardStore\.hold|moveInColumns/.test(branch), false, 'the drop performs no move and no RPC')
  // A card that is already closed is a no-op: only an open (backlog/working) card
  // raises the prompt.
  assert.match(branch, /dropped\.column === "backlog" \|\| dropped\.column === "working"/)
})

test('confirming discards through a move to discarded, with no trailing reorder', async () => {
  const src = await clientSource()
  const discard = slice(src, 'function discardTicket(', 'phase-change banner')
  assert.match(discard, /rpc\("move", \{ id: id, column: "discarded" \}\)/)
  // Never a move to done, and no reorder: the closed column is ordered by close
  // time, so a position anchored on a done card is not honoured.
  assert.equal(/column: "done"/.test(discard), false, 'the discard path never moves to done')
  assert.equal(/reorder\(/.test(discard), false, 'no trailing reorder for the closed column')
  // Same hold / optimistic-update / release / reload shape as a normal drop.
  assert.match(discard, /boardStore\.hold\(\);/)
  assert.match(discard, /moveInColumns\(prev\.columns, id, "discarded", null\)/)
  assert.match(discard, /boardStore\.release\(\);/)
  assert.match(discard, /loadBoard\(\);/)
  // The prompt closes as the discard begins.
  assert.match(discard, /setConfirmDiscard\(null\);/)
})

test('cancelling the prompt closes it and issues nothing', async () => {
  const src = await clientSource()
  const modal = slice(src, 'title: "Discard ticket"', 'selectedId ? h(TicketDetail')
  // Backdrop / Escape close and the Cancel button only clear the state.
  assert.match(modal, /onClose: function \(\) \{ setConfirmDiscard\(null\); \}/)
  assert.match(modal, /children: "Cancel"/)
  assert.match(modal, /onClick: function \(\) \{ setConfirmDiscard\(null\); \}/)
  assert.equal(/rpc\(|boardStore\./.test(modal), false, 'cancel and close send no RPC and touch no store')
  // The confirm button is the only thing that acts, and it names the danger.
  assert.match(modal, /className: "kb-btn danger"[^}]*discardTicket\(confirmDiscard\)/)
})

test('the prompt state is unconditional board state', async () => {
  const src = await clientSource()
  // A board-level useState, not a conditional hook: the Rules-of-Hooks gate runs
  // over this file, but pin the shape so a refactor cannot quietly nest it.
  assert.match(src, /var cd = React\.useState\(null\);\s*\n\s*var confirmDiscard = cd\[0\], setConfirmDiscard = cd\[1\];/)
})

test('done stays unreachable by drag: the client never moves to it and the host refuses it', async () => {
  const src = await clientSource()
  // No move RPC anywhere names the done column literally.
  assert.equal(/rpc\("move", \{[^}]*column: "done"/.test(src), false)
  const host = await readFile(HOST, 'utf8')
  const move = host.slice(host.indexOf("case 'move':"), host.indexOf("case 'resolve':"))
  assert.match(move, /if \(column === 'done'\) return fail\('bad_request'/, 'the host keeps done approval-only')
})

test('the optimistic discard update lands the card in the discarded column', async () => {
  const { moveInColumns } = await loadClientHelpers(['moveInColumns'])
  const t = (id, column) => ({ id, column })
  const columns = { backlog: [t('a', 'backlog')], working: [t('w', 'working')], done: [t('d', 'done')], discarded: [] }
  const frozen = JSON.stringify(columns)
  const next = moveInColumns(columns, 'a', 'discarded', null)
  assert.deepEqual(next.backlog.map((x) => x.id), [])
  assert.deepEqual(next.discarded.map((x) => x.id), ['a'])
  assert.equal(next.discarded[0].column, 'discarded')
  assert.equal(JSON.stringify(columns), frozen, 'the input board is never mutated')
})
