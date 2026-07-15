import { CrashReport } from 'eml-lib'
import { ADMINTOOL_URL } from './const'

let crashReport: CrashReport | null = null

export function initializeCrashReports(): CrashReport {
  if (!crashReport) crashReport = new CrashReport(ADMINTOOL_URL)
  return crashReport
}
