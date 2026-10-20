import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { LOG_KEEP, appendLine, errorLine, issueUrl, openArgv, reportMarkdown } from '../shared/errlog'

let files: Record<string, string> = {}
let opened: string[][] = []

// The engine beneath carapace. Every git call throws, so the update check hits a catch site at start.
async function world($: Engine, on: On, opts: { failGit?: boolean } = {}) {
  files = {}
  opened = []
  mock.store(on)
  mock.env(on, { HOME: '/home/test', TERM_PROGRAM: 'kitty' })
  mock.clock(on, { now: 1_800_000_000_000 })
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__carapace__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('session.messages', () => ({ value: [{ role: 'user', text: 'SECRET-PROMPT-TEXT' }] }) as never)
  on('session.usage', () => ({ value: { context: { percent: 10 }, rateLimits: [] } }) as never)
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  for (const op of ['ui.toast', 'ui.status', 'ui.log'] as const) on(op, () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.version', () => ({ value: { version: '2.1.300' } }))
  on('settings.read', () => ({ value: { theme: 'dark' } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('fs.read', (_$, e) => (e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' }))
  on('fs.write', (_$, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    if (argv[0] === 'git' && opts.failGit !== false && !argv.includes('--short')) return { deny: 'git is broken\nsecond line' }
    opened.push(argv)
    return { value: { exitCode: 0, stdout: argv.includes('--short') ? 'abc1234\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await new Promise(resolve => setTimeout(resolve, 60))
}

const bar = async ($: Engine) =>
  (
    await (
      await $.ui.mount({
        plugin: 'carapace',
        surface: 'terminal',
        component: 'AbovePrompt',
        props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} },
      })
    ).findAll({ type: 'Text' })
  )
    .map(t => t.text)
    .join(' ')

const panel = ($: Engine) =>
  $.ui.mount({
    plugin: 'carapace',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'carapace-report',
    props: { title: 'Report a problem', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })

test('an error at a catch site writes a log line and the bar offers the report button', async ($, on) => {
  await world($, on)
  const log = files['/home/test/.claude/carapace/log.txt']
  expect(log).toContain('deck update check: carapace: $.process.run: git is broken [claude 2.1.300]')
  expect(log).not.toContain('second line')
  expect(await bar($)).toContain('Problem')
})

test('with no errors the bar has no report button', async ($, on) => {
  await world($, on, { failGit: false })
  expect(files['/home/test/.claude/carapace/log.txt']).toBeUndefined()
  expect(await bar($)).not.toContain('Problem')
})

test('/mods problem opens the panel with no errors, and Save to file writes the report and clears the button', async ($, on) => {
  await world($, on)
  expect(await bar($)).toContain('Problem')
  const reply = await $.command.run({ command: 'mods', args: 'problem' } as never)
  expect(reply.text).toContain('problem report')
  await new Promise(resolve => setTimeout(resolve, 30))
  const ui = await panel($)
  await ui.input({ key: 'report-text', text: 'The bar froze', kind: 'change' })
  await ui.press({ key: 'report-save' })
  const saved = Object.keys(files).find(p => p.includes('/report-'))
  expect(saved).toBeDefined()
  expect(files[saved as string]).toContain('The bar froze')
  expect(files[saved as string]).toContain('abc1234')
  expect(files[saved as string]).toContain('kitty')
  expect(files[saved as string]).toContain('deck update check: carapace: $.process.run: git is broken')
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')).toContain('Saved to')
  expect(await bar($)).not.toContain('Problem')
  await ui.unmount()
})

test('Open on GitHub opens the browser with the issue link and clears the button', async ($, on) => {
  await world($, on)
  await $.command.run({ command: 'mods', args: 'problem' } as never)
  await new Promise(resolve => setTimeout(resolve, 30))
  const ui = await panel($)
  await ui.input({ key: 'report-text', text: 'It broke & burned #1', kind: 'change' })
  await ui.press({ key: 'report-github' })
  const argv = opened.find(a => a[0] === 'xdg-open')
  expect(argv?.[1]).toContain('https://github.com/dheerajponnaganti/carapace/issues/new?labels=bug%20report&title=It%20broke%20%26%20burned%20%231')
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')).toContain('Opened in your browser. Press Submit there.')
  expect(await bar($)).not.toContain('Problem')
  await ui.unmount()
})

test('the close mark dismisses the report and clears the button', async ($, on) => {
  await world($, on)
  await $.command.run({ command: 'mods', args: 'problem' } as never)
  await new Promise(resolve => setTimeout(resolve, 30))
  const ui = await panel($)
  await ui.press({ key: 'report-close' })
  expect(await bar($)).not.toContain('Problem')
  await ui.unmount()
})

test('the link stays under 8000 characters with a huge log, and encodes the text', () => {
  const lines = Array.from({ length: 50 }, (_, i) => errorLine(0, 'deck', 'update check', new Error(`${'x'.repeat(300)} ${i} & #`), '2.1.300'))
  const info = { description: `a & b #c ${'long '.repeat(2000)}`, carapace: 'abc1234', claude: '2.1.300', os: 'macOS', terminal: 'kitty', mods: 'Crew', lines }
  const url = issueUrl(info)
  expect(url.length).toBeLessThanOrEqual(8000)
  expect(url).toContain('labels=bug%20report')
  expect(url).toContain('a%20%26%20b%20%23c')
  expect(issueUrl({ ...info, description: 'short', lines: lines.slice(0, 2) })).toContain(encodeURIComponent('2 errors logged'))
  expect(openArgv('macOS', 'u')).toEqual(['open', 'u'])
  expect(openArgv('Linux', 'u')).toEqual(['xdg-open', 'u'])
})

test('the log keeps only the last 300 lines, each line one short line', () => {
  let text = ''
  for (let i = 0; i < LOG_KEEP + 25; i++) text = appendLine(text, `line ${i}`)
  const lines = text.split('\n').filter(Boolean)
  expect(lines.length).toBe(LOG_KEEP)
  expect(lines[0]).toBe('line 25')
  expect(lines[LOG_KEEP - 1]).toBe(`line ${LOG_KEEP + 24}`)
  expect(errorLine(0, 'm', 'w', new Error(`${'y'.repeat(500)}\nnext`), '').length).toBeLessThan(260)
})

test('nothing from a prompt reaches the report', async ($, on) => {
  await world($, on)
  await $.command.run({ command: 'mods', args: 'problem' } as never)
  await new Promise(resolve => setTimeout(resolve, 30))
  const ui = await panel($)
  await ui.press({ key: 'report-save' })
  const all = Object.values(files).join('\n') + reportMarkdown({ description: '', carapace: '', claude: '', os: '', terminal: '', mods: '', lines: [] })
  expect(all).not.toContain('SECRET-PROMPT-TEXT')
  await ui.unmount()
})
