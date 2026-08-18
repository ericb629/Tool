import MenuBar, { type MenuBarMenu } from './MenuBar'
import WindowControls from './WindowControls'

interface TitleBarProps {
  menus: MenuBarMenu[]
}

/**
 * The window is frameless (main/index.ts), so this row IS the title bar:
 * the app menu on the left, window controls on the right, same as any
 * native Windows caption bar. The gap between them is the drag region -
 * `-webkit-app-region: drag` in CSS - with the menu and controls carved
 * out as `no-drag` so their clicks still land.
 */
export default function TitleBar({ menus }: TitleBarProps) {
  return (
    <div className="title-bar">
      <MenuBar menus={menus} />
      <div className="title-bar__drag-region" onDoubleClick={() => void window.api.windowControls.toggleMaximize()} />
      <WindowControls />
    </div>
  )
}
