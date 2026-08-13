import type { ResolvedFileEntry } from '../../shared/manifest'

export interface FileStatusNotice {
  severity: 'ok' | 'warning' | 'error'
  /** Short suffix for inline use next to a filename. Empty when nothing is wrong. */
  label: string
  /** Full sentence for when there is room to explain. */
  detail: string
}

/**
 * Turns the two independent presence flags into one message. Written as an
 * exhaustive four-way match rather than two separate `if`s so the
 * both-missing case can never be silently dropped by one condition masking
 * the other.
 */
export function describeFileStatus(
  entry: Pick<ResolvedFileEntry, 'sourceStatus' | 'manifestStatus'>
): FileStatusNotice {
  const { sourceStatus, manifestStatus } = entry

  if (sourceStatus === 'ok' && manifestStatus === 'ok') {
    return { severity: 'ok', label: '', detail: '' }
  }

  if (sourceStatus === 'missing' && manifestStatus === 'ok') {
    return {
      severity: 'warning',
      label: 'file missing',
      detail: 'The source document is not on disk. Its markups are intact, but there is nothing to display them over.'
    }
  }

  if (sourceStatus === 'ok' && manifestStatus === 'missing') {
    return {
      severity: 'error',
      label: 'markup data missing',
      detail:
        'The document is present but its markup sidecar is gone. Any markups it had are likely lost — this is shown as empty, not confirmed empty.'
    }
  }

  return {
    severity: 'error',
    label: 'file and markup data missing',
    detail:
      'Neither the source document nor its markup sidecar is on disk. Any markups it had are likely lost, and there is no document to re-measure against.'
  }
}
