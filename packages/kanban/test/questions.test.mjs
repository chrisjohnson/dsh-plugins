// The KAN-32 auto-answer matrix, against a stubbed board store.
//
// Everything the engine decides about a question is decided here: which phase
// and which ticket mode may be answered at all, that an option list is the only
// thing it will answer from, that the audit event is written before the answer
// is claimed, and that every failure path lands back on the human. The store is
// a stub for exactly that reason — the matrix is the contract, and it has to be
// readable without a database.

import test from 'node:test'
import assert from 'node:assert/strict'

import { askUserToolDefinition, makeQuestionAnswerer, recommendedAnswer, sanitizeQuestions } from '../src/questions.mjs'

// ------------------------------------------------------- recommendedAnswer --

const BATCH = [
  { id: 'mode', question: 'Which mode?', options: [{ label: 'A (Recommended)' }, { label: 'B' }] },
  { id: 'scope', question: 'Which scope?', options: [{ label: 'All', description: 'everything' }] },
];

test('a batch where every question carries options answers with the first option', () => {
  assert.deepEqual(recommendedAnswer(BATCH), {
    answers: [
      { id: 'mode', selected: ['A (Recommended)'] },
      { id: 'scope', selected: ['All'] },
    ],
  })
})

test('one optionless question makes the whole batch a human question', () => {
  const mixed = [BATCH[0], { id: 'free', question: 'What name should it use?' }]
  assert.equal(recommendedAnswer(mixed), null)
})

test('an empty options array is not an offer the model made', () => {
  assert.equal(recommendedAnswer([{ id: 'x', question: 'q', options: [] }]), null)
})

test('a question with no id cannot be keyed into an answer, so nothing is answered', () => {
  assert.equal(recommendedAnswer([{ question: 'q', options: [{ label: 'A' }] }]), null)
})

test('a first option with no label is not an answer', () => {
  assert.equal(recommendedAnswer([{ id: 'x', question: 'q', options: [{ description: 'no label' }] }]), null)
  assert.equal(recommendedAnswer([{ id: 'x', question: 'q', options: [{ label: '   ' }] }]), null)
})

test('malformed batches answer nothing', () => {
  assert.equal(recommendedAnswer(undefined), null)
  assert.equal(recommendedAnswer(null), null)
  assert.equal(recommendedAnswer([]), null)
  assert.equal(recommendedAnswer('mode?'), null)
  assert.equal(recommendedAnswer([null]), null)
  assert.equal(recommendedAnswer([{ id: 'x', question: 'q', options: 'A or B' }]), null)
})

// ------------------------------------------------------------- the listener --

function harness({
  ticket = { id: 't1', key: 'KAN-1', column: 'working', phase: 'plan', planQuestions: 'interactive' },
  questions = BATCH,
  callId = 'call-1',
} = {}) {
  const events = []
  const warnings = []
  const store = {
    findSession: (sessionId) => (sessionId === 'session-1' ? { ticketId: 't1' } : undefined),
    getTicket: (ticketId) => (ticketId === 't1' ? ticket : undefined),
    appendEvent: (ticketId, kind, options) => {
      events.push({ ticketId, kind, ...options })
    },
  }
  const agent = { id: 'session-1' }
  const answerer = makeQuestionAnswerer({ store, log: { warn: (fmt, ...args) => warnings.push([fmt, ...args]) } })
  const fell = Symbol('fell-through-to-human')
  const next = () => fell
  const ask = (over = {}) =>
    answerer({ questions, agent, wait: { callId }, ...over }, next)
  return { ask, events, warnings, fell, store, ticket }
}

const ticket = (over) => ({ id: 't1', key: 'KAN-1', column: 'working', phase: 'plan', planQuestions: 'interactive', ...over })

test('a plan-phase option batch is answered on an interactive ticket', () => {
  const h = harness({ ticket: ticket({ phase: 'plan', planQuestions: 'interactive' }) })
  assert.deepEqual(h.ask(), { answers: [{ id: 'mode', selected: ['A (Recommended)'] }, { id: 'scope', selected: ['All'] }] })
})

test('a plan-phase option batch is answered on an autonomous ticket', () => {
  const h = harness({ ticket: ticket({ phase: 'plan', planQuestions: 'autonomous' }) })
  assert.notEqual(h.ask(), h.fell)
})

test('an implement-phase batch is answered only when the ticket is autonomous', () => {
  const auto = harness({ ticket: ticket({ phase: 'implement', planQuestions: 'autonomous' }) })
  assert.notEqual(auto.ask(), auto.fell)
  const interactive = harness({ ticket: ticket({ phase: 'implement', planQuestions: 'interactive' }) })
  assert.equal(interactive.ask(), interactive.fell)
  assert.equal(interactive.events.length, 0, 'a fall-through records nothing')
})

test('a review-phase batch follows the same rule as implement', () => {
  const auto = harness({ ticket: ticket({ phase: 'review', planQuestions: 'autonomous' }) })
  assert.notEqual(auto.ask(), auto.fell)
  const interactive = harness({ ticket: ticket({ phase: 'review', planQuestions: 'interactive' }) })
  assert.equal(interactive.ask(), interactive.fell)
})

test('the approval phase never answers: wrapping up is the human conversation', () => {
  for (const mode of ['interactive', 'autonomous']) {
    const h = harness({ ticket: ticket({ phase: 'verify', planQuestions: mode }) })
    assert.equal(h.ask(), h.fell, mode)
  }
})

test('a closed phase never answers', () => {
  const h = harness({ ticket: ticket({ phase: 'closed', planQuestions: 'autonomous' }) })
  assert.equal(h.ask(), h.fell)
})

test('an optionless question reaches the human in every phase and mode', () => {
  const free = [{ id: 'name', question: 'What should the file be called?' }]
  for (const phase of ['plan', 'implement', 'review']) {
    for (const planQuestions of ['interactive', 'autonomous']) {
      const h = harness({ ticket: ticket({ phase, planQuestions }), questions: free })
      assert.equal(h.ask(), h.fell, `${phase}/${planQuestions}`)
      assert.equal(h.events.length, 0)
    }
  }
})

test('a done or discarded ticket never answers', () => {
  for (const column of ['done', 'discarded']) {
    const h = harness({ ticket: ticket({ column, phase: 'closed', planQuestions: 'autonomous' }) })
    assert.equal(h.ask(), h.fell, column)
  }
})

test('the answer records a question_answered_autonomously event with the batch', () => {
  const h = harness({ ticket: ticket({ phase: 'implement', planQuestions: 'autonomous' }) })
  h.ask()
  assert.equal(h.events.length, 1)
  const event = h.events[0]
  assert.equal(event.ticketId, 't1')
  assert.equal(event.kind, 'question_answered_autonomously')
  assert.equal(event.actor, 'engine')
  assert.equal(event.phaseFrom, 'implement')
  assert.equal(event.phaseTo, 'implement')
  assert.deepEqual(event.payload, {
    callId: 'call-1',
    answers: [
      { id: 'mode', selected: ['A (Recommended)'] },
      { id: 'scope', selected: ['All'] },
    ],
  })
})

test('a missing callId is recorded as null, not invented', () => {
  const h = harness({ ticket: ticket({ planQuestions: 'autonomous', phase: 'implement' }) })
  h.ask({ wait: undefined })
  assert.equal(h.events[0].payload.callId, null)
})

test('an event write that fails does not answer — the human decides instead', () => {
  const h = harness({ ticket: ticket({ phase: 'implement', planQuestions: 'autonomous' }) })
  h.store.appendEvent = () => {
    throw new Error('db gone')
  }
  assert.equal(h.ask(), h.fell)
  assert.equal(h.warnings.length, 1, 'the failure is logged')
})

test('a session that belongs to no ticket falls through', () => {
  const h = harness()
  h.store.findSession = () => undefined
  assert.equal(h.ask(), h.fell)
})

test('a ticket that is gone falls through', () => {
  const h = harness()
  h.store.getTicket = () => undefined
  assert.equal(h.ask(), h.fell)
})

test('a request with no agent, no id, or no questions falls through', () => {
  const h = harness()
  assert.equal(h.ask({ agent: undefined }), h.fell)
  assert.equal(h.ask({ agent: {} }), h.fell)
  assert.equal(h.ask({ agent: { id: '' } }), h.fell)
  assert.equal(h.ask({ questions: undefined }), h.fell)
})

test('a store that throws fails open to the human', () => {
  const h = harness({ ticket: ticket({ phase: 'implement', planQuestions: 'autonomous' }) })
  h.store.findSession = () => {
    throw new Error('no db')
  }
  assert.equal(h.ask(), h.fell)
})

test('a broken logger never changes an answer outcome', () => {
  const store = {
    findSession: () => ({ ticketId: 't1' }),
    getTicket: () => ticket({ phase: 'implement', planQuestions: 'autonomous' }),
    appendEvent: () => {},
  }
  const answerer = makeQuestionAnswerer({
    store,
    log: {
      warn: () => {
        throw new Error('logger on fire')
      },
    },
  })
  assert.deepEqual(answerer({ questions: BATCH, agent: { id: 'session-1' } }, () => 'fell').answers.length, 2)
})

test('no log at all is allowed', () => {
  const store = {
    findSession: () => ({ ticketId: 't1' }),
    getTicket: () => ticket({ phase: 'implement', planQuestions: 'autonomous' }),
    appendEvent: () => {},
  }
  const answerer = makeQuestionAnswerer({ store })
  assert.notEqual(answerer({ questions: BATCH, agent: { id: 'session-1' } }, () => 'fell'), 'fell')
})

// ------------------------------------------------------- sanitizeQuestions --

test('sanitizeQuestions passes a well-formed batch through untouched', () => {
  const out = sanitizeQuestions(BATCH)
  assert.deepEqual(out, BATCH)
  assert.notEqual(out, BATCH, 'the entries are copies, not the caller objects')
})

test('sanitizeQuestions assigns the ids a malformed call left out', () => {
  const out = sanitizeQuestions([{ question: 'first?' }, { question: 'second?', options: [{ label: 'A' }] }])
  assert.deepEqual(out.map((q) => q.id), ['q1', 'q2'])
  assert.deepEqual(out[1].options, [{ label: 'A' }], 'everything else survives')
})

test('sanitizeQuestions keeps the ids the model did supply', () => {
  const out = sanitizeQuestions([{ id: 'alpha', question: 'a?' }, { question: 'b?' }])
  assert.deepEqual(out.map((q) => q.id), ['alpha', 'q2'])
})

test('sanitizeQuestions disambiguates a duplicate id', () => {
  const out = sanitizeQuestions([{ id: 'dup', question: 'a?' }, { id: 'dup', question: 'b?' }])
  assert.deepEqual(out.map((q) => q.id), ['dup', 'q2'])
})

test('sanitizeQuestions never invents a colliding id', () => {
  const out = sanitizeQuestions([{ question: 'a?' }, { id: 'q2', question: 'b?' }, { question: 'c?' }])
  assert.deepEqual(out.map((q) => q.id), ['q1', 'q2', 'q3'])
})

test('sanitizeQuestions rejects a batch that is not a batch', () => {
  assert.throws(() => sanitizeQuestions(undefined), /non-empty `questions` array/)
  assert.throws(() => sanitizeQuestions([]), /non-empty `questions` array/)
  assert.throws(() => sanitizeQuestions('mode?'), /non-empty `questions` array/)
  assert.throws(() => sanitizeQuestions([null]), /questions\[0\]/)
  assert.throws(() => sanitizeQuestions([{ options: [{ label: 'A' }] }]), /questions\[0\] has no question text/)
  assert.throws(() => sanitizeQuestions([{ question: '   ' }]), /questions\[0\] has no question text/)
})

// --------------------------------------------------- the tolerant ask tool ---
//
// The tool is a definition object here; `defineTool` and the agent-scope
// registration live in dispatch.mjs, which a bare clone cannot import. What is
// worth pinning is the mapping: ids assigned before the service sees them, the
// callId handed over as the card key, and the answer shape handed back.

function toolHarness(ask) {
  const definition = askUserToolDefinition({ ask, log: { warn() {} } })
  return definition
}

test('the tolerant tool keeps the core tool name and makes only id optional', () => {
  const definition = toolHarness(async () => ({ answers: [] }))
  assert.equal(definition.name, 'ask_user_question')
  const item = definition.parameters.questions.items
  assert.equal(item.properties.id.required, undefined, 'id must not be required')
  assert.equal(item.properties.question.required, true, 'the question text stays required')
  assert.ok(definition.output.render({}, { answers: [] })[0].text.includes('answers'))
})

test('the tool sanitizes ids before the service is asked', async () => {
  const seen = []
  const definition = toolHarness(async (request) => {
    seen.push(request)
    return { answers: request.questions.map((q) => ({ id: q.id, selected: ['A'] })) }
  })
  const out = await definition.execute({ questions: [{ question: 'first?' }, { id: 'keep', question: 'second?' }] }, { callId: 'call-9' })
  assert.deepEqual(seen[0].questions.map((q) => q.id), ['q1', 'keep'])
  assert.deepEqual(out.answers, [
    { id: 'q1', selected: ['A'] },
    { id: 'keep', selected: ['A'] },
  ])
})

test('the tool hands the service the agent, the signal and the call key', async () => {
  const seen = []
  const agent = { id: 'session-1' }
  const signal = { aborted: false }
  const definition = toolHarness(async (request) => {
    seen.push(request)
    return { answers: [] }
  })
  await definition.execute({ questions: [{ id: 'a', question: 'q?', options: [{ label: 'A' }] }] }, { agent, signal, callId: 'call-7' })
  assert.equal(seen[0].agent, agent)
  assert.equal(seen[0].signal, signal)
  assert.deepEqual(seen[0].wait, { callId: 'call-7' })
})

test('a call with no callId asks without a card key rather than inventing one', async () => {
  const seen = []
  const definition = toolHarness(async (request) => {
    seen.push(request)
    return { answers: [] }
  })
  await definition.execute({ questions: [{ id: 'a', question: 'q?' }] }, {})
  assert.equal('wait' in seen[0], false)
})

test('the tool maps the model shape onto the service shape', async () => {
  const seen = []
  const definition = toolHarness(async (request) => {
    seen.push(request)
    return { answers: [{ id: 'a', selected: ['A'], custom: 'note' }] }
  })
  const out = await definition.execute(
    { questions: [{ id: 'a', question: 'q?', header: 'H', multi_select: true, options: [{ label: 'A', description: 'd' }] }] },
    { callId: 'c' },
  )
  assert.deepEqual(seen[0].questions[0], {
    id: 'a',
    question: 'q?',
    header: 'H',
    multiSelect: true,
    options: [{ label: 'A', description: 'd' }],
  })
  assert.deepEqual(out, { answers: [{ id: 'a', selected: ['A'], custom: 'note' }] })
})

test('a malformed batch is a readable tool error, not a lost question', async () => {
  const definition = toolHarness(async () => ({ answers: [] }))
  await assert.rejects(() => definition.execute({ questions: [] }, {}), /non-empty `questions` array/)
  await assert.rejects(() => definition.execute({}, {}), /non-empty `questions` array/)
})

test('a service that answers with nothing hands back an empty batch', async () => {
  const definition = toolHarness(async () => ({}))
  assert.deepEqual(await definition.execute({ questions: [{ id: 'a', question: 'q?' }] }, {}), { answers: [] })
})
