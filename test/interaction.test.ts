import { describe, expect, it } from 'vitest'
import { behaviorForButton, resolveInteraction } from '../src/renderer/src/tools/interaction'
import { TOOLS, TOOL_BY_ID, isDrawingTool } from '../src/renderer/src/tools/registry'

const LEFT = 0
const MIDDLE = 1
const RIGHT = 2

const select = TOOL_BY_ID.select
const pan = TOOL_BY_ID.pan
const linear = TOOL_BY_ID.linear
const calibrate = TOOL_BY_ID.calibrate

describe('interaction arbitration', () => {
  describe('mouse mode with a selection tool', () => {
    const config = resolveInteraction(select, 'mouse')

    it('pans on left-drag and marquees on right-drag', () => {
      expect(behaviorForButton(LEFT, config)).toBe('pan')
      expect(behaviorForButton(RIGHT, config)).toBe('marquee')
    })

    it('shows a grab cursor', () => {
      expect(config.cursor).toBe('grab')
    })
  })

  describe('arrow mode', () => {
    const config = resolveInteraction(select, 'arrow')

    it('marquees on left-drag, leaving left-click free to select', () => {
      expect(behaviorForButton(LEFT, config)).toBe('marquee')
    })

    it('still marquees on right-drag', () => {
      expect(behaviorForButton(RIGHT, config)).toBe('marquee')
    })

    it('shows a standard pointer, not a grab hand', () => {
      expect(config.cursor).toBe('default')
    })
  })

  describe('while a drawing tool is active', () => {
    // The rule this suite exists to pin down: right-drag PANS here, and
    // marquees when a selection tool is active.
    it.each([
      ['linear', linear],
      ['calibrate', calibrate]
    ])('%s: left places points and right-drag pans', (_name, tool) => {
      for (const mode of ['mouse', 'arrow'] as const) {
        const config = resolveInteraction(tool, mode)
        // 'none' means the viewer ignores the left button entirely, so the
        // page canvas receives the click as a point placement.
        expect(behaviorForButton(LEFT, config)).toBe('none')
        expect(behaviorForButton(RIGHT, config)).toBe('pan')
      }
    })

    it('never marquees on any button, in either mode', () => {
      for (const tool of TOOLS.filter(isDrawingTool)) {
        for (const mode of ['mouse', 'arrow'] as const) {
          const config = resolveInteraction(tool, mode)
          for (const button of [LEFT, MIDDLE, RIGHT]) {
            expect(behaviorForButton(button, config)).not.toBe('marquee')
          }
        }
      }
    })

    it('keeps the tool cursor rather than a grab hand', () => {
      expect(resolveInteraction(linear, 'mouse').cursor).toBe(linear.cursor)
    })
  })

  describe('the pan tool', () => {
    it('pans on both left and right, in either mode', () => {
      for (const mode of ['mouse', 'arrow'] as const) {
        const config = resolveInteraction(pan, mode)
        expect(behaviorForButton(LEFT, config)).toBe('pan')
        expect(behaviorForButton(RIGHT, config)).toBe('pan')
      }
    })
  })

  it('middle-drag pans from every mode and every tool', () => {
    for (const tool of TOOLS) {
      for (const mode of ['mouse', 'arrow'] as const) {
        expect(behaviorForButton(MIDDLE, resolveInteraction(tool, mode))).toBe('pan')
      }
    }
  })

  it('ignores buttons it does not own, so back/forward do not pan', () => {
    const config = resolveInteraction(select, 'mouse')
    expect(behaviorForButton(3, config)).toBe('none')
    expect(behaviorForButton(4, config)).toBe('none')
  })

  it('resolves a config for every registered tool without a hardcoded switch', () => {
    // A newly registered tool must produce a usable config on its own; if it
    // does not, the registry entry is incomplete rather than the arbitration.
    for (const tool of TOOLS) {
      for (const mode of ['mouse', 'arrow'] as const) {
        const config = resolveInteraction(tool, mode)
        expect(config.cursor).toBeTruthy()
        expect(['pan', 'marquee', 'none']).toContain(config.leftDrag)
        expect(['pan', 'marquee']).toContain(config.rightDrag)
      }
    }
  })
})

describe('tool registry', () => {
  it('declares what every drawing tool produces, so the validity matrix applies', () => {
    for (const tool of TOOLS) {
      if (!tool.produces) continue
      expect(tool.buildGeometry).toBeTypeOf('function')
      expect(tool.buildTakeoff).toBeTypeOf('function')
      // The declared geometry kind must match what the builder actually makes.
      const built = tool.buildGeometry!([
        { x: 0, y: 0 },
        { x: 10, y: 0 }
      ])
      expect(built.kind).toBe(tool.produces.geometryKind)
      expect(tool.buildTakeoff!('ft').mode).toBe(tool.produces.takeoffMode)
    }
  })

  it('treats calibration as a drawing tool that produces no markup', () => {
    expect(isDrawingTool(calibrate)).toBe(true)
    expect(calibrate.produces).toBeUndefined()
    expect(calibrate.isCalibration).toBe(true)
  })

  it('has unique ids', () => {
    expect(new Set(TOOLS.map((t) => t.id)).size).toBe(TOOLS.length)
  })
})
