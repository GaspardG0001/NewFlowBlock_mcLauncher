import type { SyncUsage } from '../../electron/sync/usage'

function formatBytes(input: string): string {
  const value = BigInt(input)
  if (value === 0n) return '0 Mo'
  const megabytes = 1_000_000n
  const gigabytes = 1_000_000_000n
  if (value < megabytes) return '< 1 Mo'
  const divisor = (value + megabytes / 2n) / megabytes >= 1000n ? gigabytes : megabytes
  const rounded = (value + divisor / 2n) / divisor
  return `${rounded.toLocaleString('fr-FR')} ${divisor === gigabytes ? 'Go' : 'Mo'}`
}

export function clearSyncUsage(message: string): void {
  const total = document.getElementById('sync-usage-total')
  const bar = document.getElementById('sync-usage-bar')
  const legend = document.getElementById('sync-usage-legend')
  if (total) total.textContent = message
  if (bar) {
    bar.replaceChildren()
    bar.removeAttribute('aria-valuenow')
    bar.removeAttribute('aria-valuetext')
  }
  if (legend) legend.replaceChildren()
}

export function showSyncUsageError(error: unknown): void {
  console.error('Impossible de charger le stockage Sync.', error)
  clearSyncUsage('Impossible d’afficher votre espace Sync. Vérifiez votre connexion ou reconnectez-vous, puis rouvrez cet onglet.')
}

export function renderSyncUsage(usage: SyncUsage, names: Map<string, string>): void {
  const total = document.getElementById('sync-usage-total')
  const bar = document.getElementById('sync-usage-bar')
  const legend = document.getElementById('sync-usage-legend')
  if (!total || !bar || !legend) return

  const quota = BigInt(usage.quotaBytes)
  const occupied = BigInt(usage.usedBytes)
  const totalText = `${formatBytes(usage.usedBytes)} utilisés / ${formatBytes(usage.quotaBytes)}`
  total.textContent = totalText
  bar.replaceChildren()
  legend.replaceChildren()
  const percentage = quota === 0n ? (occupied > 0n ? 100 : 0) : Number(((occupied > quota ? quota : occupied) * 10000n) / quota) / 100
  bar.setAttribute('aria-valuenow', String(percentage))
  bar.setAttribute('aria-valuetext', totalText)

  const profiles = usage.profiles.filter((profile) => BigInt(profile.usedBytes) > 0n).sort((a, b) => a.profileId.localeCompare(b.profileId))
  const barCapacity = quota === 0n ? occupied : quota
  let filled = 0n
  for (const [index, profile] of profiles.entries()) {
    const color = `hsl(${Math.round((index * 360) / profiles.length)} 70% 58%)`
    const size = BigInt(profile.usedBytes)
    const remaining = barCapacity > filled ? barCapacity - filled : 0n
    const visible = size < remaining ? size : remaining
    if (visible > 0n) {
      const segment = document.createElement('span')
      segment.className = 'sync-usage-segment'
      segment.style.backgroundColor = color
      segment.style.width = `${Number((visible * 1000000n) / barCapacity) / 10000}%`
      bar.appendChild(segment)
    }
    filled += visible

    const item = document.createElement('div')
    item.className = 'sync-usage-legend-item'
    const swatch = document.createElement('span')
    swatch.className = 'sync-usage-swatch'
    swatch.style.backgroundColor = color
    const label = document.createElement('span')
    label.textContent = `${names.get(profile.profileId) ?? `Profil ${profile.profileId}`} : ${formatBytes(profile.usedBytes)} utilisés`
    item.append(swatch, label)
    legend.appendChild(item)
  }
}
