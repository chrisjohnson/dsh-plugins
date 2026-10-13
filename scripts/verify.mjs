#!/usr/bin/env node
// The repository's release contract.
//
// Nothing from this repository goes to the npm registry: a release is a
// `<package>-v<version>` git tag cut on the merge commit of a release PR, and
// consumers install that tag plus `&path:/packages/<dir>`. A git install reads
// the package's own package.json and ships exactly its `files` allowlist, so
// the packaging checks below are about what that install receives (see
// docs/releasing.md).
//
// WHY THIS EXISTS
// ---------------
// A DSH plugin has a lot of ways to be *almost* right. `dsh.client` without
// `dsh.bundle` is installable-looking but inert. A peer range that reads
// generously and silently excludes every prerelease build of the harness. A
// `dsh.client` declaration whose package forgets to export `./client`, which
// makes the host throw at boot. A patch row still pointing at a relative path
// from the author's own machine. A plugin carrying its author's deployment
// details. None of these are caught by a type checker (there is none, on
// purpose: plain ESM, no build), and every one of them is a bad first
// experience for someone who installed the plugin from the marketplace.
//
// So they are caught here instead, in one dependency-free pass that runs on a
// `git clone` with nothing installed.
//
// WHAT THIS IS NOT
// ----------------
// YAML parsing. The bundle patch is validated by the thing that actually has to
// read it: `scripts/compose-smoke.mjs` boots a real dsh composition with the
// package installed and asserts the layer landed. This script only checks the
// structural facts it can establish without a YAML parser.
//
// Usage: node scripts/verify.mjs [--verbose] [--package dsh-model-switch]

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedSpec, findBareInstall, hasTagInstall } from './lib/install-lines.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PACKAGES = join(ROOT, 'packages');

const ERROR = 'error';
const WARN = 'warn';

// Deployment-coupled strings that must never ship inside a plugin: they are the
// signature of a plugin that works on one machine and is broken everywhere.
const LEAK_PATTERNS = [
  { pattern: /\/home\/[a-z0-9_.-]+/i, label: 'an author-local /home/ path', level: ERROR },
  { pattern: /\/Users\/[a-z0-9_.-]+/i, label: 'an author-local /Users/ path', level: ERROR },
  { pattern: /\blocal-ai-machine\b/, label: 'a deployment-specific provider id', level: ERROR },
  { pattern: /\b(?!127\.0\.0\.1|0\.0\.0\.0)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}\b/, label: 'a hard-coded host:port', level: ERROR },
  { pattern: /\bsk-[A-Za-z0-9]{16,}\b/, label: 'what looks like an API key', level: ERROR },
  { pattern: /ghp_[A-Za-z0-9]{20,}/, label: 'what looks like a GitHub token', level: ERROR },
  { pattern: /localhost:\d{2,5}/, label: 'a localhost default (fine if it is documented config)', level: WARN },
];

// `entry-r7.mjs`-style files are a dev-time cache-busting trick for a specific
// deployment (Node caches ES modules by URL). They must never be released:
// they pin nothing and confuse everything.
const RELOAD_SHIM = /-r\d+\.m?js$/;

const results = [];
function add(pkg, level, rule, detail) {
  results.push({ pkg, level, rule, detail });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Files we hold to the rules: shipped sources, never docs or tests prose. */
function sourceFiles(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        // Docs and tests legitimately mention host paths and provider ids.
        if (entry.name === 'docs' || entry.name === 'test' || entry.name === 'screenshots') continue;
        walk(full);
        continue;
      }
      if (/\.(m?js|c?js|json|yml|yaml)$/.test(entry.name) && entry.name !== 'package.json') found.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return found;
}

/**
 * The one range every `@deepseek-ai/dsh*` peer (and `engines.dsh`) declares.
 *
 * Which prereleases it admits depends on who evaluates it:
 *
 * - dsh itself (install and boot) checks with `includePrerelease: true`, so
 *   every 0.2.x build from 0.2.0-rc.2 on is in, as is every 0.3.0+ build,
 *   prerelease or not.
 * - node-semver's default, which is what pnpm/npm use to resolve peers, only
 *   lets a prerelease through when a comparator carries a prerelease tag on the
 *   same major.minor.patch tuple. So here the range admits 0.2.0-rc.2 and
 *   later 0.2.0 prereleases, 0.3.0-* prereleases, and every stable release
 *   from 0.2.0 on - but not, say, 0.2.1-rc.1 or 0.4.0-rc.1. pnpm reports
 *   those as peer mismatches even though dsh's own check accepts them.
 *
 * dsh skips (or refuses to install) a bundle whose range misses the runtime,
 * so drift between packages is a plugin that stops loading on one harness
 * version. Change it here, then in every package.json, in one commit.
 */
const DSH_PEER_RANGE = '>=0.2.0-rc.2 <0.3.0-0 || >=0.3.0-0';

function isHarnessPackage(dep) {
  return dep === '@deepseek-ai/dsh' || dep.startsWith('@deepseek-ai/dsh-');
}

/**
 * Does a semver range admit the harness's prerelease builds?
 *
 * node-semver only lets a prerelease satisfy a range when some comparator in
 * that range carries a prerelease tag on the *same* major.minor.patch tuple. A
 * range like `>=0.0.1-rc.1 <0.2.0` therefore excludes `0.1.5-rc.2` even though
 * it looks enormous, and the user finds out with an ERESOLVE at install time.
 * The fix is an explicit branch that puts a prerelease tag on the tuple.
 */
function admitsPrereleases(range) {
  if (range === '*' || range === 'latest' || range === '') return true;
  return range.split('||').some((clause) => /-\d*[A-Za-z][0-9A-Za-z.-]*|-\d+(?=[\s<>)|]|$)/.test(clause.trim()));
}

function verifyPackage(dir, manifest, rootReadme) {
  const name = manifest.name ?? '(unnamed)';
  const at = (rule, detail, level = ERROR) => add(name, level, rule, detail);
  const dsh = manifest.dsh ?? {};
  const bundle = dsh.bundle;
  const client = dsh.client;

  // ---- installability -----------------------------------------------------
  if (!bundle?.patch) {
    at('bundle-manifest', 'no dsh.bundle.patch: the catalog rejects this and `dsh plugin add` installs it as an inert dependency');
  } else {
    const patches = Array.isArray(bundle.patch) ? bundle.patch : [bundle.patch];
    for (const patch of patches) {
      const patchPath = join(dir, patch);
      if (!existsSync(patchPath)) at('bundle-manifest', `dsh.bundle.patch points at ${patch}, which does not exist`);
      if (!patch.startsWith('./') && !patch.startsWith('/')) {
        at('bundle-manifest', `dsh.bundle.patch should be relative with an explicit './' prefix (got ${patch})`, WARN);
      }
      if (existsSync(patchPath)) verifyPatch(name, patchPath, at);
    }
  }

  // ---- the browser half ---------------------------------------------------
  if (client) {
    if (typeof client.platform !== 'string') at('client-platform', 'dsh.client.platform must be a string ("web")');
    const clientEntry = manifest.exports?.['./client'];
    if (!clientEntry) {
      at('client-exports', 'dsh.client is declared but exports["./client"] is missing - the host throws: "declares dsh.client but exports no ./client bundle"');
    } else if (!existsSync(join(dir, clientEntry.replace(/^\.\//, '')))) {
      at('client-exports', `exports["./client"] points at ${clientEntry}, which does not exist`);
    }
  }

  // ---- package hygiene ----------------------------------------------------
  if (manifest.private) at('not-private', 'private: true marks a package as not for release; every package here is released');
  if (!manifest.license) at('license', 'no license field');
  else if (manifest.license !== 'MIT') at('license', `license is ${manifest.license}; this repo is MIT throughout unless deliberately changed`);
  if (!existsSync(join(dir, 'LICENSE'))) at('license-file', 'no LICENSE file in the package directory - a git-tag install ships only this directory, so the repository root LICENSE never reaches the user');
  if (!manifest.repository) at('repository', 'no repository field');
  else if (manifest.repository.directory === undefined) {
    at('repository-directory', 'repository.directory is unset - an installed copy (and the marketplace) cannot map this package back to its subdirectory, which is also the &path: in its install spec');
  }
  if (!manifest.description || manifest.description.length < 40) {
    at('description', 'description is missing or too short to be useful on a marketplace card', WARN);
  }
  const keywords = Array.isArray(manifest.keywords) ? manifest.keywords : [];
  if (!keywords.includes('dsh-plugin')) at('keywords', 'keywords must include "dsh-plugin" (how the directories find plugins)');
  if (!manifest.engines?.dsh) at('engines-dsh', 'engines.dsh is unset - storefronts cannot tell users whether this works on their host');

  // ---- dependencies -------------------------------------------------------
  // `cordis` is supplied by the harness as @deepseek-ai/cordis. A bare `cordis`
  // entry anywhere gets the package hard-rejected by the Desktop community
  // market's install preview.
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const dep of Object.keys(manifest[field] ?? {})) {
      if (dep === 'cordis') at('no-bare-cordis', `${field} declares the public "cordis" package; use @deepseek-ai/cordis (the market rejects this outright)`);
      if (dep.startsWith('@deepseek-ai/') && field === 'dependencies') {
        at('peers-not-deps', `${field} pins ${dep}; official packages must be peerDependencies so the host supplies the singleton instance`);
      }
    }
  }
  for (const [dep, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (isHarnessPackage(dep)) {
      if (range !== DSH_PEER_RANGE) {
        at('peer-range', `peerDependencies["${dep}"] = "${range}"; every @deepseek-ai/dsh* peer in this repository uses exactly "${DSH_PEER_RANGE}" (dsh checks these at boot and skips a bundle whose range misses the runtime)`);
      }
    } else if (!admitsPrereleases(String(range))) {
      at('peer-prerelease', `peerDependencies["${dep}"] = "${range}" silently excludes every prerelease build of the harness; add an explicit branch, e.g. "${DSH_PEER_RANGE}"`);
    }
  }
  if (manifest.engines?.dsh !== undefined && manifest.engines.dsh !== DSH_PEER_RANGE) {
    at('peer-range', `engines.dsh = "${manifest.engines.dsh}"; keep it equal to the peer range "${DSH_PEER_RANGE}" so storefronts offer the plugin to the same harnesses it installs on`);
  }

  // ---- what a git-tag install ships ---------------------------------------
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (files.length === 0) at('files', 'no files allowlist - a git-tag install would ship the whole package directory, tests and notes included');
  if (!files.includes('package.json')) {
    // package.json is always included; only note it under --verbose.
    void 0;
  }
  const shipped = sourceFiles(dir).filter((f) => !relative(dir, f).startsWith('test'));
  for (const file of shipped) {
    const rel = relative(dir, file).split(/[\\/]/).join(posix.sep);
    if (RELOAD_SHIM.test(rel)) at('no-reload-shims', `${rel} is a dev-time module-cache shim; delete it before releasing`);
    if (!files.some((glob) => matches(rel, glob))) {
      at('files-covers-sources', `${rel} is not covered by the files allowlist and will be missing from a git-tag install`);
    }
  }
  for (const file of shipped) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const { pattern, label, level } of LEAK_PATTERNS) {
      // `// verify-allow: no-deployment-leaks` on the offending line is the
      // sanctioned way to keep a legitimate loopback default (or any other
      // deliberate match) without weakening the rule for everything else.
      const hit = lines.find((l) => pattern.test(l) && !/verify-allow:\s*(no-deployment-leaks|\*)/.test(l));
      if (hit !== undefined) {
        add(name, level, 'no-deployment-leaks', `${relative(dir, file)} contains ${label}: ${hit.trim().slice(0, 100)}`);
      }
    }
  }

  // ---- docs ---------------------------------------------------------------
  const readmePath = join(dir, 'README.md');
  if (!existsSync(readmePath)) at('readme', 'no package README - every plugin needs its own identity, not just a row in the index');
  else {
    const readme = readFileSync(readmePath, 'utf8');
    if (!/^#\s+\S+/m.test(readme)) at('readme', 'package README has no top-level heading');
    // Releases are git tags, never npm: the install line must pin this
    // package's tag and subdirectory. A bare-name install resolves from the
    // registry, where an unscoped dsh-* name may belong to somebody else.
    const pkgDir = relative(PACKAGES, dir).split(/[\\/]/).join(posix.sep);
    if (!hasTagInstall(readme, name, pkgDir)) {
      const { spec, pathPart } = expectedSpec(name, pkgDir);
      at('readme', `package README shows no git-tag install command (expected: dsh plugin --profile <name> add "${spec}<version>${pathPart}")`);
    }
    const bareInstall = findBareInstall(readme);
    if (bareInstall !== undefined) {
      at('readme', `package README installs by bare name ("${bareInstall.trim()}"), which resolves from the npm registry, not this repository - use the git-tag spec`);
    }
    if (!/^##\s+.*Config/im.test(readme)) at('readme', 'package README has no Configuration section', WARN);
    if (!rootReadme.includes(name)) at('index', `${name} is not listed in the root README index`);
    const docOptOut = /verify-allow:\s*(config-documented|\*)/.test(readme);
    if (!docOptOut) {
      for (const key of configKeysUsed(dir)) {
        if (!new RegExp(`\`?\\b${key}\\b\`?`).test(readme)) {
          at('config-documented', `config key "${key}" is read in code but never mentioned in the package README (document it, or opt out with "<!-- verify-allow: config-documented -->")`);
        }
      }
    }
  }
  const changelog = join(dir, 'CHANGELOG.md');
  if (!existsSync(changelog)) at('changelog', 'no CHANGELOG.md');
  else if (manifest.version && !readFileSync(changelog, 'utf8').includes(manifest.version)) {
    at('changelog', `CHANGELOG.md has no entry for the current version ${manifest.version}`);
  }

  // ---- tests --------------------------------------------------------------
  const testDir = join(dir, 'test');
  if (!existsSync(testDir) || readdirSync(testDir).filter((f) => f.endsWith('.test.mjs')).length === 0) {
    at('tests', 'no test/*.test.mjs - a plugin with no test is a plugin someone else has to debug');
  }
}

/** Config keys the plugin reads from its own row: `config.foo` / `config?.foo`. */
function configKeysUsed(dir) {
  const keys = new Set();
  for (const file of sourceFiles(dir)) {
    if (/\/client[.mjs]*$/.test(file) || file.endsWith('.json')) continue;
    const code = readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, ''))
      .join('\n');
    for (const match of code.matchAll(/\bconfig\s*(?:\?\.)?\.\s*([A-Za-z_][A-Za-z0-9_]*)/g)) keys.add(match[1]);
    for (const match of code.matchAll(/\bconfig\s*(?:\?\.)?\[\s*['"]([^'"]+)['"]\s*\]/g)) keys.add(match[1]);
  }
  return [...keys].filter((k) => !['length', 'map', 'filter', 'forEach', 'includes'].includes(k));
}

function matches(rel, glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(rel) || glob.replace(/\/\*\*$/, '') === rel.split('/')[0] || rel.startsWith(glob.replace(/\/\*$/, '').replace(/\*\*$/, ''));
}

/** Structural checks on a bundle patch, without a YAML parser. */
function verifyPatch(name, patchPath, at) {
  const text = readFileSync(patchPath, 'utf8');
  const body = text
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#') && l.trim() !== '');
  if (body.length === 0) {
    at('bundle-patch', 'the bundle patch is empty - it activates nothing', WARN);
    return;
  }
  if (!/^\s*-\s+(insert:|id:)/.test(body[0])) at('bundle-patch', `patch must be a YAML list starting with "- insert:" or "- id:" (got "${body[0].trim()}")`);
  if (/name:\s*\.?\//.test(text)) at('bundle-patch', 'a patch row uses a relative path as `name:` - once installed the row must name the package');
  if (/insert:/.test(text) && !new RegExp(`name:\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(text)) {
    at('bundle-patch', `the inserted row does not load this package by name (expected a line exactly "name: ${name}")`);
  }
}

// ---------------------------------------------------------------------------

const verbose = process.argv.includes('--verbose');
const only = (() => {
  const i = process.argv.indexOf('--package');
  return i === -1 ? null : process.argv[i + 1];
})();

const rootReadme = existsSync(join(ROOT, 'README.md')) ? readFileSync(join(ROOT, 'README.md'), 'utf8') : '';
if (!rootReadme) {
  results.push({ pkg: '(root)', level: ERROR, rule: 'index', detail: 'no root README index' });
}

const packageDirs = existsSync(PACKAGES)
  ? readdirSync(PACKAGES, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(PACKAGES, d.name, 'package.json'))).map((d) => join(PACKAGES, d.name))
  : [];

if (packageDirs.length === 0) {
  console.error('verify: no packages/ entries found - nothing to do');
  process.exit(1);
}

for (const dir of packageDirs) {
  const manifest = readJson(join(dir, 'package.json'));
  if (only && manifest.name !== only) continue;
  verifyPackage(dir, manifest, rootReadme);
}

const byRule = new Map();
for (const r of results) byRule.set(r.rule, (byRule.get(r.rule) ?? 0) + 1);

const errors = results.filter((r) => r.level === ERROR);
const warnings = results.filter((r) => r.level === WARN);

for (const r of results) console.log(`${r.level === ERROR ? 'FAIL' : 'warn'}  ${r.pkg}  [${r.rule}] ${r.detail}`);

if (verbose) {
  console.log(`\nchecked ${packageDirs.length} package(s); rules fired: ${[...byRule.entries()].map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
}

console.log(`\nverify: ${errors.length} error(s), ${warnings.length} warning(s) across ${packageDirs.length} package(s)`);
process.exit(errors.length > 0 ? 1 : 0);
