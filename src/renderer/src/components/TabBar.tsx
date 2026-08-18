import type { Tab } from '../tabs/types'

interface TabBarProps {
  tabs: Tab[]
  activeTabId: string | undefined
  liveLinkDocked: boolean
  canOpen: boolean
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onToggleDock: () => void
  onImportPdf: () => void
  openMenu: React.ReactNode
  /** The markup tool icon strip - rendered first, pushed to the far left. */
  toolBar?: React.ReactNode
}

export default function TabBar({
  tabs,
  activeTabId,
  liveLinkDocked,
  canOpen,
  onActivate,
  onClose,
  onToggleDock,
  onImportPdf,
  openMenu,
  toolBar
}: TabBarProps) {
  return (
    <div className="tab-bar">
      {toolBar}
      {toolBar ? <div className="markup-toolbar__separator" /> : null}
      <div className="tab-bar__tabs" role="tablist">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeTabId}
            className={`tab${tab.id === activeTabId ? ' tab--active' : ''}`}
            onClick={() => onActivate(tab.id)}
            title={tab.title}
          >
            <span className={`tab__kind tab__kind--${tab.kind}`} aria-hidden />
            <span className="tab__title">{tab.title}</span>
            {tab.closeable ? (
              <button
                className="tab__close"
                aria-label={`Close ${tab.title}`}
                onClick={(e) => {
                  // Closing must not also activate the tab being closed.
                  e.stopPropagation()
                  onClose(tab.id)
                }}
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
      </div>

      <div className="tab-bar__actions">
        {openMenu}
        <button onClick={onImportPdf} disabled={!canOpen} title={canOpen ? 'Copy a PDF into this project' : 'Open or create a project first'}>
          Import PDF…
        </button>
        <button
          onClick={onToggleDock}
          className={liveLinkDocked ? 'active' : ''}
          title={liveLinkDocked ? 'Show Live Link as a tab' : 'Dock Live Link as a sidebar'}
        >
          {liveLinkDocked ? 'Undock Live Link' : 'Dock Live Link'}
        </button>
      </div>
    </div>
  )
}
