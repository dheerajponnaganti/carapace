import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { hasSkipWord, isLong, isRunCommand, trimText } from './trimmer-logic'

const LOG = '/h/.claude/carapace/logs/x.log'
const gen = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `line ${from + i}`)

test('detects test, build and lint runs, not look-alikes', () => {
  for (const c of ['npm test', 'pnpm run build', 'yarn lint', 'bun run test', 'npx vitest run', 'npx tsc --noEmit', 'pytest -x', 'python -m pytest', 'python3 -m unittest', 'go test ./...', 'cargo clippy', 'swift build', 'xcodebuild -scheme A', './gradlew test', 'mvn -q test', 'make check', 'rspec', 'phpunit', 'dotnet build', 'claude plugin test .', 'cd app && npm test 2>&1', 'CI=1 npm run test:unit'])
    expect(isRunCommand(c)).toBe(true)
  for (const c of ['echo npm test', 'cat test.log', 'ls', 'npm install', 'git commit -m "npm test"', 'grep pytest README.md', 'npx prettier .'])
    expect(isRunCommand(c)).toBe(false)
})

test('threshold: short output passes, long by lines or chars is long', () => {
  expect(isLong(gen(60).join('\n'))).toBe(false)
  expect(isLong(gen(61).join('\n'))).toBe(true)
  expect(isLong('x'.repeat(4001))).toBe(true)
  expect(hasSkipWord('cd a && make test', ['make'])).toBe(true)
  expect(hasSkipWord('npm test', ['make'])).toBe(false)
  expect(hasSkipWord('cd web && npm run e2e -- --ci', ['npm run e2e'])).toBe(true)
  expect(hasSkipWord('npm run e2e2', ['npm run e2e'])).toBe(false)
})

test('keeps failures with context, the head and the summary tail, collapses the rest', () => {
  const lines = [...gen(500), 'FAIL src/a.test.ts', ...gen(500, 500), 'Tests: 1 failed, 1000 passed']
  const out = trimText(lines.join('\n'), LOG) as string
  expect(out).toContain('FAIL src/a.test.ts')
  expect(out).toContain('line 497')
  expect(out).not.toContain('line 496')
  expect(out).toContain('line 507')
  expect(out).not.toContain('line 508')
  expect(out).toContain('Tests: 1 failed')
  expect(out).toContain('line 0\nline 1\nline 2\n… 494 lines hidden (full log: ' + LOG + ') …')
  expect(out.split('\n').length).toBeLessThan(60)
})

test('overlapping failure ranges merge; a passing run keeps only head and tail', () => {
  const merged = trimText([...gen(100), 'ERROR a', 'x', 'ERROR b', ...gen(100, 100)].join('\n'), LOG) as string
  expect(merged.match(/lines hidden/g)?.length).toBe(2)
  expect(merged.match(/x/g)).not.toBeNull()
  const pass = trimText(gen(200).join('\n'), LOG) as string
  expect(pass.split('\n')).toHaveLength(3 + 1 + 15)
  expect(pass).toContain('… 182 lines hidden')
})

test('real failures come before warnings, and the kept text stays under the cap', () => {
  const lines = [...Array.from({ length: 300 }, (_, i) => `warning: old api ${i}`), ...gen(2000), 'FAIL src/x.test.ts', ...gen(2000, 2000)]
  const out = trimText(lines.join('\n'), LOG) as string
  expect(out).toContain('FAIL src/x.test.ts')
  expect(out.split('\n').length).toBeLessThan(170)
})

test('caps the kept text at 120 matches and counts the rest', () => {
  const lines = Array.from({ length: 400 }, (_, i) => `FAIL case ${i}`)
  const out = trimText(lines.join('\n'), LOG) as string
  expect(out).toContain('more failure lines hidden')
  expect(out).toContain('FAIL case 119')
  expect(out.split('\n').length).toBeLessThan(200)
})

const fake = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
let result: unknown
let writes: { path: string; text: string }[] = []
let failWrite = false
let asError = false
const long = (extra: string[] = []) => ({ stdout: [...gen(300), 'FAIL src/a.test.ts', 'AssertionError: nope', ...extra, ...gen(300, 300), 'Tests: 1 failed, 600 passed'].join('\n'), stderr: '', interrupted: false })

async function world($: Engine, on: On) {
  writes = []
  failWrite = false
  asError = false
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  mock.clock(on, { now: 1_800_000_000_000 })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__carapace__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  for (const op of ['ui.toast', 'ui.status', 'ui.log'] as const) on(op, () => ({ value: undefined }))
  on('fs.write', (_$, e) => {
    if (failWrite) return { deny: 'EACCES' }
    writes.push({ path: e.path, text: e.text })

    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('ui.panes', () => ({ value: [] }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  // A failing command reaches hooks as error text, the shape core gives a non-zero exit.
  on('tool.call', () => (asError ? { isError: true, result: `Exit code 1\n${(result as { stdout: string }).stdout}`, text: `Exit code 1\n${(result as { stdout: string }).stdout}` } : { result }) as never)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'clean', args: 'off' } as never)
}
const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', tool_use_id: 't', command } as never)

test('a long failing npm test is trimmed, with the failure, summary and log path', async ($, on) => {
  await world($, on)
  result = long()
  const ran = await bash($, 'npm test')
  const out = (ran.result as { stdout: string }).stdout
  expect(out).toContain('AssertionError: nope')
  expect(out).toContain('Tests: 1 failed, 600 passed')
  expect(out).toContain('/h/.claude/carapace/logs/1800000000000-npm-test.log')
  expect(out.length).toBeLessThan(1500)
  expect(writes.find(w => w.path.includes('/logs/'))?.text).toBe((result as { stdout: string }).stdout)
  expect((await $.command.run({ command: 'trim', args: '' } as never)).text).toContain('saved ~')
})

test('short output and non-test commands are unchanged', async ($, on) => {
  await world($, on)
  result = { stdout: 'ok', stderr: '', interrupted: false }
  expect((await bash($, 'npm test')).result).toEqual(result)
  result = long()
  expect((await bash($, 'cat test.log')).result).toEqual(result)
  expect(writes.filter(w => w.path.includes('/logs/'))).toHaveLength(0)
})

test('/trim off, skip and # no-trim stop the trimming', async ($, on) => {
  await world($, on)
  result = long()
  await $.command.run({ command: 'trim', args: 'off' } as never)
  expect((await bash($, 'npm test')).result).toEqual(result)
  await $.command.run({ command: 'trim', args: 'on' } as never)
  expect((await bash($, 'npm test # no-trim')).result).toEqual(result)
  await $.command.run({ command: 'trim', args: 'skip make' } as never)
  expect((await bash($, 'make test')).result).toEqual(result)
  expect((await bash($, 'npm test')).result).not.toEqual(result)
  await $.command.run({ command: 'trim', args: 'unskip make' } as never)
  expect((await bash($, 'make test')).result).not.toEqual(result)
})

test('a log write failure means no trim', async ($, on) => {
  await world($, on)
  result = long()
  failWrite = true
  expect((await bash($, 'npm test')).result).toEqual(result)
})

test('works with secret guard: secrets stay masked in the result and the log', async ($, on) => {
  await world($, on)
  result = long([`token ${fake}`])
  const ran = await bash($, 'npm test')
  expect(JSON.stringify(ran.result)).toContain('[secret masked]')
  expect(JSON.stringify(ran.result)).not.toContain(fake)
  expect(JSON.stringify(ran.result)).toContain('hidden (full log')
  expect(writes.find(w => w.path.includes('/logs/'))?.text).not.toContain(fake)
})

test('a failing run that arrives as error text is trimmed into Bash\'s own record, keeping the exit line', async ($, on) => {
  await world($, on)
  result = long()
  asError = true
  const ran = (await bash($, 'npm test')) as unknown as { result: { stdout: string; stderr: string } }
  // Core checks a replaced result against Bash's record shape: an object, never bare text.
  expect(typeof ran.result).toBe('object')
  const out = ran.result.stdout
  expect(out.startsWith('Exit code 1')).toBe(true)
  expect(out).toContain('AssertionError: nope')
  expect(out).toContain('Tests: 1 failed, 600 passed')
  expect(out).toContain('lines hidden (full log: /h/.claude/carapace/logs/')
  expect(out.length).toBeLessThan(1500)
  expect(writes.find(w => w.path.includes('/logs/'))?.text).toContain('line 599')
})
