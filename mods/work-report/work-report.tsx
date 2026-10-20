import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderElement } from 'claude-code'

import { bigText, bigWidth } from '../shared/big-number'
import { PALETTES, padCells, padStartCells, spaced } from '../shared/look'
import { titleLit } from '../shared/ui'

import {
  DEFAULT_SETTINGS,
  KINDS,
  TABS,
  addDays,
  applySetting,
  barRows,
  chartColumns,
  chartSummary,
  changedLines,
  classifyTask,
  isWorthCounting,
  dayKey,
  dollarsText,
  emptyLine,
  estimate,
  fit,
  hoursText,
  isTypedRequest,
  modelName,
  stretchDays,
  stretchTitle,
  strata,
  sumDays,
  weekCard,
} from './report-logic'
import type { DayRecord, Settings, Tab, ToolUse } from './report-logic'

import { SNAPSHOTS_OFF_KEY, loadTimeMachine, noteTimeMachinePrompt, registerTimeMachine, timelineView } from './time-machine'
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
    const line = errorLine(await $.clock.now(), 'work-report', what, err, version)
    $.ui.log(line, { to: 'debug' })
    if (home !== '') await $.fs.write(logPath(home), appendLine(await $.fs.read(logPath(home)).then(String, () => ''), line))
    const count = Number((await $.store.get(COUNT_KEY)) ?? 0) + 1
    await $.store.set(COUNT_KEY, count)
    await update($, errorsAtom, () => count)
    if (!(await $.store.get(HINT_KEY))) {
      await $.store.set(HINT_KEY, true)
      $.ui.toast(hintText('work-report'), { timeoutMs: 8000 })
    }
  })
}

const PANE = 'work-report'
const DAY_PREFIX = 'workReport:day:'
const SETTINGS_KEY = 'workReport:settings'

const tabAtom = atom({ plugin: 'carapace', key: 'workReportTab' } as const, 'today')
const daysAtom = atom({ plugin: 'carapace', key: 'workReportDays' } as const, {})
const settingsAtom = atom({ plugin: 'carapace', key: 'workReportSettings' } as const, DEFAULT_SETTINGS)

// The typed request in flight and the tools it used. A reload mid-turn loses one task at most.
let pending: { uses: ToolUse[] } | null = null

function isSettings(value: unknown): value is Settings {
  const s = value as Settings | undefined

  return typeof s?.rate === 'number' && typeof s.minutes === 'object' && s.minutes !== null
}

/** Reads this year's and the last 30 days' records from the store into state. */
async function loadDays($: Engine): Promise<void> {
  const today = new Date(await $.clock.now())
  const from = dayKey(new Date(Math.min(new Date(today.getFullYear(), 0, 1, 12).getTime(), addDays(today, -30).getTime())))
  const keys = (await $.store.keys()).filter(key => key.startsWith(DAY_PREFIX) && key.slice(DAY_PREFIX.length) >= from)
  const days: Record<string, DayRecord> = {}
  for (const key of keys) {
    const record = (await $.store.get(key)) as DayRecord | undefined
    if (record && typeof record === 'object') days[key.slice(DAY_PREFIX.length)] = record
  }
  await update($, daysAtom, () => days)
}

async function recordTask($: Engine, uses: readonly ToolUse[], model: string): Promise<void> {
  const key = dayKey(new Date(await $.clock.now()))
  const kind = classifyTask(uses)
  // Read the store first: another session on this Mac may have added to today since this one loaded.
  const stored = (await $.store.get(DAY_PREFIX + key)) as DayRecord | undefined
  const day: DayRecord = stored && typeof stored === 'object' ? stored : { kinds: {}, models: {} }
  const next: DayRecord = {
    kinds: { ...day.kinds, [kind]: (day.kinds[kind] ?? 0) + 1 },
    models: { ...day.models, [model]: (day.models[model] ?? 0) + 1 },
  }
  // ponytail: last write wins if two sessions finish in the same instant; per-session keys if that ever matters.
  await $.store.set(DAY_PREFIX + key, next)
  await update($, daysAtom, days => ({ ...days, [key]: next }))
}

export function registerWorkReport(on: On): void {
  registerTimeMachine(on)

  // Other mods hold session.start already; this matcher covers every session.
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    const saved = await $.store.get(SETTINGS_KEY)
    if (isSettings(saved)) await update($, settingsAtom, () => ({ rate: saved.rate, minutes: { ...DEFAULT_SETTINGS.minutes, ...saved.minutes } }))
    await loadDays($)
    await loadTimeMachine($).catch(err => logError($, 'load the timeline', err))
    await $.command.register({ name: 'report', description: 'See what Claude finished for you and the time it saved', argumentHint: '[settings]' })

    return next(e)
  })

  // Registered last, so it only sees prompts the other mods let through.
  on('prompt.submit', { origin: { kind: /^(?:composer|plugin)$/ } }, async ($, e, next) => {
    const entered = await next(e)
    if (entered.drop === undefined && isTypedRequest(e)) {
      pending = { uses: [] }
      noteTimeMachinePrompt(await $.clock.now(), e.text)
    }

    return entered
  })

  on('tool.call', { tool: /^/ }, async ($, e, next) => {
    if (pending !== null) {
      const path = (e as unknown as { file_path?: unknown }).file_path
      pending.uses.push({ tool: e.tool, path: typeof path === 'string' ? path : undefined, lines: changedLines(e as unknown as Record<string, unknown>) })
    }

    return next(e)
  })

  on('turn.complete', { reason: /^/ }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const task = pending
    pending = null
    if (task !== null && e.reason === 'answer' && isWorthCounting(task.uses, e.answer)) await recordTask($, task.uses, modelName(e.usage?.model))

    return next(e)
  })

  on('command.run', { command: 'report' }, async ($, e) => {
    try {
      const args = e.args.trim()
      if (args === '') {
        // Opened inside the command's own dispatch, so it counts as asked for.
        const opening = $.ui.open({ id: PANE, title: 'Work Report' })
        void (async () => {
          const opened = await opening
          if (!opened.isPlaced) $.ui.log('Work Report needs a window at least 110 columns wide. Widen it and type /report again.')
          await loadDays($)
          await loadTimeMachine($)
        })().catch(err => logError($, 'open the Work Report', err))

        // Claude Code treats a command that answers with no text as unanswered.
        return { text: 'Opening the Work Report.' }
      }
      const [word, ...rest] = args.split(/\s+/)
      if (word?.toLowerCase() === 'snapshots') {
        const choice = rest[0]?.toLowerCase()
        if (choice === 'on' || choice === 'off') await $.store.set(SNAPSHOTS_OFF_KEY, choice === 'off')
        const isOff = (await $.store.get(SNAPSHOTS_OFF_KEY)) === true

        return { text: isOff ? 'Snapshots are off: no copies of your files are taken. /report snapshots on turns them back on.' : 'Snapshots are on: a hidden copy of the project is saved after each edit, for the Timeline and Restore. /report snapshots off stops them.' }
      }
      if (word?.toLowerCase() !== 'settings') return { text: 'Use /report to open it, /report settings to see or change the estimate, or /report snapshots on|off.' }
      const changed = applySetting(rest.join(' '), await read($, settingsAtom))
      await update($, settingsAtom, () => changed.settings)
      await $.store.set(SETTINGS_KEY, changed.settings)

      return { text: changed.text }
    } catch (err) {
      logError($, '/report', err)
      return { text: 'The Work Report could not open. Your records are safe; try /report again.' }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const pal = PALETTES.deep
    // The shared palette under the names this pane grew up with.
    const LOOK = { gold: pal.accent, hairline: pal.hairline, slate: pal.slate, muted: pal.muted, text: pal.text, good: pal.good, ink: pal.onAccent, bar: pal.muted, model: pal.highlight }
    const cols = Math.max(26, e.props.bodyColumns - 2)
    const tab = await read($, tabAtom)
    const days = await read($, daysAtom)
    const settings = await read($, settingsAtom)
    const today = new Date(await $.clock.now())
    const covered = stretchDays(tab, today).map(d => days[dayKey(d)])
    const total = sumDays(covered)
    const { hours, dollars } = estimate(total.kinds, settings)
    const card = weekCard(days, settings, today)
    // The Week tab's card: the summary to read, with Copy for its plain text.
    const weekSummary = tab === 'week' && card.lines.length > 0 ? (
      <Box flexDirection="column" borderStyle="round" borderColor={LOOK.hairline} paddingX={1} width={cols}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color={LOOK.text}>{fit(card.lines[0] ?? '', Math.max(4, cols - 12))}</Text>
          <Button key="week-copy" plain label="Copy" onPress={press => void $.ui.copy({ text: card.plain, surface: press.surface })}>
            <Text backgroundColor={LOOK.slate} color={LOOK.text}>{' Copy '}</Text>
          </Button>
        </Box>
        <Text color={LOOK.good}>{fit(card.lines[1] ?? '', cols - 4)}</Text>
        <Text color={LOOK.muted}>{fit(card.lines[2] ?? '', cols - 4)}</Text>
      </Box>
    ) : null

    const heading = (label: string) => {
      const caps = fit(label.toUpperCase(), cols - 2)

      return (
        <Box flexDirection="row">
          <Text color={LOOK.muted}>{caps} </Text>
          <Text color={LOOK.hairline}>{'─'.repeat(Math.max(0, cols - caps.length - 1))}</Text>
        </Box>
      )
    }

    const title = spaced('WORK REPORT')
    const head = (
      <Box flexDirection="column">
        <Text bold color={LOOK.text}>
          {title}
        </Text>
        <Box flexDirection="row">
          <Text color={LOOK.gold}>{'━'.repeat(title.length)}</Text>
          <Text color={LOOK.hairline}>{'─'.repeat(Math.max(0, cols - title.length))}</Text>
        </Box>
      </Box>
    )

    const tabs = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {TABS.map(t => (
          <Button key={`tab-${t.key}`} plain label={t.label} onPress={() => void update($, tabAtom, (): Tab => t.key)}>
            <Text backgroundColor={t.key === tab ? LOOK.gold : LOOK.slate} color={t.key === tab ? LOOK.ink : LOOK.text} bold={t.key === tab}>
              {` ${t.label} `}
            </Text>
          </Button>
        ))}
      </Box>
    )

    const timeline = tab === 'today' ? await timelineView($, els, pal, cols, today.getTime()) : null
    const names = stretchTitle(tab, today)
    const right = fit(names.right, Math.max(0, cols - names.left.length - 2))
    const titleBar = (
      <Box flexDirection="row" justifyContent="space-between" width={cols}>
        <Text>
          {titleLit(els, pal, e.props.isFocused ? fit(names.left, Math.max(1, cols - 6)) : names.left, Boolean(e.props.isFocused))}
        </Text>
        <Text color={LOOK.muted}>{right}</Text>
      </Box>
    )
    const footnote = (
      <Text color={LOOK.muted}>{fit(`Hours and value are estimates at $${settings.rate} an hour. /report settings`, cols)}</Text>
    )

    if (total.tasks === 0) {
      return (
        <Box flexDirection="column" gap={1} width={cols + 2} backgroundColor={pal.surface} paddingX={1}>
          {head}
          {tabs}
          {titleBar}
          <Box flexDirection="column" borderStyle="round" borderColor={LOOK.hairline} paddingX={1} width={cols}>
            <Text color={LOOK.text}>{emptyLine(tab)}</Text>
          </Box>
          {timeline}
          {footnote}
        </Box>
      )
    }

    // Tiles: three, then two, then one as the pane narrows.
    const perRow = cols >= 66 ? 3 : cols >= 44 ? 2 : 1
    const tileW = Math.floor((cols - (perRow - 1)) / perRow)
    const tile = (key: string, value: string, label: string, color: string) => {
      const inner = tileW - 4
      const isBig = bigWidth(value) <= inner

      return (
        <Box key={key} flexDirection="column" borderStyle="round" borderColor={LOOK.hairline} paddingX={1} width={tileW}>
          {isBig ? (
            bigText(value).map((row, i) => (
              <Text key={`${key}-${i}`} color={color}>
                {row}
              </Text>
            ))
          ) : (
            <Text color={color} bold>
              {fit(value, inner)}
            </Text>
          )}
          <Text color={LOOK.muted}>{fit(label, inner)}</Text>
        </Box>
      )
    }
    const tiles = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={0} width={cols}>
        {tile('hours', hoursText(hours), 'HOURS SAVED · ESTIMATE', LOOK.gold)}
        {tile('tasks', String(total.tasks), 'TASKS DONE', LOOK.text)}
        {tile('value', dollarsText(dollars), 'VALUE · ESTIMATE', LOOK.good)}
      </Box>
    )

    // A labeled bar row sized to the pane.
    const barRow = (key: string, label: string, share: number, color: string, tail: string, isQuiet: boolean) => {
      const labelW = Math.min(18, Math.max(8, Math.floor(cols * 0.28)))
      const tailW = Math.min(14, tail.length + 2)
      const barW = Math.max(4, cols - labelW - tailW - 2)
      const filled = Math.round(Math.min(1, Math.max(0, share)) * barW)

      return (
        <Box key={key} flexDirection="row">
          <Text color={isQuiet ? LOOK.muted : LOOK.text}>{padCells(fit(label, labelW), labelW)} </Text>
          <Text color={color}>{'━'.repeat(filled)}</Text>
          <Text color={LOOK.hairline}>{'─'.repeat(barW - filled)}</Text>
          <Text color={isQuiet ? LOOK.muted : LOOK.text}>{` ${padStartCells(fit(tail, tailW - 1), tailW - 1)}`}</Text>
        </Box>
      )
    }
    const kindHours = KINDS.map(k => ({ ...k, color: pal.kinds[k.key], count: total.kinds[k.key] ?? 0, hours: ((total.kinds[k.key] ?? 0) * settings.minutes[k.key]) / 60 }))
    const mostHours = Math.max(...kindHours.map(k => k.hours), 0.0001)
    const where = (
      <Box flexDirection="column">
        {heading('Where the time went · estimate')}
        {kindHours.map(k => barRow(`kind-${k.key}`, k.label, k.hours / mostHours, k.color, `${k.count} · ${hoursText(k.hours)} h`, k.count === 0))}
      </Box>
    )
    const models = Object.entries(total.models).sort((a, b) => b[1] - a[1])
    const mostModel = Math.max(...models.map(([, n]) => n), 1)
    const who = (
      <Box flexDirection="column">
        {heading('Who did the work')}
        {models.map(([name, n]) => barRow(`model-${name}`, name, n / mostModel, LOOK.model, String(n), false))}
      </Box>
    )

    // Chart: three rows of eighth blocks, current day or month in gold, future months empty.
    const columns = chartColumns(tab, days, today)
    const gap = columns.length === 30 ? (cols >= 60 ? 1 : 0) : 1
    const colW = Math.max(1, Math.min(5, Math.floor((cols - (columns.length - 1) * gap) / columns.length)))
    const max = Math.max(...columns.map(c => c.value), 1)
    const pad = ' '.repeat(gap)
    const chartRow = (row: 0 | 1 | 2) => (
      <Text key={`chart-${row}`}>
        {columns.map((c, i) => {
          const cell = c.isFuture ? (row === 2 ? '·' : ' ') : (barRows(c.value, max)[row] ?? ' ')
          const color = c.isFuture ? LOOK.hairline : c.isCurrent ? LOOK.gold : LOOK.bar

          return (
            <Text key={`c-${row}-${i}`} color={color}>
              {cell.repeat(colW) + (i < columns.length - 1 ? pad : '')}
            </Text>
          )
        })}
      </Text>
    )
    const labels =
      columns.length === 30 ? (
        <Box flexDirection="row" justifyContent="space-between" width={columns.length * colW + (columns.length - 1) * gap}>
          <Text color={LOOK.muted}>{stretchTitle('month', today).right.split(' to ')[0]}</Text>
          <Text color={LOOK.muted}>Today</Text>
        </Box>
      ) : (
        <Text color={LOOK.muted}>
          {columns.map((c, i) => c.label.slice(0, colW).padEnd(colW) + (i < columns.length - 1 ? pad : '')).join('')}
        </Text>
      )
    const chartTitle = tab === 'year' ? 'By month' : tab === 'month' ? 'Last 30 days' : 'Last 7 days'
    // The year as sediment: one layer per month, as wide as its tasks, colored by kind.
    const layers = strata(days, today)
    const mostLayer = Math.max(...layers.map(l => l.total), 1)
    // " ◂ now" marks the current month. It needs six cells, so the bars give them up when the pane is narrow.
    const nowMark = ' ◂ now'
    const withNow = cols - 18 >= 6
    const layerW = withNow ? cols - 18 : Math.max(6, cols - 12)
    const sediment = (
      <Box flexDirection="column">
        {heading('The year in layers')}
        {[...layers].reverse().map(layer => {
          if (layer.isFuture) {
            return (
              <Text key={`layer-${layer.month}`}>
                <Text color={pal.muted}>{`${layer.month}  `}</Text>
                <Text color={pal.hairline}>{'·'.repeat(layerW)}</Text>
              </Text>
            )
          }
          const width = Math.round((layer.total / mostLayer) * layerW)
          let used = 0
          const segments = KINDS.map(({ key }, i) => {
            const share = layer.total > 0 ? (layer.counts[key] ?? 0) / layer.total : 0
            const n = i === KINDS.length - 1 ? width - used : Math.round(width * share)
            used += n

            return n > 0 ? (
              <Text key={`seg-${layer.month}-${key}`} color={pal.kinds[key]}>
                {'█'.repeat(n)}
              </Text>
            ) : null
          })

          return (
            <Text key={`layer-${layer.month}`}>
              <Text color={layer.isCurrent ? pal.accent : pal.muted} bold={layer.isCurrent}>{`${layer.month}  `}</Text>
              {segments}
              <Text color={pal.hairline}>{'░'.repeat(Math.max(0, layerW - width))}</Text>
              <Text color={layer.isCurrent ? pal.accent : pal.muted}>{` ${String(layer.total).padStart(3)}`}</Text>
              {layer.isCurrent && withNow ? <Text color={pal.accent}>{nowMark}</Text> : null}
            </Text>
          )
        })}
        <Text color={pal.good}>{fit(chartSummary(tab, days, today), cols)}</Text>
      </Box>
    )
    const chart = tab === 'year' ? sediment : (
      <Box flexDirection="column">
        {heading(chartTitle)}
        {chartRow(0)}
        {chartRow(1)}
        {chartRow(2)}
        {labels}
        <Text color={LOOK.good}>{fit(chartSummary(tab, days, today), cols)}</Text>
      </Box>
    )

    const page: RenderElement = (
      <Box flexDirection="column" gap={1} width={cols + 2} backgroundColor={pal.surface} paddingX={1}>
        {head}
        {tabs}
        {titleBar}
        {weekSummary}
        {tiles}
        {where}
        {who}
        {chart}
        {timeline}
        {footnote}
      </Box>
    )

    return page
  })
}
