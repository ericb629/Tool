/**
 * Page layout and cursor-anchored zoom.
 *
 * Kept out of the component because the anchor maths is the part of zooming
 * that is easy to get subtly wrong and impossible to eyeball: an error of a
 * few pixels per step only becomes obvious after a dozen steps, by which time
 * the drawing has walked off the screen.
 */

export interface BasePageSize {
  width: number
  height: number
}

export interface PageBox {
  top: number
  left: number
  width: number
  height: number
}

export interface PageLayout {
  pages: PageBox[]
  contentWidth: number
  totalHeight: number
}

/**
 * The anchor is stored as (page index, UNSCALED offset within that page) plus
 * the cursor's position in the viewport.
 *
 * Storing a content-space pixel offset instead would be wrong: content space
 * is NOT a pure multiple of scale, because the inter-page gap is a constant
 * number of pixels at every zoom. Scaling a content offset therefore drifts
 * by one gap per page above the cursor. Re-resolving an unscaled in-page
 * offset against the freshly computed layout is exact at any zoom and any
 * page count.
 */
export interface ZoomAnchor {
  pageIndex: number
  /** Offset within the page, in unscaled page units. */
  ux: number
  uy: number
  /** Cursor position relative to the scroll viewport's top-left. */
  cx: number
  cy: number
}

export function computePageLayout(
  basePageSizes: BasePageSize[],
  scale: number,
  containerWidth: number,
  pageGap: number
): PageLayout {
  const widest = basePageSizes.reduce((max, s) => Math.max(max, s.width * scale), 0)
  const contentWidth = Math.max(containerWidth, widest)
  let offset = 0
  const pages = basePageSizes.map((size) => {
    const width = size.width * scale
    const height = size.height * scale
    const top = offset
    offset += height + pageGap
    return { top, left: Math.max(0, (contentWidth - width) / 2), width, height }
  })
  return { pages, contentWidth, totalHeight: Math.max(0, offset - pageGap) }
}

/** Which page is under this content-space Y, or the nearest one if in a gap. */
export function pageIndexAt(layout: PageLayout, contentY: number): number {
  const direct = layout.pages.findIndex((p) => contentY >= p.top && contentY <= p.top + p.height)
  if (direct !== -1) return direct
  // In a gap (or past the ends): anchor to the nearest page centre so the
  // gesture still feels pinned rather than jumping.
  return layout.pages.reduce((best, p, i) => {
    const d = Math.abs(contentY - (p.top + p.height / 2))
    const bestD = Math.abs(contentY - (layout.pages[best].top + layout.pages[best].height / 2))
    return d < bestD ? i : best
  }, 0)
}

/**
 * Capture what sits under the cursor, before the scale changes.
 * `cx`/`cy` are relative to the scroll viewport, not the window.
 */
export function captureZoomAnchor(
  layout: PageLayout,
  scale: number,
  scrollLeft: number,
  scrollTop: number,
  cx: number,
  cy: number
): ZoomAnchor | undefined {
  if (layout.pages.length === 0) return undefined
  const contentX = scrollLeft + cx
  const contentY = scrollTop + cy
  const pageIndex = pageIndexAt(layout, contentY)
  const page = layout.pages[pageIndex]
  return {
    pageIndex,
    ux: (contentX - page.left) / scale,
    uy: (contentY - page.top) / scale,
    cx,
    cy
  }
}

/**
 * Scroll offsets that put the anchored point back under the cursor, given the
 * layout recomputed at the NEW scale.
 *
 * The point's new content position is (page.left + ux * scale) and we want
 * that to sit exactly `cx` from the viewport's left edge, so the scroll offset
 * is the difference. Same for Y.
 */
export function applyZoomAnchor(
  layout: PageLayout,
  scale: number,
  anchor: ZoomAnchor
): { scrollLeft: number; scrollTop: number } | undefined {
  const page = layout.pages[anchor.pageIndex]
  if (!page) return undefined
  return {
    scrollLeft: page.left + anchor.ux * scale - anchor.cx,
    scrollTop: page.top + anchor.uy * scale - anchor.cy
  }
}
