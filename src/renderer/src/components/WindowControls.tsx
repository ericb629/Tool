import { useEffect, useState } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'

/** Minimize/maximize/close for the frameless window - see main/ipc/windowControls.ts. */
export default function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.api.windowControls.isMaximized().then(setMaximized)
    return window.api.windowControls.onMaximizedChanged(setMaximized)
  }, [])

  return (
    <div className="window-controls">
      <button
        type="button"
        className="window-controls__button"
        aria-label="Minimize"
        onClick={() => void window.api.windowControls.minimize()}
      >
        <Minus size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="window-controls__button"
        aria-label={maximized ? 'Restore' : 'Maximize'}
        onClick={() => void window.api.windowControls.toggleMaximize()}
      >
        {maximized ? <Copy size={13} aria-hidden="true" /> : <Square size={12} aria-hidden="true" />}
      </button>
      <button
        type="button"
        className="window-controls__button window-controls__button--close"
        aria-label="Close"
        onClick={() => void window.api.windowControls.close()}
      >
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  )
}
