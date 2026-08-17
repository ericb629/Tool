# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Electron + React + TypeScript desktop app, Windows-only. Built with `electron-vite`.

A **civil/heavy construction takeoff and estimating tool** — the takeoff-relevant subset of Bluebeam + Excel, plus purpose-built automation. It is not a general PDF editor. Out of scope: Studio collaboration, PDF text/content editing, form fields, digital signatures, batch OCR, pivot tables, charts, macros.

Quantities produced by this app go into bids. **A wrong number that looks plausible is worse than a crash.** That principle drives most of the invariants below.

---

## Hard invariants

These were each decided deliberately, several after finding a real bug. Do not relax one without raising it explicitly first.

### Coordinates
- All persisted geometry is in **PDF user-space: origin bottom-left, Y-up.**
- Pointer events convert to `PdfPoint` **at capture**; convert back to canvas pixels **only at draw time**.
- `ViewportPoint` is a branded type — persisting pixel coordinates is a compile error. Keep it that way.
- Round-trip is verified to 4.5e-13 across zoom levels and all four rotations. Real sheets so far: `userUnit: 1`, MediaBox origin `0,0`.
- **Rotated sheets are the norm, not the exception.** The Kincora set is 138 pages: `/Rotate 270` on 94 and `90` on the other 44, not one at `0`. Never assume `rotate: 0`.

### Quantities
- **Never store a computed quantity** (length, area, count, volume) in the manifest or on disk. Always derive from geometry + page calibration at read time. Storing invites drift when geometry is edited.
- An uncalibrated page returns an explicit `{ status: 'uncalibrated' }` — **never 0, NaN, null, a blank, a bare dash, or a raw user-space number.** The discriminated union must force callers to handle it.
- Count and annotation modes are exceptions: count is dimensionless (returns 1 / `ea` regardless of calibration), annotation returns not-measurable.
- **Quantities always derive from the markup they belong to**, never from session state such as "last drawn." This exact bug shipped once (a takeoff row displayed the last-drawn markup's quantity instead of its linked one) and was invisible until an app restart.

### Arc geometry
- Invariant: `startAngle <= endAngle <= startAngle + 2*PI`, sweeping counterclockwise. A wrapping arc stores `endAngle + 2π` — 330°→30° is stored **330 → 390**, not 330 → 30.
- Sweep is a plain subtraction. `abs(end - start)` yields the 300° complement (a 5× overcount, no error raised); `mod 2π` collapses a full circle to zero. Both are wrong; both were tested against.
- Sweep > 2π is rejected, with a 1e-9 rad tolerance so a full turn built as `start + 2π` isn't rejected by float drift.
- `Math.atan2` returns `(-π, π]`, so a tool must normalize before storing.

### Model
- **Geometric primitive (`MarkupType`) and takeoff mode (`MarkupTakeoff`) are separate fields.** A polyline can be a curb measurement or a leader line. Never collapse them.
- The validity matrix is enforced in `validateMarkup` on **insert and update**: linear → polyline/polygon; area → polygon/rectangle; volume → polygon/rectangle + depth; count → **pin only**; annotation → any.
- Tools register in the tool registry and declare the geometry + takeoff mode they produce, so a tool cannot smuggle in an illegal pairing. Adding a mode is a registry entry, not a switch edit.
- Scale calibration is **per page**, not per file — mixed scales within one sheet set (site plan + detail blow-up) are normal. Calibration stores **both endpoints**, not just a distance.

### Persistence
- Project = a folder of real files on disk + a `.manifest/` sidecar directory. PDFs and spreadsheets stay valid, openable files in their own right.
- One JSON sidecar per source file, plus project-scoped `project.json`, `links.json`, `layers.json`, `legend.json`. Editing one markup rewrites exactly one sidecar.
- **Writes are atomic**: temp file + rename. `project.json` is written **last** — it is the index, and an index referencing a not-yet-written sidecar is the failure case.
- Files are identified by **stable UUID, never path**. `relativePath` is a last-known-location hint. A missing file or missing sidecar is **flagged explicitly, never silently self-healed and never auto-relinked by guessing** — silently substituting an empty manifest presented lost takeoff as valid state.
- Layers and the symbol legend are **project-scoped**, so rollups group by stable ID rather than fragile name-string matching.
- Single-writer assumption, last-write-wins, no conflict detection. Known and accepted.

### Security
- `contextIsolation` on, `nodeIntegration` off. The renderer has **no `fs` access**; `fs` is imported only in main.
- All main↔renderer traffic goes through the preload bridge. Never relax the settings to make something easier.
- `resolveWithinRoot` (`pathSafety.ts`) confines file access to the open project, realpath-resolving both sides so symlink escapes are rejected. It is deliberately electron-free so it stays testable — **an untested security boundary is not a security boundary.**

### PDF loading
- PDFs load via **`PDFDataRangeTransport` over chunked IPC** — only requested chunks cross, never a whole document (measured: 13% of bytes in 228 chunks for a 465 MB set).
- **Do not reintroduce a custom protocol scheme for this.** pdf.js hard-codes incremental loading to `http(s)` (`isHttp = /https?:/.test(url.protocol)`), so any custom scheme silently downloads the entire document — measured at +1.2 GB.
- Re-render on zoom; never CSS-scale the canvas to fake a zoom. Blurred linework makes measurement unreliable. (The one deliberate exception is the backing-store clamp below, and the old bitmap being stretched for the few frames a re-render is in flight.)
- **A page's viewport is built in exactly one place, `pdf/pageViewport.ts`.** `getViewport({ rotation })` REPLACES the page's `/Rotate` rather than adding to it, so the viewer's layout measurement and the canvas's render must go through the same helper or they drift — that drift rendered every rotated sheet a quarter-turn and overflowed the canvas over its neighbours, which read as pages randomly blank.
- **Canvas has a silent paint cliff at 2^28 device pixels** (measured in this Electron build; largest that painted 251.9 Mpx, smallest that failed 286.7 Mpx). Past it the canvas still accepts the size and still returns a context, but everything drawn reads back transparent and *nothing throws*. A 36×24 sheet crosses it inside the app's own zoom range. **Tiled rendering is what keeps this safe** (`pdf/tiles.ts`): a tile is `TILE_PX` CSS pixels square at *every* scale, so its backing store is `(TILE_PX × dpr)²` regardless of zoom and cannot approach the cliff — at `TILE_PX` 2048 and dpr 2 a tile is 16.8 Mpx, 6% of the cliff. Zoom is not a variable in that arithmetic. The tile layer therefore renders at full dpr with no clamp; `deviceScaleFor`/`MAX_CANVAS_PIXELS` now govern **only the preview bitmap**, which has one caller and passes `PREVIEW_MAX_PIXELS`.
- Render off-screen, then blit into the visible canvas. Assigning `canvas.width` clears it, so rendering straight into the visible canvas blanks the page for the whole render — the flash that made zooming unusable on a large sheet.
- Virtualize page rendering, but **do not `page.cleanup()` the instant a page leaves range** — hand it to the bounded LRU in `pdf/pageRetention.ts`. `cleanup()` clears `_intentStates`, i.e. the parsed operator list, decoded images and fonts, so cleaning up eagerly re-parsed pages that were about to be needed again: 23.4s of worker time over five zoom clicks. Virtualizing canvases alone still does not bound memory; the cap is what does.
- **`RETAINED_PAGES` must be at least two mounted windows**, i.e. `≥ 2 × (2 × OVERSCAN_PAGES + 1)`. A cap of exactly one window is *pathological, not merely small*: on A→B→A the window arriving at B evicts A's pages just before they are needed. Measured at cap 3 with a 3-page window: **0 hits, 9 misses**. At cap 6: 6 hits, 3 misses, and the return jump went 8261ms → 346ms. **If `OVERSCAN_PAGES` changes, `RETAINED_PAGES` changes with it** or the cache silently stops hitting.
- **Rendering is frame-paced.** `InternalRenderTask._scheduleNext` schedules every continuation through `requestAnimationFrame` (`pdf.mjs:16972`), so a render needing N continuations has a floor of N × ~16.7ms *regardless of machine speed*, and concurrent renders progress in lockstep — five renders of one page set finished within 2.5ms of each other after 8.2s. Two consequences: throwing CPU at raster does not help past that floor, and **a hidden or unfocused window throttles rAF to nothing, so any measurement taken against a window that is not on screen is invalid** (it will look like rendering hung).
- **Render cost tracks operator *type*, not operator count.** Page 138 of the Kincora set (an aerial photo collage with ~12 embedded photographs) has 11.4k operators and renders 5× slower than page 1's 45k vector operators. "Distant pages are slow" was really "exhibit sheets live at the end of a civil set." Never reason about render cost from op count alone.

---

## Commands

```
npm run dev         # hot-reload dev mode (opens the Electron window)
npm run build       # compile main/preload/renderer via electron-vite (outputs to out/)
npm run typecheck   # tsc --noEmit against tsconfig.node.json and tsconfig.web.json
npm test            # vitest
npm run dist        # build + package via electron-builder (outputs .exe to release/)
```

`npm run typecheck` is the fastest correctness check when editing TypeScript. Requires Node.js 24.x LTS; no `engines` field is set.

---

## Working style

**Verify by measurement, not inference.** Reading docs and reasoning about behavior has produced wrong reports here more than once — a claim that the file handler "streams and honours Range requests" was read off the Electron docs and was false. Instrument and measure.

**Running the app beats reading the code.** Every bug class that mattered was found by driving the running app, never by inspection: a flex `min-height: auto` killing scroll, a layout effect pinning scale to a fake 100%, a stale `translateX(-50%)` mis-centering every page, a takeoff row showing the wrong markup's quantity.

**Report friction honestly.** If the schema doesn't fit what an API actually gives you, say so rather than absorbing the mismatch in adapter code. A schema change is cheap; a migration over saved project files is not.

**Don't describe capabilities that don't exist** in comments or docs — no referencing scripts that were never committed, no doc comments describing workflows that aren't buildable yet.

**Report discrepancies rather than adjusting expected values to match.** If a test disagrees with the code, find out which is wrong.

**Summed render timings are NOT additive.** Renders run concurrently (preview plus one task per tile, across up to three mounted pages) and each timer measures *elapsed* wall time, so N concurrent renders count the same window N times — 41s of "raster" was recorded inside an 8.3s wall clock. **Wall clock per phase is the only honest aggregate**; per-kind totals are useful for ranking within a phase and meaningless when summed. Related: pdf.js's own `StatTimer` keys running timers by name only, so two concurrent renders of one page corrupt each other and emit `start: undefined` → `NaN`, which poisons `total`/`max` while leaving `median` plausible-looking. `Page Request` is safe (built once per operator list); `Rendering` is not.

**Prefer tests over probes for math; prefer the human for interaction feel.** Automated UI probes have cost significant time in probe-debugging loops. For numbers, memory, and persistence, measure. For whether a cursor or a drag feels right, hand it over.

**Mutation-test the money paths when changing quantity math.** Reverting the arc fix to `abs()` passed all 50 tests — because with the invariant enforced, both forms agree on every *valid* arc. Only mutation testing revealed the derivation change was untested.

---

## Git workflow

Commit and push to `origin/main` regularly — after each meaningful working change, not just at session end. Descriptive messages explaining *why*, not just what. Don't let uncommitted work pile up.

`*.pdf` is gitignored (real sheet sets run to hundreds of MB; GitHub hard-rejects >100 MB). **Careful with broad `.gitignore` patterns**: `/Test*/` silently swallowed the source `test/` directory, because Git on Windows matches case-insensitively.

---

## Architecture

Three TypeScript build targets, orchestrated by `electron.vite.config.ts` (not a plain `vite.config.ts` — the `electron-vite` CLI reads this instead):

- **`src/main/`** — Electron main process (Node context). Entry `src/main/index.ts`. Creates the `BrowserWindow` and loads either the Vite dev server (`process.env.ELECTRON_RENDERER_URL`) or built `out/renderer/index.html`. Owns all filesystem access, the manifest store, and PDF chunk reading.
- **`src/preload/`** — `src/preload/index.ts`, the *only* main↔renderer bridge. `contextBridge.exposeInMainWorld('api', ...)`, typed in `src/preload/index.d.ts`.
- **`src/renderer/`** — the React app. `src/renderer/src/main.tsx` mounts `App.tsx`. `@renderer` aliases `src/renderer/src`.
- **`src/shared/`** — manifest types, validation, and quantity derivation, imported by both sides.

TypeScript config is split to match, tied together by project references in the root `tsconfig.json` (which has no compiler options of its own):
- `tsconfig.node.json` — main + preload + `electron.vite.config.ts`
- `tsconfig.web.json` — everything under `src/renderer/src`

### UI layout

Browser-style **tabs**, not fixed panels. Tabs are per-document (a tab per open PDF), plus a Spreadsheet tab. Live Link is dockable — a normal tab, or a persistent sidebar alongside the active tab.

Each PDF tab owns its own pdf.js document and `IpcRangeTransport`. **Closing a tab must abort the transport and release the main-process file handle; switching tabs must not.** One 465 MB set measures ~800 MB renderer, so several open at once is real memory.

Tool choice and selection live in `PdfEditorPanel`, mounted per tab — both are per-tab and session-only.

Drag arbitration lives in one place (`tools/interaction.ts`): **right-drag marquees when a selection tool is active and pans when a drawing tool is active**, because a drawing tool owns the left button for placing points, and panning must not disturb points already placed.

### Packaging

`electron-builder.yml` targets Windows only — NSIS installer + portable exe, both x64, output to `release/`. It packages whatever `npm run build` puts in `out/`, which is why `dist` chains them.

### Ignored/generated paths

`out/`, `release/`, `node_modules/` are gitignored — never expect them present without running the corresponding script.

---

## Current state

Working: project open/create, PDF import, chunked render with **tiled** rendering and two-axis virtualization (which pages mount, which region of a mounted page rasterises), a bounded page-retention LRU, pan/zoom (cursor-anchored), page nav, tabs, tool palette, per-page calibration, linear polyline takeoff, selection + marquee multi-select, two mouse interaction modes, spreadsheet row linking, Live Link display. Survives a real app restart.

Known slow, measured, not yet fixed: the **first** visit to a photo-heavy exhibit sheet takes ~8.4s to go sharp (3.5s of ranged I/O plus image raster). Revisits are ~350ms. The suspected cause is that arriving at a page rasterises five things at once — previews for the destination and both overscan neighbours, plus tiles — each drawing the same expensive images. Temporary instrumentation for this lives behind `globalThis.__PDF_PERF__`; see `pdf/perf.ts` for the console API and how to strip it.

All four takeoff modes are proven **at the math layer** (area shoelace incl. non-convex and both windings, volume with mismatched depth units, count, arc).

Not built: area/count/volume/arc **tools** (math proven, no UI); the overlay renderer draws polyline only, so other geometry will hit-test but not render selection; delete anything; markup editing; undo/redo; layers and legend UI; real `.xlsx` read/write (the spreadsheet is one hard-coded row); sheet classification; box-select text extraction; the structures/runs domain model.
