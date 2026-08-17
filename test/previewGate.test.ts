import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import {
  PREVIEW_DEADLINE_MS,
  shouldRenderPreview,
  type PreviewGateState
} from '../src/renderer/src/pdf/previewGate'

/**
 * The failure this pins: the gate had one exit, so a page whose tile never
 * landed never rendered its preview and stayed permanently blank. A blank sheet
 * still accepts calibration and takeoff, so this is a correctness test, not a
 * cosmetic one.
 */

const base: PreviewGateState = {
  wantsTiles: true,
  hasTile: false,
  tilesFailed: false,
  deadlineReached: false
}

describe('preview gate', () => {
  it('renders immediately for a page that will never rasterise tiles', () => {
    // An overscan page has no visible region. It has nothing to wait for and
    // needs a preview ready for when it scrolls into view.
    assert.equal(shouldRenderPreview({ ...base, wantsTiles: false }), true)
  })

  it('waits for the first tile on a page that is going to rasterise', () => {
    assert.equal(shouldRenderPreview(base), false)
  })

  it('renders once the first tile lands', () => {
    assert.equal(shouldRenderPreview({ ...base, hasTile: true }), true)
  })

  it('renders when the tiles failed, so an error does not leave the page blank', () => {
    // Trigger 1: a tile render throws something other than a cancellation. The
    // tile loop returns and no further tiles are attempted, so waiting for a
    // first tile would wait forever.
    assert.equal(shouldRenderPreview({ ...base, tilesFailed: true }), true)
  })

  it('renders when the deadline passes, covering stalls with no error to observe', () => {
    // Triggers 2 and 3: every tile cancelled by continuous zoom, or a wedged
    // worker. Nothing throws, so only a deadline can break the wait.
    assert.equal(shouldRenderPreview({ ...base, deadlineReached: true }), true)
  })

  it('has no state in which a page waits forever', () => {
    // Exhaustive over the four booleans: whenever the page is not simply
    // waiting for a tile that may still arrive, the preview must render.
    for (const wantsTiles of [true, false]) {
      for (const hasTile of [true, false]) {
        for (const tilesFailed of [true, false]) {
          for (const deadlineReached of [true, false]) {
            const state = { wantsTiles, hasTile, tilesFailed, deadlineReached }
            const blocked = !shouldRenderPreview(state)
            if (!blocked) continue
            assert.deepEqual(
              state,
              { wantsTiles: true, hasTile: false, tilesFailed: false, deadlineReached: false },
              `blocked in a state that has no exit: ${JSON.stringify(state)}`
            )
          }
        }
      }
    }
  })

  it('sets a deadline above a normal first tile and below the slowest sheet', () => {
    // Measured: plan sheets reach ALL tiles stable in 1654-1960ms and the first
    // tile sooner; photo-collage sheets take ~8400ms cold. The deadline has to
    // sit between those or it either fires constantly or bounds nothing.
    assert.ok(PREVIEW_DEADLINE_MS > 1960, `${PREVIEW_DEADLINE_MS}ms would fire on normal sheets`)
    assert.ok(PREVIEW_DEADLINE_MS < 8400, `${PREVIEW_DEADLINE_MS}ms would not bound a slow sheet`)
  })
})
