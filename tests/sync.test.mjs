import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { createServer } from 'vite'

const vite = await createServer({ configFile: false, server: { middlewareMode: true, ws: false }, appType: 'custom', logLevel: 'error' })
const { runSync, readSyncConflicts } = await vite.ssrLoadModule('/electron/sync/engine.ts')
const { planSync } = await vite.ssrLoadModule('/electron/sync/plan.ts')
after(() => vite.close())
const hash = (data) => `sha256:${createHash('sha256').update(data).digest('hex')}`

async function harness(body) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'flowblock-sync-'))
  const remote = Object.create(null),
    blobs = new Map(),
    uploads = new Map()
  let revision = 0,
    reads = 0,
    corrupt = false
  let rules = [
    { path: 'saves/**', action: 'INCLUDE' },
    { path: 'saves/**/session.lock', action: 'EXCLUDE' }
  ]
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => new Response(corrupt ? Buffer.from('corrupt') : blobs.get(new URL(url).pathname.slice(1)))
  const request = async (operation, body) => {
    if (operation === 'config') return { enabled: true, rules }
    if (operation === 'revision') return { revision: String(revision) }
    if (operation.startsWith('manifest?')) {
      reads++
      return { revision: String(revision), files: structuredClone(remote), nextCursor: null }
    }
    if (operation === 'download') return { path: body.path, ...remote[body.path], downloadUrl: `http://localhost/${remote[body.path].hash.slice(7)}` }
    if (operation === 'upload/prepare') {
      assert.equal(body.baseVersion, remote[body.path]?.version ?? null)
      const uploadId = String(uploads.size + 1)
      uploads.set(uploadId, body)
      return {
        uploadRequired: true,
        uploadId,
        uploadUrl: `http://localhost/${body.hash.slice(7)}`,
        uploadHeaders: { 'x-amz-checksum-sha256': Buffer.from(body.hash.slice(7), 'hex').toString('base64') }
      }
    }
    if (operation.includes('/commit')) {
      const input = uploads.get(operation.split('/')[1])
      remote[input.path] = { hash: input.hash, size: input.size, version: (remote[input.path]?.version ?? 0) + 1, deleted: false }
      revision++
      return { success: true, file: { path: input.path, ...remote[input.path] }, revision: String(revision) }
    }
    if (operation === 'file') {
      assert.equal(body.baseVersion, remote[body.path].version)
      remote[body.path] = { hash: null, size: '0', version: remote[body.path].version + 1, deleted: true }
      revision++
      return { success: true, file: { path: body.path, ...remote[body.path] }, revision: String(revision) }
    }
    throw new Error(operation)
  }
  const device = (name) => {
    const root = path.join(temp, name)
    const stateFile = path.join(temp, `state-${name}`, 'manifest.json')
    return {
      root,
      stateFile,
      deviceId: name,
      selections: ['saves'],
      mode: 'sync',
      request,
      upload: async (url, file) => {
        blobs.set(url.pathname.slice(1), await fs.readFile(file))
      }
    }
  }
  const put = async (options, file, data) => {
    const full = path.join(options.root, file)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, data)
  }
  try {
    await body({
      device,
      put,
      remote,
      blobs,
      change: () => revision++,
      get reads() {
        return reads
      },
      setRules: (value) => (rules = value),
      corrupt: () => (corrupt = true)
    })
  } finally {
    globalThis.fetch = originalFetch
    const resolved = path.resolve(temp)
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
    assert.ok(path.basename(resolved).startsWith('flowblock-sync-'))
    await fs.rm(resolved, { recursive: true, force: true })
  }
}

test('two devices upload, restore a missing instance, skip unchanged files and propagate tombstones', async () =>
  harness(async (h) => {
    const a = h.device('a'),
      b = h.device('b')
    await h.put(a, 'saves/world/level.dat', 'first')
    await h.put(a, 'saves/world/session.lock', 'locked')
    assert.equal((await runSync(a)).syncedFiles, 1)
    assert.equal(h.remote['saves/world/session.lock'], undefined)
    assert.equal((await runSync(b)).syncedFiles, 1)
    assert.equal(await fs.readFile(path.join(b.root, 'saves/world/level.dat'), 'utf8'), 'first')
    const reads = h.reads
    assert.equal((await runSync(b)).syncedFiles, 0)
    assert.equal(h.reads, reads)
    await fs.unlink(path.join(a.root, 'saves/world/level.dat'))
    await runSync(a)
    assert.equal(h.remote['saves/world/level.dat'].deleted, true)
    await runSync(b)
    await assert.rejects(fs.access(path.join(b.root, 'saves/world/level.dat')))
  }))

test('concurrent edits preserve both versions and remote resolution saves a local backup', async () =>
  harness(async (h) => {
    const a = h.device('a'),
      b = h.device('b')
    await h.put(a, 'saves/level.dat', 'base')
    await runSync(a)
    await runSync(b)
    await h.put(a, 'saves/level.dat', 'remote')
    await runSync(a)
    await h.put(b, 'saves/level.dat', 'local')
    const result = await runSync(b)
    assert.equal(result.conflicts.length, 1)
    assert.deepEqual(await readSyncConflicts(b.stateFile), result.conflicts)
    assert.equal(await fs.readFile(path.join(b.root, 'saves/level.dat'), 'utf8'), 'local')
    const conflict = result.conflicts[0]
    await runSync({ ...b, resolve: { ...conflict, choice: 'remote' } })
    assert.equal(await fs.readFile(path.join(b.root, 'saves/level.dat'), 'utf8'), 'remote')
    const backups = path.join(path.dirname(b.stateFile), 'conflict-backups')
    const [backup] = await fs.readdir(backups)
    assert.equal(await fs.readFile(path.join(backups, backup, 'saves/level.dat'), 'utf8'), 'local')
  }))

test('downloads verify integrity and never replace a file on corruption', async () =>
  harness(async (h) => {
    const a = h.device('a'),
      b = h.device('b')
    await h.put(a, 'saves/level.dat', 'base')
    await runSync(a)
    await runSync(b)
    await h.put(a, 'saves/level.dat', 'changed')
    await runSync(a)
    h.corrupt()
    await assert.rejects(runSync(b))
    assert.equal(await fs.readFile(path.join(b.root, 'saves/level.dat'), 'utf8'), 'base')
  }))

test('pull leaves local edits for post-game upload; reset metadata requires a decision', async () =>
  harness(async (h) => {
    const a = h.device('a')
    await h.put(a, 'saves/level.dat', 'base')
    await runSync(a)
    await h.put(a, 'saves/level.dat', 'edited')
    assert.equal((await runSync({ ...a, mode: 'pull' })).syncedFiles, 0)
    assert.equal(h.remote['saves/level.dat'].hash, hash('base'))
    delete h.remote['saves/level.dat']
    h.change()
    assert.equal((await runSync(a)).conflicts.length, 1)
  }))

test('malicious remote paths are rejected before writing; corrupt state is preserved', async () =>
  harness(async (h) => {
    const a = h.device('a')
    h.remote['../escape'] = { hash: hash('x'), size: '1', version: 1, deleted: false }
    h.change()
    await assert.rejects(runSync(a), /relative path/)
    delete h.remote['../escape']
    h.change()
    await fs.mkdir(path.dirname(a.stateFile), { recursive: true })
    await fs.writeFile(a.stateFile, '{bad')
    await assert.rejects(runSync(a), /manifest local est illisible/)
    assert.equal(await fs.readFile(a.stateFile, 'utf8'), '{bad')
  }))

test('planner distinguishes concurrent deletion, identical concurrent edits and a new device', () => {
  const base = { hash: 'a', size: '1', version: 1, deleted: false }
  assert.equal(planSync(null, base, { ...base, hash: 'b', version: 2 }), 'conflict')
  assert.equal(planSync('b', base, { ...base, hash: 'b', version: 2 }), 'unchanged')
  assert.equal(planSync(null, undefined, base), 'download')
  assert.equal(planSync('b', undefined, base), 'conflict')
  assert.equal(planSync('b', base, { ...base, hash: null, deleted: true }), 'conflict')
})

test('an interrupted run persists completed files and safely resumes the remaining upload', async () =>
  harness(async (h) => {
    const a = h.device('a')
    await h.put(a, 'saves/a.dat', 'first')
    await h.put(a, 'saves/b.dat', 'second')
    let commits = 0
    await assert.rejects(
      runSync({
        ...a,
        request: async (operation, body, method) => {
          if (operation.includes('/commit') && ++commits === 2) throw new Error('offline')
          return a.request(operation, body, method)
        }
      }),
      /offline/
    )
    assert.equal(h.remote['saves/a.dat'].version, 1)
    assert.equal((await runSync(a)).syncedFiles, 1)
    assert.equal(h.remote['saves/a.dat'].version, 1)
    assert.equal(h.remote['saves/b.dat'].version, 1)
  }))

test('junctions/symlinks cannot redirect a selected directory outside the instance', async () =>
  harness(async (h) => {
    const a = h.device('a')
    const outside = path.join(path.dirname(a.root), 'outside')
    await fs.mkdir(outside)
    await fs.mkdir(a.root)
    await fs.writeFile(path.join(outside, 'private'), 'secret')
    await fs.symlink(outside, path.join(a.root, 'saves'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(runSync(a), /symboliques/)
    assert.equal(Object.keys(h.remote).length, 0)
  }))

test('changing rules invalidates a cached manifest without changing its revision', async () =>
  harness(async (h) => {
    const a = h.device('a')
    await runSync(a)
    const reads = h.reads
    h.setRules([{ path: 'saves/**', action: 'INCLUDE' }])
    await runSync(a)
    assert.equal(h.reads, reads + 1)
  }))

test('remote changes during pagination cause a manifest retry before any file changes', async () =>
  harness(async (h) => {
    const a = h.device('a')
    let calls = 0
    await runSync({
      ...a,
      request: async (operation, body, method) => {
        const result = await a.request(operation, body, method)
        if (operation.startsWith('manifest?') && ++calls === 1) h.change()
        return result
      }
    })
    assert.equal(calls, 2)
  }))

test('a missing installation restores cloud data instead of deleting all remote worlds', async () =>
  harness(async (h) => {
    const a = h.device('a')
    await h.put(a, 'saves/level.dat', 'world')
    await runSync(a)
    await fs.unlink(path.join(a.root, 'saves/level.dat'))
    await fs.rmdir(path.join(a.root, 'saves'))
    await fs.rmdir(a.root)
    await runSync(a)
    assert.equal(h.remote['saves/level.dat'].deleted, false)
    assert.equal(h.remote['saves/level.dat'].version, 1)
    assert.equal(await fs.readFile(path.join(a.root, 'saves/level.dat'), 'utf8'), 'world')
  }))
