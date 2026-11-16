// dsh-take-a-number: configuration defaults and strict validation.
//
// The plugin maps dsh provider routes onto take-a-number queues. The daemon
// (one per machine) owns the queues; this plugin only decides which of its
// model calls go through which queue. A provider with no mapping passes
// through un-gated — same as an unmapped model on the daemon.

export const DEFAULT_CONFIG = {
  /** When false the gate is inert (useful for rollout). */
  enabled: true,
  /** UDS path of the take-a-number daemon. // verify-allow: no-deployment-leaks */
  sock: '/run/take-a-number/tan.sock',
  /** TCP fallback of the take-a-number daemon (loopback only). // verify-allow: no-deployment-leaks */
  tcp: '127.0.0.1:4100',
  /** `{provider, queue}` entries: which take-a-number queue a provider route uses. */
  queues: [],
  /**
   * Per-instance token stamped on every reservation so the admission proxy can
   * claim this instance's held lease for its matching HTTP request (the
   * compliant path). Must match the static `x-tan-client` header in this
   * instance's litellm provider config. Empty = no token (hard-queue only).
   */
  clientToken: '',
};

const TOP_LEVEL = new Set(Object.keys(DEFAULT_CONFIG));
const QUEUE_KEYS = new Set(['provider', 'queue']);

export class ConfigError extends Error {
  constructor(message, path) {
    super(path === undefined ? message : `${path}: ${message}`);
    this.name = 'ConfigError';
    this.code = 'TAKE_A_NUMBER_CONFIG_INVALID';
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
 * Unknown keys warn; wrong types and duplicate providers refuse the boot.
 * Environment overrides (TAN_SOCK, TAN_TCP) are applied before deployment
 * config so the deployment wins.
 */
export function resolveConfig(input = {}, env = process.env) {
  if (input === null || input === undefined) input = {};
  if (!isObject(input)) throw new ConfigError('config must be an object');
  const warnings = [];
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL.has(key)) warnings.push(`unknown config key "${key}" (ignored)`);
  }
  const config = { ...clone(DEFAULT_CONFIG), ...clone(input) };

  if (typeof config.enabled !== 'boolean') throw new ConfigError('must be a boolean', 'enabled');
  if (!isNonEmptyString(config.sock)) throw new ConfigError('must be a non-empty string', 'sock');
  if (!isNonEmptyString(config.tcp)) throw new ConfigError('must be a non-empty string', 'tcp');
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(config.tcp)) {
    throw new ConfigError('must be a loopback address (127.0.0.1[:port] or localhost[:port])', 'tcp');
  }
  if (!Array.isArray(config.queues)) throw new ConfigError('must be an array', 'queues');
  if (typeof config.clientToken !== 'string') throw new ConfigError('must be a string (empty = none)', 'clientToken');

  const seen = new Set();
  config.queues = config.queues.map((entry, index) => {
    const at = `queues[${index}]`;
    if (!isObject(entry)) throw new ConfigError('must be an object', at);
    for (const key of Object.keys(entry)) {
      if (!QUEUE_KEYS.has(key)) throw new ConfigError(`unknown key "${key}"`, at);
    }
    if (!isNonEmptyString(entry.provider)) throw new ConfigError('provider must be a non-empty string', at);
    if (!isNonEmptyString(entry.queue)) throw new ConfigError('queue must be a non-empty string', at);
    if (seen.has(entry.provider)) throw new ConfigError(`duplicate provider "${entry.provider}"`, at);
    seen.add(entry.provider);
    return { provider: entry.provider, queue: entry.queue };
  });

  // Environment overrides, then the deployment config (already merged in).
  if (isNonEmptyString(env.TAN_SOCK)) config.sock = env.TAN_SOCK;
  if (isNonEmptyString(env.TAN_TCP)) config.tcp = env.TAN_TCP;
  if (isNonEmptyString(env.TAN_CLIENT_TOKEN)) config.clientToken = env.TAN_CLIENT_TOKEN;

  return { config, warnings };
}

/** The take-a-number queue for one provider route, or null (pass-through). */
export function queueFor(config, provider) {
  const entry = config.queues.find((item) => item.provider === provider);
  return entry?.queue ?? null;
}

/**
 * When false the whole mechanism is inert. This exists so the plugin can be
 * mounted and inspected before it is allowed to gate production traffic.
 */
export function isEnabled(config) {
  return config.enabled !== false;
}

/**
 * This dsh instance's identity, for the daemon's per-process leases.
 * A lab instance (DSH_HOME under a `dsh-lab/<name>` root) reports as
 * `lab-<name>`; the production instance reports as `web`.
 */
export function deriveInstance(env = process.env) {
  const home = typeof env.DSH_HOME === 'string' ? env.DSH_HOME : '';
  const match = /\/dsh-lab\/([^/]+)\//.exec(home);
  if (match) return `lab-${match[1]}`;
  return 'web';
}
