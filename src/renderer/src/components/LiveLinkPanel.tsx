import { useState } from 'react'
import type { ProjectState } from '../../../shared/manifest'
import { describeFileStatus } from '../fileStatus'

interface LiveLinkPanelProps {
  projectState: ProjectState | undefined
  onOpenProject: (folderPath: string) => void
  onCreateProject: (folderPath: string) => void
  error: string | undefined
}

/**
 * Renders identically whether it is a tab or the docked sidebar - the only
 * difference is the container it is placed in (see App).
 */
export default function LiveLinkPanel({
  projectState,
  onOpenProject,
  onCreateProject,
  error
}: LiveLinkPanelProps) {
  const [folderPath, setFolderPath] = useState('')

  return (
    <div className="live-link-panel">
      <div className="live-link-panel__project-controls">
        <input
          type="text"
          placeholder="Project folder path"
          value={folderPath}
          onChange={(e) => setFolderPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && folderPath) onOpenProject(folderPath)
          }}
        />
        <button onClick={() => onOpenProject(folderPath)} disabled={!folderPath}>
          Open
        </button>
        <button onClick={() => onCreateProject(folderPath)} disabled={!folderPath}>
          Create
        </button>
      </div>

      {error ? <div className="live-link-panel__error">{error}</div> : null}

      {!projectState ? (
        <span className="labeled-panel__placeholder">Open or create a project to see links</span>
      ) : projectState.links.length === 0 ? (
        <span className="labeled-panel__placeholder">No links yet</span>
      ) : (
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
                  <div
                    className={`live-link-list__status live-link-list__status--${notice.severity}`}
                    title={notice.detail}
                  >
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
      )}
    </div>
  )
}
