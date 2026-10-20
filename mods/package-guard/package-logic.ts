// Pure pieces of the package guard: which packages a shell line installs, and what makes one worth holding. No `$` here.

export type Pkg = { eco: 'npm' | 'pypi'; name: string }
export type Facts = { found: boolean; ageDays: number | null; weekly: number | null; deprecated: string | null }

export const MIN_AGE_DAYS = 30
export const MIN_WEEKLY = 50
export const MAX_PACKAGES = 10

const NPM_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/i
const PYPI_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
// Flags whose value is the next word: never a package name.
const VALUE_FLAGS = new Set(['-r', '--requirement', '-c', '--constraint', '-e', '--editable', '-i', '--index-url', '--extra-index-url', '--registry', '--prefix', '-t', '--target', '--cwd', '-C', '--dir', '--filter', '--python', '-p'])

/** The packages a shell line installs by name. Lockfile installs, paths, URLs and git sources are not looked up. */
export function packagesIn(command: string): Pkg[] {
  const out: Pkg[] = []
  for (const step of command.split(/&&|\|\||[;|\n]/)) {
    const words = step.trim().replace(/^(?:\w+=\S*\s+)+/, '').replace(/["']/g, '').split(/\s+/).filter(Boolean)
    const eco = ecosystem(words)
    if (eco === null) continue
    for (let i = eco.from; i < words.length; i++) {
      const w = words[i] as string
      if (VALUE_FLAGS.has(w)) {
        i++
        continue
      }
      if (w.startsWith('-')) continue
      const name = eco.eco === 'npm' ? npmName(w) : pypiName(w)
      if (name !== null) out.push({ eco: eco.eco, name })
    }
  }
  const seen = new Set<string>()

  return out.filter(p => !seen.has(`${p.eco}:${p.name}`) && seen.add(`${p.eco}:${p.name}`)).slice(0, MAX_PACKAGES)
}

/** Which installer a step runs, and where its package names start. */
function ecosystem(w: string[]): { eco: Pkg['eco']; from: number } | null {
  const [a = '', b = '', c = '', d = ''] = w
  if (/^(?:npm|pnpm|bun)$/.test(a) && /^(?:install|i|add)$/.test(b)) return { eco: 'npm', from: 2 }
  if (a === 'yarn' && (b === 'add' || (b === 'global' && c === 'add'))) return { eco: 'npm', from: b === 'add' ? 2 : 3 }
  if (/^pip3?$/.test(a) && b === 'install') return { eco: 'pypi', from: 2 }
  if (/^python3?$/.test(a) && b === '-m' && c === 'pip' && d === 'install') return { eco: 'pypi', from: 4 }
  if (a === 'uv' && b === 'pip' && c === 'install') return { eco: 'pypi', from: 3 }
  if ((a === 'uv' || a === 'poetry') && b === 'add') return { eco: 'pypi', from: 2 }

  return null
}

function npmName(w: string): string | null {
  if (/^[./~]|:/.test(w) || /\.(?:tgz|tar\.gz)$/.test(w)) return null
  // @scope/name@1.2 keeps its leading @; name@1.2 drops the version.
  const at = w.indexOf('@', 1)
  const name = at > 0 ? w.slice(0, at) : w

  return NPM_NAME.test(name) && (!name.startsWith('@') || name.includes('/')) ? name.toLowerCase() : null
}

function pypiName(w: string): string | null {
  if (/^[./~]|:/.test(w) || /\.(?:whl|tar\.gz|zip)$/.test(w)) return null
  const name = w.split(/[[=<>!~;@ ]/)[0] ?? ''

  return PYPI_NAME.test(name) ? name.toLowerCase().replace(/[._]+/g, '-') : null
}

/** Why a package is worth holding, in plain words; empty when it looks fine or nothing is known. */
export function reasons(p: Pkg, f: Facts): string[] {
  const where = p.eco === 'npm' ? 'npm' : 'PyPI'
  if (!f.found) return [`it does not exist on ${where} (a misspelled or made-up name?)`]
  const out: string[] = []
  if (f.ageDays !== null && f.ageDays < MIN_AGE_DAYS) out.push(`it was first published ${f.ageDays === 0 ? 'today' : `${f.ageDays} day${f.ageDays === 1 ? '' : 's'} ago`}`)
  if (f.weekly !== null && f.weekly < MIN_WEEKLY) out.push(`it had only ${f.weekly} download${f.weekly === 1 ? '' : 's'} last week`)
  if (f.deprecated) out.push(`it is deprecated: ${f.deprecated.replace(/\s+/g, ' ').slice(0, 120)}`)

  return out
}

/** The text Claude gets in place of running the install. */
export function holdText(command: string, held: { pkg: Pkg; why: string[] }[]): string {
  const lines = held.map(h => `- ${h.pkg.name}: ${h.why.join('; ')}`)
  const names = held.map(h => h.pkg.name).join(' ')

  return [
    `carapace package guard held this install before it ran: ${command.split('\n')[0]?.slice(0, 120) ?? ''}`,
    ...lines,
    `Check the name is the one meant. If it is, ask the person to run /packages allow ${names}, then retry. Do not install it another way.`,
  ].join('\n')
}

/** npm's daily downloads for the last year: weekly total and days since the first day with downloads. */
export function npmFacts(range: { downloads?: { day: string; downloads: number }[] } | null, latest: { deprecated?: unknown } | null, now: number): Facts {
  const days = range?.downloads ?? []
  const weekly = days.slice(-7).reduce((n, d) => n + d.downloads, 0)
  const first = days.find(d => d.downloads > 0)
  // No downloads all year is as unknown as brand new; the weekly count speaks for it.
  const ageDays = first && days[0] && first.day !== days[0].day ? Math.floor((now - Date.parse(first.day)) / 86_400_000) : null

  return { found: true, ageDays, weekly: days.length > 0 ? weekly : null, deprecated: typeof latest?.deprecated === 'string' ? latest.deprecated : null }
}

/** PyPI: the earliest upload of any release gives the age. */
export function pypiFacts(info: { releases?: Record<string, { upload_time_iso_8601?: string }[]> } | null, weekly: number | null, now: number): Facts {
  const times = Object.values(info?.releases ?? {}).flat().map(f => Date.parse(f.upload_time_iso_8601 ?? '')).filter(t => !Number.isNaN(t))
  const first = times.length > 0 ? Math.min(...times) : null

  return { found: true, ageDays: first === null ? null : Math.floor((now - first) / 86_400_000), weekly, deprecated: null }
}
