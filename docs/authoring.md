# Authoring notes

The mechanical parts of writing a dsh plugin that this repository's checks enforce.
For the rules and their reasons, see [AGENTS.md](../AGENTS.md); for how to test what
you wrote, [testing.md](./testing.md).

## The package is the feature

A plugin is a package (installed from a git tag, not the npm registry) that declares a
configuration layer:

```json
{
  "name": "dsh-my-plugin",
  "type": "module",
  "main": "./index.mjs",
  "exports": { ".": "./index.mjs", "./client": "./src/client.mjs", "./package.json": "./package.json" },
  "files": ["index.mjs", "src", "cordis.patch.yml", "README.md", "LICENSE", "CHANGELOG.md"],
  "keywords": ["dsh-plugin"],
  "engines": { "node": ">=20.9.0", "dsh": ">=0.2.0-rc.2 <0.3.0-0 || >=0.3.0-0" },
  "peerDependencies": { "@deepseek-ai/dsh-tools": ">=0.2.0-rc.2 <0.3.0-0 || >=0.3.0-0" },
  "repository": { "type": "git", "url": "git+https://github.com/<you>/<repo>.git", "directory": "packages/<name>" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web" } }
}
```

`dsh.client` only for plugins with a browser half; without it, drop the `./client`
export too (the host throws on the mismatch, in both directions).

**Unscoped `dsh-*` names, released as git tags.** The `name` is unscoped and is also
the tag prefix: `dsh-model-switch` releases as `dsh-model-switch-v<version>`, installed
with `git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-model-switch-v<version>&path:/packages/model-switch`.
Nothing here is published to npm, and the npm registry's unscoped names are first-come:
`dsh-model-switch` there is an unrelated author's package, not this plugin. So a README
in this repository never shows a bare-name install, and `verify.mjs` fails one that does.
Keep `repository` pointing at the source so catalogs can map the package back to it.

## The patch file

```yaml
- insert:
    - id: my-plugin
      name: dsh-my-plugin
```

That is the whole file, and it should stay that way. Two facts make the empty-`config`
rule worth internalising:

1. A patch layer **replaces a row's entire `config` object**; it does not deep-merge.
   Anything you put in the bundle's patch is a key every user must restate the moment
   they want to change a sibling key.
2. A profile-level `insert` row reaches **every preset**, not just the one you were
   editing while you built it.

Use the bundle patch for structure — mounting the plugin, adding a tool to a preset,
registering a slot. Never for values.

## Host half shape

```js
export default function myPlugin(ctx, config = {}) {
  const log = ctx.logger('my-plugin')
  const settings = resolveSettings(config)      // pure, tested, no dsh imports
  for (const warning of settings.warnings) log.warn(warning)

  ctx.inject(['tools'], (scope) => scope.effect(() => scope.tools.register(
    defineTool({ /* … */ }),
    'my-plugin',
  )))
}
```

Three things that cost real debugging time:

- **`ctx.tools` (and most service bags) is only available inside `ctx.inject`.**
  Touching it on the raw context throws `cannot get property "tools" of undefined`
  *while the profile is composing*, which reads like a config error and is not.
- **Register inside `scope.effect`.** Returning the effect's disposer is how a hot
  reload un-registers cleanly.
- **Throw early and loudly for a config you cannot use.** A plugin that boots broken
  and says nothing is worse than one that refuses to boot.

## Browser half shape

`src/client.mjs`, exporting `exports.name`, `exports.inject = […]` (client modules you
need: `connection`, `slots`, `clientUi`, …) and `exports.slots` for GUI insertion. Plain
ESM, React from the shared `dsh.client.react` externals — no bundling, no imports of
node modules, no `import` of your host half.

The Rules-of-Hooks trap, the symptom, and the fix are in
[AGENTS.md](../AGENTS.md#the-browser-half). There is no build step to catch it and the
error boundary hides it; the gate script is the only automated help.

## Naming and layout

- Package `dsh-<thing>`; plugin/row id `<thing>`; tool name `snake_case`.
- One plugin, one job. Two jobs means two plugins that can be installed separately.
- `src/index.mjs` (or `index.mjs`) is thin wiring; logic goes in sibling modules that
  import nothing from dsh so they can be tested.
- Prefix anything you write to disk with the plugin name, and honour
  `$DSH_HOME`/`HOME` rather than a literal home directory.

## Where the platform documentation lives

- `docs/user/develop/basic/publish.md` in `deepseek-ai/deepseek-harness` — bundles,
  profiles, `dsh plugin`, the patch layer order. (Fetch
  `raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/…`; the HTML
  rendering is noisy.)
- `awesome-dsh-plugin`'s contributing guide — the market/catalog entry format.
- `dsh-market`'s README — how the in-GUI list is built and filtered.

These move; the rules in [AGENTS.md](../AGENTS.md) are the parts that survived
contact with several versions of them.
