import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentDockCard, AgentDockMission, CleanViewChecklist, CleanViewSurfacing } from '../../types'

import { radar } from '../agent-dock/dock-logic'
import { blanksIn, fillBlank, marks } from '../prompt-upgrade/marks'
import { strata } from '../work-report/report-logic'
import { GLYPH } from './look'
import { deckHealth } from '../deck/health'

const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }

// What the prompt box holds when a test reads it; prompts a plugin submits are recorded in `sent`.
let typedPrompt = ''

async function world($: Engine, on: On, env: Record<string, string> = {}) {
  const sent: string[] = []
  let surfacing: CleanViewSurfacing | null = null
  const opened: string[] = []
  const toasts: string[] = []
  const closed: string[] = []
  const states: Record<string, unknown> = {}
  mock.store(on, { setupDone: true })
  mock.env(on, { HOME: '/home/test', ...env })
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__carapace__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  for (const op of ['ui.status', 'ui.log', 'fs.write'] as const) on(op, () => ({ value: undefined }))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [] }))
  on('prompt.read', () => ({ value: { text: typedPrompt, cursor: 0 } }))
  on('prompt.fill', () => ({ isFilled: true }))
  on('process.run', () => ({ value: { code: 0, stdout: '', stderr: '' } }))
  on('session.id', () => ({ value: 'session-1' }))
  on('settings.read', () => ({ value: { theme: 'dark' } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 90_000, window: 100_000, percent: 90 }, rateLimits: [] } }))
  on('model.complete', () => ({ value: { isAnswered: true as const, text: 'Research pricing', usage } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($, e) => (sent.push(e.text), { text: e.text }))
  on('tool.call', () => ({ result: { ok: true } }))
  on('state.set', { plugin: 'carapace', key: 'cleanViewSurfacing' }, ($, e, next) => {
    surfacing = e.value as CleanViewSurfacing | null
    return next(e)
  })
  on('state.set', { plugin: 'carapace', key: ['cleanViewEnabled', 'cleanViewBubbles'] }, ($, e, next) => {
    states[e.key] = e.value
    return next(e)
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  return { clock, surfacing: () => surfacing, opened, closed, states, toasts, sent }
}

function card(id: string, task: string, status: AgentDockCard['status'], percent: number): AgentDockCard {
  return { id, task, status, percent, hasReported: percent > 0, startedAt: 0, endedAt: null, agentId: null, seat: 0 }
}

test('inline marks show added words and blanks, and blanks fill in', () => {
  const rewrite = 'Build a one-page landing page for my bakery, [bakery name], for walk-in customers.'
  const out = marks('make a landing page for my bakery', rewrite)
  expect(out.map(m => m.text).join('')).toBe(rewrite)
  expect(out.filter(m => m.kind === 'blank').map(m => m.text)).toEqual(['[bakery name]'])
  const added = out.filter(m => m.kind === 'added').map(m => m.text).join('')
  expect(added).toContain('one-page')
  expect(added).not.toContain('bakery,')
  expect(blanksIn(rewrite)).toEqual(['[bakery name]'])
  expect(fillBlank(rewrite, '[bakery name]', ' Crumb & Co ')).toContain('bakery, Crumb & Co,')
})

test('sonar puts finished helpers at the core and queued ones at the rim', () => {
  const grid = radar([card('a', 'Price check: Panera', 'done', 100), card('b', 'Read the reviews', 'queued', 0)], 0, 41, 17)
  const find = (status: string) => {
    for (const [y, row] of grid.entries()) for (const [x, cell] of row.entries()) if (cell.kind === status) return { x, y }
    return null
  }
  const done = find('done')
  const queued = find('queued')
  expect(grid[8]?.[20]?.ch).toBe('◆')
  expect(done !== null && Math.abs((done.y ?? 0) - 8) <= 2).toBe(true)
  expect(queued !== null && Math.abs((queued.y ?? 0) - 8) >= 6).toBe(true)
})

test('the year as layers: tasks by kind per month, later months open', () => {
  const layers = strata(
    { '2026-10-02': { kinds: { emails: 2, research: 3 }, models: {} }, '2026-03-04': { kinds: { other: 1 }, models: {} }, '2025-12-31': { kinds: { other: 9 }, models: {} } },
    new Date(2026, 9, 13, 12),
  )
  expect(layers[9]).toMatchObject({ month: 'Oct', total: 5, isCurrent: true, counts: { emails: 2, research: 3 } })
  expect(layers[2]?.total).toBe(1)
  expect(layers[11]?.isFuture).toBe(true)
  expect(layers.reduce((s, l) => s + l.total, 0)).toBe(6)
})

test('/mods opens the deck', async ($, on) => {
  const w = await world($, on)
  expect((await $.command.run({ command: 'mods', args: '' } as never)).text).toBe('Opening the Shipyard.')
  const deck = await $.ui.mount({
    plugin: 'carapace',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'carapace-deck',
    props: { title: 'mods', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  const text = (await deck.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  for (const name of ['Crew', 'Work Report', 'Refine', 'Clean View']) expect(text).toContain(name)
})

test('the bar: context gauge, crush hint, five named buttons, and surfacing', async ($, on) => {
  const w = await world($, on)
  await $.prompt.submit({ text: 'research pricing for three bakeries near me', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'research pricing for three bakeries near me', turnId: 't-1' })
  const band = await $.ui.mount({
    plugin: 'carapace',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 90, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  const bar = (await band.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  expect(bar).toContain('crush · /compact')
  for (const name of ['Crew', 'Refine', 'Clean', 'Report', 'Shipyard']) expect(bar).toContain(name)
  expect(bar).not.toContain('Deep Sea')
  await band.unmount()
  await w.clock.advance(61_000)
  await $.turn.complete({ answer: 'done', durationMs: 61_000, isAborted: false, turnId: 't-1', reason: 'answer', usage } as never)
  expect(w.surfacing()?.line).toContain('Surfaced')
})

const settle = () => new Promise(resolve => setTimeout(resolve, 30))

test('every bar button opens its mod or flips its switch', async ($, on) => {
  const w = await world($, on)
  const band = await $.ui.mount({
    plugin: 'carapace',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 90, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  for (const key of ['bar-dock', 'bar-refine']) {
    await band.press({ key })
    await settle()
  }
  expect(w.opened).toEqual(['agent-dock', 'prompt-upgrade'])
  await band.press({ key: 'bar-clean' })
  await settle()
  expect(w.states.cleanViewEnabled).toBe(false)
  await band.press({ key: 'bar-clean' })
  await settle()
  expect(w.states.cleanViewEnabled).toBe(true)
  await band.unmount()
})

test('with automatic mode off, the Refine button never takes a typed prompt: it is sent as typed', async ($, on) => {
  typedPrompt = 'fix the login bug in the settings screen'
  const w = await world($, on)
  const band = await $.ui.mount({
    plugin: 'carapace',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 90, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  await band.press({ key: 'bar-refine' })
  await settle()
  expect(w.sent).toEqual(['fix the login bug in the settings screen'])
  expect(w.closed).toContain('prompt-upgrade')
  await band.unmount()
  typedPrompt = ''
})

test('every row in /mods closes the deck and opens its mod', async ($, on) => {
  const w = await world($, on)
  const deck = await $.ui.mount({
    plugin: 'carapace',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'carapace-deck',
    props: { title: 'mods', isFocused: true, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  for (const key of ['c', 'w', 'r', 'v', 'm']) {
    await deck.press({ key: `deck-press-${key}` })
    await settle()
  }
  expect(w.opened).toEqual(['agent-dock', 'work-report', 'prompt-upgrade'])
  expect(w.closed.filter(id => id === 'carapace-deck').length).toBe(3)
  expect(w.states.cleanViewEnabled).toBe(false)
  expect(w.states.cleanViewBubbles).toBe(false)
  await deck.unmount()
})

test('/clean bubbles turns the bubbles off and on, and remembers', async ($, on) => {
  const w = await world($, on)
  expect((await $.command.run({ command: 'clean', args: 'bubbles off' } as never)).text).toBe('Bubbles off: the bar stays still.')
  expect(w.states.cleanViewBubbles).toBe(false)
  expect((await $.command.run({ command: 'clean', args: 'bubbles' } as never)).text).toBe('Bubbles on: they rise beside the gauge while a job works.')
  expect(w.states.cleanViewBubbles).toBe(true)
})

test('the deck counts four mods, names the first problem, and draws the deck glyph', async ($, on) => {
  await world($, on)
  const card = (id: string, status: AgentDockCard['status']) => ({ id, task: 'Read', status, percent: 0, hasReported: false, startedAt: 0, endedAt: null, agentId: null, seat: 0 })
  const crew = (cards: AgentDockCard[]): AgentDockMission => ({ id: 'm', job: 'job', size: 3, startedAt: 0, finishedAt: null, cards, launched: cards.length, nudged: false, isStopped: false })
  const plan = (phase: CleanViewChecklist['phase']): CleanViewChecklist => ({ title: 'Plan', phase, tasks: [], needsYouReason: null, stuckReason: null, startedAt: 0, finishedAt: null, isCollapsed: false })
  expect(GLYPH.deck).toBe('◇')
  expect(GLYPH.dock).toBe('◆')
  expect(deckHealth(null, null)).toEqual({ text: '4 mods · all well', isWell: true })
  expect(deckHealth(crew([card('a', 'stuck'), card('b', 'stuck'), card('c', 'done')]), plan('stuck')).text).toBe('4 mods · 2 helpers stuck')
  expect(deckHealth(crew([card('a', 'working')]), plan('stuck')).text).toBe('4 mods · Clean View stuck')
  expect(deckHealth(crew([card('a', 'working')]), plan('needsYou'))).toEqual({ text: '4 mods · needs you', isWell: false })
  expect(deckHealth(crew([card('a', 'stuck')]), null).text).toBe('4 mods · 1 helper stuck')

  const deck = await $.ui.mount({
    plugin: 'carapace',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'carapace-deck',
    props: { title: 'mods', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  const lines = (await deck.findAll({ type: 'Text' })).map(t => t.text)
  expect(lines).toContain('4 mods · all well')
  expect(lines.some(l => l.startsWith('◇'))).toBe(true)
  await deck.unmount()
})

test('a focused pane title glows only while focused', async ($, on) => {
  await world($, on)
  const deck = async (isFocused: boolean) => {
    const ui = await $.ui.mount({
      plugin: 'carapace',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'carapace-deck',
      props: { title: 'mods', isFocused, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    })
    const lines = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    await ui.unmount()

    return lines
  }
  expect(await deck(true)).toContain('░▒ ')
  expect(await deck(false)).not.toContain('░')
})

test('Clean reads as a switch and toasts what changed', async ($, on) => {
  const w = await world($, on)
  const band = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 90, scroll: { offset: 0, bodyRows: 20 }, view: {} } })
  expect((await band.findAll({ type: 'Text' })).map(t => t.text).join('|')).toContain('Clean: on')
  await band.press({ key: 'bar-clean' })
  await settle()
  expect(w.toasts.at(-1)).toBe('Clean View off: every tool call shows.')
  await band.unmount()
})
