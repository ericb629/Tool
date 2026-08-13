import { promises as fs } from 'node:fs'
import { describe, it } from 'vitest'
import { ManifestStore } from '../src/main/manifest/store'
import type { MarkupObject } from '../src/shared/manifest/types'

// Throwaway: a calibrated page 1 with three polylines to select and marquee.
const ROOT = 'C:/Users/EricB/Desktop/Tool-tools-project'

const line = (id: string, y: number): MarkupObject => ({
  id,
  pageNumber: 1,
  layerId: 'layer-1',
  type: 'polyline',
  takeoff: { mode: 'linear', unit: 'ft' },
  geometry: { kind: 'polyline', points: [{ x: 100, y }, { x: 400, y }] },
  style: { color: '#e63946' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
})

describe.skipIf(!process.env.SEED_TOOLS)('tools fixture', () => {
  it('seed', async () => {
    await fs.rm(`${ROOT}/.manifest`, { recursive: true, force: true })
    await fs.mkdir(`${ROOT}/drawings`, { recursive: true })
    await fs.copyFile(`${ROOT}/sheet.pdf`, `${ROOT}/drawings/sheet.pdf`)

    const store = new ManifestStore()
    await store.create(ROOT)
    const pdf = store.addFile('drawings/sheet.pdf', 'pdf')
    store.updatePageCalibration(pdf, {
      pageNumber: 1,
      pointA: { x: 0, y: 0 },
      pointB: { x: 100, y: 0 },
      realDistance: 100,
      unit: 'ft'
    })
    // Page 1 lines (calibrated), plus one on uncalibrated page 2.
    store.updateMarkup(pdf, line('aaaaaaaa-0000-0000-0000-000000000001', 300))
    store.updateMarkup(pdf, line('aaaaaaaa-0000-0000-0000-000000000002', 350))
    store.updateMarkup(pdf, line('aaaaaaaa-0000-0000-0000-000000000003', 400))
    store.updateMarkup(pdf, { ...line('aaaaaaaa-0000-0000-0000-000000000004', 300), pageNumber: 2 })
    await store.save()
    console.log(`PDF_ID=${pdf}`)
  })
})
