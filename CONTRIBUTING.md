# Contributing

Bugs and ideas: [open an issue](https://github.com/chrisjohnson/dsh-plugins/issues).
Pull requests: yes, please — and read [AGENTS.md](./AGENTS.md) first if an agent is
doing the work, because most of its rules are about not breaking someone's harness.

## The short version

```sh
git checkout -b <branch>
npm run check                      # verify + hooks gate + tests, nothing to install
node scripts/compose-smoke.mjs     # if you touched packaging or a patch file
git commit                         # changelog entry in the same commit
git push -u origin <branch>        # then open a pull request
```

One package per pull request where you can. A change that spans two packages should
say why in the description.

Pull requests merge into `main` once CI has passed and they have been reviewed. That is
the process, not a GitHub rule — `main` has no branch protection.

## Releases

Releases are git tags, never npm. After a pull request merges, a release commit on
`main` bumps one package's version and changelog, and that commit is tagged
`<package>-v<version>` (e.g. `dsh-model-switch-v0.2.0`). Consumers pin the tag:

```sh
dsh plugin --profile web add "git+https://github.com/chrisjohnson/dsh-plugins.git#<package>-v<version>&path:/packages/<dir>"
```

Do not suggest a bare-name install (`pnpm add dsh-model-switch`) anywhere: that
resolves from the npm registry, where `dsh-model-switch` is an unrelated author's
package. Details in [docs/releasing.md](./docs/releasing.md).

## What makes a plugin acceptable here

- **It works with zero configuration, or it says exactly what to configure.** Optional
  features report themselves unavailable at startup; nothing throws because a key was
  absent.
- **It carries no deployment's answers.** No author-local paths, provider ids, model
  ids, hosts or ports as defaults. `scripts/verify.mjs` enforces this, and the way to
  satisfy it is to make the thing configurable — not to add an allow-comment.
- **Its decisions are testable.** Branch-heavy logic lives in a module that imports
  nothing from dsh, with tests. `npm test` on a bare clone must pass.
- **Its README is the contract.** Every config key, what it does, what happens when it
  is unset, how the failure modes present. If docs and behaviour disagree, the docs are
  the bug and the tests are the evidence.
- **It installs with one command.** A `dsh.bundle.patch` so `dsh plugin add <git-tag
  spec>` activates it, no hand-edited config, no "and then also…".

## What we will not merge

- A generated or bundled client when a plain ESM one would do. This repository has no
  build step on purpose; it is what makes "clone it, run the tests, read the source you
  are about to load into your harness" true.
- A dependency on another plugin in this repository. Optional integrations are detected
  at runtime and degrade to a no-op with a log line.
- A default that only makes sense on the author's machine.
- Version-string hacks (`entry-r7.mjs`) that work around Node's module cache. Ship a
  version.
- Anything that reads state belonging to another plugin's private files.

## Adding yourself

New plugin? The checklist is in
[AGENTS.md](./AGENTS.md#adding-a-plugin); the deeper notes are in
[docs/authoring.md](./docs/authoring.md).

## License

By contributing you agree your contribution is licensed under the
[MIT license](./LICENSE) of this repository.
