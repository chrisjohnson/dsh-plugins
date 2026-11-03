// The pre-step rewrite contract against stubbed dependencies: pass-through and
// replacement shapes, every fail-open note, and route resolution. Pure module
// — runs on a bare clone without dsh, sharp, or a network.

import test from 'node:test';
import assert from 'node:assert/strict';

import { capForAgent, createPreStepHandler, routeKeyFor } from '../src/handler.mjs';
import { resolveConfig } from '../src/config.mjs';

const CAP = 393216;
const ROUTE = 'vision-provider/small-vlm';

const noop = () => {};
const fakeLog = { info: noop, warn: noop, error: noop };

function settings(overrides = {}) {
  return resolveConfig({ caps: { [ROUTE]: CAP }, ...overrides }).settings;
}

function agentWithHeader(provider, model) {
  return {
    options: { provider, model },
    session: { requestHeader: () => ({ config: { provider, model } }) },
  };
}

function imageMessage(width, height, id = 'msg-1', extra = {}) {
  return Object.freeze({
    id,
    role: 'user',
    source: { kind: 'user' },
    content: [
      { type: 'text', text: 'look at this' },
      Object.freeze({ type: 'image', attachment: { attachmentId: `att-${width}x${height}`, mediaType: 'image/png', bytes: 12345, width, height }, ...extra }),
    ],
  });
}

function stubStore({ pixels = 400000, readFails = false, saveFails = false, tileCount = 6 } = {}) {
  const saved = [];
  const service = {
    saved,
    async readImage(ref) {
      if (readFails) throw new Error('digest mismatch');
      return { ref, data: new Uint8Array([1, 2, 3]) };
    },
    async saveImages(inputs) {
      if (saveFails) throw new Error('storage full');
      saved.push(...inputs);
      return inputs.map((input, i) => ({
        attachmentId: `tile-${i}`,
        mediaType: 'image/png',
        bytes: 1000,
        width: Math.round(Math.sqrt(pixels / tileCount)),
        height: Math.round(Math.sqrt(pixels / tileCount)),
      }));
    },
  };
  return { saved, service };
}

const stubProbe = async () => ({ width: 1536, height: 1024, animated: false });
const stubTile = async (_data, rects) => rects.map(() => new Uint8Array([9]));

function mount(configOverrides, { store, probe = stubProbe, tile = stubTile } = {}) {
  const handler = createPreStepHandler({
    config: settings(configOverrides),
    log: fakeLog,
    attachments: () => store,
    probe,
    tile,
  });
  return (messages, agent = agentWithHeader(ROUTE.split('/')[0], ROUTE.split('/')[1])) =>
    handler({ agent, messages }, async () => ({ kind: 'enter', messages }));
}

// ---- route resolution -------------------------------------------------------

test('routeKeyFor prefers the minted header and falls back to agent options', () => {
  assert.equal(routeKeyFor(agentWithHeader('p', 'm')), 'p/m');
  assert.equal(routeKeyFor({ options: { provider: 'p2', model: 'm2' }, session: {} }), 'p2/m2');
  assert.equal(routeKeyFor({ session: { requestHeader: () => undefined }, options: { provider: 'p3', model: 'm3' } }), 'p3/m3');
  assert.equal(routeKeyFor({}), undefined);
  assert.equal(routeKeyFor(undefined), undefined);
  assert.equal(routeKeyFor({ session: { requestHeader: () => { throw new Error('boom'); } }, options: { provider: 'p', model: 'm' } }), 'p/m');
});

test('capForAgent: exact key match only', () => {
  const config = settings();
  assert.equal(capForAgent(agentWithHeader('vision-provider', 'small-vlm'), config), CAP);
  assert.equal(capForAgent(agentWithHeader('vision-provider', 'other-model'), config), undefined);
  assert.equal(capForAgent(agentWithHeader('nope', 'small-vlm'), config), undefined);
  assert.equal(capForAgent({}, config), undefined);
});

// ---- pass-through shapes ----------------------------------------------------

test('a route without a cap is untouched, decision returned by identity', async () => {
  const { service } = stubStore();
  const handler = createPreStepHandler({ config: settings(), log: fakeLog, attachments: () => service, probe: stubProbe, tile: stubTile });
  const agent = agentWithHeader('big', 'provider');
  const msg = imageMessage(4000, 3000);
  const decision = await handler({ agent }, async () => ({ kind: 'enter', messages: [msg] }));
  assert.equal(decision.messages[0], msg);
  assert.equal(service.saved.length, 0);
});

test('an under-cap image passes through untouched', async () => {
  const { service } = stubStore();
  const run = mount({}, { store: service });
  const msg = imageMessage(768, 512); // exactly 393216 = not over
  const decision = await run([msg]);
  assert.equal(decision.messages[0], msg);
  assert.equal(service.saved.length, 0);
});

test('text-only and non-user messages are untouched', async () => {
  const { service } = stubStore();
  const run = mount({}, { store: service });
  const text = Object.freeze({ id: 't', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] });
  const assistant = Object.freeze({ id: 'a', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'image', attachment: { attachmentId: 'x', width: 4000, height: 4000, mediaType: 'image/png', bytes: 1 } }] });
  const decision = await run([text, assistant]);
  assert.equal(decision.messages[0], text);
  assert.equal(decision.messages[1], assistant);
  assert.equal(service.saved.length, 0);
});

test('offloaded image blocks are never re-read', async () => {
  const { service } = stubStore();
  const run = mount({}, { store: service });
  const msg = imageMessage(4000, 3000, 'off', { offloaded: true });
  const decision = await run([msg]);
  assert.equal(decision.messages[0], msg);
  assert.equal(service.saved.length, 0);
});

test('enabled:false passes everything through even with a cap hit', async () => {
  const { service } = stubStore();
  const run = mount({ enabled: false }, { store: service });
  const msg = imageMessage(4000, 3000);
  const decision = await run([msg]);
  assert.equal(decision.messages[0], msg);
  assert.equal(service.saved.length, 0);
});

test('a rejected decision is returned untouched', async () => {
  const handler = createPreStepHandler({ config: settings(), log: fakeLog, attachments: () => stubStore().service, probe: stubProbe, tile: stubTile });
  const rejected = { kind: 'reject' };
  const decision = await handler({ agent: agentWithHeader('vision-provider', 'small-vlm') }, async () => rejected);
  assert.equal(decision, rejected);
});

// ---- replacement shape ------------------------------------------------------

test('an over-cap image becomes N tile blocks plus the note, id and source preserved', async () => {
  const { service } = stubStore();
  const run = mount({}, { store: service });
  const msg = imageMessage(1536, 1024);
  const decision = await run([msg]);
  const out = decision.messages[0];
  assert.notEqual(out, msg, 'rewritten');
  assert.equal(out.id, msg.id, 'identity preserved');
  assert.equal(out.source, msg.source);
  assert.equal(out.role, 'user');
  // original content was [text, image]; output: [text, ...tiles, note]
  const images = out.content.filter((b) => b.type === 'image');
  const texts = out.content.filter((b) => b.type === 'text');
  // 1536x1024 at a 393216 cap: aspect scoring picks the 3x2 grid (6 tiles).
  assert.equal(images.length, 6, 'six tiles for 1536x1024 at this cap');
  assert.equal(texts.length, 2, 'the user text plus one note');
  assert.match(texts[1].text, /split into 6 overlapping tiles \(3x2 grid\); together they cover the full image/);
  for (const block of images) {
    assert.equal(block.type, 'image');
    assert.equal(block.attachment.mediaType, 'image/png');
    assert.ok(block.attachment.width * block.attachment.height <= CAP);
  }
  assert.equal(service.saved.length, 6);
  assert.ok(service.saved.every((s) => s.mediaType === 'image/png' && s.data instanceof Uint8Array));
  // The tiles sit where the original block was: after the user's own text.
  assert.equal(out.content[0].type, 'text');
  assert.equal(out.content[0].text, 'look at this');
});

test('multiple over-cap images in one message each get their own tiles and note', async () => {
  const { service } = stubStore();
  const run = mount({}, { store: service });
  const msg = Object.freeze({
    id: 'two',
    role: 'user',
    source: { kind: 'user' },
    content: [
      Object.freeze({ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 1, width: 1536, height: 1024 } }),
      Object.freeze({ type: 'image', attachment: { attachmentId: 'a2', mediaType: 'image/png', bytes: 1, width: 768, height: 512 } }),
      Object.freeze({ type: 'image', attachment: { attachmentId: 'a3', mediaType: 'image/png', bytes: 1, width: 2048, height: 1024 } }),
    ],
  });
  const decision = await run([msg]);
  const out = decision.messages[0];
  const notes = out.content.filter((b) => b.type === 'text');
  assert.equal(notes.length, 2, 'one note per tiled image');
  const images = out.content.filter((b) => b.type === 'image');
  assert.equal(images.length, 16, 'under-cap a2 kept plus 6 tiles for a1 and 9 for a3');
  assert.ok(out.content.some((b) => b.type === 'image' && b.attachment?.attachmentId === 'a2'), 'under-cap image kept whole');
  assert.equal(service.saved.length, 15);
});

test('startsRequestSeries and other decision fields survive the rewrite', async () => {
  const { service } = stubStore();
  const handler = createPreStepHandler({ config: settings(), log: fakeLog, attachments: () => service, probe: stubProbe, tile: stubTile });
  const msg = imageMessage(1536, 1024);
  const decision = await handler({ agent: agentWithHeader('vision-provider', 'small-vlm') }, async () => ({ kind: 'enter', messages: [msg], startsRequestSeries: true }));
  assert.equal(decision.startsRequestSeries, true);
  assert.notEqual(decision.messages[0], msg);
});

// ---- fail-open notes ----------------------------------------------------------

test('the valve keeps the original and appends a note', async () => {
  const { service } = stubStore();
  const run = mount({ maxTilesPerImage: 2 }, { store: service });
  const msg = imageMessage(4000, 4000);
  const decision = await run([msg]);
  const out = decision.messages[0];
  const original = out.content.find((b) => b.type === 'image');
  assert.equal(original.attachment.width, 4000, 'original kept whole');
  const note = out.content.find((b) => b.type === 'text' && /cannot be split/.test(b.text));
  assert.ok(note, 'valve note present');
  assert.equal(service.saved.length, 0);
});

test('unreadable bytes, animated rasters, encoder and storage failures each keep the original with a note', async () => {
  const cases = [
    { name: 'read fails', store: stubStore({ readFails: true }).service, probe: stubProbe, tile: stubTile, re: /could not be read/ },
    { name: 'probe fails', store: stubStore().service, probe: async () => { throw new Error('undecodable'); }, tile: stubTile, re: /could not be decoded/ },
    { name: 'animated', store: stubStore().service, probe: async () => ({ width: 4000, height: 3000, animated: true }), tile: stubTile, re: /animated/ },
    { name: 'tile fails', store: stubStore().service, probe: stubProbe, tile: async () => { throw new Error('sharp blew up'); }, re: /tiling failed/ },
    { name: 'save fails', store: stubStore({ saveFails: true }).service, probe: stubProbe, tile: stubTile, re: /could not be stored/ },
    { name: 'no store', store: undefined, probe: stubProbe, tile: stubTile, re: /no attachment store/ },
  ];
  for (const c of cases) {
    const run = mount({}, { store: c.store, probe: c.probe, tile: c.tile });
    const msg = imageMessage(1536, 1024); // over cap, inside the valve
    const decision = await run([msg]);
    const out = decision.messages[0];
    assert.notEqual(out, msg, `${c.name}: message rewritten with a note`);
    assert.equal(out.content[1], msg.content[1], `${c.name}: original image block kept by identity`);
    const note = out.content[2];
    assert.equal(note.type, 'text', c.name);
    assert.match(note.text, c.re, c.name);
  }
});

test('an internal blow-up returns the decision unchanged (fail open)', async () => {
  const handler = createPreStepHandler({
    config: settings(),
    log: { ...fakeLog, info: () => { throw new Error('logger exploded'); } },
    attachments: () => stubStore().service,
    probe: stubProbe,
    tile: stubTile,
  });
  const msg = imageMessage(1536, 1024);
  const decision = await handler({ agent: agentWithHeader('vision-provider', 'small-vlm') }, async () => ({ kind: 'enter', messages: [msg] }));
  assert.equal(decision.messages[0], msg);
});

// ---- 0.2.0: policy, ask, and pending-selection routing ----------------------

function mountPolicy(overrides, { store, ask, pendingSelection } = {}) {
  const handler = createPreStepHandler({
    config: settings(overrides),
    log: fakeLog,
    attachments: () => store,
    probe: stubProbe,
    tile: stubTile,
    ask,
    pendingSelection,
  });
  const agent = agentWithHeader('vision-provider', 'small-vlm');
  return (msg) => handler({ agent, signal: undefined }, async () => ({ kind: 'enter', messages: [msg ?? imageMessage(1536, 1024)] }));
}

test('policy tile: auto-tiles without asking (0.1.0 behavior)', async () => {
  const { service } = stubStore();
  let asked = 0;
  const run = mountPolicy({ policy: 'tile' }, { store: service, ask: async () => { asked++; return 'tile'; } });
  const decision = await run();
  assert.equal(asked, 0, 'no ask under policy tile');
  assert.equal(decision.messages[0].content.filter((b) => b.type === 'image').length, 6);
});

test('policy send-whole: keeps the original with the downscale note, never tiles', async () => {
  const { service } = stubStore();
  const run = mountPolicy({ policy: 'send-whole' }, { store: service });
  const msg = imageMessage(1536, 1024);
  const decision = await run(msg);
  const out = decision.messages[0];
  assert.equal(out.content[1], msg.content[1], 'original kept by identity');
  assert.match(out.content[2].text, /sent whole — the vision backend will likely downscale it/);
  assert.equal(service.saved.length, 0);
});

test('policy ask: approve tiles, reject sends whole, non-answer falls back', async () => {
  for (const [answer, expectTiles] of [['tile', true], ['send-whole', false], [undefined, true], ['garbage', true]]) {
    const { service } = stubStore();
    const questions = [];
    const run = mountPolicy({ policy: 'ask', askFallback: 'tile' }, { store: service, ask: async (_a, q) => { questions.push(q); return answer; } });
    const decision = await run();
    const images = decision.messages[0].content.filter((b) => b.type === 'image');
    assert.equal(images.length, expectTiles ? 6 : 1, `answer=${answer} -> tiles=${expectTiles}`);
    assert.equal(questions.length, 1);
    assert.match(questions[0], /Approve to tile it into 6 overlapping tiles \(3x2 grid.*reject to send it whole.*likely downscale/s);
  }
});

test('policy ask: a throwing asker falls back and the step still enters', async () => {
  const { service } = stubStore();
  const run = mountPolicy({ policy: 'ask', askFallback: 'send-whole' }, { store: service, ask: async () => { throw new Error('no answerer'); } });
  const msg = imageMessage(1536, 1024);
  const decision = await run(msg);
  assert.equal(decision.messages[0].content[1], msg.content[1], 'fallback send-whole kept original');
  assert.match(decision.messages[0].content[2].text, /sent whole/);
});

test('pending model selection outranks a stale header and creation options', async () => {
  const { service } = stubStore();
  const handler = createPreStepHandler({
    config: settings({ policy: 'tile' }),
    log: fakeLog,
    attachments: () => service,
    probe: stubProbe,
    tile: stubTile,
    pendingSelection: () => ({ provider: 'vision-provider', model: 'small-vlm' }),
  });
  // Header and options both name a NO-CAP route; only the pending selection carries the cap.
  const agent = {
    options: { provider: 'big', model: 'provider' },
    session: { requestHeader: () => ({ config: { provider: 'big', model: 'provider' } }) },
  };
  const decision = await handler({ agent }, async () => ({ kind: 'enter', messages: [imageMessage(1536, 1024)] }));
  assert.equal(decision.messages[0].content.filter((b) => b.type === 'image').length, 6, 'tiled via pending selection');
  // A throwing pendingSelection reader must not break the pass-through.
  const broken = createPreStepHandler({
    config: settings({ policy: 'tile' }), log: fakeLog, attachments: () => service, probe: stubProbe, tile: stubTile,
    pendingSelection: () => { throw new Error('projection gone'); },
  });
  const d2 = await broken({ agent: agentWithHeader('vision-provider', 'small-vlm') }, async () => ({ kind: 'enter', messages: [imageMessage(1536, 1024)] }));
  assert.equal(d2.messages[0].content.filter((b) => b.type === 'image').length, 6, 'header still resolves when the reader throws');
});
