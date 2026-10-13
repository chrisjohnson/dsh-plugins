# dsh-image-search-searxng

**Give the agent image search against a SearXNG you already run — and give the user the pictures inline.**

A single model-facing `image_search` tool for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), pointed at the `images` category of your own [SearXNG](https://docs.searxng.org/) instance. No API key vendor, no third party in the request path, nothing leaves your network that you did not already let SearXNG reach.

```
You: find a wiring diagram for a NEMA 14-50 receptacle
Agent: [image_search] → 3 results, each a markdown image link
GUI:   renders them as real inline pictures
```

## Install

Installed from a git tag of this repository — it is not published to npm. Replace `<version>` with a released version (tags are named `dsh-image-search-searxng-v<version>`; see [the tag list](https://github.com/chrisjohnson/dsh-plugins/tags)):

```sh
dsh plugin --profile web add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-image-search-searxng-v<version>&path:/packages/image-search-searxng"
```

That installs the package into the profile and enables its bundle. If you manage the profile's `package.json` yourself, the pnpm equivalent is below — then also add `dsh-image-search-searxng` to the profile's `dsh.profile.bundles`, because `pnpm add` alone installs the plugin without enabling it:

```sh
pnpm add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-image-search-searxng-v<version>&path:/packages/image-search-searxng"
```

> **Warning:** never install this plugin by bare name from the npm registry. Nothing from this repository is published there, so whatever a bare `pnpm add dsh-image-search-searxng` resolves to — now or later — is not this plugin. (The sibling name `dsh-model-switch` is already taken on npm by an unrelated author.)

Restart dsh. The tool is then available to every agent preset — the bundle's
patch layer mounts the plugin at the profile level, so no per-preset
`agent.cordis.yml` editing is involved.

Zero configuration is required if your SearXNG answers on `http://localhost:8888`.

## Configuration

| Key | Environment | Default | What it does |
| --- | --- | --- | --- |
| `baseURL` | `SEARXNG_BASE_URL` | `http://localhost:8888` | Where your SearXNG lives. Trailing slashes are trimmed; a value that is not an `http(s)` URL is rejected at boot rather than failing at the first search. |
| `apiKey` | `SEARXNG_API_KEY` | — | Sent as `preference[api_key]`, for SearXNG instances with API support enabled. |
| `maxResults` | `SEARXNG_NUM_RESULTS` | `8` | Default result count the model gets if it does not ask. A per-call `maxResults` argument still wins, clamped to 1–30. |

Precedence is **config → environment → default**. To override in your profile
patch, add the keys to the row this plugin inserts:

```yaml
- id: image-search-searxng
  name: dsh-image-search-searxng
  config:
    baseURL: http://searxng.internal:8080
    maxResults: 5
```

One caveat worth knowing about patch layers generally: a patch **replaces a
row's entire `config` object**, it does not deep-merge. Restating `baseURL` in a
later layer drops `apiKey` unless you restate that too — which is why this
plugin ships its row with no `config` block at all and resolves defaults in code.

## What the model actually receives

Titles, source pages, resolutions, and one markdown image link per result:

```
1. **NEMA 14-50 wiring**
   ![NEMA 14-50 wiring](https://example.com/diagram.png)
   Source: https://example.com/receptacles
   Resolution: 1024x768
```

That link is not decoration. dsh's own `dsh-client-ui-primitives` renderer turns
`![alt](url)` into a real `<img>` for any `http(s)` URL — there is no domain
allowlist — and falls back to alt text only when the browser's own image request
fails (hotlink protection, dead link). So results appear as pictures whenever
the source host cooperates, with no code-level distinction between the two
cases. The tool description tells the model to copy the links verbatim precisely
because rewriting one into a plain `[text](url)` link removes the picture.

## Why a separate tool instead of extending `web_search`

Because the shared web seam has nowhere to put an image. `WebSearchRequest` and
`WebSearchSource` in `@deepseek-ai/dsh-web` carry no category and no image
fields, so adding them means patching multiple upstream packages that every
future dsh upgrade would then have to be re-verified against. A standalone tool
with its own schema costs one registration and stays working across upgrades.
This is the same shape `dsh-web-search-searxng` chose.

## What this plugin deliberately does not do

- **It does not show the model the images.** The model receives text: titles and
  URLs. It cannot describe, compare, or verify what is depicted, and the tool
  description says so in as many words, because "I looked at the diagram and it
  shows…" is otherwise a very tempting hallucination.
- **It does not fetch images through your model's attachment pipeline.** Real
  image *attachments* would route arbitrary third-party URLs through the
  vision/attachment path — a much larger blast radius than "the user can see
  search results" warrants.
- **It does not fall back to a hosted search API.** If SearXNG is unreachable the
  tool call fails with the HTTP status, rather than silently querying somebody
  else's service.

## Compatibility

Requires dsh 0.2.0-rc.2 or later. Declared in `package.json` under `engines.dsh`
and on the `@deepseek-ai/dsh-tools` peer as `>=0.2.0-rc.2 <0.3.0-0 || >=0.3.0-0`.
dsh checks the range itself, counting prereleases, so it accepts every harness build
from 0.2.0-rc.2 on; on a harness outside it `dsh plugin add` refuses the install, and a
profile that already has it skips the bundle with a log line. pnpm's own peer check is
narrower: it admits only `0.2.0-rc.*` and `0.3.0-*` prereleases (plus every stable
release from 0.2.0), so on other prereleases it reports a peer mismatch that dsh does
not.

## Development

The plugin is plain ESM with no build step.

```sh
node --test packages/image-search-searxng/test/*.test.mjs   # logic, no dsh needed
node scripts/verify.mjs --package dsh-image-search-searxng  # release contract
node scripts/compose-smoke.mjs image-search-searxng         # real dsh composition
```

`src/searxng.mjs` holds the logic and the tests; `src/index.mjs` is the Cordis
wiring. The split is not ceremony — it is what lets the tests run before
anything is installed. See [`../../docs/authoring.md`](../../docs/authoring.md).

## License

MIT
