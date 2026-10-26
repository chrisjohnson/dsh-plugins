# dsh-math-literal

Keeps single-`$` dollars literal in DeepSeek Harness web chat.

The web chat renders a message with two markdown grammars: while it streams,
a math-free grammar; once it settles, a grammar with single-`$` inline math
enabled. So prose like

> paired: from $55,011 outgoing rollover to $230 contributions

streams correctly, then — at settle — the two `$` are read as an inline-math
pair and everything between them is run through KaTeX:

> paired: from 55,011outgoingrolloverato230 contributions

For a coding harness, `$HOME`, `$DSH_*` and currency are far more common in
model prose than inline TeX, so that default is backwards. This plugin turns
every lone `$` into an escaped `\$` at render time, which both grammars render
as a literal dollar sign — so the settled view matches the streaming view,
and **real math keeps working**: `$$x^2$$`, `$$` blocks, `\(x^2\)`, `\[ … \]`
pass through untouched, and `$` inside code spans and code blocks stays
byte-for-byte verbatim.

## Install

```sh
dsh plugin --profile web add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-math-literal-v<version>&path:/packages/math-literal"
```

If you manage the profile's `package.json` yourself, the pnpm equivalent:

```sh
pnpm add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-math-literal-v<version>&path:/packages/math-literal"
```

…then add `dsh-math-literal` to the profile's `dsh.profile.bundles`.

> **Warning:** never install this plugin by bare name (`pnpm add
> dsh-math-literal`): an unscoped `dsh-*` name on the npm registry can belong
> to an unrelated author. Always use the git-tag spec above.

Restart dsh. There is nothing to configure.

## What it does, and how

- **Host half** (`src/host.mjs`): subscribes to the `webserver/index-inject`
  event (the same seam `dsh-client-shortcuts` uses) and pushes one head
  `<script>` into every index response. The script
  (`src/wrapper.mjs`, a reviewed, readable IIFE — not minified) intercepts
  `window.__ModuleLoader__.create` before the shell's boot kernel calls it and
  replaces the `@deepseek-ai/dsh-client-ui-primitives` entry of the static
  module table — the frozen namespace object every `MarkdownText` consumer
  reads from — with a plain copy whose `MarkdownText` runs `text` through
  `globalThis.__DSH_MATH_LITERAL_ESCAPE__` before rendering. Ordering-robust
  (the boot queue facade may or may not exist yet) and idempotent.
- **Client half** (`src/client.mjs`, `dsh.client.immediately: true` so it is
  prefetched in the shell's immediate boot tier): loads the package-local
  chunk `src/client.parser.js` and installs the escape function as that
  global. The escape (`src/escape.mjs`) fast-paths text without `$`;
  otherwise it parses with a commonmark-only `fromMarkdown` to locate every
  code region, then one pass: skip code, keep `$$` pairs, keep already
  escaped `\$`, escape every other `$`.
- The stored session log and the model's context are **untouched** — this is
  a render-time transform only.

| Input | After transform | Renders as |
| --- | --- | --- |
| `$55,011 … $230` | `\$55,011 … \$230` | literal — both arms agree |
| `$$x^2$$`, `$$` blocks, `\(x^2\)`, `\[ … \]` | unchanged | math (unchanged KaTeX path, copy-tex intact) |
| `\$` (already escaped) | unchanged | literal `$` |
| `$` in fenced / indented / inline code | unchanged | verbatim code |

## Configuration

None. Disabling the plugin means removing its row (or disabling it in
Settings); the page then boots exactly as it did before the plugin existed.
Nothing is left half-active.

## Failure modes

- **Frontend architecture drift.** The wrapper targets the seed-table words
  `@deepseek-ai/dsh-client-ui-primitives` and `react/jsx-runtime` and the
  `__ModuleLoader__.create` choke point. If a future shell changes any of
  them, the wrapper's feature detection simply does not fire (one
  `console.warn`, no crash) and the plugin degrades to the pre-plugin
  behavior — the page never fails to boot because of it.
- **Parser chunk fails to load** (network, route change): the escape global
  stays unset, the wrapper renders the original text. Same degradation, one
  `console.warn`.
- **The escape throws on some input**: caught per render; that render uses
  the original text.
- **Cost**: one extra markdown parse for each rendered message *containing*
  `$` (the common dollar-free case is a single `includes` check).

## The generated parser chunk

`src/client.parser.js` is a generated artifact (banner included): an IIFE
bundle of `mdast-util-from-markdown` plus `src/escape.mjs` embedded verbatim,
registered as a package-local client chunk. Rebuild it (from this package's
root, with the devDependencies installed) when bumping the parser:

```sh
npm install --no-save --no-package-lock
node scripts/build-parser.mjs
```

`test/chunk.test.mjs` pins the embedded escape source and the parser-version
banner, so a stale artifact fails the test suite instead of shipping.

## Upstream

The shipped frontend build hard-wires the math extension's
`singleDollarTextMath` option to `true` (the option works upstream; the
bundled vendor chunk drops it). An upstream fix — passing
`singleDollarTextMath: false`, or exposing it — would make this plugin
removable: drop the bundle row, and nothing else changes.
