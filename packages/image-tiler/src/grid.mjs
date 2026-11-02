// dsh-image-tiler: the tiling math. Pure — imports nothing, touches no I/O.
//
// A vision backend may refuse (or silently downscale) any image above a pixel
// cap. This module answers: given a W×H raster and a cap, what is the smallest
// overlapping rows×cols grid whose every tile fits under `cap * safetyFactor`
// pixels while still covering the whole image? If no grid within `maxTiles`
// fits, the plan is infeasible and the caller keeps the original image.
//
// Overlap model: adjacent tiles share `overlapRatio` of a tile's extent, so
// text or edges that fall on a tile boundary appear whole inside at least one
// tile. With K columns the covered width is tw + (K-1)·tw·(1-o), which gives
// the minimum tile width below; the stride between tile origins is then
// (W - tw) / (K - 1), which is ≤ tw, so consecutive tiles overlap and the
// last tile ends exactly at the image edge.

/**
 * Whether one image is over the cap and must be considered for tiling.
 * An image whose pixel count equals the cap is under it: pass through.
 */
export function needsTiling({ width, height, cap }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isFinite(cap)) return false;
  if (width <= 0 || height <= 0 || cap <= 0) return false;
  return width * height > cap;
}

/**
 * Minimum tile extent for one axis so `count` tiles with the given overlap
 * still span `length` pixels. `count === 1` returns the full length.
 */
function minTileExtent(length, count, overlapRatio) {
  if (count <= 1) return length;
  return Math.ceil(length / (1 + (count - 1) * (1 - overlapRatio)));
}

/**
 * Tile origins for one axis: `count` positions of extent `tile` spanning
 * `length`. Positions are integers; the first is 0 and the last is exactly
 * `length - tile`, and consecutive positions never leave a gap because the
 * stride is ≤ `tile` (guaranteed by `minTileExtent`).
 */
function axisPositions(length, count, tile) {
  if (count <= 1) return [0];
  const stride = (length - tile) / (count - 1);
  const positions = [];
  for (let i = 0; i < count; i++) {
    positions.push(i === count - 1 ? length - tile : Math.floor(i * stride));
  }
  return positions;
}

/**
 * The rectangle list for a rows×cols grid of `tileWidth`×`tileHeight` tiles
 * over a `width`×`height` image, in row-major order.
 */
export function tileRects(width, height, rows, cols, tileWidth, tileHeight) {
  const lefts = axisPositions(width, cols, tileWidth);
  const tops = axisPositions(height, rows, tileHeight);
  const rects = [];
  for (const top of tops) {
    for (const left of lefts) {
      rects.push({ left, top, width: tileWidth, height: tileHeight });
    }
  }
  return rects;
}

/**
 * Full-coverage audit: prove the rects tile the whole image with no gaps.
 *
 * Group the rects by their `top` into horizontal bands. Each band's rects must
 * span [0, width) with no horizontal gap, and the band must reach at least the
 * next band's top (or the image bottom for the last band). Every pixel then
 * lies inside some rect: take the highest band starting at or above the
 * pixel's y — it covers that y and spans the full width at x.
 */
export function auditCoverage(width, height, rects) {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return false;
  if (width <= 0 || height <= 0) return false;
  if (!Array.isArray(rects) || rects.length === 0) return false;
  for (const r of rects) {
    if (!Number.isInteger(r.left) || !Number.isInteger(r.top)) return false;
    if (!Number.isInteger(r.width) || !Number.isInteger(r.height)) return false;
    if (r.width <= 0 || r.height <= 0) return false;
    if (r.left < 0 || r.top < 0 || r.left + r.width > width || r.top + r.height > height) return false;
  }
  const tops = [...new Set(rects.map((r) => r.top))].sort((a, b) => a - b);
  if (tops[0] !== 0) return false;
  for (let i = 0; i < tops.length; i++) {
    const band = rects.filter((r) => r.top === tops[i]).sort((a, b) => a.left - b.left);
    if (band[0].left !== 0) return false;
    let reach = 0;
    for (const r of band) {
      if (r.left > reach) return false;
      reach = Math.max(reach, r.left + r.width);
    }
    if (reach !== width) return false;
    const nextTop = i + 1 < tops.length ? tops[i + 1] : height;
    const bandDepth = Math.max(...band.map((r) => r.height));
    if (tops[i] + bandDepth < nextTop) return false;
  }
  return true;
}

/**
 * Plan the grid. Returns null when no grid within `maxTiles` tiles keeps every
 * tile at or under `floor(cap * safetyFactor)` pixels.
 *
 * Search order: fewest tiles first; among equal tile counts, the smallest
 * tile area (the most overlap). Every candidate is verified by
 * {@link auditCoverage} before it is returned, so a math bug cannot ship a
 * gap to the model.
 *
 * @returns {{ rows, cols, tiles, tileWidth, tileHeight, effectiveCap, rects } | null}
 */
export function planGrid({ width, height, cap, overlapRatio, safetyFactor, maxTiles }) {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width <= 0 || height <= 0 || !(cap > 0) || !(maxTiles >= 1)) return null;
  const effectiveCap = Math.max(1, Math.floor(cap * safetyFactor));
  let best = null;
  for (let rows = 1; rows <= maxTiles; rows++) {
    for (let cols = 1; cols <= maxTiles; cols++) {
      const tiles = rows * cols;
      if (tiles > maxTiles) break;
      const tileWidth = Math.min(width, minTileExtent(width, cols, overlapRatio));
      const tileHeight = Math.min(height, minTileExtent(height, rows, overlapRatio));
      const area = tileWidth * tileHeight;
      if (area > effectiveCap) continue;
      if (best === null || tiles < best.tiles || (tiles === best.tiles && area < best.tileArea)) {
        best = { rows, cols, tiles, tileWidth, tileHeight, tileArea: area };
      }
    }
  }
  if (best === null) return null;
  const rects = tileRects(width, height, best.rows, best.cols, best.tileWidth, best.tileHeight);
  if (!auditCoverage(width, height, rects)) return null;
  for (const r of rects) {
    if (r.width * r.height > effectiveCap) return null;
  }
  return { ...best, effectiveCap, rects };
}
