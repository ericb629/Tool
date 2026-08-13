import { net, protocol } from 'electron'
import { pathToFileURL } from 'url'
import type { ManifestStore } from './manifest/store'
import { resolveWithinRoot } from './pathSafety'

export const APP_FILE_SCHEME = 'app-file'

/**
 * Must run before app.whenReady() - Electron only honors privilege
 * registration for schemes declared at this point.
 *
 * `stream: true` and `supportFetchAPI: true` are what let pdf.js issue
 * ranged/streamed reads against this scheme instead of pulling whole
 * documents into memory.
 */
export function registerAppFileSchemeAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_FILE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}

/**
 * Serves a project's source files (the PDFs pdf.js renders in the PDF
 * Editor panel) as app-file://<fileId>/.
 *
 * The response is produced by net.fetch against a file:// URL, which streams
 * and honours Range requests - the file is never buffered into memory here,
 * which matters because sheet sets run to hundreds of MB.
 *
 * Access is confined to the currently open project: the fileId must be
 * registered in the manifest AND the path it resolves to must really live
 * inside the project root. relativePath comes off disk and is therefore
 * untrusted input, so containment is checked on every request rather than
 * assumed from how importPdf writes it.
 */
export function registerAppFileProtocolHandler(store: ManifestStore): void {
  protocol.handle(APP_FILE_SCHEME, async (request) => {
    let fileId: string
    try {
      fileId = new URL(request.url).hostname
    } catch {
      return new Response('Bad request', { status: 400 })
    }

    const resolved = store.resolveFilePath(fileId)
    if (!resolved) {
      return new Response('Unknown file', { status: 404 })
    }

    const safePath = await resolveWithinRoot(resolved.absolutePath, resolved.rootPath)
    if (!safePath) {
      // Either the file is gone, or it resolves outside the project root.
      // Deliberately not distinguishing the two to the renderer.
      return new Response('Forbidden', { status: 403 })
    }

    return net.fetch(pathToFileURL(safePath).toString())
  })
}
