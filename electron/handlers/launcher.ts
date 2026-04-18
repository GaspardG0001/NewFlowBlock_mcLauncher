import { ipcMain, BrowserWindow, app } from 'electron'
import { Launcher } from 'eml-lib'
import type { Account, IProfile } from 'eml-lib'
import type { IGameSettings } from './settings'
import logger from 'electron-log/main'
import { ADMINTOOL_URL } from '../const'

export function registerLauncherHandlers(mainWindow: BrowserWindow) {
  ipcMain.handle('game:launch', (_event, payload: { account: Account; settings: IGameSettings; profileSlug: string }) => {
    const { account, settings, profileSlug } = payload
    const java = settings.java === 'system' ? { install: 'manual' as const, absolutePath: 'java' } : { install: 'auto' as const }
    logger.log('Lancement en cours')

    console.log(settings.memory)

    const launcher = new Launcher({
      url: ADMINTOOL_URL,
      root: 'goldfrite',
      profile: { slug: profileSlug },
      account: account,
      cleaning: {
        enabled: false
      },
      java: java,
      memory: {
        min: +settings.memory.min * 1024,
        max: +settings.memory.max * 1024
      },
      window: {
        width: settings.resolution.width,
        height: settings.resolution.height,
        fullscreen: settings.resolution.fullscreen
      }
    })

    launcher.on('launch_compute_download', () => {
      logger.log('Calcul du téléchargement...')
      mainWindow.webContents.send('game:launch_compute_download')
    })

    launcher.on('launch_download', (download) => {
      logger.log(`Téléchargement de ${download.total.amount} fichiers (${download.total.size} o).`)
      mainWindow.webContents.send('game:launch_download', download)
    })
    launcher.on('download_progress', (progress) => {
      mainWindow.webContents.send('game:download_progress', progress)
    })
    launcher.on('download_error', (error) => {
      logger.error(`Erreur lors du téléchargement de ${error.filename} : ${error.message}`)
      mainWindow.webContents.send('game:download_error', error)
    })
    launcher.on('download_end', (info) => {
      logger.log(`${info.downloaded.amount} fichiers téléchargés.`)
      mainWindow.webContents.send('game:download_end', info)
    })

    launcher.on('launch_install_loader', (loader) => {
      logger.log(`Installation du loader ${loader.type} ${loader.loaderVersion}...`)
      mainWindow.webContents.send('game:launch_install_loader', loader)
    })

    launcher.on('launch_extract_natives', () => {
      logger.log('Extraction des natives...')
      mainWindow.webContents.send('game:launch_extract_natives')
    })
    launcher.on('extract_progress', (progress) => {
      logger.log(`Fichier extrait : ${progress.filename}.`)
      mainWindow.webContents.send('game:extract_progress', progress)
    })
    launcher.on('extract_end', (info) => {
      logger.log(`${info.amount} fichiers extraits.`)
      mainWindow.webContents.send('game:extract_end', info)
    })

    launcher.on('launch_copy_assets', () => {
      logger.log('Copie des ressources...')
      mainWindow.webContents.send('game:launch_copy_assets')
    })
    launcher.on('copy_progress', (progress) => {
      logger.log(`Copie de ${progress.filename} vers ${progress.dest}.`)
      mainWindow.webContents.send('game:copy_progress', progress)
    })
    launcher.on('copy_end', (info) => {
      logger.log(`${info.amount} fichiers copiés.`)
      mainWindow.webContents.send('game:copy_end', info)
    })

    launcher.on('launch_patch_loader', () => {
      logger.log('Application des correctifs du loader...')
      mainWindow.webContents.send('game:launch_patch_loader')
    })
    launcher.on('patch_progress', (progress) => {
      mainWindow.webContents.send('game:patch_progress', progress)
    })
    launcher.on('patch_error', (error) => {
      logger.error(`Erreur lors de l'application du correctif sur ${error.filename} : ${error.message}`)
      mainWindow.webContents.send('game:patch_error', error)
    })
    launcher.on('patch_end', (info) => {
      logger.log(`${info.amount} fichiers corrigés.`)
      mainWindow.webContents.send('game:patch_end', info)
    })

    launcher.on('launch_check_java', () => {
      logger.log('Vérification de Java...')
      mainWindow.webContents.send('game:launch_check_java')
    })
    launcher.on('java_info', (info) => {
      logger.log(`Utilisation de Java ${info.version} ${info.arch}`)
      mainWindow.webContents.send('game:java_info', info)
    })

    launcher.on('launch_clean', () => {
      logger.log('Nettoyage du dossier du jeu...')
      mainWindow.webContents.send('game:launch_clean')
    })
    launcher.on('clean_progress', (progress) => {
      mainWindow.webContents.send('game:clean_progress', progress)
    })
    launcher.on('clean_end', (info) => {
      logger.log(`${info.amount} fichiers nettoyés.`)
      mainWindow.webContents.send('game:clean_end', info)
    })

    launcher.on('launch_launch', (info) => {
      logger.log(`Lancement de Minecraft ${info.version} (${info.type}${info.loaderVersion ? ` ${info.loaderVersion}` : ''})...`)
      mainWindow.webContents.send('game:launch_launch', info)
      if (settings.launcherAction === 'close') {
        setTimeout(() => app.quit(), 5000)
      } else if (settings.launcherAction === 'hide') {
        setTimeout(() => mainWindow.minimize(), 5000)
      }
      mainWindow.webContents.send('game:launched')
    })
    launcher.on('launch_data', (message) => {
      logger.log(message)
      mainWindow.webContents.send('game:launch_data', message)
    })
    launcher.on('launch_close', (code) => {
      logger.log(`Fermé avec le code ${code}.`)
      mainWindow.webContents.send('game:launch_close', code)
    })

    launcher.on('launch_debug', (message) => {
      mainWindow.webContents.send('game:launch_debug', message)
    })
    launcher.on('patch_debug', (message) => {
      mainWindow.webContents.send('game:patch_debug', message)
    })

    try {
      launcher.launch()
    } catch (err) {
      logger.error('Launcher error:', err)
    }
  })
}

