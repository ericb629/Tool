import type { Uuid } from '../../../shared/manifest'

/**
 * Browser-style tabs. Each tab is one open thing; several PDFs can be open at
 * once, each with its own pdf.js document.
 *
 * Adding a future mode (Profile Mode, Plan Mode) is a new member of this
 * union plus one case in TabContent's switch - the switch is exhaustive, so
 * the compiler names every place that needs updating. Nothing else in the
 * shell is aware of specific kinds: the tab bar, close/activate handling and
 * docking all operate on TabBase.
 */
export type TabKind = 'pdf' | 'spreadsheet' | 'live-link'

interface TabBase {
  /** Stable per-tab identity. Not the fileId: the same file could be opened twice. */
  id: string
  kind: TabKind
  title: string
  /** Live Link is not closeable while it is a tab - it carries the project controls. */
  closeable: boolean
}

export interface PdfTab extends TabBase {
  kind: 'pdf'
  fileId: Uuid
}

export interface SpreadsheetTab extends TabBase {
  kind: 'spreadsheet'
  fileId: Uuid
}

export interface LiveLinkTab extends TabBase {
  kind: 'live-link'
}

export type Tab = PdfTab | SpreadsheetTab | LiveLinkTab

export const tabKey = (tab: Tab): string => tab.id

/**
 * Where the Live Link view is showing. As a tab it behaves like any other; as
 * a sidebar it sits alongside whichever tab is active. Same component either
 * way - only the container differs.
 */
export type LiveLinkPlacement = 'tab' | 'sidebar'
