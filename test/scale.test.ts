import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { parseScaleString, SCALE_PRESETS } from '../src/renderer/src/pdf/scale'

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

describe('parseScaleString', () => {
  it('parses a plain engineering scale', () => {
    const result = parseScaleString('1" = 50\'')
    assert.ok(result)
    assert.equal(result!.realDistance, 50)
    assert.equal(result!.unit, 'ft')
    // 1 printed inch is 72 PDF user-space points at userUnit 1.
    assert.equal(distance(result!.pointA, result!.pointB), 72)
  })

  it('parses an architectural fractional scale with feet-inches on the real side', () => {
    const result = parseScaleString('1/4" = 1\'-0"')
    assert.ok(result)
    assert.equal(result!.realDistance, 1)
    assert.equal(result!.unit, 'ft')
    assert.equal(distance(result!.pointA, result!.pointB), 0.25 * 72)
  })

  it('parses a mixed whole-and-fraction inch value', () => {
    const result = parseScaleString('1-1/2" = 1\'-0"')
    assert.ok(result)
    assert.equal(distance(result!.pointA, result!.pointB), 1.5 * 72)
  })

  it('parses word units with no punctuation', () => {
    const result = parseScaleString('1 in = 50 ft')
    assert.ok(result)
    assert.equal(result!.realDistance, 50)
    assert.equal(result!.unit, 'ft')
  })

  it('parses metric units', () => {
    const result = parseScaleString('2cm = 1m')
    assert.ok(result)
    assert.equal(result!.realDistance, 1)
    assert.equal(result!.unit, 'm')
    const paperInches = 2 / 2.54
    assert.ok(Math.abs(distance(result!.pointA, result!.pointB) - paperInches * 72) < 1e-9)
  })

  it('parses a bare engineering ratio as 1 inch = N inches', () => {
    const result = parseScaleString('1:600')
    assert.ok(result)
    assert.equal(result!.unit, 'ft')
    assert.equal(result!.realDistance, 50) // 600 in / 12 = 50 ft
    assert.equal(distance(result!.pointA, result!.pointB), 72)
  })

  it('rejects garbage input rather than guessing', () => {
    assert.equal(parseScaleString('not a scale'), null)
    assert.equal(parseScaleString(''), null)
    assert.equal(parseScaleString('1 = 50'), null) // no units
    assert.equal(parseScaleString('0" = 50\''), null) // zero distance
    assert.equal(parseScaleString('1" = 0\''), null)
  })

  it('every preset parses to a positive span and positive real distance', () => {
    for (const preset of SCALE_PRESETS) {
      const result = parseScaleString(preset.value)
      assert.ok(result, `preset "${preset.value}" failed to parse`)
      assert.ok(distance(result!.pointA, result!.pointB) > 0)
      assert.ok(result!.realDistance > 0)
    }
  })
})
