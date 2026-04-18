import { ipcMain } from 'electron'
import { Maintenance } from 'eml-lib'
import logger from 'electron-log/main'
import { ADMINTOOL_URL } from '../const'

export function registerMaintenanceHandlers() {
  ipcMain.handle('maintenance:get', async () => {
    const maintenance = new Maintenance(ADMINTOOL_URL)

    try {
      const status = await maintenance.getMaintenance()
      return status?.startTime && new Date(status.startTime) <= new Date() ? status : null
    } catch (err) {
      logger.error('Échec de la récupération de la maintenance :', err)
      return null
    }
  })
}


