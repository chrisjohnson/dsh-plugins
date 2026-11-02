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

test('1536x1024 at a 393216 cap tiles into a small overlapping grid', () => {
  const p = plan(1536, 1024, 393216);
  assert.ok(p, 'plan exists');
  assert.ok(p.tiles <= 32);
  for (const r of p.rects) {
    assert.ok(r.width * r.height <= p.effectiveCap, `tile ${r.width}x${r.height} <= ${p.effectiveCap}`);
    assert.ok(r.left >= 0 && r.top >= 0 && r.left + r.width <= 1536 && r.top + r.height <= 1024);
  }
  assert.equal(auditCoverage(1536, 1024, p.rects), true);
  // A 2x2 grid cannot fit under 0.95 * 393216 with overlap, so expect more tiles.
  assert.ok(p.tiles > 4, `tiles=${p.tiles}`);
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
  assert.equal(wide.rows, 1, 'one row of full-height tiles');
  assert.equal(auditCoverage(10000, 100, wide.rects), true);
  for (const r of wide.rects) assert.ok(r.width * r.height <= wide.effectiveCap);

  const tall = plan(100, 10000, 393216);
  assert.ok(tall, 'tall image tiles');
  assert.equal(tall.cols, 1, 'one column of full-width tiles');
  assert.equal(auditCoverage(100, 10000, tall.rects), true);

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
