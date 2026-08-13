import type { LinkRecord, QuantityResult, SpreadsheetFileManifest, Uuid } from '../../../shared/manifest'

export const TAKEOFF_SHEET_NAME = 'Takeoff'
export const TAKEOFF_ROW_INDEX = 0

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
}

function formatQuantity(result: QuantityResult | undefined): string {
  if (!result) return ''
  if (result.status === 'uncalibrated') return 'uncalibrated'
  if (result.status === 'not-measurable') return 'not measurable'
  return `${result.value.toFixed(2)} ${result.unit}`
}

// There is no spreadsheet (xlsx) reading in this app - SpreadsheetSheetRecord
// only tracks a sheet name (see shared/manifest/types.ts), not cell content.
// This panel is an honest stand-in for that gap: it lets you create one real
// sheet and reference row 0 of it for linking, but it does not read or write
// any actual spreadsheet file. Real cell data is out of scope for this slice.
export default function SpreadsheetPanel({
  fileId,
  manifest,
  rowQuantity,
  lastDrawnQuantity,
  lastMarkupId,
  pdfFileId,
  isLinked,
  onEnsureSheet,
  onCreateLink
}: SpreadsheetPanelProps) {
  const sheet = manifest.sheets.find((s) => s.sheetName === TAKEOFF_SHEET_NAME)

  if (!sheet) {
    return (
      <div className="spreadsheet-panel">
        <span className="labeled-panel__placeholder">No sheet yet</span>
        <button onClick={onEnsureSheet}>Add "{TAKEOFF_SHEET_NAME}" sheet</button>
      </div>
    )
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
    </div>
  )
}
