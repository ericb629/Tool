import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy, PDFPageProxy, PageViewport, RenderTask } from 'pdfjs-dist'
import { deviceScaleFor, viewportForPage } from '../pdf/pageViewport'
import {
  TILE_BUFFER_PX,
  expandRegion,
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
  perfOffscreenClose,
  perfOffscreenOpen,
  perfOpListLength,
  perfPresent,
  perfRecord,
  perfRegisterPage,
  perfStatsDrain,
  perfStatsMark,
  perfSync
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
 * Deliberately small. This layer exists only so the page is never blank -
 * while tiles rasterise, and for the frames after a zoom before the new tiles
 * land. It is stretched to whatever the page box currently is, so it is
 * rendered ONCE per page and never re-rendered on zoom.
 */
const PREVIEW_MAX_PIXELS = 2_000_000

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
  overlayRevision = 0
}: PdfPageCanvasProps) {
  const previewCanvasRef = useRef<HTMLCanvasElement>(null)
  const tileLayerRef = useRef<HTMLDivElement>(null)
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null)

  const [page, setPage] = useState<PDFPageProxy | undefined>(undefined)
  const [renderError, setRenderError] = useState<string | undefined>(undefined)

  // ---- page handle ----------------------------------------------------
  useEffect(() => {
    let cancelled = false
    let loaded: PDFPageProxy | undefined
    setRenderError(undefined)
    const getPageAt = performance.now() // PERF
    void doc
      .getPage(pageNumber)
      .then((p) => {
        perfRecord('page:getPage', performance.now() - getPageAt, { page: pageNumber }) // PERF
        loaded = p
        if (!cancelled) setPage(p)
      })
      .catch((err) => {
        if (!cancelled) setRenderError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
      // Drops the page's operator list, fonts and image resources. Scrolling a
      // large sheet set without this retains every page ever visited, so
      // virtualizing the canvases alone does not bound memory.
      if (loaded) perfCount('page:cleanup calls') // PERF
      loaded?.cleanup()
      setPage(undefined)
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

  // ---- preview: one small bitmap, never re-rendered on zoom ------------
  useEffect(() => {
    if (!page) return
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
        const rasterAt = performance.now() // PERF
        task = page.render({ canvas: offscreen, viewport: previewViewport })
        await task.promise
        perfRecord('raster:preview', performance.now() - rasterAt, { page: pageNumber, detail: `${w}x${h}` }) // PERF
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
        const blitAt = performance.now() // PERF
        canvas.width = w
        canvas.height = h
        perfSync('blit:preview', { page: pageNumber }, () => canvas.getContext('2d')?.drawImage(offscreen, 0, 0)) // PERF
        perfPresent(blitAt, pageNumber) // PERF
        offscreen.width = 0
        offscreen.height = 0
        perfOffscreenClose() // PERF
        perfCanvasSample() // PERF
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
  }, [page, rotation])

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

  useEffect(() => {
    const layer = tileLayerRef.current
    if (!page || !viewport || !layer) return

    const dpr = window.devicePixelRatio || 1
    const wanted = new Map(tilesRef.current.map((t) => [tileKey(t, scale, rotation, dpr), t]))

    perfRegisterPage(pageNumber, page, viewport) // PERF
    perfCount('tiles:effect passes') // PERF
    perfRecord('tiles:wanted', wanted.size, { page: pageNumber, detail: `scale ${scale.toFixed(3)}` }) // PERF

    // Discard anything outside the buffer, and everything from a previous
    // zoom (scale is part of the key). This is what bounds memory on a pan.
    for (const [key, canvas] of liveTiles.current) {
      if (wanted.has(key)) continue
      perfCount('tiles:discarded') // PERF
      canvas.remove()
      // Release the backing store rather than waiting for the GC: at high
      // zoom these are megabytes each.
      canvas.width = 0
      canvas.height = 0
      liveTiles.current.delete(key)
    }

    let cancelled = false
    let task: RenderTask | undefined

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
        const rasterAt = performance.now() // PERF
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
          perfRecord('raster:tile', performance.now() - rasterAt, {
            page: pageNumber,
            detail: `${deviceWidth}x${deviceHeight}`
          }) // PERF
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
            perfRecord('raster:tile wasted', performance.now() - rasterAt, { page: pageNumber }) // PERF
            return
          }
          setRenderError(err instanceof Error ? err.message : String(err))
          return
        }
        if (cancelled) {
          offscreen.width = 0
          offscreen.height = 0
          perfOffscreenClose() // PERF
          return
        }

        const blitAt = performance.now() // PERF
        const canvas = document.createElement('canvas')
        canvas.className = 'pdf-page__tile'
        canvas.width = deviceWidth
        canvas.height = deviceHeight
        canvas.style.left = `${tile.left}px`
        canvas.style.top = `${tile.top}px`
        canvas.style.width = `${tile.width}px`
        canvas.style.height = `${tile.height}px`
        perfSync('blit:tile', { page: pageNumber }, () => canvas.getContext('2d')?.drawImage(offscreen, 0, 0)) // PERF
        offscreen.width = 0
        offscreen.height = 0
        perfOffscreenClose() // PERF

        layer.appendChild(canvas)
        liveTiles.current.set(key, canvas)
        perfPresent(blitAt, pageNumber) // PERF
        // PERF: sampled right after a tile is attached - the moment the live
        // canvas count is highest during a zoom.
        perfCanvasSample() // PERF
      }
    })()

    return () => {
      cancelled = true
      task?.cancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, viewport, tileSignature, scale, rotation])

  // Drop every tile on unmount - the page leaving the virtualized range is
  // what has to release this memory.
  useEffect(() => {
    const tileMap = liveTiles.current
    return () => {
      for (const canvas of tileMap.values()) {
        canvas.remove()
        canvas.width = 0
        canvas.height = 0
      }
      tileMap.clear()
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

    const overlayAt = performance.now() // PERF
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
    perfRecord('overlay:redraw', performance.now() - overlayAt, { page: pageNumber }) // PERF
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

  return (
    <div className="pdf-page" style={{ width, height }} data-page-number={pageNumber}>
      <canvas ref={previewCanvasRef} className="pdf-page__canvas pdf-page__canvas--preview" />
      <div ref={tileLayerRef} className="pdf-page__tiles" />
      <canvas
        ref={overlayCanvasRef}
        className="pdf-page__canvas pdf-page__canvas--overlay"
        onPointerDown={(event) => {
          const overlay = overlayCanvasRef.current
          if (!overlay || !viewport || !overlayRegion || !onPointerDown) return
          onPointerDown(event, {
            pageNumber,
            viewport,
            canvas: overlay,
            origin: { x: overlayRegion.left, y: overlayRegion.top }
          })
        }}
      />
      {renderError ? <div className="pdf-page__error">Failed to render page {pageNumber}: {renderError}</div> : null}
      <div className="pdf-page__label">{pageNumber}</div>
    </div>
  )
}
