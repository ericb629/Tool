import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, PageViewport, RenderTask } from 'pdfjs-dist'

export interface PageOverlayContext {
  pageNumber: number
  viewport: PageViewport
  canvas: HTMLCanvasElement
}

interface PdfPageCanvasProps {
  doc: PDFDocumentProxy
  pageNumber: number
  scale: number
  rotation: number
  /** CSS-pixel size this page occupies, precomputed by the viewer for layout. */
  width: number
  height: number
  renderOverlay?: (ctx: CanvasRenderingContext2D, context: PageOverlayContext) => void
  onPointerDown?: (event: React.PointerEvent<HTMLCanvasElement>, context: PageOverlayContext) => void
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

        const pageViewport = page.getViewport({ scale, rotation })
        const canvas = pdfCanvasRef.current
        const overlay = overlayCanvasRef.current
        if (!canvas || !overlay) return

        const dpr = window.devicePixelRatio || 1
        const deviceWidth = Math.max(1, Math.floor(pageViewport.width * dpr))
        const deviceHeight = Math.max(1, Math.floor(pageViewport.height * dpr))

        for (const target of [canvas, overlay]) {
          target.width = deviceWidth
          target.height = deviceHeight
          target.style.width = `${pageViewport.width}px`
          target.style.height = `${pageViewport.height}px`
        }

        task = page.render({
          canvas,
          viewport: pageViewport,
          // Scale the whole page draw up to device pixels.
          transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0]
        })
        await task.promise
        if (!cancelled) setViewport(pageViewport)
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
      setViewport(undefined)
    }
  }, [doc, pageNumber, scale, rotation])

  // Overlay repaint. Separate from the PDF render so moving a markup does not
  // force the page bitmap to be redrawn. Every point drawn here is converted
  // from stored PDF user-space through the CURRENT viewport - nothing cached.
  useEffect(() => {
    const overlay = overlayCanvasRef.current
    if (!overlay || !viewport) return
    const ctx = overlay.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    ctx.save()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, viewport.width, viewport.height)
    renderOverlay?.(ctx, { pageNumber, viewport, canvas: overlay })
    ctx.restore()
  }, [viewport, renderOverlay, pageNumber, overlayRevision])

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
