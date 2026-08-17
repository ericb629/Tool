/**
 * Copies pdf.js runtime assets out of node_modules into the renderer's
 * publicDir, so they ship at a real URL in both dev and packaged builds.
 *
 * WHY A SCRIPT AND NOT CHECKED-IN BINARIES: these are version-locked to the
 * installed pdfjs-dist. Checked-in copies go stale silently on the next
 * upgrade, and a stale wasm codec fails by not decoding an image - which this
 * app renders as a blank sheet that still accepts takeoff. Copying on every
 * dev/build start means they cannot drift.
 *
 * WHAT NEEDS THIS:
 *   wasm/           JBIG2 and JPEG2000 codecs. Without them pdf.js WARNS rather
 *                   than throws and silently omits the image - the bug that
 *                   made pages 4 and 11-15 of the Kincora set render as almost
 *                   empty sheets.
 *   cmaps/          CID font character maps.
 *   standard_fonts/ The 14 standard font data files.
 *
 * Run by the `predev` and `prebuild` npm hooks. The output directory is
 * generated and gitignored.
 */

import { cp, mkdir, rm, stat, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(root, 'node_modules', 'pdfjs-dist')
const to = join(root, 'src', 'renderer', 'public', 'pdfjs')

/** Directory name in pdfjs-dist -> directory name we serve it under. */
const ASSETS = ['wasm', 'cmaps', 'standard_fonts']

async function dirSignature(path) {
  try {
    const names = (await readdir(path)).sort()
    let bytes = 0
    for (const name of names) {
      const s = await stat(join(path, name))
      if (s.isFile()) bytes += s.size
    }
    return `${names.length}:${bytes}`
  } catch {
    return undefined
  }
}

let copied = 0
let skipped = 0

await mkdir(to, { recursive: true })

for (const asset of ASSETS) {
  const src = join(from, asset)
  const dest = join(to, asset)

  if ((await dirSignature(src)) === undefined) {
    console.error(`[pdfjs-assets] MISSING ${src} - is pdfjs-dist installed?`)
    process.exitCode = 1
    continue
  }

  // Skip when file count and total bytes already match, so `npm run dev` does
  // not re-copy ~4MB on every start.
  if ((await dirSignature(src)) === (await dirSignature(dest))) {
    skipped++
    continue
  }

  await rm(dest, { recursive: true, force: true })
  await cp(src, dest, { recursive: true })
  copied++
}

console.log(
  `[pdfjs-assets] ${copied} copied, ${skipped} already current -> src/renderer/public/pdfjs/`
)
