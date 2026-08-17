import { describe, expect, it } from 'vitest'
import {
  applyZoomAnchor,
  captureZoomAnchor,
  centreAnchor,
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

// ---------------------------------------------------------------------------
// Scale changes with NO cursor: fit width, fit page, and the +/- buttons.
//
// The invariant is the same one, restated for a centre anchor: the page that
// was in the middle of the viewport is still in the middle of the viewport, and
// at the same point within that page.
//
// This is the regression suite for a real bug - the fit buttons set the zoom
// mode directly and never captured an anchor at all, so scrollTop stayed put
// while every page box moved underneath it.
// ---------------------------------------------------------------------------

const CONTAINER_HEIGHT = 800

/** The Kincora set is not uniform: mixed rotations give mixed page heights. */
const MIXED: BasePageSize[] = Array.from({ length: 138 }, (_, i) =>
  i % 3 === 0 ? { width: 2592, height: 1728 } : i % 3 === 1 ? { width: 1728, height: 2592 } : LETTER
)

function pageUnderCentre(
  layout: ReturnType<typeof computePageLayout>,
  scale: number,
  scrollTop: number
): { index: number; uy: number } {
  const contentY = scrollTop + CONTAINER_HEIGHT / 2
  const index = pageIndexAt(layout, contentY)
  return { index, uy: (contentY - layout.pages[index].top) / scale }
}

function centreHolds(
  sizes: BasePageSize[],
  fromScale: number,
  toScale: number,
  scrollTop: number
): { was: { index: number; uy: number }; now: { index: number; uy: number }; requested: number; clamped: boolean } {
  const before = computePageLayout(sizes, fromScale, CONTAINER_WIDTH, PAGE_GAP)
  const was = pageUnderCentre(before, fromScale, scrollTop)

  const anchor = centreAnchor(before, fromScale, 0, scrollTop, CONTAINER_WIDTH, CONTAINER_HEIGHT)
  if (!anchor) throw new Error('no anchor')

  const after = computePageLayout(sizes, toScale, CONTAINER_WIDTH, PAGE_GAP)
  const next = applyZoomAnchor(after, toScale, anchor)
  if (!next) throw new Error('no scroll result')

  // The browser clamps a scroll write to the scrollable range; mirror that so
  // the end-of-document cases are testing what actually happens.
  const maxScroll = Math.max(0, after.totalHeight - CONTAINER_HEIGHT)
  const applied = Math.max(0, Math.min(next.scrollTop, maxScroll))
  return {
    was,
    now: pageUnderCentre(after, toScale, applied),
    requested: next.scrollTop,
    clamped: applied !== next.scrollTop
  }
}

describe('centre-anchored zoom (fit width, fit page, zoom buttons)', () => {
  const scales: Array<[string, number, number]> = [
    ['zoom in from fit-ish', 0.35, 1],
    ['zoom out to fit-ish', 1, 0.35],
    ['fit width -> fit page (a small decrease)', 0.35, 0.28],
    ['fit page -> fit width (a small increase)', 0.28, 0.35],
    ['extreme zoom out', 2, 0.05],
    ['extreme zoom in', 0.05, 2],
    ['tiny scale to tiny scale', 0.06, 0.05]
  ]

  for (const [label, from, to] of scales) {
    it(`keeps the centred page centred: ${label}`, () => {
      // Middle of a long document, where a missing anchor is most visible.
      const layout = computePageLayout(MIXED, from, CONTAINER_WIDTH, PAGE_GAP)
      const scrollTop = layout.totalHeight / 2
      const { was, now, clamped } = centreHolds(MIXED, from, to, scrollTop)
      expect(clamped).toBe(false)
      expect(now.index).toBe(was.index)
      expect(Math.abs(now.uy - was.uy)).toBeLessThan(1e-6)
    })
  }

  // At the document ends the invariant is NOT achievable, and pretending
  // otherwise would be specifying a lie. Scrolled to the top and zoomed far
  // out, the pages become shorter than half the viewport, so whatever sits at
  // the centre line is a later page and no scroll value changes that -
  // scrollTop cannot go negative. What IS required is that the anchor asks to
  // go as far as it can in the right direction, and the clamp does the rest.

  it('asks to scroll past the top at the start of the document, and clamps to 0', () => {
    const { requested, clamped } = centreHolds(MIXED, 1, 0.1, 0)
    expect(clamped).toBe(true)
    expect(requested).toBeLessThanOrEqual(0)
  })

  it('asks to scroll past the end at the end of the document, and clamps to the bottom', () => {
    const before = computePageLayout(MIXED, 1, CONTAINER_WIDTH, PAGE_GAP)
    const after = computePageLayout(MIXED, 0.4, CONTAINER_WIDTH, PAGE_GAP)
    const maxScroll = after.totalHeight - CONTAINER_HEIGHT
    const { requested } = centreHolds(MIXED, 1, before.totalHeight - CONTAINER_HEIGHT, 0.4)
    // The anchored point is near the document end, so the request must be at or
    // past the bottom - never somewhere in the middle.
    expect(requested).toBeGreaterThan(maxScroll * 0.95)
  })

  it('preserves the centred page everywhere the scroll does not clamp', () => {
    // The real coverage for the ends: walk the whole document and assert the
    // invariant wherever it is physically achievable.
    const from = 1
    const to = 0.4
    const before = computePageLayout(MIXED, from, CONTAINER_WIDTH, PAGE_GAP)
    let checked = 0
    for (let f = 0; f <= 1.0001; f += 0.02) {
      const scrollTop = (before.totalHeight - CONTAINER_HEIGHT) * f
      const { was, now, clamped } = centreHolds(MIXED, from, to, scrollTop)
      if (clamped) continue
      expect(now.index).toBe(was.index)
      expect(Math.abs(now.uy - was.uy)).toBeLessThan(1e-6)
      checked++
    }
    expect(checked).toBeGreaterThan(30)
  })

  it('holds across a fit-width / fit-page / fit-width cycle, the reported symptom', () => {
    // Press fit width, then fit page, then fit width again: the user must end up
    // where they started, not several pages away.
    const start = computePageLayout(MIXED, 0.35, CONTAINER_WIDTH, PAGE_GAP)
    const scrollTop = start.totalHeight * 0.4
    const origin = pageUnderCentre(start, 0.35, scrollTop)

    let scale = 0.35
    let top = scrollTop
    for (const next of [0.28, 0.35, 0.28, 0.35]) {
      const layout = computePageLayout(MIXED, scale, CONTAINER_WIDTH, PAGE_GAP)
      const anchor = centreAnchor(layout, scale, 0, top, CONTAINER_WIDTH, CONTAINER_HEIGHT)!
      const after = computePageLayout(MIXED, next, CONTAINER_WIDTH, PAGE_GAP)
      top = applyZoomAnchor(after, next, anchor)!.scrollTop
      scale = next
    }

    const end = pageUnderCentre(computePageLayout(MIXED, scale, CONTAINER_WIDTH, PAGE_GAP), scale, top)
    expect(end.index).toBe(origin.index)
    expect(Math.abs(end.uy - origin.uy)).toBeLessThan(1e-6)
  })

  it('DEMONSTRATES THE BUG: without an anchor, a scale change moves the user pages away', () => {
    // This is what the fit buttons did - change scale, leave scrollTop alone.
    // Kept as a test so nobody "simplifies" the buttons back to setZoomMode().
    const from = 0.35
    const to = 0.28
    const before = computePageLayout(MIXED, from, CONTAINER_WIDTH, PAGE_GAP)
    const scrollTop = before.totalHeight / 2
    const was = pageUnderCentre(before, from, scrollTop)

    const after = computePageLayout(MIXED, to, CONTAINER_WIDTH, PAGE_GAP)
    const unanchored = pageUnderCentre(after, to, scrollTop) // scrollTop untouched

    expect(unanchored.index).not.toBe(was.index)
    // Shrinking the pages sends a fixed offset FORWARD through the document,
    // which is exactly the "fit page jumps forward" symptom.
    expect(unanchored.index).toBeGreaterThan(was.index)
  })

  it('DEMONSTRATES THE BUG: the error grows with how far out you are zoomed', () => {
    const scrollFraction = 0.5
    const drift = (from: number, to: number): number => {
      const before = computePageLayout(MIXED, from, CONTAINER_WIDTH, PAGE_GAP)
      const scrollTop = before.totalHeight * scrollFraction
      const after = computePageLayout(MIXED, to, CONTAINER_WIDTH, PAGE_GAP)
      return Math.abs(
        pageUnderCentre(after, to, scrollTop).index - pageUnderCentre(before, from, scrollTop).index
      )
    }
    // Same relative scale change, applied further out: bigger jump.
    expect(drift(0.1, 0.08)).toBeGreaterThan(drift(1, 0.8))
  })
})
