import type { MarkupGeometry, PdfPoint } from '../../../shared/manifest'

/**
 * Hit testing, entirely in PDF user-space.
 *
 * Nothing here takes a pixel. The caller converts the pointer to a PdfPoint
 * at capture and converts the tolerance from screen pixels to user-space by
 * dividing by the current scale, which is what makes a hairline polyline
 * equally clickable at 17% and at 400%.
 */

export interface UserSpaceRect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Normalises two corners captured in any drag direction. */
export function rectFromCorners(a: PdfPoint, b: PdfPoint): UserSpaceRect {
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y)
  }
}

export function rectsIntersect(a: UserSpaceRect, b: UserSpaceRect): boolean {
  return !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY)
}

function pointInRect(p: PdfPoint, r: UserSpaceRect): boolean {
  return p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY
}

/** Perpendicular distance from p to segment ab, in user-space units. */
export function distanceToSegment(p: PdfPoint, a: PdfPoint, b: PdfPoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  // Projection parameter, clamped so the nearest point stays on the segment.
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Even-odd ray cast. Used so a click inside an area markup selects it. */
function pointInPolygon(p: PdfPoint, points: PdfPoint[]): boolean {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]
    const b = points[j]
    const straddles = a.y > p.y !== b.y > p.y
    if (straddles && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** Arcs are sampled for the tests where a closed form would not pay for itself. */
function sampleArc(
  geometry: Extract<MarkupGeometry, { kind: 'arc' }>,
  segments = 48
): PdfPoint[] {
  const points: PdfPoint[] = []
  const sweep = geometry.endAngle - geometry.startAngle
  for (let i = 0; i <= segments; i++) {
    const angle = geometry.startAngle + (sweep * i) / segments
    points.push({
      x: geometry.center.x + geometry.radius * Math.cos(angle),
      y: geometry.center.y + geometry.radius * Math.sin(angle)
    })
  }
  return points
}

export function geometryPoints(geometry: MarkupGeometry): PdfPoint[] {
  switch (geometry.kind) {
    case 'point':
      return [geometry.point]
    case 'rect':
      return [
        geometry.corner1,
        { x: geometry.corner2.x, y: geometry.corner1.y },
        geometry.corner2,
        { x: geometry.corner1.x, y: geometry.corner2.y }
      ]
    case 'polyline':
    case 'polygon':
      return geometry.points
    case 'arc':
      return sampleArc(geometry)
    default:
      return []
  }
}

export function boundsOf(geometry: MarkupGeometry): UserSpaceRect {
  const points = geometryPoints(geometry)
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  return { minX, minY, maxX, maxY }
}

/**
 * Is `point` within `tolerance` of the markup?
 *
 * `tolerance` is in USER-SPACE units. Callers pass screenPixels / scale so the
 * grab radius stays constant on screen at any zoom.
 */
export function hitTestGeometry(geometry: MarkupGeometry, point: PdfPoint, tolerance: number): boolean {
  switch (geometry.kind) {
    case 'point':
      return Math.hypot(point.x - geometry.point.x, point.y - geometry.point.y) <= tolerance

    case 'polyline': {
      for (let i = 1; i < geometry.points.length; i++) {
        if (distanceToSegment(point, geometry.points[i - 1], geometry.points[i]) <= tolerance) return true
      }
      // A one-point polyline still has a grabbable vertex.
      if (geometry.points.length === 1) {
        return Math.hypot(point.x - geometry.points[0].x, point.y - geometry.points[0].y) <= tolerance
      }
      return false
    }

    case 'polygon': {
      if (pointInPolygon(point, geometry.points)) return true
      for (let i = 0; i < geometry.points.length; i++) {
        const next = geometry.points[(i + 1) % geometry.points.length]
        if (distanceToSegment(point, geometry.points[i], next) <= tolerance) return true
      }
      return false
    }

    case 'rect': {
      const r = rectFromCorners(geometry.corner1, geometry.corner2)
      const grown = {
        minX: r.minX - tolerance,
        minY: r.minY - tolerance,
        maxX: r.maxX + tolerance,
        maxY: r.maxY + tolerance
      }
      return pointInRect(point, grown)
    }

    case 'arc': {
      // On the ring, and within the swept angle.
      const dx = point.x - geometry.center.x
      const dy = point.y - geometry.center.y
      const radial = Math.abs(Math.hypot(dx, dy) - geometry.radius)
      if (radial > tolerance) return false
      const sweep = geometry.endAngle - geometry.startAngle
      if (sweep >= 2 * Math.PI) return true
      // Normalise the point's angle into [startAngle, startAngle + 2*PI).
      const TWO_PI = 2 * Math.PI
      let angle = Math.atan2(dy, dx)
      let delta = (angle - geometry.startAngle) % TWO_PI
      if (delta < 0) delta += TWO_PI
      // Allow the tolerance to spill slightly past each end cap.
      const angularSlack = geometry.radius > 0 ? tolerance / geometry.radius : 0
      return delta <= sweep + angularSlack || delta >= TWO_PI - angularSlack
    }

    default:
      return false
  }
}

function segmentIntersectsRect(a: PdfPoint, b: PdfPoint, rect: UserSpaceRect): boolean {
  if (pointInRect(a, rect) || pointInRect(b, rect)) return true

  // Liang-Barsky clip: does the segment's parameter range survive all four slabs?
  let t0 = 0
  let t1 = 1
  const dx = b.x - a.x
  const dy = b.y - a.y
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0 // parallel: inside only if not outside the slab
    const r = q / p
    if (p < 0) {
      if (r > t1) return false
      if (r > t0) t0 = r
    } else {
      if (r < t0) return false
      if (r < t1) t1 = r
    }
    return true
  }
  return (
    clip(-dx, a.x - rect.minX) &&
    clip(dx, rect.maxX - a.x) &&
    clip(-dy, a.y - rect.minY) &&
    clip(dy, rect.maxY - a.y)
  )
}

/**
 * Does the markup intersect the marquee rectangle? Touching counts - a
 * marquee that crosses a line selects it, matching how takeoff tools behave.
 */
export function geometryIntersectsRect(geometry: MarkupGeometry, rect: UserSpaceRect): boolean {
  if (!rectsIntersect(boundsOf(geometry), rect)) return false

  switch (geometry.kind) {
    case 'point':
      return pointInRect(geometry.point, rect)

    case 'polyline': {
      if (geometry.points.length === 1) return pointInRect(geometry.points[0], rect)
      for (let i = 1; i < geometry.points.length; i++) {
        if (segmentIntersectsRect(geometry.points[i - 1], geometry.points[i], rect)) return true
      }
      return false
    }

    case 'polygon': {
      for (let i = 0; i < geometry.points.length; i++) {
        const next = geometry.points[(i + 1) % geometry.points.length]
        if (segmentIntersectsRect(geometry.points[i], next, rect)) return true
      }
      // A marquee entirely inside a large area markup still selects it.
      return pointInPolygon({ x: rect.minX, y: rect.minY }, geometry.points)
    }

    case 'rect': {
      const r = rectFromCorners(geometry.corner1, geometry.corner2)
      return rectsIntersect(r, rect)
    }

    case 'arc': {
      const points = sampleArc(geometry)
      for (let i = 1; i < points.length; i++) {
        if (segmentIntersectsRect(points[i - 1], points[i], rect)) return true
      }
      return false
    }

    default:
      return false
  }
}
