import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { MAX_CANVAS_PIXELS, deviceScaleFor } from '../src/renderer/src/pdf/pageViewport'

/**
 * The canvas paint cliff.
 *
 * MEASURED in this Electron build, not read off a spec: a 2D canvas larger
 * than 2^28 device pixels still accepts the width/height you set and still
 * returns a context, but never paints - everything read back is transparent
 * and nothing throws. The page just goes blank.
 *
 * Probe results on the real 36x24 sheet geometry (2592 x 1728 pt):
 *   dpr 1.00, zoom 6  -> 15552 x 10368 = 161.2 Mpx  OK
 *   dpr 1.25, zoom 6  -> 19440 x 12960 = 251.9 Mpx  OK   (largest that painted)
 *   dpr 1.00, zoom 8  -> 20736 x 13824 = 286.7 Mpx  BLANK (smallest that failed)
 *   dpr 1.50, zoom 6  -> 23328 x 15552 = 362.8 Mpx  BLANK
 *   dpr 2.00, zoom 4  -> 20736 x 13824 = 286.7 Mpx  BLANK
 */
const MEASURED_PAINT_CLIFF = 268_435_456

/** The 36x24 sheets in the Kincora set, in PDF points. */
const SHEET_W = 2592
const SHEET_H = 1728
/** PdfViewer's ZOOM_STEPS, plus MAX_SCALE at the end. */
const ZOOM_STEPS = [0.1, 0.17, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12]
const DPRS = [1, 1.25, 1.5, 2, 3]

describe('canvas budget', () => {
  it('leaves the device-pixel ratio alone when the page fits', () => {
    // A letter page at 100% is nowhere near the budget.
    assert.equal(deviceScaleFor(612, 792, 2), 2)
    assert.equal(deviceScaleFor(1296, 864, 1.5), 1.5)
  })

  it('never exceeds the budget, at any zoom or dpr, on a real 36x24 sheet', () => {
    for (const dpr of DPRS) {
      for (const zoom of ZOOM_STEPS) {
        const cssW = SHEET_W * zoom
        const cssH = SHEET_H * zoom
        const s = deviceScaleFor(cssW, cssH, dpr)
        const pixels = Math.floor(cssW * s) * Math.floor(cssH * s)
        assert.ok(
          pixels <= MAX_CANVAS_PIXELS,
          `dpr ${dpr} zoom ${zoom}: ${pixels} px exceeds the ${MAX_CANVAS_PIXELS} budget`
        )
        // The budget is set below the cliff on memory grounds, so this is the
        // property that actually matters: the page never goes blank.
        assert.ok(
          pixels < MEASURED_PAINT_CLIFF,
          `dpr ${dpr} zoom ${zoom}: ${pixels} px is past the measured paint cliff - page renders blank`
        )
      }
    }
  })

  it('reproduces the combinations that measured blank before the clamp', () => {
    // Each of these allocated a canvas that silently refused to paint.
    for (const [dpr, zoom] of [
      [1, 8],
      [1.25, 8],
      [1.5, 6],
      [2, 4],
      [2, 12]
    ] as const) {
      const cssW = SHEET_W * zoom
      const cssH = SHEET_H * zoom
      assert.ok(cssW * cssH * dpr * dpr > MEASURED_PAINT_CLIFF, `dpr ${dpr} zoom ${zoom} should be a known-bad case`)
      const clamped = deviceScaleFor(cssW, cssH, dpr)
      assert.ok(clamped < dpr, `dpr ${dpr} zoom ${zoom} should have been clamped`)
      assert.ok(cssW * clamped * (cssH * clamped) <= MAX_CANVAS_PIXELS)
    }
  })

  it('degrades below 1:1 rather than blanking when even that would not fit', () => {
    // At MAX_SCALE the sheet is 645 Mpx in CSS pixels alone, so the backing
    // store has to be smaller than the layout box. Soft, but visible.
    const cssW = SHEET_W * 12
    const cssH = SHEET_H * 12
    const s = deviceScaleFor(cssW, cssH, 1)
    assert.ok(s < 1, 'expected sub-1:1 rendering at max zoom')
    assert.ok(s > 0, 'must stay positive - a zero-size canvas is the blank page again')
    assert.ok(cssW * s * (cssH * s) <= MAX_CANVAS_PIXELS)
  })

  it('is monotonic: zooming in never increases the backing-store ratio', () => {
    let previous = Infinity
    for (const zoom of ZOOM_STEPS) {
      const s = deviceScaleFor(SHEET_W * zoom, SHEET_H * zoom, 2)
      assert.ok(s <= previous + 1e-12, `ratio rose from ${previous} to ${s} at zoom ${zoom}`)
      previous = s
    }
  })

  it('survives degenerate inputs instead of producing NaN', () => {
    // A zero-sized or not-yet-measured page must not poison the canvas size.
    assert.equal(deviceScaleFor(0, 0, 2), 2)
    assert.equal(deviceScaleFor(-10, 100, 2), 2)
    assert.equal(deviceScaleFor(Number.NaN, 100, 2), 2)
    // devicePixelRatio itself is untrusted: 0 would render a zero-px canvas.
    assert.equal(deviceScaleFor(612, 792, 0), 1)
    assert.equal(deviceScaleFor(612, 792, Number.NaN), 1)
    assert.equal(deviceScaleFor(612, 792, -2), 1)
  })
})
