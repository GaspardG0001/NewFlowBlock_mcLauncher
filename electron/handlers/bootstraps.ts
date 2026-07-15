import type Electron from 'electron'
import { ipcMain } from 'electron'
import { Bootstrap } from 'eml-lib'
import type { Stats } from 'eml-lib'
import logger from 'electron-log/main'
import { ADMINTOOL_URL } from '../const'

let bootstrap: Bootstrap | null = null

export function registerBootstrapHandlers(mainWindow: Electron.BrowserWindow, stats: Stats) {
  if (!bootstrap) {
    bootstrap = new Bootstrap(ADMINTOOL_URL)
    stats.attach(bootstrap)

    bootstrap.on('download_progress', (data) => {
      mainWindow.webContents.send('bootstraps:download_progress', data)
    })

    bootstrap.on('download_end', (data) => {
      mainWindow.webContents.send('bootstraps:download_end', data)
    })

    bootstrap.on('bootstraps_error', (data) => {
      mainWindow.webContents.send('bootstraps:error', data)
    })
  }

  ipcMain.handle('bootstraps:check', async () => {
    try {
      return await bootstrap?.checkForUpdate()
    } catch (err) {
      logger.error('Erreur lors de la vérification de la mise à jour du bootstrap :', err)
      return { updateAvailable: false }
    }
  })

  ipcMain.handle('bootstraps:download', async () => {
    return await bootstrap?.download()
  })

  ipcMain.handle('bootstraps:install', async () => {
    return await bootstrap?.runUpdate()
  })
}


