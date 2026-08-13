import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, PageViewport, RenderTask } from 'pdfjs-dist'
import { deviceScaleFor, viewportForPage } from '../pdf/pageViewport'

export interface PageOverlayContext {
  pageNumber: number
  viewport: PageViewport
  canvas: HTMLCanvasElement
}

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
 * Renders one PDF page to its own canvas and owns the lifetime of that
 * render. Mounted only while the page is within the viewer's visible window;
 * unmounting cancels any in-flight RenderTask and drops the canvas, which is
 * what keeps a 300-page sheet set from holding hundreds of bitmaps.
 *
 * The bitmap is sized in DEVICE pixels (CSS size x devicePixelRatio) and the
 * page is drawn into it through a matching transform, so linework stays
 * sharp on high-DPI displays. The canvas is never CSS-scaled to fake a zoom:
 * a zoom change re-renders at the new scale, because blurred linework makes
 * measurement unreliable.
 */
export default function PdfPageCanvas({
  doc,
  pageNumber,
  scale,
  rotation,
  width,
  height,
  renderOverlay,
  onPointerDown,
  onViewportReady,
  overlayRevision = 0
}: PdfPageCanvasProps) {
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null)
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null)
  const [viewport, setViewport] = useState<PageViewport | undefined>(undefined)
  const [renderError, setRenderError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    let task: RenderTask | undefined
    let renderedPage: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | undefined
    setRenderError(undefined)

    void (async () => {
      try {
        const page = await doc.getPage(pageNumber)
        renderedPage = page
        if (cancelled) return

        // Adds to the page's own /Rotate rather than replacing it.
        const pageViewport = viewportForPage(page, scale, rotation)

        // Published before the render finishes, on purpose. Until the new
        // bitmap lands the old one is stretched to this exact box, which is
        // geometrically identical to this viewport - only lower resolution -
        // so hit-testing and the overlay are already correct against it.
        if (!cancelled) setViewport(pageViewport)

        // Clamped, not the raw devicePixelRatio: past the measured canvas
        // paint cliff the bitmap silently comes back blank. See pageViewport.
        const deviceScale = deviceScaleFor(
          pageViewport.width,
          pageViewport.height,
          window.devicePixelRatio || 1
        )
        const deviceWidth = Math.max(1, Math.floor(pageViewport.width * deviceScale))
        const deviceHeight = Math.max(1, Math.floor(pageViewport.height * deviceScale))

        // Render OFF-SCREEN. Resizing the visible canvas clears it, so
        // rendering straight into it blanks the page for the whole duration
        // of the render - the flash that made zooming unusable on a large
        // sheet. The visible bitmap is only touched once there is a finished
        // one to put there.
        const offscreen = document.createElement('canvas')
        offscreen.width = deviceWidth
        offscreen.height = deviceHeight

        task = page.render({
          canvas: offscreen,
          viewport: pageViewport,
          // Scale the whole page draw up to device pixels.
          transform: deviceScale === 1 ? undefined : [deviceScale, 0, 0, deviceScale, 0, 0]
        })
        await task.promise
        if (cancelled) return

        const canvas = pdfCanvasRef.current
        if (!canvas) return
        canvas.width = deviceWidth
        canvas.height = deviceHeight
        canvas.style.width = `${pageViewport.width}px`
        canvas.style.height = `${pageViewport.height}px`
        canvas.getContext('2d')?.drawImage(offscreen, 0, 0)
        // Release the backing store rather than waiting for the GC: at high
        // zoom on a large sheet these are tens of megabytes each.
        offscreen.width = 0
        offscreen.height = 0
      } catch (err) {
        // A cancelled render is the normal result of scrolling or zooming
        // away mid-draw, not a failure worth surfacing.
        if (cancelled || (err as { name?: string })?.name === 'RenderingCancelledException') return
        setRenderError(err instanceof Error ? err.message : String(err))
      }
    })()

    return () => {
      cancelled = true
      task?.cancel()
      // Drop the page's operator list, fonts and image resources. Scrolling a
      // large sheet set without this retains every page ever visited, so
      // virtualizing the canvases alone does not bound memory.
      renderedPage?.cleanup()
      // NOT cleared here. On a zoom this effect re-runs, and dropping the
      // viewport would unpublish it and blank the overlay for the duration of
      // the re-render - taking the markups away with the page. It is replaced
      // as soon as the new one is known, and the component unmounting is what
      // withdraws it (see the publish effect below).
    }
  }, [doc, pageNumber, scale, rotation])

  // Keep the visible bitmap filling its slot while a re-render is in flight.
  // The layout resizes the moment the scale changes, so without this the old
  // canvas sits at its previous size in a differently sized box. Stretching it
  // is a transient blur that the finished render replaces.
  useLayoutEffect(() => {
    const canvas = pdfCanvasRef.current
    if (!canvas) return
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
  }, [width, height])

  // Overlay repaint. Separate from the PDF render so moving a markup does not
  // force the page bitmap to be redrawn. Every point drawn here is converted
  // from stored PDF user-space through the CURRENT viewport - nothing cached.
  useEffect(() => {
    const overlay = overlayCanvasRef.current
    if (!overlay || !viewport) return
    const ctx = overlay.getContext('2d')
    if (!ctx) return

    // Same clamp as the page bitmap, and it has to be the same: clamping only
    // the bitmap would leave the overlay over the canvas paint cliff, which
    // takes the markups away instead of the linework.
    const deviceScale = deviceScaleFor(viewport.width, viewport.height, window.devicePixelRatio || 1)
    // The overlay sizes itself. It is redrawn from vectors rather than
    // rasterised, so it can follow the new scale immediately instead of
    // waiting for the page render - which is what keeps markups on screen and
    // correctly placed while the bitmap behind them catches up.
    const deviceWidth = Math.max(1, Math.floor(viewport.width * deviceScale))
    const deviceHeight = Math.max(1, Math.floor(viewport.height * deviceScale))
    if (overlay.width !== deviceWidth || overlay.height !== deviceHeight) {
      overlay.width = deviceWidth
      overlay.height = deviceHeight
    }
    overlay.style.width = `${viewport.width}px`
    overlay.style.height = `${viewport.height}px`

    ctx.save()
    ctx.setTransform(deviceScale, 0, 0, deviceScale, 0, 0)
    ctx.clearRect(0, 0, viewport.width, viewport.height)
    renderOverlay?.(ctx, { pageNumber, viewport, canvas: overlay })
    ctx.restore()
  }, [viewport, renderOverlay, pageNumber, overlayRevision])

  // Publish/withdraw this page's viewport for cross-page gestures.
  useEffect(() => {
    const overlay = overlayCanvasRef.current
    if (!onViewportReady) return
    onViewportReady(pageNumber, viewport && overlay ? { pageNumber, viewport, canvas: overlay } : undefined)
    return () => onViewportReady(pageNumber, undefined)
  }, [onViewportReady, pageNumber, viewport])

  return (
    <div className="pdf-page" style={{ width, height }} data-page-number={pageNumber}>
      <canvas ref={pdfCanvasRef} className="pdf-page__canvas" />
      <canvas
        ref={overlayCanvasRef}
        className="pdf-page__canvas pdf-page__canvas--overlay"
        onPointerDown={(event) => {
          const overlay = overlayCanvasRef.current
          if (!overlay || !viewport || !onPointerDown) return
          onPointerDown(event, { pageNumber, viewport, canvas: overlay })
        }}
      />
      {renderError ? <div className="pdf-page__error">Failed to render page {pageNumber}: {renderError}</div> : null}
      <div className="pdf-page__label">{pageNumber}</div>
    </div>
  )
}
