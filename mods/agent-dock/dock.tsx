import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderElement, Timer } from 'claude-code'

import type { AgentDockCard, AgentDockMission } from '../../types'

import {
  BAD_SIZE,
  HELPERS_SKIP_PLAN,
  NUDGE_PREFIX,
  SIZES,
  STOPPED,
  TOO_NARROW,
  badge,
  clock,
  counts,
  denyText,
  engineLimit,
  infoLine,
  initials,
  instruction,
  jobName,
  missionPercent,
  needsConfirm,
  nudgeText,
  parseSize,
  radar,
  restoreSize,
  summary,
  taskName,
  BADGE_TIERS,
  activityLine,
  capModel,
  settledHelpers,
  withAction,
  GATE_FILE,
  GATE_RETRIES,
  base,
  clashes,
  fileTouch,
  gateLabel,
  gateStep,
  gateText,
  isSameWorktree,
  parseChecks,
  sessionBadge,
  withTouch,
  tierOf,
  transcriptLines,
} from './dock-logic'
import { LOG_SIZE, autoRule, categorize, isCategory, kindOf, lowerEffort, parseRules, rulesText, rulesWith, suggestions } from './categories'
import type { CrewLogEntry, Overrides } from './categories'
import type { HelperRow, RadarKind } from './dock-logic'
import { GLYPH, PALETTES, WORDS, fit, mix, seatColor, spaced } from '../shared/look'
import type { Palette } from '../shared/look'
import { chip, heading, titleLit } from '../shared/ui'

import { COUNT_KEY, HINT_KEY, appendLine, errorLine, hintText, logPath, queueLog } from '../shared/errlog'

type Engine = EngineInterface

const errorsAtom = atom({ plugin: 'carapace', key: 'reportErrors' } as const, 0)

/**
 * Records one failure in ~/.claude/carapace/log.txt (time, mod, what failed, the error's first line, never any content),
 * counts it for the bar's report button and shows the one-time hint. Fire and forget: it never throws or holds a hook.
 * The same helper sits in every mod, because `$` cannot cross an import.
 */
function logError($: Engine, what: string, err: unknown): void {
  void queueLog(async () => {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
    const version = await $.session.version().then(v => v.version, () => '')
    const line = errorLine(await $.clock.now(), 'agent-dock', what, err, version)
    $.ui.log(line, { to: 'debug' })
    if (home !== '') await $.fs.write(logPath(home), appendLine(await $.fs.read(logPath(home)).then(String, () => ''), line))
    const count = Number((await $.store.get(COUNT_KEY)) ?? 0) + 1
    await $.store.set(COUNT_KEY, count)
    await update($, errorsAtom, () => count)
    if (!(await $.store.get(HINT_KEY))) {
      await $.store.set(HINT_KEY, true)
      $.ui.toast(hintText('agent-dock'), { timeoutMs: 8000 })
    }
  })
}

const PANE = 'agent-dock'
// The name for the helpers. Kept here because /crew must open its pane before any read.
let title = WORDS.crew
const PANE_COLUMNS = 78
// Four frames a second while helpers are live: the sonar sweep is the one place carapace moves this fast.
const FRAME_MS = 250
const STORE_SIZE = 'agentDockSize'
const STORE_MODEL = 'agentDockHelperModel'
const STORE_RULES = 'crewRules'
const STORE_LOG = 'crewLog'

const sizeAtom = atom({ plugin: 'carapace', key: 'agentDockSize' } as const, 1)
const pendingAtom = atom({ plugin: 'carapace', key: 'agentDockPending' } as const, null)
const customAtom = atom({ plugin: 'carapace', key: 'agentDockCustom' } as const, false)
const modelAtom = atom({ plugin: 'carapace', key: 'agentDockHelperModel' } as const, 'auto')
const foldedAtom = atom({ plugin: 'carapace', key: 'agentDockFolded' } as const, false)
// Whether the pane is up, kept in state so /dock can answer at once without asking the engine.
const isOpenAtom = atom({ plugin: 'carapace', key: 'agentDockIsOpen' } as const, false)
const limitAtom = atom({ plugin: 'carapace', key: 'agentDockLimit' } as const, 10)
const missionAtom = atom({ plugin: 'carapace', key: 'agentDockMission' } as const, null)
const frameAtom = atom({ plugin: 'carapace', key: 'agentDockFrame' } as const, 0)
// Watch: the helper the person is looking at, its Note box, and every helper's last few actions.
const watchingAtom = atom({ plugin: 'carapace', key: 'agentDockWatching' } as const, null)
const noteOpenAtom = atom({ plugin: 'carapace', key: 'agentDockNoteOpen' } as const, false)
const activityAtom = atom({ plugin: 'carapace', key: 'agentDockActivity' } as const, {})
const filesAtom = atom({ plugin: 'carapace', key: 'agentDockFiles' } as const, {})
const gateAtom = atom({ plugin: 'carapace', key: 'agentDockGate' } as const, {})
const badgeAtom = atom({ plugin: 'carapace', key: 'sessionBadge' } as const, null)
const badgesAtom = atom({ plugin: 'carapace', key: 'agentDockBadges' } as const, {})
const transcriptAtom = atom({ plugin: 'carapace', key: 'agentDockTranscript' } as const, null)
const TRANSCRIPT_LINES = 12
// Your changes to the category table, and what the Crew suggests from its log.
const rulesAtom = atom({ plugin: 'carapace', key: 'crewRules' } as const, {})
const tipsAtom = atom({ plugin: 'carapace', key: 'crewTips' } as const, [])
// The last prompt a person sent. Shared with Clean View: helper results and the nudge arrive as turns too, and must not start a new job.
const personPromptAtom = atom({ plugin: 'carapace', key: 'personPrompt' } as const, null)

// Module variables start over on a hot reload; everything a drawing reads lives in $.state.
let running = 0
const WATCHDOG_MS = 5000
let animation: Timer | undefined
let watchdog: Timer | undefined
let lastFrameAt = 0
let isWindows = false
let statusFile: string | null = null
// The main chat's done gate: an edit since the last stop, and how often it was sent back for failing checks.
let mainEdited = false
let mainTries = 0

function newMission(job: string, size: number, now: number): AgentDockMission {
  return { id: `m-${now}`, job, size, startedAt: now, finishedAt: null, cards: [], launched: 0, nudged: false, isStopped: false }
}

function newCard(id: string, description: string, seat: number): AgentDockCard {
  return { id, task: taskName(description), status: 'queued', percent: 0, hasReported: false, startedAt: null, endedAt: null, agentId: null, seat }
}

function isRequest(text: string): boolean {
  const t = text.trim()

  return t !== '' && !t.startsWith('/') && !t.startsWith(NUDGE_PREFIX)
}

async function refresh($: Engine): Promise<void> {
  const mission = await read($, missionAtom)
  const c = counts(mission?.cards ?? [])
  const isLive = c.working + c.queued > 0
  const now = await $.clock.now()
  // An interval the engine ended stops ticking: replace it when a frame is overdue.
  if (isLive && animation !== undefined && now - lastFrameAt > 3 * FRAME_MS) {
    animation.cancel()
    animation = undefined
  }
  if (isLive && animation === undefined) {
    lastFrameAt = now
    animation = $.clock.every(FRAME_MS, async () => {
      lastFrameAt = await $.clock.now()
      await update($, frameAtom, f => (f ?? 0) + 1)
    })
  }
  if (!isLive && animation !== undefined) {
    animation.cancel()
    animation = undefined
  }
  // While helpers are live, a slow timer re-runs refresh so an ended interval restarts without waiting for an event.
  // It is cancelled before it is re-armed, so only one runs; it draws nothing.
  watchdog?.cancel()
  watchdog = isLive ? $.clock.after(WATCHDOG_MS, () => void refresh($)) : undefined
  const isFolded = await read($, foldedAtom)
  $.ui.status(isFolded && mission !== null ? badge(c, await read($, sizeAtom), title) : undefined)
  if (statusFile !== null) {
    const body = JSON.stringify({ agents: c.working, working: c.working, queued: c.queued, done: c.done, stuck: c.stuck, updatedAt: await $.clock.now() })
    await $.fs.write(statusFile, body + '\n').catch(() => undefined)
  }
}

async function changeMission($: Engine, fn: (m: AgentDockMission) => AgentDockMission): Promise<void> {
  await update($, missionAtom, m => (m ? fn(m) : m))
  await refresh($)
}

/** Settles helper cards the live events missed, from the main conversation's record: a card never stays working forever. */
async function settleFromRecord($: Engine): Promise<void> {
  const mission = await read($, missionAtom)
  if (!mission?.cards.some(card => card.status === 'working' || card.status === 'queued')) return
  let rows: readonly HelperRow[]
  try {
    rows = (await $.session.messages()) as unknown as readonly HelperRow[]
  } catch (err) {
    logError($, 'read the conversation to settle helpers', err)
    return
  }
  const settled = settledHelpers(rows)
  const now = await $.clock.now()
  const isOpen = (card: AgentDockCard) => (card.status === 'working' || card.status === 'queued') && settled.has(card.id)
  if (!mission.cards.some(isOpen)) return
  await changeMission($, m => {
    const cards = m.cards.map(card => {
      if (!isOpen(card)) return card
      const isStuck = settled.get(card.id) === 'stuck'

      return { ...card, status: isStuck ? ('stuck' as const) : ('done' as const), percent: isStuck ? card.percent : 100, endedAt: card.endedAt ?? now }
    })
    const isLive = cards.some(card => card.status === 'working' || card.status === 'queued')

    return { ...m, cards, finishedAt: isLive ? m.finishedAt : (m.finishedAt ?? now) }
  })
}

/** Reads a helper's own conversation for the Crew pane: works on every Claude Code that runs carapace. */
async function loadTranscript($: Engine, agentId: string): Promise<void> {
  let next: { agentId: string; lines: string[]; reason: string | null }
  try {
    const found = await $.session.messages({ agentId })
    next =
      'deny' in found
        ? { agentId, lines: [], reason: String(found.deny) }
        : { agentId, lines: transcriptLines(found as unknown as readonly HelperRow[], TRANSCRIPT_LINES), reason: null }
  } catch (err) {
    logError($, 'read a helper conversation', err)
    next = { agentId, lines: [], reason: 'its conversation could not be read' }
  }
  await update($, transcriptAtom, () => next)
}

function setCard(id: string, fn: (card: AgentDockCard) => AgentDockCard) {
  return (m: AgentDockMission): AgentDockMission => ({ ...m, cards: m.cards.map(card => (card.id === id ? fn(card) : card)) })
}

async function sleepOne($: Engine): Promise<void> {
  await $.process.run(isWindows ? ['powershell', '-NoProfile', '-Command', 'Start-Sleep -Seconds 1'] : ['/bin/sleep', '1'], { cwd: $.plugin.root, timeoutMs: 5000 })
}

/** Settles an open the command started first: unfolded, marked open when placed, a toast when the window is too narrow. */
async function settleOpen($: Engine, opening: Promise<{ isPlaced: boolean }>): Promise<void> {
  const opened = await opening
  await update($, foldedAtom, () => false)
  await update($, isOpenAtom, () => opened.isPlaced)
  if (!opened.isPlaced) $.ui.toast(TOO_NARROW)
  await refresh($)
}

/** Folds the dock to its status-line badge. */
async function foldDock($: Engine): Promise<void> {
  await update($, foldedAtom, () => true)
  await update($, isOpenAtom, () => false)
  await $.ui.close({ id: PANE })
  await refresh($)
}

async function chooseSize($: Engine, size: number): Promise<void> {
  await update($, customAtom, () => false)
  if (needsConfirm(size)) {
    await update($, pendingAtom, () => size)
  } else {
    await update($, pendingAtom, () => null)
    await update($, sizeAtom, () => size)
    await $.store.set(STORE_SIZE, size)
  }
}

async function confirmBig($: Engine): Promise<void> {
  const pending = await read($, pendingAtom)
  if (pending === null) return
  await update($, pendingAtom, () => null)
  await update($, sizeAtom, () => pending)
  // ponytail: kept in the store so a reload mid-session keeps it; restoreSize drops it next session.
  await $.store.set(STORE_SIZE, pending)
}

function readLog(value: unknown): CrewLogEntry[] {
  return Array.isArray(value) ? (value as CrewLogEntry[]) : []
}

/** Logs a finished helper by category, model, time and whether it got stuck, then refreshes the suggestions. */
async function learn($: Engine, card: AgentDockCard | null, isStuck: boolean, now: number): Promise<void> {
  const tier = card?.model ? tierOf(card.model) : null
  if (card === null || tier === null || !card.category || !isCategory(card.category)) return
  const entry: CrewLogEntry = { category: card.category, tier, ms: card.startedAt === null ? 0 : now - card.startedAt, isStuck, at: now }
  const log = [...readLog(await $.store.get(STORE_LOG)), entry].slice(-LOG_SIZE)
  await $.store.set(STORE_LOG, log)
  const overrides = await read($, rulesAtom)
  await update($, tipsAtom, () => suggestions(log, overrides))
}

/** /crew rules: show the table, change one category's model, or reset. */
async function crewRules($: Engine, args: string): Promise<string> {
  const parsed = parseRules(args)
  if (parsed.kind === 'error') return parsed.text
  let overrides = await read($, rulesAtom)
  if (parsed.kind === 'reset') overrides = {}
  if (parsed.kind === 'set') overrides = { ...overrides, [parsed.category]: parsed.tier }
  if (parsed.kind !== 'show') {
    await update($, rulesAtom, () => overrides)
    await $.store.set(STORE_RULES, overrides)
  }
  const tips = suggestions(readLog(await $.store.get(STORE_LOG)), overrides)
  await update($, tipsAtom, () => tips)

  return rulesText(overrides, tips)
}

export function registerAgentDock(on: On): void {
  // Clean View holds the unfiltered session.start; this catch-all matcher keeps the two apart.
  on('session.start', { cwd: /^/ }, async ($, e, next) => {
    const saved = await $.store.get(STORE_SIZE)
    const size = restoreSize(saved)
    if (saved !== size) await $.store.set(STORE_SIZE, size)
    await update($, sizeAtom, () => size)
    const model = await $.store.get(STORE_MODEL)
    if (model === 'auto' || model === 'fast' || model === 'same') await update($, modelAtom, () => model)
    const rules = await $.store.get(STORE_RULES)
    const overrides: Overrides = rules && typeof rules === 'object' ? (rules as Overrides) : {}
    await update($, rulesAtom, () => overrides)
    const log = readLog(await $.store.get(STORE_LOG))
    await update($, tipsAtom, () => suggestions(log, overrides))
    const limit = engineLimit(await $.env.get('CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS'), await $.env.get('CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY'))
    await update($, limitAtom, () => limit)
    isWindows = (await $.env.get('OS')) === 'Windows_NT'
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
    statusFile = home ? `${home}/.claude/ai-employee-kit-data/agents-now/${await $.session.id()}.json` : null
    const badge = sessionBadge(await $.session.root().catch(() => ''), await $.session.id())
    await update($, badgeAtom, () => badge)
    await $.command.register({ name: 'crew', description: 'Open or fold your Crew of helper agents, or set its size', argumentHint: '[1-100] | rules [<category> <model>]' })
    // session.start runs again on every hot reload: settle cards whose end the live events missed.
    await settleFromRecord($).catch(err => logError($, 'settle helpers', err))
    await refresh($)

    return next(e)
  })

  on('command.run', { command: 'crew' }, async ($, e) => {
    try {
      const arg = e.args.trim()
      if (arg === '') {
        // Open first: a pane counts as asked for (shown at any width) only when $.ui.open is the command's first call.
        // Then fold it again if it was already open, which is what a second /crew means.
        const opening = $.ui.open({ id: PANE, title, columns: PANE_COLUMNS })
        const isOpen = await read($, isOpenAtom)
        void (async () => (isOpen ? (await opening, foldDock($)) : settleOpen($, opening)))().catch(err => logError($, 'open the Crew', err))

        // Claude Code treats a command that answers with no text as unanswered.
        return { text: isOpen ? `Folding your ${title}. Type /crew to open it again.` : `Opening your ${title}.` }
      }
      if (/^rules\b/i.test(arg)) return { text: await crewRules($, arg.slice(5)) }
      const size = parseSize(arg)
      if (size === null) return { text: `${title} size is a whole number from 1 to 100, e.g. /crew 10.` }
      // A big crew is confirmed in the pane, so it opens first, before any other call.
      const opening = needsConfirm(size) ? $.ui.open({ id: PANE, title, columns: PANE_COLUMNS }) : null
      void (async () => {
        await chooseSize($, size)
        if (opening !== null) await settleOpen($, opening)
      })().catch(err => logError($, 'change the crew size', err))

      return { text: needsConfirm(size) ? `Confirm ${size} ${title.toLowerCase()} in the ${title} pane.` : `${title} size is ${size}.` }
    } catch (err) {
      logError($, '/crew', err)
      return { text: `Your ${title} could not open. Try /crew again.` }
    }
  })

  // Prompt Upgrade holds the unfiltered prompt.submit; this one matches every text.
  on('prompt.submit', { text: /^/ }, async ($, e, next) => {
    const size = await read($, sizeAtom)
    const isPerson = e.origin.kind === 'composer' || (e.origin.kind === 'plugin' && e.origin.asUser === true)
    const isAsk = isPerson && isRequest(e.text)
    // Remembered before the prompt goes on, because its turn starts inside next(e).
    // If Refine's automatic mode holds the prompt back, the previous one comes back.
    const before = await read($, personPromptAtom)
    if (isAsk) {
      const at = await $.clock.now()
      await update($, personPromptAtom, () => ({ text: e.text.trim(), at }))
    }
    const result = await next(isAsk && size > 1 ? { ...e, context: [...(e.context ?? []), instruction(size)] } : e)
    if (isAsk && 'drop' in result && result.drop) await update($, personPromptAtom, () => before)

    return result
  })

  on('turn.start', { turnId: /^/ }, async ($, e, next) => {
    if (isRequest(e.text) && (await read($, personPromptAtom))?.text === e.text.trim()) {
      const now = await $.clock.now()
      const size = await read($, sizeAtom)
      // Helpers still out from an earlier request keep their cards, so the Crew follows them to the end.
      await update($, missionAtom, old => ({
        ...newMission(jobName(e.text), size, now),
        cards: (old?.cards ?? []).filter(card => card.status === 'working' || card.status === 'queued'),
      }))
      await refresh($)
    }

    return next(e)
  })

  // Cards appear as soon as Claude writes the Agent calls, before any of them runs.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const blocks = (e.message.content ?? []) as readonly { type?: string; id?: string; name?: string; input?: { description?: unknown } }[]
    const calls = blocks.filter(b => b.type === 'tool_use' && b.name === 'Agent' && typeof b.id === 'string')
    if (calls.length > 0) {
      const now = await $.clock.now()
      const size = await read($, sizeAtom)
      await update($, missionAtom, m => {
        const mission = m ?? newMission('Working on it', size, now)
        const fresh = calls
          .filter(b => !mission.cards.some(card => card.id === b.id))
          .map((b, i) => newCard(String(b.id), String(b.input?.description ?? ''), mission.cards.length + i))

        return { ...mission, cards: [...mission.cards, ...fresh] }
      })
      await refresh($)
    }

    return next(e)
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const size = await read($, sizeAtom)
    const now = await $.clock.now()
    const mission = (await read($, missionAtom)) ?? newMission('Working on it', size, now)
    if (size > 1 && mission.launched >= size) {
      await update($, missionAtom, () => ({ ...mission, cards: mission.cards.filter(card => card.id !== e.tool_use_id) }))
      await refresh($)

      return { deny: denyText(size) }
    }
    const description = typeof e.description === 'string' ? e.description : ''
    await update($, missionAtom, () => {
      const cards = mission.cards.some(card => card.id === e.tool_use_id)
        ? mission.cards
        : [...mission.cards, newCard(e.tool_use_id, description, mission.cards.length)]

      return { ...mission, cards, launched: mission.launched + 1 }
    })
    await refresh($)

    // Hold the call until a slot frees up: the engine refuses past its limit instead of queueing.
    const limit = await read($, limitAtom)
    while (running >= limit) {
      if (next.signal.aborted) {
        await changeMission($, m => ({ ...m, cards: m.cards.filter(card => card.id !== e.tool_use_id) }))

        return { deny: STOPPED }
      }
      await sleepOne($)
    }

    // The helper's model. Auto: Claude's pick, else the backup word rules. Fast: Haiku. Same: yours.
    // Never stronger than your own model, whoever picked it.
    const mode = await read($, modelAtom)
    const main = await $.session.model().catch(() => '')
    const category = categorize(`${description} ${typeof e.prompt === 'string' ? e.prompt.slice(0, 400) : ''}`)
    const rule = rulesWith(await read($, rulesAtom))[category]
    const asked = e.model ?? (mode === 'auto' ? rule.tier : mode === 'fast' ? 'haiku' : undefined)
    const model = asked === undefined ? undefined : capModel(asked, main)
    const shown = model ?? tierOf(main)
    running += 1
    await changeMission($, setCard(e.tool_use_id, card => ({ ...card, status: 'working', startedAt: now, model: shown, category })))
    try {
      const ran = await next(model === undefined ? e : { ...e, model })
      const ended = await $.clock.now()
      // A helper is done when its own turn completes (below). Helpers now run in the background,
      // so the launch returns at once; only a refused or failed launch settles the card here.
      if (ran.deny !== undefined || ran.isError === true) {
        await changeMission($, setCard(e.tool_use_id, card => ({ ...card, status: 'stuck', endedAt: ended })))
      }

      return ran
    } finally {
      running -= 1
    }
  })

  // On Auto, Claude's standing instructions carry the model rule, for any request that launches helpers.
  // Clean View holds the unfiltered prompt.compose; this one names its scope.
  on('prompt.compose', { model: /./ }, async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes('Agent') || (await read($, modelAtom)) !== 'auto') return composed

    return { sections: [...composed.sections, { id: 'carapace:crew-models', text: autoRule(await read($, rulesAtom)), scope: 'session' as const }] }
  })

  // Haiku helpers do lookups and quick checks: low effort makes them faster and cheaper still.
  // The step streams, so the hook is a generator that passes every piece on.
  // Each helper's effort follows its category (Lookup low, Write medium, Code high), never above what the step asked for.
  on('turn.step', { agentId: /./ }, async function* ($, e, next) {
    const mode = await read($, modelAtom)
    const card = (await read($, missionAtom))?.cards.find(c => c.agentId === e.agentId)
    const category = card?.category && isCategory(card.category) ? card.category : null
    const target = mode === 'same' ? undefined : mode === 'fast' || tierOf(e.model) === 'haiku' ? 'low' : category ? kindOf(category).rule.effort : undefined
    const effort = target ? lowerEffort(e.effort, target) : undefined

    return yield* next(effort ? { ...e, effort } : e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const agentId = started.agentId
    if (agentId !== undefined) await changeMission($, setCard(e.tool_use_id, card => ({ ...card, agentId })))

    return started
  })

  // Registered before Clean View, so helpers' progress lands here first.
  on('tool.call', { tool: 'mcp__carapace__report_progress', agentId: /./ }, async ($, e) => {
    const input = e as unknown as { task?: unknown; percent?: unknown; agentId?: string }
    const percent = Math.min(100, Math.max(0, Math.round(Number(input.percent) || 0)))
    const task = taskName(String(input.task ?? '')).toLowerCase()
    await changeMission($, m => {
      const byAgent = m.cards.find(card => card.agentId !== null && card.agentId === input.agentId)
      const target = byAgent ?? m.cards.find(card => card.task.toLowerCase() === task && card.status === 'working')
      if (target === undefined) return m

      return setCard(target.id, card => ({ ...card, percent, hasReported: true, agentId: card.agentId ?? input.agentId ?? null }))(m)
    })

    return { result: `Progress noted: ${percent}%.` }
  })

  on('tool.call', { tool: 'mcp__carapace__plan_steps', agentId: /./ }, async () => ({ result: HELPERS_SKIP_PLAN }))

  // Every helper action becomes one plain line for Watch, recorded as it happens: no polling.
  on('tool.call', { agentId: /./ }, async ($, e, next) => {
    const agentId = e.agentId
    if (agentId !== undefined) {
      const line = activityLine(e.tool, e as unknown as Record<string, unknown>)
      const at = await $.clock.now()
      await update($, activityAtom, activity => withAction(activity ?? {}, agentId, { line, at }))
      const touch = fileTouch(e.tool, e as unknown as Record<string, unknown>)
      if (touch) await update($, filesAtom, files => withTouch(files ?? {}, agentId, touch, at))
      // An open conversation follows the helper it shows.
      if ((await read($, transcriptAtom))?.agentId === agentId) void loadTranscript($, agentId).catch(err => logError($, 'show a helper conversation', err))
    }

    return next(e)
  })

  // Another worktree's helpers carry that worktree's badge.
  on('classic.SubagentStart', async ($, e, next) => {
    const root = await $.session.root().catch(() => '')
    if (root !== '' && !isSameWorktree(root, e.cwd)) await update($, badgesAtom, b => ({ ...b, [e.agent_id]: sessionBadge(e.cwd, '') }))

    return next(e)
  })

  // Done gate: run the project's checks in the helper's folder; send it back with the output while they fail.
  on('classic.SubagentStop', async ($, e, next) => {
    const out = await next(e)
    const text = await $.fs.read(`${e.cwd}/${GATE_FILE}`).then(String, () => '')
    const checks = parseChecks(text)
    if (checks.length === 0) return out
    const failures: { command: string; output: string }[] = []
    for (const command of checks) {
      const ran = await $.process.run(['sh', '-c', command], { cwd: e.cwd, timeoutMs: 120_000 }).catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
      if (ran.exitCode !== 0) failures.push({ command, output: `${ran.stdout}\n${ran.stderr}` })
    }
    const prev = (await read($, gateAtom))[e.agent_id]
    const step = gateStep(prev?.status === 'retrying' ? prev.tries : 0, failures.length > 0)
    const status: 'passed' | 'retrying' | 'failed' = step.action === 'pass' ? 'passed' : step.action === 'block' ? 'retrying' : 'failed'
    await update($, gateAtom, g => ({ ...g, [e.agent_id]: { status, tries: step.tries } }))

    return step.action === 'block' ? { ...out, block: gateText(failures) } : out
  })

  // The main chat's done gate: the same checks, when a turn that edited files ends. Off without .carapace/done-checks.
  on('tool.call', { tool: ['Write', 'Edit', 'NotebookEdit'] }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined && !ran.isError) mainEdited = true

    return ran
  })

  on('classic.Stop', async ($, e, next) => {
    const out = await next(e)
    // Checks run after an edit, or again while the chat was sent back for them.
    if (!mainEdited && mainTries === 0) return out
    mainEdited = false
    const checks = parseChecks(await $.fs.read(`${e.cwd}/${GATE_FILE}`).then(String, () => ''))
    if (checks.length === 0) return out
    const failures: { command: string; output: string }[] = []
    for (const command of checks) {
      const ran = await $.process.run(['sh', '-c', command], { cwd: e.cwd, timeoutMs: 120_000 }).catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
      if (ran.exitCode !== 0) failures.push({ command, output: `${ran.stdout}\n${ran.stderr}` })
    }
    const step = gateStep(mainTries, failures.length > 0)
    mainTries = step.action === 'block' ? step.tries : 0
    $.ui.toast(step.action === 'pass' ? `Done gate: ${checks.length} check${checks.length === 1 ? '' : 's'} passed.` : step.action === 'block' ? `Done gate: checks failed, Claude is fixing them (try ${step.tries} of ${GATE_RETRIES}).` : `Done gate: checks still fail after ${GATE_RETRIES} tries. Over to you.`, { timeoutMs: 6000 })

    return step.action === 'block' ? { ...out, block: gateText(failures) } : out
  }).catch(($, e, next) => next(e)) // a gate bug must never trap the chat

  on('turn.complete', { reason: ['answer', 'aborted', 'refusal', 'error'] }, async ($, e, next) => {
    if (e.agentId !== undefined) {
      // A helper finished: its card settles, the mission ends with its last helper, and the Crew logs how it went.
      const now = await $.clock.now()
      const isStuck = e.reason !== 'answer'
      await learn($, (await read($, missionAtom))?.cards.find(card => card.agentId === e.agentId) ?? null, isStuck, now)
      await changeMission($, m => {
        const cards = m.cards.map(card =>
          card.agentId === e.agentId ? { ...card, status: isStuck ? ('stuck' as const) : ('done' as const), percent: isStuck ? card.percent : 100, endedAt: now } : card,
        )
        const isLive = cards.some(card => card.status === 'working' || card.status === 'queued')

        return { ...m, cards, finishedAt: isLive ? m.finishedAt : (m.finishedAt ?? now) }
      })

      return next(e)
    }
    await settleFromRecord($).catch(err => logError($, 'settle helpers', err))
    const mission = await read($, missionAtom)
    if (mission !== null) {
      const now = await $.clock.now()
      const size = await read($, sizeAtom)
      if (e.reason === 'aborted') {
        await changeMission($, m => ({
          ...m,
          isStopped: true,
          finishedAt: now,
          cards: m.cards.filter(card => card.status !== 'queued').map(card => (card.status === 'working' ? { ...card, status: 'stuck', endedAt: now } : card)),
        }))
      } else if (e.reason === 'answer' && size > 1 && mission.launched < size && !mission.nudged) {
        await changeMission($, m => ({ ...m, nudged: true }))
        await $.prompt.submit({ text: nudgeText(mission.launched, size) })
      } else if (mission.cards.length === 0) {
        await update($, missionAtom, () => null)
        await refresh($)
      } else if (!mission.cards.some(card => card.status === 'working' || card.status === 'queued')) {
        await changeMission($, m => ({ ...m, finishedAt: now }))
      }
    }

    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await update($, isOpenAtom, () => false)
    if (e.origin.kind === 'person') {
      await update($, foldedAtom, () => true)
      await refresh($)
    }

    return closed
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    const Input = 'Input' in els ? els.Input : undefined
    const pal = PALETTES.deep
    title = WORDS.crew
    const cols = Math.max(30, e.props.bodyColumns - 2)
    const isFocused = Boolean(e.props.isFocused)
    const size = await read($, sizeAtom)
    const pending = await read($, pendingAtom)
    const isCustom = await read($, customAtom)
    const model = await read($, modelAtom)
    const limit = await read($, limitAtom)
    const mission = await read($, missionAtom)
    const frame = await read($, frameAtom)
    const now = await $.clock.now()
    const cards = mission?.cards ?? []
    const c = counts(cards)
    const isLive = c.working + c.queued > 0
    const isDone = mission !== null && !isLive && cards.length > 0 && mission.finishedAt !== null

    // Masthead: spaced title, an accent rule, the state on the right. LIVE breathes once a second.
    const word = spaced(WORDS.crew.toUpperCase())
    const stateText = isLive ? `${GLYPH.clean} ${spaced('LIVE')}` : spaced(isDone ? 'COMPLETE' : 'STANDING BY')
    const liveColor = isLive ? (Math.floor(frame / 4) % 2 === 0 ? pal.good : mix(pal.good, pal.hairline, 0.5)) : isDone ? pal.accent : pal.muted
    const titleText = `${GLYPH.dock}  ${word}`
    const masthead = (
      <Box flexDirection="column" width={cols}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text>
            <Text color={pal.highlight}>{`${GLYPH.dock}  `}</Text>
            {titleLit(els, pal, word, isFocused)}
          </Text>
          <Text color={liveColor} bold={isLive}>
            {stateText}
          </Text>
        </Box>
        <Box flexDirection="row">
          <Text color={pal.accent}>{'━'.repeat(Math.min(titleText.length, cols))}</Text>
          <Text color={pal.hairline}>{'─'.repeat(Math.max(0, cols - titleText.length))}</Text>
        </Box>
      </Box>
    )

    // Crew size: one segmented control.
    const isPreset = (SIZES as readonly number[]).includes(size)
    const sizeRow = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Text color={pal.muted}>CREW SIZE</Text>
        {SIZES.map(n => chip(els, pal, `size-${n}`, String(n), n === size ? 'primary' : 'secondary', () => void chooseSize($, n)))}
        {chip(els, pal, 'size-custom', isPreset ? 'Custom' : `Custom ${size}`, isPreset ? 'quiet' : 'primary', () => void update($, customAtom, v => !v))}
      </Box>
    )
    const customBox =
      isCustom && Input ? (
        <Input
          key="custom-size"
          placeholder="How many helpers? (1 to 100)"
          submitLabel="Set"
          autoFocus
          onSubmit={value => {
            const n = parseSize(value)
            if (n === null) $.ui.toast(BAD_SIZE)
            else void chooseSize($, n)
          }}
        />
      ) : null
    const bigTeam =
      pending !== null ? (
        <Box flexDirection="column" borderStyle="round" borderColor={pal.warn} paddingX={1} width={cols}>
          <Text color={pal.warn}>{fit('Big team: this uses your plan quickly. Continue?', cols - 4)}</Text>
          <Box flexDirection="row" columnGap={1}>
            {chip(els, pal, 'big-yes', `Continue with ${pending}`, 'primary', () => void confirmBig($))}
            {chip(els, pal, 'big-no', 'Cancel', 'quiet', () => void update($, pendingAtom, () => null))}
          </Box>
        </Box>
      ) : null
    const helperRow = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Text color={pal.muted}>HELPERS</Text>
        {chip(els, pal, 'model-auto', 'Auto', model === 'auto' ? 'primary' : 'secondary', () => {
          void update($, modelAtom, () => 'auto')
          void $.store.set(STORE_MODEL, 'auto')
        })}
        {chip(els, pal, 'model-fast', 'Fast & Cheap', model === 'fast' ? 'primary' : 'secondary', () => {
          void update($, modelAtom, () => 'fast')
          void $.store.set(STORE_MODEL, 'fast')
        })}
        {chip(els, pal, 'model-same', 'Same as me', model === 'same' ? 'primary' : 'secondary', () => {
          void update($, modelAtom, () => 'same')
          void $.store.set(STORE_MODEL, 'same')
        })}
      </Box>
    )
    // What the Crew learned: at most one suggestion under the info line, never applied without you.
    const tips = await read($, tipsAtom)
    const info = (
      <Box flexDirection="column">
        <Text color={pal.muted}>{fit(infoLine(size, limit, model), cols)}</Text>
        {tips[0] ? <Text color={pal.warn}>{fit(`✦ ${tips[0]}`, cols)}</Text> : null}
      </Box>
    )

    // Idle: the team's seats, still.
    if (mission === null || cards.length === 0) {
      const seats = Math.min(size, 25)

      return (
        <Box flexDirection="column" gap={1} width={cols + 2} backgroundColor={pal.surface} paddingX={1}>
          {masthead}
          {sizeRow}
          {customBox}
          {bigTeam}
          {info}
          {helperRow}
          <Box flexDirection="column">
            <Text>
              {Array.from({ length: seats }, (_, i) => (
                <Text key={`seat-${i}`} color={seatColor(pal, i)}>
                  {'● '}
                </Text>
              ))}
              {size > 25 ? <Text color={pal.muted}>{`+${size - 25}`}</Text> : null}
            </Text>
            <Text color={pal.text}>{fit(`Your crew of ${size} is standing by`, cols)}</Text>
            <Text color={pal.muted}>
              {fit(size === 1 ? 'Send a request and Claude decides how many helpers to use.' : `Send a request and it splits across ${size} helpers.`, cols)}
            </Text>
          </Box>
        </Box>
      )
    }

    // Mission: name, percent and time, then one bar: finished sweeps deep to bright, working shimmers.
    const percent = missionPercent(cards)
    const elapsed = (mission.finishedAt ?? now) - mission.startedAt
    const right = `${percent}%   ${clock(elapsed)}`
    const missionHead = (
      <Box flexDirection="row" justifyContent="space-between" width={cols}>
        <Text color={pal.text} bold>
          {fit(mission.job, Math.max(8, cols - right.length - 2))}
        </Text>
        <Text color={pal.text}>{right}</Text>
      </Box>
    )
    const doneW = Math.round((cols * (c.done + c.stuck)) / c.total)
    const workShare = cards.filter(card => card.status === 'working').reduce((sum, card) => sum + card.percent, 0) / 100
    const workW = Math.min(cols - doneW, Math.max(c.working > 0 ? 1 : 0, Math.round((cols * workShare) / c.total)))
    const restW = Math.max(0, cols - doneW - workW)
    const shimmerAt = Math.floor(frame / 2) % Math.max(1, workW + 3)
    const bar = (
      <Text>
        {Array.from({ length: doneW }, (_, i) => (
          <Text key={`d-${i}`} color={mix(pal.accentDeep, pal.accent, i / Math.max(1, cols - 1))}>
            ━
          </Text>
        ))}
        {Array.from({ length: workW }, (_, i) => (
          <Text key={`k-${i}`} color={Math.abs(i - shimmerAt) <= 1 ? pal.good : mix(pal.good, pal.hairline, 0.45)}>
            ━
          </Text>
        ))}
        <Text color={pal.hairline}>{'━'.repeat(restW)}</Text>
      </Text>
    )
    const parts = [`${GLYPH.clean} ${c.working} working`, `${GLYPH.queued} ${c.queued} queued`, `${GLYPH.done} ${c.done} done`, `${GLYPH.stuck} ${c.stuck} stuck`]
    const gap = parts.join('    ').length <= cols ? '    ' : '  '
    const shown = parts.join(gap).length <= cols ? parts : [`●${c.working}`, `○${c.queued}`, `✓${c.done}`, `✕${c.stuck}`]
    const countsRow = (
      <Text>
        <Text color={pal.good}>{shown[0]}</Text>
        <Text color={pal.muted}>{`${gap}${shown[1]}`}</Text>
        <Text color={pal.accent}>{`${gap}${shown[2]}`}</Text>
        <Text color={c.stuck > 0 ? pal.bad : pal.muted}>{`${gap}${shown[3]}`}</Text>
      </Text>
    )

    // Sonar: helpers move from the rim to the core, beside a roster.
    const isWide = cols >= 84
    const radarW = isWide ? 41 : Math.min(cols % 2 === 0 ? cols - 1 : cols, 33)
    const radarH = isWide ? 17 : 13
    const sweep = isLive ? ((frame * 0.42) % (Math.PI * 2)) : -Math.PI / 2
    const colorOf = (kind: RadarKind): string =>
      kind === 'ring' ? pal.hairline
      : kind === 'trail' ? pal.accentDeep
      : kind === 'sweep' ? pal.accent
      : kind === 'core' ? pal.highlight
      : kind === 'done' ? pal.good
      : kind === 'stuck' ? pal.bad
      : kind === 'queued' ? pal.muted
      : kind === 'working' ? pal.accent
      : pal.text
    const grid = radar(cards, sweep, radarW, radarH)
    const sonar = (
      <Box flexDirection="column">
        {grid.map((row, y) => (
          <Text key={`r-${y}`}>
            {row.map((cell, x) =>
              cell.kind === 'blank' ? (
                ' '
              ) : (
                <Text key={`r-${y}-${x}`} color={colorOf(cell.kind)} bold={cell.kind === 'working' || cell.kind === 'done' || cell.kind === 'stuck'}>
                  {cell.ch}
                </Text>
              ),
            )}
          </Text>
        ))}
      </Box>
    )
    const rosterW = isWide ? cols - radarW - 2 : cols
    const order = { stuck: 0, working: 1, queued: 2, done: 3 } as const
    const listed = [...cards].sort((a, b) => order[a.status] - order[b.status])
    const room = isWide ? radarH - 1 : 6
    // A letter per model beside each helper, warmer for stronger models.
    const badgeOf = (m: string | null | undefined) => { const t = m ? tierOf(m) : null; return t ? BADGE_TIERS[t] : '' }
    const badgeColor = (m: string | null | undefined) => ({ haiku: pal.good, sonnet: pal.accent, opus: pal.highlight, fable: pal.warn })[(m && tierOf(m)) || 'sonnet']

    const gates = await read($, gateAtom)
    const badges = await read($, badgesAtom)
    const lanesData = await read($, filesAtom)
    const clash = clashes(lanesData, cards.filter(card => card.status === 'working' && card.agentId !== null).map(card => card.agentId as string))
    const roster = (
      <Box flexDirection="column" width={rosterW}>
        {listed.slice(0, room).map(card => {
          const tail = card.status === 'done' ? GLYPH.done : card.status === 'stuck' ? `${GLYPH.stuck} stuck` : card.status === 'queued' ? 'queued' : card.hasReported ? `${card.percent}%` : '···'
          const color = colorOf(card.status)

          return (
            <Box key={`roster-${card.id}`} flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between">
              <Text>
                {card.agentId && badges[card.agentId] ? <Text color={pal[badges[card.agentId]?.color ?? 'accent']} bold>{`${badges[card.agentId]?.glyph} `}</Text> : null}
                <Text backgroundColor={seatColor(pal, card.seat)} color={pal.onAccent} bold>
                  {initials(card.task)}
                </Text>
                {badgeOf(card.model) ? <Text color={badgeColor(card.model)} bold>{` ${badgeOf(card.model)}`}</Text> : null}
                {card.category && isCategory(card.category) ? <Text color={pal.muted}>{` ${kindOf(card.category).label}`}</Text> : null}
                <Text color={card.status === 'queued' ? pal.muted : pal.text}>{` ${fit(card.task, Math.max(4, rosterW - 6 - tail.length - 6 - (card.category ? 11 : 0)))}`}</Text>
              </Text>
              <Text color={color}>{`${tail}  ${clock(card.startedAt === null ? 0 : (card.endedAt ?? now) - card.startedAt)}`}</Text>
            </Box>
            {card.agentId && gates[card.agentId] ? (
              <Text color={gates[card.agentId]?.status === 'passed' ? pal.good : gates[card.agentId]?.status === 'failed' ? pal.bad : pal.warn}>{fit(gateLabel(gates[card.agentId]), rosterW)}</Text>
            ) : null}
            </Box>
          )
        })}
        {listed.length > room ? <Text color={pal.muted}>{`+${listed.length - room} more`}</Text> : null}
      </Box>
    )

    // Lanes: one line per helper with the files it touched, newest first. Read is muted, write is accent, done is good, a clash is red.
    const laneCards = listed.filter(card => card.agentId !== null && (lanesData[card.agentId as string]?.length ?? 0) > 0).slice(0, 8)
    const lanes =
      laneCards.length > 0 ? (
        <Box flexDirection="column">
          {heading(els, pal, 'Lanes', cols)}
          {laneCards.map(card => (
            <Text key={`lane-${card.id}`}>
              <Text backgroundColor={seatColor(pal, card.seat)} color={pal.onAccent} bold>{initials(card.task)}</Text>
              {(lanesData[card.agentId as string] ?? []).map(t => (
                <Text key={`lane-${card.id}-${t.path}`} color={clash.has(t.path) ? pal.bad : card.status === 'done' ? pal.good : t.kind === 'write' ? pal.accent : pal.muted}>
                  {` ${clash.has(t.path) ? '⚠' : ''}${base(t.path)}`}
                </Text>
              ))}
            </Text>
          ))}
        </Box>
      ) : null

    // Watch: pick a helper to see its last few actions, open its conversation, or send it a note.
    const watching = await read($, watchingAtom)
    const isNoteOpen = await read($, noteOpenAtom)
    const activity = await read($, activityAtom)
    const watchable = listed.filter(card => card.agentId !== null).slice(0, 8)
    const target = watchable.find(card => card.id === watching) ?? null
    const transcript = await read($, transcriptAtom)
    const watchRow =
      watchable.length > 0 ? (
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Text color={pal.muted}>WATCH</Text>
          {watchable.map(card =>
            chip(els, pal, `watch-${card.id}`, initials(card.task), card.id === watching ? 'primary' : 'secondary', () => {
              void update($, watchingAtom, w => (w === card.id ? null : card.id))
              void update($, noteOpenAtom, () => false)
            }),
          )}
        </Box>
      ) : null
    const targetId = target?.agentId ?? null
    const actions = targetId !== null ? (activity[targetId] ?? []) : []
    const watchCard =
      target !== null && targetId !== null ? (
        <Box flexDirection="column" borderStyle="round" borderColor={pal.accentDeep} paddingX={1} width={cols}>
          <Text>
            <Text backgroundColor={seatColor(pal, target.seat)} color={pal.onAccent} bold>
              {initials(target.task)}
            </Text>
            <Text color={pal.text} bold>{` ${fit(target.task, Math.max(8, cols - 18))}`}</Text>
            <Text color={colorOf(target.status)}>{`  ${target.status}`}</Text>
          </Text>
          {actions.length === 0 ? (
            <Text color={pal.muted}>{fit('No actions yet.', cols - 4)}</Text>
          ) : (
            actions.map((action, i) => (
              <Text key={`act-${i}`} color={i === actions.length - 1 && target.status === 'working' ? pal.text : pal.muted}>
                {fit(`${i === actions.length - 1 ? GLYPH.active : ' '} ${action.line}  ${clock(now - action.at)} ago`, cols - 4)}
              </Text>
            ))
          )}
          <Box flexDirection="row" columnGap={1}>
            {chip(els, pal, 'watch-open', transcript?.agentId === targetId ? 'Close conversation' : 'Open', 'primary', () => {
              if (transcript?.agentId === targetId) void update($, transcriptAtom, () => null)
              else void loadTranscript($, targetId)
            })}
            {target.status === 'working' ? chip(els, pal, 'watch-note', isNoteOpen ? 'Cancel note' : 'Note', 'secondary', () => void update($, noteOpenAtom, v => !v)) : null}
          </Box>
          {transcript !== null && transcript.agentId === targetId ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color={pal.muted}>CONVERSATION</Text>
              {transcript.reason !== null ? (
                <Text color={pal.warn}>{fit(`Could not show it: ${transcript.reason}`, cols - 4)}</Text>
              ) : transcript.lines.length === 0 ? (
                <Text color={pal.muted}>{fit('Nothing yet.', cols - 4)}</Text>
              ) : (
                transcript.lines.map((line, i) => (
                  <Text key={`conv-${i}`} color={line.startsWith('›') ? pal.accent : line.startsWith('▸') ? pal.muted : pal.text}>
                    {fit(line, cols - 4)}
                  </Text>
                ))
              )}
            </Box>
          ) : null}
          {isNoteOpen && target.status === 'working' && Input ? (
            <Input
              key="watch-note-input"
              placeholder="A note for this helper"
              submitLabel="Send"
              autoFocus
              onSubmit={value => {
                const text = value.trim()
                if (text === '') return
                void $.session.send({ to: { agentId: targetId }, text }).then(sent => {
                  $.ui.toast(sent.isDelivered ? 'Note sent. It arrives between the helper\'s steps.' : `Not sent: ${sent.reason}`)
                })
                void update($, noteOpenAtom, () => false)
              }}
            />
          ) : null}
        </Box>
      ) : null

    const done = isDone ? (
      <Box borderStyle="round" borderColor={pal.good} paddingX={1} width={cols}>
        <Text color={pal.good}>{fit((mission.isStopped ? 'Stopped: ' : '') + summary(c, mission.job, elapsed), cols - 4)}</Text>
      </Box>
    ) : null

    return (
      <Box flexDirection="column" gap={1} width={cols + 2} backgroundColor={pal.surface} paddingX={1}>
        {masthead}
        {sizeRow}
        {customBox}
        {bigTeam}
        {info}
        <Box flexDirection="column">
          {heading(els, pal, 'Mission', cols)}
          {missionHead}
          {bar}
          {countsRow}
        </Box>
        {done}
        <Box flexDirection={isWide ? 'row' : 'column'} columnGap={2} rowGap={1}>
          {sonar}
          {roster}
        </Box>
        {lanes}
        {watchRow}
        {watchCard}
        {helperRow}
      </Box>
    )
  })
}
