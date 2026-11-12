import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer as createHttpServer } from 'node:http'
import { once } from 'node:events'
import { createServer } from 'vite'

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'flowblock-lifecycle-'))
const handlers = new Map()
let uuid = 'a'.repeat(32),
  authDisabled = false,
  serverDisabled = false
globalThis.__syncLifecycle = {
  app: { getPath: () => temp, getVersion: () => 'test' },
  ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
  auth: async () => {
    if (authDisabled) throw new Error('SYNC_DISABLED')
    return { player: { minecraftUuid: uuid }, deviceId: 'device', expiresAt: new Date(Date.now() + 600000).toISOString() }
  }
}
const originalFetch = globalThis.fetch
globalThis.fetch = async () =>
  serverDisabled ? Response.json({ code: 'SYNC_DISABLED' }, { status: 503 }) : Response.json({ enabled: false, rules: [] })
const vite = await createServer({
  configFile: false,
  ssr: { noExternal: ['electron', 'electron-log/main', 'eml-lib'] },
  server: { middlewareMode: true, ws: false },
  appType: 'custom',
  logLevel: 'error',
  plugins: [
    {
      name: 'lifecycle-mocks',
      enforce: 'pre',
      resolveId(source) {
        if (source === 'electron') return '\0test-electron'
        if (source === 'electron-log/main') return '\0test-log'
        if (source === 'eml-lib') return '\0test-profiles'
        if (source === './syncAuth') return '\0test-auth'
      },
      load(id) {
        if (id === '\0test-electron') return 'export const { app, ipcMain } = globalThis.__syncLifecycle'
        if (id === '\0test-log') return 'export default { warn() {} }'
        if (id === '\0test-profiles') return 'export class Profiles { async getProfiles() { return [{ id: "profile-id", slug: "profile" }] } }'
        if (id === '\0test-auth')
          return 'export const clearSyncAuth = () => {}; export const ensureSyncAuthenticated = globalThis.__syncLifecycle.auth; export const getSyncBearerToken = async () => "token"; export const getSyncAuthFailure = error => ({ success: false, message: error.message, canRetry: true })'
      }
    }
  ]
})
const { putFile, registerSyncHandlers } = await vite.ssrLoadModule('/electron/handlers/sync.ts')
const service = registerSyncHandlers({ getSavedAccountForSync: async () => ({ uuid }), refreshSavedAccountForSync: async () => ({ uuid }) })
const events = []
const sender = { isDestroyed: () => false, send: (...args) => events.push(args) }

test('storage upload errors report the HTTP status without exposing the signed URL', async () => {
  const file = path.join(temp, 'upload.txt')
  const data = Buffer.from('upload')
  await fs.writeFile(file, data)
  let receivedHeaders
  const server = createHttpServer((request, response) => {
    receivedHeaders = request.headers
    response.writeHead(403)
    response.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    await assert.rejects(
      putFile(
        `http://127.0.0.1:${address.port}/signed?secret=value`,
        {
          'x-amz-checksum-sha256': 'signed-checksum',
          'content-length': String(data.length),
          'x-storage-token': 'signed-token'
        },
        file,
        data.length,
        () => {}
      ),
      (error) => {
        assert.match(error.message, /HTTP 403/)
        assert.doesNotMatch(error.message, /secret=value/)
        return true
      }
    )
    assert.equal(receivedHeaders?.['x-amz-checksum-sha256'], 'signed-checksum')
    assert.equal(receivedHeaders?.['content-length'], String(data.length))
    assert.equal(receivedHeaders?.['x-storage-token'], 'signed-token')
  } finally {
    const closed = once(server, 'close')
    server.close()
    await closed
  }
})

after(async () => {
  globalThis.fetch = originalFetch
  delete globalThis.__syncLifecycle
  await vite.close()
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(temp).startsWith('flowblock-lifecycle-'))
  await fs.rm(temp, { recursive: true, force: true })
})

test('game reservation blocks conflict resolution transfers and preference changes until post-game synchronization finishes', async () => {
  await fs.writeFile(path.join(temp, 'sync.json'), JSON.stringify({ enabled: true, selections: {} }))
  await service.beforeGame('profile', sender, uuid)
  assert.equal(service.isBusy(), true)
  assert.equal(handlers.has('sync:upload_selected'), false)
  const transfer = await handlers.get('sync:resolve_conflict')(
    { sender },
    { profileSlug: 'profile', profileId: 'profile-id', resolve: { path: 'saves/level.dat', choice: 'local', localHash: null, remoteVersion: 1 } }
  )
  assert.equal(transfer.success, false)
  const preference = await handlers.get('sync:set_enabled')({}, false)
  assert.equal(preference.success, false)
  await service.afterGame(sender)
  assert.equal(service.isBusy(), false)
  assert.equal(events.at(-1)[0], 'sync:completed')
  assert.equal(events.at(-1)[1].success, true)
})

test('globally disabled sync allows a game whether the handshake or config returns the disabled state', async () => {
  authDisabled = true
  await service.beforeGame('profile', sender, uuid)
  assert.equal(service.isBusy(), true)
  await service.afterGame(sender)
  authDisabled = false
  serverDisabled = true
  await service.beforeGame('profile', sender, uuid)
  await service.afterGame(sender)
  serverDisabled = false
  assert.equal(service.isBusy(), false)
})

test('switching accounts during a game prevents automatic uploads into the new account', async () => {
  await service.beforeGame('profile', sender, uuid)
  uuid = 'b'.repeat(32)
  await service.afterGame(sender)
  assert.equal(events.at(-1)[1].success, false)
  assert.match(events.at(-1)[1].message, /compte actif a changé/)
  assert.equal(service.isBusy(), false)
})
