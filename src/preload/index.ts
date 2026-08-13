import { contextBridge, ipcRenderer } from 'electron'
import type { LinkRecord, MarkupObject, ProjectState } from '../shared/manifest'

const api = {
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron
  },
  project: {
    open: (folderPath: string): Promise<ProjectState> => ipcRenderer.invoke('project:open', folderPath),
    create: (folderPath: string): Promise<ProjectState> => ipcRenderer.invoke('project:create', folderPath)
  },
  manifest: {
    updateMarkup: (fileId: string, markup: MarkupObject): Promise<void> =>
      ipcRenderer.invoke('manifest:updateMarkup', fileId, markup),
    updateLink: (link: LinkRecord): Promise<void> => ipcRenderer.invoke('manifest:updateLink', link),
    save: (): Promise<void> => ipcRenderer.invoke('manifest:save')
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
