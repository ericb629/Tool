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
 */
export function pointerEventToPdfPoint(
  viewport: PageViewport,
  canvas: HTMLCanvasElement,
  event: { clientX: number; clientY: number }
): PdfPoint {
  const rect = canvas.getBoundingClientRect()
  return canvasToPdfPoint(viewport, event.clientX - rect.left, event.clientY - rect.top)
}
