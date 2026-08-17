import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy, PDFPageProxy, PageViewport, RenderTask } from 'pdfjs-dist'
import { deviceScaleFor, viewportForPage } from '../pdf/pageViewport'
import { releasePage, retainPage } from '../pdf/pageRetention'
import { auditDecodedImages, type DecodeAudit } from '../pdf/decodeAudit'
import { PREVIEW_DEADLINE_MS, canAcceptPointerInput, shouldRenderPreview } from '../pdf/previewGate'
import {
  TILE_BUFFER_PX,
  expandRegion,
  scaleTileRect,
  tileKey,
  tileSetBounds,
  tilesCovering,
  type PageRegion,
  type Tile
} from '../pdf/tiles'
// PERF
import {
  perfCanvasSample,
  perfCount,
  perfNow,
  perfOn,
  perfOffscreenClose,
  perfOffscreenOpen,
  perfOpListLength,
  perfPresent,
  perfRecord,
  perfRegisterPage,
  perfStatsDrain,
  perfStatsMark,
  perfSync,
  perfTrace
} from '../pdf/perf'

export interface PageOverlayContext {
  pageNumber: number
  /**
   * The FULL-page viewport, unchanged by tiling. Every coordinate conversion
   * still goes through this, so hit-testing and geometry stay in PDF
   * user-space exactly as before.
   */
  viewport: PageViewport
  canvas: HTMLCanvasElement
  /**
   * Top-left of `canvas` within the full page, in CSS pixels.
   *
   * The overlay canvas covers only the on-screen region of the page, not the
   * whole page, so a position measured against its bounding rect is short by
   * this much. Callers convert with pointerEventToPdfPoint(..., origin).
   */
  origin: { x: number; y: number }
}

/**
 * Full-page fallback bitmap budget, in device pixels.
 *
 * This layer exists only so the page is never blank - while tiles rasterise,
 * and for the frames after a zoom before the new tiles land. It is stretched
 * to whatever the page box currently is, so it is rendered ONCE per page and
 * never re-rendered on zoom.
 *
 * WHY IT IS THIS SMALL
 *
 * Measured, five zoom-in clicks on the Kincora set: 34 page mounts produced 16
 * previews costing 7569ms total, 399.6ms median - the single largest line item,
 * larger than tile rasterisation (4773ms) and 16x larger than all PDF parsing
 * (460ms). A preview is a full-page raster, so it pays the whole operator list
 * plus fill for the entire sheet, and it is thrown away on unmount because the
 * bitmap lives on a canvas inside the component.
 *
 * At the previous 2_000_000 a 36x24 sheet (2592x1728pt, 4.48Mpx unscaled)
 * rendered at scale 0.668 -> 1731x1154. At 250_000 it renders at 0.236 ->
 * 612x408, which is ~8x less fill.
 *
 * The trade is deliberate and bounded: this bitmap is ALREADY stretched and
 * soft by design, and it is always covered by sharp tiles once they land. It
 * is a "never show white" placeholder, not something measurements are taken
 * against - that is what the tile layer is for. Making it softer stays inside
 * its stated purpose; making it bigger would not.
 */
const PREVIEW_MAX_PIXELS = 250_000

interface PdfPageCanvasProps {
  doc: PDFDocumentProxy
  pageNumber: number
  scale: number
  /**
   * EXTRA rotation in degrees, applied on top of the page's own /Rotate.
   * Composed by viewportForPage, which both this and the viewer's layout
   * measurement go through so the two cannot disagree. See pdf/pageViewport.
   */
  rotation: number
  /** CSS-pixel size this page occupies, precomputed by the viewer for layout. */
  width: number
  height: number
  /**
   * The on-screen region of THIS page, in page-local CSS pixels, or undefined
   * when the page is scrolled out of view. Drives which tiles are rasterised
   * and which are discarded.
   */
  visible?: PageRegion
  renderOverlay?: (ctx: CanvasRenderingContext2D, context: PageOverlayContext) => void
  onPointerDown?: (event: React.PointerEvent<HTMLCanvasElement>, context: PageOverlayContext) => void
  /**
   * Publishes this page's live viewport to the viewer, so gestures that span
   * pages (marquee) can convert screen coordinates into THIS page's
   * user-space using the real transform rather than re-deriving one.
   */
  onViewportReady?: (pageNumber: number, context: PageOverlayContext | undefined) => void
  /**
   * Changed by the parent to force an overlay repaint without re-rendering
   * the PDF bitmap. Any value works as long as it differs when the overlay
   * content should change.
   */
  overlayRevision?: string | number
  /**
   * Hold this page's preview because the viewer is still rendering a page the
   * user is actually looking at. Only meaningful for overscan pages, which have
   * no visible region and would otherwise start building their operator list
   * immediately. See pdf/previewGate.
   */
  holdPreview?: boolean
  /**
   * Reports whether this page currently has a tile on screen, so the viewer
   * knows whether the foreground has landed.
   *
   * BOTH EDGES, not just the first tile. The viewer's set was previously
   * add-only, so a page that had painted once counted as painted for the rest
   * of the session and the foreground hold quietly stopped working after a
   * page's first visit. See isForegroundReady in pdf/previewGate.
   */
  onPaintedChange?: (pageNumber: number, painted: boolean) => void
}

/**
 * Renders one PDF page and owns the lifetime of its rasterisation.
 *
 * Three layers, back to front:
 *
 *   1. PREVIEW - one small full-page bitmap, stretched to the page box. Never
 *      re-rendered on zoom. Its only job is that the page is never white:
 *      tiles appear on top of it as they finish.
 *   2. TILES - the sharp layer. Fixed-size tiles covering the visible region
 *      plus a buffer, rendered at the full devicePixelRatio with no clamp,
 *      and discarded once they leave the buffer. See pdf/tiles.ts.
 *   3. OVERLAY - markups, drawn from vectors through the full-page viewport.
 *      Sized to the tile set's bounds rather than the page, so it cannot hit
 *      the canvas paint cliff either.
 *
 * The canvas is never CSS-scaled to fake a zoom: a zoom change re-tiles at
 * the new scale, because blurred linework makes measurement unreliable. The
 * preview stretching for the few frames before tiles land is the one
 * deliberate exception, and it is always covered by sharp tiles once they
 * arrive.
 *
 * Every bitmap is rendered OFF-SCREEN and blitted in when finished. Assigning
 * canvas.width clears the canvas, so rendering into a visible one blanks it
 * for the whole render - the flash that made zooming unusable.
 */
export default function PdfPageCanvas({
  doc,
  pageNumber,
  scale,
  rotation,
  width,
  height,
  visible,
  renderOverlay,
  onPointerDown,
  onViewportReady,
  overlayRevision = 0,
  holdPreview = false,
  onPaintedChange
}: PdfPageCanvasProps) {
  const previewCanvasRef = useRef<HTMLCanvasElement>(null)
  const tileLayerRef = useRef<HTMLDivElement>(null)
  /** Holds the previous zoom's tiles while the current zoom rasterises. */
  const staleLayerRef = useRef<HTMLDivElement>(null)
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null)

  // Held in a ref so an unstable callback from the parent cannot re-run the
  // page-handle effect below, which would re-fetch the page on every viewer
  // render. The effect's deps stay [doc, pageNumber], which is what they mean.
  const paintedChangeRef = useRef(onPaintedChange)
  paintedChangeRef.current = onPaintedChange

  const [page, setPage] = useState<PDFPageProxy | undefined>(undefined)
  const [renderError, setRenderError] = useState<string | undefined>(undefined)
  /**
   * Whether at least one tile has been painted for this page. Gates the preview
   * so the sharp layer is not competing with it - see the preview effect.
   */
  const [hasTile, setHasTile] = useState(false)
  /**
   * Whether a preview bitmap has been blitted onto the visible canvas.
   *
   * State, not just the `previewPainted` ref below: this drives what is on
   * screen and whether the page accepts pointer input, and a ref does not
   * re-render. Together with hasTile it answers "is there ANY content on this
   * page yet" - see canAcceptPointerInput in pdf/previewGate.
   */
  const [hasPreview, setHasPreview] = useState(false)
  /** A tile render failed with something other than a cancellation. */
  const [tilesFailed, setTilesFailed] = useState(false)
  /** PREVIEW_DEADLINE_MS elapsed without a first tile. See pdf/previewGate. */
  const [previewDeadlineReached, setPreviewDeadlineReached] = useState(false)
  /**
   * Whether any image on this page failed to decode. pdf.js does not throw for
   * that - it resolves the image to null and skips the draw - so a sheet whose
   * content is missing is indistinguishable from an empty one unless we look.
   * See pdf/decodeAudit.
   */
  const [decode, setDecode] = useState<DecodeAudit | undefined>(undefined)
  const decodeChecked = useRef(false)

  // ---- page handle ----------------------------------------------------
  useEffect(() => {
    let cancelled = false
    let loaded: PDFPageProxy | undefined
    setRenderError(undefined)
    // If this page was held after a previous unmount, stop counting it against
    // the retention cap - it is live again. Its parse is still intact, which
    // is the whole point: doc.getPage() below returns the same proxy from
    // pdf.js's own cache, operator list and all.
    perfTrace('mount', `p${pageNumber} scale ${scale.toFixed(4)}`) // PERF
    releasePage(doc, pageNumber)
    const getPageAt = perfNow() // PERF
    void doc
      .getPage(pageNumber)
      .then((p) => {
        if (perfOn()) perfRecord('page:getPage', performance.now() - getPageAt, { page: pageNumber }) // PERF
        loaded = p
        if (!cancelled) setPage(p)
      })
      .catch((err) => {
        if (!cancelled) setRenderError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
      // Hand the page to the bounded retention cache instead of cleaning it up
      // here. cleanup() drops the operator list, fonts and decoded images, and
      // doing that the instant a page leaves the virtualized range made zoom
      // re-parse pages it was about to need again - 23.4s of worker time over
      // five zoom clicks on the Kincora set.
      //
      // This does NOT reintroduce unbounded retention: the cache holds at most
      // RETAINED_PAGES entries and cleans up on eviction. See pdf/pageRetention.
      perfTrace('unmount', `p${pageNumber}`) // PERF
      if (loaded) retainPage(doc, pageNumber, loaded)
      // The tiles are destroyed below, so this page no longer has anything on
      // screen. Telling the viewer is what keeps its painted set a statement
      // about the present rather than a session-long high-water mark.
      paintedChangeRef.current?.(pageNumber, false)
      setPage(undefined)
      setHasTile(false)
      setHasPreview(false)
      setTilesFailed(false)
      setPreviewDeadlineReached(false)
      setDecode(undefined)
      decodeChecked.current = false
    }
  }, [doc, pageNumber])

  // The full-page viewport, derived synchronously. Deriving it here rather
  // than after an async render is what lets the overlay follow a zoom
  // immediately instead of blanking until the bitmap catches up.
  const viewport = useMemo(
    () => (page ? viewportForPage(page, scale, rotation) : undefined),
    [page, scale, rotation]
  )

  // ---- which tiles the current view needs -----------------------------
  const tiles = useMemo(() => {
    if (!viewport || !visible) return []
    return tilesCovering(expandRegion(visible, TILE_BUFFER_PX), viewport.width, viewport.height)
  }, [viewport, visible])

  // Tiles are grid-aligned, so this string changes only when the view crosses
  // a tile boundary - not on every pan frame. Everything downstream keys off
  // it so panning inside the buffer does no canvas work at all.
  const tileSignature = tiles.map((t) => `${t.col},${t.row}`).join(' ')
  const tilesRef = useRef<Tile[]>(tiles)
  tilesRef.current = tiles

  const overlayRegion = useMemo(
    () => tileSetBounds(tiles),
    // Bounds move only with the tile set; recomputing per pan frame would
    // resize the overlay canvas every frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tileSignature]
  )

  // Runs after a render resolves, when the operator list is complete. Once per
  // page: the answer cannot change without the page being re-parsed.
  const auditDecode = (loaded: PDFPageProxy): void => {
    if (decodeChecked.current) return
    const result = auditDecodedImages(loaded)
    if (result.status === 'pending') return
    decodeChecked.current = true
    setDecode(result)
  }

  // ---- preview: one small bitmap, never re-rendered on zoom ------------
  //
  // ORDERING: a page that is going to rasterise tiles waits for its FIRST TILE
  // before rendering its preview, so the two do not compete.
  //
  // They were doing the same expensive work back to back, in front of the user:
  // both replay the whole operator list, so on an image-heavy sheet both decode
  // the same aerials. Measured jumping to page 23 (four pages mount): 4 previews
  // at 1980ms median against 2 tiles at 1658ms - six concurrent renders, four of
  // them previews.
  //
  // The preview is NOT giving up its job by waiting. Its stated purpose is that
  // the page is never white before tiles land, and it has never actually done
  // that: in every measurement it is no faster than a tile (1980 vs 1658ms here,
  // 318 vs 318ms warm, 1560 vs 1659ms on pages 1-3), because it replays the same
  // operator list and dispatch dominates its smaller fill. What it genuinely
  // does is cover the page during a ZOOM, where tiles are discarded and the
  // preview is not re-rendered. Rendering it just after the first tile keeps
  // that intact.
  //
  // A page with no visible region rasterises no tiles, so it renders its preview
  // immediately - it needs one ready for when it scrolls into view. Deferring
  // those too needs a shared cross-page gauge (React commits every child's
  // render phase before any effect runs, so a synchronous counter still races);
  // that is the render-priority queue on the roadmap, not this change.
  const wantsTiles = tiles.length > 0

  // Set once a preview has been painted for this page+rotation, so landing a
  // tile later cannot trigger a second one. "Rendered once per page" stays true.
  // Bounds how long the preview waits for a first tile. Without this a page
  // whose tile never lands stays blank forever - see pdf/previewGate for the
  // three ways that happens.
  useEffect(() => {
    if (!page || tilesFailed || previewDeadlineReached) return
    // Runs while waiting for a first tile OR while held for the foreground:
    // both are waits, and both need the same backstop.
    if (!wantsTiles && !holdPreview) return
    if (wantsTiles && hasTile && !holdPreview) return
    const timer = window.setTimeout(() => setPreviewDeadlineReached(true), PREVIEW_DEADLINE_MS)
    return () => window.clearTimeout(timer)
  }, [page, wantsTiles, hasTile, tilesFailed, previewDeadlineReached, holdPreview])

  const previewPainted = useRef(false)
  useEffect(() => {
    previewPainted.current = false
    setHasPreview(false)
  }, [page, rotation])

  useEffect(() => {
    if (!page) return
    if (previewPainted.current) return
    // Waiting on the sharp layer. When the first tile lands this effect re-runs.
    if (
      !shouldRenderPreview({
        wantsTiles,
        hasTile,
        tilesFailed,
        deadlineReached: previewDeadlineReached,
        heldForForeground: holdPreview
      })
    )
      return
    let cancelled = false
    let task: RenderTask | undefined

    void (async () => {
      let offscreenOpen = false // PERF
      try {
        const unscaled = viewportForPage(page, 1, rotation)
        const previewScale = deviceScaleFor(unscaled.width, unscaled.height, 1, PREVIEW_MAX_PIXELS)
        const previewViewport = viewportForPage(page, previewScale, rotation)
        const w = Math.max(1, Math.floor(previewViewport.width))
        const h = Math.max(1, Math.floor(previewViewport.height))

        const offscreen = document.createElement('canvas')
        offscreen.width = w
        offscreen.height = h
        perfOffscreenOpen() // PERF
        offscreenOpen = true // PERF
        const statsFrom = perfStatsMark(page) // PERF
        const rasterAt = perfNow() // PERF
        task = page.render({ canvas: offscreen, viewport: previewViewport })
        await task.promise
        if (perfOn()) perfRecord('raster:preview', performance.now() - rasterAt, { page: pageNumber, detail: `${w}x${h}` }) // PERF
        perfStatsDrain(page, pageNumber, statsFrom) // PERF
        perfOpListLength(page, pageNumber) // PERF
        if (cancelled) {
          perfOffscreenClose() // PERF
          offscreenOpen = false // PERF
          return
        }

        const canvas = previewCanvasRef.current
        if (!canvas) {
          perfOffscreenClose() // PERF
          offscreenOpen = false // PERF
          return
        }
        const blitAt = perfNow() // PERF
        canvas.width = w
        canvas.height = h
        perfSync('blit:preview', pageNumber, () => canvas.getContext('2d')?.drawImage(offscreen, 0, 0)) // PERF
        perfPresent(blitAt, pageNumber) // PERF
        offscreen.width = 0
        offscreen.height = 0
        perfOffscreenClose() // PERF
        perfCanvasSample() // PERF
        previewPainted.current = true
        setHasPreview(true)
        auditDecode(page)
      } catch (err) {
        // Guarded: the throw can predate the offscreen allocation (a bad
        // viewport), and an unguarded close would under-count the live gauge.
        if (offscreenOpen) perfOffscreenClose() // PERF
        if (cancelled || (err as { name?: string })?.name === 'RenderingCancelledException') {
          perfCount('raster:preview cancelled') // PERF
          return
        }
        setRenderError(err instanceof Error ? err.message : String(err))
      }
    })()

    return () => {
      cancelled = true
      task?.cancel()
    }
    // hasTile/wantsTiles are the gate. Booleans, not the `visible` object, so a
    // pan that only changes the visible RECTANGLE does not re-run this.
  }, [page, rotation, wantsTiles, hasTile, tilesFailed, previewDeadlineReached, holdPreview])

  // The preview is stretched to whatever the page box currently is, so a zoom
  // never leaves it at the wrong size while tiles are still rendering.
  useLayoutEffect(() => {
    const canvas = previewCanvasRef.current
    if (!canvas) return
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
  }, [width, height])

  // ---- tiles: the sharp layer -----------------------------------------
  // Managed imperatively rather than as React children: a pan crossing a tile
  // boundary would otherwise reconcile the whole page subtree, and tiles must
  // be attached only once they hold a finished bitmap.
  const liveTiles = useRef(new Map<string, HTMLCanvasElement>())
  /**
   * The previous zoom's tiles, kept on screen underneath while the current
   * zoom rasterises, and re-placed by the ratio between the two scales.
   *
   * WHY THIS EXISTS. `tileKey` bakes in the scale, so a zoom step invalidates
   * every tile at once, and the discard loop below used to remove them all
   * immediately. That left the preview as the only thing on screen - and the
   * preview is 250k pixels stretched over the whole page box, a 2.6x upscale at
   * fit width and far worse zoomed in. Sharp, then very blurry, then sharp
   * again, once per step: what a rapid zoom felt like was flashing.
   *
   * A previous attempt at a two-generation scheme did nothing at all, because
   * its state lived in per-component refs while pages were REMOUNTING on every
   * zoom step, so React destroyed it before it could render. That lifecycle bug
   * was the stale-scroll-offset one, fixed in 9e18835 - five zoom clicks now
   * produce zero page mounts. This state therefore survives a zoom, which is
   * the precondition the earlier attempt silently lacked. If pages ever start
   * remounting on zoom again, this stops working and goes quiet about it.
   */
  const staleTiles = useRef(new Map<string, { canvas: HTMLCanvasElement; tile: Tile }>())
  /**
   * Geometry of each live tile, kept because a tile that becomes stale has to
   * be re-placed from its ORIGINAL page-local rect. Reading it back off the DOM
   * would compound rounding across a run of zoom steps.
   */
  const renderedTiles = useRef(new Map<string, Tile>())
  /** The scale `liveTiles` was rasterised at, so a zoom step is detectable. */
  const liveScale = useRef(scale)
  /** The scale `staleTiles` was rasterised at, for the re-placement ratio. */
  const staleScale = useRef(scale)

  // A LAYOUT effect, unlike every other render effect here, and for the same
  // reason the preview is sized in one: the page box has already been resized
  // by the time this runs, so re-placing the stale generation in a passive
  // effect would leave it at the previous zoom's geometry for one frame on
  // every step. The prologue below is a handful of style writes over at most a
  // few tiles; the actual rasterisation is still async and still off the
  // critical path.
  useLayoutEffect(() => {
    const layer = tileLayerRef.current
    const staleLayer = staleLayerRef.current
    if (!page || !viewport || !layer || !staleLayer) return

    const dpr = window.devicePixelRatio || 1
    const wanted = new Map(tilesRef.current.map((t) => [tileKey(t, scale, rotation, dpr), t]))

    perfRegisterPage(pageNumber, page, viewport) // PERF
    perfCount('tiles:effect passes') // PERF
    if (perfOn()) perfRecord('tiles:wanted', wanted.size, { page: pageNumber, detail: `scale ${scale.toFixed(3)}` }) // PERF

    const dropStale = (): void => {
      for (const { canvas } of staleTiles.current.values()) {
        canvas.remove()
        canvas.width = 0
        canvas.height = 0
      }
      staleTiles.current.clear()
    }

    const zoomed = scale !== liveScale.current
    if (zoomed) {
      // Only ever ONE stale generation, so this cannot grow with the number of
      // zoom steps.
      //
      // Promote the outgoing generation ONLY IF IT HAS ANYTHING IN IT. On a
      // fast zoom the previous step's tiles may not have landed yet, and
      // promoting an empty generation would throw away the last sharp thing on
      // screen and put the blurry preview back - exactly the case this is here
      // to fix. Keeping the older stale layer instead means a rapid run of
      // steps stretches one good bitmap progressively, rather than flashing.
      if (liveTiles.current.size > 0) {
        dropStale()
        for (const [key, canvas] of liveTiles.current) {
          const tile = renderedTiles.current.get(key)
          if (!tile) {
            canvas.remove()
            canvas.width = 0
            canvas.height = 0
            continue
          }
          staleLayer.appendChild(canvas)
          staleTiles.current.set(key, { canvas, tile })
        }
        staleScale.current = liveScale.current
        perfCount('tiles:generations promoted') // PERF
      } else {
        perfCount('tiles:stale generation held') // PERF
      }
      liveTiles.current.clear()
      renderedTiles.current.clear()
      liveScale.current = scale
    }

    // Re-place the stale generation for the scale now on screen. The bitmaps
    // are not re-rendered; the browser stretches them for the few frames the
    // new generation is in flight.
    if (staleTiles.current.size > 0) {
      const ratio = scale / staleScale.current
      for (const { canvas, tile } of staleTiles.current.values()) {
        const rect = scaleTileRect(tile, ratio)
        canvas.style.left = `${rect.left}px`
        canvas.style.top = `${rect.top}px`
        canvas.style.width = `${rect.width}px`
        canvas.style.height = `${rect.height}px`
      }
    }

    // Discard anything outside the buffer. This is what bounds memory on a pan.
    // Tiles from a previous zoom are no longer swept up here - they were moved
    // to the stale layer above and are removed once the new set has landed.
    for (const [key, canvas] of liveTiles.current) {
      if (wanted.has(key)) continue
      perfCount('tiles:discarded') // PERF
      canvas.remove()
      // Release the backing store rather than waiting for the GC: at high
      // zoom these are megabytes each.
      canvas.width = 0
      canvas.height = 0
      liveTiles.current.delete(key)
      renderedTiles.current.delete(key)
    }

    let cancelled = false
    let task: RenderTask | undefined
    const tileSetAt = perfNow() // PERF

    void (async () => {
      for (const [key, tile] of wanted) {
        if (cancelled) return
        if (liveTiles.current.has(key)) continue

        const deviceWidth = Math.max(1, Math.round(tile.width * dpr))
        const deviceHeight = Math.max(1, Math.round(tile.height * dpr))

        const offscreen = document.createElement('canvas')
        offscreen.width = deviceWidth
        offscreen.height = deviceHeight
        perfOffscreenOpen() // PERF

        const statsFrom = perfStatsMark(page) // PERF
        const rasterAt = perfNow() // PERF
        try {
          // The page is rendered through its FULL viewport; the transform
          // shifts this tile's region into the tile canvas and scales to
          // device pixels. Rotation is already composed into the viewport.
          task = page.render({
            canvas: offscreen,
            viewport,
            transform: [dpr, 0, 0, dpr, -tile.left * dpr, -tile.top * dpr]
          })
          await task.promise
          // PERF: tile pixel area is recorded alongside the time, so the
          // report shows whether cost tracks area (fill-bound) or is flat
          // regardless of area (operator-list-dispatch-bound).
          if (perfOn()) { // PERF
            perfRecord('raster:tile', performance.now() - rasterAt, {
              page: pageNumber,
              detail: `${deviceWidth}x${deviceHeight}`
            })
          }
          perfStatsDrain(page, pageNumber, statsFrom) // PERF
          perfOpListLength(page, pageNumber) // PERF
          perfCount('raster:tiles completed') // PERF
        } catch (err) {
          offscreen.width = 0
          offscreen.height = 0
          perfOffscreenClose() // PERF
          if (cancelled || (err as { name?: string })?.name === 'RenderingCancelledException') {
            // PERF: a high cancelled:completed ratio during a zoom gesture is
            // the direct evidence for the no-coalescing hypothesis.
            perfCount('raster:tiles cancelled') // PERF
            if (perfOn()) perfRecord('raster:tile wasted', performance.now() - rasterAt, { page: pageNumber }) // PERF
            return
          }
          setTilesFailed(true)
          setRenderError(err instanceof Error ? err.message : String(err))
          return
        }
        if (cancelled) {
          offscreen.width = 0
          offscreen.height = 0
          perfOffscreenClose() // PERF
          return
        }

        const blitAt = perfNow() // PERF
        const canvas = document.createElement('canvas')
        canvas.className = 'pdf-page__tile'
        canvas.width = deviceWidth
        canvas.height = deviceHeight
        canvas.style.left = `${tile.left}px`
        canvas.style.top = `${tile.top}px`
        canvas.style.width = `${tile.width}px`
        canvas.style.height = `${tile.height}px`
        perfSync('blit:tile', pageNumber, () => canvas.getContext('2d')?.drawImage(offscreen, 0, 0)) // PERF
        offscreen.width = 0
        offscreen.height = 0
        perfOffscreenClose() // PERF

        layer.appendChild(canvas)
        liveTiles.current.set(key, canvas)
        renderedTiles.current.set(key, tile)
        // Opens the preview gate: the sharp layer is on screen for this page, so
        // its preview can render now without competing for animation frames.
        if (!cancelled) {
          setHasTile(true)
          paintedChangeRef.current?.(pageNumber, true)
        }
        auditDecode(page)
        perfPresent(blitAt, pageNumber) // PERF
        // PERF: sampled right after a tile is attached - the moment the live
        // canvas count is highest during a zoom.
        perfCanvasSample() // PERF
      }
      // PERF: the whole wanted set is on screen. The page's FIRST tile is what
      // currently releases held overscan previews, but a destination page wants
      // 2-6 tiles, so this is the other end of the window in which the page the
      // user navigated to is still rendering. Pairing the two says whether the
      // neighbour's parse lands inside it.
      if (cancelled) return
      // The new generation covers the view, so the stretched one underneath has
      // nothing left to cover. Dropping it here rather than on the first tile is
      // deliberate: the first tile covers only its own corner, and removing the
      // stale layer then would put the blurred preview back for the rest.
      dropStale()
      if (perfOn()) { // PERF
        perfRecord('tiles:set complete', performance.now() - tileSetAt, {
          page: pageNumber,
          detail: `${wanted.size} tiles`
        })
        perfTrace('tiles complete', `p${pageNumber} ${wanted.size} tiles`)
      }
    })()

    return () => {
      cancelled = true
      task?.cancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, viewport, tileSignature, scale, rotation])

  // Drop every tile on unmount - the page leaving the virtualized range is
  // what has to release this memory. Both generations, or the stale one would
  // outlive the page that owns it.
  useEffect(() => {
    const tileMap = liveTiles.current
    const staleMap = staleTiles.current
    const geometry = renderedTiles.current
    return () => {
      for (const canvas of tileMap.values()) {
        canvas.remove()
        canvas.width = 0
        canvas.height = 0
      }
      tileMap.clear()
      for (const { canvas } of staleMap.values()) {
        canvas.remove()
        canvas.width = 0
        canvas.height = 0
      }
      staleMap.clear()
      geometry.clear()
    }
  }, [])

  // ---- overlay --------------------------------------------------------
  // Separate from the page bitmap so moving a markup does not re-rasterise
  // anything. Every point is converted from stored PDF user-space through the
  // CURRENT full-page viewport - nothing cached, nothing tile-relative.
  useEffect(() => {
    const overlay = overlayCanvasRef.current
    if (!overlay || !viewport || !overlayRegion) return
    const ctx = overlay.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    // Sized to the tile set, not the page: a full-page overlay would cross the
    // canvas paint cliff at high zoom and take the markups away instead of the
    // linework. This stays viewport-sized at every zoom.
    const deviceWidth = Math.max(1, Math.round(overlayRegion.width * dpr))
    const deviceHeight = Math.max(1, Math.round(overlayRegion.height * dpr))
    if (overlay.width !== deviceWidth || overlay.height !== deviceHeight) {
      overlay.width = deviceWidth
      overlay.height = deviceHeight
    }
    overlay.style.left = `${overlayRegion.left}px`
    overlay.style.top = `${overlayRegion.top}px`
    overlay.style.width = `${overlayRegion.width}px`
    overlay.style.height = `${overlayRegion.height}px`

    const overlayAt = perfNow() // PERF
    ctx.save()
    // Translate so callers keep drawing in FULL-PAGE CSS coordinates and never
    // have to know the overlay is a window onto the page.
    ctx.setTransform(dpr, 0, 0, dpr, -overlayRegion.left * dpr, -overlayRegion.top * dpr)
    ctx.clearRect(overlayRegion.left, overlayRegion.top, overlayRegion.width, overlayRegion.height)
    renderOverlay?.(ctx, {
      pageNumber,
      viewport,
      canvas: overlay,
      origin: { x: overlayRegion.left, y: overlayRegion.top }
    })
    ctx.restore()
    if (perfOn()) perfRecord('overlay:redraw', performance.now() - overlayAt, { page: pageNumber }) // PERF
  }, [viewport, overlayRegion, renderOverlay, pageNumber, overlayRevision])

  // Publish/withdraw this page's viewport for cross-page gestures.
  useEffect(() => {
    const overlay = overlayCanvasRef.current
    if (!onViewportReady) return
    onViewportReady(
      pageNumber,
      viewport && overlay && overlayRegion
        ? { pageNumber, viewport, canvas: overlay, origin: { x: overlayRegion.left, y: overlayRegion.top } }
        : undefined
    )
    return () => onViewportReady(pageNumber, undefined)
  }, [onViewportReady, pageNumber, viewport, overlayRegion])

  // Nothing has been drawn for this page yet. Both a visible placeholder and a
  // refusal to accept points hang off this - see canAcceptPointerInput.
  const painted = canAcceptPointerInput(hasTile, hasPreview)

  return (
    <div className="pdf-page" style={{ width, height }} data-page-number={pageNumber}>
      {/* Under every render layer, so the first thing that paints covers it.
          Exists because `.pdf-page` is white and a white sheet is
          indistinguishable from an empty one. */}
      {!painted ? (
        <div className="pdf-page__placeholder">
          <span className="pdf-page__placeholder-label">Rendering page {pageNumber}…</span>
        </div>
      ) : null}
      <canvas ref={previewCanvasRef} className="pdf-page__canvas pdf-page__canvas--preview" />
      {/* Before the live layer, so the outgoing generation always paints
          UNDER the incoming one regardless of the order tiles land in. */}
      <div ref={staleLayerRef} className="pdf-page__tiles pdf-page__tiles--stale" />
      <div ref={tileLayerRef} className="pdf-page__tiles" />
      <canvas
        ref={overlayCanvasRef}
        className="pdf-page__canvas pdf-page__canvas--overlay"
        onPointerDown={(event) => {
          const overlay = overlayCanvasRef.current
          if (!overlay || !viewport || !overlayRegion || !onPointerDown) return
          // Refuse points on a sheet with no content on screen. The overlay is
          // live as soon as the page proxy resolves - it is sized from the
          // tiles the view WANTS - so without this a cold exhibit sheet accepts
          // calibration and takeoff for several seconds while still blank.
          if (!painted) return
          onPointerDown(event, {
            pageNumber,
            viewport,
            canvas: overlay,
            origin: { x: overlayRegion.left, y: overlayRegion.top }
          })
        }}
      />
      {renderError ? <div className="pdf-page__error">Failed to render page {pageNumber}: {renderError}</div> : null}
      {decode?.status === 'failed' ? (
        <div className="pdf-page__decode-warning" role="alert">
          <strong>Content missing.</strong> {decode.failed} of {decode.images} image
          {decode.images === 1 ? '' : 's'} on this sheet could not be decoded. Do not measure from
          this page.
        </div>
      ) : null}
      {decode?.status === 'unknown' ? (
        <div className="pdf-page__decode-warning pdf-page__decode-warning--unknown" role="alert">
          <strong>Could not verify this sheet rendered completely.</strong> {decode.reason}
        </div>
      ) : null}
      <div className="pdf-page__label">{pageNumber}</div>
    </div>
  )
}
