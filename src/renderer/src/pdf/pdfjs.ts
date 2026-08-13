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

export { pdfjsLib }
export const PDF_WORKER_URL = pdfWorkerUrl
