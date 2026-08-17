# PDF viewer performance — what shipped, what was rejected, what is left

Everything here is measured on `Test2/.../Kincora ... (Full Sheets) (1).pdf`
(523 MB, 138 pages, `/Rotate 270` on 94 and `90` on 44), in `npm run dev`, at
`devicePixelRatio` 1. **Page 23 is the representative test page** — a 51k-operator
vector plan sheet. Page 138 is an aerial photo collage and is the pathological
case, not the normal one.

Viewer performance work is **closed** as of this document. It is written so a
future session can tell what was tried from what was merely considered.

---

## Shipped

| Change | Effect |
|---|---|
| **`pdfData` buffer-pool fix** (`cf557fa`) | `readRange` returned a view over `Buffer.allocUnsafe`, whose backing ArrayBuffer is Node's shared 64 KB pool for any read under 32 KB. Structured clone sends the *backing buffer*, so the renderer received unrelated main-process memory. Not perf — a boundary leak. |
| **Bounded page-retention LRU, cap 6** (`17c3464`) | Far-jump revisits: ~7.6 s → ~0 s. Retention hits went 0/9 → 6/3. **Re-measured after the remount fix — see the correction below.** |
| **Preview budget 2M → 250k pixels** (`b6657b3`) | Previews were the largest single line item at 7569 ms over five zoom clicks. ~8× less fill. |
| **Preview gated behind the first tile** (`2c05968`) | Preview and tiles were both replaying the whole operator list, concurrently, in front of the user. Preview total 6745 → **3477 ms**, two fewer operator-list builds, time-to-sharp 1923 → 1656 ms (−14%). |

### Correction: the LRU's original headline was inflated by a separate bug

The LRU was first measured as removing "23.4 s of destroyed parses over five
zoom clicks", and revisits as 24× faster. The parse figure was real but its
CAUSE was not the LRU's to own: pages were remounting on every zoom step because
the visible range was computed against a stale scroll offset (see below). With
that fixed, five zoom clicks produce **0 page mounts, 0 previews and 0 parses**,
so the LRU now contributes nothing to zooming.

What it still earns, re-measured on the same page 1 -> 138 -> 1 -> 138 scenario:

  leg                  cap 3     cap 6
  jump to end (cold)   ~9.1 s    ~7.6 s
  jump back to start   ~1.5 s    ~0 s
  jump to end again    ~7.6 s    ~0 s

A far jump genuinely changes the page set, so the cache is doing real work
there. Keep it, at cap 6, for that reason - not for the zoom number that
originally justified it.

### The invariant that cost the most to find

**`RETAINED_PAGES` ≥ 2 × (2 × `OVERSCAN_PAGES` + 1).** A cap equal to *one*
mounted window is pathological, not merely small: on A→B→A the window arriving
at B evicts A's pages just before they are needed, so the cache never hits.
Measured at cap 3 with a 3-page window: **0 hits, 9 misses**. If
`OVERSCAN_PAGES` changes, this changes with it.

---

## Measured and rejected — do not rebuild these

Each of these looked obviously right beforehand. The number that killed it is
recorded so it does not get proposed again from first principles.

### Wheel-event coalescing — REJECTED
The zoom path calls `applyZoom` per wheel event with no coalescing, so a
gesture should have produced a storm of discarded tile sets.

**Killed by: 1.67 wheel events per gesture.** A detented mouse wheel, not a
trackpad. There is nothing to coalesce, and `tiles cancelled : completed` was
`0.00`. Would matter on a trackpad; does not matter here.

### Render-priority queue — REJECTED (correct, but not worth it)
A semaphore ordering visible-page rasterisation ahead of overscan. It *is* the
correct fix for arrival cost, and it removes the race that defeated the
`requestIdleCallback` attempt (React commits every child's render phase before
any effect runs, so a synchronous counter still races).

**Killed by: removing four of six concurrent renders bought 12%.** Under a
contention model the sharp layer should have been ~3× faster. Reordering the
*same* work therefore buys less than that. Filed in CLAUDE.md's not-built list
with this warning attached.

### `TILE_PX` 1024 → 2048 — NEVER BUILT, and the prediction is now suspect
The tile-tax probe fitted `T(N) = N·D + F` with D ≈ 114 ms of per-canvas
operator-list dispatch and F ≈ 213 ms of fill for the whole region, holding
within 6% at N = 16. That predicted ~46% off tile raster from cutting tile count
~4×, at ~1.8× the backing memory (151 → 268 MB per page at dpr 2; the 2²⁸ paint
cliff is not a concern — a 2048 tile at dpr 2 is 16.8 Mpx, 6% of it).

**RE-DERIVE BEFORE TRUSTING THAT.** The model assumed tiles are
contention-bound. They are not — see below. A prediction built on a false
premise can still fit its own data.

---

## Filed for later

### 1. rAF pacing — STRUCTURAL, not addressable
`InternalRenderTask._scheduleNext` schedules every render continuation through
`requestAnimationFrame` (`pdf.mjs:16972`). A render needing N continuations has
a floor of N × ~16.7 ms *regardless of machine speed*, and concurrent renders
progress in lockstep — five renders once finished within 2.5 ms of each other
after 8.2 s.

This is why removing 4 of 6 concurrent renders bought only 12%. **Nothing short
of changing how pdf.js schedules continuations moves it.** Do not spend effort
here expecting a win; treat it as the floor that other work has to live above.

Corollary that wasted real time once: **a hidden or unfocused window throttles
rAF to nothing**, so any measurement taken against a window that is not on
screen is invalid, not merely noisy. It looks exactly like rendering hanging.

### 2. Range prefetch — LATENCY, and the addressable one
This is the part of "floor-bound" that *is* fixable, and it should not be
confused with the item above.

`disableAutoFetch: true` (load-bearing: without it pdf.js walks the whole
document and the memory win evaporates) means every byte is a **sequential
demand fetch**. A cold jump to page 138 issued **196 range requests for 34 MB,
3463 ms of measured I/O**, each a full IPC round trip, with pdf.js parsing a
little, discovering it needs more, and waiting again.

Latency, not throughput — so it is hideable. Speculatively fetching the
destination page's ranges on navigation, or widening the request granularity,
would attack it without touching `disableAutoFetch`. **Untried.** The counters
needed to evaluate it (`io`, `io:requests`, `io:bytes`) are already in place.

### 3. Decode-to-target-size — no mechanism yet
Page 138's aerials decode at full resolution to fill a 250k-pixel preview at 35%
zoom. `maxImageSize` is **not** the answer and must not be reached for: it is a
`getDocument` guard rail keyed on total pixel count that makes oversized images
*fail to decode* rather than downscale, so on a sheet whose content *is* one
large aerial it would render the sheet empty — a wrong number that looks
plausible. Any real fix means changing how pdf.js decodes images. No proposal.

---

## The instrumentation is retained deliberately

`src/renderer/src/pdf/perf.ts` plus lines marked `// PERF` are **kept, not
stripped**. It caught four wrong predictions in one session, and `TILE_PX`, rAF
pacing and range prefetch are all still open and all need these exact counters.
Rebuilding it would cost more than carrying it.

**Turning it on:**

```js
__PDF_PERF__ = true          // BEFORE opening the document — see below
__PDF_PERF_PHASE__('name')   // label what follows
__PDF_PERF_RETENTION__(n)    // read/set the retention cap
__PDF_PERF_CANVASES__()      // live canvas census
__PDF_PERF_TILETAX__()       // tile-count vs raster-cost probe
__PDF_PERF_DUMP__()          // the report
__PDF_PERF_RESET__()         // clear
```

**`pdfBug` must be enabled before the document opens.** Parse-vs-raster timing
comes from pdf.js's `StatTimer`, switched on by the `pdfBug` option, which is
gated on `__PDF_PERF__` and read *once* at `getDocument`. Set the flag, then
open the PDF. If a document is already open, close its tab and reopen it, or
every `pdfjs:*` row will be missing.

### Reading the report without being misled

- **`raster:*` totals are not additive.** Renders run concurrently and each
  timer measures *elapsed* time, so N concurrent renders count the same window N
  times — 41 s of "raster" was recorded inside an 8.3 s wall clock. **Wall clock
  per phase is the only honest aggregate.**
- **`pdfjs:Rendering` is unreliable.** `StatTimer` keys running timers by name
  only, so two concurrent renders of one page corrupt each other and emit
  `start: undefined` → NaN. `pdfjs:Page Request` is safe (built once per
  operator list).
- **Render cost tracks operator *type*, not count.** Page 138 has 11.4k
  operators and renders 5× slower than page 1's 45k.

### Cost of keeping it

`// PERF` lines are scattered through `PdfPageCanvas.tsx` and `PdfViewer.tsx` —
the two most-edited files in the project. **If that starts making them hard to
read, strip it then**: delete `pdf/perf.ts` and every `// PERF` line
(`grep -rn "// PERF" src/`). Git history has it, and this document records what
it was for.
