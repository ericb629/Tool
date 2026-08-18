import { BrowserWindow, dialog, ipcMain } from 'electron'
import type {
  FileType,
  LinkRecord,
  MarkupObject,
  PageCalibration,
  ProjectState,
  SpreadsheetSheetRecord
} from '../../shared/manifest'
import { ManifestStore } from '../manifest/store'

/**
 * Registers the manifest-system IPC surface. This is the only bridge
 * between the renderer and the filesystem for project data - the renderer
 * never touches fs directly (contextIsolation is on, nodeIntegration is
 * off; see src/main/index.ts and src/preload/index.ts). PDF bytes are
 * served separately, as ranged chunks over the pdfData IPC channel (see
 * src/main/pdfData.ts), not through this IPC surface.
 *
 * There is no custom protocol scheme and must not be: pdf.js hard-codes
 * incremental loading to http(s), so a custom scheme silently downloads whole
 * documents. See CLAUDE.md.
 */
export function registerManifestIpcHandlers(store: ManifestStore): void {
  ipcMain.handle('project:open', async (_event, folderPath: string): Promise<ProjectState> => {
    return store.open(folderPath)
  })

  ipcMain.handle('project:create', async (_event, folderPath: string): Promise<ProjectState> => {
    return store.create(folderPath)
  })

  ipcMain.handle(
    'project:addFile',
    async (_event, relativePath: string, fileType: FileType): Promise<ProjectState> => {
      store.addFile(relativePath, fileType)
      await store.save()
      return store.getState()
    }
  )

  ipcMain.handle(
    'project:importPdf',
    async (event): Promise<{ state: ProjectState; fileId: string } | null> => {
      const parentWindow = BrowserWindow.fromWebContents(event.sender)
      const result = parentWindow
        ? await dialog.showOpenDialog(parentWindow, {
            properties: ['openFile'],
            filters: [{ name: 'PDF', extensions: ['pdf'] }]
          })
        : await dialog.showOpenDialog({
            properties: ['openFile'],
            filters: [{ name: 'PDF', extensions: ['pdf'] }]
          })
      if (result.canceled || result.filePaths.length === 0) return null
      return store.importPdf(result.filePaths[0])
    }
  )

  ipcMain.handle(
    'project:createSpreadsheet',
    async (): Promise<{ state: ProjectState; fileId: string }> => {
      return store.createSpreadsheet()
    }
  )

  ipcMain.handle('manifest:updateMarkup', async (_event, fileId: string, markup: MarkupObject): Promise<void> => {
    store.updateMarkup(fileId, markup)
  })

  // Called once the renderer has opened a document and knows its real page
  // count - the manifest cannot know it before then. Saves only if something
  // was actually added, so merely viewing a PDF doesn't dirty the project.
  ipcMain.handle('manifest:ensurePages', async (_event, fileId: string, pageCount: number): Promise<ProjectState> => {
    if (store.ensurePages(fileId, pageCount)) {
      await store.save()
    }
    return store.getState()
  })

  ipcMain.handle(
    'manifest:updateCalibration',
    async (_event, fileId: string, calibration: PageCalibration): Promise<void> => {
      store.updatePageCalibration(fileId, calibration)
    }
  )

  ipcMain.handle(
    'manifest:setSheets',
    async (_event, fileId: string, sheets: SpreadsheetSheetRecord[]): Promise<void> => {
      store.setSheets(fileId, sheets)
    }
  )

  ipcMain.handle(
    'manifest:updateCell',
    async (_event, fileId: string, sheetName: string, cellRef: string, value: string | number): Promise<void> => {
      store.updateCell(fileId, sheetName, cellRef, value)
    }
  )

  ipcMain.handle('manifest:updateLink', async (_event, link: LinkRecord): Promise<void> => {
    store.updateLink(link)
  })

  ipcMain.handle('manifest:save', async (): Promise<void> => {
    await store.save()
  })

  ipcMain.handle('manifest:getState', async (): Promise<ProjectState> => {
    return store.getState()
  })
}
