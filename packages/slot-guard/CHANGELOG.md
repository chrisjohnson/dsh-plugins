# Changelog

All notable changes to this plugin are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.1.0 - 2026-11-05

### Added

- Initial release. A browser-half-only diagnostic for the Web GUI's invisible
  failure mode: a plugin slot entry that throws during render is caught by the
  renderer's `SlotErrorBoundary`, which logs `slot entry crashed in '<slotKey>'`
  and renders an empty `<div data-slot-error>`, so the region goes invisibly
  blank — and when the crash escapes every boundary the whole React root
  unmounts and the page goes white with no trace.
- Three surfaces, no configuration: a read-only `console.error` wrapper plus
  `window` `error`/`unhandledrejection` listeners that decode minified React
  errors #300/#310/#311 into a timestamped plain-English line naming the slot key
  and the Rules-of-Hooks mistake to look for; injected CSS that styles the crash
  face into a visible red banner carrying the slot key and a reload hint, in light
  and dark; and a full-screen recovery overlay, painted only when a page that had
  rendered goes empty and stays empty, so a white page always says what happened
  and offers a reload. Crash state is readable at `window.__dshSlotGuard`.
- The browser half uses no React, so it cannot itself become the crash it reports.
