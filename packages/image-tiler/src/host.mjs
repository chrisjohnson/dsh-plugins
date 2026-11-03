// dsh-image-tiler: host-plane Cordis plugin. Thin wiring only — the decision
// lives in handler.mjs (pure, tested), the math in grid.mjs, the pixels in
// tiler.mjs.
//
// One global `agent/pre-step` waterfall listener rewrites user messages whose
// attached images exceed the routed model's pixel cap (config.caps) into
// overlapping under-cap tiles before they are committed to the session log.
// Every route without a cap entry, and every image under its cap, passes
// through untouched.

import { format } from 'node:util';

import { resolveConfig } from './config.mjs';
import { createPreStepHandler } from './handler.mjs';
import { extractTilePngs, probeImage } from './tiler.mjs';

const PLUGIN_NAME = 'dsh-image-tiler';

export default function imageTiler(ctx, config = {}) {
  const log = ctx.logger(PLUGIN_NAME);
  const { settings, warnings } = resolveConfig(config);
  for (const warning of warnings) log.warn('%s', warning);

  // Plugin loggers are quiet by default; this opt-in exporter forwards only
  // this plugin's lines to stderr, which the service manager captures.
  if (settings.logToStderr) {
    ctx.logger.exporter({
      levels: { default: -1, [PLUGIN_NAME]: 3 },
      export: ({ ts, type, name, args }) => {
        process.stderr.write(`${new Date(ts).toISOString()} ${type.toUpperCase()} ${name} ${format(...args)}\n`);
      },
    });
  }

  // Resolved lazily: the attachment service is provided by the host profile,
  // and a profile without one must still boot — the handler then keeps every
  // over-cap image whole and says so in the note.
  const attachments = () => {
    try {
      const got = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined;
      if (got !== undefined && got !== null) return got;
      return ctx.attachments;
    } catch {
      return undefined;
    }
  };

  // The composer's model pick is durable as a `model/selection` event and
  // folded into the `modelSelection` projection's `pending` slot until a
  // request consumes it. Reading it is how the FIRST message of a session (no
  // minted header yet) and a mid-session switch route to the right cap.
  const pendingSelection = (agent) => {
    try {
      const registry = typeof ctx.get === 'function' ? ctx.get('sessionProjections') : undefined;
      const state = registry?.stateOf?.(agent?.session, 'modelSelection');
      return state?.pending ?? undefined;
    } catch {
      return undefined;
    }
  };

  // `policy: "ask"` rides the harness approval machinery: approve tiles, reject
  // sends whole; anything else (no answerer, cancelled, policy `never`, no
  // approval service) returns undefined and the handler applies askFallback.
  const remembered = new Map(); // agent id -> 'tile' | 'send-whole' (in-memory, per process)
  const ask = async (agent, question, signal) => {
    if (settings.rememberPerSession && agent?.id !== undefined && remembered.has(agent.id)) {
      return remembered.get(agent.id);
    }
    let approval;
    try {
      approval = (typeof ctx.get === 'function' ? ctx.get('approval') : undefined) ?? ctx.approval;
    } catch {
      approval = undefined;
    }
    if (typeof approval?.request !== 'function') return undefined;
    let outcome;
    try {
      outcome = await approval.request({ agent, toolName: 'image_tiling', reason: question, signal });
    } catch (error) {
      log.warn('approval request failed: %s', String(error?.message ?? error));
      return undefined;
    }
    const mode = outcome === 'allowed-once' ? 'tile' : outcome === 'rejected' ? 'send-whole' : undefined;
    if (mode !== undefined && settings.rememberPerSession && agent?.id !== undefined) {
      remembered.set(agent.id, mode);
    }
    return mode;
  };

  const handler = createPreStepHandler({
    config: settings,
    log,
    attachments,
    probe: probeImage,
    tile: extractTilePngs,
    ask,
    pendingSelection,
  });

  ctx.on('agent/pre-step', (payload, next) => handler(payload, next), { global: true });

  log.info(
    'active (enabled=%s, policy=%s, askFallback=%s, rememberPerSession=%s, overlapRatio=%s, safetyFactor=%s, maxTilesPerImage=%s, logToStderr=%s, caps=%s)',
    settings.enabled,
    settings.policy,
    settings.askFallback,
    settings.rememberPerSession,
    settings.overlapRatio,
    settings.safetyFactor,
    settings.maxTilesPerImage,
    settings.logToStderr,
    JSON.stringify(settings.caps),
  );
  if (Object.keys(settings.caps).length === 0) {
    log.info('no caps configured: every image passes through untouched (set caps to "provider/model": pixels to activate tiling)');
  }
}
