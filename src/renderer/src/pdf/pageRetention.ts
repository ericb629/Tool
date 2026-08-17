import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { perfCount, perfRegisterEnv } from './perf' // PERF

/**
 * A bounded hold on recently-unmounted pages, so a page leaving the
 * virtualized range does not immediately destroy its parse.
 *
 * WHY THIS EXISTS
 *
 * `page.cleanup()` clears pdf.js's `_intentStates`, which is where the parsed
 * operator list, the decoded images and the loaded fonts live. Calling it the
 * instant a page unmounts means the next visit re-parses from scratch.
 *
 * Measured on the Kincora set, page 15 (146k operators), five zoom-in clicks:
 * 19 cleanup() calls and 7 full re-parses totalling 23.4 SECONDS of worker
 * time. Zoom changes the layout, which changes visibleRange, which unmounts
 * pages, which destroyed parses that were about to be needed again. The UI
 * thread was never the problem - the worker was drowning in repeat work it
 * should never have been asked to do.
 *
 * HOW IT STAYS BOUNDED
 *
 * The invariant this must not break is that scrolling a large sheet set does
 * not retain every page ever visited. Three things enforce that:
 *
 *   1. A hard cap on COUNT. Exceeding it evicts the least-recently-retained
 *      page and cleans it up immediately, so retention is O(cap) and never
 *      grows with the number of pages visited.
 *   2. Mounted pages do not occupy a slot. Mounting calls release(), so the
 *      cap governs unmounted retention only.
 *   3. Closing a document flushes every page it owns, so a closed tab holds
 *      nothing.
 *
 * WHAT IT DOES NOT BOUND - AND CANNOT OBSERVE
 *
 * The cap bounds the COUNT of retained pages, not their BYTES. What a retained
 * page holds - operator list, decoded images, loaded fonts - lives in the
 * pdf.js WORKER's V8 isolate, not in this one. Nothing in this module, and
 * nothing in the renderer's own heap or canvas accounting, can see it:
 *
 *   - `canvas:peak backing MB` measures canvas backing stores only.
 *   - The Performance panel's Memory track and `performance.memory` are scoped
 *     to this isolate, so the worker's heap is invisible to both.
 *   - `performance.measureUserAgentSpecificMemory()` WOULD include dedicated
 *     workers, but it requires cross-origin isolation (COOP/COEP), which this
 *     app does not have and which would be a real change to how the renderer
 *     is loaded - especially on the packaged build's file:// origin.
 *
 * So raising the cap trades worker memory that this code cannot measure for
 * parse time that it can. Read the worker's heap out of band (DevTools ->
 * Memory -> select the pdf.worker JS VM instance -> heap snapshot) before
 * raising it, and lower it rather than raising it if that number is the
 * constraint. A dedicated Worker is a THREAD in the renderer process, not a
 * separate process, so the renderer process's working set also includes it -
 * there is no separate worker process to look at.
 */

/**
 * Number of unmounted pages to hold.
 *
 * MUST BE AT LEAST TWO MOUNTED WINDOWS. The mounted set is
 * (2 * OVERSCAN_PAGES + 1) pages - three at OVERSCAN_PAGES = 1. A cap equal to
 * ONE window is pathological rather than merely small: navigating A -> B -> A,
 * the window arriving at B retains A's pages, then the window returning to A
 * retains B's pages and evicts A's in the process - always just before they
 * are needed again. The cache then never hits at all.
 *
 * That is not a theory. Measured on the Kincora set, jumping page 1 -> 138 ->
 * 1 -> 138 at cap 3: 0 hits, 9 misses, 9 evictions. Raising it to 6:
 *
 *   leg                     cap 3     cap 6
 *   jump to end (cold)      8442ms    8373ms   (unchanged - nothing to cache)
 *   jump back to start      1777ms     227ms   (7.8x)
 *   jump to end again       8261ms     346ms   (24x)
 *
 * with hits/misses going from 0/9 to 6/3 - the three remaining misses being
 * the genuinely-first visits.
 *
 * So: keep this at >= 2 * (2 * OVERSCAN_PAGES + 1). If OVERSCAN_PAGES changes,
 * this has to change with it, or A -> B -> A silently stops hitting.
 *
 * The memory cost is real and is in the worker, where this module cannot see it
 * (see the note above): six retained pages of photo-collage exhibit sheets hold
 * six sets of decoded aerials. Sweep with __PDF_PERF_RETENTION__(n) and take a
 * worker heap snapshot before raising it further.
 */
export const RETAINED_PAGES = 6

/**
 * The subset of PDFPageProxy this module needs. Declared structurally so the
 * bounding behaviour can be tested without a real pdf.js document - an
 * untested memory bound is not a memory bound.
 */
export interface CleanablePage {
  cleanup(): void
}

/** What the cache reports so the perf counters can distinguish failure modes. */
export type RetentionEvent = 'hit' | 'miss' | 'cleanup'

let nextDocId = 1
const docIds = new WeakMap<object, number>()

/**
 * A stable id per document. Keyed weakly so a destroyed document does not stay
 * reachable through this map, and by identity rather than by fingerprint
 * because two tabs on the same file are still two documents.
 */
function docIdFor(doc: object): number {
  let id = docIds.get(doc)
  if (id === undefined) {
    id = nextDocId++
    docIds.set(doc, id)
  }
  return id
}

export class PageRetention {
  /** Insertion-ordered, so the first key is always the least recently used. */
  private readonly entries = new Map<string, { docId: number; page: CleanablePage }>()
  private cap: number

  constructor(
    cap: number = RETAINED_PAGES,
    private readonly onEvent: (event: RetentionEvent) => void = () => undefined
  ) {
    this.cap = Math.max(0, Math.floor(cap))
  }

  /** Pages currently held. Diagnostic and test surface. */
  get size(): number {
    return this.entries.size
  }

  get capacity(): number {
    return this.cap
  }

  /**
   * Change the cap at runtime and apply it immediately. Lowering it evicts and
   * cleans up down to the new cap rather than waiting for the next retain, so
   * a sweep does not carry pages across settings.
   */
  setCapacity(next: number): void {
    this.cap = Math.max(0, Math.floor(next))
    this.trim()
  }

  /** Hold a page that has just unmounted. */
  retain(doc: object, pageNumber: number, page: CleanablePage): void {
    const docId = docIdFor(doc)
    const key = `${docId}:${pageNumber}`
    // Delete first so re-retaining refreshes LRU position rather than keeping
    // the original insertion order.
    this.entries.delete(key)
    this.entries.set(key, { docId, page })
    this.trim()
  }

  /**
   * A page is being mounted again: stop counting it against the cap.
   *
   * The return value is the diagnostic that matters. A HIT means the parse
   * survived the round trip and this cache did its job. A MISS means the page
   * was evicted (or never retained) and is about to be re-parsed - so a high
   * miss count alongside high evictions says the cap is too small, which looks
   * identical to "the fix does nothing" if you only watch Page Request.
   */
  release(doc: object, pageNumber: number): boolean {
    const hit = this.entries.delete(`${docIdFor(doc)}:${pageNumber}`)
    this.onEvent(hit ? 'hit' : 'miss')
    return hit
  }

  /**
   * Release everything belonging to one document. Must run on tab close,
   * before the loading task is destroyed, or a closed document's pages would
   * sit here holding worker resources.
   */
  flushDoc(doc: object): void {
    const docId = docIdFor(doc)
    for (const [key, entry] of [...this.entries]) {
      if (entry.docId !== docId) continue
      this.entries.delete(key)
      entry.page.cleanup()
      this.onEvent('cleanup')
    }
  }

  /** Release everything, for teardown and tests. */
  flushAll(): void {
    for (const entry of [...this.entries.values()]) {
      entry.page.cleanup()
      this.onEvent('cleanup')
    }
    this.entries.clear()
  }

  private trim(): void {
    while (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      const evicted = this.entries.get(oldest.value)
      this.entries.delete(oldest.value)
      // pdf.js defers this if the page still has live render tasks
      // (#tryCleanup returns false while renderTasks.size > 0) and retries on
      // completion, so an evicted page is always released - possibly late,
      // never not at all.
      evicted?.page.cleanup()
      this.onEvent('cleanup')
    }
  }
}

/**
 * The shared instance.
 *
 * 'cleanup' keeps the existing `page:cleanup calls` counter name, so it now
 * counts real evictions rather than every unmount. 'hit'/'miss' are what
 * separate "working" from "cap too small" from "not on the real path".
 */
export const pageRetention = new PageRetention(RETAINED_PAGES, (event) =>
  perfCount(event === 'cleanup' ? 'page:cleanup calls' : `page:retention ${event}`)
) // PERF hook

/** Typed convenience wrappers over the shared instance. */
export function retainPage(doc: PDFDocumentProxy, pageNumber: number, page: PDFPageProxy): void {
  pageRetention.retain(doc, pageNumber, page)
}

export function releasePage(doc: PDFDocumentProxy, pageNumber: number): boolean {
  return pageRetention.release(doc, pageNumber)
}

export function flushDocumentPages(doc: PDFDocumentProxy): void {
  pageRetention.flushDoc(doc)
}

// ---- console knob -----------------------------------------------------
// PERF: wired here rather than in perf.ts because perf.ts must not import this
// module - that would be a cycle.
//
// Deliberately NOT gated on __PDF_PERF__: gating a config setter behind a flag
// means forgetting the flag makes it a silent no-op, which is exactly how a
// sweep produces three identical results and wastes a session.
// The dump must record which cap it was taken at, or a sweep's runs cannot be
// told apart afterwards.
perfRegisterEnv(() => [
  ['retention cap', String(pageRetention.capacity)],
  ['retention held', String(pageRetention.size)],
  ['RETAINED_PAGES default', String(RETAINED_PAGES)]
]) // PERF

interface RetentionGlobals {
  __PDF_PERF_RETENTION__?: (n?: number) => { cap: number; held: number }
}

const rg = globalThis as typeof globalThis & RetentionGlobals

rg.__PDF_PERF_RETENTION__ = (n?: number): { cap: number; held: number } => {
  if (typeof n === 'number') pageRetention.setCapacity(n)
  const state = { cap: pageRetention.capacity, held: pageRetention.size }
  // eslint-disable-next-line no-console
  console.log(`[pdf-perf] RETAINED_PAGES cap=${state.cap}, currently held=${state.held}`)
  return state
}
