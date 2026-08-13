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
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
