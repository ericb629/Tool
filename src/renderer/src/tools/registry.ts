import {
  Circle as CircleIcon,
  Hand as HandIcon,
  MousePointer2 as SelectIcon,
  Ruler as RulerIcon,
  Shapes as ShapesIcon,
  Slash as SlashIcon,
  Spline as SplineIcon,
  type LucideIcon
} from 'lucide-react'
import type {
  AreaUnit,
  LinearUnit,
  MarkupGeometry,
  MarkupTakeoff,
  MarkupType,
  PdfPoint
} from '../../../shared/manifest'

export type ToolId = 'select' | 'pan' | 'calibrate' | 'linear' | 'polyline' | 'area' | 'circle'

/** Which unit dropdown a tool's takeoff needs. Absent means 'linear'. */
export type TakeoffUnitKind = 'linear' | 'area'

/**
 * What a drawing tool produces. Declaring it here rather than hardcoding it
 * at the call site is what lets the existing validity matrix keep doing its
 * job: the markup a tool builds carries the type/takeoff pair the tool
 * declared, and validateMarkup rejects the combination if it is not legal.
 * A tool cannot quietly invent an illegal pairing.
 */
export interface ToolProduces {
  markupType: MarkupType
  takeoffMode: MarkupTakeoff['mode']
  geometryKind: MarkupGeometry['kind']
}

export interface ToolDefinition {
  id: ToolId
  label: string
  /** Shown in the palette; kept short so the palette stays a strip. */
  hint: string
  /** CSS cursor while this tool is active and no drag is in progress. */
  cursor: string
  /**
   * What the left button does for a NON-drawing tool. Drawing tools always
   * take the left button to place points, so they do not set this.
   *
   * Declared here rather than switched on tool id at the call site, so adding
   * a future non-drawing tool does not mean editing the arbitration logic.
   */
  leftButton?: 'select' | 'pan'
  /**
   * Absent for tools that do not draw (Select, Pan). Present means the tool
   * collects points and produces a markup or a calibration.
   */
  produces?: ToolProduces
  /** Which unit dropdown to show while drawing. Defaults to 'linear'. */
  unitKind?: TakeoffUnitKind
  /**
   * Area-mode tools only: an optional depth input in the draw prompt that,
   * when filled in, switches the committed takeoff from 'area' to 'volume'
   * (area x depth) instead of adding a separate volume tool - the geometry
   * and MarkupType are identical either way, only the takeoff differs, and
   * validateMarkup already allows both modes for the same MarkupType.
   */
  supportsDepth?: boolean
  /** Stroke color new markups from this tool are saved with. */
  defaultColor: string
  /** Icon shown by whichever palette renders this tool. */
  icon: LucideIcon
  /**
   * Renders in the markup toolbar (TabBar, far left) instead of the
   * in-viewer ToolPalette. Only the measuring tools live there - Select/Pan/
   * Calibrate stay in the viewer where the rest of that palette is.
   */
  inTopBar?: boolean
  /** Minimum points before the tool can be committed. */
  minPoints?: number
  /** Committing after exactly this many points, for fixed-arity tools. */
  exactPoints?: number
  buildGeometry?: (points: PdfPoint[]) => MarkupGeometry
  /** `unit` is whichever unit the draw prompt collected - see `unitKind`. */
  buildTakeoff?: (unit: LinearUnit | AreaUnit) => MarkupTakeoff
  /** Calibration is not a markup; it takes its own commit path. */
  isCalibration?: boolean
}

/**
 * The registry. Adding Count or Arc-sector means appending an entry here -
 * the palette renders whatever is registered and the viewer drives any tool
 * through the same collect-then-commit path, so nothing switches on tool
 * identity.
 */
export const TOOLS: ToolDefinition[] = [
  {
    id: 'select',
    label: 'Select',
    hint: 'Select markups',
    cursor: 'default',
    leftButton: 'select',
    defaultColor: '#e63946',
    icon: SelectIcon
  },
  {
    id: 'pan',
    label: 'Pan',
    hint: 'Drag to pan',
    cursor: 'grab',
    leftButton: 'pan',
    defaultColor: '#e63946',
    icon: HandIcon
  },
  {
    id: 'calibrate',
    label: 'Calibrate',
    hint: 'Click two points a known distance apart',
    cursor: 'crosshair',
    exactPoints: 2,
    minPoints: 2,
    isCalibration: true,
    defaultColor: '#2a9d8f',
    icon: RulerIcon
  },
  {
    id: 'linear',
    label: 'Linear',
    hint: 'Click two points to measure a straight distance',
    cursor: 'crosshair',
    exactPoints: 2,
    minPoints: 2,
    produces: {
      markupType: 'polyline',
      takeoffMode: 'linear',
      geometryKind: 'polyline'
    },
    defaultColor: '#e63946',
    icon: SlashIcon,
    inTopBar: true,
    buildGeometry: (points) => ({ kind: 'polyline', points }),
    buildTakeoff: (unit) => ({ mode: 'linear', unit: unit as LinearUnit })
  },
  {
    id: 'polyline',
    label: 'Polyline',
    hint: 'Click along a bent run, then finish',
    cursor: 'crosshair',
    minPoints: 2,
    produces: {
      markupType: 'polyline',
      takeoffMode: 'linear',
      geometryKind: 'polyline'
    },
    defaultColor: '#e63946',
    icon: SplineIcon,
    inTopBar: true,
    buildGeometry: (points) => ({ kind: 'polyline', points }),
    buildTakeoff: (unit) => ({ mode: 'linear', unit: unit as LinearUnit })
  },
  {
    id: 'area',
    label: 'Area',
    hint: 'Click each corner, then finish',
    cursor: 'crosshair',
    minPoints: 3,
    produces: {
      markupType: 'polygon',
      takeoffMode: 'area',
      geometryKind: 'polygon'
    },
    unitKind: 'area',
    supportsDepth: true,
    defaultColor: '#e9c46a',
    icon: ShapesIcon,
    inTopBar: true,
    buildGeometry: (points) => ({ kind: 'polygon', points }),
    buildTakeoff: (unit) => ({ mode: 'area', unit: unit as AreaUnit })
  },
  {
    id: 'circle',
    label: 'Circle',
    hint: 'Click the center, then click the edge, then finish',
    cursor: 'crosshair',
    exactPoints: 2,
    minPoints: 2,
    produces: {
      markupType: 'arc',
      takeoffMode: 'area',
      geometryKind: 'arc'
    },
    unitKind: 'area',
    defaultColor: '#457b9d',
    icon: CircleIcon,
    inTopBar: true,
    buildGeometry: ([center, edge]) => ({
      kind: 'arc',
      center,
      radius: Math.hypot(edge.x - center.x, edge.y - center.y),
      startAngle: 0,
      endAngle: 2 * Math.PI
    }),
    buildTakeoff: (unit) => ({ mode: 'area', unit: unit as AreaUnit })
  }
]

export const TOOL_BY_ID: Record<ToolId, ToolDefinition> = Object.fromEntries(
  TOOLS.map((t) => [t.id, t])
) as Record<ToolId, ToolDefinition>

export const isDrawingTool = (tool: ToolDefinition): boolean =>
  Boolean(tool.produces) || Boolean(tool.isCalibration)
