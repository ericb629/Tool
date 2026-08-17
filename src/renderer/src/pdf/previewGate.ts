/**
 * When a page's low-resolution preview is allowed to render.
 *
 * The preview waits for the page's first TILE, so the sharp layer is not
 * competing with it for animation frames. That ordering is worth having - it
 * cut preview raster from 6745ms to 3477ms across a page jump - but as first
 * written the wait had no exit: `wantsTiles && !hasTile` blocked the preview
 * FOREVER if a tile never landed, leaving the page permanently blank.
 *
 * Permanently blank is not a cosmetic problem here. A blank sheet still accepts
 * calibration and takeoff and would measure against nothing, and unlike the
 * JBIG2 decode failure there is no banner to warn anyone. It is the same class
 * of failure, without the tell.
 *
 * WHAT TRIGGERS A TILE NEVER LANDING
 *
 *   1. A tile render throws something other than a cancellation. The tile loop
 *      sets renderError and returns, so no further tiles are attempted and the
 *      first-tile signal never arrives.
 *   2. Every tile render is cancelled before it completes - a continuous zoom
 *      or pan that keeps re-running the tile effect faster than a tile renders.
 *   3. Any stall further down: a wedged worker, a decoder that never returns.
 *
 * So the gate has three exits, not one: the tile arrived, the tiles failed, or
 * we waited long enough. The deadline is the backstop for cases 2 and 3, which
 * have no error to observe.
 */

/**
 * How long the preview waits for a first tile before rendering anyway.
 *
 * 2500ms, chosen against measurements rather than taste. A dense plan sheet
 * reaches ALL tiles stable in 1654-1960ms, and the FIRST tile well before that,
 * so this rarely fires in normal use and the ordering benefit is kept. A
 * photo-collage exhibit sheet takes ~8400ms cold, so there the deadline fires
 * and the user gets a blurry page at 2.5s instead of a blank one for 8.4s.
 *
 * The cost is real and deliberately accepted: on the slowest sheets the preview
 * competes with tiles again for the remainder. Blurry-then-sharp beats blank.
 */
export const PREVIEW_DEADLINE_MS = 2500

export interface PreviewGateState {
  /** This page has a visible region, so it is going to rasterise tiles. */
  wantsTiles: boolean
  /** At least one tile has been painted for this page. */
  hasTile: boolean
  /** A tile render failed with something other than a cancellation. */
  tilesFailed: boolean
  /** PREVIEW_DEADLINE_MS has elapsed without a first tile. */
  deadlineReached: boolean
}

/**
 * True when the preview should render now.
 *
 * A page with no visible region rasterises no tiles at all, so it never waits -
 * it needs a preview ready for when it scrolls into view.
 */
export function shouldRenderPreview({
  wantsTiles,
  hasTile,
  tilesFailed,
  deadlineReached
}: PreviewGateState): boolean {
  if (!wantsTiles) return true
  return hasTile || tilesFailed || deadlineReached
}
