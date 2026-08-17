import * as pdfjsLib from 'pdfjs-dist'
// `?url` makes Vite emit the worker as its own asset and hand back a URL,
// in both dev (an http://localhost URL from the dev server) and production
// (a relative asset path next to index.html). Importing the worker as a
// module instead would inline 2MB+ into the renderer bundle and break the
// separate-thread guarantee pdf.js relies on. This is the line that most
// commonly works in `dev` and then fails in a packaged build, so it is
// deliberately kept in one place with no environment branching.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

/**
 * Base URLs for pdf.js's RUNTIME ASSETS.
 *
 * These are not optional extras. pdf.js v6 decodes JBIG2 and JPEG2000 in
 * WebAssembly and needs `wasmUrl` to find the codec; without it, decoding
 * fails and pdf.js **warns rather than throws**, silently omitting the image.
 * That is how pages 4 and 11-15 of the Kincora set rendered as near-empty
 * sheets: each is a single scanned JBIG2 image, so losing it loses the whole
 * drawing while the page frame and labels still draw. A sheet that silently
 * did not render still accepts calibration and takeoff, so this is the
 * wrong-number-that-looks-plausible failure class, not a cosmetic one.
 *
 * `cMapUrl` (CID fonts) and `standardFontDataUrl` (the 14 standard fonts) fail
 * the same quiet way and are wired here for the same reason.
 *
 * The files are copied out of node_modules by scripts/copy-pdfjs-assets.mjs
 * into the renderer's publicDir, so they stay version-locked to the installed
 * pdfjs-dist rather than going stale as checked-in binaries.
 *
 * RESOLUTION: built from `document.baseURI` so the same code works in dev
 * (http://localhost/...) and packaged (file:///.../out/renderer/...). pdf.js
 * requires a trailing slash on all three - getFactoryUrlProp throws without
 * one - so the trailing slashes below are load-bearing.
 *
 * See CLAUDE.md: every pdf.js runtime asset must be reachable at a real URL in
 * BOTH dev and packaged, and dev passing tells you nothing about packaged.
 */
const assetBase = new URL('pdfjs/', document.baseURI)

export const PDF_WASM_URL = new URL('wasm/', assetBase).href
export const PDF_CMAP_URL = new URL('cmaps/', assetBase).href
export const PDF_STANDARD_FONT_URL = new URL('standard_fonts/', assetBase).href

export { pdfjsLib }
export const PDF_WORKER_URL = pdfWorkerUrl
