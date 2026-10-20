import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = 'work-report'

import type { TimeSnap } from '../../types'

import { brokeBy, brokeSince, checkNote, fixedBy, groupByPrompt, isCheckCommand, pruneDrop, repoHash, storeDir } from './time-machine-logic'

const NOW = new Date(2026, 9, 13, 15, 0).getTime()
let testFails = true
const DAY = 86_400_000
const snap = (n: number, over: Partial<TimeSnap> = {}): TimeSnap => ({ sha: `s${n}`, at: NOW - (100 - n) * 1000, tool: 'Edit', label: `Edit f${n}`, prompt: 1, promptText: 'fix it', ...over })

test('test, build and check commands are recognised', () => {
  for (const c of ['npm test', 'npx -y -p typescript@5.6.3 tsc -p . --noEmit', 'cd x && pytest -q', 'cargo build', 'claude plugin test .', 'make']) expect(isCheckCommand(c)).toBe(true)
  for (const c of ['ls -la', 'git status', 'echo test-drive', 'cat attest.txt']) expect(isCheckCommand(c)).toBe(false)
})

test('a failing check followed by a passing one links to the first snapshot after the fix', () => {
  const snaps = [snap(1, { check: 'fail' }), snap(2), snap(3, { check: 'pass' }), snap(4, { check: 'pass' }), snap(5, { check: 'fail' }), snap(6, { check: 'pass' })]
  expect(fixedBy(snaps)).toEqual({ s3: 's1', s6: 's5' })
  expect(fixedBy([snap(1, { check: 'pass' })])).toEqual({})
})

test('who broke it: the last pass of the same command, and the changes since', () => {
  const t = (n: number, over: Partial<TimeSnap> = {}) => snap(n, { checkCommand: over.check ? 'npm test' : undefined, ...over })
  const snaps = [t(1), t(2, { check: 'pass' }), t(3), t(4, { label: 'Edit b.ts' }), t(5, { check: 'fail' })]
  expect(brokeSince(snaps, 'npm test')).toMatchObject({ good: { sha: 's2' }, first: { sha: 's3' } })
  expect(brokeSince(snaps, 'npm run build')).toBeNull()
  // A second failure in a row is the same break, named once.
  expect(brokeSince([...snaps, t(6, { check: 'fail' })], 'npm test')).toBeNull()
  expect(Object.keys(brokeBy([...snaps, t(6, { check: 'fail' })]))).toEqual(['s5'])
  const note = checkNote(snaps, 'npm test', 'fail', false) as string
  expect(note).toContain('passed at')
  expect(note).toContain('Edit f3, Edit b.ts, Edit f5')
  expect(note).toContain('first change after the pass was "Edit f3"')
  expect(checkNote(snaps, 'npm test', 'pass', false)).toBeNull()
  expect(checkNote(snaps, 'npm test', 'pass', true)).toContain('flaky')
})

test('pruning drops snapshots older than 7 days, then the oldest beyond the cap', () => {
  const old = snap(0, { at: NOW - 8 * DAY })
  const many = Array.from({ length: 205 }, (_, i) => snap(i + 1, { at: NOW - 1000 + i }))
  expect(pruneDrop([old, snap(1)], NOW).map(s => s.sha)).toEqual(['s0'])
  expect(pruneDrop([old, ...many], NOW).map(s => s.sha)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5'])
  expect(pruneDrop(many.slice(0, 3), NOW)).toEqual([])
})

test('snapshots group by prompt, today only, newest prompt first', () => {
  const snaps = [snap(1, { prompt: 10, at: NOW - 3 * DAY }), snap(2, { prompt: 20 }), snap(3, { prompt: 20 }), snap(4, { prompt: 30, promptText: 'next' })]
  const groups = groupByPrompt(snaps, NOW - DAY)
  expect(groups.map(g => [g.prompt, g.snaps.length])).toEqual([[30, 1], [20, 2]])
})

test('the store sits under the carapace folder, apart from the project', () => {
  expect(storeDir('/home/t', '/work/app')).toBe(`/home/t/.claude/carapace/snapshots/${repoHash('/work/app')}.git`)
  expect(repoHash('/work/app')).not.toBe(repoHash('/work/other'))
})

// The engine beneath: every process call is answered here, so no real repo is touched.
async function world($: Engine, on: On, opts: { isRepo?: boolean; hasStore?: boolean } = {}) {
  testFails = true
  const calls: string[][] = []
  let edits = 0
  let committed = ''
  let commits = 0
  mock.store(on, {})
  mock.env(on, { HOME: '/home/test' })
  mock.clock(on, { now: NOW })
  const done = (stdout = '', exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('session.root', () => ({ value: '/p' }))
  on('process.run', (_$, e) => {
    calls.push([...e.argv])
    const a = e.argv.join(' ')
    if (a.includes('--is-inside-work-tree')) return done('true\n', opts.isRepo === false ? 128 : 0)
    if (e.argv[0] === 'test') return done('', opts.hasStore === false ? 1 : 0)
    if (a.includes('write-tree')) return done(`tree${edits}\n`)
    if (a.includes('^{tree}')) return done(`${committed}\n`)
    if (a.includes('commit-tree')) {
      committed = e.argv[e.argv.indexOf('commit-tree') + 1] ?? ''
      return done(`sha${commits++}\n`)
    }
    if (e.argv[0] === 'du') return done('12\tstore\n')
    return done()
  })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__carapace__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  for (const n of ['ui.toast', 'ui.status', 'ui.log', 'fs.write']) on(n as never, () => ({ value: undefined }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.call', (_$, e) => ((e.tool === 'Edit' && (edits += 1), (e as { command?: string }).command === 'npm test' && testFails) ? { result: { stdout: '', stderr: '', interrupted: false }, isError: true } : { result: { ok: true } }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'clean', args: 'off' } as never)

  return calls
}

const call = ($: Engine, tool: string, extra: object = {}) => $.tool.call({ tool_use_id: `${tool}-${Math.random()}`, tool, ...extra } as never)

test('an Edit snapshots into the hidden store, never the project git', async ($, on) => {
  const calls = await world($, on)
  await call($, 'Edit', { file_path: '/p/a.ts' })
  const commit = calls.find(c => c.includes('commit-tree'))
  expect(commit).toBeDefined()
  expect(commit?.some(a => a.startsWith('--git-dir=/home/test/.claude/carapace/snapshots/'))).toBe(true)
  for (const c of calls.filter(c => c[0] === 'git' && c[1]?.startsWith('--git-dir'))) expect(c[1]).not.toMatch(/\/p\/\.git/)
})

test('a first snapshot creates the store, folders included, as a bare repo by path', async ($, on) => {
  const calls = await world($, on, { hasStore: false })
  await call($, 'Edit', { file_path: '/p/a.ts' })
  const init = calls.find(c => c.includes('init'))
  expect(init?.slice(0, 4)).toEqual(['git', 'init', '-q', '--bare'])
  expect(init?.[4]).toMatch(/^\/home\/test\/\.claude\/carapace\/snapshots\/.+\.git$/)
  expect(calls.some(c => c.includes('commit-tree'))).toBe(true)
})

test('a project that is not a git repo is skipped', async ($, on) => {
  const calls = await world($, on, { isRepo: false })
  await call($, 'Write', { file_path: '/p/a.ts' })
  expect(calls.some(c => c.includes('commit-tree'))).toBe(false)
})

test('the Timeline links the fix and Restore asks first, then checks out of the hidden store', async ($, on) => {
  const calls = await world($, on)
  await $.prompt.submit({ text: 'make the build pass', wait: false, origin: { kind: 'composer' } } as never)
  await call($, 'Edit', { file_path: '/p/a.ts' })
  await call($, 'Bash', { command: 'npm test' })
  await call($, 'Edit', { file_path: '/p/b.ts' })
  await call($, 'Bash', { command: 'npm run build' })
  const ui = await $.ui.mount({
    plugin: 'carapace',
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE,
    props: { title: 'Work Report', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
  })
  const text = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  const first = await text()
  expect(first).toContain('TIMELINE')
  expect(first).toContain('make the build pass')
  expect(first).toContain('fixed by this')
  expect(first).toContain('/rewind')
  expect(calls.some(c => c.includes('checkout'))).toBe(false)
  await ui.press({ key: 'tm-restore-sha1' } as never)
  expect(await text()).toContain('Replace your files')
  expect(calls.some(c => c.includes('checkout'))).toBe(false)
  await ui.press({ key: 'tm-yes-sha1' } as never)
  const out = calls.find(c => c.includes('checkout'))
  expect(out?.slice(-3)).toEqual(['sha1', '--', '.'])
  expect(out?.some(a => a.startsWith('--git-dir=/home/test/.claude/carapace/'))).toBe(true)
})

test('/report snapshots off stops snapshots, and on brings them back', async ($, on) => {
  const calls = await world($, on)
  expect((await $.command.run({ command: 'report', args: 'snapshots off' } as never)).text).toContain('off')
  await call($, 'Edit', { file_path: '/p/a.ts' })
  expect(calls.find(c => c.includes('commit-tree'))).toBeUndefined()
  expect((await $.command.run({ command: 'report', args: 'snapshots on' } as never)).text).toContain('on')
  await call($, 'Edit', { file_path: '/p/b.ts' })
  expect(calls.find(c => c.includes('commit-tree'))).toBeDefined()
})

test('a check tells Claude what broke it, and a result that flips with no change is flaky', async ($, on) => {
  await world($, on)
  testFails = false
  await call($, 'Edit', { file_path: '/p/a.ts' })
  const pass = (await call($, 'Bash', { command: 'npm test' })) as { context?: string[] }
  expect(pass.context ?? []).toEqual([])
  await call($, 'Edit', { file_path: '/p/b.ts' })
  testFails = true
  const fail = (await call($, 'Bash', { command: 'npm test' })) as { context?: string[] }
  expect(fail.context?.join('\n')).toContain('first change after the pass was "Edit b.ts"')
  const again = (await call($, 'Bash', { command: 'npm test' })) as { context?: string[] }
  expect(again.context ?? []).toEqual([])
  testFails = false
  const flip = (await call($, 'Bash', { command: 'npm test' })) as { context?: string[] }
  expect(flip.context?.join('\n')).toContain('flaky')
})
