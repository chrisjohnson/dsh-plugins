# Releasing a plugin

Everything here exists because a published version is permanent: it is what someone's
`dsh plugin add` pulls forever, and what their deployment rolls back to.

## Before you release

1. CI is green on `main` for the commit you are about to tag. Never tag a commit CI
   has not passed.
2. `npm run check` locally (verify + hooks gate + tests).
3. `node scripts/compose-smoke.mjs` — the package installs and imports in a real
   profile built from the publishable file list, not the working tree.
4. `npm pack --pack-destination /tmp -w <pkg>` then `tar -tzf` the tarball: read the
   list. Is every runtime file in it? Is any test, script, or local note in it that
   should not be? (`verify.mjs` checks the first half of this; only a human notices
   the second.)
5. The package's `README.md` and `CHANGELOG.md` describe the version you are about to
   publish — `verify.mjs` fails if the changelog does not mention the version string,
   and the README is what a plugin market shows.

## Version and tag

Semantic versioning, per package, from the user's point of view:

- **major** — an install or a configuration breaks: a renamed config key, a tool
  removed, a `dsh.client` slot that no longer exists.
- **minor** — new behaviour with the old behaviour intact; a new optional key.
- **patch** — a bug fix nobody has to configure anything for.

Tag as `<package>-v<version>` (`model-switch-v0.2.0`) so several packages can release
from this repository without colliding. One package per tag; a release commit touches
exactly one `package.json` and its changelog.

```sh
npm version <major|minor|patch> -w <pkg> --no-git-tag-version   # rewrites package.json
git add -A && git commit -m "release(model-switch): 0.2.0"
git tag model-switch-v0.2.0 && git push origin main --tags
```

## Publishing

Publish from CI, not a laptop: a GitHub Actions `npm publish` with OIDC gives the
package a **provenance** attestation, which the plugin catalogs and the Desktop market
surface, and it means no long-lived npm token exists on a developer machine.

```yaml
# .github/workflows/release.yml (sketch — enable once the npm scope/owners are set)
on:
  push:
    tags: ['*-v[0-9]*']
permissions:
  contents: read
  id-token: write          # required for provenance
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, registry-url: 'https://registry.npmjs.org' }
      - run: npm ci
      - run: npm test -w "$PKG"
      - run: npm publish --provenance --access public -w "$PKG"
        env: { NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}' }
```

Until that workflow is enabled, publishing is manual
(`npm publish --provenance --access public -w <pkg>` from a machine with an npm
account that owns the unscoped `dsh-*` names — see the note in
[authoring.md](./authoring.md) about unscoped names and ownership).

**Never `npm unpublish` a version people may have installed.** `npm deprecate` it with
a message that says what to use instead. Deprecation warns; unpublish breaks installs
and any lockfile that pinned it, including yours.

## Listing it

Once it is on npm, the plugin can appear in the community places. Each has different
mechanics, and two of them index *repositories*, so a monorepo package needs care:

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

The in-GUI market reads `engines.dsh`, so keeping that range honest is what stops a
plugin being offered to a harness it cannot run on.

## Consuming it from the deployment it came from

The other half of the loop — how `dsh-deploy` moves from an in-tree plugin to a
published version, how it tests a candidate against real sessions, and how it rolls
back — is documented in that repository:
`dsh-deploy/CONTRIBUTING.md` ("Plugins live here"). Short version: install an **exact
version**, test it in the lab, promote it to the profile, restart in a planned window,
and never commit a `link:`/`file:` dependency into a profile.
