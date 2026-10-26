# Changelog

All notable changes to this plugin are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.1.0 - 2026-10-26

### Added

- Initial release. A head-script wrapper (injected on every index response
  via the `webserver/index-inject` seam) replaces the frozen
  `@deepseek-ai/dsh-client-ui-primitives` seed entry's `MarkdownText` with a
  render-time escape of lone `$` signs, so settled markdown no longer reads
  `$55,011 … $230` as an inline-math pair. Real math (`$$…$$`, `\(…\)`,
  `\[ … \]`) and all code regions are untouched; the stored log and the
  model's context are. No configuration; degrades to the pre-plugin
  behavior on any miss.
