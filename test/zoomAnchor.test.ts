import { describe, expect, it } from 'vitest'
import {
  applyZoomAnchor,
  captureZoomAnchor,
  computePageLayout,
  pageIndexAt,
  type BasePageSize
} from '../src/renderer/src/pdf/zoomAnchor'

const PAGE_GAP = 12
const CONTAINER_WIDTH = 900
const LETTER: BasePageSize = { width: 612, height: 792 }
const WIDE: BasePageSize = { width: 1224, height: 792 }

/**
 * The invariant that matters: after a zoom, the point of the document that was
 * under the cursor is still under the cursor.
 *
 * This is checked by resolving the anchored point's content-space position in
 * the NEW layout and confirming its distance from the viewport edge is
 * unchanged. Checking the scroll offset alone would pass for a wrong layout.
 */
function cursorStaysPut(
  sizes: BasePageSize[],
  fromScale: number,
  toScale: number,
  scrollLeft: number,
  scrollTop: number,
  cx: number,
  cy: number
): { dx: number; dy: number } {
  const before = computePageLayout(sizes, fromScale, CONTAINER_WIDTH, PAGE_GAP)
  const anchor = captureZoomAnchor(before, fromScale, scrollLeft, scrollTop, cx, cy)
  if (!anchor) throw new Error('no anchor')

  const after = computePageLayout(sizes, toScale, CONTAINER_WIDTH, PAGE_GAP)
  const next = applyZoomAnchor(after, toScale, anchor)
  if (!next) throw new Error('no scroll result')

  // Where the anchored point now lives in content space, and therefore where
  // it lands on screen relative to the viewport's top-left.
  const page = after.pages[anchor.pageIndex]
  const screenX = page.left + anchor.ux * toScale - next.scrollLeft
  const screenY = page.top + anchor.uy * toScale - next.scrollTop
  return { dx: screenX - cx, dy: screenY - cy }
}

describe('cursor-anchored zoom', () => {
  it('keeps the point under the cursor fixed when zooming in', () => {
    const { dx, dy } = cursorStaysPut([LETTER], 1, 2, 0, 0, 300, 400)
    expect(dx).toBeCloseTo(0, 9)
    expect(dy).toBeCloseTo(0, 9)
  })

  it('keeps the point under the cursor fixed when zooming out', () => {
    const { dx, dy } = cursorStaysPut([LETTER], 2, 0.5, 120, 640, 455, 210)
    expect(dx).toBeCloseTo(0, 9)
    expect(dy).toBeCloseTo(0, 9)
  })

  it('stays exact deep into a multi-page document, where the gaps accumulate', () => {
    // Page 8 of 20. A content-space pixel anchor drifts by one gap per page
    // above the cursor here; this is the case that catches it.
    const sizes = Array.from({ length: 20 }, () => LETTER)
    const { dx, dy } = cursorStaysPut(sizes, 1, 1.75, 40, 792 * 7 + PAGE_GAP * 7 + 300, 500, 350)
    expect(dx).toBeCloseTo(0, 9)
    expect(dy).toBeCloseTo(0, 9)
  })

  it('stays exact when the horizontal centring offset changes with scale', () => {
    // At 0.5 the page is narrower than the container and gets centred; at 2 it
    // is wider and sits at left 0. The anchor has to survive that shift.
    const { dx } = cursorStaysPut([WIDE], 0.5, 2, 0, 0, 700, 200)
    expect(dx).toBeCloseTo(0, 9)
  })

  it('holds over a long chain of small zoom steps', () => {
    // Drift is per-step and only visible after many steps.
    const sizes = Array.from({ length: 6 }, () => LETTER)
    let scale = 1
    let scrollLeft = 30
    let scrollTop = 1500
    const cx = 420
    const cy = 260

    for (let i = 0; i < 25; i++) {
      const before = computePageLayout(sizes, scale, CONTAINER_WIDTH, PAGE_GAP)
      const anchor = captureZoomAnchor(before, scale, scrollLeft, scrollTop, cx, cy)!
      const next = scale * 1.1
      const after = computePageLayout(sizes, next, CONTAINER_WIDTH, PAGE_GAP)
      const applied = applyZoomAnchor(after, next, anchor)!

      const page = after.pages[anchor.pageIndex]
      expect(page.left + anchor.ux * next - applied.scrollLeft).toBeCloseTo(cx, 9)
      expect(page.top + anchor.uy * next - applied.scrollTop).toBeCloseTo(cy, 9)

      scale = next
      scrollLeft = applied.scrollLeft
      scrollTop = applied.scrollTop
    }
  })

  it('anchors to the nearest page when the cursor is in an inter-page gap', () => {
    const sizes = [LETTER, LETTER]
    const layout = computePageLayout(sizes, 1, CONTAINER_WIDTH, PAGE_GAP)
    // 4px into the 12px gap: nearer page 1's centre than page 2's.
    expect(pageIndexAt(layout, 792 + 4)).toBe(0)
    // Above the first page and below the last both clamp to a real page.
    expect(pageIndexAt(layout, -500)).toBe(0)
    expect(pageIndexAt(layout, 99_999)).toBe(1)
  })

  it('returns no anchor before any page exists', () => {
    const layout = computePageLayout([], 1, CONTAINER_WIDTH, PAGE_GAP)
    expect(captureZoomAnchor(layout, 1, 0, 0, 10, 10)).toBeUndefined()
  })
})

describe('page layout', () => {
  it('stacks pages with a constant gap that does not scale', () => {
    const layout = computePageLayout([LETTER, LETTER], 2, CONTAINER_WIDTH, PAGE_GAP)
    expect(layout.pages[0].top).toBe(0)
    expect(layout.pages[1].top).toBe(792 * 2 + PAGE_GAP)
    // Total excludes the trailing gap.
    expect(layout.totalHeight).toBe(792 * 2 * 2 + PAGE_GAP)
  })

  it('centres a page narrower than the container and never negatively offsets a wider one', () => {
    const narrow = computePageLayout([LETTER], 1, CONTAINER_WIDTH, PAGE_GAP)
    expect(narrow.pages[0].left).toBeCloseTo((CONTAINER_WIDTH - 612) / 2, 9)

    const wide = computePageLayout([WIDE], 2, CONTAINER_WIDTH, PAGE_GAP)
    expect(wide.pages[0].left).toBe(0)
    expect(wide.contentWidth).toBe(1224 * 2)
  })
})
