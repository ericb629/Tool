import { PDFDataRangeTransport } from 'pdfjs-dist'

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
    initialData: Uint8Array
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

    void window.api.pdfData
      .read(this.fileId, begin, end)
      .then((chunk) => {
        // The document may have been closed while this was in flight;
        // delivering then would push data into a torn-down worker.
        if (this.aborted) return
        this.onDataRange(begin, new Uint8Array(chunk))
      })
      .catch((err) => {
        if (this.aborted) return
        // Surfacing this as a rejected range would hang the page render with
        // no explanation, so make the failure visible.
        // eslint-disable-next-line no-console
        console.error(`[pdf] chunk ${begin}-${end} failed for ${this.fileId}:`, err)
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
