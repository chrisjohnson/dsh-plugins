# dsh-slot-guard

Makes a plugin's render crash impossible to miss in the DeepSeek Harness Web GUI.

## The problem it solves

A plugin's browser half mounts into the same React root as the core UI. When one
of those entries throws while rendering, the renderer's `SlotErrorBoundary`
catches it, logs

```
slot entry crashed in '<slotKey>': Error: Minified React error #311; visit https://react.dev/errors/311 for the full message
```

and renders `<div data-slot-error="<slotKey>"></div>` — an empty, zero-height
div. The region goes **invisibly blank**. If the crash escapes every boundary, the
whole root unmounts and the page is simply **white**, with nothing in the
foreground to say why and nothing that recovers short of a reload.

The usual cause is a hook-count change in a mounted entry: standard state arrives
as hook-valued props (`useInput`, `useSessions`, …), so a defensive
`useX ? useX(sel) : null`, a `typeof seat !== "function"` guard, a `try`/`catch`
around a seat, or an early return above a hook all change how many hooks the
component calls when a prop appears or disappears between two renders of the same
mounted component. React then fails with production error **#311** (**#310** when
a list grew, **#300** for an early return), and in a production build that number
is all you get unless you open devtools and follow a link.

## What it does

1. **Decodes.** It wraps `console.error` (read-only: the original call always
   runs first, with the original arguments, and the wrapper never swallows
   anything) and listens on `window` for `error` and `unhandledrejection`. A
   minified React error becomes a timestamped, plain-English line that names the
   slot key when the renderer supplied one:

   ```
   [dsh-slot-guard 2026-11-05T00:12:44.107Z] react-error: slot 'conversation.input.right' crashed with React #311 — a component changed how many React hooks it calls between two renders of the same mounted entry (slot boundary)
     look at the plugin that owns this slot: standard state arrives as hook-valued props (useInput, useSessions, ...), so `useX ? useX(...) : null`, a `typeof seat !== "function"` guard, a try/catch around a seat, or an early return above a hook all change the hook count when a prop appears or disappears. Call the seat over a stable module-scope fallback and branch on the result.
   ```

   Identical lines are logged once per 5 s, so a crash that repeats on every
   render cannot flood the console.

2. **Shows the crash face.** It injects CSS that turns `div[data-slot-error]` and
   `div[data-factory-error]` into a visible red banner carrying the slot key and
   a reload hint, in light and dark. A crashed region becomes a red box where the
   blank used to be, so you can see *which* part of the page died.

3. **Refuses the white page.** It watches the React root. Once the page has
   rendered and then goes empty and stays empty for 1.2 s, it paints a
   full-screen overlay — "The UI crashed — `<decoded reason>` — reload the page
   to recover" — with a Reload button. A page that was never healthy (a boot
   failure, a wrong URL, a stopped server) gets no overlay: that is not this
   crash, and a guard that cries wolf on every blank screen is worse than none.

Current crash state is readable from the console at any time as
`window.__dshSlotGuard` (`{ version, lastCrash, overlayShown }`).

## Install

```sh
dsh plugin --profile web add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-slot-guard-v0.1.1&path:/packages/slot-guard"
```

Then restart the service. Nothing takes effect until the browser half loads, and
a restart ends every session running in the harness.

## Configuration

None, by design. A diagnostic you have to configure is a diagnostic you do not
have when you need it. The bundle row carries no `config:`; the plugin resolves
its own defaults in code. To turn it off, disable or remove the bundle.

## Failure modes

- **The guard itself throws.** Every entry point is wrapped; a guard failure logs
  `[dsh-slot-guard] the guard itself failed; ignoring` and never propagates.
- **The browser half loads after the crash.** The renderer's crash face is a DOM
  node, so a 1 s backstop scan plus a `MutationObserver` still finds it and
  reports it, even when the original `console.error` line went by before this
  bundle ran.
- **Another plugin also wraps `console.error`.** Wrappers chain: whichever runs
  last calls the earlier one, and this wrapper always calls the original first,
  so no message is lost regardless of order.
- **A legitimate blank page.** The overlay requires the root to have been
  non-empty earlier in this page's life and to stay empty past the grace window.
  Client-side navigation never empties `#root`, so it does not trigger.

## Checks

- `node scripts/check-plugin-hooks.mjs packages/slot-guard` — clean: the browser
  half uses no React at all, so it cannot be the hook-order crash it reports.
- `node --test packages/slot-guard/test/*.test.mjs` — the decoder: React code
  extraction, slot-key extraction, the hook-order verdicts for #300/#310/#311,
  the headline text, and the non-React passthrough.
- Lab: inject `<div data-slot-error="x">` into a live page and the banner renders
  with the key; empty `#root` and the overlay appears with a reload button; a
  healthy page shows neither and adds no console noise.
