/**
 * Tile grid for page rasterisation.
 *
 * A page is rasterised as a grid of fixed-size tiles covering only the region
 * on screen, instead of one canvas the size of the whole page at the current
 * zoom. That is what makes high zoom both sharp and bounded:
 *
 *   - A whole-page canvas grows as scale^2. A 36x24 sheet at zoom 8 is 286
 *     Mpx, past the measured 2^28 canvas paint cliff, so it silently renders
 *     blank. Clamping the backing store instead keeps it visible but soft,
 *     and soft linework means imprecise point placement - a measurement
 *     accuracy problem, not a cosmetic one.
 *   - A tile is TILE_PX CSS pixels square at EVERY zoom, so its backing store
 *     is (TILE_PX * dpr)^2 regardless of scale. Tiles therefore render at the
 *     full devicePixelRatio with no clamp, and no single canvas can approach
 *     the cliff no matter how far in the user zooms.
 *
 * Tiles are aligned to a fixed grid in page-local CSS pixels, so the set of
 * tiles a viewport needs changes only when the viewport crosses a tile
 * boundary - not on every pan frame. Panning within the buffered region does
 * no canvas work at all.
 *
 * This is a RENDER-LAYER concern only. Nothing here touches the coordinate
 * boundary: hit-testing and geometry stay in PDF user-space, converted
 * through the page's full viewport exactly as before.
 */

/** Tile edge in page-local CSS pixels at the current scale. */
export const TILE_PX = 1024

/**
 * How far beyond the visible region to keep tiles, in CSS pixels. Buys a pan
 * of this distance with no new rasterisation, at the cost of the ring of
 * tiles around the viewport. Tiles outside it are discarded, which is what
 * bounds memory while panning a large sheet at high zoom.
 */
export const TILE_BUFFER_PX = 512

export interface PageRegion {
  left: number
  top: number
  width: number
  height: number
}

export interface Tile {
  col: number
  row: number
  /** Page-local CSS pixels. Clipped to the page, so edge tiles are smaller. */
  left: number
  top: number
  width: number
  height: number
}

export function expandRegion(region: PageRegion, by: number): PageRegion {
  return {
    left: region.left - by,
    top: region.top - by,
    width: region.width + by * 2,
    height: region.height + by * 2
  }
}

export function intersectRegion(a: PageRegion, b: PageRegion): PageRegion | undefined {
  const left = Math.max(a.left, b.left)
  const top = Math.max(a.top, b.top)
  const right = Math.min(a.left + a.width, b.left + b.width)
  const bottom = Math.min(a.top + a.height, b.top + b.height)
  if (right <= left || bottom <= top) return undefined
  return { left, top, width: right - left, height: bottom - top }
}

/**
 * Largest single full-page canvas this app will rasterise, in device pixels.
 *
 * Tiling exists for two reasons and BOTH are high-zoom reasons: staying clear
 * of the 2^28 canvas paint cliff, and bounding memory when a page is far larger
 * than the viewport. At fit width neither applies - the whole page is a few
 * megapixels - and yet the page was still being cut into 2-6 canvases, each of
 * which replays the ENTIRE operator list, because pdf.js does no per-tile
 * culling. On a photo-collage sheet that is 2-6 full redraws of twelve aerials
 * to fill one screen.
 *
 * That is why zooming got slower on complicated pages and barely changed on
 * simple ones: the tax is per-tile-per-operator-type, so it scales with how
 * expensive the page's content is.
 *
 * 32 Mpx is 12% of the measured cliff (251.9 Mpx paints, 286.7 fails), so this
 * is a MEMORY bound, not a correctness one - 32 Mpx is 128 MB of backing store,
 * and the stale generation can hold a second one during a zoom. For the real
 * sheet geometry (2592x1728) a full-page canvas is 4.478M * scale^2 * dpr^2
 * device pixels, so this covers every fit-width scale at dpr 2 (0.98 -> 17.2
 * Mpx) plus a step or two beyond, and up to scale ~2.7 at dpr 1. Past it, tile.
 */
export const SINGLE_CANVAS_MAX_PIXELS = 32_000_000

/**
 * Whether this page can be rasterised as ONE canvas at the current scale.
 *
 * When it can, that is strictly better than a grid: one operator-list replay
 * instead of N, no seams, and panning cannot invalidate it because there is
 * only one cell. When it cannot, the grid earns its keep and is used unchanged.
 */
export function fitsSingleCanvas(
  pageWidth: number,
  pageHeight: number,
  dpr: number,
  budget = SINGLE_CANVAS_MAX_PIXELS
): boolean {
  const devicePixels = pageWidth * dpr * pageHeight * dpr
  return Number.isFinite(devicePixels) && devicePixels > 0 && devicePixels <= budget
}

/** The single tile covering an entire page. See fitsSingleCanvas. */
export function wholePageTile(pageWidth: number, pageHeight: number): Tile {
  return { col: 0, row: 0, left: 0, top: 0, width: pageWidth, height: pageHeight }
}

/**
 * The tiles needed to cover `region` of a page that is `pageWidth` x
 * `pageHeight` CSS pixels at the current scale. Clipped to the page, so the
 * caller never rasterises past the sheet edge.
 */
export function tilesCovering(region: PageRegion, pageWidth: number, pageHeight: number): Tile[] {
  const page: PageRegion = { left: 0, top: 0, width: pageWidth, height: pageHeight }
  const clipped = intersectRegion(region, page)
  if (!clipped) return []

  const firstCol = Math.floor(clipped.left / TILE_PX)
  const lastCol = Math.floor((clipped.left + clipped.width - 1e-6) / TILE_PX)
  const firstRow = Math.floor(clipped.top / TILE_PX)
  const lastRow = Math.floor((clipped.top + clipped.height - 1e-6) / TILE_PX)

  const tiles: Tile[] = []
  for (let row = firstRow; row <= lastRow; row++) {
    for (let col = firstCol; col <= lastCol; col++) {
      const left = col * TILE_PX
      const top = row * TILE_PX
      const width = Math.min(TILE_PX, pageWidth - left)
      const height = Math.min(TILE_PX, pageHeight - top)
      if (width <= 0 || height <= 0) continue
      tiles.push({ col, row, left, top, width, height })
    }
  }
  return tiles
}

/**
 * Bounding box of a tile set. The overlay is sized to this rather than to the
 * page: a full-page overlay would hit the same paint cliff as a full-page
 * bitmap and take the markups away instead of the linework. Because it tracks
 * the tile grid, it is re-sized only when the tile set changes, not per pan
 * frame.
 */
export function tileSetBounds(tiles: Tile[]): PageRegion | undefined {
  if (tiles.length === 0) return undefined
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const tile of tiles) {
    left = Math.min(left, tile.left)
    top = Math.min(top, tile.top)
    right = Math.max(right, tile.left + tile.width)
    bottom = Math.max(bottom, tile.top + tile.height)
  }
  return { left, top, width: right - left, height: bottom - top }
}

/**
 * Identity of a rasterised tile. Scale, rotation and dpr are all baked in, so
 * a tile from a different zoom can never be mistaken for a current one and is
 * discarded on the next reconcile.
 */
export function tileKey(tile: Tile, scale: number, rotation: number, dpr: number): string {
  return `${scale.toFixed(6)}|${rotation}|${dpr}|${tile.col}|${tile.row}`
}

/**
 * Where a tile rendered at one scale belongs on screen at another.
 *
 * A tile's geometry is page-local CSS pixels at the scale it was rasterised,
 * and the page box is itself proportional to scale, so re-placing an old tile
 * under a new scale is a single ratio applied to all four numbers. The bitmap
 * is not re-rendered - the browser stretches it - which is why this is only
 * ever used for the OUTGOING generation while the new one rasterises.
 *
 * This is the one case the "never CSS-scale a canvas to fake a zoom" rule
 * explicitly allows: the old bitmap stretched for the few frames a re-render is
 * in flight. It is bounded by being replaced the moment real tiles land, and it
 * is strictly better than the alternative - before this, a scale change
 * discarded every tile at once and left the 250k-pixel preview stretched over
 * the whole page, which at fit width is a 2.6x upscale and much worse zoomed
 * in. That read as the page flashing between sharp and blurred on every step.
 *
 * Measurement is unaffected: hit-testing and geometry go through the page
 * viewport, never through a tile.
 */
export function scaleTileRect(tile: Tile, ratio: number): PageRegion {
  return {
    left: tile.left * ratio,
    top: tile.top * ratio,
    width: tile.width * ratio,
    height: tile.height * ratio
  }
}
