// dsh-kanban: structured ticket data rendered as readable markdown for prompts.
//
// Plans, implementer results and review verdicts are stored as JSON because the
// tool-call protocol is JSON. A model reading a prompt should not have to parse
// that: every function here turns one stored shape back into plain markdown. Pure:
// nothing here touches the store, the engine or dsh.

const NONE = '(none)';

const list = (items) => (Array.isArray(items) ? items.filter((item) => typeof item === 'string' && item.trim() !== '') : []);
const bullets = (items) => list(items).map((item) => `- ${item}`);

/** One condition as markdown: id, statement, how it is verified, its source. */
export function conditionMarkdown(condition, { deferredNote = '' } = {}) {
  return [
    `- \`${condition.id}\` — ${condition.statement}`,
    `  - how verified: ${condition.howVerified}${deferredNote}`,
    `  - source: ${condition.source ?? 'plan'}`,
  ].join('\n');
}

export function conditionsMarkdown(conditions, { note = () => '' } = {}) {
  if (!Array.isArray(conditions) || conditions.length === 0) return '(the plan declared no conditions)';
  return conditions.map((condition) => conditionMarkdown(condition, { deferredNote: note(condition) })).join('\n');
}

/** The plan's summary, steps, release scope and sandbox section (conditions are rendered separately). */
export function planMarkdown(plan) {
  if (plan === null || plan === undefined || typeof plan !== 'object') return '(no plan)';
  const out = [];
  out.push(typeof plan.summary === 'string' && plan.summary.trim() !== '' ? plan.summary.trim() : '(the plan has no summary)');
  const steps = list(plan.steps);
  if (steps.length > 0) {
    out.push('', '### Steps', '', ...steps.map((step, index) => `${index + 1}. ${step}`));
  }
  if (plan.releaseScope === 'stop_before_merge') {
    out.push('', '### Release scope', '', 'Stop before the release: the work ends on a branch; merging, tagging and deploying are the human\'s deferred steps.');
  } else if (plan.releaseScope === 'full_release') {
    out.push('', '### Release scope', '', 'Full release: this build carries the release through (merge, tag, deploy) unless a condition is deferred.');
  }
  const grants = plan.sandbox?.grants;
  const paths = list(grants?.paths);
  const commands = list(grants?.commands);
  if (paths.length > 0 || commands.length > 0) {
    out.push('', '### Sandbox grants (approved by the human with the plan)', '');
    if (paths.length > 0) out.push('Paths this build may write outside its workspace:', ...bullets(paths));
    if (commands.length > 0) out.push('Command prefixes this build may run beyond the standing sandbox:', ...bullets(commands));
  }
  const checks = Array.isArray(plan.sandbox?.checks) ? plan.sandbox.checks : [];
  if (checks.length > 0) {
    out.push('', '### Sandbox checks the planner recorded', '');
    for (const row of checks) out.push(`- \`${row.path}\` — checked: ${row.check}; observed: ${row.observed}`);
  }
  return out.join('\n');
}

/** The implementer's result as markdown. */
export function implementResultMarkdown(result) {
  if (result === null || result === undefined || typeof result !== 'object') return '(no implementation result recorded)';
  const out = [`Status: ${result.status ?? '(unset)'}`, '', typeof result.summary === 'string' && result.summary.trim() !== '' ? result.summary.trim() : '(no summary)'];
  const files = list(result.changed_files);
  out.push('', 'Changed files:', ...(files.length > 0 ? bullets(files) : [NONE]));
  const rows = Array.isArray(result.done_when) ? result.done_when : [];
  out.push('', 'Per-condition claims:');
  if (rows.length === 0) out.push(NONE);
  for (const row of rows) {
    out.push(`- \`${row.id}\` — ${row.met === true ? 'met' : 'NOT met'} (confidence ${row.confidence}): ${row.evidence}`);
  }
  const risks = list(result.residual_risks);
  if (risks.length > 0) out.push('', 'Residual risks:', ...bullets(risks));
  const questions = list(result.questions);
  if (questions.length > 0) out.push('', 'Open questions:', ...bullets(questions));
  return out.join('\n');
}

/** A review verdict as markdown (the feedback a rework round answers). */
export function reviewMarkdown(review) {
  if (review === null || review === undefined || typeof review !== 'object') return '(no review recorded)';
  const out = [`Verdict: ${review.verdict ?? '(unset)'}`];
  const reasons = list(review.reasons);
  if (reasons.length > 0) out.push('', 'Reasons:', ...bullets(reasons));
  if (typeof review.instruction === 'string' && review.instruction.trim() !== '') {
    out.push('', 'Instruction for the next round:', '', review.instruction.trim());
  }
  if (typeof review.scope_drift === 'string' && review.scope_drift.trim() !== '' && review.scope_drift.trim().toLowerCase() !== 'none') {
    out.push('', `Scope drift: ${review.scope_drift.trim()}`);
  }
  const rows = Array.isArray(review.done_when) ? review.done_when : [];
  if (rows.length > 0) {
    out.push('', 'Per-condition findings:');
    for (const row of rows) out.push(`- \`${row.id}\` — ${row.met === true ? 'met' : 'NOT met'} (confidence ${row.confidence}): ${row.evidence}`);
  }
  const coverage = Array.isArray(review.acceptance_coverage) ? review.acceptance_coverage : [];
  if (coverage.length > 0) {
    out.push('', 'Acceptance coverage:');
    for (const row of coverage) out.push(`- "${row.acceptance}" is covered by \`${row.condition}\``);
  }
  return out.join('\n');
}

/**
 * What the engine checks before it accepts `kanban_submit_implementation`, and
 * what the review that follows holds the claims to. Written from the checks in
 * actions.mjs / result.mjs; the conditions list makes the id rule concrete.
 */
export function submissionContract({ conditions, threshold, rework = false }) {
  const ids = (Array.isArray(conditions) ? conditions : []).map((c) => `\`${c.id}\``).join(', ') || '(none)';
  const lines = [
    'The engine checks these before it accepts a `kanban_submit_implementation` call, and rejects the call (nothing is recorded) if any fails:',
    '',
    '- `status` is exactly `complete`, `partial` or `blocked`.',
    '- `summary` is a string and `changed_files` is an array of strings.',
    '- `done_when` is a non-empty array. It may be empty only when `status` is `blocked` or `questions` is non-empty.',
    '- Every `done_when` row is `{id, met, confidence, evidence}`: `id` a non-empty string, `met` a boolean, `confidence` a number from 0 to 1, `evidence` a string.',
    `- The row ids are exactly the plan's condition ids: ${ids}. A missing id and an invented id both reject the call.`,
    '- `questions` and `residual_risks`, when present, are arrays of strings.',
    '',
    'The review that follows holds each claim to this:',
    '',
    `- A condition reported \`met: true\` needs specific evidence: a path, a \`file:line\`, a command and what it printed. "It works" is not evidence.`,
    `- It needs \`confidence\` of at least ${threshold}; below that the claim does not count.`,
    '- A condition marked deferred to approval is not yours to prove: report it `met: false` and say so.',
  ];
  if (rework) {
    lines.push('- The working tree must differ from where the previous round started. A round that changes nothing parks the ticket as no progress instead of spending an attempt.');
  }
  lines.push('', 'Submit by calling the tool. Do not emit the result as prose or as a JSON answer.');
  return lines.join('\n');
}
