import { protocol } from 'electron'
import type { ManifestStore } from './manifest/store'
import { buildFileResponse } from './fileResponse'
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
 * The body is streamed off disk with real Range support (see
 * buildFileResponse) - nothing is buffered whole, in this process or the
 * renderer. This is not an optimization: net.fetch on a file:// URL omits
 * Accept-Ranges and Content-Length, which makes pdf.js give up on
 * incremental loading and pull the entire document into renderer memory
 * (measured: +1.2GB for a 465MB sheet set).
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

    try {
      const rangeHeader = request.headers.get('Range')
      if (process.env.TOOL_DEBUG_PROTOCOL) {
        // eslint-disable-next-line no-console
        console.log(`[protocol] range=${rangeHeader ?? 'none'}`)
      }
      return await buildFileResponse(safePath, rangeHeader)
    } catch {
      return new Response('Could not read file', { status: 500 })
    }
  })
}
