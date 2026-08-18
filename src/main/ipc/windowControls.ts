import { ipcMain, type BrowserWindow } from 'electron'

/**
 * IPC surface for the custom title bar's minimize/maximize/close buttons.
 * The window is frameless (see main/index.ts) so there is no native chrome
 * to click - the renderer has to ask for these. Also pushes maximize state
 * to the renderer so the button can swap between its maximize/restore icon
 * even when the change came from elsewhere (double-clicking the title bar,
 * the Windows snap layout, Win+Up).
 */
export function registerWindowControlIpcHandlers(window: BrowserWindow): void {
  ipcMain.handle('windowControls:minimize', () => {
    window.minimize()
  })

  ipcMain.handle('windowControls:toggleMaximize', () => {
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })

  ipcMain.handle('windowControls:close', () => {
    window.close()
  })

  ipcMain.handle('windowControls:isMaximized', () => window.isMaximized())

  const notify = (): void => {
    if (window.isDestroyed()) return
    window.webContents.send('windowControls:maximizedChanged', window.isMaximized())
  }
  window.on('maximize', notify)
  window.on('unmaximize', notify)
}
