import { isDrawingTool, type ToolDefinition } from './registry'

export type InteractionMode = 'mouse' | 'arrow'
export type DragBehavior = 'pan' | 'marquee' | 'none'

/**
 * How the viewer should interpret drags, resolved from the active tool and
 * the interaction mode.
 *
 * THE RULE, written down so it is not re-litigated: right-drag MARQUEES when
 * a selection tool is active, and PANS when a drawing tool is active. A
 * drawing tool owns the left button for placing points, so panning has to
 * move to the right button - and it must not disturb points already placed.
 * Right-click WITHOUT a drag opens the context menu in every case.
 */
export interface InteractionConfig {
  cursor: string
  leftDrag: DragBehavior
  rightDrag: 'pan' | 'marquee'
}

export function resolveInteraction(tool: ToolDefinition, mode: InteractionMode): InteractionConfig {
  if (tool.dragRect) {
    // A rectangle drag is this tool's entire gesture - unlike Select, it does
    // not care about the mouse/arrow mode toggle. Reuses the SAME 'marquee'
    // drag behavior PdfViewer already implements for multi-select; the
    // handler branches on which tool is active, not the drag mechanism.
    return { cursor: tool.cursor, leftDrag: 'marquee', rightDrag: 'pan' }
  }
  if (isDrawingTool(tool)) {
    // Left places points, so panning moves to the right button.
    return { cursor: tool.cursor, leftDrag: 'none', rightDrag: 'pan' }
  }
  if (tool.leftButton === 'pan') {
    return { cursor: tool.cursor, leftDrag: 'pan', rightDrag: 'pan' }
  }
  // A selection tool. Mouse mode drives the document with the left button and
  // marquees with the right; arrow mode is the conventional pointer.
  return mode === 'mouse'
    ? { cursor: 'grab', leftDrag: 'pan', rightDrag: 'marquee' }
    : { cursor: tool.cursor, leftDrag: 'marquee', rightDrag: 'marquee' }
}

/**
 * Which drag a mouse button starts. Middle-drag pans from any mode and any
 * tool, which is why it is checked before anything tool-specific.
 */
export function behaviorForButton(button: number, interaction: InteractionConfig): DragBehavior {
  if (button === 1) return 'pan'
  if (button === 0) return interaction.leftDrag
  if (button === 2) return interaction.rightDrag
  return 'none'
}
