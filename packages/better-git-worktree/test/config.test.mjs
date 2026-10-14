import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { defaultStateDir, dshHome, resolveConfiguredPath, resolveSettings } from '../src/config.mjs'

const HOME = '/home-of-test'

test('dshHome: $DSH_HOME when it has content, else ~/.dsh, made absolute and ~-expanded', () => {
  assert.equal(dshHome({ DSH_HOME: '/srv/lab-dsh' }, HOME), '/srv/lab-dsh')
  assert.equal(dshHome({}, HOME), join(HOME, '.dsh'))
  assert.equal(dshHome({ DSH_HOME: '   ' }, HOME), join(HOME, '.dsh'))
  assert.equal(dshHome({ DSH_HOME: '~/lab' }, HOME), join(HOME, 'lab'))
  assert.equal(dshHome({ DSH_HOME: '/srv/a/../b' }, HOME), '/srv/b')
})

test('the default registry directory follows DSH_HOME, so a lab server never reads production state', () => {
  assert.equal(defaultStateDir({ DSH_HOME: '/srv/lab-dsh' }, HOME), '/srv/lab-dsh/plugins/dsh-better-git-worktree')
  assert.equal(defaultStateDir({}, HOME), join(HOME, '.dsh', 'plugins', 'dsh-better-git-worktree'))
})

test('resolveConfiguredPath: absolute verbatim, ~ expanded, relative against the dsh home', () => {
  const env = { DSH_HOME: '/srv/lab-dsh' }
  assert.equal(resolveConfiguredPath('/var/state', env, HOME), '/var/state')
  assert.equal(resolveConfiguredPath('~/state', env, HOME), join(HOME, 'state'))
  assert.equal(resolveConfiguredPath('state', env, HOME), '/srv/lab-dsh/state')
})

test('no configuration at all is valid: the registry lives where earlier releases kept it', () => {
  const { stateDir, warnings } = resolveSettings({}, { env: { DSH_HOME: '/srv/dsh' }, home: HOME })
  assert.equal(stateDir, '/srv/dsh/plugins/dsh-better-git-worktree')
  assert.deepEqual(warnings, [])
})

test('stateDir overrides the directory; a relative value is relative to the dsh home, never the cwd', () => {
  assert.equal(resolveSettings({ stateDir: '/var/bgw' }, { env: {}, home: HOME }).stateDir, '/var/bgw')
  assert.equal(resolveSettings({ stateDir: 'bgw-state' }, { env: { DSH_HOME: '/srv/dsh' }, home: HOME }).stateDir, '/srv/dsh/bgw-state')
})

test('a blank or non-string stateDir falls back to the default and says so', () => {
  const { stateDir, warnings } = resolveSettings({ stateDir: 42 }, { env: { DSH_HOME: '/srv/dsh' }, home: HOME })
  assert.equal(stateDir, '/srv/dsh/plugins/dsh-better-git-worktree')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /stateDir 42 is not a non-empty path/)
  assert.equal(resolveSettings({ stateDir: '  ' }, { env: {}, home: HOME }).warnings.length, 1)
})

test('an unknown key (a misspelling that would silently do nothing) is warned about', () => {
  const { warnings } = resolveSettings({ stateDirectory: '/x' }, { env: {}, home: HOME })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /unknown config key "stateDirectory" is ignored; this plugin honours stateDir/)
})
