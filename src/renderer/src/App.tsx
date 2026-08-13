import { useCallback, useEffect, useMemo, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import LabeledPanel from './components/LabeledPanel'
import LiveLinkPanel from './components/LiveLinkPanel'
import PdfEditorPanel from './components/PdfEditorPanel'
import SpreadsheetPanel, { TAKEOFF_ROW_INDEX, TAKEOFF_SHEET_NAME } from './components/SpreadsheetPanel'
import { describeFileStatus } from './fileStatus'
import { deriveQuantity, type LinkRecord, type MarkupObject, type PageCalibration, type ProjectState, type QuantityResult, type Uuid } from '../../shared/manifest'

export default function App() {
  const [folderPath, setFolderPath] = useState('')
  const [projectState, setProjectState] = useState<ProjectState | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const [pdfFileId, setPdfFileId] = useState<Uuid | undefined>(undefined)
  const [spreadsheetFileId, setSpreadsheetFileId] = useState<Uuid | undefined>(undefined)
  const [lastMarkupId, setLastMarkupId] = useState<Uuid | undefined>(undefined)
  const [addSpreadsheetPath, setAddSpreadsheetPath] = useState('')

  // Auto-select the first PDF/spreadsheet when none is selected or the
  // current selection was removed from the project.
  useEffect(() => {
    if (!projectState) {
      setPdfFileId(undefined)
      setSpreadsheetFileId(undefined)
      return
    }
    setPdfFileId((current) =>
      current && projectState.files.some((f) => f.fileId === current)
        ? current
        : projectState.files.find((f) => f.fileType === 'pdf')?.fileId
    )
    setSpreadsheetFileId((current) =>
      current && projectState.files.some((f) => f.fileId === current)
        ? current
        : projectState.files.find((f) => f.fileType === 'spreadsheet')?.fileId
    )
  }, [projectState])

  async function refreshState(): Promise<void> {
    setProjectState(await window.api.manifest.getState())
  }

  async function handleOpen(): Promise<void> {
    setError(undefined)
    try {
      setProjectState(await window.api.project.open(folderPath))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleCreate(): Promise<void> {
    setError(undefined)
    try {
      setProjectState(await window.api.project.create(folderPath))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleImportPdf(): Promise<void> {
    setError(undefined)
    try {
      const result = await window.api.project.importPdf()
      if (!result) return
      setProjectState(result.state)
      setPdfFileId(result.fileId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleAddSpreadsheet(): Promise<void> {
    if (!addSpreadsheetPath) return
    setError(undefined)
    try {
      setProjectState(await window.api.project.addFile(addSpreadsheetPath, 'spreadsheet'))
      setAddSpreadsheetPath('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleSaveCalibration(fileId: Uuid, calibration: PageCalibration): Promise<void> {
    setError(undefined)
    try {
      await window.api.manifest.updateCalibration(fileId, calibration)
      await window.api.manifest.save()
      await refreshState()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleSaveMarkup(fileId: Uuid, markup: MarkupObject): Promise<void> {
    setError(undefined)
    try {
      await window.api.manifest.updateMarkup(fileId, markup)
      await window.api.manifest.save()
      await refreshState()
      setLastMarkupId(markup.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleDocumentLoaded(fileId: Uuid, pageCount: number): Promise<void> {
    setError(undefined)
    try {
      // The real page count is only knowable once pdf.js has opened the
      // document; this backfills pages[] in the sidecar. It is a no-op save
      // if every page already has a record.
      setProjectState(await window.api.manifest.ensurePages(fileId, pageCount))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleEnsureSheet(fileId: Uuid): Promise<void> {
    setError(undefined)
    try {
      await window.api.manifest.setSheets(fileId, [{ sheetName: 'Takeoff' }])
      await window.api.manifest.save()
      await refreshState()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleCreateLink(link: LinkRecord): Promise<void> {
    setError(undefined)
    try {
      await window.api.manifest.updateLink(link)
      await window.api.manifest.save()
      await refreshState()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const pdfFiles = projectState?.files.filter((f) => f.fileType === 'pdf') ?? []
  const pdfFileEntry = pdfFiles.find((f) => f.fileId === pdfFileId)
  const pdfManifest = pdfFileEntry?.manifest.fileType === 'pdf' ? pdfFileEntry.manifest : undefined
  const spreadsheetFileEntry = projectState?.files.find((f) => f.fileId === spreadsheetFileId)
  const spreadsheetManifest =
    spreadsheetFileEntry?.manifest.fileType === 'spreadsheet' ? spreadsheetFileEntry.manifest : undefined
  const layerId = projectState?.layers[0]?.id

  // Derives a markup's quantity from whichever PDF actually holds it.
  // Recomputed from geometry + calibration on demand, never cached, so an
  // edit to either can't leave a stale number behind.
  const quantityFor = useCallback(
    (sourceFileId: Uuid | undefined, markupId: Uuid | undefined): QuantityResult | undefined => {
      if (!projectState || !sourceFileId || !markupId) return undefined
      const entry = projectState.files.find((f) => f.fileId === sourceFileId)
      if (!entry || entry.manifest.fileType !== 'pdf') return undefined
      const markup = entry.manifest.markups.find((m) => m.id === markupId)
      if (!markup) return undefined
      const page = entry.manifest.pages.find((p) => p.pageNumber === markup.pageNumber) ?? {
        pageNumber: markup.pageNumber
      }
      return deriveQuantity(markup, page)
    },
    [projectState]
  )

  // Quantity of the markup just drawn - a preview for the toolbar only.
  const lastDrawnQuantity = useMemo(
    () => quantityFor(pdfFileId, lastMarkupId),
    [quantityFor, pdfFileId, lastMarkupId]
  )

  const rowLink = projectState?.links.find(
    (l) =>
      l.target.fileId === spreadsheetFileId &&
      l.target.sheetName === TAKEOFF_SHEET_NAME &&
      l.target.rowIndex === TAKEOFF_ROW_INDEX
  )

  // The row's number must come from the markup the row is LINKED to, not
  // from whatever happened to be drawn most recently. Those differ after a
  // restart (nothing has been drawn yet) and any time a second markup is
  // drawn after linking the first - in both cases the row would otherwise
  // display a number that does not belong to it.
  const rowQuantity = useMemo(
    () => quantityFor(rowLink?.sourceFileId, rowLink?.markupId),
    [quantityFor, rowLink]
  )


  return (
    <Group orientation="horizontal" className="app-panel-group">
      <Panel defaultSize={30} minSize={15}>
        <LabeledPanel title="PDF Editor">
          <div className="pdf-editor-shell">
            <div className="pdf-editor-shell__files">
              <button
                onClick={handleImportPdf}
                disabled={!projectState}
                title={projectState ? 'Copy a PDF into this project' : 'Open or create a project first'}
              >
                Import PDF…
              </button>
              {!projectState ? (
                <span className="labeled-panel__placeholder">Open or create a project to import drawings</span>
              ) : (
                <ul className="pdf-file-list">
                  {pdfFiles.length === 0 ? (
                    <span className="labeled-panel__placeholder">No PDFs yet — import one to get started</span>
                  ) : (
                    pdfFiles.map((file) => {
                      const notice = describeFileStatus(file)
                      return (
                        <li key={file.fileId}>
                          <button
                            type="button"
                            className={file.fileId === pdfFileId ? 'active' : ''}
                            onClick={() => setPdfFileId(file.fileId)}
                            title={notice.detail || file.relativePath}
                          >
                            {file.relativePath}
                            {notice.severity !== 'ok' ? (
                              <span className={`file-status file-status--${notice.severity}`}>{notice.label}</span>
                            ) : null}
                          </button>
                        </li>
                      )
                    })
                  )}
                </ul>
              )}
            </div>
            {!projectState || !pdfFileId ? null : !pdfManifest || !layerId ? (
              <span className="labeled-panel__placeholder">
                {layerId ? 'Loading…' : 'This project has no default layer (open/create a project to get one)'}
              </span>
            ) : pdfFileEntry && pdfFileEntry.sourceStatus === 'missing' ? (
              <div className="pdf-viewer__message pdf-viewer__message--error">
                {describeFileStatus(pdfFileEntry).detail}
              </div>
            ) : (
              <PdfEditorPanel
                fileId={pdfFileId}
                manifest={pdfManifest}
                layerId={layerId}
                quantityResult={lastDrawnQuantity}
                onDocumentLoaded={(pageCount) => handleDocumentLoaded(pdfFileId, pageCount)}
                onSaveCalibration={(calibration) => handleSaveCalibration(pdfFileId, calibration)}
                onSaveMarkup={(markup) => handleSaveMarkup(pdfFileId, markup)}
              />
            )}
          </div>
        </LabeledPanel>
      </Panel>
      <Separator className="resize-handle" />
      <Panel defaultSize={40} minSize={15}>
        <LabeledPanel title="Spreadsheet">
          {!projectState ? undefined : !spreadsheetFileId ? (
            <div className="add-file-control">
              <span className="labeled-panel__placeholder">No spreadsheet in this project yet</span>
              <input
                type="text"
                placeholder="Spreadsheet path relative to project root"
                value={addSpreadsheetPath}
                onChange={(e) => setAddSpreadsheetPath(e.target.value)}
              />
              <button onClick={handleAddSpreadsheet} disabled={!addSpreadsheetPath}>
                Add spreadsheet
              </button>
            </div>
          ) : !spreadsheetManifest ? (
            <span className="labeled-panel__placeholder">Loading…</span>
          ) : (
            <SpreadsheetPanel
              fileId={spreadsheetFileId}
              manifest={spreadsheetManifest}
              rowQuantity={rowQuantity}
              lastDrawnQuantity={lastDrawnQuantity}
              lastMarkupId={lastMarkupId}
              pdfFileId={pdfFileId}
              isLinked={Boolean(rowLink)}
              onEnsureSheet={() => handleEnsureSheet(spreadsheetFileId)}
              onCreateLink={handleCreateLink}
            />
          )}
        </LabeledPanel>
      </Panel>
      <Separator className="resize-handle" />
      <Panel defaultSize={30} minSize={15}>
        <LabeledPanel title="Live Link">
          <div className="live-link-panel">
            <div className="live-link-panel__project-controls">
              <input
                type="text"
                placeholder="Project folder path"
                value={folderPath}
                onChange={(e) => setFolderPath(e.target.value)}
              />
              <button onClick={handleOpen} disabled={!folderPath}>
                Open
              </button>
              <button onClick={handleCreate} disabled={!folderPath}>
                Create
              </button>
            </div>
            {error ? <div className="live-link-panel__error">{error}</div> : null}
            <LiveLinkPanel projectState={projectState} />
          </div>
        </LabeledPanel>
      </Panel>
    </Group>
  )
}
