import { CURRENT_SCHEMA_VERSION } from '../../shared/manifest'

type Migration = (raw: any) => any // eslint-disable-line @typescript-eslint/no-explicit-any

type ManifestKind = 'project' | 'links' | 'layers' | 'legend' | 'file'

// Keyed by the schemaVersion a manifest is migrating FROM. Add an entry
// here each time CURRENT_SCHEMA_VERSION bumps, e.g.
//   project: { 1: (v1) => ({ ...v1, schemaVersion: 2, someNewField: default }) }
// Nothing to migrate yet since schemaVersion has never bumped.
const migrations: Record<ManifestKind, Record<number, Migration>> = {
  project: {},
  links: {},
  layers: {},
  legend: {},
  file: {}
}

/**
 * Applies the registered migration chain for `kind`, stepping the raw JSON
 * forward one schemaVersion at a time until it reaches
 * CURRENT_SCHEMA_VERSION. Each raw manifest file carries its own
 * schemaVersion and is migrated independently of the others (see design
 * decision: per-file-type versioning, not one project-wide version).
 */
export function migrate<T extends { schemaVersion: number }>(kind: ManifestKind, raw: T): T {
  let current: T = raw
  const chain = migrations[kind]
  while (current.schemaVersion < CURRENT_SCHEMA_VERSION) {
    const step = chain[current.schemaVersion]
    if (!step) {
      throw new Error(`No migration registered for '${kind}' from schemaVersion ${current.schemaVersion}`)
    }
    current = step(current)
  }
  return current
}
