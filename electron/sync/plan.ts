export interface SyncFileState {
  hash: string | null
  size: string
  version: number
  deleted: boolean
}
export type SyncAction = 'unchanged' | 'upload' | 'download' | 'deleteLocal' | 'deleteRemote' | 'conflict'

export function planSync(localHash: string | null, base: SyncFileState | undefined, remote: SyncFileState | undefined): SyncAction {
  const remoteHash = remote && !remote.deleted ? remote.hash : null
  const baseHash = base && !base.deleted ? base.hash : null
  if (localHash === remoteHash) return 'unchanged'
  if (!base) {
    if (!remote) return localHash ? 'upload' : 'unchanged'
    if (remote.deleted) return localHash ? 'conflict' : 'unchanged'
    return localHash === null ? 'download' : 'conflict'
  }
  // Missing remote metadata may be a reset or a purged tombstone. Do not resurrect.
  if (!remote) return 'conflict'
  const localChanged = localHash !== baseHash
  const remoteChanged = remoteHash !== baseHash
  if (localChanged && remoteChanged) return 'conflict'
  if (remoteChanged) return remote.deleted ? 'deleteLocal' : 'download'
  if (localChanged) return localHash === null ? 'deleteRemote' : 'upload'
  return 'unchanged'
}
