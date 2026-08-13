import { strict as assert } from 'node:assert'
import { beforeAll, describe, it } from 'vitest'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { deriveQuantity } from '../src/shared/manifest/quantity'
import { pointerEventToPdfPoint } from '../src/renderer/src/pdf/coordinates'
import type { MarkupObject, PageCalibration, PdfPoint } from '../src/shared/manifest/types'

// These tests exercise the REAL pdf.js PageViewport, not a stand-in, because
// the whole coordinate-integrity design rests on the assumption that
// convertToPdfPoint / convertToViewportPoint are exact inverses at any zoom
// and rotation. If that assumption ever breaks, persisted PdfPoints stop
// meaning what the schema says they mean.

// A minimal in-memory PDF: US Letter (612x792), origin at (0,0).
function buildPdf(mediaBox = '[0 0 612 792]'): Uint8Array {
  const content = '72 600 m 360 600 l S\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox ${mediaBox} /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}endstream`
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefStart = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  return new Uint8Array(Buffer.from(pdf, 'latin1'))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let page: any

beforeAll(async () => {
  const doc = await getDocument({ data: buildPdf(), disableWorker: true }).promise
  page = await doc.getPage(1)
})

/** Mirrors exactly what PdfEditorPanel does on pointerdown. */
function pointerToPdfPoint(viewport: { convertToPdfPoint(x: number, y: number): number[] }, canvasX: number, canvasY: number): PdfPoint {
  const [x, y] = viewport.convertToPdfPoint(canvasX, canvasY)
  return { x, y }
}

describe('pointer -> PDF user-space conversion', () => {
  it('places the canvas top-left at the top of the page in user-space (Y is flipped)', () => {
    const viewport = page.getViewport({ scale: 1 })
    const topLeft = pointerToPdfPoint(viewport, 0, 0)
    // Canvas Y grows down, PDF user-space Y grows up: canvas (0,0) is the
    // TOP of the page, i.e. user-space y = page height.
    assert.equal(Math.abs(topLeft.x), 0)
    assert.equal(topLeft.y, 792)

    const bottomLeft = pointerToPdfPoint(viewport, 0, 792)
    assert.equal(Math.abs(bottomLeft.y), 0)
  })

  it('round-trips a user-space point through canvas space unchanged at scale 1', () => {
    const viewport = page.getViewport({ scale: 1 })
    const original: PdfPoint = { x: 72, y: 600 }
    const [cx, cy] = viewport.convertToViewportPoint(original.x, original.y)
    const roundTripped = pointerToPdfPoint(viewport, cx, cy)
    assert.ok(Math.abs(roundTripped.x - original.x) < 1e-9)
    assert.ok(Math.abs(roundTripped.y - original.y) < 1e-9)
  })

  for (const scale of [0.25, 0.5, 1, 1.5, 2, 4]) {
    it(`round-trips unchanged at zoom ${scale}x`, () => {
      const viewport = page.getViewport({ scale })
      for (const original of [
        { x: 0, y: 0 },
        { x: 72, y: 600 },
        { x: 306, y: 396 },
        { x: 612, y: 792 }
      ]) {
        const [cx, cy] = viewport.convertToViewportPoint(original.x, original.y)
        const back = pointerToPdfPoint(viewport, cx, cy)
        assert.ok(Math.abs(back.x - original.x) < 1e-9, `x drifted at scale ${scale}`)
        assert.ok(Math.abs(back.y - original.y) < 1e-9, `y drifted at scale ${scale}`)
      }
    })
  }

  for (const rotation of [0, 90, 180, 270]) {
    it(`round-trips unchanged at rotation ${rotation} degrees`, () => {
      const viewport = page.getViewport({ scale: 1.5, rotation })
      const original: PdfPoint = { x: 72, y: 600 }
      const [cx, cy] = viewport.convertToViewportPoint(original.x, original.y)
      const back = pointerToPdfPoint(viewport, cx, cy)
      assert.ok(Math.abs(back.x - original.x) < 1e-9, `x drifted at rotation ${rotation}`)
      assert.ok(Math.abs(back.y - original.y) < 1e-9, `y drifted at rotation ${rotation}`)
    })
  }

  it('yields the SAME user-space point for the same physical spot at different zooms', () => {
    // The identical page location, clicked at 1x and at 2x, must produce
    // identical stored coordinates - this is the property that makes stored
    // PdfPoints zoom-independent.
    const vp1 = page.getViewport({ scale: 1 })
    const vp2 = page.getViewport({ scale: 2 })
    const target: PdfPoint = { x: 200, y: 500 }

    const [x1, y1] = vp1.convertToViewportPoint(target.x, target.y)
    const [x2, y2] = vp2.convertToViewportPoint(target.x, target.y)

    const from1x = pointerToPdfPoint(vp1, x1, y1)
    const from2x = pointerToPdfPoint(vp2, x2, y2)

    assert.ok(Math.abs(from1x.x - from2x.x) < 1e-9)
    assert.ok(Math.abs(from1x.y - from2x.y) < 1e-9)
  })
})

describe('quantities are zoom-invariant end to end', () => {
  const calibration: PageCalibration = {
    pageNumber: 1,
    pointA: { x: 72, y: 600 },
    pointB: { x: 360, y: 600 }, // 288 user-space units apart
    realDistance: 4,
    unit: 'in'
  }

  function markupFrom(points: PdfPoint[]): MarkupObject {
    return {
      id: 'm1',
      pageNumber: 1,
      layerId: 'l1',
      type: 'polyline',
      takeoff: { mode: 'linear', unit: 'in' },
      geometry: { kind: 'polyline', points },
      style: { color: '#000' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
  }

  it('gives the same measurement whether drawn at 1x or 4x zoom', () => {
    // Draw the "same" line by clicking two physical page locations, once on
    // a 1x canvas and once on a 4x canvas.
    const a: PdfPoint = { x: 100, y: 100 }
    const b: PdfPoint = { x: 400, y: 500 }

    const drawAt = (scale: number): MarkupObject => {
      const vp = page.getViewport({ scale })
      const [ax, ay] = vp.convertToViewportPoint(a.x, a.y)
      const [bx, by] = vp.convertToViewportPoint(b.x, b.y)
      return markupFrom([pointerToPdfPoint(vp, ax, ay), pointerToPdfPoint(vp, bx, by)])
    }

    const at1x = deriveQuantity(drawAt(1), { pageNumber: 1, calibration })
    const at4x = deriveQuantity(drawAt(4), { pageNumber: 1, calibration })

    assert.equal(at1x.status, 'ok')
    assert.equal(at4x.status, 'ok')
    if (at1x.status !== 'ok' || at4x.status !== 'ok') return
    assert.ok(Math.abs(at1x.value - at4x.value) < 1e-9, 'measurement changed with zoom level')
  })

  it('measures the known 288-unit calibration line as exactly 4 inches', () => {
    const line = markupFrom([calibration.pointA, calibration.pointB])
    const result = deriveQuantity(line, { pageNumber: 1, calibration })
    assert.equal(result.status, 'ok')
    if (result.status !== 'ok') return
    assert.ok(Math.abs(result.value - 4) < 1e-9, `expected 4 in, got ${result.value}`)
  })

  it('derives 1 inch per 72 user-space units (PDF default user unit)', () => {
    // 720 units should be 10 inches under this calibration.
    const line = markupFrom([{ x: 0, y: 0 }, { x: 720, y: 0 }])
    const result = deriveQuantity(line, { pageNumber: 1, calibration })
    assert.equal(result.status, 'ok')
    if (result.status !== 'ok') return
    assert.ok(Math.abs(result.value - 10) < 1e-9, `expected 10 in, got ${result.value}`)
  })
})

describe('non-zero-origin MediaBox', () => {
  it('reports user-space coordinates relative to the page viewBox origin', async () => {
    // Civil sheets are not always origin-at-zero. convertToPdfPoint must
    // account for the viewBox offset, otherwise every stored point on such a
    // sheet is silently shifted.
    const doc = await getDocument({ data: buildPdf('[10 20 622 812]'), disableWorker: true }).promise
    const offsetPage = await doc.getPage(1)
    assert.deepEqual(offsetPage.view, [10, 20, 622, 812])

    const viewport = offsetPage.getViewport({ scale: 1 })
    const topLeft = pointerToPdfPoint(viewport, 0, 0)
    assert.ok(Math.abs(topLeft.x - 10) < 1e-9, `expected x origin 10, got ${topLeft.x}`)
    assert.ok(Math.abs(topLeft.y - 812) < 1e-9, `expected y top 812, got ${topLeft.y}`)

    // And it still round-trips.
    const original: PdfPoint = { x: 100, y: 200 }
    const [cx, cy] = viewport.convertToViewportPoint(original.x, original.y)
    const back = pointerToPdfPoint(viewport, cx, cy)
    assert.ok(Math.abs(back.x - original.x) < 1e-9)
    assert.ok(Math.abs(back.y - original.y) < 1e-9)
  })
})

describe('windowed overlay origin', () => {
  /**
   * The overlay canvas covers only the on-screen region of a page, not the
   * whole page - a full-page overlay would cross the canvas paint cliff at
   * high zoom. That means a pointer position measured against the overlay's
   * bounding rect is short by the overlay's origin within the page, and
   * pointerEventToPdfPoint has to add it back.
   *
   * If this is wrong, every point placed at high zoom lands somewhere else on
   * the sheet and every quantity derived from it is wrong while looking
   * entirely plausible. Tiling must not move the coordinate boundary.
   */
  function fakeCanvas(rectLeft: number, rectTop: number): HTMLCanvasElement {
    return {
      getBoundingClientRect: () => ({ left: rectLeft, top: rectTop })
    } as unknown as HTMLCanvasElement
  }

  it('lands on the same PdfPoint as a whole-page overlay would', async () => {
    const doc = await getDocument({ data: buildPdf(), disableWorker: true }).promise
    const page = await doc.getPage(1)
    const viewport = page.getViewport({ scale: 8 })

    // A page-local CSS position, and a click on it.
    const pageX = 3000
    const pageY = 2100
    const expected = pointerToPdfPoint(viewport, pageX, pageY)

    // Whole-page overlay: canvas pinned to the page's top-left on screen.
    const pageScreenLeft = -2400
    const pageScreenTop = -1800
    const whole = pointerEventToPdfPoint(viewport, fakeCanvas(pageScreenLeft, pageScreenTop), {
      clientX: pageScreenLeft + pageX,
      clientY: pageScreenTop + pageY
    })
    assert.ok(Math.abs(whole.x - expected.x) < 1e-9)
    assert.ok(Math.abs(whole.y - expected.y) < 1e-9)

    // Windowed overlay: canvas starts at (2048, 1024) within the page, so on
    // screen it sits that much further right and down.
    const origin = { x: 2048, y: 1024 }
    const windowed = pointerEventToPdfPoint(
      viewport,
      fakeCanvas(pageScreenLeft + origin.x, pageScreenTop + origin.y),
      { clientX: pageScreenLeft + pageX, clientY: pageScreenTop + pageY },
      origin
    )
    assert.ok(Math.abs(windowed.x - expected.x) < 1e-9, `x drifted: ${windowed.x} vs ${expected.x}`)
    assert.ok(Math.abs(windowed.y - expected.y) < 1e-9, `y drifted: ${windowed.y} vs ${expected.y}`)
  })

  it('agrees across zooms and overlay origins', async () => {
    const doc = await getDocument({ data: buildPdf(), disableWorker: true }).promise
    const page = await doc.getPage(1)

    for (const scale of [0.25, 1, 8, 12]) {
      const viewport = page.getViewport({ scale })
      for (const origin of [{ x: 0, y: 0 }, { x: 1024, y: 512 }, { x: 3072, y: 2048 }]) {
        const target: PdfPoint = { x: 300, y: 400 }
        const [cx, cy] = viewport.convertToViewportPoint(target.x, target.y)
        // The overlay sits at `origin` in the page; the page's top-left is at
        // screen 0,0 here, so the canvas rect starts at the origin.
        const back = pointerEventToPdfPoint(
          viewport,
          fakeCanvas(origin.x, origin.y),
          { clientX: cx, clientY: cy },
          origin
        )
        assert.ok(
          Math.abs(back.x - target.x) < 1e-9 && Math.abs(back.y - target.y) < 1e-9,
          `scale ${scale} origin ${origin.x},${origin.y}: got ${back.x},${back.y}`
        )
      }
    }
  })
})
