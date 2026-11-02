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

  const handler = createPreStepHandler({
    config: settings,
    log,
    attachments,
    probe: probeImage,
    tile: extractTilePngs,
  });

  ctx.on('agent/pre-step', (payload, next) => handler(payload, next), { global: true });

  log.info(
    'active (enabled=%s, overlapRatio=%s, safetyFactor=%s, maxTilesPerImage=%s, logToStderr=%s, caps=%s)',
    settings.enabled,
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
