import { randomUUID } from 'crypto'
import { basename, join } from 'path'
import {
  CURRENT_SCHEMA_VERSION,
  validateMarkup,
  type FileManifest,
  type Layer,
  type LayerRegistry,
  type LinkRecord,
  type MarkupObject,
  type PdfFileManifest,
  type ProjectFileEntry,
  type ProjectManifest,
  type ProjectState,
  type ResolvedFileEntry,
  type SpreadsheetFileManifest,
  type SymbolLegend,
  type SymbolLegendEntry,
  type Uuid
} from '../../shared/manifest'
import { manifestDir, pathExists, readJsonIfExists, writeJson } from './io'
import { migrate } from './migrations'
import { pruneOrphanLinks } from './prune'

interface LinksFile {
  schemaVersion: number
  links: LinkRecord[]
}

/**
 * Holds the currently open project in memory and mediates all reads/writes
 * to its .manifest/ sidecar files.
 *
 * SINGLE-WRITER ASSUMPTION: this app opens exactly one project in one
 * window at a time, and this store assumes it is the only writer to the
 * project's .manifest/ folder for the lifetime of the process. Concurrent
 * edits from a second window, or a second machine via cloud sync, are not
 * detected or merged - last save wins. Revisit if multi-window editing is
 * ever added.
 */
export class ManifestStore {
  private rootPath: string | undefined
  private project: ProjectManifest | undefined
  private links: LinkRecord[] = []
  private layers: Layer[] = []
  private legend: SymbolLegendEntry[] = []
  private files: Map<Uuid, FileManifest> = new Map()
  private fileStatus: Map<Uuid, 'ok' | 'missing'> = new Map()

  private dirtyProject = false
  private dirtyLinks = false
  private dirtyLayers = false
  private dirtyLegend = false
  private dirtyFileIds: Set<Uuid> = new Set()

  async open(rootPath: string): Promise<ProjectState> {
    const dir = manifestDir(rootPath)

    const rawProject = await readJsonIfExists<ProjectManifest>(join(dir, 'project.json'))
    if (!rawProject) {
      throw new Error(`No project found at ${rootPath} (missing .manifest/project.json)`)
    }
    const project = migrate('project', rawProject)

    const rawLinks = await readJsonIfExists<LinksFile>(join(dir, 'links.json'))
    const links = rawLinks ? migrate('links', rawLinks).links : []

    const rawLayers = await readJsonIfExists<LayerRegistry>(join(dir, 'layers.json'))
    const layers = rawLayers ? migrate('layers', rawLayers).layers : []

    const rawLegend = await readJsonIfExists<SymbolLegend>(join(dir, 'legend.json'))
    const legend = rawLegend ? migrate('legend', rawLegend).symbols : []

    const files = new Map<Uuid, FileManifest>()
    const fileStatus = new Map<Uuid, 'ok' | 'missing'>()

    for (const entry of project.files) {
      const sourceExists = await pathExists(join(rootPath, entry.relativePath))
      fileStatus.set(entry.fileId, sourceExists ? 'ok' : 'missing')

      const rawFile = await readJsonIfExists<FileManifest>(join(dir, `${entry.fileId}.json`))
      // A source file can resolve (or not) independently of whether its
      // sidecar exists - e.g. a fresh addFile() call with no sidecar
      // written yet. Missing sidecars self-heal to an empty manifest rather
      // than failing the whole project load.
      const manifest = rawFile ? migrate('file', rawFile) : createEmptyFileManifest(entry)
      files.set(entry.fileId, manifest)
    }

    this.rootPath = rootPath
    this.project = project
    this.links = pruneOrphanLinks(links, files)
    this.layers = layers
    this.legend = legend
    this.files = files
    this.fileStatus = fileStatus
    this.dirtyProject = false
    this.dirtyLinks = false
    this.dirtyLayers = false
    this.dirtyLegend = false
    this.dirtyFileIds = new Set()

    return this.toProjectState()
  }

  async create(rootPath: string): Promise<ProjectState> {
    if (await pathExists(join(manifestDir(rootPath), 'project.json'))) {
      throw new Error(`A project already exists at ${rootPath}`)
    }

    const now = new Date().toISOString()
    const project: ProjectManifest = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      projectId: randomUUID(),
      name: basename(rootPath),
      createdAt: now,
      updatedAt: now,
      files: []
    }

    this.rootPath = rootPath
    this.project = project
    this.links = []
    this.layers = []
    this.legend = []
    this.files = new Map()
    this.fileStatus = new Map()
    this.dirtyProject = true
    this.dirtyLinks = true
    this.dirtyLayers = true
    this.dirtyLegend = true
    this.dirtyFileIds = new Set()

    await this.save()
    return this.toProjectState()
  }

  /**
   * Registers a new source file with the open project and creates its empty
   * sidecar. Not exposed over IPC in this phase (no file-import UI exists
   * yet) - used directly by the manifest-system verification script to seed
   * dummy PDF/spreadsheet references.
   */
  addFile(relativePath: string, fileType: 'pdf' | 'spreadsheet'): Uuid {
    if (!this.project) throw new Error('No project is open')
    const fileId = randomUUID()
    const entry: ProjectFileEntry = { fileId, relativePath, fileType, addedAt: new Date().toISOString() }
    this.project.files.push(entry)
    this.files.set(fileId, createEmptyFileManifest(entry))
    this.fileStatus.set(fileId, 'ok')
    this.dirtyProject = true
    this.dirtyFileIds.add(fileId)
    return fileId
  }

  updateMarkup(fileId: Uuid, markup: MarkupObject): void {
    const file = this.requireFile(fileId)
    if (file.fileType !== 'pdf') {
      throw new Error(`File ${fileId} is not a PDF; cannot hold markups`)
    }

    const result = validateMarkup(markup)
    if (!result.valid) {
      throw new Error(`Invalid markup: ${result.reason}`)
    }

    const existingIndex = file.markups.findIndex((m) => m.id === markup.id)
    if (existingIndex >= 0) {
      file.markups[existingIndex] = markup
    } else {
      file.markups.push(markup)
    }
    file.updatedAt = new Date().toISOString()
    this.dirtyFileIds.add(fileId)
  }

  updateLink(link: LinkRecord): void {
    const existingIndex = this.links.findIndex((l) => l.id === link.id)
    if (existingIndex >= 0) {
      this.links[existingIndex] = link
    } else {
      this.links.push(link)
    }
    this.dirtyLinks = true
  }

  async save(): Promise<void> {
    if (!this.rootPath || !this.project) {
      throw new Error('No project is open')
    }
    const dir = manifestDir(this.rootPath)

    // Defensive pass, same reasoning as the on-load prune: a markup or file
    // may have been removed from memory since the last save.
    this.links = pruneOrphanLinks(this.links, this.files)

    if (this.dirtyProject) {
      this.project.updatedAt = new Date().toISOString()
      await writeJson(join(dir, 'project.json'), this.project)
      this.dirtyProject = false
    }
    if (this.dirtyLinks) {
      const linksFile: LinksFile = { schemaVersion: CURRENT_SCHEMA_VERSION, links: this.links }
      await writeJson(join(dir, 'links.json'), linksFile)
      this.dirtyLinks = false
    }
    if (this.dirtyLayers) {
      const layerRegistry: LayerRegistry = { schemaVersion: CURRENT_SCHEMA_VERSION, layers: this.layers }
      await writeJson(join(dir, 'layers.json'), layerRegistry)
      this.dirtyLayers = false
    }
    if (this.dirtyLegend) {
      const symbolLegend: SymbolLegend = { schemaVersion: CURRENT_SCHEMA_VERSION, symbols: this.legend }
      await writeJson(join(dir, 'legend.json'), symbolLegend)
      this.dirtyLegend = false
    }
    for (const fileId of this.dirtyFileIds) {
      const manifest = this.files.get(fileId)
      if (manifest) {
        await writeJson(join(dir, `${fileId}.json`), manifest)
      }
    }
    this.dirtyFileIds.clear()
  }

  private requireFile(fileId: Uuid): FileManifest {
    const file = this.files.get(fileId)
    if (!file) throw new Error(`Unknown fileId: ${fileId}`)
    return file
  }

  private toProjectState(): ProjectState {
    if (!this.rootPath || !this.project) throw new Error('No project is open')
    const files: ResolvedFileEntry[] = this.project.files.map((entry) => ({
      fileId: entry.fileId,
      relativePath: entry.relativePath,
      fileType: entry.fileType,
      status: this.fileStatus.get(entry.fileId) ?? 'missing',
      manifest: this.requireFile(entry.fileId)
    }))

    return {
      schemaVersion: this.project.schemaVersion,
      projectId: this.project.projectId,
      name: this.project.name,
      rootPath: this.rootPath,
      files,
      links: this.links,
      layers: this.layers,
      legend: this.legend
    }
  }
}

function createEmptyFileManifest(entry: Pick<ProjectFileEntry, 'fileId' | 'fileType'>): FileManifest {
  const now = new Date().toISOString()
  if (entry.fileType === 'pdf') {
    const manifest: PdfFileManifest = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      fileId: entry.fileId,
      fileType: 'pdf',
      updatedAt: now,
      pages: [],
      markups: []
    }
    return manifest
  }
  const manifest: SpreadsheetFileManifest = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    fileId: entry.fileId,
    fileType: 'spreadsheet',
    updatedAt: now,
    sheets: []
  }
  return manifest
}
