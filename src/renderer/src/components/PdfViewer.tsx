import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight } from 'lucide-react'
import { PDF_CMAP_URL, PDF_STANDARD_FONT_URL, PDF_WASM_URL, pdfjsLib } from '../pdf/pdfjs'
import { IpcRangeTransport } from '../pdf/IpcRangeTransport'
import { canvasToPdfPoint } from '../pdf/coordinates'
import { viewportForPage } from '../pdf/pageViewport'
import { flushDocumentPages } from '../pdf/pageRetention'
import { intersectRegion, type PageRegion } from '../pdf/tiles'
import { rectFromCorners, type UserSpaceRect } from '../pdf/hitTest'
import {
  applyZoomAnchor,
  captureZoomAnchor,
  computePageLayout,
  type BasePageSize,
  type ZoomAnchor
} from '../pdf/zoomAnchor'
import { behaviorForButton, type InteractionConfig } from '../tools/interaction'
import { perfCount, perfNow, perfOn, perfRecord } from '../pdf/perf' // PERF

export type { InteractionConfig }
import PdfPageCanvas, { type PageOverlayContext } from './PdfPageCanvas'

const OVERSCAN_PAGES = 1
const PAGE_GAP = 12
const ZOOM_STEPS = [0.1, 0.17, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8]
const MIN_SCALE = 0.05
const MAX_SCALE = 12
/** Below this movement a press counts as a click, not a drag. */
const DRAG_THRESHOLD_PX = 4
/** And a click that lingers longer than this is treated as a drag attempt. */
const CLICK_MAX_MS = 600

export type ZoomMode = { kind: 'fit-width' } | { kind: 'fit-page' } | { kind: 'fixed'; scale: number }

export interface PageRectSelection {
  pageNumber: number
  rect: UserSpaceRect
}

interface PdfViewerProps {
  fileId: string
  active?: boolean
  interaction: InteractionConfig
  onDocumentLoaded?: (pageCount: number) => void
  renderOverlay?: (ctx: CanvasRenderingContext2D, context: PageOverlayContext) => void
  onPagePointerDown?: (event: React.PointerEvent<HTMLCanvasElement>, context: PageOverlayContext) => void
  onMarqueeComplete?: (selections: PageRectSelection[], additive: boolean) => void
  onContextMenu?: (clientX: number, clientY: number) => void
  overlayRevision?: string | number
  paletteSlot?: React.ReactNode
  /** Rendered at the left of the bottom status bar, before the page nav. */
  statusBarSlot?: React.ReactNode
  /** Rendered at the right end of the bottom status bar. */
  statusBarEnd?: React.ReactNode
}

export default function PdfViewer({
  fileId,
  active = true,
  interaction,
  onDocumentLoaded,
  renderOverlay,
  onPagePointerDown,
  onMarqueeComplete,
  onContextMenu,
  overlayRevision,
  paletteSlot,
  statusBarSlot,
  statusBarEnd
}: PdfViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const pageContexts = useRef(new Map<number, PageOverlayContext>())

  const [doc, setDoc] = useState<PDFDocumentProxy | undefined>(undefined)
  const [basePageSizes, setBasePageSizes] = useState<BasePageSize[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading')
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined)

  const [zoomMode, setZoomMode] = useState<ZoomMode>({ kind: 'fit-width' })
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  const [scrollTop, setScrollTop] = useState(0)
  // Tracked because tiling needs the visible region of each page, which at
  // high zoom is a horizontal window too - a 36x24 sheet at 8x is 20736 CSS
  // pixels wide, far past the viewport.
  const [scrollLeft, setScrollLeft] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [isPanning, setIsPanning] = useState(false)
  const [marqueeScreenRect, setMarqueeScreenRect] = useState<
    { left: number; top: number; width: number; height: number } | undefined
  >(undefined)

  perfCount('react:PdfViewer renders') // PERF

  // ---- document ------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setErrorMessage(undefined)
    setDoc(undefined)
    setBasePageSizes([])
    setCurrentPage(1)

    let transport: IpcRangeTransport | undefined
    let task: ReturnType<typeof pdfjsLib.getDocument> | undefined
    // Held so teardown can flush this document's retained pages. Closing a tab
    // must release its worker resources; without this, pages held by the
    // retention cache would outlive the document that owns them.
    let openedDoc: PDFDocumentProxy | undefined

    const openedAt = performance.now() // PERF

    void (async () => {
      let opened: { length: number; initialData: Uint8Array }
      try {
        opened = await window.api.pdfData.open(fileId)
      } catch (err) {
        if (!cancelled) {
          setStatus('error')
          setErrorMessage(err instanceof Error ? err.message : String(err))
        }
        return
      }
      if (cancelled) {
        void window.api.pdfData.close(fileId).catch(() => undefined)
        return
      }

      transport = new IpcRangeTransport(fileId, opened.length, opened.initialData, (message) => {
        if (cancelled) return
        setStatus('error')
        setErrorMessage(message)
      })
      // `pdfBug` turns on pdf.js's own StatTimer, which is what splits worker
      // parse ("Page Request") from canvas raster ("Rendering").
      //
      // GATED, not unconditional: StatTimer runs inside the render loop, and
      // there is no reason for a shipped build to pay for it. Read once here, at
      // open, so __PDF_PERF__ has to be set BEFORE the document opens for
      // bucket (b) to appear in the report. See pdf/perf.ts.
      task = pdfjsLib.getDocument({
        range: transport,
        disableAutoFetch: true,
        disableStream: true,
        // Runtime assets. Without wasmUrl, JBIG2/JPEG2000 images fail to decode
        // and pdf.js WARNS rather than throwing - the page renders without its
        // scan and looks merely empty. See pdf/pdfjs.ts.
        wasmUrl: PDF_WASM_URL,
        cMapUrl: PDF_CMAP_URL,
        cMapPacked: true,
        standardFontDataUrl: PDF_STANDARD_FONT_URL,
        pdfBug: perfOn() // PERF
      })

      try {
        const loaded = await task.promise
        openedDoc = loaded
        perfRecord('open:getDocument', performance.now() - openedAt) // PERF
        if (cancelled) return
        if (loaded.numPages === 0) {
          setStatus('empty')
          return
        }
        const sizes: BasePageSize[] = []
        const sizeLoopAt = performance.now() // PERF
        for (let pageNumber = 1; pageNumber <= loaded.numPages; pageNumber++) {
          const page = await loaded.getPage(pageNumber)
          if (cancelled) return
          // Same helper the page canvas renders through, so the layout box and
          // the rendered bitmap agree on rotated sheets. See pdf/pageViewport.
          const viewport = viewportForPage(page, 1)
          sizes.push({ width: viewport.width, height: viewport.height })
          page.cleanup()
        }
        if (cancelled) return
        perfRecord('open:sizeLoop', performance.now() - sizeLoopAt, { detail: `${loaded.numPages} pages` }) // PERF
        perfRecord('open:timeToReady', performance.now() - openedAt) // PERF
        setDoc(loaded)
        setBasePageSizes(sizes)
        setStatus('ready')
        onDocumentLoaded?.(loaded.numPages)
      } catch (err) {
        if (cancelled) return
        setStatus('error')
        setErrorMessage(err instanceof Error ? err.message : String(err))
      }
    })()

    return () => {
      cancelled = true
      // Before destroy(), so retained pages are cleaned up against a document
      // that is still alive rather than left dangling.
      if (openedDoc) flushDocumentPages(openedDoc)
      transport?.abort()
      void task?.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId])

  // ---- container measurement ----------------------------------------
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const measure = (): void => setContainerSize({ width: element.clientWidth, height: element.clientHeight })
    measure()
    let timer: number | undefined
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(measure, 120)
    })
    observer.observe(element)
    return () => {
      window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [status])

  // ---- scale + layout ------------------------------------------------
  const referenceSize = basePageSizes[Math.min(currentPage, basePageSizes.length) - 1] ?? basePageSizes[0]

  const scale = useMemo(() => {
    if (zoomMode.kind === 'fixed') return zoomMode.scale
    if (!referenceSize || containerSize.width === 0) return 1
    const availableWidth = Math.max(50, containerSize.width - 24)
    if (zoomMode.kind === 'fit-width') return availableWidth / referenceSize.width
    const availableHeight = Math.max(50, containerSize.height - 24)
    return Math.min(availableWidth / referenceSize.width, availableHeight / referenceSize.height)
  }, [zoomMode, referenceSize, containerSize])

  // Pages are laid out with an explicit left offset rather than a CSS
  // translate, so horizontal scrolling works when a page is wider than the
  // viewport AND so cursor-anchored zoom can invert the mapping exactly.
  const layout = useMemo(
    () => {
      // PERF: counted here rather than inside computePageLayout so zoomAnchor.ts
      // stays pure. It has exactly one production caller, so this is the same
      // number. StrictMode double-invokes useMemo factories, so with it on this
      // runs 2x per render pass and there are 2 render passes per wheel tick.
      const at = perfNow() // PERF
      const result = computePageLayout(basePageSizes, scale, containerSize.width, PAGE_GAP)
      if (perfOn()) { // PERF
        perfCount('layout:computePageLayout')
        perfRecord('layout:computePageLayout', performance.now() - at, {
          detail: `${basePageSizes.length} pages`
        })
      }
      return result
    },
    [basePageSizes, scale, containerSize.width]
  )

  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const scaleRef = useRef(scale)
  scaleRef.current = scale

  // ---- cursor-anchored zoom -----------------------------------------
  // Captured before the scale changes, applied against the layout recomputed
  // after it. See pdf/zoomAnchor.ts for why the anchor is an unscaled in-page
  // offset rather than a content-space pixel offset.
  const pendingAnchor = useRef<ZoomAnchor | undefined>(undefined)

  const applyZoom = useCallback((nextScale: number, clientX: number, clientY: number) => {
    const element = scrollRef.current
    if (!element) return
    const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, nextScale))
    if (Math.abs(clamped - scaleRef.current) < 1e-9) return

    const rect = element.getBoundingClientRect()
    const anchor = captureZoomAnchor(
      layoutRef.current,
      scaleRef.current,
      element.scrollLeft,
      element.scrollTop,
      clientX - rect.left,
      clientY - rect.top
    )
    if (!anchor) return
    pendingAnchor.current = anchor
    setZoomMode({ kind: 'fixed', scale: clamped })
  }, [])

  useLayoutEffect(() => {
    const anchor = pendingAnchor.current
    const element = scrollRef.current
    if (!anchor || !element) return
    pendingAnchor.current = undefined
    const next = applyZoomAnchor(layout, scale, anchor)
    if (!next) return
    element.scrollLeft = next.scrollLeft
    element.scrollTop = next.scrollTop
    // Read back rather than trusting the write: the browser clamps to the
    // scrollable range, so at the edges the applied offset is not the
    // requested one and the virtualized range must follow what actually took.
    setScrollTop(element.scrollTop)
    setScrollLeft(element.scrollLeft)
  }, [layout, scale])

  // ---- visible range -------------------------------------------------
  const visibleRange = useMemo(() => {
    perfCount('layout:visibleRange') // PERF
    if (!active) return { start: 1, end: 0 }
    if (layout.pages.length === 0) return { start: 1, end: 0 }
    const viewTop = scrollTop
    const viewBottom = scrollTop + (containerSize.height || 1)
    let start = layout.pages.length
    let end = 1
    layout.pages.forEach((page, index) => {
      if (page.top + page.height >= viewTop && page.top <= viewBottom) {
        start = Math.min(start, index + 1)
        end = Math.max(end, index + 1)
      }
    })
    if (start > end) {
      start = Math.min(layout.pages.length, Math.max(1, currentPage))
      end = start
    }
    return {
      start: Math.max(1, start - OVERSCAN_PAGES),
      end: Math.min(layout.pages.length, end + OVERSCAN_PAGES)
    }
  }, [active, layout, scrollTop, containerSize.height, currentPage])

  useEffect(() => {
    if (layout.pages.length === 0) return
    const focusLine = scrollTop + (containerSize.height || 0) / 2
    let candidate = 1
    layout.pages.forEach((page, index) => {
      if (page.top <= focusLine) candidate = index + 1
    })
    setCurrentPage(candidate)
  }, [scrollTop, containerSize.height, layout])

  /**
   * The on-screen region of each page, in that page's own CSS pixels, keyed by
   * page number. Only pages that intersect the viewport get an entry.
   *
   * This is what makes tiling possible: page-level virtualization decides
   * which pages mount, this decides which REGION of a mounted page is
   * rasterised. The two are independent - at 8x a single mounted page is far
   * larger than the viewport, and without this it would rasterise in full.
   */
  const visibleRegions = useMemo(() => {
    // Hot: this memo recomputes on every scroll and pan frame, so the start
    // stamp must not be an unconditional performance.now().
    const regionsAt = perfNow() // PERF
    perfCount('layout:visibleRegions') // PERF
    const regions = new Map<number, PageRegion>()
    if (containerSize.width === 0 || containerSize.height === 0) return regions
    const view: PageRegion = {
      left: scrollLeft,
      top: scrollTop,
      width: containerSize.width,
      height: containerSize.height
    }
    layout.pages.forEach((page, index) => {
      const overlap = intersectRegion(view, page)
      if (!overlap) return
      // Content space -> page-local, which is what the tile grid is defined in.
      regions.set(index + 1, {
        left: overlap.left - page.left,
        top: overlap.top - page.top,
        width: overlap.width,
        height: overlap.height
      })
    })
    if (perfOn()) perfRecord('layout:visibleRegions', performance.now() - regionsAt) // PERF
    return regions
  }, [layout, scrollLeft, scrollTop, containerSize])

  const handleScroll = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    setScrollTop(element.scrollTop)
    setScrollLeft(element.scrollLeft)
  }, [])

  useEffect(() => {
    if (!active) return
    const element = scrollRef.current
    if (!element || element.scrollTop === scrollTop) return
    element.scrollTop = scrollTop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const scrollToPage = useCallback(
    (pageNumber: number) => {
      const element = scrollRef.current
      const target = layout.pages[pageNumber - 1]
      if (element && target) element.scrollTo({ top: target.top })
    },
    [layout]
  )

  // ---- wheel: scroll, or ctrl+wheel to zoom at the cursor -------------
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    // A "gesture" is a run of wheel events with no 200ms gap. Events-per-gesture
    // is the number that confirms or kills the no-coalescing hypothesis.
    let lastWheelAt = 0 // PERF
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey) return // plain wheel keeps the container's native scroll
      if (perfOn()) { // PERF
        const now = performance.now()
        if (now - lastWheelAt > 200) perfCount('zoom:wheel gestures')
        lastWheelAt = now
        perfCount('zoom:wheel events')
      }
      event.preventDefault()
      const factor = Math.exp(-event.deltaY / 400)
      applyZoom(scaleRef.current * factor, event.clientX, event.clientY)
    }
    // Not passive: zooming must be able to preventDefault the page zoom.
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [applyZoom, status])

  // ---- drag gestures: pan, marquee, click-vs-drag --------------------
  const gesture = useRef<
    | {
        pointerId: number
        button: number
        behavior: 'pan' | 'marquee'
        startClientX: number
        startClientY: number
        startScrollLeft: number
        startScrollTop: number
        startedAt: number
        moved: boolean
        additive: boolean
      }
    | undefined
  >(undefined)
  const suppressContextMenu = useRef(false)

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    const element = scrollRef.current
    if (!element) return
    // 'none' is the drawing-tool left button: those clicks are delivered by
    // the page canvas as point placements, not handled as a drag here.
    const behavior = behaviorForButton(event.button, interaction)
    if (behavior === 'none') return

    gesture.current = {
      pointerId: event.pointerId,
      button: event.button,
      behavior,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startScrollLeft: element.scrollLeft,
      startScrollTop: element.scrollTop,
      startedAt: Date.now(),
      moved: false,
      additive: event.shiftKey || event.ctrlKey
    }
    element.setPointerCapture(event.pointerId)
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const g = gesture.current
    const element = scrollRef.current
    if (!g || !element || event.pointerId !== g.pointerId) return

    const dx = event.clientX - g.startClientX
    const dy = event.clientY - g.startClientY
    if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
    if (!g.moved) {
      g.moved = true
      // Only once, at the threshold crossing: a pan re-renders on every move
      // anyway, and flipping this per-move would add a second state write.
      // A click that never crosses the threshold never shows `grabbing`.
      if (g.behavior === 'pan') setIsPanning(true)
    }

    if (g.behavior === 'pan') {
      perfCount('pan:pointermove events') // PERF
      // Drive the scroll container itself, so panning and the virtualized
      // scroll are the same mechanism rather than two competing ones.
      element.scrollLeft = g.startScrollLeft - dx
      element.scrollTop = g.startScrollTop - dy
      setScrollTop(element.scrollTop)
      setScrollLeft(element.scrollLeft)
      return
    }

    const rect = element.getBoundingClientRect()
    const x0 = g.startClientX - rect.left
    const y0 = g.startClientY - rect.top
    const x1 = event.clientX - rect.left
    const y1 = event.clientY - rect.top
    setMarqueeScreenRect({
      left: Math.min(x0, x1),
      top: Math.min(y0, y1),
      width: Math.abs(x1 - x0),
      height: Math.abs(y1 - y0)
    })
  }

  function finishGesture(event: React.PointerEvent<HTMLDivElement>): void {
    const g = gesture.current
    const element = scrollRef.current
    if (!g || !element || event.pointerId !== g.pointerId) return
    gesture.current = undefined
    setIsPanning(false)
    element.releasePointerCapture?.(event.pointerId)
    setMarqueeScreenRect(undefined)

    const shortEnough = Date.now() - g.startedAt <= CLICK_MAX_MS
    if (!g.moved && shortEnough && g.button === 2) {
      onContextMenu?.(event.clientX, event.clientY)
      return
    }
    if (g.moved) suppressContextMenu.current = true
    if (!g.moved || g.behavior !== 'marquee') return

    // Convert the screen rect into each visible page's OWN user-space using
    // that page's live viewport - the conversion stays on the coordinate
    // boundary and a marquee spanning pages is handled per page.
    const selections: PageRectSelection[] = []
    for (const [pageNumber, context] of pageContexts.current) {
      const canvasRect = context.canvas.getBoundingClientRect()
      const overlapsX = Math.min(g.startClientX, event.clientX) <= canvasRect.right && Math.max(g.startClientX, event.clientX) >= canvasRect.left
      const overlapsY = Math.min(g.startClientY, event.clientY) <= canvasRect.bottom && Math.max(g.startClientY, event.clientY) >= canvasRect.top
      if (!overlapsX || !overlapsY) continue
      // The overlay canvas is a window onto the page, not the whole page, so
      // its origin within the page has to be added back before converting.
      const a = canvasToPdfPoint(
        context.viewport,
        g.startClientX - canvasRect.left + context.origin.x,
        g.startClientY - canvasRect.top + context.origin.y
      )
      const b = canvasToPdfPoint(
        context.viewport,
        event.clientX - canvasRect.left + context.origin.x,
        event.clientY - canvasRect.top + context.origin.y
      )
      selections.push({ pageNumber, rect: rectFromCorners(a, b) })
    }
    onMarqueeComplete?.(selections, g.additive)
  }

  const registerPage = useCallback((pageNumber: number, context: PageOverlayContext | undefined) => {
    if (context) pageContexts.current.set(pageNumber, context)
    else pageContexts.current.delete(pageNumber)
  }, [])

  const changeZoomStep = useCallback(
    (direction: 1 | -1) => {
      const element = scrollRef.current
      const next =
        direction === 1
          ? ZOOM_STEPS.find((s) => s > scale + 1e-6)
          : [...ZOOM_STEPS].reverse().find((s) => s < scale - 1e-6)
      if (!next) return
      // Buttons zoom about the viewport centre; the wheel zooms at the cursor.
      const rect = element?.getBoundingClientRect()
      applyZoom(next, (rect?.left ?? 0) + (rect?.width ?? 0) / 2, (rect?.top ?? 0) + (rect?.height ?? 0) / 2)
    },
    [scale, applyZoom]
  )

  // ---- typeable page number -------------------------------------------
  // Held as a string so a half-typed value is never coerced into a jump.
  const [pageInput, setPageInput] = useState('1')
  const pageInputFocused = useRef(false)
  // Set when Enter or Esc already resolved the edit, so the blur that follows
  // does not commit a second time.
  const pageEditHandled = useRef(false)

  // Follows the page as it changes by SCROLLING, not just via the arrows -
  // but never while the field has focus, or it would overwrite typing.
  useEffect(() => {
    if (!pageInputFocused.current) setPageInput(String(currentPage))
  }, [currentPage])

  const commitPageInput = useCallback(() => {
    const raw = pageInput.trim()
    const parsed = Number(raw)
    // Anything not a whole number in range reverts. Leaving a bad value in the
    // field, or jumping to a coerced one, are both worse than not moving.
    if (!/^\d+$/.test(raw) || !Number.isInteger(parsed) || parsed < 1 || parsed > basePageSizes.length) {
      setPageInput(String(currentPage))
      return
    }
    setPageInput(String(parsed))
    const element = scrollRef.current
    const target = layout.pages[parsed - 1]
    if (element && target) element.scrollTo({ top: target.top })
  }, [pageInput, basePageSizes.length, currentPage, layout])

  const pageCount = basePageSizes.length

  if (status === 'loading') return <div className="pdf-viewer__message">Loading PDF…</div>
  if (status === 'error') {
    return (
      <div className="pdf-viewer__message pdf-viewer__message--error">
        Could not open this PDF.
        {errorMessage ? <div className="pdf-viewer__message-detail">{errorMessage}</div> : null}
      </div>
    )
  }
  if (status === 'empty') return <div className="pdf-viewer__message">This PDF has no pages.</div>



  return (
    <div className="pdf-viewer">
      {/* Wrapper is the positioning context for the marquee, which must sit
          over the viewport and NOT scroll with the content. */}
      <div className="pdf-viewer__viewport">
      <div
        className="pdf-viewer__scroll"
        ref={scrollRef}
        onScroll={handleScroll}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishGesture}
        onPointerCancel={finishGesture}
        onContextMenu={(e) => {
          // A drag that happened to use the right button must not also raise
          // the browser menu on release.
          e.preventDefault()
          if (suppressContextMenu.current) suppressContextMenu.current = false
        }}
        style={{ cursor: isPanning ? 'grabbing' : interaction.cursor }}
      >
        <div className="pdf-viewer__canvas-area" style={{ height: layout.totalHeight, width: layout.contentWidth }}>
          {doc &&
            layout.pages.map((page, index) => {
              const pageNumber = index + 1
              if (pageNumber < visibleRange.start || pageNumber > visibleRange.end) return null
              return (
                <div
                  key={pageNumber}
                  className="pdf-viewer__page-slot"
                  style={{ top: page.top, left: page.left, width: page.width, height: page.height }}
                >
                  <PdfPageCanvas
                    doc={doc}
                    pageNumber={pageNumber}
                    scale={scale}
                    rotation={0}
                    width={page.width}
                    height={page.height}
                    visible={visibleRegions.get(pageNumber)}
                    renderOverlay={renderOverlay}
                    onPointerDown={onPagePointerDown}
                    onViewportReady={registerPage}
                    overlayRevision={overlayRevision}
                  />
                </div>
              )
            })}
        </div>
      </div>

      {marqueeScreenRect ? (
        <div
          className="pdf-viewer__marquee"
          style={{
            left: marqueeScreenRect.left,
            top: marqueeScreenRect.top,
            width: marqueeScreenRect.width,
            height: marqueeScreenRect.height
          }}
        />
      ) : null}
      </div>

      {/* Thin status bar. Sits outside the viewport wrapper and is flex:none,
          so it costs a fixed ~26px and the scroll container keeps the rest -
          scroll position, the ResizeObserver measurement and virtualization
          are all unchanged by it. */}
      <div className="pdf-viewer__statusbar">
        {statusBarSlot}
        <span className="pdf-viewer__separator" />
        <button className="pdf-viewer__barbtn" onClick={() => changeZoomStep(-1)} title="Zoom out" aria-label="Zoom out">
          −
        </button>
        <span className="pdf-viewer__zoom-indicator">{Math.round(scale * 100)}%</span>
        <button className="pdf-viewer__barbtn" onClick={() => changeZoomStep(1)} title="Zoom in" aria-label="Zoom in">
          +
        </button>
        <button
          className={`pdf-viewer__barbtn${zoomMode.kind === 'fit-width' ? ' pdf-viewer__barbtn--active' : ''}`}
          onClick={() => setZoomMode({ kind: 'fit-width' })}
        >
          Fit width
        </button>
        <button
          className={`pdf-viewer__barbtn${zoomMode.kind === 'fit-page' ? ' pdf-viewer__barbtn--active' : ''}`}
          onClick={() => setZoomMode({ kind: 'fit-page' })}
        >
          Fit page
        </button>
        <span className="pdf-viewer__separator" />
        {paletteSlot}
        <span className="pdf-viewer__separator" />
        <div className="pdf-viewer__pagenav">
          <button
            className="pdf-viewer__iconbtn"
            onClick={() => scrollToPage(1)}
            disabled={currentPage <= 1}
            title="First page"
            aria-label="First page"
          >
            <ChevronFirst size={15} aria-hidden="true" />
          </button>
          <button
            className="pdf-viewer__iconbtn"
            onClick={() => scrollToPage(currentPage - 1)}
            disabled={currentPage <= 1}
            title="Previous page"
            aria-label="Previous page"
          >
            <ChevronLeft size={15} aria-hidden="true" />
          </button>
          <span className="pdf-viewer__pagefield">
          <input
            className="pdf-viewer__page-input"
            value={pageInput}
            inputMode="numeric"
            aria-label={`Page number, 1 to ${pageCount}`}
            onChange={(e) => setPageInput(e.target.value)}
            onFocus={(e) => {
              pageInputFocused.current = true
              e.target.select()
            }}
            onBlur={() => {
              pageInputFocused.current = false
              if (pageEditHandled.current) {
                pageEditHandled.current = false
                return
              }
              commitPageInput()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitPageInput()
                pageEditHandled.current = true
                e.currentTarget.blur()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                // Kept local: the editor's global Esc would otherwise also
                // cancel a draw or clear the selection.
                e.stopPropagation()
                setPageInput(String(currentPage))
                pageEditHandled.current = true
                e.currentTarget.blur()
              }
            }}
          />
          <span className="pdf-viewer__page-total">of {pageCount}</span>
          </span>
          <button
            className="pdf-viewer__iconbtn"
            onClick={() => scrollToPage(currentPage + 1)}
            disabled={currentPage >= pageCount}
            title="Next page"
            aria-label="Next page"
          >
            <ChevronRight size={15} aria-hidden="true" />
          </button>
          <button
            className="pdf-viewer__iconbtn"
            onClick={() => scrollToPage(pageCount)}
            disabled={currentPage >= pageCount}
            title="Last page"
            aria-label="Last page"
          >
            <ChevronLast size={15} aria-hidden="true" />
          </button>
        </div>
        <span className="pdf-viewer__separator" />
        {statusBarEnd}
      </div>
    </div>
  )
}
