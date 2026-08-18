import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { extractTextInRect, pageHasTextLayer, type TextRun } from '../src/renderer/src/pdf/textExtract'
import type { UserSpaceRect } from '../src/renderer/src/pdf/hitTest'

// Horizontal run: transform [scale,0,0,scale,e,f] with height as the row's
// vertical extent. Matches how a plain, unrotated line of text comes back
// from pdf.js - each character then occupies `width/str.length` along X.
function horizontalRun(str: string, e: number, f: number, width: number, height = 10): TextRun {
  return { str, transform: [1, 0, 0, 1, e, f], width, height }
}

const rect = (minX: number, minY: number, maxX: number, maxY: number): UserSpaceRect => ({ minX, minY, maxX, maxY })

describe('extractTextInRect', () => {
  it('returns the whole run when the box fully contains it', () => {
    const run = horizontalRun('RCP', 0, 0, 30) // 10 wide per char
    const text = extractTextInRect([run], rect(-5, -5, 35, 15))
    assert.equal(text, 'RCP')
  })

  it('returns just the covered substring of a longer dimension string - the main use case', () => {
    // "24 RCP" at 10 units/char: '2'[0,10] '4'[10,20] ' '[20,30] 'R'[30,40] 'C'[40,50] 'P'[50,60]
    const run = horizontalRun('24 RCP', 0, 0, 60)
    const text = extractTextInRect([run], rect(0, 0, 20, 10))
    assert.equal(text, '24')
  })

  it('excludes a character whose box overlaps the rect by less than the threshold', () => {
    // Single char box is x:[0,10] y:[0,10], area 100. A rect covering exactly
    // a fifth of its area (x:[0,2]) sits right at the default 0.2 threshold.
    const run = horizontalRun('A', 0, 0, 10)
    const atThreshold = extractTextInRect([run], rect(0, 0, 2, 10))
    const belowThreshold = extractTextInRect([run], rect(0, 0, 1.9, 10))
    assert.equal(atThreshold, 'A')
    assert.equal(belowThreshold, '')
  })

  it('reconstructs reading order across runs given out of paint order and multiple lines', () => {
    // Paint order deliberately scrambled: title-block acronym drawn after the
    // sheet number, both above a note on a second line.
    const title = horizontalRun('TITLE', 50, 100, 50) // same line as sheet, to the right
    const sheet = horizontalRun('SHEET', 0, 100, 50) // top line, left
    const note = horizontalRun('NOTE', 0, 50, 40) // second line, below
    const text = extractTextInRect([title, sheet, note], rect(-5, 40, 105, 115))
    assert.equal(text, 'SHEET TITLE NOTE')
  })

  it('handles 90-degree rotated text via the run direction/up vectors', () => {
    // dir=(0,1) text runs upward, up=(-1,0). A single 'A' glyph 10 units tall.
    const run: TextRun = { str: 'A', transform: [0, 10, -10, 0, 0, 0], width: 10, height: 10 }
    const text = extractTextInRect([run], rect(-15, -5, 5, 15))
    assert.equal(text, 'A')
  })

  it('returns empty when nothing overlaps', () => {
    const run = horizontalRun('RCP', 0, 0, 30)
    assert.equal(extractTextInRect([run], rect(1000, 1000, 1010, 1010)), '')
  })

  it('returns empty for an empty run list', () => {
    assert.equal(extractTextInRect([], rect(0, 0, 10, 10)), '')
  })

  // Regression: at the original 0.5 threshold, a box a real user dragged
  // around the whole word "site" - visually correct, but stopping a bit
  // short of the run's true right edge, as real drags do - dropped the
  // trailing 'e' and returned "sit". A box covering 70% of the run's width
  // (short of the full 100%, generous of the first three characters) must
  // still return the whole word.
  it('keeps the trailing character of a whole word under a slightly-short real-world drag', () => {
    // 's'[0,10] 'i'[10,20] 't'[20,30] 'e'[30,40]. A box ending at x=33 covers
    // the last character ('e') by only 30% - short of the old 0.5 threshold
    // (which is exactly the failure this reproduces: "sit" instead of
    // "site"), but within the new, drag-imprecision-tolerant one.
    const run = horizontalRun('site', 0, 0, 40)
    const text = extractTextInRect([run], rect(0, 0, 33, 10))
    assert.equal(text, 'site')
  })

  // Regression: real page-40 data from a rotated (page.rotate: 90) civil
  // sheet - a "1.5" run read via pdf.js's actual getTextContent(). Locks in
  // that a real, small, rotated, multi-character run on a dense sheet
  // extracts correctly, not just the synthetic single-glyph rotation case.
  it('extracts a real rotated multi-character run from a dense civil sheet', () => {
    const run: TextRun = {
      str: '1.5',
      transform: [0, 11.9726, -11.9941, 0, 170.5359099, 2140.9093380200015],
      width: 14.98490616000042,
      height: 11.9941
    }
    // A generous box around the run's true bounds (computed by hand from the
    // transform: dir=(0,1), up=(-1,0), so X spans [e-height, e], Y spans
    // [f, f+width]).
    const box = rect(170.5359099 - 11.9941 - 1, 2140.9093380200015 - 1, 170.5359099 + 1, 2140.9093380200015 + 14.985 + 1)
    assert.equal(extractTextInRect([run], box), '1.5')
  })
})

describe('pageHasTextLayer', () => {
  it('is true when at least one run has non-whitespace text', () => {
    assert.equal(pageHasTextLayer([horizontalRun('RCP', 0, 0, 30)]), true)
  })

  it('is false for an empty items array - a scanned page with no text layer', () => {
    assert.equal(pageHasTextLayer([]), false)
  })

  it('is false when every run is whitespace-only', () => {
    assert.equal(pageHasTextLayer([horizontalRun('   ', 0, 0, 10), horizontalRun('', 0, 0, 0)]), false)
  })
})
