// KAN-77: the New-ticket workspace box is an address-bar combobox, and all of its
// filtering lives in one pure client helper. `src/client.mjs` is a self-contained
// browser script whose functions cannot be imported, so the matcher is sliced out
// of the real source and evaluated here (see test/client-source.mjs) — the test
// runs the code the browser runs, not a copy of it.

import test from 'node:test'
import assert from 'node:assert/strict'

import { loadClientHelpers } from './client-source.mjs'

const { fuzzyWorkspaces } = await loadClientHelpers(['fuzzyWorkspaces'])

const ws = (title, path) => ({ id: path, title, path })

const REGISTRY = [
  ws('dsh-deploy', '/work/dsh-deploy'),
  ws('dsh-plugins', '/work/dsh-plugins'),
  ws('kanban-lab', '/work/dsh-lab'),
  ws('Website', '/work/site'),
]

test('an empty or whitespace query is not a filter: the registry comes back whole, in order', () => {
  for (const query of ['', '   ', null, undefined]) {
    assert.deepEqual(fuzzyWorkspaces(query, REGISTRY), REGISTRY, `query ${JSON.stringify(query)}`)
  }
})

test('matching ignores case, in the query and in the workspace', () => {
  assert.deepEqual(fuzzyWorkspaces('DSH', REGISTRY), [REGISTRY[0], REGISTRY[1], REGISTRY[2]])
  assert.deepEqual(fuzzyWorkspaces('website', REGISTRY), [REGISTRY[3]])
  assert.deepEqual(fuzzyWorkspaces('WEB', REGISTRY), [REGISTRY[3]])
})

test('a subsequence matches, not only a contiguous substring', () => {
  // 'kl' is nowhere in 'kanban-lab' as a run of characters, but every letter appears
  // in order — and the two /work/dsh-* paths contain k…l too, ranked below it
  // because their hit is on the path, not the title.
  assert.deepEqual(fuzzyWorkspaces('kl', REGISTRY), [REGISTRY[2], REGISTRY[0], REGISTRY[1]])
  // 'dp' likewise: d…p inside 'dsh-deploy' (and inside 'dsh-plugins').
  assert.deepEqual(fuzzyWorkspaces('dp', REGISTRY), [REGISTRY[0], REGISTRY[1]])
})

test('a path prefix outranks a title prefix, which outranks any subsequence', () => {
  const items = [
    ws('Zeta', 'beta-site'), // path prefix -> best
    ws('Beta Gamma', 'w/bg'), // title prefix
    ws('Zeta beta', 'w/c'), // title subsequence
    ws('Nothing', 'w/betamax'), // path subsequence
  ]
  assert.deepEqual(fuzzyWorkspaces('beta', items), [items[0], items[1], items[2], items[3]])
})

test('ties keep the registry order', () => {
  const items = [ws('alpha one', '/w/a1'), ws('alpha two', '/w/a2'), ws('alpha three', '/w/a3')]
  assert.deepEqual(fuzzyWorkspaces('alpha', items), items)
})

test('the result is capped at eight rows', () => {
  const items = []
  for (let i = 0; i < 12; i += 1) items.push(ws(`lab ${i}`, `/work/lab-${i}`))
  const out = fuzzyWorkspaces('lab', items)
  assert.equal(out.length, 8)
  assert.deepEqual(out, items.slice(0, 8))
})

test('a query nothing matches returns nothing', () => {
  assert.deepEqual(fuzzyWorkspaces('zzzzq', REGISTRY), [])
  assert.deepEqual(fuzzyWorkspaces('nope', REGISTRY), [])
})

test('a title-only match still counts', () => {
  const items = [ws('SearxNG box', '/srv/other'), ws('Unrelated', '/srv/searxng')]
  assert.deepEqual(fuzzyWorkspaces('searx', items), [items[0], items[1]])
})

test('rows with a missing title or path do not throw', () => {
  const items = [{ path: 'w/only-path' }, { title: 'Only Title' }, ws('Both', 'w/both'), null, undefined]
  // The titled row wins on rank (title prefix beats path subsequence), not on order.
  assert.deepEqual(fuzzyWorkspaces('only', items), [items[1], items[0]])
  assert.deepEqual(fuzzyWorkspaces('both', items), [items[2]])
})

test('a non-array list is treated as an empty registry', () => {
  assert.deepEqual(fuzzyWorkspaces('anything', undefined), [])
  assert.deepEqual(fuzzyWorkspaces('', null), [])
})
