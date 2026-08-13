import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { validateMarkup } from '../src/shared/manifest/validation'
import type { MarkupGeometry, MarkupTakeoff, MarkupType } from '../src/shared/manifest/types'

const GEOMETRY_BY_TYPE: Record<MarkupType, MarkupGeometry> = {
  pin: { kind: 'point', point: { x: 0, y: 0 } },
  text: { kind: 'point', point: { x: 0, y: 0 } },
  rectangle: { kind: 'rect', corner1: { x: 0, y: 0 }, corner2: { x: 1, y: 1 } },
  polygon: { kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] },
  polyline: { kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
  arc: { kind: 'arc', center: { x: 0, y: 0 }, radius: 1, startAngle: 0, endAngle: Math.PI }
}

const TAKEOFF_BY_MODE: Record<MarkupTakeoff['mode'], MarkupTakeoff> = {
  linear: { mode: 'linear', unit: 'ft' },
  area: { mode: 'area', unit: 'sf' },
  volume: { mode: 'volume', unit: 'cf', depth: 1, depthUnit: 'ft' },
  count: { mode: 'count', symbolId: 'symbol-1' },
  annotation: { mode: 'annotation' }
}

// The matrix the implementation is supposed to enforce, restated here
// independently so a change to validation.ts's table fails a test rather
// than silently redefining what is legal.
const EXPECTED_VALID: Record<MarkupType, MarkupTakeoff['mode'][]> = {
  pin: ['count', 'annotation'],
  rectangle: ['area', 'volume', 'annotation'],
  polygon: ['linear', 'area', 'volume', 'annotation'],
  polyline: ['linear', 'annotation'],
  arc: ['linear', 'area', 'volume', 'annotation'],
  text: ['annotation']
}

const ALL_TYPES = Object.keys(EXPECTED_VALID) as MarkupType[]
const ALL_MODES = Object.keys(TAKEOFF_BY_MODE) as MarkupTakeoff['mode'][]

describe('type/takeoff validity matrix', () => {
  for (const type of ALL_TYPES) {
    for (const mode of ALL_MODES) {
      const shouldBeValid = EXPECTED_VALID[type].includes(mode)
      it(`${type} + ${mode} is ${shouldBeValid ? 'accepted' : 'rejected'}`, () => {
        const result = validateMarkup({
          type,
          takeoff: TAKEOFF_BY_MODE[mode],
          geometry: GEOMETRY_BY_TYPE[type]
        })
        assert.equal(
          result.valid,
          shouldBeValid,
          result.valid ? `${type}+${mode} was wrongly accepted` : `${type}+${mode} was wrongly rejected`
        )
      })
    }
  }

  it('restricts count mode to pins and nothing else', () => {
    const countable = ALL_TYPES.filter(
      (type) => validateMarkup({ type, takeoff: TAKEOFF_BY_MODE.count, geometry: GEOMETRY_BY_TYPE[type] }).valid
    )
    assert.deepEqual(countable, ['pin'])
  })

  it('explains why a combination was rejected', () => {
    const result = validateMarkup({
      type: 'polyline',
      takeoff: TAKEOFF_BY_MODE.area,
      geometry: GEOMETRY_BY_TYPE.polyline
    })
    assert.equal(result.valid, false)
    if (!result.valid) {
      assert.match(result.reason, /polyline/)
      assert.match(result.reason, /area/)
    }
  })
})

describe('type/geometry agreement', () => {
  it('accepts every type carrying its own expected geometry', () => {
    for (const type of ALL_TYPES) {
      const result = validateMarkup({
        type,
        takeoff: TAKEOFF_BY_MODE.annotation,
        geometry: GEOMETRY_BY_TYPE[type]
      })
      assert.equal(result.valid, true, `${type} rejected its own geometry`)
    }
  })

  it('rejects a pin secretly carrying polygon points', () => {
    const result = validateMarkup({
      type: 'pin',
      takeoff: TAKEOFF_BY_MODE.count,
      geometry: GEOMETRY_BY_TYPE.polygon
    })
    assert.equal(result.valid, false)
  })

  it('rejects a polyline carrying rect geometry', () => {
    const result = validateMarkup({
      type: 'polyline',
      takeoff: TAKEOFF_BY_MODE.linear,
      geometry: GEOMETRY_BY_TYPE.rectangle
    })
    assert.equal(result.valid, false)
  })

  it('rejects every mismatched type/geometry pairing', () => {
    for (const type of ALL_TYPES) {
      for (const other of ALL_TYPES) {
        // pin and text legitimately share 'point' geometry.
        if (GEOMETRY_BY_TYPE[type].kind === GEOMETRY_BY_TYPE[other].kind) continue
        const result = validateMarkup({
          type,
          takeoff: TAKEOFF_BY_MODE.annotation,
          geometry: GEOMETRY_BY_TYPE[other]
        })
        assert.equal(result.valid, false, `${type} wrongly accepted ${GEOMETRY_BY_TYPE[other].kind} geometry`)
      }
    }
  })
})
