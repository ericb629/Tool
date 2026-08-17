import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { computePageLayout } from '../src/renderer/src/pdf/zoomAnchor'
import { TILE_BUFFER_PX, expandRegion, intersectRegion, tilesCovering } from '../src/renderer/src/pdf/tiles'

/**
 * HOW MANY PAGES ARE ACTUALLY VISIBLE AFTER A PAGE JUMP.
 *
 * This exists because a proposal was built on the belief that a fit-width jump
 * to page 138 leaves 137 and 138 "both genuinely visible", so both parse on the
 * critical path, and that prioritising the primary page over other VISIBLE
 * pages would close the gap. The arithmetic says otherwise, and the arithmetic
 * is cheap to run, so it is pinned here rather than re-argued.
 *
 * Geometry is the real Kincora set, read off the file: all 138 pages measure
 * 2592x1728 after /Rotate is applied (94 at 270, 44 at 90). Uniform size is
 * what makes this decidable - `referenceSize` never changes, so the fit-width
 * scale does not move when the current page changes, and the layout is a plain
 * uniform grid.
 *
 * A 3:2 page at fit width is TALLER than any landscape viewport: page height is
 * availableWidth / 1.5, so a second page can only appear when the viewport is
 * narrower than 1.5x its own height - a portrait window. On every landscape
 * window the destination page covers ~98% of the viewport ON ITS OWN and its
 * neighbour has no visible region at all, which means it is already overscan
 * and already held by the existing two-tier preview gate.
 */

const KINCORA_PAGE = { width: 2592, height: 1728 }
const PAGE_GAP = 12
/** The viewer's own fit-width margin - see PdfViewer's `scale` memo. */
const FIT_WIDTH_MARGIN = 24

/** Landscape viewports, from a small laptop to a large desktop. */
const LANDSCAPE = [
  [1280, 700],
  [1600, 820],
  [1920, 980],
  [2560, 1300]
] as const

interface Jump {
  /** Page-local visible region of each page with one, keyed by page number. */
  regions: Map<number, { left: number; top: number; width: number; height: number }>
  layout: ReturnType<typeof computePageLayout>
}

/** Reproduces what the viewer does on `scrollTo({ top: target.top })`. */
function jumpTo(pageNumber: number, containerWidth: number, containerHeight: number, pageCount = 138): Jump {
  const sizes = Array.from({ length: pageCount }, () => KINCORA_PAGE)
  const scale = Math.max(50, containerWidth - FIT_WIDTH_MARGIN) / KINCORA_PAGE.width
  const layout = computePageLayout(sizes, scale, containerWidth, PAGE_GAP)
  // The browser clamps scrollTop to the scrollable range, which matters when
  // the target is near the end of the document.
  const scrollTop = Math.min(
    layout.pages[pageNumber - 1].top,
    Math.max(0, layout.totalHeight - containerHeight)
  )
  const view = { left: 0, top: scrollTop, width: containerWidth, height: containerHeight }
  const regions = new Map<number, { left: number; top: number; width: number; height: number }>()
  layout.pages.forEach((page, index) => {
    const overlap = intersectRegion(view, page)
    if (!overlap) return
    regions.set(index + 1, {
      left: overlap.left - page.left,
      top: overlap.top - page.top,
      width: overlap.width,
      height: overlap.height
    })
  })
  return { regions, layout }
}

describe('pages visible after a jump, at fit width', () => {
  it('leaves exactly one page visible on every landscape viewport', () => {
    for (const [cw, ch] of LANDSCAPE) {
      const { regions } = jumpTo(138, cw, ch)
      assert.deepEqual(
        [...regions.keys()],
        [138],
        `viewport ${cw}x${ch}: expected only the destination page to be visible`
      )
    }
  })

  it('gives the destination page ~98% of the viewport on its own', () => {
    for (const [cw, ch] of LANDSCAPE) {
      const region = jumpTo(138, cw, ch).regions.get(138)!
      const coverage = (region.width * region.height) / (cw * ch)
      // There is no second visible page to take viewport share FROM, so a
      // coverage threshold separating a "primary" page from a lesser visible
      // one has nothing to separate: any threshold under this is inert, and
      // any threshold over it would defer the page the user navigated to.
      assert.ok(coverage > 0.98, `viewport ${cw}x${ch}: coverage ${(coverage * 100).toFixed(1)}%`)
    }
  })

  it('holds for a mid-document jump too, not just the last page', () => {
    // The last page is the one case where scrollTop gets clamped, so check a
    // page that is nowhere near the end and cannot be clamped.
    for (const [cw, ch] of LANDSCAPE) {
      assert.deepEqual([...jumpTo(70, cw, ch).regions.keys()], [70], `viewport ${cw}x${ch}`)
    }
  })

  it('needs a portrait viewport before a second page appears', () => {
    // Stated as the boundary rather than as a magic number: a second page can
    // only share the viewport once the viewport is taller than a page, and a
    // page at fit width is availableWidth / 1.5 tall.
    const [cw, ch] = [1000, 1400]
    const visible = [...jumpTo(100, cw, ch).regions.keys()]
    assert.ok(visible.length > 1, `expected several pages visible on a portrait viewport, got ${visible}`)
    assert.ok(cw / ch < 1.5, 'this only happens on a viewport narrower than the 3:2 page aspect')
  })

  it('wants several tiles, so releasing on the FIRST tile protects only part of the render', () => {
    // This is what is left of the original problem once co-visibility is ruled
    // out. `foregroundReady` flips as soon as the destination paints tile 1, so
    // the held neighbour's parse is released while tiles 2..N are still going.
    for (const [cw, ch] of LANDSCAPE) {
      const { regions, layout } = jumpTo(138, cw, ch)
      const page = layout.pages[137]
      const tiles = tilesCovering(expandRegion(regions.get(138)!, TILE_BUFFER_PX), page.width, page.height)
      assert.ok(tiles.length >= 2, `viewport ${cw}x${ch}: ${tiles.length} tile(s)`)
    }
  })
})
