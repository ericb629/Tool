import { promises as fs, type promises as fsTypes } from 'fs'
import type { ManifestStore } from './manifest/store'
import { resolveWithinRoot } from './pathSafety'

/**
 * Ceiling on one chunk request, so a single call cannot become "load the
 * whole 500MB sheet set into memory" - the failure this module exists to
 * prevent.
 *
 * Not as small as it looks tempting to make it. pdf.js requests 64KB at a
 * time only while walking the file; when it needs one large object (an image
 * XObject or a dense content stream) it asks for that object's exact byte
 * range in a single call. A real 465MB civil set produced requests of
 * 4,259,840 and 4,456,448 bytes, which a 4MiB ceiling rejected - and a
 * rejected chunk is never delivered, so the page waited for it forever.
 * 64MiB clears any plausible single PDF object while still being a small
 * fraction of a large sheet set.
 */
export const MAX_CHUNK_BYTES = 64 * 1024 * 1024

/**
 * Bytes sent up front with the document length. pdf.js can begin parsing the
 * header while it range-requests the cross-reference table at the end.
 */
export const INITIAL_CHUNK_BYTES = 64 * 1024

interface OpenDocument {
  handle: fsTypes.FileHandle
  length: number
  /**
   * How many callers currently hold this document open.
   *
   * The same file can legitimately be opened more than once at a time: React
   * StrictMode double-invokes effects in dev, so the viewer opens a document,
   * is torn down before the open resolves, and opens it again. Without a
   * count, the first (cancelled) attempt's close tears down the handle the
   * second attempt is actively using. That failure is silent and permanent -
   * readRange answers a closed id with an empty chunk, so pdf.js waits for
   * bytes that never arrive and the viewer shows "Loading PDF..." forever.
   *
   * Each openDocument is paired with exactly one closeDocument by the caller,
   * so counting them is enough; the handle closes when the last one lets go.
   */
  refs: number
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
  /**
   * fileIds that were opened and have since been closed. pdf.js can have a
   * chunk request already in flight when a document is torn down, so that
   * read lands after the handle is gone. Answering it with an empty chunk
   * keeps teardown quiet, while an id that was NEVER opened still throws -
   * that one is a real bug and must not be swallowed.
   */
  private closed = new Set<string>()
  /**
   * Opens for a fileId that have not resolved yet. Two overlapping opens must
   * share one fs.open: opening twice and storing the second over the first
   * leaves the first handle referenced by nothing, so it survives only until
   * the GC notices - which is what the "Closing file descriptor N on garbage
   * collection" warnings were.
   */
  private opening = new Map<string, Promise<OpenResult>>()

  constructor(private readonly store: ManifestStore) {}

  async openDocument(fileId: string): Promise<OpenResult> {
    // Join an open already in flight rather than starting a second one. If it
    // failed, fall through and try again from scratch.
    const inFlight = this.opening.get(fileId)
    if (inFlight) await inFlight.catch(() => undefined)

    const existing = this.open.get(fileId)
    if (existing) {
      existing.refs += 1
      return {
        length: existing.length,
        initialData: await this.readRange(fileId, 0, Math.min(INITIAL_CHUNK_BYTES, existing.length))
      }
    }

    const attempt = this.openNewDocument(fileId)
    this.opening.set(fileId, attempt)
    try {
      return await attempt
    } finally {
      this.opening.delete(fileId)
    }
  }

  private async openNewDocument(fileId: string): Promise<OpenResult> {
    const resolved = this.store.resolveFilePath(fileId)
    if (!resolved) throw new Error(`Unknown fileId: ${fileId}`)

    const safePath = await resolveWithinRoot(resolved.absolutePath, resolved.rootPath)
    if (!safePath) throw new Error('File is unavailable')

    const handle = await fs.open(safePath, 'r')
    try {
      // Reopening makes it live again, so it is no longer "closed".
      this.closed.delete(fileId)
      const { size } = await handle.stat()
      this.open.set(fileId, { handle, length: size, refs: 1, bytesServed: 0, chunkCount: 0 })
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
    if (!doc) {
      // Already torn down, with a request that was in flight at the time:
      // answer emptily rather than raising. An id never opened at all is a
      // genuine fault and still throws.
      if (this.closed.has(fileId)) return new Uint8Array(0)
      throw new Error(`Document not open: ${fileId}`)
    }

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
    // Copy into an exactly-sized buffer rather than returning a VIEW over the
    // read buffer.
    //
    // Buffer.allocUnsafe serves any request under `Buffer.poolSize >>> 1` out
    // of a shared pool. MEASURED on this Node build rather than assumed:
    // poolSize is 65536, so EVERY read under 32768 bytes is pooled and its
    // `buffer.buffer` is the full 64KB pool with a non-zero `byteOffset`.
    //
    // Structured clone across IPC serialises the BACKING ArrayBuffer, not just
    // the view, so the renderer received the whole pool and could read
    // whatever else had recently been allocated in the main process via
    // `chunk.buffer`.
    //
    // That is not a rare edge: pdf.js's 64KB rangeChunkSize is the size of its
    // *walk* requests, and plenty of reads come in smaller - xref fragments, a
    // PDF under 64KB, and any range clamped against the end of the file. The
    // renderer has no `fs` access precisely so that main-process memory cannot
    // reach it, and this leaked straight past that.
    return new Uint8Array(buffer.subarray(0, filled))
  }

  async closeDocument(fileId: string): Promise<void> {
    const doc = this.open.get(fileId)
    if (!doc) return
    // Someone else still holds it open - see OpenDocument.refs.
    doc.refs -= 1
    if (doc.refs > 0) return
    this.open.delete(fileId)
    this.closed.add(fileId)
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

  /**
   * Called on app shutdown so no handle outlives the process cleanly. This
   * one ignores the reference count: the process is going away, so an
   * outstanding reference is not a reason to keep a descriptor open.
   */
  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.open.keys()].map((fileId) => {
        const doc = this.open.get(fileId)
        if (doc) doc.refs = 1
        return this.closeDocument(fileId)
      })
    )
  }

  /** Test/diagnostic aid: how many callers currently hold a document open. */
  refCountFor(fileId: string): number {
    return this.open.get(fileId)?.refs ?? 0
  }

  /** Test/diagnostic aid: how many documents currently hold an open handle. */
  get openCount(): number {
    return this.open.size
  }
}
