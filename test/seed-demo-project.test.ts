import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { ManifestStore } from '../src/main/manifest/store'

// Not a test: a seeding utility for manual GUI verification, kept here so it
// can reuse the project's TypeScript/ESM pipeline. Skipped by default so it
// never runs as part of `npm test`. Run it deliberately with:
//   npx vitest run test/seed-demo-project.test.ts -t seed --no-file-parallelism
// after setting SEED_DEMO=1.
const ROOT = 'C:/Users/EricB/Desktop/Tool-test-project'

describe.skipIf(!process.env.SEED_DEMO)('demo project seeding', () => {
  it('seed', async () => {
    await fs.rm(join(ROOT, '.manifest'), { recursive: true, force: true })
    await fs.mkdir(join(ROOT, 'drawings'), { recursive: true })
    await fs.copyFile(join(ROOT, 'sheet.pdf'), join(ROOT, 'drawings', 'sheet.pdf'))
    await fs.mkdir(join(ROOT, 'sheets'), { recursive: true })
    await fs.writeFile(join(ROOT, 'sheets', 'takeoff.csv'), 'item,qty\n')

    const store = new ManifestStore()
    await store.create(ROOT)
    const pdfId = store.addFile('drawings/sheet.pdf', 'pdf')
    const sheetId = store.addFile('sheets/takeoff.csv', 'spreadsheet')
    store.setSheets(sheetId, [{ sheetName: 'Takeoff' }])
    await store.save()

    console.log(`Seeded ${ROOT}\n  pdfFileId=${pdfId}\n  spreadsheetFileId=${sheetId}`)
  })
})
