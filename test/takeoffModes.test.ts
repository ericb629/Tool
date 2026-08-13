import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { deriveQuantity } from '../src/shared/manifest/quantity'
import { validateMarkup } from '../src/shared/manifest/validation'
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

// Coverage for the takeoff modes that no UI has ever produced. Only linear
// polyline has been exercised against real pointer input, so everything here
// is checked against hand-computed geometry rather than against whatever the
// implementation happens to return.

// ---------- fixtures ----------

/** `userSpaceUnits` of PDF user-space equals `realDistance` of `unit`. */
function calibration(userSpaceUnits: number, realDistance: number, unit: LinearUnit): PageCalibration {
  return {
    pageNumber: 1,
    pointA: { x: 0, y: 0 },
    pointB: { x: userSpaceUnits, y: 0 },
    realDistance,
    unit
  }
}

const page = (cal?: PageCalibration): PdfPageRecord => ({ pageNumber: 1, calibration: cal })
/** 1 user-space unit == 1 foot. */
const FT = page(calibration(1, 1, 'ft'))

function markup(type: MarkupType, geometry: MarkupGeometry, takeoff: MarkupTakeoff): MarkupObject {
  return {
    id: 'm',
    pageNumber: 1,
    layerId: 'l',
    type,
    takeoff,
    geometry,
    style: { color: '#000' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

const area = (unit: AreaUnit): MarkupTakeoff => ({ mode: 'area', unit })
const volume = (unit: VolumeUnit, depth: number, depthUnit: LinearUnit): MarkupTakeoff => ({
  mode: 'volume',
  unit,
  depth,
  depthUnit
})
const linear = (unit: LinearUnit): MarkupTakeoff => ({ mode: 'linear', unit })

function ok(result: ReturnType<typeof deriveQuantity>): { value: number; unit: string } {
  assert.equal(result.status, 'ok', `expected 'ok', got '${result.status}'`)
  const o = result as { status: 'ok'; value: number; unit: string }
  return { value: o.value, unit: o.unit }
}

function close(actual: number, expected: number, tol = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${actual} to be within ${tol} of ${expected}`)
}

// Shapes reused across modes.
const RECT_3X4: MarkupGeometry = { kind: 'rect', corner1: { x: 0, y: 0 }, corner2: { x: 3, y: 4 } }

/** L-shape: 4x4 square with a 2x2 bite out of the top-right. Area = 12. */
const L_SHAPE_CCW: MarkupGeometry = {
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
const L_SHAPE_CW: MarkupGeometry = {
  kind: 'polygon',
  points: [...(L_SHAPE_CCW as { points: { x: number; y: number }[] }).points].reverse()
}

// ---------- 1. AREA ----------

describe('area mode', () => {
  it('rectangle of known area: 3 x 4 = 12 sf', () => {
    const r = ok(deriveQuantity(markup('rectangle', RECT_3X4, area('sf')), FT))
    close(r.value, 12)
    assert.equal(r.unit, 'sf')
  })

  it('rectangle area is independent of which corners were clicked first', () => {
    const flipped: MarkupGeometry = { kind: 'rect', corner1: { x: 3, y: 4 }, corner2: { x: 0, y: 0 } }
    const mixed: MarkupGeometry = { kind: 'rect', corner1: { x: 0, y: 4 }, corner2: { x: 3, y: 0 } }
    close(ok(deriveQuantity(markup('rectangle', flipped, area('sf')), FT)).value, 12)
    close(ok(deriveQuantity(markup('rectangle', mixed, area('sf')), FT)).value, 12)
  })

  it('shoelace on a simple polygon: 10 x 10 = 100 sf', () => {
    const square: MarkupGeometry = {
      kind: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 }
      ]
    }
    close(ok(deriveQuantity(markup('polygon', square, area('sf')), FT)).value, 100)
  })

  it('shoelace on a NON-CONVEX (L-shaped) polygon: 8 + 4 = 12 sf', () => {
    close(ok(deriveQuantity(markup('polygon', L_SHAPE_CCW, area('sf')), FT)).value, 12)
  })

  // Shoelace is signed; winding order must not leak into the answer.
  it('winding order does not change the area, and never makes it negative', () => {
    const ccw = ok(deriveQuantity(markup('polygon', L_SHAPE_CCW, area('sf')), FT))
    const cw = ok(deriveQuantity(markup('polygon', L_SHAPE_CW, area('sf')), FT))
    close(ccw.value, 12)
    close(cw.value, 12)
    close(ccw.value, cw.value)
    assert.ok(cw.value > 0, 'clockwise winding must not yield a negative area')
  })

  it('scales with the square of the calibration, at several scales', () => {
    // 10x10 user units under 1u=1ft, 1u=10ft, 1u=0.5ft.
    const square: MarkupGeometry = {
      kind: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 }
      ]
    }
    const at = (units: number, real: number): number =>
      ok(deriveQuantity(markup('polygon', square, area('sf')), page(calibration(units, real, 'ft')))).value
    close(at(1, 1), 100)
    close(at(1, 10), 10_000, 1e-6)
    close(at(1, 0.5), 25)
    close(at(2, 1), 25) // 2 units = 1 ft  =>  10 units = 5 ft  =>  25 sf
  })

  it('converts sf to sy at several scales (9 sf == 1 sy)', () => {
    const sf = ok(deriveQuantity(markup('rectangle', RECT_3X4, area('sf')), FT))
    const sy = ok(deriveQuantity(markup('rectangle', RECT_3X4, area('sy')), FT))
    close(sf.value, 12)
    close(sy.value, 12 / 9)
    assert.equal(sy.unit, 'sy')

    // Same physical area reached through a coarser calibration.
    const coarse = page(calibration(1, 3, 'ft')) // 1u = 3ft => 3x4 units = 9x12 ft = 108 sf
    close(ok(deriveQuantity(markup('rectangle', RECT_3X4, area('sf')), coarse)).value, 108, 1e-6)
    close(ok(deriveQuantity(markup('rectangle', RECT_3X4, area('sy')), coarse)).value, 12, 1e-6)
  })

  it('is invariant to the unit the calibration was entered in', () => {
    const viaFeet = ok(deriveQuantity(markup('rectangle', RECT_3X4, area('sf')), page(calibration(1, 1, 'ft'))))
    const viaInches = ok(deriveQuantity(markup('rectangle', RECT_3X4, area('sf')), page(calibration(1, 12, 'in'))))
    const viaMeters = ok(deriveQuantity(markup('rectangle', RECT_3X4, area('sf')), page(calibration(1, 0.3048, 'm'))))
    close(viaInches.value, viaFeet.value, 1e-9)
    close(viaMeters.value, viaFeet.value, 1e-9)
  })
})

// ---------- 2. VOLUME ----------

describe('volume mode', () => {
  it('known area x depth in matching units: 12 sf x 3 ft = 36 cf', () => {
    const r = ok(deriveQuantity(markup('rectangle', RECT_3X4, volume('cf', 3, 'ft')), FT))
    close(r.value, 36)
    assert.equal(r.unit, 'cf')
  })

  // The case a UI will hit constantly: page calibrated in feet, depth typed
  // in inches.
  it('depth unit may differ from the calibration unit: 12 sf x 6 in = 6 cf', () => {
    close(ok(deriveQuantity(markup('rectangle', RECT_3X4, volume('cf', 6, 'in')), FT)).value, 6)
  })

  it('depth in millimetres against a foot calibration', () => {
    // 12 sf x 304.8 mm (= 1 ft) = 12 cf
    close(ok(deriveQuantity(markup('rectangle', RECT_3X4, volume('cf', 304.8, 'mm')), FT)).value, 12, 1e-9)
  })

  it('converts to cubic yards (27 cf == 1 cy)', () => {
    // 9 x 3 = 27 sf footprint, 1 ft deep = 27 cf = 1 cy
    const rect: MarkupGeometry = { kind: 'rect', corner1: { x: 0, y: 0 }, corner2: { x: 9, y: 3 } }
    const cf = ok(deriveQuantity(markup('rectangle', rect, volume('cf', 1, 'ft')), FT))
    const cy = ok(deriveQuantity(markup('rectangle', rect, volume('cy', 1, 'ft')), FT))
    close(cf.value, 27)
    close(cy.value, 1)
    assert.equal(cy.unit, 'cy')
  })

  it('a 6 in subbase over 100 sy is 150 cy - a realistic paving check', () => {
    // 900 sf = 100 sy footprint, 0.5 ft deep => 450 cf => 16.667 cy
    const rect: MarkupGeometry = { kind: 'rect', corner1: { x: 0, y: 0 }, corner2: { x: 30, y: 30 } }
    close(ok(deriveQuantity(markup('rectangle', rect, volume('cf', 6, 'in')), FT)).value, 450)
    close(ok(deriveQuantity(markup('rectangle', rect, volume('cy', 6, 'in')), FT)).value, 450 / 27, 1e-9)
  })

  it('works over a non-convex footprint: 12 sf x 2 ft = 24 cf', () => {
    close(ok(deriveQuantity(markup('polygon', L_SHAPE_CCW, volume('cf', 2, 'ft')), FT)).value, 24)
  })

  it('scales the footprint by the square of the calibration, depth independently', () => {
    // 1u = 2ft  =>  3x4 units = 6x8 ft = 48 sf; depth 3 ft => 144 cf
    const coarse = page(calibration(1, 2, 'ft'))
    close(ok(deriveQuantity(markup('rectangle', RECT_3X4, volume('cf', 3, 'ft')), coarse)).value, 144, 1e-6)
  })

  it('a zero depth yields zero volume, not an error', () => {
    const r = ok(deriveQuantity(markup('rectangle', RECT_3X4, volume('cf', 0, 'ft')), FT))
    close(r.value, 0)
  })
})

// ---------- 3. COUNT ----------

describe('count mode', () => {
  const pin = markup('pin', { kind: 'point', point: { x: 5, y: 5 } }, { mode: 'count', symbolId: 's1' })

  it('a pin derives to exactly 1', () => {
    const r = ok(deriveQuantity(pin, FT))
    assert.equal(r.value, 1)
  })

  it('carries the dimensionless unit "ea", never a length or area unit', () => {
    const r = ok(deriveQuantity(pin, FT))
    assert.equal(r.unit, 'ea')
    assert.ok(!['ft', 'in', 'm', 'cm', 'mm', 'sf', 'sy', 'm2', 'acre', 'cf', 'cy', 'm3'].includes(r.unit))
  })

  it('counts without needing a calibration, and ignores one if present', () => {
    // A count is dimensionless, so scale is irrelevant - this is deliberate,
    // not an oversight. See the uncalibrated suite below.
    close(ok(deriveQuantity(pin, page(undefined))).value, 1)
    close(ok(deriveQuantity(pin, page(calibration(1, 500, 'm')))).value, 1)
  })

  it('does not consult the point coordinates', () => {
    const far = markup('pin', { kind: 'point', point: { x: 1e6, y: -1e6 } }, { mode: 'count', symbolId: 's1' })
    close(ok(deriveQuantity(far, FT)).value, 1)
  })
})

// ---------- 4. ARC ----------

describe('arc mode', () => {
  const arc = (startAngle: number, endAngle: number, radius = 10): MarkupGeometry => ({
    kind: 'arc',
    center: { x: 0, y: 0 },
    radius,
    startAngle,
    endAngle
  })

  it('quarter circle length = r * pi/2', () => {
    close(ok(deriveQuantity(markup('arc', arc(0, Math.PI / 2), linear('ft')), FT)).value, 10 * (Math.PI / 2))
  })

  it('half circle length = r * pi', () => {
    close(ok(deriveQuantity(markup('arc', arc(0, Math.PI), linear('ft')), FT)).value, 10 * Math.PI)
  })

  it('full circle length = 2 * pi * r', () => {
    close(ok(deriveQuantity(markup('arc', arc(0, 2 * Math.PI), linear('ft')), FT)).value, 2 * Math.PI * 10)
  })

  it('quarter sector area = 0.25 * pi * r^2', () => {
    close(ok(deriveQuantity(markup('arc', arc(0, Math.PI / 2), area('sf')), FT)).value, 0.25 * Math.PI * 100)
  })

  it('full circle area degrades to pi * r^2', () => {
    close(ok(deriveQuantity(markup('arc', arc(0, 2 * Math.PI), area('sf')), FT)).value, Math.PI * 100)
  })

  it('arc length scales with the calibration', () => {
    const coarse = page(calibration(1, 5, 'ft')) // 1u = 5ft
    close(
      ok(deriveQuantity(markup('arc', arc(0, Math.PI), linear('ft')), coarse)).value,
      10 * Math.PI * 5,
      1e-6
    )
  })

  it('an arc spanning negative to positive angles measures the sweep between them', () => {
    // -30deg to +30deg is a 60deg sweep. No wraparound in the numeric values,
    // so subtraction is unambiguous here.
    close(
      ok(deriveQuantity(markup('arc', arc(-Math.PI / 6, Math.PI / 6), linear('ft')), FT)).value,
      10 * (Math.PI / 3)
    )
  })

  // ---- KNOWN DEFECT ----
  // An arc that crosses 0 / 2*PI with angles normalized to [0, 2*PI) - which
  // is what any tool built on Math.atan2 + normalization will produce.
  // 330deg -> 30deg is a 60deg sweep, but the implementation computes
  // abs(end - start) = 300deg and reports an arc five times too long.
  // it.fails asserts this is CURRENTLY broken: it will start failing (loudly)
  // the moment the sweep calculation is fixed, which is the point.
  it.fails('KNOWN DEFECT: arc crossing the 0/360 boundary measures the wrong sweep', () => {
    const start = (11 * Math.PI) / 6 // 330 deg
    const end = Math.PI / 6 //  30 deg
    const correctSweep = Math.PI / 3 // 60 deg
    close(ok(deriveQuantity(markup('arc', arc(start, end), linear('ft')), FT)).value, 10 * correctSweep, 1e-9)
  })

  it('documents what the 0/360-crossing arc returns TODAY, so the error is measurable', () => {
    const start = (11 * Math.PI) / 6
    const end = Math.PI / 6
    const actual = ok(deriveQuantity(markup('arc', arc(start, end), linear('ft')), FT)).value
    const correct = 10 * (Math.PI / 3)
    close(actual, 10 * ((5 * Math.PI) / 3), 1e-9) // the complement, not the arc
    assert.ok(actual > correct * 4, `overstates a 60deg arc by ${(actual / correct).toFixed(1)}x`)
  })

  it.fails('KNOWN DEFECT: the same wraparound overstates sector AREA', () => {
    const start = (11 * Math.PI) / 6
    const end = Math.PI / 6
    close(
      ok(deriveQuantity(markup('arc', arc(start, end), area('sf')), FT)).value,
      0.5 * 100 * (Math.PI / 3),
      1e-9
    )
  })
})

// ---------- 5. UNCALIBRATED, EVERY MODE ----------

describe('uncalibrated page, every mode', () => {
  const none = page(undefined)

  it('linear returns uncalibrated', () => {
    const g: MarkupGeometry = { kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 3, y: 4 }] }
    assert.equal(deriveQuantity(markup('polyline', g, linear('ft')), none).status, 'uncalibrated')
  })

  it('area returns uncalibrated for rect, polygon and arc alike', () => {
    assert.equal(deriveQuantity(markup('rectangle', RECT_3X4, area('sf')), none).status, 'uncalibrated')
    assert.equal(deriveQuantity(markup('polygon', L_SHAPE_CCW, area('sf')), none).status, 'uncalibrated')
    const a: MarkupGeometry = { kind: 'arc', center: { x: 0, y: 0 }, radius: 10, startAngle: 0, endAngle: Math.PI }
    assert.equal(deriveQuantity(markup('arc', a, area('sf')), none).status, 'uncalibrated')
  })

  it('volume returns uncalibrated', () => {
    assert.equal(deriveQuantity(markup('rectangle', RECT_3X4, volume('cf', 3, 'ft')), none).status, 'uncalibrated')
  })

  it('no uncalibrated result carries a value field to be mistaken for a quantity', () => {
    for (const m of [
      markup('rectangle', RECT_3X4, area('sf')),
      markup('rectangle', RECT_3X4, volume('cf', 3, 'ft')),
      markup('polygon', L_SHAPE_CCW, area('sy'))
    ]) {
      const r = deriveQuantity(m, none)
      assert.equal(r.status, 'uncalibrated')
      assert.ok(!('value' in r), 'an uncalibrated result must not carry a number')
    }
  })

  // The two modes that deliberately do NOT report 'uncalibrated'. Asserting
  // otherwise would be asserting a bug.
  it('count is NOT uncalibrated - a count is dimensionless', () => {
    const pin = markup('pin', { kind: 'point', point: { x: 1, y: 1 } }, { mode: 'count', symbolId: 's' })
    const r = deriveQuantity(pin, none)
    assert.equal(r.status, 'ok')
  })

  it('annotation is NOT uncalibrated - it is not-measurable in any case', () => {
    const t = markup('text', { kind: 'point', point: { x: 1, y: 1 } }, { mode: 'annotation' })
    assert.equal(deriveQuantity(t, none).status, 'not-measurable')
    assert.equal(deriveQuantity(t, FT).status, 'not-measurable')
  })
})

// ---------- 6. VALIDITY MATRIX, PER MODE ----------
// The exhaustive 30-combination matrix lives in validation.test.ts. These
// assert the pairings each of these modes depends on, so a change there
// cannot silently let a mode receive geometry its derivation cannot handle.

describe('validity matrix per takeoff mode', () => {
  const POINT: MarkupGeometry = { kind: 'point', point: { x: 0, y: 0 } }
  const POLYLINE: MarkupGeometry = { kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }
  const ARC: MarkupGeometry = { kind: 'arc', center: { x: 0, y: 0 }, radius: 1, startAngle: 0, endAngle: 1 }

  const valid = (type: MarkupType, geometry: MarkupGeometry, takeoff: MarkupTakeoff): boolean =>
    validateMarkup({ type, takeoff, geometry }).valid

  it('area accepts rectangle, polygon and arc; rejects polyline and pin', () => {
    assert.ok(valid('rectangle', RECT_3X4, area('sf')))
    assert.ok(valid('polygon', L_SHAPE_CCW, area('sf')))
    assert.ok(valid('arc', ARC, area('sf')))
    assert.ok(!valid('polyline', POLYLINE, area('sf')))
    assert.ok(!valid('pin', POINT, area('sf')))
  })

  it('volume accepts the same shapes as area', () => {
    const v = volume('cf', 1, 'ft')
    assert.ok(valid('rectangle', RECT_3X4, v))
    assert.ok(valid('polygon', L_SHAPE_CCW, v))
    assert.ok(valid('arc', ARC, v))
    assert.ok(!valid('polyline', POLYLINE, v))
    assert.ok(!valid('pin', POINT, v))
  })

  it('count accepts only a pin', () => {
    const c: MarkupTakeoff = { mode: 'count', symbolId: 's' }
    assert.ok(valid('pin', POINT, c))
    assert.ok(!valid('rectangle', RECT_3X4, c))
    assert.ok(!valid('polygon', L_SHAPE_CCW, c))
    assert.ok(!valid('polyline', POLYLINE, c))
    assert.ok(!valid('arc', ARC, c))
    assert.ok(!valid('text', POINT, c))
  })

  it('linear accepts polyline, polygon and arc; rejects rectangle and pin', () => {
    assert.ok(valid('polyline', POLYLINE, linear('ft')))
    assert.ok(valid('polygon', L_SHAPE_CCW, linear('ft')))
    assert.ok(valid('arc', ARC, linear('ft')))
    assert.ok(!valid('rectangle', RECT_3X4, linear('ft')))
    assert.ok(!valid('pin', POINT, linear('ft')))
  })

  it('every type/mode pairing the matrix allows has a derivation that returns a number', () => {
    // Guards the gap that would matter most: validation permitting something
    // deriveQuantity then throws on.
    const cases: Array<[MarkupType, MarkupGeometry, MarkupTakeoff]> = [
      ['polyline', POLYLINE, linear('ft')],
      ['polygon', L_SHAPE_CCW, linear('ft')],
      ['arc', ARC, linear('ft')],
      ['rectangle', RECT_3X4, area('sf')],
      ['polygon', L_SHAPE_CCW, area('sf')],
      ['arc', ARC, area('sf')],
      ['rectangle', RECT_3X4, volume('cf', 1, 'ft')],
      ['polygon', L_SHAPE_CCW, volume('cf', 1, 'ft')],
      ['arc', ARC, volume('cf', 1, 'ft')],
      ['pin', POINT, { mode: 'count', symbolId: 's' }]
    ]
    for (const [type, geometry, takeoff] of cases) {
      assert.ok(valid(type, geometry, takeoff), `${type}/${takeoff.mode} should be valid`)
      const r = deriveQuantity(markup(type, geometry, takeoff), FT)
      assert.equal(r.status, 'ok', `${type}/${takeoff.mode} derived '${r.status}'`)
      if (r.status === 'ok') {
        assert.ok(Number.isFinite(r.value), `${type}/${takeoff.mode} produced ${r.value}`)
      }
    }
  })
})
