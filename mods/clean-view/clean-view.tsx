import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderElement, Timer } from 'claude-code'

import type { CleanViewChecklist, CleanViewTask } from '../../types'

import { GLYPH, PALETTES, breathe, cells, fit, padCells, WORDS } from '../shared/look'
import { bubbles, pingGlyph } from '../footer/footer-logic'
import {
  EASE_MS,
  WIPE_MS,
  depthLabel,
  depthLabelWidth,
  mergeRuns,
  diveConnector,
  easedValue,
  narrowConnector,
  refillTime,
  riseDots,
  riseLevel,
  riseStep,
  tide,
  tideLevel,
  wipeName,
} from './bar-art'
import { ACCOUNT_KIND_KEY, ACCOUNT_UNKNOWN, subscriberOnly, describeBudget, knownKind, headerView, overText, parseBudget, spentIn } from '../shared/budget-logic'
import type { Budget } from '../shared/budget-logic'
import { dayKey, tasksOn } from '../work-report/report-logic'
import type { Palette } from '../shared/look'
import type { Els } from '../shared/ui'
import { osaNotifyArgv, riskyReason } from './clean-logic'
import { applyPlan, applyProgress, cleanName, fromTodos, hasPlan, newJob, realTasks, replayTasks, sameTasks, startNext, withTaskUpdate } from './checklist-logic'
import type { TranscriptRow } from './checklist-logic'
import { detect, push as pushLoop } from './loop-logic'
import type { Loop, LoopEvent } from './loop-logic'

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
    const line = errorLine(await $.clock.now(), 'clean-view', what, err, version)
    $.ui.log(line, { to: 'debug' })
    if (home !== '') await $.fs.write(logPath(home), appendLine(await $.fs.read(logPath(home)).then(String, () => ''), line))
    const count = Number((await $.store.get(COUNT_KEY)) ?? 0) + 1
    await $.store.set(COUNT_KEY, count)
    await update($, errorsAtom, () => count)
    if (!(await $.store.get(HINT_KEY))) {
      await $.store.set(HINT_KEY, true)
      $.ui.toast(hintText('clean-view'), { timeoutMs: 8000 })
    }
  })
}

const PLAN_TOOL = 'mcp__carapace__plan_steps'
const PROGRESS_TOOL = 'mcp__carapace__report_progress'
const ALWAYS_ALLOWED = new Set([
  'ToolSearch',
  'Read',
  'Glob',
  'Grep',
  'LS',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'AskUserQuestion',
  PLAN_TOOL,
  PROGRESS_TOOL,
])
const METER = 10
const LABEL_WIDTH = 8
const STORE_KEY = 'cleanViewEnabled'
const BUBBLES_KEY = 'cleanViewBubbles'
// One frame a second while a job works; four a second only during the two-second surfacing.
const FRAME_MS = 1000
const SURFACE_FRAME_MS = 250
const SURFACE_MS = 2000
const SURFACE_AFTER_MS = 60_000
const CRUSH = 85
const COLLAPSE_MS = 5000
// When a turn ends, the ◇ ripples out once over a second, at the surfacing frame rate.
const PING_MS = 1000
const BUBBLES = 8
const NOTIFY_KEY = 'cleanViewNotify'
// Tool rows while Clean View is off: a sea mark and the time of a finished call, a cross for an error.
const CONTACT = '◎'
const ERRORED = '✕'
const HULL = '✕ hull breach'
const COMPACT_LABEL = ' compact now '
// ponytail: the map keeps the last 200 calls; an older row shows no time.
const TOOL_MEMORY = 200

const NEEDS_OK = 'Claude needs your OK to continue'
const HAS_QUESTION = 'Claude has a question for you'
const WAITING_REPLY = 'Claude is waiting for your reply'
const SAID_NO = 'you said no to a step, so Claude paused'
const KEEPS_FAILING = 'a step keeps failing, Claude is trying another way'
const REFUSED = "Claude couldn't help with that request"
const USER_SAID_NO = /doesn't want to proceed|user (?:rejected|declined|denied)/i

const GATE_MESSAGE =
  `Clean View: lay out the plan first. Call ${PLAN_TOOL} with every step of this job ` +
  '(load it with ToolSearch if it is deferred), or write a to-do list with TodoWrite or TaskCreate. ' +
  'Then carry on.'

const PLAN_RULES = [
  'Clean View is on: the person sees a checklist of your steps instead of tool calls.',
  `- Before an edit, a write, a command or an agent, call ${PLAN_TOOL} with every step of the job, in order (2 to 8 steps). If it is deferred, load it with ToolSearch first. Reading tools (Read, Glob, Grep, WebFetch, WebSearch) work before a plan; the others are refused until one exists.`,
  '- If you can answer in one short reply with no tools at all, answer directly: no plan is needed.',
  `- Then call ${PROGRESS_TOOL} as real progress happens, and with percent 100 the moment a step finishes.`,
  '- If you have TodoWrite or TaskCreate, your to-do list can serve as the plan instead.',
  '- Write every step name in plain English a non-technical person understands. Keep it under 40 characters and start it with a verb, like "Build the pricing section".',
  '- Never put file paths, file names, commands, code or tool names in a step name.',
].join('\n')

const NAMER =
  'Name the request in 2 to 6 plain words that start with a verb, like "Build my landing page". ' +
  'No quotes, no punctuation, no file names. Reply with the name only.'

const enabledAtom = atom({ plugin: 'carapace', key: 'cleanViewEnabled' } as const, true)
const checklistAtom = atom({ plugin: 'carapace', key: 'checklist' } as const, null)
const tickAtom = atom({ plugin: 'carapace', key: 'tick' } as const, 0)
const contextAtom = atom({ plugin: 'carapace', key: 'cleanViewContext' } as const, 0)
const surfacingAtom = atom({ plugin: 'carapace', key: 'cleanViewSurfacing' } as const, null)
const missionAtom = atom({ plugin: 'carapace', key: 'agentDockMission' } as const, null)
const accountAtom = atom({ plugin: 'carapace', key: 'budgetAccount' } as const, { kind: 'unknown', gateway: null })
const budgetAtom = atom({ plugin: 'carapace', key: 'budgetConfig' } as const, null)
const ledgerAtom = atom({ plugin: 'carapace', key: 'budgetLedger' } as const, { days: {}, sess: {} })
const sessionIdAtom = atom({ plugin: 'carapace', key: 'budgetSessionId' } as const, '')
const oxygenAtom = atom({ plugin: 'carapace', key: 'cleanViewOxygen' } as const, null)
const resetsAtom = atom({ plugin: 'carapace', key: 'cleanViewOxygenResets' } as const, null)
const easeAtom = atom({ plugin: 'carapace', key: 'cleanViewContextEase' } as const, null)
const pingAtom = atom({ plugin: 'carapace', key: 'cleanViewPing' } as const, null)
const bubblesOnAtom = atom({ plugin: 'carapace', key: 'cleanViewBubbles' } as const, true)
const notifyOnAtom = atom({ plugin: 'carapace', key: 'cleanViewNotify' } as const, true)
// The last prompt a person sent, written by the Crew's prompt hook: only a turn carrying it starts a new job.
const personPromptAtom = atom({ plugin: 'carapace', key: 'personPrompt' } as const, null)
// Whether a main turn is running. Kept in state so a hot reload mid-turn restores it.
const turnRunningAtom = atom({ plugin: 'carapace', key: 'cleanViewTurnRunning' } as const, false)
// No one sees the checklist in a headless run (claude -p, CI, evals), so the plan rules and gate only cost tokens there.
const watchedAtom = atom({ plugin: 'carapace', key: 'cleanViewWatched' } as const, true)
// A loop the detector found in this turn, shown as the bar's stuck row. Cleared by a different result or the turn's end.
const loopAtom = atom({ plugin: 'carapace', key: 'loopStuck' } as const, null)
// Work Report's days, read only, for "done today".
const daysAtom = atom({ plugin: 'carapace', key: 'workReportDays' } as const, {})

// Module variables start over on a hot reload; everything a drawing reads lives in $.state.
const WATCHDOG_MS = 5000
let animation: Timer | undefined
let settle: Timer | undefined
let watchdog: Timer | undefined
let animationMs = 0
let lastTickAt = 0
let syncGen = 0
let collapse: Timer | undefined
// A mirror of turnRunningAtom, restored at session.start (which runs again on every hot reload).
let isTurnRunning = false
let failures = 0
// The running main turn's id (for Stop) and its calls so far (for the loop detector). Helpers get no row, so only the main session is watched.
let heldTurn: string | null = null
let loopHistory: LoopEvent[] = []
let errorReason: string | null = null

// When each tool call started and ended, by tool use id. The tool rows read it while Clean View is off.
const toolTimes = new Map<string, { start: number; end: number | null }>()

function remember(id: string, start: number): void {
  toolTimes.set(id, { start, end: null })
  if (toolTimes.size > TOOL_MEMORY) {
    const oldest = toolTimes.keys().next().value
    if (oldest !== undefined) toolTimes.delete(oldest)
  }
}

/** A long job's line becomes a notification: the engine's channel first, then osascript on a Mac if that sends nothing. */
async function notifyJob($: Engine, line: string): Promise<void> {
  if (!(await read($, notifyOnAtom))) return
  try {
    const sent = await $.ui.notify(line, { title: 'carapace' })
    // macOS fallback; anywhere else osascript is missing and the call fails quietly below.
    if (!sent.isSent) await $.process.run(osaNotifyArgv(line), { cwd: '/', timeoutMs: 10000 })
  } catch {
    // A failed notification never breaks the turn.
  }
}

/** The compact button: asks the engine to compact between turns. The engine refuses while a turn runs. */
function compactNow($: Engine): void {
  if (isTurnRunning) return
  // The mod's own call skips its session.compact hook, so the gauge empties here.
  $.session.compact().then(result => (result.messages ? readContext($, true) : undefined)).catch(err => logError($, 'compact', err))
}

/** How long a call took: tenths of a second under a second, the bar's usual form above. */
function tookText(ms: number): string {
  return ms < 1000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : formatDuration(ms)
}

/** A folded group row while Clean View is off: the same marks, for the whole run of calls. Claude Code folds most calls into these. */
async function paintGroup($: Engine, els: Els, calls: readonly { tool: string; input: unknown; isRunning: boolean; isErrored: boolean; tool_use_id?: string }[], row: RenderElement): Promise<RenderElement> {
  const { Box, Text } = els
  const pal: Palette = PALETTES.deep
  const commandOf = (c: (typeof calls)[number]) => (c.tool === 'Bash' ? (c.input as { command?: unknown } | null)?.command : undefined)
  const marks: RenderElement[] = []
  if (calls.some(c => riskyReason(commandOf(c)) !== null)) marks.push(<Text key="hull" color={pal.bad} bold>{HULL + ' '}</Text>)
  if (calls.some(c => c.isErrored)) marks.push(<Text key="errored" color={pal.bad}>{ERRORED + ' '}</Text>)
  else if (calls.length > 0 && calls.every(c => !c.isRunning)) {
    const spans = calls.map(c => (c.tool_use_id ? toolTimes.get(c.tool_use_id) : undefined)).filter(t => t !== undefined && t.end !== null)
    if (spans.length > 0) {
      const took = spans.reduce((sum, t) => sum + ((t?.end ?? 0) - (t?.start ?? 0)), 0)
      marks.push(<Text key="took" color={pal.accent}>{CONTACT + ' ' + tookText(took) + ' '}</Text>)
    }
  }
  if (marks.length === 0) return row

  // Claude Code's row takes the full width, so the marks sit under it as a result line.
  return (
    <Box flexDirection="column">
      {row}
      <Text>
        <Text color={pal.muted}>{'  ⎿  '}</Text>
        {marks}
      </Text>
    </Box>
  )
}

/** A tool row while Clean View is off: a sea mark and the time of a finished call, a cross for an error, a warning before a risky command. */
async function paintContact($: Engine, els: Els, props: unknown, row: RenderElement): Promise<RenderElement> {
  const { Box, Text } = els
  const p = props as { tool: string; input: unknown; isRunning: boolean; isErrored: boolean; tool_use_id: string }
  const pal: Palette = PALETTES.deep
  const command = p.tool === 'Bash' ? (p.input as { command?: unknown } | null)?.command : undefined
  const timing = toolTimes.get(p.tool_use_id)
  const marks: RenderElement[] = []
  if (riskyReason(command) !== null) marks.push(<Text key="hull" color={pal.bad} bold>{HULL + ' '}</Text>)
  if (p.isErrored) marks.push(<Text key="errored" color={pal.bad}>{ERRORED + ' '}</Text>)
  else if (!p.isRunning && timing && timing.end !== null) {
    marks.push(<Text key="took" color={pal.accent}>{CONTACT + ' ' + tookText(timing.end - timing.start) + ' '}</Text>)
  }
  if (marks.length === 0) return row

  // Claude Code's row takes the full width, so the marks sit under it as a result line.
  return (
    <Box flexDirection="column">
      {row}
      <Text>
        <Text color={pal.muted}>{'  ⎿  '}</Text>
        {marks}
      </Text>
    </Box>
  )
}


function shortTitle(raw: unknown): string {
  const words = String(raw ?? '').replace(/["'.!?]/g, ' ').split(/\s+/).filter(Boolean)

  return cleanName(words.slice(0, 6).join(' '))
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}


function reasonForError(kind: string, details: string): string {
  const text = `${kind} ${details}`
  if (/rate_limit|billing|usage limit|rate limit|\b429\b/i.test(text)) return 'you hit your usage limit, try again a little later'
  if (/overloaded|server_error|\b5\d\d\b/i.test(text)) return "Claude's servers are busy, try again in a minute"
  if (/prompt is too long|context|too many tokens/i.test(text)) return 'type /compact and try again'
  if (/authentication|oauth|account_on_hold|verification|credential|\b40[13]\b|log ?in|api key/i.test(text)) return 'type /login'
  if (/ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|connection|socket|fetch failed|offline/i.test(text)) return 'the internet connection dropped'

  return 'something went wrong, try again'
}

/**
 * Rebuilds the job's steps from the main conversation's record and corrects the live ones when they differ: a missed
 * event, a hot reload or a forked helper's calls (which arrive with no agentId) can leave the live steps wrong.
 */
async function setLoop($: Engine, next: Loop | null): Promise<void> {
  await update($, loopAtom, old => (next === null ? null : { ...next, isDismissed: old !== null && old.kind === next.kind && old.line === next.line && old.isDismissed }))
}

async function watchLoop($: Engine, e: unknown, ran: { isError?: boolean; text?: string; result?: unknown }): Promise<void> {
  const input = e as { tool: string; command?: string; file_path?: string; new_string?: string; content?: string }
  const out = ran.result as { stdout?: string; stderr?: string } | undefined
  const text = ran.text ?? [out?.stderr, out?.stdout].filter(Boolean).join('\n')
  const event: LoopEvent = { tool: input.tool, isError: ran.isError === true, text }
  if (input.tool === 'Bash' && typeof input.command === 'string') event.command = input.command
  if ((input.tool === 'Edit' || input.tool === 'Write') && typeof input.file_path === 'string') {
    event.file = input.file_path
    event.after = input.new_string ?? input.content ?? ''
  }
  loopHistory = pushLoop(loopHistory, event)
  await setLoop($, detect(loopHistory))
}

async function reconcile($: Engine): Promise<void> {
  const list = await read($, checklistAtom)
  if (list === null || !list.prompt) return
  let messages: readonly TranscriptRow[]
  try {
    messages = (await $.session.messages()) as unknown as readonly TranscriptRow[]
  } catch (err) {
    logError($, 'read the conversation to settle steps', err)
    return
  }
  const tasks = replayTasks(list, messages, await $.clock.now())
  if (tasks === null || sameTasks(tasks, list.tasks)) return
  await update($, checklistAtom, current => (current && current.startedAt === list.startedAt ? { ...current, tasks } : current))
}

async function syncAnimation($: Engine): Promise<void> {
  // A later call supersedes this one: a stale call must not cancel the timer the newer decision made.
  const gen = ++syncGen
  const list = await read($, checklistAtom)
  const surfacing = await read($, surfacingAtom)
  const ping = await read($, pingAtom)
  const ease = await read($, easeAtom)
  const now = await $.clock.now()
  // The short animations (the rise, the ping ring, the ease, the step wipes) run at the quick frame until they all end.
  const wipeEnds = (list?.tasks ?? []).filter(task => task.addedAt !== undefined).map(task => (task.addedAt ?? 0) + WIPE_MS)
  const busyUntil = Math.max(surfacing?.until ?? 0, ping ?? 0, ease ? ease.at + EASE_MS : 0, ...wipeEnds)
  if (gen !== syncGen) return
  const isBusy = now < busyUntil
  const isLive = list !== null && (list.phase === 'working' || (list.phase === 'needsYou' && isTurnRunning))
  const wanted = isBusy ? SURFACE_FRAME_MS : isLive ? FRAME_MS : 0
  // One timer wakes the bar when the last short animation ends, so the quick frame stops on time.
  settle?.cancel()
  settle = isBusy ? $.clock.after(busyUntil - now, () => void syncAnimation($)) : undefined
  // While the animation is live, a slow timer re-runs this sync so an ended interval restarts without waiting for an event.
  // It is cancelled before it is re-armed, so only one runs; it draws nothing.
  watchdog?.cancel()
  watchdog = wanted > 0 ? $.clock.after(WATCHDOG_MS, () => void syncAnimation($)) : undefined
  // An interval the engine ended (a refused period) stops ticking: restart it when a tick is overdue.
  if (wanted === animationMs && (wanted === 0 || now - lastTickAt <= 3 * wanted)) return
  animation?.cancel()
  animation = undefined
  animationMs = wanted
  lastTickAt = now
  if (wanted > 0) {
    animation = $.clock.every(wanted, async () => {
      lastTickAt = await $.clock.now()
      await update($, tickAtom, frame => (frame ?? 0) + 1)
    })
  }
}

/** How full the context is, for the tide line and the gauge. A failed read leaves the last value. */
/** Reads the gauge and oxygen. Right after a compaction the engine has no fill until the next response, so the gauge empties. */
async function readContext($: Engine, isCompacted = false): Promise<void> {
  try {
    const usage = await $.session.usage()
    const now = await $.clock.now()
    const before = await read($, contextAtom)
    const percent = isCompacted ? 0 : Math.round(usage.context.percent ?? 0)
    await update($, contextAtom, () => percent)
    // A change from a known value eases the gauge over a second. The first reading of a session appears at once.
    // It starts from the value on screen, so a second reading mid-ease does not snap back.
    const old = await read($, easeAtom)
    const shown = old ? easedValue(old.from, before, now - old.at) : before
    if (before > 0 && percent !== before) await update($, easeAtom, () => ({ from: shown, at: now }))
    // Oxygen: what is left of the five-hour plan window, and when it refills. Absent off a subscription.
    const plan = usage.rateLimits.find(r => r.kind === 'five_hour')
    const resetsAt = (plan as { resetsAt?: unknown } | undefined)?.resetsAt
    await update($, oxygenAtom, () => (plan ? Math.max(0, Math.round(100 - plan.percentUsed)) : null))
    await update($, resetsAtom, () => (typeof resetsAt === 'string' ? resetsAt : null))
  } catch (err) {
    logError($, 'read context and usage', err)
    // The tide keeps its last level.
  }
  await syncAnimation($)
}

async function change($: Engine, fn: (list: CleanViewChecklist) => CleanViewChecklist): Promise<void> {
  await update($, checklistAtom, list => (list ? fn(list) : list))
  await syncAnimation($)
}

function needsYou($: Engine, reason: string): Promise<void> {
  return change($, list =>
    list.phase === 'working' || list.phase === 'stuck' || list.phase === 'needsYou'
      ? { ...list, phase: 'needsYou', needsYouReason: reason }
      : list,
  )
}

function backToWork(list: CleanViewChecklist): CleanViewChecklist {
  return list.phase === 'needsYou' && isTurnRunning ? { ...list, phase: 'working', needsYouReason: null } : list
}

async function setEnabled($: Engine, isOn: boolean): Promise<void> {
  await update($, enabledAtom, () => isOn)
  await $.store.set(STORE_KEY, isOn)
  $.ui.toast(isOn ? 'Clean View on: technical details hidden' : 'Clean View off: showing everything', { timeoutMs: 2500 })
}

function nameJob($: Engine, request: string, startedAt: number): void {
  $.clock.after(0, () => {
    void (async () => {
      const ask = (isLowEffort: boolean) =>
        $.model.complete({
          model: 'haiku',
          ...(isLowEffort ? { effort: 'low' as const } : {}),
          maxTokens: 24,
          timeoutMs: 15000,
          system: NAMER,
          prompt: request.slice(0, 2000),
        })
      let named = await ask(true)
      // ponytail: some Haiku builds refuse an effort setting; one retry without it covers that.
      if (!named.isAnswered && named.reason === 'api-error' && named.status === 400) named = await ask(false)
      if (!named.isAnswered) return
      const title = shortTitle(named.text)
      await update($, checklistAtom, list => (list && list.startedAt === startedAt ? { ...list, title } : list))
    })().catch(err => logError($, 'name the job', err))
  })
}

export function registerCleanView(on: On): void {
  // The hook below runs for interactive sessions only; this one marks a headless run.
  on('session.start', { isInteractive: false }, async ($, e, next) => {
    await update($, watchedAtom, () => false)
    return next(e)
  })
  on('session.start', async ($, e, next) => {
    await update($, watchedAtom, () => e.isInteractive !== false)
    isTurnRunning = await read($, turnRunningAtom)
    const saved = await $.store.get(STORE_KEY)
    if (typeof saved === 'boolean') await update($, enabledAtom, () => saved)
    const bubblesSaved = await $.store.get(BUBBLES_KEY)
    if (typeof bubblesSaved === 'boolean') await update($, bubblesOnAtom, () => bubblesSaved)
    const notifySaved = await $.store.get(NOTIFY_KEY)
    if (typeof notifySaved === 'boolean') await update($, notifyOnAtom, () => notifySaved)
    // Headless: no checklist to feed, and an offered tool still gets called.
    if (e.isInteractive !== false) {
      await $.tool.register({
        name: 'plan_steps',
        description:
          'Lay out every step of the current job, in order, before doing anything else: 2 to 8 short plain-English names, ' +
          'each under 40 characters and starting with a verb, with no file names, paths, commands or code. The first step starts right away.',
        inputSchema: {
          type: 'object',
          properties: { steps: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 } },
          required: ['steps'],
        },
        isDeferred: false,
      })
      await $.tool.register({
        name: 'report_progress',
        description:
          'Report progress on the current step of the plan: its name and a percent from 0 to 100. ' +
          'Send 100 the moment a step finishes; the next step then starts on its own.',
        inputSchema: {
          type: 'object',
          properties: { task: { type: 'string' }, percent: { type: 'number', minimum: 0, maximum: 100 } },
          required: ['task', 'percent'],
        },
        isDeferred: false,
      })
    }
    await $.command.register({ name: 'clean', description: 'Turn Clean View on or off, its bubbles, or job notifications', argumentHint: 'on|off | bubbles on|off | notify on|off' })
    await $.command.register({ name: 'budget', description: 'API credits: set, see or clear a spending budget', argumentHint: '$20 day | 5M tokens week | off' })
    await readContext($)
    // session.start runs again on every hot reload: line the steps up with the record.
    await reconcile($).catch(err => logError($, 'settle steps', err))
    await syncAnimation($)

    return next(e)
  })

  // /compact or the engine's own compaction: the gauge would keep its old depth until the next turn.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.trigger !== 'precompute' && result.messages) await readContext($, true)

    return result
  })

  on('command.run', { command: 'budget' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const account = await read($, accountAtom)
    const kind = knownKind(account, await $.store.get(ACCOUNT_KIND_KEY))
    if (kind === 'subscriber') return { text: subscriberOnly(WORDS.limit) }
    const parsed = parseBudget(arg)
    // Before the first reply nobody knows the account; a subscriber's budget would be stored and never fit.
    if (kind === 'unknown' && parsed.kind === 'set') return { text: ACCOUNT_UNKNOWN }
    if (parsed.kind === 'error') return { text: 'Use /budget $20 day, /budget 5M tokens week, /budget off, or /budget.' }
    if (parsed.kind === 'off' || parsed.kind === 'set') {
      const budget: Budget | null = parsed.kind === 'set' ? parsed.budget : null
      await update($, budgetAtom, () => budget)
      await $.store.set('budgetConfig', budget)
      const note = account.gateway ? ' Your company limit applies.' : ''

      return { text: (budget ? `Budget set: ${describeBudget(budget)}. Warnings only; nothing is blocked.` : 'Budget off.') + note }
    }
    if (account.gateway) return { text: `Your company's spend limit applies: ${Math.round(account.gateway.percentUsed)}% used.` }
    const budget = (await read($, budgetAtom)) as Budget | null
    if (!budget) return { text: 'No budget set. Try /budget $20 day.' }
    const now = await $.clock.now()
    const view = headerView(account, budget, await read($, ledgerAtom), await read($, sessionIdAtom), now, WORDS.limit)
    const spent = spentIn(await read($, ledgerAtom), budget, await read($, sessionIdAtom), now)

    return { text: `Budget: ${describeBudget(budget)}. ${view?.text ?? ''}${view?.level === 'red' ? ` ${overText(budget, spent)}` : ''}`.trim() }
  })

  on('command.run', { command: 'clean' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const [word, value] = arg.split(/\s+/)
    if (word === 'notify') {
      const isNotifying = value === 'on' ? true : value === 'off' ? false : value === undefined ? !(await read($, notifyOnAtom)) : undefined
      if (isNotifying === undefined) return { text: 'Use /clean notify on, /clean notify off, or /clean notify to switch.' }
      await update($, notifyOnAtom, () => isNotifying)
      await $.store.set(NOTIFY_KEY, isNotifying)

      return { text: isNotifying ? 'Notifications on: a long job that ends sends a notification.' : 'Notifications off: long jobs end quietly.' }
    }
    if (word === 'bubbles') {
      const isBubbling = value === 'on' ? true : value === 'off' ? false : value === undefined ? !(await read($, bubblesOnAtom)) : undefined
      if (isBubbling === undefined) return { text: 'Use /clean bubbles on, /clean bubbles off, or /clean bubbles to switch.' }
      await update($, bubblesOnAtom, () => isBubbling)
      await $.store.set(BUBBLES_KEY, isBubbling)

      const words = WORDS

      return { text: isBubbling ? `${words.bubbles} on: they ${words.rise} beside the gauge while a job works.` : `${words.bubbles} off: the bar stays still.` }
    }
    const isOn = arg === 'on' ? true : arg === 'off' ? false : arg === '' ? !(await read($, enabledAtom)) : undefined
    if (isOn === undefined) return { text: 'Use /clean on, /clean off, or /clean to switch.' }
    await setEnabled($, isOn)

    return { text: isOn ? 'Clean View is on.' : 'Clean View is off.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const isOffered = e.tools.includes(PLAN_TOOL) || e.tools.includes('ToolSearch')
    if (!isOffered || !(await read($, watchedAtom)) || !(await read($, enabledAtom))) return composed

    return { sections: [...composed.sections, { id: 'carapace:clean-view-plan', text: PLAN_RULES, scope: 'session' as const }] }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    heldTurn = e.turnId
    loopHistory = []
    await setLoop($, null)
    const text = e.text.trim()
    const now = await $.clock.now()
    const list = await read($, checklistAtom)
    isTurnRunning = true
    await update($, turnRunningAtom, () => true)
    failures = 0
    errorReason = null
    collapse?.cancel()
    collapse = undefined
    const isReply = list !== null && list.phase === 'needsYou' && list.needsYouReason === WAITING_REPLY
    const isPersonPrompt = (await read($, personPromptAtom))?.text === text
    if (text !== '' && !text.startsWith('/') && !isReply && isPersonPrompt) {
      await update($, checklistAtom, () => ({ ...newJob(shortTitle(text), now), prompt: text }))
      nameJob($, text, now)
    } else if (list !== null) {
      // A turn the person did not send (a helper's result, the Crew's nudge) carries the job on, even a finished one.
      await update($, checklistAtom, (): CleanViewChecklist => ({
        ...list,
        ...(list.phase === 'done' ? { resumedAt: now } : {}),
        phase: 'working',
        needsYouReason: null,
        stuckReason: null,
        finishedAt: null,
        isCollapsed: false,
      }))
    }
    await update($, surfacingAtom, () => null)
    await readContext($)
    await syncAnimation($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    await reconcile($).catch(err => logError($, 'settle steps', err))
    loopHistory = []
    await setLoop($, null)
    isTurnRunning = false
    await update($, turnRunningAtom, () => false)
    const now = await $.clock.now()
    let isDone = false
    await change($, list => {
      if (e.reason === 'error') return { ...list, phase: 'stuck', stuckReason: errorReason ?? reasonForError('', e.answer) }
      if (e.reason === 'refusal') return { ...list, phase: 'stuck', stuckReason: REFUSED }
      if (e.reason === 'aborted') return { ...list, phase: 'stopped', finishedAt: now }
      if (list.phase === 'stuck') return list
      // Open steps wait for the person only when Claude ended on a question; otherwise the job is finished.
      const isQuestion = e.reason === 'answer' && e.answer.trim().endsWith('?')
      if (isQuestion && hasPlan(list) && list.tasks.some(task => task.status !== 'done')) {
        return { ...list, phase: 'needsYou', needsYouReason: WAITING_REPLY }
      }
      isDone = true
      // Planned steps Claude never reported stay open, so the header can say how far the job got.
      // A job with no plan (only the starter steps) was a plain answer: it is all done.
      const tasks = hasPlan(list) ? list.tasks : list.tasks.map((task): CleanViewTask => ({ ...task, status: 'done', percent: 100 }))

      return { ...list, tasks, phase: 'done', needsYouReason: null, stuckReason: null, finishedAt: now, isCollapsed: false }
    })
    await readContext($)
    if (e.reason === 'answer') {
      await update($, pingAtom, () => now + PING_MS)
    }
    const done = isDone ? await read($, checklistAtom) : null
    if (done !== null && (done.finishedAt ?? now) - (done.resumedAt ?? done.startedAt) >= SURFACE_AFTER_MS) {
      // A long job ends by surfacing: a two-second rise, then the summary line.
      const helpers = (await read($, missionAtom))?.cards.length ?? 0
      const took = formatDuration((done.finishedAt ?? now) - (done.resumedAt ?? done.startedAt))
      const line = `Surfaced · ${helpers > 0 ? `${helpers} helpers · ` : ''}${done.title} · ${took}`
      await update($, surfacingAtom, () => ({ until: now + SURFACE_MS, line }))
      void notifyJob($, line).catch(() => undefined)
    }
    await syncAnimation($)
    if (isDone) {
      collapse = $.clock.after(COLLAPSE_MS, () => {
        void update($, checklistAtom, list => (list && list.phase === 'done' ? { ...list, isCollapsed: true } : list))
      })
    }

    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    errorReason = reasonForError(e.error, e.error_details ?? '')
    const reason = errorReason
    await change($, list => (list.phase === 'stuck' && !isTurnRunning ? { ...list, stuckReason: reason } : list))

    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    if (e.notification_type === 'permission_prompt') await needsYou($, NEEDS_OK)

    return next(e)
  })

  // The plan gate and the checklist feed, for the main conversation only.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const isOn = await read($, enabledAtom)
    if (isOn && (await read($, watchedAtom)) && !ALWAYS_ALLOWED.has(e.tool) && !hasPlan(await read($, checklistAtom))) {
      return { deny: GATE_MESSAGE }
    }
    await change($, backToWork)
    if (e.tool === 'AskUserQuestion') await needsYou($, HAS_QUESTION)
    remember(e.tool_use_id, await $.clock.now())

    const ran = await next(e)
    const timing = toolTimes.get(e.tool_use_id)
    if (timing) timing.end = await $.clock.now()

    await change($, backToWork)
    if (ran.deny !== undefined) return ran
    await watchLoop($, e, ran)
    if (ran.isError) {
      failures += 1
      const reason = USER_SAID_NO.test(ran.text ?? '') ? SAID_NO : failures >= 3 ? KEEPS_FAILING : null
      if (reason !== null) await change($, list => ({ ...list, phase: 'stuck', stuckReason: reason, needsYouReason: null }))

      return ran
    }
    failures = 0
    await change($, list => (list.phase === 'stuck' && isTurnRunning ? { ...list, phase: 'working', stuckReason: null } : list))
    await readContext($)
    const now = await $.clock.now()
    if (e.tool === 'TodoWrite') {
      const todos = e.todos
      await update($, checklistAtom, list => fromTodos(list ?? newJob('Working on it', now), todos, now))
      await syncAnimation($)
    }
    if (e.tool === 'TaskCreate') {
      const created = ran.result as { task?: { id?: unknown } } | undefined
      const id = created?.task?.id
      const name = cleanName(e.subject)
      if (typeof id === 'string') {
        const task: CleanViewTask = { id: `task-${id}`, name, status: 'upcoming', percent: 0, hasReported: false, addedAt: now }
        await update($, checklistAtom, list => {
          const job = list ?? newJob('Working on it', now)

          return { ...job, tasks: startNext([...realTasks(job), task]) }
        })
        await syncAnimation($)
      }
    }
    if (e.tool === 'TaskUpdate') {
      const taskUpdate = { taskId: e.taskId, subject: e.subject, status: e.status }
      await change($, list => withTaskUpdate(list, taskUpdate))
    }

    return ran
  })

  on('tool.call', { tool: 'mcp__carapace__plan_steps' }, async ($, e) => {
    if (e.agentId !== undefined) return { result: 'Only the main conversation keeps the Clean View plan. Carry on.' }
    const raw = (e as unknown as { steps?: unknown }).steps
    const steps = Array.isArray(raw)
      ? raw.filter((step): step is string => typeof step === 'string' && step.trim() !== '').slice(0, 8)
      : []
    if (steps.length === 0) return { deny: 'Send steps: a list of 2 to 8 short step names.' }
    const now = await $.clock.now()
    await update($, checklistAtom, list => applyPlan(list ?? newJob('Working on it', now), steps, now))
    await syncAnimation($)

    return { result: `Planned ${steps.length} steps. The first one has started.` }
  })

  on('tool.call', { tool: 'mcp__carapace__report_progress' }, async ($, e) => {
    if (e.agentId !== undefined) return { result: 'Only the main conversation keeps the Clean View plan. Carry on.' }
    const input = e as unknown as { task?: unknown; percent?: unknown }
    const percent = Math.min(100, Math.max(0, Math.round(Number(input.percent) || 0)))
    const now = await $.clock.now()
    await update($, checklistAtom, list => applyProgress(list ?? newJob('Working on it', now), String(input.task ?? ''), percent, now))
    await syncAnimation($)

    return { result: `Progress noted: ${percent}%.` }
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) return paintContact($, $.ui.resolve(e), e.props, await next(e))
    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) return next(e)
    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) return paintGroup($, $.ui.resolve(e), e.props.calls, await next(e))
    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) return next(e)

    return next({ ...e, props: { ...e.props, hint: '' } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const pal: Palette = PALETTES.deep
    const isOn = await read($, enabledAtom)
    const list = isOn ? await read($, checklistAtom) : null
    await read($, tickAtom)
    const context = await read($, contextAtom)
    const surfacing = isOn ? await read($, surfacingAtom) : null
    const now = await $.clock.now()
    // The slow motions (breathing, tide, bubbles, sweep) step once a second, whatever the quick frame rate.
    const frame = Math.floor(now / 1000)
    // The deck's hook sits beneath this one: the bar's buttons, then what other mods draw above the prompt.
    const buttons = await next(e)
    // Never wider than the band: a wider tree spills past its edge and the terminal wraps it.
    const outer = Math.max(4, e.props.bodyColumns)
    const columns = outer - 2
    const isSurfacing = surfacing !== null && now < surfacing.until
    const riseFrame = isSurfacing ? riseStep(SURFACE_MS - (surfacing.until - now)) : 0

    // The gauge, its number and the tide ease from the old context to the new one over a second.
    const ease = isOn ? await read($, easeAtom) : null
    const shown = Math.round(ease ? easedValue(ease.from, context, now - ease.at) : context)

    // Right side of the header: oxygen, then the context gauge as depth. At the crush line it turns amber and says what to do.
    const oxygen = await read($, oxygenAtom)
    const isCrush = shown >= CRUSH
    const canCompact = isOn && isCrush && !isTurnRunning
    const compactButton = canCompact ? (
      <Button plain key="compact-now" label="compact now" onPress={() => compactNow($)}>
        <Text backgroundColor={pal.warn} color={pal.onAccent} bold>
          {COMPACT_LABEL}
        </Text>
      </Button>
    ) : null
    // Beside a docked pane the bar is narrow: oxygen and the depth word go, the meter halves, /compact stays.
    const isNarrow = columns < 60
    // Too tight for meters (beside a wide docked pane): the header keeps the title, rows keep their names.
    const isTiny = columns < 34
    const meterW = isNarrow ? METER / 2 : METER
    const words = WORDS
    const depth = canCompact ? '' : isCrush ? (isNarrow ? '/compact' : `${words.full} · /compact`) : isNarrow ? '' : shown >= 50 ? words.high : words.low
    const gaugeFill = isSurfacing ? Math.round(Math.min(1, (SURFACE_MS - (surfacing.until - now)) / SURFACE_MS) * meterW) : Math.round((Math.min(100, shown) / 100) * meterW)
    // The refill time sits after the oxygen figure, in local time, when the plan reports it.
    const refill = isNarrow ? '' : refillTime(await read($, resetsAtom))
    // An API account has no plan window: the same slot shows tokens and spend, or the budget left.
    const money = oxygen === null && !isNarrow ? headerView(await read($, accountAtom), await read($, budgetAtom), await read($, ledgerAtom), await read($, sessionIdAtom), now, words.limit) : null
    const oxygenLabel = money ? `${money.text}   ` : oxygen === null || isNarrow ? '' : `${words.limit} ${oxygen}%${refill ? ` ↻ ${refill}` : ''}   `
    const gaugeLabel = `▼ ${shown}% ${depth} `
    const gauge = (
      <Text>
        <Text color={money ? (money.level === 'red' ? pal.bad : money.level === 'amber' ? pal.warn : pal.muted) : oxygen !== null && oxygen < 20 ? pal.warn : pal.muted}>{oxygenLabel}</Text>
        <Text color={isCrush ? pal.warn : pal.text}>{`▼ ${shown}%`}</Text>
        <Text color={isCrush ? pal.warn : pal.muted}>{` ${depth} `}</Text>
        <Text color={isCrush ? pal.warn : pal.accent}>{'━'.repeat(gaugeFill)}</Text>
        <Text color={pal.hairline}>{'─'.repeat(meterW - gaugeFill)}</Text>
      </Text>
    )
    // The ◇ breathes while a job works and ripples out once when a turn ends. Bubbles rise beside the gauge while it works.
    const ping = await read($, pingAtom)
    const isPinging = ping !== null && now < ping
    const isLive = list?.phase === 'working'
    const markColor = isPinging ? pal.highlight : isLive ? breathe(pal, frame) : pal.accent
    const mark = <Text color={markColor} bold>{`${isPinging ? pingGlyph(PING_MS - (ping - now)) : '◇'} `}</Text>
    const bubbleW = isLive && !isNarrow && (await read($, bubblesOnAtom)) ? BUBBLES : 0
    const field = bubbles(bubbleW, frame)
    const bubbleColors: Record<string, string> = { '·': pal.halo, '∘': pal.accentDeep, '°': pal.accent }
    const fizz = (
      <Text>
        {field.high.map((ch, i) => (
          <Text key={`b-${i}`} color={bubbleColors[ch] ?? pal.muted}>
            {ch}
          </Text>
        ))}
        {bubbleW > 0 ? <Text>{' '}</Text> : null}
      </Text>
    )
    const lowBubble = (c: number): string | null => {
      const k = c - (columns - bubbleW)
      const ch = bubbleW > 0 && k >= 0 ? field.low[k] : undefined

      return ch && ch !== ' ' ? ch : null
    }
    const headWidth = isTiny ? Math.max(1, columns - 2) : Math.max(8, columns - oxygenLabel.length - gaugeLabel.length - meterW - 2 - 2 - (bubbleW > 0 ? bubbleW + 1 : 0) - (canCompact ? COMPACT_LABEL.length + 1 : 0))
    const tasksToday = tasksOn((await read($, daysAtom))[dayKey(new Date(now))])
    const idle = isOn ? (tasksToday > 0 ? `Ready · ${tasksToday} done today` : 'Ready') : 'Clean View off: every tool row shows'
    const loop = isOn ? await read($, loopAtom) : null
    // The loop row below says exactly what repeats, so the header does not say Stuck as well.
    const isLoopShown = loop !== null && !loop.isDismissed
    let head = (
      <Text>
        <Text color={pal.accent} bold>
          {'carapace'}
        </Text>
        <Text color={pal.muted}>{fit(` · ${idle}`, Math.max(4, headWidth - 8))}</Text>
      </Text>
    )
    if (isSurfacing) {
      head = (
        <Text>
          <Text color={pal.accent}>{'rising'}</Text>
          <Text color={pal.muted}>{fit(riseDots(riseFrame), Math.max(0, headWidth - 6))}</Text>
        </Text>
      )
    } else if (surfacing !== null && list !== null && list.phase === 'done') {
      head = <Text color={pal.good} bold>{fit(surfacing.line, headWidth)}</Text>
    } else if (list !== null) {
      const title = list.title
      if (list.phase === 'working') {
        // The timer's real width: ' · 12m 34s' is 10 cells, more than a fixed reserve allowed.
        const took = ` · ${formatDuration(now - (list.resumedAt ?? list.startedAt))}`
        head = (
          <Text>
            <Text bold color={pal.text}>
              {fit(title, Math.max(4, headWidth - cells(took)))}
            </Text>
            <Text color={pal.muted}>{took}</Text>
          </Text>
        )
      } else if (list.phase === 'needsYou') {
        head = (
          <Text>
            <Text backgroundColor={pal.warn} color={pal.onAccent} bold>
              {' Needs you '}
            </Text>
            <Text color={pal.text}>{fit(` ${list.needsYouReason ?? WAITING_REPLY}`, headWidth - 11)}</Text>
          </Text>
        )
      } else if (list.phase === 'stuck') {
        head = isLoopShown
          ? <Text color={pal.text}>{fit(`${GLYPH.stuck} ${title}`, headWidth)}</Text>
          : <Text color={pal.bad}>{fit(`${GLYPH.stuck} Stuck: ${list.stuckReason ?? 'something went wrong'}`, headWidth)}</Text>
      } else if (list.phase === 'stopped') {
        head = <Text color={pal.muted}>{fit(`■ Stopped · ${title} · you pressed Esc`, headWidth)}</Text>
      } else {
        const took = formatDuration((list.finishedAt ?? now) - (list.resumedAt ?? list.startedAt))
        const finished = list.tasks.filter(task => task.status === 'done').length
        head = finished === list.tasks.length
          ? <Text color={pal.good}>{fit(`${GLYPH.done} All done · ${title} · took ${took}`, headWidth)}</Text>
          : <Text color={pal.warn}>{fit(`■ Finished · ${finished} of ${list.tasks.length} steps · ${title} · took ${took}`, headWidth)}</Text>
      }
    }

    // The tide: one wave per column, while a job works and while the bar surfaces. Its low right end carries the bubbles.
    const showTide = list !== null && (list.phase === 'working' || isSurfacing)
    const tideCells = isSurfacing
      ? tide(columns, riseLevel(riseFrame), frame).map(cell => ({ ...cell, high: true }))
      : tide(columns, tideLevel(shown), frame)
    const tideRow = showTide ? (
      <Box flexDirection="row">
        {mergeRuns(
          tideCells.map((cell, c) => {
            const bubble = lowBubble(c)
            const color = bubble !== null ? bubbleColors[bubble] : isCrush && !isSurfacing ? pal.warn : cell.high ? pal.accent : pal.accentDeep

            return { text: bubble ?? cell.glyph, color }
          }),
        ).map((run, r) => (
          <Text key={`t-${r}`} color={run.color}>
            {run.text}
          </Text>
        ))}
      </Box>
    ) : null

    // The checklist: one row per step. Wide bars add a depth label before each connector; narrow ones keep the short connector.
    const showRows = list !== null && !(list.phase === 'done' && list.isCollapsed) && !isSurfacing
    const labelWidth = depthLabelWidth(list?.tasks.length ?? 0, words)
    const prefixWidth = isNarrow ? 3 : labelWidth + 5
    const nameWidth = isTiny ? Math.max(1, columns - prefixWidth - 2) : Math.max(8, columns - prefixWidth - 2 - 2 - METER - 1 - LABEL_WIDTH)
    const firstUpcoming = list?.tasks.findIndex(task => task.status === 'upcoming') ?? -1
    const isPaused = list?.phase === 'needsYou'
    const count = list?.tasks.length ?? 0
    // A tall list shows a window around the active step when the rows would pass maxRows: header, tide and buttons stay.
    // The stuck row takes one more when it shows.
    const budget = Math.max(1, e.props.maxRows - 2 - (showTide ? 1 : 0) - (isLoopShown ? 1 : 0))
    let from = 0
    let to = count
    if (showRows && count > budget) {
      const activeAt = list.tasks.findIndex(task => task.status === 'active')
      const anchor = activeAt >= 0 ? activeAt : firstUpcoming >= 0 ? firstUpcoming : count - 1
      const size = Math.max(1, budget - 2)
      from = Math.min(Math.max(0, anchor - Math.floor((size - 1) / 2)), count - size)
      to = from + size
      if (from === 0) to = Math.min(count, to + 1)
      else if (to === count) from = Math.max(0, from - 1)
    }
    const more = (n: number, key: string) => (
      <Text key={key} color={pal.muted}>{`${' '.repeat(prefixWidth)}+${n} more`}</Text>
    )
    const rows = showRows
      ? list.tasks.map((task, i) => {
          const isDone = task.status === 'done'
          // Once a job has ended, its open steps are no longer being worked on.
          const isEnded = list.phase === 'done' || list.phase === 'stopped'
          const isActive = task.status === 'active' && !isEnded
          let filled = 0
          let tag = isEnded ? 'Not done' : i === firstUpcoming ? 'Next' : ''
          let sweepAt: number | null = null
          if (isDone) {
            filled = METER
            tag = 'Done'
          } else if (isActive && task.hasReported) {
            filled = Math.round(task.percent / 10)
            tag = `${task.percent}%`
          } else if (isActive) {
            sweepAt = (frame % (METER + 3)) - 3
            tag = 'Working'
          }
          const at = sweepAt
          const cells = Array.from({ length: METER }, (_, c) => (at !== null ? c >= at && c < at + 3 : c < filled))
          const icon = isDone ? GLYPH.done : isActive ? (isPaused ? GLYPH.waiting : GLYPH.active) : GLYPH.queued

          return (
            <Box key={`task-${task.id}`} flexDirection="row">
              {isNarrow ? null : <Text color={pal.muted}>{depthLabel(i, labelWidth, words)}</Text>}
              <Text color={pal.accentDeep}>{isNarrow ? narrowConnector(i, count) : diveConnector(i, count)}</Text>
              <Text color={isDone ? pal.good : isActive ? (isLive ? breathe(pal, frame) : pal.accent) : pal.muted}>{icon} </Text>
              <Text bold={isActive} color={isActive ? pal.text : pal.muted}>
                {padCells(fit(wipeName(task.name, task.addedAt, now), nameWidth), nameWidth)}
              </Text>
              {isTiny ? null : <Text>{'  '}</Text>}
              {isTiny ? null : <Text>
                {mergeRuns(cells.map(isLit => ({ text: isLit ? '━' : '─', color: isLit ? (isDone ? pal.good : pal.accent) : pal.hairline }))).map((run, m) => (
                  <Text key={`m-${m}`} color={run.color}>
                    {run.text}
                  </Text>
                ))}
              </Text>}
              {isTiny ? null : <Text color={isActive ? pal.text : pal.muted}> {tag.padEnd(LABEL_WIDTH)}</Text>}
            </Box>
          )
        }).slice(from, to)
      : []
    if (from > 0) rows.unshift(more(from, 'more-up'))
    if (to < count) rows.push(more(count - to, 'more-down'))

    const stuckRow = loop !== null && !loop.isDismissed ? (
      <Box flexDirection="row">
        <Text color={pal.bad} bold>{`${GLYPH.stuck} `}</Text>
        <Text color={pal.bad}>{padCells(fit(`stuck: ${loop.tries} tries on the same ${loop.kind === 'edit' ? 'edit' : 'error'}${loop.line ? ' · ' + loop.line : ''}`, Math.max(1, columns - (isTiny ? 8 : 22))), Math.max(1, columns - (isTiny ? 8 : 22)))}</Text>
        <Button plain key="loop-stop" label="Stop" onPress={() => (heldTurn === null ? Promise.resolve() : $.turn.abort({ turnId: heldTurn }))}>
          <Text backgroundColor={pal.warn} color={pal.onAccent} bold>{' Stop '}</Text>
        </Button>
        {isTiny ? null : <Text>{' '}</Text>}
        {isTiny ? null : <Button plain key="loop-dismiss" label="Dismiss" onPress={() => update($, loopAtom, old => (old === null ? null : { ...old, isDismissed: true }))}>
          <Text color={pal.muted}>{'[ Dismiss ]'}</Text>
        </Button>}
      </Box>
    ) : null

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" width={outer} backgroundColor={pal.surface} paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text>
              {mark}
              {head}
            </Text>
            {isTiny ? null : <Box flexDirection="row"><Text>
              {fizz}
              {gauge}
            </Text>{compactButton}</Box>}
          </Box>
          {stuckRow}
          {tideRow}
          {rows}
        </Box>
        {buttons}
      </Box>
    )
  })
}
