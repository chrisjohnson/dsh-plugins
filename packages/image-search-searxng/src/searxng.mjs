// Pure SearXNG plumbing: configuration resolution, request building, response
// mapping and result rendering. No I/O, no dsh imports, no ambient state — this
// is the half of the plugin that can be tested in isolation (test/searxng.test.mjs).
//
// The plugin half (./index.mjs) is the only place that talks to a running dsh.

export const PLUGIN_NAME = 'image-search-searxng';

// SearXNG's own upstream default is 8080; 8888 is what the compose setups most
// people copy (including the one dsh-web-search-searxng documents) settle on.
// Overridable three ways — see the Configuration table in README.md.
export const DEFAULT_BASE_URL = 'http://localhost:8888'; // verify-allow: no-deployment-leaks
export const DEFAULT_MAX_RESULTS = 8;
export const MAX_RESULTS_CEILING = 30;
export const USER_AGENT = 'dsh-image-search-searxng/0.1.0';

/**
 * Resolve effective configuration.
 *
 * Order is explicit config (the profile patch's `config:` block), then the
 * environment, then the documented default. Config wins because it is the
 * per-profile answer; the environment is the per-machine one.
 *
 * @param {Record<string, unknown>} config
 * @param {Record<string, string | undefined>} env
 */
export function resolveConfig(config = {}, env = process.env) {
  const baseURL = pickUrl(config.baseURL) ?? pickUrl(env.SEARXNG_BASE_URL) ?? DEFAULT_BASE_URL;
  const apiKey = pickString(config.apiKey) ?? pickString(env.SEARXNG_API_KEY);
  const maxResults = pickPositiveInt(config.maxResults) ?? pickPositiveInt(env.SEARXNG_NUM_RESULTS) ?? DEFAULT_MAX_RESULTS;
  return { baseURL: baseURL.replace(/\/+$/, ''), apiKey, maxResults };
}

function pickString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function pickUrl(value) {
  const raw = pickString(value);
  if (raw === undefined) return undefined;
  // A typo here would otherwise surface as an opaque fetch failure at the first
  // tool call, so reject it at boot where the log is being read.
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`protocol must be http: or https:, got ${url.protocol}`);
    return url.toString();
  } catch (error) {
    throw new Error(`${PLUGIN_NAME}: invalid baseURL ${JSON.stringify(raw)} (${error instanceof Error ? error.message : String(error)})`);
  }
}

function pickPositiveInt(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
}

/** Clamp a caller-supplied count into the range the tool advertises. */
export function capResults(requested, fallback) {
  const n = typeof requested === 'number' && Number.isFinite(requested) ? Math.trunc(requested) : fallback;
  return Math.max(1, Math.min(MAX_RESULTS_CEILING, n));
}

/**
 * Build the SearXNG search request URL.
 *
 * `categories=images` is the whole reason this plugin exists: the shared
 * `web_search` seam has no category concept (see README, "Why a separate tool").
 */
export function buildSearchURL({ baseURL, query, apiKey }) {
  const endpoint = new URL('/search', baseURL);
  endpoint.searchParams.set('q', query);
  endpoint.searchParams.set('categories', 'images');
  endpoint.searchParams.set('format', 'json');
  if (apiKey !== undefined && apiKey.length > 0) endpoint.searchParams.set('preference[api_key]', apiKey);
  return endpoint;
}

/**
 * Map a SearXNG JSON payload onto the tool's output schema.
 *
 * Results without an `img_src` are dropped rather than surfaced as text-only
 * rows: the contract of this tool is "an image the user can see".
 */
export function mapResults(payload, cap) {
  const rows = Array.isArray(payload?.results) ? payload.results : [];
  return rows
    .filter((row) => typeof row?.img_src === 'string' && row.img_src.length > 0)
    .slice(0, cap)
    .map((row) => ({
      ...(typeof row.title === 'string' && row.title.length > 0 ? { title: row.title } : {}),
      imgSrc: row.img_src,
      sourceUrl: typeof row.url === 'string' && row.url.length > 0 ? row.url : row.img_src,
      ...(typeof row.resolution === 'string' && row.resolution.length > 0 ? { resolution: row.resolution } : {}),
    }));
}

/**
 * Render results for the model.
 *
 * Markdown image links, deliberately, not attachments: the model gets titles
 * and URLs as text, and dsh-client-ui-primitives renders `![alt](url)` as a real
 * inline <img> whenever the source host serves it, falling back to alt text on
 * its own via a per-image onError. That is why the instruction in the tool
 * description is to copy these VERBATIM — rewriting one into a plain link
 * removes the picture.
 */
export function formatResults(results) {
  if (!Array.isArray(results) || results.length === 0) return 'No image results found.';
  return results
    .map((row, i) => {
      const title = row.title ?? `Image ${i + 1}`;
      const lines = [`${i + 1}. **${title}**`, `   ![${title}](${row.imgSrc})`, `   Source: ${row.sourceUrl}`];
      if (row.resolution) lines.push(`   Resolution: ${row.resolution}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

/** The tool description, built from resolved config so the numbers are true. */
export function toolDescription(defaultMaxResults) {
  return 'Search the web for images via a self-hosted SearXNG instance. Returns '
    + 'titles, source pages, and a markdown image link (`![title](url)`) per '
    + 'result. Copy those markdown image links VERBATIM into your reply - '
    + 'this chat UI renders them as real inline pictures when the source '
    + 'host allows it (most do), falling back to plain alt text '
    + 'automatically otherwise; do not rewrite them as plain `[text](url)` '
    + 'links yourself. You do not receive image pixels or a visual '
    + 'attachment yourself - you cannot describe, compare, or analyze what '
    + 'is actually depicted. Cite results only by title, source, and '
    + 'resolution; never claim to see the image content itself. '
    + `Default result count is ${defaultMaxResults}; ask for up to ${MAX_RESULTS_CEILING}.`;
}

/** The tool's output schema (also used to assert the shape in tests). */
export const outputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    results: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          imgSrc: { type: 'string', required: true },
          sourceUrl: { type: 'string', required: true },
          resolution: { type: 'string' },
        },
      },
    },
  },
};
