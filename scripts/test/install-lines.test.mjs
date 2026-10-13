import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findBareInstall, hasTagInstall } from '../lib/install-lines.mjs';

test('bare-name installs are caught in every common shape', () => {
  for (const line of [
    'pnpm add dsh-model-switch',
    'npm install dsh-model-switch',
    'npm i dsh-model-switch',
    'yarn add dsh-model-switch',
    'dsh plugin add dsh-model-switch',
    'dsh plugin --profile web add dsh-model-switch',
    'dsh plugin --profile web add dsh-model-switch@0.2.0',
    'pnpm add dsh-model-switch@latest',
    'pnpm add "dsh-model-switch"',
    "pnpm add 'dsh-model-switch'",
    '$ pnpm add dsh-model-switch',
    '  $ dsh plugin --profile web add "dsh-model-switch@0.2.0"',
    'pnpm add -D dsh-model-switch',
    'pnpm add --save-exact dsh-model-switch',
    'pnpm add some-other-pkg dsh-model-switch',
  ]) {
    assert.equal(findBareInstall(`# x\n\n${line}\n`), line, line);
  }
});

test('git-tag installs and prose mentions are not bare installs', () => {
  for (const line of [
    'dsh plugin --profile web add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-model-switch-v0.2.0&path:/packages/model-switch"',
    'pnpm add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-model-switch-v<version>&path:/packages/model-switch"',
    '> **Warning:** never `pnpm add dsh-model-switch` by bare name.',
    'Do not run pnpm add dsh-model-switch from the registry.',
    'pnpm add left-pad',
    'node scripts/verify.mjs --package dsh-model-switch',
  ]) {
    assert.equal(findBareInstall(line), undefined, line);
  }
});

test('the tag install line must name this package and its directory', () => {
  const good = 'dsh plugin --profile web add "git+https://github.com/chrisjohnson/dsh-plugins.git#dsh-x-v<version>&path:/packages/x"';
  assert.equal(hasTagInstall(good, 'dsh-x', 'x'), true);
  assert.equal(hasTagInstall(good, 'dsh-y', 'x'), false);
  assert.equal(hasTagInstall(good, 'dsh-x', 'y'), false);
  assert.equal(hasTagInstall(good.replace('dsh plugin --profile web add', 'pnpm add'), 'dsh-x', 'x'), false);
});
