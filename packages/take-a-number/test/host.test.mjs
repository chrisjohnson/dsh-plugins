import { test } from 'node:test';
import assert from 'node:assert/strict';

import TakeANumber from '../src/host.mjs';

// Regression: the browser-facing config accessor must not be named `config`,
// because the instance stores the resolved config object on `this.config` and an
// own property shadows a same-named prototype method — `this.config()` then
// throws "not a function" and the Activity panel falls back to its notice.
test('browserConfig reads dashboardUrl without colliding with the this.config property', () => {
  const inst = Object.create(TakeANumber.prototype);
  inst.config = { dashboardUrl: 'https://take-a-number.local-ai-machine.johnsonlab.dev' };
  assert.equal(typeof TakeANumber.prototype.browserConfig, 'function');
  assert.deepEqual(inst.browserConfig(), { dashboardUrl: 'https://take-a-number.local-ai-machine.johnsonlab.dev' });
  // The own `config` property is an object, not callable — the old bug.
  assert.equal(typeof inst.config, 'object');
  assert.throws(() => inst.config(), TypeError);
});
