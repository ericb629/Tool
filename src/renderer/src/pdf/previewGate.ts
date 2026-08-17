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
 * This is a BACKSTOP for the cases where a tile is never coming - everything
 * cancelled, or a stall - not a promise to show something quickly. It is
 * deliberately long, and 2500ms was measured to be wrong:
 *
 *   far jump to page 138 (photo collage), time to sharp
 *     deadline off / gated    8373, 8442, 8261 ms
 *     deadline 2500ms         9021 ms
 *
 * The preview on that sheet takes 6195ms to render, so firing at 2.5s put it on
 * screen at ~8.7s - the same moment the tiles arrived - while adding ~6s of
 * competing raster. It delivered nothing sooner and cost ~600ms. The idea that
 * "blurry at 2.5s beats blank at 8.4s" was simply false: the user never saw
 * blurry at 2.5s.
 *
 * SCALING IT WITH PAGE COST IS ALSO WRONG, and the data says why: the obvious
 * proxy is operator count, and it is ANTI-correlated with render cost on the
 * pages that are slow. Page 138 is 11.4k operators and ~8.4s; page 23 is 51k
 * operators and ~1.7s. Scaling on op count would shorten the deadline exactly
 * where it does the most damage.
 *
 * So: long enough never to fire on a page that is merely slow, short enough
 * that a genuinely stuck page is not blank forever. A page that is stuck is not
 * rendering anything anyway, so waiting longer there costs nothing.
 */
export const PREVIEW_DEADLINE_MS = 12_000

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
