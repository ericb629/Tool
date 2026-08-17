import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import {
  auditOperatorList,
  type AuditableObjects,
  type AuditableOperatorList
} from '../src/renderer/src/pdf/decodeAuditCore'

/**
 * The failure this guards against is silent: pdf.js resolves an undecodable
 * image to `null` and the canvas skips the draw, so the render SUCCEEDS and the
 * sheet comes out missing its content while still accepting calibration and
 * takeoff. Getting `null` vs unresolved vs present wrong here would either hide
 * a missing drawing or cry wolf on every page.
 */

const PAINT_IMAGE = 85
const PAINT_MASK = 90
const OTHER = 12
const IMAGE_OPS = new Set([PAINT_IMAGE, PAINT_MASK])

function objects(entries: Record<string, unknown>): AuditableObjects {
  return {
    has: (id) => Object.prototype.hasOwnProperty.call(entries, id),
    get: (id) => {
      if (!Object.prototype.hasOwnProperty.call(entries, id)) throw new Error(`unresolved ${id}`)
      return entries[id]
    }
  }
}

function opList(
  ops: Array<[number, unknown]>,
  lastChunk = true
): AuditableOperatorList {
  return { fnArray: ops.map((o) => o[0]), argsArray: ops.map((o) => o[1]), lastChunk }
}

describe('auditOperatorList', () => {
  it('reports a decoded image as ok', () => {
    const result = auditOperatorList(
      opList([[OTHER, []], [PAINT_IMAGE, ['img_p0_1']]]),
      objects({ img_p0_1: { width: 10 } }),
      IMAGE_OPS
    )
    assert.deepEqual(result, { status: 'ok', images: 1 })
  })

  it('reports an image resolved to null as FAILED - the decode-failure signal', () => {
    // pdf.js sends `_sendImgData(objId, null)` when decoding fails, so the
    // entry is resolved, present, and null. That is the whole detection.
    const result = auditOperatorList(
      opList([[PAINT_IMAGE, ['img_p3_1']]]),
      objects({ img_p3_1: null }),
      IMAGE_OPS
    )
    assert.deepEqual(result, { status: 'failed', images: 1, failed: 1 })
  })

  it('counts failures alongside successes on the same page', () => {
    const result = auditOperatorList(
      opList([
        [PAINT_IMAGE, ['good']],
        [PAINT_IMAGE, ['bad']],
        [PAINT_MASK, ['alsobad']]
      ]),
      objects({ good: { width: 1 }, bad: null, alsobad: null }),
      IMAGE_OPS
    )
    assert.deepEqual(result, { status: 'failed', images: 3, failed: 2 })
  })

  it('treats an unresolved image as pending, not failed', () => {
    // Mid-render the object simply has not arrived. Reporting that as a failure
    // would put a "content missing" banner on every page while it renders.
    const result = auditOperatorList(
      opList([[PAINT_IMAGE, ['img_p0_1']]]),
      objects({}),
      IMAGE_OPS
    )
    assert.deepEqual(result, { status: 'ok', images: 1 }, 'unresolved is not counted as failed')
  })

  it('is pending until the operator list is complete', () => {
    // An incomplete list would report images that have not been emitted yet.
    const result = auditOperatorList(
      opList([[PAINT_IMAGE, ['img_p0_1']]], false),
      objects({ img_p0_1: null }),
      IMAGE_OPS
    )
    assert.deepEqual(result, { status: 'pending' })
  })

  it('is pending when there is no operator list at all', () => {
    assert.deepEqual(auditOperatorList(undefined, objects({}), IMAGE_OPS), { status: 'pending' })
    assert.deepEqual(auditOperatorList(opList([]), objects({}), IMAGE_OPS), { status: 'pending' })
  })

  it('ignores image ops whose argument is an inline object rather than an id', () => {
    // Mask ops can carry the image inline; there is no objs entry to check and
    // no failure to report.
    const result = auditOperatorList(
      opList([[PAINT_MASK, [{ data: new Uint8Array(4) }]]]),
      objects({}),
      IMAGE_OPS
    )
    assert.deepEqual(result, { status: 'ok', images: 0 })
  })

  it('ignores non-image operators entirely', () => {
    const result = auditOperatorList(
      opList([[OTHER, ['img_p0_1']], [OTHER, null]]),
      objects({ img_p0_1: null }),
      IMAGE_OPS
    )
    assert.deepEqual(result, { status: 'ok', images: 0 }, 'a null objs entry on a non-image op is irrelevant')
  })

  it('returns unknown - never ok - when no image ops are known to the build', () => {
    // If a pdf.js upgrade renames the paint operators, detection must fail
    // CLOSED and say so, not report a clean bill of health.
    const result = auditOperatorList(
      opList([[PAINT_IMAGE, ['img_p3_1']]]),
      objects({ img_p3_1: null }),
      new Set()
    )
    assert.equal(result.status, 'unknown')
  })
})
