import { useState } from 'react'
import type { LinkRecord, QuantityResult, SpreadsheetFileManifest, Uuid } from '../../../shared/manifest'

export const TAKEOFF_SHEET_NAME = 'Takeoff'
export const TAKEOFF_ROW_INDEX = 0

// Plain grid, not Univer: this app has no real .xlsx read/write yet and the
// whole feature here is "editable cells + drag-box extraction into one of
// them" - a full spreadsheet engine (canvas rendering, DI container, formula
// engine) is disproportionate to that. Revisit if formulas or real .xlsx
// import/export become an actual requirement.
const GRID_COLS = 10
const GRID_ROWS = 25

function colLetter(index: number): string {
  return String.fromCharCode(65 + index)
}

function cellRef(col: number, row: number): string {
  return `${colLetter(col)}${row + 1}`
}

/** Numeric-looking text is stored as a number; everything else as trimmed text. */
function parseCellValue(raw: string): string | number {
  const trimmed = raw.trim()
  if (trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed)
  return trimmed
}

interface SpreadsheetPanelProps {
  fileId: Uuid
  manifest: SpreadsheetFileManifest
  /**
   * Quantity of the markup this row is LINKED to. Undefined when the row has
   * no link yet. Deliberately NOT the last-drawn markup's quantity: a row must
   * never display a number belonging to something it is not linked to.
   */
  rowQuantity: QuantityResult | undefined
  /** Preview of the markup just drawn, shown only while the row is unlinked. */
  lastDrawnQuantity: QuantityResult | undefined
  lastMarkupId: Uuid | undefined
  pdfFileId: Uuid | undefined
  /** Whether THIS ROW has a link, from persisted state - not session state. */
  isLinked: boolean
  onEnsureSheet: () => void
  onCreateLink: (link: LinkRecord) => void
  onUpdateCell: (sheetName: string, cellRef: string, value: string | number) => void
  /** Reports focus changes so App can target drag-box extraction at this cell. */
  onActiveCellChange: (cellRef: string | undefined) => void
}

function formatQuantity(result: QuantityResult | undefined): string {
  if (!result) return ''
  if (result.status === 'uncalibrated') return 'uncalibrated'
  if (result.status === 'not-measurable') return 'not measurable'
  return `${result.value.toFixed(2)} ${result.unit}`
}

// There is no spreadsheet (xlsx) reading in this app - this panel is an
// honest stand-in for that gap: a real, editable cell grid, plus the
// pre-existing "create a Takeoff sheet and link its row 0" flow used by Live
// Link. Both operate on the same sheet record; grid cells are NOT rows of a
// real workbook, just a sparse cell store (see SpreadsheetSheetRecord.cells).
export default function SpreadsheetPanel({
  fileId,
  manifest,
  rowQuantity,
  lastDrawnQuantity,
  lastMarkupId,
  pdfFileId,
  isLinked,
  onEnsureSheet,
  onCreateLink,
  onUpdateCell,
  onActiveCellChange
}: SpreadsheetPanelProps) {
  const sheet = manifest.sheets.find((s) => s.sheetName === TAKEOFF_SHEET_NAME)

  // The cell currently being typed into: buffered locally so keystrokes stay
  // responsive and are not committed (IPC write + manifest re-fetch) on every
  // keystroke - only on blur, like the app's other draw-then-commit flows.
  const [editingRef, setEditingRef] = useState<string | undefined>(undefined)
  const [editingValue, setEditingValue] = useState('')

  if (!sheet) {
    return (
      <div className="spreadsheet-panel">
        <span className="labeled-panel__placeholder">No sheet yet</span>
        <button onClick={onEnsureSheet}>Add "{TAKEOFF_SHEET_NAME}" sheet</button>
      </div>
    )
  }

  const cells = sheet.cells ?? {}

  function commitEditing(): void {
    if (editingRef !== undefined) onUpdateCell(TAKEOFF_SHEET_NAME, editingRef, parseCellValue(editingValue))
    setEditingRef(undefined)
  }

  function handleLink(): void {
    if (!lastMarkupId || !pdfFileId) return
    const now = new Date().toISOString()
    const link: LinkRecord = {
      id: crypto.randomUUID(),
      markupId: lastMarkupId,
      sourceFileId: pdfFileId,
      target: { fileId, sheetName: TAKEOFF_SHEET_NAME, rowIndex: TAKEOFF_ROW_INDEX },
      createdAt: now,
      updatedAt: now
    }
    onCreateLink(link)
  }

  return (
    <div className="spreadsheet-panel">
      <table className="spreadsheet-panel__table">
        <thead>
          <tr>
            <th>Sheet</th>
            <th>Row</th>
            <th>Quantity</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{TAKEOFF_SHEET_NAME}</td>
            <td>{TAKEOFF_ROW_INDEX}</td>
            <td>
              {rowQuantity ? (
                formatQuantity(rowQuantity)
              ) : lastDrawnQuantity ? (
                // Not this row's number yet - label it so a preview can never
                // be mistaken for the linked quantity.
                <span className="spreadsheet-panel__preview">{formatQuantity(lastDrawnQuantity)} (unlinked)</span>
              ) : (
                <span className="spreadsheet-panel__empty">not linked</span>
              )}
            </td>
            <td>
              {isLinked ? (
                <span>Linked</span>
              ) : (
                <button onClick={handleLink} disabled={!lastMarkupId}>
                  Link to last markup
                </button>
              )}
            </td>
          </tr>
        </tbody>
      </table>

      <div className="spreadsheet-grid" role="grid" aria-label="Sheet cells">
        <table className="spreadsheet-grid__table">
          <thead>
            <tr>
              <th className="spreadsheet-grid__corner" />
              {Array.from({ length: GRID_COLS }, (_, col) => (
                <th key={col}>{colLetter(col)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: GRID_ROWS }, (_, row) => (
              <tr key={row}>
                <th>{row + 1}</th>
                {Array.from({ length: GRID_COLS }, (_, col) => {
                  const ref = cellRef(col, row)
                  const editing = editingRef === ref
                  const value = editing ? editingValue : (cells[ref] ?? '')
                  return (
                    <td key={col}>
                      <input
                        className="spreadsheet-grid__cell"
                        value={value}
                        onFocus={() => {
                          setEditingRef(ref)
                          setEditingValue(String(cells[ref] ?? ''))
                          onActiveCellChange(ref)
                        }}
                        onChange={(e) => setEditingValue(e.target.value)}
                        onBlur={commitEditing}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur()
                        }}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
