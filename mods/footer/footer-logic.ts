// Pure pieces of the footer: model names, effort levels, git status, bubbles. No `$` here.

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** "claude-opus-5-5" or "opus" become "Opus 5.5" or "Opus"; anything else stays as given. */
export function prettyModel(id: string): string {
  const m = id.match(/(opus|sonnet|haiku|fable)[- ]?(\d+)?(?:[-.](\d+))?/i)
  if (!m || !m[1]) return id
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()

  return m[2] ? `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : family
}

/** How many of the five pressure cells an effort fills: low 1 to max 5; 0 when unknown. */
export function effortCells(effort: string | number | null | undefined): number {
  if (typeof effort === 'number') return Math.max(1, Math.min(5, Math.round(effort)))

  return EFFORTS.indexOf((effort ?? '') as (typeof EFFORTS)[number]) + 1
}

export type GitState = { branch: string; ahead: number; behind: number; changed: number; isDetached: boolean }

/** Reads `git status --porcelain=v2 --branch`: the branch, ahead and behind, and how many files changed. */
export function parseGitStatus(stdout: string): GitState | null {
  let branch: string | null = null
  let ahead = 0
  let behind = 0
  let changed = 0
  for (const line of stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length).trim()
    else if (line.startsWith('# branch.ab ')) {
      const [a, b] = line.slice('# branch.ab '.length).trim().split(' ')
      ahead = Math.abs(Number(a) || 0)
      behind = Math.abs(Number(b) || 0)
    } else if (line.trim() !== '' && !line.startsWith('#')) changed += 1
  }
  if (branch === null) return null
  const isDetached = branch === '(detached)'

  return { branch: isDetached ? 'adrift' : branch, ahead, behind, changed, isDetached }
}

// A bubble lives ten frames: a dot, then a ring on the low row, then a ring and a bigger ring on the high row, then it pops.
const LIFE = 10
const RISE: { high: boolean; glyph: string }[] = [
  { high: false, glyph: '·' },
  { high: false, glyph: '∘' },
  { high: true, glyph: '∘' },
  { high: true, glyph: '°' },
]

export type BubbleField = { low: string[]; high: string[] }

/** Bubbles rising, one cell per column: each column starts its bubble at a different frame, so only a few are up at once. ' ' is empty. */
export function bubbles(width: number, frame: number): BubbleField {
  const low: string[] = []
  const high: string[] = []
  for (let c = 0; c < Math.max(0, width); c++) {
    const stage = RISE[(frame + c * 7) % LIFE]
    low.push(stage && !stage.high ? stage.glyph : ' ')
    high.push(stage?.high ? stage.glyph : ' ')
  }

  return { low, high }
}

/** The ping ring when a job ends: the ◇ ripples out once, a quarter second a frame. */
export function pingGlyph(elapsedMs: number): string {
  return ['◌', '○', '◎', '◇'][Math.min(3, Math.max(0, Math.floor(elapsedMs / 250)))] ?? '◇'
}

export type CacheFile = { session_id?: unknown; prompt_cache?: { caching_observed?: unknown; expires_at?: unknown; recache_tokens_if_cold?: unknown } | null }
export type CacheStatus = { text: string; isAmber: boolean; isCold: boolean }

/** Amber for the last two minutes of the cache lifetime. */
export const CACHE_AMBER_MS = 120_000

/**
 * The cache countdown from the status line file: "cache 42m", "cache 45s", or "cache cold" once expired.
 * null (show nothing) when there is no data: no file, no `prompt_cache`, caching not seen, or no expiry time.
 */
export function cacheStatus(file: CacheFile | null | undefined, nowMs: number): CacheStatus | null {
  const c = file?.prompt_cache
  if (!c || c.caching_observed === false || typeof c.expires_at !== 'number') return null
  const left = c.expires_at * 1000 - nowMs
  if (left <= 0) return { text: 'cache cold', isAmber: false, isCold: true }
  const text = left >= 60_000 ? `cache ${Math.ceil(left / 60_000)}m` : `cache ${Math.ceil(left / 1000)}s`

  return { text, isAmber: left <= CACHE_AMBER_MS, isCold: false }
}

/** "45000" becomes "45k tokens"; small counts stay whole. */
export function tokenText(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k tokens` : `${n} tokens`
}

/** The one-time toast for the first send on a cold cache; null when the cache is not cold or the cost is unknown. */
export function recacheNote(file: CacheFile | null | undefined, nowMs: number, say: (tokens: number) => string = t => `The cache went cold. This send re-reads about ${tokenText(t)}.`): string | null {
  const tokens = file?.prompt_cache?.recache_tokens_if_cold
  if (!cacheStatus(file, nowMs)?.isCold || typeof tokens !== 'number') return null

  return say(tokens)
}

export type Reading = { at: number; pct: number }
const HISTORY_MS = 30 * 60_000
const MIN_SPAN_MS = 3 * 60_000

/** Adds a reading of the five-hour window and drops old ones. A fall in the percent means the window reset, so history restarts. */
export function addReading(history: Reading[], at: number, pct: number): Reading[] {
  const last = history[history.length - 1]
  if (last && last.pct === pct) return history
  const base = last && pct < last.pct ? [] : history

  return [...base, { at, pct }].filter(r => at - r.at <= HISTORY_MS)
}

/**
 * "empty in ~40m" when the pace of the recent readings reaches 100 percent before the window resets; otherwise null.
 * Needs readings at least three minutes apart that are rising.
 */
export function forecast(history: Reading[], nowMs: number, resetsAtMs: number | null, phrase = 'empty in'): string | null {
  const first = history[0]
  const last = history[history.length - 1]
  if (!first || !last || resetsAtMs === null || last.at - first.at < MIN_SPAN_MS || last.pct <= first.pct) return null
  const eta = ((100 - last.pct) / ((last.pct - first.pct) / (last.at - first.at))) - (nowMs - last.at)
  if (eta <= 0 || nowMs + eta >= resetsAtMs) return null
  const minutes = Math.max(1, Math.round(eta / 60_000))

  return `${phrase} ~${minutes >= 10 ? Math.round(minutes / 5) * 5 : minutes}m`
}
