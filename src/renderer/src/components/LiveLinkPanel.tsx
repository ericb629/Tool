import type { ProjectState } from '../../../shared/manifest'
import { describeFileStatus } from '../fileStatus'

interface LiveLinkPanelProps {
  projectState: ProjectState | undefined
}

export default function LiveLinkPanel({ projectState }: LiveLinkPanelProps) {
  if (!projectState) {
    return <span className="labeled-panel__placeholder">Open or create a project to see links</span>
  }

  if (projectState.links.length === 0) {
    return <span className="labeled-panel__placeholder">No links yet</span>
  }

  return (
    <ul className="live-link-list">
      {projectState.links.map((link) => {
        const sourceFile = projectState.files.find((f) => f.fileId === link.sourceFileId)
        const notice = sourceFile ? describeFileStatus(sourceFile) : undefined
        return (
          <li key={link.id} className="live-link-list__item">
            <div className="live-link-list__source">
              {sourceFile ? sourceFile.relativePath : link.sourceFileId}
              {' — markup '}
              {link.markupId.slice(0, 8)}
            </div>
            {notice && notice.severity !== 'ok' ? (
              <div className={`live-link-list__status live-link-list__status--${notice.severity}`} title={notice.detail}>
                {notice.label}
              </div>
            ) : null}
            <div className="live-link-list__target">
              {'→ '}
              {link.target.sheetName} row {link.target.rowIndex}
            </div>
            {link.notes ? <div className="live-link-list__notes">{link.notes}</div> : null}
          </li>
        )
      })}
    </ul>
  )
}
