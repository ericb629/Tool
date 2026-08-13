import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { pruneOrphanLinks } from '../src/main/manifest/prune'
import type { FileManifest, LinkRecord, PdfFileManifest, SpreadsheetFileManifest } from '../src/shared/manifest/types'

const NOW = '2026-01-01T00:00:00.000Z'

function pdfManifest(fileId: string, markupIds: string[]): PdfFileManifest {
  return {
    schemaVersion: 1,
    fileId,
    fileType: 'pdf',
    updatedAt: NOW,
    pages: [{ pageNumber: 1 }],
    markups: markupIds.map((id) => ({
      id,
      pageNumber: 1,
      layerId: 'layer-1',
      type: 'polyline' as const,
      takeoff: { mode: 'linear' as const, unit: 'ft' as const },
      geometry: { kind: 'polyline' as const, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
      style: { color: '#000' },
      createdAt: NOW,
      updatedAt: NOW
    }))
  }
}

function spreadsheetManifest(fileId: string): SpreadsheetFileManifest {
  return {
    schemaVersion: 1,
    fileId,
    fileType: 'spreadsheet',
    updatedAt: NOW,
    sheets: [{ sheetName: 'Takeoff' }]
  }
}

function link(overrides: Partial<LinkRecord> = {}): LinkRecord {
  return {
    id: 'link-1',
    markupId: 'markup-1',
    sourceFileId: 'pdf-1',
    target: { fileId: 'sheet-1', sheetName: 'Takeoff', rowIndex: 0 },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  }
}

function filesMap(entries: FileManifest[]): Map<string, FileManifest> {
  return new Map(entries.map((f) => [f.fileId, f]))
}

describe('pruneOrphanLinks', () => {
  const intactFiles = filesMap([pdfManifest('pdf-1', ['markup-1']), spreadsheetManifest('sheet-1')])

  it('keeps a link whose source markup and target sheet both exist', () => {
    const result = pruneOrphanLinks([link()], intactFiles)
    assert.equal(result.length, 1)
  })

  it('drops a link whose source PDF is gone', () => {
    const files = filesMap([spreadsheetManifest('sheet-1')])
    assert.deepEqual(pruneOrphanLinks([link()], files), [])
  })

  it('drops a link whose source markup was deleted from an existing PDF', () => {
    const files = filesMap([pdfManifest('pdf-1', ['some-other-markup']), spreadsheetManifest('sheet-1')])
    assert.deepEqual(pruneOrphanLinks([link()], files), [])
  })

  // This is the case the audit found unhandled: the spreadsheet side.
  it('drops a link whose TARGET spreadsheet is gone', () => {
    const files = filesMap([pdfManifest('pdf-1', ['markup-1'])])
    assert.deepEqual(pruneOrphanLinks([link()], files), [])
  })

  it('drops a link whose target fileId points at a PDF rather than a spreadsheet', () => {
    const files = filesMap([pdfManifest('pdf-1', ['markup-1']), pdfManifest('pdf-2', [])])
    const bad = link({ target: { fileId: 'pdf-2', sheetName: 'Takeoff', rowIndex: 0 } })
    assert.deepEqual(pruneOrphanLinks([bad], files), [])
  })

  it('drops a link whose source fileId points at a spreadsheet rather than a PDF', () => {
    const files = filesMap([spreadsheetManifest('sheet-1'), spreadsheetManifest('sheet-2')])
    const bad = link({ sourceFileId: 'sheet-2' })
    assert.deepEqual(pruneOrphanLinks([bad], files), [])
  })

  it('prunes only the orphaned links and keeps the rest', () => {
    const files = filesMap([pdfManifest('pdf-1', ['markup-1', 'markup-2']), spreadsheetManifest('sheet-1')])
    const links = [
      link({ id: 'keep-1', markupId: 'markup-1' }),
      link({ id: 'drop-1', markupId: 'gone' }),
      link({ id: 'keep-2', markupId: 'markup-2' }),
      link({ id: 'drop-2', target: { fileId: 'missing-sheet', sheetName: 'Takeoff', rowIndex: 0 } })
    ]
    const kept = pruneOrphanLinks(links, files).map((l) => l.id)
    assert.deepEqual(kept, ['keep-1', 'keep-2'])
  })

  it('is idempotent', () => {
    const links = [link(), link({ id: 'orphan', markupId: 'gone' })]
    const once = pruneOrphanLinks(links, intactFiles)
    const twice = pruneOrphanLinks(once, intactFiles)
    assert.deepEqual(once, twice)
  })
})
