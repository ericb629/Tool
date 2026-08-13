import { useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import LabeledPanel from './components/LabeledPanel'
import LiveLinkPanel from './components/LiveLinkPanel'
import type { ProjectState } from '../../shared/manifest'

export default function App() {
  const [folderPath, setFolderPath] = useState('')
  const [projectState, setProjectState] = useState<ProjectState | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  async function handleOpen(): Promise<void> {
    setError(undefined)
    try {
      setProjectState(await window.api.project.open(folderPath))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleCreate(): Promise<void> {
    setError(undefined)
    try {
      setProjectState(await window.api.project.create(folderPath))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Group orientation="horizontal" className="app-panel-group">
      <Panel defaultSize={30} minSize={15}>
        <LabeledPanel title="PDF Editor" />
      </Panel>
      <Separator className="resize-handle" />
      <Panel defaultSize={40} minSize={15}>
        <LabeledPanel title="Spreadsheet" />
      </Panel>
      <Separator className="resize-handle" />
      <Panel defaultSize={30} minSize={15}>
        <LabeledPanel title="Live Link">
          <div className="live-link-panel">
            <div className="live-link-panel__project-controls">
              <input
                type="text"
                placeholder="Project folder path"
                value={folderPath}
                onChange={(e) => setFolderPath(e.target.value)}
              />
              <button onClick={handleOpen} disabled={!folderPath}>
                Open
              </button>
              <button onClick={handleCreate} disabled={!folderPath}>
                Create
              </button>
            </div>
            {error ? <div className="live-link-panel__error">{error}</div> : null}
            <LiveLinkPanel projectState={projectState} />
          </div>
        </LabeledPanel>
      </Panel>
    </Group>
  )
}
