import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Hand, MousePointer2 } from 'lucide-react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import PdfViewer, { type PageRectSelection } from './PdfViewer'
import { resolveInteraction, type InteractionMode } from '../tools/interaction'
import type { PageOverlayContext } from './PdfPageCanvas'
import ToolPalette from './ToolPalette'
import ContextMenu from './ContextMenu'
import { pdfPointToCanvas, pointerEventToPdfPoint } from '../pdf/coordinates'
import { geometryIntersectsRect, geometryPoints, hitTestGeometry } from '../pdf/hitTest'
import { TOOL_BY_ID, isDrawingTool, type ToolId } from '../tools/registry'
import { parseScaleString, SCALE_PRESETS } from '../pdf/scale'
import { extractTextInRect, pageHasTextLayer, type TextRun } from '../pdf/textExtract'
import type {
  AreaUnit,
  LinearUnit,
  MarkupObject,
  PageCalibration,
  PdfFileManifest,
  PdfPoint,
  QuantityResult,
  Uuid,
  VolumeUnit
} from '../../../shared/manifest'

const LINEAR_UNITS: LinearUnit[] = ['ft', 'in', 'm', 'cm', 'mm']
const AREA_UNITS: AreaUnit[] = ['sf', 'sy', 'm2', 'acre']
const VOLUME_UNITS: VolumeUnit[] = ['cf', 'cy', 'm3']
/** Geometry kinds that draw a closed, fillable boundary. */
const CLOSED_GEOMETRY_KINDS = new Set(['polygon', 'rect'])
/** Grab radius in SCREEN pixels; converted to user-space by dividing by scale. */
const HIT_TOLERANCE_PX = 6

interface DrawOpts {
  dashed?: boolean
  closed?: boolean
  dots?: boolean
  dotRadius?: number
}

interface PdfEditorPanelProps {
  fileId: Uuid
  manifest: PdfFileManifest
  layerId: Uuid
  active?: boolean
  /**
   * Controlled: the tool strip for the four measuring tools lives in the
   * TabBar (App), not in this component, so App owns which tool is active
   * per tab and passes it down. Select/Pan/Calibrate are still chosen from
   * the in-viewer ToolPalette, which calls onToolChange the same way.
   */
  toolId: ToolId
  onToolChange: (id: ToolId) => void
  /** Derives a quantity for a specific markup, on demand. */
  quantityForMarkup: (markupId: Uuid) => QuantityResult | undefined
  onDocumentLoaded: (pageCount: number) => void
  onSaveCalibration: (calibration: PageCalibration) => void
  onSaveMarkup: (markup: MarkupObject) => void
  /**
   * Drag-box text extraction (Extract Text tool) writes into whichever cell
   * is currently active in the spreadsheet panel - that's App-level state,
   * not this tab's. Returns an error message to show inline if there is
   * nowhere to put the text (e.g. no cell has been clicked yet); undefined
   * means it was written.
   */
  onExtractText?: (text: string) => string | undefined
  /** "B3", shown so the user can see the extraction target before dragging. */
  activeCellLabel?: string
}

function formatQuantity(result: QuantityResult | undefined): string {
  if (!result) return '—'
  if (result.status === 'uncalibrated') return 'uncalibrated'
  if (result.status === 'not-measurable') return 'not measurable'
  return `${result.value.toFixed(2)} ${result.unit}`
}

export default function PdfEditorPanel({
  fileId,
  manifest,
  layerId,
  active = true,
  toolId,
  onToolChange,
  quantityForMarkup,
  onDocumentLoaded,
  onSaveCalibration,
  onSaveMarkup,
  onExtractText,
  activeCellLabel
}: PdfEditorPanelProps) {
  // Selection is per-tab session state: this component stays mounted per
  // tab, so its state is per-tab for free. Tool CHOICE is controlled by App
  // (see toolId/onToolChange above) so the markup toolbar in the TabBar can
  // reach it, but each tab still keeps its own choice - App keys it by tab.
  const [interactionMode, setInteractionMode] = useState<InteractionMode>('mouse')
  const [selectedIds, setSelectedIds] = useState<Uuid[]>([])

  // In-progress draw. Points are PdfPoints - no pixel ever enters state.
  const [drawPage, setDrawPage] = useState<number | undefined>(undefined)
  const [drawPoints, setDrawPoints] = useState<PdfPoint[]>([])
  // Points popped by Ctrl+Z, restorable by Ctrl+R - see ToolDefinition.supportsPointUndo.
  // Placing a new point (not a redo) clears it, same as any editor's undo stack.
  const [redoStack, setRedoStack] = useState<PdfPoint[]>([])
  const [realDistance, setRealDistance] = useState('')
  const [calibrationUnit, setCalibrationUnit] = useState<LinearUnit>('ft')
  const [measureUnit, setMeasureUnit] = useState<LinearUnit>('ft')
  const [areaUnit, setAreaUnit] = useState<AreaUnit>('sf')
  // Depth is optional (Area tool only): left blank, the markup takes off as
  // area; filled in, it switches to a volume takeoff (area x depth) - see
  // ToolDefinition.supportsDepth.
  const [depthValue, setDepthValue] = useState('')
  const [depthUnit, setDepthUnit] = useState<LinearUnit>('ft')
  const [volumeUnit, setVolumeUnit] = useState<VolumeUnit>('cy')
  const [menu, setMenu] = useState<{ x: number; y: number } | undefined>(undefined)

  // Calibration has two input methods: measure a known distance on the page
  // (the original flow, drawPoints + realDistance above), or type/pick the
  // sheet's printed scale directly - which needs no points at all. viewedPage
  // tracks which page a typed scale applies to, since there is nothing drawn
  // to infer it from.
  const [calibrationMode, setCalibrationMode] = useState<'distance' | 'scale'>('scale')
  const [scaleText, setScaleText] = useState('')
  const [viewedPage, setViewedPage] = useState(1)

  // The opened document, held only for on-demand getTextContent() calls from
  // the Extract Text tool - rendering never reads this ref, PdfViewer owns
  // its own `doc` for that. A ref because it does not need to trigger a
  // render; extraction reads it at drag-completion time, not render time.
  const docRef = useRef<PDFDocumentProxy | undefined>(undefined)
  const [extractStatus, setExtractStatus] = useState<{ kind: 'error' | 'info'; message: string } | undefined>(
    undefined
  )

  const tool = TOOL_BY_ID[toolId]
  const drawing = isDrawingTool(tool)

  const cancelDraw = useCallback(() => {
    setDrawPoints([])
    setDrawPage(undefined)
    setRealDistance('')
    setScaleText('')
    setDepthValue('')
    setRedoStack([])
  }, [])

  // Ctrl+Z / Ctrl+R step back/forward through the in-progress draw's points
  // (see ToolDefinition.supportsPointUndo). Each does exactly one setState
  // call per array, reading the other from render scope rather than nesting
  // a setState inside another's functional updater - StrictMode invokes
  // updater functions twice to check purity, so a setRedoStack nested inside
  // setDrawPoints's updater silently ran twice per keypress, duplicating
  // entries and producing exactly the "needs two presses" drift this was.
  const undoPoint = useCallback(() => {
    if (drawPoints.length === 0) return
    const popped = drawPoints[drawPoints.length - 1]
    setRedoStack((prev) => [...prev, popped])
    setDrawPoints((prev) => prev.slice(0, -1))
  }, [drawPoints])

  const redoPoint = useCallback(() => {
    if (redoStack.length === 0) return
    const restored = redoStack[redoStack.length - 1]
    setDrawPoints((prev) => [...prev, restored])
    setRedoStack((prev) => prev.slice(0, -1))
  }, [redoStack])

  // toolId is controlled (App owns it, see PdfEditorPanelProps), so a change
  // can arrive from outside this component - the markup toolbar in the
  // TabBar - with no chance to cancelDraw() first. Catch every change here
  // instead of at each call site, so in-progress points from tool A never
  // leak into tool B regardless of where the switch came from.
  const prevToolId = useRef(toolId)
  useEffect(() => {
    if (prevToolId.current !== toolId) {
      prevToolId.current = toolId
      cancelDraw()
      setExtractStatus(undefined)
    }
  }, [toolId, cancelDraw])

  // Esc cancels an in-progress draw and returns to Select; with nothing in
  // progress it clears the selection.
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setMenu(undefined)
      if (drawPoints.length > 0 || drawing) {
        onToolChange('select')
      } else {
        setSelectedIds([])
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, drawing, drawPoints.length, onToolChange])

  // Ctrl+Z/Ctrl+R undo/redo the in-progress draw's points. preventDefault so
  // Ctrl+R does not fall through to any default reload behavior.
  useEffect(() => {
    if (!active || !drawing || !tool.supportsPointUndo) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey) return
      if (event.key === 'z' || event.key === 'Z') {
        event.preventDefault()
        undoPoint()
      } else if (event.key === 'r' || event.key === 'R') {
        event.preventDefault()
        redoPoint()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, drawing, tool, undoPoint, redoPoint])

  // ---- commit (defined before handlePagePointerDown/handlePageDoubleClick,
  // which call it) -------------------------------------------------------
  // Takes an explicit points array (defaulting to current state) so the
  // double-click handler can commit with a trimmed list in the SAME event,
  // without waiting a render for setDrawPoints to land first.
  const commitMarkup = useCallback(
    (points: PdfPoint[] = drawPoints): void => {
      if (!tool.produces || !tool.buildGeometry || !tool.buildTakeoff) return
      if (drawPage === undefined || points.length < (tool.minPoints ?? 2)) return
      const now = new Date().toISOString()
      const depth = tool.supportsDepth ? Number.parseFloat(depthValue) : NaN
      // Depth turns an area takeoff into a volume takeoff (area x depth) on
      // the SAME geometry/MarkupType - see ToolDefinition.supportsDepth. Left
      // blank, the tool's own declared takeoff (area) is used unchanged.
      const takeoff =
        tool.supportsDepth && Number.isFinite(depth) && depth > 0
          ? { mode: 'volume' as const, unit: volumeUnit, depth, depthUnit }
          : tool.buildTakeoff(tool.unitKind === 'area' ? areaUnit : measureUnit)
      onSaveMarkup({
        id: crypto.randomUUID(),
        pageNumber: drawPage,
        layerId,
        // The tool declares its type; validateMarkup in the main process still
        // checks the type/takeoff pairing, so a tool cannot smuggle in an
        // illegal combination.
        type: tool.produces.markupType,
        takeoff,
        geometry: tool.buildGeometry(points),
        style: { color: tool.defaultColor },
        createdAt: now,
        updatedAt: now
      })
      cancelDraw()
    },
    [tool, drawPage, drawPoints, depthValue, volumeUnit, depthUnit, areaUnit, measureUnit, layerId, onSaveMarkup, cancelDraw]
  )

  // ---- pointer on a page ---------------------------------------------
  const handlePagePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>, context: PageOverlayContext) => {
      if (event.button !== 0) return
      setMenu(undefined)
      const point = pointerEventToPdfPoint(context.viewport, context.canvas, event, context.origin)

      // Extract Text's whole gesture is the marquee drag handled below in
      // handleMarquee - a plain click here has nothing to do (in particular,
      // not fall through to selecting whatever markup happens to be under it).
      if (tool.dragRect) return

      // Scale-typed calibration needs no clicks on the page at all - it
      // derives its reference line from the typed/picked scale instead.
      if (drawing && tool.isCalibration && calibrationMode === 'scale') return

      if (drawing) {
        // A draw belongs to one page; mixing pages would mix coordinate spaces.
        if (drawPage !== undefined && drawPage !== context.pageNumber) return

        // Every click places a point, including the first of a double-click
        // pair - handlePageDoubleClick trims that extra one back off when it
        // fires right after. PointerEvent.detail is NOT a reliable click-count
        // signal here, so double-click detection lives entirely there instead.
        setDrawPage(context.pageNumber)
        setDrawPoints((prev) => {
          const next = [...prev, point]
          return tool.exactPoints && next.length > tool.exactPoints ? [point] : next
        })
        // A new point invalidates whatever Ctrl+Z had queued for redo.
        setRedoStack([])
        return
      }

      // Select. Tolerance is screen-constant: divide by scale so a hairline is
      // as clickable at 17% as at 400%.
      const tolerance = HIT_TOLERANCE_PX / context.viewport.scale
      const hit = manifest.markups
        .filter((m) => m.pageNumber === context.pageNumber)
        .find((m) => hitTestGeometry(m.geometry, point, tolerance))
      const additive = event.shiftKey || event.ctrlKey
      if (!hit) {
        if (!additive) setSelectedIds([])
        return
      }
      setSelectedIds((prev) =>
        additive ? (prev.includes(hit.id) ? prev.filter((id) => id !== hit.id) : [...prev, hit.id]) : [hit.id]
      )
    },
    [drawing, drawPage, tool, manifest, calibrationMode]
  )

  // A double-click's second pointerdown already placed a point identical (or
  // very close) to the first - drop it before committing, so the shape ends
  // where the user's first click of the pair landed, not with a spurious
  // extra vertex. Uses the native `dblclick` event (via PdfPageCanvas),
  // unlike PointerEvent.detail, this reliably fires exactly once per pair.
  const handlePageDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>, context: PageOverlayContext) => {
      if (!drawing || !tool.dblClickFinish) return
      if (drawPage !== undefined && drawPage !== context.pageNumber) return
      event.preventDefault()
      const trimmed = drawPoints.length > 0 ? drawPoints.slice(0, -1) : drawPoints
      commitMarkup(trimmed)
    },
    [drawing, tool, drawPage, drawPoints, commitMarkup]
  )

  // Extract Text's whole job: pull the text under a dragged box into the
  // spreadsheet's active cell. Async because getPage/getTextContent are -
  // handleMarquee itself stays sync and just fires this without awaiting it.
  const handleExtractRect = useCallback(
    async (selection: PageRectSelection) => {
      const doc = docRef.current
      if (!doc) {
        setExtractStatus({ kind: 'error', message: 'Document is still loading - try again in a moment.' })
        return
      }
      const page = await doc.getPage(selection.pageNumber)
      const content = await page.getTextContent()
      // includeMarkedContent is not requested, so every item is a real
      // TextItem - filtered/mapped anyway since the union type does not
      // guarantee it (and pdfjs-dist does not export TextItem from its
      // public entry point, so this reads the fields structurally instead).
      const runs: TextRun[] = content.items.flatMap((item) =>
        'str' in item && 'transform' in item && 'width' in item && 'height' in item
          ? [{ str: item.str, transform: item.transform, width: item.width, height: item.height }]
          : []
      )

      if (!pageHasTextLayer(runs)) {
        setExtractStatus({
          kind: 'error',
          message: `Page ${selection.pageNumber} has no extractable text - it's a scanned image, not a text layer.`
        })
        return
      }

      const text = extractTextInRect(runs, selection.rect)
      if (!text) {
        setExtractStatus({ kind: 'info', message: 'No text found in that box.' })
        return
      }

      const error = onExtractText?.(text)
      setExtractStatus(
        error ? { kind: 'error', message: error } : { kind: 'info', message: `Extracted: "${text}"` }
      )
    },
    [onExtractText]
  )

  const handleMarquee = useCallback(
    (selections: PageRectSelection[], additive: boolean) => {
      if (tool.dragRect) {
        // A drag box belongs to whichever page it started on; spanning pages
        // is not meaningful for a single extracted cell value.
        if (selections.length > 0) void handleExtractRect(selections[0])
        return
      }
      const hits: Uuid[] = []
      for (const { pageNumber, rect } of selections) {
        for (const markup of manifest.markups) {
          if (markup.pageNumber !== pageNumber) continue
          if (geometryIntersectsRect(markup.geometry, rect)) hits.push(markup.id)
        }
      }
      setSelectedIds((prev) => (additive ? Array.from(new Set([...prev, ...hits])) : hits))
    },
    [manifest, tool, handleExtractRect]
  )

  // ---- overlay --------------------------------------------------------
  const renderOverlay = useCallback(
    (ctx: CanvasRenderingContext2D, context: PageOverlayContext) => {
      const { viewport, pageNumber } = context

      // `closed` also fills the shape (lightly) so an area/circle markup
      // reads as a region rather than just its boundary. `dots` marks each
      // actual vertex, small and only when the caller asks for them - a
      // committed markup shows them only while selected, so an unselected
      // line/area/circle reads as a clean shape rather than a dotted one.
      const stroke = (
        points: PdfPoint[],
        color: string,
        width: number,
        { dashed = false, closed = false, dots = true, dotRadius = 3 }: DrawOpts = {}
      ): void => {
        if (points.length === 0) return
        ctx.save()
        ctx.strokeStyle = color
        ctx.fillStyle = color
        ctx.lineWidth = width
        if (dashed) ctx.setLineDash([6, 4])
        ctx.beginPath()
        const first = pdfPointToCanvas(viewport, points[0])
        ctx.moveTo(first.x, first.y)
        for (let i = 1; i < points.length; i++) {
          const p = pdfPointToCanvas(viewport, points[i])
          ctx.lineTo(p.x, p.y)
        }
        if (closed) {
          ctx.closePath()
          ctx.globalAlpha = 0.15
          ctx.fill()
          ctx.globalAlpha = 1
        }
        ctx.stroke()
        if (dots) {
          for (const point of points) {
            const p = pdfPointToCanvas(viewport, point)
            ctx.beginPath()
            ctx.arc(p.x, p.y, dotRadius, 0, Math.PI * 2)
            ctx.fill()
          }
        }
        ctx.restore()
      }

      const page = manifest.pages.find((p) => p.pageNumber === pageNumber)
      if (page?.calibration) stroke([page.calibration.pointA, page.calibration.pointB], '#2a9d8f', 2)

      for (const markup of manifest.markups) {
        if (markup.pageNumber !== pageNumber) continue
        const points = geometryPoints(markup.geometry)
        if (points.length === 0) continue
        const geometry = markup.geometry
        const isArc = geometry.kind === 'arc'
        const fullSweep = geometry.kind === 'arc' && geometry.endAngle - geometry.startAngle >= 2 * Math.PI - 1e-9
        const closed = CLOSED_GEOMETRY_KINDS.has(geometry.kind) || fullSweep
        const selected = selectedIds.includes(markup.id)
        // Vertices only show up on the selected markup, small and on the top
        // stroke only - the halo underneath stays plain so they don't double up.
        if (selected) stroke(points, '#4aa3ff', 8, { closed })
        stroke(points, selected ? '#ffffff' : markup.style.color, 2, {
          closed,
          dots: selected && !isArc,
          dotRadius: 2
        })
      }

      if (pageNumber === drawPage && drawPoints.length > 0) {
        const color = tool.isCalibration ? '#f4a261' : tool.defaultColor
        // A 2-point arc-producing tool (Circle) previews the real circle
        // instead of the straight center-to-edge line a naive point-by-point
        // stroke would draw - reuses buildGeometry rather than special-casing
        // the tool by id.
        const previewPoints =
          tool.produces?.geometryKind === 'arc' && drawPoints.length === 2 && tool.buildGeometry
            ? geometryPoints(tool.buildGeometry(drawPoints))
            : drawPoints
        stroke(previewPoints, color, 2, { dashed: true, dots: previewPoints === drawPoints })
      }
    },
    [manifest, selectedIds, drawPage, drawPoints, tool]
  )

  const overlayRevision = useMemo(
    () => `${manifest.updatedAt}|${selectedIds.join(',')}|${drawPage}|${drawPoints.length}|${toolId}`,
    [manifest.updatedAt, selectedIds, drawPage, drawPoints.length, toolId]
  )

  // ---- commit ---------------------------------------------------------
  function commitCalibration(): void {
    const distance = Number.parseFloat(realDistance)
    if (drawPoints.length !== 2 || drawPage === undefined) return
    if (!Number.isFinite(distance) || distance <= 0) return
    onSaveCalibration({
      pageNumber: drawPage,
      pointA: drawPoints[0],
      pointB: drawPoints[1],
      realDistance: distance,
      unit: calibrationUnit
    })
    cancelDraw()
    onToolChange('select')
  }

  const parsedScale = useMemo(() => parseScaleString(scaleText), [scaleText])

  function commitScaleCalibration(): void {
    if (!parsedScale) return
    onSaveCalibration({ pageNumber: viewedPage, ...parsedScale })
    cancelDraw()
    onToolChange('select')
  }

  // ---- interaction arbitration ---------------------------------------
  // See tools/interaction.ts for the right-drag rule.
  const interaction = useMemo(() => resolveInteraction(tool, interactionMode), [tool, interactionMode])

  const selectedMarkup = selectedIds.length === 1 ? manifest.markups.find((m) => m.id === selectedIds[0]) : undefined
  // Derived from the SELECTED markup, on demand - never from session state.
  const selectedQuantity = selectedMarkup ? quantityForMarkup(selectedMarkup.id) : undefined

  // Icon-only, so the title AND aria-label carry the meaning - without them
  // the control is unusable to a screen reader and unguessable to everyone.
  const modeToggle = (
    <div className="mode-toggle" role="group" aria-label="Mouse interaction mode">
      <button
        type="button"
        className={`mode-toggle__button${interactionMode === 'mouse' ? ' mode-toggle__button--active' : ''}`}
        onClick={() => setInteractionMode('mouse')}
        title="Mouse mode: left-drag pans, right-drag marquees"
        aria-label="Mouse mode"
        aria-pressed={interactionMode === 'mouse'}
      >
        <Hand size={17} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`mode-toggle__button${interactionMode === 'arrow' ? ' mode-toggle__button--active' : ''}`}
        onClick={() => setInteractionMode('arrow')}
        title="Arrow mode: left-click selects, left-drag marquees"
        aria-label="Arrow mode"
        aria-pressed={interactionMode === 'arrow'}
      >
        <MousePointer2 size={17} aria-hidden="true" />
      </button>
    </div>
  )

  // Status readout. formatQuantity is the only thing that renders a quantity
  // here, and it maps the uncalibrated and not-measurable states to explicit
  // words - never a blank, a dash, or a bare number that would read as a real
  // measurement.
  const quantityReadout = (
    <span className="pdf-viewer__quantity">
      {selectedIds.length > 1
        ? `${selectedIds.length} selected`
        : selectedMarkup
          ? `Selected: ${formatQuantity(selectedQuantity)}`
          : 'Nothing selected'}
    </span>
  )

  return (
    <div className="pdf-editor">
      <PdfViewer
        fileId={fileId}
        active={active}
        interaction={interaction}
        onDocumentLoaded={onDocumentLoaded}
        onDocumentReady={(doc) => {
          docRef.current = doc
        }}
        onCurrentPageChange={setViewedPage}
        renderOverlay={renderOverlay}
        onPagePointerDown={handlePagePointerDown}
        onPageDoubleClick={handlePageDoubleClick}
        onMarqueeComplete={handleMarquee}
        onContextMenu={(x, y) => {
          // A right-click without a drag always opens the context menu (see
          // tools/interaction.ts); for these tools it also cancels whatever
          // is in progress, rather than leaving a half-drawn shape behind it.
          if (drawing && tool.rightClickCancels) cancelDraw()
          setMenu({ x, y })
        }}
        overlayRevision={overlayRevision}
        statusBarSlot={modeToggle}
        statusBarEnd={quantityReadout}
        paletteSlot={<ToolPalette activeToolId={toolId} onSelect={onToolChange} />}
      />

      {tool.dragRect && (
        <div className="pdf-editor__prompt">
          <span>{tool.hint}</span>
          <span>
            Target cell:{' '}
            {activeCellLabel ? (
              activeCellLabel
            ) : (
              <span className="pdf-editor__prompt-warning">none - click a cell in the spreadsheet first</span>
            )}
          </span>
          {extractStatus ? (
            <span className={extractStatus.kind === 'error' ? 'pdf-editor__prompt-warning' : undefined}>
              {extractStatus.message}
            </span>
          ) : null}
        </div>
      )}

      {drawing && (
        <div className="pdf-editor__prompt">
          <span>{tool.hint}</span>
          {tool.isCalibration ? (
            <>
              <div className="pdf-editor__calibration-mode" role="radiogroup" aria-label="Calibration method">
                <label>
                  <input
                    type="radio"
                    name="calibration-mode"
                    checked={calibrationMode === 'scale'}
                    onChange={() => {
                      cancelDraw()
                      setCalibrationMode('scale')
                    }}
                  />
                  Known scale
                </label>
                <label>
                  <input
                    type="radio"
                    name="calibration-mode"
                    checked={calibrationMode === 'distance'}
                    onChange={() => {
                      cancelDraw()
                      setCalibrationMode('distance')
                    }}
                  />
                  Known distance
                </label>
              </div>

              {calibrationMode === 'distance' ? (
                drawPoints.length === 2 ? (
                  <>
                    <span>Distance on page {drawPage}:</span>
                    <input
                      type="number"
                      value={realDistance}
                      onChange={(e) => setRealDistance(e.target.value)}
                      placeholder="e.g. 100"
                      autoFocus
                    />
                    <select value={calibrationUnit} onChange={(e) => setCalibrationUnit(e.target.value as LinearUnit)}>
                      {LINEAR_UNITS.map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                    <button onClick={commitCalibration} disabled={!Number.parseFloat(realDistance)}>
                      Save calibration
                    </button>
                  </>
                ) : (
                  <span>{drawPoints.length} of 2 points</span>
                )
              ) : (
                <>
                  <span>Scale for page {viewedPage}:</span>
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) setScaleText(e.target.value)
                    }}
                  >
                    <option value="">Common scales…</option>
                    {SCALE_PRESETS.map((preset) => (
                      <option key={preset.value} value={preset.value}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={scaleText}
                    onChange={(e) => setScaleText(e.target.value)}
                    placeholder={`e.g. 1" = 50'`}
                  />
                  <button onClick={commitScaleCalibration} disabled={!parsedScale}>
                    Save calibration
                  </button>
                  {scaleText && !parsedScale ? (
                    <span className="pdf-editor__prompt-warning">Couldn&apos;t parse that scale.</span>
                  ) : null}
                </>
              )}
            </>
          ) : (
            <>
              <span>
                {drawPoints.length} point(s){drawPage ? ` on page ${drawPage}` : ''}
                {tool.supportsPointUndo && drawPoints.length > 0 ? ' · Ctrl+Z undo' : ''}
                {tool.supportsPointUndo && redoStack.length > 0 ? ' · Ctrl+R redo' : ''}
              </span>
              {drawPage !== undefined && !manifest.pages.some((p) => p.pageNumber === drawPage && p.calibration) ? (
                <span className="pdf-editor__prompt-warning">This page is not calibrated.</span>
              ) : null}
              {tool.unitKind === 'area' ? (
                <select value={areaUnit} onChange={(e) => setAreaUnit(e.target.value as AreaUnit)}>
                  {AREA_UNITS.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              ) : (
                <select value={measureUnit} onChange={(e) => setMeasureUnit(e.target.value as LinearUnit)}>
                  {LINEAR_UNITS.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              )}
              {tool.supportsDepth ? (
                <>
                  <span>Depth (optional):</span>
                  <input
                    type="number"
                    value={depthValue}
                    onChange={(e) => setDepthValue(e.target.value)}
                    placeholder="e.g. 1"
                    style={{ width: '4em' }}
                  />
                  <select value={depthUnit} onChange={(e) => setDepthUnit(e.target.value as LinearUnit)}>
                    {LINEAR_UNITS.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                  {Number.parseFloat(depthValue) > 0 ? (
                    <select value={volumeUnit} onChange={(e) => setVolumeUnit(e.target.value as VolumeUnit)}>
                      {VOLUME_UNITS.map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </>
              ) : null}
              <button onClick={() => commitMarkup()} disabled={drawPoints.length < (tool.minPoints ?? 2)}>
                Finish
              </button>
            </>
          )}
          <button onClick={() => onToolChange('select')}>Cancel (Esc)</button>
        </div>
      )}

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} selectionCount={selectedIds.length} onClose={() => setMenu(undefined)} />
      ) : null}
    </div>
  )
}
