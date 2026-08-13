import { contextBridge } from 'electron'

// Placeholder API surface for future main <-> renderer communication.
// Extend this as features (PDF editing, spreadsheet, live link) need IPC.
const api = {
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
