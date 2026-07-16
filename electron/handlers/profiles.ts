import { ipcMain } from 'electron'
import { Profiles } from 'eml-lib'
import type { Account } from 'eml-lib'
import logger from 'electron-log/main'
import { ADMINTOOL_URL } from '../const'

export function registerProfilesHandlers() {
  ipcMain.handle('profiles:get', async (_event, account?: Account) => {
    const profiles = new Profiles(ADMINTOOL_URL, account)

    try {
      const list = await profiles.getProfiles()
      const sorted = [list.find((p) => p.isDefault)!, ...list.filter((p) => !p.isDefault)]
      return sorted
    } catch (err) {
      logger.error('Échec de la récupération des profils :', err)
      return null
    }
  })
}

