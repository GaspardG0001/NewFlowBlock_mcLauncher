import { ipcMain, app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import logger from 'electron-log/main'
import { GAME_ROOT } from '../const'
import type { IAuthService } from './auth'
import { clearSyncAuth, ensureSyncAuthenticated, type ISyncAuthStatus } from './syncAuth'

const statePath = path.join(app.getPath('userData'), 'sync.json')

export interface ISyncEntry {
  name: string
  isDirectory: boolean
}

interface ISyncState {
  enabled: boolean
  selections: Record<string, string[]>
}

// Entries selected by default when a profile is synced for the first time.
export const DEFAULT_SYNC_SELECTION = ['config', 'resourcepacks', 'saves', 'schematics', 'shaderpacks', 'journeymap', 'WayPointData.dat', 'options.txt']

const DEFAULT_STATE: ISyncState = { enabled: false, selections: {} }

function readState(): ISyncState {
  try {
    if (!fs.existsSync(statePath)) return { ...DEFAULT_STATE }
    const data = fs.readFileSync(statePath, 'utf-8')
    return { ...DEFAULT_STATE, ...JSON.parse(data) }
  } catch (err) {
    logger.error('Erreur lors de la lecture de l\'état de synchronisation :', err)
    return { ...DEFAULT_STATE }
  }
}

function writeState(state: ISyncState) {
  try {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
    return true
  } catch (err) {
    logger.error('Erreur lors de l\'écriture de l\'état de synchronisation :', err)
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

export function registerSyncHandlers(authService: IAuthService) {
  ipcMain.handle('sync:get_state', async () => {
    return readState().enabled
  })

  ipcMain.handle('sync:authenticate', async (): Promise<ISyncAuthStatus> => {
    return ensureSyncAuthenticated(authService.getSavedAccountForSync, authService.refreshSavedAccountForSync)
  })

  ipcMain.handle('sync:set_enabled', async (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid Sync enabled value.')

    if (enabled) {
      await ensureSyncAuthenticated(authService.getSavedAccountForSync, authService.refreshSavedAccountForSync)
    } else {
      clearSyncAuth()
    }

    const state = readState()
    state.enabled = enabled
    const written = writeState(state)
    if (!written && enabled) clearSyncAuth()
    return written
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
      logger.error('Erreur lors de la lecture du dossier d\'instance :', err)
      return []
    }
  })

  ipcMain.handle('sync:get_selection', async (_event, profileSlug: string): Promise<string[]> => {
    const state = readState()
    return state.selections[profileSlug] ?? [...DEFAULT_SYNC_SELECTION]
  })

  ipcMain.handle('sync:set_selection', async (_event, payload: { profileSlug: string; selection: string[] }) => {
    const state = readState()
    state.selections[payload.profileSlug] = payload.selection
    return writeState(state)
  })
}
