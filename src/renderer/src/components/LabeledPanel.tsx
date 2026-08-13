import type { ReactNode } from 'react'

interface LabeledPanelProps {
  title: string
  children?: ReactNode
}

export default function LabeledPanel({ title, children }: LabeledPanelProps) {
  return (
    <div className="labeled-panel">
      <div className="labeled-panel__header">{title}</div>
      <div className="labeled-panel__body">
        {children ?? <span className="labeled-panel__placeholder">{title} coming soon</span>}
      </div>
    </div>
  )
}
