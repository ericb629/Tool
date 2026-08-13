import { ipcMain } from 'electron'
import type { LinkRecord, MarkupObject, ProjectState } from '../../shared/manifest'
import { ManifestStore } from '../manifest/store'

/**
 * Registers the manifest-system IPC surface. This is the only bridge
 * between the renderer and the filesystem for project data - the renderer
 * never touches fs directly (contextIsolation is on, nodeIntegration is
 * off; see src/main/index.ts and src/preload/index.ts).
 */
export function registerManifestIpcHandlers(store: ManifestStore): void {
  ipcMain.handle('project:open', async (_event, folderPath: string): Promise<ProjectState> => {
    return store.open(folderPath)
  })

  ipcMain.handle('project:create', async (_event, folderPath: string): Promise<ProjectState> => {
    return store.create(folderPath)
  })

  ipcMain.handle('manifest:updateMarkup', async (_event, fileId: string, markup: MarkupObject): Promise<void> => {
    store.updateMarkup(fileId, markup)
  })

  ipcMain.handle('manifest:updateLink', async (_event, link: LinkRecord): Promise<void> => {
    store.updateLink(link)
  })

  ipcMain.handle('manifest:save', async (): Promise<void> => {
    await store.save()
  })
}
