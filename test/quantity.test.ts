import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { deriveQuantity } from '../src/shared/manifest/quantity'
import type {
  AreaUnit,
  LinearUnit,
  MarkupGeometry,
  MarkupObject,
  MarkupTakeoff,
  MarkupType,
  PageCalibration,
  PdfPageRecord,
  VolumeUnit
} from '../src/shared/manifest/types'

// ---------- helpers ----------

/**
 * Builds a calibration where `userSpaceUnits` of PDF user-space equals
 * `realDistance` of `unit`. pointA/pointB are laid out horizontally so the
 * Euclidean distance between them is exactly `userSpaceUnits`.
 */
function calibration(userSpaceUnits: number, realDistance: number, unit: LinearUnit): PageCalibration {
  return {
    pageNumber: 1,
    pointA: { x: 0, y: 0 },
    pointB: { x: userSpaceUnits, y: 0 },
    realDistance,
    unit
  }
}

function page(cal?: PageCalibration): PdfPageRecord {
  return { pageNumber: 1, calibration: cal }
}

function markup(type: MarkupType, geometry: MarkupGeometry, takeoff: MarkupTakeoff): MarkupObject {
  return {
    id: 'test-markup',
    pageNumber: 1,
    layerId: 'test-layer',
    type,
    takeoff,
    geometry,
    style: { color: '#000' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

function linear(unit: LinearUnit): MarkupTakeoff {
  return { mode: 'linear', unit }
}

function area(unit: AreaUnit): MarkupTakeoff {
  return { mode: 'area', unit }
}

function volume(unit: VolumeUnit, depth: number, depthUnit: LinearUnit): MarkupTakeoff {
  return { mode: 'volume', unit, depth, depthUnit }
}

/** Asserts an 'ok' result and returns it, so tests never silently pass on a non-ok status. */
function expectOk(result: ReturnType<typeof deriveQuantity>): { value: number; unit: string } {
  assert.equal(result.status, 'ok', `expected status 'ok', got '${result.status}'`)
  // narrowed by the assert above
  const ok = result as { status: 'ok'; value: number; unit: string }
  return { value: ok.value, unit: ok.unit }
}

function assertClose(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`
  )
}

// ---------- uncalibrated: the financially dangerous case ----------

describe('uncalibrated pages', () => {
  it('returns status uncalibrated, never a number, for a linear markup', () => {
    const m = markup('polyline', { kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 300, y: 400 }] }, linear('ft'))
    const result = deriveQuantity(m, page(undefined))
    assert.equal(result.status, 'uncalibrated')
    assert.ok(!('value' in result), 'uncalibrated result must not carry a value field')
  })

  it('returns status uncalibrated for area and volume markups', () => {
    const rect: MarkupGeometry = { kind: 'rect', corner1: { x: 0, y: 0 }, corner2: { x: 10, y: 10 } }
    assert.equal(deriveQuantity(markup('rectangle', rect, area('sf')), page(undefined)).status, 'uncalibrated')
    assert.equal(
      deriveQuantity(markup('rectangle', rect, volume('cf', 2, 'ft')), page(undefined)).status,
      'uncalibrated'
    )
  })

  it('still counts pins on an uncalibrated page (a count needs no scale)', () => {
    const m = markup('pin', { kind: 'point', point: { x: 5, y: 5 } }, { mode: 'count', symbolId: 'sym-1' })
    const result = expectOk(deriveQuantity(m, page(undefined)))
    assert.equal(result.value, 1)
    assert.equal(result.unit, 'ea')
  })

  it('reports annotation markups as not-measurable, not as zero', () => {
    const m = markup('text', { kind: 'point', point: { x: 1, y: 1 } }, { mode: 'annotation' })
    const result = deriveQuantity(m, page(calibration(100, 100, 'ft')))
    assert.equal(result.status, 'not-measurable')
    assert.ok(!('value' in result), 'not-measurable result must not carry a value field')
  })
})

// ---------- linear: known answers at multiple scales ----------

describe('linear quantities', () => {
  // 3-4-5 triangle: a polyline from (0,0) to (300,400) is exactly 500 units.
  const line345: MarkupGeometry = { kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 300, y: 400 }] }

  it('1 unit = 1 ft: a 500-unit line is 500 ft', () => {
    const result = expectOk(deriveQuantity(markup('polyline', line345, linear('ft')), page(calibration(100, 100, 'ft'))))
    assertClose(result.value, 500)
    assert.equal(result.unit, 'ft')
  })

  it('scales linearly: at 1 unit = 0.5 ft the same line is 250 ft', () => {
    const result = expectOk(deriveQuantity(markup('polyline', line345, linear('ft')), page(calibration(100, 50, 'ft'))))
    assertClose(result.value, 250)
  })

  it('scales linearly: at 1 unit = 2 ft the same line is 1000 ft', () => {
    const result = expectOk(deriveQuantity(markup('polyline', line345, linear('ft')), page(calibration(100, 200, 'ft'))))
    assertClose(result.value, 1000)
  })

  it('an architectural scale (1 unit = 4 ft) gives 2000 ft', () => {
    const result = expectOk(deriveQuantity(markup('polyline', line345, linear('ft')), page(calibration(25, 100, 'ft'))))
    assertClose(result.value, 2000)
  })

  it('sums every segment of a multi-segment polyline', () => {
    // 3 segments of 100 units each = 300 units = 300 ft at 1 unit = 1 ft.
    const zigzag: MarkupGeometry = {
      kind: 'polyline',
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 200, y: 100 }
      ]
    }
    const result = expectOk(deriveQuantity(markup('polyline', zigzag, linear('ft')), page(calibration(100, 100, 'ft'))))
    assertClose(result.value, 300)
  })

  it('treats a polygon in linear mode as a closed perimeter', () => {
    // 10x20 rectangle as a polygon: perimeter 60 units.
    const rectPolygon: MarkupGeometry = {
      kind: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 20 },
        { x: 0, y: 20 }
      ]
    }
    const result = expectOk(
      deriveQuantity(markup('polygon', rectPolygon, linear('ft')), page(calibration(1, 1, 'ft')))
    )
    assertClose(result.value, 60)
  })

  it('derives arc length as r * deltaTheta (semicircle of r=10)', () => {
    const semicircle: MarkupGeometry = {
      kind: 'arc',
      center: { x: 0, y: 0 },
      radius: 10,
      startAngle: 0,
      endAngle: Math.PI
    }
    const result = expectOk(deriveQuantity(markup('arc', semicircle, linear('ft')), page(calibration(1, 1, 'ft'))))
    assertClose(result.value, 10 * Math.PI)
  })
})

// ---------- unit round-trips ----------

describe('linear unit conversion', () => {
  const oneHundredUnits: MarkupGeometry = { kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }

  // Calibrated so 100 units = 100 ft, i.e. 1 unit = 1 ft. The same physical
  // length must come back correctly in every linear unit.
  const ftPage = page(calibration(100, 100, 'ft'))

  const expectations: Array<[LinearUnit, number]> = [
    ['ft', 100],
    ['in', 1200],
    ['m', 30.48],
    ['cm', 3048],
    ['mm', 30480]
  ]

  for (const [unit, expected] of expectations) {
    it(`100 ft expressed in ${unit} is ${expected}`, () => {
      const result = expectOk(deriveQuantity(markup('polyline', oneHundredUnits, linear(unit)), ftPage))
      assertClose(result.value, expected, 1e-6)
      assert.equal(result.unit, unit)
    })
  }

  it('round-trips through a metric calibration back to feet', () => {
    // Calibrate in meters, measure in feet: 100 units = 30.48 m = 100 ft.
    const metricPage = page(calibration(100, 30.48, 'm'))
    const result = expectOk(deriveQuantity(markup('polyline', oneHundredUnits, linear('ft')), metricPage))
    assertClose(result.value, 100, 1e-6)
  })

  it('is invariant to which unit the calibration was entered in', () => {
    const geometry: MarkupGeometry = { kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 250, y: 0 }] }
    // 100 units = 12 in = 1 ft = 0.3048 m, all the same physical distance.
    const viaInches = expectOk(deriveQuantity(markup('polyline', geometry, linear('ft')), page(calibration(100, 12, 'in'))))
    const viaFeet = expectOk(deriveQuantity(markup('polyline', geometry, linear('ft')), page(calibration(100, 1, 'ft'))))
    const viaMeters = expectOk(
      deriveQuantity(markup('polyline', geometry, linear('ft')), page(calibration(100, 0.3048, 'm')))
    )
    assertClose(viaInches.value, viaFeet.value, 1e-9)
    assertClose(viaMeters.value, viaFeet.value, 1e-9)
    assertClose(viaFeet.value, 2.5, 1e-9)
  })
})

// ---------- area, including shoelace on a non-convex polygon ----------

describe('area quantities', () => {
  const oneUnitPerFoot = page(calibration(1, 1, 'ft'))

  it('computes rectangle area from opposite corners', () => {
    const rect: MarkupGeometry = { kind: 'rect', corner1: { x: 0, y: 0 }, corner2: { x: 3, y: 4 } }
    const result = expectOk(deriveQuantity(markup('rectangle', rect, area('sf')), oneUnitPerFoot))
    assertClose(result.value, 12)
    assert.equal(result.unit, 'sf')
  })

  it('computes rectangle area regardless of corner ordering', () => {
    // corner2 below-left of corner1 - area must stay positive.
    const rect: MarkupGeometry = { kind: 'rect', corner1: { x: 3, y: 4 }, corner2: { x: 0, y: 0 } }
    const result = expectOk(deriveQuantity(markup('rectangle', rect, area('sf')), oneUnitPerFoot))
    assertClose(result.value, 12)
  })

  it('computes a convex polygon area via shoelace', () => {
    // Simple 10x10 square.
    const square: MarkupGeometry = {
      kind: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 }
      ]
    }
    const result = expectOk(deriveQuantity(markup('polygon', square, area('sf')), oneUnitPerFoot))
    assertClose(result.value, 100)
  })

  it('computes a NON-CONVEX (L-shaped) polygon area via shoelace', () => {
    // L-shape: a 4x4 square with a 2x2 bite taken out of the top-right.
    // Decomposes as (4 wide x 2 tall) + (2 wide x 2 tall) = 8 + 4 = 12.
    const lShape: MarkupGeometry = {
      kind: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 2 },
        { x: 2, y: 2 },
        { x: 2, y: 4 },
        { x: 0, y: 4 }
      ]
    }
    const result = expectOk(deriveQuantity(markup('polygon', lShape, area('sf')), oneUnitPerFoot))
    assertClose(result.value, 12)
  })

  it('gives the same non-convex area for reversed winding order', () => {
    const cw: MarkupGeometry = {
      kind: 'polygon',
      points: [
        { x: 0, y: 4 },
        { x: 2, y: 4 },
        { x: 2, y: 2 },
        { x: 4, y: 2 },
        { x: 4, y: 0 },
        { x: 0, y: 0 }
      ]
    }
    const result = expectOk(deriveQuantity(markup('polygon', cw, area('sf')), oneUnitPerFoot))
    assertClose(result.value, 12)
  })

  it('scales area by the square of the linear scale', () => {
    // 1 unit = 10 ft, so a 10x10-unit square is 100x100 ft = 10,000 sf.
    const square: MarkupGeometry = {
      kind: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 }
      ]
    }
    const result = expectOk(deriveQuantity(markup('polygon', square, area('sf')), page(calibration(1, 10, 'ft'))))
    assertClose(result.value, 10_000, 1e-6)
  })

  it('converts area units: 9 sf is 1 sy', () => {
    const rect: MarkupGeometry = { kind: 'rect', corner1: { x: 0, y: 0 }, corner2: { x: 3, y: 3 } }
    const sf = expectOk(deriveQuantity(markup('rectangle', rect, area('sf')), oneUnitPerFoot))
    const sy = expectOk(deriveQuantity(markup('rectangle', rect, area('sy')), oneUnitPerFoot))
    assertClose(sf.value, 9, 1e-9)
    assertClose(sy.value, 1, 1e-9)
  })

  it('converts area units: 43560 sf is 1 acre', () => {
    const rect: MarkupGeometry = { kind: 'rect', corner1: { x: 0, y: 0 }, corner2: { x: 43560, y: 1 } }
    const acres = expectOk(deriveQuantity(markup('rectangle', rect, area('acre')), oneUnitPerFoot))
    assertClose(acres.value, 1, 1e-6)
  })

  it('derives a full-circle arc area as pi * r^2 with no special-casing', () => {
    const circle: MarkupGeometry = {
      kind: 'arc',
      center: { x: 0, y: 0 },
      radius: 10,
      startAngle: 0,
      endAngle: 2 * Math.PI
    }
    const result = expectOk(deriveQuantity(markup('arc', circle, area('sf')), oneUnitPerFoot))
    assertClose(result.value, Math.PI * 100, 1e-9)
  })
})

// ---------- volume ----------

describe('volume quantities', () => {
  const oneUnitPerFoot = page(calibration(1, 1, 'ft'))

  it('computes area x depth in cubic feet', () => {
    // 3x4 = 12 sf footprint, 3 ft deep = 36 cf.
    const rect: MarkupGeometry = { kind: 'rect', corner1: { x: 0, y: 0 }, corner2: { x: 3, y: 4 } }
    const result = expectOk(deriveQuantity(markup('rectangle', rect, volume('cf', 3, 'ft')), oneUnitPerFoot))
    assertClose(result.value, 36, 1e-9)
    assert.equal(result.unit, 'cf')
  })

  it('converts to cubic yards: 27 cf is 1 cy', () => {
    const rect: MarkupGeometry = { kind: 'rect', corner1: { x: 0, y: 0 }, corner2: { x: 9, y: 3 } }
    const result = expectOk(deriveQuantity(markup('rectangle', rect, volume('cy', 1, 'ft')), oneUnitPerFoot))
    assertClose(result.value, 1, 1e-9)
  })

  it('honours a depth given in a different unit than the calibration', () => {
    // 12 sf footprint, depth 6 in = 0.5 ft => 6 cf.
    const rect: MarkupGeometry = { kind: 'rect', corner1: { x: 0, y: 0 }, corner2: { x: 3, y: 4 } }
    const result = expectOk(deriveQuantity(markup('rectangle', rect, volume('cf', 6, 'in')), oneUnitPerFoot))
    assertClose(result.value, 6, 1e-9)
  })

  it('computes volume over a non-convex footprint', () => {
    // The same L-shape (12 sf) at 2 ft deep = 24 cf.
    const lShape: MarkupGeometry = {
      kind: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 2 },
        { x: 2, y: 2 },
        { x: 2, y: 4 },
        { x: 0, y: 4 }
      ]
    }
    const result = expectOk(deriveQuantity(markup('polygon', lShape, volume('cf', 2, 'ft')), oneUnitPerFoot))
    assertClose(result.value, 24, 1e-9)
  })
})

// ---------- invariants that protect against stale/derived-value bugs ----------

describe('derivation invariants', () => {
  it('is a pure function of geometry + calibration (same inputs, same answer)', () => {
    const m = markup('polyline', { kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 300, y: 400 }] }, linear('ft'))
    const p = page(calibration(100, 100, 'ft'))
    const first = expectOk(deriveQuantity(m, p))
    const second = expectOk(deriveQuantity(m, p))
    assert.deepEqual(first, second)
  })

  it('reflects edited geometry immediately - no cached quantity survives an edit', () => {
    const p = page(calibration(100, 100, 'ft'))
    const before = markup('polyline', { kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }, linear('ft'))
    const beforeResult = expectOk(deriveQuantity(before, p))
    assertClose(beforeResult.value, 100)

    // Same markup id, moved endpoint: the derived answer must change.
    const after: MarkupObject = {
      ...before,
      geometry: { kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 200, y: 0 }] }
    }
    const afterResult = expectOk(deriveQuantity(after, p))
    assertClose(afterResult.value, 200)
  })

  it('reflects an edited calibration immediately', () => {
    const m = markup('polyline', { kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }, linear('ft'))
    assertClose(expectOk(deriveQuantity(m, page(calibration(100, 100, 'ft')))).value, 100)
    assertClose(expectOk(deriveQuantity(m, page(calibration(100, 500, 'ft')))).value, 500)
  })

  it('never returns NaN for a degenerate single-point polyline (returns 0 length, not NaN)', () => {
    const degenerate = markup('polyline', { kind: 'polyline', points: [{ x: 5, y: 5 }] }, linear('ft'))
    const result = expectOk(deriveQuantity(degenerate, page(calibration(100, 100, 'ft'))))
    assert.ok(Number.isFinite(result.value), `expected a finite value, got ${result.value}`)
    assertClose(result.value, 0)
  })
})
