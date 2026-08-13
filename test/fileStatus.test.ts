import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { describeFileStatus } from '../src/renderer/src/fileStatus'

describe('describeFileStatus', () => {
  it('says nothing when both the document and its sidecar are present', () => {
    const notice = describeFileStatus({ sourceStatus: 'ok', manifestStatus: 'ok' })
    assert.equal(notice.severity, 'ok')
    assert.equal(notice.label, '')
  })

  it('warns, but does not alarm, when only the source document is gone', () => {
    const notice = describeFileStatus({ sourceStatus: 'missing', manifestStatus: 'ok' })
    assert.equal(notice.severity, 'warning')
    assert.match(notice.detail, /markups are intact/i)
  })

  it('treats a missing sidecar as an error, and does not claim the file was empty', () => {
    const notice = describeFileStatus({ sourceStatus: 'ok', manifestStatus: 'missing' })
    assert.equal(notice.severity, 'error')
    assert.match(notice.detail, /likely lost/i)
    assert.match(notice.detail, /not confirmed empty/i)
  })

  it('mentions BOTH problems when both are missing', () => {
    const notice = describeFileStatus({ sourceStatus: 'missing', manifestStatus: 'missing' })
    assert.equal(notice.severity, 'error')
    // The regression this guards: reporting only one of the two conditions.
    assert.match(notice.label, /file/i)
    assert.match(notice.label, /markup/i)
    assert.match(notice.detail, /Neither/i)
  })

  it('produces a distinct message for every combination', () => {
    const combos = [
      { sourceStatus: 'ok', manifestStatus: 'ok' },
      { sourceStatus: 'missing', manifestStatus: 'ok' },
      { sourceStatus: 'ok', manifestStatus: 'missing' },
      { sourceStatus: 'missing', manifestStatus: 'missing' }
    ] as const
    const labels = combos.map((c) => describeFileStatus(c).label)
    assert.equal(new Set(labels).size, combos.length, `messages collapsed: ${JSON.stringify(labels)}`)
  })
})
