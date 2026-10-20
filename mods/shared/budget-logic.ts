// Pure pieces of the API-credit view: account type, number formats, budget periods, per-day accounting, messages. No `$` here.

export type Period = 'day' | 'week' | 'month' | 'session'
export type Budget = { unit: 'usd' | 'tokens'; amount: number; period: Period }
export type Totals = { usd: number; tokens: number }
export type Ledger = { days: Record<string, Totals>; sess: Record<string, { usd: number; tokens: number; baseUsd: number; baseTokens: number; at: number }> }
export type Account = { kind: 'unknown' | 'subscriber' | 'api'; gateway: { percentUsed: number; resetsAt: number | null } | null }
export type Level = 'ok' | 'amber' | 'red'
export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

export const EMPTY_LEDGER: Ledger = { days: {}, sess: {} }
export const KEEP_DAYS = 62
const DAY_MS = 86_400_000
const PERIODS: Period[] = ['day', 'week', 'month', 'session']

/** Subscription when a five_hour window is reported; a spend_limit window is a company budget; otherwise API credits. API only once a response has cost something, because a subscriber's windows arrive with the first response. */
export function accountOf(limits: RateLimit[], usd: number, prev: Account): Account {
  const sub = limits.find(r => r.kind === 'five_hour')
  if (sub) return { kind: 'subscriber', gateway: null }
  const cap = limits.find(r => r.kind === 'spend_limit')
  if (cap) {
    const resets = cap.resetsAt ? Date.parse(cap.resetsAt) : NaN
    return { kind: 'api', gateway: { percentUsed: cap.percentUsed, resetsAt: Number.isNaN(resets) ? null : resets } }
  }
  if (prev.kind === 'subscriber') return prev

  return usd > 0 ? { kind: 'api', gateway: null } : prev
}

/** 950, 12k, 1.2M. */
export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(Math.round(n / 100_000) / 10).toString()}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(Math.round(n / 100) / 10).toString()}k`

  return String(Math.round(n))
}

/** $3.40 under $100, $120 above. */
export function money(usd: number): string {
  return usd < 100 ? `$${Math.max(0, usd).toFixed(2)}` : `$${Math.round(usd)}`
}

const amount = (n: number, unit: Budget['unit']): string => (unit === 'usd' ? money(n) : `${compactTokens(n)} tok`)

/** "5M" "20k" "1.5m" to a number; null when it is not a count. */
function count(text: string): number | null {
  const m = text.match(/^(\d+(?:\.\d+)?)([kmb]?)$/)
  if (!m) return null

  return Number(m[1]) * ({ '': 1, k: 1e3, m: 1e6, b: 1e9 }[m[2] as '' | 'k' | 'm' | 'b'])
}

export type Parsed = { kind: 'show' } | { kind: 'off' } | { kind: 'set'; budget: Budget } | { kind: 'error' }

/** The words after "/budget": "$20 day", "5M tokens week", "20 month", "off", or nothing. */
export function parseBudget(args: string): Parsed {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { kind: 'show' }
  if (words.length === 1 && words[0] === 'off') return { kind: 'off' }
  const period = words[words.length - 1] as Period
  if (!PERIODS.includes(period) || words.length < 2) return { kind: 'error' }
  const rest = words.slice(0, -1)
  const unitWord = rest[rest.length - 1]
  const isTokens = unitWord === 'tokens' || unitWord === 'token' || unitWord === 'tok'
  const figure = (isTokens ? rest.slice(0, -1) : rest).join('').replace(/^\$/, '')
  const n = count(figure)
  if (n === null || n <= 0 || (isTokens && rest.some(w => w.startsWith('$')))) return { kind: 'error' }

  return { kind: 'set', budget: { unit: isTokens ? 'tokens' : 'usd', amount: n, period } }
}

export function describeBudget(b: Budget): string {
  return `${amount(b.amount, b.unit)} per ${b.period}`
}

/** Local date, YYYY-MM-DD. */
export function localDate(ms: number): string {
  const d = new Date(ms)

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const midnight = (ms: number, addDays = 0): number => {
  const d = new Date(ms)

  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + addDays).getTime()
}

/** When the period resets: next local midnight (day and week roll daily), the first of next month, or never (session: null). */
export function resetOf(period: Period, nowMs: number): number | null {
  if (period === 'session') return null
  if (period === 'month') {
    const d = new Date(nowMs)

    return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
  }

  return midnight(nowMs, 1)
}

/** The dates a period counts: today; the last 7 local days ending today; the calendar month so far. */
function datesOf(period: Period, nowMs: number): string[] {
  if (period === 'week') return Array.from({ length: 7 }, (_, i) => localDate(midnight(nowMs, -i)))
  if (period === 'month') {
    const day = new Date(nowMs).getDate()

    return Array.from({ length: day }, (_, i) => localDate(midnight(nowMs, -i)))
  }

  return [localDate(nowMs)]
}

/** Adds a session's growth to today. usd is the session's total so far (a fall means /clear, so the count restarts); tokens is new tokens since the last call. Never counts a total twice. */
export function record(ledger: Ledger, id: string, usd: number, newTokens: number, nowMs: number, isResumed = false): Ledger {
  const seen = ledger.sess[id]
  const prevUsd = seen ? (usd < seen.usd ? 0 : seen.usd) : isResumed ? usd : 0
  const addUsd = Math.max(0, usd - prevUsd)
  const today = localDate(nowMs)
  const day = ledger.days[today] ?? { usd: 0, tokens: 0 }
  const keepFrom = localDate(midnight(nowMs, -(KEEP_DAYS - 1)))
  const days = Object.fromEntries(Object.entries({ ...ledger.days, [today]: { usd: day.usd + addUsd, tokens: day.tokens + newTokens } }).filter(([k]) => k >= keepFrom))
  const sess = Object.fromEntries(
    Object.entries({
      ...ledger.sess,
      [id]: { usd, tokens: (seen?.tokens ?? 0) + newTokens, baseUsd: seen ? (usd < seen.usd ? 0 : seen.baseUsd) : isResumed ? usd : 0, baseTokens: seen?.baseTokens ?? 0, at: nowMs },
    }).filter(([, s]) => nowMs - s.at <= KEEP_DAYS * DAY_MS),
  )

  return { days, sess }
}

/** What this session has used (cost since it was first seen here, tokens counted here). */
export function sessionTotals(ledger: Ledger, id: string): Totals {
  const s = ledger.sess[id]

  return s ? { usd: Math.max(0, s.usd - s.baseUsd), tokens: s.tokens } : { usd: 0, tokens: 0 }
}

export function spentIn(ledger: Ledger, b: Budget, id: string, nowMs: number): number {
  const t = b.period === 'session' ? sessionTotals(ledger, id) : datesOf(b.period, nowMs).reduce((sum, d) => ({ usd: sum.usd + (ledger.days[d]?.usd ?? 0), tokens: sum.tokens + (ledger.days[d]?.tokens ?? 0) }), { usd: 0, tokens: 0 })

  return b.unit === 'usd' ? t.usd : t.tokens
}

export const levelOf = (pct: number): Level => (pct >= 100 ? 'red' : pct >= 80 ? 'amber' : 'ok')

export type View = { text: string; level: Level; pct: number | null }

/** The bar header's money slot: null for a subscriber (never money) or before the account is known. `limit` is the look's gauge word. */
export function headerView(account: Account, budget: Budget | null, ledger: Ledger, id: string, nowMs: number, limit = 'O₂'): View | null {
  if (account.kind !== 'api') return null
  if (account.gateway) {
    const used = account.gateway.percentUsed

    return { text: `${limit} ${Math.max(0, Math.round(100 - used))}% · company budget`, level: levelOf(used), pct: used }
  }
  if (!budget) {
    const t = sessionTotals(ledger, id)

    return { text: `⛁ ${compactTokens(t.tokens)} tok · ${money(t.usd)}`, level: 'ok', pct: null }
  }
  const spent = spentIn(ledger, budget, id, nowMs)
  const pct = (spent / budget.amount) * 100
  const left = Math.max(0, budget.amount - spent)

  return { text: `${limit} ${Math.max(0, Math.round(100 - pct))}% · ${amount(left, budget.unit)} left`, level: levelOf(pct), pct }
}

const WORD: Record<Period, string> = { day: 'daily', week: 'weekly', month: 'monthly', session: 'session' }
const OWN: Record<Period, string> = { day: "today's", week: "this week's", month: "this month's", session: "this session's" }

export const overText = (b: Budget, spent: number): string => `Over your ${WORD[b.period]} budget by ${amount(spent - b.amount, b.unit)}.`
export const nearText = (b: Budget, pct: number): string => `${Math.round(pct)}% of your ${WORD[b.period]} budget is used.`

/** A toast when the level rises within a period (80% once, 100% once); the caller adds the red toast on every send. `key` names the period instance, so a new day fires again. */
export function warnStep(prev: { key: string; level: Level } | null, key: string, level: Level): { toast: Level | null; next: { key: string; level: Level } } {
  const before = prev && prev.key === key ? prev.level : 'ok'
  const rank = { ok: 0, amber: 1, red: 2 }

  return { toast: rank[level] > rank[before] ? level : null, next: { key, level } }
}

/** The period instance: the date for day and week, the month for month. */
export const periodKey = (b: Budget, id: string, nowMs: number): string => (b.period === 'session' ? id : b.period === 'month' ? localDate(nowMs).slice(0, 7) : localDate(nowMs))

export const subscriberOnly = (limit: string) => `Budgets are for API credits; your plan's limit is the ${limit} gauge.`
export const ACCOUNT_UNKNOWN = 'carapace learns whether you are on a plan or API credits from the first reply. Send a message, then set the budget.'
/** Store key: the last account kind a reply showed, so a new session knows it before its first reply. */
export const ACCOUNT_KIND_KEY = 'budgetAccountKind'

/** The account to judge a command by: this session's, else the kind the last session saw. */
export function knownKind(account: Account, stored: unknown): Account['kind'] {
  return account.kind !== 'unknown' ? account.kind : stored === 'subscriber' || stored === 'api' ? stored : 'unknown'
}

/** The cold-cache toast, by account. perToken is the cache-write price in dollars per token, or null when unknown. */
export function coldNote(account: Account, tokens: number, perToken: number | null, budget: Budget | null): string {
  const t = `${compactTokens(tokens)} tokens`
  if (account.kind === 'subscriber') return `The cache went cold. This send re-reads about ${t}; it counts against your 5-hour limit.`
  if (account.kind !== 'api' || perToken === null) return `The cache went cold. This send re-reads about ${t}.`
  const usd = tokens * perToken
  const cost = `about ${usd < 0.01 ? '$0.01' : money(usd)}`
  if (!account.gateway && budget) {
    const share = Math.round(((budget.unit === 'usd' ? usd : tokens) / budget.amount) * 100)

    return `The cache went cold. This send costs ${cost}, ${Math.max(1, share)}% of ${OWN[budget.period]} budget.`
  }

  return `The cache went cold. This send costs ${cost} to re-cache.`
}
