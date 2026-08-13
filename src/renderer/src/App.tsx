import { useEffect, useMemo, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import LabeledPanel from './components/LabeledPanel'
import LiveLinkPanel from './components/LiveLinkPanel'
import PdfEditorPanel from './components/PdfEditorPanel'
import SpreadsheetPanel from './components/SpreadsheetPanel'
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

  // The one place deriveQuantity is actually called from the running app -
  // recomputed from geometry + calibration on every render, never cached.
  const quantityResult = useMemo<QuantityResult | undefined>(() => {
    if (!pdfManifest || !lastMarkupId) return undefined
    const markup = pdfManifest.markups.find((m) => m.id === lastMarkupId)
    if (!markup) return undefined
    const page = pdfManifest.pages.find((p) => p.pageNumber === markup.pageNumber) ?? {
      pageNumber: markup.pageNumber
    }
    return deriveQuantity(markup, page)
  }, [pdfManifest, lastMarkupId])

  const existingLinkForMarkup = projectState?.links.find((l) => l.markupId === lastMarkupId)

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
                quantityResult={quantityResult}
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
              quantityResult={quantityResult}
              lastMarkupId={lastMarkupId}
              pdfFileId={pdfFileId}
              existingLinkForMarkup={existingLinkForMarkup}
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
