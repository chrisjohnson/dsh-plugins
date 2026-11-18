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

import {
  askUserToolDefinition,
  makeQuestionAnswerer,
  OpenQuestionRegistry,
  questionIdsFromCallArgs,
  questionsFromCallArgs,
  recommendedAnswer,
  sanitizeQuestions,
  settleOpenWait,
  validateQuestionAnswers,
} from '../src/questions.mjs'

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

test('a question carrying a presentation intent is never answered from', () => {
  // exit_plan_mode asks through this same seam with kind 'plan-review' and
  // *Approve* as its first option. Taking the first label there would approve
  // a plan with no human, which is the one decision this board must not take.
  const planReview = [{
    id: 'plan-review',
    question: 'Approve this plan and leave plan mode?',
    detail: '# the plan',
    options: [{ label: 'Approve' }, { label: 'Keep planning' }],
    intent: { kind: 'plan-review', approve: 'Approve', callId: 'call-1' },
  }]
  assert.equal(recommendedAnswer(planReview), null)
  assert.equal(recommendedAnswer([BATCH[0], planReview[0]]), null, 'one intent anywhere vetoes the whole batch')
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

test('a plan-mode exit review reaches the human even on an autonomous ticket', () => {
  // The guard that matters: this ask has options and a recommended first label,
  // so the option rule alone would answer it and approve the plan with nobody
  // in the room.
  const h = harness({
    ticket: ticket({ phase: 'implement', planQuestions: 'autonomous' }),
    questions: [{
      id: 'plan-review',
      question: 'Approve this plan and leave plan mode?',
      detail: '# the plan',
      options: [{ label: 'Approve' }, { label: 'Keep planning' }],
      intent: { kind: 'plan-review', approve: 'Approve' },
    }],
  })
  assert.equal(h.ask(), h.fell)
  assert.equal(h.events.length, 0)
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

// -------------------------------------------------- questionsFromCallArgs --
//
// KAN-66: the same batch, read back out of a `tool/call` event instead of being
// answered. This is a display path — the orchestrator is being shown what a
// worker asked — so the bar is "never throws, never invents", not "rejects".

test('the question batch is recovered from a tool-call arguments string', () => {
  const args = JSON.stringify({
    questions: [
      { id: 'restart', question: 'Is the restart owed now?', header: 'Restart', options: [{ label: 'Yes (Recommended)' }, { label: 'No' }] },
      { id: 'scope', question: 'Which packages?', options: ['dsh-kanban', { label: 'everything' }] },
    ],
  })
  assert.deepEqual(questionsFromCallArgs(args), [
    { id: 'restart', question: 'Is the restart owed now?', options: ['Yes (Recommended)', 'No'], header: 'Restart' },
    { id: 'scope', question: 'Which packages?', options: ['dsh-kanban', 'everything'] },
  ])
})

test('an already-parsed arguments object reads the same way', () => {
  assert.deepEqual(questionsFromCallArgs({ questions: [{ question: 'Which tag?' }] }), [
    { id: null, question: 'Which tag?', options: [] },
  ])
})

// KAN-98: the ids are part of what a read shows, because the caller that reads a
// pending question is often the one that has to answer it — and `answerQuestion`
// only accepts a batch keyed by the ids the model asked with. A question the
// model gave no id for says `id: null`: the tolerant tool assigns its own at
// execution time, and a display path that invented one would name an id nothing
// is waiting on.
test('each question carries the id it was asked with, or null when it had none', () => {
  const [named, blank, missing] = questionsFromCallArgs({
    questions: [
      { id: '  pin  ', question: 'Which pin?' },
      { id: '   ', question: 'Restart now?' },
      { question: 'No id at all?' },
    ],
  })
  assert.equal(named.id, 'pin', 'the id is trimmed like the text')
  assert.equal(blank.id, null, 'an id that is only whitespace is no id')
  assert.equal(missing.id, null, 'an absent id is null, not an empty string')
})

test('whitespace in the question text is folded onto one line', () => {
  const [only] = questionsFromCallArgs({ questions: [{ question: '  ship\n  it   now?  ' }] })
  assert.equal(only.question, 'ship it now?')
})

test('anything unreadable is null, never a throw and never a made-up question', () => {
  assert.equal(questionsFromCallArgs(undefined), null)
  assert.equal(questionsFromCallArgs(null), null)
  assert.equal(questionsFromCallArgs('not json at all'), null)
  assert.equal(questionsFromCallArgs('{}'), null, 'no questions key')
  assert.equal(questionsFromCallArgs('{"questions":[]}'), null, 'an empty batch')
  assert.equal(questionsFromCallArgs({ questions: [{ options: ['a'] }] }), null, 'an entry with no text')
  assert.equal(questionsFromCallArgs({ questions: [null, 'nope'] }), null, 'junk entries only')
  assert.equal(questionsFromCallArgs(42), null)
})

test('a batch with one usable entry among junk still shows that one', () => {
  assert.deepEqual(questionsFromCallArgs({ questions: [null, { question: 'Real?' }, { id: 'x' }] }), [
    { id: null, question: 'Real?', options: [] },
  ])
})

// ------------------------------------------------ questionIdsFromCallArgs --
//
// KAN-94: the same `tool/call` arguments, read for their ids instead of their
// text. This one is an authorisation path — an answer posted over HTTP is only
// accepted when it names the pending batch — so where the display reader skips
// what it cannot read, this one refuses the whole batch: a partial id list would
// turn a complete answer into an "extra id" refusal, or worse, let an answer
// through that missed a question nobody is holding an id for.

const IDS_ARGS = JSON.stringify({
  questions: [
    { id: 'restart', question: 'Is the restart owed now?', options: [{ label: 'Yes (Recommended)' }] },
    { id: 'scope', question: 'Which packages?', options: [{ label: 'kanban' }] },
  ],
})

test('the ids of a well-formed batch come back in the order they were asked', () => {
  assert.deepEqual(questionIdsFromCallArgs(IDS_ARGS), ['restart', 'scope'])
  assert.deepEqual(questionIdsFromCallArgs({ questions: [{ id: 'a', question: 'a?' }] }), ['a'])
})

test('an already-parsed arguments object and a bare array read the same way', () => {
  assert.deepEqual(questionIdsFromCallArgs({ questions: [{ id: 'a' }, { id: 'b' }] }), ['a', 'b'])
  assert.deepEqual(questionIdsFromCallArgs([{ id: 'a' }, { id: 'b' }]), ['a', 'b'])
})

test('a batch whose ids the model left out or repeated is not a batch to check against', () => {
  // `sanitizeQuestions` assigns these ids itself, so the service is holding ids
  // that are not in the call — answering against the call would be a guess.
  assert.equal(questionIdsFromCallArgs({ questions: [{ question: 'a?' }, { id: 'b', question: 'b?' }] }), null)
  assert.equal(questionIdsFromCallArgs({ questions: [{ id: 'dup' }, { id: 'dup' }] }), null)
  assert.equal(questionIdsFromCallArgs({ questions: [{ id: '  ', question: 'a?' }] }), null)
})

test('anything unreadable is null, never a throw and never a partial id list', () => {
  assert.equal(questionIdsFromCallArgs(undefined), null)
  assert.equal(questionIdsFromCallArgs(null), null)
  assert.equal(questionIdsFromCallArgs('not json at all'), null)
  assert.equal(questionIdsFromCallArgs('{}'), null, 'no questions key')
  assert.equal(questionIdsFromCallArgs('{"questions":[]}'), null, 'an empty batch')
  assert.equal(questionIdsFromCallArgs({ questions: [null] }), null, 'a junk entry voids the batch')
  assert.equal(questionIdsFromCallArgs({ questions: ['nope'] }), null)
  assert.equal(questionIdsFromCallArgs(42), null)
  assert.equal(questionIdsFromCallArgs('[]'), null)
})

// ------------------------------------------------- validateQuestionAnswers --
//
// KAN-94: is this answer batch the answer to that pending question? The core
// service checks the same thing, but only after the ticket event has been
// written — and the board's rule is that the log describes answers that
// happened. So the shape and the ids are settled here, before anything is
// claimed, and a refusal costs nothing.

const PENDING = ['restart', 'scope']

test('a batch that names every pending question once is accepted as written', () => {
  assert.deepEqual(
    validateQuestionAnswers({
      pendingIds: PENDING,
      answers: [
        { id: 'restart', selected: ['Yes (Recommended)'] },
        { id: 'scope', selected: [], custom: 'just the kanban package' },
      ],
    }),
    {
      ok: true,
      answers: [
        { id: 'restart', selected: ['Yes (Recommended)'] },
        { id: 'scope', selected: [], custom: 'just the kanban package' },
      ],
    },
  )
})

test('an answer that misses a pending question is refused by name', () => {
  const out = validateQuestionAnswers({ pendingIds: PENDING, answers: [{ id: 'restart', selected: ['Yes'] }] })
  assert.equal(out.ok, false)
  assert.match(out.reason, /does not cover the pending question\(s\): scope/)
})

test('an answer that names a question nobody asked is refused by name', () => {
  const out = validateQuestionAnswers({
    pendingIds: PENDING,
    answers: [
      { id: 'restart', selected: ['Yes'] },
      { id: 'scope', selected: ['kanban'] },
      { id: 'made-up', selected: ['x'] },
    ],
  })
  assert.equal(out.ok, false)
  assert.match(out.reason, /not pending: made-up/)
})

test('an answer that names one question twice is refused', () => {
  const out = validateQuestionAnswers({
    pendingIds: ['restart'],
    answers: [{ id: 'restart', selected: ['Yes'] }, { id: 'restart', selected: ['No'] }],
  })
  assert.equal(out.ok, false)
  assert.match(out.reason, /names "restart" twice/)
})

test('answers that are not a batch of entries are refused', () => {
  for (const bad of [undefined, null, 'restart=Yes', {}, [], 42]) {
    assert.equal(validateQuestionAnswers({ pendingIds: PENDING, answers: bad }).ok, false, JSON.stringify(bad))
  }
})

test('a malformed entry says which one and why', () => {
  const cases = [
    [{ id: 'restart' }, /answers\[0\]\.selected/],
    [{ id: 'restart', selected: 'Yes' }, /answers\[0\]\.selected must be an array/],
    [{ id: 'restart', selected: [7] }, /must hold only strings/],
    [{ id: 'restart', selected: ['Yes'], custom: 7 }, /custom must be a string/],
    [{ selected: ['Yes'] }, /answers\[0\] has no id/],
    ['restart', /answers\[0\] must be an object/],
    [null, /answers\[0\] must be an object/],
  ]
  for (const [entry, pattern] of cases) {
    const out = validateQuestionAnswers({ pendingIds: ['restart'], answers: [entry] })
    assert.equal(out.ok, false, JSON.stringify(entry))
    assert.match(out.reason, pattern)
  }
})

test('a pending batch with no readable ids is a refusal, not a guess', () => {
  for (const pendingIds of [null, undefined, [], 'restart']) {
    const out = validateQuestionAnswers({ pendingIds, answers: [{ id: 'restart', selected: ['Yes'] }] })
    assert.equal(out.ok, false)
    assert.match(out.reason, /no readable ids/)
  }
})

test('the accepted answers are copies, so a caller cannot change the log after the fact', () => {
  const answers = [{ id: 'restart', selected: ['Yes'] }]
  const out = validateQuestionAnswers({ pendingIds: ['restart'], answers })
  assert.equal(out.ok, true)
  out.answers[0].selected.push('tampered')
  assert.deepEqual(answers[0].selected, ['Yes'])
})

// =========================================== the deferral half (KAN-103) ====
//
// An `ask_user_question` whose tool call is still in flight is not answerable
// through `userQuestions.answer` — that method's first line looks the call up
// among the session's *continued* questions, and an open call is not one. While
// the call is open the only answer path core offers is the
// `user-questions/request` waterfall the ask is itself waiting on, and the
// browser card owns it. KAN-103 gives the board a second holder of that same
// seam: the listener parks the open wait in an `OpenQuestionRegistry`, and
// `POST /api/kanban/answerQuestion` settles it.
//
// The tests below drive a real waterfall chain — the same shape cordis runs:
// listeners outermost-first, each handed a `next()` that throws if it is called
// twice, and the innermost `next()` standing in for the browser card.

/**
 * A cordis-shaped waterfall over the given listeners, with `inner` as the
 * innermost `next()` (the browser card's own answer path).
 */
function runWaterfall(listener, request, inner) {
  const chain = [listener]
  const dispatch = () => {
    const callback = chain.shift()
    if (callback === undefined) return inner()
    let called = false
    const next = () => {
      if (called) throw new Error('next() called multiple times')
      called = true
      return dispatch()
    }
    return callback(request, next)
  }
  return dispatch()
}

function deferHarness({
  ticket = { id: 't1', key: 'KAN-1', column: 'working', phase: 'verify', planQuestions: 'interactive' },
  questions = [{ id: 'restart', question: 'Restart now?', options: [{ label: 'Yes (Recommended)' }, { label: 'No' }] }],
  callId = 'call-1',
  withRegistry = true,
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
  const openWaits = withRegistry ? new OpenQuestionRegistry() : null
  const listener = makeQuestionAnswerer({ store, log: { warn: (fmt, ...args) => warnings.push([fmt, ...args]) }, openWaits })
  // The browser card: consulted through `next()`, and it answers whenever the
  // person at the page decides — which may be after, or never.
  let cardAnswer
  let cardReject
  let cardConsulted = 0
  const card = () =>
    new Promise((resolve, reject) => {
      cardConsulted += 1
      cardAnswer = resolve
      cardReject = reject
    })
  const ask = () => runWaterfall(listener, { questions, agent: { id: 'session-1' }, wait: { callId } }, card)
  const settle = (answers = [{ id: 'restart', selected: ['Yes (Recommended)'] }]) =>
    settleOpenWait({ openWaits, store, log: { warn: (fmt, ...args) => warnings.push([fmt, ...args]) } }, { sessionId: 'session-1', callId, answers })
  return {
    ask,
    settle,
    store,
    events,
    warnings,
    openWaits,
    get cardConsulted() {
      return cardConsulted
    },
    cardAnswer: (value) => cardAnswer?.(value),
    cardReject: (error) => cardReject?.(error),
  }
}

// ------------------------------------------------------- OpenQuestionRegistry --

test('a registered wait settles exactly once, and a second settle is a no-op', async () => {
  const registry = new OpenQuestionRegistry()
  const entry = registry.register({ sessionId: 's', callId: 'c', ticketId: 't' })
  assert.equal(entry.sessionId, 's')
  assert.equal(entry.callId, 'c')
  assert.equal(entry.ticketId, 't')
  assert.equal(registry.get('s', 'c'), entry)
  assert.equal(entry.settle([{ id: 'q', selected: ['A'] }]), true, 'the first settle admits the answer')
  assert.equal(entry.settle([{ id: 'q', selected: ['B'] }]), false, 'a second answer is not admitted')
  assert.deepEqual(await entry.answered, { answers: [{ id: 'q', selected: ['A'] }] }, 'the first answer is the one delivered')
  assert.equal(registry.get('s', 'c'), null, 'settling releases the wait')
})

test('release stops a wait being answered at all, and dispose drops every one', () => {
  const registry = new OpenQuestionRegistry()
  const first = registry.register({ sessionId: 's', callId: 'c1', ticketId: 't' })
  registry.register({ sessionId: 's', callId: 'c2', ticketId: 't' })
  assert.equal(registry.size, 2)
  assert.equal(registry.release(first.key), true)
  assert.equal(registry.release(first.key), false, 'releasing twice is not a thing')
  assert.equal(first.settle([]), true, 'a released entry can still be settled by whoever held it')
  assert.equal(registry.get('s', 'c1'), null)
  registry.dispose()
  assert.equal(registry.size, 0)
  assert.equal(registry.get('s', 'c2'), null)
})

test('two waits cannot collide: the key is the pair, not either half', () => {
  const registry = new OpenQuestionRegistry()
  const a = registry.register({ sessionId: 'a', callId: 'bc', ticketId: 't' })
  const b = registry.register({ sessionId: 'ab', callId: 'c', ticketId: 't' })
  assert.notEqual(a.key, b.key, 'a NUL separator keeps `a|bc` and `ab|c` apart')
  assert.equal(registry.size, 2)
})

// ------------------------------------------------------- settleOpenWait order --

test('the open answer is recorded before it is admitted, and the ask takes it', async () => {
  const h = deferHarness()
  const settled = h.ask()
  assert.equal(h.openWaits.size, 1, 'the ask is parked for a human')
  assert.deepEqual(h.events, [], 'nothing is recorded until someone answers')

  const out = h.settle()
  assert.deepEqual(out, { ok: true })
  assert.equal(h.events.length, 1, 'exactly one audit event')
  assert.equal(h.events[0].kind, 'question_answered_by_api')
  assert.equal(h.events[0].actor, 'api')
  assert.equal(h.events[0].ticketId, 't1')
  assert.equal(h.events[0].phaseFrom, 'verify', 'the ticket phase it was answered in')
  assert.deepEqual(h.events[0].payload, {
    callId: 'call-1',
    answers: [{ id: 'restart', selected: ['Yes (Recommended)'] }],
  })
  assert.deepEqual(await settled, { answers: [{ id: 'restart', selected: ['Yes (Recommended)'] }] })
})

test('an event write that fails admits no answer, and leaves the ask answerable', async () => {
  const h = deferHarness()
  const settled = h.ask()
  h.store.appendEvent = () => {
    throw new Error('db gone')
  }
  const out = h.settle()
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'not-recorded')
  assert.match(out.error, /db gone/)
  assert.equal(h.events.length, 0, 'a refusal records nothing')
  assert.equal(h.openWaits.size, 1, 'the ask stays parked: the card can still answer it')
  assert.equal(h.settle().ok, false, 'and a retry is refused for the same reason, not silently admitted')

  h.cardAnswer({ answers: [{ id: 'restart', selected: ['No'] }] })
  assert.deepEqual(await settled, { answers: [{ id: 'restart', selected: ['No'] }] }, 'the ask itself is unharmed')
})

test('settling a wait that is not open says so and writes nothing', () => {
  const h = deferHarness()
  const out = h.settle()
  assert.deepEqual(out, { ok: false, reason: 'not-open' })
  assert.equal(h.events.length, 0)
})

// ------------------------------------------------------------- the race -------

test('an open ask in the approval phase is answered over HTTP, and the card loses', async () => {
  const h = deferHarness()
  const settled = h.ask()
  assert.equal(h.cardConsulted, 1, 'the browser card is still reached, exactly as before')
  assert.equal(h.settle().ok, true)
  assert.deepEqual(await settled, { answers: [{ id: 'restart', selected: ['Yes (Recommended)'] }] })
  assert.equal(h.openWaits.size, 0, 'the wait is gone the moment anyone answers')
})

test('the browser card answering first wins, and the API answer is then refused', async () => {
  const h = deferHarness()
  const settled = h.ask()
  h.cardAnswer({ answers: [{ id: 'restart', selected: ['No'] }] })
  assert.deepEqual(await settled, { answers: [{ id: 'restart', selected: ['No'] }] })
  assert.equal(h.events.length, 0, 'an answer the board did not deliver is not the board’s event to write')
  assert.equal(h.openWaits.size, 0, 'the parked wait is released either way')
  assert.deepEqual(h.settle(), { ok: false, reason: 'not-open' }, 'the second answerer sees a question that is no longer pending')
  assert.equal(h.events.length, 0, 'and that refusal still writes nothing')
})

test('a downstream rejection is the ask’s own outcome, not a swallowed one', async () => {
  const h = deferHarness()
  const settled = h.ask()
  const abort = new Error('ask_user_question was aborted before the user answered')
  h.cardReject(abort)
  await assert.rejects(() => settled, /aborted before the user answered/)
  assert.equal(h.openWaits.size, 0, 'a dead ask stops being answerable from the board too')
  assert.deepEqual(h.settle(), { ok: false, reason: 'not-open' })
  assert.equal(h.events.length, 0)
})

test('a card that rejects after the board answered does not surface as a failure', async () => {
  const h = deferHarness()
  const settled = h.ask()
  assert.equal(h.settle().ok, true)
  h.cardReject(new Error('the foreground question wait ended'))
  assert.deepEqual(await settled, { answers: [{ id: 'restart', selected: ['Yes (Recommended)'] }] })
})

// ------------------------------------------------------- what still falls through --

test('the auto-answer decision wins over the deferral: nothing is parked', async () => {
  const h = deferHarness({ ticket: { id: 't1', key: 'KAN-1', column: 'working', phase: 'implement', planQuestions: 'autonomous' } })
  const out = h.ask()
  assert.deepEqual(out, { answers: [{ id: 'restart', selected: ['Yes (Recommended)'] }] }, 'the board decided it, so no human is waited on')
  assert.equal(h.cardConsulted, 0, 'the card was never reached')
  assert.equal(h.openWaits.size, 0, 'and nothing is parked')
  assert.equal(h.events[0].kind, 'question_answered_autonomously')
  assert.deepEqual(h.settle(), { ok: false, reason: 'not-open' }, 'there is no open ask to answer')
  assert.equal(h.events.length, 1, 'the refused settle wrote no second event')
})

test('an optionless question in a tabled phase is parked for a human, not answered', async () => {
  const h = deferHarness({
    ticket: { id: 't1', key: 'KAN-1', column: 'working', phase: 'implement', planQuestions: 'autonomous' },
    questions: [{ id: 'name', question: 'What should the file be called?' }],
  })
  const settled = h.ask()
  assert.equal(h.openWaits.size, 1)
  assert.equal(h.settle([{ id: 'name', selected: [], custom: 'questions.mjs' }]).ok, true)
  assert.deepEqual(await settled, { answers: [{ id: 'name', selected: [], custom: 'questions.mjs' }] })
})

test('a request with no agent id or no call id falls through with no entry', () => {
  const events = []
  const store = {
    findSession: (sessionId) => (sessionId === 'session-1' ? { ticketId: 't1' } : undefined),
    getTicket: () => ({ id: 't1', column: 'working', phase: 'verify' }),
    appendEvent: (ticketId, kind, options) => events.push({ kind, ...options }),
  }
  const openWaits = new OpenQuestionRegistry()
  const answerer = makeQuestionAnswerer({ store, log: { warn() {} }, openWaits })
  const fell = Symbol('fell-through-to-human')
  assert.equal(answerer({ questions: [], agent: {}, wait: { callId: 'c' } }, () => fell), fell)
  assert.equal(answerer({ questions: [], agent: { id: '' }, wait: { callId: 'c' } }, () => fell), fell)
  assert.equal(answerer({ questions: [], agent: { id: 'session-1' } }, () => fell), fell, 'no wait, so no call id to key on')
  assert.equal(answerer({ questions: [], agent: { id: 'session-1' }, wait: { callId: '' } }, () => fell), fell)
  assert.equal(answerer({ questions: [], agent: { id: 'other' }, wait: { callId: 'c' } }, () => fell), fell, 'a session of no ticket')
  assert.equal(openWaits.size, 0, 'none of them parked anything')
  assert.equal(events.length, 0)
})

test('without a registry the listener is exactly the pre-KAN-103 answerer', async () => {
  const h = deferHarness({ withRegistry: false })
  const out = h.ask()
  assert.equal(h.cardConsulted, 1, 'the card is reached and owns the answer')
  assert.equal(h.openWaits, null, 'there is nowhere to park a wait')
  assert.equal(h.events.length, 0)
  h.cardAnswer({ answers: [{ id: 'restart', selected: ['No'] }] })
  assert.deepEqual(await out, { answers: [{ id: 'restart', selected: ['No'] }] }, "the card's answer is the whole outcome")
})

test('next() is never called twice, on any path, because cordis forbids it', async () => {
  // The waterfall above throws `next() called multiple times` if a listener
  // cheats, so reaching a settled answer on each exit is the assertion. Each
  // case takes a different way out of the listener.
  const apiFirst = deferHarness()
  const first = apiFirst.ask()
  assert.equal(apiFirst.settle().ok, true)
  assert.deepEqual(await first, { answers: [{ id: 'restart', selected: ['Yes (Recommended)'] }] })

  const cardFirst = deferHarness()
  const second = cardFirst.ask()
  cardFirst.cardAnswer({ answers: [{ id: 'restart', selected: ['No'] }] })
  assert.deepEqual(await second, { answers: [{ id: 'restart', selected: ['No'] }] })

  const refused = deferHarness()
  const third = refused.ask()
  refused.cardReject(new Error('no user-questions answerer accepted the request'))
  await assert.rejects(() => third, /no user-questions answerer/)

  const decided = deferHarness({ ticket: { id: 't1', key: 'KAN-1', column: 'working', phase: 'plan', planQuestions: 'interactive' } })
  assert.deepEqual(await decided.ask(), { answers: [{ id: 'restart', selected: ['Yes (Recommended)'] }] })
  assert.equal(decided.cardConsulted, 0, 'an auto-answer never reaches the card at all')
})
