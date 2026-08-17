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
  /**
   * The viewer is still rendering a page the user is actually looking at, and
   * this page is not one of them.
   *
   * An overscan page has no visible region, so it rasterises no tiles and its
   * preview would otherwise start IMMEDIATELY - building the whole operator
   * list while the destination page is still being parsed and rendered, in a
   * single-threaded worker. Measured: a jump to page 138 parses page 137
   * (5265ms) and page 138 (2429ms), and only the second is on screen.
   */
  heldForForeground: boolean
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
  deadlineReached,
  heldForForeground
}: PreviewGateState): boolean {
  // The two escape hatches win over everything, including the foreground hold.
  // Whatever else is true, a page must not be able to wait forever.
  if (deadlineReached || tilesFailed) return true
  if (heldForForeground) return false
  if (!wantsTiles) return true
  return hasTile
}

/**
 * Whether the foreground has landed, so held overscan previews may start.
 *
 * `painted` MUST mean "has content on screen right now", not "painted at some
 * point this session". It was a session-history set once, added to on a first
 * tile and never cleared - not on unmount, not on navigation, not on document
 * change - so a page that had painted counted as painted forever, even after
 * unmount destroyed its tiles and the retention LRU evicted its parse. The hold
 * therefore engaged on a page's FIRST visit and never again: on the
 * 1 -> 138 -> 1 -> 138 scenario it was active for leg 1 only, and any
 * repeat-jump measurement of it was measuring nothing.
 *
 * Kept pure and here rather than inline in the viewer because the emptiness
 * case below is the kind of thing that reads as an oversight and gets
 * "tidied up" into a bug.
 */
export function isForegroundReady(
  visiblePages: Iterable<number>,
  paintedPages: ReadonlySet<number>
): boolean {
  let anyVisible = false
  for (const pageNumber of visiblePages) {
    anyVisible = true
    if (paintedPages.has(pageNumber)) return true
  }
  // Nothing visible yet means nothing to wait for. Returning false here would
  // hold every overscan preview indefinitely on an empty or not-yet-measured
  // viewport.
  return !anyVisible
}

/**
 * Whether a page may accept pointer input - placing points, calibrating,
 * starting a takeoff.
 *
 * NOT a cosmetic guard. The overlay canvas is live as soon as the page proxy
 * resolves, because it is sized from the set of tiles the view WANTS rather
 * than the set that has rendered. Between navigation and the first tile the
 * sheet is therefore white (`.pdf-page` is `background: #fff`) and fully
 * interactive, which on a cold exhibit sheet is several seconds. A white sheet
 * is indistinguishable from a genuinely empty one, so a calibration or a
 * takeoff placed there measures against nothing and looks completely normal
 * afterwards - the same failure class as the JBIG2 decode bug, which at least
 * had a banner.
 *
 * The preview cannot close that window: it is gated behind the same first tile
 * and pays the same parse, so it has never once arrived earlier.
 */
export function canAcceptPointerInput(hasTile: boolean, hasPreview: boolean): boolean {
  return hasTile || hasPreview
}
