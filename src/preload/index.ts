import { contextBridge, ipcRenderer } from 'electron'
import type {
  FileType,
  LinkRecord,
  MarkupObject,
  PageCalibration,
  ProjectState,
  SpreadsheetSheetRecord
} from '../shared/manifest'

const api = {
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron
  },
  project: {
    open: (folderPath: string): Promise<ProjectState> => ipcRenderer.invoke('project:open', folderPath),
    create: (folderPath: string): Promise<ProjectState> => ipcRenderer.invoke('project:create', folderPath),
    addFile: (relativePath: string, fileType: FileType): Promise<ProjectState> =>
      ipcRenderer.invoke('project:addFile', relativePath, fileType),
    importPdf: (): Promise<{ state: ProjectState; fileId: string } | null> =>
      ipcRenderer.invoke('project:importPdf')
  },
  // pdf.js data transport. Only the chunks pdf.js asks for cross this
  // boundary; a whole document is never transferred. See src/main/pdfData.ts.
  pdfData: {
    open: (fileId: string): Promise<{ length: number; initialData: Uint8Array }> =>
      ipcRenderer.invoke('pdfData:open', fileId),
    read: (fileId: string, begin: number, end: number): Promise<Uint8Array> =>
      ipcRenderer.invoke('pdfData:read', fileId, begin, end),
    close: (fileId: string): Promise<void> => ipcRenderer.invoke('pdfData:close', fileId)
  },
  manifest: {
    updateMarkup: (fileId: string, markup: MarkupObject): Promise<void> =>
      ipcRenderer.invoke('manifest:updateMarkup', fileId, markup),
    updateCalibration: (fileId: string, calibration: PageCalibration): Promise<void> =>
      ipcRenderer.invoke('manifest:updateCalibration', fileId, calibration),
    ensurePages: (fileId: string, pageCount: number): Promise<ProjectState> =>
      ipcRenderer.invoke('manifest:ensurePages', fileId, pageCount),
    setSheets: (fileId: string, sheets: SpreadsheetSheetRecord[]): Promise<void> =>
      ipcRenderer.invoke('manifest:setSheets', fileId, sheets),
    updateLink: (link: LinkRecord): Promise<void> => ipcRenderer.invoke('manifest:updateLink', link),
    save: (): Promise<void> => ipcRenderer.invoke('manifest:save'),
    getState: (): Promise<ProjectState> => ipcRenderer.invoke('manifest:getState')
  },
  // The window is frameless (see main/index.ts) - the custom title bar
  // drives minimize/maximize/close through here instead of native chrome.
  windowControls: {
    minimize: (): Promise<void> => ipcRenderer.invoke('windowControls:minimize'),
    toggleMaximize: (): Promise<void> => ipcRenderer.invoke('windowControls:toggleMaximize'),
    close: (): Promise<void> => ipcRenderer.invoke('windowControls:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('windowControls:isMaximized'),
    onMaximizedChanged: (callback: (maximized: boolean) => void): (() => void) => {
      const listener = (_event: unknown, maximized: boolean): void => callback(maximized)
      ipcRenderer.on('windowControls:maximizedChanged', listener)
      return () => ipcRenderer.removeListener('windowControls:maximizedChanged', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
