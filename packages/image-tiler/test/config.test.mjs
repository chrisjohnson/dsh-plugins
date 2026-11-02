// Config resolution: defaults, inert absence, and the warn-and-fallback path
// for every unusable value. Pure module — runs on a bare clone.

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG, resolveConfig } from '../src/config.mjs';

test('absent config is the documented inert state', () => {
  for (const input of [undefined, null, {}, 'nonsense', 42, []]) {
    const { settings, warnings } = resolveConfig(input);
    assert.deepEqual(settings.caps, {});
    assert.equal(settings.enabled, true);
    assert.equal(settings.overlapRatio, DEFAULT_CONFIG.overlapRatio);
    assert.equal(settings.safetyFactor, DEFAULT_CONFIG.safetyFactor);
    assert.equal(settings.maxTilesPerImage, DEFAULT_CONFIG.maxTilesPerImage);
    assert.equal(settings.logToStderr, false);
    if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) {
      assert.ok(warnings.length > 0, `junk input ${JSON.stringify(input)} warns`);
    }
  }
});

test('caps entries are kept only when well formed', () => {
  const { settings, warnings } = resolveConfig({
    caps: {
      'provider-a/model-x': 393216,
      'provider-b/model y': 1048576,
      'provider-c/bad-0': 0,
      'provider-c/bad-neg': -5,
      'provider-c/bad-float': 1.5,
      'provider-c/bad-str': '393216',
      '  ': 100,
    },
  });
  assert.deepEqual(settings.caps, { 'provider-a/model-x': 393216, 'provider-b/model y': 1048576 });
  assert.ok(warnings.some((w) => w.includes('provider-c/bad-0')));
  assert.ok(warnings.some((w) => w.includes('provider-c/bad-str')));
  assert.ok(warnings.some((w) => w.includes('empty key')));
});

test('a non-object caps warns and yields {}', () => {
  for (const bad of ['393216', 393216, [1, 2], true]) {
    const { settings, warnings } = resolveConfig({ caps: bad });
    assert.deepEqual(settings.caps, {});
    assert.ok(warnings.some((w) => w.includes('caps')));
  }
});

test('numeric keys are range-checked with fallbacks', () => {
  const good = resolveConfig({ overlapRatio: 0, safetyFactor: 1, maxTilesPerImage: 1 });
  assert.equal(good.settings.overlapRatio, 0);
  assert.equal(good.settings.safetyFactor, 1);
  assert.equal(good.settings.maxTilesPerImage, 1);
  assert.deepEqual(good.warnings, []);

  const bad = resolveConfig({ overlapRatio: 0.9, safetyFactor: 0, maxTilesPerImage: 9999 });
  assert.equal(bad.settings.overlapRatio, DEFAULT_CONFIG.overlapRatio);
  assert.equal(bad.settings.safetyFactor, DEFAULT_CONFIG.safetyFactor);
  assert.equal(bad.settings.maxTilesPerImage, DEFAULT_CONFIG.maxTilesPerImage);
  assert.equal(bad.warnings.length, 3);

  // safetyFactor 0 is excluded (an empty budget would tile forever); 1 is the
  // exact cap and allowed.
  assert.equal(resolveConfig({ safetyFactor: 0.0001 }).settings.safetyFactor, 0.0001);
  assert.equal(resolveConfig({ overlapRatio: 0.749 }).settings.overlapRatio, 0.749);
});

test('boolean keys refuse non-booleans with a warning', () => {
  const { settings, warnings } = resolveConfig({ enabled: 'yes', logToStderr: 1 });
  assert.equal(settings.enabled, true);
  assert.equal(settings.logToStderr, false);
  assert.equal(warnings.length, 2);
  assert.equal(resolveConfig({ enabled: false }).settings.enabled, false);
});

test('unknown keys warn and are ignored', () => {
  const { settings, warnings } = resolveConfig({ cap: 123, tileOverlap: 0.5 });
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((w) => w.includes('unknown config key')));
  assert.deepEqual(Object.keys(settings).sort(), Object.keys(DEFAULT_CONFIG).sort());
});
