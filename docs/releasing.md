# Releasing a plugin

**Releases are git tags. Nothing from this repository is published to the npm
registry.** A release is a `<package>-v<version>` tag on `main`, and consumers install
that tag plus the package's subdirectory:

```sh
dsh plugin --profile web add "git+https://github.com/chrisjohnson/dsh-plugins.git#<package>-v<version>&path:/packages/<dir>"
```

The flow, end to end:

1. A change merges to `main` through a pull request, after CI passes.
2. A release commit on `main` bumps one package's version and changelog.
3. That commit is tagged `<package>-v<version>` and the tag is pushed.
4. Consumers pin the tag.

Everything below exists because a pushed tag is permanent: it is what someone's install
spec points at forever, and what their deployment rolls back to.

> **Never point anyone at a bare package name.** `pnpm add dsh-model-switch` resolves
> from the npm registry, where the package of that name belongs to an unrelated author
> and is not this plugin. Any unscoped `dsh-*` name can end up like that. Install
> instructions here always use the git-tag spec.

## Before you release

1. CI is green on `main` for the commit you are about to tag. Never tag a commit CI
   has not passed.
2. `npm run check` locally (verify + hooks gate + tests).
3. `node scripts/compose-smoke.mjs` — the package installs and imports in a real
   profile, with the harness checking its peer ranges.
4. `npm pack --pack-destination /tmp -w <pkg>` then `tar -tzf` the tarball: read the
   list. A git install honours the same `files` allowlist, so this is exactly what a
   consumer gets. Is every runtime file in it? Is any test, script, or local note in it
   that should not be? (`verify.mjs` checks the first half of this; only a human
   notices the second.)
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
release from this repository without colliding. One package per tag; a release commit
touches exactly one `package.json` and its changelog.

```sh
npm version <major|minor|patch> -w <pkg> --no-git-tag-version   # rewrites package.json
git add packages/<dir>/package.json packages/<dir>/CHANGELOG.md
git commit -m "release(dsh-model-switch): 0.2.0"
# after that commit is on main and CI is green there:
git tag dsh-model-switch-v0.2.0 <release-commit> && git push origin dsh-model-switch-v0.2.0
```

Never move, delete or re-push a tag that has been pushed. If a release is bad, cut a
new version and say in its changelog what to use instead; anything that pinned the old
tag keeps resolving it.

## Why not npm

`verify.mjs` still calls itself the "publish contract", and it still checks the things
an npm tarball would need (`files`, `exports`, `repository.directory`, a LICENSE).
Those checks are kept on purpose: a git install reads the same `package.json` and the
same `files` allowlist and `exports` as a tarball would. But tags are the release
channel: there is no `npm publish` step, workflow or token anywhere in the release
flow.

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
