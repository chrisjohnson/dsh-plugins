// dsh-kanban: model-facing phase actions.
//
// These tools are registered inside the agent scope, so they are visible only
// in that workflow session. A tool validates its payload before recording it;
// a phase-mismatched call is an ordinary tool error the model can correct.

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

/**
 * Register the action tools for a session purpose.
 * @returns {() => void} disposer for all tools registered here.
 */
export function registerActionTools({ ctx, sessionId, purpose, liveRef, driver }) {
  const disposers = [];
  if (purpose === 'plan') {
    disposers.push(registerTool(ctx, {
      name: 'kanban_submit_plan',
      description: 'Submit the complete implementation plan. Call this when you have enough information; it ends the planning session.',
      parameters: PLAN_PARAMETERS,
      output: TOOL_OUTPUT,
      async execute(args, exec) {
        const errors = validatePlan(args);
        if (errors.length > 0) throw new Error(`plan rejected: ${errors.join('; ')}`);
        if (!Array.isArray(args.done_when) || args.done_when.length === 0) throw new Error('plan needs at least one done_when condition');
        return accept(driver, sessionId, { type: 'plan', value: args }, exec);
      },
    }));
  }
  if (purpose === 'build') {
    disposers.push(registerTool(ctx, {
      name: 'kanban_submit_implementation',
      description: 'Submit the implementation result. Call this when the implementation work for this round is finished.',
      parameters: IMPLEMENT_PARAMETERS,
      output: TOOL_OUTPUT,
      async execute(args, exec) {
        requirePhase(liveRef, 'implementer', 'kanban_submit_implementation');
        const errors = validateImplementResult(args);
        if (errors.length > 0) throw new Error(`implementation rejected: ${errors.join('; ')}`);
        return accept(driver, sessionId, { type: 'implementation', value: args }, exec);
      },
    }));
    disposers.push(registerTool(ctx, {
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
        return accept(driver, sessionId, { type: 'review', value: args }, exec);
      },
    }));
  }
  if (purpose === 'approval') {
    const runAfterTurn = (exec, fn) => {
      exec.concludeTurn();
      setTimeout(() => { Promise.resolve().then(fn).catch((error) => driver.log?.warn?.('approval action failed: %s', String(error?.stack ?? error))); }, 0);
      return { accepted: true };
    };
    disposers.push(registerTool(ctx, {
      name: 'kanban_approve',
      description: 'Approve the completed work and close the ticket as done. Use only after the work is actually complete.',
      parameters: APPROVE_PARAMETERS,
      output: TOOL_OUTPUT,
      async execute(args, exec) {
        if (driver.approval === undefined) throw new Error('approval handlers are unavailable');
        return runAfterTurn(exec, () => driver.approval.approve(liveRef.ticketId, args.message ?? ''));
      },
    }));
    disposers.push(registerTool(ctx, {
      name: 'kanban_discard',
      description: 'Discard the ticket and its work, closing it without approval.',
      parameters: DISCARD_PARAMETERS,
      output: TOOL_OUTPUT,
      async execute(args, exec) {
        if (driver.approval === undefined) throw new Error('approval handlers are unavailable');
        return runAfterTurn(exec, () => driver.approval.discard(liveRef.ticketId, args.reason ?? ''));
      },
    }));
    disposers.push(registerTool(ctx, {
      name: 'kanban_submit_plan',
      description: 'Submit a new plan for another build/review round instead of approving or discarding.',
      parameters: PLAN_PARAMETERS,
      output: TOOL_OUTPUT,
      async execute(args, exec) {
        if (driver.approval === undefined) throw new Error('approval handlers are unavailable');
        const errors = validatePlan(args);
        if (errors.length > 0) throw new Error(`plan rejected: ${errors.join('; ')}`);
        if (!Array.isArray(args.done_when) || args.done_when.length === 0) throw new Error('plan needs at least one done_when condition');
        return runAfterTurn(exec, () => driver.approval.plan(liveRef.ticketId, args));
      },
    }));
  }
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
