import { TOOLS, type ToolId } from '../tools/registry'

interface ToolPaletteProps {
  activeToolId: ToolId
  onSelect: (id: ToolId) => void
  /** Tools that draw are disabled until the page can support them. */
  disabledToolIds?: ToolId[]
  disabledReason?: string
}

/** Renders whatever is registered - adding a tool needs no change here. */
export default function ToolPalette({
  activeToolId,
  onSelect,
  disabledToolIds = [],
  disabledReason
}: ToolPaletteProps) {
  return (
    <div className="tool-palette" role="toolbar" aria-label="Tools">
      {TOOLS.map((tool) => {
        const disabled = disabledToolIds.includes(tool.id)
        const active = tool.id === activeToolId
        return (
          <button
            key={tool.id}
            className={`tool-palette__tool${active ? ' tool-palette__tool--active' : ''}`}
            aria-pressed={active}
            disabled={disabled}
            title={disabled ? disabledReason ?? tool.hint : tool.hint}
            onClick={() => onSelect(tool.id)}
          >
            {tool.label}
          </button>
        )
      })}
    </div>
  )
}
