// dsh-image-tiler: configuration defaults and validation. Pure — imports
// nothing from dsh.
//
// The one piece of deployment knowledge is `caps`: a map from "provider/model"
// to the maximum pixels that route's vision backend accepts. It lives here
// (a plugin row) rather than on the model entry because the model-route schema
// strips unknown keys, and because the cap belongs to the physical backend,
// which the deployment knows and the plugin must not guess.
//
// Nothing here throws: a bad key falls back to its default with one warning,
// so a typo degrades behaviour loudly but never takes the profile down.

export const DEFAULT_CONFIG = Object.freeze({
  /** When false the pre-step listener passes every message through untouched. */
  enabled: true,
  /** Map of "provider/model" -> max pixels per image. Empty means inert. */
  caps: {},
  /** Fraction of a tile's extent shared with its neighbours, [0, 0.75). */
  overlapRatio: 0.12,
  /** Every tile stays at or under `cap * safetyFactor` pixels, (0, 1]. */
  safetyFactor: 0.95,
  /** Valve: give up (send the original) rather than emit more tiles than this. */
  maxTilesPerImage: 32,
  /** Forward this plugin's log lines to stderr (the service log captures it). */
  logToStderr: false,
});

const TOP_LEVEL = new Set(Object.keys(DEFAULT_CONFIG));

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Merge a deployment config over the defaults and validate it.
 * @param {unknown} input - the plugin row's `config` object (may be absent).
 * @returns {{ settings: object, warnings: string[] }}
 */
export function resolveConfig(input = {}) {
  const raw = isObject(input) ? input : {};
  const warnings = [];
  if (input !== undefined && input !== null && !isObject(input)) {
    warnings.push('config must be an object; using defaults');
  }
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL.has(key)) warnings.push(`unknown config key "${key}" (ignored)`);
  }

  const settings = { ...DEFAULT_CONFIG };

  settings.enabled = typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_CONFIG.enabled;
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    warnings.push(`enabled must be true or false (got ${JSON.stringify(raw.enabled)}); using ${settings.enabled}`);
  }

  settings.logToStderr = typeof raw.logToStderr === 'boolean' ? raw.logToStderr : DEFAULT_CONFIG.logToStderr;
  if (raw.logToStderr !== undefined && typeof raw.logToStderr !== 'boolean') {
    warnings.push(`logToStderr must be true or false (got ${JSON.stringify(raw.logToStderr)}); using ${settings.logToStderr}`);
  }

  settings.overlapRatio = numberInRange(raw.overlapRatio, DEFAULT_CONFIG.overlapRatio, { min: 0, max: 0.75, name: 'overlapRatio', warnings });
  settings.safetyFactor = numberInRange(raw.safetyFactor, DEFAULT_CONFIG.safetyFactor, { min: 0, minExclusive: true, max: 1, maxExclusive: false, name: 'safetyFactor', warnings });
  settings.maxTilesPerImage = positiveInteger(raw.maxTilesPerImage, DEFAULT_CONFIG.maxTilesPerImage, 256, 'maxTilesPerImage', warnings);

  settings.caps = {};
  if (raw.caps === undefined || raw.caps === null) {
    // Absent caps is the documented inert state; say so once via the host log.
  } else if (!isObject(raw.caps)) {
    warnings.push('caps must be an object mapping "provider/model" to a pixel budget; using {}');
  } else {
    for (const [key, value] of Object.entries(raw.caps)) {
      if (key.trim() === '') {
        warnings.push('caps: skipping an empty key');
        continue;
      }
      if (!Number.isInteger(value) || value < 1) {
        warnings.push(`caps["${key}"] must be a positive integer of pixels (got ${JSON.stringify(value)}); skipping it`);
        continue;
      }
      settings.caps[key] = value;
    }
  }

  return { settings, warnings };
}

function numberInRange(value, fallback, { min, max, name, warnings, minExclusive = false, maxExclusive = true }) {
  if (value === undefined) return fallback;
  const lowOk = value > min || (!minExclusive && value === min);
  const highOk = value < max || (!maxExclusive && value === max);
  const inRange = typeof value === 'number' && Number.isFinite(value) && lowOk && highOk;
  if (!inRange) {
    const span = `${minExclusive ? '(' : '['}${min}, ${max}${maxExclusive ? ')' : ']'}`;
    warnings.push(`${name} must be a number in ${span} (got ${JSON.stringify(value)}); using ${fallback}`);
    return fallback;
  }
  return value;
}

function positiveInteger(value, fallback, max, name, warnings) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    warnings.push(`${name} must be an integer in [1, ${max}] (got ${JSON.stringify(value)}); using ${fallback}`);
    return fallback;
  }
  return value;
}
