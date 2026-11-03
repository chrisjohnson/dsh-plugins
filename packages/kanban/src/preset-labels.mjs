// dsh-kanban: human-readable names for the shipped agent presets.
//
// The harness renders its four built-in presets with locale-owned product
// names, not with their registry ids: see `BUILT_IN_PRESET_KEYS` and the `en`
// bundle of @deepseek-ai/dsh-client-ui-agent-preset (`presetStandardName`,
// `presetPtcName`, `presetMinimalName`, `presetCordisName` → "Standard mode",
// "PTC mode", "Minimal mode", "Creator mode"). A shipped preset publishes no
// `name` of its own, so anything that shows `row.name ?? row.id` — the kanban
// picker and the ticket Details panel did — prints the bare ids where the
// harness says those four words. This module is the kanban copy of that wording.
//
// Pure on purpose: no @deepseek-ai/* import, so the Host half can use it and a
// plain `node --test` file can pin it. The browser half cannot import this file
// (src/client.mjs is a classic script), so it mirrors the same four pairs
// inline; test/preset-labels.test.mjs fails if the two copies drift.

/** The shipped preset ids and the names the harness gives them. */
export const BUILT_IN_PRESET_NAMES = {
  standard: 'Standard mode',
  ptc: 'PTC mode',
  minimal: 'Minimal mode',
  cordis: 'Creator mode',
};

/**
 * The name to show for one preset roster row.
 *
 * A shipped id always reads as the harness name. Anything else keeps the copy
 * its own declaration published, and falls back to the raw id when it published
 * none. Ids themselves never change: this is display copy only, and what a
 * ticket stores and what the wire carries stays the registry id.
 *
 * @param id - the preset's registry id.
 * @param publishedName - the `name` the preset declaration published, if any.
 * @returns the label to render.
 */
export function presetDisplayName(id, publishedName) {
  const key = id === null || id === undefined ? '' : String(id);
  if (Object.prototype.hasOwnProperty.call(BUILT_IN_PRESET_NAMES, key)) {
    return BUILT_IN_PRESET_NAMES[key];
  }
  if (publishedName === undefined || publishedName === null || publishedName === '') {
    return key;
  }
  return String(publishedName);
}
