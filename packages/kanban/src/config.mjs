// dsh-kanban: configuration defaults and strict validation.
//
// The rule this file exists to enforce is the project's deletion test: if a
// value would still be meaningful after deleting the database, it is config,
// and it lives here plus the deployment's profile patch — never in SQLite.
//
// This module imports nothing from @deepseek-ai/* so every branch is testable
// on a bare clone. The host half resolves `null` routes against the host's
// model catalog; this half only decides whether a value is *shaped* correctly.

export const ROLES = ['planner', 'implementer', 'reviewer', 'approver'];

export const DEFAULT_TOOLS = {
  // Planning is read-only by intent; the guard also blocks write/edit.
  planner: ['read', 'read_image', 'glob', 'grep', 'bash', 'ask_user_question', 'subagent', 'subagent_fork'],
  implementer: ['read', 'read_image', 'write', 'edit', 'glob', 'grep', 'bash', 'job_list', 'job_output', 'job_kill', 'subagent', 'subagent_fork'],
  // Review inspects; the engine's edit guard blocks write/edit in review.
  reviewer: ['read', 'read_image', 'glob', 'grep', 'bash'],
  approver: ['read', 'read_image', 'write', 'edit', 'glob', 'grep', 'bash', 'job_list', 'job_output', 'job_kill', 'subagent', 'subagent_fork'],
};

/** Prompt files, relative to promptsDir. */
export const DEFAULT_PROMPTS = {
  'plan-human': 'plan-human.md',
  'plan-self': 'plan-self.md',
  implement: 'implement.md',
  rework: 'rework.md',
  review: 'review.md',
};

export const DEFAULT_CONFIG = {
  /** SQLite file. `null` resolves to `$DSH_HOME/kanban/kanban.db`. */
  dbPath: null,
  /** Default cwd for a ticket created without one. `null` resolves to process.cwd(). */
  defaultWorkspaceCwd: null,

  /** Provider concurrency/pricing. Unknown providers are admitted one at a time at an unknown price. */
  providers: [],

  /** role -> route + tool allow-list. Roles are model routes, not system prompts. */
  roles: {
    planner: {
      provider: null,
      model: null,
      reasoningEffort: null,
      allowTools: DEFAULT_TOOLS.planner,
    },
    implementer: {
      provider: null,
      model: null,
      reasoningEffort: null,
      allowTools: DEFAULT_TOOLS.implementer,
    },
    reviewer: {
      provider: null,
      model: null,
      reasoningEffort: null,
      allowTools: DEFAULT_TOOLS.reviewer,
    },
    approver: {
      provider: null,
      model: null,
      reasoningEffort: null,
      allowTools: DEFAULT_TOOLS.approver,
    },
  },

  /** Every met condition must carry at least this confidence for a mechanical pass. */
  confidenceThreshold: 0.7,
  /** Whether a ticket may carry its own threshold (still bounded by [0,1]). */
  allowTicketThresholdOverride: true,

  /** Implement -> review cycles allowed before a ticket needs a human. */
  maxAttempts: 3,
  /**
   * Attempt -> rung mapping. The first entry is the role's configured route.
   * A later rung may name `provider`/`model` and `paid:true`; the engine only
   * uses it when the ticket allows paid spend and the budget covers the call.
   */
  escalationLadder: [{ rung: 0 }],

  /** Worker tick and timing intervals (milliseconds). */
  tickIntervalMs: 5000,
  /** A turn with no observable progress for this long is abandoned. */
  stallTimeoutMs: 600000,

  /** Tickets allowed to hold an active implement attempt at once. */
  wipCap: 4,
  /** Promote backlog tickets into `now` when WIP allows. */
  autoPromote: true,
  /** Maximum promotions per tick, so one tick cannot flood the queue. */
  autoPromotePerTick: 2,

  defaultBudgetUsd: 0,
  /** Artifacts older than this are pruned; spans/usage/events are never pruned. */
  retentionDays: 90,
  /** Directory holding prompt markdown. `null` resolves to the package's `prompts/`. */
  promptsDir: null,

  /** New-ticket defaults. */
  defaultPlanTiming: 'at_pickup',
  defaultPlanQuestions: 'interactive',
};

const TOP_LEVEL_KEYS = new Set(Object.keys(DEFAULT_CONFIG));
const ROLE_KEYS = new Set(['provider', 'model', 'reasoningEffort', 'allowTools']);
const PROVIDER_KEYS = new Set([
  'name',
  'tier',
  'priceIn',
  'priceOut',
  'priceCacheRead',
  'priceCacheWrite',
]);
const LADDER_KEYS = new Set(['rung', 'provider', 'model', 'reasoningEffort', 'paid']);

export class ConfigError extends Error {
  constructor(message, path) {
    super(path === undefined ? message : `${path}: ${message}`);
    this.name = 'ConfigError';
    this.code = 'KANBAN_CONFIG_INVALID';
    this.path = path;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

function optionalString(value, path, errors, { nullable = true } = {}) {
  if (value === undefined) return;
  if (value === null) {
    if (!nullable) errors.push(new ConfigError('must be a string', path));
    return;
  }
  if (!isNonEmptyString(value)) errors.push(new ConfigError('must be a non-empty string or null', path));
}

function positiveNumber(value, path, errors) {
  if (!isFiniteNumber(value) || value <= 0) errors.push(new ConfigError('must be a positive number', path));
}

/** Deep-clone plain JSON (config is JSON/YAML; no functions, no dates). */
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = clone(v);
    return out;
  }
  return value;
}

function merge(target, source) {
  if (!isObject(source)) return target;
  for (const [key, value] of Object.entries(source)) {
    if (isObject(value) && isObject(target[key])) merge(target[key], value);
    else target[key] = clone(value);
  }
  return target;
}

function validateProviders(providers, errors, warnings) {
  if (!Array.isArray(providers)) {
    errors.push(new ConfigError('providers must be an array', 'providers'));
    return;
  }
  const seen = new Set();
  providers.forEach((provider, index) => {
    const at = `providers[${index}]`;
    if (!isObject(provider)) {
      errors.push(new ConfigError('must be an object', at));
      return;
    }
    for (const key of Object.keys(provider)) {
      if (!PROVIDER_KEYS.has(key)) errors.push(new ConfigError(`unknown key "${key}"`, at));
    }
    if (!isNonEmptyString(provider.name)) errors.push(new ConfigError('name must be a non-empty string', at));
    else if (seen.has(provider.name)) errors.push(new ConfigError(`duplicate provider "${provider.name}"`, at));
    else seen.add(provider.name);
    if (provider.tier !== undefined && provider.tier !== 'local' && provider.tier !== 'paid') {
      errors.push(new ConfigError('tier must be "local" or "paid"', `${at}.tier`));
    }
    for (const key of ['priceIn', 'priceOut', 'priceCacheRead', 'priceCacheWrite']) {
      if (provider[key] === undefined || provider[key] === null) continue;
      if (!isFiniteNumber(provider[key]) || provider[key] < 0) {
        errors.push(new ConfigError('must be a non-negative number per million tokens', `${at}.${key}`));
      }
    }
  });
}

function validateRoles(roles, errors) {
  if (!isObject(roles)) {
    errors.push(new ConfigError('roles must be an object', 'roles'));
    return;
  }
  for (const role of ROLES) {
    const entry = roles[role];
    const at = `roles.${role}`;
    if (entry === undefined) {
      errors.push(new ConfigError(`missing role entry (expected ${ROLES.join(', ')})`, at));
      continue;
    }
    if (!isObject(entry)) {
      errors.push(new ConfigError('must be an object', at));
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!ROLE_KEYS.has(key)) errors.push(new ConfigError(`unknown key "${key}"`, at));
    }
    optionalString(entry.provider, `${at}.provider`, errors);
    optionalString(entry.model, `${at}.model`, errors);
    optionalString(entry.reasoningEffort, `${at}.reasoningEffort`, errors);
    if (!Array.isArray(entry.allowTools) || entry.allowTools.some((name) => !isNonEmptyString(name))) {
      errors.push(new ConfigError('allowTools must be an array of tool names', `${at}.allowTools`));
    }
  }
}

function validateLadder(ladder, errors) {
  if (!Array.isArray(ladder) || ladder.length === 0) {
    errors.push(new ConfigError('escalationLadder must be a non-empty array', 'escalationLadder'));
    return;
  }
  ladder.forEach((entry, index) => {
    const at = `escalationLadder[${index}]`;
    if (!isObject(entry)) {
      errors.push(new ConfigError('must be an object', at));
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!LADDER_KEYS.has(key)) errors.push(new ConfigError(`unknown key "${key}"`, at));
    }
    if (entry.rung !== index) errors.push(new ConfigError(`rung must equal its index (${index})`, `${at}.rung`));
    optionalString(entry.provider, `${at}.provider`, errors);
    optionalString(entry.model, `${at}.model`, errors);
    optionalString(entry.reasoningEffort, `${at}.reasoningEffort`, errors);
    if (entry.paid !== undefined && typeof entry.paid !== 'boolean') {
      errors.push(new ConfigError('paid must be a boolean', `${at}.paid`));
    }
  });
}

/**
 * Merge deployment config over the defaults and validate it strictly.
 *
 * Unknown keys produce a warning (matching the deployment's other plugins) so
 * an old row does not take the profile down. Anything that would make the
 * engine run degraded — a wrong type, a zero slot count, a negative price, a
 * malformed ladder — throws {@link ConfigError}.
 *
 * @param {unknown} input raw `config:` object from the profile patch.
 * @returns {{config: object, warnings: string[]}}
 */
export function resolveConfig(input = {}) {
  if (input === null || input === undefined) input = {};
  if (!isObject(input)) throw new ConfigError('config must be an object');
  const warnings = [];
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) warnings.push(`unknown config key "${key}" (ignored)`);
  }

  const config = merge(clone(DEFAULT_CONFIG), input);
  const errors = [];

  optionalString(config.dbPath, 'dbPath', errors);
  optionalString(config.defaultWorkspaceCwd, 'defaultWorkspaceCwd', errors);
  validateProviders(config.providers, errors, warnings);
  validateRoles(config.roles, errors);
  validateLadder(config.escalationLadder, errors);

  if (!isFiniteNumber(config.confidenceThreshold) || config.confidenceThreshold < 0 || config.confidenceThreshold > 1) {
    errors.push(new ConfigError('must be a number in [0,1]', 'confidenceThreshold'));
  }
  if (typeof config.allowTicketThresholdOverride !== 'boolean') {
    errors.push(new ConfigError('must be a boolean', 'allowTicketThresholdOverride'));
  }
  if (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1) {
    errors.push(new ConfigError('must be an integer >= 1', 'maxAttempts'));
  }
  positiveNumber(config.tickIntervalMs, 'tickIntervalMs', errors);

  positiveNumber(config.stallTimeoutMs, 'stallTimeoutMs', errors);
  if (!Number.isInteger(config.wipCap) || config.wipCap < 1) {
    errors.push(new ConfigError('must be an integer >= 1', 'wipCap'));
  }
  if (typeof config.autoPromote !== 'boolean') errors.push(new ConfigError('must be a boolean', 'autoPromote'));
  if (!Number.isInteger(config.autoPromotePerTick) || config.autoPromotePerTick < 1) {
    errors.push(new ConfigError('must be an integer >= 1', 'autoPromotePerTick'));
  }
  if (!isFiniteNumber(config.defaultBudgetUsd) || config.defaultBudgetUsd < 0) {
    errors.push(new ConfigError('must be a number >= 0', 'defaultBudgetUsd'));
  }
  if (!Number.isInteger(config.retentionDays) || config.retentionDays < 1) {
    errors.push(new ConfigError('must be an integer >= 1', 'retentionDays'));
  }
  optionalString(config.promptsDir, 'promptsDir', errors);
  if (!['now', 'at_pickup'].includes(config.defaultPlanTiming)) {
    errors.push(new ConfigError('must be now or at_pickup', 'defaultPlanTiming'));
  }
  if (!['interactive', 'autonomous'].includes(config.defaultPlanQuestions)) {
    errors.push(new ConfigError('must be interactive or autonomous', 'defaultPlanQuestions'));
  }

  if (errors.length > 0) {
    const joined = errors.map((e) => e.message).join('; ');
    throw new ConfigError(`invalid config: ${joined}`);
  }
  return { config, warnings };
}

/** The provider entry for a route, or a conservative unknown-provider answer. */
export function providerPolicy(config, provider) {
  const found = config.providers.find((p) => p.name === provider);
  if (found !== undefined) {
    return {
      name: provider,
      tier: found.tier ?? (found.priceIn > 0 || found.priceOut > 0 ? 'paid' : 'local'),
      priceIn: found.priceIn ?? null,
      priceOut: found.priceOut ?? null,
      priceCacheRead: found.priceCacheRead ?? null,
      priceCacheWrite: found.priceCacheWrite ?? null,
      known: true,
    };
  }
  // Hard constraint: an unknown provider is admitted one turn at a time and
  // treated as unpriced, never as free.
  return {
    name: provider,
    tier: 'local',
    priceIn: null,
    priceOut: null,
    priceCacheRead: null,
    priceCacheWrite: null,
    known: false,
  };
}

/**
 * Resolve the route for one implement attempt.
 * Attempts 1..n use rung 0 until the ladder says otherwise; a ladder rung may
 * override provider/model/reasoningEffort and may require paid spend.
 */
export function routeForAttempt(config, role, attempt) {
  const base = config.roles[role];
  const ladder = config.escalationLadder;
  // Attempt 1 and 2 stay on rung 0; attempt 3 takes rung 1, and so on.
  const index = Math.min(Math.floor(Math.max(0, attempt - 1) / 2), ladder.length - 1);
  const step = ladder[Math.min(index, ladder.length - 1)] ?? { rung: 0 };
  return {
    rung: step.rung,
    provider: step.provider ?? base.provider,
    model: step.model ?? base.model,
    reasoningEffort: step.reasoningEffort ?? base.reasoningEffort ?? null,
    requiresPaid: step.paid === true || step.provider !== undefined,
  };
}

/** Canonical JSON with sorted keys, for config/prompt hashing. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
