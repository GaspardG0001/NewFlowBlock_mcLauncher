import { ipcMain } from 'electron'
import { Maintenance, Profiles } from 'eml-lib'
import type { Account, IProfile } from 'eml-lib'
import logger from 'electron-log/main'
import { ADMINTOOL_URL } from '../const'

export type UserRole = 'Membre' | 'Développeur'

const profileKey = (profile: IProfile) => profile.id ?? profile.slug

async function hasElevatedPermissions(account?: Account): Promise<boolean> {
  if (!account) return false

  const [publicProfiles, accountProfiles, publicMaintenance, accountMaintenance] = await Promise.all([
    new Profiles(ADMINTOOL_URL).getProfiles(),
    new Profiles(ADMINTOOL_URL, account).getProfiles(),
    new Maintenance(ADMINTOOL_URL, undefined as unknown as Account).getMaintenance(),
    new Maintenance(ADMINTOOL_URL, account).getMaintenance()
  ])

  const publicProfileKeys = new Set(publicProfiles.map(profileKey))
  const canAccessHiddenProfile = accountProfiles.some((profile) => !publicProfileKeys.has(profileKey(profile)))
  const canBypassMaintenance = publicMaintenance !== null && accountMaintenance === null

  return canAccessHiddenProfile || canBypassMaintenance
}

export function registerPermissionsHandlers() {
  ipcMain.handle('permissions:get_role', async (_event, account?: Account) => {
    try {
      return (await hasElevatedPermissions(account)) ? 'Développeur' : 'Membre'
    } catch (err) {
      logger.error('Échec de la récupération des permissions :', err)
      return 'Membre'
    }
  })
}
