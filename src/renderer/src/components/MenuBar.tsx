import { useEffect, useRef, useState } from 'react'

export interface MenuItem {
  label: string
  onClick?: () => void
  /** Shown grayed-out with `title` as the reason - never a silent no-op. */
  disabled?: boolean
  title?: string
}

export interface MenuBarMenu {
  id: string
  label: string
  items: MenuItem[]
  /** Shown instead of `items` when there is nothing here yet. */
  emptyLabel?: string
}

interface MenuBarProps {
  menus: MenuBarMenu[]
}

/**
 * A classic desktop app menu bar (Tool / File / View / Document / Tools):
 * one open dropdown at a time, hover switches between menus while one is
 * already open, and outside click / Escape closes whatever is open. Menus
 * with no real commands yet (View, Tools) pass an empty `items` array plus
 * `emptyLabel` rather than being wired to fake handlers.
 */
export default function MenuBar({ menus }: MenuBarProps) {
  const [openMenuId, setOpenMenuId] = useState<string | undefined>(undefined)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!openMenuId) return
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpenMenuId(undefined)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpenMenuId(undefined)
    }
    document.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [openMenuId])

  return (
    <div className="menu-bar" role="menubar" aria-label="Application menu" ref={rootRef}>
      {menus.map((menu) => (
        <div key={menu.id} className="menu-bar__menu">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={openMenuId === menu.id}
            className={`menu-bar__button${openMenuId === menu.id ? ' menu-bar__button--active' : ''}`}
            onClick={() => setOpenMenuId((prev) => (prev === menu.id ? undefined : menu.id))}
            onMouseEnter={() => setOpenMenuId((prev) => (prev !== undefined ? menu.id : prev))}
          >
            {menu.label}
          </button>
          {openMenuId === menu.id ? (
            <ul className="menu-bar__list" role="menu">
              {menu.items.length === 0 ? (
                <li className="menu-bar__empty">{menu.emptyLabel ?? 'Nothing here yet'}</li>
              ) : (
                menu.items.map((item) => (
                  <li key={item.label}>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={item.disabled}
                      title={item.title}
                      onClick={() => {
                        setOpenMenuId(undefined)
                        item.onClick?.()
                      }}
                    >
                      {item.label}
                    </button>
                  </li>
                ))
              )}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  )
}
