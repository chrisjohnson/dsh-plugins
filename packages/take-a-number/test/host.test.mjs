import { test } from 'node:test';
import assert from 'node:assert/strict';

// The host half imports the harness packages, so on a bare clone — where CI
// runs the suite with nothing installed — there is nothing to import. Skip with
// a reason rather than fail, the way the other packages' host tests do.
let TakeANumber;
try {
  TakeANumber = (await import('../src/host.mjs')).default;
} catch {
  TakeANumber = undefined;
}
const skip = TakeANumber === undefined ? 'dsh peer packages are not installed' : false;

// Regression: the browser-facing config accessor must not be named `config`,
// because the instance stores the resolved config object on `this.config` and an
// own property shadows a same-named prototype method — `this.config()` then
// throws "not a function" and the Activity panel falls back to its notice.
test('browserConfig reads dashboardUrl without colliding with the this.config property', { skip }, () => {
  const inst = Object.create(TakeANumber.prototype);
  inst.config = { dashboardUrl: 'https://take-a-number.local-ai-machine.johnsonlab.dev' };
  assert.equal(typeof TakeANumber.prototype.browserConfig, 'function');
  assert.deepEqual(inst.browserConfig(), { dashboardUrl: 'https://take-a-number.local-ai-machine.johnsonlab.dev' });
  // The own `config` property is an object, not callable — the old bug.
  assert.equal(typeof inst.config, 'object');
  assert.throws(() => inst.config(), TypeError);
});
