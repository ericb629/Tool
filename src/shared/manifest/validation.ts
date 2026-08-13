import type { MarkupGeometry, MarkupObject, MarkupTakeoff, MarkupType } from './types'

const ARC_SWEEP_EPSILON = 1e-9

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

  // Arc sweep invariant. Without it, an arc wrapping past 0 stored as
  // 330 -> 30 degrees derives as its 300-degree complement: a quantity five
  // times too large that still looks like a plausible number. Rejecting it
  // here keeps the bad shape off disk rather than leaving the derivation to
  // guess which arc was meant. See MarkupGeometry for the full rationale.
  if (markup.geometry.kind === 'arc' && markup.geometry.endAngle < markup.geometry.startAngle) {
    return {
      valid: false,
      reason:
        `Arc endAngle (${markup.geometry.endAngle}) must be >= startAngle (${markup.geometry.startAngle}). ` +
        `An arc that wraps past 0 stores endAngle + 2*PI - e.g. 330 to 30 degrees is stored as 330 -> 390.`
    }
  }

  if (markup.geometry.kind === 'arc') {
    const sweep = markup.geometry.endAngle - markup.geometry.startAngle
    // Tolerance because a full turn is normally built as startAngle + 2*PI,
    // and that subtraction can land a few ULPs above 2*PI (~9e-16 observed).
    // 1e-9 rad is far below any angle a drawing tool can express, and far
    // above float noise.
    if (sweep > 2 * Math.PI + ARC_SWEEP_EPSILON) {
      return {
        valid: false,
        reason: `Arc sweep (${sweep}) exceeds one full turn; the maximum is 2*PI.`
      }
    }
  }

  return { valid: true }
}
