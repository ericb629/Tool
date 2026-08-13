import { createReadStream, promises as fs } from 'fs'
import { extname } from 'path'
import { Readable } from 'stream'

const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf'
}

export interface ParsedRange {
  start: number
  end: number
}

/**
 * Parses a single-range HTTP Range header against a known file size.
 *
 * Returns 'unsatisfiable' for a syntactically valid range that falls outside
 * the file (which must become a 416), and undefined for anything we don't
 * handle - a malformed header, or a multi-range request - so the caller
 * falls back to serving the whole file, which is always a valid response.
 */
export function parseRange(header: string | null, size: number): ParsedRange | 'unsatisfiable' | undefined {
  if (!header) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return undefined

  const [, rawStart, rawEnd] = match
  let start: number
  let end: number

  if (rawStart === '') {
    // Suffix form "bytes=-N": the last N bytes. pdf.js uses this to read the
    // cross-reference table at the end of a document.
    if (rawEnd === '') return undefined
    const suffixLength = Number(rawEnd)
    if (suffixLength === 0) return 'unsatisfiable'
    start = Math.max(0, size - suffixLength)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
    if (end >= size) end = size - 1
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}

/**
 * Builds a streaming Response for a file, with real Range support.
 *
 * Electron's net.fetch on a file:// URL returns 200 with no Accept-Ranges and
 * no Content-Length. pdf.js decides whether it can fetch a document
 * incrementally by reading exactly those headers, so with net.fetch it always
 * concludes it cannot, and pulls the ENTIRE file into renderer memory - about
 * 1.2GB of renderer growth for a 465MB sheet set, measured. Advertising
 * Accept-Ranges + Content-Length and answering ranged requests with a 206 is
 * what lets pdf.js load only the pages it needs.
 *
 * The body is a stream off disk in both cases, so no whole file is ever
 * buffered in the main process either.
 */
export async function buildFileResponse(filePath: string, rangeHeader: string | null): Promise<Response> {
  const stat = await fs.stat(filePath)
  const size = stat.size
  const contentType = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'

  const range = parseRange(rangeHeader, size)

  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes' }
    })
  }

  if (range) {
    const length = range.end - range.start + 1
    const stream = Readable.toWeb(
      createReadStream(filePath, { start: range.start, end: range.end })
    ) as unknown as ReadableStream<Uint8Array>
    return new Response(stream, {
      status: 206,
      headers: {
        'content-type': contentType,
        'content-length': String(length),
        'content-range': `bytes ${range.start}-${range.end}/${size}`,
        'accept-ranges': 'bytes'
      }
    })
  }

  const stream = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream<Uint8Array>
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-length': String(size),
      // Without this pdf.js will not attempt incremental loading at all.
      'accept-ranges': 'bytes'
    }
  })
}
