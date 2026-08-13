import { Group, Panel, Separator } from 'react-resizable-panels'
import LabeledPanel from './components/LabeledPanel'

export default function App() {
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
        <LabeledPanel title="Live Link" />
      </Panel>
    </Group>
  )
}
