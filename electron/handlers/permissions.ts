import { ipcMain } from 'electron'
import { DEVELOPPER_ACCOUNTS } from '../const'

export type UserRole = 'Membre' | 'Développeur'

const normalizedDeveloperAccounts = new Set(DEVELOPPER_ACCOUNTS.map((account) => account.toLowerCase()))

export function getUserRole(username?: string | null): UserRole {
  if (!username) return 'Membre'

  const normalizedUsername = username.trim().toLowerCase()
  if (!normalizedUsername) return 'Membre'

  return normalizedDeveloperAccounts.has(normalizedUsername) ? 'Développeur' : 'Membre'
}

export function registerPermissionsHandlers() {
  ipcMain.handle('permissions:get_role', (_event, username?: string | null) => {
    return getUserRole(username)
  })
}
