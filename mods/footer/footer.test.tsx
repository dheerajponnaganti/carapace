import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { addReading, bubbles, cacheStatus, effortCells, forecast, recacheNote, parseGitStatus, pingGlyph, prettyModel } from './footer-logic'

const STATUS = ['# branch.oid abc', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1', '1 .M N... 100644 100644 100644 a b README.md', '? notes.txt', ''].join('\n')

let model = 'claude-opus-5-5'
let effortLevel = 'high'
let clock: ReturnType<typeof mock.clock>
let cacheFile: string | null = null
const toasts: string[] = []
const NOW = 1_800_000_000_000
const opened: string[] = []
const ran: string[] = []

async function world($: Engine, on: On) {
  model = 'claude-opus-5-5'
  effortLevel = 'high'
  mock.store(on, { setupDone: true })
  mock.env(on, { HOME: '/home/test', CLAUDE_EFFORT: 'medium' })
  clock = mock.clock(on, { now: NOW })
  on('prompt.submit', () => ({ text: '' }) as never)
  on('session.measure', () => ({ changed: [] }) as never)
  on('tool.register', ($, e) => ({ value: { tool: `mcp__carapace__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  cacheFile = null
  toasts.length = 0
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }))
  on('fs.read', (_$, e) => (cacheFile !== null && e.path.endsWith('/.claude/carapace/statusline.json') ? { value: cacheFile } : { deny: 'ENOENT' }))
  for (const op of ['ui.status', 'ui.log', 'fs.write'] as const) on(op, () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: '/work/bakery-site' }))
  on('session.model', () => ({ value: model }))
  on('settings.read', () => ({ value: { theme: 'dark', effortLevel } }))
  opened.length = 0
  ran.length = 0
  on('command.run', ($, e) => {
    ran.push(`${e.command} ${e.args}`)
    if (e.command === 'effort') effortLevel = e.args
    if (e.command === 'model') model = `claude-${e.args}-5-5`
    return { text: '' }
  })
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 10, window: 100, percent: 10 }, rateLimits: [] } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: STATUS, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await $.session.start({ cwd: '/work/bakery-site', surface: 'terminal', isInteractive: true })
  await new Promise(resolve => setTimeout(resolve, 30))
}

test('model names, effort levels, bubbles and the ping ring', () => {
  expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(prettyModel('opus')).toBe('Opus')
  expect(prettyModel('claude-haiku-5-5')).toBe('Haiku 5.5')
  expect(prettyModel('gpt-x')).toBe('gpt-x')
  expect(effortCells('low')).toBe(1)
  expect(effortCells('max')).toBe(5)
  expect(effortCells(undefined)).toBe(0)
  expect(bubbles(8, 0).low.length).toBe(8)
  expect(bubbles(8, 0)).not.toEqual(bubbles(8, 1))
  expect(pingGlyph(0)).toBe('◌')
  expect(pingGlyph(999)).toBe('◇')
})

test('git status: branch, ahead and behind, files changed, detached', () => {
  expect(parseGitStatus(STATUS)).toEqual({ branch: 'main', ahead: 2, behind: 1, changed: 2, isDetached: false })
  expect(parseGitStatus('# branch.head (detached)\n')?.branch).toBe('adrift')
  expect(parseGitStatus('fatal: not a git repository')).toBe(null)
})

test('the footer shows the model, a lowered effort and the anchor', async ($, on) => {
  await world($, on)
  const footer = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  const text = (await footer.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  expect(text).toContain('Opus 5.5')
  expect(text).toContain('medium (asked high)')
  expect(text).toContain('main')
  expect(text).toContain('±2')
  expect(text).toContain('↑2')
  await footer.unmount()
})

test('the footer follows /model and /effort at once, not at the next reply', async ($, on) => {
  await world($, on)
  model = 'claude-sonnet-5-5'
  effortLevel = 'low'
  await $.command.run({ command: 'effort', args: 'low' } as never)
  await new Promise(resolve => setTimeout(resolve, 30))
  const footer = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  const text = (await footer.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  expect(text).toContain('Sonnet 5.5')
  expect(text).toContain('low')
  expect(text).not.toContain('medium')
  await footer.unmount()
})

test('pressing the model opens a drawer that sets the model and the effort', async ($, on) => {
  await world($, on)
  const footer = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  await footer.press({ key: 'footer-model' })
  expect(opened).toEqual(['footer-drawer'])
  const drawer = await $.ui.mount({
    plugin: 'carapace',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'footer-drawer',
    props: { title: 'Model and effort', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  await drawer.press({ key: 'model-sonnet' })
  await drawer.press({ key: 'effort-max' })
  expect(ran).toEqual(['model sonnet', 'effort max'])
  const after = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  const text = (await after.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  expect(text).toContain('Sonnet 5.5')
  expect(text).toContain('max')
})

const file = (expiresAt: number | null, extra = {}) => ({ session_id: 'session-1', prompt_cache: { caching_observed: true, expires_at: expiresAt, recache_tokens_if_cold: 45000, ...extra } })
const texts = async (footer: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) => (await footer.findAll({ type: 'Text' })).map(t => t.text).join('\n')

test('cache countdown: minutes, seconds, amber in the last two minutes, cold, and no data', () => {
  expect(cacheStatus(file(NOW / 1000 + 42 * 60), NOW)).toEqual({ text: 'cache 42m', isAmber: false, isCold: false })
  expect(cacheStatus(file(NOW / 1000 + 120), NOW)?.isAmber).toBe(true)
  expect(cacheStatus(file(NOW / 1000 + 121), NOW)?.isAmber).toBe(false)
  expect(cacheStatus(file(NOW / 1000 + 45), NOW)?.text).toBe('cache 45s')
  expect(cacheStatus(file(NOW / 1000 - 1), NOW)).toEqual({ text: 'cache cold', isAmber: false, isCold: true })
  expect(cacheStatus(file(null), NOW)).toBe(null)
  expect(cacheStatus(file(NOW / 1000 + 60, { caching_observed: false }), NOW)).toBe(null)
  expect(cacheStatus({}, NOW)).toBe(null)
  expect(cacheStatus(null, NOW)).toBe(null)
  expect(recacheNote(file(NOW / 1000 - 5), NOW)).toContain('45k tokens')
  expect(recacheNote(file(NOW / 1000 + 5), NOW)).toBe(null)
  expect(recacheNote(file(NOW / 1000 - 5, { recache_tokens_if_cold: null }), NOW)).toBe(null)
})

test('forecast: the pace reaches 100 percent before the reset, or says nothing', () => {
  const MIN = 60_000
  const rising = [{ at: NOW - 30 * MIN, pct: 20 }, { at: NOW, pct: 50 }]
  expect(forecast(rising, NOW, NOW + 120 * MIN)).toBe('empty in ~50m')
  expect(forecast(rising, NOW, NOW + 20 * MIN)).toBe(null)
  expect(forecast(rising, NOW, null)).toBe(null)
  expect(forecast([{ at: NOW, pct: 50 }], NOW, NOW + 120 * MIN)).toBe(null)
  expect(forecast([{ at: NOW - 1 * MIN, pct: 20 }, { at: NOW, pct: 30 }], NOW, NOW + 120 * MIN)).toBe(null)
  expect(forecast([{ at: NOW - 30 * MIN, pct: 50 }, { at: NOW, pct: 50 }], NOW, NOW + 120 * MIN)).toBe(null)
  expect(addReading([{ at: NOW - 40 * MIN, pct: 5 }, { at: NOW - 10 * MIN, pct: 10 }], NOW, 15).length).toBe(2)
  expect(addReading([{ at: NOW - 10 * MIN, pct: 90 }], NOW, 2)).toEqual([{ at: NOW, pct: 2 }])
})

test('the footer shows the cache countdown from the file, and nothing without it', async ($, on) => {
  await world($, on)
  cacheFile = JSON.stringify(file(NOW / 1000 + 42 * 60))
  await $.session.start({ cwd: '/work/bakery-site', surface: 'terminal', isInteractive: true })
  await new Promise(resolve => setTimeout(resolve, 30))
  const footer = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  expect(await texts(footer)).toContain('cache 42m')
  await footer.unmount()
  cacheFile = null
  await $.session.start({ cwd: '/work/bakery-site', surface: 'terminal', isInteractive: true })
  await new Promise(resolve => setTimeout(resolve, 30))
  const bare = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  expect(await texts(bare)).not.toContain('cache')
  await bare.unmount()
})

test('the first send on a cold cache toasts the re-cache estimate once', async ($, on) => {
  await world($, on)
  cacheFile = JSON.stringify(file(NOW / 1000 - 5))
  await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' } } as never)
  await $.prompt.submit({ text: 'again', origin: { kind: 'composer' } } as never)
  expect(toasts.filter(t => t.includes('45k tokens')).length).toBe(1)
})

test('the forecast shows only when the window empties before it resets', async ($, on) => {
  await world($, on)
  const ctx = { tokens: 10, window: 100, percent: 10 }
  const measure = (pct: number, resetsAt: string) => $.session.measure({ context: ctx, rateLimits: [{ kind: 'five_hour', percentUsed: pct, resetsAt }] } as never)
  const resets = new Date(NOW + 120 * 60_000).toISOString()
  await measure(20, resets)
  await clock.advance(30 * 60_000)
  await measure(50, resets)
  const footer = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  expect(await texts(footer)).toContain('empty in ~50m')
  await footer.unmount()
})

test('the branch mark is ≈ when files changed', async ($, on) => {
  await world($, on)
  const footer = await $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  const text = (await footer.findAll({ type: 'Text' })).map(t => t.text).join('')
  await footer.unmount()
  expect(text).toContain('≈ main')
})
