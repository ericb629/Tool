import { strict as assert } from 'node:assert'
import { afterAll, describe, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { buildFileResponse, parseRange } from '../src/main/fileResponse'

const SIZE = 1000

describe('parseRange', () => {
  it('ignores a missing or malformed header so the whole file is served', () => {
    assert.equal(parseRange(null, SIZE), undefined)
    assert.equal(parseRange('', SIZE), undefined)
    assert.equal(parseRange('bytes=abc', SIZE), undefined)
    assert.equal(parseRange('items=0-10', SIZE), undefined)
    // Multi-range is legal HTTP but unsupported here; falling back to the
    // whole file is always a correct response.
    assert.equal(parseRange('bytes=0-10,20-30', SIZE), undefined)
  })

  it('parses an explicit start and end', () => {
    assert.deepEqual(parseRange('bytes=0-99', SIZE), { start: 0, end: 99 })
    assert.deepEqual(parseRange('bytes=100-199', SIZE), { start: 100, end: 199 })
  })

  it('parses an open-ended range as running to the last byte', () => {
    assert.deepEqual(parseRange('bytes=900-', SIZE), { start: 900, end: 999 })
  })

  it('clamps an end past EOF rather than reading off the end', () => {
    assert.deepEqual(parseRange('bytes=990-99999', SIZE), { start: 990, end: 999 })
  })

  // pdf.js reads the cross-reference table with a suffix range, so this form
  // has to work or incremental loading silently never starts.
  it('parses a suffix range as the last N bytes', () => {
    assert.deepEqual(parseRange('bytes=-100', SIZE), { start: 900, end: 999 })
  })

  it('clamps a suffix range larger than the file to the whole file', () => {
    assert.deepEqual(parseRange('bytes=-99999', SIZE), { start: 0, end: 999 })
  })

  it('reports ranges that start past EOF as unsatisfiable', () => {
    assert.equal(parseRange('bytes=1000-1100', SIZE), 'unsatisfiable')
    assert.equal(parseRange('bytes=5000-', SIZE), 'unsatisfiable')
    assert.equal(parseRange('bytes=-0', SIZE), 'unsatisfiable')
  })

  it('tolerates surrounding whitespace', () => {
    assert.deepEqual(parseRange('  bytes=0-9  ', SIZE), { start: 0, end: 9 })
  })
})

const cleanup: string[] = []
async function makeFile(contents: string): Promise<string> {
  const dir = join(tmpdir(), `tool-fileresp-${randomUUID()}`)
  await fs.mkdir(dir, { recursive: true })
  const path = join(dir, 'sheet.pdf')
  await fs.writeFile(path, contents)
  cleanup.push(dir)
  return path
}
afterAll(async () => {
  for (const dir of cleanup) await fs.rm(dir, { recursive: true, force: true })
})

describe('buildFileResponse', () => {
  const body = 'ABCDEFGHIJ'.repeat(10) // 100 bytes

  it('advertises accept-ranges and content-length on a full request', async () => {
    // Without BOTH of these pdf.js refuses to load incrementally and pulls
    // the entire document into renderer memory.
    const res = await buildFileResponse(await makeFile(body), null)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('accept-ranges'), 'bytes')
    assert.equal(res.headers.get('content-length'), '100')
    assert.equal(res.headers.get('content-type'), 'application/pdf')
    assert.equal(await res.text(), body)
  })

  it('answers a ranged request with 206 and only those bytes', async () => {
    const res = await buildFileResponse(await makeFile(body), 'bytes=0-9')
    assert.equal(res.status, 206, 'a 200 here makes pdf.js abandon incremental loading')
    assert.equal(res.headers.get('content-range'), 'bytes 0-9/100')
    assert.equal(res.headers.get('content-length'), '10')
    const text = await res.text()
    assert.equal(text, 'ABCDEFGHIJ')
    assert.equal(text.length, 10, 'must return ONLY the requested slice')
  })

  it('serves a middle slice correctly', async () => {
    const res = await buildFileResponse(await makeFile(body), 'bytes=10-14')
    assert.equal(res.status, 206)
    assert.equal(await res.text(), body.slice(10, 15))
  })

  it('serves a suffix range (how pdf.js finds the xref table)', async () => {
    const res = await buildFileResponse(await makeFile(body), 'bytes=-5')
    assert.equal(res.status, 206)
    assert.equal(res.headers.get('content-range'), 'bytes 95-99/100')
    assert.equal(await res.text(), body.slice(95))
  })

  it('returns 416 for a range beyond the end of the file', async () => {
    const res = await buildFileResponse(await makeFile(body), 'bytes=500-600')
    assert.equal(res.status, 416)
    assert.equal(res.headers.get('content-range'), 'bytes */100')
  })

  it('falls back to the whole file for an unparseable range', async () => {
    const res = await buildFileResponse(await makeFile(body), 'bytes=garbage')
    assert.equal(res.status, 200)
    assert.equal(await res.text(), body)
  })

  it('labels unknown extensions as octet-stream rather than claiming pdf', async () => {
    const dir = join(tmpdir(), `tool-fileresp-${randomUUID()}`)
    await fs.mkdir(dir, { recursive: true })
    const path = join(dir, 'notes.txt')
    await fs.writeFile(path, 'hi')
    cleanup.push(dir)
    const res = await buildFileResponse(path, null)
    assert.equal(res.headers.get('content-type'), 'application/octet-stream')
  })
})
