import type { FileManifest, LinkRecord, Uuid } from '../../shared/manifest'

/**
 * Drops any LinkRecord whose source PDF file, source markup, or target
 * spreadsheet file is no longer present in memory. There is currently no
 * delete capability anywhere in the app (no deleteMarkup/deleteFile/
 * deleteLink), so today this only guards against a link becoming orphaned
 * by something outside a normal edit - e.g. a sidecar going missing between
 * saves (see ManifestStore.open's 'manifest-missing' handling). It exists
 * ahead of a future delete feature so links can't be silently left pointing
 * at nothing once one is added. Applied on every project load and
 * defensively before every save.
 */
export function pruneOrphanLinks(links: LinkRecord[], files: Map<Uuid, FileManifest>): LinkRecord[] {
  return links.filter((link) => {
    const sourceFile = files.get(link.sourceFileId)
    if (!sourceFile || sourceFile.fileType !== 'pdf') return false
    if (!sourceFile.markups.some((markup) => markup.id === link.markupId)) return false

    const targetFile = files.get(link.target.fileId)
    if (!targetFile || targetFile.fileType !== 'spreadsheet') return false

    return true
  })
}
