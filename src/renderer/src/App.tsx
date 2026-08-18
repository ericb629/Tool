import { useCallback, useEffect, useMemo, useState } from 'react'
import AboutDialog from './components/AboutDialog'
import LiveLinkPanel from './components/LiveLinkPanel'
import MarkupToolBar from './components/MarkupToolBar'
import type { MenuBarMenu } from './components/MenuBar'
import PdfEditorPanel from './components/PdfEditorPanel'
import SpreadsheetPanel, { TAKEOFF_ROW_INDEX, TAKEOFF_SHEET_NAME } from './components/SpreadsheetPanel'
import TabBar from './components/TabBar'
import TitleBar from './components/TitleBar'
import { describeFileStatus } from './fileStatus'
import type { ToolId } from './tools/registry'
import type { LiveLinkPlacement, Tab } from './tabs/types'
import {
  deriveQuantity,
  type LinkRecord,
  type MarkupObject,
  type PageCalibration,
  type ProjectState,
  type QuantityResult,
  type Uuid
} from '../../shared/manifest'

const LIVE_LINK_TAB_ID = 'live-link'

/**
 * Tab state (which tabs are open, which is active, per-tab zoom/scroll/mode)
 * is deliberately SESSION-ONLY, not persisted to the manifest.
 *
 * The manifest is the project's data - what was measured and what it links
 * to. Which documents happened to be open in a window is workspace state: it
 * belongs to a person and a sitting, not to the project. Persisting it would
 * also mean two estimators sharing a project folder would fight over each
 * other's open tabs through the same last-write-wins save path, and it would
 * need a schema version bump plus a migration for something no takeoff
 * depends on.
 */
export default function App() {
  const [projectState, setProjectState] = useState<ProjectState | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [lastMarkupId, setLastMarkupId] = useState<Uuid | undefined>(undefined)

  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | undefined>(undefined)
  const [liveLinkPlacement, setLiveLinkPlacement] = useState<LiveLinkPlacement>('sidebar')
  const [openMenuVisible, setOpenMenuVisible] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  // Tool CHOICE lives here, keyed by tab id, because the markup tool strip
  // is in the TabBar (App-level) rather than inside PdfEditorPanel - but
  // each PDF tab still remembers its own tool, same as before the strip
  // moved out. Selection stays inside PdfEditorPanel; only choice moved.
  const [toolByTab, setToolByTab] = useState<Record<string, ToolId>>({})
  // The spreadsheet cell the Extract Text tool writes into - whichever cell
  // was last focused, across tabs, since extraction happens from a PDF tab
  // while the target lives on a spreadsheet tab.
  const [activeCell, setActiveCell] = useState<{ fileId: Uuid; sheetName: string; cellRef: string } | undefined>(
    undefined
  )

  // Live Link is synthesized rather than stored, so docking is just a
  // question of where it renders - the tab list never has to be rewritten.
  const displayedTabs = useMemo<Tab[]>(() => {
    if (liveLinkPlacement === 'sidebar') return tabs
    const liveLinkTab: Tab = {
      id: LIVE_LINK_TAB_ID,
      kind: 'live-link',
      title: 'Live Link',
      // Carries the project controls, so it must not be closeable.
      closeable: false
    }
    return [liveLinkTab, ...tabs]
  }, [tabs, liveLinkPlacement])


  // Keep the active tab valid as tabs open, close, or Live Link docks away.
  useEffect(() => {
    if (displayedTabs.length === 0) {
      if (activeTabId !== undefined) setActiveTabId(undefined)
      return
    }
    if (!displayedTabs.some((t) => t.id === activeTabId)) {
      setActiveTabId(displayedTabs[0].id)
    }
  }, [displayedTabs, activeTabId])

  function openTab(next: Tab): void {
    setTabs((prev) => (prev.some((t) => t.id === next.id) ? prev : [...prev, next]))
    setActiveTabId(next.id)
    setOpenMenuVisible(false)
  }

  function closeTab(id: string): void {
    // Unmounting the tab's content is what aborts its IpcRangeTransport and
    // releases the main-process file handle - see PdfViewer's cleanup.
    setTabs((prev) => prev.filter((t) => t.id !== id))
  }

  const tabIdForFile = (fileId: Uuid): string => `file:${fileId}`

  function openFileTab(fileId: Uuid): void {
    const entry = projectState?.files.find((f) => f.fileId === fileId)
    if (!entry) return
    const title = entry.relativePath.split('/').pop() ?? entry.relativePath
    openTab(
      entry.fileType === 'pdf'
        ? { id: tabIdForFile(fileId), kind: 'pdf', title, closeable: true, fileId }
        : { id: tabIdForFile(fileId), kind: 'spreadsheet', title, closeable: true, fileId }
    )
  }

  // ---- project + manifest actions ----

  async function refreshState(): Promise<void> {
    setProjectState(await window.api.manifest.getState())
  }

  function guard<T extends unknown[]>(fn: (...args: T) => Promise<void>) {
    return async (...args: T): Promise<void> => {
      setError(undefined)
      try {
        await fn(...args)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }
  }

  const handleOpenProject = guard(async (folderPath: string) => {
    setTabs([])
    setLastMarkupId(undefined)
    setProjectState(await window.api.project.open(folderPath))
  })

  const handleCreateProject = guard(async (folderPath: string) => {
    setTabs([])
    setLastMarkupId(undefined)
    setProjectState(await window.api.project.create(folderPath))
  })

  const handleImportPdf = guard(async () => {
    const result = await window.api.project.importPdf()
    if (!result) return
    setProjectState(result.state)
    const entry = result.state.files.find((f) => f.fileId === result.fileId)
    const title = entry?.relativePath.split('/').pop() ?? 'PDF'
    openTab({ id: tabIdForFile(result.fileId), kind: 'pdf', title, closeable: true, fileId: result.fileId })
  })

  const handleCreateSpreadsheet = guard(async () => {
    const result = await window.api.project.createSpreadsheet()
    setProjectState(result.state)
    const entry = result.state.files.find((f) => f.fileId === result.fileId)
    const title = entry?.relativePath.split('/').pop() ?? 'Sheet'
    openTab({ id: tabIdForFile(result.fileId), kind: 'spreadsheet', title, closeable: true, fileId: result.fileId })
  })

  const handleSaveCalibration = guard(async (fileId: Uuid, calibration: PageCalibration) => {
    await window.api.manifest.updateCalibration(fileId, calibration)
    await window.api.manifest.save()
    await refreshState()
  })

  const handleSaveMarkup = guard(async (fileId: Uuid, markup: MarkupObject) => {
    await window.api.manifest.updateMarkup(fileId, markup)
    await window.api.manifest.save()
    await refreshState()
    setLastMarkupId(markup.id)
  })

  const handleDocumentLoaded = guard(async (fileId: Uuid, pageCount: number) => {
    setProjectState(await window.api.manifest.ensurePages(fileId, pageCount))
  })

  const handleEnsureSheet = guard(async (fileId: Uuid) => {
    await window.api.manifest.setSheets(fileId, [{ sheetName: TAKEOFF_SHEET_NAME }])
    await window.api.manifest.save()
    await refreshState()
  })

  const handleCreateLink = guard(async (link: LinkRecord) => {
    await window.api.manifest.updateLink(link)
    await window.api.manifest.save()
    await refreshState()
  })

  const handleUpdateCell = guard(async (fileId: Uuid, sheetName: string, cellRef: string, value: string | number) => {
    await window.api.manifest.updateCell(fileId, sheetName, cellRef, value)
    await window.api.manifest.save()
    await refreshState()
  })

  // Returns an error message to show inline (no cell has been clicked yet);
  // undefined means the write is in flight. Sync so PdfEditorPanel can show
  // the outcome immediately rather than waiting on the IPC round trip.
  function handleExtractText(text: string): string | undefined {
    if (!activeCell) return 'No active cell - click a cell in the spreadsheet first.'
    void handleUpdateCell(activeCell.fileId, activeCell.sheetName, activeCell.cellRef, text)
    return undefined
  }

  // ---- derived quantities ----

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

  const lastDrawnQuantity = useMemo(() => {
    if (!projectState || !lastMarkupId) return undefined
    const owner = projectState.files.find(
      (f) => f.manifest.fileType === 'pdf' && f.manifest.markups.some((m) => m.id === lastMarkupId)
    )
    return quantityFor(owner?.fileId, lastMarkupId)
  }, [projectState, lastMarkupId, quantityFor])

  const layerId = projectState?.layers[0]?.id
  const openableFiles = projectState?.files.filter((f) => !tabs.some((t) => t.id === tabIdForFile(f.fileId))) ?? []

  // ---- tab content ----

  function renderTab(tab: Tab, isActive: boolean): React.ReactNode {
    switch (tab.kind) {
      case 'pdf': {
        const entry = projectState?.files.find((f) => f.fileId === tab.fileId)
        if (!entry || entry.manifest.fileType !== 'pdf') {
          return <div className="pdf-viewer__message">This file is no longer in the project.</div>
        }
        if (entry.sourceStatus === 'missing') {
          return (
            <div className="pdf-viewer__message pdf-viewer__message--error">{describeFileStatus(entry).detail}</div>
          )
        }
        if (!layerId) {
          return <div className="pdf-viewer__message">This project has no default layer.</div>
        }
        return (
          <PdfEditorPanel
            fileId={tab.fileId}
            manifest={entry.manifest}
            layerId={layerId}
            toolId={toolByTab[tab.id] ?? 'select'}
            onToolChange={(id) => setToolByTab((prev) => ({ ...prev, [tab.id]: id }))}
            quantityForMarkup={(markupId) => quantityFor(tab.fileId, markupId)}
            active={isActive}
            onDocumentLoaded={(pageCount) => handleDocumentLoaded(tab.fileId, pageCount)}
            onSaveCalibration={(calibration) => handleSaveCalibration(tab.fileId, calibration)}
            onSaveMarkup={(markup) => handleSaveMarkup(tab.fileId, markup)}
            onExtractText={handleExtractText}
            activeCellLabel={activeCell?.cellRef}
          />
        )
      }
      case 'spreadsheet': {
        const entry = projectState?.files.find((f) => f.fileId === tab.fileId)
        if (!entry || entry.manifest.fileType !== 'spreadsheet') {
          return <div className="pdf-viewer__message">This file is no longer in the project.</div>
        }
        const rowLink = projectState?.links.find(
          (l) =>
            l.target.fileId === tab.fileId &&
            l.target.sheetName === TAKEOFF_SHEET_NAME &&
            l.target.rowIndex === TAKEOFF_ROW_INDEX
        )
        return (
          <SpreadsheetPanel
            fileId={tab.fileId}
            manifest={entry.manifest}
            rowQuantity={quantityFor(rowLink?.sourceFileId, rowLink?.markupId)}
            lastDrawnQuantity={lastDrawnQuantity}
            lastMarkupId={lastMarkupId}
            pdfFileId={
              projectState?.files.find(
                (f) => f.manifest.fileType === 'pdf' && f.manifest.markups.some((m) => m.id === lastMarkupId)
              )?.fileId
            }
            isLinked={Boolean(rowLink)}
            onEnsureSheet={() => handleEnsureSheet(tab.fileId)}
            onCreateLink={handleCreateLink}
            onUpdateCell={(sheetName, cellRef, value) => handleUpdateCell(tab.fileId, sheetName, cellRef, value)}
            onActiveCellChange={(cellRef) =>
              setActiveCell(cellRef ? { fileId: tab.fileId, sheetName: TAKEOFF_SHEET_NAME, cellRef } : undefined)
            }
          />
        )
      }
      case 'live-link':
        return liveLink
      default: {
        // Exhaustiveness: a new TabKind fails to compile until handled here.
        const unreachable: never = tab
        return unreachable
      }
    }
  }

  const liveLink = (
    <LiveLinkPanel
      projectState={projectState}
      onOpenProject={handleOpenProject}
      onCreateProject={handleCreateProject}
      error={error}
    />
  )

  // The project-open/create controls live on LiveLinkPanel, not in a
  // separate dialog - "New Project" and "Open Project" both just surface it.
  // When it's docked as the sidebar it's already visible; when it's a tab,
  // switch to it.
  function focusProjectControls(): void {
    if (liveLinkPlacement === 'tab') setActiveTabId(LIVE_LINK_TAB_ID)
  }

  const activeTab = displayedTabs.find((t) => t.id === activeTabId)
  const NOT_BUILT = 'Not built yet'

  // The markup tool strip (Polyline/Area/Circle/Extract Text) needs an
  // active PDF tab; the markup-producing tools additionally need that page
  // calibrated (Extract Text does not - see MarkupToolBar).
  const activePdfManifest =
    activeTab?.kind === 'pdf'
      ? (() => {
          const entry = projectState?.files.find((f) => f.fileId === activeTab.fileId)
          return entry?.manifest.fileType === 'pdf' ? entry.manifest : undefined
        })()
      : undefined
  const markupToolsUncalibrated = !activePdfManifest || !activePdfManifest.pages.some((p) => p.calibration)
  const activeMarkupToolId: ToolId = activeTab ? (toolByTab[activeTab.id] ?? 'select') : 'select'
  function setActiveMarkupTool(id: ToolId): void {
    if (activeTab) setToolByTab((prev) => ({ ...prev, [activeTab.id]: id }))
  }

  const menus: MenuBarMenu[] = [
    {
      id: 'tool',
      label: 'Tool',
      items: [
        { label: 'About Tool', onClick: () => setAboutOpen(true) },
        { label: 'Preferences…', disabled: true, title: NOT_BUILT },
        { label: 'Profile…', disabled: true, title: NOT_BUILT },
        { label: 'Exit', onClick: () => window.close() }
      ]
    },
    {
      id: 'file',
      label: 'File',
      items: [
        { label: 'New Project…', onClick: focusProjectControls },
        { label: 'Open Project…', onClick: focusProjectControls },
        { label: 'Import PDF…', disabled: !projectState, onClick: handleImportPdf },
        {
          label: 'Save',
          disabled: !projectState,
          onClick: () => {
            void window.api.manifest.save()
          }
        },
        { label: 'Save As…', disabled: true, title: NOT_BUILT },
        { label: 'Print…', disabled: true, title: NOT_BUILT },
        { label: 'Close Tab', disabled: !activeTab?.closeable, onClick: () => activeTab && closeTab(activeTab.id) }
      ]
    },
    { id: 'view', label: 'View', items: [], emptyLabel: 'No view options yet' },
    {
      id: 'document',
      label: 'Document',
      items: [
        { label: 'Rotate Page…', disabled: true, title: NOT_BUILT },
        { label: 'Insert Pages…', disabled: true, title: NOT_BUILT },
        { label: 'Extract Pages…', disabled: true, title: NOT_BUILT },
        { label: 'Delete Page…', disabled: true, title: NOT_BUILT }
      ]
    },
    { id: 'tools', label: 'Tools', items: [], emptyLabel: 'No tools here yet' }
  ]

  return (
    <div className="app">
      <TitleBar menus={menus} />
      {aboutOpen ? <AboutDialog onClose={() => setAboutOpen(false)} /> : null}
      <TabBar
        tabs={displayedTabs}
        activeTabId={activeTabId}
        liveLinkDocked={liveLinkPlacement === 'sidebar'}
        canOpen={Boolean(projectState)}
        onActivate={setActiveTabId}
        onClose={closeTab}
        onToggleDock={() => setLiveLinkPlacement((p) => (p === 'sidebar' ? 'tab' : 'sidebar'))}
        onImportPdf={handleImportPdf}
        onNewSpreadsheet={handleCreateSpreadsheet}
        toolBar={
          <MarkupToolBar
            activeToolId={activeMarkupToolId}
            onSelect={setActiveMarkupTool}
            noPdfTab={!activePdfManifest}
            uncalibrated={markupToolsUncalibrated}
          />
        }
        openMenu={
          <div className="open-menu">
            <button disabled={!projectState} onClick={() => setOpenMenuVisible((v) => !v)}>
              Open ▾
            </button>
            {openMenuVisible && projectState ? (
              <ul className="open-menu__list">
                {openableFiles.length === 0 ? (
                  <li className="open-menu__empty">Everything is already open</li>
                ) : (
                  openableFiles.map((f) => (
                    <li key={f.fileId}>
                      <button onClick={() => openFileTab(f.fileId)}>{f.relativePath}</button>
                    </li>
                  ))
                )}
              </ul>
            ) : null}
          </div>
        }
      />

      <div className="app__body">
        <div className="app__content">
          {displayedTabs.length === 0 ? (
            <div className="pdf-viewer__message">
              {projectState ? 'Open a document from the Open menu.' : 'Open or create a project to begin.'}
            </div>
          ) : (
            displayedTabs.map((tab) => (
              // Every tab stays mounted so its pdf.js document and transport
              // survive a switch; only the active one is displayed, and
              // inactive PDF tabs drop their render structures (see
              // PdfViewer's `active`).
              <div key={tab.id} className="tab-panel" hidden={tab.id !== activeTabId}>
                {renderTab(tab, tab.id === activeTabId)}
              </div>
            ))
          )}
        </div>

        {liveLinkPlacement === 'sidebar' ? <aside className="app__sidebar">{liveLink}</aside> : null}
      </div>
    </div>
  )
}
