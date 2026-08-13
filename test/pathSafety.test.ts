import { strict as assert } from 'node:assert'
import { afterAll, describe, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { resolveWithinRoot } from '../src/main/pathSafety'

// This is the check that stops app-file:// from serving arbitrary files off
// the user's disk. relativePath comes out of a manifest JSON file that a user
// could hand-edit or that could be restored from a tampered backup, so it is
// untrusted input.

const cleanup: string[] = []

async function makeTree(): Promise<{ root: string; outside: string }> {
  const base = join(tmpdir(), `tool-path-test-${randomUUID()}`)
  const root = join(base, 'project')
  const outside = join(base, 'outside')
  await fs.mkdir(join(root, 'drawings'), { recursive: true })
  await fs.mkdir(outside, { recursive: true })
  await fs.writeFile(join(root, 'drawings', 'sheet.pdf'), '%PDF-1.4\n')
  await fs.writeFile(join(outside, 'secrets.txt'), 'not yours\n')
  cleanup.push(base)
  return { root, outside }
}

afterAll(async () => {
  for (const dir of cleanup) await fs.rm(dir, { recursive: true, force: true })
})

describe('resolveWithinRoot', () => {
  it('allows a file genuinely inside the project root', async () => {
    const { root } = await makeTree()
    const resolved = await resolveWithinRoot(join(root, 'drawings', 'sheet.pdf'), root)
    assert.ok(resolved, 'a file inside the project must be served')
    assert.match(resolved, /sheet\.pdf$/)
  })

  it('rejects a path that climbs out with ..', async () => {
    const { root } = await makeTree()
    const escape = join(root, '..', 'outside', 'secrets.txt')
    assert.equal(await resolveWithinRoot(escape, root), undefined)
  })

  it('rejects an unrelated absolute path', async () => {
    const { root, outside } = await makeTree()
    assert.equal(await resolveWithinRoot(join(outside, 'secrets.txt'), root), undefined)
  })

  it('rejects the project root itself', async () => {
    const { root } = await makeTree()
    assert.equal(await resolveWithinRoot(root, root), undefined)
  })

  it('returns undefined for a file that does not exist', async () => {
    const { root } = await makeTree()
    assert.equal(await resolveWithinRoot(join(root, 'drawings', 'nope.pdf'), root), undefined)
  })

  it('does not leak whether a rejected path exists', async () => {
    // Both a missing file and an out-of-project file must look identical to
    // the caller, so the renderer cannot probe the filesystem.
    const { root, outside } = await makeTree()
    const missing = await resolveWithinRoot(join(root, 'drawings', 'nope.pdf'), root)
    const forbidden = await resolveWithinRoot(join(outside, 'secrets.txt'), root)
    assert.equal(missing, forbidden)
  })

  // Directory JUNCTIONS are used rather than symlinks: on Windows a symlink
  // needs Developer Mode or elevation (EPERM otherwise), which would make
  // these tests silently pass without exercising anything, while a junction
  // needs no special privilege and goes through the same realpath resolution.
  // If even a junction cannot be created, the test reports as skipped rather
  // than as a pass.
  async function makeJunction(target: string, linkPath: string): Promise<boolean> {
    try {
      await fs.symlink(target, linkPath, 'junction')
      return true
    } catch {
      return false
    }
  }

  it('rejects a link inside the project that points outside it', async (ctx) => {
    const { root, outside } = await makeTree()
    const junction = join(root, 'drawings', 'escape')
    if (!(await makeJunction(outside, junction))) {
      ctx.skip()
      return
    }
    // Reachable by string path as "inside the project", but really outside.
    const escaped = join(junction, 'secrets.txt')
    assert.equal(
      await resolveWithinRoot(escaped, root),
      undefined,
      'a link escaping the project must be rejected - comparing unresolved strings would allow it'
    )
  })

  it('still allows real files when the ROOT itself is reached through a link', async (ctx) => {
    // Guards the opposite failure: over-strict resolution that rejects
    // everything because the project sits under a linked parent.
    const { root } = await makeTree()
    const linkedRoot = join(tmpdir(), `tool-path-link-${randomUUID()}`)
    if (!(await makeJunction(root, linkedRoot))) {
      ctx.skip()
      return
    }
    cleanup.push(linkedRoot)
    const resolved = await resolveWithinRoot(join(linkedRoot, 'drawings', 'sheet.pdf'), linkedRoot)
    assert.ok(resolved, 'a linked project root must still serve its own files')
  })
})
