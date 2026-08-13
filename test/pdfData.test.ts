import { strict as assert } from 'node:assert'
import { afterAll, describe, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { INITIAL_CHUNK_BYTES, MAX_CHUNK_BYTES, PdfDataReader } from '../src/main/pdfData'
import { ManifestStore } from '../src/main/manifest/store'

const cleanup: string[] = []

/** Recognisable byte pattern so a wrong offset produces a wrong value, not just a wrong length. */
function pattern(size: number): Buffer {
  const buf = Buffer.allocUnsafe(size)
  for (let i = 0; i < size; i++) buf[i] = i % 251
  return buf
}

async function setup(size = 500_000): Promise<{
  reader: PdfDataReader
  fileId: string
  root: string
  contents: Buffer
  store: ManifestStore
}> {
  const base = join(tmpdir(), `tool-pdfdata-${randomUUID()}`)
  const root = join(base, 'project')
  await fs.mkdir(join(root, 'drawings'), { recursive: true })
  cleanup.push(base)

  const contents = pattern(size)
  await fs.writeFile(join(root, 'drawings', 'sheet.pdf'), contents)

  const store = new ManifestStore()
  await store.create(root)
  const fileId = store.addFile('drawings/sheet.pdf', 'pdf')
  await store.save()

  return { reader: new PdfDataReader(store), fileId, root, contents, store }
}

afterAll(async () => {
  for (const dir of cleanup) await fs.rm(dir, { recursive: true, force: true })
})

describe('PdfDataReader.openDocument', () => {
  it('reports the true byte length and returns an initial chunk', async () => {
    const { reader, fileId, contents } = await setup()
    const { length, initialData } = await reader.openDocument(fileId)
    assert.equal(length, contents.length)
    assert.equal(initialData.length, INITIAL_CHUNK_BYTES)
    assert.deepEqual(Buffer.from(initialData), contents.subarray(0, INITIAL_CHUNK_BYTES))
    await reader.closeDocument(fileId)
  })

  it('does not over-read the initial chunk for a file smaller than it', async () => {
    const { reader, fileId, contents } = await setup(1000)
    const { length, initialData } = await reader.openDocument(fileId)
    assert.equal(length, 1000)
    assert.equal(initialData.length, 1000)
    assert.deepEqual(Buffer.from(initialData), contents)
    await reader.closeDocument(fileId)
  })

  it('rejects an unknown fileId', async () => {
    const { reader } = await setup()
    await assert.rejects(() => reader.openDocument('not-a-file'), /Unknown fileId/)
  })

  it('rejects a file that has been removed from disk', async () => {
    const { reader, fileId, root } = await setup()
    await fs.rm(join(root, 'drawings', 'sheet.pdf'))
    await assert.rejects(() => reader.openDocument(fileId), /unavailable/i)
  })

  it('rejects a manifest entry pointing outside the project root', async () => {
    // The containment check must apply here too, not only on the old
    // protocol path - relativePath comes off disk and is untrusted.
    const { reader, store, root } = await setup()
    const outside = join(root, '..', 'outside')
    await fs.mkdir(outside, { recursive: true })
    await fs.writeFile(join(outside, 'secrets.pdf'), 'not yours')
    const escapeId = store.addFile('../outside/secrets.pdf', 'pdf')
    await assert.rejects(() => reader.openDocument(escapeId), /unavailable/i)
  })
})

describe('PdfDataReader.readRange', () => {
  it('treats end as EXCLUSIVE, matching pdf.js requestDataRange', async () => {
    // pdf.js builds `bytes=${begin}-${end - 1}`. An inclusive read here would
    // shift every chunk by one byte and corrupt documents in a way that
    // still parses for a while.
    const { reader, fileId, contents } = await setup()
    await reader.openDocument(fileId)
    const chunk = await reader.readRange(fileId, 100, 200)
    assert.equal(chunk.length, 100, 'end is exclusive: [100, 200) is 100 bytes')
    assert.deepEqual(Buffer.from(chunk), contents.subarray(100, 200))
    await reader.closeDocument(fileId)
  })

  it('returns the exact bytes at the requested offset', async () => {
    const { reader, fileId, contents } = await setup()
    await reader.openDocument(fileId)
    for (const [begin, end] of [
      [0, 10],
      [1234, 5678],
      [contents.length - 100, contents.length]
    ]) {
      const chunk = await reader.readRange(fileId, begin, end)
      assert.deepEqual(Buffer.from(chunk), contents.subarray(begin, end), `wrong bytes for [${begin}, ${end})`)
    }
    await reader.closeDocument(fileId)
  })

  it('clamps a range extending past EOF', async () => {
    const { reader, fileId, contents } = await setup()
    await reader.openDocument(fileId)
    const chunk = await reader.readRange(fileId, contents.length - 50, contents.length + 5000)
    assert.equal(chunk.length, 50)
    assert.deepEqual(Buffer.from(chunk), contents.subarray(contents.length - 50))
    await reader.closeDocument(fileId)
  })

  it('returns empty for a degenerate or past-EOF range rather than throwing', async () => {
    const { reader, fileId, contents } = await setup()
    await reader.openDocument(fileId)
    assert.equal((await reader.readRange(fileId, 5, 5)).length, 0)
    assert.equal((await reader.readRange(fileId, 200, 100)).length, 0)
    assert.equal((await reader.readRange(fileId, contents.length + 10, contents.length + 20)).length, 0)
    await reader.closeDocument(fileId)
  })

  it('refuses a chunk larger than the cap, so one call cannot pull the file', async () => {
    // Needs a file bigger than the cap: a request past EOF is clamped to the
    // file length first, so on a small file there is nothing to refuse.
    const { reader, fileId } = await setup(MAX_CHUNK_BYTES + 100_000)
    await reader.openDocument(fileId)
    await assert.rejects(() => reader.readRange(fileId, 0, MAX_CHUNK_BYTES + 1), /exceeds/)
    // Right at the cap is still allowed.
    const ok = await reader.readRange(fileId, 0, MAX_CHUNK_BYTES)
    assert.equal(ok.length, MAX_CHUNK_BYTES)
    await reader.closeDocument(fileId)
  })

  it('rejects non-integer offsets', async () => {
    const { reader, fileId } = await setup()
    await reader.openDocument(fileId)
    await assert.rejects(() => reader.readRange(fileId, 1.5, 10), /Invalid range/)
    await assert.rejects(() => reader.readRange(fileId, 0, Number.NaN), /Invalid range/)
    await reader.closeDocument(fileId)
  })

  it('refuses to read a document that is not open', async () => {
    const { reader, fileId } = await setup()
    await assert.rejects(() => reader.readRange(fileId, 0, 10), /not open/)
  })
})

describe('handle lifecycle', () => {
  it('releases the handle on close', async () => {
    const { reader, fileId } = await setup()
    await reader.openDocument(fileId)
    assert.equal(reader.openCount, 1)
    await reader.closeDocument(fileId)
    assert.equal(reader.openCount, 0)
  })

  it('is safe to close twice or close something never opened', async () => {
    const { reader, fileId } = await setup()
    await reader.openDocument(fileId)
    await reader.closeDocument(fileId)
    await reader.closeDocument(fileId)
    await reader.closeDocument('never-opened')
    assert.equal(reader.openCount, 0)
  })

  it('does not leak a handle when the same document is reopened', async () => {
    const { reader, fileId } = await setup()
    await reader.openDocument(fileId)
    await reader.openDocument(fileId)
    await reader.openDocument(fileId)
    assert.equal(reader.openCount, 1, 'reopening must replace, not accumulate, handles')
    await reader.closeDocument(fileId)
  })

  it('closeAll releases everything', async () => {
    const { reader, fileId, store } = await setup()
    const second = store.addFile('drawings/sheet.pdf', 'pdf')
    await reader.openDocument(fileId)
    await reader.openDocument(second)
    assert.equal(reader.openCount, 2)
    await reader.closeAll()
    assert.equal(reader.openCount, 0)
  })

  it('a closed document can be reopened and read again', async () => {
    const { reader, fileId, contents } = await setup()
    await reader.openDocument(fileId)
    await reader.closeDocument(fileId)
    await reader.openDocument(fileId)
    const chunk = await reader.readRange(fileId, 0, 16)
    assert.deepEqual(Buffer.from(chunk), contents.subarray(0, 16))
    await reader.closeDocument(fileId)
  })
})

/**
 * Overlapping opens of the SAME document.
 *
 * React StrictMode double-invokes effects in dev, so the viewer opens a file,
 * is torn down before its open resolves, and opens it again. The teardown of
 * the first attempt must not close the document the second attempt is using -
 * and because readRange answers a closed id with an EMPTY chunk (to keep
 * genuine teardown quiet), getting this wrong does not raise: pdf.js simply
 * waits for bytes that never arrive and the viewer says "Loading PDF..."
 * forever. Only files larger than the initial chunk are affected, because a
 * small one never range-requests at all.
 */
describe('overlapping opens', () => {
  it('survives a stale opener closing while a live one is in use', async () => {
    const { reader, fileId, contents } = await setup(500_000)

    // Both effect invocations open before either resolves.
    const [, second] = await Promise.all([reader.openDocument(fileId), reader.openDocument(fileId)])
    assert.equal(second.length, contents.length)

    // The first (cancelled) invocation now tears itself down.
    await reader.closeDocument(fileId)

    // The live document must still serve real bytes, not an empty chunk.
    const begin = INITIAL_CHUNK_BYTES
    const chunk = await reader.readRange(fileId, begin, begin + 1024)
    assert.equal(chunk.length, 1024, 'live document served an empty chunk after a stale close')
    assert.deepEqual(Buffer.from(chunk), contents.subarray(begin, begin + 1024))

    await reader.closeDocument(fileId)
    assert.equal(reader.openCount, 0, 'handle still held after the last close')
  })

  it('shares one handle across racing opens and closes it on the last release', async () => {
    const { reader, fileId } = await setup(500_000)
    await Promise.all([reader.openDocument(fileId), reader.openDocument(fileId), reader.openDocument(fileId)])
    // One handle, three holders. Opening three times and storing each over the
    // last would leave two handles that nothing can ever close.
    assert.equal(reader.openCount, 1)
    assert.equal(reader.refCountFor(fileId), 3)

    await reader.closeDocument(fileId)
    assert.equal(reader.openCount, 1, 'closed while other holders remained')
    await reader.closeDocument(fileId)
    assert.equal(reader.openCount, 1, 'closed while another holder remained')
    await reader.closeDocument(fileId)
    assert.equal(reader.openCount, 0, 'still held after the last release')
  })

  it('closeAll releases a document even with references outstanding', async () => {
    const { reader, fileId } = await setup(500_000)
    await reader.openDocument(fileId)
    await reader.openDocument(fileId)
    await reader.closeAll()
    assert.equal(reader.openCount, 0)
  })

  it('reopening after a full close serves real bytes again', async () => {
    const { reader, fileId, contents } = await setup(500_000)
    await reader.openDocument(fileId)
    await reader.closeDocument(fileId)
    // A reopen must clear the "closed" marking, or every range request is
    // answered with an empty chunk and the document silently never loads.
    await reader.openDocument(fileId)
    const chunk = await reader.readRange(fileId, INITIAL_CHUNK_BYTES, INITIAL_CHUNK_BYTES + 512)
    assert.deepEqual(Buffer.from(chunk), contents.subarray(INITIAL_CHUNK_BYTES, INITIAL_CHUNK_BYTES + 512))
    await reader.closeDocument(fileId)
  })
})
