import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import {
  PREVIEW_DEADLINE_MS,
  canAcceptPointerInput,
  isForegroundReady,
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
  deadlineReached: false,
  heldForForeground: false
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

  it('holds an overscan page while the foreground is still rendering', () => {
    // The parse an overscan page triggers is the whole cost being deferred:
    // jumping to page 138 parsed 137 (5265ms) and 138 (2429ms) in one
    // single-threaded worker, and only 138 was on screen.
    assert.equal(shouldRenderPreview({ ...base, wantsTiles: false, heldForForeground: true }), false)
    assert.equal(shouldRenderPreview({ ...base, wantsTiles: false, heldForForeground: false }), true)
  })

  it('lets the escape hatches override the foreground hold', () => {
    // Otherwise the hold becomes a third way to wait forever.
    assert.equal(shouldRenderPreview({ ...base, heldForForeground: true, deadlineReached: true }), true)
    assert.equal(shouldRenderPreview({ ...base, heldForForeground: true, tilesFailed: true }), true)
  })

  it('has no state in which a page waits forever', () => {
    // Exhaustive over all five booleans: a blocked state must always be one
    // that something can still resolve - a tile that may arrive, or a
    // foreground render that will finish - never a dead end.
    const bools = [true, false]
    for (const wantsTiles of bools) {
      for (const hasTile of bools) {
        for (const tilesFailed of bools) {
          for (const deadlineReached of bools) {
            for (const heldForForeground of bools) {
              const state = { wantsTiles, hasTile, tilesFailed, deadlineReached, heldForForeground }
              if (shouldRenderPreview(state)) continue
              // Blocked. The deadline must still be able to release it.
              assert.equal(
                shouldRenderPreview({ ...state, deadlineReached: true }),
                true,
                `no deadline exit from ${JSON.stringify(state)}`
              )
              assert.equal(deadlineReached, false, `blocked despite the deadline: ${JSON.stringify(state)}`)
              assert.equal(tilesFailed, false, `blocked despite tile failure: ${JSON.stringify(state)}`)
            }
          }
        }
      }
    }
  })

  it('holds until a page the user is looking at has painted', () => {
    assert.equal(isForegroundReady([138], new Set()), false)
    assert.equal(isForegroundReady([138], new Set([138])), true)
  })

  it('does not wait when nothing is visible', () => {
    // An empty or not-yet-measured viewport has no foreground to wait for.
    // Returning false here would hold every overscan preview indefinitely.
    assert.equal(isForegroundReady([], new Set()), true)
  })

  it('stops counting a page that painted and then unmounted', () => {
    // THE BUG THIS PINS. The viewer's painted set was add-only, so a page that
    // had painted once counted as painted for the rest of the session - even
    // after unmount destroyed its tiles and the retention LRU evicted its
    // parse. The hold engaged on a page's FIRST visit and never again, so on
    // 1 -> 138 -> 1 -> 138 it was doing nothing from leg 2 onwards, and any
    // repeat-jump measurement of it was measuring a gate that was not running.
    const painted = new Set([138])
    assert.equal(isForegroundReady([138], painted), true)
    painted.delete(138) // what unmount now reports
    assert.equal(isForegroundReady([138], painted), false)
  })

  it('counts any visible page, not one particular one', () => {
    // Several pages are genuinely visible on a portrait viewport, and the
    // foreground has landed as soon as ANY of them has content.
    assert.equal(isForegroundReady([100, 101, 102], new Set([101])), true)
    assert.equal(isForegroundReady([100, 101, 102], new Set([7])), false)
  })

  it('refuses pointer input until the page has content on screen', () => {
    // A white sheet is indistinguishable from an empty one, and the overlay is
    // live from the moment the page proxy resolves - so without this a cold
    // exhibit sheet accepts calibration and takeoff for several seconds while
    // showing nothing. Points placed there measure against nothing and look
    // entirely normal afterwards.
    assert.equal(canAcceptPointerInput(false, false), false)
    // Either layer landing is enough: both prove content is on screen.
    assert.equal(canAcceptPointerInput(true, false), true)
    assert.equal(canAcceptPointerInput(false, true), true)
    assert.equal(canAcceptPointerInput(true, true), true)
  })

  it('sets a deadline that cannot fire on a page which is merely slow', () => {
    // Measured: the slowest real sheet (a photo collage, cold) reaches sharp in
    // ~8400ms, and its own preview takes 6195ms to render. A deadline below that
    // fires without helping - the preview lands no earlier than the tiles - and
    // costs ~600ms of competing raster. The deadline exists for pages where a
    // tile is never coming at all, so it must sit clear of merely-slow.
    assert.ok(
      PREVIEW_DEADLINE_MS > 8400,
      `${PREVIEW_DEADLINE_MS}ms fires on sheets that are slow but working`
    )
    // And still bounded: a stuck page must not be blank indefinitely.
    assert.ok(PREVIEW_DEADLINE_MS <= 30_000, `${PREVIEW_DEADLINE_MS}ms is not a bound`)
  })
})
