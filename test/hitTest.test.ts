import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import {
  boundsOf,
  distanceToSegment,
  geometryIntersectsRect,
  hitTestGeometry,
  rectFromCorners
} from '../src/renderer/src/pdf/hitTest'
import type { MarkupGeometry } from '../src/shared/manifest/types'

// All of this is PDF user-space. The screen-pixel tolerance is converted by
// the caller as pixels/scale, so these tests pass a user-space tolerance
// directly and separately assert the zoom-invariance that conversion buys.

const LINE: MarkupGeometry = { kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }
const SQUARE: MarkupGeometry = {
  kind: 'polygon',
  points: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 }
  ]
}

describe('distanceToSegment', () => {
  it('measures perpendicular distance within the segment', () => {
    assert.equal(distanceToSegment({ x: 50, y: 5 }, { x: 0, y: 0 }, { x: 100, y: 0 }), 5)
  })

  it('clamps to the endpoints rather than the infinite line', () => {
    // Off the end: distance is to the endpoint, not 5.
    assert.equal(distanceToSegment({ x: 150, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }), 50)
  })

  it('handles a degenerate zero-length segment', () => {
    assert.equal(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 }), 5)
  })
})

describe('hit testing a polyline', () => {
  it('hits within tolerance and misses beyond it', () => {
    assert.equal(hitTestGeometry(LINE, { x: 50, y: 2 }, 3), true)
    assert.equal(hitTestGeometry(LINE, { x: 50, y: 4 }, 3), false)
  })

  it('does not hit past the end of the line', () => {
    assert.equal(hitTestGeometry(LINE, { x: 130, y: 0 }, 3), false)
  })

  // The property the zoom-scaled tolerance exists for: at 17% a screen pixel
  // is ~6 user units, at 400% it is ~1.5 - the same click must work at both.
  it('a screen-constant tolerance keeps a hairline clickable at any zoom', () => {
    const screenPixels = 6
    const nearMiss = { x: 50, y: 20 } // 20 user units off the line
    // Zoomed out (scale 0.17): 6px is ~35 user units, so this is a hit.
    assert.equal(hitTestGeometry(LINE, nearMiss, screenPixels / 0.17), true)
    // Zoomed in (scale 4): 6px is 1.5 user units, so the same point misses.
    assert.equal(hitTestGeometry(LINE, nearMiss, screenPixels / 4), false)
    // And a point genuinely on the line hits at both.
    assert.equal(hitTestGeometry(LINE, { x: 50, y: 0 }, screenPixels / 0.17), true)
    assert.equal(hitTestGeometry(LINE, { x: 50, y: 0 }, screenPixels / 4), true)
  })

  it('hits a middle vertex of a multi-segment polyline', () => {
    const zigzag: MarkupGeometry = {
      kind: 'polyline',
      points: [
        { x: 0, y: 0 },
        { x: 50, y: 50 },
        { x: 100, y: 0 }
      ]
    }
    assert.equal(hitTestGeometry(zigzag, { x: 50, y: 50 }, 2), true)
    assert.equal(hitTestGeometry(zigzag, { x: 50, y: 0 }, 2), false)
  })
})

describe('hit testing areas', () => {
  it('selects a polygon from inside it, not only on its edge', () => {
    assert.equal(hitTestGeometry(SQUARE, { x: 5, y: 5 }, 0.001), true)
    assert.equal(hitTestGeometry(SQUARE, { x: 10, y: 5 }, 0.001), true) // on the edge
    assert.equal(hitTestGeometry(SQUARE, { x: 20, y: 5 }, 0.001), false)
  })

  it('selects a rect from inside and within tolerance outside', () => {
    const rect: MarkupGeometry = { kind: 'rect', corner1: { x: 0, y: 0 }, corner2: { x: 10, y: 10 } }
    assert.equal(hitTestGeometry(rect, { x: 5, y: 5 }, 1), true)
    assert.equal(hitTestGeometry(rect, { x: 10.5, y: 5 }, 1), true)
    assert.equal(hitTestGeometry(rect, { x: 12, y: 5 }, 1), false)
  })

  it('handles a rect whose corners were dragged in any direction', () => {
    const flipped: MarkupGeometry = { kind: 'rect', corner1: { x: 10, y: 10 }, corner2: { x: 0, y: 0 } }
    assert.equal(hitTestGeometry(flipped, { x: 5, y: 5 }, 0.001), true)
  })

  it('hits a pin within tolerance', () => {
    const pin: MarkupGeometry = { kind: 'point', point: { x: 5, y: 5 } }
    assert.equal(hitTestGeometry(pin, { x: 5, y: 8 }, 4), true)
    assert.equal(hitTestGeometry(pin, { x: 5, y: 12 }, 4), false)
  })
})

describe('hit testing an arc', () => {
  const quarter: MarkupGeometry = {
    kind: 'arc',
    center: { x: 0, y: 0 },
    radius: 100,
    startAngle: 0,
    endAngle: Math.PI / 2
  }

  it('hits on the ring within the swept angle', () => {
    assert.equal(hitTestGeometry(quarter, { x: 100, y: 0 }, 2), true)
    assert.equal(hitTestGeometry(quarter, { x: 0, y: 100 }, 2), true)
  })

  it('misses off the ring even at the right angle', () => {
    assert.equal(hitTestGeometry(quarter, { x: 50, y: 0 }, 2), false)
  })

  it('misses on the ring but outside the swept angle', () => {
    assert.equal(hitTestGeometry(quarter, { x: -100, y: 0 }, 2), false)
  })

  it('a full circle hits at any angle', () => {
    const circle: MarkupGeometry = { ...quarter, endAngle: 2 * Math.PI } as MarkupGeometry
    assert.equal(hitTestGeometry(circle, { x: -100, y: 0 }, 2), true)
  })
})

describe('marquee intersection', () => {
  const marquee = rectFromCorners({ x: 40, y: -10 }, { x: 60, y: 10 })

  it('normalises corners captured in any drag direction', () => {
    const forward = rectFromCorners({ x: 0, y: 0 }, { x: 10, y: 10 })
    const backward = rectFromCorners({ x: 10, y: 10 }, { x: 0, y: 0 })
    assert.deepEqual(forward, backward)
  })

  it('selects a line the marquee crosses without containing', () => {
    assert.equal(geometryIntersectsRect(LINE, marquee), true)
  })

  it('does not select a line the marquee misses', () => {
    assert.equal(geometryIntersectsRect(LINE, rectFromCorners({ x: 40, y: 50 }, { x: 60, y: 70 })), false)
  })

  it('selects a fully contained markup', () => {
    assert.equal(geometryIntersectsRect(SQUARE, rectFromCorners({ x: -5, y: -5 }, { x: 20, y: 20 })), true)
  })

  it('selects an area markup that entirely contains the marquee', () => {
    const big: MarkupGeometry = {
      kind: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
        { x: 1000, y: 1000 },
        { x: 0, y: 1000 }
      ]
    }
    assert.equal(geometryIntersectsRect(big, rectFromCorners({ x: 400, y: 400 }, { x: 500, y: 500 })), true)
  })

  it('selects a pin inside and rejects one outside', () => {
    const inside: MarkupGeometry = { kind: 'point', point: { x: 50, y: 0 } }
    const outside: MarkupGeometry = { kind: 'point', point: { x: 500, y: 0 } }
    assert.equal(geometryIntersectsRect(inside, marquee), true)
    assert.equal(geometryIntersectsRect(outside, marquee), false)
  })

  it('selects an arc the marquee crosses', () => {
    const arc: MarkupGeometry = {
      kind: 'arc',
      center: { x: 0, y: 0 },
      radius: 50,
      startAngle: 0,
      endAngle: Math.PI
    }
    assert.equal(geometryIntersectsRect(arc, rectFromCorners({ x: -5, y: 45 }, { x: 5, y: 55 })), true)
    assert.equal(geometryIntersectsRect(arc, rectFromCorners({ x: -5, y: -55 }, { x: 5, y: -45 })), false)
  })

  it('a zero-area marquee (a click) still resolves without throwing', () => {
    const degenerate = rectFromCorners({ x: 50, y: 0 }, { x: 50, y: 0 })
    assert.equal(geometryIntersectsRect(LINE, degenerate), true)
  })
})

describe('boundsOf', () => {
  it('bounds a polyline', () => {
    assert.deepEqual(boundsOf(LINE), { minX: 0, minY: 0, maxX: 100, maxY: 0 })
  })

  it('bounds an arc by its sampled extent, not its centre', () => {
    const arc: MarkupGeometry = {
      kind: 'arc',
      center: { x: 0, y: 0 },
      radius: 10,
      startAngle: 0,
      endAngle: Math.PI / 2
    }
    const b = boundsOf(arc)
    assert.ok(b.maxX > 9.9 && b.maxY > 9.9, `expected the quarter arc to reach ~10, got ${JSON.stringify(b)}`)
    assert.ok(b.minX >= -1e-9 && b.minY >= -1e-9)
  })
})
