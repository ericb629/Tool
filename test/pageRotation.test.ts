import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { viewportForPage } from '../src/renderer/src/pdf/pageViewport'

/**
 * Page rotation: the viewer's LAYOUT and the canvas's RENDER must agree.
 *
 * getViewport REPLACES a page's intrinsic /Rotate when given a rotation
 * rather than adding to it, so passing a bare 0 rendered every rotated sheet
 * turned a quarter turn, in a canvas whose portrait shape overflowed its
 * landscape slot and painted over the neighbouring pages - which looked like
 * pages randomly rendering blank.
 *
 * Sheet sets are commonly stored rotated. The Kincora set that surfaced this
 * is 138 pages: /Rotate 270 on 94 and 90 on the other 44, not one at 0.
 *
 * These exercise viewportForPage - the helper BOTH call sites now go through
 * - against real pdf.js. Asserting on getViewport directly would pass no
 * matter what the components did.
 */

/** Smallest PDF that exercises /Rotate: one page, no content needed. */
function rotatedPdf(rotate: number, width = 1728, height = 2592): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Rotate ${rotate} >>`
  ]
  let pdf = '%PDF-1.7\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(pdf, 'latin1'))
}

async function loadPage(rotate: number) {
  const doc = await getDocument({ data: rotatedPdf(rotate), disableWorker: true }).promise
  return doc.getPage(1)
}

describe('page rotation', () => {
  it.each([0, 90, 180, 270])('reports /Rotate %i and measures the page accordingly', async (rotate) => {
    const page = await loadPage(rotate)
    assert.equal(page.rotate, rotate)

    const measured = viewportForPage(page, 1)
    const quarterTurned = rotate === 90 || rotate === 270
    // A quarter turn swaps the page's width and height.
    assert.equal(Math.round(measured.width), quarterTurned ? 2592 : 1728)
    assert.equal(Math.round(measured.height), quarterTurned ? 1728 : 2592)
  })

  it.each([0, 90, 180, 270])(
    'render viewport matches the measured layout box at /Rotate %i',
    async (rotate) => {
      const page = await loadPage(rotate)
      // The layout box PdfViewer computes, and the viewport PdfPageCanvas
      // renders into. These are the two real call sites.
      const measured = viewportForPage(page, 1)

      for (const scale of [0.17, 1, 2.5, 8]) {
        const rendered = viewportForPage(page, scale)
        assert.ok(
          Math.abs(rendered.width - measured.width * scale) < 1e-9,
          `scale ${scale}: width ${rendered.width} != layout ${measured.width * scale}`
        )
        assert.ok(
          Math.abs(rendered.height - measured.height * scale) < 1e-9,
          `scale ${scale}: height ${rendered.height} != layout ${measured.height * scale}`
        )
      }
    }
  )

  it('forcing rotation to 0 disagrees with the layout on a rotated page', async () => {
    // Documents the bug: this is what the canvas used to do.
    const page = await loadPage(270)
    const scale = 2.5
    const measured = viewportForPage(page, 1)
    const forcedZero = page.getViewport({ scale, rotation: 0 })

    assert.notEqual(Math.round(forcedZero.width), Math.round(measured.width * scale))
    // The canvas came out portrait inside a landscape slot, so it overflowed
    // into the pages below it.
    assert.ok(forcedZero.height > measured.height * scale)
  })

  it('extra rotation composes with the page rotation rather than replacing it', async () => {
    const page = await loadPage(90)
    // A future user-applied 90 on a page already stored at 90 is 180 total,
    // not 90.
    const composed = viewportForPage(page, 1, 90)
    const portrait = page.getViewport({ scale: 1, rotation: 180 })
    assert.equal(Math.round(composed.width), Math.round(portrait.width))
    assert.equal(Math.round(composed.height), Math.round(portrait.height))
  })

  it('a full extra turn is the same as none', async () => {
    const page = await loadPage(270)
    const none = viewportForPage(page, 1, 0)
    const fullTurn = viewportForPage(page, 1, 360)
    assert.equal(Math.round(fullTurn.width), Math.round(none.width))
    assert.equal(Math.round(fullTurn.height), Math.round(none.height))
  })
})
