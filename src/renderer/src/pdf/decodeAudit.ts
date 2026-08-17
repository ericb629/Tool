import type { PDFPageProxy } from 'pdfjs-dist'
import { pdfjsLib } from './pdfjs'
import {
  auditOperatorList,
  type AuditableOperatorList,
  type DecodeAudit
} from './decodeAuditCore'

export type { DecodeAudit }

/**
 * Detects images that pdf.js failed to decode, so a sheet that silently did not
 * render can say so instead of looking merely empty.
 *
 * WHY DETECTION AND NOT A CATCH
 *
 * pdf.js does not throw on a decode failure. The worker warns and calls
 * `_sendImgData(objId, null)` (pdf.worker.mjs:34569), which RESOLVES the entry
 * in `page.objs` to `null`. The canvas then hits
 * `if (!imgData) { warn(...); return }` (pdf.mjs:12798) and skips the draw. The
 * render task resolves successfully, so there is no exception to catch anywhere
 * and no error to surface - the page just comes out missing its content.
 *
 * That is the failure this app cannot tolerate: pages 4 and 11-15 of the
 * Kincora set are single scanned JBIG2 images, so losing the image loses the
 * entire drawing while the frame and labels still draw. The sheet still accepts
 * calibration and takeoff and would measure against nothing - a wrong number
 * that looks plausible, which is worse here than a crash.
 *
 * THE PRIVATE-API WART, STATED RATHER THAN HIDDEN
 *
 * Reaching the operator list needs `page._intentStates`, a private field.
 * `page.getOperatorList()` is public but requests a DIFFERENT rendering intent
 * and would force a second full parse - measured at up to 4s per page - so it
 * is not usable here.
 *
 * The risk is that a pdf.js upgrade changes that shape and detection silently
 * stops working, which for a safety indicator means failing OPEN. So an
 * unreadable internal returns `unknown` rather than `ok`, and the UI shows that
 * distinctly. If "unknown" starts appearing on every page after an upgrade,
 * that is the intended signal, not noise to suppress.
 */

/**
 * Ops that paint an image referenced by object id. Built by NAME so an op
 * renumbering between pdf.js versions cannot silently point this at the wrong
 * operators; names that no longer exist are simply skipped.
 */
const IMAGE_OP_NAMES = [
  'paintImageXObject',
  'paintImageXObjectRepeat',
  'paintJpegXObject',
  'paintImageMaskXObject',
  'paintImageMaskXObjectRepeat'
] as const

const IMAGE_OPS: ReadonlySet<number> = new Set(
  IMAGE_OP_NAMES.map((name) => (pdfjsLib.OPS as Record<string, number | undefined>)[name]).filter(
    (code): code is number => typeof code === 'number'
  )
)

interface InternalIntentState {
  operatorList?: AuditableOperatorList
}

export function auditDecodedImages(page: PDFPageProxy): DecodeAudit {
  const states = (page as unknown as { _intentStates?: Map<string, InternalIntentState> })._intentStates
  if (!states || typeof states.values !== 'function') {
    return { status: 'unknown', reason: 'pdf.js internals changed: page._intentStates is not readable' }
  }

  let opList: AuditableOperatorList | undefined
  for (const state of states.values()) {
    if (state.operatorList?.fnArray?.length) {
      opList = state.operatorList
      break
    }
  }

  return auditOperatorList(opList, page.objs, IMAGE_OPS)
}
