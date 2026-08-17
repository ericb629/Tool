/**
 * The decision logic for "did an image on this page fail to decode".
 *
 * Kept free of every import so it can be tested in the Node test environment.
 * The pdf.js-facing half - finding the operator list and the image op codes -
 * lives in decodeAudit.ts. An untested safety indicator is not a safety
 * indicator, and this is the half that can actually be wrong.
 */

export type DecodeAudit =
  | { status: 'ok'; images: number }
  | { status: 'failed'; images: number; failed: number }
  /** Could not determine. Never treat this as ok. */
  | { status: 'unknown'; reason: string }
  /** The operator list is not finished yet; ask again after the render. */
  | { status: 'pending' }

export interface AuditableOperatorList {
  fnArray: number[]
  argsArray: unknown[]
  /** pdf.js sets this on the final chunk. */
  lastChunk?: boolean
}

/** The subset of pdf.js's PDFObjects registry this needs. */
export interface AuditableObjects {
  has(objId: string): boolean
  get(objId: string): unknown
}

/**
 * Walks an operator list and reports images whose object resolved to `null`.
 *
 * `null` is precisely the decode-failure signal: the worker calls
 * `_sendImgData(objId, null)` on failure, which RESOLVES the entry rather than
 * leaving it pending. So:
 *
 *   has() === false            -> not resolved yet (render still in flight)
 *   has() === true, get() null -> decode FAILED
 *   has() === true, get() data -> fine
 */
export function auditOperatorList(
  opList: AuditableOperatorList | undefined,
  objs: AuditableObjects,
  imageOps: ReadonlySet<number>
): DecodeAudit {
  if (imageOps.size === 0) {
    return { status: 'unknown', reason: 'no image paint operators are known to this build' }
  }
  if (!opList || opList.fnArray.length === 0) return { status: 'pending' }
  // An incomplete list would report images that have simply not arrived yet.
  if (!opList.lastChunk) return { status: 'pending' }

  let images = 0
  let failed = 0
  for (let i = 0; i < opList.fnArray.length; i++) {
    if (!imageOps.has(opList.fnArray[i])) continue
    const args = opList.argsArray[i]
    const objId = Array.isArray(args) ? args[0] : undefined
    // Mask ops can carry an inline object rather than an id. Only ids are
    // resolvable through objs, so only those can be shown to have failed.
    if (typeof objId !== 'string') continue
    images++
    // has() first: get() throws for an unresolved entry.
    if (objs.has(objId) && objs.get(objId) === null) failed++
  }

  if (failed > 0) return { status: 'failed', images, failed }
  return { status: 'ok', images }
}
