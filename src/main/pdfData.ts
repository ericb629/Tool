import { promises as fs, type promises as fsTypes } from 'fs'
import type { ManifestStore } from './manifest/store'
import { resolveWithinRoot } from './pathSafety'

/**
 * Bytes handed back for one chunk request. pdf.js asks for 64KB at a time by
 * default; this ceiling exists so a buggy or hostile renderer cannot turn a
 * single call into "load the whole 500MB sheet set into memory", which is the
 * exact failure this module exists to prevent.
 */
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024

/**
 * Bytes sent up front with the document length. pdf.js can begin parsing the
 * header while it range-requests the cross-reference table at the end.
 */
export const INITIAL_CHUNK_BYTES = 64 * 1024

interface OpenDocument {
  handle: fsTypes.FileHandle
  length: number
  /** Diagnostics for TOOL_DEBUG_PDFDATA: proves chunking rather than assuming it. */
  bytesServed: number
  chunkCount: number
}

export interface OpenResult {
  length: number
  initialData: Uint8Array
}

/**
 * Serves PDF bytes to the renderer in chunks, on demand.
 *
 * Background: pdf.js only performs incremental (ranged) loading over http(s)
 * URLs - it picks its transport by scheme and refuses range support outright
 * for anything else. Serving a custom protocol therefore made it download
 * every document in full, which for a 465MB sheet set meant roughly 1.2GB of
 * renderer memory. PDFDataRangeTransport is pdf.js's supported answer for
 * supplying data from a non-http source, and it is what the renderer uses
 * instead; this class is the main-process half of it.
 *
 * Only the chunks pdf.js actually asks for cross the IPC boundary, and the
 * file is read through a held FileHandle at an offset - no whole document is
 * ever buffered, in either process.
 *
 * Every open() re-checks containment against the current project root, so a
 * manifest that points outside the project cannot be used to read arbitrary
 * files even though the fileId is otherwise trusted.
 */
export class PdfDataReader {
  private open = new Map<string, OpenDocument>()

  constructor(private readonly store: ManifestStore) {}

  async openDocument(fileId: string): Promise<OpenResult> {
    // Reopening the same fileId (switching away and back) must not leak the
    // previous handle.
    await this.closeDocument(fileId)

    const resolved = this.store.resolveFilePath(fileId)
    if (!resolved) throw new Error(`Unknown fileId: ${fileId}`)

    const safePath = await resolveWithinRoot(resolved.absolutePath, resolved.rootPath)
    if (!safePath) throw new Error('File is unavailable')

    const handle = await fs.open(safePath, 'r')
    try {
      const { size } = await handle.stat()
      this.open.set(fileId, { handle, length: size, bytesServed: 0, chunkCount: 0 })
      const initialData = await this.readRange(fileId, 0, Math.min(INITIAL_CHUNK_BYTES, size))
      return { length: size, initialData }
    } catch (err) {
      await handle.close().catch(() => undefined)
      this.open.delete(fileId)
      throw err
    }
  }

  /**
   * Reads [begin, end) - end is EXCLUSIVE, matching pdf.js's
   * requestDataRange contract (it builds `bytes=${begin}-${end - 1}`).
   * Getting this off by one corrupts every chunk in a way that still parses
   * for a while, so it is asserted by tests rather than trusted.
   */
  async readRange(fileId: string, begin: number, end: number): Promise<Uint8Array> {
    const doc = this.open.get(fileId)
    if (!doc) throw new Error(`Document not open: ${fileId}`)

    if (!Number.isInteger(begin) || !Number.isInteger(end)) {
      throw new Error(`Invalid range [${begin}, ${end})`)
    }
    const start = Math.max(0, begin)
    const stop = Math.min(end, doc.length)
    if (start >= stop) return new Uint8Array(0)
    if (stop - start > MAX_CHUNK_BYTES) {
      throw new Error(`Range of ${stop - start} bytes exceeds the ${MAX_CHUNK_BYTES}-byte limit`)
    }

    const length = stop - start
    const buffer = Buffer.allocUnsafe(length)
    let filled = 0
    // A single read is not guaranteed to return everything asked for.
    while (filled < length) {
      const { bytesRead } = await doc.handle.read(buffer, filled, length - filled, start + filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    doc.bytesServed += filled
    doc.chunkCount += 1
    return new Uint8Array(buffer.buffer, buffer.byteOffset, filled)
  }

  async closeDocument(fileId: string): Promise<void> {
    const doc = this.open.get(fileId)
    if (!doc) return
    this.open.delete(fileId)
    if (process.env.TOOL_DEBUG_PDFDATA) {
      const pct = ((doc.bytesServed / doc.length) * 100).toFixed(1)
      // eslint-disable-next-line no-console
      console.log(
        `[pdfData] ${fileId}: served ${doc.bytesServed} of ${doc.length} bytes (${pct}%) in ${doc.chunkCount} chunks`
      )
    }
    await doc.handle.close().catch(() => undefined)
  }

  /** Diagnostics: bytes actually handed to the renderer for an open document. */
  statsFor(fileId: string): { bytesServed: number; chunkCount: number; length: number } | undefined {
    const doc = this.open.get(fileId)
    return doc ? { bytesServed: doc.bytesServed, chunkCount: doc.chunkCount, length: doc.length } : undefined
  }

  /** Called on app shutdown so no handle outlives the process cleanly. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.open.keys()].map((fileId) => this.closeDocument(fileId)))
  }

  /** Test/diagnostic aid: how many documents currently hold an open handle. */
  get openCount(): number {
    return this.open.size
  }
}
