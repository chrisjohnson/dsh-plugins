#!/usr/bin/env node
// The lab profile: a real dsh, on a spare port, with its own DSH_HOME, running
// the working tree.
//
// WHY THIS EXISTS
// ---------------
// Testing a plugin against the deployment it shipped from means restarting the
// production service — which ends every session running inside it, including the
// one doing the edit. That is unacceptable for an agent-driven loop, so the loop
// gets its own harness instead:
//
//   .lab/install   a private dsh installation. Needed because the Cordis loader
//                  resolves a plugin row from *its own* module location, so the
//                  plugin has to live in the same node_modules as the loader.
//                  (Verified: a profile-installed plugin composes from anywhere,
//                  but only imports from beside the installation.)
//   .lab/home      a private DSH_HOME. Never sees the real profiles, sessions,
//                  settings or credentials unless you explicitly point it at them.
//
// STATUS: install and boot have not been exercised end-to-end on this repository
// yet (the composition and import halves are, by compose-smoke). Run
// `node scripts/lab.mjs up` once and confirm before trusting the wording below.
//
// Usage:
//   node scripts/lab.mjs up                 # install (or refresh) + boot on :3099
//   node scripts/lab.mjs up --port 3123     # different port
//   node scripts/lab.mjs install            # install/refresh without booting
//   node scripts/lab.mjs clean              # delete .lab/install and .lab/home
//
// There is no `down`: `up` runs in the foreground, so Ctrl-C stops it.
//
// Providers and plugin config: dsh >= 0.2 has no settings.yaml. Configure the
// lab by adding rows to .lab/home/profiles/web/cordis.patch.yml (it may hold
// API keys, so never commit it or copy it into a repository).
// DSH_VERSION picks the harness (default: the version CI smokes against).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const LAB = join(ROOT, '.lab');
const INSTALL = join(LAB, 'install');
const HOME = join(LAB, 'home');
const PORT = (() => {
  const i = process.argv.indexOf('--port');
  return i === -1 ? '3099' : process.argv[i + 1];
})();
if (process.argv.includes('--settings')) {
  console.error(
    'lab: --settings was removed: dsh >= 0.2 does not read settings.yaml.\n' +
      `  Put providers and plugin config in rows of ${join(HOME, 'profiles', 'web', 'cordis.patch.yml')} instead.`,
  );
  process.exit(2);
}
const command = (process.argv[2] ?? 'up').replace(/^--$/, 'up');

function packages() {
  return readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(ROOT, 'packages', entry.name, 'package.json')))
    .map((entry) => join(ROOT, 'packages', entry.name));
}

function ensureInstalled() {
  mkdirSync(INSTALL, { recursive: true });
  if (!existsSync(join(INSTALL, 'package.json'))) {
    const init = spawnSync('npm', ['init', '-y', '--scope', 'lab', '--force'], { cwd: INSTALL, encoding: 'utf8' });
    if (init.status !== 0) throw new Error(`npm init failed in ${INSTALL}: ${init.stderr}`);
  }
  // One flat tree: the harness, every local package, and their peer
  // dependencies as siblings of the Cordis loader that will import them.
  // `file:` for a directory is a symlink in npm >= 7, which is what makes edits
  // to packages/*/src visible on the next boot with no reinstall.
  const version = process.env.DSH_VERSION ?? '0.2.0-rc.2';
  const specifiers = [`@deepseek-ai/dsh@${version}`, ...packages()];
  console.log(`installing into ${INSTALL}:\n  ${specifiers.join('\n  ')}`);
  const result = spawnSync('npm', ['install', '--no-audit', '--no-fund', ...specifiers], {
    cwd: INSTALL,
    stdio: 'inherit',
    timeout: 900000,
  });
  if (result.status !== 0) throw new Error(`npm install failed (exit ${result.status})`);
}

function ensureHome() {
  mkdirSync(HOME, { recursive: true });
  for (const dir of packages()) {
    const name = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name;
    console.log(`  + ${name}`);
    spawnSync('node', [join(INSTALL, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'plugin', '--profile', 'web', 'add', dir], {
      cwd: HOME,
      stdio: 'inherit',
      env: { ...process.env, DSH_HOME: HOME },
    });
  }
}

function boot() {
  const bin = join(INSTALL, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  if (!existsSync(bin)) throw new Error(`${bin} missing — run 'node scripts/lab.mjs install' first`);
  console.log(`\nlab dsh → http://127.0.0.1:${PORT}   (DSH_HOME=${HOME})`);
  console.log('edit packages/*/src, then Ctrl-C and re-run: nothing here is watched.\n');
  const child = spawn('node', [bin, '--profile', 'web', '--port', PORT], {
    cwd: HOME,
    stdio: 'inherit',
    env: { ...process.env, DSH_HOME: HOME },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

try {
  if (command === 'clean') {
    rmSync(INSTALL, { recursive: true, force: true });
    rmSync(HOME, { recursive: true, force: true });
    console.log(`removed ${LAB}`);
  } else if (command === 'install') {
    ensureInstalled();
    ensureHome();
  } else if (command === 'up') {
    ensureInstalled();
    ensureHome();
    boot();
  } else {
    console.error(`unknown command ${command}; use up | install | clean`);
    process.exit(2);
  }
} catch (error) {
  console.error(`lab ${command}: ${String(error instanceof Error ? error.message : error)}`);
  process.exit(1);
}
