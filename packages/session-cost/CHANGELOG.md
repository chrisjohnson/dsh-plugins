# Changelog

All notable changes to `dsh-session-cost` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this package ships as git
tags, not npm versions.

## [0.3.0]

### Added
- **Agent Network total, not just the current session.** The badge now sums the
  billed cost of the session *and every descendant subagent session* — the same
  figure the `dsh-context` Context tab shows as "Agent Network" (current agent +
  all subagents, every level of the subtree). On a subagent-less session this is
  just the session's own cost, so existing sessions are unchanged.
- **Interactive pill that opens the Context tab.** The badge is now a real button
  with the core StatsPills hover (interactive background + secondary label) and
  pointer cursor. Clicking it switches the session to the **Context** tab, where
  the full Agent Network breakdown (per-model rates, current agent vs. subagents)
  lives.

### Changed
- The composer number now reflects the whole agent family. A session whose current
  agent is cheap but whose subagents did real work now shows the family total
  (e.g. `$0.74` = `$0.29` current + `$0.45` across 14 subagents) instead of only
  the current agent's `$0.29`.

## [0.2.0]

### Changed
- **Price from the live models.dev catalog, not a bundled table.** The badge now
  fetches `https://models.dev/api.json` (the same source `dsh-context` reads) and
  resolves each session model the same way `dsh-context` does — mapped provider,
  then the `deepseek-` prefix, then the model-name index — so it covers every model
  the Context Insights page prices and shows the same number, instead of only the
  two `deepseek-flash` models the 0.1.0 table shipped. A tiny inline catalog is the
  offline fallback for the common DeepSeek case.
- **Match the core StatsPills look.** The badge now renders in the same tertiary
  label color, inherited font, and tabular numerals as the core stats pills, and it
  lands in the row right after the token/cache pill instead of a foreign element.

### Fixed
- A session using any model outside the 0.1.0 two-model table showed no cost even
  though `dsh-context` priced it. Now covered for the whole catalog.
- The badge's number now matches the Context page exactly: it uses `dsh-context`'s
  cost format (two significant figures under $1, e.g. `$0.0021`) and shows a
  sub-cent cost instead of hiding it. A truly `$0` / unpriced session still hides.

## [0.1.0]

### Added
- `dsh-session-cost`: a compact estimated-cost badge in the composer stats bar. It
  reads the session's `contextTimeline.cost` billed-token buckets and prices them
  with the models.dev per-million rates for the model in use, mirroring
  `dsh-context`'s cost fold (including the DeepSeek peak×2 rule). Hidden at $0.
- `src/prices.mjs` — the pure, unit-tested rate table + cost formula.
- `src/client.mjs` — the UMD browser half that draws the badge into
  `conversation.composer.dock`.
- `test/prices.test.mjs` — unit tests for rates, the cost fold, peak/off, and
  formatting.
