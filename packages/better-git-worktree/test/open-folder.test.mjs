import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { findOpener, folderOpenersFor, openFolder, openerEnvironment } from '../src/open-folder.mjs'

test('each platform gets its own opener list', () => {
  assert.deepEqual(folderOpenersFor('darwin').map((o) => o.command), ['open'])
  assert.deepEqual(folderOpenersFor('win32').map((o) => o.command), ['explorer'])
  assert.equal(folderOpenersFor('linux')[0].command, 'xdg-open')
  assert.deepEqual(folderOpenersFor('linux')[1], { command: 'gio', args: ['open'] })
})

test('findOpener walks PATH in opener preference order and finds nothing on a bare host', () => {
  const installed = new Set(['/usr/bin/nautilus', '/opt/bin/gio'])
  const exists = (path) => installed.has(path)
  const opener = findOpener({ platform: 'linux', path: '/usr/bin:/opt/bin', exists })
  assert.equal(opener.command, 'gio', 'gio is preferred over nautilus')
  assert.equal(findOpener({ platform: 'linux', path: '', exists }), undefined)
  assert.equal(findOpener({ platform: 'linux', path: '/nowhere', exists }), undefined)
})

test('credential-shaped variables never reach the opener', () => {
  const env = openerEnvironment({ HOME: '/h', PATH: '/bin', GITHUB_TOKEN: 'x', API_KEY: 'x', MY_SECRET: 'x', DB_PASSWORD: 'x', AWS_CREDENTIAL_FILE: 'x', UNSET: undefined })
  assert.deepEqual(env, { HOME: '/h', PATH: '/bin' })
})

function fakeSpawn(behaviour) {
  const calls = []
  const launch = (command, args, options) => {
    const child = new EventEmitter()
    child.unref = () => {}
    calls.push({ command, args, options })
    queueMicrotask(() => behaviour(child))
    return child
  }
  return { launch, calls }
}

test('openFolder launches the opener detached, with the path last and a scrubbed environment', async () => {
  const { launch, calls } = fakeSpawn((child) => child.emit('exit', 0))
  await openFolder('/work/copy', {
    exists: (p) => p === '/work/copy' || p === '/bin/xdg-open',
    platform: 'linux',
    path: '/bin',
    env: { PATH: '/bin', API_KEY: 'x' },
    spawn: launch,
    settleMs: 5000,
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'xdg-open')
  assert.deepEqual(calls[0].args, ['/work/copy'])
  assert.equal(calls[0].options.detached, true)
  assert.equal(calls[0].options.stdio, 'ignore')
  assert.deepEqual(calls[0].options.env, { PATH: '/bin' })
})

test('a file manager that stays in the foreground still counts as success', async () => {
  const { launch } = fakeSpawn(() => {})
  await openFolder('/work/copy', { exists: (p) => p === '/work/copy' || p === '/bin/open', platform: 'darwin', path: '/bin', env: {}, spawn: launch, settleMs: 5 })
})

test('openFolder reports a vanished directory, a missing opener, a launch error and a non-zero exit', async () => {
  await assert.rejects(openFolder('/gone', { exists: () => false }), /\/gone no longer exists/)
  await assert.rejects(openFolder('/work/copy', { exists: (p) => p === '/work/copy', platform: 'linux', path: '/bin' }), /no folder opener is installed on this host \(tried xdg-open, gio, nautilus/)
  const present = (p) => p === '/work/copy' || p === '/bin/open'
  const errored = fakeSpawn((child) => child.emit('error', new Error('ENOENT')))
  await assert.rejects(openFolder('/work/copy', { exists: present, platform: 'darwin', path: '/bin', env: {}, spawn: errored.launch, settleMs: 5000 }), /open is unavailable: ENOENT/)
  const failed = fakeSpawn((child) => child.emit('exit', 3))
  await assert.rejects(openFolder('/work/copy', { exists: present, platform: 'darwin', path: '/bin', env: {}, spawn: failed.launch, settleMs: 5000 }), /open exited with 3/)
})
