# Releasing a plugin

**Releases are git tags. Nothing from this repository is published to the npm
registry.** Consumers install a `<package>-v<version>` tag plus the package's
subdirectory:

```sh
dsh plugin --profile web add "git+https://github.com/chrisjohnson/dsh-plugins.git#<package>-v<version>&path:/packages/<dir>"
```

The flow, end to end:

1. A release is a normal pull request that bumps one package's version and moves its
   CHANGELOG `Unreleased` entry under that version.
2. After it merges, the tag `<package>-v<version>` is cut on that merge commit and
   pushed. Nothing is committed directly to `main`.
3. Consumers pin the tag.

Everything below exists because a pushed tag is permanent: it is what someone's install
spec points at forever, and what their deployment rolls back to.

> **Never point anyone at a bare package name.** `pnpm add dsh-model-switch` resolves
> from the npm registry, where the package of that name belongs to an unrelated author
> and is not this plugin. Any unscoped `dsh-*` name can end up like that. Install
> instructions here always use the git-tag spec.

## Before you open the release pull request

1. Everything going into the release has already merged to `main` through its own
   pull request, with its CHANGELOG entry under `Unreleased`.
2. `npm run check` locally (verify + hooks gate + tests).
3. `node scripts/compose-smoke.mjs` — the package installs and imports in a real
   profile, with the harness checking its peer ranges.
4. `npm pack --dry-run`, run inside `packages/<dir>`, and read the file list.
   Nothing is published; this is just the quickest way to see what the `files`
   allowlist selects, which is exactly what a git-tag install ships. Is every
   runtime file in it? Is any test, script, or local note in it that should not
   be? (`verify.mjs` checks the first half of this; only a human notices the
   second.) Run it from the package directory: the root `package.json` has no
   npm `workspaces` field, so `-w` fails with "No workspaces found".
5. The package's `README.md` and `CHANGELOG.md` describe the version you are about to
   tag — `verify.mjs` fails if the changelog does not mention the version string, and
   the README is what a plugin market shows.

## Version and tag

Semantic versioning, per package, from the user's point of view:

- **major** — an install or a configuration breaks: a renamed config key, a tool
  removed, a `dsh.client` slot that no longer exists.
- **minor** — new behaviour with the old behaviour intact; a new optional key.
- **patch** — a bug fix nobody has to configure anything for.

Tag as `<package name>-v<version>` (`dsh-model-switch-v0.2.0`) so several packages can
release from this repository without colliding. One package per release pull request
and per tag: the pull request touches exactly one `package.json` and its changelog.

```sh
# on a branch, then open a pull request like any other change:
(cd packages/<dir> && npm version <major|minor|patch> --no-git-tag-version)   # rewrites package.json
# move the CHANGELOG "Unreleased" entry under a "## <version>" heading, then:
git add packages/<dir>/package.json packages/<dir>/CHANGELOG.md
git commit -m "release(dsh-model-switch): 0.2.0"

# after the pull request merges, tag its merge commit (CI green there):
git fetch origin
git tag dsh-model-switch-v0.2.0 "$(gh pr view <number> --json mergeCommit --jq .mergeCommit.oid)"
git push origin dsh-model-switch-v0.2.0
```

Never move, delete or re-push a tag that has been pushed. If a release is bad, cut a
new version and say in its changelog what to use instead; anything that pinned the old
tag keeps resolving it.

## Why not npm

Tags are the release channel: there is no `npm publish` step, workflow or token
anywhere in the release flow. `verify.mjs` (the release contract) still checks
packaging — `files`, `exports`, `repository.directory`, a LICENSE in the package
directory — because a git-tag install reads the package's own `package.json` and ships
only what its `files` allowlist selects.

## Listing it

Once a version is tagged, the plugin can appear in the community places. Each has
different mechanics, and two of them index *repositories*, so a monorepo package needs
care:

- **awesome-dsh-plugin** (feeds the in-GUI market and dshmarket.com) accepts monorepo
  subpackages: one YAML file per entry under `data/plugins/`, named
  `<owner>__<repo>--packages-<dir>.yml`, `name: <owner>/<repo>#<dir>`, `url` pointing at
  the subdirectory. Up to three entries per pull request, the repository must be at
  least a day old and carry the `dsh-plugin` topic. A package that ships only a
  `dsh.client` with no host half is rejected; a pure aggregate meta-package is not
  listed. Optional `tarball:` should point at a GitHub Release asset.
- **dshfind.com** and **dsh-plugin.org** index GitHub repositories by topic — one entry
  per repository, so they describe the collection, not the individual package. Put
  `dsh-plugin` on the repository and make the repository README's index do the work.

Check how each one installs what it lists: anything that offers a bare-name install
would resolve from npm, not from here.

The in-GUI market reads `engines.dsh`, so keeping that range honest is what stops a
plugin being offered to a harness it cannot run on.

## Consuming it from the deployment it came from

The other half of the loop — how `dsh-deploy` moves from an in-tree plugin to a
released version, how it tests a candidate against real sessions, and how it rolls
back — is documented in that repository:
`dsh-deploy/CONTRIBUTING.md` ("Plugins live here"). Short version: pin an **exact
tag**, test it in the lab, promote it to the profile, restart in a planned window,
and never commit a `link:`/`file:` dependency into a profile.
