export type SyncRule = { path: string; action: string; enabled?: boolean }

// Portable paths: also reject Windows aliases, streams and reserved devices.
export function normalizeSyncPath(input: unknown): string {
  if (typeof input !== 'string' || !input || input.length > 1024) throw new Error('Invalid relative path')
  const normalized = input.replace(/\\/g, '/')
  if (
    normalized
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[<>:"|\u0000-\u001f\u007f]/.test(part) ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      )
  )
    throw new Error('Invalid relative path')
  return normalized
}

export function globToRegExp(input: string): RegExp {
  const glob = normalizeSyncPath(input)
  let expression = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        expression += '(?:.*/)?'
        i += 2
      } else {
        expression += '.*'
        i++
      }
    } else if (c === '*') expression += '[^/]*'
    else if (c === '?') expression += '[^/]'
    else expression += c.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
  }
  return new RegExp(`${expression}$`)
}

export function isSyncPathAllowed(path: string, rules: SyncRule[]): boolean {
  const active = rules.filter((rule) => rule.enabled !== false)
  return (
    active.some((rule) => rule.action === 'INCLUDE' && globToRegExp(rule.path).test(path)) &&
    !active.some((rule) => rule.action === 'EXCLUDE' && globToRegExp(rule.path).test(path))
  )
}

export function validateFilePath(input: unknown): string {
  const path = normalizeSyncPath(input)
  if (/[?*]/.test(path)) throw new Error('Wildcards are only allowed in rules')
  return path
}
