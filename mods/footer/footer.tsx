import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import { GLYPH, PALETTES, breathe, fit, mix, WORDS } from '../shared/look'
import type { Palette } from '../shared/look'
import { chip, paneTitle } from '../shared/ui'
import { modelMix } from '../agent-dock/dock-logic'
import { EFFORTS, addReading, cacheStatus, effortCells, forecast, parseGitStatus, prettyModel, recacheNote } from './footer-logic'
import type { CacheFile } from './footer-logic'
import { ACCOUNT_KIND_KEY, EMPTY_LEDGER, accountOf, coldNote, headerView, overText, periodKey, record, resetOf, spentIn, warnStep } from '../shared/budget-logic'
import type { Budget, Ledger } from '../shared/budget-logic'

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
    const line = errorLine(await $.clock.now(), 'footer', what, err, version)
    $.ui.log(line, { to: 'debug' })
    if (home !== '') await $.fs.write(logPath(home), appendLine(await $.fs.read(logPath(home)).then(String, () => ''), line))
    const count = Number((await $.store.get(COUNT_KEY)) ?? 0) + 1
    await $.store.set(COUNT_KEY, count)
    await update($, errorsAtom, () => count)
    if (!(await $.store.get(HINT_KEY))) {
      await $.store.set(HINT_KEY, true)
      $.ui.toast(hintText('footer'), { timeoutMs: 8000 })
    }
  })
}

const FLASH_MS = 1000
const DRAWER = 'footer-drawer'
const MODELS = [['default', 'Default'], ['fable', 'Fable'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']] as const

const modelAtom = atom({ plugin: 'carapace', key: 'footerModel' } as const, null)
const gitAtom = atom({ plugin: 'carapace', key: 'footerGit' } as const, null)
const tickAtom = atom({ plugin: 'carapace', key: 'tick' } as const, 0)
const checklistAtom = atom({ plugin: 'carapace', key: 'checklist' } as const, null)
const cacheAtom = atom({ plugin: 'carapace', key: 'footerCache' } as const, null)
const readingsAtom = atom({ plugin: 'carapace', key: 'footerReadings' } as const, { readings: [], resetsAt: null })
const accountAtom = atom({ plugin: 'carapace', key: 'budgetAccount' } as const, { kind: 'unknown', gateway: null })
const budgetAtom = atom({ plugin: 'carapace', key: 'budgetConfig' } as const, null)
const ledgerAtom = atom({ plugin: 'carapace', key: 'budgetLedger' } as const, EMPTY_LEDGER)
const sessionIdAtom = atom({ plugin: 'carapace', key: 'budgetSessionId' } as const, '')
const budgetReadingsAtom = atom({ plugin: 'carapace', key: 'budgetReadings' } as const, { readings: [], resetsAt: null })
const missionAtom = atom({ plugin: 'carapace', key: 'agentDockMission' } as const, null)

/**
 * The model and the effort the person chose, before any turn says what was really sent. After /model, /effort or a
 * settings change (isChanged) the new choice replaces the last turn's values at once, instead of at the next reply.
 */
async function readModel($: Engine, isChanged = false): Promise<void> {
  let asked: string | null = null
  try {
    const settings = (await $.settings.read()) as { effortLevel?: unknown }
    asked = typeof settings.effortLevel === 'string' ? settings.effortLevel : null
  } catch (err) {
    logError($, 'read settings', err)
    asked = null
  }
  const model = await $.session.model().catch(() => '')
  const env = (await $.env.get('CLAUDE_EFFORT')) ?? null
  const sent = isChanged ? (asked ?? env) : (env ?? asked)
  await update($, modelAtom, prev => ({
    model: prev?.model && model === '' ? prev.model : model,
    effort: isChanged ? (sent ?? prev?.effort ?? null) : (prev?.effort ?? sent),
    asked,
  }))
}

/** Branch, ahead and behind, files changed. Outside a repo the anchor hides. A new count flashes once. */
async function readGit($: Engine): Promise<void> {
  try {
    const cwd = await $.session.cwd()
    const run = await $.process.run(['git', '-C', cwd, 'status', '--porcelain=v2', '--branch'], { timeoutMs: 3000 })
    const state = run.exitCode === 0 ? parseGitStatus(run.stdout) : null
    const now = await $.clock.now()
    await update($, gitAtom, prev => {
      if (state === null) return null
      const isNew = prev !== null && prev.changed !== state.changed

      return { ...state, flashUntil: isNew ? now + FLASH_MS : (prev?.flashUntil ?? 0) }
    })
    if (state !== null) $.clock.after(FLASH_MS, () => void update($, gitAtom, g => (g ? { ...g } : g)))
  } catch {
    // No git, or it took too long: the anchor keeps its last reading.
  }
}

let isColdToasted = false
let cacheTimer: { cancel: () => void } | undefined

/** The status line script's file (see scripts/statusline.py), or null when it is missing, unreadable or from another session. */
async function readCacheFile($: Engine): Promise<CacheFile | null> {
  try {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
    if (home === '') return null
    const file = JSON.parse(String(await $.fs.read(`${home.replace(/[\\/]+$/, '')}/.claude/carapace/statusline.json`))) as CacheFile
    const id = await $.session.id().catch(() => null)

    return typeof file.session_id === 'string' && id !== null && file.session_id !== id ? null : file
  } catch {
    return null
  }
}

let cacheFile: CacheFile | null = null
// Dollars per token to write the cache on the model in use, learned from the engine's own estimate at a model switch.
let cachePrice: number | null = null
let warned: { key: string; level: 'ok' | 'amber' | 'red' } | null = null

/** The budget in force, the ledger and the session id, as the toasts and the header see them. */
async function budgetState($: Engine) {
  return { account: await read($, accountAtom), budget: (await read($, budgetAtom)) as Budget | null, ledger: (await read($, ledgerAtom)) as Ledger, id: await read($, sessionIdAtom) }
}

/** Adds the session's new cost and tokens to today's totals (a total already counted is never added twice), then warns at 80 and 100 percent. */
async function bookSpend($: Engine, usd: number | undefined, newTokens: number): Promise<void> {
  const id = await $.session.id().catch(() => '')
  if (id === '') return
  const now = await $.clock.now()
  await update($, sessionIdAtom, () => id)
  let isResumed = false
  if (!(await read($, ledgerAtom)).sess[id]) isResumed = now - (await $.session.usage().then(u => u.startedAt, () => now)) > 10 * 60_000
  const next = await update($, ledgerAtom, prev => record(prev, id, usd ?? prev.sess[id]?.usd ?? 0, newTokens, now, isResumed))
  await $.store.set('budgetLedger', next)
  const { account, budget, ledger } = await budgetState($)
  const view = headerView(account, budget, ledger, id, now)
  if (view === null) return
  if (view.pct !== null) {
    const resets = account.gateway ? account.gateway.resetsAt : budget ? (resetOf(budget.period, now) ?? Infinity) : null
    const pct = view.pct
    await update($, budgetReadingsAtom, prev => ({ readings: addReading(prev.readings, now, pct), resetsAt: resets }))
  }
  if (!budget || account.gateway) return
  const step = warnStep(warned, periodKey(budget, id, now), view.level)
  warned = step.next
  if (step.toast === 'amber') $.ui.toast(`${Math.round(view.pct ?? 0)}% of your ${budget.period === 'day' ? 'daily' : budget.period === 'week' ? 'weekly' : budget.period === 'month' ? 'monthly' : 'session'} budget is used.`, { timeoutMs: 6000 })
  if (step.toast === 'red') $.ui.toast(overText(budget, spentIn(ledger, budget, id, now)), { timeoutMs: 6000 })
}

/**
 * Updates the countdown from the last reading of the file, then sleeps until its text next changes (the next minute,
 * or each second in the last minute). No file reads on the timer: those happen on session and turn events.
 */
async function tickCache($: Engine): Promise<void> {
  cacheTimer?.cancel()
  cacheTimer = undefined
  try {
    const now = await $.clock.now()
    const status = cacheStatus(cacheFile, now)
    await update($, cacheAtom, prev => (JSON.stringify(prev) === JSON.stringify(status) ? prev : status))
    const expires = cacheFile?.prompt_cache?.expires_at
    const left = typeof expires === 'number' ? expires * 1000 - now : 0
    if (status === null || status.isCold || left <= 0) return
    const wait = left > 60_000 ? (left % 60_000 || 60_000) + 50 : 1000
    cacheTimer = $.clock.after(wait, () => void tickCache($))
  } catch {
    // The countdown keeps its last reading.
  }
}

/** Reads the status line file again (a reply has just landed or the session started), then redraws the countdown. */
async function refreshCache($: Engine): Promise<void> {
  cacheFile = await readCacheFile($)
  await tickCache($)
}

/** The drawer: pressing the model in the footer opens it. `$.ui.open` is the press's first call, so it seats at any width. */
function openDrawer($: Engine): void {
  void $.ui.open({ id: DRAWER, title: 'Model and effort', focus: true, closeOnEscape: true })
}

/** Runs Claude Code's own /model or /effort, then shows the new choice. The mod's own run skips its command.run hook. */
async function choose($: Engine, command: 'model' | 'effort', value: string): Promise<void> {
  try {
    await $.command.run({ command, args: value })
  } catch (err) {
    logError($, `set the ${command}`, err)
  }
  await readModel($, true)
}

export function registerFooter(on: On): void {
  // Other mods hold session.start under other matchers; this one covers any session with a folder.
  on('session.start', { cwd: /./ }, async ($, e, next) => {
    const started = await next(e)
    void (async () => {
      try {
        const config = ((await $.store.get('budgetConfig')) ?? null) as Budget | null
        await update($, budgetAtom, () => config)
        const saved = (await $.store.get('budgetLedger')) as Ledger | undefined
        if (saved?.days) await update($, ledgerAtom, () => saved)
      } catch (err) {
        logError($, 'read the budget', err)
      }
    })()
    void readModel($).catch(err => logError($, 'read the model', err))
    void readGit($)
    void refreshCache($)

    return started
  })

  // What the main conversation really sends: the model and the effort after any quiet downgrade.
  // The step streams, so the hook is a generator: it notes the values and passes every piece straight on.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const model = e.model
      const effort = e.effort ?? null
      await update($, modelAtom, prev => ({ model, effort, asked: prev?.asked ?? null }))
    }

    return yield* next(e)
  })

  // The person switched model or effort: show it now, not after the next reply. A picker (/model with no name)
  // answers later, so the model switch and a settings change are heard too.
  on('command.run', { command: /^(?:model|effort|fast)$/ }, async ($, e, next) => {
    const result = await next(e)
    void readModel($, true).catch(err => logError($, 'read the model', err))

    return result
  })
  on('classic.PostModelSwitch', async ($, e, next) => {
    const result = await next(e)
    const price = e as { estimated_cache_write_usd?: unknown; context_tokens?: unknown }
    if (typeof price.estimated_cache_write_usd === 'number' && typeof price.context_tokens === 'number' && price.context_tokens > 0) cachePrice = price.estimated_cache_write_usd / price.context_tokens
    void readModel($, true).catch(err => logError($, 'read the model', err))

    return result
  })
  on('classic.ConfigChange', async ($, e, next) => {
    const result = await next(e)
    void readModel($, true).catch(err => logError($, 'read the model', err))

    return result
  })

  // Tools that can change files or the branch: the anchor reads git again after each one.
  on('tool.call', { tool: /^(?:Edit|Write|MultiEdit|NotebookEdit|Bash)$/ }, async ($, e, next) => {
    const result = await next(e)
    void readGit($)

    return result
  })

  on('turn.complete', { turnId: /./ }, async ($, e, next) => {
    const u = e.usage
    if (u) void bookSpend($, undefined, u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens).catch(err => logError($, 'book the spend', err))
    if (e.agentId === undefined) {
      void readGit($)
      void readModel($).catch(err => logError($, 'read the model', err))
      // The status line script writes its file just after a reply (Claude Code debounces it by 300 ms).
      $.clock.after(1500, () => void refreshCache($))
    }

    return next(e)
  })

  // The first send on a cold cache says what it will cost, once (until the cache is warm again).
  on('prompt.submit', { text: /^/ }, async ($, e, next) => {
    try {
      const { account, budget, ledger, id } = await budgetState($)
      const now = await $.clock.now()
      const note = recacheNote(await readCacheFile($), now, t => coldNote(account, t, cachePrice, budget))
      if (note !== null && !isColdToasted) $.ui.toast(note, { timeoutMs: 8000 })
      isColdToasted = note !== null
      // Past the budget, every send says so. Warnings only: the send goes on.
      if (budget && !account.gateway && account.kind === 'api' && headerView(account, budget, ledger, id, now)?.level === 'red') {
        $.ui.toast(overText(budget, spentIn(ledger, budget, id, now)), { timeoutMs: 6000 })
      }
    } catch (err) {
      logError($, 'read the cache file', err)
    }

    return next(e)
  })

  // The five-hour window: a short history of readings for the "empty in" forecast.
  on('session.measure', async ($, e, next) => {
    const before = await read($, accountAtom)
    const found = accountOf(e.rateLimits, e.cost?.usd ?? 0, before)
    await update($, accountAtom, () => found)
    if (found.kind !== before.kind && found.kind !== 'unknown') await $.store.set(ACCOUNT_KIND_KEY, found.kind)
    if (found.kind === 'api' && e.cost) void bookSpend($, e.cost.usd, 0).catch(err => logError($, 'book the spend', err))
    const plan = e.rateLimits.find(r => r.kind === 'five_hour')
    if (plan) {
      const at = await $.clock.now()
      const resets = plan.resetsAt ? Date.parse(plan.resetsAt) : NaN
      await update($, readingsAtom, prev => ({ readings: addReading(prev.readings, at, plan.percentUsed), resetsAt: Number.isNaN(resets) ? null : resets }))
    }

    return next(e)
  })

  // The right end of the prompt footer: Claude Code's own mode labels, then the gauge and the anchor.
  on('ui.render', { component: 'SessionMode' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const pal: Palette = PALETTES.deep
    const words = WORDS
    const info = await read($, modelAtom)
    const git = await read($, gitAtom)
    const cache = await read($, cacheAtom)
    const plan = await read($, readingsAtom)
    await read($, tickAtom)
    const isWorking = (await read($, checklistAtom))?.phase === 'working'
    const mission = await read($, missionAtom)
    const working = mission?.cards.filter(c => c.status === 'working') ?? []
    const helpers = working.length
    const now = await $.clock.now()
    // The pulses step once a second, whatever the quick frame rate.
    const frame = Math.floor(now / 1000)

    const sent = effortCells(info?.effort)
    const asked = effortCells(info?.asked)
    const isLowered = asked > sent && sent > 0
    const cells = Array.from({ length: 5 }, (_, i) => {
      const base = mix(pal.accentDeep, pal.highlight, i / 4)
      if (i < sent) return <Text key={`e-${i}`} color={isWorking && frame % 2 === 1 ? mix(base, pal.text, 0.45) : base}>▰</Text>
      if (isLowered && i < asked) return <Text key={`e-${i}`} color={pal.warn}>▱</Text>

      return <Text key={`e-${i}`} color={pal.hairline}>▱</Text>
    })
    const effortWord = typeof info?.effort === 'number' ? String(info.effort) : (EFFORTS[sent - 1] ?? '')
    const crewMix = modelMix(working.map(c => c.model))

    let anchor = null
    if (git !== null) {
      const isDirty = git.changed > 0
      const isFlash = now < git.flashUntil
      anchor = (
        <Text>
          <Text color={pal.muted}>{'   '}</Text>
          <Text color={git.isDetached ? pal.bad : isDirty ? pal.warn : pal.good}>{`${isDirty ? words.changed : words.home} `}</Text>
          <Text color={git.isDetached ? pal.bad : pal.text}>{git.isDetached ? words.detached : git.branch}</Text>
          {isDirty ? (
            <Text color={isFlash ? pal.accent : pal.warn} backgroundColor={isFlash ? pal.halo : undefined} bold={isFlash}>
              {` ±${git.changed}`}
            </Text>
          ) : null}
          {git.ahead > 0 ? <Text color={pal.accent}>{` ↑${git.ahead}`}</Text> : null}
          {git.behind > 0 ? <Text color={pal.warn}>{` ↓${git.behind}`}</Text> : null}
        </Text>
      )
    }

    const budgetPlan = await read($, budgetReadingsAtom)
    const empty = forecast(plan.readings, now, plan.resetsAt) ?? forecast(budgetPlan.readings, now, budgetPlan.resetsAt, 'budget runs out in')
    const gauges = (
      <Text>
        {cache ? <Text color={cache.isAmber ? pal.warn : cache.isCold ? pal.muted : pal.accent}>{`   ${cache.text}`}</Text> : null}
        {empty ? <Text color={pal.warn}>{`   ${empty}`}</Text> : null}
      </Text>
    )

    return (
      <Box flexDirection="row">
        {e.props.modes.length > 0 ? <Text dimColor>{`${e.props.modes.join(' & ')}   `}</Text> : null}
        {info !== null && info.model !== '' ? (
          <Button key="footer-model" plain label="model and effort" onPress={() => openDrawer($)}>
            <Text>
              <Text color={isWorking ? breathe(pal, frame) : pal.accent}>{GLYPH.model}</Text>
              <Text color={pal.text}>{` ${prettyModel(info.model)} `}</Text>
              {sent > 0 ? cells : null}
              {effortWord ? <Text color={isLowered ? pal.warn : pal.muted}>{` ${effortWord}${isLowered ? ` (asked ${EFFORTS[asked - 1]})` : ''}`}</Text> : null}
              {helpers > 0 ? <Text color={pal.highlight}>{`  +${helpers}${crewMix ? ` · ${crewMix}` : ''}`}</Text> : null}
            </Text>
          </Button>
        ) : null}
        {anchor}
        {cache || empty ? gauges : null}
      </Box>
    )
  })

  // The drawer: the model and the effort as chips; the current ones are lit.
  on('ui.render', { component: 'Pane', requestId: DRAWER }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    const pal: Palette = PALETTES.deep
    const cols = Math.max(26, e.props.bodyColumns - 2)
    const info = await read($, modelAtom)
    const family = prettyModel(info?.model ?? '').split(' ')[0]?.toLowerCase() ?? ''
    const effort = info?.asked ?? (typeof info?.effort === 'string' ? info.effort : null)

    return (
      <Box flexDirection="column" gap={1} width={cols + 2} backgroundColor={pal.surface} paddingX={1}>
        {paneTitle(els, pal, 'Model and effort', cols, undefined, Boolean(e.props.isFocused))}
        <Text color={pal.muted}>Model</Text>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {MODELS.map(([alias, label]) => chip(els, pal, `model-${alias}`, label, alias === family ? 'primary' : 'secondary', () => void choose($, 'model', alias)))}
        </Box>
        <Text color={pal.muted}>Effort</Text>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {EFFORTS.map(level => chip(els, pal, `effort-${level}`, level, level === effort ? 'primary' : 'secondary', () => void choose($, 'effort', level)))}
        </Box>
        <Text color={pal.muted}>{fit('Saved as your default for new chats too.', cols)}</Text>
      </Box>
    )
  })
}
