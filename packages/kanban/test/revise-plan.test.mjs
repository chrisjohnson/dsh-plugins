// Revise plan: before the build starts, a human can send the plan session an
// instruction and let its resubmission replace the plan and done_when as a new
// version, through the same path every plan takes.

import test from 'node:test'
import assert from 'node:assert/strict'

import { isPlanReady } from '../src/grants.mjs'
import { planRevisionState } from '../src/recovery.mjs'
import { IMPLEMENTATION, PLAN, PLAN_GRANTS, PLAN_V2, REVIEW_PASS, eventKinds, lastPrompt, pickedUp, setup } from './support/engine-harness.mjs'

function engineFor(queues, options) {
  const made = setup(queues, options)
  made.engine.recovered = true
  return made
}

/** A ticket that planned in Backlog and waits there at the build phase. */
async function plannedInBacklog(queues = {}, options) {
  const made = engineFor({ plan: [{ type: 'plan', value: PLAN }], ...queues }, options)
  const ticket = pickedUp(made.store, { column: 'backlog', planTiming: 'now' })
  await made.engine.advance(made.store.getTicket(ticket.id))
  const waiting = made.store.getTicket(ticket.id)
  assert.equal(waiting.column, 'backlog')
  assert.equal(waiting.phase, 'implement')
  return { ...made, ticket: waiting }
}

async function revise(engine, ticketId, instruction) {
  const started = await engine.revisePlan(ticketId, instruction)
  await started.done
  return started
}

const conditionIds = (store, ticketId) => store.listConditions(ticketId).map((c) => c.id)

test('a revision goes to the plan session and its resubmission replaces plan and done_when as version 2', async () => {
  const { store, driver, engine, ticket } = await plannedInBacklog()
  const planSession = [...driver.lost.values()][0]
  driver.reactivation = { ok: true }
  driver.queues.planner.push({ type: 'plan', value: PLAN_V2 })
  const turnsBefore = driver.turns.length
  await revise(engine, ticket.id, 'put the file under docs/')
  assert.equal(driver.turns.length, turnsBefore + 1)
  assert.equal(driver.turns.at(-1), planSession, 'the instruction went to the plan session, not a new one')
  assert.equal(driver.reactivations.at(-1).purpose, 'plan')
  const prompt = lastPrompt(store, ticket.id, 'planner')
  assert.match(prompt, /The human asked for a revised plan/)
  assert.match(prompt, /put the file under docs\//)
  assert.match(prompt, /kanban_submit_plan/)
  assert.equal(store.currentPlanVersion(ticket.id), 2)
  assert.deepEqual(conditionIds(store, ticket.id), ['docs-notes'], 'done_when was replaced')
  const artifact = JSON.parse(store.latestArtifact(ticket.id, 'plan').content)
  assert.equal(artifact.planVersion, 2)
  assert.equal(artifact.summary, 'write the file somewhere safer')
  const after = store.getTicket(ticket.id)
  assert.equal(after.phase, 'implement')
  assert.equal(after.column, 'backlog', 'a Backlog ticket stays in Backlog')
  assert.equal(after.needsAttentionReason ?? null, null)
  assert.equal(driver.liveTicketSession(ticket.id, 'plan'), undefined, 'the plan session is closed again after the resubmission')
  const kinds = eventKinds(store, ticket.id)
  assert.ok(kinds.includes('plan_revision_requested'))
  const revised = store.listEvents(ticket.id, { limit: 100 }).filter((e) => e.kind === 'planned').at(-1)
  assert.equal(revised.payload.revised, true)
  assert.equal(revised.payload.planVersion, 2)
  assert.equal(planRevisionState(store.listEvents(ticket.id, { limit: 100 })).status, 'applied')
})

test('with no plan session to reopen the revision starts one from the plan and the instruction', async () => {
  const { store, driver, engine, ticket } = await plannedInBacklog()
  driver.queues.planner.push({ type: 'plan', value: PLAN_V2 })
  const sessionsBefore = driver.counter
  await revise(engine, ticket.id, 'smaller scope')
  assert.equal(driver.counter, sessionsBefore + 1, 'a new plan session')
  const prompt = lastPrompt(store, ticket.id, 'planner')
  assert.match(prompt, /^plan self /, 'the ordinary planning prompt')
  assert.match(prompt, /Current plan:/)
  assert.match(prompt, /"summary": "write the file"/, 'the plan being revised')
  assert.match(prompt, /Instruction:\nsmaller scope/)
  assert.equal(store.currentPlanVersion(ticket.id), 2)
})

test('a resubmission the plan check rejects is reported on the ticket and changes nothing', async () => {
  const { store, driver, engine, ticket } = await plannedInBacklog()
  driver.reactivation = { ok: true }
  driver.queues.planner.push({ type: 'plan', value: { summary: 'x', steps: ['a'], done_when: [] } })
  await revise(engine, ticket.id, 'drop the conditions')
  assert.equal(store.currentPlanVersion(ticket.id), 1, 'still version 1')
  assert.deepEqual(conditionIds(store, ticket.id), ['notes'])
  const rejected = store.listEvents(ticket.id, { limit: 100 }).filter((e) => e.kind === 'plan_revision_rejected').at(-1)
  assert.ok(rejected, 'an event says so')
  assert.match(rejected.payload.reason, /revised plan was rejected/)
  assert.match(rejected.payload.reason, /current plan is unchanged/)
  assert.equal(rejected.payload.instruction, 'drop the conditions')
  assert.match(store.latestArtifact(ticket.id, 'plan_revision_rejected').content, /rejected/)
  const state = planRevisionState(store.listEvents(ticket.id, { limit: 100 }))
  assert.equal(state.status, 'rejected', 'and so does the visible state the detail view shows')
  assert.match(state.reason, /revised plan was rejected/)
  assert.equal(store.getTicket(ticket.id).phase, 'implement')
})

test('a malformed plan is rejected with the checker\'s reasons', async () => {
  const { store, driver, engine, ticket } = await plannedInBacklog()
  driver.queues.planner.push({ type: 'plan', value: { steps: 'not a list' } })
  await revise(engine, ticket.id, 'anything')
  const rejected = store.listEvents(ticket.id, { limit: 100 }).filter((e) => e.kind === 'plan_revision_rejected').at(-1)
  assert.match(rejected.payload.reason, /revised plan was rejected: /)
  assert.equal(store.currentPlanVersion(ticket.id), 1)
})

test('a plan session that does not resubmit, asks a question, or fails is reported as such', async () => {
  const { store, driver, engine, ticket } = await plannedInBacklog()
  driver.queues.planner.push(null)
  await revise(engine, ticket.id, 'first')
  driver.queues.planner.push({ text: 'Do you want this under docs/ or notes/?' })
  await revise(engine, ticket.id, 'second')
  driver.queues.planner.push({ fail: 'model error' })
  await revise(engine, ticket.id, 'third')
  const reasons = store.listEvents(ticket.id, { limit: 200 }).filter((e) => e.kind === 'plan_revision_rejected').map((e) => e.payload.reason)
  assert.equal(reasons.length, 3)
  assert.match(reasons[0], /ended without resubmitting a plan/)
  assert.match(reasons[1], /asked a question instead of resubmitting a plan \(Do you want this under docs\/ or notes\/\?\)/)
  assert.match(reasons[2], /turn failed: model error/)
  assert.equal(store.currentPlanVersion(ticket.id), 1)
})

test('a revised plan that declares sandbox grants waits for the human like any first plan', async () => {
  const { store, driver, engine, ticket } = await plannedInBacklog()
  driver.queues.planner.push({ type: 'plan', value: PLAN_GRANTS })
  await revise(engine, ticket.id, 'it needs to push')
  const parked = store.getTicket(ticket.id)
  assert.equal(parked.phase, 'plan', 'back to the plan-approval wait')
  assert.equal(isPlanReady(parked.needsAttentionReason), true)
  assert.equal(store.currentPlanVersion(ticket.id), 2)
  assert.deepEqual(JSON.parse(store.latestArtifact(ticket.id, 'plan').content).sandbox.grants, { paths: ['/ws/grant'], commands: ['git push'] })
  // And the human approving it is what starts the build, as always.
  await engine.approvePlan(ticket.id)
  assert.equal(store.getTicket(ticket.id).phase, 'implement')
})

test('revising a plan in the plan-approval wait: new grants supersede the old, none lifts the park', async () => {
  const withGrants = engineFor({ plan: [{ type: 'plan', value: PLAN_GRANTS }] })
  const ticket = pickedUp(withGrants.store)
  await withGrants.engine.advance(withGrants.store.getTicket(ticket.id))
  assert.equal(isPlanReady(withGrants.store.getTicket(ticket.id).needsAttentionReason), true)
  assert.equal(withGrants.engine.planRevisionBlock(withGrants.store.getTicket(ticket.id)), null, 'revisable while waiting for plan approval')
  // A narrower plan with fresh grants replaces the old ones.
  const narrower = { ...PLAN_GRANTS, sandbox: { grants: { paths: ['/ws/other'], commands: [] }, checks: [{ path: '/ws/other', check: 'test -w /ws/other', observed: 'writable' }] } }
  withGrants.driver.queues.planner.push({ type: 'plan', value: narrower })
  await revise(withGrants.engine, ticket.id, 'only /ws/other')
  assert.deepEqual(JSON.parse(withGrants.store.latestArtifact(ticket.id, 'plan').content).sandbox.grants.paths, ['/ws/other'])
  assert.equal(isPlanReady(withGrants.store.getTicket(ticket.id).needsAttentionReason), true, 'still waiting for approval of the new grants')
  assert.equal(withGrants.store.currentPlanVersion(ticket.id), 2)
  // A plan with no grants at all leaves nothing to approve: the park lifts.
  withGrants.driver.queues.planner.push({ type: 'plan', value: PLAN_V2 })
  await revise(withGrants.engine, ticket.id, 'no grants after all')
  const lifted = withGrants.store.getTicket(ticket.id)
  assert.equal(lifted.needsAttentionReason ?? null, null)
  assert.equal(lifted.phase, 'implement')
  assert.equal('sandbox' in JSON.parse(withGrants.store.latestArtifact(ticket.id, 'plan').content), false)
  assert.equal(withGrants.store.currentPlanVersion(ticket.id), 3)
})

test('a revision is refused once the build has started, while a turn runs, or with nothing to revise', async () => {
  const { store, driver, engine, ticket } = await plannedInBacklog()
  await assert.rejects(() => engine.revisePlan(ticket.id, '   '), /an instruction is required/)
  await assert.rejects(() => engine.revisePlan('missing', 'x'), /no ticket/)

  driver.busy = true
  await assert.rejects(() => engine.revisePlan(ticket.id, 'x'), /a turn is in flight/)
  driver.busy = false

  // The build starts: a build session exists.
  store.attachSession({ ticketId: ticket.id, dshSessionId: 'build-1', role: 'build', purpose: 'build' })
  await assert.rejects(() => engine.revisePlan(ticket.id, 'x'), /build has already started/)

  const fresh = engineFor()
  const unplanned = pickedUp(fresh.store, { column: 'backlog' })
  await assert.rejects(() => fresh.engine.revisePlan(unplanned.id, 'x'), /no plan yet/)

  const reviewing = await plannedInBacklog()
  reviewing.store.transitionTicket(reviewing.ticket.id, { phase: 'review' }, { actor: 'engine', reason: 'seed' })
  await assert.rejects(() => reviewing.engine.revisePlan(reviewing.ticket.id, 'x'), /not in review/)

  const closed = await plannedInBacklog()
  await closed.engine.markDone(closed.ticket.id, 'done elsewhere')
  await assert.rejects(() => closed.engine.revisePlan(closed.ticket.id, 'x'), /already done/)
})

test('a Working ticket that has not built yet can be revised, and the engine does not start it meanwhile', async () => {
  const { store, driver, engine } = engineFor({ plan: [{ type: 'plan', value: PLAN }] })
  const ticket = pickedUp(store, { column: 'backlog', planTiming: 'now' })
  await engine.advance(store.getTicket(ticket.id))
  store.transitionTicket(ticket.id, { column: 'working' }, { actor: 'human', reason: 'drag' })
  driver.queues.planner.push({ type: 'plan', value: PLAN_V2 })
  driver.queues.implementer.push({ type: 'implementation', value: IMPLEMENTATION })
  driver.queues.reviewer.push({ type: 'review', value: REVIEW_PASS })
  const started = await engine.revisePlan(ticket.id, 'under docs/')
  assert.equal(engine.active.has(ticket.id), true, 'the revision holds the ticket, so a tick cannot launch a build under it')
  await started.done
  // Once applied the ticket is free to build against the new plan.
  await new Promise((resolve) => setTimeout(resolve, 30))
  while (engine.active.has(ticket.id)) await engine.active.get(ticket.id)
  assert.equal(store.currentPlanVersion(ticket.id), 2)
  assert.match(lastPrompt(store, ticket.id, 'implementer'), /docs-notes/, 'the build ran against the revised conditions')
})
