import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import {
  TILE_BUFFER_PX,
  TILE_PX,
  expandRegion,
  intersectRegion,
  scaleTileRect,
  tileKey,
  tileSetBounds,
  tilesCovering,
  type PageRegion
} from '../src/renderer/src/pdf/tiles'

/**
 * The measured canvas paint cliff in this Electron build. Past 2^28 device
 * pixels a canvas still accepts its size and still returns a context, but
 * never paints - the page goes silently blank. The whole point of tiling is
 * that no single canvas can approach this at ANY zoom.
 */
const PAINT_CLIFF = 268_435_456

/** The Kincora sheets, in PDF points. */
const SHEET_W = 2592
const SHEET_H = 1728
/** A typical viewport, and a 4K one. */
const VIEWPORTS = [
  { width: 1400, height: 900 },
  { width: 3840, height: 2160 }
]
const ZOOMS = [0.1, 0.17, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12]
const DPRS = [1, 1.25, 1.5, 2, 3]

/** Device pixels a tile's backing store occupies. */
function tilePixels(tile: { width: number; height: number }, dpr: number): number {
  return Math.max(1, Math.round(tile.width * dpr)) * Math.max(1, Math.round(tile.height * dpr))
}

describe('tile grid', () => {
  it('covers the requested region completely', () => {
    const region: PageRegion = { left: 1500, top: 900, width: 1400, height: 700 }
    const tiles = tilesCovering(region, 20736, 13824)
    assert.ok(tiles.length > 0)
    // Every corner of the region falls inside some tile.
    for (const [x, y] of [
      [region.left, region.top],
      [region.left + region.width - 1e-6, region.top],
      [region.left, region.top + region.height - 1e-6],
      [region.left + region.width - 1e-6, region.top + region.height - 1e-6]
    ]) {
      const covering = tiles.find(
        (t) => x >= t.left && x < t.left + t.width && y >= t.top && y < t.top + t.height
      )
      assert.ok(covering, `no tile covers (${x}, ${y})`)
    }
  })

  it('never rasterises past the page edge', () => {
    const pageW = 3000
    const pageH = 2000
    const tiles = tilesCovering({ left: -500, top: -500, width: 9000, height: 9000 }, pageW, pageH)
    for (const tile of tiles) {
      assert.ok(tile.left >= 0 && tile.top >= 0, 'tile starts before the page')
      assert.ok(tile.left + tile.width <= pageW + 1e-9, 'tile runs past the page width')
      assert.ok(tile.top + tile.height <= pageH + 1e-9, 'tile runs past the page height')
      assert.ok(tile.width > 0 && tile.height > 0)
    }
    // And the whole page is covered.
    const bounds = tileSetBounds(tiles)
    assert.deepEqual(bounds, { left: 0, top: 0, width: pageW, height: pageH })
  })

  it('returns nothing for a page scrolled out of view', () => {
    assert.deepEqual(tilesCovering({ left: 5000, top: 0, width: 100, height: 100 }, 1000, 1000), [])
    assert.equal(tileSetBounds([]), undefined)
    assert.equal(intersectRegion({ left: 0, top: 0, width: 10, height: 10 }, { left: 50, top: 0, width: 10, height: 10 }), undefined)
  })

  it('NO tile approaches the paint cliff, at any zoom or dpr', () => {
    // This is the property the whole design exists for. A whole-page canvas
    // grows as scale^2 and crosses the cliff inside the app's zoom range; a
    // tile is a fixed CSS size, so its backing store never changes with zoom.
    for (const dpr of DPRS) {
      for (const zoom of ZOOMS) {
        for (const view of VIEWPORTS) {
          const pageW = SHEET_W * zoom
          const pageH = SHEET_H * zoom
          const visible: PageRegion = {
            left: Math.max(0, pageW / 2 - view.width / 2),
            top: Math.max(0, pageH / 2 - view.height / 2),
            width: Math.min(view.width, pageW),
            height: Math.min(view.height, pageH)
          }
          const tiles = tilesCovering(expandRegion(visible, TILE_BUFFER_PX), pageW, pageH)
          for (const tile of tiles) {
            const px = tilePixels(tile, dpr)
            assert.ok(
              px < PAINT_CLIFF,
              `dpr ${dpr} zoom ${zoom}: tile is ${px} px, past the paint cliff`
            )
            // Much stronger than "under the cliff": it is a constant.
            assert.ok(
              px <= Math.round(TILE_PX * dpr) ** 2,
              `dpr ${dpr} zoom ${zoom}: tile exceeded the fixed tile size`
            )
          }
        }
      }
    }
  })

  it('bounds resident tile memory by the VIEWPORT, not the page or the zoom', () => {
    // Panning a 36x24 sheet at 8x must not accumulate: the resident set is
    // whatever covers the viewport plus one buffer ring, at every zoom.
    const dpr = 2
    const view = { width: 1400, height: 900 }
    let worstBytes = 0
    let worstAt = ''
    for (const zoom of ZOOMS) {
      const pageW = SHEET_W * zoom
      const pageH = SHEET_H * zoom
      // Sweep the viewport across the page - the pan the requirement names.
      for (let x = 0; x < Math.max(1, pageW - view.width); x += view.width / 2) {
        const visible: PageRegion = {
          left: x,
          top: Math.max(0, pageH / 2 - view.height / 2),
          width: Math.min(view.width, pageW),
          height: Math.min(view.height, pageH)
        }
        const tiles = tilesCovering(expandRegion(visible, TILE_BUFFER_PX), pageW, pageH)
        const bytes = tiles.reduce((sum, t) => sum + tilePixels(t, dpr) * 4, 0)
        if (bytes > worstBytes) {
          worstBytes = bytes
          worstAt = `zoom ${zoom}, x ${Math.round(x)}`
        }
      }
    }
    // A whole-page canvas at 8x/dpr2 would be 4.4 GB. Resident tiles stay in
    // the tens of MB because only the viewport plus a buffer ring is kept.
    assert.ok(
      worstBytes < 200 * 1024 * 1024,
      `resident tiles peaked at ${(worstBytes / 1048576).toFixed(0)} MB (${worstAt})`
    )
  })

  it('keeps the overlay viewport-sized rather than page-sized', () => {
    // A full-page overlay would hit the cliff exactly like a full-page bitmap
    // and take the markups away instead of the linework.
    const dpr = 2
    const view = { width: 1400, height: 900 }
    for (const zoom of ZOOMS) {
      const pageW = SHEET_W * zoom
      const pageH = SHEET_H * zoom
      const visible: PageRegion = {
        left: Math.max(0, pageW / 2 - view.width / 2),
        top: Math.max(0, pageH / 2 - view.height / 2),
        width: Math.min(view.width, pageW),
        height: Math.min(view.height, pageH)
      }
      const bounds = tileSetBounds(tilesCovering(expandRegion(visible, TILE_BUFFER_PX), pageW, pageH))
      assert.ok(bounds)
      const px = Math.round(bounds.width * dpr) * Math.round(bounds.height * dpr)
      assert.ok(px < PAINT_CLIFF, `zoom ${zoom}: overlay is ${px} px, past the paint cliff`)
      // It tracks the viewport plus buffer and tile alignment, never the page.
      assert.ok(bounds.width <= view.width + 2 * TILE_BUFFER_PX + 2 * TILE_PX)
      assert.ok(bounds.height <= view.height + 2 * TILE_BUFFER_PX + 2 * TILE_PX)
    }
  })

  it('does not re-tile while panning inside the buffer', () => {
    // The tile set is grid-aligned, so small pans must not change it - that is
    // what keeps a pan from cancelling in-flight tile renders every frame.
    const pageW = SHEET_W * 8
    const pageH = SHEET_H * 8
    const at = (left: number): string =>
      tilesCovering(expandRegion({ left, top: 4000, width: 1400, height: 900 }, TILE_BUFFER_PX), pageW, pageH)
        .map((t) => `${t.col},${t.row}`)
        .join(' ')

    const base = at(4000)
    assert.equal(at(4008), base, 'an 8px pan changed the tile set')
    assert.equal(at(4040), base, 'a 40px pan changed the tile set')
    assert.notEqual(at(4000 + TILE_PX * 2), base, 'a large pan should change the tile set')
  })

  it('re-places a tile from a previous zoom onto the current page box', () => {
    // A zoom step invalidates every tile key at once. The outgoing generation
    // is kept on screen underneath, stretched, until the new one lands -
    // otherwise the only thing left is the 250k-pixel preview over the whole
    // page, and the sheet reads as flashing between sharp and blurred.
    const tile = { col: 1, row: 2, left: 1024, top: 2048, width: 1024, height: 800 }

    // Tile geometry and the page box are both proportional to scale, so the
    // ratio between the two scales places it exactly.
    const zoomedIn = scaleTileRect(tile, 2)
    assert.deepEqual(zoomedIn, { left: 2048, top: 4096, width: 2048, height: 1600 })

    const zoomedOut = scaleTileRect(tile, 0.5)
    assert.deepEqual(zoomedOut, { left: 512, top: 1024, width: 512, height: 400 })

    // Same scale must be identity, or a re-run of the tile effect that is not a
    // zoom would nudge the layer.
    assert.deepEqual(scaleTileRect(tile, 1), { left: 1024, top: 2048, width: 1024, height: 800 })
  })

  it('re-places from the original rect, so repeated zoom steps do not drift', () => {
    // The stale layer is re-placed on every step while it is held, so the
    // ratio is always measured against the scale it was RASTERISED at, never
    // against wherever it currently sits. Applying 1.25 five times to the
    // previous result instead would compound.
    const tile = { col: 0, row: 0, left: 0, top: 0, width: 1024, height: 1024 }
    const direct = scaleTileRect(tile, 1.25 ** 5)
    let compounded = { ...tile }
    for (let i = 0; i < 5; i++) {
      const step = scaleTileRect(compounded as typeof tile, 1.25)
      compounded = { ...compounded, ...step }
    }
    assert.ok(
      Math.abs(direct.width - compounded.width) < 1e-9,
      'compounding and direct application must agree for this to be safe either way'
    )
  })

  it('keys tiles by zoom, so a stale zoom cannot be reused', () => {
    const tile = { col: 1, row: 2, left: 1024, top: 2048, width: 1024, height: 1024 }
    assert.notEqual(tileKey(tile, 1, 0, 2), tileKey(tile, 2, 0, 2), 'scale must be part of the key')
    assert.notEqual(tileKey(tile, 1, 0, 2), tileKey(tile, 1, 90, 2), 'rotation must be part of the key')
    assert.notEqual(tileKey(tile, 1, 0, 1), tileKey(tile, 1, 0, 2), 'dpr must be part of the key')
    assert.equal(tileKey(tile, 1, 0, 2), tileKey({ ...tile }, 1, 0, 2))
  })
})
