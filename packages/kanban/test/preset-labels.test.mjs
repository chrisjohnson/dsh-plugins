import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { BUILT_IN_PRESET_NAMES, presetDisplayName } from '../src/preset-labels.mjs'
import { clientSource, loadClientHelpers } from './client-source.mjs'

// KAN-56: the board used to print the registry ids — "standard", "ptc",
// "minimal", "cordis" — where the harness's own preset UI says "Standard mode",
// "PTC mode", "Minimal mode", "Creator mode". These tests pin the wording, the
// fallbacks, and the fact that the browser half mirrors the Host half.

const HARNESS_NAMES = {
  standard: 'Standard mode',
  ptc: 'PTC mode',
  minimal: 'Minimal mode',
  cordis: 'Creator mode',
}

test('the four shipped ids read as the harness names', () => {
  assert.deepEqual(BUILT_IN_PRESET_NAMES, HARNESS_NAMES)
  for (const [id, name] of Object.entries(HARNESS_NAMES)) {
    assert.equal(presetDisplayName(id), name)
    assert.equal(presetDisplayName(id, undefined), name)
    assert.equal(presetDisplayName(id, null), name)
  }
})

test('a custom preset keeps the name its declaration published', () => {
  assert.equal(presetDisplayName('code-review', 'Code review'), 'Code review')
  // A shipped id is never relabelled by the fallback: the built-in wins.
  assert.equal(presetDisplayName('standard', 'Standard mode'), 'Standard mode')
})

test('an unknown id with no published name falls back to the id', () => {
  assert.equal(presetDisplayName('mystery'), 'mystery')
  assert.equal(presetDisplayName('mystery', undefined), 'mystery')
  assert.equal(presetDisplayName('mystery', ''), 'mystery')
  assert.equal(presetDisplayName('mystery', null), 'mystery')
})

test('an empty id says nothing rather than crashing', () => {
  assert.equal(presetDisplayName(undefined, 'Published'), 'Published')
  assert.equal(presetDisplayName(null, undefined), '')
})

test('the browser half mirrors the same four pairs inline', async () => {
  // src/client.mjs is a classic script: it cannot import this module, so it
  // carries the same map. A drift here is the board disagreeing with the
  // harness again, which is exactly what this file exists to prevent.
  const client = await clientSource()
  const inline = client.match(/var builtIn = \{([^}]*)\};/)
  assert.ok(inline, 'client.mjs must carry the built-in preset name map')
  const pairs = Object.fromEntries([...inline[1].matchAll(/(\w+):\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]))
  assert.deepEqual(pairs, BUILT_IN_PRESET_NAMES)
})

test('the client picker labels built-ins with the harness names', async () => {
  const { presetOptions } = await loadClientHelpers(['presetDisplayName', 'presetNameFromWire', 'presetOptions'])

  // What the Host now sends: ids plus harness names.
  const wire = {
    default: 'standard',
    items: [
      { id: 'standard', name: 'Standard mode', broken: false },
      { id: 'ptc', name: 'PTC mode', broken: false },
      { id: 'minimal', name: 'Minimal mode', broken: false },
      { id: 'cordis', name: 'Creator mode', broken: false },
      { id: 'code-review', name: 'Code review', broken: false },
      { id: 'broken-one', name: 'Broken one', broken: true },
    ],
  }
  assert.deepEqual(presetOptions(wire).map((o) => o.label), [
    'Harness default (Standard mode)',
    'Standard mode',
    'PTC mode',
    'Minimal mode',
    'Creator mode',
    'Code review',
    'Broken one (unavailable)',
  ])
  // The values stay the registry ids: only the labels changed.
  assert.deepEqual(presetOptions(wire).map((o) => o.value), ['', ...wire.items.map((i) => i.id)])

  // An older Host (or a roster that published no names at all) still reads as
  // the harness wording, and no registry at all still names the default.
  const bare = { default: 'standard', items: [{ id: 'standard' }, { id: 'ptc' }] }
  assert.deepEqual(presetOptions(bare).map((o) => o.label), [
    'Harness default (Standard mode)',
    'Standard mode',
    'PTC mode',
  ])
  assert.equal(presetOptions(null)[0].label, 'Harness default (Standard mode)')
  assert.equal(presetOptions({ default: 'code-review', items: [] })[0].label, 'Harness default (code-review)')
})

test('TicketMeta shows the display name for a set preset', async () => {
  const client = await clientSource()
  const meta = client.slice(client.indexOf('function TicketMeta(props)'), client.indexOf('function TicketDetail(props)'))
  assert.match(meta, /presetDisplayName\(t\.preset, presetNameFromWire\(props\.presets, t\.preset\)\)/)
  // An unset preset still reads as the harness default, not as a name.
  assert.match(meta, /: "harness default"/)
})

test('the capabilities wire carries the display name, not the raw id', async () => {
  const host = await readFile(fileURLToPath(new URL('../src/host.mjs', import.meta.url)), 'utf8')
  assert.match(host, /import \{ presetDisplayName \} from '\.\/preset-labels\.mjs'/)
  const helper = host.slice(host.indexOf('async function presetsCapability'))
  const body = helper.slice(0, helper.indexOf('\n}\n') + 3)
  assert.match(body, /name: presetDisplayName\(row\.id, row\.name\)/)
})
