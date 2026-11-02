// dsh-image-tiler: the pixel pipeline. The only module in this package that
// imports sharp (and the reason sharp is a direct dependency: it is an
// implementation detail of this package, not a harness singleton — a second
// copy of sharp cannot split any entry or context identity).
//
// Everything here is dumb on purpose: decode/probe bytes, cut rectangles,
// PNG-encode them. All decisions live in grid.mjs / handler.mjs.

import sharp from 'sharp';

/**
 * Probe one encoded image.
 * @returns {{ width, height, animated }} `animated` is true when the raster
 *   carries more than one frame (animated GIF/WebP, multi-page TIFF): those
 *   cannot be tiled without dropping frames, so the caller keeps the original.
 */
export async function probeImage(data) {
  const meta = await sharp(data, { animated: true }).metadata();
  if (!Number.isInteger(meta.width) || !Number.isInteger(meta.height)) {
    throw new Error('image dimensions could not be probed');
  }
  const pages = meta.pages ?? (Array.isArray(meta.pageNames) ? meta.pageNames.length : 1);
  return { width: meta.width, height: meta.height, animated: pages > 1 };
}

/**
 * Cut the rectangles out of one encoded image and PNG-encode each tile.
 * Decoding per rectangle keeps the code simple and the peak memory bounded;
 * screenshots at these sizes decode in milliseconds.
 * @param {Uint8Array} data - the encoded source image.
 * @param {Array<{left, top, width, height}>} rects - tile rectangles.
 * @returns {Promise<Uint8Array[]>} PNG bytes in rectangle order.
 */
export async function extractTilePngs(data, rects) {
  const tiles = [];
  for (const rect of rects) {
    const buf = await sharp(data)
      .extract({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
      .png()
      .toBuffer();
    tiles.push(new Uint8Array(buf));
  }
  return tiles;
}
