// dsh-kanban: model-facing phase actions.
//
// All six action tools are registered in every workflow session, whatever its
// purpose: a session changes phase inside its own life (implement -> review) and
// a restarted board can hand a plan session back as an approval session, so a
// session must never be missing the tool its next turn needs. Each submitting
// tool therefore enforces its own phase and refuses a call that does not belong
// to it; that rejection is an ordinary tool error the model can read and
// correct. `kanban_plan` reads the board and is gated by nothing at all.
//
// These tools are registered inside the agent scope, so they are visible only
// in that workflow session. A tool validates its payload before recording it.

import { defineTool } from '@deepseek-ai/dsh-tools';

import { validateImplementResult, validatePlan, validateReview } from './result.mjs';

const TOOL_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
};

const PLAN_PARAMETERS = {
  summary: { type: 'string', required: true, description: 'One paragraph describing the implementation approach.' },
  steps: { type: 'array', required: true, items: { type: 'string' }, description: 'Ordered implementation steps.' },
  done_when: {
    type: 'array',
    required: true,
    description: 'Non-empty, individually checkable completion conditions.',
    items: {
      type: 'object',
      additionalProperties: true,
      properties: {
        id: { type: 'string', required: true, description: 'Short kebab-case identifier, unique in this plan.' },
        statement: { type: 'string', required: true, description: 'One observable fact that must be true.' },
        how_verified: { type: 'string', required: true, description: 'Exact command or observable a verifier can check.' },
      },
    },
  },
};

const IMPLEMENT_PARAMETERS = {
  status: { type: 'string', required: true, description: 'complete, partial, or blocked.' },
  summary: { type: 'string', required: true, description: 'What changed and why.' },
  changed_files: { type: 'array', required: true, items: { type: 'string' }, description: 'Files changed by this turn.' },
  done_when: {
    type: 'array',
    required: true,
    description: 'Your per-condition result claims.',
    items: {
      type: 'object',
      additionalProperties: true,
      properties: {
        id: { type: 'string', required: true },
        met: { type: 'boolean', required: true },
        confidence: { type: 'number', required: true, description: '0..1' },
        evidence: { type: 'string', required: true },
      },
    },
  },
  questions: { type: 'array', items: { type: 'string' }, description: 'Optional questions for the orchestrator.' },
  residual_risks: { type: 'array', items: { type: 'string' } },
};

const REVIEW_PARAMETERS = {
  verdict: { type: 'string', required: true, description: 'pass or fail.' },
  reasons: { type: 'array', required: true, items: { type: 'string' }, description: 'Why the verdict was reached.' },
  scope_drift: { type: 'string', description: 'Any work outside the ticket/plan scope.' },
  acceptance_coverage: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: true,
      properties: {
        condition: { type: 'string', required: true },
        acceptance: { type: 'string', required: true },
      },
    },
  },
  done_when: {
    type: 'array',
    description: 'One row for every plan done_when id, using the same ids, with met/confidence/evidence.',
    items: {
      type: 'object',
      additionalProperties: true,
      properties: {
        id: { type: 'string', required: true },
        met: { type: 'boolean', required: true },
        confidence: { type: 'number', required: true },
        evidence: { type: 'string', required: true },
      },
    },
  },
  instruction: { type: 'string', description: 'Concrete changes needed when verdict is fail.' },
};

const APPROVE_PARAMETERS = {
  message: { type: 'string', description: 'Optional note recorded with the approval.' },
};

const DISCARD_PARAMETERS = {
  reason: { type: 'string', description: 'Optional reason recorded with the discard.' },
};

const PLAN_READ_PARAMETERS = {};

/**
 * The plan's condition ids, straight from the board. An empty list means the
 * ticket has no plan yet, and every cross-check below stands down rather than
 * inventing a failure the human has to decode.
 */
function planConditionIds(store, ticketId) {
  if (store === undefined || store === null || typeof store.listConditions !== 'function') return [];
  try {
    return store.listConditions(ticketId).map((condition) => String(condition.id));
  } catch {
    return [];
  }
}

/**
 * Compare submitted done_when ids against the plan's ids and name the expected
 * set in the error. The model gets a correction it can act on instead of a
 * silent mismatch the engine would only notice later, and the ids it must use
 * are in the message rather than in a plan it may have summarized away.
 *
 * @param {string[]} submitted the ids the tool call carried
 * @param {string[]} expected the plan's condition ids
 * @param {string} tool tool name for the error line
 * @param {boolean} exact true to require an exact set, false to allow omissions
 */
function assertConditionIds(submitted, expected, tool, exact) {
  if (expected.length === 0) return;
  const missing = exact ? expected.filter((id) => !submitted.includes(id)) : [];
  const unknown = submitted.filter((id) => !expected.includes(id));
  if (missing.length === 0 && unknown.length === 0) return;
  const parts = [];
  if (missing.length > 0) parts.push(`missing ${missing.join(', ')}`);
  if (unknown.length > 0) parts.push(`not plan conditions: ${unknown.join(', ')}`);
  throw new Error(`${tool} rejected — ${parts.join('; ')}. The plan's condition ids are exactly: ${expected.join(', ')}. Resubmit with one done_when row per id, using these ids unchanged.`);
}

function submittedIds(value) {
  return Array.isArray(value?.done_when)
    ? value.done_when.filter((row) => row !== null && typeof row === 'object').map((row) => String(row.id ?? ''))
    : [];
}

function parseArtifact(content) {
  if (typeof content !== 'string') return null;
  try {
    const value = JSON.parse(content);
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** The plan's conditions in the shape the model submitted them, ids included. */
function planConditionObjects(store, ticketId) {
  if (store === undefined || store === null || typeof store.listConditions !== 'function') return [];
  try {
    return store.listConditions(ticketId).map((condition) => ({
      id: String(condition.id),
      statement: String(condition.statement),
      how_verified: String(condition.howVerified ?? condition.how_verified ?? ''),
    }));
  } catch {
    return [];
  }
}


function accept(driver, sessionId, action, exec) {
  return driver.submitAction(sessionId, action, exec);
}

function requirePhase(liveRef, expected, tool) {
  const current = liveRef.phase.role;
  if (current !== expected) {
    throw new Error(`${tool} is not available in the ${current} phase`);
  }
}

function registerTool(ctx, definition) {
  return ctx.tools.register(defineTool(definition));
}

function validatePlanPayload(args) {
  const errors = validatePlan(args);
  if (errors.length > 0) throw new Error(`plan rejected: ${errors.join('; ')}`);
  if (!Array.isArray(args.done_when) || args.done_when.length === 0) throw new Error('plan needs at least one done_when condition');
}

/**
 * Register every Kanban action tool in one workflow session.
 *
 * The session purpose is deliberately not an input: what each tool accepts is
 * decided by the session's current phase (`liveRef.phase.role`), so a session
 * that changes phase mid-life, or one reattached after a restart, never finds
 * the tool it needs missing. The engine re-validates the ticket's own phase, so
 * a call that is in the right session but the wrong ticket state still fails
 * cleanly.
 *
 * @returns {() => void} disposer for all tools registered here.
 */
export function registerActionTools({ ctx, sessionId, liveRef, driver, store }) {
  const board = store ?? driver?.store ?? null;
  const disposers = [];
  const register = (definition) => disposers.push(registerTool(ctx, definition));

  // Approval actions close the ticket and its session, so they conclude the turn
  // first and run the engine call after it has settled.
  const runAfterTurn = (exec, fn) => {
    exec.concludeTurn();
    setTimeout(() => { Promise.resolve().then(fn).catch((error) => driver.log?.warn?.('approval action failed: %s', String(error?.stack ?? error))); }, 0);
    return { accepted: true };
  };

  register({
    name: 'kanban_submit_plan',
    description: 'Submit the implementation plan. In a planning session this ends planning; in an approval session it sends the ticket back for another build/review round instead of approving or discarding it.',
    parameters: PLAN_PARAMETERS,
    output: TOOL_OUTPUT,
    async execute(args, exec) {
      const role = liveRef.phase.role;
      if (role !== 'planner' && role !== 'approver') {
        throw new Error(`kanban_submit_plan is not available in the ${role} phase`);
      }
      validatePlanPayload(args);
      if (role === 'planner') return accept(driver, sessionId, { type: 'plan', value: args }, exec);
      if (driver.approval === undefined) throw new Error('approval handlers are unavailable');
      return runAfterTurn(exec, () => driver.approval.plan(liveRef.ticketId, args));
    },
  });

  register({
    name: 'kanban_submit_implementation',
    description: 'Submit the implementation result. Call this when the implementation work for this round is finished.',
    parameters: IMPLEMENT_PARAMETERS,
    output: TOOL_OUTPUT,
    async execute(args, exec) {
      requirePhase(liveRef, 'implementer', 'kanban_submit_implementation');
      const errors = validateImplementResult(args);
      if (errors.length > 0) throw new Error(`implementation rejected: ${errors.join('; ')}`);
      // A blocked run or one that stopped to ask questions legitimately reports
      // no claims, so there is nothing to cross-check; anything else must name
      // exactly the plan's conditions.
      const claims = submittedIds(args);
      assertConditionIds(claims, planConditionIds(board, liveRef.ticketId), 'kanban_submit_implementation', claims.length > 0);
      return accept(driver, sessionId, { type: 'implementation', value: args }, exec);
    },
  });

  register({
    name: 'kanban_submit_review',
    description: 'Submit the review verdict. Include one done_when row per plan id and one acceptance_coverage row per acceptance statement; a pass advances to human approval.',
    parameters: REVIEW_PARAMETERS,
    output: TOOL_OUTPUT,
    async execute(args, exec) {
      requirePhase(liveRef, 'reviewer', 'kanban_submit_review');
      const errors = validateReview(args);
      if (errors.length > 0) throw new Error(`review rejected: ${errors.join('; ')}`);
      if (args.verdict === 'fail' && typeof args.instruction !== 'string') {
        throw new Error('review rejected: a fail verdict needs a concrete instruction');
      }
      // A pass claims every condition met, so its rows must be exactly the plan's;
      // a fail is allowed to stop listing what it already sent back. An id that
      // is not in the plan is wrong either way.
      assertConditionIds(
        submittedIds(args),
        planConditionIds(board, liveRef.ticketId),
        'kanban_submit_review',
        args.verdict === 'pass',
      );
      return accept(driver, sessionId, { type: 'review', value: args }, exec);
    },
  });

  register({
    name: 'kanban_approve',
    description: 'Approve the completed work and close the ticket as done. Use only after the work is actually complete.',
    parameters: APPROVE_PARAMETERS,
    output: TOOL_OUTPUT,
    async execute(args, exec) {
      requirePhase(liveRef, 'approver', 'kanban_approve');
      if (driver.approval === undefined) throw new Error('approval handlers are unavailable');
      return runAfterTurn(exec, () => driver.approval.approve(liveRef.ticketId, args.message ?? ''));
    },
  });

  register({
    name: 'kanban_discard',
    description: 'Discard the ticket and its work, closing it without approval.',
    parameters: DISCARD_PARAMETERS,
    output: TOOL_OUTPUT,
    async execute(args, exec) {
      requirePhase(liveRef, 'approver', 'kanban_discard');
      if (driver.approval === undefined) throw new Error('approval handlers are unavailable');
      return runAfterTurn(exec, () => driver.approval.discard(liveRef.ticketId, args.reason ?? ''));
    },
  });

  register({
    name: 'kanban_plan',
    description: 'Read the current plan, its done_when conditions, and the latest review for this ticket. Read-only and available in every phase: use it to re-read the contract you are working against.',
    parameters: PLAN_READ_PARAMETERS,
    output: TOOL_OUTPUT,
    async execute() {
      if (board === null) throw new Error('kanban_plan is unavailable: the board store is not attached to this session');
      const ticketId = liveRef.ticketId;
      const planRow = typeof board.latestArtifact === 'function' ? board.latestArtifact(ticketId, 'plan') : undefined;
      const reviewRow = typeof board.latestArtifact === 'function' ? board.latestArtifact(ticketId, 'review') : undefined;
      const plan = planRow === undefined || planRow === null ? null : parseArtifact(planRow.content);
      const review = reviewRow === undefined || reviewRow === null ? null : parseArtifact(reviewRow.content);
      const conditions = planConditionObjects(board, ticketId);
      if (plan === null && conditions.length === 0) {
        return { plan: null, conditions: [], review: null, note: 'This ticket has no plan yet. Call kanban_submit_plan when you have one.' };
      }
      return {
        plan: plan === null ? null : { summary: plan.summary ?? '', steps: plan.steps ?? [], done_when: conditions },
        conditions,
        review,
      };
    },
  });

  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch {
        // Disposal is best-effort during session teardown.
      }
    }
  };
}
