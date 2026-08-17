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

### 2a. Whole-file residency — MEASURED AND REJECTED

Prompted by Bluebeam loading any page of this set in under a second, cold. The
hypothesis was that a local file on an SSD should be read or indexed in full on
open, making `disableAutoFetch: true` the wrong model. Measured:

  whole 523MB file off this SSD    246ms first, 188ms repeat (2.1-2.8 GB/s)
  page 138 parse, demand-fetched   2615ms
  page 138 parse, all bytes resident 2353ms
  memory, getDocument({data})      rss 1020 -> 2097MB (pdf.js keeps its own copy)

**Residency buys ~10% for ~523MB per open document.** The bytes were never the
bottleneck - disk is two orders of magnitude cheaper than the parse. Do not
reach for `disableAutoFetch: false`.

This section once closed by claiming the app's I/O was IPC-bound rather than
disk-bound - 196 requests at **3463ms in the app** against **936ms of actual
read()** - and pointed at fewer/larger requests or a buffer held in main. **That
was wrong and is retracted; see 2c.** Both of those figures are sums of
OVERLAPPING durations (peak 60 requests in flight), so neither is a cost and the
~2.5s "gap" between them is not a quantity of anything. Sanity check the 936ms
against the disk rate measured four lines above: 26.6MB at 2.1GB/s is ~13ms of
actual read. Real transport cost is ~123ms.

### 2b. Parse cost is per-PAGE, not per-document

The single most useful number found so far, because it reframes what "slow"
means. Measured operator-list construction:

  page    ops        parse    kind
    60     47478      141ms   vector
    23     52349      290ms   vector
     1     46919      370ms   vector
     4       477      960ms   one JBIG2 scan
   138     12302     2429ms   photo collage
    10   1489578     3071ms   huge vector
   137     12318     5265ms   photo collage

A normal plan sheet parses in 141-370ms. The pathological pages are image-heavy,
and their cost is DECODE, not operator count - page 137 has 12k operators and
takes 5.3s while page 10 has 1.49M operators and takes 3.1s. Never reason about
page cost from operator count.

Bluebeam is native C++, so its JBIG2/JPEG2000 decode is likely far faster than
pdf.js's wasm path regardless of scheduling. Sub-second on page 137 may be partly
decoder speed that scheduling cannot close - worth establishing before treating
1s as the target for every page rather than for normal sheets.

### 2c. IPC transport overhead — MEASURED AND REJECTED

The "3463ms of I/O" that motivated this was **an artifact of summing overlapping
durations**. Peak concurrent range requests: **60**. Measured transport cost:

  per message      0.225 ms   (a 1-byte read is 0.100 ms)
  per byte         2.962 ms/MB   (~338 MB/s end to end)
  196 req, 26.6MB  44 ms + 79 ms = ~123 ms

So there is no 2.5s to reclaim. `rangeChunkSize` at 1MB would save ~40ms of the
44ms message overhead; coalescing adjacent requests, batching per tick, and
read-ahead buffers in main all save less than that. **Do not build them.**

The far-jump cost is decode, not transport - page 137 alone is 5265ms.

**On the payload figure.** Two numbers were recorded for the same 196-request
jump: **34 MB** in the original 2d entry and **26.6 MB** here. Only one can be
right and the raw dumps were not kept, so this is settled by provenance rather
than re-derivation: 26.6 MB came from the controlled payload sweep, at counter
precision, after the concurrency error was understood; 34 MB is a round
restatement written in the same paragraph as the discredited 3463ms. **26.6 MB
is the figure to quote.** The conclusion does not turn on it either way - at
34 MB the total would be 44 + 101 = ~145ms. `io:bytes` is authoritative if
anyone wants to close it properly: enable `__PDF_PERF__`, open the set, jump
cold to 138, and read `io:bytes` next to `io:requests` and `io:peak in flight`.

### 2d. Range prefetch — probably also not worth it
This is the part of "floor-bound" that *is* fixable, and it should not be
confused with the item above.

`disableAutoFetch: true` (load-bearing: without it pdf.js walks the whole
document and the memory win evaporates) means every byte is a **sequential
demand fetch**. A cold jump to page 138 issued **196 range requests for 26.6 MB**
(see 2c on that figure), each a full IPC round trip, with pdf.js parsing a
little, discovering it needs more, and waiting again.

Superseded by 2c: the 3463ms figure this rested on was a sum of overlapping
durations, and the real transport cost is ~123ms. Prefetching bytes cannot beat
that. **Untried and now low-value.** If revisited, note that `io` totals must be
read against `io:peak in flight` (60) rather than taken as elapsed cost.

### 2e. Primary-page priority — the co-visibility premise was FALSE

Commit 116e383 closed with: page 138 did not fall to ~2.4s because "at fit-width
two pages are genuinely visible, so 137 and 138 are both foreground and both
still parse on the critical path", and proposed prioritising the primary page
over other VISIBLE pages, trading a longer blank on the neighbour. The cheap
version of that - demote a page covering less than some fraction of the viewport
to the overscan tier, reusing the existing two-tier gate - was specced and then
checked against the geometry before being built. **It has nothing to bite on.**

Real geometry, read off the file: all 138 pages are **2592x1728** after `/Rotate`
(94 at 270, 44 at 90). Uniform, so `referenceSize` never changes and the
fit-width scale does not move when the current page does. A 3:2 page at fit width
is `availableWidth / 1.5` tall - taller than any landscape viewport - so:

  viewport      scale     page box      visible after a jump to 138
  1280x700     0.4846   1256x837       p138 = 98.1%   (2 tiles)
  1600x820     0.6080   1576x1051      p138 = 98.5%   (4 tiles)
  1920x980     0.7315   1896x1264      p138 = 98.8%   (4 tiles)
  2560x1300    0.9784   2536x1691      p138 = 99.1%   (6 tiles)

**One visible page, at ~98%.** Page 137 has no visible region at all: it is
already overscan and already held. A coverage threshold under 98% is inert and
one over it would defer the page the user navigated to. A second page appears
only on a viewport narrower than the 3:2 page aspect - a portrait window.
Pinned in `test/visiblePages.test.ts`, cheap to re-run on other sheet geometry.

**What is actually left, and it is a different mechanism.** `foregroundReady`
flips as soon as the destination paints its **first** tile - but the destination
wants 2-6 tiles. So the held neighbour's preview is released, and its 5265ms
parse starts, while tiles 2..N of the page being looked at are still rendering.
That fits the shape of the residual: 138 reaches sharp in 6349ms while its own
parse is 2429ms.

The candidate fix is to release the hold when the destination's **current tile
set is complete** rather than on its first tile. No new tier, no coverage
threshold, no blank-neighbour trade - the neighbour is off-screen either way.
It needs the same two escape hatches as the existing gate (tile failure and the
deadline), because "all tiles" is a harder condition to reach than "any tile"
and a page must never wait forever. **Unbuilt and unmeasured**; the hypothesis
above is inferred from tile counts, not observed, so instrument the release
point before writing the change.

---

## THE JUDGEMENT CALL — what to do next, decided without the deciding measurement

The instrumentation in `59a78ef` was never run. This section is a **judgement,
not a finding**, and it is written that way on purpose so a future session does
not inherit it as measured fact. Everything above this line is measured;
everything in this section is reasoning from it.

### The reframing that decides it

Cost per arrival is **one parse plus N full replays of the operator list**, and
only the parse is cached. On a cold fit-width arrival at page 138 the viewer
performs:

  1 parse            2429 ms, irreducible without changing pdf.js's decoder
  2-6 tile renders   each replays the ENTIRE operator list
  1 preview render   replays it again, at low resolution
  1 neighbour        parse 5265 ms + its own preview replay

Decode is cached after the first replay, so replays 2..N are draw and fill - but
on a sheet whose content *is* twelve large aerials, drawing twelve large aerials
is not the cheap part, and every replay pays rAF pacing independently.

**The insight is that tiling is a HIGH-ZOOM mechanism being paid for at fit
width, where it earns nothing.** Tiles exist for two reasons, both of which are
about zoom: staying clear of the 2^28 canvas paint cliff, and bounding memory
when a page is far larger than the viewport. At fit width neither applies - the
whole page is 1.7-4.3 Mpx of CSS pixels and fits comfortably in one safe canvas -
yet the page is still cut into 2-6 canvases, each replaying everything.

### Ranked, highest expected value first

**1. Render a page as ONE canvas whenever it fits in one safely, and tile only
when it does not.** This is the change to make. It removes N-1 redundant
full-page replays from the common case - every fit-width arrival, which is how
the app is normally used - and it does so by construction rather than by tuning.

The threshold is arithmetic, not taste: a 2592x1728 page at scale `s` and dpr 2
is `17.9M * s²` device pixels, so it stays inside the existing 64 Mpx
`MAX_CANVAS_PIXELS` budget up to about **s = 1.9**. Fit width is 0.48-0.98. Above
the threshold, tile exactly as now. The measured cliff is ~252 Mpx, so the budget
keeps a 4x margin and the safety property is preserved by construction.

Note this is NOT "raise `TILE_PX` to 2048". That proposal came with a ~46%
prediction from the `T(N) = N*D + F` model, whose `D` was interpreted as
per-canvas operator-list *dispatch* - and dispatch is exactly what the op-count
finding discredited. **Do not resurrect the number.** The mechanism here is
different and does not depend on that model: it is "stop replaying the operator
list N times when one replay would do", and its magnitude is unknown.

**2. Do not pay for the overscan neighbour on a page JUMP.** `OVERSCAN_PAGES = 1`
means a typed jump to 138 also mounts 137, and on exhibit sheets that is 5265 ms
of worker time for a page that - per 2e - is entirely off screen. The current
hold *defers* that work; it does not remove it, and whether it lands inside the
destination's render window is precisely the thing that was never measured.

Mounting overscan only once the destination has **settled** (its whole tile set
complete, not its first tile) removes the uncertainty rather than chasing it.
Overscan earns its keep while scrolling, where the neighbour is where you are
about to be; on a typed jump the user asked for one page. This subsumes the
"release on tile-set completion" candidate in 2e, and it needs the same two
escape hatches for the same reason.

**3. Skip the arrival preview when tiles already cover the page.** At fit width
the visible region *is* the page, so the preview is a whole extra replay of the
same content, at low resolution, immediately covered. Its real job is covering
the page during a ZOOM, where tiles are discarded and it is not re-rendered -
so keep it for that and stop rendering it on arrival. Smallest of the three, and
the one most likely to be already half-solved by item 1.

### What this is expected to achieve, stated so it can be falsified

Page 138 arriving in roughly **2.5-3.5 s** instead of 6349 ms, with the floor
set by its own 2429 ms parse. Normal vector sheets are already at 1.2 s against a
141-370 ms parse and should improve proportionally less.

**Sub-second is probably not reachable and should not be the target.** Bluebeam
is native C++; its JBIG2/JPEG2000 decode is likely far faster than pdf.js's wasm
path, and no amount of scheduling closes a decoder gap. rAF pacing is a hard
floor underneath all of this.

### Confidence, honestly

- Item 1: mechanism certain, magnitude unknown. Fewer replays cannot be slower.
- Item 2: magnitude known (5265 ms of real work), behaviour trade real - scroll
  down immediately after a jump and the neighbour will not be ready.
- Item 3: mechanism certain, magnitude small.

If someone runs the instrumentation before building any of this, it can only
sharpen the order. It cannot make item 1 wrong.

---

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
