import { ipcMain, app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { Profiles } from 'eml-lib'
import logger from 'electron-log/main'
import { ADMINTOOL_URL, GAME_ROOT } from '../const'
import type { IAuthService } from './auth'
import { clearSyncAuth, ensureSyncAuthenticated, getSyncAuthFailure, getSyncBearerToken, type ISyncAuthResult } from './syncAuth'
import { readSyncConflicts, runSync, type SyncConflict, type SyncResult } from '../sync/engine'
import { atomicJson } from '../sync/files'
import { validateFilePath } from '../sync/paths'

const statePath = path.join(app.getPath('userData'), 'sync.json')
export interface ISyncEntry {
  name: string
  isDirectory: boolean
}
interface ISyncState {
  enabled: boolean
  selections: Record<string, string[]>
}
export const DEFAULT_SYNC_SELECTION = [
  'config',
  'resourcepacks',
  'saves',
  'schematics',
  'shaderpacks',
  'journeymap',
  'XaeroWaypoints',
  'XaeroWorldMap',
  'screenshots',
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
export type ISyncUploadResult = SyncResult | { success: false; message: string }
class SyncUploadError extends Error {
  constructor(
    message: string,
    public readonly code?: string
  ) {
    super(message)
  }
}
let activeJob = false
let gameRunning = false
let gameReserved = false

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function readState(): ISyncState {
  try {
    const data = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    if (!isRecord(data)) throw new Error('Invalid Sync settings')
    return {
      enabled: data.enabled === true,
      selections: isRecord(data.selections)
        ? Object.fromEntries(
            Object.entries(data.selections).filter(
              (entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((v) => typeof v === 'string')
            )
          )
        : {}
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { enabled: false, selections: {} }
    throw new SyncUploadError('Les paramètres Sync sont illisibles. Restaurez le fichier sync.json avant de réessayer.')
  }
}
function validateSelection(selection: unknown): string[] {
  if (!Array.isArray(selection) || selection.length > 1000) throw new SyncUploadError('Sélection invalide.')
  return [
    ...new Set(
      selection.map((value) => {
        const name = validateFilePath(value)
        if (name.includes('/')) throw new SyncUploadError('Sélection invalide.')
        return name
      })
    )
  ]
}
function validateProfile(slug: unknown, id: unknown) {
  if (typeof slug !== 'string' || !slug || slug.length > 128 || sanitizeSlug(slug) !== slug || typeof id !== 'string' || !id || id.length > 128)
    throw new SyncUploadError('Profil invalide. Actualisez la liste des profils.')
  return { profileSlug: slug, profileId: id }
}
function sendProgress(sender: Electron.WebContents | undefined, progress: ISyncUploadProgress) {
  if (sender && !sender.isDestroyed()) sender.send('sync:upload_progress', progress)
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
      return new SyncUploadError('La synchronisation est désactivée par l’administrateur.', code)
    case 'SYNC_PROFILE_NOT_FOUND':
      return new SyncUploadError('Ce profil n’a pas de configuration Sync.', code)
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
  if (status === 404) return new SyncUploadError('La synchronisation est désactivée pour ce profil.', code)
  if (status === 413) return new SyncUploadError('Un fichier dépasse les limites de votre espace de synchronisation.')
  if (status === 429) return new SyncUploadError('Trop de demandes ont été envoyées. Patientez un instant puis réessayez.')
  if (status >= 500) return new SyncUploadError('La synchronisation est temporairement indisponible. Réessayez plus tard.')
  return new SyncUploadError('La synchronisation n’a pas pu aboutir. Vérifiez votre sélection puis réessayez.')
}

export function putFile(
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
    const requestHeaders = { ...headers }
    const contentLengthHeaders = Object.keys(requestHeaders).filter((name) => name.toLowerCase() === 'content-length')
    if (contentLengthHeaders.length > 1 || (contentLengthHeaders.length === 1 && requestHeaders[contentLengthHeaders[0]] !== String(fileSize))) {
      throw new SyncUploadError('La longueur du fichier ne correspond pas aux en-têtes d’upload.')
    }
    if (contentLengthHeaders.length === 0) requestHeaders['Content-Length'] = String(fileSize)
    const request = transport.request(
      target,
      {
        method: 'PUT',
        headers: requestHeaders
      },
      (response) => {
        response.resume()
        response.once('end', () => {
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
            resolve()
          } else {
            const statusCode = response.statusCode
            logger.warn('FlowBlock Sync storage upload returned HTTP status:', statusCode ?? 'unknown')
            reject(
              new SyncUploadError(
                statusCode && statusCode >= 500
                  ? `Le service de stockage a rencontré une erreur (HTTP ${statusCode}). Réessayez plus tard.`
                  : `Le stockage a refusé le transfert (HTTP ${statusCode ?? 'inconnu'}). Vérifiez la configuration Sync ou contactez l’administrateur.`
              )
            )
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

async function requestSync(
  authService: IAuthService,
  profileId: string,
  operation: string,
  body?: Record<string, unknown>,
  method?: string,
  expectedPlayer?: string
): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const identity = await ensureSyncAuthenticated(authService.getSavedAccountForSync, authService.refreshSavedAccountForSync)
    if (expectedPlayer && identity.player.minecraftUuid !== expectedPlayer)
      throw new SyncUploadError('Le compte actif a changé. Relancez la synchronisation avec le compte utilisé pour cette partie.')
    const token = await getSyncBearerToken(authService.getSavedAccountForSync, authService.refreshSavedAccountForSync)
    const response = await fetch(new URL(`/api/sync/profiles/${encodeURIComponent(profileId)}/${operation}`, ADMINTOOL_URL), {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
      redirect: 'error'
    })
    if (response.status === 401 && attempt === 0) {
      clearSyncAuth()
      continue
    }
    const result: unknown = await response.json()
    if (!response.ok) {
      if (isRecord(result) && result.code === 'MANIFEST_CHANGED') throw new Error('MANIFEST_CHANGED')
      throw getApiError(result, response.status)
    }
    return result
  }
  throw new SyncUploadError('Reconnectez-vous puis réessayez.')
}

function getManifestPath(profileSlug: string, profileId: string, playerUuid: string): string {
  const key = createHash('sha256')
    .update(JSON.stringify([new URL(ADMINTOOL_URL).origin, playerUuid, profileId, getInstancePath(profileSlug)]))
    .digest('hex')
  return path.join(app.getPath('userData'), 'sync-manifests', key, 'manifest.json')
}

export interface SyncService {
  isEnabled(): boolean
  beforeGame(profileSlug: string, sender: Electron.WebContents, accountUuid: string): Promise<void>
  afterGame(sender: Electron.WebContents): Promise<void>
  launchFailed(): void
  isBusy(): boolean
}

export function registerSyncHandlers(authService: IAuthService): SyncService {
  let activeProfile: { slug: string; id: string; playerUuid: string } | undefined
  const synchronize = async (
    profileSlug: string,
    profileId: string,
    sender?: Electron.WebContents,
    mode: 'pull' | 'sync' = 'sync',
    resolve?: { path: string; choice: 'local' | 'remote'; localHash: string | null; remoteVersion: number | null },
    internal = false,
    expectedPlayer?: string
  ): Promise<SyncResult> => {
    validateProfile(profileSlug, profileId)
    if (activeJob || (!internal && (gameRunning || gameReserved)))
      throw new SyncUploadError('Fermez Minecraft et attendez la fin de la synchronisation en cours.')
    activeJob = true
    try {
      const state = readState()
      if (!state.enabled) throw new SyncUploadError('Activez FlowBlock Sync avant de synchroniser.')
      const status = await ensureSyncAuthenticated(authService.getSavedAccountForSync, authService.refreshSavedAccountForSync)
      if (expectedPlayer && status.player.minecraftUuid !== expectedPlayer)
        throw new SyncUploadError('Le compte actif a changé depuis le lancement du jeu. Les données locales sont conservées.')
      const stateFile = getManifestPath(profileSlug, profileId, status.player.minecraftUuid)
      return await runSync({
        root: getInstancePath(profileSlug),
        stateFile,
        deviceId: status.deviceId,
        selections: validateSelection(state.selections[profileSlug] ?? DEFAULT_SYNC_SELECTION),
        mode,
        resolve,
        request: (operation, body, method) => requestSync(authService, profileId, operation, body, method, status.player.minecraftUuid),
        upload: (url, file, size, headers, progress) => putFile(url.toString(), headers, file, size, progress),
        progress: (progress) => sendProgress(sender, progress)
      })
    } finally {
      activeJob = false
    }
  }
  ipcMain.handle('sync:get_state', () => readState().enabled)
  ipcMain.handle('sync:authenticate', async (): Promise<ISyncAuthResult> => {
    try {
      return { success: true, status: await ensureSyncAuthenticated(authService.getSavedAccountForSync, authService.refreshSavedAccountForSync) }
    } catch (error) {
      return getSyncAuthFailure(error)
    }
  })
  ipcMain.handle('sync:set_enabled', async (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid Sync enabled value')
    if (activeJob || gameReserved || gameRunning)
      return { success: false, message: 'Fermez Minecraft et attendez la fin de la synchronisation.', canRetry: true }
    if (enabled) {
      try {
        await ensureSyncAuthenticated(authService.getSavedAccountForSync, authService.refreshSavedAccountForSync)
      } catch (error) {
        return getSyncAuthFailure(error)
      }
    } else clearSyncAuth()
    const state = readState()
    state.enabled = enabled
    await atomicJson(statePath, state)
    return { success: true }
  })
  ipcMain.handle('sync:list_instance_entries', async (_event, profileSlug: string, profileId?: string): Promise<ISyncEntry[]> => {
    validateProfile(profileSlug, profileId ?? 'local')
    const entries = new Map<string, ISyncEntry>()
    const root = getInstancePath(profileSlug)
    if (fs.existsSync(root))
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isSymbolicLink()) entries.set(entry.name, { name: entry.name, isDirectory: entry.isDirectory() })
      }
    if (profileId && readState().enabled) {
      const config = await requestSync(authService, profileId, 'config')
      if (isRecord(config) && Array.isArray(config.rules))
        for (const rule of config.rules) {
          if (!isRecord(rule) || rule.action !== 'INCLUDE' || typeof rule.path !== 'string') continue
          const name = rule.path.split('/')[0]
          if (!name || /[?*]/.test(name)) continue
          if (!entries.has(name)) entries.set(name, { name, isDirectory: rule.path.includes('/') })
        }
    }
    return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name))
  })
  ipcMain.handle('sync:get_selection', (_event, profileSlug: string) => {
    validateProfile(profileSlug, 'local')
    return readState().selections[profileSlug] ?? [...DEFAULT_SYNC_SELECTION]
  })
  ipcMain.handle('sync:set_selection', async (_event, payload: { profileSlug: string; selection: string[] }) => {
    if (activeJob || gameRunning || gameReserved) throw new SyncUploadError('Fermez Minecraft avant de modifier la sélection.')
    validateProfile(payload.profileSlug, 'local')
    const state = readState()
    state.selections[payload.profileSlug] = validateSelection(payload.selection)
    await atomicJson(statePath, state)
    return true
  })
  const resolveConflict = async (
    sender: Electron.WebContents,
    payload: {
      profileSlug: string
      profileId: string
      resolve: { path: string; choice: 'local' | 'remote'; localHash: string | null; remoteVersion: number | null }
    }
  ): Promise<ISyncUploadResult> => {
    try {
      if (!payload.resolve || !['local', 'remote'].includes(payload.resolve.choice)) throw new Error('Choix invalide.')
      return await synchronize(payload.profileSlug, payload.profileId, sender, 'sync', payload.resolve)
    } catch (error) {
      // Do not log HTTP errors that might contain temporary URLs or tokens.
      logger.warn('FlowBlock Sync a échoué.')
      return { success: false, message: error instanceof Error ? error.message : 'La synchronisation a échoué. Réessayez.' }
    }
  }
  ipcMain.handle('sync:get_conflicts', async (_event, payload: { profileSlug: string; profileId: string }): Promise<SyncConflict[]> => {
    const { profileSlug, profileId } = validateProfile(payload?.profileSlug, payload?.profileId)
    if (!readState().enabled) return []
    const status = await ensureSyncAuthenticated(authService.getSavedAccountForSync, authService.refreshSavedAccountForSync)
    return readSyncConflicts(getManifestPath(profileSlug, profileId, status.player.minecraftUuid))
  })
  ipcMain.handle('sync:resolve_conflict', (event, payload) => resolveConflict(event.sender, payload))
  return {
    isEnabled: () => readState().enabled,
    isBusy: () => activeJob || gameRunning || gameReserved,
    beforeGame: async (slug, sender, accountUuid) => {
      if (activeJob || gameRunning || gameReserved) throw new SyncUploadError('Une partie ou une synchronisation est déjà en cours.')
      gameReserved = true
      try {
        if (readState().enabled) {
          const identity = await ensureSyncAuthenticated(authService.getSavedAccountForSync, authService.refreshSavedAccountForSync)
          if (identity.player.minecraftUuid !== accountUuid.replace(/-/g, '').toLowerCase())
            throw new SyncUploadError('Le compte de la partie ne correspond plus au compte connecté. Reconnectez-vous.')
          const account = await authService.getSavedAccountForSync()
          const profiles = await new Profiles(ADMINTOOL_URL, account).getProfiles()
          const profile = profiles.find((p) => p.slug === slug)
          if (!profile || typeof profile.id !== 'string') throw new SyncUploadError('Profil introuvable pour Sync.')
          activeProfile = { slug, id: profile.id, playerUuid: identity.player.minecraftUuid }
          const result = await synchronize(slug, profile.id, sender, 'pull', undefined, true)
          if (result.conflicts.length)
            throw new SyncUploadError(
              'Des fichiers sont en conflit. Ouvrez FlowBlock Sync dans les paramètres pour choisir les versions à conserver.'
            )
        }
        gameRunning = true
      } catch (error) {
        if ((error instanceof SyncUploadError && error.code === 'SYNC_DISABLED') || (error instanceof Error && error.message === 'SYNC_DISABLED')) {
          activeProfile = undefined
          gameRunning = true
          return
        }
        gameReserved = false
        activeProfile = undefined
        throw error
      }
    },
    afterGame: async (sender) => {
      gameRunning = false
      try {
        if (activeProfile && readState().enabled) {
          const result = await synchronize(activeProfile.slug, activeProfile.id, sender, 'sync', undefined, true, activeProfile.playerUuid)
          if (!sender.isDestroyed()) sender.send('sync:completed', result)
        }
      } catch (error) {
        if (!sender.isDestroyed())
          sender.send('sync:completed', {
            success: false,
            message: error instanceof Error ? error.message : 'Synchronisation après partie interrompue.'
          })
      } finally {
        gameReserved = false
        activeProfile = undefined
      }
    },
    launchFailed: () => {
      gameRunning = false
      gameReserved = false
      activeProfile = undefined
    }
  }
}
