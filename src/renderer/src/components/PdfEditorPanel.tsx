import { useCallback, useMemo, useState } from 'react'
import PdfViewer from './PdfViewer'
import type { PageOverlayContext } from './PdfPageCanvas'
import { pdfPointToCanvas, pointerEventToPdfPoint } from '../pdf/coordinates'
import type {
  LinearUnit,
  MarkupObject,
  PageCalibration,
  PdfFileManifest,
  PdfPoint,
  QuantityResult,
  Uuid
} from '../../../shared/manifest'

const LINEAR_UNITS: LinearUnit[] = ['ft', 'in', 'm', 'cm', 'mm']

type Mode = 'idle' | 'calibrate' | 'measure'

interface PdfEditorPanelProps {
  fileId: Uuid
  manifest: PdfFileManifest
  layerId: Uuid
  quantityResult: QuantityResult | undefined
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
  quantityResult,
  onDocumentLoaded,
  onSaveCalibration,
  onSaveMarkup
}: PdfEditorPanelProps) {
  const [mode, setMode] = useState<Mode>('idle')
  // Every in-progress point below is a PdfPoint. No pixel coordinate is ever
  // held in state - it is converted at capture and converted back at draw.
  const [activePage, setActivePage] = useState<number | undefined>(undefined)
  const [calibratePoints, setCalibratePoints] = useState<PdfPoint[]>([])
  const [measurePoints, setMeasurePoints] = useState<PdfPoint[]>([])
  const [realDistance, setRealDistance] = useState('')
  const [calibrationUnit, setCalibrationUnit] = useState<LinearUnit>('ft')
  const [measureUnit, setMeasureUnit] = useState<LinearUnit>('ft')

  const url = `app-file://${fileId}/document.pdf`

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>, context: PageOverlayContext) => {
      if (mode === 'idle') return
      // Conversion happens here, at the point of capture.
      const point = pointerEventToPdfPoint(context.viewport, context.canvas, event)

      // Calibration and a measurement both belong to a single page; switching
      // pages mid-draw would silently mix coordinate spaces.
      if (activePage !== undefined && activePage !== context.pageNumber) return
      setActivePage(context.pageNumber)

      if (mode === 'calibrate') {
        setCalibratePoints((prev) => (prev.length >= 2 ? [point] : [...prev, point]))
      } else {
        setMeasurePoints((prev) => [...prev, point])
      }
    },
    [mode, activePage]
  )

  const renderOverlay = useCallback(
    (ctx: CanvasRenderingContext2D, context: PageOverlayContext) => {
      const { viewport, pageNumber } = context

      const strokePath = (points: PdfPoint[], color: string, dashed = false): void => {
        if (points.length === 0) return
        ctx.save()
        ctx.strokeStyle = color
        ctx.fillStyle = color
        ctx.lineWidth = 2
        if (dashed) ctx.setLineDash([6, 4])
        ctx.beginPath()
        // Stored user-space -> pixels, freshly, at draw time only.
        const first = pdfPointToCanvas(viewport, points[0])
        ctx.moveTo(first.x, first.y)
        for (let i = 1; i < points.length; i++) {
          const p = pdfPointToCanvas(viewport, points[i])
          ctx.lineTo(p.x, p.y)
        }
        ctx.stroke()
        for (const point of points) {
          const p = pdfPointToCanvas(viewport, point)
          ctx.beginPath()
          ctx.arc(p.x, p.y, 3, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.restore()
      }

      const pageRecord = manifest.pages.find((p) => p.pageNumber === pageNumber)
      if (pageRecord?.calibration) {
        strokePath([pageRecord.calibration.pointA, pageRecord.calibration.pointB], '#2a9d8f')
      }

      for (const markup of manifest.markups) {
        if (markup.pageNumber !== pageNumber || markup.geometry.kind !== 'polyline') continue
        strokePath(markup.geometry.points, '#e63946')
      }

      if (pageNumber === activePage) {
        if (mode === 'calibrate') strokePath(calibratePoints, '#f4a261', true)
        if (mode === 'measure') strokePath(measurePoints, '#e63946', true)
      }
    },
    [manifest, mode, activePage, calibratePoints, measurePoints]
  )

  // Any change that affects the overlay bumps this, so PdfPageCanvas repaints
  // the overlay without re-rendering the page bitmap.
  const overlayRevision = useMemo(
    () => `${manifest.updatedAt}|${mode}|${activePage}|${calibratePoints.length}|${measurePoints.length}`,
    [manifest.updatedAt, mode, activePage, calibratePoints.length, measurePoints.length]
  )

  function resetDrawing(): void {
    setCalibratePoints([])
    setMeasurePoints([])
    setActivePage(undefined)
    setMode('idle')
  }

  function saveCalibration(): void {
    const distance = Number.parseFloat(realDistance)
    if (calibratePoints.length !== 2 || activePage === undefined) return
    if (!Number.isFinite(distance) || distance <= 0) return
    onSaveCalibration({
      pageNumber: activePage,
      pointA: calibratePoints[0],
      pointB: calibratePoints[1],
      realDistance: distance,
      unit: calibrationUnit
    })
    setRealDistance('')
    resetDrawing()
  }

  function finishMeasure(): void {
    if (measurePoints.length < 2 || activePage === undefined) return
    const now = new Date().toISOString()
    onSaveMarkup({
      id: crypto.randomUUID(),
      pageNumber: activePage,
      layerId,
      type: 'polyline',
      takeoff: { mode: 'linear', unit: measureUnit },
      geometry: { kind: 'polyline', points: measurePoints },
      style: { color: '#e63946' },
      createdAt: now,
      updatedAt: now
    })
    resetDrawing()
  }

  const activePageHasCalibration =
    activePage !== undefined && manifest.pages.some((p) => p.pageNumber === activePage && p.calibration)
  const anyPageHasCalibration = manifest.pages.some((p) => p.calibration)

  const toolbarExtras = (
    <>
      <span className="pdf-viewer__separator" />
      <button
        className={mode === 'calibrate' ? 'active' : ''}
        onClick={() => {
          resetDrawing()
          setMode((m) => (m === 'calibrate' ? 'idle' : 'calibrate'))
        }}
      >
        Calibrate
      </button>
      <button
        className={mode === 'measure' ? 'active' : ''}
        disabled={!anyPageHasCalibration}
        title={anyPageHasCalibration ? 'Draw a linear markup' : 'Calibrate a page first'}
        onClick={() => {
          resetDrawing()
          setMode((m) => (m === 'measure' ? 'idle' : 'measure'))
        }}
      >
        Measure
      </button>
      <span className="pdf-viewer__quantity">Last: {formatQuantity(quantityResult)}</span>
    </>
  )

  return (
    <div className="pdf-editor">
      <PdfViewer
        url={url}
        onDocumentLoaded={onDocumentLoaded}
        renderOverlay={renderOverlay}
        onPagePointerDown={handlePointerDown}
        overlayRevision={overlayRevision}
        toolbarExtras={toolbarExtras}
      />

      {mode === 'calibrate' && (
        <div className="pdf-editor__prompt">
          {calibratePoints.length < 2 ? (
            <span>Click two points a known distance apart{activePage ? ` on page ${activePage}` : ''}.</span>
          ) : (
            <>
              <span>Distance between the two points on page {activePage}:</span>
              <input
                type="number"
                value={realDistance}
                onChange={(e) => setRealDistance(e.target.value)}
                placeholder="e.g. 100"
                autoFocus
              />
              <select value={calibrationUnit} onChange={(e) => setCalibrationUnit(e.target.value as LinearUnit)}>
                {LINEAR_UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {unit}
                  </option>
                ))}
              </select>
              <button onClick={saveCalibration} disabled={!Number.parseFloat(realDistance)}>
                Save calibration
              </button>
            </>
          )}
          <button onClick={resetDrawing}>Cancel</button>
        </div>
      )}

      {mode === 'measure' && (
        <div className="pdf-editor__prompt">
          <span>
            {measurePoints.length === 0
              ? 'Click along the line to measure.'
              : `${measurePoints.length} point(s) on page ${activePage}.`}
          </span>
          {activePage !== undefined && !activePageHasCalibration ? (
            <span className="pdf-editor__prompt-warning">This page is not calibrated — the result will show as uncalibrated.</span>
          ) : null}
          <select value={measureUnit} onChange={(e) => setMeasureUnit(e.target.value as LinearUnit)}>
            {LINEAR_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {unit}
              </option>
            ))}
          </select>
          <button onClick={finishMeasure} disabled={measurePoints.length < 2}>
            Finish line
          </button>
          <button onClick={resetDrawing}>Cancel</button>
        </div>
      )}
    </div>
  )
}
