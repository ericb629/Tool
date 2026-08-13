import { useEffect } from 'react'

interface ContextMenuProps {
  x: number
  y: number
  selectionCount: number
  onClose: () => void
}

/**
 * Stub. Opens at the cursor and reports the selection so the gesture
 * plumbing can be verified; the actions themselves are deliberately absent
 * rather than half-built.
 */
export default function ContextMenu({ x, y, selectionCount, onClose }: ContextMenuProps) {
  useEffect(() => {
    const dismiss = (): void => onClose()
    // Any press outside, or a scroll, closes it.
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('wheel', dismiss)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('wheel', dismiss)
    }
  }, [onClose])

  return (
    <div className="context-menu" style={{ left: x, top: y }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="context-menu__header">
        {selectionCount === 0
          ? 'No selection'
          : `${selectionCount} markup${selectionCount === 1 ? '' : 's'} selected`}
      </div>
      <button className="context-menu__item" disabled>
        Actions coming soon
      </button>
    </div>
  )
}
