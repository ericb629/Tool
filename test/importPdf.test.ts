import { strict as assert } from 'node:assert'
import { afterAll, describe, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { ManifestStore } from '../src/main/manifest/store'

const cleanup: string[] = []

async function newProject(): Promise<{ root: string; store: ManifestStore; source: string }> {
  const base = join(tmpdir(), `tool-import-test-${randomUUID()}`)
  const root = join(base, 'project')
  const incoming = join(base, 'incoming')
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(incoming, { recursive: true })
  const source = join(incoming, 'C-101.pdf')
  await fs.writeFile(source, '%PDF-1.4\ntest\n')
  cleanup.push(base)
  const store = new ManifestStore()
  await store.create(root)
  return { root, store, source }
}

afterAll(async () => {
  for (const dir of cleanup) await fs.rm(dir, { recursive: true, force: true })
})

describe('importPdf', () => {
  it('copies the PDF into the project drawings/ folder', async () => {
    const { root, store, source } = await newProject()
    const { fileId } = await store.importPdf(source)

    const copied = join(root, 'drawings', 'C-101.pdf')
    assert.ok(
      await fs.stat(copied).then(() => true, () => false),
      'the PDF must be copied into drawings/ so the project folder is self-contained'
    )
    // The original must be left alone.
    assert.ok(await fs.stat(source).then(() => true, () => false), 'the source file must not be moved or deleted')

    const state = store.getState()
    const entry = state.files.find((f) => f.fileId === fileId)
    assert.ok(entry)
    assert.equal(entry.fileType, 'pdf')
    assert.equal(entry.sourceStatus, 'ok')
    assert.equal(entry.manifestStatus, 'ok')
  })

  it('records a project-relative path, never an absolute one', async () => {
    const { store, source } = await newProject()
    const { fileId, state } = await store.importPdf(source)
    const entry = state.files.find((f) => f.fileId === fileId)
    assert.ok(entry)
    // An absolute path here would defeat the protocol handler's containment
    // check and break the project if the folder is ever moved.
    assert.equal(entry.relativePath, 'drawings/C-101.pdf')
    assert.ok(!entry.relativePath.includes(':'), 'relativePath must not be absolute')
  })

  it('does not overwrite an existing drawing with the same filename', async () => {
    const { root, store, source } = await newProject()
    await store.importPdf(source)
    await fs.writeFile(source, '%PDF-1.4\nsecond distinct file\n')
    await store.importPdf(source)

    const drawings = (await fs.readdir(join(root, 'drawings'))).sort()
    assert.equal(drawings.length, 2, `expected both imports to survive, got ${JSON.stringify(drawings)}`)

    const state = store.getState()
    assert.equal(state.files.filter((f) => f.fileType === 'pdf').length, 2)
    const paths = state.files.map((f) => f.relativePath)
    assert.equal(new Set(paths).size, paths.length, 'each import must get its own path')
  })

  it('assigns a distinct fileId per import', async () => {
    const { store, source } = await newProject()
    const a = await store.importPdf(source)
    const b = await store.importPdf(source)
    assert.notEqual(a.fileId, b.fileId)
  })

  it('survives a close and reopen', async () => {
    const { root, store, source } = await newProject()
    const { fileId } = await store.importPdf(source)

    const reopened = await new ManifestStore().open(root)
    const entry = reopened.files.find((f) => f.fileId === fileId)
    assert.ok(entry, 'the imported PDF must still be listed after reopening')
    assert.equal(entry.sourceStatus, 'ok')
    assert.equal(entry.manifestStatus, 'ok')
  })

  it('refuses to import when no project is open', async () => {
    await assert.rejects(() => new ManifestStore().importPdf('C:/nowhere/x.pdf'), /No project is open/)
  })
})

describe('ensurePages', () => {
  it('backfills a record for every page and is idempotent', async () => {
    const { store, source } = await newProject()
    const { fileId } = await store.importPdf(source)

    assert.equal(store.ensurePages(fileId, 12), true)
    const pdf = store.getState().files.find((f) => f.fileId === fileId)!.manifest
    assert.ok(pdf.fileType === 'pdf')
    if (pdf.fileType !== 'pdf') return
    assert.deepEqual(pdf.pages.map((p) => p.pageNumber), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])

    // Second call changes nothing, so it must not dirty the project.
    assert.equal(store.ensurePages(fileId, 12), false)
  })

  it('preserves an existing calibration when backfilling', async () => {
    const { store, source } = await newProject()
    const { fileId } = await store.importPdf(source)
    store.updatePageCalibration(fileId, {
      pageNumber: 3,
      pointA: { x: 0, y: 0 },
      pointB: { x: 100, y: 0 },
      realDistance: 50,
      unit: 'ft'
    })
    store.ensurePages(fileId, 6)

    const pdf = store.getState().files.find((f) => f.fileId === fileId)!.manifest
    if (pdf.fileType !== 'pdf') return
    assert.equal(pdf.pages.length, 6)
    const page3 = pdf.pages.find((p) => p.pageNumber === 3)
    assert.ok(page3?.calibration, 'backfilling must not wipe an existing calibration')
    assert.equal(page3.calibration.realDistance, 50)
  })

  it('does not drop records for pages beyond a shrunken page count', async () => {
    const { store, source } = await newProject()
    const { fileId } = await store.importPdf(source)
    store.ensurePages(fileId, 10)
    store.ensurePages(fileId, 3)

    const pdf = store.getState().files.find((f) => f.fileId === fileId)!.manifest
    if (pdf.fileType !== 'pdf') return
    assert.equal(pdf.pages.length, 10, 'a smaller page count must not silently delete page records')
  })

  it('rejects a nonsensical page count instead of writing it', async () => {
    const { store, source } = await newProject()
    const { fileId } = await store.importPdf(source)
    assert.throws(() => store.ensurePages(fileId, 0), /Invalid page count/)
    assert.throws(() => store.ensurePages(fileId, -1), /Invalid page count/)
    assert.throws(() => store.ensurePages(fileId, 1.5), /Invalid page count/)
  })
})
