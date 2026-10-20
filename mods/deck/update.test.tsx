import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { isDue, needsInstaller, parseCount, updateNotice, updatedText } from './update-logic'

type Git = { behind: number; dirty?: boolean; fetchFails?: boolean; noUpstream?: boolean; top?: string; changed?: string }
let calls: string[][] = []
let toasts: string[] = []

// The engine beneath carapace, with git answering as a clone that is `behind` commits behind GitHub.
async function world($: Engine, on: On, git: Git) {
  calls = []
  toasts = []
  let head = 'aaa'
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  mock.clock(on, { now: 1_800_000_000_000 })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__carapace__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  for (const op of ['ui.status', 'ui.log', 'fs.write'] as const) on(op, () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('session.id', () => ({ value: 'session-1' }))
  on('settings.read', () => ({ value: { theme: 'dark' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    calls.push(argv)
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] !== 'git') return out('', 1)
    const verb = argv[3]
    if (verb === 'rev-parse' && argv[4] === '--show-toplevel') return out(`${git.top ?? '/home/test/carapace'}\n`)
    if (verb === 'fetch') return out('', git.fetchFails ? 128 : 0)
    if (verb === 'rev-list') return git.noUpstream && argv.includes('HEAD..@{u}') ? out('', 128) : out(`${git.behind}\n`)
    if (verb === 'log') return out('Crew learns from finished helpers\n')
    if (verb === 'status') return out(git.dirty ? ' M mods/deck/deck.tsx\n' : '')
    if (verb === 'rev-parse') return out(`${head}\n`)
    if (verb === 'pull') {
      head = 'bbb'
      return out('')
    }
    if (verb === 'diff') return out(git.changed ?? 'mods/agent-dock/dock.tsx\n')
    return out('')
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await new Promise(resolve => setTimeout(resolve, 30))
}

const band = ($: Engine) =>
  $.ui.mount({
    plugin: 'carapace',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })

test('the pure parts: when to look, reading counts, the notices', () => {
  expect(isDue(undefined, 1000)).toBe(true)
  expect(isDue(1000, 1000 + 60_000)).toBe(false)
  expect(isDue(1000, 1000 + 7 * 3600_000)).toBe(true)
  expect(parseCount('3\n')).toBe(3)
  expect(parseCount('fatal: no upstream')).toBe(0)
  expect(updateNotice({ behind: 1, subject: 'Fix', checkedAt: 0 })).toContain('1 change.')
  expect(needsInstaller('mods/a.ts\nterminal/Deep Sea.terminal')).toBe(true)
  expect(needsInstaller('mods/a.ts\nREADME.md')).toBe(false)
  expect(updatedText(2, 'install.sh', '/Users/sam/code/carapace')).toContain('run /Users/sam/code/carapace/install.sh')
  expect(updatedText(2, 'install.ps1', 'C:\\Users\\sam\\carapace')).toContain('install.ps1')
  expect(updatedText(2, 'install.ps1', 'C:\\Users\\sam\\carapace')).not.toContain('install.sh')
})

test('a new chat finds 3 new commits and the bar shows ↑ Update 3', async ($, on) => {
  await world($, on, { behind: 3 })
  expect(calls.some(c => c[3] === 'fetch')).toBe(true)
  const text = (await (await band($)).findAll({ type: 'Text' })).map(t => t.text).join(' ')
  expect(text).toContain('Update')
  expect(text).toContain('3')
})

test('/mods update pulls, and says the mods reload by themselves', async ($, on) => {
  await world($, on, { behind: 2 })
  const reply = await $.command.run({ command: 'mods', args: 'update' } as never)
  expect(calls.some(c => c[3] === 'pull' && c.includes('--ff-only'))).toBe(true)
  expect(reply.text).toContain('carapace updated')
})

test('local edits stop the update before anything is pulled', async ($, on) => {
  await world($, on, { behind: 2, dirty: true })
  const reply = await $.command.run({ command: 'mods', args: 'update' } as never)
  expect(reply.text).toContain('local edits')
  expect(calls.some(c => c[3] === 'pull')).toBe(false)
})

test('up to date or offline: no chip, a plain answer to /mods check', async ($, on) => {
  await world($, on, { behind: 0 })
  const text = (await (await band($)).findAll({ type: 'Text' })).map(t => t.text).join(' ')
  expect(text).not.toContain('Update')
  expect((await $.command.run({ command: 'mods', args: 'check' } as never)).text).toBe('carapace is up to date.')
})

test('a failed fetch is quiet at start and explained on /mods check', async ($, on) => {
  await world($, on, { behind: 5, fetchFails: true })
  expect(calls.some(c => c[3] === 'rev-list')).toBe(false)
  expect((await $.command.run({ command: 'mods', args: 'check' } as never)).text).toContain('Could not reach GitHub')
})

test('a branch that does not follow GitHub is not called up to date', async ($, on) => {
  await world($, on, { behind: 0, noUpstream: true })
  const text = (await $.command.run({ command: 'mods', args: 'check' } as never)).text
  expect(text).not.toContain('up to date')
  expect(text).toContain('does not follow')
})

test('an offline chat start tries again at the next chat start', async ($, on) => {
  await world($, on, { behind: 0, fetchFails: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(calls.filter(c => c[3] === 'fetch').length).toBe(2)
})

test('Update asks first: the first press says what is new, the second installs', async ($, on) => {
  await world($, on, { behind: 2 })
  const b = await band($)
  await b.press({ key: 'bar-update' })
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(toasts.at(-1)).toBe('2 changes: Crew learns from finished helpers. Press Update again to install.')
  expect(calls.some(c => c[3] === 'pull')).toBe(false)
  await b.press({ key: 'bar-update' })
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(calls.some(c => c[3] === 'pull')).toBe(true)
})
