// dsh-image-search-searxng — plugin half.
//
// Registers one model-facing `image_search` tool against a self-hosted SearXNG
// instance's `images` category. All the logic lives in ./searxng.mjs and is
// tested there; this file is only the dsh wiring.
//
// Two things about that wiring are load-bearing and were each learned the
// expensive way:
//
//   1. `ctx.tools` is an injected Cordis SERVICE, not a base context method.
//      Touching it without `ctx.inject(['tools'], …)` throws
//      `cannot get property "tools" without inject` while the plugin is being
//      constructed, which takes the whole profile down with it. `ctx.logger` and
//      `ctx.effect` really are always present; services are not.
//
//   2. The tool reaches every agent preset automatically because the bundle's
//      `cordis.patch.yml` inserts the plugin row at the profile level — no
//      per-preset `agent.cordis.yml` editing is needed.
//
// Why a standalone tool rather than an extension of the shared `web_search`
// seam: `WebSearchRequest`/`WebSearchSource` in @deepseek-ai/dsh-web have no
// category or image fields at all, so extending them means patching several
// upstream packages that every future dsh upgrade would then have to be
// re-verified against. See README, "Why a separate tool".

import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  PLUGIN_NAME,
  capResults,
  buildSearchURL,
  formatResults,
  mapResults,
  outputSchema,
  resolveConfig,
  toolDescription,
  USER_AGENT,
} from './searxng.mjs';

export default function imageSearchSearxng(ctx, config = {}) {
  const log = ctx.logger(PLUGIN_NAME);
  let resolved;
  try {
    resolved = resolveConfig(config, process.env);
  } catch (error) {
    // Fail loudly and specifically at boot rather than at the first tool call.
    log.error(String(error instanceof Error ? error.message : error));
    throw error;
  }
  const { baseURL, apiKey, maxResults } = resolved;

  ctx.inject(['tools'], (scope) => {
    scope.effect(() =>
      scope.tools.register(
        defineTool({
          name: 'image_search',
          description: toolDescription(maxResults),
          parameters: {
            query: { type: 'string', required: true, description: 'The image search query.' },
            maxResults: { type: 'integer', description: `Maximum results to return, 1-30 (default ${maxResults}).` },
          },
          output: {
            schema: outputSchema,
            render(_args, value) {
              return [{ type: 'text', text: formatResults(value.results) }];
            },
          },
          isConcurrencySafe: () => true,
          async execute(args, exec) {
            const endpoint = buildSearchURL({ baseURL, query: args.query, apiKey });
            const capped = capResults(args.maxResults, maxResults);

            let response;
            try {
              response = await fetch(endpoint, {
                method: 'GET',
                redirect: 'error',
                headers: { accept: 'application/json', 'user-agent': USER_AGENT },
                signal: exec.signal,
              });
            } catch (error) {
              throw new Error(`SearXNG image search request failed: ${String(error)}`);
            }
            if (!response.ok) throw new Error(`SearXNG image search failed: HTTP ${response.status}`);

            const results = mapResults(await response.json(), capped);
            log.info('image_search %j -> %d results', args.query, results.length);
            return { results };
          },
        }),
      ),
      `${PLUGIN_NAME}: register image_search`,
    );
  });

  log.info('active (baseURL=%s, maxResults=%d, apiKey=%s)', baseURL, maxResults, apiKey ? 'set' : 'unset');
}
