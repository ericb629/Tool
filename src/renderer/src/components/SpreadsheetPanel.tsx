import type { LinkRecord, QuantityResult, SpreadsheetFileManifest, Uuid } from '../../../shared/manifest'

const SHEET_NAME = 'Takeoff'
const ROW_INDEX = 0

interface SpreadsheetPanelProps {
  fileId: Uuid
  manifest: SpreadsheetFileManifest
  quantityResult: QuantityResult | undefined
  lastMarkupId: Uuid | undefined
  pdfFileId: Uuid | undefined
  existingLinkForMarkup: LinkRecord | undefined
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
  quantityResult,
  lastMarkupId,
  pdfFileId,
  existingLinkForMarkup,
  onEnsureSheet,
  onCreateLink
}: SpreadsheetPanelProps) {
  const sheet = manifest.sheets.find((s) => s.sheetName === SHEET_NAME)

  if (!sheet) {
    return (
      <div className="spreadsheet-panel">
        <span className="labeled-panel__placeholder">No sheet yet</span>
        <button onClick={onEnsureSheet}>Add "{SHEET_NAME}" sheet</button>
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
      target: { fileId, sheetName: SHEET_NAME, rowIndex: ROW_INDEX },
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
            <td>{SHEET_NAME}</td>
            <td>{ROW_INDEX}</td>
            <td>{formatQuantity(quantityResult) || '—'}</td>
            <td>
              {existingLinkForMarkup ? (
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
