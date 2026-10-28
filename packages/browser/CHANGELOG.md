# Changelog

[Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
[semantic versioning](https://semver.org/).

## Unreleased

## 0.1.0

### Added

- First release. Routes `dsh-playwright-browser@0.1.3`'s `browser_*` tools to one browser context per DSH session on a single shared Browserless connection (`connectUrl`), reconnecting after the connection is lost, closing a session's context when the session ends, and falling back to a local Chromium (`fallbackExecutablePath`) with a notice in every affected tool result when Browserless is unreachable.
