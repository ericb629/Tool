import { TOOLS, type ToolId } from '../tools/registry'

interface ToolPaletteProps {
  activeToolId: ToolId
  onSelect: (id: ToolId) => void
}

/**
 * Renders whatever is registered - adding a tool needs no change here.
 * Tools flagged `inTopBar` render in MarkupToolBar instead (TabBar, far
 * left), so they are excluded to avoid a duplicate control. The tools left
 * here (Select/Pan/Calibrate) are never gated on calibration, unlike the
 * measuring tools in MarkupToolBar, so there is no disabled state to plumb.
 */
export default function ToolPalette({ activeToolId, onSelect }: ToolPaletteProps) {
  return (
    <div className="tool-palette" role="toolbar" aria-label="Tools">
      {TOOLS.filter((tool) => !tool.inTopBar).map((tool) => {
        const active = tool.id === activeToolId
        return (
          <button
            key={tool.id}
            className={`tool-palette__tool${active ? ' tool-palette__tool--active' : ''}`}
            aria-pressed={active}
            title={tool.hint}
            onClick={() => onSelect(tool.id)}
          >
            {tool.label}
          </button>
        )
      })}
    </div>
  )
}
