# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the package follows
[semantic versioning](https://semver.org/).

## Unreleased

### Changed

- Requires dsh 0.2.0-rc.2 or later: `engines.dsh` and the `@deepseek-ai/dsh-tools`
  peer are now `>=0.2.0-rc.2 <0.3.0-0 || >=0.3.0-0`. dsh 0.2 checks bundle peer
  ranges at boot, so the range now states the line this is actually tested against.
- Installed from a git tag (`dsh-image-search-searxng-v<version>`), not the npm
  registry — see the README's Install section.

## 0.1.0

Initial public release, extracted from a running multi-session dsh deployment
where it has served `image_search` since 2026-09-23.

### Added

- `image_search` tool over a self-hosted SearXNG instance's `images` category.
- Configuration via `config.baseURL` / `$SEARXNG_BASE_URL`, `apiKey` /
  `$SEARXNG_API_KEY`, and `maxResults` / `$SEARXNG_NUM_RESULTS`, resolved
  config → environment → default.
- Boot-time validation of `baseURL` (an unusable value fails at startup, not at
  the first tool call).
- Unit tests for configuration resolution, request building, response mapping
  and result rendering.

### Changed from the pre-public version

- No code default was removed: the SearXNG base URL stays overridable by config
  and environment, but the plugin no longer reads a deployment's own compose
  file layout.
- Results without an `img_src` are now dropped consistently, and a malformed
  SearXNG payload yields "no results" instead of throwing.
