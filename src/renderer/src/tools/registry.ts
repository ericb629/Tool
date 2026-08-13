import type {
  LinearUnit,
  MarkupGeometry,
  MarkupTakeoff,
  MarkupType,
  PdfPoint
} from '../../../shared/manifest'

export type ToolId = 'select' | 'pan' | 'calibrate' | 'linear'

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
  /** Minimum points before the tool can be committed. */
  minPoints?: number
  /** Committing after exactly this many points, for fixed-arity tools. */
  exactPoints?: number
  buildGeometry?: (points: PdfPoint[]) => MarkupGeometry
  buildTakeoff?: (unit: LinearUnit) => MarkupTakeoff
  /** Calibration is not a markup; it takes its own commit path. */
  isCalibration?: boolean
}

/**
 * The registry. Adding Area, Count, Volume, Arc or box-select-text means
 * appending an entry here - the palette renders whatever is registered and
 * the viewer drives any tool through the same collect-then-commit path, so
 * nothing switches on tool identity.
 */
export const TOOLS: ToolDefinition[] = [
  {
    id: 'select',
    label: 'Select',
    hint: 'Select markups',
    cursor: 'default',
    leftButton: 'select'
  },
  {
    id: 'pan',
    label: 'Pan',
    hint: 'Drag to pan',
    cursor: 'grab',
    leftButton: 'pan'
  },
  {
    id: 'calibrate',
    label: 'Calibrate',
    hint: 'Click two points a known distance apart',
    cursor: 'crosshair',
    exactPoints: 2,
    minPoints: 2,
    isCalibration: true
  },
  {
    id: 'linear',
    label: 'Linear',
    hint: 'Click along a line, then finish',
    cursor: 'crosshair',
    minPoints: 2,
    produces: {
      markupType: 'polyline',
      takeoffMode: 'linear',
      geometryKind: 'polyline'
    },
    buildGeometry: (points) => ({ kind: 'polyline', points }),
    buildTakeoff: (unit) => ({ mode: 'linear', unit })
  }
]

export const TOOL_BY_ID: Record<ToolId, ToolDefinition> = Object.fromEntries(
  TOOLS.map((t) => [t.id, t])
) as Record<ToolId, ToolDefinition>

export const isDrawingTool = (tool: ToolDefinition): boolean =>
  Boolean(tool.produces) || Boolean(tool.isCalibration)
