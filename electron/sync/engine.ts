import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicJson, currentHash, downloadFile, hashFile, isMissing, safeFile, scanFiles, signedUrl } from './files'
import { isSyncPathAllowed, validateFilePath, type SyncRule } from './paths'
import { planSync, type SyncFileState } from './plan'

export interface SyncConflict {
  path: string
  localHash: string | null
  remoteVersion: number | null
  remoteDeleted: boolean
}
interface Manifest {
  revision: string | null
  files: Record<string, SyncFileState>
}
interface LocalState {
  format: 1
  rulesKey?: string
  base: Record<string, SyncFileState>
  remote: Manifest
  conflicts: SyncConflict[]
}
export interface SyncResult {
  success: true
  syncedFiles: number
  conflicts: SyncConflict[]
}
export interface SyncOptions {
  root: string
  stateFile: string
  deviceId: string
  selections: string[]
  mode: 'pull' | 'sync'
  request: (operation: string, body?: Record<string, unknown>, method?: string) => Promise<unknown>
  upload: (url: URL, file: string, size: number, headers: Record<string, string>, progress: (bytes: number) => void) => Promise<void>
  progress?: (value: { completedFiles: number; totalFiles: number; currentPath: string | null; bytesSent: number; fileSize: number }) => void
  resolve?: { path: string; choice: 'local' | 'remote'; localHash: string | null; remoteVersion: number | null }
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Réponse Sync invalide.')
  return input as Record<string, unknown>
}
function revision(input: unknown): string {
  if (typeof input !== 'string' || !/^\d+$/.test(input)) throw new Error('Révision Sync invalide.')
  return input
}
function fileState(input: unknown): SyncFileState {
  const file = record(input)
  if (!Number.isSafeInteger(file.version) || (file.version as number) < 1 || typeof file.deleted !== 'boolean')
    throw new Error('Manifest Sync invalide.')
  if (file.deleted) return { version: file.version as number, deleted: true, hash: null, size: '0' }
  if (typeof file.hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(file.hash) || typeof file.size !== 'string' || !/^\d+$/.test(file.size))
    throw new Error('Manifest Sync invalide.')
  return { version: file.version as number, deleted: false, hash: file.hash, size: file.size }
}
function parseFiles(input: unknown): Record<string, SyncFileState> {
  return Object.assign(
    Object.create(null),
    Object.fromEntries(Object.entries(record(input)).map(([file, value]) => [validateFilePath(file), fileState(value)]))
  )
}
async function loadState(file: string): Promise<LocalState> {
  try {
    const stored = record(JSON.parse(await fs.readFile(file, 'utf8')))
    if (stored.format !== 1) throw new Error('Version du manifest local inconnue.')
    const remote = record(stored.remote)
    return {
      format: 1,
      rulesKey: typeof stored.rulesKey === 'string' ? stored.rulesKey : undefined,
      base: parseFiles(stored.base),
      remote: { revision: remote.revision === null ? null : revision(remote.revision), files: parseFiles(remote.files) },
      conflicts: Array.isArray(stored.conflicts)
        ? stored.conflicts.map((input) => {
            const conflict = record(input)
            if (
              (conflict.localHash !== null && (typeof conflict.localHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(conflict.localHash))) ||
              (conflict.remoteVersion !== null && (!Number.isSafeInteger(conflict.remoteVersion) || (conflict.remoteVersion as number) < 1)) ||
              typeof conflict.remoteDeleted !== 'boolean'
            )
              throw new Error('Conflit local invalide.')
            return {
              path: validateFilePath(conflict.path),
              localHash: conflict.localHash as string | null,
              remoteVersion: conflict.remoteVersion as number | null,
              remoteDeleted: conflict.remoteDeleted
            }
          })
        : []
    }
  } catch (error) {
    if (!isMissing(error)) throw new Error('Le manifest local est illisible. Les fichiers sont conservés ; restaurez le manifest avant de réessayer.')
    return { format: 1, base: Object.create(null), remote: { revision: null, files: Object.create(null) }, conflicts: [] }
  }
}
export async function readSyncConflicts(file: string): Promise<SyncConflict[]> {
  return (await loadState(file)).conflicts
}

async function remoteManifest(options: SyncOptions, state: LocalState): Promise<Manifest> {
  const latest = revision(record(await options.request('revision')).revision)
  if (state.remote.revision === latest) return state.remote
  for (let attempt = 0; attempt < 3; attempt++) {
    let cursor: string | null = null
    let knownRevision: string | undefined
    const files: Record<string, SyncFileState> = Object.create(null)
    const seen = new Set<string>()
    try {
      do {
        const query = new URLSearchParams({ limit: '1000' })
        if (cursor) query.set('cursor', cursor)
        if (knownRevision) query.set('revision', knownRevision)
        const response = record(await options.request(`manifest?${query}`))
        const currentRevision = revision(response.revision)
        if (knownRevision && knownRevision !== currentRevision) throw new Error('MANIFEST_CHANGED')
        knownRevision = currentRevision
        Object.assign(files, parseFiles(response.files))
        if (response.nextCursor !== null && response.nextCursor !== undefined && typeof response.nextCursor !== 'string')
          throw new Error('Curseur Sync invalide.')
        cursor = response.nextCursor as string | null
        if (cursor && seen.has(cursor)) throw new Error('Curseur Sync répété.')
        if (cursor) seen.add(cursor)
      } while (cursor)
      if (revision(record(await options.request('revision')).revision) !== knownRevision) continue
      return { revision: knownRevision!, files }
    } catch (error) {
      if (attempt === 2 || !(error instanceof Error) || !error.message.includes('MANIFEST_CHANGED')) throw error
    }
  }
  throw new Error('Les données distantes changent trop rapidement. Réessayez.')
}

export async function runSync(options: SyncOptions): Promise<SyncResult> {
  const configuration = record(await options.request('config'))
  if (configuration.enabled !== true) return { success: true, syncedFiles: 0, conflicts: [] }
  if (!Array.isArray(configuration.rules)) throw new Error('Configuration Sync invalide.')
  const rules: SyncRule[] = configuration.rules.map((input) => {
    const rule = record(input)
    if (typeof rule.path !== 'string' || !['INCLUDE', 'EXCLUDE'].includes(String(rule.action))) throw new Error('Règle Sync invalide.')
    return { path: rule.path, action: String(rule.action) }
  })
  const selected = new Set(options.selections)
  const allowed = (file: string) => selected.has(file.split('/')[0]) && isSyncPathAllowed(file, rules) && !/\.flowblock-[\w-]+\.tmp$/.test(file)
  const state = await loadState(options.stateFile)
  // A rule change must invalidate the manifest cache, even at the same file revision.
  const rulesKey = JSON.stringify(rules)
  if (state.rulesKey !== rulesKey) state.remote.revision = null
  state.rulesKey = rulesKey
  const remote = await remoteManifest(options, state)
  let rootMissing = false
  try {
    await fs.lstat(options.root)
  } catch (error) {
    if (isMissing(error)) rootMissing = true
    else throw error
  }
  const local = await scanFiles(options.root, options.selections, allowed)
  const paths = [...new Set([...Object.keys(remote.files), ...Object.keys(state.base), ...local.keys()])].filter(allowed).sort()
  // Windows and default macOS volumes cannot represent case aliases safely.
  if (process.platform !== 'linux') {
    const names = new Map<string, string>()
    for (const file of paths) {
      const parts = file.split('/')
      for (let i = 1; i <= parts.length; i++) {
        const actual = parts.slice(0, i).join('/')
        const key = actual.toLowerCase()
        if (names.has(key) && names.get(key) !== actual)
          throw new Error('Deux chemins distants ne diffèrent que par la casse. Corrigez ce conflit depuis un appareil compatible.')
        names.set(key, actual)
      }
    }
  }
  let completedFiles = 0
  let syncedFiles = 0
  const conflicts: SyncConflict[] = []
  const save = async () => {
    state.conflicts = conflicts
    await atomicJson(options.stateFile, state)
  }
  state.remote = remote
  for (const file of paths) {
    const localHash = local.get(file) ?? null
    const remoteFile = remote.files[file]
    let action = planSync(localHash, state.base[file], remoteFile)
    // A missing installation must restore its cloud data, never erase every world.
    if (rootMissing && remoteFile && !remoteFile.deleted && localHash === null) action = 'download'
    const resolution = options.resolve?.path === file ? options.resolve : undefined
    if (resolution) {
      if (resolution.localHash !== localHash || resolution.remoteVersion !== (remoteFile?.version ?? null))
        throw new Error('Le conflit a changé. Actualisez la synchronisation avant de choisir une version.')
      action =
        resolution.choice === 'local'
          ? localHash
            ? 'upload'
            : remoteFile && !remoteFile.deleted
              ? 'deleteRemote'
              : 'unchanged'
          : remoteFile && !remoteFile.deleted
            ? 'download'
            : 'deleteLocal'
    }
    options.progress?.({ completedFiles, totalFiles: paths.length, currentPath: file, bytesSent: 0, fileSize: 0 })
    if (action === 'conflict') {
      conflicts.push({ path: file, localHash, remoteVersion: remoteFile?.version ?? null, remoteDeleted: !remoteFile || remoteFile.deleted })
      continue
    }
    if (action === 'unchanged') {
      if (remoteFile) state.base[file] = remoteFile
      else delete state.base[file]
    } else if (action === 'download' || action === 'deleteLocal') {
      const absolute = await safeFile(options.root, file)
      let temp: string | undefined
      try {
        if (action === 'download') {
          const response = record(await options.request('download', { path: file }))
          const actual = fileState({ ...response, deleted: false })
          if (actual.version !== remoteFile?.version || actual.hash !== remoteFile.hash || actual.size !== remoteFile.size)
            throw new Error('Le fichier distant a changé. Relancez la synchronisation.')
          temp = await downloadFile(signedUrl(response.downloadUrl), absolute, actual.hash!, actual.size)
        }
        if ((await currentHash(options.root, file)) !== localHash) throw new Error('Un fichier local a changé. Relancez la synchronisation.')
        await safeFile(options.root, file)
        if (resolution?.choice === 'remote' && localHash) {
          const backup = path.join(path.dirname(options.stateFile), 'conflict-backups', randomUUID(), ...file.split('/'))
          await fs.mkdir(path.dirname(backup), { recursive: true })
          await fs.copyFile(absolute, backup)
        }
        if (temp) await fs.rename(temp, absolute)
        else await fs.rm(absolute, { force: true })
        if (remoteFile) state.base[file] = remoteFile
        else delete state.base[file]
        syncedFiles++
      } finally {
        if (temp) await fs.rm(temp, { force: true })
      }
    } else if (options.mode === 'sync') {
      if (action === 'deleteRemote') {
        const result = record(
          await options.request('file', { path: file, baseVersion: remoteFile?.version ?? null, deviceId: options.deviceId }, 'DELETE')
        )
        const committed = fileState({ ...record(result.file), size: '0', hash: null, deleted: true })
        state.base[file] = committed
      } else {
        const source = await safeFile(options.root, file)
        const staging = path.join(path.dirname(options.stateFile), `upload-${randomUUID()}.tmp`)
        await fs.mkdir(path.dirname(staging), { recursive: true })
        try {
          await fs.copyFile(source, staging)
          const snapshot = await hashFile(staging)
          if (snapshot.hash !== localHash) throw new Error('Un fichier a changé pendant la préparation. Réessayez.')
          const prepared = record(
            await options.request('upload/prepare', {
              path: file,
              hash: snapshot.hash,
              size: String(snapshot.size),
              baseVersion: remoteFile?.version ?? null,
              deviceId: options.deviceId
            })
          )
          if (typeof prepared.uploadId !== 'string' || typeof prepared.uploadRequired !== 'boolean') throw new Error('Session d’upload invalide.')
          if (prepared.uploadRequired) {
            const headers = record(prepared.uploadHeaders)
            const checksum = Buffer.from(snapshot.hash.slice(7), 'hex').toString('base64')
            if (headers['x-amz-checksum-sha256'] !== checksum) throw new Error('Checksum d’upload invalide.')
            await options.upload(signedUrl(prepared.uploadUrl), staging, snapshot.size, { 'x-amz-checksum-sha256': checksum }, (bytesSent) =>
              options.progress?.({ completedFiles, totalFiles: paths.length, currentPath: file, bytesSent, fileSize: snapshot.size })
            )
          }
          const result = record(await options.request(`upload/${encodeURIComponent(prepared.uploadId)}/commit`, {}))
          const committed = record(result.file)
          if (result.success !== true || committed.path !== file || committed.hash !== snapshot.hash)
            throw new Error('Confirmation d’upload invalide.')
          state.base[file] = fileState({ ...committed, size: String(snapshot.size), deleted: false })
        } finally {
          await fs.rm(staging, { force: true })
        }
      }
      state.remote.revision = null
      syncedFiles++
    }
    completedFiles++
    await save()
  }
  await save()
  options.progress?.({ completedFiles, totalFiles: paths.length, currentPath: null, bytesSent: 0, fileSize: 0 })
  return { success: true, syncedFiles, conflicts }
}
