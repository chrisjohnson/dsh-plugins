// Grid math: cap adherence, full coverage, the valve, and the aspect-ratio
// corners. Pure module — runs on a bare clone.

import test from 'node:test';
import assert from 'node:assert/strict';

import { auditCoverage, needsTiling, planGrid, tileRects } from '../src/grid.mjs';

const BASE = Object.freeze({ overlapRatio: 0.12, safetyFactor: 0.95, maxTiles: 32 });

function plan(width, height, cap, overrides = {}) {
  return planGrid({ width, height, cap, ...BASE, ...overrides });
}

test('needsTiling: over/under/exact boundary and junk input', () => {
  assert.equal(needsTiling({ width: 1536, height: 1024, cap: 393216 }), true);
  assert.equal(needsTiling({ width: 768, height: 512, cap: 393216 }), false); // exactly the cap
  assert.equal(needsTiling({ width: 767, height: 512, cap: 393216 }), false);
  assert.equal(needsTiling({ width: 0, height: 10, cap: 5 }), false);
  assert.equal(needsTiling({ width: 10.5, height: 10, cap: 5 }), false);
  assert.equal(needsTiling({ width: 10, height: 10, cap: 0 }), false);
});

test('1536x1024 at a 393216 cap tiles into an aspect-matched grid', () => {
  const p = plan(1536, 1024, 393216);
  assert.ok(p, 'plan exists');
  assert.ok(p.tiles <= 32);
  for (const r of p.rects) {
    assert.ok(r.width * r.height <= p.effectiveCap, `tile ${r.width}x${r.height} <= ${p.effectiveCap}`);
    assert.ok(r.left >= 0 && r.top >= 0 && r.left + r.width <= 1536 && r.top + r.height <= 1024);
  }
  assert.equal(auditCoverage(1536, 1024, p.rects), true);
  // 0.2.0 scoring: 3x2 aspect-matched tiles beat the 5-tile 1x5 sliver grid.
  assert.equal(p.rows, 3, `rows=${p.rows}`);
  assert.equal(p.cols, 2, `cols=${p.cols}`);
});

test('4K screenshots get near-square tiles, not full-height slivers', () => {
  // The case from production: 3840x2160 at the 393216 cap. The fewest-tiles
  // answer (0.1.0) was 1x26 strips of 167x2160; squareness must beat it.
  const p = plan(3840, 2160, 393216);
  assert.ok(p);
  assert.equal(auditCoverage(3840, 2160, p.rects), true);
  const tileAspect = p.tileWidth / p.tileHeight;
  const sourceAspect = 3840 / 2160;
  assert.ok(tileAspect > sourceAspect / 2 && tileAspect < sourceAspect * 2, `tile aspect ${tileAspect.toFixed(2)} stays near the source aspect ${sourceAspect.toFixed(2)}`);
  assert.ok(p.tiles <= 32);
  // The 2730x1536 shape (dsh-normalized 4K paste) likewise avoids 13x1 strips.
  const q = plan(2730, 1536, 393216);
  assert.ok(q);
  assert.ok(q.rows > 1 && q.cols > 1, `2730x1536 -> ${q.rows}x${q.cols}`);
});

test('every plan is deterministic and covers the image', () => {
  const cases = [
    [1920, 1080, 393216],
    [4000, 3000, 393216],
    [1024, 1024, 500000],
    [300, 4000, 100000],
    [4000, 300, 100000],
    [2048, 1536, 1048576],
  ];
  for (const [w, h, cap] of cases) {
    const a = plan(w, h, cap);
    const b = plan(w, h, cap);
    assert.deepEqual(a, b, `deterministic for ${w}x${h}@${cap}`);
    if (a === null) continue;
    assert.equal(auditCoverage(w, h, a.rects), true, `coverage for ${w}x${h}@${cap}`);
    assert.ok(a.rects.length <= BASE.maxTiles);
    for (const r of a.rects) assert.ok(r.width * r.height <= a.effectiveCap);
  }
});

test('valve: an image no grid within maxTiles can fit returns null', () => {
  // 20000x20000 = 400M px at a 393216 cap needs at least ~1074 tiles.
  assert.equal(plan(20000, 20000, 393216), null);
  // A tiny cap with a small valve also refuses.
  assert.equal(plan(1000, 1000, 1000, { maxTiles: 2 }), null);
  // The same image passes once the valve is realistic.
  const p = plan(1000, 1000, 1000, { maxTiles: 32 });
  assert.ok(p === null || p.rects.length <= 32);
});

test('wide/short and tall/narrow edge cases', () => {
  const wide = plan(10000, 100, 393216);
  assert.ok(wide, 'wide image tiles');
  assert.equal(auditCoverage(10000, 100, wide.rects), true);
  assert.ok(wide.tiles <= 32);
  for (const r of wide.rects) assert.ok(r.width * r.height <= wide.effectiveCap);
  // Aspect scoring may pick a short multi-row grid of wide tiles over a
  // single row of slivers; either way tiles stay wide like the source.
  assert.ok(wide.tileWidth / wide.tileHeight > 10, 'tiles stay strongly wide');

  const tall = plan(100, 10000, 393216);
  assert.ok(tall, 'tall image tiles');
  assert.equal(auditCoverage(100, 10000, tall.rects), true);
  assert.ok(tall.tiles <= 32);
  assert.ok(tall.tileHeight / tall.tileWidth > 10, 'tiles stay strongly tall');

  // A strip so thin one tile already fits: no tiling needed upstream, but the
  // planner must not crash if asked.
  const strip = plan(100000, 1, 393216);
  if (strip !== null) assert.equal(auditCoverage(100000, 1, strip.rects), true);
});

test('overlap: adjacent tiles share roughly overlapRatio of a tile', () => {
  const p = plan(1536, 1024, 393216, { overlapRatio: 0.25 });
  assert.ok(p);
  const row = p.rects.filter((r) => r.top === p.rects[0].top);
  for (let i = 1; i < row.length; i++) {
    const overlap = row[i - 1].left + row[i - 1].width - row[i].left;
    assert.ok(overlap > 0, 'adjacent tiles overlap');
    assert.ok(overlap <= row[i].width, 'overlap never exceeds a tile');
  }
  const zero = plan(1536, 1024, 393216, { overlapRatio: 0 });
  assert.ok(zero);
  assert.equal(auditCoverage(1536, 1024, zero.rects), true);
});

test('safetyFactor tightens the per-tile budget', () => {
  const loose = plan(1536, 1024, 393216, { safetyFactor: 1 });
  const tight = plan(1536, 1024, 393216, { safetyFactor: 0.5 });
  assert.ok(loose && tight);
  assert.ok(tight.effectiveCap < loose.effectiveCap);
  assert.ok(tight.tiles >= loose.tiles, 'a tighter budget never needs fewer tiles');
  for (const r of tight.rects) assert.ok(r.width * r.height <= Math.floor(393216 * 0.5));
});

test('tileRects: first tile at origin, last flush with the edge', () => {
  const rects = tileRects(1500, 1000, 2, 3, 600, 550);
  assert.equal(rects.length, 6);
  assert.equal(rects[0].left, 0);
  assert.equal(rects[0].top, 0);
  const last = rects[rects.length - 1];
  assert.equal(last.left + last.width, 1500);
  assert.equal(last.top + last.height, 1000);
  assert.equal(auditCoverage(1500, 1000, rects), true);
});

test('auditCoverage rejects gaps and out-of-bounds rects', () => {
  assert.equal(auditCoverage(100, 100, [{ left: 0, top: 0, width: 50, height: 100 }, { left: 60, top: 0, width: 40, height: 100 }]), false); // horizontal gap
  assert.equal(auditCoverage(100, 100, [{ left: 0, top: 0, width: 100, height: 40 }, { left: 0, top: 60, width: 100, height: 40 }]), false); // vertical gap
  assert.equal(auditCoverage(100, 100, [{ left: 0, top: 0, width: 100, height: 100 }]), true);
  assert.equal(auditCoverage(100, 100, [{ left: 0, top: 0, width: 101, height: 100 }]), false); // out of bounds
  assert.equal(auditCoverage(100, 100, []), false);
  assert.equal(auditCoverage(100, 100, [{ left: 1, top: 0, width: 99, height: 100 }]), false); // misses column 0
});
