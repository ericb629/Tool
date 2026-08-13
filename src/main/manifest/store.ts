import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { basename, extname, join, relative, sep } from 'path'
import {
  CURRENT_SCHEMA_VERSION,
  validateMarkup,
  type FileManifest,
  type Layer,
  type LayerRegistry,
  type LinkRecord,
  type MarkupObject,
  type PageCalibration,
  type PdfFileManifest,
  type PresenceStatus,
  type ProjectFileEntry,
  type ProjectManifest,
  type ProjectState,
  type ResolvedFileEntry,
  type SpreadsheetFileManifest,
  type SpreadsheetSheetRecord,
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
  private fileStatus: Map<Uuid, { sourceStatus: PresenceStatus; manifestStatus: PresenceStatus }> = new Map()

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
    const fileStatus = new Map<Uuid, { sourceStatus: PresenceStatus; manifestStatus: PresenceStatus }>()

    for (const entry of project.files) {
      const sourceExists = await pathExists(join(rootPath, entry.relativePath))
      const rawFile = await readJsonIfExists<FileManifest>(join(dir, `${entry.fileId}.json`))

      // The source document and its sidecar are tracked independently: they
      // can go missing separately, for different reasons, and reporting only
      // one of them would hide the other when both are gone.
      fileStatus.set(entry.fileId, {
        sourceStatus: sourceExists ? 'ok' : 'missing',
        manifestStatus: rawFile ? 'ok' : 'missing'
      })

      // A missing sidecar is never silently self-healed into "this file had
      // no markups" - an empty manifest is attached only so callers get a
      // well-formed object, and manifestStatus is what says whether to trust
      // it. See ResolvedFileEntry in shared/manifest/types.ts.
      files.set(entry.fileId, rawFile ? migrate('file', rawFile) : createEmptyFileManifest(entry))
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

    // Every markup needs a layerId (see MarkupObject), and there is no
    // layer-management UI yet - seed one default layer so a new project has
    // somewhere valid for markups to point rather than inventing a
    // layers UI here.
    const defaultLayer: Layer = {
      id: randomUUID(),
      name: 'Default',
      defaultVisible: true,
      createdAt: now
    }

    this.rootPath = rootPath
    this.project = project
    this.links = []
    this.layers = [defaultLayer]
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
   * sidecar.
   */
  addFile(relativePath: string, fileType: 'pdf' | 'spreadsheet'): Uuid {
    if (!this.project) throw new Error('No project is open')
    const fileId = randomUUID()
    const entry: ProjectFileEntry = { fileId, relativePath, fileType, addedAt: new Date().toISOString() }
    this.project.files.push(entry)
    this.files.set(fileId, createEmptyFileManifest(entry))
    this.fileStatus.set(fileId, { sourceStatus: 'ok', manifestStatus: 'ok' })
    this.dirtyProject = true
    this.dirtyFileIds.add(fileId)
    return fileId
  }

  /**
   * Copies a PDF from anywhere on disk into this project's drawings/ folder,
   * registers it in the manifest, and persists. Copying (rather than
   * referencing in place) is what makes the project folder self-contained -
   * the manifest's relativePath is then always inside rootPath, which the
   * PDF chunk reader relies on to refuse anything outside.
   */
  async importPdf(sourceAbsolutePath: string): Promise<{ state: ProjectState; fileId: Uuid }> {
    if (!this.rootPath || !this.project) throw new Error('No project is open')

    const drawingsDir = join(this.rootPath, 'drawings')
    await fs.mkdir(drawingsDir, { recursive: true })

    const destAbsolutePath = await uniqueDestPath(drawingsDir, basename(sourceAbsolutePath))
    await fs.copyFile(sourceAbsolutePath, destAbsolutePath)

    const relativePath = toManifestRelativePath(this.rootPath, destAbsolutePath)
    const fileId = this.addFile(relativePath, 'pdf')
    await this.save()
    return { state: this.getState(), fileId }
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

  /**
   * Upserts the PageCalibration for one page of a PDF file, creating the
   * PdfPageRecord if this page hasn't been touched before. Mirrors
   * updateMarkup's upsert-by-key shape.
   */
  updatePageCalibration(fileId: Uuid, calibration: PageCalibration): void {
    const file = this.requireFile(fileId)
    if (file.fileType !== 'pdf') {
      throw new Error(`File ${fileId} is not a PDF; cannot hold a page calibration`)
    }

    const existingIndex = file.pages.findIndex((p) => p.pageNumber === calibration.pageNumber)
    if (existingIndex >= 0) {
      file.pages[existingIndex] = { ...file.pages[existingIndex], calibration }
    } else {
      file.pages.push({ pageNumber: calibration.pageNumber, calibration })
    }
    file.updatedAt = new Date().toISOString()
    this.dirtyFileIds.add(fileId)
  }

  /**
   * Replaces the sheet list of a spreadsheet file. There is no real
   * spreadsheet-file (xlsx) reading in this app yet - SpreadsheetSheetRecord
   * only tracks a sheet name (see types.ts), not cell content - so this is
   * the minimal primitive needed to give a LinkRecord.target.sheetName
   * somewhere real to point at.
   */
  setSheets(fileId: Uuid, sheets: SpreadsheetSheetRecord[]): void {
    const file = this.requireFile(fileId)
    if (file.fileType !== 'spreadsheet') {
      throw new Error(`File ${fileId} is not a spreadsheet; cannot hold sheets`)
    }
    file.sheets = sheets
    file.updatedAt = new Date().toISOString()
    this.dirtyFileIds.add(fileId)
  }

  /**
   * Ensures a PdfPageRecord exists for every page of a PDF, called once the
   * renderer has actually opened the document and knows the true page count
   * (the manifest has no way to know it before then). Existing records -
   * including any calibration already on them - are left untouched; this
   * only fills gaps, and never removes records for pages beyond `pageCount`
   * (a shrinking page count means the underlying file was replaced, which
   * is a data question, not something to silently resolve here).
   *
   * Returns true if anything changed, so callers can skip a pointless save.
   */
  ensurePages(fileId: Uuid, pageCount: number): boolean {
    const file = this.requireFile(fileId)
    if (file.fileType !== 'pdf') {
      throw new Error(`File ${fileId} is not a PDF; cannot hold pages`)
    }
    if (!Number.isInteger(pageCount) || pageCount < 1) {
      throw new Error(`Invalid page count for ${fileId}: ${pageCount}`)
    }

    const existing = new Set(file.pages.map((p) => p.pageNumber))
    let changed = false
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      if (existing.has(pageNumber)) continue
      file.pages.push({ pageNumber })
      changed = true
    }
    if (!changed) return false

    file.pages.sort((a, b) => a.pageNumber - b.pageNumber)
    file.updatedAt = new Date().toISOString()
    this.dirtyFileIds.add(fileId)
    return true
  }

  /**
   * Resolves a fileId to its absolute path on disk plus the project root it
   * must stay inside, for the PDF chunk reader (src/main/pdfData.ts) that
   * feeds pdf.js. All file access happens in main; the renderer only ever
   * holds a fileId, never a filesystem path, and receives only the byte
   * ranges pdf.js asks for - never a whole document.
   *
   * The root is returned alongside the path so the caller can enforce
   * containment itself - this method deliberately does not decide access,
   * because relativePath comes from a manifest file on disk that a user (or
   * a corrupted/hand-edited project) could point anywhere.
   */
  resolveFilePath(fileId: Uuid): { absolutePath: string; rootPath: string } | undefined {
    if (!this.rootPath || !this.project) return undefined
    const entry = this.project.files.find((f) => f.fileId === fileId)
    if (!entry) return undefined
    return { absolutePath: join(this.rootPath, entry.relativePath), rootPath: this.rootPath }
  }

  getState(): ProjectState {
    return this.toProjectState()
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

    // project.json is the index of which fileIds have sidecars, so it is
    // written last: once this write lands, every sidecar and collection
    // file it depends on has already been durably written above. A crash
    // before this point leaves project.json at its previous (still
    // internally consistent) version; anything written above but not yet
    // indexed is simply orphaned, not corrupt. See open()'s
    // 'manifest-missing' handling, which relies on this ordering.
    if (this.dirtyProject) {
      this.project.updatedAt = new Date().toISOString()
      await writeJson(join(dir, 'project.json'), this.project)
      this.dirtyProject = false
    }
  }

  private requireFile(fileId: Uuid): FileManifest {
    const file = this.files.get(fileId)
    if (!file) throw new Error(`Unknown fileId: ${fileId}`)
    return file
  }

  private toProjectState(): ProjectState {
    if (!this.rootPath || !this.project) throw new Error('No project is open')
    const files: ResolvedFileEntry[] = this.project.files.map((entry) => {
      // An entry with no recorded status shouldn't happen (open/addFile both
      // set one), but default to the pessimistic answer rather than claiming
      // 'ok' for something never actually checked.
      const status = this.fileStatus.get(entry.fileId) ?? {
        sourceStatus: 'missing' as const,
        manifestStatus: 'missing' as const
      }
      return {
        fileId: entry.fileId,
        relativePath: entry.relativePath,
        fileType: entry.fileType,
        sourceStatus: status.sourceStatus,
        manifestStatus: status.manifestStatus,
        manifest: this.requireFile(entry.fileId)
      }
    })

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

function toManifestRelativePath(rootPath: string, absolutePath: string): string {
  return relative(rootPath, absolutePath).split(sep).join('/')
}

async function uniqueDestPath(dir: string, fileName: string): Promise<string> {
  const ext = extname(fileName)
  const base = basename(fileName, ext)
  let candidate = join(dir, fileName)
  let n = 1
  while (await pathExists(candidate)) {
    candidate = join(dir, `${base}-${n}${ext}`)
    n++
  }
  return candidate
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
