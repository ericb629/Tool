import { promises as fs } from 'fs'
import { isAbsolute, relative } from 'path'

/**
 * Resolves `absolutePath` and returns it only if it really lives inside
 * `rootPath`; otherwise undefined.
 *
 * Deliberately kept free of any electron import so it can be unit tested -
 * this is the check that stops the app-file:// protocol from serving
 * arbitrary files off the user's disk, and an untested security boundary is
 * not a security boundary.
 *
 * Both sides go through realpath before comparing, so a symlink planted
 * inside the project that points outside it is rejected too - comparing the
 * un-resolved strings would let that through. The root is resolved as well
 * because it may legitimately sit under a symlinked parent (common on
 * Windows with redirected user folders), which would otherwise make every
 * path look like an escape.
 *
 * Returns undefined rather than throwing for a missing file, so callers
 * can't accidentally distinguish "outside the project" from "not there" and
 * leak that difference to the renderer.
 */
export async function resolveWithinRoot(absolutePath: string, rootPath: string): Promise<string | undefined> {
  let realFile: string
  let realRoot: string
  try {
    realRoot = await fs.realpath(rootPath)
    realFile = await fs.realpath(absolutePath)
  } catch {
    return undefined
  }

  const rel = relative(realRoot, realFile)
  // '' means the path IS the root directory; '..'-prefixed or absolute means
  // it escaped. `relative` returns an absolute path when the two are on
  // different Windows drives, which is why isAbsolute is checked too.
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined
  return realFile
}
