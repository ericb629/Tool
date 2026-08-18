interface AboutDialogProps {
  onClose: () => void
}

export default function AboutDialog({ onClose }: AboutDialogProps) {
  const versions = window.api.versions
  return (
    <div className="about-dialog__backdrop" onClick={onClose}>
      <div className="about-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Tool</h2>
        <p>Civil/heavy construction takeoff and estimating.</p>
        <div className="about-dialog__versions">
          <div>
            <span>Electron</span>
            <span>{versions.electron}</span>
          </div>
          <div>
            <span>Chromium</span>
            <span>{versions.chrome}</span>
          </div>
          <div>
            <span>Node</span>
            <span>{versions.node}</span>
          </div>
        </div>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}
