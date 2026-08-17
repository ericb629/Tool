import { PDFDataRangeTransport } from 'pdfjs-dist'
import { perfCount, perfNow, perfOn, perfRecord } from './perf' // PERF

/**
 * Feeds pdf.js document bytes on demand over IPC.
 *
 * pdf.js only does incremental loading over http(s) URLs - it selects its
 * transport by scheme and disables range support for anything else - so
 * serving documents from a custom protocol made it pull every file into
 * renderer memory in full (~1.2GB for a 465MB sheet set). PDFDataRangeTransport
 * is the supported escape hatch for a non-http source: pdf.js calls
 * requestDataRange for the byte ranges it actually needs, and we answer them
 * from the main process a chunk at a time.
 *
 * Pair this with `disableAutoFetch: true` on getDocument. Without it pdf.js
 * eagerly walks the whole document in the background and the memory win
 * disappears, which is easy to miss because everything still works.
 */
export class IpcRangeTransport extends PDFDataRangeTransport {
  private aborted = false
  private pending = 0

  constructor(
    private readonly fileId: string,
    length: number,
    initialData: Uint8Array,
    /**
     * Called when a chunk cannot be delivered. Without this the failure is
     * silent and terminal: pdf.js waits for data that will never arrive, so
     * the page simply never finishes rendering and nothing says why.
     */
    private readonly onChunkError?: (message: string) => void
  ) {
    super(length, initialData)
  }

  /**
   * `end` is EXCLUSIVE - pdf.js builds `bytes=${begin}-${end - 1}` for HTTP,
   * and the main-process reader follows the same convention.
   */
  requestDataRange(begin: number, end: number): void {
    if (this.aborted) return
    this.pending += 1
    // Hot: a single far-page jump issued 196 of these, so neither the start
    // stamp nor the range string may be built when recording is off.
    const startedAt = perfNow() // PERF
    perfCount('io:requests') // PERF

    void window.api.pdfData
      .read(this.fileId, begin, end)
      .then((chunk) => {
        if (perfOn()) { // PERF
          perfRecord('io', performance.now() - startedAt, {
            bytes: chunk.byteLength,
            detail: `${begin}-${end}`
          })
        }
        perfCount('io:bytes', chunk.byteLength) // PERF
        // The document may have been closed while this was in flight;
        // delivering then would push data into a torn-down worker.
        if (this.aborted) return
        this.onDataRange(begin, new Uint8Array(chunk))
      })
      .catch((err) => {
        if (this.aborted) return
        const message = err instanceof Error ? err.message : String(err)
        // eslint-disable-next-line no-console
        console.error(`[pdf] chunk ${begin}-${end} failed for ${this.fileId}:`, err)
        // Fail the document loudly. pdf.js has no way to be told a range
        // failed, so the alternative is a page that stays blank forever.
        this.onChunkError?.(`Could not read bytes ${begin}-${end} of this PDF: ${message}`)
      })
      .finally(() => {
        this.pending -= 1
      })
  }

  /**
   * Called by pdf.js when the document is destroyed, and directly by the
   * viewer on unmount. Idempotent: marks in-flight requests to be discarded
   * on arrival and releases the file handle held in the main process.
   */
  abort(): void {
    if (this.aborted) return
    this.aborted = true
    void window.api.pdfData.close(this.fileId).catch(() => undefined)
  }

  /** Diagnostic only: chunk requests still awaiting a reply. */
  get pendingRequests(): number {
    return this.pending
  }
}
