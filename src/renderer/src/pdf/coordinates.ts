import type { PageViewport } from 'pdfjs-dist'
import type { PdfPoint } from '../../../shared/manifest'

/**
 * A point in canvas/viewport pixel space: origin top-left, Y down, and
 * meaningful ONLY for the exact viewport (zoom + rotation) that produced it.
 *
 * The `space` discriminant is a deliberate brand. PdfPoint and a raw
 * {x, y} pixel pair are structurally identical, so without it TypeScript
 * would happily let pixel coordinates flow into a MarkupGeometry or a
 * PageCalibration and be persisted - the exact bug the coordinate-integrity
 * rule exists to prevent. With it, the compiler rejects that assignment.
 *
 * Nothing outside the render boundary should hold one of these.
 */
export interface ViewportPoint {
  x: number
  y: number
  readonly space: 'viewport'
}

/**
 * Converts a pointer position (in CSS pixels relative to the page canvas)
 * into PDF user-space. Call this at the moment of capture; store the result,
 * never the pixels.
 *
 * Note this takes CSS pixels, not device pixels: the canvas is sized in
 * device pixels for sharpness (see PdfPageCanvas) but laid out in CSS pixels
 * matching viewport.width/height, and pdf.js's viewport transform is defined
 * against the latter.
 */
export function canvasToPdfPoint(viewport: PageViewport, cssX: number, cssY: number): PdfPoint {
  const [x, y] = viewport.convertToPdfPoint(cssX, cssY)
  return { x, y }
}

/**
 * Converts a stored PDF user-space point back to canvas pixels. Call this
 * only at draw time, from the freshly-current viewport - never cache the
 * result, because it is invalidated by any zoom, rotation, or resize.
 */
export function pdfPointToCanvas(viewport: PageViewport, point: PdfPoint): ViewportPoint {
  const [x, y] = viewport.convertToViewportPoint(point.x, point.y)
  return { x, y, space: 'viewport' }
}

/**
 * Convenience wrapper for a DOM pointer event: subtracts the canvas's own
 * position so callers don't hand-roll (and get wrong) the offset maths.
 *
 * `origin` is the canvas's top-left within the full page, in CSS pixels. The
 * overlay canvas covers only the on-screen region of a page rather than the
 * whole page - a full-page overlay would cross the canvas paint cliff at high
 * zoom - so a position measured against its bounding rect is short by exactly
 * this much. It defaults to the origin, which is the whole-page case.
 *
 * The conversion itself is unchanged: still viewport.convertToPdfPoint, still
 * yielding a PdfPoint. Tiling is a render-layer concern and does not move the
 * coordinate boundary.
 */
export function pointerEventToPdfPoint(
  viewport: PageViewport,
  canvas: HTMLCanvasElement,
  event: { clientX: number; clientY: number },
  origin: { x: number; y: number } = { x: 0, y: 0 }
): PdfPoint {
  const rect = canvas.getBoundingClientRect()
  return canvasToPdfPoint(
    viewport,
    event.clientX - rect.left + origin.x,
    event.clientY - rect.top + origin.y
  )
}
