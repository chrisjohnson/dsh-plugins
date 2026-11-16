import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigError, deriveInstance, isEnabled, queueFor, resolveConfig } from '../src/config.mjs';

test('defaults: enabled, loopback endpoints, no queue mappings', () => {
  const { config, warnings } = resolveConfig({}, {});
  assert.equal(config.enabled, true);
  assert.equal(config.sock, '/run/take-a-number/tan.sock');
  assert.equal(config.tcp, '127.0.0.1:4100');
  assert.deepEqual(config.queues, []);
  assert.deepEqual(warnings, []);
});

test('queue mappings validate: provider + queue required, duplicates rejected', () => {
  const { config } = resolveConfig({ queues: [{ provider: 'local-ai-machine (apu)', queue: 'strix-apu' }] }, {});
  assert.equal(queueFor(config, 'local-ai-machine (apu)'), 'strix-apu');
  assert.equal(queueFor(config, 'other'), null);
  assert.throws(() => resolveConfig({ queues: [{ provider: 'a' }] }, {}), ConfigError);
  assert.throws(() => resolveConfig({ queues: [{ provider: 'a', queue: 'q' }, { provider: 'a', queue: 'r' }] }, {}), ConfigError);
  assert.throws(() => resolveConfig({ queues: [{ provider: 'a', queue: 'q', bogus: 1 }] }, {}), ConfigError);
});

test('non-loopback tcp is refused', () => {
  assert.throws(() => resolveConfig({ tcp: '192.168.1.21:4100' }, {}), ConfigError);
  assert.throws(() => resolveConfig({ tcp: '0.0.0.0:4100' }, {}), ConfigError);
  const { config } = resolveConfig({ tcp: '127.0.0.1:9999' }, {});
  assert.equal(config.tcp, '127.0.0.1:9999');
});



test('dashboardUrl: empty by default, http(s) accepted, bare string rejected', () => {
  assert.equal(resolveConfig({}, {}).config.dashboardUrl, '');
  assert.equal(resolveConfig({ dashboardUrl: 'https://take-a-number.local-ai-machine.johnsonlab.dev' }, {}).config.dashboardUrl, 'https://take-a-number.local-ai-machine.johnsonlab.dev');
  assert.throws(() => resolveConfig({ dashboardUrl: 'not a url' }, {}), ConfigError);
  assert.throws(() => resolveConfig({ dashboardUrl: 123 }, {}), ConfigError);
});

test('environment overrides TAN_SOCK and TAN_TCP', () => {
  const { config } = resolveConfig({}, { TAN_SOCK: '/tmp/tan.sock', TAN_TCP: '127.0.0.1:4200' });
  assert.equal(config.sock, '/tmp/tan.sock');
  assert.equal(config.tcp, '127.0.0.1:4200');
});

test('unknown keys warn, do not throw', () => {
  const { config, warnings } = resolveConfig({ enabled: true, bogus: 1 }, {});
  assert.equal(config.enabled, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /bogus/);
});

test('deriveInstance: lab instances under a dsh-lab root, production is web', () => {
  assert.equal(deriveInstance({ DSH_HOME: '/home/dsh/dsh-deploy/.dsh' }), 'web');
  assert.equal(deriveInstance({ DSH_HOME: '/home/dsh/dsh-lab/bench/.dsh' }), 'lab-bench');
  assert.equal(deriveInstance({}), 'web');
  assert.equal(deriveInstance({ DSH_HOME: '' }), 'web');
});

test('isEnabled', () => {
  const on = resolveConfig({}, {}).config;
  const off = resolveConfig({ enabled: false }, {}).config;
  assert.equal(isEnabled(on), true);
  assert.equal(isEnabled(off), false);
});
