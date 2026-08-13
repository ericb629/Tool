import { ipcMain } from 'electron'
import type { PdfDataReader, OpenResult } from '../pdfData'

/**
 * IPC surface for pdf.js's PDFDataRangeTransport. Only the chunks pdf.js
 * requests cross this boundary - never a whole document. See src/main/pdfData.ts
 * for why this exists rather than a custom protocol.
 */
export function registerPdfDataIpcHandlers(reader: PdfDataReader): void {
  ipcMain.handle('pdfData:open', async (_event, fileId: string): Promise<OpenResult> => {
    return reader.openDocument(fileId)
  })

  ipcMain.handle(
    'pdfData:read',
    async (_event, fileId: string, begin: number, end: number): Promise<Uint8Array> => {
      return reader.readRange(fileId, begin, end)
    }
  )

  ipcMain.handle('pdfData:close', async (_event, fileId: string): Promise<void> => {
    await reader.closeDocument(fileId)
  })
}
