// Tests for the pure half of dsh-image-search-searxng.
//
//    node --test packages/image-search-searxng/test/*.test.mjs
//
// These cover configuration resolution, request building, response mapping and
// rendering — everything that can break without a running dsh. The plugin's
// Cordis wiring (inject/effect/register) is deliberately NOT exercised here:
// importing src/index.mjs would require the @deepseek-ai packages, which this
// repository does not install so that `git clone && npm test` works. That wiring
// is covered by scripts/compose-smoke.mjs, which installs the package into a real
// profile and boots a real composition.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RESULTS,
  MAX_RESULTS_CEILING,
  USER_AGENT,
  buildSearchURL,
  capResults,
  formatResults,
  mapResults,
  resolveConfig,
  toolDescription,
} from '../src/searxng.mjs';

test('config: explicit config beats the environment, which beats the default', () => {
  assert.equal(resolveConfig({ baseURL: 'http://cfg:1/' }, { SEARXNG_BASE_URL: 'http://env:2/' }).baseURL, 'http://cfg:1');
  assert.equal(resolveConfig({}, { SEARXNG_BASE_URL: 'http://env:2/' }).baseURL, 'http://env:2');
  assert.equal(resolveConfig({}, {}).baseURL, DEFAULT_BASE_URL);
});

test('config: trailing slashes are trimmed so the endpoint never doubles up', () => {
  assert.equal(resolveConfig({ baseURL: 'http://box:8888///' }, {}).baseURL, 'http://box:8888');
});

test('config: blank values are absent values, not empty strings', () => {
  const resolved = resolveConfig({ apiKey: '   ' }, { SEARXNG_API_KEY: ' secret ' });
  assert.equal(resolved.apiKey, 'secret');
  assert.equal(resolveConfig({ apiKey: '' }, {}).apiKey, undefined);
});

test('config: a baseURL that is not a URL fails at boot with the offending value', () => {
  assert.throws(() => resolveConfig({ baseURL: 'not a url' }, {}), /invalid baseURL "not a url"/);
  assert.throws(() => resolveConfig({ baseURL: 'ftp://box:8888' }, {}), /protocol must be http/);
});

test('config: result count comes from config, then env, then the documented default', () => {
  assert.equal(resolveConfig({ maxResults: 3 }, { SEARXNG_NUM_RESULTS: '5' }).maxResults, 3);
  assert.equal(resolveConfig({}, { SEARXNG_NUM_RESULTS: '5' }).maxResults, 5);
  assert.equal(resolveConfig({}, { SEARXNG_NUM_RESULTS: 'zero' }).maxResults, 8);
  assert.equal(resolveConfig({}, { SEARXNG_NUM_RESULTS: '-4' }).maxResults, 8);
});

test('config: a profile row that passes environment variables through as `!!js process.env.X`', () => {
  // Such a row hands the plugin raw strings when the variable is set and
  // `undefined` when it is not; both must resolve exactly as if the key were absent.
  const set = resolveConfig(
    { baseURL: 'http://searxng.test:9000', maxResults: '5', apiKey: 'k' },
    {},
  );
  assert.deepEqual(set, { baseURL: 'http://searxng.test:9000', maxResults: 5, apiKey: 'k' });
  const unset = resolveConfig({ baseURL: undefined, maxResults: undefined, apiKey: undefined }, {});
  assert.deepEqual(unset, { baseURL: DEFAULT_BASE_URL, maxResults: DEFAULT_MAX_RESULTS, apiKey: undefined });
});

test('user agent names the version actually installed', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(USER_AGENT, `${manifest.name}/${manifest.version}`);
});

test('capResults clamps into the advertised 1..30 range', () => {
  assert.equal(capResults(undefined, 8), 8);
  assert.equal(capResults(0, 8), 1);
  assert.equal(capResults(-5, 8), 1);
  assert.equal(capResults(999, 8), MAX_RESULTS_CEILING);
  assert.equal(capResults(2.9, 8), 2);
  assert.equal(capResults('nonsense', 8), 8);
});

test('request: images category, json format, api key only when present', () => {
  const url = buildSearchURL({ baseURL: 'http://box:8888', query: 'red fox', apiKey: undefined });
  assert.equal(url.pathname, '/search');
  assert.equal(url.searchParams.get('categories'), 'images');
  assert.equal(url.searchParams.get('format'), 'json');
  assert.equal(url.searchParams.get('q'), 'red fox');
  assert.equal(url.searchParams.get('preference[api_key]'), null);

  const withKey = buildSearchURL({ baseURL: 'http://box:8888', query: 'x', apiKey: 'k' });
  assert.equal(withKey.searchParams.get('preference[api_key]'), 'k');
});

test('mapping: rows without an image URL are dropped, not surfaced as text', () => {
  const payload = {
    results: [
      { title: 'kept', img_src: 'http://img/1', url: 'http://page/1', resolution: '800x600' },
      { title: 'no image', url: 'http://page/2' },
      { title: 'empty image', img_src: '', url: 'http://page/3' },
      { img_src: 'http://img/4' },
    ],
  };
  const mapped = mapResults(payload, 10);
  assert.equal(mapped.length, 2);
  assert.deepEqual(mapped[0], { title: 'kept', imgSrc: 'http://img/1', sourceUrl: 'http://page/1', resolution: '800x600' });
  // No source page? the image URL stands in, so a row is always clickable.
  assert.deepEqual(mapped[1], { imgSrc: 'http://img/4', sourceUrl: 'http://img/4' });
});

test('mapping: absent or malformed payloads yield no results instead of throwing', () => {
  for (const payload of [undefined, null, {}, { results: null }, { results: 'nope' }]) {
    assert.deepEqual(mapResults(payload, 5), []);
  }
});

test('mapping: the cap is applied after filtering', () => {
  const payload = { results: Array.from({ length: 10 }, (_, i) => ({ img_src: `http://img/${i}` })) };
  assert.equal(mapResults(payload, 3).length, 3);
});

test('render: results become copy-pasteable markdown image links', () => {
  const text = formatResults([
    { title: 'A fox', imgSrc: 'http://img/1', sourceUrl: 'http://page/1', resolution: '200x100' },
    { imgSrc: 'http://img/2', sourceUrl: 'http://img/2' },
  ]);
  assert.match(text, /1\. \*\*A fox\*\*/);
  assert.match(text, /!\[A fox\]\(http:\/\/img\/1\)/);
  assert.match(text, /Resolution: 200x100/);
  // Untitled results still get a numbered alt string rather than `undefined`.
  assert.match(text, /!\[Image 2\]\(http:\/\/img\/2\)/);
  assert.doesNotMatch(text, /undefined/);
});

test('render: an empty result set says so plainly', () => {
  assert.equal(formatResults([]), 'No image results found.');
  assert.equal(formatResults(undefined), 'No image results found.');
});

test('description: advertises the configured default, not a stale constant', () => {
  assert.match(toolDescription(12), /Default result count is 12/);
  // The verbatim-copy instruction is what makes images render; it must not drift.
  assert.match(toolDescription(8), /VERBATIM/);
});
