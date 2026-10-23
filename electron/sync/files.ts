import fs from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { validateFilePath } from './paths'

export async function safeFile(root: string, relativePath: string): Promise<string> {
  const normalized = validateFilePath(relativePath)
  const parts = normalized.split('/')
  let current = path.resolve(root)
  // Check the root and every ancestor, including junctions on Windows.
  for (const part of ['', ...parts]) {
    if (part) current = path.join(current, part)
    try {
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink()) throw new Error('Les liens symboliques ne peuvent pas être synchronisés.')
      if (current !== path.join(root, ...parts) && !stat.isDirectory()) throw new Error('Un dossier de synchronisation a été remplacé par un fichier.')
    } catch (error) { if (!isMissing(error)) throw error }
  }
  return path.resolve(root, ...parts)
}

export function isMissing(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' }

export async function hashFile(file: string): Promise<{ hash: string; size: number }> {
  const before = await fs.lstat(file)
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Fichier de synchronisation invalide.')
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(file)) { hash.update(chunk); size += chunk.length }
  const after = await fs.lstat(file)
  if (before.size !== size || after.size !== size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) throw new Error('Un fichier a changé pendant la synchronisation. Réessayez.')
  return { hash: `sha256:${hash.digest('hex')}`, size }
}

export async function currentHash(root: string, relativePath: string): Promise<string | null> {
  try { return (await hashFile(await safeFile(root, relativePath))).hash }
  catch (error) { if (isMissing(error)) return null; throw error }
}

export async function scanFiles(root: string, selections: string[], allowed: (file: string) => boolean): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  const visit = async (relative: string): Promise<void> => {
    const absolute = await safeFile(root, relative)
    let stat
    try { stat = await fs.lstat(absolute) } catch (error) { if (isMissing(error)) return; throw error }
    if (stat.isDirectory()) {
      for (const child of await fs.readdir(absolute)) await visit(`${relative}/${child}`)
    } else if (stat.isFile() && allowed(relative)) files.set(relative, (await hashFile(absolute)).hash)
  }
  for (const selected of new Set(selections)) {
    validateFilePath(selected)
    if (selected.includes('/')) throw new Error('Sélection invalide.')
    await visit(selected)
  }
  return files
}

export function signedUrl(value: unknown): URL {
  if (typeof value !== 'string') throw new Error('URL de stockage invalide.')
  const url = new URL(value)
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('URL de stockage invalide.')
  return url
}

export async function downloadFile(url: URL, target: string, expectedHash: string, expectedSize: string) {
  const temp = `${target}.flowblock-${randomUUID()}.tmp`
  await fs.mkdir(path.dirname(target), { recursive: true })
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(300000) })
    if (!response.ok || !response.body) throw new Error('Le téléchargement a échoué.')
    const hash = createHash('sha256')
    let bytes = 0n
    const size = BigInt(expectedSize)
    const verify = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += BigInt(chunk.length)
      if (bytes > size) { callback(new Error('Le fichier téléchargé dépasse la taille attendue.')); return }
      hash.update(chunk); callback(null, chunk)
    } })
    await pipeline(Readable.fromWeb(response.body as never), verify, createWriteStream(temp, { flags: 'wx', mode: 0o600 }))
    if (bytes !== size || `sha256:${hash.digest('hex')}` !== expectedHash) throw new Error('L’intégrité du téléchargement est invalide.')
    return temp
  } catch (error) { await fs.rm(temp, { force: true }); throw error }
}

export async function atomicJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  try { await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await fs.rename(temp, file) }
  finally { await fs.rm(temp, { force: true }) }
}
