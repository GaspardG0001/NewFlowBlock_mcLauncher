import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Account } from 'eml-lib'
import { ADMINTOOL_URL } from '../const'

const deviceIdPath = path.join(app.getPath('userData'), 'sync-device-id')
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
const PLAYER_UUID_PATTERN = /^[\da-f]{32}$/
const TOKEN_REAUTHENTICATION_WINDOW_MS = 60_000

export interface ISyncAuthStatus {
  expiresAt: string
  player: {
    minecraftUuid: string
    minecraftName: string
  }
  deviceId: string
}

interface IHandshakeResponse extends ISyncAuthStatus {
  success: true
  token: string
  tokenType: 'Bearer'
}

let syncToken: string | undefined
let syncTokenExpiresAt = 0
let syncAuthStatus: ISyncAuthStatus | undefined

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function readOrCreateDeviceId(): string {
  try {
    const stored = fs.readFileSync(deviceIdPath, 'utf8').trim()
    if (!UUID_PATTERN.test(stored)) {
      throw new Error('L’identifiant de cet appareil pour Player Sync est invalide. Supprimez le fichier sync-device-id pour le régénérer.')
    }
    return stored.toLowerCase()
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error
  }

  const deviceId = randomUUID()
  try {
    fs.writeFileSync(deviceIdPath, deviceId, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    return deviceId
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) throw error
    const stored = fs.readFileSync(deviceIdPath, 'utf8').trim()
    if (!UUID_PATTERN.test(stored)) {
      throw new Error('L’identifiant de cet appareil pour Player Sync est invalide.')
    }
    return stored.toLowerCase()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function validateHandshakeResponse(body: unknown, deviceId: string): IHandshakeResponse {
  if (!isRecord(body) || body.success !== true || body.tokenType !== 'Bearer' || typeof body.token !== 'string' || body.token.length === 0) {
    throw new Error('La réponse d’authentification Player Sync est invalide.')
  }

  if (
    typeof body.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(body.expiresAt)) ||
    Date.parse(body.expiresAt) <= Date.now() ||
    new Date(body.expiresAt).toISOString() !== body.expiresAt
  ) {
    throw new Error('La réponse Player Sync contient une date d’expiration invalide.')
  }

  if (
    !isRecord(body.player) ||
    typeof body.player.minecraftUuid !== 'string' ||
    !PLAYER_UUID_PATTERN.test(body.player.minecraftUuid) ||
    body.player.minecraftUuid !== body.player.minecraftUuid.toLowerCase() ||
    typeof body.player.minecraftName !== 'string' ||
    body.player.minecraftName.length === 0 ||
    body.deviceId !== deviceId
  ) {
    throw new Error('La réponse Player Sync contient des informations de joueur ou d’appareil invalides.')
  }

  return {
    success: true,
    token: body.token,
    tokenType: 'Bearer',
    expiresAt: body.expiresAt,
    player: {
      minecraftUuid: body.player.minecraftUuid,
      minecraftName: body.player.minecraftName
    },
    deviceId
  }
}

function getHandshakeError(status: number): Error {
  switch (status) {
    case 400:
      return new Error('La requête Player Sync est invalide. Vérifiez la configuration du launcher.')
    case 401:
      return new Error('Microsoft n’a pas validé ce compte. Reconnectez-vous puis réessayez.')
    case 403:
      return new Error('Player Sync nécessite un compte Microsoft possédant Minecraft Java.')
    case 409:
      return new Error('Un conflit temporaire empêche Player Sync. Réessayez dans quelques instants.')
    case 429:
      return new Error('Trop de tentatives Player Sync. Attendez avant de réessayer.')
    case 502:
    case 503:
      return new Error('Player Sync est temporairement indisponible. Réessayez plus tard.')
    default:
      return new Error(`L’authentification Player Sync a échoué (HTTP ${status}).`)
  }
}

function assertMicrosoftAccount(account: Account): void {
  if (account.meta?.type !== 'msa' || !account.meta.online || typeof account.accessToken !== 'string' || account.accessToken.length === 0) {
    throw new Error('Player Sync nécessite un compte Microsoft en ligne avec Minecraft Java.')
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const responseText = await response.text()
  try {
    return JSON.parse(responseText) as unknown
  } catch {
    if (response.ok) throw new Error('Le serveur Player Sync a renvoyé une réponse JSON invalide.')
    return undefined
  }
}

async function requestHandshake(account: Account, deviceId: string): Promise<Response> {
  try {
    return await fetch(new URL('/api/sync/auth/handshake', ADMINTOOL_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accessToken: account.accessToken,
        deviceId,
        deviceName: 'Desktop',
        platform: process.platform,
        arch: os.arch(),
        launcherVersion: app.getVersion()
      }),
      signal: AbortSignal.timeout(10_000)
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error('Le serveur Player Sync ne répond pas. Réessayez plus tard.')
    }
    throw new Error('Impossible de joindre le serveur Player Sync. Vérifiez votre connexion puis réessayez.')
  }
}

async function authenticate(account: Account, refreshAccount: () => Promise<Account>): Promise<ISyncAuthStatus> {
  assertMicrosoftAccount(account)
  const deviceId = readOrCreateDeviceId()
  let currentAccount = account
  let refreshed = false
  let conflictRetries = 0

  while (true) {
    const response = await requestHandshake(currentAccount, deviceId)

    if (response.status === 401 && !refreshed) {
      currentAccount = await refreshAccount()
      assertMicrosoftAccount(currentAccount)
      refreshed = true
      continue
    }

    if (response.status === 409 && conflictRetries === 0) {
      conflictRetries += 1
      await delay(300)
      continue
    }

    const body = await readJsonResponse(response)
    if (!response.ok) throw getHandshakeError(response.status)

    const result = validateHandshakeResponse(body, deviceId)
    syncToken = result.token
    syncTokenExpiresAt = Date.parse(result.expiresAt)
    syncAuthStatus = {
      expiresAt: result.expiresAt,
      player: result.player,
      deviceId: result.deviceId
    }
    return syncAuthStatus
  }
}

export async function ensureSyncAuthenticated(
  getAccount: () => Promise<Account>,
  refreshAccount: () => Promise<Account>
): Promise<ISyncAuthStatus> {
  if (syncToken && syncAuthStatus && syncTokenExpiresAt - Date.now() > TOKEN_REAUTHENTICATION_WINDOW_MS) {
    return syncAuthStatus
  }
  return authenticate(await getAccount(), refreshAccount)
}

export async function getSyncBearerToken(getAccount: () => Promise<Account>, refreshAccount: () => Promise<Account>): Promise<string> {
  await ensureSyncAuthenticated(getAccount, refreshAccount)
  if (!syncToken) throw new Error('L’authentification Player Sync n’a pas produit de jeton.')
  return syncToken
}

export function clearSyncAuth(): void {
  syncToken = undefined
  syncTokenExpiresAt = 0
  syncAuthStatus = undefined
}
