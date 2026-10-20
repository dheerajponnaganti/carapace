// Everything Work Report decides without touching the engine. No `$` in this file, so tests import it directly.

import type { WorkReportDay, WorkReportKind, WorkReportSettings, WorkReportTab } from '../../types'
import { fit } from '../shared/look'

export type Kind = WorkReportKind
export type Tab = WorkReportTab
export type DayRecord = WorkReportDay
export type Settings = WorkReportSettings
export type ToolUse = { tool: string; path?: string; lines?: number }

export const KINDS: readonly { key: Kind; label: string; color: string }[] = [
  { key: 'code', label: 'Code', color: '#9B8CE0' },
  { key: 'emails', label: 'Emails', color: '#6CA0DC' },
  { key: 'media', label: 'Images and video', color: '#C678A0' },
  { key: 'documents', label: 'Documents', color: '#D9A35F' },
  { key: 'research', label: 'Research', color: '#4FB3A9' },
  { key: 'other', label: 'Other', color: '#7D8590' },
]

export const DEFAULT_SETTINGS: Settings = {
  rate: 50,
  minutes: { code: 30, emails: 10, documents: 30, media: 20, research: 25, other: 10 },
}

export const TABS: readonly { key: Tab; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'year', label: 'Year' },
]

const MEDIA_FILE = /\.(?:png|jpe?g|gif|webp|svg|heic|tiff?|bmp|mp4|mov|webm|mkv|avi|m4v)$/i
const DOC_FILE = /\.(?:md|markdown|docx?|pdf|pptx?|xlsx?|csv|rtf|odt|ods|odp|pages|key|numbers|txt)$/i
const WRITES = new Set(['Write', 'Edit', 'NotebookEdit'])
// Source files: writing one is coding. Reading one says nothing, since any task may look at code.
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|kts|swift|c|cc|cpp|cxx|h|hpp|cs|php|scala|sh|bash|zsh|ps1|sql|lua|dart|ex|exs|erl|hs|clj|vue|svelte|css|scss|less|html?|ipynb)$/i

/** The kind one tool call points to, or null when it says nothing about the task's kind. */
export function kindOfTool(use: ToolUse): Kind | null {
  const name = use.tool.toLowerCase()
  if (name.startsWith('mcp__carapace__') || name === 'toolsearch') return null
  if (/gmail|outlook|e-?mail|mail|inbox/.test(name)) return 'emails'
  if (/image|video|photo|illustrat|higgsfield|descript|runway|heygen|hyperframes|motion|rasterless/.test(name)) return 'media'
  if (/docs?(?:_|$)|slides?|sheets?|spreadsheet|docx|pptx|xlsx|pdf|notion|document/.test(name)) return 'documents'
  if (/websearch|webfetch|web_search|web_fetch|exa|transcript|browse|scrape|perplexity/.test(name)) return 'research'
  if (use.path && WRITES.has(use.tool)) {
    if (MEDIA_FILE.test(use.path)) return 'media'
    if (use.tool === 'Write' && DOC_FILE.test(use.path)) return 'documents'
    if (use.tool === 'NotebookEdit' || CODE_FILE.test(use.path)) return 'code'
  }
  if (use.path && MEDIA_FILE.test(use.path)) return 'media'

  return null
}

/** One kind per task: the kind its tools pointed to most; ties go in the order of KINDS. */
export function classifyTask(uses: readonly ToolUse[]): Kind {
  const kind = mostUsedKind(uses)
  // A small code change (under 10 changed lines in all) is a quick fix, not half an hour of coding.
  if (kind === 'code' && uses.reduce((sum, use) => sum + (use.lines ?? 0), 0) < SMALL_CHANGE) return 'other'

  return kind
}

export const SMALL_CHANGE = 10
export const SUBSTANTIAL_WORDS = 150

/** Does a task with no tool use deserve a count? Only a substantial reply does: "thanks" and "ok" never. */
export function isWorthCounting(uses: readonly ToolUse[], answer: string): boolean {
  return uses.length > 0 || answer.trim().split(/\s+/).filter(Boolean).length >= SUBSTANTIAL_WORDS
}

/** Changed lines one Edit, Write or NotebookEdit call carries: the longer of the old and new text. */
export function changedLines(input: Record<string, unknown>): number {
  const count = (v: unknown) => (typeof v === 'string' && v !== '' ? v.split('\n').length : 0)

  return Math.max(count(input.new_string), count(input.old_string), count(input.content), count(input.new_source))
}

function mostUsedKind(uses: readonly ToolUse[]): Kind {
  const tally = new Map<Kind, number>()
  for (const use of uses) {
    const kind = kindOfTool(use)
    if (kind) tally.set(kind, (tally.get(kind) ?? 0) + 1)
  }
  let best: Kind = 'other'
  let most = 0
  for (const { key } of KINDS) {
    const n = tally.get(key) ?? 0
    if (n > most) {
      best = key
      most = n
    }
  }

  return best
}

/** Should this submitted prompt become a task? Typed (or sent as typed), not a command, not folded into a running turn. */
export function isTypedRequest(e: { text: string; turnId?: string; origin: { kind: string; asUser?: true } }): boolean {
  const isPerson = e.origin.kind === 'composer' || (e.origin.kind === 'plugin' && e.origin.asUser === true)
  const text = e.text.trim()

  return isPerson && text !== '' && !text.startsWith('/') && e.turnId === undefined
}

/** "claude-opus-5-5" → "Opus 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5". */
export function modelName(id: string | undefined): string {
  if (!id) return 'Unknown'
  const parts = id.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[.*\]$/, '').split('-')
  const words = parts.filter(p => !/^\d+$/.test(p))
  const numbers = parts.filter(p => /^\d+$/.test(p))
  const name = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')

  return numbers.length > 0 ? `${name} ${numbers.join('.')}` : name || id
}

// Days are stepped at local noon, so a clock change never lands a day twice or skips one.
export function noon(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12)
}

export function addDays(date: Date, n: number): Date {
  const d = noon(date)
  d.setDate(d.getDate() + n)

  return d
}

export function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 1 for January 1. */
export function dayOfYear(date: Date): number {
  return Math.round((noon(date).getTime() - new Date(date.getFullYear(), 0, 1, 12).getTime()) / 86_400_000) + 1
}

/** The days a tab covers, oldest first, today last. */
export function stretchDays(tab: Tab, today: Date): Date[] {
  const count = tab === 'today' ? 1 : tab === 'week' ? 7 : tab === 'month' ? 30 : dayOfYear(today)

  return Array.from({ length: count }, (_, i) => addDays(today, i - count + 1))
}

export function tasksOn(record: DayRecord | undefined): number {
  return record ? Object.values(record.kinds).reduce((s, n) => s + (n ?? 0), 0) : 0
}

/** Adds records together: counts per kind and per model. */
export function sumDays(records: readonly (DayRecord | undefined)[]): DayRecord & { tasks: number } {
  const kinds: Partial<Record<Kind, number>> = {}
  const models: Record<string, number> = {}
  for (const r of records) {
    if (!r) continue
    for (const [k, n] of Object.entries(r.kinds)) kinds[k as Kind] = (kinds[k as Kind] ?? 0) + (n ?? 0)
    for (const [m, n] of Object.entries(r.models)) models[m] = (models[m] ?? 0) + n
  }

  return { kinds, models, tasks: Object.values(kinds).reduce((s, n) => s + (n ?? 0), 0) }
}

/** Days in a row with a finished task, ending today (or yesterday, while today is still empty). */
export function streak(days: Record<string, DayRecord>, today: Date): number {
  let at = tasksOn(days[dayKey(today)]) > 0 ? 0 : -1
  let n = 0
  while (tasksOn(days[dayKey(addDays(today, at))]) > 0) {
    n += 1
    at -= 1
  }

  return n
}

export function estimate(kinds: Partial<Record<Kind, number>>, settings: Settings): { hours: number; dollars: number } {
  const minutes = KINDS.reduce((s, { key }) => s + (kinds[key] ?? 0) * settings.minutes[key], 0)
  const hours = minutes / 60

  return { hours, dollars: hours * settings.rate }
}

export function hoursText(hours: number): string {
  return hours >= 100 ? String(Math.round(hours)) : (Math.round(hours * 10) / 10).toFixed(1).replace(/\.0$/, '')
}

export function dollarsText(dollars: number): string {
  return `$${Math.round(dollars).toLocaleString('en-US')}`
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function shortDate(date: Date): string {
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`
}

export function stretchTitle(tab: Tab, today: Date): { left: string; right: string } {
  const days = stretchDays(tab, today)
  const first = days[0] ?? today
  if (tab === 'today') return { left: 'TODAY', right: `${WEEKDAYS[today.getDay()]} ${shortDate(today)}` }
  if (tab === 'week') return { left: 'LAST 7 DAYS', right: `${shortDate(first)} to ${shortDate(today)}` }
  if (tab === 'month') return { left: 'LAST 30 DAYS', right: `${shortDate(first)} to ${shortDate(today)}` }

  return { left: String(today.getFullYear()), right: `1 Jan to ${shortDate(today)}` }
}

export type Column = { label: string; value: number; isCurrent: boolean; isFuture: boolean }

/** What the chart draws: the last 7 days for Today and Week, 30 days for Month, 12 months for Year. */
export function chartColumns(tab: Tab, days: Record<string, DayRecord>, today: Date): Column[] {
  if (tab === 'year') {
    const year = today.getFullYear()
    const totals = Array.from({ length: 12 }, () => 0)
    for (const [key, record] of Object.entries(days)) {
      const [y, m] = key.split('-').map(Number)
      if (y === year && m !== undefined && m >= 1 && m <= 12) totals[m - 1] = (totals[m - 1] ?? 0) + tasksOn(record)
    }

    return totals.map((value, i) => ({ label: MONTHS[i] ?? '', value, isCurrent: i === today.getMonth(), isFuture: i > today.getMonth() }))
  }
  const count = tab === 'month' ? 30 : 7

  return Array.from({ length: count }, (_, i) => {
    const day = addDays(today, i - count + 1)

    return { label: count === 7 ? (WEEKDAYS[day.getDay()] ?? '') : String(day.getDate()), value: tasksOn(days[dayKey(day)]), isCurrent: i === count - 1, isFuture: false }
  })
}

const BLOCKS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

/** Three text rows for one column, top first: a bar of up to 24 eighths. */
export function barRows(value: number, max: number): [string, string, string] {
  const eighths = max > 0 ? Math.round((value / max) * 24) : 0
  const cell = (row: number) => BLOCKS[Math.min(8, Math.max(0, eighths - row * 8))] ?? ' '

  return [cell(2), cell(1), cell(0)]
}

/** The line under the chart. */
export function chartSummary(tab: Tab, days: Record<string, DayRecord>, today: Date): string {
  if (tab === 'today' || tab === 'week') {
    const n = streak(days, today)

    return n === 0 ? 'No streak yet. Finish a task today to start one.' : `${n}-day streak`
  }
  const covered = stretchDays(tab, today)
  const active = covered.filter(d => tasksOn(days[dayKey(d)]) > 0).length
  if (tab === 'month') {
    let best: Date | null = null
    let most = 0
    for (const d of covered) {
      const n = tasksOn(days[dayKey(d)])
      if (n > most) {
        most = n
        best = d
      }
    }

    return best ? `Best day: ${WEEKDAYS[best.getDay()]} ${shortDate(best)}, ${most} tasks  ·  ${active} active days` : 'No active days yet.'
  }
  const months = chartColumns('year', days, today)
  const top = months.reduce((a, b) => (b.value > a.value ? b : a), months[0] ?? { label: '', value: 0, isCurrent: false, isFuture: false })

  return top.value > 0 ? `Best month: ${top.label}, ${top.value} tasks  ·  ${active} active days` : 'No active days yet.'
}

export function emptyLine(tab: Tab): string {
  if (tab === 'today') return 'Nothing finished yet today. Your first finished task shows up here.'
  if (tab === 'week') return 'Nothing finished in the last 7 days. Your first finished task shows up here.'
  if (tab === 'month') return 'Nothing finished in the last 30 days. Your first finished task shows up here.'

  return 'Nothing finished this year yet. Your first finished task shows up here.'
}

const SETTING_NAMES: Record<string, Kind> = {
  emails: 'emails',
  email: 'emails',
  code: 'code',
  coding: 'code',
  documents: 'documents',
  docs: 'documents',
  images: 'media',
  video: 'media',
  media: 'media',
  research: 'research',
  other: 'other',
}

/** `/report settings ...`: the new settings and what to say, or an explanation of what went wrong. */
export function applySetting(args: string, settings: Settings): { settings: Settings; text: string } {
  const [name = '', value = ''] = args.trim().toLowerCase().split(/\s+/)
  const n = Number(value)
  const isNumber = /^\d+(?:\.\d+)?$/.test(value) && n > 0 && n <= 10_000
  if (name === '') return { settings, text: settingsText(settings) }
  if (!isNumber) return { settings, text: 'Use a positive number, e.g. /report settings rate 75 or /report settings emails 15.' }
  if (name === 'rate') return { settings: { ...settings, rate: n }, text: `Hourly rate set to $${n} (estimate).` }
  const kind = SETTING_NAMES[name]
  if (!kind) return { settings, text: 'Settings are: rate, code, emails, documents, images, research, other.' }
  const label = KINDS.find(k => k.key === kind)?.label ?? kind

  return { settings: { ...settings, minutes: { ...settings.minutes, [kind]: n } }, text: `${label}: ${n} minutes saved per task (estimate).` }
}

export function settingsText(settings: Settings): string {
  const rows = KINDS.map(({ key, label }) => `${label}: ${settings.minutes[key]} min per task`)

  return [`Hourly rate: $${settings.rate} (estimate)`, ...rows, 'Change one: /report settings rate 75, /report settings emails 15'].join('\n')
}

// One trimming rule for every mod: the shared one keeps spaced titles' word gaps.
export { fit }

export type Stratum = { month: string; counts: Partial<Record<Kind, number>>; total: number; isCurrent: boolean; isFuture: boolean }

/** One layer per month of the current year: tasks by kind, the current month marked, later months still open water. */
export function strata(days: Record<string, DayRecord>, today: Date): Stratum[] {
  const year = today.getFullYear()
  const layers: Stratum[] = Array.from({ length: 12 }, (_, i) => ({ month: MONTHS[i] ?? '', counts: {}, total: 0, isCurrent: i === today.getMonth(), isFuture: i > today.getMonth() }))
  for (const [key, record] of Object.entries(days)) {
    const [y, m] = key.split('-').map(Number)
    const layer = y === year && m !== undefined ? layers[m - 1] : undefined
    if (!layer) continue
    for (const [kind, n] of Object.entries(record.kinds)) {
      layer.counts[kind as Kind] = (layer.counts[kind as Kind] ?? 0) + (n ?? 0)
      layer.total += n ?? 0
    }
  }

  return layers
}

/** The Week tab's card: the range, the totals and the three busiest kinds, as the plain lines the card shows and Copy takes. */
export function weekCard(days: Record<string, DayRecord>, settings: Settings, today: Date): { lines: string[]; plain: string } {
  const week = stretchDays('week', today)
  const total = sumDays(week.map(day => days[dayKey(day)]))
  const { hours } = estimate(total.kinds, settings)
  const busiest = week.reduce((best, day) => (tasksOn(days[dayKey(day)]) > tasksOn(days[dayKey(best)]) ? day : best), week[0] ?? today)
  const range = stretchTitle('week', today).right
  const bestDay = total.tasks > 0 ? ' · best day ' + WEEKDAYS[busiest.getDay()] : ''
  const top = KINDS.map(k => ({ name: k.label.toLowerCase(), n: total.kinds[k.key] ?? 0 }))
    .filter(k => k.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 3)
  const lines = total.tasks > 0 ? ['This week · ' + range, total.tasks + ' tasks · ' + hoursText(hours) + ' h saved' + bestDay, top.map(k => k.name + ' ' + k.n).join(' · ')] : []

  return { lines, plain: lines.join('\n') }
}
