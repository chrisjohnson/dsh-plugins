// The sharp pipeline against real PNG bytes: probe dimensions and pixel-exact
// rectangle cuts. Needs sharp; on a bare clone without it these tests skip
// rather than fail (same convention as the other packages' host tests).
// The animated-raster branch is decided in handler.mjs and covered there with
// a stubbed probe — synthesizing a multi-frame raster here would test sharp,
// not this plugin.

import test from 'node:test';
import assert from 'node:assert/strict';

import { planGrid } from '../src/grid.mjs';

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  sharp = undefined;
}
const skip = sharp === undefined ? 'sharp is not installed' : false;

let tiler;
if (sharp !== undefined) {
  tiler = await import('../src/tiler.mjs');
}

// A deterministic pattern so a cut rectangle can be verified pixel-for-pixel.
function patternAt(x, y) {
  return [(x * 3) % 256, (y * 5) % 256, (x + y) % 256];
}

async function makeScreenshot(width, height) {
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = patternAt(x, y);
      const i = (y * width + x) * channels;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  return new Uint8Array(await sharp(raw, { raw: { width, height, channels } }).png().toBuffer());
}

test('probeImage reports dimensions and static-ness of a real PNG', { skip }, async () => {
  const png = await makeScreenshot(1536, 1024);
  const meta = await tiler.probeImage(png);
  assert.equal(meta.width, 1536);
  assert.equal(meta.height, 1024);
  assert.equal(meta.animated, false);
});

test('probeImage refuses bytes it cannot decode', { skip }, async () => {
  await assert.rejects(() => tiler.probeImage(new Uint8Array([1, 2, 3, 4])));
});

test('extractTilePngs cuts pixel-exact, under-cap tiles that reassemble the image', { skip }, async () => {
  const width = 1536;
  const height = 1024;
  const cap = 393216;
  const png = await makeScreenshot(width, height);
  const plan = planGrid({ width, height, cap, overlapRatio: 0.12, safetyFactor: 0.95, maxTiles: 32 });
  assert.ok(plan);
  const tiles = await tiler.extractTilePngs(png, plan.rects);
  assert.equal(tiles.length, plan.rects.length);
  for (let i = 0; i < tiles.length; i++) {
    const rect = plan.rects[i];
    const meta = await sharp(tiles[i]).metadata();
    assert.equal(meta.width, rect.width);
    assert.equal(meta.height, rect.height);
    assert.ok(rect.width * rect.height <= plan.effectiveCap);
    // Spot-check corners and centre of the tile against the source pattern.
    const buf = await sharp(tiles[i]).raw().toBuffer();
    const px = (x, y) => [buf[(y * rect.width + x) * 3], buf[(y * rect.width + x) * 3 + 1], buf[(y * rect.width + x) * 3 + 2]];
    for (const [x, y] of [[0, 0], [rect.width - 1, 0], [0, rect.height - 1], [rect.width - 1, rect.height - 1], [rect.width >> 1, rect.height >> 1]]) {
      assert.deepEqual(px(x, y), patternAt(rect.left + x, rect.top + y), `tile ${i} pixel ${x},${y}`);
    }
  }
});
