import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Hand, MousePointer2 } from 'lucide-react'
import PdfViewer, { type PageRectSelection } from './PdfViewer'
import { resolveInteraction, type InteractionMode } from '../tools/interaction'
import type { PageOverlayContext } from './PdfPageCanvas'
import ToolPalette from './ToolPalette'
import ContextMenu from './ContextMenu'
import { pdfPointToCanvas, pointerEventToPdfPoint } from '../pdf/coordinates'
import { geometryIntersectsRect, geometryPoints, hitTestGeometry } from '../pdf/hitTest'
import { TOOL_BY_ID, isDrawingTool, type ToolId } from '../tools/registry'
import { parseScaleString, SCALE_PRESETS } from '../pdf/scale'
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
  onSaveMarkup
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

  const tool = TOOL_BY_ID[toolId]
  const drawing = isDrawingTool(tool)

  const cancelDraw = useCallback(() => {
    setDrawPoints([])
    setDrawPage(undefined)
    setRealDistance('')
    setScaleText('')
    setDepthValue('')
  }, [])

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

  // ---- pointer on a page ---------------------------------------------
  const handlePagePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>, context: PageOverlayContext) => {
      if (event.button !== 0) return
      setMenu(undefined)
      const point = pointerEventToPdfPoint(context.viewport, context.canvas, event, context.origin)

      // Scale-typed calibration needs no clicks on the page at all - it
      // derives its reference line from the typed/picked scale instead.
      if (drawing && tool.isCalibration && calibrationMode === 'scale') return

      if (drawing) {
        // A draw belongs to one page; mixing pages would mix coordinate spaces.
        if (drawPage !== undefined && drawPage !== context.pageNumber) return
        setDrawPage(context.pageNumber)
        setDrawPoints((prev) => {
          const next = [...prev, point]
          return tool.exactPoints && next.length > tool.exactPoints ? [point] : next
        })
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
    [drawing, drawPage, tool, manifest]
  )

  const handleMarquee = useCallback(
    (selections: PageRectSelection[], additive: boolean) => {
      const hits: Uuid[] = []
      for (const { pageNumber, rect } of selections) {
        for (const markup of manifest.markups) {
          if (markup.pageNumber !== pageNumber) continue
          if (geometryIntersectsRect(markup.geometry, rect)) hits.push(markup.id)
        }
      }
      setSelectedIds((prev) => (additive ? Array.from(new Set([...prev, ...hits])) : hits))
    },
    [manifest]
  )

  // ---- overlay --------------------------------------------------------
  const renderOverlay = useCallback(
    (ctx: CanvasRenderingContext2D, context: PageOverlayContext) => {
      const { viewport, pageNumber } = context

      // `closed` also fills the shape (lightly) so an area/circle markup
      // reads as a region rather than just its boundary. `dots` marks each
      // actual vertex - skipped for arcs, whose points are 48 samples along
      // the curve, not places the user clicked.
      const stroke = (
        points: PdfPoint[],
        color: string,
        width: number,
        { dashed = false, closed = false, dots = true }: { dashed?: boolean; closed?: boolean; dots?: boolean } = {}
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
            ctx.arc(p.x, p.y, 3, 0, Math.PI * 2)
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
        const opts = { closed, dots: !isArc }
        // Selected markups get a halo underneath, then the normal stroke.
        if (selected) stroke(points, '#4aa3ff', 8, opts)
        stroke(points, selected ? '#ffffff' : markup.style.color, 2, opts)
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

  function commitMarkup(): void {
    if (!tool.produces || !tool.buildGeometry || !tool.buildTakeoff) return
    if (drawPage === undefined || drawPoints.length < (tool.minPoints ?? 2)) return
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
      geometry: tool.buildGeometry(drawPoints),
      style: { color: tool.defaultColor },
      createdAt: now,
      updatedAt: now
    })
    cancelDraw()
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
        onCurrentPageChange={setViewedPage}
        renderOverlay={renderOverlay}
        onPagePointerDown={handlePagePointerDown}
        onMarqueeComplete={handleMarquee}
        onContextMenu={(x, y) => setMenu({ x, y })}
        overlayRevision={overlayRevision}
        statusBarSlot={modeToggle}
        statusBarEnd={quantityReadout}
        paletteSlot={<ToolPalette activeToolId={toolId} onSelect={onToolChange} />}
      />

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
              <button onClick={commitMarkup} disabled={drawPoints.length < (tool.minPoints ?? 2)}>
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
