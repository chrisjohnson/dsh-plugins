// dsh-kanban: the Questions setting applied to the whole ticket (KAN-32).
//
// A ticket carries one `planQuestions` choice — `interactive` (ask me) or
// `autonomous` (decide autonomously). Before 0.18.0 only planning honoured it:
// an autonomous ticket's build session still stopped on an `ask_user_question`
// prompt and waited for a human, which is exactly the round trip the setting
// says it does not want. This module closes that gap the same way KAN-30 closed
// the sandbox one: a pure decision module plus an agent-scoped waterfall
// listener on the seam core already exposes.
//
// The seam is real, not invented. `@deepseek-ai/dsh-user-questions` answers an
// `ask_user_question` call by dispatching
// `ctx.waterfall(scopeTarget(agent, agent), "user-questions/request", ...)`,
// and a cordis waterfall settles on the first listener that does not call
// `next()`. Registering on the agent's own scope with `prepend` therefore puts
// the board in front of the human bridge for that session and nobody else's.
//
// What gets decided, and what never does:
//
// - A batch is auto-answered only when EVERY question in it carries a non-empty
//   `options` list: an option list is a decision the model already made and
//   offered a human a chance to overrule, so taking the first (recommended)
//   option is taking the model's own answer, not inventing one. A question with
//   no options is the model saying it genuinely does not know; that stays with
//   a person.
// - Plan-phase option batches are auto-answered for EVERY ticket. The plan
//   prompt now says so, so a planner that needs a human asks an optionless
//   question.
// - Build-phase (implement, review) batches are auto-answered only for an
//   `autonomous` ticket. An `interactive` ticket keeps being asked.
// - The approval (verify) phase is never answered here. Wrapping up a finished
//   ticket is the one conversation that is the human's by definition.
// - A done or discarded ticket is never answered: nothing should be asking
//   anything from a closed ticket, and an answer would resurrect its turn.
// - A question that carries a presentation `intent` is never answered from, in
//   any phase or mode. `exit_plan_mode` asks through this same seam with
//   `kind: 'plan-review'` and *Approve* as its first option: an option list
//   there is not a recommendation, it is a human's decision, and taking the
//   first label would approve a plan with nobody in the room.
// - Every miss, malformed input or exception calls `next()`. The human stays
//   the answerer of last resort; a broken auto-answer path costs a prompt,
//   never a silent decision.
//
// Every auto-answer writes a `question_answered_autonomously` ticket event
// first, and if that write fails it does not answer: an unlogged decision is a
// decision nobody can review, so the ask falls back to the human.
//
// The module imports nothing from `@deepseek-ai/*`, so the whole matrix is
// testable on a bare clone.

/** The ticket phases whose questions this module may ever answer. */
const ANSWERABLE_PHASES = new Set(['plan', 'implement', 'review']);

/**
 * The recommended answer to a batch, or null when the batch is not one the
 * engine may decide.
 *
 * Every question must carry a usable id (the answer is keyed by it), a
 * non-empty `options` array, and a first option with a non-empty string label.
 * Anything else — free text, a malformed call, an option list whose first
 * entry is not a label — is not a decision the model already made, so it is
 * not ours to take.
 *
 * A question carrying a presentation `intent` is never answered here, whatever
 * its options look like. An intent means a UI recognises the ask as a specific
 * kind of decision rather than a free choice between labels: `exit_plan_mode`
 * asks through this exact seam with `kind: 'plan-review'` and *Approve* as its
 * first option, so taking the first label there would approve a plan with no
 * human — the one decision this board exists to put in front of a person. The
 * intent is the ask saying it is not a recommendation, and it wins.
 *
 * @param {unknown} questions - the batch as the ask reached the waterfall.
 * @returns {{answers: Array<{id: string, selected: string[]}>}|null}
 */
export function recommendedAnswer(questions) {
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const answers = [];
  for (const question of questions) {
    if (question === null || typeof question !== 'object') return null;
    if (question.intent !== undefined && question.intent !== null) return null;
    const id = typeof question.id === 'string' ? question.id.trim() : '';
    if (id === '') return null;
    const options = question.options;
    if (!Array.isArray(options) || options.length === 0) return null;
    const first = options[0];
    if (first === null || typeof first !== 'object') return null;
    const label = typeof first.label === 'string' ? first.label : '';
    if (label.trim() === '') return null;
    answers.push({ id, selected: [label] });
  }
  return { answers };
}

/**
 * Build the `user-questions/request` waterfall listener for one workflow
 * session.
 *
 * @param {{store: object, log?: object}} deps - the board store and a logger.
 * @returns {(req: object, next: () => unknown) => unknown}
 */
export function makeQuestionAnswerer({ store, log }) {
  const warn = (fmt, ...args) => {
    try {
      log?.warn?.(fmt, ...args);
    } catch {
      // A broken logger must never change an answer outcome.
    }
  };
  return function questionAnswerer(req, next) {
    try {
      const agentId = req?.agent?.id;
      if (typeof agentId !== 'string' || agentId === '') return next();
      const session = store.findSession(agentId);
      const ticketId = session?.ticketId ?? null;
      if (ticketId === null || ticketId === undefined) return next();
      const ticket = store.getTicket(ticketId);
      if (ticket === null || ticket === undefined) return next();
      if (ticket.column === 'done' || ticket.column === 'discarded') return next();
      const phase = ticket.phase;
      if (!ANSWERABLE_PHASES.has(phase)) return next();
      // Planning decides option batches for every ticket; the build session
      // only when the ticket asked to be driven autonomously.
      if (phase !== 'plan' && ticket.planQuestions !== 'autonomous') return next();
      const answer = recommendedAnswer(req?.questions);
      if (answer === null) return next();
      const callId = typeof req?.wait?.callId === 'string' ? req.wait.callId : null;
      try {
        store.appendEvent(ticketId, 'question_answered_autonomously', {
          actor: 'engine',
          phaseFrom: phase,
          phaseTo: phase,
          payload: { callId, answers: answer.answers },
        });
      } catch (error) {
        // The event is the audit trail of the decision. No event, no decision:
        // the human answers it instead.
        warn('kanban questions: could not record question_answered_autonomously for %s: %s', ticketId, String(error?.message ?? error));
        return next();
      }
      warn(
        'kanban questions: %s auto-answered %s question(s) in %s: %s',
        ticketId,
        String(answer.answers.length),
        phase,
        answer.answers.map((a) => `${a.id}="${a.selected[0]}"`).join(', '),
      );
      return answer;
    } catch (error) {
      warn('kanban questions: answerer failed open to the human: %s', String(error?.stack ?? error));
      return next();
    }
  };
}

/** Map one model-facing question entry into the shape the service takes. */
function serviceQuestion(question) {
  return {
    id: question.id,
    question: question.question,
    ...(typeof question.header === 'string' && question.header !== '' ? { header: question.header } : {}),
    ...(Array.isArray(question.options) ? { options: question.options.map((option) => ({ ...option })) } : {}),
    ...(question.multi_select !== undefined ? { multiSelect: question.multi_select } : {}),
    ...(question.multiSelect !== undefined ? { multiSelect: question.multiSelect } : {}),
    ...(question.detail !== undefined ? { detail: question.detail } : {}),
  };
}

/**
 * The tolerant `ask_user_question` tool definition, as a plain object so this
 * module stays free of `@deepseek-ai/*` and the mapping is testable on a bare
 * clone; the caller wraps it in `defineTool` and registers it in the agent
 * scope, where it shadows the preset's copy.
 *
 * It is the core tool's schema with two deliberate differences. `id` is not
 * required, because the observed failure was a model emitting a batch without
 * ids and losing the question entirely — `sanitizeQuestions` assigns what is
 * missing instead. And the ask carries `wait: {callId}`, which is what keys the
 * client card `question:<sessionId>:<callId>`: without it the card gets an
 * anonymous key that changes on every render, and a half-typed answer is gone
 * the moment the page reloads. With it, core's own persisted draft store
 * (`dsh.user-questions.drafts.v1`) restores the selection.
 *
 * @param {{ask: (request: object) => Promise<{answers: object[]}>, log?: object}} deps
 * @returns {object} a definition for `defineTool`
 */
export function askUserToolDefinition({ ask, log }) {
  const warn = (fmt, ...args) => {
    try {
      log?.warn?.(fmt, ...args);
    } catch {
      // A broken logger must never change a tool outcome.
    }
  };
  return {
    name: 'ask_user_question',
    description:
      'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. ' +
      'Give every question a distinct id. When you have a recommendation, put it first in `options` and append "(Recommended)" to its label.',
    parameters: {
      questions: {
        type: 'array',
        required: true,
        description: 'Questions to ask the user before continuing.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string', description: 'Stable id for this question; echoed in the answer. Omitted ids are assigned in order.' },
            question: { type: 'string', required: true, description: 'The specific question to ask the user.' },
            header: { type: 'string', description: 'Optional short heading for the question, such as "Confirm" or "Choose Mode".' },
            options: {
              type: 'array',
              description: 'Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  label: { type: 'string', required: true, description: 'Short user-facing option label.' },
                  description: { type: 'string', description: 'One sentence explaining the tradeoff or impact.' },
                },
              },
            },
            multi_select: { type: 'boolean', description: 'Whether the user may select more than one option. Defaults to false.' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                selected: { type: 'array', required: true, items: { type: 'string' } },
                custom: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const questions = sanitizeQuestions(args?.questions).map(serviceQuestion);
      const answer = await ask({
        questions,
        ...(exec?.agent !== undefined && exec.agent !== null ? { agent: exec.agent } : {}),
        ...(exec?.signal !== undefined ? { signal: exec.signal } : {}),
        ...(typeof exec?.callId === 'string' && exec.callId !== '' ? { wait: { callId: exec.callId } } : {}),
      });
      const answers = Array.isArray(answer?.answers) ? answer.answers : [];
      warn('kanban questions: ask_user_question settled with %s answer(s)', String(answers.length));
      return {
        answers: answers.map((item) => ({
          id: String(item?.id ?? ''),
          selected: Array.isArray(item?.selected) ? [...item.selected] : [],
          ...(typeof item?.custom === 'string' ? { custom: item.custom } : {}),
        })),
      };
    },
  };
}

/**
 * Make a question batch safe to hand to the question service.
 *
 * The observed failure this exists for: a model emitted a batch whose questions
 * carried no `id`, the service rejected the whole call, and the session lost
 * the question rather than recovering from it. An id is bookkeeping, not
 * content — the batch is still exactly what the model meant to ask — so a
 * missing one is assigned here (`q1`, `q2`, …, never colliding with an id the
 * model did supply), and a duplicate is disambiguated the same way. What is
 * *not* bookkeeping is the question text: a batch with no questions, or an
 * entry with no question, is a call the model has to make again, so it throws a
 * readable error the tool layer turns into a correction the model can act on.
 *
 * @param {unknown} questions
 * @returns {object[]} the batch, every entry carrying a unique string id
 */
export function sanitizeQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('ask_user_question needs a non-empty `questions` array');
  }
  const used = new Set();
  return questions.map((question, index) => {
    if (question === null || typeof question !== 'object' || Array.isArray(question)) {
      throw new Error(`ask_user_question: questions[${index}] must be an object with a "question" string`);
    }
    if (typeof question.question !== 'string' || question.question.trim() === '') {
      throw new Error(`ask_user_question: questions[${index}] has no question text`);
    }
    const given = typeof question.id === 'string' ? question.id.trim() : '';
    let id = given;
    if (id === '' || used.has(id)) {
      let n = index + 1;
      while (used.has(`q${n}`)) n += 1;
      id = `q${n}`;
    }
    used.add(id);
    return { ...question, id };
  });
}
