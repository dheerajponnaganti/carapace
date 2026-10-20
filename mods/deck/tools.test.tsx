import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEFAULT_PINS, FULL_TEXT, drawsSomething, fitPins, readPins, setPin, togglePin, toolId, withLogbook, withReport } from './tools'

test('pure: toggle, cap at 5, order, unknown names, fit to width', () => {
  expect(setPin(['crew'], 'report', true)).toEqual({ pins: ['crew', 'report'], outcome: 'pinned' })
  expect(setPin(['crew'], 'crew', true).outcome).toBe('already')
  expect(setPin(['crew', 'report', 'refine', 'clean'], 'report', false).pins).toEqual(['crew', 'refine', 'clean'])
  expect(setPin([], 'crew', false).outcome).toBe('not pinned')
  expect(togglePin(['crew'], 'crew').pins).toEqual([])
  expect(setPin(['crew', 'report', 'refine', 'clean', 'logbook'], 'x', true).outcome).toBe('full')
  expect(readPins(undefined)).toEqual([...DEFAULT_PINS])
  expect(readPins(['clean', 'nope', 7, 'clean', 'crew'])).toEqual(['clean', 'crew'])
  expect(readPins([])).toEqual([])
  expect(toolId('Work Report')).toBe('report')
  expect(toolId('prompt-upgrade')).toBe('refine')
  expect(toolId('bubbles')).toBeNull()
  expect(fitPins(['crew', 'refine', 'clean'], 25, () => 8)).toEqual(['crew', 'refine'])
  expect(fitPins(['crew'], 3, () => 8)).toEqual([])
  expect(withLogbook(['crew', 'refine', 'clean'])).toEqual(['crew', 'refine', 'clean', 'logbook'])
  expect(withLogbook(['crew', 'refine', 'clean', 'report', 'rea'])).toEqual(['crew', 'refine', 'clean', 'report', 'rea'])
  // The bar grew to five: an existing bar of four gets Report back once.
  expect(withReport(['crew', 'refine', 'clean', 'logbook'])).toEqual(['crew', 'refine', 'clean', 'logbook', 'report'])
  expect(withReport(['crew', 'report'])).toEqual(['crew', 'report'])
})

let store: Record<string, unknown> = {}
async function world($: Engine, on: On, seed: Record<string, unknown> = {}) {
  store = { setupDone: true, ...seed }
  const toasts: string[] = []
  const opened: string[] = []
  mock.store(on, store)
  mock.env(on, { HOME: '/home/test' })
  mock.clock(on, { now: 1_800_000_000_000 })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__carapace__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  for (const op of ['ui.status', 'ui.log', 'fs.write'] as const) on(op, () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
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

  return { toasts, opened }
}

const band = ($: Engine, columns = 100) =>
  $.ui.mount({
    plugin: 'carapace',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: columns, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
const barText = async (b: Awaited<ReturnType<typeof band>>) => (await b.findAll({ type: 'Text' })).map(t => t.text).join('|')
const settle = () => new Promise(resolve => setTimeout(resolve, 30))

test('default bar: Crew, Refine, Clean, Logbook, then Shipyard; no Report', async ($, on) => {
  await world($, on)
  const text = await barText(await band($))
  expect(text).toMatch(/Crew[\s\S]*Refine[\s\S]*Clean[\s\S]*Logbook[\s\S]*set up[\s\S]*Shipyard/)
  expect(text).not.toContain('Report')
})

test('Logbook arrives once: pinned when a slot is free, with a hint; unpinning it sticks', async ($, on) => {
  const w = await world($, on, { deckPins: ['crew', 'refine', 'clean'] })
  expect(await barText(await band($))).toContain('Logbook')
  expect(w.toasts).toContain('New: Logbook keeps your work\'s memory in Obsidian. Press Logbook to set it up.')
  await $.command.run({ command: 'mods', args: 'unpin logbook' } as never)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  expect(await barText(await band($))).not.toContain('Logbook')
})

test('with five pins Logbook stays off the bar and the hint points to the Shipyard', async ($, on) => {
  const w = await world($, on, { deckPins: ['crew', 'refine', 'clean', 'report', 'rea'] })
  expect(await barText(await band($))).not.toContain('Logbook')
  expect(w.toasts).toContain('New: Logbook keeps your work\'s memory in Obsidian. Find it in ⌬ Shipyard.')
})

test('/mods pin report puts Report on the bar, last of the pins; unpin takes it off', async ($, on) => {
  await world($, on, { deckPins: ['crew', 'refine', 'clean'], logbookPinOffered: true, reportPinOffered: true })
  expect((await $.command.run({ command: 'mods', args: 'pin work report' } as never)).text).toBe('Work Report: pinned.')
  const b = await band($)
  expect(await barText(b)).toMatch(/Clean[\s\S]*Report[\s\S]*Shipyard/)
  await b.unmount()
  expect((await $.command.run({ command: 'mods', args: 'unpin report' } as never)).text).toBe('Work Report: unpinned.')
  expect(await barText(await band($))).not.toContain('Report')
})

test('the drawer shows pin marks and its pin button pins and unpins with a toast', async ($, on) => {
  const w = await world($, on, { deckPins: ['crew', 'refine', 'clean'], logbookPinOffered: true, reportPinOffered: true })
  const kit = await $.ui.mount({
    plugin: 'carapace', surface: 'terminal', component: 'Pane', requestId: 'carapace-deck',
    props: { title: 'Shipyard', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  const text = async () => (await kit.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  expect(await text()).toContain('◉ pinned')
  expect(await text()).toContain('○ pin')
  await kit.press({ key: 'deck-pin-report' })
  await settle()
  expect(w.toasts.at(-1)).toBe('Work Report: pinned.')
  await kit.press({ key: 'deck-pin-refine' })
  await settle()
  expect(w.toasts.at(-1)).toBe('Refine: unpinned.')
  expect(FULL_TEXT).toBe('The bar holds 5 pins. Unpin one first.')
})

test('the Shipyard button opens the pane', async ($, on) => {
  const w = await world($, on)
  const b = await band($)
  await b.press({ key: 'bar-shipyard' })
  await settle()
  expect(w.opened).toEqual(['carapace-deck'])
})

test('a narrow band drops pins from the end before wrapping', async ($, on) => {
  await world($, on)
  const wide = await barText(await band($, 100))
  expect(wide).toContain('Clean')
  const narrow = await barText(await band($, 60))
  expect(narrow).toContain('Crew')
  expect(narrow).not.toContain('Clean')
  expect(narrow).toContain('Shipyard')
})

test('alerts still show with zero pins', async ($, on) => {
  await world($, on, { carapaceErrorCount: 2 })
  await $.command.run({ command: 'mods', args: 'unpin crew' } as never)
  await $.command.run({ command: 'mods', args: 'unpin refine' } as never)
  await $.command.run({ command: 'mods', args: 'unpin clean' } as never)
  const none = await barText(await band($, 100))
  expect(none).toContain('Problem')
  expect(none).toContain('Shipyard')
  expect(none).not.toContain('Crew')
})

test('other mods draw something only when their tree shows content; core and empty boxes do not', () => {
  expect(drawsSomething({ type: 'engine', ref: 3 })).toBe(false)
  expect(drawsSomething({ type: 'Box', props: {}, children: [] })).toBe(false)
  expect(drawsSomething({ type: 'Box', props: {}, children: [{ type: 'engine', ref: 0 }, { type: 'Text', props: {}, children: [''] }] })).toBe(false)
  expect(drawsSomething({ type: 'Box', props: {}, children: [{ type: 'Button', props: { label: 'Review' } }] })).toBe(true)
  expect(drawsSomething({ type: 'Text', props: {}, children: ['ponytail full'] })).toBe(true)
})

test('the bar and /mods use the Sea names', async ($, on) => {
  await world($, on, { deckPins: ['crew', 'logbook'], logbookPinOffered: true })
  expect(await barText(await band($))).toMatch(/Crew[\s\S]*Logbook[\s\S]*Shipyard/)
  expect((await $.command.run({ command: 'mods', args: '' } as never)).text).toBe('Opening the Shipyard.')
})

test('other plugins\' rows are off by default; /mods more switches them and a new session remembers', async ($, on) => {
  await world($, on, { logbookPinOffered: true })
  expect((await $.command.run({ command: 'mods', args: 'more on' } as never)).text).toContain('fold behind ⋯ More')
  // A new session keeps the choice: a plain /mods more now switches it back off.
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  expect((await $.command.run({ command: 'mods', args: 'more' } as never)).text).toContain('are hidden')
})

test('an existing bar of four gets Report once when the bar grows to five; unpinning it sticks', async ($, on) => {
  await world($, on, { deckPins: ['crew', 'refine', 'clean', 'logbook'], logbookPinOffered: true })
  expect(await barText(await band($, 160))).toMatch(/Logbook[\s\S]*Report[\s\S]*Shipyard/)
  await $.command.run({ command: 'mods', args: 'unpin report' } as never)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  expect(await barText(await band($, 160))).not.toContain('Report')
})
