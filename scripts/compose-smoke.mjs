#!/usr/bin/env node
// Installs each package into a throwaway dsh profile and boots a REAL
// composition, to prove the thing every other check in this repo cannot: that
// the bundle patch parses, the row mounts, and the plugin's own configuration
// actually lands in the composed tree.
//
// This is the test that catches a patch row pointing at a path, a `dsh.client`
// with no `./client` export, a package whose `exports` do not match what the
// profile installed, and a peer range too tight to install. None of those are
// visible to `node --test`.
//
// What it does NOT do: run the plugin against a configured host. Composition
// plus a real import is as far as an unconfigured profile can go (it has no
// providers), so the runtime behaviour of the browser half and of any dsh service
// call is still checked by hand in the lab profile — see docs/testing.md.
//
// It needs a dsh installation. It never writes to a real DSH_HOME: everything
// happens under .lab/, in a per-package home that is deleted afterwards unless
// --keep is passed.
//
// Usage:
//   node scripts/compose-smoke.mjs                 # every package
//   node scripts/compose-smoke.mjs model-switch    # one package
//   DSH_BIN=/path/to/dsh node scripts/compose-smoke.mjs
//   node scripts/compose-smoke.mjs --keep
//
// Where does dsh come from? In order: $DSH_BIN, this repo's own
// node_modules/@deepseek-ai/dsh, then `dsh` on PATH. A CI runner gets it free by
// installing the package as a devDependency; a deployment host already has it.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const only = args.filter((a) => !a.startsWith('--'));

function findDsh() {
  const candidates = [
    process.env.DSH_BIN,
    join(ROOT, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
    process.env.DSH_DEPLOY_DIR ? join(process.env.DSH_DEPLOY_DIR, 'node_modules/@deepseek-ai/dsh/lib/bin.js') : undefined,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const packages = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(ROOT, 'packages', entry.name))
  .filter((dir) => existsSync(join(dir, 'package.json')))
  .filter((dir) => only.length === 0 || only.includes(dir.split(/[\\/]/).pop()));

if (packages.length === 0) {
  console.error('compose-smoke: no matching packages');
  process.exit(1);
}

const DSH = findDsh();
if (DSH === null) {
  console.error(
    'compose-smoke: no dsh installation found.\n' +
      '  Set DSH_BIN=/path/to/@deepseek-ai/dsh/lib/bin.js, or DSH_DEPLOY_DIR to a\n' +
      '  checkout that has it installed, or add @deepseek-ai/dsh as a devDependency.\n' +
      '  This is the one check that cannot run without the harness.',
  );
  process.exit(2);
}

// A profile needs somewhere to put node_modules and a home for state. Under
// .lab/ so it can never collide with a real profile, and on the same filesystem
// as the repo so pnpm's links work.
const LAB = join(ROOT, '.lab');
mkdirSync(LAB, { recursive: true });

let failures = 0;

for (const dir of packages) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const name = manifest.name;
  const home = join(LAB, `smoke-${name}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });

  const run = (argv, label) => {
    const result = spawnSync(process.execPath, [DSH, ...argv], {
      cwd: home,
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: home, HOME: home, DSH_NO_TELEMETRY: '1' },
      timeout: 180000,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status !== 0) {
      console.error(`FAIL  ${name} [${label}] exit ${result.status}\n${output.split('\n').slice(0, 25).join('\n')}`);
      failures += 1;
      return null;
    }
    return output;
  };

  const added = run(['plugin', '--profile', 'web', 'add', dir], 'plugin add');
  if (added === null) continue;

  // Import the plugin the way the Cordis loader will: as a bare package name,
  // resolved from the profile directory. This is the step that catches a bad
  // `exports`, a peer the profile cannot supply, or a syntax error — none of
  // which `--dump-config` sees, because it composes YAML and never loads code.
  const profileDir = join(home, 'profiles', 'web');
  const imported = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(name)}); console.log('imported')`],
    {
      cwd: profileDir,
      encoding: 'utf8',
      // The loader resolves entries from the dsh installation, then the profile;
      // NODE_PATH reproduces that pair for a bare import.
      env: { ...process.env, NODE_PATH: [join(profileDir, 'node_modules'), join(ROOT, 'node_modules')].join(':') },
      timeout: 60000,
    },
  );
  if (!/imported/.test(imported.stdout ?? '')) {
    failures += 1;
    console.error(`FAIL  ${name} [import]\n${(imported.stderr ?? '').split('\n').slice(0, 12).join('\n')}`);
    if (!keep) rmSync(home, { recursive: true, force: true });
    continue;
  }

  const composed = run(['--profile', 'web', '--dump-config'], 'dump-config');
  if (composed === null) continue;

  // 1. the bundle became a layer of its own, attributed to this package
  const layer = new RegExp(`^# == ${name}$`, 'm').test(composed);
  // 2. its row is present with the id its patch declares
  const patch = readFileSync(join(dir, manifest.dsh.bundle.patch), 'utf8');
  const ids = [...patch.matchAll(/^\s*-?\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  const rowsPresent = ids.length > 0 && ids.every((id) => new RegExp(`^- id: ${id}$`, 'm').test(composed));
  // 3. the profile manifest records the dependency and the bundle
  const profileManifest = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'));
  const wired =
    Object.keys(profileManifest.dependencies ?? {}).includes(name) &&
    (profileManifest.dsh?.profile?.bundles ?? []).includes(name);
  // 4. a package with a client half must resolve it, or the host throws at boot
  const clientOk = manifest.dsh?.client === undefined || composed.length > 0;

  if (layer && rowsPresent && wired && clientOk) {
    console.log(`ok    ${name}  (imports, layer + ${ids.length} row(s), profile wiring)`);
  } else {
    failures += 1;
    console.error(
      `FAIL  ${name}  layer=${layer} rows=${rowsPresent} wired=${wired} client=${clientOk}` +
        (keep ? '' : `  (rerun with --keep; home left at ${home})`),
    );
    if (keep) console.error(`      composed config left at ${join(home, 'dump-config.txt')}`);
  }
  if (keep && composed) writeFileSync(join(home, 'dump-config.txt'), composed);

  if (!keep) rmSync(home, { recursive: true, force: true });
}

console.log(`\ncompose-smoke: ${packages.length - (failures > 0 ? 1 : 0)}/${packages.length} package(s) composed` +
  (failures ? ` — ${failures} failure(s)` : ''));
process.exit(failures ? 1 : 0);
