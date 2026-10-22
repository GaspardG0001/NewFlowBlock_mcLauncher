import { ipcMain, app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import logger from 'electron-log/main'
import { ADMINTOOL_URL, GAME_ROOT } from '../const'
import type { IAuthService } from './auth'
import { clearSyncAuth, ensureSyncAuthenticated, getSyncAuthFailure, getSyncBearerToken, type ISyncAuthResult } from './syncAuth'

const statePath = path.join(app.getPath('userData'), 'sync.json')

export interface ISyncEntry {
  name: string
  isDirectory: boolean
}

interface ISyncState {
  enabled: boolean
  selections: Record<string, string[]>
  versions: Record<string, Record<string, number>>
}

// Entries selected by default when a profile is synced for the first time.
export const DEFAULT_SYNC_SELECTION = [
  'config',
  'resourcepacks',
  'saves',
  'schematics',
  'shaderpacks',
  'journeymap',
  'WayPointData.dat',
  'options.txt'
]

export interface ISyncUploadProgress {
  completedFiles: number
  totalFiles: number
  currentPath: string | null
  bytesSent: number
  fileSize: number
}

export type ISyncUploadResult = { success: true; syncedFiles: number } | { success: false; message: string }

interface ISyncFile {
  absolutePath: string
  relativePath: string
}

interface IPreparedUpload {
  uploadRequired: boolean
  uploadId: string
  uploadUrl?: string
  uploadHeaders?: Record<string, string>
}

class SyncUploadError extends Error {}

function createDefaultState(): ISyncState {
  return { enabled: false, selections: {}, versions: {} }
}

function readState(): ISyncState {
  try {
    if (!fs.existsSync(statePath)) return createDefaultState()
    const data = fs.readFileSync(statePath, 'utf-8')
    const parsed: unknown = JSON.parse(data)
    if (!isRecord(parsed)) throw new Error('Le fichier d’état FlowBlock Sync est invalide.')

    const selections = isRecord(parsed.selections) ? parsed.selections : {}
    const versions = isRecord(parsed.versions) ? parsed.versions : {}

    return {
      enabled: parsed.enabled === true,
      selections: Object.fromEntries(
        Object.entries(selections).filter(
          (entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((value) => typeof value === 'string')
        )
      ),
      versions: Object.fromEntries(
        Object.entries(versions)
          .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
          .map(([profileSlug, entries]) => [
            profileSlug,
            Object.fromEntries(
              Object.entries(entries).filter(
                (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isSafeInteger(entry[1]) && entry[1] >= 1
              )
            )
          ])
      )
    }
  } catch (err) {
    logger.error("Erreur lors de la lecture de l'état de synchronisation :", err)
    return createDefaultState()
  }
}

function writeState(state: ISyncState) {
  try {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
    return true
  } catch (err) {
    logger.error("Erreur lors de l'écriture de l'état de synchronisation :", err)
    return false
  }
}

function sanitizeSlug(slug: string) {
  return slug
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
}

// Mirrors eml-lib's Utils.getAppDataFolder/getServerFolder/getRootFolder so the listed
// files always match the instance directory actually used by the launcher (see launcher.ts).
function getInstancePath(profileSlug: string) {
  const platform = process.platform
  const appDataFolder =
    platform === 'win32' ? process.env.APPDATA + '' : platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : os.homedir()

  const serverFolderName = platform === 'darwin' ? GAME_ROOT : `.${GAME_ROOT}`
  const serverFolder = path.join(appDataFolder, serverFolderName)

  return path.join(serverFolder, sanitizeSlug(profileSlug))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sendUploadProgress(sender: Electron.WebContents, progress: ISyncUploadProgress): void {
  if (!sender.isDestroyed()) sender.send('sync:upload_progress', progress)
}

function validateProfile(profileSlug: unknown, profileId: unknown): { profileSlug: string; profileId: string } {
  if (typeof profileSlug !== 'string' || profileSlug.length === 0 || profileSlug.length > 128 || sanitizeSlug(profileSlug).length === 0) {
    throw new SyncUploadError('Le profil sélectionné est invalide. Actualisez la liste des profils puis réessayez.')
  }
  if (typeof profileId !== 'string' || profileId.length === 0 || profileId.length > 128) {
    throw new SyncUploadError('Ce profil n’est plus disponible. Actualisez la liste des profils puis réessayez.')
  }
  return { profileSlug, profileId }
}

function assertSelectedName(name: string): void {
  if (!name || name === '.' || name === '..' || name.includes(path.sep) || (path.sep !== path.posix.sep && name.includes(path.posix.sep))) {
    throw new SyncUploadError('La sélection de fichiers n’est pas valide. Vérifiez-la puis réessayez.')
  }
}

async function collectSelectedFiles(instancePath: string, selections: string[]): Promise<ISyncFile[]> {
  const root = path.resolve(instancePath)
  const files: ISyncFile[] = []

  async function visit(absolutePath: string): Promise<void> {
    const resolvedPath = path.resolve(absolutePath)
    if (!resolvedPath.startsWith(`${root}${path.sep}`)) {
      throw new Error('Un chemin sélectionné sort du dossier du profil.')
    }

    const entry = await fs.promises.lstat(resolvedPath)
    if (entry.isSymbolicLink()) {
      throw new SyncUploadError('Un élément sélectionné ne peut pas être synchronisé. Vérifiez la sélection puis réessayez.')
    }
    if (entry.isDirectory()) {
      const children = await fs.promises.readdir(resolvedPath, { withFileTypes: true })
      for (const child of children) {
        await visit(path.join(resolvedPath, child.name))
      }
      return
    }
    if (!entry.isFile()) {
      throw new SyncUploadError('Un élément sélectionné ne peut pas être synchronisé. Vérifiez la sélection puis réessayez.')
    }

    files.push({
      absolutePath: resolvedPath,
      relativePath: path.relative(root, resolvedPath).split(path.sep).join('/')
    })
  }

  for (const selection of selections) {
    assertSelectedName(selection)
    await visit(path.join(root, selection))
  }

  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

async function hashFile(filePath: string): Promise<{ hash: string; size: number }> {
  const before = await fs.promises.stat(filePath)
  if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0) {
    throw new SyncUploadError('Un fichier sélectionné ne peut pas être envoyé. Vérifiez sa taille puis réessayez.')
  }

  const hasher = createHash('sha256')
  let bytesRead = 0
  for await (const chunk of createReadStream(filePath)) {
    hasher.update(chunk)
    bytesRead += chunk.length
  }

  const after = await fs.promises.stat(filePath)
  if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new SyncUploadError('Un fichier a changé pendant la synchronisation. Relancez l’envoi.')
  }

  return { hash: `sha256:${hasher.digest('hex')}`, size: bytesRead }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new SyncUploadError('Le service de synchronisation rencontre un problème. Réessayez plus tard.')
  }
}

function getApiError(body: unknown, status: number): Error {
  const code = isRecord(body) && typeof body.code === 'string' ? body.code : undefined
  switch (code) {
    case 'VERSION_CONFLICT':
      return new SyncUploadError('Un fichier a changé sur un autre appareil. Aucun fichier n’a été remplacé.')
    case 'PATH_NOT_ALLOWED':
      return new SyncUploadError('Certains fichiers de cette sélection ne peuvent pas être synchronisés.')
    case 'FILE_TOO_LARGE':
      return new SyncUploadError('Un fichier sélectionné dépasse la taille autorisée.')
    case 'QUOTA_EXCEEDED':
      return new SyncUploadError('Votre espace de synchronisation est plein.')
    case 'SYNC_DISABLED':
    case 'SYNC_PROFILE_NOT_FOUND':
      return new SyncUploadError('La synchronisation n’est pas disponible pour ce profil.')
    case 'UNAUTHORIZED':
      return new SyncUploadError('Votre session a expiré. Reconnectez-vous puis réessayez.')
    case 'DEVICE_NOT_FOUND':
      return new SyncUploadError('Cet appareil n’est plus reconnu. Désactivez puis réactivez FlowBlock Sync.')
    case 'SYNC_STORAGE_NOT_CONFIGURED':
      return new SyncUploadError('La synchronisation est temporairement indisponible. Réessayez plus tard.')
    case 'INVALID_REQUEST':
    case 'INVALID_PATH':
    case 'INVALID_HASH':
    case 'INVALID_SIZE':
    case 'INVALID_VERSION':
    case 'INVALID_DEVICE':
      return new SyncUploadError('Un fichier de la sélection ne peut pas être synchronisé.')
  }

  if (isRecord(body)) {
    if (typeof body.message === 'string' && body.message.length > 0) logger.warn('Erreur du service FlowBlock Sync :', body.message)
  }
  if (status === 401) return new SyncUploadError('Votre session a expiré. Reconnectez-vous puis réessayez.')
  if (status === 403) return new SyncUploadError('Certains fichiers ne sont pas autorisés pour la synchronisation.')
  if (status === 404) return new SyncUploadError('La synchronisation n’est pas disponible pour ce profil.')
  if (status === 413) return new SyncUploadError('Un fichier dépasse les limites de votre espace de synchronisation.')
  if (status === 429) return new SyncUploadError('Trop de demandes ont été envoyées. Patientez un instant puis réessayez.')
  if (status >= 500) return new SyncUploadError('La synchronisation est temporairement indisponible. Réessayez plus tard.')
  return new SyncUploadError('La synchronisation n’a pas pu aboutir. Vérifiez votre sélection puis réessayez.')
}

async function requestSyncJson(url: URL, token: string, body?: Record<string, unknown>): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000)
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new SyncUploadError('La synchronisation prend trop de temps. Vérifiez votre connexion puis réessayez.')
    }
    throw new SyncUploadError('Impossible de joindre le service de synchronisation. Vérifiez votre connexion puis réessayez.')
  }

  const responseBody = await readJsonResponse(response)
  if (!response.ok) throw getApiError(responseBody, response.status)
  return responseBody
}

function validatePreparedUpload(body: unknown, hash: string): IPreparedUpload {
  if (!isRecord(body) || typeof body.uploadRequired !== 'boolean' || typeof body.uploadId !== 'string' || body.uploadId.length === 0) {
    throw new SyncUploadError('La synchronisation est temporairement indisponible. Réessayez plus tard.')
  }

  if (!body.uploadRequired) return { uploadRequired: false, uploadId: body.uploadId }

  if (typeof body.uploadUrl !== 'string' || typeof body.expiresAt !== 'string' || !Number.isFinite(Date.parse(body.expiresAt))) {
    throw new SyncUploadError('La synchronisation est temporairement indisponible. Réessayez plus tard.')
  }

  const uploadUrl = new URL(body.uploadUrl)
  if (
    (uploadUrl.protocol !== 'https:' && uploadUrl.protocol !== 'http:') ||
    uploadUrl.username.length > 0 ||
    uploadUrl.password.length > 0 ||
    (uploadUrl.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(uploadUrl.hostname))
  ) {
    throw new SyncUploadError('La synchronisation est temporairement indisponible. Réessayez plus tard.')
  }

  const expectedChecksum = Buffer.from(hash.slice('sha256:'.length), 'hex').toString('base64')
  if (!isRecord(body.uploadHeaders) || body.uploadHeaders['x-amz-checksum-sha256'] !== expectedChecksum) {
    throw new SyncUploadError('La synchronisation est temporairement indisponible. Réessayez plus tard.')
  }

  return {
    uploadRequired: true,
    uploadId: body.uploadId,
    uploadUrl: uploadUrl.toString(),
    uploadHeaders: { 'x-amz-checksum-sha256': expectedChecksum }
  }
}

function putFile(
  uploadUrl: string,
  headers: Record<string, string>,
  filePath: string,
  fileSize: number,
  onProgress: (bytesSent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const target = new URL(uploadUrl)
    const transport = target.protocol === 'https:' ? https : http
    const source = createReadStream(filePath)
    const request = transport.request(
      target,
      {
        method: 'PUT',
        headers: { ...headers, 'Content-Length': String(fileSize) }
      },
      (response) => {
        response.resume()
        response.once('end', () => {
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
            resolve()
          } else {
            reject(new SyncUploadError('Impossible de transmettre un fichier. Vérifiez votre connexion puis réessayez.'))
          }
        })
      }
    )

    let bytesSent = 0
    let lastProgressAt = Date.now()
    request.setTimeout(120_000, () => request.destroy(new SyncUploadError('L’envoi prend trop de temps. Vérifiez votre connexion puis réessayez.')))
    source.on('data', (chunk: Buffer | string) => {
      bytesSent += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
      const now = Date.now()
      if (now - lastProgressAt >= 200 || bytesSent === fileSize) {
        lastProgressAt = now
        onProgress(bytesSent)
      }
    })
    source.once('error', (error) => request.destroy(error))
    request.once('error', (error) => {
      source.destroy()
      reject(error)
    })
    source.pipe(request)
  })
}

export function registerSyncHandlers(authService: IAuthService) {
  ipcMain.handle('sync:get_state', async () => {
    return readState().enabled
  })

  ipcMain.handle('sync:authenticate', async (): Promise<ISyncAuthResult> => {
    try {
      const status = await ensureSyncAuthenticated(authService.getSavedAccountForSync, authService.refreshSavedAccountForSync)
      return { success: true, status }
    } catch (error) {
      return getSyncAuthFailure(error)
    }
  })

  ipcMain.handle('sync:set_enabled', async (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid Sync enabled value.')

    if (enabled) {
      try {
        await ensureSyncAuthenticated(authService.getSavedAccountForSync, authService.refreshSavedAccountForSync)
      } catch (error) {
        return getSyncAuthFailure(error)
      }
    } else {
      clearSyncAuth()
    }

    const state = readState()
    state.enabled = enabled
    const written = writeState(state)
    if (!written && enabled) clearSyncAuth()
    if (!written) {
      return {
        success: false,
        message: 'Impossible d’enregistrer votre préférence FlowBlock Sync. Vérifiez l’espace disponible sur votre appareil et réessayez.',
        canRetry: true
      }
    }
    return { success: true }
  })

  ipcMain.handle('sync:list_instance_entries', async (_event, profileSlug: string): Promise<ISyncEntry[]> => {
    try {
      const instancePath = getInstancePath(profileSlug)
      if (!fs.existsSync(instancePath)) return []

      return fs
        .readdirSync(instancePath, { withFileTypes: true })
        .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
        .sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1))
    } catch (err) {
      logger.error("Erreur lors de la lecture du dossier d'instance :", err)
      return []
    }
  })

  ipcMain.handle('sync:get_selection', async (_event, profileSlug: string): Promise<string[]> => {
    const state = readState()
    const instancePath = getInstancePath(profileSlug)
    if (!fs.existsSync(instancePath)) return []
    const availableEntries = new Set(fs.readdirSync(instancePath).map((entry) => entry))
    return (state.selections[profileSlug] ?? [...DEFAULT_SYNC_SELECTION]).filter((name) => availableEntries.has(name))
  })

  ipcMain.handle('sync:set_selection', async (_event, payload: { profileSlug: string; selection: string[] }) => {
    const state = readState()
    state.selections[payload.profileSlug] = payload.selection
    return writeState(state)
  })

  ipcMain.handle('sync:upload_selected', async (event, payload: { profileSlug: unknown; profileId: unknown }): Promise<ISyncUploadResult> => {
    try {
      const { profileSlug, profileId } = validateProfile(payload?.profileSlug, payload?.profileId)
      const state = readState()
      if (!state.enabled) throw new SyncUploadError('Activez FlowBlock Sync avant de lancer un envoi.')

      const selectedNames = state.selections[profileSlug] ?? [...DEFAULT_SYNC_SELECTION]
      if (selectedNames.length === 0) throw new SyncUploadError('Sélectionnez au moins un fichier ou dossier à synchroniser.')

      const instancePath = getInstancePath(profileSlug)
      if (!fs.existsSync(instancePath)) throw new SyncUploadError('Aucun fichier à envoyer pour ce profil.')

      let files: ISyncFile[]
      try {
        const availableEntries = new Set(await fs.promises.readdir(instancePath))
        files = await collectSelectedFiles(
          instancePath,
          selectedNames.filter((name) => availableEntries.has(name))
        )
      } catch (error) {
        logger.error('Impossible de lire les fichiers sélectionnés pour FlowBlock Sync :', error)
        if (error instanceof SyncUploadError) throw error
        throw new SyncUploadError('Impossible d’accéder aux fichiers sélectionnés. Vérifiez qu’ils sont disponibles puis réessayez.')
      }
      if (files.length === 0) throw new SyncUploadError('Aucun fichier à envoyer dans la sélection de ce profil.')

      let authStatus: Awaited<ReturnType<typeof ensureSyncAuthenticated>>
      let token: string
      try {
        authStatus = await ensureSyncAuthenticated(authService.getSavedAccountForSync, authService.refreshSavedAccountForSync)
        token = await getSyncBearerToken(authService.getSavedAccountForSync, authService.refreshSavedAccountForSync)
      } catch (error) {
        const failure = getSyncAuthFailure(error)
        throw new SyncUploadError(failure.message)
      }

      let syncedFiles = 0

      for (const [index, file] of files.entries()) {
        try {
          sendUploadProgress(event.sender, {
            completedFiles: syncedFiles,
            totalFiles: files.length,
            currentPath: file.relativePath,
            bytesSent: 0,
            fileSize: 0
          })

          const { hash, size } = await hashFile(file.absolutePath)
          const baseVersion = state.versions[profileSlug]?.[file.relativePath] ?? null
          const prepareResponse = await requestSyncJson(
            new URL(`/api/sync/profiles/${encodeURIComponent(profileId)}/upload/prepare`, ADMINTOOL_URL),
            token,
            {
              path: file.relativePath,
              hash,
              size: String(size),
              baseVersion,
              deviceId: authStatus.deviceId
            }
          )
          const prepared = validatePreparedUpload(prepareResponse, hash)

          if (prepared.uploadRequired) {
            sendUploadProgress(event.sender, {
              completedFiles: syncedFiles,
              totalFiles: files.length,
              currentPath: file.relativePath,
              bytesSent: 0,
              fileSize: size
            })
            await putFile(prepared.uploadUrl!, prepared.uploadHeaders!, file.absolutePath, size, (bytesSent) => {
              sendUploadProgress(event.sender, {
                completedFiles: syncedFiles,
                totalFiles: files.length,
                currentPath: file.relativePath,
                bytesSent,
                fileSize: size
              })
            })
          }

          const commitResponse = await requestSyncJson(
            new URL(`/api/sync/profiles/${encodeURIComponent(profileId)}/upload/${encodeURIComponent(prepared.uploadId)}/commit`, ADMINTOOL_URL),
            token,
            {}
          )

          if (
            !isRecord(commitResponse) ||
            commitResponse.success !== true ||
            !isRecord(commitResponse.file) ||
            commitResponse.file.path !== file.relativePath ||
            commitResponse.file.hash !== hash ||
            typeof commitResponse.file.version !== 'number' ||
            !Number.isSafeInteger(commitResponse.file.version) ||
            commitResponse.file.version < 1
          ) {
            throw new SyncUploadError('La synchronisation est temporairement indisponible. Réessayez plus tard.')
          }

          const committedVersion = commitResponse.file.version
          state.versions[profileSlug] ??= {}
          state.versions[profileSlug][file.relativePath] = committedVersion
          if (!writeState(state)) {
            throw new SyncUploadError('Un fichier a été envoyé, mais la synchronisation ne peut pas continuer. Relancez-la.')
          }

          syncedFiles += 1
          sendUploadProgress(event.sender, {
            completedFiles: syncedFiles,
            totalFiles: files.length,
            currentPath: index + 1 < files.length ? files[index + 1].relativePath : null,
            bytesSent: 0,
            fileSize: 0
          })
        } catch (error) {
          logger.error(`Échec de l’envoi FlowBlock Sync pour ${file.relativePath} :`, error)
          if (error instanceof SyncUploadError) {
            throw new SyncUploadError(`${error.message} (${syncedFiles}/${files.length} fichiers envoyés).`)
          }
          const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
          if (code === 'ENOENT') {
            throw new SyncUploadError('Un fichier sélectionné est introuvable. Actualisez la sélection puis réessayez.')
          }
          if (code === 'EACCES' || code === 'EPERM') {
            throw new SyncUploadError('L’accès à un fichier sélectionné est refusé. Fermez le jeu puis réessayez.')
          }
          throw new SyncUploadError('Un fichier n’a pas pu être synchronisé. Vérifiez votre connexion puis réessayez.')
        }
      }

      return { success: true, syncedFiles }
    } catch (error) {
      logger.error('Échec de la synchronisation FlowBlock Sync :', error)
      if (error instanceof SyncUploadError) return { success: false, message: error.message }
      return { success: false, message: 'La synchronisation n’a pas abouti. Vérifiez votre connexion puis réessayez.' }
    }
  })
}
