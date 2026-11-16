import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KIND_MAP, acquireFields, composeDescription, gatedStream, kindFor } from '../src/gate.mjs';

test('kindFor: purpose maps through KIND_MAP, unknowns and absences are call', () => {
  assert.equal(kindFor({}), 'call');
  assert.equal(kindFor({ purpose: '' }), 'call');
  assert.equal(kindFor({ purpose: 'subagent' }), 'subagent');
  assert.equal(kindFor({ purpose: 'title' }), 'set-title');
  assert.equal(kindFor({ purpose: 'compaction' }), 'compaction');
  assert.equal(kindFor({ purpose: 'nonsense' }), 'call');
});

test('composeDescription: kind · turn · "title", clamped to 160', () => {
  assert.equal(composeDescription({ kind: 'call' }), 'call');
  assert.equal(composeDescription({ kind: 'interactive-chat', turn: 7, title: 'Fix the deploy script' }), 'interactive-chat · turn 7 · “Fix the deploy script”');
  assert.equal(composeDescription({ kind: 'call', turn: 0, title: 'x' }), 'call · “x”');
  const long = composeDescription({ kind: 'call', title: 'y'.repeat(300) });
  assert.equal(long.length, 160);
  assert.ok(long.endsWith('…'));
});

test('acquireFields: optional fields appear only when present', () => {
  const fields = acquireFields({ provider: 'p', model: 'm', sessionId: 's1', purpose: 'subagent' }, { sessionTitle: 'T', turn: 3 });
  assert.equal(fields.provider, 'p');
  assert.equal(fields.model, 'm');
  assert.equal(fields.session, 's1');
  assert.equal(fields.kind, 'subagent');
  assert.equal(fields.sessionTitle, 'T');
  assert.equal(fields.turn, 3);
  assert.match(fields.description, /subagent · turn 3 · “T”/);

  const bare = acquireFields({ provider: 'p' }, {});
  assert.equal(bare.model, undefined);
  assert.equal(bare.session, undefined);
  assert.equal(bare.sessionTitle, undefined);
  assert.equal(bare.turn, undefined);
  assert.equal(bare.kind, 'call');
});

async function collect(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

function fakeWithLease({ granted = true } = {}) {
  const calls = [];
  const fn = async (client, fields, run, opts) => {
    calls.push({ client, fields, opts });
    if (granted === 'abort') {
      const error = new Error('aborted while queued');
      error.code = 'ABORTED';
      throw error;
    }
    if (granted === false) {
      const error = new Error('no slot');
      error.code = 'NO_SLOT';
      throw error;
    }
    return run(granted === true ? 'lease-1' : null);
  };
  fn.calls = calls;
  return fn;
}

test('gatedStream: pass-through when disabled or unmapped', async () => {
  const withLease = fakeWithLease();
  const next = async function* () { yield 'a'; yield 'b'; };
  assert.deepEqual(await collect(gatedStream({ enabled: false, queueId: 'q', client: {}, withLease }, { provider: 'p' }, next)), ['a', 'b']);
  assert.deepEqual(await collect(gatedStream({ enabled: true, queueId: null, client: {}, withLease }, { provider: 'p' }, next)), ['a', 'b']);
  assert.equal(withLease.calls.length, 0);
});

test('gatedStream: runs under the lease and passes metadata through', async () => {
  const withLease = fakeWithLease();
  const next = async function* () { yield 'a'; };
  const gate = {
    enabled: true,
    queueId: 'r9700-egpu',
    client: 'client',
    withLease,
    describe: () => ({ sessionTitle: 'My Session', turn: 2 }),
  };
  const chunks = await collect(gatedStream(gate, { provider: 'p', model: 'm', sessionId: 's1' }, next));
  assert.deepEqual(chunks, ['a']);
  assert.equal(withLease.calls.length, 1);
  const call = withLease.calls[0];
  assert.equal(call.client, 'client');
  assert.equal(call.fields.model, 'm');
  assert.equal(call.fields.kind, 'call');
  assert.equal(call.fields.session, 's1');
  assert.equal(call.fields.sessionTitle, 'My Session');
  assert.equal(call.fields.turn, 2);
  assert.match(call.fields.description, /call · turn 2 · “My Session”/);
});

test('gatedStream: degraded pass-through (leaseId null) still streams', async () => {
  const withLease = fakeWithLease({ granted: null });
  const next = async function* () { yield 'x'; };
  const chunks = await collect(gatedStream({ enabled: true, queueId: 'q', client: 'c', withLease }, { provider: 'p' }, next));
  assert.deepEqual(chunks, ['x']);
});

test('gatedStream: a gate rejection propagates to the caller', async () => {
  const withLease = fakeWithLease({ granted: false });
  const next = async function* () { yield 'never'; };
  await assert.rejects(collect(gatedStream({ enabled: true, queueId: 'q', client: 'c', withLease }, { provider: 'p' }, next)), (error) => error.code === 'NO_SLOT');
});

test('gatedStream: stamps clientToken on the acquire fields when set, omits when empty', async () => {
  const withLease = fakeWithLease();
  const next = async function* () { yield 'a'; };
  const base = { enabled: true, queueId: 'q', client: 'c', withLease };

  await collect(gatedStream({ ...base, clientToken: 'tok-123' }, { provider: 'p' }, next));
  assert.equal(withLease.calls[0].fields.clientToken, 'tok-123');

  await collect(gatedStream({ ...base, clientToken: '' }, { provider: 'p' }, next));
  assert.equal(withLease.calls[1].fields.clientToken, undefined);

  await collect(gatedStream(base, { provider: 'p' }, next));
  assert.equal(withLease.calls[2].fields.clientToken, undefined);
});

test('gatedStream: describe() failures are swallowed', async () => {
  const withLease = fakeWithLease();
  const next = async function* () { yield 'a'; };
  const gate = { enabled: true, queueId: 'q', client: 'c', withLease, describe: () => { throw new Error('boom'); } };
  assert.deepEqual(await collect(gatedStream(gate, { provider: 'p', sessionId: 's1' }, next)), ['a']);
  assert.equal(withLease.calls[0].fields.sessionTitle, undefined);
});

test('KIND_MAP covers the documented kinds', () => {
  for (const kind of ['interactive-chat', 'set-title', 'compaction', 'subagent', 'judge', 'generate', 'image-gen', 'call']) {
    assert.ok(Object.values(KIND_MAP).includes(kind), `kind ${kind} reachable`);
  }
});
