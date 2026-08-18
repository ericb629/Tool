import type { UserSpaceRect } from './hitTest'

/**
 * The subset of pdf.js's TextItem this module depends on. Kept minimal and
 * pdf.js-type-free on purpose: these are pure functions over plain data, so
 * they can be unit tested without a real PDFDocumentProxy.
 *
 * `transform`'s translation (index 4, 5) is a point in the SAME default
 * PDF user-space that PdfPoint already uses in this app - traced through
 * pdf.js's worker source: getCurrentTextTransform() is built from the
 * content stream's own operators (an identity-seeded CTM), never touched by
 * viewBox or /Rotate, and PageViewport.transform (what convertToPdfPoint
 * inverts) is a separate matrix built from viewBox+scale+rotation. Inverting
 * one says nothing about the other - so no viewport step is needed here, the
 * drag box (already a PdfPoint rect) and text items are already comparable.
 * `width`/`height` are scalar magnitudes in that same space despite pdf.js's
 * "device space" wording in its own JSDoc - not screen pixels.
 */
export interface TextRun {
  str: string
  transform: number[]
  width: number
  height: number
}

/**
 * Fraction of a character box's own area that must overlap the drag rect for
 * that character to count. Overlap-fraction, not centroid: a box that clips
 * part of a glyph still catches it, one that barely grazes a corner does not.
 *
 * Tuned down from an initial 0.5 guess after real-sheet testing: at 0.5, a
 * box visually dragged around a whole word ("site") dropped its last
 * character ("sit"), and on a dense, zoomed-out sheet (profile numbers)
 * boxes missed everything. A drag box's real-world imprecision - especially
 * against small text at low zoom, where a few screen pixels of slop is a
 * large fraction of the target - means a human's box very often falls a bit
 * short of a character's true edge, hitting trailing characters hardest.
 * Biased toward inclusion: capturing a stray neighboring character is a
 * smaller failure than returning nothing.
 */
const OVERLAP_THRESHOLD = 0.2

/**
 * pdf.js's public getTextContent() returns RUNS (one item per contiguous
 * glyph sequence at uniform spacing/style), not characters, and does not
 * expose per-glyph advances - the only per-glyph hook in this pdfjs-dist
 * version (`intersector.addGlyph`, in the worker source) is private,
 * constructed internally only for annotation-highlight text hit-testing, and
 * unreachable from the main-thread API without patching pdf.js. So a run is
 * subdivided by ASSUMING uniform character width (run.width / str.length)
 * along its own direction vector - an approximation, not real glyph metrics,
 * but it is what makes a box around "24" inside "24' RCP STORM SEWER" return
 * just "24" instead of the whole run.
 */
interface CharSpan {
  char: string
  box: UserSpaceRect
}

function runToCharSpans(run: TextRun): CharSpan[] {
  const { str, transform, width, height } = run
  const n = str.length
  if (n === 0 || width === 0) return []
  const [a, b, c, d, e, f] = transform
  const dirLen = Math.hypot(a, b) || 1
  const upLen = Math.hypot(c, d) || 1
  const dirX = a / dirLen
  const dirY = b / dirLen
  const upX = c / upLen
  const upY = d / upLen
  const charWidth = width / n

  const spans: CharSpan[] = []
  for (let i = 0; i < n; i++) {
    const startAlong = i * charWidth
    const endAlong = startAlong + charWidth
    const corners = [
      { x: e + dirX * startAlong, y: f + dirY * startAlong },
      { x: e + dirX * endAlong, y: f + dirY * endAlong },
      { x: e + dirX * startAlong + upX * height, y: f + dirY * startAlong + upY * height },
      { x: e + dirX * endAlong + upX * height, y: f + dirY * endAlong + upY * height }
    ]
    spans.push({
      char: str[i],
      // Axis-aligned bounding box of the (possibly rotated) character
      // parallelogram - exact for the 0/90/180/270 rotations that appear on
      // these sheets, a safe over-approximation for any other angle.
      box: {
        minX: Math.min(corners[0].x, corners[1].x, corners[2].x, corners[3].x),
        maxX: Math.max(corners[0].x, corners[1].x, corners[2].x, corners[3].x),
        minY: Math.min(corners[0].y, corners[1].y, corners[2].y, corners[3].y),
        maxY: Math.max(corners[0].y, corners[1].y, corners[2].y, corners[3].y)
      }
    })
  }
  return spans
}

function overlapFraction(box: UserSpaceRect, rect: UserSpaceRect): number {
  const ix0 = Math.max(box.minX, rect.minX)
  const iy0 = Math.max(box.minY, rect.minY)
  const ix1 = Math.min(box.maxX, rect.maxX)
  const iy1 = Math.min(box.maxY, rect.maxY)
  if (ix1 <= ix0 || iy1 <= iy0) return 0
  const boxArea = (box.maxX - box.minX) * (box.maxY - box.minY)
  if (boxArea <= 0) return 0
  return ((ix1 - ix0) * (iy1 - iy0)) / boxArea
}

/**
 * A scanned sheet (no OCR text layer) must fail visibly rather than quietly
 * returning an empty string indistinguishable from "nothing under the box".
 * Checked once for the whole page, independent of where the box was dragged.
 */
export function pageHasTextLayer(runs: TextRun[]): boolean {
  return runs.some((run) => run.str.trim().length > 0)
}

interface PartialRun {
  text: string
  box: UserSpaceRect
}

/**
 * Extracts the text whose character boxes overlap `rect` by at least
 * `threshold`, in reading order. getTextContent() returns items in
 * content-stream paint order, not reading order, so the result is
 * reconstructed geometrically: descending Y into line buckets (PDF space is
 * Y-up, so "top" = larger Y; a new line starts when the Y gap exceeds half
 * the previous item's height), then ascending X within a line.
 */
export function extractTextInRect(runs: TextRun[], rect: UserSpaceRect, threshold = OVERLAP_THRESHOLD): string {
  const partials: PartialRun[] = []

  for (const run of runs) {
    const spans = runToCharSpans(run)
    let current: CharSpan[] = []
    const flushCurrent = (): void => {
      if (current.length === 0) return
      partials.push({
        text: current.map((s) => s.char).join(''),
        box: {
          minX: Math.min(...current.map((s) => s.box.minX)),
          maxX: Math.max(...current.map((s) => s.box.maxX)),
          minY: Math.min(...current.map((s) => s.box.minY)),
          maxY: Math.max(...current.map((s) => s.box.maxY))
        }
      })
      current = []
    }
    for (const span of spans) {
      if (overlapFraction(span.box, rect) >= threshold) {
        current.push(span)
      } else {
        flushCurrent()
      }
    }
    flushCurrent()
  }

  if (partials.length === 0) return ''

  const sorted = [...partials].sort((a, b) => b.box.minY - a.box.minY)
  const lines: PartialRun[][] = []
  for (const p of sorted) {
    const line = lines.at(-1)
    const lineHeight = line ? line[0].box.maxY - line[0].box.minY || 1 : 0
    if (line && Math.abs(line[0].box.minY - p.box.minY) <= lineHeight * 0.5) {
      line.push(p)
    } else {
      lines.push([p])
    }
  }

  return lines
    .map((line) =>
      line
        .sort((a, b) => a.box.minX - b.box.minX)
        .map((p) => p.text.trim())
        .filter(Boolean)
        .join(' ')
    )
    .filter(Boolean)
    .join(' ')
}
