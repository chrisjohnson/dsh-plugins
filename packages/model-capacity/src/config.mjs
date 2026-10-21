// dsh-model-capacity: configuration defaults and strict validation.
//
// Limits are per provider route, because a provider is the physical backend the
// deployment split its GPUs into. There is deliberately no per-model bucket:
// two model ids behind one provider route share the same backend and therefore
// the same slots.

export const DEFAULT_CONFIG = {
  /** When false the gate and the subagent guard are inert (useful for rollout). */
  enabled: true,
  /** Limit for a provider that has no explicit entry. */
  defaultMaxConcurrent: 1,
  /** `{provider, maxConcurrent}` entries. The most specific entry is the provider itself. */
  limits: [],
  /** Bound on queued calls per provider, so a runaway fan-out cannot grow memory without limit. */
  queueLimitPerProvider: 1000,
  /** A subagent reservation that never materialises is released after this long. */
  reservationTtlMs: 300000,
  /** Tools whose dispatch is preflighted against capacity and gets an immediate error. */
  subagentTools: ['subagent', 'subagent_fork', 'spawn_teammate'],
};

const TOP_LEVEL = new Set(Object.keys(DEFAULT_CONFIG));
const LIMIT_KEYS = new Set(['provider', 'maxConcurrent']);

export class ConfigError extends Error {
  constructor(message, path) {
    super(path === undefined ? message : `${path}: ${message}`);
    this.name = 'ConfigError';
    this.code = 'MODEL_CAPACITY_CONFIG_INVALID';
    this.path = path;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = clone(item);
    return out;
  }
  return value;
}

/**
 * Merge a deployment config over the defaults and validate it.
 * Unknown keys warn once; wrong types and impossible limits refuse the boot.
 */
export function resolveConfig(input = {}) {
  if (input === null || input === undefined) input = {};
  if (!isObject(input)) throw new ConfigError('config must be an object');
  const warnings = [];
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL.has(key)) warnings.push(`unknown config key "${key}" (ignored)`);
  }
  const config = { ...clone(DEFAULT_CONFIG), ...clone(input) };

  if (typeof config.enabled !== 'boolean') throw new ConfigError('must be a boolean', 'enabled');
  if (!Number.isInteger(config.defaultMaxConcurrent) || config.defaultMaxConcurrent < 1) {
    throw new ConfigError('must be an integer >= 1', 'defaultMaxConcurrent');
  }
  if (!Number.isInteger(config.queueLimitPerProvider) || config.queueLimitPerProvider < 1) {
    throw new ConfigError('must be an integer >= 1', 'queueLimitPerProvider');
  }
  if (!Number.isInteger(config.reservationTtlMs) || config.reservationTtlMs < 1000) {
    throw new ConfigError('must be an integer >= 1000', 'reservationTtlMs');
  }
  if (!Array.isArray(config.subagentTools) || config.subagentTools.some((name) => !isNonEmptyString(name))) {
    throw new ConfigError('must be an array of tool names', 'subagentTools');
  }
  if (!Array.isArray(config.limits)) throw new ConfigError('must be an array', 'limits');

  const seen = new Set();
  config.limits = config.limits.map((entry, index) => {
    const at = `limits[${index}]`;
    if (!isObject(entry)) throw new ConfigError('must be an object', at);
    for (const key of Object.keys(entry)) {
      if (!LIMIT_KEYS.has(key)) throw new ConfigError(`unknown key "${key}"`, at);
    }
    if (!isNonEmptyString(entry.provider)) throw new ConfigError('provider must be a non-empty string', at);
    if (seen.has(entry.provider)) throw new ConfigError(`duplicate provider "${entry.provider}"`, at);
    seen.add(entry.provider);
    if (!Number.isInteger(entry.maxConcurrent) || entry.maxConcurrent < 1) {
      throw new ConfigError('maxConcurrent must be an integer >= 1', `${at}.maxConcurrent`);
    }
    return { provider: entry.provider, maxConcurrent: entry.maxConcurrent };
  });

  return { config, warnings };
}

/** The limit for one provider route. */
export function limitFor(config, provider) {
  const entry = config.limits.find((limit) => limit.provider === provider);
  return entry === undefined ? config.defaultMaxConcurrent : entry.maxConcurrent;
}

/**
 * When false the whole mechanism is inert. This exists so the plugin can be
 * mounted and inspected before it is allowed to gate production traffic.
 */
export function isEnabled(config) {
  return config.enabled !== false;
}
