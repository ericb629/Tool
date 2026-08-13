import type { PageViewport } from 'pdfjs-dist'

/**
 * The subset of PDFPageProxy this module needs. Declared structurally rather
 * than importing PDFPageProxy so the behaviour can be tested against a real
 * pdf.js page in the Node test environment without dragging in the DOM types.
 */
export interface RotatablePage {
  readonly rotate: number
  getViewport(params: { scale: number; rotation?: number }): PageViewport
}

/**
 * The ONE place a page's PageViewport is constructed.
 *
 * `getViewport({ rotation })` REPLACES the page's intrinsic /Rotate rather
 * than adding to it, so passing a bare 0 renders a rotated sheet un-rotated.
 * Sheet sets are commonly stored rotated - the Kincora set is /Rotate 270 on
 * 94 pages and 90 on the other 44, with not one page at 0 - so forcing 0
 * turned every sheet a quarter turn AND produced a portrait canvas for a
 * landscape layout slot, which overflowed and painted over the neighbouring
 * pages. That read as "some pages render blank".
 *
 * Both call sites go through here so the two can no longer drift:
 *   - PdfViewer measures the layout box with viewportForPage(page, 1)
 *   - PdfPageCanvas renders with viewportForPage(page, scale, extraRotation)
 *
 * `extraRotation` is a future user-applied rotation in degrees, applied ON TOP
 * of the page's own. A page stored at 90 that the user turns another 90 is
 * 180 total, not 90.
 */
export function viewportForPage(page: RotatablePage, scale: number, extraRotation = 0): PageViewport {
  return page.getViewport({ scale, rotation: page.rotate + extraRotation })
}

/**
 * Largest backing store this app will allocate for a single page canvas, in
 * device pixels.
 *
 * MEASURED, not read off a spec: in this Electron build a 2D canvas larger
 * than 2^28 px (268,435,456) still reports back the width and height you set
 * and still returns a drawing context - it simply never paints. Everything
 * drawn into it reads back fully transparent, and nothing throws, so the page
 * goes silently blank with no error to catch. Probed on the real 36x24 sheet
 * geometry (2592 x 1728 pt): largest canvas that paints is 251.9 Mpx, and the
 * first that fails is 286.7 Mpx.
 *
 * That cliff sits INSIDE the app's own zoom range - a 36x24 sheet crosses it
 * at zoom 8 on a 1.0 dpr display, at zoom 6 on 1.5, and at zoom 4 on 2.0,
 * while ZOOM_STEPS goes to 8 and MAX_SCALE to 12.
 *
 * The budget below is set well under the cliff on MEMORY grounds rather than
 * correctness grounds: at 64 Mpx one backing store is already 256 MB, and the
 * virtualized window holds several pages at once, each with a page canvas and
 * an overlay canvas, plus a transient off-screen copy of the page being
 * re-rendered.
 *
 * Past this point the page is rendered at a lower device resolution and
 * scaled up by the browser, so extreme zoom degrades to SOFT rather than
 * blank. Keeping linework crisp at that zoom needs tiled rendering - drawing
 * only the visible region of the page instead of the whole sheet - which this
 * app does not do.
 */
export const MAX_CANVAS_PIXELS = 64_000_000

/**
 * The device-pixel ratio to actually render a page at: the display's, unless
 * that would exceed the canvas budget, in which case the largest ratio that
 * fits.
 *
 * Returns a ratio rather than a pixel size so the page bitmap and the overlay
 * can be clamped identically. They must agree: clamping only the page bitmap
 * would leave the overlay canvas over the paint cliff and take the markups
 * away instead of the linework.
 */
export function deviceScaleFor(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  budget = MAX_CANVAS_PIXELS
): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  const cssArea = cssWidth * cssHeight
  if (!Number.isFinite(cssArea) || cssArea <= 0) return dpr
  return Math.min(dpr, Math.sqrt(budget / cssArea))
}
