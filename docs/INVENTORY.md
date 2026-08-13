# Source inventory

Every source file, what it does, and how the layers connect. Updated after
Part A (audit fixes) and Part B (PDF import + display).

**Totals:** 27 source files + 9 test files, ~4,065 lines of TS/TSX.
**Tests:** 135 passing (was zero before this work).

## main process (`src/main/`, Node context)

| File | What it does |
|---|---|
| `index.ts` | App entry. Registers the `app-file:` scheme as privileged *before* `app.whenReady()` (Electron ignores it after), creates the single `BrowserWindow` (`contextIsolation: true`, `nodeIntegration: false`), registers the protocol handler + IPC against one shared `ManifestStore`. |
| `protocol.ts` | Serves project files as `app-file://<fileId>/`. Resolves the fileId through the manifest, enforces containment via `pathSafety`, then returns `net.fetch(file://…)` — which **streams and honours Range requests**, so multi-hundred-MB sheet sets are never buffered into memory or sent over IPC. |
| `pathSafety.ts` | `resolveWithinRoot()` — the security boundary for the above. `realpath`s both the file and the project root before comparing, so `..` traversal *and* links escaping the project are rejected. Kept free of any `electron` import purely so it can be unit-tested. |
| `ipc/manifest.ts` | The IPC surface: `project:open/create/addFile/importPdf`, `manifest:updateMarkup/updateCalibration/ensurePages/setSheets/updateLink/save/getState`. Thin wrappers over `ManifestStore`. PDF bytes deliberately do **not** travel here. |
| `manifest/store.ts` | `ManifestStore` — one open project in memory, sole mediator of `.manifest/` reads and writes. Tracks per-collection dirty flags so a save rewrites only what changed. Notable: `importPdf` (copies into `drawings/`, uniquifying the filename), `ensurePages` (backfills `pages[]` once the real page count is known), `resolveFilePath` (for the protocol handler). Still no delete method of any kind. |
| `manifest/io.ts` | fs helpers. `writeJson` writes to a temp file then `rename`s over the target, so a file can never be observed half-written. `readJsonIfExists` suppresses only ENOENT and rethrows everything else. |
| `manifest/migrations.ts` | Schema-version migration runner. Table is still **empty** — schema has never bumped past v1. Scaffolding, never yet exercised. |
| `manifest/prune.ts` | `pruneOrphanLinks` — drops a `LinkRecord` unless its source PDF, source markup, *and* target spreadsheet all resolve. Runs on every open and before every save. Still unreachable in normal use because nothing can delete anything yet; its comment says so. |

## preload (`src/preload/`)

| File | What it does |
|---|---|
| `index.ts` | Builds the `api` object and exposes it via `contextBridge`. Every method is a one-line `ipcRenderer.invoke` passthrough — no logic, no fs. |
| `index.d.ts` | Declares `window.api: Api` for the renderer's type view. |

## renderer (`src/renderer/`, React)

| File | What it does |
|---|---|
| `index.html` | Vite entry. CSP allows `app-file:` and `worker-src 'self' blob:` (the latter is what lets the pdf.js module worker start). |
| `src/main.tsx` | Mounts `<App />`. |
| `src/App.tsx` | Root. Owns project state and the lifted `pdfFileId` / `spreadsheetFileId` selection. Handles open/create/import, and routes every mutation through IPC then refreshes state. Calls `deriveQuantity` — the one place in the running app that does. |
| `src/fileStatus.ts` | `describeFileStatus()` — turns the two independent presence flags into one message via an exhaustive four-way match, so the both-missing case can't be masked by one condition. |
| `src/pdf/pdfjs.ts` | Single place the pdf.js worker URL is configured (`?url` import). Verified to load in **both** dev and a production build. |
| `src/pdf/coordinates.ts` | **The coordinate boundary.** `canvasToPdfPoint` / `pdfPointToCanvas` / `pointerEventToPdfPoint`. Exports a branded `ViewportPoint` type so pixel coordinates are structurally incompatible with `PdfPoint` and the compiler rejects persisting them. |
| `src/components/PdfViewer.tsx` | Continuous-scroll viewer: loads the document by `app-file://` URL, measures every page once at scale 1 for layout, virtualizes rendering to the visible window ± 1 page, page prev/next + "Page X of Y", zoom in/out + fit-width + fit-page, debounced re-measure on resize. Loading / error / empty states. |
| `src/components/PdfPageCanvas.tsx` | Renders one page and owns that render's lifetime — unmounting cancels the `RenderTask` and drops the canvas. Bitmap sized at `devicePixelRatio`; zoom re-renders rather than CSS-scaling (blurred linework would make measurement unreliable). Separate overlay canvas so markup repaints don't redraw the page. |
| `src/components/PdfEditorPanel.tsx` | Wraps `PdfViewer` with calibration and linear-measurement tools. All in-progress points are `PdfPoint`s — converted at capture, converted back only inside `renderOverlay`. |
| `src/components/SpreadsheetPanel.tsx` | One-row stand-in showing the derived quantity and a link action. Reads/writes **no** actual spreadsheet file — labelled as such in the file. |
| `src/components/LiveLinkPanel.tsx` | Lists `LinkRecord`s with their source file's status notice. |
| `src/components/LabeledPanel.tsx` | Header + body shell for each panel. |
| `src/styles.css` | Layout and visuals. Note `.labeled-panel__body { min-height: 0 }` — without it a flex child grows to its content and the viewer's `overflow:auto` never engages. |

## shared (`src/shared/manifest/`, used by main *and* renderer)

| File | What it does |
|---|---|
| `types.ts` | All manifest shapes. `PdfPoint` is PDF user-space (bottom-left origin, Y-up). `ResolvedFileEntry` carries `sourceStatus` and `manifestStatus` as **independent** fields. `MarkupObject` stores no derived quantity; `PageCalibration` stores both endpoints but not the derived distance. |
| `quantity.ts` | `deriveQuantity()` → `QuantityResult` discriminated union (`ok` / `uncalibrated` / `not-measurable`). Never returns a bare number for an uncalibrated page. |
| `validation.ts` | `validateMarkup()` — type↔takeoff validity matrix and type↔geometry agreement. |
| `index.ts` | Barrel re-export. |

## tests (`test/`, vitest)

| File | Covers |
|---|---|
| `quantity.test.ts` | Known-answer geometry at multiple scales, all linear/area/volume unit round-trips, shoelace incl. a **non-convex** polygon, arc length/sector area, the uncalibrated case, and no-stale-derivation invariants. |
| `coordinates.test.ts` | Real pdf.js `PageViewport` round-trips at 6 zoom levels and 4 rotations, zoom-invariance of derived quantities, and non-zero-origin MediaBox. |
| `validation.test.ts` | The full type × takeoff matrix (30 combinations), count-restricted-to-pin, every mismatched type/geometry pairing. |
| `store.test.ts` | Save/reopen round-trip, all four source/manifest presence combinations, save ordering, no `.tmp-` residue, and that no derived quantity reaches disk. |
| `pathSafety.test.ts` | The protocol containment boundary, including link-escape via Windows junctions. |
| `importPdf.test.ts` | Import lands in `drawings/`, relative (not absolute) paths, no filename clobbering, `ensurePages` backfill/idempotence/calibration-preservation. |
| `prune.test.ts` | Orphan link pruning on both the source and target sides. |
| `fileStatus.test.ts` | All four status messages are distinct and the both-missing case names both problems. |
| `seed-demo-project.test.ts` | Not a test — a `SEED_DEMO=1`-gated utility for seeding a project for manual GUI checks. Skipped by default. |

## How it connects

```
renderer                          preload            main
────────                          ───────            ────
App.tsx ──window.api.project.* ──▶ contextBridge ──▶ ipc/manifest.ts ──▶ ManifestStore ──▶ .manifest/*.json
        ◀──────── ProjectState ─────────────────────────────────────────┘

PdfViewer ──▶ pdfjs.getDocument("app-file://<fileId>/…")
                    │
                    ▼  (NOT via IPC — streamed)
              protocol.ts ──▶ pathSafety.resolveWithinRoot ──▶ net.fetch(file://…) ──▶ drawings/*.pdf

pointerdown ──▶ pdf/coordinates.pointerEventToPdfPoint ──▶ PdfPoint ──▶ state ──▶ IPC ──▶ disk
   (pixels stop here)                                                      │
                                                                            ▼
                                          deriveQuantity(markup, page) ──▶ QuantityResult ──▶ UI
```

## Still not built

No delete of anything (markup, file, or link). No layers or legend UI. No real
spreadsheet reading — `SpreadsheetSheetRecord` holds only a sheet name. Only
the `linear` takeoff mode is wired to UI; area/count/volume exist in the schema
and are unit-tested but have no tools. No undo/redo. No multi-window or
concurrent-write handling (single-writer, last-save-wins).
