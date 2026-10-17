# Changelog

All notable changes to `dsh-session-cost` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this package ships as git
tags, not npm versions.

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
