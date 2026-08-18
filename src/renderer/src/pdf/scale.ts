import type { LinearUnit, PdfPoint } from '../../../shared/manifest'

/**
 * Typed/selected drawing-scale support for calibration. The alternative to
 * measuring a known distance on the page: the user states the printed scale
 * (e.g. `1" = 50'`) and we synthesize a calibration reference line instead of
 * asking them to click one.
 *
 * This assumes the PDF's user-space unit is 1/72 of a physical printed inch
 * (userUnit: 1, the convention CLAUDE.md documents as the norm for real
 * sheets) - i.e. that the page is at its native, undistorted print scale.
 * pointA/pointB only need to be the right DISTANCE apart (deriveQuantity
 * takes their Euclidean distance), not positioned on any real page feature,
 * so placing them at an arbitrary spot is correct, not a shortcut.
 */

const POINTS_PER_INCH = 72

const TO_INCHES: Record<LinearUnit, number> = {
  in: 1,
  ft: 12,
  mm: 1 / 25.4,
  cm: 1 / 2.54,
  m: 1 / 0.0254
}

export interface ParsedScale {
  pointA: PdfPoint
  pointB: PdfPoint
  realDistance: number
  unit: LinearUnit
}

function parseFraction(raw: string): number | null {
  const s = raw.trim()
  if (!s) return null
  const mixed = s.match(/^(\d+(?:\.\d+)?)[\s-]+(\d+)\/(\d+)$/)
  if (mixed) {
    const den = Number(mixed[3])
    if (den === 0) return null
    return Number(mixed[1]) + Number(mixed[2]) / den
  }
  const fraction = s.match(/^(\d+)\/(\d+)$/)
  if (fraction) {
    const den = Number(fraction[2])
    if (den === 0) return null
    return Number(fraction[1]) / den
  }
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s)
  return null
}

function parseSide(raw: string): { value: number; unit: LinearUnit } | null {
  const s = raw.trim()
  if (!s) return null

  // Feet, optionally with trailing inches: 50'  1'-0"  12' 6"  1'6"
  const feetInches = s.match(/^(\d+(?:\.\d+)?)\s*'(?:\s*-?\s*([\d./\s-]+)")?\s*$/)
  if (feetInches) {
    const feet = Number(feetInches[1])
    const inches = feetInches[2] ? parseFraction(feetInches[2]) : 0
    if (Number.isFinite(feet) && inches !== null) return { unit: 'ft', value: feet + inches / 12 }
    return null
  }

  // Inches, plain or fractional: 1"  1/4"  1-1/2"  0.25"
  const inchesOnly = s.match(/^([\d./\s-]+)"$/)
  if (inchesOnly) {
    const value = parseFraction(inchesOnly[1])
    return value === null ? null : { unit: 'in', value }
  }

  // A number followed by a unit word: 50 ft, 1 in, 100mm, 2cm, 1m
  const withUnit = s.match(/^([\d./\s-]+)\s*(in|inch|inches|ft|feet|foot|mm|cm|m)$/i)
  if (withUnit) {
    const value = parseFraction(withUnit[1])
    if (value === null) return null
    const word = withUnit[2].toLowerCase()
    const unit: LinearUnit = word.startsWith('in') ? 'in' : word.startsWith('f') ? 'ft' : (word as LinearUnit)
    return { unit, value }
  }

  return null
}

function buildResult(paperInches: number, realValue: number, realUnit: LinearUnit): ParsedScale | null {
  if (!(paperInches > 0) || !(realValue > 0)) return null
  const span = paperInches * POINTS_PER_INCH
  if (!Number.isFinite(span) || span <= 0) return null
  return { pointA: { x: 0, y: 0 }, pointB: { x: span, y: 0 }, realDistance: realValue, unit: realUnit }
}

/**
 * Parses a typed scale. Accepts `<paper distance> = <real distance>` (each
 * side a number with a unit - ", in, ft, ', feet, mm, cm, m, or feet-inches
 * like 1'-0") or a bare ratio `1:600`, which follows the imperial
 * engineering-scale convention of treating the paper side as inches.
 * Returns null on anything it cannot confidently parse - callers must show
 * that as an error, never guess.
 */
export function parseScaleString(input: string): ParsedScale | null {
  const raw = input.trim()
  if (!raw) return null

  const ratio = raw.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/)
  if (ratio) {
    const paperInches = Number(ratio[1])
    const realInches = Number(ratio[2])
    if (!(paperInches > 0) || !(realInches > 0)) return null
    return buildResult(paperInches, realInches / 12, 'ft')
  }

  const parts = raw.split('=')
  if (parts.length !== 2) return null
  const left = parseSide(parts[0])
  const right = parseSide(parts[1])
  if (!left || !right) return null
  return buildResult(left.value * TO_INCHES[left.unit], right.value, right.unit)
}

export interface ScalePreset {
  label: string
  value: string
}

/** Common civil/engineering scales (paper inch = feet). */
const ENGINEERING_SCALES = ['10', '20', '30', '40', '50', '60', '100', '200', '300', '400', '500', '1000']

/** Common architectural scales (paper fraction-inch = one foot). */
const ARCHITECTURAL_SCALES = ['3/32', '1/8', '3/16', '1/4', '3/8', '1/2', '3/4', '1', '1-1/2', '3']

export const SCALE_PRESETS: ScalePreset[] = [
  ...ENGINEERING_SCALES.map((ft) => ({ label: `1" = ${ft}'`, value: `1" = ${ft}'` })),
  ...ARCHITECTURAL_SCALES.map((num) => ({ label: `${num}" = 1'-0"`, value: `${num}" = 1'-0"` }))
]
