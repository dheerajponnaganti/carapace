import type { EngineInterface as Engine, On } from 'claude-code'

import { holdText, npmFacts, packagesIn, pypiFacts, reasons } from './package-logic'
import type { Facts, Pkg } from './package-logic'

const OFF_KEY = 'packageGuard:off'
const LOOKUP_MS = 6000

/** One lookup, or null when it did not answer in time: a slow or offline registry never blocks an install. */
async function get($: Engine, url: string): Promise<{ status: number; json: unknown } | null> {
  const timeout = new Promise<null>(resolve => void $.clock.after(LOOKUP_MS, () => resolve(null)))
  const res = await Promise.race([$.http.fetch(url).catch(() => null), timeout])
  if (res === null) return null
  try {
    return { status: res.status, json: res.ok ? JSON.parse(res.text) : null }
  } catch {
    return { status: res.status, json: null }
  }
}

/** What the public registry says about a package; null when it could not be asked. */
async function factsOf($: Engine, p: Pkg, now: number): Promise<Facts | null> {
  if (p.eco === 'npm') {
    const [range, latest] = await Promise.all([get($, `https://api.npmjs.org/downloads/range/last-year/${p.name}`), get($, `https://registry.npmjs.org/${p.name.replace('/', '%2F')}/latest`)])
    if (range === null || latest === null) return null
    // Both 404: the name was never published.
    if (range.status === 404 && latest.status === 404) return { found: false, ageDays: null, weekly: null, deprecated: null }
    if (!latest.json) return null

    return npmFacts(range.json as never, latest.json as never, now)
  }
  const info = await get($, `https://pypi.org/pypi/${p.name}/json`)
  if (info === null) return null
  if (info.status === 404) return { found: false, ageDays: null, weekly: null, deprecated: null }
  if (!info.json) return null
  const stats = await get($, `https://pypistats.org/api/packages/${p.name}/recent`)
  const weekly = (stats?.json as { data?: { last_week?: unknown } } | null)?.data?.last_week

  return pypiFacts(info.json as never, typeof weekly === 'number' ? weekly : null, now)
}

export function registerPackageGuard(on: On): void {
  // Names the person allowed; a reload clears them, which is the safe side.
  const allowed = new Set<string>()
  const cache = new Map<string, Facts>()
  let held = 0
  let checked = 0

  on('session.start', { cwd: /\S/ }, async ($, e, next) => {
    await $.command.register({ name: 'packages', description: 'Package guard: status, on, off, allow <name...>', argumentHint: '[on|off|allow <name...>]' })

    return next(e)
  })

  // Before an install runs: look each named package up; hold the install when one looks wrong.
  on('tool.call', { tool: /^Bash$/ }, async ($, e, next) => {
    const command = (e as unknown as { command?: unknown }).command
    if (typeof command !== 'string' || (await $.store.get(OFF_KEY)) === true) return next(e)
    const pkgs = packagesIn(command).filter(p => !allowed.has(p.name))
    if (pkgs.length === 0) return next(e)
    const now = await $.clock.now()
    const looked = await Promise.all(
      pkgs.map(async p => {
        const key = `${p.eco}:${p.name}`
        const facts = cache.get(key) ?? (await factsOf($, p, now))
        if (facts !== null) cache.set(key, facts)

        return { pkg: p, why: facts === null ? [] : reasons(p, facts) }
      }),
    )
    checked += pkgs.length
    const bad = looked.filter(l => l.why.length > 0)
    if (bad.length === 0) return next(e)
    held++

    return { deny: holdText(command, bad) }
  }).catch(($, e, next) => next(e)) // a guard bug must not stop Bash; fails open

  on('command.run', { command: 'packages' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    if (verb === 'on' || verb === 'off') await $.store.set(OFF_KEY, verb === 'off')
    if (verb === 'allow') {
      const names = rest.map(n => n.toLowerCase()).filter(Boolean)
      if (names.length === 0) return { text: 'Say which: /packages allow <name>.' }
      for (const n of names) allowed.add(n)

      return { text: `Allowed for this session: ${names.join(', ')}. Ask Claude to retry the install.` }
    }
    const isOn = (await $.store.get(OFF_KEY)) !== true

    return { text: `Package guard is ${isOn ? 'on' : 'off'}: installs of new, barely used, deprecated or unknown npm and PyPI packages are held. This session: ${checked} checked, ${held} held${allowed.size > 0 ? `, allowed: ${[...allowed].join(', ')}` : ''}.` }
  })
}
