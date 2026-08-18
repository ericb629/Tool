import { TOOLS, type ToolId } from '../tools/registry'

const TOP_BAR_TOOLS = TOOLS.filter((tool) => tool.inTopBar)

interface MarkupToolBarProps {
  activeToolId: ToolId
  onSelect: (id: ToolId) => void
  /** No PDF tab is active - disables every tool here, Extract Text included. */
  noPdfTab: boolean
  /**
   * The active PDF's page is not calibrated - disables only the tools that
   * PRODUCE a markup (Polyline/Area/Circle, i.e. `tool.produces` is set).
   * Extract Text has no `produces` and does not depend on calibration at
   * all - it reads text off the page, not a scaled quantity - so it stays
   * enabled as long as a PDF tab is open.
   */
  uncalibrated: boolean
}

/**
 * Icon-only strip at the far left of the tab bar for the tools that act on a
 * PDF page (Polyline/Area/Circle/Extract Text) - unlike Select/Pan/Calibrate,
 * which stay in the in-viewer ToolPalette. The label only appears on
 * hover/focus (CSS, see .markup-toolbar__label) so the strip stays a strip.
 */
export default function MarkupToolBar({ activeToolId, onSelect, noPdfTab, uncalibrated }: MarkupToolBarProps) {
  return (
    <div className="markup-toolbar" role="toolbar" aria-label="Markup tools">
      {TOP_BAR_TOOLS.map((tool) => {
        const Icon = tool.icon
        const active = tool.id === activeToolId
        const disabled = noPdfTab || (uncalibrated && Boolean(tool.produces))
        const reason = noPdfTab ? 'Open a PDF to use these tools' : disabled ? 'Calibrate a page first' : undefined
        return (
          <button
            key={tool.id}
            type="button"
            className={`markup-toolbar__button${active ? ' markup-toolbar__button--active' : ''}`}
            aria-pressed={active}
            aria-label={tool.label}
            disabled={disabled}
            title={disabled ? reason : undefined}
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
