import { strict as assert } from 'node:assert'
import { afterAll, describe, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { ManifestStore } from '../src/main/manifest/store'
import type { MarkupObject, PageCalibration } from '../src/shared/manifest/types'

const NOW = '2026-01-01T00:00:00.000Z'
const roots: string[] = []

async function newProjectRoot(): Promise<string> {
  const root = join(tmpdir(), `tool-store-test-${randomUUID()}`)
  await fs.mkdir(root, { recursive: true })
  roots.push(root)
  return root
}

afterAll(async () => {
  for (const root of roots) {
    await fs.rm(root, { recursive: true, force: true })
  }
})

function polyline(id: string, points: Array<{ x: number; y: number }>): MarkupObject {
  return {
    id,
    pageNumber: 1,
    layerId: 'layer-1',
    type: 'polyline',
    takeoff: { mode: 'linear', unit: 'ft' },
    geometry: { kind: 'polyline', points },
    style: { color: '#e63946' },
    createdAt: NOW,
    updatedAt: NOW
  }
}

const calibration: PageCalibration = {
  pageNumber: 1,
  pointA: { x: 0, y: 0 },
  pointB: { x: 100, y: 0 },
  realDistance: 100,
  unit: 'ft'
}

describe('ManifestStore round-trip', () => {
  it('persists a markup and a calibration across close and reopen', async () => {
    const root = await newProjectRoot()

    const writer = new ManifestStore()
    await writer.create(root)
    const fileId = writer.addFile('pdfs/sheet.pdf', 'pdf')
    writer.updatePageCalibration(fileId, calibration)
    writer.updateMarkup(fileId, polyline('markup-1', [{ x: 0, y: 0 }, { x: 300, y: 400 }]))
    await writer.save()

    // A completely fresh store, as if the app had been restarted.
    const reader = new ManifestStore()
    const state = await reader.open(root)

    const file = state.files.find((f) => f.fileId === fileId)
    assert.ok(file, 'file entry survived the reopen')
    assert.equal(file.manifest.fileType, 'pdf')
    if (file.manifest.fileType !== 'pdf') return

    assert.equal(file.manifest.markups.length, 1)
    assert.deepEqual(file.manifest.markups[0].geometry, {
      kind: 'polyline',
      points: [{ x: 0, y: 0 }, { x: 300, y: 400 }]
    })
    assert.deepEqual(file.manifest.pages[0].calibration, calibration)
  })

  it('seeds exactly one default layer so markups have a valid layerId', async () => {
    const root = await newProjectRoot()
    const store = new ManifestStore()
    const state = await store.create(root)
    assert.equal(state.layers.length, 1)
    assert.ok(state.layers[0].id)
  })

  it('rejects an invalid type/takeoff combination before it reaches disk', async () => {
    const root = await newProjectRoot()
    const store = new ManifestStore()
    await store.create(root)
    const fileId = store.addFile('pdfs/sheet.pdf', 'pdf')

    const illegal = {
      ...polyline('bad-1', [{ x: 0, y: 0 }, { x: 1, y: 1 }]),
      takeoff: { mode: 'count' as const, symbolId: 'sym-1' }
    }
    assert.throws(() => store.updateMarkup(fileId, illegal), /cannot use takeoff mode/)

    await store.save()
    const reader = new ManifestStore()
    const state = await reader.open(root)
    const file = state.files.find((f) => f.fileId === fileId)
    assert.ok(file && file.manifest.fileType === 'pdf' && file.manifest.markups.length === 0)
  })

  it('refuses to hold markups on a spreadsheet file', async () => {
    const root = await newProjectRoot()
    const store = new ManifestStore()
    await store.create(root)
    const sheetId = store.addFile('sheets/takeoff.xlsx', 'spreadsheet')
    assert.throws(() => store.updateMarkup(sheetId, polyline('m', [{ x: 0, y: 0 }])), /not a PDF/)
  })

  it('updates an existing markup in place rather than appending a duplicate', async () => {
    const root = await newProjectRoot()
    const store = new ManifestStore()
    await store.create(root)
    const fileId = store.addFile('pdfs/sheet.pdf', 'pdf')

    store.updateMarkup(fileId, polyline('markup-1', [{ x: 0, y: 0 }, { x: 100, y: 0 }]))
    store.updateMarkup(fileId, polyline('markup-1', [{ x: 0, y: 0 }, { x: 200, y: 0 }]))
    await store.save()

    const state = await new ManifestStore().open(root)
    const file = state.files.find((f) => f.fileId === fileId)
    assert.ok(file && file.manifest.fileType === 'pdf')
    if (file.manifest.fileType !== 'pdf') return
    assert.equal(file.manifest.markups.length, 1)
    assert.deepEqual(file.manifest.markups[0].geometry.kind === 'polyline' && file.manifest.markups[0].geometry.points, [
      { x: 0, y: 0 },
      { x: 200, y: 0 }
    ])
  })
})

/**
 * Source presence and sidecar presence are independent, so all four
 * combinations are exercised - in particular the both-missing case, which a
 * single combined status field would have collapsed into one of the others.
 */
describe('source and manifest presence are reported independently', () => {
  async function projectWithFile(opts: {
    writeSource: boolean
    keepSidecar: boolean
  }): Promise<{ sourceStatus: string; manifestStatus: string; markupCount: number }> {
    const root = await newProjectRoot()
    const store = new ManifestStore()
    await store.create(root)
    const fileId = store.addFile('drawings/sheet.pdf', 'pdf')
    store.updateMarkup(fileId, polyline('markup-1', [{ x: 0, y: 0 }, { x: 300, y: 400 }]))
    await store.save()

    if (opts.writeSource) {
      await fs.mkdir(join(root, 'drawings'), { recursive: true })
      await fs.writeFile(join(root, 'drawings', 'sheet.pdf'), '%PDF-1.4\n')
    }
    if (!opts.keepSidecar) {
      await fs.rm(join(root, '.manifest', `${fileId}.json`))
    }

    const state = await new ManifestStore().open(root)
    const file = state.files.find((f) => f.fileId === fileId)
    assert.ok(file, 'file entry should still be listed in project.json')
    return {
      sourceStatus: file.sourceStatus,
      manifestStatus: file.manifestStatus,
      markupCount: file.manifest.fileType === 'pdf' ? file.manifest.markups.length : -1
    }
  }

  it('both present -> ok / ok', async () => {
    const r = await projectWithFile({ writeSource: true, keepSidecar: true })
    assert.equal(r.sourceStatus, 'ok')
    assert.equal(r.manifestStatus, 'ok')
    assert.equal(r.markupCount, 1)
  })

  it('source gone, sidecar intact -> missing / ok, markups preserved', async () => {
    const r = await projectWithFile({ writeSource: false, keepSidecar: true })
    assert.equal(r.sourceStatus, 'missing')
    assert.equal(r.manifestStatus, 'ok')
    assert.equal(r.markupCount, 1, 'losing the PDF must not lose its markups')
  })

  it('source intact, sidecar gone -> ok / missing', async () => {
    const r = await projectWithFile({ writeSource: true, keepSidecar: false })
    assert.equal(r.sourceStatus, 'ok')
    assert.equal(
      r.manifestStatus,
      'missing',
      'a vanished sidecar must be reported, not quietly replaced with an empty manifest'
    )
  })

  // The case a single combined enum hid: one condition masked the other.
  it('both gone -> missing / missing, neither condition masks the other', async () => {
    const r = await projectWithFile({ writeSource: false, keepSidecar: false })
    assert.equal(r.sourceStatus, 'missing', 'the absent PDF must stay visible even when the sidecar is also gone')
    assert.equal(r.manifestStatus, 'missing')
  })
})

describe('save ordering and atomicity', () => {
  it('writes project.json last, after every sidecar it indexes', async () => {
    const root = await newProjectRoot()
    const store = new ManifestStore()
    await store.create(root)
    const fileId = store.addFile('pdfs/sheet.pdf', 'pdf')
    store.updateMarkup(fileId, polyline('markup-1', [{ x: 0, y: 0 }, { x: 1, y: 1 }]))
    await store.save()

    const dir = join(root, '.manifest')
    const projectStat = await fs.stat(join(dir, 'project.json'))
    const sidecarStat = await fs.stat(join(dir, `${fileId}.json`))
    assert.ok(
      projectStat.mtimeMs >= sidecarStat.mtimeMs,
      'project.json must not be written before the sidecars it references'
    )
  })

  it('leaves no .tmp- files behind after a successful save', async () => {
    const root = await newProjectRoot()
    const store = new ManifestStore()
    await store.create(root)
    const fileId = store.addFile('pdfs/sheet.pdf', 'pdf')
    store.updateMarkup(fileId, polyline('markup-1', [{ x: 0, y: 0 }, { x: 1, y: 1 }]))
    await store.save()

    const entries = await fs.readdir(join(root, '.manifest'))
    assert.deepEqual(entries.filter((e) => e.includes('.tmp-')), [])
  })

  it('every written manifest file is complete, parseable JSON', async () => {
    const root = await newProjectRoot()
    const store = new ManifestStore()
    await store.create(root)
    const fileId = store.addFile('pdfs/sheet.pdf', 'pdf')
    store.updateMarkup(fileId, polyline('markup-1', [{ x: 0, y: 0 }, { x: 1, y: 1 }]))
    await store.save()

    const dir = join(root, '.manifest')
    for (const entry of await fs.readdir(dir)) {
      const raw = await fs.readFile(join(dir, entry), 'utf-8')
      assert.doesNotThrow(() => JSON.parse(raw), `${entry} is not complete JSON`)
    }
  })

  it('refuses to create a project where one already exists', async () => {
    const root = await newProjectRoot()
    await new ManifestStore().create(root)
    await assert.rejects(() => new ManifestStore().create(root), /already exists/)
  })

  it('fails loudly when opening a folder that is not a project', async () => {
    const root = await newProjectRoot()
    await assert.rejects(() => new ManifestStore().open(root), /No project found/)
  })
})

describe('no derived quantity is ever written to disk', () => {
  it('persisted markup JSON contains no length/area/volume/count field', async () => {
    const root = await newProjectRoot()
    const store = new ManifestStore()
    await store.create(root)
    const fileId = store.addFile('pdfs/sheet.pdf', 'pdf')
    store.updatePageCalibration(fileId, calibration)
    store.updateMarkup(fileId, polyline('markup-1', [{ x: 0, y: 0 }, { x: 300, y: 400 }]))
    await store.save()

    const raw = await fs.readFile(join(root, '.manifest', `${fileId}.json`), 'utf-8')
    for (const forbidden of ['"length"', '"area"', '"volume"', '"count"', '"quantity"']) {
      assert.ok(!raw.includes(forbidden), `sidecar must not persist a derived ${forbidden} field`)
    }
  })

  it('calibration stores both endpoints but not the derived user-space distance', async () => {
    const root = await newProjectRoot()
    const store = new ManifestStore()
    await store.create(root)
    const fileId = store.addFile('pdfs/sheet.pdf', 'pdf')
    store.updatePageCalibration(fileId, calibration)
    await store.save()

    const raw = JSON.parse(await fs.readFile(join(root, '.manifest', `${fileId}.json`), 'utf-8'))
    const stored = raw.pages[0].calibration
    assert.deepEqual(stored.pointA, { x: 0, y: 0 })
    assert.deepEqual(stored.pointB, { x: 100, y: 0 })
    assert.deepEqual(Object.keys(stored).sort(), ['pageNumber', 'pointA', 'pointB', 'realDistance', 'unit'])
  })
})
