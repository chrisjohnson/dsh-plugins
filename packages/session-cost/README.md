# dsh-session-cost

**A compact estimated-cost badge in the composer stats bar — the `$` you'd otherwise have to open a panel to find.**

One small pill, drawn next to the core token/cache stats (`14.6M tok · Cache hit 97%`) in the composer bar, showing the session's estimated cost. It reads the session's own billed token buckets and prices them with public models.dev rates. It is **hidden while the session is at $0**, so the composer row is unchanged on idle sessions and the number appears the moment the session burns tokens.

It is deliberately not a cost dashboard. `litellm` and the `dsh-context` Context Insights page already give full per-turn breakdowns; this is just the always-visible total.

## How it works

- **Data source.** The badge reads the `contextTimeline` session projection's `cost` field — the per-turn *billed* token buckets that `dsh-context` folds on every assistant settlement:

  ```
  cost[provider][model][period] = { uncached, cacheRead, cacheWrite, output }
  period ∈ { "peak", "off" }
  ```

  Reading the same buckets `dsh-context` uses keeps the badge's token counts identical to the Context Insights page (no second token-counting pass).

- **Pricing.** Each bucket is priced with the models.dev per-million rate for that model, then summed. The formula mirrors `dsh-context`'s cost fold exactly, including the DeepSeek peak rule: for a DeepSeek provider the **peak** period (Beijing-time workday windows) bills at 2× the off-peak/list rate, all other periods at the list rate. The rate table lives in `src/prices.mjs` and ships the public `deepseek-flash` rates today; add a model by appending one row.

- **Where.** The entry is registered into the `conversation.composer.dock` slot (the same slot the core stats pill owns), placed after it. It renders a single `$`-formatted `span` and nothing else — no panel, no dialog, no settings.

## Install

Installed from a git tag of this repository — it is not published to npm. Replace `<version>` with a released version (tags are named `dsh-session-cost-v<version>`; see [the tag list](https://github.com/chrisjohnson/dsh-plugins/tags)):

```sh
dsh plugin --profile web add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-session-cost-v<version>&path:/packages/session-cost"
```

If you manage the profile's `package.json` yourself, the pnpm equivalent is below — then also add `dsh-session-cost` to the profile's `dsh.profile.bundles`, because `pnpm add` alone installs the plugin without enabling it:

```sh
pnpm add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-session-cost-v<version>&path:/packages/session-cost"
```

> **Warning:** never `pnpm add dsh-session-cost` (or `dsh plugin add dsh-session-cost`) by bare name. That resolves from the npm registry, where an unscoped `dsh-*` name may belong to an unrelated author and is **not** this plugin.

Restart dsh. With no configuration the badge is live.

## Configuration

There is none. The badge has no user-facing settings — it prices whatever models the session already used, from a public rate table. The bundle patch row carries an empty `config` on purpose.

## Notes and limits

- **It is an estimate.** Token counts are the provider-reported billed totals; only the dollars-per-token conversion is an estimate, from public models.dev list rates. It will not match a billing invoice to the cent, and it is not a spend-control.
- **DeepSeek peak pricing only applies when the provider is recognised as DeepSeek.** The peak×2 rule fires for the dsh provider ids `deepseek-official` and `deepseek-account` (the ones `dsh-context` maps to models.dev `deepseek`). A session routed through a deployment-owned proxy (for example a local LiteLLM gateway that forwards to DeepSeek) is **not** in that map, so it is priced at flat list rates with no peak/off split — the same thing `dsh-context` does for such a provider, so the two surfaces stay consistent. To apply the peak rule to a proxy, add its dsh provider id to `MODELS_DEV_PROVIDER_IDS` in `src/prices.mjs`.
- **Unknown models are hidden.** If a session used a model that is not in `MODEL_RATES`, the badge shows nothing rather than a guess. Add the model's models.dev rates to `src/prices.mjs` to price it.
- **Depends on `dsh-context` for the buckets.** The badge reads the `contextTimeline` projection that `dsh-context` maintains. If `dsh-context` is not enabled in the profile, the badge has no data and stays hidden. It does not otherwise touch or configure `dsh-context`.
- **Subagents are not summed.** The badge shows the cost of the session it is drawn for. Descendant subagent sessions have their own `contextTimeline`; summing the family is a separate concern the `dsh-context` fleet view already covers.

## Checks

- `node --test packages/session-cost/test/*.test.mjs` — unit tests for the price table, the cost fold, the peak/off rule, and the formatting.
- `node scripts/check-plugin-hooks.mjs` — the browser half is a single hook call over a stable fallback, so the Rules-of-Hooks gate passes.
- `node scripts/verify.mjs` — the release contract (install line, files allowlist, peer range, no deployment leakage).
