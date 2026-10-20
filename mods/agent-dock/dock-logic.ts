// Everything Agent Dock decides without touching the engine. No `$` in this file, so tests import it directly.
import type { AgentDockAction, AgentDockCard, AgentDockGate, AgentDockHelperModel, AgentDockTouch } from '../../types'

import { cells, cutCells } from '../shared/look'
export { fit } from '../shared/look'

export const SIZES = [1, 3, 5, 10, 20, 50, 100] as const
export const MAX_SIZE = 100
export const BIG_TEAM = 20
export const TILE_THRESHOLD = 12
export const PROGRESS_TOOL = 'mcp__carapace__report_progress'
export const NUDGE_PREFIX = 'You used '

/** "10" → 10. Anything but a whole number from 1 to 100 is null. */
export function parseSize(text: string): number | null {
  if (!/^\s*\d+\s*$/.test(text)) return null
  const n = Number(text.trim())

  return n >= 1 && n <= MAX_SIZE ? n : null
}

/** A big team never carries over to a new session. */
export function restoreSize(saved: unknown): number {
  return typeof saved === 'number' && Number.isInteger(saved) && saved >= 1 && saved <= BIG_TEAM ? saved : 1
}

export function needsConfirm(size: number): boolean {
  return size > BIG_TEAM
}

/** Concurrent helpers: the lower of the two engine limits. */
export function engineLimit(maxSubagents: string | undefined, maxToolUse: string | undefined): number {
  const read = (v: string | undefined, fallback: number) => (v && /^\d+$/.test(v.trim()) && Number(v) > 0 ? Number(v) : fallback)

  return Math.min(read(maxSubagents, 20), read(maxToolUse, 10))
}

function clipWords(text: string, max: number): string {
  if (cells(text) <= max) return text
  const cut = cutCells(text, max - 1)
  const space = cut.lastIndexOf(' ')

  return (space > 10 ? cut.slice(0, space) : cut).replace(/[\s,.;:-]+$/, '') + '…'
}

/** The first clause of a request, about 40 characters, capitalised. */
export function jobName(request: string): string {
  const first = request.trim().split(/[.!?\n;]|,\s|\s(?:and then|then|so that)\s/i)[0] ?? ''
  const clean = first.replace(/\s+/g, ' ').trim()
  if (clean === '') return 'Working on it'

  return clipWords(clean.charAt(0).toUpperCase() + clean.slice(1), 40)
}

/** A helper's card name: 3 to 5 words. */
export function taskName(description: string): string {
  const words = description.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 5)
  const name = words.join(' ')

  return name === '' ? 'Helper' : clipWords(name.charAt(0).toUpperCase() + name.slice(1), 32)
}

/** Two letters for a badge: first and last word ("Price check: Panera" → "PP"). */
export function initials(task: string): string {
  const words = task.match(/[A-Za-z0-9]+/g) ?? []
  const first = words[0] ?? '?'
  const last = words.length > 1 ? (words[words.length - 1] ?? '') : (first[1] ?? '')

  return (first.charAt(0) + last.charAt(0)).toUpperCase()
}

/** The models a helper can run on, weakest first. */
export const TIERS = ['haiku', 'sonnet', 'opus', 'fable'] as const
export type Tier = (typeof TIERS)[number]
export const TIER_NAMES: Record<Tier, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' }
/** One letter per model, for the badge beside a helper. */
export const BADGE_TIERS: Record<Tier, string> = { haiku: 'H', sonnet: 'S', opus: 'O', fable: 'F' }

/** The family a model id belongs to ("claude-opus-5-5" → opus), or null. */
export function tierOf(model: string): Tier | null {
  return TIERS.find(t => model.toLowerCase().includes(t)) ?? null
}

/** A helper never runs on a stronger model than the person's own. */
export function capModel(chosen: Tier, main: string): Tier {
  const top = tierOf(main)
  if (top === null) return chosen

  return TIERS.indexOf(chosen) > TIERS.indexOf(top) ? top : chosen
}

/** "2 Haiku 1 Sonnet": the working helpers by model, strongest last. */
export function modelMix(models: readonly (string | null | undefined)[]): string {
  const counts = TIERS.map(t => [t, models.filter(m => m === t).length] as const).filter(([, n]) => n > 0)

  return counts.map(([t, n]) => `${n} ${TIER_NAMES[t]}`).join(' ')
}

/** The instruction added to every request when the team has more than one helper. */
export function instruction(size: number): string {
  return [
    `Crew: the crew size is ${size}.`,
    `- Split this request into exactly ${size} independent pieces and launch one helper (the Agent tool) per piece, all in one message so they run in parallel.`,
    '- Find a real split, one helper per item (per store, per task, per file, per section). Never argue that it cannot be split and never pad with useless work.',
    '- Give each helper a short plain-English description of 3 to 5 words, for example "Price check: Panera".',
    `- In each helper's prompt add: "As you work, call ${PROGRESS_TOOL} with your task name and a percent at about 25, 50, 75 and 100. Do not call plan_steps."`,
    '- When they finish, combine their results into one answer.',
  ].join('\n')
}

export function nudgeText(used: number, size: number): string {
  return `${NUDGE_PREFIX}${used} of ${size} helpers. Split the remaining work across the other ${size - used}, one helper per piece, all in parallel.`
}

export function denyText(size: number): string {
  return `Crew size is ${size}: this request already has ${size} helpers. Finish with the helpers you have.`
}

export const HELPERS_SKIP_PLAN = 'Helpers skip the plan and call report_progress as they work.'
export const STOPPED = 'Stopped before this helper started.'
export const TOO_NARROW = 'Crew needs a window at least 110 columns wide. Widen it, or watch the status bar.'
export const BAD_SIZE = 'Type a whole number from 1 to 100'

export type Counts = { working: number; queued: number; done: number; stuck: number; total: number }

export function counts(cards: readonly AgentDockCard[]): Counts {
  const c = { working: 0, queued: 0, done: 0, stuck: 0, total: cards.length }
  for (const card of cards) c[card.status] += 1

  return c
}

export function badge(c: Counts, size: number, name = 'Crew'): string {
  if (c.total === 0) return `◆ ${name} of ${size}`
  const parts = [`${c.working} working`, `${c.queued} queued`, `${c.done} done`]
  if (c.stuck > 0) parts.push(`${c.stuck} stuck`)

  return parts.join(' · ')
}

/** 0:41, 12:05, 1:02:09 */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const pad = (n: number) => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600)

  return h > 0 ? `${h}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`
}

/** 2m 14s */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)

  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export function summary(c: Counts, job: string, ms: number): string {
  const finished = c.done + c.stuck
  const line = `${finished} ${finished === 1 ? 'agent' : 'agents'} finished ${job} in ${duration(ms)}`

  return c.stuck > 0 ? `${line} (${c.stuck} got stuck)` : line
}

/** A card's share of the mission: finished counts 100, working its reported percent. */
export function cardPercent(card: AgentDockCard): number {
  if (card.status === 'done' || card.status === 'stuck') return 100

  return card.status === 'working' ? card.percent : 0
}

export function missionPercent(cards: readonly AgentDockCard[]): number {
  if (cards.length === 0) return 0

  return Math.round(cards.reduce((sum, card) => sum + cardPercent(card), 0) / cards.length)
}

/** A meter of `width` cells: filled to the percent, or a moving sweep while nothing is reported. */
export function meter(percent: number, width: number, sweepFrame: number | null): { filled: string; empty: string } {
  const w = Math.max(1, width)
  if (sweepFrame !== null) {
    const at = (sweepFrame % (w + 4)) - 4
    const cells = Array.from({ length: w }, (_, i) => (i >= at && i < at + 4 ? '━' : '─'))

    return { filled: cells.join(''), empty: '' }
  }
  const n = Math.round((Math.min(100, Math.max(0, percent)) / 100) * w)

  return { filled: '━'.repeat(n), empty: '─'.repeat(w - n) }
}

export function helperModelLabel(model: AgentDockHelperModel): string {
  return model === 'auto' ? 'Model per task' : model === 'fast' ? 'Fast & Cheap' : 'Same model as you'
}

export function infoLine(size: number, limit: number, model: AgentDockHelperModel): string {
  const split = size === 1 ? 'Claude decides how many helpers' : `Splits each request across ${size} helpers`

  return `${split}  ·  ${Math.min(Math.max(size, 1), limit)} at a time  ·  ${helperModelLabel(model)}`
}

export type RadarKind = 'blank' | 'ring' | 'trail' | 'sweep' | 'core' | AgentDockCard['status']
export type RadarCell = { ch: string; kind: RadarKind }

/**
 * Helpers as contacts on sonar. Each starts at the rim and moves toward the core as it reports progress;
 * finished ones settle at the core, stuck ones stay red at the rim. Character cells are about twice as tall
 * as wide, so x distances are halved to keep the rings round.
 */
export function radar(cards: readonly AgentDockCard[], sweep: number, width: number, height: number): RadarCell[][] {
  const w = width % 2 === 0 ? width - 1 : width
  const h = height % 2 === 0 ? height - 1 : height
  const cx = (w - 1) / 2
  const cy = (h - 1) / 2
  const R = cy
  const grid: RadarCell[][] = Array.from({ length: h }, () => Array.from({ length: w }, () => ({ ch: ' ', kind: 'blank' as RadarKind })))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / 2
      const dy = y - cy
      const r = Math.hypot(dx, dy)
      if (r > R + 0.4) continue
      const row = grid[y]
      if (!row) continue
      if ([R / 3, (2 * R) / 3, R].some(k => Math.abs(r - k) < 0.32) || ((x === cx || y === cy) && r <= R)) row[x] = { ch: '·', kind: 'ring' }
      let diff = sweep - Math.atan2(dy, dx)
      while (diff < 0) diff += Math.PI * 2
      while (diff >= Math.PI * 2) diff -= Math.PI * 2
      if (diff < 0.9 && r <= R) row[x] = diff < 0.18 ? { ch: '•', kind: 'sweep' } : { ch: '∙', kind: 'trail' }
    }
  }
  const core = grid[cy]
  if (core) core[cx] = { ch: '◆', kind: 'core' }
  const useInitials = cards.length <= 24
  cards.forEach((card, i) => {
    const angle = (i / Math.max(1, cards.length)) * Math.PI * 2 - Math.PI / 2
    const radius =
      card.status === 'done' ? 1.2 : card.status === 'queued' ? R : card.status === 'stuck' ? R - 0.4 : 1.6 + (R - 1.6) * (1 - card.percent / 100)
    const x = Math.round(cx + Math.cos(angle) * radius * 2)
    const y = Math.round(cy + Math.sin(angle) * radius)
    const row = grid[y]
    if (!row || x < 0 || x >= w) return
    if (useInitials && x + 1 < w) {
      const ini = initials(card.task)
      row[x] = { ch: ini.charAt(0), kind: card.status }
      row[x + 1] = { ch: ini.charAt(1) || ' ', kind: card.status }
    } else {
      row[x] = { ch: '•', kind: card.status }
    }
  })

  return grid
}

/** The rows of the conversation record the Crew reads: Agent calls and their outcomes, and task notices in user text. */
export type HelperRow = {
  role: 'user' | 'assistant'
  text: string
  toolUses: readonly { tool_use_id: string; tool: string; input: Record<string, unknown>; result?: unknown; text?: string; isError?: true; agentId?: string }[]
}

const NOTICE = /<task-notification>([\s\S]*?)<\/task-notification>/g
const tag = (body: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1]?.trim()

/**
 * How each helper ended, by its Agent call's id, as the main conversation's record tells it: a refused or failed call
 * is stuck; a foreground call answered is done; a background one is done or stuck by its task notice.
 */
export function settledHelpers(rows: readonly HelperRow[]): Map<string, 'done' | 'stuck'> {
  const settled = new Map<string, 'done' | 'stuck'>()
  const byAgent = new Map<string, string>()
  for (const row of rows) {
    for (const use of row.toolUses) {
      if (use.tool !== 'Agent' && use.tool !== 'Task') continue
      if (use.agentId) byAgent.set(use.agentId, use.tool_use_id)
      if (use.text === undefined) continue
      const record = use.result as { status?: unknown } | undefined
      const isBackground = use.input.run_in_background === true || record?.status === 'async_launched'
      if (use.isError) settled.set(use.tool_use_id, 'stuck')
      else if (!isBackground) settled.set(use.tool_use_id, 'done')
    }
    if (row.role !== 'user') continue
    for (const notice of row.text.matchAll(NOTICE)) {
      const body = notice[1] ?? ''
      const id = tag(body, 'tool-use-id') ?? byAgent.get(tag(body, 'task-id') ?? '')
      const status = tag(body, 'status')
      if (id && status) settled.set(id, /fail|kill|error|stop/i.test(status) ? 'stuck' : 'done')
    }
  }

  return settled
}

/** How many recent actions the Crew keeps per helper, and for how many helpers. */
export const ACTIVITY_SIZE = 3
export const ACTIVITY_AGENTS = 30

export const base = (path: unknown) => String(path ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''

/** One plain line for what a helper did: "Reading install.sh", "Running npm test", "Searching for TODO". */
export function activityLine(tool: string, input: Record<string, unknown>): string {
  const clip = (text: string) => taskName(text.replace(/\s+/g, ' ').trim()).slice(0, 48) || tool
  switch (tool) {
    case 'Read':
      return `Reading ${base(input.file_path)}`
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${base(input.file_path)}`
    case 'Write':
      return `Writing ${base(input.file_path)}`
    case 'Bash':
      return `Running ${clip(String(input.command ?? '').split('\n')[0] ?? '')}`
    case 'Grep':
      return `Searching for ${clip(String(input.pattern ?? ''))}`
    case 'Glob':
      return `Finding ${clip(String(input.pattern ?? ''))}`
    case 'WebFetch':
    case 'WebSearch':
      return `Looking up ${clip(String(input.query ?? input.url ?? ''))}`
    default:
      return tool.startsWith('mcp__') ? `Using ${tool.split('__').pop() ?? tool}` : `Using ${tool}`
  }
}

/** Adds one action to a helper's list, newest last, keeping the lists small. */
export function withAction(
  activity: Readonly<Record<string, readonly AgentDockAction[]>>,
  agentId: string,
  action: AgentDockAction,
): Record<string, AgentDockAction[]> {
  const next: Record<string, AgentDockAction[]> = {}
  for (const [id, list] of Object.entries(activity)) if (id !== agentId) next[id] = [...list]
  next[agentId] = [...(activity[agentId] ?? []), action].slice(-ACTIVITY_SIZE)
  const ids = Object.keys(next)
  for (const id of ids.slice(0, Math.max(0, ids.length - ACTIVITY_AGENTS))) delete next[id]

  return next
}

const GLYPH_ACTION = '▸'

/** A helper's conversation as the Crew pane shows it: its requests, replies and actions, one line each, newest last. */
export function transcriptLines(rows: readonly HelperRow[], max: number): string[] {
  const first = (text: string) => text.replace(/<[^>]+>/g, ' ').split('\n').map(line => line.trim()).find(line => line !== '') ?? ''
  const lines: string[] = []
  for (const row of rows) {
    const text = first(row.text)
    if (text !== '') lines.push(row.role === 'user' ? `› ${text}` : text)
    for (const use of row.toolUses) lines.push(`${GLYPH_ACTION} ${activityLine(use.tool, use.input)}`)
  }

  return lines.slice(-max)
}

/** Crew lanes: the files each helper touched, newest first. */
export const LANE_FILES = 6

const WRITES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/** The file a tool call touched and how, or null for tools that touch none. */
export function fileTouch(tool: string, input: Record<string, unknown>): { path: string; kind: 'read' | 'write' } | null {
  const pick = (...keys: string[]) => keys.map(k => input[k]).find((v): v is string => typeof v === 'string' && v !== '')
  if (WRITES.has(tool)) {
    const path = pick('file_path', 'notebook_path')

    return path ? { path, kind: 'write' } : null
  }
  if (tool === 'Read' || tool === 'Grep') {
    const path = pick('file_path', 'path')

    return path ? { path, kind: 'read' } : null
  }

  return null
}

/** Adds one touch to a helper's lane: newest first, one entry per file (a write stays a write), capped. */
export function withTouch(
  lanes: Readonly<Record<string, readonly AgentDockTouch[]>>,
  agentId: string,
  touch: { path: string; kind: 'read' | 'write' },
  at: number,
): Record<string, AgentDockTouch[]> {
  const next: Record<string, AgentDockTouch[]> = {}
  for (const [id, list] of Object.entries(lanes)) if (id !== agentId) next[id] = [...list]
  const old = (lanes[agentId] ?? []).find(t => t.path === touch.path)
  const kind = old?.kind === 'write' ? 'write' : touch.kind
  next[agentId] = [{ path: touch.path, kind, at }, ...(lanes[agentId] ?? []).filter(t => t.path !== touch.path)].slice(0, LANE_FILES)
  const ids = Object.keys(next)
  for (const id of ids.slice(0, Math.max(0, ids.length - ACTIVITY_AGENTS))) delete next[id]

  return next
}

/** Files written by two or more of the given running helpers. */
export function clashes(lanes: Readonly<Record<string, readonly AgentDockTouch[]>>, running: readonly string[]): Set<string> {
  const seen = new Map<string, number>()
  for (const id of running) for (const t of lanes[id] ?? []) if (t.kind === 'write') seen.set(t.path, (seen.get(t.path) ?? 0) + 1)

  return new Set([...seen].filter(([, n]) => n > 1).map(([p]) => p))
}

/** Session badge: a glyph and a palette token from a hash of the worktree root (or the session id). */
export const BADGE_GLYPHS = ['◆', '●', '■', '▲', '▼', '★', '✦', '❖', '♦', '◉', '⬢', '✚'] as const
export const BADGE_COLORS = ['accent', 'good', 'warn', 'highlight', 'accentDeep'] as const

export function sessionBadge(root: string | null | undefined, sessionId: string): { glyph: string; color: (typeof BADGE_COLORS)[number] } {
  const key = root && root !== '' ? root : sessionId
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i += 1) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0

  return { glyph: BADGE_GLYPHS[h % BADGE_GLYPHS.length] ?? '◆', color: BADGE_COLORS[Math.floor(h / BADGE_GLYPHS.length) % BADGE_COLORS.length] ?? 'accent' }
}

/** Done gate: how often a failing helper is sent back before it may stop. */
export const GATE_RETRIES = 2
export const GATE_FILE = '.carapace/done-checks'

/** One shell command per line; blank lines and # comments are skipped. */
export function parseChecks(text: string): string[] {
  return text.split('\n').map(l => l.trim()).filter(l => l !== '' && !l.startsWith('#'))
}

/** What the helper is told when checks fail. */
export function gateText(failures: readonly { command: string; output: string }[]): string {
  const body = failures.map(f => `$ ${f.command}\n${f.output.trim().slice(-1500)}`).join('\n\n')

  return `Done checks failed. Fix them, then finish again.\n\n${body}`
}

/** After a run: block (send back), pass, or give up. `tries` is how often it was sent back already. */
export function gateStep(tries: number, isFailing: boolean): { action: 'pass' | 'block' | 'giveup'; tries: number } {
  if (!isFailing) return { action: 'pass', tries }
  if (tries < GATE_RETRIES) return { action: 'block', tries: tries + 1 }

  return { action: 'giveup', tries }
}

export function gateLabel(gate: AgentDockGate | undefined): string {
  if (!gate) return ''
  if (gate.status === 'passed') return 'gate: passed'
  if (gate.status === 'failed') return `gate: failed (${gate.tries} tries)`

  return `gate: retrying (${gate.tries})`
}

/** A helper runs in the session's worktree when its folder is the root or beneath it, outside any nested worktree. */
export function isSameWorktree(root: string, cwd: string): boolean {
  return cwd === root || (cwd.startsWith(root + '/') && !/\/worktrees\//.test(cwd.slice(root.length)))
}
