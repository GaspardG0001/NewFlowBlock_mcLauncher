export interface SyncUsage {
  scope: 'player'
  quotaBytes: string
  usedBytes: string
  reservedBytes: string
  profiles: { profileId: string; usedBytes: string; reservedBytes: string }[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function bytes(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value)
}

export function parseSyncUsage(value: unknown): SyncUsage {
  if (
    !isRecord(value) ||
    value.scope !== 'player' ||
    !bytes(value.quotaBytes) ||
    !bytes(value.usedBytes) ||
    !bytes(value.reservedBytes) ||
    !Array.isArray(value.profiles)
  ) throw new Error('La réponse de stockage Sync est invalide.')

  const profiles: SyncUsage['profiles'] = []
  const ids = new Set<string>()
  let used = 0n
  let reserved = 0n
  for (const entry of value.profiles) {
    if (
      !isRecord(entry) || typeof entry.profileId !== 'string' || !entry.profileId ||
      ids.has(entry.profileId) ||
      !bytes(entry.usedBytes) || !bytes(entry.reservedBytes)
    ) throw new Error('La réponse de stockage Sync est invalide.')
    ids.add(entry.profileId)
    used += BigInt(entry.usedBytes)
    reserved += BigInt(entry.reservedBytes)
    profiles.push({ profileId: entry.profileId, usedBytes: entry.usedBytes, reservedBytes: entry.reservedBytes })
  }
  if (used !== BigInt(value.usedBytes) || reserved !== BigInt(value.reservedBytes))
    throw new Error('La réponse de stockage Sync est incohérente.')
  return { scope: value.scope, quotaBytes: value.quotaBytes, usedBytes: value.usedBytes, reservedBytes: value.reservedBytes, profiles }
}
