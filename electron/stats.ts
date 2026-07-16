import { app } from 'electron'
import { Stats } from 'eml-lib'
import { ADMINTOOL_URL } from './const'

let stats: Stats | null = null

export async function initializeStats(): Promise<Stats> {
  if (stats) return stats

  stats = new Stats(ADMINTOOL_URL, app.getVersion(), ['STARTUP', 'LOGIN', 'LAUNCH'])
  await stats.initialize()

  return stats
}
