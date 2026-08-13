import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { pdfjsLib } from '../pdf/pdfjs'
import PdfPageCanvas, { type PageOverlayContext } from './PdfPageCanvas'

/** Pages rendered beyond the visible range, so scrolling doesn't flash blank. */
const OVERSCAN_PAGES = 1
const PAGE_GAP = 12
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8]

export type ZoomMode = { kind: 'fit-width' } | { kind: 'fit-page' } | { kind: 'fixed'; scale: number }

interface BasePageSize {
  width: number
  height: number
}

interface PdfViewerProps {
  /** app-file:// URL; bytes are streamed by the main process, never sent over IPC. */
  url: string
  onDocumentLoaded?: (pageCount: number) => void
  renderOverlay?: (ctx: CanvasRenderingContext2D, context: PageOverlayContext) => void
  onPagePointerDown?: (event: React.PointerEvent<HTMLCanvasElement>, context: PageOverlayContext) => void
  overlayRevision?: string | number
  toolbarExtras?: React.ReactNode
}

export default function PdfViewer({
  url,
  onDocumentLoaded,
  renderOverlay,
  onPagePointerDown,
  overlayRevision,
  toolbarExtras
}: PdfViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  const [doc, setDoc] = useState<PDFDocumentProxy | undefined>(undefined)
  const [basePageSizes, setBasePageSizes] = useState<BasePageSize[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading')
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined)

  const [zoomMode, setZoomMode] = useState<ZoomMode>({ kind: 'fit-width' })
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  const [scrollTop, setScrollTop] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)

  // ---- load document -------------------------------------------------
  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setErrorMessage(undefined)
    setDoc(undefined)
    setBasePageSizes([])
    setCurrentPage(1)

    const task = pdfjsLib.getDocument({ url })
    void task.promise.then(
      async (loaded) => {
        // Teardown is the loading task's job (see cleanup below), not the
        // document proxy's - PDFDocumentProxy has no destroy().
        if (cancelled) return
        if (loaded.numPages === 0) {
          setStatus('empty')
          return
        }
        // Measure every page once at scale 1 so the scroll container can be
        // laid out (and virtualized) without rendering anything.
        const sizes: BasePageSize[] = []
        for (let pageNumber = 1; pageNumber <= loaded.numPages; pageNumber++) {
          const page = await loaded.getPage(pageNumber)
          if (cancelled) return
          const viewport = page.getViewport({ scale: 1 })
          sizes.push({ width: viewport.width, height: viewport.height })
        }
        if (cancelled) return
        setDoc(loaded)
        setBasePageSizes(sizes)
        setStatus('ready')
        onDocumentLoaded?.(loaded.numPages)
      },
      (err) => {
        if (cancelled) return
        setStatus('error')
        setErrorMessage(err instanceof Error ? err.message : String(err))
      }
    )

    return () => {
      cancelled = true
      void task.destroy()
    }
    // onDocumentLoaded deliberately excluded: it is a callback identity, not
    // an input to loading, and including it would reload the document on
    // every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  // ---- container measurement (debounced) -----------------------------
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return

    const measure = (): void => {
      setContainerSize({ width: element.clientWidth, height: element.clientHeight })
    }
    measure()

    let timer: number | undefined
    const observer = new ResizeObserver(() => {
      // Debounced: a drag-resize fires continuously, and each change would
      // otherwise re-render every visible page at a new scale.
      window.clearTimeout(timer)
      timer = window.setTimeout(measure, 120)
    })
    observer.observe(element)
    return () => {
      window.clearTimeout(timer)
      observer.disconnect()
    }
    // Depends on `status`: the scroll container is not in the DOM while the
    // document is loading (the component early-returns a message instead), so
    // a mount-only effect would find a null ref and never re-attach - leaving
    // containerSize at 0 and the scale pinned to its fallback of 1.
  }, [status])

  // ---- scale ---------------------------------------------------------
  const referenceSize = basePageSizes[Math.min(currentPage, basePageSizes.length) - 1] ?? basePageSizes[0]

  const scale = useMemo(() => {
    if (zoomMode.kind === 'fixed') return zoomMode.scale
    if (!referenceSize || containerSize.width === 0) return 1
    // Leave room for the scrollbar and the page's own margin.
    const availableWidth = Math.max(50, containerSize.width - 24)
    if (zoomMode.kind === 'fit-width') return availableWidth / referenceSize.width
    const availableHeight = Math.max(50, containerSize.height - 24)
    return Math.min(availableWidth / referenceSize.width, availableHeight / referenceSize.height)
  }, [zoomMode, referenceSize, containerSize])

  // ---- layout --------------------------------------------------------
  const layout = useMemo(() => {
    let offset = 0
    const pages = basePageSizes.map((size) => {
      const width = size.width * scale
      const height = size.height * scale
      const top = offset
      offset += height + PAGE_GAP
      return { top, width, height }
    })
    return { pages, totalHeight: Math.max(0, offset - PAGE_GAP) }
  }, [basePageSizes, scale])

  // ---- visible range -------------------------------------------------
  const visibleRange = useMemo(() => {
    if (layout.pages.length === 0) return { start: 1, end: 0 }
    const viewTop = scrollTop
    const viewBottom = scrollTop + (containerSize.height || 1)
    let start = layout.pages.length
    let end = 1
    layout.pages.forEach((page, index) => {
      const pageBottom = page.top + page.height
      if (pageBottom >= viewTop && page.top <= viewBottom) {
        start = Math.min(start, index + 1)
        end = Math.max(end, index + 1)
      }
    })
    if (start > end) {
      // Scrolled into a gap between pages.
      start = Math.min(layout.pages.length, Math.max(1, currentPage))
      end = start
    }
    return {
      start: Math.max(1, start - OVERSCAN_PAGES),
      end: Math.min(layout.pages.length, end + OVERSCAN_PAGES)
    }
  }, [layout, scrollTop, containerSize.height, currentPage])

  // Track which page is "current" for the page indicator: the one covering
  // the vertical middle of the viewport.
  useEffect(() => {
    if (layout.pages.length === 0) return
    const focusLine = scrollTop + (containerSize.height || 0) / 2
    let candidate = 1
    layout.pages.forEach((page, index) => {
      if (page.top <= focusLine) candidate = index + 1
    })
    setCurrentPage(candidate)
  }, [scrollTop, containerSize.height, layout])

  const handleScroll = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    setScrollTop(element.scrollTop)
  }, [])

  const scrollToPage = useCallback(
    (pageNumber: number) => {
      const element = scrollRef.current
      const target = layout.pages[pageNumber - 1]
      if (!element || !target) return
      element.scrollTo({ top: target.top })
    },
    [layout]
  )

  const pageCount = basePageSizes.length

  const changeZoom = useCallback(
    (direction: 1 | -1) => {
      const current = scale
      const next =
        direction === 1
          ? ZOOM_STEPS.find((step) => step > current + 1e-6)
          : [...ZOOM_STEPS].reverse().find((step) => step < current - 1e-6)
      if (next) setZoomMode({ kind: 'fixed', scale: next })
    },
    [scale]
  )

  if (status === 'loading') {
    return <div className="pdf-viewer__message">Loading PDF…</div>
  }
  if (status === 'error') {
    return (
      <div className="pdf-viewer__message pdf-viewer__message--error">
        Could not open this PDF.
        {errorMessage ? <div className="pdf-viewer__message-detail">{errorMessage}</div> : null}
      </div>
    )
  }
  if (status === 'empty') {
    return <div className="pdf-viewer__message">This PDF has no pages.</div>
  }

  return (
    <div className="pdf-viewer">
      <div className="pdf-viewer__toolbar">
        <button onClick={() => scrollToPage(currentPage - 1)} disabled={currentPage <= 1} title="Previous page">
          ◀
        </button>
        <span className="pdf-viewer__page-indicator">
          Page {currentPage} of {pageCount}
        </span>
        <button
          onClick={() => scrollToPage(currentPage + 1)}
          disabled={currentPage >= pageCount}
          title="Next page"
        >
          ▶
        </button>

        <span className="pdf-viewer__separator" />

        <button onClick={() => changeZoom(-1)} title="Zoom out">
          −
        </button>
        <span className="pdf-viewer__zoom-indicator">{Math.round(scale * 100)}%</span>
        <button onClick={() => changeZoom(1)} title="Zoom in">
          +
        </button>
        <button
          className={zoomMode.kind === 'fit-width' ? 'active' : ''}
          onClick={() => setZoomMode({ kind: 'fit-width' })}
        >
          Fit width
        </button>
        <button
          className={zoomMode.kind === 'fit-page' ? 'active' : ''}
          onClick={() => setZoomMode({ kind: 'fit-page' })}
        >
          Fit page
        </button>

        {toolbarExtras}
      </div>

      <div className="pdf-viewer__scroll" ref={scrollRef} onScroll={handleScroll}>
        <div className="pdf-viewer__canvas-area" style={{ height: layout.totalHeight }}>
          {doc &&
            layout.pages.map((page, index) => {
              const pageNumber = index + 1
              // Virtualization: only pages inside the visible window are
              // mounted. Unmounting cancels their render task and releases
              // the canvas (see PdfPageCanvas).
              if (pageNumber < visibleRange.start || pageNumber > visibleRange.end) return null
              return (
                <div
                  key={pageNumber}
                  className="pdf-viewer__page-slot"
                  style={{ top: page.top, width: page.width, height: page.height }}
                >
                  <PdfPageCanvas
                    doc={doc}
                    pageNumber={pageNumber}
                    scale={scale}
                    rotation={0}
                    width={page.width}
                    height={page.height}
                    renderOverlay={renderOverlay}
                    onPointerDown={onPagePointerDown}
                    overlayRevision={overlayRevision}
                  />
                </div>
              )
            })}
        </div>
      </div>
    </div>
  )
}
