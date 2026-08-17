/**
 * TEMPORARY performance instrumentation for the PDF render path.
 *
 * ============================ HOW TO REMOVE ============================
 *   1. delete this file
 *   2. delete every line marked with a trailing `// PERF`
 *      (`grep -rn "// PERF" src/` lists the complete set)
 * There is nothing else. No build config, no dependency, no test touches it.
 * ======================================================================
 *
 * Disabled unless `globalThis.__PDF_PERF__` is set, which it never is by
 * default - you turn it on from the devtools console. Every entry point below
 * early-returns when off.
 *
 * BUCKET (b) NEEDS THE FLAG SET *BEFORE* THE DOCUMENT OPENS. Parse-vs-raster
 * timing comes from pdf.js's own StatTimer, which is switched on by the
 * `pdfBug` option passed to getDocument - read once, at open. That option is
 * gated on this flag so StatTimer never runs inside the render loop in a
 * shipped build, which means: set __PDF_PERF__ = true, THEN open the PDF. If
 * the document is already open, close its tab and reopen it, or `pdfjs:*` rows
 * will be missing from the report.
 *
 * Console API, all installed on `globalThis`:
 *
 *   __PDF_PERF__ = true          enable recording (before opening a document)
 *   __PDF_PERF_PHASE__('zoom')   label everything recorded from now on
 *   __PDF_PERF_DUMP__()          print the report (and return it as a string)
 *   __PDF_PERF_RESET__()         clear records and counters
 *   __PDF_PERF_TILETAX__()       run the tile-tax probe (see below)
 *
 * The four buckets asked for map onto `kind` like this:
 *   (a) file I/O        'io'
 *   (b) parse + decode  'pdfjs:Page Request'   (pdf.js's own StatTimer)
 *   (c) rasterization   'raster:tile', 'raster:preview'
 *                       cross-checked by 'pdfjs:Rendering'
 *   (d) blit / present  'blit:tile', 'blit:preview', 'present'
 */

import type { PDFPageProxy, PageViewport } from 'pdfjs-dist'

export interface PerfRecord {
  /** ms since the module loaded. */
  t: number
  phase: string
  kind: string
  ms: number
  page?: number
  detail?: string
  bytes?: number
}

const RECORD_CAP = 20_000

const records: PerfRecord[] = []
const counters = new Map<string, number>()
let phase = 'startup'
const t0 = performance.now()

/** Set from PdfPageCanvas so the tile-tax probe has a real page to render. */
let probePage: { page: PDFPageProxy; pageNumber: number; viewport: PageViewport } | undefined

interface PerfGlobals {
  __PDF_PERF__?: boolean
  __PDF_PERF_PHASE__?: (name: string) => void
  __PDF_PERF_DUMP__?: () => string
  __PDF_PERF_RESET__?: () => void
  __PDF_PERF_TILETAX__?: (edge?: number) => Promise<string>
  __PDF_PERF_CANVASES__?: () => CanvasCensus
  __PDF_PERF_TRACE__?: () => Array<{ t: number; kind: string; detail: string }>
}

const g = globalThis as typeof globalThis & PerfGlobals

export function perfOn(): boolean {
  return g.__PDF_PERF__ === true
}

/**
 * A start stamp that costs nothing when recording is off.
 *
 * The guards live INSIDE the functions below, so a call site's ARGUMENTS are
 * always evaluated - `performance.now()`, template strings and object literals
 * all run even when disabled. That is fine once per document open and not fine
 * on a path that runs per pan frame or per chunk, so hot sites use this and
 * wrap their record call in `if (perfOn())`.
 */
export function perfNow(): number {
  return perfOn() ? performance.now() : 0
}

export function perfRecord(kind: string, ms: number, extra?: Omit<Partial<PerfRecord>, 'kind' | 'ms'>): void {
  if (!perfOn()) return
  if (records.length >= RECORD_CAP) return
  records.push({ t: performance.now() - t0, phase, kind, ms, ...extra })
}

/**
 * An ordered trace. The summary tables aggregate, and a remount question is
 * about SEQUENCE - which page mounted, when, and what the visible range was at
 * that moment. Capped so it cannot grow without bound.
 */
const TRACE_CAP = 4000
const trace: Array<{ t: number; kind: string; detail: string }> = []

export function perfTrace(kind: string, detail: string): void {
  if (!perfOn()) return
  if (trace.length >= TRACE_CAP) return
  trace.push({ t: Math.round(performance.now() - t0), kind, detail })
}

/** Records a high-water mark rather than a total. */
export function perfPeak(name: string, value: number): void {
  if (!perfOn()) return
  counters.set(name, Math.max(counters.get(name) ?? 0, value))
}

export function perfCount(name: string, by = 1): void {
  if (!perfOn()) return
  counters.set(name, (counters.get(name) ?? 0) + by)
}

/** Times an awaited operation and records it. Returns whatever it returns. */
export async function perfTime<T>(
  kind: string,
  extra: Omit<Partial<PerfRecord>, 'kind' | 'ms'>,
  run: () => Promise<T>
): Promise<T> {
  if (!perfOn()) return run()
  const start = performance.now()
  try {
    return await run()
  } finally {
    perfRecord(kind, performance.now() - start, extra)
  }
}

/**
 * Times a synchronous operation - used for the blit.
 *
 * Takes the page number rather than an options object so a disabled build does
 * not allocate one per blit. The closure is inherent: it IS the work.
 */
export function perfSync<T>(kind: string, page: number, run: () => T): T {
  if (!perfOn()) return run()
  const start = performance.now()
  try {
    return run()
  } finally {
    perfRecord(kind, performance.now() - start, { page })
  }
}

/**
 * Records how long after `since` the next frame actually paints. This is the
 * only honest way to measure (d) present: drawImage returning is not the same
 * as the pixels being on screen.
 */
export function perfPresent(since: number, pageNumber: number): void {
  if (!perfOn()) return
  requestAnimationFrame(() => {
    perfRecord('present', performance.now() - since, { page: pageNumber })
  })
}

/**
 * Drains any new entries from pdf.js's own StatTimer, which `pdfBug: true`
 * turns on. `Page Request` is the worker-side parse + font load + image
 * decode; `Rendering` is the canvas walk. Call with the length captured
 * BEFORE the render started.
 *
 * Caveat recorded honestly: the preview render and the tile loop share one
 * StatTimer per page, so when they overlap the entries interleave. Our own
 * 'raster:*' timers are the authority for (c); these are the cross-check and
 * the only source for (b).
 */
export function perfStatsMark(page: PDFPageProxy): number {
  if (!perfOn()) return 0
  return page.stats?.times.length ?? 0
}

export function perfStatsDrain(page: PDFPageProxy, pageNumber: number, from: number): void {
  if (!perfOn()) return
  const times = page.stats?.times as Array<{ name: string; start: number; end: number }> | undefined
  if (!times) return
  for (let i = from; i < times.length; i++) {
    const entry = times[i]
    const ms = entry.end - entry.start
    // StatTimer keys running timers by NAME ONLY, so two concurrent renders of
    // the same page corrupt each other: the second time() overwrites the first
    // one's start, and the second timeEnd() finds the key already deleted and
    // pushes `start: undefined`, which lands here as NaN. One NaN poisons
    // reduce() and Math.max() for the whole group while median() sorts around
    // it - exactly the total/max=NaN, median=fine signature we saw.
    //
    // The preview render and the tile loop share one PDFPageProxy, so this
    // fires routinely for "Rendering". "Page Request" is unaffected: it is
    // started once per operator-list build, guarded at pdf.mjs:15666.
    if (!Number.isFinite(ms)) {
      perfCount(`pdfjs:${entry.name} corrupted samples`)
      continue
    }
    perfRecord(`pdfjs:${entry.name}`, ms, { page: pageNumber })
  }
}

/**
 * Operator-list length for a page, read out of pdf.js's private intent state.
 *
 * Deliberately NOT `page.getOperatorList()`: that requests a different
 * rendering intent and would force a SECOND full parse, distorting the very
 * numbers we are here to collect. Reading the already-built list costs
 * nothing. Private access is acceptable for throwaway instrumentation.
 */
export function perfOpListLength(page: PDFPageProxy, pageNumber: number): void {
  if (!perfOn()) return
  if (counters.has(`oplist:page${pageNumber}`)) return
  const states = (page as unknown as { _intentStates?: Map<string, { operatorList?: { fnArray: unknown[] } }> })
    ._intentStates
  if (!states) return
  for (const state of states.values()) {
    const len = state.operatorList?.fnArray.length
    if (typeof len === 'number' && len > 0) {
      counters.set(`oplist:page${pageNumber}`, len)
      return
    }
  }
}

/**
 * Extra rows for the report's Environment table, supplied by modules that
 * perf.ts must not import (pageRetention imports perf, so perf importing it
 * back would be a cycle).
 *
 * This exists because the first sweep produced a dump with no record of which
 * retention cap it was taken at, which would have made three sweep dumps
 * indistinguishable. A measurement that does not record its own settings is
 * not a measurement.
 */
let envRows: (() => Array<[string, string]>) | undefined

export function perfRegisterEnv(probe: () => Array<[string, string]>): void {
  envRows = probe
}

/** Lets the tile-tax probe reach a real, already-parsed page. */
export function perfRegisterPage(pageNumber: number, page: PDFPageProxy, viewport: PageViewport): void {
  if (!perfOn()) return
  probePage = { page, pageNumber, viewport }
}

// ---- canvas census ----------------------------------------------------

/**
 * Live <canvas> elements attached to the document, and the total bytes their
 * backing stores hold (width * height * 4).
 *
 * Chromium caps how many 2D canvases get GPU acceleration per page and
 * silently demotes the rest to software raster. Nothing in JS can observe that
 * demotion directly - this reports the inputs to it (count and bytes) so the
 * number is at least on the table. See the report footer for how to confirm
 * demotion in DevTools.
 *
 * Off-screen render targets are deliberately NOT counted here: they are
 * detached and transient. `canvas:offscreen live` tracks those separately.
 */
const canvasCollection = (): HTMLCollectionOf<HTMLCanvasElement> =>
  document.getElementsByTagName('canvas')

export interface CanvasCensus {
  total: number
  tiles: number
  previews: number
  overlays: number
  backingMB: number
  offscreenLive: number
}

let offscreenLive = 0
let offscreenPeak = 0

export function perfOffscreenOpen(): void {
  if (!perfOn()) return
  offscreenLive += 1
  if (offscreenLive > offscreenPeak) offscreenPeak = offscreenLive
}

export function perfOffscreenClose(): void {
  if (!perfOn()) return
  offscreenLive = Math.max(0, offscreenLive - 1)
}

export function perfCanvasCensus(): CanvasCensus {
  const all = canvasCollection()
  let tiles = 0
  let previews = 0
  let overlays = 0
  let bytes = 0
  for (let i = 0; i < all.length; i++) {
    const c = all[i]
    bytes += c.width * c.height * 4
    if (c.classList.contains('pdf-page__tile')) tiles++
    else if (c.classList.contains('pdf-page__canvas--preview')) previews++
    else if (c.classList.contains('pdf-page__canvas--overlay')) overlays++
  }
  return {
    total: all.length,
    tiles,
    previews,
    overlays,
    backingMB: bytes / (1024 * 1024),
    offscreenLive
  }
}

/** Samples the census and folds it into the high-water marks. */
export function perfCanvasSample(): void {
  if (!perfOn()) return
  const census = perfCanvasCensus()
  perfRecord('canvas:live', census.total, { detail: `${census.backingMB.toFixed(1)}MB backing` })
  counters.set('canvas:peak total', Math.max(counters.get('canvas:peak total') ?? 0, census.total))
  counters.set('canvas:peak tiles', Math.max(counters.get('canvas:peak tiles') ?? 0, census.tiles))
  counters.set(
    'canvas:peak backing MB',
    Math.max(counters.get('canvas:peak backing MB') ?? 0, Math.round(census.backingMB))
  )
  counters.set('canvas:peak offscreen', offscreenPeak)
}

// ---- reporting --------------------------------------------------------

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const line = (cells: string[]): string => '| ' + cells.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |'
  const rule = '|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|'
  return [line(headers), rule, ...rows.map(line)].join('\n')
}

function report(): string {
  if (records.length === 0 && counters.size === 0) return '[pdf-perf] nothing recorded - is __PDF_PERF__ = true?'

  // Phase and kind are carried as fields rather than packed into a string key
  // and split back apart: phase names come from the console and can contain
  // whatever separator we pick, and a separator exotic enough to be safe (a
  // NUL, say) makes this file read as binary to grep and to Read.
  const groups = new Map<string, { ph: string; kind: string; values: number[] }>()
  for (const r of records) {
    // A single non-finite sample poisons total and max for its whole group
    // while leaving median plausible-looking. See perfStatsDrain for how
    // pdf.js's StatTimer manufactures them.
    if (!Number.isFinite(r.ms)) continue
    const key = `${r.phase}␟${r.kind}`
    const bucket = groups.get(key)
    if (bucket) bucket.values.push(r.ms)
    else groups.set(key, { ph: r.phase, kind: r.kind, values: [r.ms] })
  }

  const rows = [...groups.values()]
    .map(({ ph, kind, values }) => {
      const total = values.reduce((a, b) => a + b, 0)
      return { ph, kind, n: values.length, total, med: median(values), max: Math.max(...values) }
    })
    .sort((a, b) => (a.ph === b.ph ? b.total - a.total : a.ph.localeCompare(b.ph)))

  const summary = table(
    ['phase', 'kind', 'n', 'total ms', 'median ms', 'max ms'],
    rows.map((r) => [r.ph, r.kind, String(r.n), r.total.toFixed(1), r.med.toFixed(2), r.max.toFixed(2)])
  )

  // WALL CLOCK per phase, from the first to the last record in it. Summed
  // durations answer "where did the time go"; only this answers "how long did
  // the user wait", which is the whole question for a page jump. It includes
  // any idling inside a phase, so label a phase immediately before the action
  // and switch phases immediately after it settles.
  const spans = new Map<string, { first: number; last: number; n: number }>()
  for (const r of records) {
    if (!Number.isFinite(r.ms)) continue
    const span = spans.get(r.phase)
    if (span) {
      span.first = Math.min(span.first, r.t)
      span.last = Math.max(span.last, r.t)
      span.n += 1
    } else {
      spans.set(r.phase, { first: r.t, last: r.t, n: 1 })
    }
  }
  const spanTable = table(
    ['phase', 'records', 'wall clock ms'],
    [...spans.entries()].map(([ph, s]) => [ph, String(s.n), (s.last - s.first).toFixed(1)])
  )

  const counterRows = [...counters.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  const countersTable = counterRows.length
    ? table(['counter', 'value'], counterRows.map(([k, v]) => [k, String(v)]))
    : '(none)'

  // ---- derived: the ratios that actually decide the hypotheses ----
  const c = (name: string): number => counters.get(name) ?? 0
  const ratio = (a: number, b: number): string => (b === 0 ? 'n/a' : (a / b).toFixed(2))
  const gestures = c('zoom:wheel gestures')
  const derived = table(
    ['question', 'value', 'decides'],
    [
      [
        'wheel events per gesture',
        ratio(c('zoom:wheel events'), gestures),
        'hypothesis 1 - no zoom coalescing'
      ],
      [
        'tiles cancelled : completed',
        ratio(c('raster:tiles cancelled'), c('raster:tiles completed')),
        'hypothesis 1 - wasted raster'
      ],
      [
        'computePageLayout per wheel gesture',
        ratio(c('layout:computePageLayout'), gestures),
        'StrictMode double-invoke of render bodies + useMemo'
      ],
      [
        'computePageLayout per wheel event',
        ratio(c('layout:computePageLayout'), c('zoom:wheel events')),
        'compare across the 3 runs - do NOT assume a value'
      ],
      [
        'visibleRange recomputes per wheel event',
        ratio(c('layout:visibleRange'), c('zoom:wheel events')),
        'O(pages) scan, runs on both render passes'
      ],
      [
        'visibleRegions recomputes per wheel event',
        ratio(c('layout:visibleRegions'), c('zoom:wheel events')),
        'O(pages) scan, deps include scrollTop so both passes'
      ],
      [
        'PdfViewer renders per wheel event',
        ratio(c('react:PdfViewer renders'), c('zoom:wheel events')),
        'React reconciliation cost'
      ],
      [
        'PdfViewer renders per pan pointermove',
        ratio(c('react:PdfViewer renders'), c('pan:pointermove events')),
        'hypothesis 4 - two state writes per move'
      ],
      ['page.cleanup calls', String(c('page:cleanup calls')), 'hypothesis 3 - page flip re-parse']
    ]
  )

  const census = perfCanvasCensus()
  const canvasTable = table(
    ['metric', 'now', 'peak'],
    [
      ['attached <canvas>', String(census.total), String(c('canvas:peak total'))],
      ['  of which tiles', String(census.tiles), String(c('canvas:peak tiles'))],
      ['  previews / overlays', `${census.previews} / ${census.overlays}`, '-'],
      ['backing store MB', census.backingMB.toFixed(1), String(c('canvas:peak backing MB'))],
      ['detached offscreen live', String(census.offscreenLive), String(c('canvas:peak offscreen'))]
    ]
  )

  const env = table(
    ['property', 'value'],
    [
      ['devicePixelRatio', String(window.devicePixelRatio)],
      ['innerWidth x innerHeight', `${window.innerWidth} x ${window.innerHeight}`],
      ...(envRows?.() ?? []),
      ['records', String(records.length)],
      ['capped', records.length >= RECORD_CAP ? 'YES - numbers are truncated' : 'no']
    ]
  )

  return (
    `\n===== pdf-perf report =====\n\n${summary}\n` +
    `\nWall clock per phase\n${spanTable}\n` +
    `\nDerived\n${derived}\n` +
    `\nCounters\n${countersTable}\n` +
    `\nCanvas census\n${canvasTable}\n` +
    `JS cannot observe GPU->software demotion. To confirm: DevTools -> ... -> Rendering\n` +
    `-> tick "Frame Rendering Stats", or open chrome://gpu in a new window.\n` +
    `\nEnvironment\n${env}\n`
  )
}

// ---- the tile-tax probe -----------------------------------------------

/**
 * Renders the SAME page region at the SAME total pixel count, split three
 * ways: 1 canvas, 4 canvases, 16 canvases. No user gesture involved.
 *
 * This is the decisive experiment for "raster cost = tile count x operator
 * list length". pdf.js does no per-operator culling, so every canvas replays
 * the whole page's operator list regardless of how small it is.
 *
 *   if op-list dispatch dominates  ->  4-way ~= 4x, 16-way ~= 16x the 1-way
 *   if fill/stroke dominates       ->  all three land within noise
 *
 * The second outcome would kill the hypothesis and mean raising TILE_PX is
 * not worth doing.
 */
async function tileTax(edge = 2048): Promise<string> {
  if (!perfOn()) return '[pdf-perf] enable __PDF_PERF__ first'
  if (!probePage) return '[pdf-perf] no page registered yet - open a PDF and let a page render'

  const { page, pageNumber, viewport } = probePage
  const side = Math.min(edge, Math.floor(viewport.width), Math.floor(viewport.height))
  if (side < 64) return '[pdf-perf] page too small to probe'

  const runSplit = async (split: number): Promise<number> => {
    const cell = Math.floor(side / split)
    const start = performance.now()
    for (let row = 0; row < split; row++) {
      for (let col = 0; col < split; col++) {
        const canvas = document.createElement('canvas')
        canvas.width = cell
        canvas.height = cell
        await page.render({
          canvas,
          viewport,
          transform: [1, 0, 0, 1, -col * cell, -row * cell]
        }).promise
        canvas.width = 0
        canvas.height = 0
      }
    }
    return performance.now() - start
  }

  // Warm: the operator list must already be built, or the first split pays
  // the parse and the comparison is meaningless.
  await page.render({ canvas: Object.assign(document.createElement('canvas'), { width: 16, height: 16 }), viewport })
    .promise

  const results: Array<[number, number]> = []
  for (const split of [1, 2, 4]) {
    results.push([split * split, await runSplit(split)])
  }

  const base = results[0][1]
  const rows = results.map(([tiles, ms]) => [
    String(tiles),
    `${Math.floor(side / Math.sqrt(tiles))}px`,
    ms.toFixed(1),
    `${(ms / base).toFixed(2)}x`
  ])

  const opList = counters.get(`oplist:page${pageNumber}`)
  return (
    `\n===== tile-tax probe (page ${pageNumber}, ${side}x${side} region, same total pixels) =====\n\n` +
    table(['canvases', 'cell', 'total ms', 'vs 1-canvas'], rows) +
    `\n\noperator list length: ${opList ?? 'unknown'}\n` +
    `interpretation: ratios tracking the canvas count => op-list dispatch dominates (raising TILE_PX helps).\n` +
    `                ratios near 1.00x => fill/stroke dominates (raising TILE_PX will not help).\n`
  )
}

// ---- console wiring ---------------------------------------------------

g.__PDF_PERF_PHASE__ = (name: string): void => {
  phase = name
  // eslint-disable-next-line no-console
  console.log(`[pdf-perf] phase -> ${name}`)
}

g.__PDF_PERF_DUMP__ = (): string => {
  const text = report()
  // eslint-disable-next-line no-console
  console.log(text)
  return text
}

g.__PDF_PERF_TRACE__ = (): Array<{ t: number; kind: string; detail: string }> => trace

g.__PDF_PERF_RESET__ = (): void => {
  records.length = 0
  trace.length = 0
  counters.clear()
  offscreenPeak = offscreenLive
  phase = 'startup'
  // eslint-disable-next-line no-console
  console.log('[pdf-perf] cleared')
}

g.__PDF_PERF_CANVASES__ = (): CanvasCensus => {
  const census = perfCanvasCensus()
  // eslint-disable-next-line no-console
  console.log('[pdf-perf] canvases', census)
  return census
}

g.__PDF_PERF_TILETAX__ = async (edge?: number): Promise<string> => {
  const text = await tileTax(edge)
  // eslint-disable-next-line no-console
  console.log(text)
  return text
}
