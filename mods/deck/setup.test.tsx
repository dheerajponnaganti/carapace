import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { helpersOf, parseAmount, pinsFor, withSaved } from './setup'
import { LOGBOOK_PANE } from '../logbook/logbook'

test('pure: pins follow the work, amounts parse, answers map both ways', () => {
  expect(pinsFor(['coding'], true)).toEqual(['crew', 'clean', 'logbook', 'refine', 'report'])
  expect(pinsFor(['research'], false)).toEqual(['crew', 'report', 'refine', 'clean'])
  expect(pinsFor(['emails', 'writing'], true)).toEqual(['refine', 'report', 'logbook', 'crew', 'clean'])
  expect(pinsFor([], false)).toEqual(['crew', 'refine', 'clean', 'report'])
  expect(parseAmount('$75')).toBe(75)
  expect(parseAmount('1,200 a month')).toBe(1200)
  expect(parseAmount('62.5/hr')).toBe(62.5)
  expect(parseAmount('0')).toBeNull()
  expect(parseAmount('free')).toBeNull()
  expect(helpersOf('fast')).toBe('cost')
  expect(helpersOf(undefined)).toBe('balanced')
  const live = { rate: 50, work: ['coding' as const], pay: 'sub' as const, budget: { amount: 20, period: 'day' as const }, helpers: 'balanced' as const, view: 'checklist' as const, memory: true }
  expect(withSaved(live, { ...live, rate: 90, memory: false, work: ['emails'] })).toMatchObject({ rate: live.rate, memory: false, work: ['emails'] })
  expect(withSaved(live, { rate: -1, work: 'x', pay: 'bad' })).toEqual(live)
  expect(withSaved(live, null)).toEqual(live)
})

let sets: Record<string, unknown> = {}
let opened: string[] = []

async function world($: Engine, on: On, seed: Record<string, unknown> = {}) {
  sets = {}
  opened = []
  // The store, recording each save so a test can check where every answer went.
  const data: Record<string, unknown> = { ...seed }
  on('store.get', ($, e) => ({ value: data[e.key] }))
  on('store.set', ($, e) => {
    data[e.key] = e.value
    sets[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    delete data[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(data) }))
  mock.env(on, { HOME: '/home/test' })
  mock.clock(on, { now: 1_800_000_000_000 })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__carapace__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  for (const op of ['ui.status', 'ui.log', 'ui.close', 'ui.toast', 'fs.write'] as const) on(op, () => ({ value: undefined }))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.id', () => ({ value: 'session-1' }))
  on('settings.read', () => ({ value: { theme: 'dark' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await new Promise(resolve => setTimeout(resolve, 30))
}

const bar = async ($: Engine) => {
  const b = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} } })
  const text = (await b.findAll({ type: 'Text' })).map(t => t.text).join('|')
  await b.unmount()

  return text
}
const pane = ($: Engine) =>
  $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'Pane', requestId: 'carapace-setup', props: { title: 'Setup', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } })
const settle = () => new Promise(resolve => setTimeout(resolve, 30))

test('a new install asks for setup on the bar; Save writes every answer where its mod reads it', async ($, on) => {
  await world($, on)
  expect(await bar($)).toContain('Set up')
  // The first session with a person at the prompt opens setup by itself.
  expect(opened).toContain('carapace-setup')
  expect((await $.command.run({ command: 'setup', args: '' } as never)).text).toBe('Opening setup.')
  await settle()
  expect(opened).toContain('carapace-setup')
  const p = await pane($)
  // Headings draw in capitals.
  const text = (await p.findAll({ type: 'Text' })).map(t => t.text).join('\n').toLowerCase()
  for (const q of ['hour of your time', 'use claude for', 'pay for claude', 'what matters more', 'see while claude works', 'remember your work']) expect(text).toContain(q)

  for (const key of ['setup-work-coding', 'setup-work-research', 'setup-pay-budget', 'setup-period-week', 'setup-helpers-cost', 'setup-view-steps', 'setup-memory-no']) {
    await p.press({ key })
    await settle()
  }
  await p.press({ key: 'setup-save' })
  await settle()

  expect(sets['workReport:settings']).toMatchObject({ rate: 50 })
  expect(sets.deckPins).toEqual(['crew', 'report', 'refine', 'clean'])
  expect(sets.budgetAccountKind).toBe('api')
  expect(sets.budgetConfig).toEqual({ unit: 'usd', amount: 20, period: 'week' })
  expect(sets.agentDockHelperModel).toBe('fast')
  expect(sets.cleanViewEnabled).toBe(false)
  expect(sets.setupDone).toBe(true)
  expect(sets.setupAnswers).toMatchObject({ rate: 50, pay: 'budget', memory: false })
  // No memory wanted: Logbook's setup does not open.
  expect(opened).not.toContain(LOGBOOK_PANE)
  expect(await bar($)).not.toContain('Set up')
})

test('memory wanted and no vault yet: Save opens Logbook to pick where it lives; Later only stops the asking', async ($, on) => {
  await world($, on)
  await $.command.run({ command: 'setup', args: '' } as never)
  await settle()
  const p = await pane($)
  await p.press({ key: 'setup-save' })
  await settle()
  expect(opened).toContain(LOGBOOK_PANE)
  expect(sets.budgetAccountKind).toBe('subscriber')
  expect(sets.budgetConfig).toBeNull()
})

test('Later saves nothing and keeps the bar asking; a new session does not open setup again', async ($, on) => {
  await world($, on)
  await $.command.run({ command: 'setup', args: '' } as never)
  await settle()
  const p = await pane($)
  await p.press({ key: 'setup-later' })
  await settle()
  expect(sets.setupLater).toBe(true)
  expect(sets.setupDone).toBeUndefined()
  expect(sets.deckPins).toBeUndefined()
  opened = []
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  expect(opened).not.toContain('carapace-setup')
  expect(await bar($)).toContain('Set up')
})

test('setup reopens with the saved work and memory answers; live settings win over older saved ones', async ($, on) => {
  await world($, on, { setupAnswers: { rate: 120, work: ['research'], pay: 'sub', budget: { amount: 20, period: 'day' }, helpers: 'quality', view: 'steps', memory: false }, budgetAccountKind: 'api' })
  await $.command.run({ command: 'setup', args: '' } as never)
  await settle()
  const p = await pane($)
  const t = (await p.findAll({ type: 'Text' })).map(x => x.text).join('\n')
  expect(t).toContain('$50 an hour')
  expect(t).toContain('Yes, keep Logbook')
  expect(t).toContain('Detected: API credits.')
  await p.press({ key: 'setup-save' })
  await settle()
  expect(sets['workReport:settings']).toMatchObject({ rate: 50 })
  expect(sets.deckPins).toBeUndefined()
  expect(sets.setupAnswers).toMatchObject({ work: ['research'], memory: false })
})

test('Clean View turned off with /clean while setup is open survives Save', async ($, on) => {
  await world($, on)
  await $.command.run({ command: 'setup', args: '' } as never)
  await settle()
  await $.command.run({ command: 'clean', args: 'off' } as never)
  await settle()
  await (await pane($)).press({ key: 'setup-save' })
  await settle()
  expect(sets.cleanViewEnabled).toBe(false)
})
