import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { registerWindow } from './window'
import { bandFor, isOwnedProfile, profileFor } from './window-logic'

type Answer = { exitCode: number; stdout: string }
let runs: string[][] = []

// The engine beneath the mod: env and process calls are answered here and recorded.
function world($: Engine, on: On, env: Record<string, string>, answer: (argv: readonly string[]) => Answer, store: Record<string, unknown> = {}) {
  runs = []
  cwds.length = 0
  mock.store(on, store)
  mock.env(on, env)
  mock.clock(on, { now: 1_000_000 })
  on('ui.status', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: '/' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__carapace__${e.name}` } }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    cwds.push(e.init?.cwd)
    const reply = answer(e.argv)

    return { value: { ...reply, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  registerWindow(on)
}

const TERMINAL = { TERM_PROGRAM: 'Apple_Terminal', HOME: '/Users/me' }

// Each process the mod asks for gets an answer: a tab on ttys004, and a repaint that succeeds.
function mac(argv: readonly string[]): Answer {
  if (argv[0] === 'sh') return { exitCode: 0, stdout: 'ttys004\n' }

  return { exitCode: 0, stdout: 'set Deep Sea' }
}

const cwds: (string | undefined)[] = []

const paints = () => runs.filter(argv => argv[0] === 'osascript')

test('outside Terminal.app the window mod runs no process and changes nothing', async ($, on) => {
  world($, on, { TERM_PROGRAM: 'vscode', HOME: '/Users/me' }, mac)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // Other mods make their own calls; the window mod must make no terminal or tty call.
  expect(runs.filter(argv => argv[0] === 'osascript' || argv[0] === 'sh')).toEqual([])
})

test('on Linux or Windows the window mod does nothing even inside a terminal', async ($, on) => {
  world($, on, { HOME: '/home/me' }, mac)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(paints()).toEqual([])
})

test('Terminal.app paints the tab Deep Sea, once', async ($, on) => {
  world($, on, TERMINAL, mac)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect(paints()).toHaveLength(1)
  expect(paints()[0][3]).toBe('Deep Sea')
  expect(paints()[0][4]).toBe('/dev/ttys004')
})

test('a band names one profile: calm under 50, deep to 84, crush from 85', () => {
  expect(bandFor(0)).toBe('calm')
  expect(bandFor(49.9)).toBe('calm')
  expect(bandFor(50)).toBe('deep')
  expect(bandFor(84)).toBe('deep')
  expect(bandFor(85)).toBe('crush')
  expect(bandFor(100)).toBe('crush')
})

test('each band wears its Deep Sea profile', () => {
  expect(profileFor('calm')).toBe('Deep Sea')
  expect(profileFor('deep')).toBe('Deep Sea · Deep')
  expect(profileFor('crush')).toBe('Deep Sea · Crush')
  expect(isOwnedProfile(profileFor('deep'))).toBe(true)
  expect(isOwnedProfile('Basic')).toBe(false)
})

test('the tab is painted even when the session folder was deleted: no call runs from it', async ($, on) => {
  world($, on, TERMINAL, mac)
  await $.session.start({ cwd: '/Users/me/gone', surface: 'terminal', isInteractive: true })

  expect(paints()).toHaveLength(1)
  // The tab lookup and the repaint name a folder that always exists, never the session's.
  const own = runs.map((argv, i) => [argv[0], cwds[i]]).filter(([cmd]) => cmd === 'sh' || cmd === 'osascript')
  expect(own).toEqual([['sh', '/'], ['osascript', '/']])
})
