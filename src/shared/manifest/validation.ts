import type { MarkupGeometry, MarkupObject, MarkupTakeoff, MarkupType } from './types'

export type ValidationResult = { valid: true } | { valid: false; reason: string }

// Type/takeoff validity matrix. Enforced at creation (see ManifestStore in
// the main process) rather than discovered later at quantity-derivation
// time, per the design decision that invalid combinations should never
// reach disk.
//
//   linear     -> polyline, polygon (perimeter), arc
//   area       -> polygon, rectangle, arc
//   volume     -> polygon, rectangle, arc (+ depth)
//   count      -> pin
//   annotation -> any
const VALID_TAKEOFF_MODES_BY_TYPE: Record<MarkupType, MarkupTakeoff['mode'][]> = {
  pin: ['count', 'annotation'],
  rectangle: ['area', 'volume', 'annotation'],
  polygon: ['linear', 'area', 'volume', 'annotation'],
  polyline: ['linear', 'annotation'],
  arc: ['linear', 'area', 'volume', 'annotation'],
  text: ['annotation']
}

// A MarkupType also implies which MarkupGeometry.kind it must carry, so the
// two fields never drift apart (e.g. a 'pin' can't secretly hold polygon
// points).
const EXPECTED_GEOMETRY_KIND_BY_TYPE: Record<MarkupType, MarkupGeometry['kind']> = {
  pin: 'point',
  rectangle: 'rect',
  polygon: 'polygon',
  polyline: 'polyline',
  arc: 'arc',
  text: 'point'
}

export function validateMarkup(markup: Pick<MarkupObject, 'type' | 'takeoff' | 'geometry'>): ValidationResult {
  const allowedModes = VALID_TAKEOFF_MODES_BY_TYPE[markup.type]
  if (!allowedModes.includes(markup.takeoff.mode)) {
    return {
      valid: false,
      reason: `MarkupType '${markup.type}' cannot use takeoff mode '${markup.takeoff.mode}'. Allowed modes: ${allowedModes.join(', ')}`
    }
  }

  const expectedGeometryKind = EXPECTED_GEOMETRY_KIND_BY_TYPE[markup.type]
  if (markup.geometry.kind !== expectedGeometryKind) {
    return {
      valid: false,
      reason: `MarkupType '${markup.type}' requires geometry kind '${expectedGeometryKind}', got '${markup.geometry.kind}'`
    }
  }

  return { valid: true }
}
