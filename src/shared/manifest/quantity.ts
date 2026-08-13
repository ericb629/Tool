import type { AreaUnit, LinearUnit, MarkupGeometry, MarkupObject, PdfPageRecord, VolumeUnit } from './types'

// Quantities are never stored in the manifest (see MarkupObject comment) —
// they are always derived from geometry + calibration at read time. An
// uncalibrated page must never produce 0, NaN, or a raw user-space number
// standing in as a quantity: an unlabeled plausible-looking number reaching
// a bid is a real financial error, so callers are forced by this
// discriminated union to handle the uncalibrated case explicitly rather
// than falling through to a number.
export type QuantityResult =
  | { status: 'ok'; value: number; unit: LinearUnit | AreaUnit | VolumeUnit | 'ea' }
  | { status: 'uncalibrated' }
  | { status: 'not-measurable' } // annotation-mode markups have no quantity

const LINEAR_TO_METERS: Record<LinearUnit, number> = {
  in: 0.0254,
  ft: 0.3048,
  mm: 0.001,
  cm: 0.01,
  m: 1
}

const AREA_TO_SQUARE_METERS: Record<AreaUnit, number> = {
  sf: LINEAR_TO_METERS.ft ** 2,
  sy: 0.9144 ** 2,
  acre: 4046.8564224,
  m2: 1
}

const VOLUME_TO_CUBIC_METERS: Record<VolumeUnit, number> = {
  cf: LINEAR_TO_METERS.ft ** 3,
  cy: 0.9144 ** 3,
  m3: 1
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

function geometryLength(geometry: MarkupGeometry): number {
  switch (geometry.kind) {
    case 'polyline': {
      let total = 0
      for (let i = 1; i < geometry.points.length; i++) {
        total += distance(geometry.points[i - 1], geometry.points[i])
      }
      return total
    }
    case 'polygon': {
      let total = 0
      for (let i = 0; i < geometry.points.length; i++) {
        const next = geometry.points[(i + 1) % geometry.points.length]
        total += distance(geometry.points[i], next)
      }
      return total
    }
    case 'arc':
      return geometry.radius * Math.abs(geometry.endAngle - geometry.startAngle)
    default:
      throw new Error(`Cannot derive a length from geometry kind '${geometry.kind}'`)
  }
}

function geometryArea(geometry: MarkupGeometry): number {
  switch (geometry.kind) {
    case 'rect':
      return Math.abs((geometry.corner2.x - geometry.corner1.x) * (geometry.corner2.y - geometry.corner1.y))
    case 'polygon': {
      // Shoelace formula.
      let sum = 0
      for (let i = 0; i < geometry.points.length; i++) {
        const p = geometry.points[i]
        const next = geometry.points[(i + 1) % geometry.points.length]
        sum += p.x * next.y - next.x * p.y
      }
      return Math.abs(sum) / 2
    }
    case 'arc':
      // Sector area; degrades to a full circle's area (pi * r^2) when
      // deltaTheta === 2*PI with no special-casing needed.
      return 0.5 * geometry.radius ** 2 * Math.abs(geometry.endAngle - geometry.startAngle)
    default:
      throw new Error(`Cannot derive an area from geometry kind '${geometry.kind}'`)
  }
}

export function deriveQuantity(markup: MarkupObject, page: PdfPageRecord): QuantityResult {
  if (markup.takeoff.mode === 'annotation') {
    return { status: 'not-measurable' }
  }

  if (markup.takeoff.mode === 'count') {
    return { status: 'ok', value: 1, unit: 'ea' }
  }

  const calibration = page.calibration
  if (!calibration) {
    return { status: 'uncalibrated' }
  }

  // Real-world calibration units per one PDF user-space unit.
  const scale = calibration.realDistance / distance(calibration.pointA, calibration.pointB)
  const calibrationUnitToMeters = LINEAR_TO_METERS[calibration.unit]

  if (markup.takeoff.mode === 'linear') {
    const lengthInMeters = geometryLength(markup.geometry) * scale * calibrationUnitToMeters
    return { status: 'ok', value: lengthInMeters / LINEAR_TO_METERS[markup.takeoff.unit], unit: markup.takeoff.unit }
  }

  const areaInSquareMeters = geometryArea(markup.geometry) * scale ** 2 * calibrationUnitToMeters ** 2

  if (markup.takeoff.mode === 'area') {
    return { status: 'ok', value: areaInSquareMeters / AREA_TO_SQUARE_METERS[markup.takeoff.unit], unit: markup.takeoff.unit }
  }

  // volume
  const depthInMeters = markup.takeoff.depth * LINEAR_TO_METERS[markup.takeoff.depthUnit]
  const volumeInCubicMeters = areaInSquareMeters * depthInMeters
  return { status: 'ok', value: volumeInCubicMeters / VOLUME_TO_CUBIC_METERS[markup.takeoff.unit], unit: markup.takeoff.unit }
}
