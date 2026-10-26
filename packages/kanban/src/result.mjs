// dsh-kanban: the mechanical result protocol.
//
// Code decides before any model does. This module extracts the final JSON,
// validates its schema, checks ids, evidence and confidence in the specified
// order, and returns a decision the engine acts on. An LLM is only consulted
// when this table cannot decide.

const STATUSES = new Set(['complete', 'partial', 'blocked']);

/**
 * Extract the last JSON object from a message. Accepts a bare object, a fenced
 * ```json block, or prose followed by one object; the model gets no credit for
 * putting it anywhere else.
 * @param {string} text
 * @returns {{ok:true, value:unknown, raw:string}|{ok:false, reason:string}}
 */
export function extractJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, reason: 'no text in the final message' };
  const fenced = [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/gi)].map((m) => m[1].trim()).filter(Boolean);
  const candidates = [...fenced];
  const direct = balancedObject(text);
  if (direct !== null) candidates.push(direct);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(candidates[index]);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return { ok: true, value, raw: candidates[index] };
    } catch {
      // try the next candidate
    }
  }
  return { ok: false, reason: 'no parseable JSON object in the final message' };
}

/** Scan for the last balanced top-level object, respecting strings and escapes. */
function balancedObject(text) {
  let best = null;
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          best = text.slice(start, i + 1);
          start = i;
          break;
        }
      }
    }
  }
  return best;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Validate the implementer's result schema. Returns a list of errors; empty
 * means schema-valid (ids are checked separately against the plan).
 */
export function validateImplementResult(value) {
  const errors = [];
  if (!isObject(value)) return ['result is not an object'];
  if (!STATUSES.has(value.status)) errors.push('status must be complete|partial|blocked');
  if (typeof value.summary !== 'string') errors.push('summary must be a string');
  if (!Array.isArray(value.changed_files) || value.changed_files.some((f) => typeof f !== 'string')) {
    errors.push('changed_files must be an array of strings');
  }
  const emptyAllowed = value.status === 'blocked' || (Array.isArray(value.questions) && value.questions.length > 0);
  if (!Array.isArray(value.done_when) || (value.done_when.length === 0 && !emptyAllowed)) {
    errors.push('done_when must be a non-empty array');
  } else if (Array.isArray(value.done_when)) {
    value.done_when.forEach((item, index) => {
      const at = `done_when[${index}]`;
      if (!isObject(item)) {
        errors.push(`${at} is not an object`);
        return;
      }
      if (!isNonEmptyString(item.id)) errors.push(`${at}.id is required`);
      if (typeof item.met !== 'boolean') errors.push(`${at}.met must be a boolean`);
      if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
        errors.push(`${at}.confidence must be a number in [0,1]`);
      }
      if (typeof item.evidence !== 'string') errors.push(`${at}.evidence must be a string`);
    });
  }
  if (value.questions !== undefined && (!Array.isArray(value.questions) || value.questions.some((q) => typeof q !== 'string'))) {
    errors.push('questions must be an array of strings');
  }
  if (
    value.residual_risks !== undefined &&
    (!Array.isArray(value.residual_risks) || value.residual_risks.some((r) => typeof r !== 'string'))
  ) {
    errors.push('residual_risks must be an array of strings');
  }
  return errors;
}

const GENERIC_EVIDENCE = new Set([
  'it works',
  'works',
  'done',
  'ok',
  'passed',
  'tests pass',
  'test passed',
  'complete',
  'completed',
  'n/a',
  'na',
  'yes',
  'true',
]);

/**
 * Evidence is "specific" when it names an observable artifact — a path, a
 * file:line, a command, an exit code, or quoted output. "It works" is not.
 */
export function isSpecificEvidence(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim().toLowerCase();
  if (trimmed.length < 12) return false;
  if (GENERIC_EVIDENCE.has(trimmed)) return false;
  return (
    /[\\/][\w.-]+/.test(text) ||
    /:\d+/.test(text) ||
    /\b(exit|rc|status|code)\s*[=:]\s*\d+/i.test(text) ||
    /`[^`]+`/.test(text) ||
    /\b(ran|running|executed|output|reported|showed)\b/i.test(text) ||
    /\b(test|spec|suite|build|compile|lint)\b/i.test(text)
  );
}

/**
 * The gate order from the spec. First failure decides the branch.
 *
 * @returns {{decision:'pass'|'adjudicate'|'blocked'|'questions', gaps:string[], conditions:object[], schemaErrors:string[]}}
 */
export function gateImplement({ value, conditions, threshold }) {
  const schemaErrors = validateImplementResult(value);
  if (schemaErrors.length > 0) {
    return { decision: 'adjudicate', gaps: schemaErrors, conditions: [], schemaErrors, reason: 'schema' };
  }
  if (value.status === 'blocked') {
    return { decision: 'blocked', gaps: ['implementer reported blocked'], conditions: [], schemaErrors: [] };
  }
  if (Array.isArray(value.questions) && value.questions.length > 0) {
    return { decision: 'questions', gaps: value.questions, conditions: [], schemaErrors: [] };
  }

  const planIds = conditions.map((c) => c.id);
  const resultIds = value.done_when.map((c) => c.id);
  const missing = planIds.filter((id) => !resultIds.includes(id));
  const extra = resultIds.filter((id) => !planIds.includes(id));
  if (missing.length > 0 || extra.length > 0) {
    const gaps = [];
    if (missing.length > 0) gaps.push(`missing conditions: ${missing.join(', ')}`);
    if (extra.length > 0) gaps.push(`unexpected conditions: ${extra.join(', ')}`);
    return { decision: 'adjudicate', gaps, conditions: [], schemaErrors: [], reason: 'ids' };
  }

  const gaps = [];
  const detail = [];
  for (const condition of conditions) {
    const claim = value.done_when.find((c) => c.id === condition.id);
    const specific = isSpecificEvidence(claim.evidence);
    const met = claim.met === true;
    const confident = claim.confidence >= threshold;
    if (met && !specific) gaps.push(`${condition.id}: met but evidence is not specific ("${claim.evidence}")`);
    if (met && !confident) gaps.push(`${condition.id}: confidence ${claim.confidence} < threshold ${threshold}`);
    if (!met) gaps.push(`${condition.id}: reported unmet${claim.evidence ? ` (${claim.evidence})` : ''}`);
    detail.push({
      id: condition.id,
      met,
      confidence: claim.confidence,
      evidence: claim.evidence,
      specific,
      confident,
    });
  }
  if (gaps.length === 0) return { decision: 'pass', gaps: [], conditions: detail, schemaErrors: [] };
  return { decision: 'adjudicate', gaps, conditions: detail, schemaErrors: [], reason: 'conditions' };
}

/** Validate a plan: at least one individually checkable condition. */
export function validatePlan(value) {
  const errors = [];
  if (!isObject(value)) return ['plan is not an object'];
  const conditions = value.done_when ?? value.conditions;
  if (!Array.isArray(conditions) || conditions.length === 0) errors.push('done_when must be a non-empty array');
  else {
    const seen = new Set();
    conditions.forEach((item, index) => {
      const at = `done_when[${index}]`;
      if (!isObject(item)) return errors.push(`${at} is not an object`);
      if (!isNonEmptyString(item.id)) errors.push(`${at}.id is required`);
      else if (seen.has(item.id)) errors.push(`${at}.id "${item.id}" is duplicated`);
      else seen.add(item.id);
      if (!isNonEmptyString(item.statement)) errors.push(`${at}.statement is required`);
      if (!isNonEmptyString(item.how_verified ?? item.howVerified)) errors.push(`${at}.how_verified is required`);
    });
  }
  if (value.summary !== undefined && typeof value.summary !== 'string') errors.push('summary must be a string');
  return errors;
}

/** Normalize a validated plan to the engine's flat shape. */
export function normalizePlan(value) {
  const conditions = value.done_when ?? value.conditions;
  return {
    summary: typeof value.summary === 'string' ? value.summary : '',
    steps: Array.isArray(value.steps) ? value.steps.filter((s) => typeof s === 'string') : [],
    conditions: conditions.map((c, index) => ({
      id: String(c.id),
      statement: String(c.statement),
      howVerified: String(c.how_verified ?? c.howVerified),
      ordinal: index,
    })),
  };
}

/** Validate the intent-coverage judgement. */
export function validateCoverage(value) {
  if (!isObject(value)) return ['coverage is not an object'];
  if (typeof value.covers !== 'boolean') return ['covers must be a boolean'];
  if (value.covers === false && !isNonEmptyString(value.reason)) return ['a negative coverage decision needs a reason'];
  return [];
}

/** Validate the adjudicator's answer. */
export function validateAdjudication(value) {
  if (!isObject(value)) return ['adjudication is not an object'];
  const errors = [];
  if (!['done', 'not_done', 'human'].includes(value.verdict)) errors.push('verdict must be done|not_done|human');
  if (!Array.isArray(value.done_when)) errors.push('done_when must be an array');
  if (value.verdict === 'not_done' && !isNonEmptyString(value.instruction)) errors.push('not_done needs a concrete instruction');
  if (value.verdict === 'human' && !isNonEmptyString(value.reason)) errors.push('human needs a reason');
  return errors;
}

/** Validate the verifier's per-condition verdict. */
export function validateVerification(value) {
  if (!isObject(value)) return ['verification is not an object'];
  if (!Array.isArray(value.done_when) || value.done_when.length === 0) return ['done_when must be a non-empty array'];
  const errors = [];
  value.done_when.forEach((item, index) => {
    if (!isObject(item)) return errors.push(`done_when[${index}] is not an object`);
    if (!isNonEmptyString(item.id)) errors.push(`done_when[${index}].id is required`);
    if (typeof item.met !== 'boolean') errors.push(`done_when[${index}].met must be a boolean`);
    if (typeof item.confidence !== 'number') errors.push(`done_when[${index}].confidence must be a number`);
    if (typeof item.evidence !== 'string') errors.push(`done_when[${index}].evidence must be a string`);
  });
  return errors;
}

/** Validate the reviewer's verdict. */
export function validateReview(value) {
  if (!isObject(value)) return ['review is not an object'];
  const errors = [];
  if (value.verdict !== 'pass' && value.verdict !== 'fail') errors.push('verdict must be pass|fail');
  if (!Array.isArray(value.reasons) || value.reasons.some((r) => typeof r !== 'string')) errors.push('reasons must be an array of strings');
  if (value.verdict === 'fail' && value.reasons.length === 0) errors.push('fail needs at least one reason');
  if (
    value.acceptance_coverage !== undefined &&
    (!Array.isArray(value.acceptance_coverage) ||
      value.acceptance_coverage.some((row) => !isObject(row) || typeof row.condition !== 'string' || typeof row.acceptance !== 'string'))
  ) {
    errors.push('acceptance_coverage must be an array of {condition, acceptance}');
  }
  if (value.scope_drift !== undefined && typeof value.scope_drift !== 'string') errors.push('scope_drift must be a string');
  return errors;
}

/** Validate the griller's JSON. */
export function validateGrill(value) {
  if (!isObject(value)) return ['grill is not an object'];
  const errors = [];
  if (!Array.isArray(value.questions) || value.questions.some((q) => typeof q !== 'string' || q.trim() === '')) {
    errors.push('questions must be an array of non-empty strings');
  }
  if (value.answers !== undefined && (!Array.isArray(value.answers) || value.answers.some((a) => typeof a !== 'string'))) {
    errors.push('answers must be an array of strings');
  }
  if (
    value.refined_acceptance !== undefined &&
    (!Array.isArray(value.refined_acceptance) || value.refined_acceptance.some((a) => typeof a !== 'string'))
  ) {
    errors.push('refined_acceptance must be an array of strings');
  }
  return errors;
}

/** The continuation message for a failed gate: only the specific gaps. */
export function continuationPrompt(gaps, schemaHint) {
  return [
    'Your previous reply did not satisfy the result protocol. Do not start over; answer only these gaps.',
    '',
    ...gaps.map((gap) => `- ${gap}`),
    '',
    schemaHint,
    '',
    'Reply with the complete final JSON object again (not prose only, not a fragment).',
  ].join('\n');
}
