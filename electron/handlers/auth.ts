import { ipcMain, app } from 'electron'
import { MicrosoftAuth } from 'eml-lib'
import type { Account, Stats } from 'eml-lib'
import logger from 'electron-log/main'
import * as fs from 'node:fs'
import * as path from 'node:path'

const sessionPath = path.join(app.getPath('userData'), 'session.json')

export type AuthErrorCode = 'AUTH_CANCELLED' | 'XBOX_PROFILE_MISSING' | 'MINECRAFT_PROFILE_MISSING'

export type IAuthResponse =
  | { success: true; account: Account }
  | { success: false; error: string; code?: AuthErrorCode }

function getAuthErrorCode(message: string): AuthErrorCode | undefined {
  if (/XErr["']?\s*:\s*2148916233|XErr[^0-9]*2148916233/i.test(message)) {
    return 'XBOX_PROFILE_MISSING'
  }

  if (/Minecraft not owned|Profile request failed|Profile error:/i.test(message)) {
    return 'MINECRAFT_PROFILE_MISSING'
  }

  return undefined
}

export function registerAuthHandlers(mainWindow: Electron.BrowserWindow, stats: Stats) {
  const auth = new MicrosoftAuth(mainWindow)
  stats.attach(auth)

  ipcMain.handle('auth:login', async () => {
    try {
      const account = await auth.auth()
      fs.writeFileSync(sessionPath, JSON.stringify(account))
      return { success: true, account } as IAuthResponse
    } catch (err: any) {
      if (err.code === 'AUTH_CANCELLED') {
        logger.info('Connexion Microsoft annulée par l’utilisateur.')
        return { success: false, error: err.message, code: 'AUTH_CANCELLED' }
      }

      logger.error('Échec de la connexion :', err)
      const error = err.message ?? 'Erreur inconnue'
      return { success: false, error, code: getAuthErrorCode(error) }
    }
  })

  ipcMain.handle('auth:refresh', async () => {
    if (!fs.existsSync(sessionPath)) {
      return { success: false } as { success: false }
    }

    try {
      const data = fs.readFileSync(sessionPath, 'utf-8')
      const savedSession = JSON.parse(data) as Account

      if (savedSession && savedSession.uuid) {
        const valid = await auth.validate(savedSession)
        if (valid) {
          return { success: true, account: savedSession } as IAuthResponse
        }
        const account = await auth.refresh(savedSession)
        fs.writeFileSync(sessionPath, JSON.stringify(account))
        return { success: true, account } as IAuthResponse
      }
      return { success: false }
    } catch (err: any) {
      logger.error('Échec du rafraîchissement de la session :', err)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('auth:logout', async () => {
    if (fs.existsSync(sessionPath)) {
      fs.unlinkSync(sessionPath)
    }
    return { success: true }
  })
}


