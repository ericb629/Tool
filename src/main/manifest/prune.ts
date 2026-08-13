import type { FileManifest, LinkRecord, Uuid } from '../../shared/manifest'

/**
 * Drops any LinkRecord whose source file or target markup no longer exists
 * in memory. Applied on every project load and defensively before every
 * save, so a link left dangling by a file removal or a markup deletion
 * (there is no multi-file transaction guaranteeing those stay in sync) is
 * cleaned up automatically rather than pointing at nothing.
 */
export function pruneOrphanLinks(links: LinkRecord[], files: Map<Uuid, FileManifest>): LinkRecord[] {
  return links.filter((link) => {
    const file = files.get(link.sourceFileId)
    if (!file || file.fileType !== 'pdf') return false
    return file.markups.some((markup) => markup.id === link.markupId)
  })
}
