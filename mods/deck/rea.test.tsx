import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { RESTART_ADDED, RESTART_UPDATED, isNewer, parseVersion, reaKind, reaStatus, updateBadge } from './rea-logic'

type W = { state?: string; latest?: string; version?: string; installerOk?: boolean }
let calls: string[][] = []
let toasts: string[] = []

// The engine beneath carapace with stubbed git, npm and rea; `state` is the installer's state file.
async function world($: Engine, on: On, w: W = {}) {
  calls = []
  toasts = []
  let state = w.state
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  mock.clock(on, { now: 1_800_000_000_000 })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__carapace__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  for (const op of ['ui.status', 'ui.log', 'ui.close', 'fs.write'] as const) on(op, () => ({ value: undefined }))
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('session.id', () => ({ value: 'session-1' }))
  on('settings.read', () => ({ value: { theme: 'dark' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('fs.read', (_$, e) => (e.path.endsWith('carapace-install.json') && state !== undefined ? { value: state } : { deny: 'ENOENT' }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    calls.push(argv)
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    // REA answers only when it is on the machine: recorded by the installer, or there before carapace.
    if (argv[0] === 'rea' && argv[1] === '--version') return state && /"rea"/.test(state) ? out(`${w.version ?? '6.7.0'}\n`) : out('', 127)
    if (argv[0] === 'rea' && argv[1] === 'update') return out('updated\n')
    if (argv[0] === 'npm') return w.latest ? out(`${w.latest}\n`) : out('', 1)
    if (argv[0]?.endsWith('install.sh')) {
      if (w.installerOk === false) return out('', 1)
      state = '{"rea":"installed"}'
      return out('REA: added\n')
    }
    if (argv[0] === 'git' && argv[3] === 'rev-parse' && argv[4] === '--show-toplevel') return out('/home/test/carapace\n')
    if (argv[0] === 'git' && argv[3] === 'rev-list') return out('0\n')
    return out('', argv[0] === 'git' ? 0 : 1)
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await new Promise(resolve => setTimeout(resolve, 60))
}

const settle = () => new Promise(resolve => setTimeout(resolve, 60))
const texts = async (m: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) => (await m.findAll({ type: 'Text' })).map(t => t.text).join('|')
const band = ($: Engine) =>
  $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} } })
const pane = ($: Engine) =>
  $.ui.mount({ plugin: 'carapace', surface: 'terminal', component: 'Pane', requestId: 'carapace-deck', props: { title: 'Shipyard', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } })

test('pure: version compare, row status text, update label, state parsing', () => {
  expect(parseVersion('rea 6.7.0 (build 3)\n')).toBe('6.7.0')
  expect(isNewer('6.8.0', '6.7.0')).toBe(true)
  expect(isNewer('6.10.0', '6.9.9')).toBe(true)
  expect(isNewer('6.7.0', '6.7.0')).toBe(false)
  expect(isNewer('', '6.7.0')).toBe(false)
  expect(reaKind('{"rea":"installed"}')).toBe('ours')
  expect(reaKind('{"rea":"preexisting"}')).toBe('yours')
  expect(reaKind('{}')).toBe('none')
  expect(reaKind('not json')).toBe('none')
  expect(reaStatus({ kind: 'none', version: '', latest: '' })).toBe('not installed')
  expect(reaStatus({ kind: 'ours', version: '6.7.0', latest: '6.7.0' })).toBe('REA 6.7.0 · up to date')
  expect(reaStatus({ kind: 'ours', version: '6.7.0', latest: '6.8.0' })).toBe('REA 6.7.0 · 6.8.0 waiting')
  expect(reaStatus({ kind: 'yours', version: '', latest: '9.9.9' })).toBe('REA (yours)')
  expect(updateBadge(0, { kind: 'ours', version: '6.7.0', latest: '6.8.0' })).toBe('REA 6.8.0')
  expect(updateBadge(3, { kind: 'ours', version: '6.7.0', latest: '6.8.0' })).toBe('3 · REA 6.8.0')
  expect(updateBadge(3, { kind: 'yours', version: '', latest: '6.8.0' })).toBe('3')
})

test('not installed: the Shipyard row shows Add and the bar has no REA button', async ($, on) => {
  await world($, on)
  const t = await texts(await pane($))
  expect(t).toContain('REA')
  expect(t).toContain('not installed')
  expect(t).toContain('Add')
  expect(await texts(await band($))).not.toContain('REA')
  expect(calls.some(c => c[0] === 'npm')).toBe(false)
})

test('Add runs the installer with --with-rea, then says to restart', async ($, on) => {
  await world($, on)
  const p = await pane($)
  await p.press({ key: 'deck-press-e' })
  await settle()
  const run = calls.find(c => c[0]?.endsWith('install.sh'))
  expect(run).toContain('--with')
  expect(run).toContain('rea')
  expect(toasts).toContain('Adding REA...')
  expect(toasts.at(-1)).toBe(RESTART_ADDED)
})

test('a failed Add says so briefly', async ($, on) => {
  await world($, on, { installerOk: false })
  await (await pane($)).press({ key: 'deck-press-e' })
  await settle()
  expect(toasts.at(-1)).toContain('REA was not added')
})

test('an update waiting shows on the bar and pressing it runs rea update', async ($, on) => {
  await world($, on, { state: '{"rea":"installed"}', latest: '6.8.0' })
  const b = await band($)
  expect(await texts(b)).toContain('REA 6.8.0')
  await b.press({ key: 'bar-update' })
  await settle()
  await b.press({ key: 'bar-update' })
  await settle()
  expect(calls.some(c => c[0] === 'rea' && c[1] === 'update')).toBe(true)
  expect(toasts.at(-1)).toContain(RESTART_UPDATED)
})

test('/mods update also runs rea update', async ($, on) => {
  await world($, on, { state: '{"rea":"installed"}', latest: '6.8.0' })
  const reply = await $.command.run({ command: 'mods', args: 'update' } as never)
  expect(calls.some(c => c[0] === 'rea' && c[1] === 'update')).toBe(true)
  expect(reply.text).toContain(RESTART_UPDATED)
})

test('REA that is current: no update button', async ($, on) => {
  await world($, on, { state: '{"rea":"installed"}', latest: '6.7.0' })
  expect(await texts(await band($))).not.toContain('Update')
  expect(await texts(await pane($))).toContain('REA 6.7.0 · up to date')
})

test('offline npm: no REA news, no error', async ($, on) => {
  await world($, on, { state: '{"rea":"installed"}' })
  expect(await texts(await band($))).not.toContain('Update')
})

test("a pre-existing REA shows (yours) and is never checked or updated", async ($, on) => {
  await world($, on, { state: '{"rea":"preexisting"}', latest: '9.9.9' })
  expect(await texts(await pane($))).toContain('REA (yours)')
  expect(await texts(await band($))).not.toContain('Update')
  await $.command.run({ command: 'mods', args: 'update' } as never)
  expect(calls.some(c => c[0] === 'rea' || c[0] === 'npm')).toBe(false)
})
