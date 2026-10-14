import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { REGISTRY_FILE, STATE_VERSION, WorktreeRegistry } from '../src/registry.mjs'
import { tempDir } from './helpers.mjs'

// The registry in the shape STATE_VERSION 1 has always been written: built from
// what the plugin's own put()/patch() store, not copied from a deployment.
// `a` is a pre-session copy (record keyed by the session that lives in it); `b` is
// a converted one (keyed by the source session, pointing at its continuation).
const V1 = {
  version: 1,
  worktrees: {
    'session-a': {
      sessionId: 'session-a',
      origin: 'pre-session',
      repoRoot: '/work/project',
      managedRoot: '/work/project/.dsh-worktrees/brave-otter',
      branch: 'dsh/brave-otter',
      petName: 'brave-otter',
      baseBranch: 'main',
      baseRef: 'origin/main',
      activated: true,
      createdAt: 1700000000000,
    },
    'session-b': {
      sessionId: 'session-b',
      sourceSessionId: undefined,
      origin: 'converted',
      repoRoot: '/work/project',
      managedRoot: '/work/project/.dsh-worktrees/calm-heron',
      branch: 'dsh/calm-heron',
      petName: 'calm-heron',
      baseBranch: 'main',
      baseRef: 'origin/main',
      activated: true,
      createdAt: 1700000100000,
      stashRef: '0123456789abcdef0123456789abcdef01234567',
      stashEntry: 'stash@{0}',
      targetSessionId: 'session-b-continued',
      conversationCarried: true,
    },
  },
}

function fixture(content) {
  const { dir, cleanup } = tempDir('bgw-registry-')
  const file = join(dir, 'state', REGISTRY_FILE)
  if (content !== undefined) {
    mkdirSync(join(dir, 'state'), { recursive: true })
    writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`)
  }
  return { dir, file, cleanup }
}

test('STATE_VERSION is still 1: existing sessions bind to their copies', () => {
  assert.equal(STATE_VERSION, 1)
})

test('a registry file in the v1 shape loads: every session keeps its binding and its status fields', () => {
  const { file, cleanup } = fixture(V1)
  try {
    const registry = new WorktreeRegistry(file)
    assert.equal(registry.problem, undefined)
    assert.equal(registry.writable, true)
    assert.deepEqual(registry.list().map((record) => record.sessionId).sort(), ['session-a', 'session-b'])
    const a = registry.get('session-a')
    assert.equal(a.managedRoot, '/work/project/.dsh-worktrees/brave-otter')
    assert.equal(a.branch, 'dsh/brave-otter')
    assert.equal(a.petName, 'brave-otter')
    assert.equal(a.baseRef, 'origin/main')
    assert.equal(a.activated, true)
    const b = registry.get('session-b')
    assert.equal(b.targetSessionId, 'session-b-continued')
    assert.equal(b.conversationCarried, true)
    assert.equal(b.stashRef, '0123456789abcdef0123456789abcdef01234567')
    assert.equal(registry.findByRoot('/work/project/.dsh-worktrees/calm-heron').sessionId, 'session-b')
    assert.equal(registry.findByRoot('/nowhere'), undefined)
  } finally {
    cleanup()
  }
})

test('a record whose stored sessionId is missing takes its key as the session id', () => {
  const { file, cleanup } = fixture({ version: 1, worktrees: { 'session-z': { managedRoot: '/w/x' } } })
  try {
    assert.equal(new WorktreeRegistry(file).get('session-z').sessionId, 'session-z')
  } finally {
    cleanup()
  }
})

test('an unchanged registry round-trips: persisting writes the same records back', () => {
  const { file, cleanup } = fixture(V1)
  try {
    const registry = new WorktreeRegistry(file)
    assert.equal(registry.persist(), true)
    const written = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(written.version, 1)
    assert.deepEqual(JSON.parse(JSON.stringify(V1.worktrees)), written.worktrees)
    assert.ok(readFileSync(file, 'utf8').endsWith('\n'))
  } finally {
    cleanup()
  }
})

test('put, patch and remove persist, and a second registry on the same file sees them', () => {
  const { file, cleanup } = fixture(V1)
  try {
    const registry = new WorktreeRegistry(file)
    registry.put({ sessionId: 'session-c', managedRoot: '/w/c', branch: 'dsh/c' })
    registry.patch('session-a', { activated: false })
    assert.equal(registry.patch('session-missing', { x: 1 }), undefined)
    assert.equal(registry.remove('session-b'), true)
    assert.equal(registry.remove('session-b'), false)
    const again = new WorktreeRegistry(file)
    assert.deepEqual(again.list().map((record) => record.sessionId).sort(), ['session-a', 'session-c'])
    assert.equal(again.get('session-a').activated, false)
  } finally {
    cleanup()
  }
})

test('a missing file is an empty, writable registry; the first write creates the directory', () => {
  const { file, cleanup } = fixture()
  try {
    const registry = new WorktreeRegistry(file)
    assert.equal(registry.problem, undefined)
    assert.equal(registry.writable, true)
    assert.equal(registry.list().length, 0)
    registry.put({ sessionId: 'session-a', managedRoot: '/w/a' })
    assert.equal(existsSync(file), true)
  } finally {
    cleanup()
  }
})

test('records and fields this release does not understand are carried through a write', () => {
  const stored = {
    version: 1,
    note: 'written by a later release',
    worktrees: {
      'session-a': { sessionId: 'session-a', managedRoot: '/w/a', futureField: { nested: true } },
      'session-odd': { reason: 'no managedRoot at all' },
      'session-null': null,
    },
  }
  const { file, cleanup } = fixture(stored)
  try {
    const registry = new WorktreeRegistry(file)
    assert.deepEqual(registry.list().map((record) => record.sessionId), ['session-a'])
    registry.put({ sessionId: 'session-new', managedRoot: '/w/new' })
    const written = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(written.note, 'written by a later release')
    assert.deepEqual(written.worktrees['session-a'].futureField, { nested: true })
    assert.deepEqual(written.worktrees['session-odd'], { reason: 'no managedRoot at all' })
    assert.equal(written.worktrees['session-null'], null)
    assert.equal(written.worktrees['session-new'].managedRoot, '/w/new')
  } finally {
    cleanup()
  }
})

for (const [label, content, pattern] of [
  ['not valid JSON', '{"version": 1, "worktrees": {', /not valid JSON/],
  ['a version this release does not read', { version: 2, worktrees: {} }, /registry version 2/],
  ['no version at all', { worktrees: {} }, /registry version undefined/],
  ['an array', '[]', /does not hold a registry object/],
  ['a "worktrees" field that is not an object', { version: 1, worktrees: [] }, /not an object/],
]) {
  test(`a file that is ${label} is never overwritten`, () => {
    const { file, cleanup } = fixture(content)
    try {
      const before = readFileSync(file, 'utf8')
      const registry = new WorktreeRegistry(file)
      assert.match(registry.problem, pattern)
      assert.equal(registry.writable, false)
      assert.equal(registry.list().length, 0)
      assert.equal(registry.put({ sessionId: 'session-a', managedRoot: '/w/a' }).sessionId, 'session-a')
      registry.patch('session-a', { activated: true })
      registry.remove('session-a')
      assert.equal(registry.persist(), false)
      assert.equal(readFileSync(file, 'utf8'), before, 'the file on disk is byte-for-byte what it was')
      assert.deepEqual(readdirSync(join(file, '..')), [REGISTRY_FILE], 'no temp file was left behind')
    } finally {
      cleanup()
    }
  })
}

test('a file that exists but cannot be read is never overwritten either', () => {
  const { file, cleanup } = fixture(V1)
  try {
    chmodSync(file, 0o000)
    const registry = new WorktreeRegistry(file)
    if (registry.problem === undefined) {
      // Running as root: permissions do not apply. Prove the same path another way.
      const failing = new WorktreeRegistry(file, { read: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) } })
      assert.match(failing.problem, /could not be read/)
      assert.equal(failing.writable, false)
    } else {
      assert.match(registry.problem, /could not be read/)
      assert.equal(registry.writable, false)
    }
    chmodSync(file, 0o600)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).worktrees['session-a'].petName, 'brave-otter')
  } finally {
    cleanup()
  }
})

test('writes are atomic: no temp file is left after a write, and a failed write leaves the old file in place', () => {
  const { file, cleanup } = fixture(V1)
  try {
    const registry = new WorktreeRegistry(file)
    registry.put({ sessionId: 'session-c', managedRoot: '/w/c' })
    assert.deepEqual(readdirSync(join(file, '..')), [REGISTRY_FILE])

    const before = readFileSync(file, 'utf8')
    const blocked = new WorktreeRegistry(file, {
      write: () => {
        throw new Error('disk full')
      },
    })
    assert.throws(() => blocked.put({ sessionId: 'session-d', managedRoot: '/w/d' }), /disk full/)
    assert.equal(readFileSync(file, 'utf8'), before)
  } finally {
    cleanup()
  }
})
