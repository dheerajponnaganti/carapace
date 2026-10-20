import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { WorkReportDay as Day } from '../../types'

import { DEFAULT_SETTINGS, addDays, applySetting, changedLines, classifyTask, dayKey, dayOfYear, isWorthCounting, streak, sumDays, weekCard } from './report-logic'

const NOW = new Date(2026, 9, 13, 15, 0).getTime()
const PANE = 'work-report'
let copied: string[] = []
const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }

type World = { days: () => Record<string, Day> }

// The engine beneath carapace: every call the mods make is answered here.
async function world($: Engine, on: On, store: Record<string, unknown> = {}): Promise<World> {
  let days: Record<string, Day> = {}
  mock.store(on, store)
  mock.env(on, { HOME: '/home/test' })
  mock.clock(on, { now: NOW })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__carapace__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.copy', ($, e) => {
    copied.push((e as unknown as { text: string }).text)
    return { value: { isCopied: true as const } }
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.panes', () => ({ value: [] }))
  on('fs.write', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'session-1' }))
  on('model.complete', () => ({ value: { isAnswered: true as const, text: 'Work', usage } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: { ok: true } }))
  on('state.set', { plugin: 'carapace', key: 'workReportDays' }, ($, e, next) => {
    days = e.value as Record<string, Day>
    return next(e)
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'clean', args: 'off' } as never)

  return { days: () => days }
}

function pane($: Engine, columns: number, isFocused = true) {
  return $.ui.mount({
    plugin: 'carapace',
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE,
    props: { title: 'Work Report', isFocused, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
  })
}

async function texts(ui: Awaited<ReturnType<typeof pane>>) {
  return (await ui.findAll({ type: 'Text' })).map(t => t.text)
}

async function finish($: Engine, text: string, tools: { tool: string; file_path?: string }[], origin: object = { kind: 'composer' }, reason = 'answer') {
  await $.prompt.submit({ text, wait: false, origin } as never)
  await $.turn.start({ text, turnId: `t-${text}` })
  for (const [i, t] of tools.entries()) await $.tool.call({ tool_use_id: `${text}-${i}`, ...t } as never)
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: reason === 'aborted', turnId: `t-${text}`, reason, usage } as never)
}

const seeded = {
  'workReport:day:2026-10-13': { kinds: { emails: 2, research: 1 }, models: { 'Opus 5.5': 3 } },
  'workReport:day:2026-10-12': { kinds: { documents: 1 }, models: { 'Opus 5.5': 1 } },
  'workReport:day:2026-10-01': { kinds: { media: 4 }, models: { 'Haiku 5.5': 4 } },
  'workReport:day:2026-03-15': { kinds: { other: 6 }, models: { 'Sonnet 5.5': 6 } },
}

test('a task is sorted by the tools it used', () => {
  expect(classifyTask([{ tool: 'mcp__claude_ai_Gmail__send_message' }])).toBe('emails')
  expect(classifyTask([{ tool: 'WebSearch' }, { tool: 'WebFetch' }, { tool: 'Read' }])).toBe('research')
  expect(classifyTask([{ tool: 'Write', path: '/tmp/plan.docx' }])).toBe('documents')
  expect(classifyTask([{ tool: 'Write', path: '/tmp/hero.png' }, { tool: 'WebSearch' }])).toBe('media')
  expect(classifyTask([{ tool: 'Bash' }, { tool: 'mcp__carapace__plan_steps' }])).toBe('other')
})

test('only typed prompts that end with an answer count', async ($, on) => {
  const w = await world($, on)
  await finish($, 'draft a reply to the bakery supplier', [{ tool: 'mcp__claude_ai_Gmail__create_draft' }])
  await finish($, '/cost', [])
  await finish($, 'You used 3 of 10 helpers', [], { kind: 'plugin', name: 'carapace' })
  await finish($, 'research pricing for three bakeries', [{ tool: 'WebSearch' }], { kind: 'composer' }, 'aborted')
  await $.turn.complete({ answer: 'helper', durationMs: 10, isAborted: false, turnId: 'h', reason: 'answer', agentId: 'agent-1', usage } as never)

  const today = w.days()[dayKey(new Date(NOW))]
  expect(today?.kinds).toEqual({ emails: 1 })
  expect(today?.models).toEqual({ 'Opus 5.5': 1 })
})

test('the streak counts days in a row', () => {
  const today = new Date(NOW)
  const day = (n: number) => ({ kinds: { other: n }, models: {} })
  const days = { [dayKey(today)]: day(1), [dayKey(addDays(today, -1))]: day(2), [dayKey(addDays(today, -2))]: day(1), [dayKey(addDays(today, -4))]: day(5) }
  expect(streak(days, today)).toBe(3)
  // Today still empty: the streak runs from yesterday.
  expect(streak({ [dayKey(addDays(today, -1))]: day(1), [dayKey(addDays(today, -2))]: day(1) }, today)).toBe(2)
})

test('days add together by kind and model', () => {
  const total = sumDays([
    { kinds: { emails: 2, research: 1 }, models: { 'Opus 5.5': 3 } },
    undefined,
    { kinds: { emails: 1 }, models: { 'Opus 5.5': 1, 'Haiku 5.5': 0 } },
  ])
  expect(total.kinds).toEqual({ emails: 3, research: 1 })
  expect(total.models).toEqual({ 'Opus 5.5': 4, 'Haiku 5.5': 0 })
  expect(total.tasks).toBe(4)
})

test('the day of the year, and days stepped across a clock change', () => {
  expect(dayOfYear(new Date(2026, 0, 1))).toBe(1)
  expect(dayOfYear(new Date(2026, 11, 31, 23, 30))).toBe(365)
  expect(dayOfYear(new Date(2028, 2, 1))).toBe(61)
  expect(dayKey(addDays(new Date(2026, 2, 7, 23, 59), 1))).toBe('2026-03-08')
  expect(dayKey(addDays(new Date(2026, 10, 1, 0, 30), 1))).toBe('2026-11-02')
})

test('each tab draws its own title and chart', async ($, on) => {
  await world($, on, seeded)
  const ui = await pane($, 100)
  const expectations: [string, string, string][] = [
    ['tab-today', 'TODAY', 'LAST 7 DAYS'],
    ['tab-week', 'LAST 7 DAYS', 'LAST 7 DAYS'],
    ['tab-month', 'LAST 30 DAYS', 'LAST 30 DAYS'],
    ['tab-year', '2026', 'THE YEAR IN LAYERS'],
  ]
  for (const [key, title, chart] of expectations) {
    await ui.press({ key })
    const shown = await texts(ui)
    expect(shown).toContain(title)
    expect(shown.some(t => t.startsWith(chart))).toBe(true)
  }
  const year = (await texts(ui)).join('\n')
  expect(year).toContain('Best month: Oct')
  expect(year).toContain('HOURS SAVED')
})

test('/report answers with text at once', async ($, on) => {
  await world($, on)
  const reply = await $.command.run({ command: 'report', args: '' } as never)
  expect(reply.text).toBe('Opening the Work Report.')
  const settings = await $.command.run({ command: 'report', args: 'settings rate 75' } as never)
  expect(settings.text).toContain('$75')
})

test('a clean empty state', async ($, on) => {
  await world($, on)
  const ui = await pane($, 100)
  expect(await texts(ui)).toContain('Nothing finished yet today. Your first finished task shows up here.')
})

test('a narrow pane keeps every line inside its width', async ($, on) => {
  await world($, on, seeded)
  for (const columns of [40, 120]) {
    const ui = await pane($, columns)
    await ui.press({ key: 'tab-year' })
    for (const line of await texts(ui)) expect(line.length).toBeLessThanOrEqual(columns)
    await ui.unmount()
  }
})

test('the current month carries a now marker, and narrow panes keep it inside the width', async ($, on) => {
  await world($, on, seeded)
  for (const columns of [100, 26]) {
    const ui = await pane($, columns)
    await ui.press({ key: 'tab-year' })
    const shown = await texts(ui)
    expect(shown.some(t => t.includes('◂ now'))).toBe(true)
    for (const line of shown) expect(line.length).toBeLessThanOrEqual(columns)
    await ui.unmount()
  }
})

test('a focused pane title glows, an unfocused one does not', async ($, on) => {
  await world($, on, seeded)
  const focused = await pane($, 100, true)
  expect((await texts(focused)).some(t => t.includes('░▒ ') && t.includes(' ▒░'))).toBe(true)
  await focused.unmount()
  const idle = await pane($, 100, false)
  expect((await texts(idle)).some(t => t.includes('░'))).toBe(false)
  await idle.unmount()
})


test('a week with no tasks has no card to show', () => {
  expect(weekCard({}, { rate: 50, minutes: { code: 30, emails: 10, documents: 30, media: 20, research: 25, other: 10 } }, new Date(NOW)).lines).toEqual([])
})

test('the Week tab card reads the last seven days and Copy takes its plain text', async ($, on) => {
  await world($, on, seeded)
  copied = []
  const ui = await pane($, 100)
  await ui.press({ key: 'tab-week' })
  const shown = await texts(ui)
  const lines = ['This week · 7 Oct to 13 Oct', '4 tasks · 1.3 h saved · best day Tue', 'emails 2 · documents 1 · research 1']
  for (const line of lines) expect(shown).toContain(line)
  await ui.press({ key: 'week-copy' })
  expect(copied).toEqual([lines.join('\n')])
  await ui.unmount()
})

test('writing source code counts as Code; reading it, or writing notes, does not', () => {
  expect(classifyTask([{ tool: 'Edit', path: 'src/app.tsx', lines: 12 }, { tool: 'Bash' }])).toBe('code')
  expect(classifyTask([{ tool: 'NotebookEdit', path: 'model.ipynb', lines: 40 }])).toBe('code')
  expect(classifyTask([{ tool: 'Read', path: 'src/app.py' }])).toBe('other')
  expect(classifyTask([{ tool: 'Write', path: 'notes/plan.md' }])).toBe('documents')
  expect(applySetting('code 45', DEFAULT_SETTINGS).settings.minutes.code).toBe(45)
  expect(DEFAULT_SETTINGS.minutes.code).toBe(30)
})

test('a small code change counts as Other; a one-word reply with no tools does not count', async ($, on) => {
  expect(classifyTask([{ tool: 'Edit', path: 'a.ts', lines: 9 }])).toBe('other')
  expect(classifyTask([{ tool: 'Edit', path: 'a.ts', lines: 5 }, { tool: 'Edit', path: 'b.ts', lines: 5 }])).toBe('code')
  expect(changedLines({ old_string: 'a\nb', new_string: 'a\nb\nc' })).toBe(3)
  expect(isWorthCounting([], 'thanks')).toBe(false)
  expect(isWorthCounting([], 'word '.repeat(150))).toBe(true)
  expect(isWorthCounting([{ tool: 'Read' }], 'ok')).toBe(true)
  const w = await world($, on)
  await finish($, 'thanks a lot', [])
  expect(w.days()[dayKey(new Date(NOW))]).toBeUndefined()
})
