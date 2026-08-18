import { TOOLS, type ToolId } from '../tools/registry'

const TOP_BAR_TOOLS = TOOLS.filter((tool) => tool.inTopBar)

interface MarkupToolBarProps {
  activeToolId: ToolId
  onSelect: (id: ToolId) => void
  disabled: boolean
  disabledReason?: string
}

/**
 * Icon-only strip at the far left of the tab bar for the measuring tools
 * (Linear/Polyline/Area/Circle) - unlike Select/Pan/Calibrate, which stay in
 * the in-viewer ToolPalette. The label only appears on hover/focus (CSS,
 * see .markup-toolbar__label) so the strip stays a strip.
 */
export default function MarkupToolBar({ activeToolId, onSelect, disabled, disabledReason }: MarkupToolBarProps) {
  return (
    <div className="markup-toolbar" role="toolbar" aria-label="Markup tools">
      {TOP_BAR_TOOLS.map((tool) => {
        const Icon = tool.icon
        const active = tool.id === activeToolId
        return (
          <button
            key={tool.id}
            type="button"
            className={`markup-toolbar__button${active ? ' markup-toolbar__button--active' : ''}`}
            aria-pressed={active}
            aria-label={tool.label}
            disabled={disabled}
            title={disabled ? disabledReason : undefined}
            onClick={() => onSelect(tool.id)}
          >
            <Icon size={16} aria-hidden="true" />
            <span className="markup-toolbar__label">{tool.label}</span>
          </button>
        )
      })}
    </div>
  )
}
