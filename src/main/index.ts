import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { registerManifestIpcHandlers } from './ipc/manifest'
import { registerPdfDataIpcHandlers } from './ipc/pdfData'
import { registerWindowControlIpcHandlers } from './ipc/windowControls'
import { ManifestStore } from './manifest/store'
import { PdfDataReader } from './pdfData'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    // Frameless: the renderer draws its own title bar (menu bar on the
    // left, minimize/maximize/close on the right) instead of relying on
    // the OS one - see components/TitleBar.tsx and ipc/windowControls.ts.
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  registerWindowControlIpcHandlers(mainWindow)

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// One ManifestStore per process: the app opens a single project in a single
// window (see ManifestStore's single-writer assumption). The reader holds
// open file handles, so it is module-scoped in order to be closed on quit.
const store = new ManifestStore()
const pdfDataReader = new PdfDataReader(store)

app.whenReady().then(() => {
  registerManifestIpcHandlers(store)
  registerPdfDataIpcHandlers(pdfDataReader)

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Release any PDF file handles still held when the app exits. closeAll is
// async, so quitting has to be deferred until it finishes - otherwise the
// process exits first and Node closes the descriptors on GC instead, which
// it warns about (DEP0137) and will eventually treat as an error.
let handlesReleased = false
app.on('will-quit', (event) => {
  if (handlesReleased) return
  event.preventDefault()
  void pdfDataReader.closeAll().finally(() => {
    handlesReleased = true
    app.quit()
  })
})
