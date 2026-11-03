// dsh-image-tiler: the `agent/pre-step` rewrite decision. Pure — imports only
// ./grid.mjs; the host injects the attachments service and the pixel ops, so
// every branch here is testable without dsh, sharp, or a network.
//
// Contract: the waterfall listener calls `next()` first, then rewrites the
// ENTERED message list. A message is rewritten only when it is a user message
// carrying at least one image block whose stored pixels exceed the routed
// model's cap. The rewrite replaces each such block with the tile image
// blocks plus one note text block; everything else passes through by
// identity. Any failure — no cap, no attachment store, unreadable bytes,
// animated raster, encoder or storage error, the tile valve — keeps the
// original block and appends a note explaining what the model is about to
// see. The handler never throws into the loop and never rejects a step.

import { needsTiling, planGrid } from './grid.mjs';

/**
 * The "provider/model" key for the route this agent's NEXT request will use.
 * Resolution order (0.2.0):
 *   1. the durable pending model selection — a composer pick not yet consumed
 *      by any request (this is what a mid-session switch, or the very first
 *      message of a session, actually routes to);
 *   2. the last minted request header (what the next step continues from);
 *   3. the agent's own creation options.
 * 1-before-2 matters: after a switch the header still names the OLD model
 * until the new one mints (the same staleness dsh-compaction-basic documents).
 *
 * @param {object} agent - the live agent.
 * @param {(agent: object) => {provider?: string, model?: string} | undefined} [pendingSelection]
 *   host-injected reader for the session's pending model selection.
 */
export function routeKeyFor(agent, pendingSelection) {
  let sel;
  try {
    sel = pendingSelection?.(agent);
  } catch {
    sel = undefined;
  }
  if (typeof sel?.provider === 'string' && typeof sel?.model === 'string' && sel.provider !== '' && sel.model !== '') {
    return `${sel.provider}/${sel.model}`;
  }
  let config;
  try {
    config = agent?.session?.requestHeader?.()?.config;
  } catch {
    config = undefined;
  }
  if (typeof config?.provider !== 'string' || typeof config?.model !== 'string' || config.provider === '' || config.model === '') {
    config = { provider: agent?.options?.provider, model: agent?.options?.model };
  }
  if (typeof config.provider !== 'string' || typeof config.model !== 'string') return undefined;
  if (config.provider === '' || config.model === '') return undefined;
  return `${config.provider}/${config.model}`;
}

/** The pixel cap for one agent, or undefined when its route has none. */
export function capForAgent(agent, config, pendingSelection) {
  const key = routeKeyFor(agent, pendingSelection);
  if (key === undefined) return undefined;
  const cap = config.caps[key];
  return Number.isInteger(cap) && cap > 0 ? cap : undefined;
}

function isTileableImageBlock(block) {
  return block?.type === 'image' && block.offloaded !== true && block.attachment != null;
}

function messageHasTileable(message) {
  return message?.role === 'user' && Array.isArray(message?.content) && message.content.some(isTileableImageBlock);
}

/**
 * Resolve the `ask` policy for one over-cap image through the host-injected
 * asker. Any absence or blow-up falls back to `config.askFallback` — the turn
 * must proceed even when no human can answer.
 * @returns {Promise<'tile' | 'send-whole'>}
 */
async function resolveAsk(agent, signal, config, log, ask, whole, plan, cap) {
  if (typeof ask !== 'function') return config.askFallback;
  const question = `${whole} exceeds this model's ${cap}-pixel cap. `
    + `Approve to tile it into ${plan.tiles} overlapping tiles (${plan.rows}x${plan.cols} grid, full detail); `
    + `reject to send it whole — the vision backend will likely downscale it.`;
  try {
    const answer = await ask(agent, question, signal);
    if (answer === 'tile' || answer === 'send-whole') return answer;
    log.info('no human answer for %s; using askFallback=%s', whole, config.askFallback);
  } catch (error) {
    log.warn('ask failed for %s: %s; using askFallback=%s', whole, String(error?.message ?? error), config.askFallback);
  }
  return config.askFallback;
}

/**
 * Decide one over-cap image block.
 * @returns {Promise<null | { blocks?: object[], note?: string }>}
 *   `null` keeps the block untouched; `blocks` replaces it (tile image
 *   blocks); `note` is always appended after whatever stays.
 */
async function decideBlock(block, { agent, signal, cap, config, log, attachments, probe, tile, ask, pendingSelection }) {
  const ref = block.attachment;
  const width = ref?.width;
  const height = ref?.height;
  if (!needsTiling({ width, height, cap })) return null;

  const whole = `Image ${width}x${height}`;

  const plan = planGrid({
    width,
    height,
    cap,
    overlapRatio: config.overlapRatio,
    safetyFactor: config.safetyFactor,
    maxTiles: config.maxTilesPerImage,
  });
  if (plan === null) {
    log.info('valve: %s (%d px) exceeds the %d-pixel cap and cannot be split into at most %d tiles; sent whole', whole, width * height, cap, config.maxTilesPerImage);
    return { note: `${whole} (${width * height} px) exceeds this model's ${cap}-pixel cap and cannot be split into at most ${config.maxTilesPerImage} tiles; sent whole.` };
  }

  let mode = config.policy;
  if (mode === 'ask') mode = await resolveAsk(agent, signal, config, log, ask, whole, plan, cap);
  if (mode === 'send-whole') {
    log.info('%s exceeds the %d-pixel cap; sent whole per policy (backend will likely downscale)', whole, cap);
    return { note: `${whole} exceeds this model's ${cap}-pixel cap; sent whole — the vision backend will likely downscale it.` };
  }

  const store = attachments();
  if (store === undefined || store === null || typeof store.readImage !== 'function' || typeof store.saveImages !== 'function') {
    log.warn('no attachments service: %s is over the %d-pixel cap but cannot be tiled; sent whole', whole, cap);
    return { note: `${whole} exceeds this model's ${cap}-pixel cap, but no attachment store is available to tile it; sent whole.` };
  }

  let stored;
  try {
    stored = await store.readImage(ref);
  } catch (error) {
    log.warn('read failed for %s: %s; sent whole', whole, String(error?.message ?? error));
    return { note: `${whole} exceeds this model's ${cap}-pixel cap but its bytes could not be read for tiling; sent whole.` };
  }

  let meta;
  try {
    meta = await probe(stored.data);
  } catch (error) {
    log.warn('probe failed for %s: %s; sent whole', whole, String(error?.message ?? error));
    return { note: `${whole} exceeds this model's ${cap}-pixel cap but could not be decoded for tiling; sent whole.` };
  }
  if (meta?.animated === true) {
    log.info('%s is animated; not tiled; sent whole', whole);
    return { note: `${whole} exceeds this model's ${cap}-pixel cap but is animated and cannot be tiled; sent whole.` };
  }

  let pngs;
  try {
    pngs = await tile(stored.data, plan.rects);
  } catch (error) {
    log.warn('tiling failed for %s: %s; sent whole', whole, String(error?.message ?? error));
    return { note: `${whole} exceeds this model's ${cap}-pixel cap but tiling failed; sent whole.` };
  }

  let refs;
  try {
    refs = await store.saveImages(pngs.map((data, index) => ({
      data,
      mediaType: 'image/png',
      name: `tile-${index + 1}-of-${pngs.length}.png`,
    })));
  } catch (error) {
    log.warn('saving tiles failed for %s: %s; sent whole', whole, String(error?.message ?? error));
    return { note: `${whole} exceeds this model's ${cap}-pixel cap but its tiles could not be stored; sent whole.` };
  }

  const blocks = refs.map((tileRef) => Object.freeze({ type: 'image', attachment: tileRef }));
  log.info('%s split into %d overlapping tiles (%dx%d grid), each <= %d px (cap %d)', whole, blocks.length, plan.rows, plan.cols, plan.effectiveCap, cap);
  return {
    blocks,
    note: `${whole} split into ${blocks.length} overlapping tiles (${plan.rows}x${plan.cols} grid); together they cover the full image — read all tiles.`,
  };
}

/**
 * Build the `agent/pre-step` listener body.
 * @param {object} deps
 * @param {object} deps.config - resolved settings (see config.mjs).
 * @param {object} deps.log - logger with info/warn/error.
 * @param {() => object|undefined} deps.attachments - lazy attachment store.
 * @param {(data: Uint8Array) => Promise<{animated: boolean}>} deps.probe
 * @param {(data: Uint8Array, rects: object[]) => Promise<Uint8Array[]>} deps.tile
 * @param {(agent: object, question: string, signal: AbortSignal) => Promise<'tile'|'send-whole'|undefined>} [deps.ask]
 *   host asker for `policy: "ask"`; any non-answer falls back to askFallback.
 * @param {(agent: object) => {provider, model}|undefined} [deps.pendingSelection]
 *   reader for the session's pending (not yet consumed) model selection.
 * @returns {(payload: object, next: () => Promise<object>) => Promise<object>}
 */
export function createPreStepHandler({ config, log, attachments, probe, tile, ask, pendingSelection }) {
  return async function preStep(payload, next) {
    const decision = await next();
    if (!config.enabled || decision?.kind !== 'enter' || !Array.isArray(decision.messages)) {
      return decision;
    }
    const cap = capForAgent(payload?.agent, config, pendingSelection);
    if (cap === undefined) return decision;

    try {
      let changed = false;
      const messages = [];
      for (const message of decision.messages) {
        if (!messageHasTileable(message)) {
          messages.push(message);
          continue;
        }
        const content = [];
        let messageChanged = false;
        for (const block of message.content) {
          if (!isTileableImageBlock(block)) {
            content.push(block);
            continue;
          }
          const result = await decideBlock(block, {
            agent: payload?.agent,
            signal: payload?.signal,
            cap,
            config,
            log,
            attachments,
            probe,
            tile,
            ask,
            pendingSelection,
          });
          if (result === null) {
            content.push(block);
            continue;
          }
          messageChanged = true;
          if (result.blocks !== undefined) content.push(...result.blocks);
          else content.push(block);
          content.push({ type: 'text', text: result.note });
        }
        if (messageChanged) {
          changed = true;
          messages.push(Object.freeze({ ...message, content: Object.freeze(content) }));
        } else {
          messages.push(message);
        }
      }
      if (!changed) return decision;
      return { ...decision, messages };
    } catch (error) {
      // Fail open: a broken rewrite must never cost the user their turn.
      log.error('pre-step tiling failed; step entered unchanged: %s', String(error?.stack ?? error?.message ?? error));
      return decision;
    }
  };
}
