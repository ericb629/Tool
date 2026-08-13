import { promises as fs } from 'fs'
import { dirname, join } from 'path'

export function manifestDir(rootPath: string): string {
  return join(rootPath, '.manifest')
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

export async function readJsonIfExists<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

/**
 * Writes JSON atomically: the full content lands in a temp file first, then
 * `rename` swaps it into place in one filesystem operation. This means a
 * crash or power loss mid-write can never leave `filePath` truncated or
 * containing partial JSON - the reader always sees either the old complete
 * file or the new complete file, never something in between.
 */
export async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmpPath, filePath)
}
