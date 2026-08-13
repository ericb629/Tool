// Project manifest schema — shared between main and renderer processes.
// See CLAUDE.md-adjacent design discussion for the full rationale; this file
// is the source of truth for the shapes agreed there.

// ---------- Shared primitives ----------
export type Uuid = string
export type IsoTimestamp = string

export const CURRENT_SCHEMA_VERSION = 1 as const
export type SchemaVersion = typeof CURRENT_SCHEMA_VERSION

export type FileType = 'pdf' | 'spreadsheet'

// ---------- Coordinate space ----------
/**
 * A point in PDF user-space (the PDF page's native coordinate system, as
 * exposed by PDF.js's page.getViewport() before any canvas/CSS transform).
 * Origin: bottom-left of the page. X increases right, Y increases UP.
 * NOT canvas/screen pixel space (top-left origin, Y down) — conversion
 * happens at the render boundary via viewport.convertToPdfPoint /
 * convertToViewportPoint; everything persisted here stays in user-space so
 * it is independent of zoom, DPI, and window size.
 */
export interface PdfPoint {
  x: number
  y: number
}

export type LinearUnit = 'in' | 'ft' | 'mm' | 'cm' | 'm'
export type AreaUnit = 'sf' | 'sy' | 'm2' | 'acre'
export type VolumeUnit = 'cf' | 'cy' | 'm3'

// ---------- Project-level manifest (project.json) ----------
export interface ProjectManifest {
  schemaVersion: SchemaVersion
  projectId: Uuid
  name: string
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  files: ProjectFileEntry[]
}

export interface ProjectFileEntry {
  fileId: Uuid // stable identity, independent of filename/path
  relativePath: string // last-known path, relative to project root
  fileType: FileType
  addedAt: IsoTimestamp
}

// ---------- Layers (layers.json, project-scoped) ----------
export interface Layer {
  id: Uuid
  name: string
  color?: string
  defaultVisible: boolean
  createdAt: IsoTimestamp
}

export interface LayerRegistry {
  schemaVersion: SchemaVersion
  layers: Layer[]
}

// ---------- Symbol legend (legend.json, project-scoped) ----------
export interface SymbolLegendEntry {
  id: Uuid
  name: string // e.g. "Tee", "90 deg Bend", "Gate Valve"
  category?: string // e.g. "Waterline Fittings"
  swatchColor?: string
  createdAt: IsoTimestamp
}

export interface SymbolLegend {
  schemaVersion: SchemaVersion
  symbols: SymbolLegendEntry[]
}

// ---------- Per-PDF sidecar (.manifest/<fileId>.json) ----------
export interface PdfFileManifest {
  schemaVersion: SchemaVersion
  fileId: Uuid
  fileType: 'pdf'
  updatedAt: IsoTimestamp
  pages: PdfPageRecord[]
  markups: MarkupObject[]
}

export interface PdfPageRecord {
  pageNumber: number
  // Civil sheet sets are addressed as "C-101", not "page 14". Populated by
  // manual entry for now; OCR extraction off the sheet's title block is a
  // later roadmap feature, not implemented here.
  sheetNumber?: string
  sheetName?: string
  calibration?: PageCalibration
}

export interface PageCalibration {
  // Duplicated from the parent PdfPageRecord so a PageCalibration round-trips
  // standalone (e.g. a "calibration history" list) without needing its
  // position in pages[] for context.
  pageNumber: number
  pointA: PdfPoint
  pointB: PdfPoint
  realDistance: number // real-world distance between pointA/pointB, in `unit`
  unit: LinearUnit
  // The user-space distance between pointA/pointB is deliberately NOT
  // stored — it is derived (Euclidean distance) at read time, same
  // principle as not storing computed takeoff quantities below.
}

// Geometric primitive — HOW a markup is drawn.
export type MarkupType = 'pin' | 'rectangle' | 'polygon' | 'polyline' | 'arc' | 'text'

export type MarkupGeometry =
  | { kind: 'point'; point: PdfPoint }
  | { kind: 'rect'; corner1: PdfPoint; corner2: PdfPoint }
  | { kind: 'polyline'; points: PdfPoint[] }
  | { kind: 'polygon'; points: PdfPoint[] }
  | {
      // Center/radius/angle representation, chosen over a three-point arc
      // because (a) angles directly parametrize partial vs. full arcs, (b)
      // the sector-area formula (0.5 * r^2 * deltaTheta) falls out for free
      // and degrades to a full circle's area when deltaTheta === 2*PI with
      // no special-casing, and (c) a three-point arc would need conversion
      // to center/radius internally anyway to compute length exactly, which
      // just reintroduces the numerical error this avoids by storing it
      // directly. Angles are radians, measured counterclockwise from the
      // positive x-axis, consistent with the y-up convention above.
      kind: 'arc'
      center: PdfPoint
      radius: number
      startAngle: number
      endAngle: number
    }

export interface MarkupStyle {
  color: string // hex
  strokeWidth?: number
  fillOpacity?: number
  label?: string
}

// Placeholder until a real cost-item/catalog feature exists — no validation
// beyond "these are strings" is applied yet.
export interface TakeoffItemRef {
  costCode?: string
  itemId?: string
  description?: string
}

// Semantic meaning — WHAT a markup measures. Deliberately a separate field
// from MarkupType: the same geometric primitive can serve different takeoff
// purposes (e.g. a polygon's outline can be a linear perimeter or an area).
//
// Count mode is restricted to 'pin' markups only: a count has to be
// something a quantity can be derived from without being separately stored,
// and "one pin = one count" is the only geometry that satisfies that for
// counting — it also matches how fittings are actually taken off (clicked
// one at a time against a legend symbol), not lasso-selected as a cluster.
export type MarkupTakeoff =
  | { mode: 'linear'; unit: LinearUnit; itemRef?: TakeoffItemRef }
  | { mode: 'area'; unit: AreaUnit; itemRef?: TakeoffItemRef }
  | { mode: 'volume'; unit: VolumeUnit; depth: number; depthUnit: LinearUnit; itemRef?: TakeoffItemRef }
  | { mode: 'count'; symbolId: Uuid; itemRef?: TakeoffItemRef }
  | { mode: 'annotation' }

export interface MarkupObject {
  id: Uuid
  pageNumber: number
  layerId: Uuid
  type: MarkupType
  takeoff: MarkupTakeoff
  geometry: MarkupGeometry
  style: MarkupStyle
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  // Quantities (length/area/count/volume) are NEVER stored here — always
  // derived from geometry + PageCalibration (+ depth for volume) at read
  // time. See src/shared/manifest/quantity.ts.
}

// ---------- Per-spreadsheet sidecar (.manifest/<fileId>.json) ----------
export interface SpreadsheetFileManifest {
  schemaVersion: SchemaVersion
  fileId: Uuid
  fileType: 'spreadsheet'
  updatedAt: IsoTimestamp
  sheets: SpreadsheetSheetRecord[]
}

export interface SpreadsheetSheetRecord {
  sheetName: string
}

export interface SpreadsheetRowReference {
  fileId: Uuid
  sheetName: string
  rowIndex: number
  rowKey?: string // deferred stability escape hatch, kept optional
}

// ---------- Links (links.json, project-scoped) ----------
export interface LinkRecord {
  id: Uuid
  markupId: Uuid
  sourceFileId: Uuid
  target: SpreadsheetRowReference
  linkType?: string
  notes?: string
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

// ---------- Assembled in-memory project state (handed to renderer) ----------
export type FileManifest = PdfFileManifest | SpreadsheetFileManifest

/**
 * Whether a thing referenced by the manifest was actually found on disk.
 * Kept as two independent fields on ResolvedFileEntry rather than one
 * combined enum: the source file and its sidecar go missing for different
 * reasons and have different consequences, and a single enum forces one to
 * mask the other when both are absent.
 */
export type PresenceStatus = 'ok' | 'missing'

export interface ResolvedFileEntry {
  fileId: Uuid
  relativePath: string
  fileType: FileType
  // Is the source document (the PDF/spreadsheet at relativePath) on disk?
  // 'missing' means the file was moved, renamed, or deleted outside the app.
  // Its markups are intact; there is just nothing to render them over.
  sourceStatus: PresenceStatus
  // Is this file's .manifest/<fileId>.json sidecar on disk? project.json is
  // always the last file written on save (see ManifestStore.save), so a
  // fileId it references should always have a sidecar. 'missing' therefore
  // means something happened outside a normal save (manual deletion,
  // restoring a partial backup, external corruption) and this file's markup
  // history is likely LOST.
  //
  // `manifest` is still populated with an empty in-memory placeholder when
  // this is 'missing', so callers always get a well-formed FileManifest -
  // but an empty manifest here means "we don't know what was here", NOT
  // "there was nothing here". Callers must check manifestStatus before
  // presenting it as this file's real content.
  manifestStatus: PresenceStatus
  manifest: FileManifest
}

export interface ProjectState {
  schemaVersion: SchemaVersion
  projectId: Uuid
  name: string
  rootPath: string
  files: ResolvedFileEntry[]
  links: LinkRecord[]
  layers: Layer[]
  legend: SymbolLegendEntry[]
}
